'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setImmediate: nextTick } = require('node:timers/promises');
const { createYouTubeCache } = require('../scrs/backend/youtube-cache');
const { createMediaTools } = require('./helpers/media-tools');
const { createTestServer } = require('./helpers/server');
const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', C = 'CCCCCCCCCCC', D = 'DDDDDDDDDDD';

async function until(predicate) {
    for (let i = 0; i < 2000; i++) { if (predicate()) return; await nextTick(); }
    throw new Error('Cache did not reach expected state');
}
function setup(t, options = {}, toolsOptions = {}) {
    const root = fs.mkdtempSync(path.resolve(__dirname, '.tmp-cache-'));
    const tools = createMediaTools(toolsOptions);
    const cache = createYouTubeCache({ root, spawn: tools.spawn, ...options });
    t.after(async () => { await cache.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, tools, cache };
}

test('completed files and metadata survive restart; abandoned and invalid cache files are discarded', async t => {
    const { root, tools, cache } = setup(t);
    const file = await cache.prepare(A);
    await cache.close();
    fs.mkdirSync(path.join(root, '.staging', 'abandoned'));
    fs.writeFileSync(path.join(root, '.staging', 'abandoned', 'partial.mp4'), 'unfinished');
    fs.writeFileSync(path.join(root, B + '.mp3'), 'orphan');
    fs.writeFileSync(path.join(root, C + '.json'), '{}');
    const restart = createYouTubeCache({ root, spawn: tools.spawn });
    t.after(() => restart.close());
    assert.equal(restart.status(A).status, 'ready');
    assert.equal((await restart.prepare(A)).bytes, file.bytes);
    assert.equal(tools.calls.filter(call => call.command === 'yt-dlp').length, 1);
    assert.equal(fs.existsSync(path.join(root, B + '.mp3')), false);
    assert.equal(fs.existsSync(path.join(root, C + '.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(root, '.staging')), []);
});

test('LRU and TTL cleanup respect active HTTP leases and never touch local uploads', async t => {
    let clock = 1000;
    const { root, cache } = setup(t, { now: () => clock, maxBytes: 48, maxEntryBytes: 24, ttlMs: 100 });
    const lease = cache.acquire(A);
    await lease.ready;
    clock++;
    await cache.prepare(B, { direct: false });
    clock++;
    await cache.prepare(C, { direct: false });
    assert.equal(cache.status(A).status, 'ready');
    assert.equal(cache.status(B).status, 'preparing');
    assert.equal(cache.status(C).status, 'ready');
    fs.writeFileSync(path.join(root, 'local-upload.mp3'), 'keep this unrelated file');
    clock += 200;
    cache.cleanup();
    assert.equal(cache.status(A).status, 'ready');
    assert.equal(cache.status(C).status, 'preparing');
    lease.release(); lease.release();
    cache.cleanup();
    assert.equal(cache.status(A).status, 'preparing');
    assert.equal(fs.readFileSync(path.join(root, 'local-upload.mp3'), 'utf8'), 'keep this unrelated file');
});

test('a protected full cache rejects admission instead of publishing a file over the budget', async t => {
    const { root, cache } = setup(t, { maxBytes: 24, maxEntryBytes: 24 });
    const lease = cache.acquire(A);
    await lease.ready;
    await assert.rejects(cache.prepare(B), { code: 'CACHE_FULL' });
    assert.equal(cache.status(A).status, 'ready');
    assert.equal(fs.existsSync(path.join(root, B + '.mp3')), false);
    lease.release();
});

test('current playback has a reserved worker; repeated info polls do not cancel useful prefetch', async t => {
    const { cache, tools } = setup(t, {}, { blockDownloads: true });
    cache.plan('alice', A, [B, C]);
    await until(() => tools.pending.length === 2);
    assert.equal(tools.calls.filter(call => call.command === 'yt-dlp').length, 2);
    for (let i = 0; i < 5; i++) cache.request(A);
    assert.ok(tools.calls.every(call => call.signals.length === 0));
    tools.release(A);
    await until(() => cache.status(A).status === 'ready');
    // Another current song starts even while B's background download is blocked.
    const current = cache.acquire(D);
    await until(() => tools.pending.some(item => item.call.args.at(-1).endsWith(D)));
    tools.release(D);
    await current.ready;
    assert.equal(cache.status(D).status, 'ready');
    assert.ok(tools.calls.find(call => call.args.at(-1).endsWith(B)).signals.length === 0);
    current.release();
    tools.release(B);
    await until(() => tools.pending.some(item => item.call.args.at(-1).endsWith(C)));
    tools.release(C);
    await until(() => cache.status(C).status === 'ready');
});

test('changing a plan cancels obsolete current and background jobs and removes incomplete files', async t => {
    const { root, cache, tools } = setup(t, {}, { blockDownloads: true });
    cache.plan('alice', A, [B]);
    await until(() => tools.pending.length === 2);
    const old = tools.calls.slice();
    cache.plan('alice', C, []);
    await until(() => old.every(call => call.signals.includes('SIGTERM')));
    assert.equal(fs.existsSync(path.join(root, A + '.mp3')), false);
    assert.equal(fs.existsSync(path.join(root, B + '.mp3')), false);
    await until(() => tools.pending.some(item => item.call.args.at(-1).endsWith(C)));
    tools.release(C);
    await until(() => cache.status(C).status === 'ready');
    assert.deepEqual(fs.readdirSync(path.join(root, '.staging')), []);
});

test('disconnected players expire their prefetch plan and shut down unwanted download jobs', async t => {
    let clock = 1000;
    const { cache, tools } = setup(t, { now: () => clock }, { blockDownloads: true });
    cache.plan('alice', A, [B, C]);
    await until(() => tools.pending.length === 2);
    clock += 120001;
    cache.cleanup();
    await until(() => tools.calls.every(call => call.signals.includes('SIGTERM')));
    assert.equal(cache.status(A).status, 'failed');
    assert.equal(cache.status(C).status, 'failed');
});

test('oversized downloads and partial conversions are rejected without a playable cache file', async t => {
    const { root, cache, tools } = setup(t, { maxEntryBytes: 30 }, { sourceBytes: 31 });
    await assert.rejects(cache.prepare(A), { code: 'MEDIA_TOO_LARGE' });
    assert.equal(tools.calls.filter(call => call.command === 'yt-dlp').length, 1);
    assert.equal(fs.existsSync(path.join(root, A + '.mp3')), false);
    assert.deepEqual(fs.readdirSync(path.join(root, '.staging')), []);
});

test('tool timeouts terminate the subprocess and leave no partial audio published', async t => {
    const { root, cache, tools } = setup(t, { downloadTimeoutMs: 15 }, { blockDownloads: true });
    await assert.rejects(cache.prepare(A), { code: 'PREPARATION_TIMEOUT' });
    assert.ok(tools.calls.every(call => call.signals.includes('SIGKILL')));
    assert.equal(fs.existsSync(path.join(root, A + '.mp3')), false);
});

test('real ffmpeg extracts, normalizes and decodes synthetic MP4 audio before byte-range playback', async t => {
    const root = fs.mkdtempSync(path.resolve(__dirname, '.tmp-mp4-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = path.join(root, 'fixture.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=0.4',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-shortest', '-c:v', 'mpeg4', '-c:a', 'aac', fixture]);
    let downloads = 0;
    const cacheSpawn = (command, args, options) => {
        if (command !== 'yt-dlp') return spawn(command, args, options);
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => { child.emit('close', 143); return true; };
        setImmediate(() => {
            downloads++;
            if (downloads === 1) { child.stderr.end('HTTP Error 403'); child.stdout.end(); child.emit('close', 1); return; }
            fs.copyFileSync(fixture, args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4'));
            child.stdout.end(); child.stderr.end(); child.emit('close', 0);
        });
        return child;
    };
    const h = await createTestServer({ cacheSpawn });
    t.after(() => h.close());
    const audio = await fetch(h.base + '/api/yt-audio/' + A);
    assert.equal(audio.status, 200);
    const buffer = Buffer.from(await audio.arrayBuffer());
    assert.ok(buffer.length > 1000);
    const file = path.join(h.localRoot, '.youtube-cache', A + '.mp3');
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type', '-of', 'json', file]));
    assert.equal(probe.streams.length, 1);
    assert.equal(probe.streams[0].codec_name, 'mp3');
    assert.ok(Number(probe.format.duration) > 0.3);
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
    const range = await fetch(h.base + '/api/yt-audio/' + A, { headers: { Range: 'bytes=0-511' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), buffer.subarray(0, 512));
    assert.equal(downloads, 2);
});
