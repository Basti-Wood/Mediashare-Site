'use strict';

const { randomUUID } = require('crypto');
const { spawn: defaultSpawn } = require('child_process');

function playlistUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch {}
    const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];
    const id = url?.searchParams.get('list');
    if (!url || url.protocol !== 'https:' || !hosts.includes(url.hostname)
        || url.username || url.password || url.port || !/^[A-Za-z0-9_-]{2,150}$/.test(id || ''))
        throw Object.assign(new Error('Paste a YouTube playlist URL containing list=…'), { status: 400 });
    return { id, url: `https://www.youtube.com/playlist?list=${id}` };
}

function safeSegment(value) {
    const segment = String(value || '').trim();
    if (!segment || segment.length > 180 || /[<>:"/\\|?*\x00-\x1f]/.test(segment)
        || segment === '.' || segment.includes('..') || segment.startsWith('.'))
        throw Object.assign(new Error('Invalid channel or folder name.'), { status: 400 });
    return segment;
}

function createPlaylistImporter({ spawn = defaultSpawn, onSave, onChange = () => {} }) {
    const jobs = new Map();

    function view(job) {
        if (!job) return null;
        const { id, status, playlistId, url, title, total, processed, saved, skipped, failed,
            currentTitle, error, warnings, startedAt, finishedAt } = job;
        return { id, status, playlistId, url, title, total, processed, saved, skipped, failed,
            currentTitle, error, warnings: [...warnings], startedAt, finishedAt,
            cancelling: job.cancelled && status === 'running' };
    }

    function publish(job) { onChange(job.channel, view(job)); }

    function run(job, command, args, maxOutput = 8 * 1024 * 1024) {
        return new Promise((resolve, reject) => {
            if (job.cancelled) return reject(new Error('Import cancelled.'));
            const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
            job.child = child;
            let timedOut = false;
            job.timeoutTimer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, 90000);
            job.timeoutTimer.unref();
            let output = '';
            let stderr = '';
            let overflow = false;
            const cleanup = () => {
                if (job.child === child) job.child = null;
                clearTimeout(job.killTimer);
                clearTimeout(job.timeoutTimer);
            };
            child.stdout.on('data', chunk => {
                if (overflow) return;
                output += chunk.toString();
                if (Buffer.byteLength(output) > maxOutput) {
                    overflow = true;
                    output = '';
                    child.kill('SIGKILL');
                }
            });
            child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
            child.on('error', err => {
                cleanup();
                reject(new Error(err.code === 'ENOENT'
                    ? `${command} is not installed. Rebuild the Docker image or install it on the server.`
                    : err.message));
            });
            child.on('close', code => {
                cleanup();
                if (job.cancelled) return reject(new Error('Import cancelled.'));
                if (timedOut) return reject(new Error('Reading the playlist timed out. Please try again.'));
                if (overflow) return reject(new Error('The playlist metadata is too large to import.'));
                if (code !== 0) return reject(new Error(stderr.trim() || `${command} exited with code ${code}.`));
                resolve(output);
            });
        });
    }

    async function work(job) {
        try {
            const raw = await run(job, 'yt-dlp', [
                '--ignore-config', '--js-runtimes', 'node', '--socket-timeout', '30', '--retries', '2',
                '--flat-playlist', '--dump-single-json', '--skip-download', '--ignore-errors', '--', job.url
            ]);
            let metadata;
            try { metadata = JSON.parse(raw); }
            catch { throw new Error('Could not read the playlist. Check its URL and visibility.'); }
            const entries = Array.isArray(metadata?.entries) ? metadata.entries : [];
            if (!entries.length) throw new Error('No videos found. Check that the playlist is public or unlisted.');
            job.title = String(metadata.title || 'YouTube playlist');
            job.total = entries.length;
            const addedAt = new Date().toISOString();
            const items = [];
            for (const entry of entries) {
                if (!/^[A-Za-z0-9_-]{11}$/.test(entry?.id || '')
                    || ['private', 'premium_only', 'subscriber_only', 'needs_auth'].includes(entry.availability)
                    || ['[Private video]', '[Deleted video]', 'Private video', 'Deleted video'].includes(entry.title)) {
                    job.skipped++;
                } else {
                    items.push({ url: `https://www.youtube.com/watch?v=${entry.id}`,
                        title: String(entry.title || `YouTube video (${entry.id})`), platform: 'youtube', addedAt });
                }
            }
            job.processed = entries.length;
            if (!items.length) throw new Error('This playlist has no available songs. Your music list was kept.');
            if (job.cancelled) return;
            const committed = await onSave(job.channel, {
                id: job.playlistId, url: job.url, title: job.title, items, savedAt: addedAt
            }, () => job.cancelled);
            if (committed === false) return;
            job.saved = items.length;
            job.status = job.skipped ? 'partial' : 'completed';
            if (job.skipped) job.warnings.push(`${job.skipped} unavailable playlist entries were skipped.`);
        } catch (err) {
            job.status = 'failed';
            job.error = err.message;
        } finally {
            if (job.cancelled && !job.saved) {
                job.status = 'cancelled';
                job.error = null;
            }
            clearTimeout(job.killTimer);
            clearTimeout(job.timeoutTimer);
            job.currentTitle = '';
            job.finishedAt = new Date().toISOString();
            publish(job);
        }
    }

    return {
        start(channel, { url } = {}) {
            const source = playlistUrl(url);
            safeSegment(channel);
            if (jobs.get(channel)?.status === 'running')
                throw Object.assign(new Error('A playlist import is already running for this channel.'), { status: 409 });
            const job = {
                id: randomUUID(), channel, playlistId: source.id, url: source.url, title: 'YouTube playlist',
                status: 'running', total: null, processed: 0, saved: 0, skipped: 0, failed: 0,
                currentTitle: '', error: null, warnings: [], startedAt: new Date().toISOString(), finishedAt: null,
                cancelled: false, child: null
            };
            jobs.set(channel, job);
            publish(job);
            // Keep the request short; status survives dashboard reloads while
            // this process runs. Completed playlists and their queues are persisted.
            job.done = work(job);
            return view(job);
        },
        status(channel) { return view(jobs.get(channel)); },
        cancel(channel, id) {
            const job = jobs.get(channel);
            if (!job || job.id !== id)
                throw Object.assign(new Error('Import not found.'), { status: 404 });
            if (job.status === 'running' && !job.cancelled) {
                job.cancelled = true;
                const child = job.child;
                if (child) {
                    child.kill('SIGTERM');
                    job.killTimer = setTimeout(() => {
                        if (job.child === child) child.kill('SIGKILL');
                    }, 3000);
                    job.killTimer.unref();
                }
                publish(job);
            }
            return view(job);
        },
        async settle(channel) { await jobs.get(channel)?.done; }
    };
}

module.exports = { createPlaylistImporter, playlistUrl };
