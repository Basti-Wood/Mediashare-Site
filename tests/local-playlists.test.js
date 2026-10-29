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
    h.cookie = cookie;
    h.api = (route, method = 'GET', body) => h.request(route, { method, body, cookie });
    h.start = body => h.api('/api/local/alice/playlist-import', 'POST', body || { url: playlist });
    h.status = async () => (await h.api('/api/local/alice/playlist-import')).data.job;
    h.files = async folder => (await h.api('/api/local/alice/files' + (folder ? '/' + encodeURIComponent(folder) : ''))).data.files;
    h.list = async () => (await h.api('/api/mylist/alice')).data.items;
    h.saved = async () => (await h.api('/api/local/alice/playlists')).data.playlists;
    h.current = async () => (await h.request('/api/channels/alice/current')).data.current;
    h.next = item => h.request('/api/channels/alice/next', { method: 'POST', body: { playbackId: item._playbackId } });
    h.upload = async (names = ['My song.mp3'], folder = '') => {
        const form = new FormData();
        for (const name of names) form.append('files', new Blob(['ID3 test audio'], { type: 'audio/mpeg' }), name);
        return h.request('/api/local/alice/upload' + (folder ? '/' + encodeURIComponent(folder) : ''), { method: 'POST', form, cookie });
    };
    return { h, downloader };
}

async function until(predicate) {
    for (let i = 0; i < 1000; i++) {
        if (predicate()) return;
        await nextTick();
    }
    throw new Error('Import did not reach expected state');
}

function viewer(id = 'viewer1') {
    return { id, username: id, media: 'https://youtu.be/CCCCCCCCCCC', Platform: 'youtube', song_name: 'Viewer song' };
}

function seedFile(h, name = 'Existing.mp3', folder = '') {
    const dir = path.join(h.localRoot, 'alice', folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), 'ID3 existing recording');
}

test('playlist URLs are canonicalized and reject other hosts, protocols and credentials', () => {
    assert.deepEqual(playlistUrl('https://www.youtube.com/watch?v=AAAAAAAAAAA&list=PLtest123&t=10'), { id: 'PLtest123', url: playlist });
    for (const url of ['not a URL', 'https://youtube.com/watch?v=AAAAAAAAAAA',
        'https://youtube.com.evil.test/playlist?list=PLtest123', 'https://youtube.com@evil.test/playlist?list=PLtest123',
        'http://youtube.com/playlist?list=PLtest123', 'file:///etc/passwd?list=PLtest123',
        'https://user:pass@youtube.com/playlist?list=PLtest123', 'https://youtube.com:1234/playlist?list=PLtest123',
        'https://youtube.com/playlist?list=../../escape'])
        assert.throws(() => playlistUrl(url), { status: 400 });
});

test('import, saved-playlist, upload and queue operations require channel access', async t => {
    const { h, downloader } = await setup(t);
    for (const [route, method] of [['playlist-import', 'POST'], ['playlist-import', 'GET'],
        ['playlist-import/unknown', 'DELETE'], ['queue', 'POST'], ['playlists', 'GET'],
        ['playlists/PLtest123/load', 'POST'], ['playlists/PLtest123', 'DELETE'], ['upload', 'POST']]) {
        const body = method === 'POST' ? { url: playlist } : undefined;
        assert.equal((await h.request('/api/local/alice/' + route, { method, body })).status, 401);
        assert.equal((await h.api('/api/local/bob/' + route, method, body)).status, 403);
    }
    assert.equal(downloader.calls.length, 0);
});

test('invalid import input never starts yt-dlp', async t => {
    const { h, downloader } = await setup(t);
    for (const body of [{}, { url: 'https://example.com/playlist?list=PLtest123' }])
        assert.equal((await h.start(body)).status, 400);
    assert.equal(downloader.calls.length, 0);
});

test('playlist import saves links and titles, replaces the complete list and never downloads audio', async t => {
    const { h, downloader } = await setup(t);
    seedFile(h);
    await h.api('/api/local/alice/queue', 'POST', { filename: 'Existing.mp3' });
    await h.api('/api/mylist/alice/add', 'POST', { url: 'https://youtu.be/CCCCCCCCCCC' });
    const response = await h.start({ url: 'https://youtube.com/watch?v=AAAAAAAAAAA&list=PLtest123' });
    assert.equal(response.status, 202);
    assert.equal(response.data.job.status, 'running');
    await h.settleImport();
    const job = await h.status();
    assert.equal(job.status, 'completed');
    assert.equal(job.saved, 2);
    assert.deepEqual((await h.list()).map(item => item.title), entries.map(item => item.title));
    assert.ok((await h.list()).every(item => item.platform === 'youtube' && item.url.includes('watch?v=')));
    assert.equal((await h.api('/api/mode/alice')).data.mode, 'mylist');
    assert.deepEqual((await h.files()).map(file => file.name), ['Existing.mp3']);
    assert.equal(fs.readFileSync(path.join(h.localRoot, 'alice', 'Existing.mp3'), 'utf8'), 'ID3 existing recording');
    assert.equal(downloader.calls.length, 1);
    const [metadata] = downloader.calls;
    assert.equal(metadata.command, 'yt-dlp');
    assert.equal(metadata.args.at(-1), playlist);
    assert.ok(metadata.args.includes('--skip-download') && metadata.args.includes('--flat-playlist'));
    assert.equal(metadata.options.shell, false);
    assert.ok(h.events.some(event => event.event === 'local:import:update' && event.payload.job.saved === 2));
    assert.equal((await h.saved())[0].url, playlist);
});

test('an active metadata import is recoverable through status and blocks a second import', async t => {
    const { h, downloader } = await setup(t, { blockMetadata: true });
    const started = await h.start();
    await until(() => downloader.blocked.length > 0);
    assert.equal((await h.start()).status, 409);
    assert.equal((await h.status()).id, started.data.job.id);
    downloader.release();
    await h.settleImport();
    assert.equal((await h.status()).status, 'completed');
});

test('a new playlist replaces the queue but retains saved playlists for loading again', async t => {
    const { h } = await setup(t);
    await h.start();
    await h.settleImport();
    await h.start({ url: 'https://youtube.com/playlist?list=PLsecond' });
    await h.settleImport();
    assert.equal((await h.list()).length, 2);
    assert.equal((await h.saved()).length, 2);
    seedFile(h);
    await h.api('/api/local/alice/queue', 'POST', { filename: 'Existing.mp3' });
    assert.equal((await h.list()).length, 3);
    const loaded = await h.api('/api/local/alice/playlists/PLtest123/load', 'POST');
    assert.equal(loaded.status, 200);
    assert.equal((await h.list()).length, 2);
    await h.start();
    await h.settleImport();
    assert.equal((await h.saved()).length, 2, 'reimport updates the saved playlist instead of duplicating it');
    assert.equal((await h.api('/api/local/alice/playlists/missing/load', 'POST')).status, 404);
    assert.equal((await h.api('/api/local/alice/playlists/PLtest123', 'DELETE')).status, 200);
    assert.equal((await h.saved()).length, 1);
    assert.equal((await h.list()).length, 2, 'deleting a saved snapshot keeps its already loaded queue');
});

test('playlist replacement preserves the current viewer song and takes over when it ends', async t => {
    const { h } = await setup(t);
    h.queues.set('alice', [viewer(), viewer('viewer2')]);
    const current = await h.current();
    await h.start();
    await h.settleImport();
    assert.equal((await h.current())._playbackId, current._playbackId);
    assert.equal(h.calls.filter(call => call.action === 'setmediatop').length, 0);
    await h.next(current);
    const next = await h.current();
    assert.equal(next.song_name, entries[0].title);
    assert.equal(next._source, 'mylist');
});

test('playlist replacement retires the old looping song without bringing it back on a loop toggle', async t => {
    const { h } = await setup(t);
    seedFile(h);
    await h.api('/api/local/alice/queue', 'POST', {});
    await h.api('/api/mode/alice', 'POST', { mylistLoop: true });
    const playing = await h.current();
    await h.start();
    await h.settleImport();
    assert.equal((await h.current())._playbackId, playing._playbackId);
    await h.api('/api/mode/alice', 'POST', { mylistLoop: false });
    await h.api('/api/mode/alice', 'POST', { mylistLoop: true });
    assert.deepEqual((await h.list()).map(item => item.title), entries.map(item => item.title));
    await h.next(playing);
    assert.equal((await h.current()).song_name, entries[0].title);
});

test('unavailable entries are skipped while duplicate playable entries retain playlist order', async t => {
    const { h } = await setup(t, { entries: [entries[1], null, { id: 'CCCCCCCCCCC', title: '[Private video]' }, entries[0], entries[1]] });
    await h.start();
    await h.settleImport();
    assert.equal((await h.status()).status, 'partial');
    assert.equal((await h.status()).saved, 3);
    assert.equal((await h.status()).skipped, 2);
    assert.deepEqual((await h.list()).map(item => item.title), ['Second song', 'First song', 'Second song']);
});

test('cancellation stops metadata lookup and leaves the previous list and saved playlist untouched', async t => {
    const { h, downloader } = await setup(t, { blockMetadata: true });
    seedFile(h);
    await h.api('/api/local/alice/queue', 'POST', { filename: 'Existing.mp3' });
    const before = await h.list();
    const started = await h.start();
    await until(() => downloader.blocked.length > 0);
    assert.equal((await h.api('/api/local/alice/playlist-import/' + started.data.job.id, 'DELETE')).status, 200);
    await h.settleImport();
    assert.equal((await h.status()).status, 'cancelled');
    assert.deepEqual(await h.list(), before);
    assert.deepEqual(await h.saved(), []);
    assert.ok(downloader.calls.some(call => call.signals.includes('SIGTERM')));
    assert.equal((await h.api('/api/local/alice/playlist-import/not-this-job', 'DELETE')).status, 404);
});

test('unreadable or empty playlists keep all existing music', async t => {
    for (const options of [{ missing: 'yt-dlp' }, { invalidMetadata: true }, { entries: [] }, { entries: [null] }]) {
        const { h } = await setup(t, options);
        seedFile(h);
        await h.api('/api/local/alice/queue', 'POST', { filename: 'Existing.mp3' });
        const before = await h.list();
        await h.start();
        await h.settleImport();
        assert.equal((await h.status()).status, 'failed');
        assert.ok((await h.status()).error);
        assert.deepEqual(await h.list(), before);
        assert.deepEqual(await h.saved(), []);
    }
});

test('saved playlist snapshots and the current queue survive server recreation', async t => {
    const downloader = createDownloader();
    const h = await createTestServer({ spawn: downloader.spawn, preserveData: true });
    t.after(() => h.close());
    t.after(() => fs.rmSync(h.localRoot, { recursive: true, force: true }));
    const cookie = await h.login();
    await h.request('/api/local/alice/playlist-import', { method: 'POST', body: { url: playlist }, cookie });
    await h.settleImport();
    await h.request('/api/mylist/alice/shuffle', { method: 'POST', cookie });
    const before = (await h.request('/api/mylist/alice', { cookie })).data.items;
    await h.close();
    const restarted = await createTestServer({ localRoot: h.localRoot, preserveData: true });
    t.after(() => restarted.close());
    assert.deepEqual((await restarted.request('/api/mylist/alice', { cookie })).data.items, before);
    assert.equal((await restarted.request('/api/local/alice/playlists', { cookie })).data.playlists[0].count, 2);
    await restarted.request('/api/local/alice/playlists/PLtest123/load', { method: 'POST', cookie });
    assert.deepEqual((await restarted.request('/api/mylist/alice', { cookie })).data.items.map(item => item.title), entries.map(item => item.title));
    assert.deepEqual((await restarted.request('/api/local/bob/playlists', { cookie: await restarted.login('bob') })).data.playlists, []);
    await restarted.close();
});

test('root and folder uploads play next without interrupting the current song or replacing the playlist', async t => {
    const { h } = await setup(t);
    await h.start();
    await h.settleImport();
    const current = await h.current();
    const uploaded = await h.upload(['Announcement.mp3']);
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.data.queued, 1);
    assert.equal((await h.current())._playbackId, current._playbackId);
    assert.deepEqual((await h.list()).map(item => item.title), ['Announcement.mp3', 'Second song']);
    await h.next(current);
    const next = await h.current();
    assert.equal(next.song_name, 'Announcement.mp3');
    await h.next(next);
    assert.equal((await h.current()).song_name, 'Second song');
    assert.equal((await h.upload(['Another.mp3'], 'Uploads')).status, 200);
    assert.ok((await h.files('Uploads')).some(file => file.name === 'Another.mp3'));
});

test('individual files take priority over viewer requests, retain upload order and are played once with loop enabled', async t => {
    const { h } = await setup(t);
    h.queues.set('alice', [viewer(), viewer('viewer2')]);
    await h.api('/api/mode/alice', 'POST', { mylistLoop: true });
    const playing = await h.current();
    assert.equal((await h.upload(['One.mp3', 'Two.mp3'])).status, 200);
    assert.equal((await h.current())._playbackId, playing._playbackId);
    await h.next(playing);
    for (const name of ['One.mp3', 'Two.mp3']) {
        const next = await h.current();
        assert.equal(next.song_name, name);
        await h.next(next);
    }
    assert.equal((await h.current()).username, 'viewer2');
    assert.deepEqual(await h.list(), []);
});

test('next-song files stay first when the playlist is shuffled', async t => {
    const { h } = await setup(t);
    await h.start();
    await h.settleImport();
    await h.upload(['Next.mp3']);
    await h.api('/api/mylist/alice/shuffle', 'POST');
    assert.equal((await h.list())[0].title, 'Next.mp3');
});

test('repeat uploads preserve existing files and failed audio is not queued', async t => {
    const { h } = await setup(t);
    seedFile(h, 'My song.mp3');
    assert.equal((await h.upload()).status, 200);
    assert.equal(fs.readFileSync(path.join(h.localRoot, 'alice', 'My song.mp3'), 'utf8'), 'ID3 existing recording');
    assert.equal((await h.list())[0].title, 'My song (2).mp3');
    const { h: invalid } = await setup(t, { normalizeFailure: true });
    assert.equal((await invalid.upload()).status, 422);
    assert.deepEqual(await invalid.list(), []);
    assert.deepEqual(await invalid.files(), []);
});

test('local filenames and platform are sent to the API for queued and immediate playback', async t => {
    const { h } = await setup(t);
    const name = 'A & B #1 + 50%.mp3';
    seedFile(h, name);
    const queued = await h.api('/api/local/alice/queue', 'POST', { filename: name });
    assert.equal(queued.status, 200);
    const current = await h.current();
    assert.equal(current.song_name, name);
    assert.equal(current.Platform, 'local');
    assert.equal(h.queues.get('alice')[0].song_name, name, 'title reaches upstream storage, not only the dashboard');
    let sent = h.calls.find(call => call.action === 'setmediatop');
    assert.equal(sent.song_name, name);
    assert.equal(sent.platform, 'local');
    await h.api('/api/local/alice/play/' + encodeURIComponent(name), 'POST');
    sent = h.calls.filter(call => call.action === 'setmediatop').at(-1);
    assert.equal(sent.song_name, name);
    assert.equal((await h.api('/api/media/alice')).data.media[0].song_name, name);
    assert.equal((await fetch(h.base + current.media)).status, 200);
});

test('folder queue appends files and invalid local paths are rejected', async t => {
    const { h } = await setup(t);
    seedFile(h, 'Z.mp3', 'Music');
    seedFile(h, 'A.mp3', 'Music');
    await h.start();
    await h.settleImport();
    assert.equal((await h.api('/api/local/alice/queue', 'POST', { folder: 'Music' })).data.added, 2);
    assert.deepEqual((await h.list()).map(item => item.title), ['First song', 'Second song', 'A.mp3', 'Z.mp3']);
    for (const body of [{ folder: '../escape' }, { filename: '../escape.mp3' }, { filename: 'test.txt' }])
        assert.equal((await h.api('/api/local/alice/queue', 'POST', body)).status, 400);
    assert.equal((await h.api('/api/local/alice/queue', 'POST', { filename: 'missing.mp3' })).status, 404);
});

test('the real upload pipeline saves a playable MP3 using synthetic audio', {
    skip: spawnSync('ffmpeg', ['-version']).status !== 0 || spawnSync('ffprobe', ['-version']).status !== 0
}, async t => {
    const audio = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-codec:a', 'libmp3lame', '-f', 'mp3', 'pipe:1']);
    const h = await createTestServer({ spawn });
    t.after(() => h.close());
    const cookie = await h.login();
    const form = new FormData();
    form.append('files', new Blob([audio], { type: 'audio/mpeg' }), 'Synthetic tone.mp3');
    assert.equal((await h.request('/api/local/alice/upload', { method: 'POST', form, cookie })).status, 200);
    const codec = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(h.localRoot, 'alice', 'Synthetic tone.mp3')], { encoding: 'utf8' }).trim();
    assert.equal(codec, 'mp3');
});

test('UTF-8 filenames retain their original spelling in uploads and upstream titles', async t => {
    const { h } = await setup(t);
    const name = 'Été - 日本語.mp3';
    assert.equal((await h.upload([name])).status, 200);
    assert.equal((await h.list())[0].title, name);
    const playing = await h.current();
    assert.equal(playing.song_name, name);
    assert.equal(h.calls.find(call => call.action === 'setmediatop').song_name, name);
});

test('equal filenames in one upload batch create separate playable files', async t => {
    const { h } = await setup(t);
    assert.equal((await h.upload(['Same.mp3', 'Same.mp3'])).status, 200);
    assert.deepEqual((await h.list()).map(item => item.title), ['Same.mp3', 'Same (2).mp3']);
    assert.equal((await h.files()).length, 2);
});
