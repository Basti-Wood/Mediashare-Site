'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes, createHash } = require('crypto');

const digest = value => createHash('sha256').update(value).digest('hex');
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

// One revocable connection per account/channel. Only a hash is kept on disk.
function createStreamDeckTokens(root) {
    const records = new Map();
    const keyFor = (username, channel) => digest(JSON.stringify([username, channel]));
    const fileFor = key => path.join(root, `${key}.json`);
    if (fs.existsSync(root)) {
        for (const filename of fs.readdirSync(root)) {
            if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
            try {
                const record = JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8'));
                if (record && typeof record.username === 'string' && typeof record.channel === 'string'
                    && /^[a-f0-9]{64}$/.test(record.hash) && typeof record.authVersion === 'string')
                    records.set(keyFor(record.username, record.channel), record);
            } catch (err) {
                if (!(err instanceof SyntaxError) && err.code !== 'ENOENT') throw err;
            }
        }
    }
    function status(username, channel) {
        const record = records.get(keyFor(username, channel));
        return record ? { channel: record.channel, createdAt: record.createdAt } : null;
    }
    return {
        status,
        create(username, channel, authVersion) {
            const key = keyFor(username, channel);
            const token = `msd_${randomBytes(32).toString('hex')}`;
            const record = { username, channel, authVersion, hash: digest(token), createdAt: new Date().toISOString() };
            fs.mkdirSync(root, { recursive: true, mode: 0o700 });
            const file = fileFor(key);
            try {
                fs.writeFileSync(file + '.tmp', JSON.stringify(record) + '\n', { mode: 0o600 });
                fs.renameSync(file + '.tmp', file);
            } finally {
                fs.rmSync(file + '.tmp', { force: true });
            }
            records.set(key, record);
            return { token, connection: status(username, channel) };
        },
        revoke(username, channel) {
            const key = keyFor(username, channel);
            fs.rmSync(fileFor(key), { force: true });
            records.delete(key);
        },
        find(authorization) {
            const token = /^Bearer (msd_[a-f0-9]{64})$/.exec(authorization || '')?.[1];
            if (!token) return null;
            const hash = digest(token);
            return [...records.values()].find(record => record.hash === hash) || null;
        }
    };
}

// Relative adjustments read the latest volume on the server. Dial events can
// arrive faster than HTTP responses, so clients never calculate absolute values.
function createStreamDeckCommands({ audioSettings, skip, state, onSettings, now = Date.now }) {
    const requests = new Map();
    return async function execute(channel, command) {
        if (!command || typeof command !== 'object' || Array.isArray(command)
            || typeof command.requestId !== 'string'
            || !/^[A-Za-z0-9_-]{8,80}$/.test(command.requestId || '')
            || !['skip', 'adjust-volume', 'toggle-pause'].includes(command.action)
            || (command.action === 'adjust-volume' && (!Number.isInteger(command.delta) || Math.abs(command.delta) > 100 || command.delta === 0))
            || (command.playbackId !== undefined && command.playbackId !== null && typeof command.playbackId !== 'string'))
            throw failure('Use a valid requestId and skip, adjust-volume or toggle-pause action.');
        const key = JSON.stringify([channel, command.requestId]);
        const signature = JSON.stringify([command.action, command.delta, command.playbackId]);
        for (const [id, record] of requests) {
            if (record.expires <= now() && record.finished) requests.delete(id);
        }
        const previous = requests.get(key);
        if (previous) {
            if (previous.signature !== signature) throw failure('requestId was already used for a different command.', 409);
            return previous.promise;
        }
        if (requests.size >= 4096) throw failure('Too many control requests. Please try again shortly.', 429);
        const record = { signature, expires: now() + 120000, finished: false };
        record.promise = Promise.resolve().then(async () => {
            let advanced;
            if (command.action === 'skip') {
                advanced = (await skip(channel, command.playbackId))?.advanced;
            } else {
                const current = audioSettings.get(channel);
                const changes = command.action === 'toggle-pause' ? { paused: !current.paused }
                    : { volume: Math.max(0, Math.min(100, current.volume + command.delta)) };
                const settings = audioSettings.update(channel, changes);
                onSettings(channel, settings);
            }
            return { success: true, ...state(channel), ...(advanced === undefined ? {} : { advanced }) };
        }).finally(() => { record.finished = true; });
        requests.set(key, record);
        return record.promise;
    };
}

module.exports = { createStreamDeckTokens, createStreamDeckCommands };
