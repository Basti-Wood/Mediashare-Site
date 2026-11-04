'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setImmediate: nextTick } = require('node:timers/promises');
const { createTestServer } = require('./helpers/server');
const { createMediaTools } = require('./helpers/media-tools');
const { createDownloader } = require('./helpers/downloader');
const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', C = 'CCCCCCCCCCC', D = 'DDDDDDDDDDD';
const viewer = id => ({ id, media: 'https://youtu.be/' + id, username: 'viewer' });
async function until(predicate) {
    for (let i = 0; i < 2000; i++) { if (predicate()) return; await nextTick(); }
    throw new Error('Media did not reach expected state');
}
async function setup(t, options = {}) {
    const tools = createMediaTools(options);
    const h = await createTestServer({ cacheSpawn: tools.spawn });
    t.after(() => h.close());
    return { h, tools };
}

test('requested video uses combined MP4 first, then merged video/audio if necessary, and never publishes audio-only output', async t => {
    const { h, tools } = await setup(t, { downloadFailure: call => call.args[call.args.indexOf('--format') + 1].startsWith('best[ext=mp4]') ? 'HTTP Error 403' : null });
    const res = await fetch(h.base + '/api/yt-video/' + A);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    await res.arrayBuffer();
    const downloads = tools.calls.filter(call => call.command === 'yt-dlp');
    assert.equal(downloads.length, 2);
    assert.match(downloads[1].args[downloads[1].args.indexOf('--format') + 1], /bestvideo\[height<=720\]\+bestaudio/);
    assert.ok(downloads.every(call => call.args.includes('--abort-on-unavailable-fragments')));
    const conversion = tools.calls.find(call => call.command === 'ffmpeg' && call.args.at(-1).endsWith('ready.mp4'));
    assert.ok(conversion.args.includes('libx264') && conversion.args.includes('aac'));
    assert.ok(conversion.args.includes('+faststart'));
    assert.equal(conversion.args.includes('-vn'), false);
    const cacheRoot = path.join(h.localRoot, '.youtube-video-cache');
    assert.ok(fs.existsSync(path.join(cacheRoot, A + '.mp4')));
    assert.equal(fs.existsSync(path.join(cacheRoot, A + '.mp3')), false);
    assert.deepEqual((await h.request('/api/yt-video/' + A + '/info')).data, { status: 'ready', duration: 30 });
    assert.equal((await h.request('/api/yt-video/bad/info')).status, 400);
});

test('video preparation rejects a source without a picture rather than reporting success', async t => {
    const { h } = await setup(t, { noVideo: true });
    const res = await fetch(h.base + '/api/yt-video/' + A);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, 'INVALID_MEDIA');
    assert.equal(fs.existsSync(path.join(h.localRoot, '.youtube-video-cache', A + '.mp4')), false);
});

test('alternating lookahead prepares request videos and personal audio in their respective caches', async t => {
    const { h } = await setup(t);
    const cookie = await h.login();
    for (const id of [B, C]) await h.request('/api/mylist/alice/add', { method: 'POST', cookie, body: { url: 'https://youtu.be/' + id } });
    await h.request('/api/mode/alice', { method: 'POST', cookie, body: { mode: 'switch' } });
    const queue = [viewer(A), viewer(D)];
    h.queues.set('alice', queue);
    const before = JSON.stringify(queue);
    const current = await h.request('/api/channels/alice/current');
    assert.equal(current.data.current._source, 'requests');
    await until(() => [A, D].every(id => h.youtubeVideoCache.status(id).status === 'ready')
        && [B, C].every(id => h.youtubeCache.status(id).status === 'ready'));
    assert.equal(h.youtubeVideoCache.status(B).status, 'preparing');
    assert.equal(h.youtubeCache.status(A).status, 'preparing');
    assert.equal(JSON.stringify(queue), before);
    assert.equal(h.calls.filter(call => call.action === 'setmediatop' || call.action === 'removemedia').length, 0);
});

test('simultaneous private-video skips remove exactly one current request', async t => {
    const { h } = await setup(t, { downloadFailure: call => call.args.at(-1).endsWith(A) ? 'Private video. Sign in to view' : null });
    h.queues.set('alice', [viewer(A), viewer(B)]);
    const current = (await h.request('/api/channels/alice/current')).data.current;
    await assert.rejects(h.youtubeVideoCache.prepare(A), { code: 'YOUTUBE_UNAVAILABLE' });
    const body = { playbackId: current._playbackId, unavailable: { mediaType: 'video', videoId: A } };
    const results = await Promise.all([1, 2].map(() => h.request('/api/channels/alice/next', { method: 'POST', body })));
    assert.deepEqual(results.map(result => result.data.advanced), [true, false]);
    assert.equal(h.queues.get('alice')[0].id, B);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
});

test('automatic skip requires the matching playback, media type, video ID and confirmed unavailable failure', async t => {
    const { h } = await setup(t, { downloadFailure: 'HTTP Error 429: Too many requests' });
    h.queues.set('alice', [viewer(A), viewer(B)]);
    const current = (await h.request('/api/channels/alice/current')).data.current;
    await assert.rejects(h.youtubeVideoCache.prepare(A), { code: 'YOUTUBE_RATE_LIMIT' });
    for (const body of [
        { unavailable: { mediaType: 'video', videoId: A } },
        { playbackId: 'old', unavailable: { mediaType: 'video', videoId: A } },
        { playbackId: current._playbackId, unavailable: { mediaType: 'audio', videoId: A } },
        { playbackId: current._playbackId, unavailable: { mediaType: 'video', videoId: B } },
        { playbackId: current._playbackId, unavailable: { mediaType: 'video', videoId: A } }
    ]) {
        const result = await h.request('/api/channels/alice/next', { method: 'POST', body });
        assert.equal(result.data.advanced, false);
    }
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
    assert.equal(h.queues.get('alice')[0].id, A);
});

test('skipping private personal audio retires loop duplicates but preserves the saved playlist snapshot', async t => {
    const metadata = createDownloader({ entries: [A, B, A].map(id => ({ id, title: id })) });
    const tools = createMediaTools({ downloadFailure: call => call.args.at(-1).endsWith(A) ? 'Video unavailable. This video is private' : null });
    const h = await createTestServer({ spawn: metadata.spawn, cacheSpawn: tools.spawn });
    t.after(() => h.close());
    const cookie = await h.login();
    await h.request('/api/local/alice/playlist-import', { method: 'POST', cookie, body: { url: 'https://youtube.com/playlist?list=PLtest123' } });
    await h.settleImport();
    await h.request('/api/mode/alice', { method: 'POST', cookie, body: { mode: 'mylist', mylistLoop: true } });
    const current = (await h.request('/api/channels/alice/current')).data.current;
    assert.equal(current._source, 'mylist');
    await assert.rejects(h.youtubeCache.prepare(A), { code: 'YOUTUBE_UNAVAILABLE' });
    const result = await h.request('/api/channels/alice/next', { method: 'POST', body: {
        playbackId: current._playbackId, unavailable: { mediaType: 'audio', videoId: A } } });
    assert.equal(result.data.advanced, true);
    const list = (await h.request('/api/mylist/alice', { cookie })).data.items;
    assert.equal(list.length, 1);
    assert.ok(list[0].url.includes(B));
    const saved = (await h.request('/api/local/alice/playlists', { cookie })).data.playlists;
    assert.equal(saved[0].count, 3);
    const next = (await h.request('/api/channels/alice/current')).data.current;
    assert.ok(next.media.includes(B));
    assert.equal(next._source, 'mylist');
    await h.request('/api/local/alice/playlists/' + saved[0].id + '/load', { method: 'POST', cookie });
    const reloaded = (await h.request('/api/mylist/alice', { cookie })).data.items;
    assert.equal(reloaded.length, 3);
    assert.equal(reloaded.filter(item => item.url.includes(A)).length, 2);
});

test('real MP4 output contains synchronized H.264/AAC tracks, bounded dimensions, fast-start metadata and byte ranges', async t => {
    const root = fs.mkdtempSync(path.resolve(__dirname, '.tmp-video-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = path.join(root, 'fixture.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1600x900:d=0.4',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-shortest', '-c:v', 'mpeg4', '-threads', '2', '-c:a', 'aac', fixture]);
    let downloads = 0;
    const cacheSpawn = (command, args, options) => {
        if (command !== 'yt-dlp') return spawn(command, args, options);
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => { child.emit('close', 143); return true; };
        setImmediate(() => {
            downloads++;
            fs.copyFileSync(fixture, args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4'));
            child.stdout.end(); child.stderr.end(); child.emit('close', 0);
        });
        return child;
    };
    const h = await createTestServer({ cacheSpawn });
    t.after(() => h.close());
    const res = await fetch(h.base + '/api/yt-video/' + A);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.ok(buffer.length > 1000);
    assert.ok(buffer.indexOf('moov') > 0 && buffer.indexOf('moov') < buffer.indexOf('mdat'));
    const file = path.join(h.localRoot, '.youtube-video-cache', A + '.mp4');
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height,duration', '-of', 'json', file]));
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    const audio = probe.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.width, 1280);
    assert.equal(video.height, 720);
    assert.equal(audio.codec_name, 'aac');
    assert.ok(Math.abs(Number(video.duration) - Number(audio.duration)) < 0.1);
    execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
    const range = await fetch(h.base + '/api/yt-video/' + A, { headers: { Range: 'bytes=0-511' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), buffer.subarray(0, 512));
    assert.equal(downloads, 1);
    const personal = await fetch(h.base + '/api/yt-audio/' + A);
    assert.equal(personal.headers.get('content-type'), 'audio/mpeg');
    await personal.arrayBuffer();
    assert.ok(fs.existsSync(path.join(h.localRoot, '.youtube-cache', A + '.mp3')));
    assert.equal(downloads, 2);
});

test('a queue-save failure after an unavailable skip cannot let a duplicate skip consume the next request', async t => {
    const { h } = await setup(t, { downloadFailure: call => call.args.at(-1).endsWith(A) ? 'Private video' : null });
    h.queues.set('alice', [viewer(A), viewer(B)]);
    const current = (await h.request('/api/channels/alice/current')).data.current;
    await assert.rejects(h.youtubeVideoCache.prepare(A), { code: 'YOUTUBE_UNAVAILABLE' });
    const original = h.musicLibrary.setQueue;
    h.musicLibrary.setQueue = () => { throw new Error('Simulated full disk'); };
    t.after(() => { h.musicLibrary.setQueue = original; });
    const body = { playbackId: current._playbackId, unavailable: { mediaType: 'video', videoId: A } };
    assert.equal((await h.request('/api/channels/alice/next', { method: 'POST', body })).status, 502);
    assert.equal((await h.request('/api/channels/alice/next', { method: 'POST', body })).data.advanced, false);
    assert.equal(h.queues.get('alice')[0].id, B);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
});
