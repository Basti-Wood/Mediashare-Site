'use strict';

// One clock per playback, independent of when a browser opens its player.
// Only the elected audible player's reports move the clock. Observers only read.
function createPlaybackClock({ now = Date.now, onChange = () => {}, leaseMs = 6000 } = {}) {
    const channels = new Map();
    const MAX_POSITION = 24 * 60 * 60;
    const validPosition = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_POSITION;
    const running = record => record.started && record.playing && !record.paused;
    const positionAt = record => Math.min(record.duration || MAX_POSITION,
        record.position + (running(record) ? Math.max(0, now() - record.at) / 1000 : 0));
    function snapshot(channel) {
        const record = channels.get(channel);
        return record ? { channel, playbackId: record.id, position: positionAt(record), serverNow: now(),
            paused: record.paused, running: running(record), started: record.started,
            revision: record.revision, seekVersion: record.seekVersion, settingsRevision: record.settingsRevision,
            leaderId: record.leaderId, leaseUntil: record.leaseUntil, duration: record.duration } : null;
    }
    function changed(channel, record) {
        record.revision++;
        const state = snapshot(channel);
        onChange(state);
        return state;
    }
    return {
        snapshot,
        select(channel, id, settings, settingsRevision) {
            if (!id) { channels.delete(channel); return null; }
            if (channels.get(channel)?.id !== id) channels.set(channel, {
                id, position: 0, at: now(), paused: settings.paused, playing: false, started: false,
                revision: 0, seekVersion: 0, settingsRevision, duration: 0, leaderId: null, leaseUntil: 0
            });
            return snapshot(channel);
        },
        clear(channel) { channels.delete(channel); },
        settings(channel, settings, revision) {
            const record = channels.get(channel);
            if (!record || revision < record.settingsRevision) return snapshot(channel);
            if (record.paused !== settings.paused) {
                record.position = positionAt(record); record.at = now();
                record.paused = settings.paused;
                record.leaderId = null; record.leaseUntil = 0;
            }
            record.settingsRevision = revision;
            return changed(channel, record);
        },
        report(channel, data) {
            const record = channels.get(channel);
            const rejected = () => ({ accepted: false, playback: snapshot(channel) });
            if (!record || data?.playbackId !== record.id || typeof data.clientId !== 'string'
                || !/^[A-Za-z0-9_-]{8,80}$/.test(data.clientId)
                || !['playing', 'waiting', 'paused'].includes(data.state)
                || !validPosition(data.position) || data.seekVersion !== record.seekVersion
                || data.settingsRevision !== record.settingsRevision || data.observer === true) return rejected();
            const ownsClock = record.leaderId === data.clientId;
            if (!ownsClock && (record.leaseUntil > now() || data.state !== 'playing' || record.paused)) return rejected();
            record.leaderId = data.clientId;
            record.leaseUntil = now() + leaseMs;
            if (validPosition(data.duration) && data.duration > 0) record.duration = data.duration;
            const latency = data.state === 'playing' && Number.isFinite(data.reportedAt) && Math.abs(now() - data.reportedAt) < 5000
                ? Math.max(0, now() - data.reportedAt) / 1000 : 0;
            record.position = Math.min(data.position + (data.state === 'playing' && !record.paused ? latency : 0), record.duration || MAX_POSITION);
            record.at = now();
            record.playing = data.state === 'playing';
            if (record.playing && !record.paused) record.started = true;
            return { accepted: true, playback: changed(channel, record) };
        },
        seek(channel, { playbackId, position } = {}) {
            const record = channels.get(channel);
            if (!record || record.id !== playbackId) return { accepted: false, playback: snapshot(channel) };
            if (!validPosition(position)) throw Object.assign(new Error('Use a valid playback position in seconds.'), { status: 400 });
            record.position = Math.min(position, record.duration || MAX_POSITION);
            record.at = now();
            record.seekVersion++;
            return { accepted: true, playback: changed(channel, record) };
        }
    };
}

module.exports = { createPlaybackClock };
