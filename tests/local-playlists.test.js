'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setImmediate: nextTick } = require('node:timers/promises');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { createTestServer } = require('./helpers/server');
const { createDownloader, entries } = require('./helpers/downloader');
const { playlistUrl } = require('../scrs/backend/playlist-imports');

const playlist = 'https://www.youtube.com/playlist?list=PLtest123';

async function setup(t, options = {}) {
    const downloader = createDownloader(options);
    const h = await createTestServer({ spawn: downloader.spawn });
    t.after(() => h.close());
    const cookie = await h.login();
    h.api = (route, method = 'GET', body) => h.request(route, { method, body, cookie });
    h.start = body => h.api('/api/local/alice/playlist-import', 'POST', body || { url: playlist });
    h.status = async () => (await h.api('/api/local/alice/playlist-import')).data.job;
    h.files = async folder => (await h.api('/api/local/alice/files' + (folder ? '/' + encodeURIComponent(folder) : ''))).data.files;
    return { h, downloader };
}

async function until(predicate) {
    for (let i = 0; i < 1000; i++) {
        if (predicate()) return;
        await nextTick();
    }
    throw new Error('Download did not reach expected state');
}

test('playlist URLs are canonicalized and reject other hosts, protocols and credentials', () => {
    assert.deepEqual(playlistUrl('https://www.youtube.com/watch?v=AAAAAAAAAAA&list=PLtest123&t=10'), {
        id: 'PLtest123', url: playlist
    });
    for (const url of ['not a URL', 'https://youtube.com/watch?v=AAAAAAAAAAA',
        'https://youtube.com.evil.test/playlist?list=PLtest123',
        'https://youtube.com@evil.test/playlist?list=PLtest123',
        'http://youtube.com/playlist?list=PLtest123',
        'file:///etc/passwd?list=PLtest123',
        'https://user:pass@youtube.com/playlist?list=PLtest123',
        'https://youtube.com:1234/playlist?list=PLtest123',
        'https://youtube.com/playlist?list=../../escape'])
        assert.throws(() => playlistUrl(url), { status: 400 });
});

test('import, status, cancellation and local queue require channel access', async t => {
    const { h, downloader } = await setup(t);
    for (const [route, method] of [['playlist-import', 'POST'], ['playlist-import', 'GET'],
        ['playlist-import/unknown', 'DELETE'], ['queue', 'POST']]) {
        assert.equal((await h.request('/api/local/alice/' + route, { method, body: method === 'POST' ? { url: playlist } : undefined })).status, 401);
        assert.equal((await h.api('/api/local/bob/' + route, method, method === 'POST' ? { url: playlist } : undefined)).status, 403);
    }
    assert.equal(downloader.calls.length, 0);
});

test('invalid import input never starts a downloader', async t => {
    const { h, downloader } = await setup(t);
    for (const body of [{}, { url: 'https://example.com/playlist?list=PLtest123' },
        { url: playlist, folder: '../escape' }, { url: playlist, folder: '/absolute' }])
        assert.equal((await h.start(body)).status, 400);
    assert.equal(downloader.calls.length, 0);
});

test('playlist imports run in the background, normalize MP3s and expose ordered local files', async t => {
    const { h, downloader } = await setup(t);
    const response = await h.start({ url: 'https://youtube.com/watch?v=AAAAAAAAAAA&list=PLtest123' });
    assert.equal(response.status, 202);
    assert.equal(response.data.job.status, 'running');
    await h.settleImport();
    const job = await h.status();
    assert.equal(job.status, 'completed');
    assert.equal(job.total, 2);
    assert.equal(job.saved, 2);
    assert.equal(job.processed, 2);
    const files = await h.files(job.folder);
    assert.deepEqual(files.map(file => file.name.slice(0, 5)), ['00001', '00002']);
    const audio = await fetch(`${h.base}/api/local-media/alice/${job.folder}/${encodeURIComponent(files[0].name)}`);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.equal(Buffer.from(await audio.arrayBuffer()).toString(), 'ID3 normalized test audio');
    const metadata = downloader.calls.find(call => call.args.includes('--dump-single-json'));
    assert.equal(metadata.args.at(-1), playlist);
    assert.equal(metadata.options.shell, false);
    assert.ok(downloader.calls.filter(call => call.command === 'yt-dlp' && call.args.includes('--extract-audio'))
        .every(call => call.args.includes('--no-playlist') && call.args.includes('mp3')));
    assert.ok(h.events.some(event => event.event === 'local:import:update' && event.payload.job.saved === 2));
    assert.equal(fs.readdirSync(path.join(h.localRoot, '.playlist-downloads')).length, 0);
    const folders = (await h.api('/api/local/alice/folders')).data.folders;
    assert.deepEqual(folders, [job.folder]);
});

test('an active import is recoverable through status and blocks a second import', async t => {
    const { h, downloader } = await setup(t, { blockId: entries[0].id });
    const started = await h.start();
    await until(() => downloader.blocked.length > 0);
    assert.equal((await h.start()).status, 409);
    assert.equal((await h.status()).id, started.data.job.id);
    assert.equal((await h.status()).status, 'running');
    downloader.release();
    await h.settleImport();
    assert.equal((await h.status()).status, 'completed');
});

test('repeat imports preserve existing MP3s and report them as already saved', async t => {
    const { h } = await setup(t);
    await h.start({ url: playlist, folder: 'My music' });
    await h.settleImport();
    const [file] = await h.files('My music');
    const existing = path.join(h.localRoot, 'alice', file.folder, file.name);
    fs.writeFileSync(existing, 'original recording');
    await h.start({ url: playlist, folder: 'My music' });
    await h.settleImport();
    assert.equal((await h.status()).saved, 0);
    assert.equal((await h.status()).skipped, 2);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'original recording');
});

test('an unavailable video is reported while the remaining songs finish', async t => {
    const { h } = await setup(t, { failId: entries[0].id });
    await h.start();
    await h.settleImport();
    const job = await h.status();
    assert.equal(job.status, 'partial');
    assert.equal(job.saved, 1);
    assert.equal(job.failed, 1);
    assert.match(job.warnings[0], /unavailable/);
    assert.equal((await h.files(job.folder)).length, 1);
});

test('cancellation stops the downloader and keeps completed songs', async t => {
    const { h, downloader } = await setup(t, { blockId: entries[1].id });
    const started = await h.start();
    await until(() => downloader.blocked.length > 0);
    const running = await h.status();
    assert.equal(running.saved, 1);
    assert.equal((await h.api('/api/local/alice/folders/' + running.folder, 'DELETE')).status, 409);
    const cancel = await h.api('/api/local/alice/playlist-import/' + started.data.job.id, 'DELETE');
    assert.equal(cancel.status, 200);
    await h.settleImport();
    assert.equal((await h.status()).status, 'cancelled');
    assert.equal((await h.files(running.folder)).length, 1);
    assert.ok(downloader.calls.some(call => call.signals.includes('SIGTERM')));
    assert.equal((await h.api('/api/local/alice/playlist-import/not-this-job', 'DELETE')).status, 404);
});

test('missing executables and invalid metadata return useful failures without publishing incomplete MP3s', async t => {
    for (const options of [{ missing: 'yt-dlp' }, { missing: 'ffmpeg' }, { invalidMetadata: true }, { normalizeFailure: true }, { entries: [] }]) {
        const { h } = await setup(t, options);
        await h.start();
        await h.settleImport();
        const job = await h.status();
        assert.equal(job.status, 'failed');
        assert.ok(job.error);
        assert.equal((await h.files()).length, 0);
        if (options.missing) assert.match(job.error, /not installed/);
    }
});

test('saved MP3s can be queued individually or by folder and looped through My List', async t => {
    const { h } = await setup(t);
    await h.start();
    await h.settleImport();
    const job = await h.status();
    const files = await h.files(job.folder);
    const queued = await h.api('/api/local/alice/queue', 'POST', { folder: job.folder, filename: files[0].name });
    assert.equal(queued.data.added, 1);
    const list = (await h.api('/api/mylist/alice')).data.items;
    assert.equal(list[0].platform, 'local');
    assert.match(list[0].url, /^\/api\/local-media\/alice\//);
    await h.api('/api/mode/alice', 'POST', { mode: 'mylist', mylistLoop: true });
    const first = (await h.request('/api/channels/alice/current')).data.current;
    await h.request('/api/channels/alice/next', { method: 'POST', body: { playbackId: first._playbackId } });
    const second = (await h.request('/api/channels/alice/current')).data.current;
    assert.equal(second.media, first.media);
    assert.notEqual(second._playbackId, first._playbackId);
    await h.api('/api/mylist/alice', 'DELETE');
    const folder = await h.api('/api/local/alice/queue', 'POST', { folder: job.folder });
    assert.equal(folder.data.added, 2);
    assert.deepEqual((await h.api('/api/mylist/alice')).data.items.map(item => item.title), files.map(file => file.name));
    assert.equal((await h.api('/api/local/alice/queue', 'POST', { folder: '../escape' })).status, 400);
    assert.equal((await h.api('/api/local/alice/queue', 'POST', { folder: job.folder, filename: '../escape.mp3' })).status, 400);
    assert.equal((await h.api('/api/local/alice/queue', 'POST', { filename: 'missing.mp3' })).status, 404);
});

test('the real ffmpeg pipeline saves a playable MP3 using synthetic audio', {
    skip: spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0
}, async t => {
    const audio = execFileSync('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2',
        '-codec:a', 'libmp3lame', '-f', 'mp3', 'pipe:1'
    ]);
    const downloader = createDownloader({ entries: [entries[0]], audio });
    const h = await createTestServer({
        spawn: (command, args, options) => command === 'ffmpeg'
            ? spawn(command, args, options) : downloader.spawn(command, args, options)
    });
    t.after(() => h.close());
    const cookie = await h.login();
    const accepted = await h.request('/api/local/alice/playlist-import', {
        method: 'POST', cookie, body: { url: playlist }
    });
    assert.equal(accepted.status, 202);
    await h.settleImport();
    const job = (await h.request('/api/local/alice/playlist-import', { cookie })).data.job;
    assert.equal(job.status, 'completed');
    const folder = path.join(h.localRoot, 'alice', job.folder);
    const [file] = fs.readdirSync(folder);
    const codec = execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(folder, file)
    ], { encoding: 'utf8' }).trim();
    assert.equal(codec, 'mp3');
});
