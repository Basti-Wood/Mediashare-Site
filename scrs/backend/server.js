'use strict';
require('dotenv').config();

const express  = require('express');
const session  = require('express-session');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const { execFile, spawn } = require('child_process');
const multer   = require('multer');
const WebSocket = require('ws');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const BASTI_BASE = 'https://api.bastiwood.com';
const BASTI_WS_BASE = String(process.env.BASTI_WS_BASE || BASTI_BASE)
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:')
    .replace(/\/$/, '');
const BASTI_POLLING_ONLY = String(process.env.BASTI_POLLING_ONLY || 'true').toLowerCase() !== 'false';

const upstreamByChannel = new Map();
const localChannelSubscriberCounts = new Map();
const reconnectDelayByChannel = new Map();
const wsDisabledByChannel = new Set();
const pollTimerByChannel = new Map();
const lastMediaSignatureByChannel = new Map();

function mediaSignature(media) {
    return JSON.stringify(Array.isArray(media) ? media : []);
}

function emitQueueUpdate(channel, media = []) {
    io.to(`ch:${channel}`).emit('queue:update', { channel, media });
}

async function fetchChannelMedia(channel) {
    const data = await bastiGet(`/getallmedia/${encodeURIComponent(channel)}`);
    return Array.isArray(data?.media) ? data.media : [];
}

async function pollChannelOnce(channel) {
    try {
        const media = await fetchChannelMedia(channel);
        const signature = mediaSignature(media);
        if (lastMediaSignatureByChannel.get(channel) !== signature) {
            lastMediaSignatureByChannel.set(channel, signature);
            emitQueueUpdate(channel, media);
        }
    } catch (err) {
        console.error(`Polling failed for ${channel}:`, err.message || err);
    }
}

function startPollingChannel(channel) {
    if (pollTimerByChannel.has(channel)) return;
    const timer = setInterval(() => {
        if (getSubscriberCount(channel) <= 0) {
            stopPollingChannel(channel);
            return;
        }
        pollChannelOnce(channel);
    }, 3000);
    pollTimerByChannel.set(channel, timer);
    pollChannelOnce(channel);
}

function stopPollingChannel(channel) {
    const timer = pollTimerByChannel.get(channel);
    if (timer) {
        clearInterval(timer);
        pollTimerByChannel.delete(channel);
    }
}

function resetReconnectDelay(channel) {
    reconnectDelayByChannel.set(channel, 2000);
}

function nextReconnectDelay(channel) {
    const current = reconnectDelayByChannel.get(channel) || 2000;
    const next = Math.min(current * 2, 30000);
    reconnectDelayByChannel.set(channel, next);
    return current;
}

function getSubscriberCount(channel) {
    return localChannelSubscriberCounts.get(channel) || 0;
}

function incrementSubscriberCount(channel) {
    localChannelSubscriberCounts.set(channel, getSubscriberCount(channel) + 1);
}

function decrementSubscriberCount(channel) {
    const next = getSubscriberCount(channel) - 1;
    if (next <= 0) localChannelSubscriberCounts.delete(channel);
    else localChannelSubscriberCounts.set(channel, next);
}

function disconnectUpstream(channel) {
    const ws = upstreamByChannel.get(channel);
    if (!ws) return;
    upstreamByChannel.delete(channel);
    try { ws.close(); } catch {}
}

function scheduleUpstreamReconnect(channel) {
    if (getSubscriberCount(channel) <= 0) return;
    if (wsDisabledByChannel.has(channel)) return;
    if (upstreamByChannel.has(channel)) return;
    const delay = nextReconnectDelay(channel);
    setTimeout(() => connectUpstreamChannel(channel), delay);
}

function connectUpstreamChannel(channel) {
    if (getSubscriberCount(channel) <= 0) return;
    if (upstreamByChannel.has(channel)) return;
    if (BASTI_POLLING_ONLY) {
        startPollingChannel(channel);
        return;
    }
    if (wsDisabledByChannel.has(channel)) {
        startPollingChannel(channel);
        return;
    }

    const url = `${BASTI_WS_BASE}/ws/getallmedia/${encodeURIComponent(channel)}`;
    const headers = process.env.BASTIAPI_KEY ? { 'x-api-key': process.env.BASTIAPI_KEY } : undefined;
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    upstreamByChannel.set(channel, ws);

    ws.on('open', () => {
        resetReconnectDelay(channel);
        stopPollingChannel(channel);
        try { ws.send('refresh'); } catch {}
    });

    ws.on('message', raw => {
        try {
            const payload = JSON.parse(String(raw));
            const media = Array.isArray(payload?.media) ? payload.media : [];
            lastMediaSignatureByChannel.set(channel, mediaSignature(media));
            emitQueueUpdate(channel, media);
        } catch (err) {
            console.error(`Invalid upstream WS payload for ${channel}:`, err);
        }
    });

    ws.on('error', err => {
        const message = String(err?.message || err);
        if (message.includes('Unexpected server response: 404')) {
            wsDisabledByChannel.add(channel);
            console.warn(`Upstream WS unavailable for ${channel}; using polling fallback.`);
            disconnectUpstream(channel);
            startPollingChannel(channel);
            return;
        }
        console.error(`Upstream WS error for ${channel}:`, message);
    });

    ws.on('close', () => {
        if (upstreamByChannel.get(channel) === ws) upstreamByChannel.delete(channel);
        if (wsDisabledByChannel.has(channel)) {
            startPollingChannel(channel);
            return;
        }
        scheduleUpstreamReconnect(channel);
    });
}

// ── Proxy helpers (keeps BASTIAPI_KEY server-side) ────────────────────────────

async function bastiGet(path) {
    const r = await fetch(`${BASTI_BASE}${path}`, {
        headers: { 'x-api-key': process.env.BASTIAPI_KEY || '' }
    });
    return r.json();
}

async function bastiPost(path) {
    const r = await fetch(`${BASTI_BASE}${path}`, {
        method:  'POST',
        headers: { 'x-api-key': process.env.BASTIAPI_KEY || '' }
    });
    return r.json();
}

// Owner songs are marked by setting the username to US + channel name
// (e.g. channel "bastiwood" -> "USbastiwood"). The viewer-requests list filters
// these out. NOTE: the Twitch bot reads the song TITLE, not the username, so a
// username marker alone will NOT stop the bot pasting it — add a username check
// in the bot too if that matters.
function ownerUsernameFor(channel) {
    return 'US' + String(channel || '');
}

function isOwnerSong(item, channel) {
    if (!item) return false;
    if (item.owner_song === true) return true;
    const u = String(item.username || '');
    // Match US<channel> exactly, or any US-prefixed owner username as a fallback.
    return u === ownerUsernameFor(channel) || /^US./.test(u);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadAccounts() {
    const raw = fs.readFileSync(path.join(__dirname, '../..', 'conf', 'accounts.json'), 'utf8');
    return JSON.parse(raw).accounts;
}

function getAccountIdentifier(account) {
    return account?.channel || account?.username;
}

function normalizeIdentifier(value) {
    return String(value || '').trim().toLowerCase();
}

function getViewersForAccount(accounts, account) {
    const ownerIdentifiers = new Set(
        [account?.channel, account?.username]
            .filter(Boolean)
            .map(normalizeIdentifier)
    );

    return accounts
        .filter(other => {
            const accessList = other.access_accounts || [];
            return accessList.some(identifier => ownerIdentifiers.has(normalizeIdentifier(identifier)));
        })
        .map(getAccountIdentifier)
        .filter(Boolean);
}

function hasAccess(user, channel, accounts = loadAccounts()) {
    const requested = normalizeIdentifier(channel);
    const target = accounts.find(account => {
        const identifier = normalizeIdentifier(getAccountIdentifier(account));
        return identifier === requested || normalizeIdentifier(account.username) === requested;
    });

    if (!target) return false;

    if (
        normalizeIdentifier(getAccountIdentifier(target)) === normalizeIdentifier(user.channel)
        || normalizeIdentifier(target.username) === normalizeIdentifier(user.username)
    ) {
        return true;
    }

    const viewers = new Set((target.access_accounts || []).map(normalizeIdentifier));
    return viewers.has(normalizeIdentifier(user.channel)) || viewers.has(normalizeIdentifier(user.username));
}

// ── Personal list + play-mode (in-memory, per channel) ───────────────────────────

// mylistByChannel: channel -> string[] items
const mylistByChannel = new Map();
// modeByChannel:   channel -> { mode: 'requests'|'mylist'|'switch', switchTurn: 'requests'|'mylist' }
const modeByChannel   = new Map();

function getMyList(channel) {
    if (!mylistByChannel.has(channel)) mylistByChannel.set(channel, []);
    return mylistByChannel.get(channel);
}

function getMode(channel) {
    if (!modeByChannel.has(channel)) modeByChannel.set(channel, { mode: 'requests', switchTurn: 'requests' });
    return modeByChannel.get(channel);
}

// Keep loadChannelMyList / saveChannelMyList as thin wrappers so existing call-sites stay untouched
function loadChannelMyList(channel) { return { items: getMyList(channel) }; }
function saveChannelMyList(channel, data) { mylistByChannel.set(channel, data.items || []); }

function clearChannelMyList(channel) { getMyList(channel).length = 0; }


function loadChannelMode(channel) { return getMode(channel); }
function saveChannelMode(channel, data) { modeByChannel.set(channel, data); }

function parseYouTubeVideoId(url) {
    const s = String(url);
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    const m = s.match(/(?:youtube\.com\/(?:watch\?.*?v=|shorts\/|embed\/|v\/|e\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

function parseYouTubePlaylistId(url) {
    const m = String(url).match(/[?&]list=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    // Radio/mix playlists (RD..., UL...) cannot be expanded via the API or scrape
    // — ignore them so we fall through to single-video handling instead of
    // storing a useless un-expandable stub.
    const id = m[1];
    if (/^(RD|UL)/.test(id)) return null;
    return id;
}

async function resolveYouTubeVideoTitle(videoId) {
    try {
        const r = await fetch(
            `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`
        );
        if (!r.ok) return null;
        const d = await r.json();
        return d.title || null;
    } catch { return null; }
}

async function expandYouTubePlaylistViaScrape(playlistId) {
    try {
        const r = await fetch(
            `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
            {
                headers: {
                    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            }
        );
        if (!r.ok) { console.warn(`Playlist scrape HTTP ${r.status} for ${playlistId}`); return null; }
        const html = await r.text();

        // ── Step 1: extract ytInitialData JSON by counting braces ────────────
        const marker   = 'var ytInitialData = ';
        const startIdx = html.indexOf(marker);
        if (startIdx === -1) { console.warn('ytInitialData marker not found'); return null; }

        const jsonStart = startIdx + marker.length;
        let depth = 0, inString = false, escape = false, end = -1;
        for (let i = jsonStart; i < html.length; i++) {
            const c = html[i];
            if (escape)               { escape = false; continue; }
            if (c === '\\' && inString) { escape = true;  continue; }
            if (c === '"')              { inString = !inString; continue; }
            if (inString)               continue;
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (end === -1) { console.warn('Could not find end of ytInitialData JSON'); return null; }

        let parsed;
        try { parsed = JSON.parse(html.slice(jsonStart, end)); }
        catch (e) { console.warn('ytInitialData JSON parse failed:', e.message); return null; }

        // ── Step 2: walk the entire tree looking for playlistVideoRenderer ───
        const now   = new Date().toISOString();
        const items = [];
        const seen  = new Set();

        function walk(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) { obj.forEach(walk); return; }

            const v = obj.playlistVideoRenderer;
            if (v?.videoId && !seen.has(v.videoId)) {
                seen.add(v.videoId);
                const title = v.title?.runs?.[0]?.text
                           || v.title?.simpleText
                           || 'Unknown Title';
                items.push({ url: `https://www.youtube.com/watch?v=${v.videoId}`, title, platform: 'youtube', addedAt: now });
                return; // no need to descend further into this renderer
            }
            for (const val of Object.values(obj)) walk(val);
        }

        walk(parsed);

        // ── Step 3: regex backstop ───────────────────────────────────────────
        // ytInitialData sometimes only contains the first ~100 lazy-loaded
        // entries, or YouTube changes the renderer shape. Sweep the raw HTML for
        // any "videoId":"..." tokens we haven't already captured so long
        // playlists aren't silently truncated.
        const idRegex = /"videoId":"([A-Za-z0-9_-]{11})"/g;
        let rm;
        while ((rm = idRegex.exec(html)) !== null) {
            const vid = rm[1];
            if (seen.has(vid)) continue;
            seen.add(vid);
            items.push({ url: `https://www.youtube.com/watch?v=${vid}`, title: 'Unknown Title', platform: 'youtube', addedAt: now });
        }

        console.log(`Scraped ${items.length} videos from playlist ${playlistId}`);
        return items.length > 0 ? items : null;
    } catch (e) { console.error('Playlist scrape error:', e.message); return null; }
}

async function expandYouTubePlaylistViaYtDlp(playlistId) {
    return new Promise((resolve, reject) => {
        // --flat-playlist: only list videos, don't resolve each one (fast).
        // --print id:     output just the video ID on each line.
        // --no-playlist:  ensure a bare ID isn't treated as a playlist.
        execFile(
            'yt-dlp',
            [
                '--flat-playlist',
                '--print', 'id',
                '--no-playlist',
                '--no-warnings',
                `https://www.youtube.com/playlist?list=${playlistId}`
            ],
            { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) return reject(new Error(String(stderr || err.message).trim()));
                const ids = String(stdout).trim().split(/\r?\n/).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id));
                if (ids.length === 0) return reject(new Error('yt-dlp returned no video IDs'));
                const now = new Date().toISOString();
                const items = ids.map(id => ({
                    url:      `https://www.youtube.com/watch?v=${id}`,
                    title:    'Unknown Title',
                    platform: 'youtube',
                    addedAt:  now
                }));
                console.log(`yt-dlp resolved ${items.length} videos from playlist ${playlistId}`);
                resolve(items);
            }
        );
    });
}

async function expandYouTubePlaylist(playlistId) {
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (apiKey) {
        // Full expansion via YouTube Data API v3 (up to 2000 items)
        const items = [];
        let pageToken = '';
        let pages = 0;
        do {
            let url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(apiKey)}`;
            if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
            const r = await fetch(url);
            const data = await r.json().catch(() => ({}));
            if (!r.ok || data.error) {
                const reason = data?.error?.errors?.[0]?.reason || data?.error?.message || `HTTP ${r.status}`;
                console.error(`YouTube Data API failed for playlist ${playlistId}: ${reason}`);
                console.error('  → Check: key is correct, "YouTube Data API v3" is ENABLED, and quota is not exhausted.');
                break;
            }
            for (const item of (data.items || [])) {
                const videoId = item.snippet?.resourceId?.videoId;
                const title   = item.snippet?.title;
                if (videoId && title !== 'Deleted video' && title !== 'Private video') {
                    items.push({
                        url:      `https://www.youtube.com/watch?v=${videoId}`,
                        title:    title || 'Unknown Title',
                        platform: 'youtube',
                        addedAt:  new Date().toISOString()
                    });
                }
            }
            pageToken = data.nextPageToken || '';
            pages++;
        } while (pageToken && pages < 40);
        if (items.length > 0) return items;
    }

    // Fallback 1: yt-dlp --flat-playlist (no key needed, handles any size)
    try {
        const items = await expandYouTubePlaylistViaYtDlp(playlistId);
        if (items && items.length > 0) return items;
    } catch (e) {
        console.warn(`yt-dlp playlist fallback failed for ${playlistId}:`, e.message || e);
    }

    // Fallback 2: scrape the YouTube playlist page (last resort)
    return expandYouTubePlaylistViaScrape(playlistId);
}

// ── Middleware ────────────────────────────────────────────────────────────────

// Block raw access to config/env files
app.use('/conf', (_req, res) => res.status(403).end());
app.use('/.env', (_req, res) => res.status(403).end());

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
    secret:            process.env.SESSION_SECRET || 'change_me',
    resave:            false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, '../..')));

// Suppress favicon 404
app.get('/favicon.ico', (_req, res) => res.status(204).end());

function requireAuth(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in.' });
    next();
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials.' });

    let accounts;
    try { accounts = loadAccounts(); }
    catch { return res.status(500).json({ error: 'Cannot read accounts.' }); }

    const account = accounts.find(a => a.username === username && a.password === password);
    if (!account) return res.status(401).json({ error: 'Invalid username or password.' });

    const viewers = getViewersForAccount(accounts, account);

    req.session.regenerate(err => {
        if (err) return res.status(500).json({ error: 'Session error.' });
        req.session.user = {
            username:        account.username,
            channel:         account.channel || account.username.toLowerCase(),
            access_accounts: viewers
        };
        res.json({ success: true, user: req.session.user });
    });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.session.user });
});

// ── Media — proxy to api.bastiwood.com ───────────────────────────────────────

// GET all media for an owner (dashboard). Owner songs (pushed via add_media_top)
// are filtered OUT of the viewer-requests list — they're shown only in Now Playing.
app.get('/api/media/:owner', requireAuth, async (req, res) => {
    if (!hasAccess(req.session.user, req.params.owner))
        return res.status(403).json({ error: 'Access denied.' });
    try {
        const data = await bastiGet(`/getallmedia/${req.params.owner}`);
        const media = Array.isArray(data.media) ? data.media : [];
        // Keep the currently-playing item (index 0) even if it's an owner song so
        // Now Playing can show it; drop owner songs from the rest of the list.
        const cleaned = media.filter((item, i) =>
            i === 0 || !isOwnerSong(item, req.params.owner)
        );
        res.json({ ...data, media: cleaned });
    } catch {
        res.status(502).json({ error: 'Could not reach api.bastiwood.com' });
    }
});

// Remove a media item by index (dashboard X button)
app.post('/api/media/:owner/remove/:index', requireAuth, async (req, res) => {
    if (!hasAccess(req.session.user, req.params.owner))
        return res.status(403).json({ error: 'Access denied.' });
    try {
        const data = await bastiPost(`/removemedia/${req.params.owner}/${req.params.index}`);
        io.to(`ch:${req.params.owner}`).emit('queue:update', { channel: req.params.owner });
        res.json(data);
    } catch {
        res.status(502).json({ error: 'Could not reach api.bastiwood.com' });
    }
});

// Push an OWNER song to the FRONT of the Basti queue (used when a My List song
// becomes current). Calls Basti's /setmediatop route, which mirrors /setmedia
// but inserts at index 0. The owner marker is the username (US<channel>); Basti
// also tags it owner_song: true. Note Basti resolves the title itself.
async function pushOwnerSongToBasti(channel, item) {
    const rawUrl = item?.url || item?.media || '';
    const user   = ownerUsernameFor(channel);   // US<channel> marks it as an owner song

    // The /setmediatop/{...}/{media:path} route loses everything after '?',
    // so a normal watch?v=ID URL arrives as '.../watch' with no id. To avoid
    // that entirely, convert YouTube links to a query-free youtu.be/<id> form
    // (Basti's set_media_top handles youtu.be via its '/'-split fallback).
    let media = rawUrl;
    const ytId = parseYouTubeVideoId(rawUrl);
    if (ytId) {
        media = `https://youtu.be/${ytId}`;
    }

    const encodedMedia = encodeURIComponent(media);
    return bastiPost(`/setmediatop/${encodeURIComponent(channel)}/${encodeURIComponent(user)}/${encodedMedia}`);
}

// ── Personal list (stored locally per channel) ────────────────────────────────

app.get('/api/mylist/:owner', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.owner))
        return res.status(403).json({ error: 'Access denied.' });
    res.json(loadChannelMyList(req.params.owner));
});

app.post('/api/mylist/:owner/add', requireAuth, async (req, res) => {
    if (!hasAccess(req.session.user, req.params.owner))
        return res.status(403).json({ error: 'Access denied.' });

    const { url } = req.body;
    if (!url || typeof url !== 'string' || !url.trim())
        return res.status(400).json({ error: 'URL required.' });

    const rawUrl    = url.trim();
    const data      = loadChannelMyList(req.params.owner);
    const added     = [];
    let   warning   = null;
    const now       = new Date().toISOString();
    const playlistId = parseYouTubePlaylistId(rawUrl);

    if (playlistId) {
        // Any YouTube URL with an expandable list= param → try the full playlist
        const expanded = await expandYouTubePlaylist(playlistId);
        if (expanded && expanded.length > 0) {
            data.items.push(...expanded);
            added.push(...expanded);
        } else {
            // Expansion failed (private/unavailable, or API+scrape both down).
            // If the URL also pointed at a specific video, add THAT single video
            // so the user at least gets the one they selected — never a dead stub.
            const videoId = parseYouTubeVideoId(rawUrl);
            if (videoId) {
                const title = await resolveYouTubeVideoTitle(videoId) || 'Unknown Title';
                const entry = { url: `https://www.youtube.com/watch?v=${videoId}`, title, platform: 'youtube', addedAt: now };
                data.items.push(entry);
                added.push(entry);
                warning = 'Could not expand the playlist (add a YOUTUBE_API_KEY for reliable import) — added the single selected video instead.';
            } else {
                const entry = {
                    url:        rawUrl,
                    title:      `YouTube Playlist (${playlistId})`,
                    platform:   'youtube-playlist',
                    playlistId,
                    addedAt:    now
                };
                data.items.push(entry);
                added.push(entry);
                warning = 'Could not expand the playlist — stored as a link only.';
            }
        }
    } else {
        const videoId = parseYouTubeVideoId(rawUrl);
        if (videoId) {
            const title = await resolveYouTubeVideoTitle(videoId) || 'Unknown Title';
            const entry = { url: rawUrl, title, platform: 'youtube', addedAt: now };
            data.items.push(entry);
            added.push(entry);
        } else if (rawUrl.includes('spotify.com')) {
            const entry = { url: rawUrl, title: 'Spotify Track', platform: 'spotify', addedAt: now };
            data.items.push(entry);
            added.push(entry);
        } else {
            const entry = { url: rawUrl, title: rawUrl, platform: 'other', addedAt: now };
            data.items.push(entry);
            added.push(entry);
        }
    }

    saveChannelMyList(req.params.owner, data);
    res.json({ success: true, added, total: data.items.length, warning });
});

app.post('/api/mylist/:owner/remove/:index', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.owner))
        return res.status(403).json({ error: 'Access denied.' });

    const index = parseInt(req.params.index, 10);
    const data  = loadChannelMyList(req.params.owner);

    if (isNaN(index) || index < 0 || index >= data.items.length)
        return res.status(400).json({ error: 'Invalid index.' });

    data.items.splice(index, 1);
    saveChannelMyList(req.params.owner, data);
    res.json({ success: true, total: data.items.length });
});

app.delete('/api/mylist/:owner', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.owner))
        return res.status(403).json({ error: 'Access denied.' });
    clearChannelMyList(req.params.owner);
    res.json({ success: true });
});

// ── Mode API ──────────────────────────────────────────────────────────────────

app.get('/api/mode/:channel', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    res.json(loadChannelMode(req.params.channel));
});

app.post('/api/mode/:channel', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    const { mode } = req.body;
    const valid = ['requests', 'mylist', 'switch'];
    if (!valid.includes(mode))
        return res.status(400).json({ error: 'Invalid mode.' });
    const data = loadChannelMode(req.params.channel);
    data.mode = mode;
    if (mode === 'switch') data.switchTurn = 'requests';
    saveChannelMode(req.params.channel, data);
    io.to(`ch:${req.params.channel}`).emit('queue:update', { channel: req.params.channel });
    res.json({ success: true, mode });
});

// Tracks whether we've already pushed the head My List song to Basti for a
// channel, so /current (which may be polled rapidly) doesn't push duplicates.
const ownerPushInFlight = new Set();

// Move the head My List item into the FRONT of the Basti queue, then drop it
// from My List. Returns true if something was pushed.
async function promoteMyListHeadToBasti(ch) {
    const listData = loadChannelMyList(ch);
    if (listData.items.length === 0) return false;
    if (ownerPushInFlight.has(ch)) return false;

    ownerPushInFlight.add(ch);
    // Remove it from My List FIRST so the song is consumed exactly once. If we
    // waited until after the Basti POST, a slow/failed call (bastiPost never
    // throws on an HTTP error, only on a network fault) could leave the item in
    // the list and replay it on the next poll. Snapshot it so we can restore it
    // only if the network call genuinely fails.
    const [head] = listData.items.splice(0, 1);
    saveChannelMyList(ch, listData);

    try {
        await pushOwnerSongToBasti(ch, head);
        io.to(`ch:${ch}`).emit('queue:update', { channel: ch });
        return true;
    } catch (e) {
        console.error(`Failed to push owner song to Basti for ${ch}:`, e.message || e);
        // Network failure — put it back at the front so it isn't lost.
        const current = loadChannelMyList(ch);
        current.items.unshift(head);
        saveChannelMyList(ch, current);
        return false;
    } finally {
        ownerPushInFlight.delete(ch);
    }
}

// ── YouTube direct-audio resolver (yt-dlp) ────────────────────────────────────
//
// Why this exists: the YouTube IFrame player runs in a cross-origin iframe that
// the browser (Brave/Chrome) suspends when this page is a background tab — that's
// what kept stopping playback. We can't capture or control the iframe's audio
// from JS. Instead we resolve a DIRECT audio stream URL with yt-dlp and let the
// overlay play it through a normal same-origin <audio> element, which the browser
// does NOT suspend in the background.
//
// We used to 302-redirect straight to the resolved googlevideo URL (cheap — no
// proxying). That broke sound entirely once the overlay started routing the
// <audio> element through the Web Audio API (for loudness normalisation):
// browsers silently mute any MediaElementAudioSourceNode whose underlying
// resource is cross-origin without CORS headers, and googlevideo does not send
// them. So instead we proxy-transcode the resolved URL through ffmpeg — this
// also lets us apply EBU R128 loudness normalisation (loudnorm) so every track
// plays back at the same perceived volume, same-origin, no CORS issues.
//
// The resolved googlevideo URL is signed and time-limited (a few hours), so we
// cache it briefly to avoid spawning yt-dlp on every play.

const ytAudioCache = new Map(); // videoId -> { url, expires }
const YT_AUDIO_TTL_MS = 90 * 60 * 1000; // 90 min — comfortably inside the signed-URL lifetime

// Target loudness for all normalised playback (YouTube proxy + local uploads).
// -14 LUFS matches the common streaming-platform target (Spotify/YouTube/Apple
// Music), so songs from different sources end up at a consistent volume.
const LOUDNORM_FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11';

function resolveYouTubeAudioUrl(videoId) {
    return new Promise((resolve, reject) => {
        // -f bestaudio: pick the best audio-only stream.
        // -g: print the direct media URL instead of downloading.
        // --no-playlist: a bare ID must never expand into a list.
        execFile(
            'yt-dlp',
            [
                '-f', 'bestaudio',
                '-g',
                '--no-playlist',
                '--no-warnings',
                `https://www.youtube.com/watch?v=${videoId}`
            ],
            { timeout: 20000, maxBuffer: 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    return reject(new Error(String(stderr || err.message).trim()));
                }
                const url = String(stdout).trim().split('\n')[0];
                if (!url || !/^https?:\/\//.test(url)) {
                    return reject(new Error('yt-dlp returned no usable URL'));
                }
                resolve(url);
            }
        );
    });
}

// GET a same-origin, loudness-normalised audio stream for a YouTube video id.
// No auth: the overlay (OBS browser source / background tab) has no session,
// same as the other /api/channels endpoints.
app.get('/api/yt-audio/:videoId', async (req, res) => {
    const videoId = String(req.params.videoId || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'Invalid video id.' });
    }

    let sourceUrl;
    const cached = ytAudioCache.get(videoId);
    if (cached && cached.expires > Date.now()) {
        sourceUrl = cached.url;
    } else {
        try {
            sourceUrl = await resolveYouTubeAudioUrl(videoId);
            ytAudioCache.set(videoId, { url: sourceUrl, expires: Date.now() + YT_AUDIO_TTL_MS });
        } catch (e) {
            console.error(`yt-dlp failed for ${videoId}:`, e.message || e);
            return res.status(502).json({ error: 'Could not resolve audio stream.' });
        }
    }

    streamNormalizedAudio(sourceUrl, res, videoId);
});

// Transcodes a (possibly remote) audio source through ffmpeg with loudness
// normalisation and streams the result to the client same-origin. `res` must
// not have been responded to yet.
function streamNormalizedAudio(sourceUrl, res, label) {
    const ff = spawn('ffmpeg', [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', sourceUrl,
        '-vn',
        '-af', LOUDNORM_FILTER,
        '-f', 'mp3',
        '-b:a', '192k',
        'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let sentData = false;
    let stderrTail = '';
    ff.stderr.on('data', chunk => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');

    ff.stdout.once('data', () => { sentData = true; });
    ff.stdout.pipe(res);

    ff.on('error', err => {
        console.error(`ffmpeg failed to start for ${label}:`, err.message || err);
        if (!res.headersSent) res.status(502).json({ error: 'Audio transcode failed.' });
    });

    ff.on('close', code => {
        if (code !== 0 && !sentData) {
            console.error(`ffmpeg exited ${code} for ${label}:`, stderrTail.trim());
            if (!res.headersSent) res.status(502).json({ error: 'Audio transcode failed.' });
        }
        if (!res.writableEnded) res.end();
    });

    // Client changed/skipped tracks — stop transcoding immediately.
    res.on('close', () => {
        if (!ff.killed) ff.kill('SIGKILL');
    });
}

// ── Overlay endpoints (no auth — used by OBS browser source) ─────────────────

// Get the current (first) item — respects play mode.
// For 'mylist'/'switch' sources, owner songs are routed THROUGH the Basti queue
// (front row) so they appear in the top slot for the Twitch bot. We push the
// head My List item to Basti, then always read the current item from Basti.
app.get('/api/channels/:ch/current', async (req, res) => {
    const ch = req.params.ch;
    const modeData = loadChannelMode(ch);
    const { mode } = modeData;
    const effectiveSource = mode === 'switch' ? modeData.switchTurn : mode;

    try {
        let media = [];
        try {
            const data = await bastiGet(`/getallmedia/${ch}`);
            media = Array.isArray(data.media) ? data.media : [];
        } catch {
            return res.status(502).json({ error: 'Could not reach api.bastiwood.com' });
        }

        const topIsOwner = isOwnerSong(media[0], ch);

        // Viewer-request songs available right now = anything in the Basti queue
        // that isn't an owner (My List) song.
        const hasViewerSong = media.some(item => !isOwnerSong(item, ch));
        const hasMyListSong = loadChannelMyList(ch).items.length > 0;

        // Decide whether to promote a My List song into Basti's front row now:
        //  - 'mylist' mode : always prefer My List.
        //  - 'switch' mode : when it's My List's turn (effectiveSource === 'mylist').
        //  - ANY mode      : automatic fallback — if there's no viewer song to
        //                    play but a personal-list song exists, promote it so
        //                    the overlay never dead-ends on an empty viewer list.
        const wantMyList =
            !topIsOwner && hasMyListSong &&
            (effectiveSource === 'mylist' || !hasViewerSong);

        if (wantMyList) {
            const pushed = await promoteMyListHeadToBasti(ch);
            if (pushed) {
                const data = await bastiGet(`/getallmedia/${ch}`);
                media = Array.isArray(data.media) ? data.media : [];
            }
        }

        const current = media[0]
            ? { ...media[0], _source: isOwnerSong(media[0], ch) ? 'mylist' : 'requests' }
            : null;
        res.json({ current });
    } catch (e) {
        console.error('current failed:', e.message || e);
        res.status(502).json({ error: 'Could not reach api.bastiwood.com' });
    }
});

// Advance the queue (video ended in overlay).
// Everything (owner songs included) now lives in the Basti queue, so advancing
// is simply removing index 0 from Basti. In 'switch' mode we flip whose turn is
// next so the following /current call promotes a My List song (or not).
app.post('/api/channels/:ch/next', async (req, res) => {
    const ch = req.params.ch;
    const modeData = loadChannelMode(ch);
    const { mode } = modeData;

    try {
        await bastiPost(`/removemedia/${ch}/0`);
        if (mode === 'switch') {
            modeData.switchTurn = modeData.switchTurn === 'mylist' ? 'requests' : 'mylist';
            saveChannelMode(ch, modeData);
        }
        io.to(`ch:${ch}`).emit('queue:update', { channel: ch });
        res.json({ success: true });
    } catch {
        res.status(502).json({ error: 'Could not reach api.bastiwood.com' });
    }
});

// ── Webhook (api.bastiwood.com pushes new media to us) ───────────────────────

app.post('/api/webhook/:ch', (req, res) => {
    const key = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!process.env.BASTIAPI_KEY || key !== process.env.BASTIAPI_KEY)
        return res.status(401).json({ error: 'Unauthorized.' });

    // Just signal connected clients to refresh — api.bastiwood.com is source of truth
    io.to(`ch:${req.params.ch}`).emit('queue:update', { channel: req.params.ch });
    res.status(200).json({ success: true });
});

// ── Local media (MP3 upload, folder management, instant playback) ─────────────

const LOCAL_MEDIA_ROOT = path.join(__dirname, '../..', 'data', 'local-media');

function localMediaDir(channel, folder = '') {
    const dir = path.join(LOCAL_MEDIA_ROOT, sanitisePath(channel), sanitisePath(folder));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function sanitisePath(segment) {
    // Strip anything that isn't a safe filename character; collapse dots & slashes.
    return String(segment || '')
        .replace(/\.\./g, '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/^\.+/, '')
        .trim() || '_';
}

// Multer storage: keep original filename (sanitised), organised by channel/folder.
const localUpload = multer({
    storage: multer.diskStorage({
        destination(req, file, cb) {
            const channel = sanitisePath(req.params.channel || '');
            const folder  = sanitisePath(req.params.folder || '');
            cb(null, localMediaDir(channel, folder));
        },
        filename(req, file, cb) {
            const ext  = path.extname(file.originalname) || '.mp3';
            const base = sanitisePath(path.basename(file.originalname, ext));
            cb(null, `${base}${ext}`);
        }
    }),
    fileFilter(req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.mp3' && file.mimetype !== 'audio/mpeg') {
            return cb(new Error('Only MP3 files are allowed.'));
        }
        cb(null, true);
    },
    limits: { fileSize: 50 * 1024 * 1024 }  // 50 MB per file
});

// List folders for a channel
app.get('/api/local/:channel/folders', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    try {
        const base = localMediaDir(req.params.channel);
        const entries = fs.readdirSync(base, { withFileTypes: true });
        const folders = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
        res.json({ folders });
    } catch (e) {
        res.status(500).json({ error: 'Could not list folders.' });
    }
});

// Create a folder
app.post('/api/local/:channel/folders', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    const name = sanitisePath(String(req.body?.name || '').trim());
    if (!name) return res.status(400).json({ error: 'Folder name required.' });
    try {
        localMediaDir(req.params.channel, name);
        res.json({ success: true, folder: name });
    } catch (e) {
        res.status(500).json({ error: 'Could not create folder.' });
    }
});

// Delete a folder (and all files inside)
app.delete('/api/local/:channel/folders/:folder', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    try {
        const dir = localMediaDir(req.params.channel, req.params.folder);
        fs.rmSync(dir, { recursive: true, force: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Could not delete folder.' });
    }
});

// List files (optionally scoped to a folder)
app.get('/api/local/:channel/files', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    listLocalFiles(req.params.channel, '').then(files => res.json({ files }))
        .catch(() => res.status(500).json({ error: 'Could not list files.' }));
});

app.get('/api/local/:channel/files/:folder', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    listLocalFiles(req.params.channel, req.params.folder).then(files => res.json({ files }))
        .catch(() => res.status(500).json({ error: 'Could not list files.' }));
});

async function listLocalFiles(channel, folder) {
    const base  = localMediaDir(channel, folder);
    const files = [];
    // Walk the folder (non-recursive for the specified folder; when folder=''
    // we walk the base dir AND one level of subdirectories).
    if (!folder) {
        // Show files in root AND in each subfolder
        const entries = fs.readdirSync(base, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory()) {
                const subDir = path.join(base, e.name);
                const subs = fs.readdirSync(subDir, { withFileTypes: true });
                for (const s of subs) {
                    if (s.isFile() && s.name.toLowerCase().endsWith('.mp3')) {
                        files.push({ name: s.name, folder: e.name, path: `${e.name}/${s.name}` });
                    }
                }
            } else if (e.isFile() && e.name.toLowerCase().endsWith('.mp3')) {
                files.push({ name: e.name, folder: '', path: e.name });
            }
        }
    } else {
        const entries = fs.readdirSync(base, { withFileTypes: true });
        for (const e of entries) {
            if (e.isFile() && e.name.toLowerCase().endsWith('.mp3')) {
                files.push({ name: e.name, folder, path: `${folder}/${e.name}` });
            }
        }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
}

// Upload MP3 files (optionally into a folder).  The :folder param is optional;
// express doesn't support optional params natively, so we register two routes.
app.post('/api/local/:channel/upload', requireAuth, (req, res, next) => {
    req.params.folder = '';
    next();
});
app.post('/api/local/:channel/upload/:folder', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    localUpload.array('files', 20)(req, res, async err => {
        if (err) {
            const msg = String(err.message || err);
            if (msg.includes('Only MP3')) return res.status(400).json({ error: msg });
            return res.status(500).json({ error: msg });
        }
        const files = req.files || [];
        for (const f of files) {
            try {
                await normalizeAudioFile(f.path);
            } catch (e) {
                console.error(`Loudness normalisation failed for ${f.path}:`, e.message || e);
            }
        }
        io.to(`ch:${req.params.channel}`).emit('queue:update', { channel: req.params.channel });
        res.json({ success: true, uploaded: files.length });
    });
});

// Re-encodes an uploaded MP3 in place to a consistent loudness target (see
// LOUDNORM_FILTER) so local uploads sound the same volume as YouTube tracks
// and each other. Runs once at upload time (not per-play), so Range/seek
// support on playback is unaffected.
function normalizeAudioFile(filePath) {
    return new Promise((resolve, reject) => {
        const tmpPath = `${filePath}.norm.tmp.mp3`;
        const ff = spawn('ffmpeg', [
            '-y',
            '-i', filePath,
            '-af', LOUDNORM_FILTER,
            '-b:a', '192k',
            tmpPath
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        let stderrTail = '';
        ff.stderr.on('data', chunk => {
            stderrTail = (stderrTail + chunk.toString()).slice(-2000);
        });
        ff.on('error', reject);
        ff.on('close', code => {
            if (code !== 0) {
                fs.rm(tmpPath, { force: true }, () => {});
                return reject(new Error(stderrTail.trim() || `ffmpeg exited ${code}`));
            }
            fs.rename(tmpPath, filePath, err => err ? reject(err) : resolve());
        });
    });
}

// Delete a single file
app.delete('/api/local/:channel/files/:folder/:filename', requireAuth, (req, res) => {
    deleteLocalFileEndpoint(req, res);
});
app.delete('/api/local/:channel/files/:filename', requireAuth, (req, res) => {
    deleteLocalFileEndpoint(req, res);
});

function deleteLocalFileEndpoint(req, res) {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    try {
        const folder   = sanitisePath(req.params.folder || '');
        const filename = sanitisePath(req.params.filename || '');
        const dir      = localMediaDir(req.params.channel, folder);
        const filePath = path.join(dir, filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
        // Safety: ensure the resolved path is still inside our media tree.
        if (!filePath.startsWith(localMediaDir(req.params.channel))) {
            return res.status(400).json({ error: 'Invalid path.' });
        }
        fs.unlinkSync(filePath);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Could not delete file.' });
    }
}

// Serve a local MP3 file for playback (no auth — used by the overlay/OBS).
app.get('/api/local-media/:channel/:folder/:filename', (req, res) => {
    serveLocalFile(req, res);
});
app.get('/api/local-media/:channel/:filename', (req, res) => {
    serveLocalFile(req, res);
});

function serveLocalFile(req, res) {
    try {
        const folder   = sanitisePath(req.params.folder || '');
        const filename = sanitisePath(req.params.filename || '');
        const dir      = localMediaDir(req.params.channel, folder);
        const filePath = path.join(dir, filename);
        if (!filePath.startsWith(localMediaDir(req.params.channel))) {
            return res.status(400).json({ error: 'Invalid path.' });
        }
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Accept-Ranges', 'bytes');
        res.sendFile(filePath);
    } catch (e) {
        res.status(500).json({ error: 'Could not serve file.' });
    }
}

// Push a local MP3 to play NOW — inserts it at the front of the Basti queue
// as an owner song and removes whatever was already playing so it starts instantly.
app.post('/api/local/:channel/play/:folder/:filename', requireAuth, async (req, res) => {
    playLocalFileNow(req, res);
});
app.post('/api/local/:channel/play/:filename', requireAuth, async (req, res) => {
    playLocalFileNow(req, res);
});

async function playLocalFileNow(req, res) {
    const ch = req.params.channel;
    if (!hasAccess(req.session.user, ch))
        return res.status(403).json({ error: 'Access denied.' });

    try {
        const folder   = sanitisePath(req.params.folder || '');
        const filename = sanitisePath(req.params.filename || '');
        const dir      = localMediaDir(ch, folder);
        const filePath = path.join(dir, filename);

        if (!filePath.startsWith(localMediaDir(ch)))
            return res.status(400).json({ error: 'Invalid path.' });
        if (!fs.existsSync(filePath))
            return res.status(404).json({ error: 'File not found.' });

        // Build a URL the overlay can fetch (localhost from the server's perspective,
        // but the overlay runs in the browser — use a relative URL).
        const mediaUrl = folder
            ? `/api/local-media/${encodeURIComponent(ch)}/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`
            : `/api/local-media/${encodeURIComponent(ch)}/${encodeURIComponent(filename)}`;

        const user = ownerUsernameFor(ch);
        const entry = { url: mediaUrl, title: filename, platform: 'local' };

        // Remove the currently-playing item first so the new one plays immediately.
        try { await bastiPost(`/removemedia/${encodeURIComponent(ch)}/0`); } catch {}

        // Push the local song to the front of Basti.
        await pushOwnerSongToBasti(ch, entry);

        io.to(`ch:${ch}`).emit('queue:update', { channel: ch });
        res.json({ success: true, url: mediaUrl });
    } catch (e) {
        console.error('playLocalFileNow failed:', e.message || e);
        res.status(500).json({ error: 'Could not play file.' });
    }
}

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on('connection', socket => {
    const joinedChannels = new Set();

    socket.on('join:channel', ch => {
        if (typeof ch !== 'string') return;
        const channel = ch.trim();
        if (!channel || joinedChannels.has(channel)) return;

        joinedChannels.add(channel);
        socket.join(`ch:${channel}`);
        incrementSubscriberCount(channel);
        connectUpstreamChannel(channel);
    });

    socket.on('leave:channel', ch => {
        if (typeof ch !== 'string') return;
        const channel = ch.trim();
        if (!channel || !joinedChannels.has(channel)) return;

        joinedChannels.delete(channel);
        socket.leave(`ch:${channel}`);
        decrementSubscriberCount(channel);
        if (getSubscriberCount(channel) <= 0) {
            disconnectUpstream(channel);
            stopPollingChannel(channel);
            lastMediaSignatureByChannel.delete(channel);
        }
    });

    socket.on('disconnect', () => {
        for (const channel of joinedChannels) {
            decrementSubscriberCount(channel);
            if (getSubscriberCount(channel) <= 0) {
                disconnectUpstream(channel);
                stopPollingChannel(channel);
                lastMediaSignatureByChannel.delete(channel);
            }
        }
    });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;
server.listen(PORT, () => {
    console.log(`Mediashare running on http://localhost:${PORT}`);
    if (BASTI_POLLING_ONLY) {
        console.log('Upstream sync mode: polling-only');
    }
});
