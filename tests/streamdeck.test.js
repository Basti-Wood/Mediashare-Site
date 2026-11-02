'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { createTestServer } = require('./helpers/server');
const { createPlugin, connectionSettings, SKIP, VOLUME } = require('../streamdeck/com.bastiwood.mediashare.sdPlugin/bin/plugin');

async function setup(t, options = {}) {
    const h = await createTestServer(options);
    t.after(() => h.close());
    const cookie = await h.login();
    h.cookie = cookie;
    h.api = (route, method = 'GET', body) => h.request(route, { method, body, cookie });
    h.pair = async (channel = 'alice') => h.api(`/api/streamdeck/${channel}/connection`, 'POST');
    h.token = (await h.pair()).data.token;
    h.control = (body, token = h.token) => h.request('/api/streamdeck/control', {
        method: 'POST', body: { requestId: randomUUID(), ...body }, headers: { Authorization: 'Bearer ' + token }
    });
    h.state = token => h.request('/api/streamdeck/state', { headers: { Authorization: 'Bearer ' + (token || h.token) } });
    h.current = async () => (await h.request('/api/channels/alice/current')).data.current;
    h.add = id => h.api('/api/mylist/alice/add', 'POST', { url: 'https://youtu.be/' + id });
    return h;
}

async function until(predicate) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Stream Deck did not reach the expected state');
}

async function pluginFor(h, options = {}) {
    const sent = [];
    const plugin = createPlugin({ pluginUUID: 'test-plugin', send: message => sent.push(message), ...options });
    await plugin.handle({ event: 'didReceiveGlobalSettings', payload: { settings: { baseUrl: h.base, token: h.token } } });
    await plugin.handle({ event: 'willAppear', context: 'dial', action: VOLUME, payload: { settings: { step: 2 } } });
    await plugin.handle({ event: 'willAppear', context: 'skip', action: SKIP, payload: { settings: {} } });
    return { plugin, sent, fire: (event, payload = {}) => plugin.handle({ event, action: event.startsWith('key') ? SKIP : VOLUME,
        context: event.startsWith('key') ? 'skip' : 'dial', payload }) };
}

test('pairing requires login/access and stores only a private token hash', async t => {
    const h = await setup(t);
    for (const method of ['GET', 'POST', 'DELETE']) {
        assert.equal((await h.request('/api/streamdeck/alice/connection', { method })).status, 401);
        assert.equal((await h.api('/api/streamdeck/bob/connection', method)).status, 403);
    }
    assert.match(h.token, /^msd_[a-f0-9]{64}$/);
    const root = path.join(h.localRoot, '.streamdeck');
    const [file] = fs.readdirSync(root);
    const saved = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(saved.includes(h.token), false);
    assert.equal(saved.includes('test-only'), false);
    assert.equal(fs.statSync(path.join(root, file)).mode & 0o777, 0o600);
    const status = await h.api('/api/streamdeck/alice/connection');
    assert.equal(status.data.connection.channel, 'alice');
    assert.equal(JSON.stringify(status.data).includes('hash'), false);
    const headers = { Authorization: 'Bearer ' + h.token };
    assert.equal((await h.request('/api/mylist/alice/add', { method: 'POST', body: { url: 'https://youtu.be/AAAAAAAAAAA' }, headers })).status, 401);
});

test('tokens use the Authorization header and stay scoped to their paired channel', async t => {
    const h = await setup(t);
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'Basic ' + h.token }])
        assert.equal((await h.request('/api/streamdeck/state', { cookie: h.cookie, headers })).status, 401);
    assert.equal((await h.request('/api/streamdeck/state?token=' + h.token)).status, 401);
    assert.equal((await h.control({ action: 'adjust-volume', delta: -20, channel: 'bob' })).status, 200);
    assert.equal((await h.state()).data.settings.volume, 80);
    assert.equal((await h.request('/api/channels/bob/audio-settings')).data.settings.volume, 100);
});

test('replacement and disconnect revoke the old token immediately', async t => {
    const h = await setup(t);
    const original = h.token;
    const replaced = await h.pair();
    assert.equal(replaced.status, 201);
    assert.equal((await h.state(original)).status, 401);
    h.token = replaced.data.token;
    assert.equal((await h.state()).status, 200);
    assert.equal((await h.api('/api/streamdeck/alice/connection', 'DELETE')).status, 200);
    assert.equal((await h.state()).status, 401);
    assert.equal((await h.api('/api/streamdeck/alice/connection')).data.connection, null);
});

test('account deletion, password changes and removed moderator access disable device controls', async t => {
    const h = await setup(t);
    h.accounts[0].password = 'changed';
    assert.equal((await h.state()).status, 401);
    h.accounts[0].password = 'test-only';
    h.accounts[1].access_accounts = ['alice'];
    const moderated = await h.pair('bob');
    assert.equal(moderated.status, 201);
    assert.equal((await h.state(moderated.data.token)).status, 200);
    h.accounts[1].access_accounts = [];
    assert.equal((await h.state(moderated.data.token)).status, 403);
    h.accounts.splice(0, 1);
    assert.equal((await h.state()).status, 401);
});

test('a paired device and its audio settings survive server recreation', async t => {
    const h = await setup(t, { preserveData: true });
    t.after(() => fs.rmSync(h.localRoot, { recursive: true, force: true }));
    await h.control({ action: 'adjust-volume', delta: -37 });
    await h.control({ action: 'toggle-pause' });
    await h.close();
    const restarted = await createTestServer({ localRoot: h.localRoot, preserveData: true });
    t.after(() => restarted.close());
    const state = await restarted.request('/api/streamdeck/state', { headers: { Authorization: 'Bearer ' + h.token } });
    assert.deepEqual(state.data.settings, { volume: 63, paused: true });
    assert.equal(state.data.channel, 'alice');
    await restarted.close();
});

test('dial commands adjust the latest volume, clamp boundaries and broadcast shared pause state', async t => {
    const h = await setup(t);
    await h.api('/api/channels/alice/audio-settings', 'POST', { volume: 50 });
    await Promise.all(Array.from({ length: 10 }, () => h.control({ action: 'adjust-volume', delta: 2 })));
    assert.equal((await h.state()).data.settings.volume, 70);
    await h.control({ action: 'adjust-volume', delta: 100 });
    assert.equal((await h.state()).data.settings.volume, 100);
    await h.control({ action: 'adjust-volume', delta: -100 });
    assert.equal((await h.state()).data.settings.volume, 0);
    const stopped = await h.control({ action: 'toggle-pause' });
    assert.deepEqual(stopped.data.settings, { volume: 0, paused: true });
    const message = h.events.filter(event => event.event === 'audio:settings').at(-1);
    assert.equal(message.room, 'ch:alice');
    assert.deepEqual(message.payload.settings, { volume: 0, paused: true });
    assert.deepEqual((await h.request('/api/channels/alice/audio-settings')).data.settings, stopped.data.settings);
    assert.equal((await h.control({ action: 'toggle-pause' })).data.settings.paused, false);
});

test('invalid commands are rejected without changing settings', async t => {
    const h = await setup(t);
    for (const body of [{ action: 'erase-files' }, { action: 'adjust-volume', delta: 0 }, { action: 'adjust-volume', delta: 101 },
        { action: 'adjust-volume', delta: '2' }, { action: 'adjust-volume', delta: 1.5 }, { action: 'toggle-pause', requestId: '' }])
        assert.equal((await h.control(body)).status, 400);
    assert.deepEqual((await h.state()).data.settings, { volume: 100, paused: false });
});

test('duplicate commands do not toggle or skip twice, and requestId reuse with another action is rejected', async t => {
    const h = await setup(t);
    const command = { action: 'toggle-pause', requestId: randomUUID() };
    const responses = await Promise.all([h.control(command), h.control(command), h.control(command)]);
    assert.ok(responses.every(result => result.data.settings.paused));
    assert.equal((await h.control({ ...command, action: 'skip' })).status, 409);
    await h.add('AAAAAAAAAAA');
    await h.add('BBBBBBBBBBB');
    const current = await h.current();
    const skip = { action: 'skip', playbackId: current._playbackId, requestId: randomUUID() };
    await Promise.all([h.control(skip), h.control(skip)]);
    const next = await h.current();
    assert.match(next.media, /BBBBBBBBBBB/);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
    assert.equal((await h.control(skip)).data.advanced, true);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
});

test('Skip and an overlay finish for the same playback advance only one song', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    await h.add('BBBBBBBBBBB');
    const current = await h.current();
    await Promise.all([
        h.control({ action: 'skip', playbackId: current._playbackId }),
        h.request('/api/channels/alice/next', { method: 'POST', body: { playbackId: current._playbackId } })
    ]);
    assert.match((await h.current()).media, /BBBBBBBBBBB/);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
    const empty = await setup(t);
    assert.equal((await empty.control({ action: 'skip' })).data.advanced, false);
    assert.equal(empty.calls.filter(call => call.action === 'removemedia').length, 0);
});

test('plugin turns adjust app volume; dial press pauses/resumes once and Skip advances once', async t => {
    const h = await setup(t);
    await h.api('/api/channels/alice/audio-settings', 'POST', { volume: 40 });
    await h.add('AAAAAAAAAAA');
    await h.add('BBBBBBBBBBB');
    const current = await h.current();
    const ui = await pluginFor(h);
    await ui.fire('dialRotate', { ticks: 3, settings: { step: 2 } });
    assert.equal((await h.state()).data.settings.volume, 46);
    await ui.fire('dialRotate', { ticks: -2, settings: { step: 5 } });
    assert.equal((await h.state()).data.settings.volume, 36);
    await ui.fire('dialDown');
    await ui.fire('dialUp');
    assert.equal((await h.state()).data.settings.paused, true);
    assert.equal((await h.current())._playbackId, current._playbackId);
    await ui.fire('dialDown');
    assert.equal((await h.state()).data.settings.paused, false);
    await ui.fire('keyDown');
    await ui.fire('keyUp');
    assert.match((await h.current()).media, /BBBBBBBBBBB/);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
    assert.ok(ui.sent.some(message => message.event === 'setFeedback' && message.payload.title === 'Paused'));
});

test('rapid dial turns coalesce while preserving reversals at volume boundaries', async t => {
    const h = await setup(t);
    await h.api('/api/channels/alice/audio-settings', 'POST', { volume: 95 });
    let release;
    let started = false;
    const blocked = new Promise(resolve => { release = resolve; });
    const controls = [];
    const ui = await pluginFor(h, { fetcher: async (url, options) => {
        if (url.endsWith('/control')) {
            controls.push(JSON.parse(options.body));
            if (!started) { started = true; await blocked; }
        }
        return fetch(url, options);
    } });
    const first = ui.fire('dialRotate', { ticks: 1, settings: { step: 10 } });
    await until(() => started);
    const rest = [1, 1, -1].map(ticks => ui.fire('dialRotate', { ticks, settings: { step: 10 } }));
    release();
    await Promise.all([first, ...rest]);
    assert.deepEqual(controls.map(command => command.delta), [10, 20, -10]);
    assert.equal((await h.state()).data.settings.volume, 90);
});

test('plugin refresh follows dashboard changes and reports revoked connections without logging secrets', async t => {
    const h = await setup(t);
    const ui = await pluginFor(h);
    await h.api('/api/channels/alice/audio-settings', 'POST', { volume: 23, paused: true });
    await ui.plugin.refresh();
    assert.equal(ui.sent.filter(message => message.event === 'setFeedback').at(-1).payload.value, '23%');
    assert.equal(ui.sent.filter(message => message.event === 'setFeedback').at(-1).payload.title, 'Paused');
    await h.api('/api/streamdeck/alice/connection', 'DELETE');
    await ui.fire('dialDown');
    assert.ok(ui.sent.some(message => message.event === 'showAlert'));
    assert.equal(ui.sent.filter(message => message.event === 'setFeedback').at(-1).payload.title, 'Check connection');
    assert.equal(JSON.stringify(ui.sent).includes(h.token), false);
});

test('plugin settings reject insecure remote URLs and save a valid connection only after verification', async t => {
    const h = await setup(t);
    for (const baseUrl of ['http://media.example.com', 'https://name:password@example.com', 'https://example.com/?token=bad', 'file:///tmp/file'])
        assert.throws(() => connectionSettings({ baseUrl, token: h.token }));
    const sent = [];
    const plugin = createPlugin({ pluginUUID: 'plugin', send: message => sent.push(message) });
    await plugin.handle({ event: 'sendToPlugin', action: VOLUME, context: 'dial', payload: { command: 'connect', connection: { baseUrl: h.base, token: h.token } } });
    assert.equal(sent.find(message => message.event === 'setGlobalSettings').payload.token, h.token);
    assert.equal(sent.find(message => message.event === 'sendToPropertyInspector').payload.connected, true);
    sent.length = 0;
    await plugin.handle({ event: 'sendToPlugin', action: VOLUME, context: 'dial', payload: { command: 'connect', connection: { baseUrl: h.base, token: 'msd_' + '0'.repeat(64) } } });
    assert.equal(sent.some(message => message.event === 'setGlobalSettings'), false);
    assert.equal(sent.find(message => message.event === 'sendToPropertyInspector').payload.connected, false);
});

function pairingUI(h) {
    const elements = new Map();
    const field = id => {
        if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: false, disabled: false, handlers: {},
            addEventListener(name, fn) { this.handlers[name] = fn; }, fire(name) { return this.handlers[name]?.(); } });
        return elements.get(id);
    };
    let copied;
    const window = { location: { origin: h.base } };
    const context = vm.createContext({ document: { getElementById: field }, window,
        navigator: { clipboard: { async writeText(value) { copied = value; } } },
        fetch: (url, options = {}) => fetch(h.base + url, { ...options, headers: { Cookie: h.cookie } }) });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../scrs/frontend/streamdeck.js'), 'utf8'), context);
    return { field, context, setChannel: window.mediashareStreamDeck.setChannel, copied: () => copied };
}

test('dashboard pairing creates, copies and revokes a token for the selected channel', async t => {
    const h = await setup(t);
    const ui = pairingUI(h);
    await ui.setChannel('alice');
    assert.match(ui.field('streamdeck-status').textContent, /A token exists for alice/);
    await ui.field('streamdeck-create').fire('click');
    const token = ui.field('streamdeck-token').value;
    assert.match(token, /^msd_/);
    assert.equal(ui.field('streamdeck-token-wrap').hidden, false);
    await ui.field('streamdeck-copy').fire('click');
    assert.equal(ui.copied(), token);
    assert.equal((await h.state(token)).status, 200);
    await ui.field('streamdeck-revoke').fire('click');
    assert.equal(ui.field('streamdeck-token').value, '');
    assert.equal(ui.field('streamdeck-token-wrap').hidden, true);
    assert.equal((await h.state(token)).status, 401);
});

test('switching channels during pairing cannot display another channel token', async t => {
    const h = await setup(t);
    h.accounts[1].access_accounts = ['alice'];
    const ui = pairingUI(h);
    await ui.setChannel('alice');
    const original = ui.context.fetch;
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    ui.context.fetch = async (url, options) => { const response = await original(url, options); if (options.method === 'POST') await blocked; return response; };
    const creating = ui.field('streamdeck-create').fire('click');
    await ui.setChannel('bob');
    release();
    await creating;
    assert.equal(ui.field('streamdeck-token').value, '');
    assert.equal(ui.field('streamdeck-token-wrap').hidden, true);
    assert.match(ui.field('streamdeck-status').textContent, /control bob/);
});

test('real plugin process registers over WebSocket and handles a dial event against the HTTP app', async t => {
    const h = await setup(t);
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise(resolve => server.once('listening', resolve));
    const messages = [];
    const connected = new Promise(resolve => server.once('connection', socket => {
        socket.on('message', raw => {
            const message = JSON.parse(raw.toString());
            messages.push(message);
            if (message.event === 'getGlobalSettings') socket.send(JSON.stringify({ event: 'didReceiveGlobalSettings', payload: { settings: { baseUrl: h.base, token: h.token } } }));
        });
        resolve(socket);
    }));
    const child = spawn(process.execPath, [path.resolve(__dirname, '../streamdeck/com.bastiwood.mediashare.sdPlugin/bin/plugin.js'),
        '-port', String(server.address().port), '-pluginUUID', 'test-registration', '-registerEvent', 'registerPlugin', '-info', '{}'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    t.after(async () => {
        child.kill();
        for (const socket of server.clients) socket.terminate();
        await new Promise(resolve => server.close(resolve));
    });
    const socket = await connected;
    await until(() => messages.some(message => message.event === 'getGlobalSettings'));
    assert.deepEqual(messages[0], { event: 'registerPlugin', uuid: 'test-registration' });
    socket.send(JSON.stringify({ event: 'willAppear', context: 'dial', action: VOLUME, payload: { settings: { step: 2 } } }));
    socket.send(JSON.stringify({ event: 'dialRotate', context: 'dial', action: VOLUME, payload: { ticks: -4, settings: { step: 2 } } }));
    await until(() => messages.some(message => message.event === 'setFeedback' && message.payload.value === '92%'));
    assert.equal((await h.state()).data.settings.volume, 92);
    assert.equal(stderr, '');
});

test('the property inspector registers, sends settings and displays connection verification', () => {
    const fields = new Map();
    function field(id) {
        if (!fields.has(id)) fields.set(id, { value: '', hidden: false, disabled: true, handlers: {}, textContent: '', addEventListener(name, fn) { this.handlers[name] = fn; } });
        return fields.get(id);
    }
    const messages = [];
    let socket;
    const window = {};
    const context = vm.createContext({ document: { getElementById: field }, window, WebSocket: class {
        constructor(url) { this.url = url; this.readyState = 1; socket = this; }
        send(value) { messages.push(JSON.parse(value)); }
    } });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../streamdeck/com.bastiwood.mediashare.sdPlugin/ui/settings.js'), 'utf8'), context);
    window.connectElgatoStreamDeckSocket('12345', 'action-context', 'registerPropertyInspector', '{}', JSON.stringify({ action: VOLUME, payload: { settings: { step: 3 } } }));
    socket.onopen();
    assert.deepEqual(messages[0], { event: 'registerPropertyInspector', uuid: 'action-context' });
    assert.equal(field('dial-settings').hidden, false);
    assert.equal(field('step').value, 3);
    const token = 'msd_' + 'a'.repeat(64);
    socket.onmessage({ data: JSON.stringify({ event: 'didReceiveGlobalSettings', payload: { settings: { baseUrl: 'https://media.example.com', token } } }) });
    field('connect').handlers.click();
    assert.deepEqual(messages.find(message => message.event === 'setSettings').payload, { step: 3 });
    assert.deepEqual(messages.find(message => message.event === 'sendToPlugin'), {
        event: 'sendToPlugin', context: 'action-context', action: VOLUME,
        payload: { command: 'connect', connection: { baseUrl: 'https://media.example.com', token } }
    });
    socket.onmessage({ data: JSON.stringify({ event: 'sendToPropertyInspector', payload: { connected: true, message: 'Connected to alice.' } }) });
    assert.equal(field('status').textContent, 'Connected to alice.');
    assert.equal(field('connect').disabled, false);
});

test('the dashboard serves a public installer and blocks private connection files', async t => {
    const h = await setup(t);
    const packageFile = path.resolve(__dirname, '../streamdeck/com.bastiwood.mediashare.streamDeckPlugin');
    const downloaded = await fetch(h.base + '/api/streamdeck/plugin');
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-disposition'), /attachment.*com\.bastiwood\.mediashare\.streamDeckPlugin/);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304');
    assert.deepEqual(bytes, fs.readFileSync(packageFile));
    const file = fs.readdirSync(path.join(h.localRoot, '.streamdeck'))[0];
    for (const route of ['/data/streamdeck/' + file, '/%64ata/streamdeck/' + file])
        assert.equal((await fetch(h.base + route)).status, 403);
});
