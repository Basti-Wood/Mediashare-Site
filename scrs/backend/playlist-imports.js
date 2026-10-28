'use strict';

const fs = require('fs');
const path = require('path');
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

function createPlaylistImporter({ root, spawn = defaultSpawn, normalizeFile, onChange = () => {} }) {
    const jobs = new Map();

    function view(job) {
        if (!job) return null;
        const { id, status, folder, title, total, processed, saved, skipped, failed,
            currentTitle, error, warnings, startedAt, finishedAt } = job;
        return { id, status, folder, title, total, processed, saved, skipped, failed,
            currentTitle, error, warnings: [...warnings], startedAt, finishedAt,
            cancelling: job.cancelled && status === 'running' };
    }

    function publish(job) { onChange(job.channel, view(job)); }

    function run(job, command, args, maxOutput = 8 * 1024 * 1024) {
        return new Promise((resolve, reject) => {
            if (job.cancelled) return reject(new Error('Import cancelled.'));
            const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
            job.child = child;
            let output = '';
            let stderr = '';
            let overflow = false;
            const cleanup = () => {
                if (job.child === child) job.child = null;
                clearTimeout(job.killTimer);
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
                if (overflow) return reject(new Error('The playlist metadata is too large to import.'));
                if (code !== 0) return reject(new Error(stderr.trim() || `${command} exited with code ${code}.`));
                resolve(output);
            });
        });
    }

    async function work(job, source) {
        const staging = path.join(root, '.playlist-downloads', job.id);
        const target = path.join(root, safeSegment(job.channel), job.folder);
        try {
            fs.mkdirSync(staging, { recursive: true });
            fs.mkdirSync(target, { recursive: true });
            await run(job, 'ffmpeg', ['-version']);
            const common = ['--ignore-config', '--js-runtimes', 'node', '--socket-timeout', '30', '--retries', '2'];
            const raw = await run(job, 'yt-dlp', [
                ...common, '--flat-playlist', '--dump-single-json', '--skip-download', '--ignore-errors', '--', source
            ]);
            let metadata;
            try { metadata = JSON.parse(raw); }
            catch { throw new Error('Could not read the playlist. Check its URL and visibility.'); }
            const entries = Array.isArray(metadata.entries) ? metadata.entries : [];
            if (!entries.length) throw new Error('No videos found. Check that the playlist is public or unlisted.');
            job.title = metadata.title || job.title;
            job.total = entries.length;
            publish(job);

            for (let i = 0; i < entries.length && !job.cancelled; i++) {
                const entry = entries[i];
                const itemDir = path.join(staging, String(i));
                job.currentTitle = String(entry?.title || `Video ${i + 1}`);
                publish(job);
                try {
                    if (!/^[A-Za-z0-9_-]{11}$/.test(entry?.id || ''))
                        throw new Error('This playlist entry is unavailable.');
                    fs.mkdirSync(itemDir, { recursive: true });
                    await run(job, 'yt-dlp', [
                        ...common, '--no-playlist', '--format', 'bestaudio/best',
                        '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '192K',
                        '--restrict-filenames', '--windows-filenames', '--no-overwrites', '--no-progress',
                        '--output', path.join(itemDir, '%(title).120B [%(id)s].%(ext)s'),
                        '--', `https://www.youtube.com/watch?v=${entry.id}`
                    ], 128 * 1024);
                    if (job.cancelled) break;
                    const mp3 = fs.readdirSync(itemDir, { withFileTypes: true })
                        .find(file => file.isFile() && file.name.toLowerCase().endsWith('.mp3'));
                    if (!mp3) throw new Error('No MP3 was produced for this video.');
                    const downloaded = path.join(itemDir, mp3.name);
                    const filename = `${String(i + 1).padStart(5, '0')} - ${mp3.name}`;
                    const destination = path.join(target, filename);
                    if (fs.existsSync(destination)) {
                        job.skipped++;
                    } else {
                        await normalizeFile(downloaded);
                        if (job.cancelled) break;
                        try {
                            // Never overwrite existing uploads or another import.
                            fs.copyFileSync(downloaded, destination, fs.constants.COPYFILE_EXCL);
                            job.saved++;
                        } catch (err) {
                            if (err.code !== 'EEXIST') throw err;
                            job.skipped++;
                        }
                    }
                } catch (err) {
                    if (job.cancelled) break;
                    job.failed++;
                    if (job.warnings.length < 5)
                        job.warnings.push(`${job.currentTitle}: ${err.message}`);
                } finally {
                    fs.rmSync(itemDir, { recursive: true, force: true });
                }
                job.processed++;
                publish(job);
            }
            job.status = job.cancelled ? 'cancelled'
                : job.failed === 0 ? 'completed'
                : job.saved + job.skipped > 0 ? 'partial' : 'failed';
            if (job.status === 'failed') job.error = job.warnings[0] || 'No songs could be saved.';
        } catch (err) {
            job.status = job.cancelled ? 'cancelled' : 'failed';
            if (!job.cancelled) job.error = err.message;
        } finally {
            clearTimeout(job.killTimer);
            try { fs.rmSync(staging, { recursive: true, force: true }); }
            catch {
                if (job.warnings.length < 5) job.warnings.push('Temporary download files could not be removed.');
            }
            job.currentTitle = '';
            job.finishedAt = new Date().toISOString();
            publish(job);
        }
    }

    return {
        start(channel, { url, folder } = {}) {
            const source = playlistUrl(url);
            safeSegment(channel);
            const destination = safeSegment(folder || `YouTube-${source.id}`);
            if (jobs.get(channel)?.status === 'running')
                throw Object.assign(new Error('A playlist import is already running for this channel.'), { status: 409 });
            const job = {
                id: randomUUID(), channel, folder: destination, title: 'YouTube playlist',
                status: 'running', total: null, processed: 0, saved: 0, skipped: 0, failed: 0,
                currentTitle: '', error: null, warnings: [], startedAt: new Date().toISOString(), finishedAt: null,
                cancelled: false, child: null
            };
            jobs.set(channel, job);
            publish(job);
            // Keep the request short; status survives dashboard reloads while
            // this process runs. Completed MP3s are stored on disk.
            job.done = work(job, source.url);
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
