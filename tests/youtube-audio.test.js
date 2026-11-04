'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setImmediate: nextTick } = require('node:timers/promises');
const { createTestServer } = require('./helpers/server');
const { createMediaTools } = require('./helpers/media-tools');

async function until(predicate) {
    for (let i = 0; i < 2000; i++) { if (predicate()) return; await nextTick(); }
    throw new Error('Preparation did not reach expected state');
}
async function setup(t, options = {}) {
    const tools = createMediaTools(options);
    const h = await createTestServer({ cacheSpawn: tools.spawn });
    t.after(() => h.close());
    const audio = (id = 'AAAAAAAAAAA', options) => fetch(h.base + '/api/yt-audio/' + id, options);
    return { h, tools, audio };
}

test('preparation returns 202 promptly; only complete files are published and audio clients share one download', async t => {
    const { h, tools, audio } = await setup(t, { blockDownloads: true });
    const info = await h.request('/api/yt-audio/AAAAAAAAAAA/info');
    assert.equal(info.status, 202);
    assert.equal(info.data.status, 'preparing');
    const [first, second] = [audio(), audio()];
    await until(() => tools.pending.length === 1);
    assert.equal(fs.existsSync(path.join(h.localRoot, '.youtube-cache', 'AAAAAAAAAAA.mp3')), false);
    tools.release();
    for (const response of await Promise.all([first, second])) {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'audio/mpeg');
        assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength('ID3 complete test audio'));
        assert.equal(await response.text(), 'ID3 complete test audio');
    }
    assert.equal(tools.calls.filter(call => call.command === 'yt-dlp').length, 1);
    const args = tools.calls[0].args;
    assert.ok(args.includes('--js-runtimes') && args.includes('node'));
    assert.ok(args.includes('--no-playlist') && args.includes('--retries'));
    assert.ok(args.includes('--abort-on-unavailable-fragments'));
    assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=AAAAAAAAAAA');
    const ready = await h.request('/api/yt-audio/AAAAAAAAAAA/info');
    assert.deepEqual(ready.data, { status: 'ready', duration: 30 });
    const range = await audio('AAAAAAAAAAA', { headers: { Range: 'bytes=4-11' } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), 'complete');
    const head = await audio('AAAAAAAAAAA', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(tools.calls.filter(call => call.command === 'yt-dlp').length, 1);
});

test('a refused audio-only download falls back to combined MP4 and extracts its audio', async t => {
    const { tools, audio } = await setup(t, { downloadFailure: call => call.args.includes('bestaudio[ext=m4a]/bestaudio/best') ? 'HTTP Error 403' : null });
    const response = await audio();
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ID3 complete test audio');
    const downloads = tools.calls.filter(call => call.command === 'yt-dlp');
    assert.equal(downloads.length, 2);
    assert.match(downloads[1].args[downloads[1].args.indexOf('--format') + 1], /best\[ext=mp4\]/);
    const conversion = tools.calls.find(call => call.command === 'ffmpeg' && call.args.at(-1).endsWith('ready.mp3'));
    assert.ok(conversion.args.includes('-vn'));
    assert.ok(conversion.args.includes('loudnorm=I=-14:TP=-1.5:LRA=11'));
    assert.ok(conversion.args[conversion.args.indexOf('-i') + 1].endsWith('source.mp4'));
});

test('missing media tools and empty, invalid, truncated or undecodable files return safe errors without publishing audio', async t => {
    for (const options of [{ missing: 'yt-dlp' }, { missing: 'ffmpeg' }, { missing: 'ffprobe' },
        { emptyOutput: true }, { noAudio: true }, { truncated: true }, { decodeFailure: true }]) {
        const { h, audio } = await setup(t, options);
        const response = await audio();
        assert.equal(response.status, 502);
        assert.match(response.headers.get('content-type'), /application\/json/);
        const data = await response.json();
        assert.equal(data.status, 'failed');
        assert.equal(data.code, options.missing ? 'DEPENDENCY_MISSING' : 'INVALID_MEDIA');
        assert.equal(fs.existsSync(path.join(h.localRoot, '.youtube-cache', 'AAAAAAAAAAA.mp3')), false);
        assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
    }
});

test('unavailable songs do not loop downloads; explicit Retry starts a fresh attempt and keeps the queue intact', async t => {
    let unavailable = true;
    const { h, tools, audio } = await setup(t, { downloadFailure: () => unavailable ? 'Video unavailable. This video is private' : null });
    h.queues.set('alice', [{ id: 'a', media: 'https://youtu.be/AAAAAAAAAAA', username: 'viewer' }]);
    const failed = await audio();
    assert.equal((await failed.json()).code, 'YOUTUBE_UNAVAILABLE');
    assert.equal((await h.request('/api/yt-audio/AAAAAAAAAAA/info')).status, 502);
    assert.equal(tools.calls.filter(call => call.command === 'yt-dlp').length, 1);
    unavailable = false;
    assert.equal((await h.request('/api/yt-audio/AAAAAAAAAAA/info?retry=1')).status, 202);
    const retry = await audio();
    assert.equal(retry.status, 200);
    await retry.text();
    assert.equal(tools.calls.filter(call => call.command === 'yt-dlp').length, 2);
    assert.equal(h.queues.get('alice').length, 1);
});

test('current prepares the next three songs without consuming, rotating or editing the upstream queue', async t => {
    const { h, tools } = await setup(t);
    const queue = 'ABCDE'.split('').map(id => ({ id, media: 'https://youtu.be/' + id.repeat(11), username: 'viewer' }));
    h.queues.set('alice', queue);
    const before = JSON.stringify(queue);
    const current = await h.request('/api/channels/alice/current');
    assert.equal(current.status, 200);
    await until(() => 'ABCD'.split('').every(id => h.youtubeVideoCache.status(id.repeat(11)).status === 'ready'));
    const urls = tools.calls.filter(call => call.command === 'yt-dlp').map(call => call.args.at(-1));
    assert.deepEqual(urls, 'ABCD'.split('').map(id => 'https://www.youtube.com/watch?v=' + id.repeat(11)));
    assert.equal(JSON.stringify(queue), before);
    assert.deepEqual(h.calls.map(call => call.action), ['getallmedia']);
    await h.request('/api/channels/alice/current');
    assert.equal(tools.calls.filter(call => call.command === 'yt-dlp').length, 4);
});

test('invalid IDs never start tools or access arbitrary cache paths', async t => {
    const { h, tools, audio } = await setup(t);
    assert.equal((await audio('bad')).status, 400);
    assert.equal((await h.request('/api/yt-audio/bad/info')).status, 400);
    assert.equal(tools.calls.length, 0);
});
