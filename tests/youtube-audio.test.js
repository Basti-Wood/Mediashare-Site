'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createTestServer } = require('./helpers/server');

function audioTools(options = {}) {
    const resolutions = [];
    const transcodes = [];
    let failTranscode = options.failTranscode;
    return {
        resolutions, transcodes,
        execFile(command, args, settings, callback) {
            resolutions.push({ command, args, settings });
            setImmediate(() => {
                if (options.missing) return callback(Object.assign(new Error('yt-dlp not installed'), { code: 'ENOENT' }));
                const data = options.metadata || { url: 'https://cdn.example.test/audio', http_headers: {
                    'User-Agent': 'yt-dlp-agent', Referer: 'https://www.youtube.com/',
                    Origin: 'https://www.youtube.com', Accept: '*/*', 'Not-Forwarded': 'secret',
                    'Bad-Header': 'value\r\nInjected: value'
                } };
                callback(null, JSON.stringify(data), '');
            });
        },
        spawn(command, args, settings) {
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.killed = false;
            let closed = false;
            const close = code => {
                if (closed) return;
                closed = true;
                child.exitCode = code;
                child.emit('close', code);
            };
            child.kill = () => { child.killed = true; close(null); return true; };
            transcodes.push({ command, args, settings });
            setImmediate(() => {
                if (options.missingFfmpeg) {
                    child.emit('error', Object.assign(new Error('ffmpeg missing'), { code: 'ENOENT' }));
                    child.stdout.end();
                    return setImmediate(() => close(-2));
                }
                if (options.emptySuccess) {
                    child.stdout.end();
                    return setImmediate(() => close(0));
                }
                if (options.partialFailure) {
                    child.stdout.end(Buffer.from('ID3 truncated audio'));
                    return setImmediate(() => close(1));
                }
                if (failTranscode) {
                    failTranscode = false;
                    child.stderr.end('Upstream HTTP 403');
                    child.stdout.end();
                    // stdout ends before the process closes, as with real ffmpeg.
                    setImmediate(() => close(1));
                } else {
                    child.stdout.end(Buffer.from('ID3 test audio'));
                    child.stderr.end();
                    setImmediate(() => close(0));
                }
            });
            return child;
        }
    };
}

async function setup(t, options) {
    const tools = audioTools(options);
    const h = await createTestServer(tools);
    t.after(() => h.close());
    h.audio = () => fetch(h.base + '/api/yt-audio/AAAAAAAAAAA');
    return { h, tools };
}

test('audio resolution enables Node, preserves upstream headers and caches successful sources', async t => {
    const { h, tools } = await setup(t);
    const responses = await Promise.all([h.audio(), h.audio()]);
    for (const response of responses) {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'audio/mpeg');
        assert.equal(await response.text(), 'ID3 test audio');
    }
    assert.equal(tools.resolutions.length, 1);
    const resolution = tools.resolutions[0];
    assert.ok(resolution.args.includes('--js-runtimes'));
    assert.ok(resolution.args.includes('node'));
    assert.ok(resolution.args.includes('bestaudio/best'));
    const args = tools.transcodes[0].args;
    const headers = args[args.indexOf('-headers') + 1];
    assert.match(headers, /User-Agent: yt-dlp-agent\r\n/);
    assert.match(headers, /Referer: https:\/\/www.youtube.com\/\r\n/);
    assert.equal(headers.includes('Not-Forwarded'), false);
    assert.equal(headers.includes('Injected'), false);
    await (await h.audio()).text();
    assert.equal(tools.resolutions.length, 1);
});

test('empty failed transcodes return JSON 502 and invalidate the cached URL for retry', async t => {
    const { h, tools } = await setup(t, { failTranscode: true });
    const failed = await h.audio();
    assert.equal(failed.status, 502);
    assert.match(failed.headers.get('content-type'), /application\/json/);
    assert.equal((await failed.json()).code, 'AUDIO_TRANSCODE_FAILED');
    const retry = await h.audio();
    assert.equal(retry.status, 200);
    assert.equal(await retry.text(), 'ID3 test audio');
    assert.equal(tools.resolutions.length, 2);
});

test('missing yt-dlp and unusable metadata are reported as resolver failures', async t => {
    for (const options of [{ missing: true }, { metadata: { url: 'file:///etc/passwd' } }, { metadata: {} }]) {
        const { h, tools } = await setup(t, options);
        const response = await h.audio();
        assert.equal(response.status, 502);
        const data = await response.json();
        assert.equal(data.code, options.missing ? 'YTDLP_MISSING' : 'YOUTUBE_RESOLVE_FAILED');
        assert.equal(tools.transcodes.length, 0);
    }
});

test('missing ffmpeg and empty successful processes return 502 instead of empty audio', async t => {
    for (const options of [{ missingFfmpeg: true }, { emptySuccess: true }]) {
        const { h } = await setup(t, options);
        const response = await h.audio();
        assert.equal(response.status, 502);
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.equal((await response.json()).code, 'AUDIO_TRANSCODE_FAILED');
    }
});

test('a failed partial transcode breaks the stream instead of reporting normal completion', async t => {
    const { h } = await setup(t, { partialFailure: true });
    await assert.rejects(async () => {
        const response = await h.audio();
        await response.arrayBuffer();
    });
});
