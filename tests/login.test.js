'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTestServer } = require('./helpers/server');
const { REMEMBER_LOGIN_MS } = require('../scrs/backend/session-store');

async function setup(t, options) {
    const h = await createTestServer(options);
    t.after(() => h.close());
    h.signIn = (rememberMe = true, headers = {}) => h.request('/api/auth/login', {
        method: 'POST', body: { username: 'alice', password: 'test-only', rememberMe }, headers
    });
    return h;
}

function sessionId(cookie) { return decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0]; }
function sessionFile(h, cookie) { return h.sessionStore.filename(sessionId(cookie)); }
const expires = header => new Date(header.match(/Expires=([^;]+)/i)[1]).getTime();
const storeCall = (store, method, ...args) => new Promise((resolve, reject) =>
    store[method](...args, (err, result) => err ? reject(err) : resolve(result)));

test('remembered login uses a 30-day opaque HttpOnly cookie and keeps passwords off disk', async t => {
    const h = await setup(t);
    const result = await h.signIn();
    assert.equal(result.status, 200);
    assert.match(result.setCookie, /^mediashare\.sid=s%3A/);
    assert.match(result.setCookie, /HttpOnly/);
    assert.match(result.setCookie, /SameSite=Lax/);
    assert.ok(Math.abs(expires(result.setCookie) - Date.now() - REMEMBER_LOGIN_MS) < 60000);
    const saved = fs.readFileSync(sessionFile(h, result.cookie), 'utf8');
    assert.equal(saved.includes('test-only'), false);
    assert.equal(saved.includes('password'), false);
    assert.equal(result.cookie.includes('alice'), false);
    const me = await h.request('/api/auth/me', { cookie: result.cookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, 'alice');
});

test('Remember me can be disabled for a browser-session cookie', async t => {
    const h = await setup(t);
    const result = await h.signIn(false);
    assert.equal(result.status, 200);
    assert.equal(/Expires=|Max-Age=/i.test(result.setCookie), false);
    assert.equal((await h.request('/api/auth/me', { cookie: result.cookie })).status, 200);
});

test('secure cookies work behind the configured HTTPS reverse proxy', async t => {
    const h = await setup(t);
    const secure = await h.signIn(true, { 'X-Forwarded-Proto': 'https' });
    assert.match(secure.setCookie, /; Secure/);
    const local = await h.signIn();
    assert.equal(local.setCookie.includes('; Secure'), false);
});

test('active remembered sessions renew their expiration', async t => {
    const h = await setup(t);
    const login = await h.signIn();
    const file = sessionFile(h, login.cookie);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.expires = Date.now() + 86400000;
    saved.session.cookie.expires = new Date(saved.expires).toISOString();
    fs.writeFileSync(file, JSON.stringify(saved));
    const renewed = await h.request('/api/auth/me', { cookie: login.cookie });
    assert.equal(renewed.status, 200);
    assert.ok(expires(renewed.setCookie) > Date.now() + 29 * 86400000);
});

test('remembered login survives a server restart, including a generated persistent signing secret', async t => {
    const first = await createTestServer({ preserveData: true, env: { SESSION_SECRET: '' } });
    t.after(async () => { await first.close(); fs.rmSync(first.localRoot, { recursive: true, force: true }); });
    const cookie = await first.login();
    await first.close();
    const second = await createTestServer({ localRoot: first.localRoot, env: { SESSION_SECRET: '' } });
    t.after(() => second.close());
    const result = await second.request('/api/auth/me', { cookie });
    assert.equal(result.status, 200);
    assert.equal(result.data.user.username, 'alice');
});

test('logout clears the cookie, revokes the stored session and prevents late requests from restoring it', async t => {
    const h = await setup(t);
    const login = await h.signIn();
    const id = sessionId(login.cookie);
    const original = await storeCall(h.sessionStore, 'get', id);
    const logout = await h.request('/api/auth/logout', { method: 'POST', cookie: login.cookie });
    assert.equal(logout.status, 200);
    assert.match(logout.setCookie, /mediashare\.sid=;/);
    assert.ok(expires(logout.setCookie) < Date.now());
    await storeCall(h.sessionStore, 'touch', id, original);
    await storeCall(h.sessionStore, 'set', id, original);
    assert.equal(await storeCall(h.sessionStore, 'get', id), null);
    assert.equal((await h.request('/api/auth/me', { cookie: login.cookie })).status, 401);
});

test('expired or tampered cookies cannot authenticate', async t => {
    const h = await setup(t);
    const login = await h.signIn();
    const file = sessionFile(h, login.cookie);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.expires = Date.now() - 1;
    fs.writeFileSync(file, JSON.stringify(saved));
    assert.equal((await h.request('/api/auth/me', { cookie: login.cookie })).status, 401);
    assert.equal(fs.existsSync(file), false);
    const valid = await h.signIn();
    assert.equal((await h.request('/api/auth/me', { cookie: valid.cookie.slice(0, -3) + 'bad' })).status, 401);
});

test('password changes and deleted accounts revoke remembered logins', async t => {
    const h = await setup(t);
    const first = await h.signIn();
    h.accounts[0].password = 'updated-password';
    assert.equal((await h.request('/api/auth/me', { cookie: first.cookie })).status, 401);
    const second = await h.request('/api/auth/login', {
        method: 'POST', body: { username: 'alice', password: 'updated-password' }
    });
    assert.equal(second.status, 200);
    h.accounts.splice(0, 1);
    assert.equal((await h.request('/api/auth/me', { cookie: second.cookie })).status, 401);
});

test('session data cannot be downloaded from the static file server', async t => {
    const h = await setup(t);
    await h.signIn();
    for (const url of ['/data/sessions/.secret', '/data/sessions/anything.json', '/data/audio-settings/alice.json',
        '/%64ata/sessions/anything.json', '/HTML/..%2fdata/sessions/anything.json', '/%63onf/accounts.json'])
        assert.equal((await fetch(h.base + url)).status, 403);
});

test('invalid remember-me values and bad credentials create no login cookie', async t => {
    const h = await setup(t);
    assert.equal((await h.signIn('true')).status, 400);
    const bad = await h.request('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.setCookie, null);
});

function loginPage(responder, remember = true) {
    const elements = new Map();
    const requests = [];
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            value: id === 'username' ? 'alice' : id === 'password' ? 'test-only' : '',
            checked: remember, classList: { add() {}, remove() {} },
            addEventListener(event, handler) { this[event] = handler; }
        });
        return elements.get(id);
    }
    const location = { href: '', replace(url) { this.href = url; } };
    const ready = vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/login.js'), 'utf8'), {
        document: { getElementById: element }, window: { location },
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            return responder(url, options);
        }
    });
    return { ready, elements, requests, location };
}

test('the login page opens the dashboard automatically when the cookie is still valid', async () => {
    const page = loginPage(async () => ({ ok: true }));
    await page.ready;
    assert.equal(page.location.href, '/HTML/main.html');
});

test('the login form sends the selected remember-me choice and remains usable without a session', async () => {
    const page = loginPage(async url => url === '/api/auth/me'
        ? { ok: false } : { ok: true, json: async () => ({ success: true }) }, false);
    await page.ready;
    assert.equal(page.location.href, '');
    await page.elements.get('login-form').submit({ preventDefault() {} });
    const request = page.requests.find(request => request.url === '/api/auth/login');
    assert.equal(JSON.parse(request.options.body).rememberMe, false);
    assert.equal(page.location.href, '/HTML/main.html');
});
