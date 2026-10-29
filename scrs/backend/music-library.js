'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Saved playlists are snapshots of YouTube links and titles, never audio files.
// Keep their original order separately from the consumable/shuffled play queue.
function createMusicLibrary(root) {
    const cache = new Map();
    const fileFor = channel => path.join(root, `${encodeURIComponent(channel)}.json`);
    const copy = value => JSON.parse(JSON.stringify(value));

    function get(channel) {
        if (!cache.has(channel)) {
            let data = { items: [], playlists: [] };
            try {
                const saved = JSON.parse(fs.readFileSync(fileFor(channel), 'utf8'));
                if (!Array.isArray(saved.items) || !Array.isArray(saved.playlists))
                    throw new Error('Invalid music library.');
                data = saved;
            } catch (err) {
                if (err.code !== 'ENOENT') throw err;
            }
            cache.set(channel, data);
        }
        return cache.get(channel);
    }

    function save(channel, data) {
        fs.mkdirSync(root, { recursive: true });
        const file = fileFor(channel);
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            fs.writeFileSync(temporary, JSON.stringify(data) + '\n');
            fs.renameSync(temporary, file);
            cache.set(channel, data);
        } finally {
            fs.rmSync(temporary, { force: true });
        }
    }

    return {
        queue(channel) { return get(channel).items; },
        setQueue(channel, items) { save(channel, { ...get(channel), items }); },
        playlists(channel) {
            return get(channel).playlists.map(({ items, ...playlist }) => ({ ...playlist, count: items.length }));
        },
        playlist(channel, id) {
            const playlist = get(channel).playlists.find(item => item.id === id);
            return playlist ? copy(playlist) : null;
        },
        saveAndLoad(channel, playlist) {
            const data = get(channel);
            const playlists = data.playlists.filter(item => item.id !== playlist.id);
            playlists.push(copy(playlist));
            save(channel, { playlists, items: copy(playlist.items) });
        },
        removePlaylist(channel, id) {
            const data = get(channel);
            const playlists = data.playlists.filter(item => item.id !== id);
            if (playlists.length === data.playlists.length) return false;
            save(channel, { ...data, playlists });
            return true;
        }
    };
}

module.exports = { createMusicLibrary };
