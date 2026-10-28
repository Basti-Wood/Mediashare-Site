'use strict';

const fs = require('fs');
const path = require('path');

// Each channel belongs to a user account. Keep its transport and volume shared
// by the dashboard, pop-out and OBS, and retain them across server restarts.
function createAudioSettings(root) {
    const cache = new Map();
    const keyFor = channel => String(channel).trim().toLowerCase();
    const fileFor = key => path.join(root, `${encodeURIComponent(key)}.json`);
    function get(channel) {
        const key = keyFor(channel);
        if (!cache.has(key)) {
            let saved = {};
            try { saved = JSON.parse(fs.readFileSync(fileFor(key), 'utf8')); } catch {}
            cache.set(key, {
                volume: typeof saved?.volume === 'number' && Number.isFinite(saved.volume)
                    ? Math.max(0, Math.min(100, saved.volume)) : 100,
                paused: saved?.paused === true
            });
        }
        return { ...cache.get(key) };
    }
    return {
        get,
        update(channel, changes = {}) {
            if (!changes || typeof changes !== 'object' || Array.isArray(changes))
                throw Object.assign(new Error('Audio settings must be an object.'), { status: 400 });
            const { volume, paused } = changes;
            if ((volume !== undefined && (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 100))
                || (paused !== undefined && typeof paused !== 'boolean')
                || (volume === undefined && paused === undefined))
                throw Object.assign(new Error('Use a volume from 0 to 100 and a boolean paused setting.'), { status: 400 });
            const key = keyFor(channel);
            const settings = { ...get(channel), ...(volume === undefined ? {} : { volume }),
                ...(paused === undefined ? {} : { paused }) };
            fs.mkdirSync(root, { recursive: true });
            const file = fileFor(key);
            fs.writeFileSync(file + '.tmp', JSON.stringify(settings) + '\n');
            fs.renameSync(file + '.tmp', file);
            cache.set(key, settings);
            return { ...settings };
        }
    };
}

module.exports = { createAudioSettings };
