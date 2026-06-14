'use strict';
require('dotenv').config();

const express  = require('express');
const session  = require('express-session');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const { execFile } = require('child_process');
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

async function expandYouTubePlaylist(playlistId) {
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (apiKey) {
        // Full expansion via YouTube Data API v3 (up to 200 items)
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
        } while (pageToken && pages < 10);
        if (items.length > 0) return items;
    }

    // Fallback: scrape the YouTube playlist page (no API key required)
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
// The endpoint 302-redirects to the resolved googlevideo URL (cheap — we don't
// proxy the audio bytes). Those URLs are signed and time-limited (a few hours),
// so we cache them briefly to avoid spawning yt-dlp on every play.

const ytAudioCache = new Map(); // videoId -> { url, expires }
const YT_AUDIO_TTL_MS = 90 * 60 * 1000; // 90 min — comfortably inside the signed-URL lifetime

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

// GET a direct audio stream for a YouTube video id. Redirects to the resolved
// googlevideo URL. No auth: the overlay (OBS browser source / background tab)
// has no session, same as the other /api/channels endpoints.
app.get('/api/yt-audio/:videoId', async (req, res) => {
    const videoId = String(req.params.videoId || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'Invalid video id.' });
    }

    const cached = ytAudioCache.get(videoId);
    if (cached && cached.expires > Date.now()) {
        return res.redirect(302, cached.url);
    }

    try {
        const url = await resolveYouTubeAudioUrl(videoId);
        ytAudioCache.set(videoId, { url, expires: Date.now() + YT_AUDIO_TTL_MS });
        return res.redirect(302, url);
    } catch (e) {
        console.error(`yt-dlp failed for ${videoId}:`, e.message || e);
        return res.status(502).json({ error: 'Could not resolve audio stream.' });
    }
});

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
