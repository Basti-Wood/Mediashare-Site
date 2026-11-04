'use strict';

// Fake only the executable boundary. Real cache scheduling, disk files,
// publication, HTTP routes and byte-range serving remain under test.
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function createMediaTools(options = {}) {
    const calls = [];
    const pending = [];
    function spawn(command, args, settings) {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        let closed = false;
        const call = { command, args, settings, signals: [] };
        calls.push(call);
        const close = code => {
            if (closed) return;
            closed = true;
            child.stdout.end(); child.stderr.end(); child.emit('close', code);
        };
        child.kill = signal => { call.signals.push(signal); close(143); return true; };
        const run = () => {
            if (closed) return;
            try {
                if (options.missing === command) {
                    child.emit('error', Object.assign(new Error('Not installed'), { code: 'ENOENT' }));
                    return close(-2);
                }
                if (command === 'yt-dlp') {
                    const fail = typeof options.downloadFailure === 'function' ? options.downloadFailure(call) : options.downloadFailure;
                    if (fail) { child.stderr.write(fail); return close(1); }
                    const template = args[args.indexOf('--output') + 1];
                    fs.writeFileSync(template.replace('%(ext)s', args.includes('bestaudio[ext=m4a]/bestaudio/best') ? 'm4a' : 'mp4'),
                        Buffer.alloc(options.sourceBytes || 20, 1));
                } else if (command === 'ffprobe') {
                    const normalized = /ready\.(mp3|mp4)$/.test(args.at(-1));
                    const mp3 = args.at(-1).endsWith('.mp3');
                    child.stdout.write(JSON.stringify({ format: { duration: options.truncated && normalized ? 5 : options.duration || 30 },
                        streams: [...(options.noAudio ? [] : [{ codec_type: 'audio', codec_name: mp3 ? 'mp3' : 'aac' }]),
                            ...(mp3 || options.noVideo ? [] : [{ codec_type: 'video', codec_name: 'h264' }])] }));
                } else if (command === 'ffmpeg') {
                    if (options.convertFailure || (options.decodeFailure && args.at(-1) === '-')) {
                        child.stderr.write('Invalid data in audio file'); return close(1);
                    }
                    if (args.at(-1) !== '-') fs.writeFileSync(args.at(-1), options.emptyOutput ? '' : options.output || 'ID3 complete test audio');
                } else throw new Error('Unexpected media command: ' + command);
                close(0);
            } catch (err) { child.emit('error', err); close(1); }
        };
        setImmediate(() => {
            if (closed) return;
            if (command === 'yt-dlp' && options.blockDownloads) pending.push({ call, run });
            else run();
        });
        return child;
    }
    return { spawn, calls, pending, release(id) {
        const index = id ? pending.findIndex(item => item.call.args.at(-1).endsWith(id)) : 0;
        if (index >= 0) pending.splice(index, 1)[0]?.run();
    } };
}

module.exports = { createMediaTools };
