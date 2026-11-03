'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn: defaultSpawn } = require('child_process');

const ID = /^[A-Za-z0-9_-]{11}$/;
const MIB = 1024 * 1024;
const error = (code, message, status = 502) => Object.assign(new Error(message), { code, status });
const FORMATS = [
    'bestaudio[ext=m4a]/bestaudio/best',
    'best[ext=mp4][height<=480]/best[acodec!=none][height<=480]/best[acodec!=none]'
];

function publicFailure(err) {
    if (err.code === 'ENOENT') return error('DEPENDENCY_MISSING', 'The server is missing a media tool. Rebuild the Docker image to install yt-dlp, ffmpeg and ffprobe.');
    if (err.code && err.status) return err;
    const detail = String(err.message || err);
    if (/private video|video (is )?unavailable|this video is not available|has been removed|copyright|members.only|age.restricted/i.test(detail))
        return error('YOUTUBE_UNAVAILABLE', 'YouTube refused this video or it is unavailable to this server. Retry later or skip this song.');
    if (/429|too many requests/i.test(detail)) return error('YOUTUBE_RATE_LIMIT', 'YouTube is rate-limiting this server. Wait a little and retry.');
    if (/sign in|confirm.*bot|403/i.test(detail)) return error('YOUTUBE_ACCESS', 'YouTube refused this download. Retry later or skip this song.');
    if (/max.*file.*size|larger than|too large/i.test(detail)) return error('MEDIA_TOO_LARGE', 'This video exceeds the temporary audio cache limit.');
    if (/does not pass filter|is_live/i.test(detail)) return error('LIVE_STREAM', 'Live streams cannot be prepared as complete temporary songs.');
    if (/invalid data|decod|invalid audio/i.test(detail)) return error('INVALID_MEDIA', 'The downloaded song could not be decoded completely. Retry playback or skip it.');
    return error('PREPARATION_FAILED', 'The server could not download and prepare this song. Retry playback or skip it.');
}

// Completed normalized files are published atomically. The browser never reads
// a partial download, an expiring googlevideo URL, or a running transcode.
function createYouTubeCache({ root, spawn = defaultSpawn, now = Date.now,
    maxBytes = 1024 * MIB, maxEntryBytes = 128 * MIB, ttlMs = 6 * 60 * 60 * 1000,
    downloadTimeoutMs = 180000, processTimeoutMs = 120000, concurrency = 2,
    loudnorm = 'loudnorm=I=-14:TP=-1.5:LRA=11', onError = () => {} } = {}) {
    root = path.resolve(root);
    const entries = new Map();
    const jobs = new Map();
    const active = new Set();
    const plans = new Map();
    const demands = new Map();
    const leases = new Map();
    const stageRoot = path.join(root, '.staging');
    let closed = false;
    let order = 0;
    fs.mkdirSync(stageRoot, { recursive: true });

    const fileFor = id => path.join(root, id + '.mp3');
    const metaFor = id => path.join(root, id + '.json');
    const validId = id => { if (!ID.test(id || '')) throw error('INVALID_ID', 'Invalid YouTube video ID.', 400); };
    const referenced = id => [...plans.values()].some(plan => plan.expires > now() && plan.ids.includes(id));
    const pinned = id => (leases.get(id) || 0) > 0 || (demands.get(id) || 0) > now()
        || [...plans.values()].some(plan => plan.expires > now() && plan.current === id);
    const wanted = id => pinned(id) || referenced(id);
    function remove(id) {
        entries.delete(id);
        fs.rmSync(fileFor(id), { force: true });
        fs.rmSync(metaFor(id), { force: true });
    }
    function writeMeta(entry) {
        entry.savedAt = now();
        const temporary = path.join(root, `.${entry.id}.${randomUUID()}.tmp`);
        try {
            fs.writeFileSync(temporary, JSON.stringify(entry) + '\n');
            fs.renameSync(temporary, metaFor(entry.id));
        } finally { fs.rmSync(temporary, { force: true }); }
    }
    function ready(id, touch = false) {
        const entry = entries.get(id);
        if (!entry) return null;
        let stat;
        try { stat = fs.lstatSync(fileFor(id)); } catch {}
        if (!stat?.isFile() || stat.size !== entry.bytes || !stat.size
            || (entry.expires <= now() && !pinned(id))) { remove(id); return null; }
        if (touch) {
            entry.lastUsed = now();
            entry.expires = now() + ttlMs;
            if (now() - (entry.savedAt || entry.createdAt) > 60000) writeMeta(entry);
        }
        return { ...entry, file: fileFor(id) };
    }
    function trim(extra = 0, keep = null) {
        for (const [id, entry] of entries) if (entry.expires <= now() && !pinned(id)) remove(id);
        let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
        const candidates = [...entries.values()].filter(entry => entry.id !== keep && !pinned(entry.id))
            .sort((a, b) => a.lastUsed - b.lastUsed);
        for (const entry of candidates) {
            if (bytes + extra <= maxBytes) break;
            remove(entry.id);
            bytes -= entry.bytes;
        }
        if (bytes + extra > maxBytes) throw error('CACHE_FULL', 'The temporary audio cache is full. Let the current downloads finish and retry.', 503);
    }

    // Recover completed files after restart; discard abandoned/incomplete pairs.
    for (const name of fs.readdirSync(root)) {
        if (!/^[A-Za-z0-9_-]{11}\.json$/.test(name)) continue;
        const id = name.slice(0, -5);
        try {
            const entry = JSON.parse(fs.readFileSync(metaFor(id), 'utf8'));
            if (entry?.id !== id || !Number.isFinite(entry.duration) || entry.duration <= 0
                || !Number.isFinite(entry.bytes) || entry.bytes <= 0 || entry.bytes > maxEntryBytes
                || !Number.isFinite(entry.expires) || !Number.isFinite(entry.lastUsed)) throw new Error('Invalid cache record');
            entries.set(id, entry);
            ready(id);
        } catch { remove(id); }
    }
    for (const name of fs.readdirSync(root)) {
        if (/^[A-Za-z0-9_-]{11}\.mp3$/.test(name) && !entries.has(name.slice(0, -4))) fs.rmSync(path.join(root, name), { force: true });
    }
    for (const name of fs.readdirSync(stageRoot)) {
        fs.rmSync(path.join(stageRoot, name), { recursive: true, force: true });
    }
    trim();

    function stop(job, reason) {
        if (job.cancelled || ['ready', 'failed'].includes(job.state)) return;
        job.cancelled = reason || error('CANCELLED', 'Audio preparation was cancelled.', 409);
        if (job.child) {
            const child = job.child;
            child.kill('SIGTERM');
            job.killTimer = setTimeout(() => { if (job.child === child) child.kill('SIGKILL'); }, 2000);
            job.killTimer.unref();
        } else if (job.state === 'queued') {
            job.state = 'failed'; job.error = job.cancelled; job.retryAt = now(); job.reject(job.error);
        }
    }
    function sweep() {
        for (const [channel, plan] of plans) if (plan.expires <= now()) plans.delete(channel);
        for (const [id, until] of demands) if (until <= now()) demands.delete(id);
        for (const job of jobs.values()) {
            if (['queued', 'downloading', 'converting', 'checking'].includes(job.state) && !wanted(job.id)) stop(job);
            if (job.state === 'failed' && job.retryAt < now() - 60000) jobs.delete(job.id);
        }
        try { trim(); } catch { /* Current files can temporarily consume the whole budget. */ }
        pump();
    }
    const timer = setInterval(sweep, 5000);
    timer.unref();

    function run(job, command, args, timeoutMs = processTimeoutMs) {
        return new Promise((resolve, reject) => {
            if (job.cancelled || closed) return reject(job.cancelled || error('CLOSED', 'Audio cache is stopping.', 503));
            const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
            job.child = child;
            let stdout = '', stderr = '', failure;
            const timeout = setTimeout(() => { failure = error('PREPARATION_TIMEOUT', 'Preparing this song timed out. Retry playback or skip it.'); child.kill('SIGKILL'); }, timeoutMs);
            timeout.unref();
            const sizeCheck = setInterval(() => {
                try {
                    const size = fs.readdirSync(job.stage).reduce((sum, name) => sum + fs.lstatSync(path.join(job.stage, name)).size, 0);
                    if (size > maxEntryBytes * 2 + MIB) { failure = error('MEDIA_TOO_LARGE', 'This video exceeds the temporary audio cache limit.'); child.kill('SIGKILL'); }
                } catch { /* A download may be between temporary-file renames. */ }
            }, 250);
            sizeCheck.unref();
            const cleanup = () => {
                clearTimeout(timeout); clearInterval(sizeCheck); clearTimeout(job.killTimer);
                if (job.child === child) job.child = null;
            };
            child.stdout.on('data', chunk => {
                stdout += chunk.toString();
                if (Buffer.byteLength(stdout) > 1024 * 1024) { failure = error('INVALID_MEDIA', 'The media tool returned too much output.'); child.kill('SIGKILL'); }
            });
            child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
            child.on('error', err => { cleanup(); reject(err); });
            child.on('close', code => {
                cleanup();
                if (job.cancelled) reject(job.cancelled);
                else if (failure) reject(failure);
                else if (code !== 0) reject(new Error(stderr || `${command} exited with code ${code}`));
                else resolve(stdout);
            });
        });
    }
    async function probe(job, file) {
        const raw = await run(job, 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-show_entries', 'format=duration:stream=codec_type,codec_name,duration', '-of', 'json', file]);
        let data;
        try { data = JSON.parse(raw); } catch { throw error('INVALID_MEDIA', 'The downloaded song has no readable audio.'); }
        const audio = data.streams?.find(stream => stream.codec_type === 'audio');
        const duration = Number(data.format?.duration || audio?.duration);
        if (!audio || !Number.isFinite(duration) || duration <= 0) throw error('INVALID_MEDIA', 'The downloaded song has no complete audio track.');
        return { duration, codec: audio.codec_name };
    }
    async function work(job) {
        job.stage = path.join(stageRoot, randomUUID());
        let lastError;
        try {
            fs.mkdirSync(job.stage, { recursive: true });
            for (let attempt = 0; attempt < FORMATS.length; attempt++) {
                if (job.cancelled) throw job.cancelled;
                for (const name of fs.readdirSync(job.stage)) fs.rmSync(path.join(job.stage, name), { recursive: true, force: true });
                try {
                    job.state = 'downloading';
                    await run(job, 'yt-dlp', [
                        '--ignore-config', '--js-runtimes', 'node', '--no-playlist', '--no-progress',
                        '--socket-timeout', '20', '--retries', '3', '--fragment-retries', '3', '--extractor-retries', '2',
                        '--abort-on-unavailable-fragments', '--retry-sleep', 'fragment:exp=1:4',
                        '--retry-sleep', 'http:exp=1:4', '--concurrent-fragments', '2', '--match-filters', '!is_live',
                        '--max-filesize', String(maxEntryBytes), '--cache-dir', path.join(root, '.extractor'),
                        '--format', FORMATS[attempt], '--output', path.join(job.stage, 'source.%(ext)s'),
                        '--', `https://www.youtube.com/watch?v=${job.id}`
                    ], downloadTimeoutMs);
                    const name = fs.readdirSync(job.stage).find(name => /^source\.[a-z0-9]+$/i.test(name) && !name.endsWith('.part') && !name.endsWith('.ytdl'));
                    if (!name) throw error('INVALID_MEDIA', 'The download did not produce a complete media file.');
                    const source = path.join(job.stage, name);
                    const sourceStat = fs.lstatSync(source);
                    if (!sourceStat.isFile() || !sourceStat.size) throw error('INVALID_MEDIA', 'The downloaded file is empty.');
                    if (sourceStat.size > maxEntryBytes) throw error('MEDIA_TOO_LARGE', 'This video exceeds the temporary audio cache limit.');
                    const original = await probe(job, source);
                    job.state = 'converting';
                    const output = path.join(job.stage, 'ready.mp3');
                    await run(job, 'ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe',
                        '-i', source, '-vn', '-af', loudnorm, '-codec:a', 'libmp3lame', '-b:a', '192k',
                        '-fs', String(maxEntryBytes + 1), output]);
                    const size = fs.lstatSync(output).size;
                    if (!size) throw error('INVALID_MEDIA', 'The prepared audio file was empty.');
                    if (size > maxEntryBytes) throw error('MEDIA_TOO_LARGE', 'This video exceeds the temporary audio cache limit.');
                    job.state = 'checking';
                    const normalized = await probe(job, output);
                    if (normalized.codec !== 'mp3' || Math.abs(normalized.duration - original.duration) > Math.max(2, original.duration * 0.01))
                        throw error('INVALID_MEDIA', 'The prepared audio was incomplete.');
                    // Decode the whole file before publishing it, including any
                    // malformed/truncated final frames that metadata can miss.
                    await run(job, 'ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', output, '-f', 'null', '-']);
                    if (job.cancelled || closed) throw job.cancelled || error('CLOSED', 'Audio cache is stopping.', 503);
                    trim(size, job.id);
                    const entry = { id: job.id, bytes: size, duration: normalized.duration, createdAt: now(), lastUsed: now(), expires: now() + ttlMs };
                    fs.renameSync(output, fileFor(job.id));
                    try { writeMeta(entry); } catch (err) { fs.rmSync(fileFor(job.id), { force: true }); throw err; }
                    entries.set(job.id, entry);
                    job.state = 'ready';
                    jobs.delete(job.id);
                    job.resolve({ ...entry, file: fileFor(job.id) });
                    return;
                } catch (err) {
                    lastError = publicFailure(err);
                    if (job.cancelled || ['DEPENDENCY_MISSING', 'YOUTUBE_UNAVAILABLE', 'YOUTUBE_RATE_LIMIT', 'MEDIA_TOO_LARGE', 'LIVE_STREAM', 'CACHE_FULL', 'CLOSED'].includes(lastError.code)) throw lastError;
                }
            }
            throw lastError;
        } catch (err) {
            job.state = 'failed';
            job.error = publicFailure(job.cancelled || err);
            job.retryAt = now() + (job.cancelled ? 0 : 60000);
            job.reject(job.error);
            if (!job.cancelled) { try { onError(job.id, job.error); } catch {} }
        } finally {
            try { fs.rmSync(job.stage, { recursive: true, force: true }); } catch {}
        }
    }
    function pump() {
        if (closed) return;
        while (active.size < concurrency) {
            const queued = [...jobs.values()].filter(job => job.state === 'queued' && !job.cancelled)
                .sort((a, b) => a.priority - b.priority || a.order - b.order);
            const job = queued.find(job => job.priority === 0 || [...active].filter(item => item.priority > 0).length < Math.max(1, concurrency - 1));
            if (!job) return;
            active.add(job);
            job.running = work(job).finally(() => { active.delete(job); pump(); });
        }
    }
    function prepare(id, { priority = 0, retry = false, direct = true } = {}) {
        validId(id);
        if (closed) throw error('CLOSED', 'Audio cache is stopping.', 503);
        if (priority === 0 && direct) demands.set(id, now() + 15000);
        const cached = ready(id, priority === 0);
        if (cached) return Promise.resolve(cached);
        let job = jobs.get(id);
        if (job?.state === 'failed') {
            if (!retry && job.retryAt > now()) return job.promise;
            jobs.delete(id); job = null;
        }
        if (!job) {
            if ([...jobs.values()].filter(job => job.state === 'queued').length >= 48) throw error('CACHE_BUSY', 'The audio preparation queue is busy. Retry shortly.', 503);
            job = { id, state: 'queued', priority, order: order++, cancelled: null, child: null };
            job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
            job.promise.catch(() => {});
            jobs.set(id, job);
        }
        job.priority = Math.min(priority, job.priority);
        if (priority === 0 && !active.has(job) && active.size >= concurrency) {
            const background = [...active].find(item => item.priority > 0 && item !== job);
            if (background) stop(background, error('PREEMPTED', 'Prefetch paused for the current song.', 409));
        }
        pump();
        return job.promise;
    }
    function status(id) {
        validId(id);
        const entry = ready(id);
        if (entry) return { status: 'ready', duration: entry.duration };
        const job = jobs.get(id);
        if (job?.state === 'failed') return { status: 'failed', error: job.error.message, code: job.error.code, httpStatus: job.error.status };
        return { status: 'preparing', stage: job?.state || 'queued', retryAfterMs: 1000 };
    }
    return {
        status,
        prepare,
        request(id, options) { prepare(id, options).catch(() => {}); return status(id); },
        acquire(id) {
            validId(id);
            leases.set(id, (leases.get(id) || 0) + 1);
            let released = false;
            const release = () => {
                if (released) return; released = true;
                const count = (leases.get(id) || 1) - 1;
                if (count) leases.set(id, count); else leases.delete(id);
            };
            try { return { ready: prepare(id, { direct: false }), release }; }
            catch (err) { release(); throw err; }
        },
        plan(channel, current, upcoming = []) {
            if (closed) return;
            const ids = [...new Set([current, ...upcoming].filter(id => ID.test(id || '')))];
            plans.set(channel, { current, ids, expires: now() + 120000 });
            for (const id of ids) {
                try { prepare(id, { priority: id === current ? 0 : 1, direct: false }).catch(() => {}); } catch {}
            }
            sweep();
        },
        cleanup: sweep,
        async close() {
            closed = true;
            clearInterval(timer);
            for (const job of jobs.values()) stop(job, error('CLOSED', 'Audio cache is stopping.', 503));
            await Promise.allSettled([...active].map(job => job.running));
        }
    };
}

module.exports = { createYouTubeCache };
