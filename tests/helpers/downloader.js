'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const entries = [
    { id: 'AAAAAAAAAAA', title: 'First song' },
    { id: 'BBBBBBBBBBB', title: 'Second song' }
];

// Fake only the executable boundary. The import manager still writes real
// temporary files, performs normalization callbacks and handles child events.
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
                if (args.includes('-version')) return close(0);
                if (options.normalizeFailure) {
                    child.stderr.emit('data', Buffer.from('Normalization failed'));
                    return close(1);
                }
                fs.writeFileSync(args.at(-1), Buffer.from('ID3 normalized test audio'));
                return close(0);
            }
            if (command !== 'yt-dlp') throw new Error('Unexpected command: ' + command);
            if (args.includes('--dump-single-json')) {
                child.stdout.emit('data', Buffer.from(options.invalidMetadata ? 'invalid' : JSON.stringify({
                    title: 'Test playlist', entries: options.entries || entries
                })));
                return close(0);
            }
            const id = new URL(args.at(-1)).searchParams.get('v');
            const download = () => {
                if (closed) return;
                if (options.failId === id) {
                    child.stderr.emit('data', Buffer.from('Video unavailable'));
                    return close(1);
                }
                const template = args[args.indexOf('--output') + 1];
                const filename = template.replace('%(title).120B', 'Saved_song')
                    .replace('%(id)s', id).replace('%(ext)s', 'mp3');
                fs.mkdirSync(path.dirname(filename), { recursive: true });
                fs.writeFileSync(filename, options.audio || Buffer.from('ID3 downloaded test audio'));
                close(0);
            };
            if (options.blockId === id) blocked.push(download);
            else download();
        });
        return child;
    }
    return { spawn, calls, blocked, release: () => blocked.shift()?.() };
}

module.exports = { createDownloader, entries };
