'use strict';

const { randomUUID } = require('node:crypto');
const SKIP = 'com.bastiwood.mediashare.skip';
const VOLUME = 'com.bastiwood.mediashare.volume';

function connectionSettings(value = {}) {
    let url;
    try { url = new URL(value.baseUrl); } catch {}
    if (!url || url.username || url.password || url.search || url.hash
        || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
        throw new Error('Enter your HTTPS website address (or HTTP localhost for testing).');
    if (!/^msd_[a-f0-9]{64}$/.test(value.token || '')) throw new Error('Paste a connection token from the Mediashare dashboard.');
    return { baseUrl: url.href.replace(/\/+$/, ''), token: value.token };
}

// No SDK/runtime dependencies to install: Stream Deck runs this with Node 24.
// The documented local WebSocket protocol handles keys, encoders and feedback.
function createPlugin({ send, pluginUUID, fetcher = fetch, requestId = randomUUID }) {
    const actions = new Map();
    let connection = null;
    let state = null;
    let error = 'Connect in settings';
    let generation = 0;
    let revision = 0;
    let reading = false;
    let working = false;
    let queue = [];
    let idle = Promise.resolve();

    async function request(settings, route, body) {
        const response = await fetcher(settings.baseUrl + '/api/streamdeck/' + route, {
            method: body ? 'POST' : 'GET',
            headers: { Authorization: 'Bearer ' + settings.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(5000), redirect: 'error', cache: 'no-store'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Update the Mediashare server and check the connection settings.');
        if (typeof data.channel !== 'string' || typeof data.settings?.volume !== 'number' || typeof data.settings.paused !== 'boolean')
            throw new Error('The website returned an invalid playback state.');
        return data;
    }

    function render() {
        for (const [context, action] of actions) {
            if (action.action === VOLUME) {
                send({ event: 'setFeedback', context, payload: {
                    title: error ? 'Check connection' : state?.settings.paused ? 'Paused' : state?.channel || 'Volume',
                    value: error ? '—' : `${Math.round(state?.settings.volume ?? 100)}%`,
                    indicator: error ? 0 : state?.settings.volume ?? 100,
                    icon: 'images/volume.svg'
                } });
            } else {
                send({ event: 'setTitle', context, payload: { title: error ? 'Connect' : 'Skip', target: 0 } });
            }
        }
    }

    async function refresh() {
        if (!connection || reading || working) return;
        reading = true;
        const version = generation;
        const startedAt = revision;
        try {
            const result = await request(connection, 'state');
            if (version === generation && startedAt === revision) { state = result; error = ''; render(); }
        } catch (err) {
            if (version === generation && startedAt === revision) { error = err.message; render(); }
        } finally { reading = false; }
    }

    function configure(settings) {
        try {
            const next = connectionSettings(settings);
            if (connection?.baseUrl === next.baseUrl && connection.token === next.token) return;
            connection = next;
            error = 'Connecting…';
        } catch (err) { connection = null; error = err.message; }
        generation++;
        state = null;
        queue = [];
        render();
    }

    function enqueue(command, context) {
        if (!connection) { send({ event: 'showAlert', context }); return Promise.resolve(); }
        const previous = queue.at(-1);
        if (command.action === 'adjust-volume' && previous?.command.action === 'adjust-volume'
            && previous.generation === generation && Math.sign(previous.command.delta) === Math.sign(command.delta)) {
            // Merge only equal directions; a reversal at 0/100 must retain its
            // order. Commands already on the wire are never modified/retried.
            previous.command.delta = Math.sign(command.delta) * Math.min(100, Math.abs(previous.command.delta + command.delta));
        } else queue.push({ command: { requestId: requestId(), ...command }, context, generation });
        if (!working) {
            working = true;
            idle = Promise.resolve().then(async () => {
                try {
                    while (queue.length) {
                        const item = queue.shift();
                        if (item.generation !== generation) continue;
                        revision++;
                        try {
                            // Capture the playback identity immediately before
                            // sending, so a previous Skip cannot stale the next.
                            if (item.command.action === 'skip' && state?.playbackId)
                                item.command.playbackId = state.playbackId;
                            const result = await request(connection, 'control', item.command);
                            if (item.generation === generation) { state = result; error = ''; render(); }
                        } catch (err) {
                            if (item.generation === generation) {
                                error = err.message;
                                render();
                                send({ event: 'showAlert', context: item.context });
                            }
                        }
                    }
                } finally { working = false; }
            });
        }
        return idle;
    }

    async function handle(message) {
        const payload = message.payload || {};
        if (message.event === 'didReceiveGlobalSettings') {
            configure(payload.settings || {});
            await refresh();
        } else if (message.event === 'willAppear') {
            actions.set(message.context, { action: message.action, settings: payload.settings || {} });
            render();
            await refresh();
        } else if (message.event === 'willDisappear') actions.delete(message.context);
        else if (message.event === 'didReceiveSettings') {
            const action = actions.get(message.context);
            if (action) action.settings = payload.settings || {};
        } else if (message.event === 'keyDown' && message.action === SKIP) {
            await enqueue({ action: 'skip' }, message.context);
        } else if (message.event === 'dialDown' && message.action === VOLUME) {
            await enqueue({ action: 'toggle-pause' }, message.context);
        } else if (message.event === 'dialRotate' && message.action === VOLUME && Number.isInteger(payload.ticks) && payload.ticks !== 0) {
            const setting = payload.settings?.step ?? actions.get(message.context)?.settings.step;
            const step = Number.isInteger(Number(setting)) && Number(setting) >= 1 && Number(setting) <= 10 ? Number(setting) : 2;
            await enqueue({ action: 'adjust-volume', delta: Math.sign(payload.ticks) * Math.min(100, Math.abs(payload.ticks * step)) }, message.context);
        } else if (message.event === 'sendToPlugin' && payload.command === 'connect') {
            try {
                const settings = connectionSettings(payload.connection);
                const result = await request(settings, 'state');
                configure(settings);
                state = result;
                error = '';
                render();
                send({ event: 'setGlobalSettings', context: pluginUUID, payload: settings });
                send({ event: 'sendToPropertyInspector', context: message.context, action: message.action,
                    payload: { connected: true, message: `Connected to ${result.channel}. Volume ${result.settings.volume}%.` } });
            } catch (err) {
                send({ event: 'sendToPropertyInspector', context: message.context, action: message.action,
                    payload: { connected: false, message: err.message } });
            }
        }
    }
    return { handle, refresh, settled: () => idle };
}

function start(argv = process.argv.slice(2), WebSocketType = WebSocket) {
    const args = new Map();
    for (let i = 0; i + 1 < argv.length; i += 2) args.set(argv[i], argv[i + 1]);
    const port = Number(args.get('-port'));
    const pluginUUID = args.get('-pluginUUID');
    const registerEvent = args.get('-registerEvent');
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !pluginUUID || !registerEvent)
        throw new Error('Start this plugin from the Stream Deck application.');
    const socket = new WebSocketType(`ws://127.0.0.1:${port}`);
    const send = message => { if (socket.readyState === 1) socket.send(JSON.stringify(message)); };
    const plugin = createPlugin({ send, pluginUUID });
    socket.addEventListener('open', () => {
        send({ event: registerEvent, uuid: pluginUUID });
        send({ event: 'getGlobalSettings', context: pluginUUID });
    });
    socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        plugin.handle(message).catch(() => {});
    });
    socket.addEventListener('error', () => {});
    const timer = setInterval(() => { plugin.refresh().catch(() => {}); }, 1000);
    timer.unref();
    socket.addEventListener('close', () => clearInterval(timer));
    return { socket, plugin };
}

if (require.main === module) start();
module.exports = { createPlugin, connectionSettings, start, SKIP, VOLUME };
