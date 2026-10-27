'use strict';

// Run the real routes, middleware and sessions against a local HTTP server.
// Only credentials, sockets and the external Basti/YouTube services are faked.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const serverFile = path.resolve(__dirname, '../../scrs/backend/server.js');
const serverRequire = createRequire(serverFile);

async function createTestServer(options = {}) {
    const queues = new Map();
    const calls = [];
    const events = [];
    const accounts = ['alice', 'bob'].map(channel => ({
        username: channel, password: 'test-only', channel, access_accounts: []
    }));
    let server;
    let listen;
    let failPromotion = null;
    let beforePromotion = null;

    const sandbox = {
        __dirname: path.dirname(serverFile),
        process: { env: { SESSION_SECRET: 'test-only', BASTI_POLLING_ONLY: 'true' } },
        console: { log() {}, warn() {}, error() {} },
        Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
        Math: Object.assign(Object.create(Math), { random: options.random || Math.random }),
        require(name) {
            if (name === 'dotenv') return { config() {} };
            if (name === 'fs') return {
                ...fs,
                readFileSync(file, ...args) {
                    if (String(file).endsWith(`${path.sep}conf${path.sep}accounts.json`))
                        return JSON.stringify({ accounts });
                    return fs.readFileSync(file, ...args);
                }
            };
            if (name === 'http') return {
                ...http,
                createServer(app) {
                    server = http.createServer(app);
                    listen = server.listen.bind(server);
                    server.listen = () => server; // choose an ephemeral port below
                    return server;
                }
            };
            if (name === 'socket.io') return {
                Server: class {
                    on() {}
                    to(room) { return { emit: (event, payload) => events.push({ room, event, payload }) }; }
                }
            };
            return serverRequire(name);
        },
        async fetch(rawUrl, init = {}) {
            const url = new URL(rawUrl);
            if (url.hostname === 'www.youtube.com' && url.pathname === '/oembed')
                return { ok: true, json: async () => ({ title: new URL(url.searchParams.get('url')).searchParams.get('v') }) };
            if (url.hostname !== 'api.bastiwood.com') throw new Error(`Unexpected external request: ${url}`);
            const [action, channel, username, media] = url.pathname.slice(1).split('/').map(decodeURIComponent);
            const queue = queues.get(channel) || [];
            queues.set(channel, queue);
            calls.push({ action, channel, method: init.method || 'GET' });
            if (action === 'getallmedia')
                return { ok: true, json: async () => ({ media: queue.map(item => ({ ...item })) }) };
            if (action === 'setmediatop') {
                if (beforePromotion) await beforePromotion();
                if (failPromotion) {
                    const failure = failPromotion;
                    failPromotion = null;
                    if (failure === 'network') throw new Error('Upstream offline');
                    return { ok: failure !== 'http', status: 503, json: async () => ({ success: false, error: 'Rejected' }) };
                }
                // Deliberately reuse the upstream ID, including for one-song loops.
                queue.unshift({ id: 'stable-id', media, username, owner_song: true, Platform: 'youtube' });
            } else if (action === 'removemedia') {
                queue.splice(Number(username), 1);
            } else {
                throw new Error(`Unexpected upstream action: ${action}`);
            }
            return { ok: true, json: async () => ({ success: true }) };
        }
    };
    vm.runInNewContext(fs.readFileSync(serverFile, 'utf8'), sandbox, { filename: serverFile });
    server.listen = listen;
    await new Promise(resolve => listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    async function request(route, { method = 'GET', body, cookie } = {}) {
        const res = await fetch(base + route, {
            method,
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        const data = await res.json();
        return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0] };
    }

    async function login(channel = 'alice') {
        return (await request('/api/auth/login', { method: 'POST', body: { username: channel, password: 'test-only' } })).cookie;
    }

    return {
        base, calls, events, queues, request, login,
        failPromotion(kind) { failPromotion = kind; },
        beforePromotion(action) { beforePromotion = action; },
        async close() {
            server.closeAllConnections();
            await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
        }
    };
}

module.exports = { createTestServer };
