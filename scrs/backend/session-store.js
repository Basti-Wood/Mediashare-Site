'use strict';

const fs = require('fs');
const path = require('path');
const { createHash, randomBytes, randomUUID } = require('crypto');
const { Store } = require('express-session');

const DAY = 24 * 60 * 60 * 1000;
const REMEMBER_LOGIN_MS = 30 * DAY;

function persistentSessionSecret(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, '.secret');
    try {
        fs.writeFileSync(file, randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch (err) { if (err.code !== 'EEXIST') throw err; }
    return fs.readFileSync(file, 'utf8').trim();
}

class FileSessionStore extends Store {
    constructor(directory, { now = Date.now } = {}) {
        super();
        this.directory = directory;
        this.now = now;
        this.pending = new Map();
        this.revoked = new Map();
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.prune().catch(() => {});
        this.cleanupTimer = setInterval(() => this.prune().catch(() => {}), 60 * 60 * 1000);
        this.cleanupTimer.unref();
    }

    filename(id) {
        // The browser's opaque ID is never interpreted as a filesystem path.
        return path.join(this.directory, createHash('sha256').update(String(id)).digest('hex') + '.json');
    }

    queued(file, action) {
        const pending = (this.pending.get(file) || Promise.resolve()).catch(() => {}).then(action);
        this.pending.set(file, pending);
        const finish = () => { if (this.pending.get(file) === pending) this.pending.delete(file); };
        pending.then(finish, finish);
        return pending;
    }

    enqueue(id, action, callback = () => {}) {
        this.queued(this.filename(id), action).then(value => callback(null, value), callback);
    }

    async read(file) {
        let record;
        try { record = JSON.parse(await fs.promises.readFile(file, 'utf8')); }
        catch (err) {
            if (err.code === 'ENOENT') return null;
            if (!(err instanceof SyntaxError)) throw err;
        }
        if (!record || !Number.isFinite(record.expires) || record.expires <= this.now()
            || !record.session || typeof record.session !== 'object') {
            await fs.promises.rm(file, { force: true });
            return null;
        }
        return record;
    }

    async write(file, data) {
        const expiry = data.cookie?.expires ? new Date(data.cookie.expires).getTime() : this.now() + DAY;
        const temporary = file + '.' + randomUUID() + '.tmp';
        try {
            await fs.promises.writeFile(temporary, JSON.stringify({ expires: expiry, session: data }), { mode: 0o600 });
            await fs.promises.rename(temporary, file);
        } finally {
            await fs.promises.rm(temporary, { force: true });
        }
    }

    get(id, callback) {
        this.enqueue(id, async () => this.revoked.has(id) ? null : (await this.read(this.filename(id)))?.session || null, callback);
    }

    set(id, data, callback) {
        this.enqueue(id, () => this.revoked.has(id) ? undefined : this.write(this.filename(id), data), callback);
    }

    touch(id, data, callback) {
        this.enqueue(id, async () => {
            if (this.revoked.has(id)) return;
            const record = await this.read(this.filename(id));
            if (!record) return; // a late request cannot restore a logged-out session
            record.session.cookie = data.cookie;
            await this.write(this.filename(id), record.session);
        }, callback);
    }

    destroy(id, callback) {
        this.revoked.set(id, this.now() + REMEMBER_LOGIN_MS);
        this.enqueue(id, () => fs.promises.rm(this.filename(id), { force: true }), callback);
    }

    async prune() {
        for (const [id, expires] of this.revoked) if (expires <= this.now()) this.revoked.delete(id);
        const names = await fs.promises.readdir(this.directory);
        for (const name of names) if (/^[a-f0-9]{64}\.json$/.test(name)) {
            const file = path.join(this.directory, name);
            await this.queued(file, () => this.read(file));
        }
    }

    async close() {
        clearInterval(this.cleanupTimer);
        await Promise.allSettled([...this.pending.values()]);
    }
}

module.exports = { FileSessionStore, persistentSessionSecret, REMEMBER_LOGIN_MS };
