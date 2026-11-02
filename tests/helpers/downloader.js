'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');

const entries = [
    { id: 'AAAAAAAAAAA', title: 'First song' },
    { id: 'BBBBBBBBBBB', title: 'Second song' }
];

// Only metadata lookup and local-upload normalization are allowed. Any attempt
// to download playlist audio fails this fake executable boundary.
function createDownloader(options = {}) {
    const calls = [];
    const blocked = [];
    function spawn(command, args, spawnOptions) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        let closed = false;
        const call = { command, args, options: spawnOptions, signals: [] };
        calls.push(call);
        const close = code => { if (!closed) { closed = true; child.emit('close', code); } };
        child.kill = signal => { call.signals.push(signal); close(143); return true; };
        setImmediate(() => {
            if (options.missing === command) {
                child.emit('error', Object.assign(new Error('Not installed'), { code: 'ENOENT' }));
                return close(-2);
            }
            if (command === 'ffmpeg') {
                if (options.normalizeFailure) {
                    child.stderr.emit('data', Buffer.from('Normalization failed'));
                    return close(1);
                }
                fs.writeFileSync(args.at(-1), Buffer.from('ID3 normalized test audio'));
                return close(0);
            }
            if (command !== 'yt-dlp' || !args.includes('--skip-download') || !args.includes('--dump-single-json')) {
                child.emit('error', new Error('Unexpected audio download: ' + command));
                return close(1);
            }
            const read = () => {
                if (closed) return;
                child.stdout.emit('data', Buffer.from(options.invalidMetadata ? 'invalid' : JSON.stringify({
                    title: options.title || 'Test playlist', entries: options.entries ?? entries
                })));
                close(0);
            };
            if (options.blockMetadata) blocked.push(read);
            else read();
        });
        return child;
    }
    return { spawn, calls, blocked, release: () => blocked.shift()?.() };
}

module.exports = { createDownloader, entries };
