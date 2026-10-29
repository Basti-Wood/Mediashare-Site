'use strict';
require('dotenv').config();

const express  = require('express');
const session  = require('express-session');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const { randomUUID, createHmac } = require('crypto');
const { execFile, spawn } = require('child_process');
const multer   = require('multer');
const WebSocket = require('ws');
const { Server } = require('socket.io');
const { createPlaylistImporter } = require('./playlist-imports');
const { createMusicLibrary } = require('./music-library');
const { createAudioSettings } = require('./audio-settings');
const { FileSessionStore, persistentSessionSecret, REMEMBER_LOGIN_MS } = require('./session-store');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const LOCAL_MEDIA_ROOT = process.env.LOCAL_MEDIA_ROOT || path.join(__dirname, '../..', 'data', 'local-media');
const musicLibrary = createMusicLibrary(path.join(LOCAL_MEDIA_ROOT, '.library'));
const audioSettings = createAudioSettings(process.env.AUDIO_SETTINGS_ROOT || path.join(__dirname, '../..', 'data', 'audio-settings'));
const sessionDirectory = process.env.SESSION_STORE_ROOT || path.join(__dirname, '../..', 'data', 'sessions');
const sessionSecret = process.env.SESSION_SECRET || persistentSessionSecret(sessionDirectory);
const sessionStore = new FileSessionStore(sessionDirectory);
const SESSION_COOKIE_NAME = 'mediashare.sid';
const trustProxy = String(process.env.TRUST_PROXY ?? '1');
app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

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
    return Array.isArray(data?.media) ? data.media.map(item => decorateOwnerSong(channel, item)) : [];
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
    const data = await r.json();
    if (!r.ok || data?.success === false || data?.error)
        throw new Error(data?.error || `Basti request failed (${r.status})`);
    return data;
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

// ── Personal list (persisted) + play-mode (per channel) ───────────────────────────

// Loop applies only to My List; viewer requests are always consumed once.
const modeByChannel   = new Map();
const promotedMyListByChannel = new Map();
const personalListWaitByChannel = new Map();
const retiredMyListSongs = new WeakSet();

function getMyList(channel) {
    return musicLibrary.queue(channel);
}

function getMode(channel) {
    if (!modeByChannel.has(channel)) modeByChannel.set(channel, {
        mode: 'requests', switchTurn: 'requests', mylistLoop: false
    });
    return modeByChannel.get(channel);
}

// Keep loadChannelMyList / saveChannelMyList as thin wrappers so existing call-sites stay untouched
function loadChannelMyList(channel) { return { items: getMyList(channel) }; }
function saveChannelMyList(channel, data) { musicLibrary.setQueue(channel, data.items || []); }

function clearChannelMyList(channel) {
    const playing = promotedMyListByChannel.get(channel);
    if (playing) retiredMyListSongs.add(playing);
    saveChannelMyList(channel, { items: [] });
}


function loadChannelMode(channel) { return getMode(channel); }
function saveChannelMode(channel, data) { modeByChannel.set(channel, data); }

// Preview, pop-out and OBS may all poll/finish at once. Serialize playback
// changes so a looping item is promoted once and a finish removes only one song.
const playbackLocks = new Map();
const playbackByChannel = new Map();

async function withPlaybackLock(channel, action) {
    const previous = playbackLocks.get(channel) || Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    playbackLocks.set(channel, pending);
    try {
        return await pending;
    } finally {
        if (playbackLocks.get(channel) === pending) playbackLocks.delete(channel);
    }
}

function playbackIdFor(channel, item) {
    if (!item) {
        playbackByChannel.delete(channel);
        return null;
    }
    const signature = JSON.stringify([
        item.id, item.url || item.media, item.song_name || item.title,
        item.username, item.platform || item.Platform
    ]);
    let playback = playbackByChannel.get(channel);
    if (!playback || playback.signature !== signature) {
        playback = { signature, id: randomUUID() };
        playbackByChannel.set(channel, playback);
    }
    return playback.id;
}

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


// ── Middleware ────────────────────────────────────────────────────────────────

// The static server decodes URLs. Normalize the path here too, so encoded
// directory names cannot expose private config or persistent session records.
app.use((req, res, next) => {
    let pathname;
    try { pathname = path.posix.normalize('/' + decodeURIComponent(req.path)).toLowerCase(); }
    catch { return res.status(400).end(); }
    if (['/conf', '/.env', '/data'].some(root => pathname === root || pathname.startsWith(root + '/')))
        return res.status(403).end();
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
    name:              SESSION_COOKIE_NAME,
    secret:            sessionSecret,
    store:             sessionStore,
    resave:            false,
    saveUninitialized: false,
    rolling:           true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: REMEMBER_LOGIN_MS }
}));

app.use(express.static(path.join(__dirname, '../..')));

// Suppress favicon 404
app.get('/favicon.ico', (_req, res) => res.status(204).end());

function requireAuth(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in.' });
    let accounts;
    try { accounts = loadAccounts(); }
    catch { return res.status(503).json({ error: 'Cannot read accounts.' }); }
    const account = accounts.find(a => a.username === req.session.user.username);
    if (!account || req.session.authVersion !== authenticationVersion(account)) {
        return req.session.destroy(() => {
            clearLoginCookie(req, res);
            res.status(401).json({ error: 'Please sign in again.' });
        });
    }
    req.session.user = sessionUser(account, accounts);
    next();
}

function authenticationVersion(account) {
    return createHmac('sha256', sessionSecret).update(JSON.stringify([account.username, account.password])).digest('hex');
}

function sessionUser(account, accounts) {
    return { username: account.username, channel: account.channel || account.username.toLowerCase(),
        access_accounts: getViewersForAccount(accounts, account) };
}

function clearLoginCookie(req, res) {
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure: req.secure });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
    const { username, password, rememberMe = true } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials.' });
    if (typeof rememberMe !== 'boolean') return res.status(400).json({ error: 'rememberMe must be a boolean.' });

    let accounts;
    try { accounts = loadAccounts(); }
    catch { return res.status(500).json({ error: 'Cannot read accounts.' }); }

    const account = accounts.find(a => a.username === username && a.password === password);
    if (!account) return res.status(401).json({ error: 'Invalid username or password.' });

    req.session.regenerate(err => {
        if (err) return res.status(500).json({ error: 'Session error.' });
        req.session.user = sessionUser(account, accounts);
        req.session.authVersion = authenticationVersion(account);
        req.session.cookie.maxAge = rememberMe ? REMEMBER_LOGIN_MS : null;
        req.session.save(err => {
            if (err) return res.status(500).json({ error: 'Could not save login session.' });
            res.json({ success: true, user: req.session.user });
        });
    });
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: 'Could not log out.' });
        clearLoginCookie(req, res);
        res.json({ success: true });
    });
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
        res.json({ ...data, media: cleaned.map(item => decorateOwnerSong(req.params.owner, item)) });
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
        if (req.params.index === '0') {
            playbackByChannel.delete(req.params.owner);
            personalListWaitByChannel.delete(req.params.owner);
            promotedMyListByChannel.delete(req.params.owner);
        }
        io.to(`ch:${req.params.owner}`).emit('queue:update', { channel: req.params.owner });
        res.json(data);
    } catch {
        res.status(502).json({ error: 'Could not reach api.bastiwood.com' });
    }
});

// Push an OWNER song to the FRONT of the Basti queue (used when a My List song
// becomes current). Calls Basti's /setmediatop route, which mirrors /setmedia
// but inserts at index 0. The owner marker is the username (US<channel>); Basti
// also tags it owner_song: true. Send our title, especially for uploaded files.
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
    const metadata = new URLSearchParams();
    if (item.title || item.song_name) metadata.set('song_name', item.title || item.song_name);
    if (item.platform) metadata.set('platform', item.platform);
    return bastiPost(`/setmediatop/${encodeURIComponent(channel)}/${encodeURIComponent(user)}/${encodedMedia}?${metadata}`);
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

    const rawUrl = url.trim();
    const added = [];
    const now = new Date().toISOString();
    const playlistId = parseYouTubePlaylistId(rawUrl);
    if (playlistId) {
        try {
            const job = playlistImporter.start(req.params.owner, { url: rawUrl });
            return res.status(202).json({ success: true, job });
        } catch (err) {
            return res.status(err.status || 500).json({ error: err.message });
        }
    }
    const videoId = parseYouTubeVideoId(rawUrl);
    if (videoId) {
        const title = await resolveYouTubeVideoTitle(videoId) || `YouTube video (${videoId})`;
        added.push({ url: rawUrl, title, platform: 'youtube', addedAt: now });
    } else if (rawUrl.includes('spotify.com')) {
        added.push({ url: rawUrl, title: 'Spotify Track', platform: 'spotify', addedAt: now });
    } else {
        added.push({ url: rawUrl, title: rawUrl, platform: 'other', addedAt: now });
    }
    const data = loadChannelMyList(req.params.owner);
    data.items.push(...added);
    saveChannelMyList(req.params.owner, data);
    res.json({ success: true, added, total: data.items.length });
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

app.post('/api/mylist/:owner/shuffle', requireAuth, (req, res) => {
    const channel = req.params.owner;
    if (!hasAccess(req.session.user, channel))
        return res.status(403).json({ error: 'Access denied.' });

    const data = loadChannelMyList(channel);
    // Fisher-Yates gives every ordering the same chance and keeps duplicates.
    const next = data.items.filter(item => item._playNext);
    const shuffled = data.items.filter(item => !item._playNext);
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    data.items = [...next, ...shuffled];
    saveChannelMyList(channel, data);
    io.to(`ch:${channel}`).emit('queue:update', { channel });
    res.json({ success: true, items: data.items });
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
    const { mode, mylistLoop } = req.body;
    const valid = ['requests', 'mylist', 'switch'];
    if (mode !== undefined && !valid.includes(mode))
        return res.status(400).json({ error: 'Invalid mode.' });
    if (mylistLoop !== undefined && typeof mylistLoop !== 'boolean')
        return res.status(400).json({ error: 'mylistLoop must be a boolean.' });
    if (mode === undefined && mylistLoop === undefined)
        return res.status(400).json({ error: 'A mode or mylistLoop setting is required.' });
    const data = loadChannelMode(req.params.channel);
    if (mode !== undefined) {
        data.mode = mode;
        if (mode === 'switch') data.switchTurn = 'requests';
    }
    if (mylistLoop !== undefined && mylistLoop !== data.mylistLoop) {
        data.mylistLoop = mylistLoop;
        // Toggling during a song also applies to that song. Retain it when
        // enabling loop, and avoid one extra replay when disabling loop.
        const playing = promotedMyListByChannel.get(req.params.channel);
        const list = getMyList(req.params.channel);
        const index = playing ? list.indexOf(playing) : -1;
        if (mylistLoop && playing && !playing._playNext && !retiredMyListSongs.has(playing) && index === -1) list.push(playing);
        if (!mylistLoop && index !== -1) list.splice(index, 1);
        saveChannelMyList(req.params.channel, { items: list });
    }
    saveChannelMode(req.params.channel, data);
    io.to(`ch:${req.params.channel}`).emit('queue:update', { channel: req.params.channel });
    res.json({ success: true, ...data });
});

// Promote once under the channel playback lock. Looping rotates the item to
// the tail, so the displayed list always shows the upcoming playback order.
async function promoteMyListHeadToBasti(ch) {
    const listData = loadChannelMyList(ch);
    if (listData.items.length === 0) return false;
    const head = listData.items[0];

    try {
        await pushOwnerSongToBasti(ch, head);
        promotedMyListByChannel.set(ch, head);
        // A user may remove, clear or shuffle the list during the upstream
        // request. Find this exact entry again; never restore a deleted song.
        const current = loadChannelMyList(ch);
        const index = current.items.indexOf(head);
        if (index !== -1) {
            current.items.splice(index, 1);
            if (loadChannelMode(ch).mylistLoop && !head._playNext) current.items.push(head);
            saveChannelMyList(ch, current);
        }
        playbackByChannel.delete(ch);
        io.to(`ch:${ch}`).emit('queue:update', { channel: ch });
        return true;
    } catch (e) {
        console.error(`Failed to push owner song to Basti for ${ch}:`, e.message || e);
        // Keep the list unchanged when promotion fails.
        return false;
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

const ytAudioCache = new Map(); // videoId -> { source: { url, headers }, expires }
const ytAudioPending = new Map();
const YT_AUDIO_TTL_MS = 90 * 60 * 1000; // 90 min — comfortably inside the signed-URL lifetime

// Target loudness for all normalised playback (YouTube proxy + local uploads).
// -14 LUFS matches the common streaming-platform target (Spotify/YouTube/Apple
// Music), so songs from different sources end up at a consistent volume.
const LOUDNORM_FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11';

function resolveYouTubeAudioSource(videoId) {
    if (ytAudioPending.has(videoId)) return ytAudioPending.get(videoId);
    const pending = new Promise((resolve, reject) => {
        // Modern YouTube extraction needs an enabled JS runtime. Keep yt-dlp's
        // HTTP headers with the signed URL so ffmpeg uses the same request context.
        execFile(
            'yt-dlp',
            [
                '--ignore-config',
                '--js-runtimes', 'node',
                '-f', 'bestaudio/best',
                '--dump-single-json',
                '--skip-download',
                '--no-playlist',
                '--no-warnings',
                '--',
                `https://www.youtube.com/watch?v=${videoId}`
            ],
            { timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    return reject(Object.assign(new Error(String(stderr || err.message).trim()), { code: err.code }));
                }
                try {
                    const data = JSON.parse(String(stdout));
                    const selected = data.requested_downloads?.[0] || data;
                    const url = selected.url || data.url;
                    if (!url || !['https:', 'http:'].includes(new URL(url).protocol))
                        throw new Error('yt-dlp returned no usable audio URL.');
                    const headers = {};
                    for (const [name, value] of Object.entries(selected.http_headers || data.http_headers || {})) {
                        if (/^(user-agent|referer|origin|accept)$/i.test(name)
                            && typeof value === 'string' && !/[\r\n]/.test(value)) headers[name] = value;
                    }
                    resolve({ url, headers });
                } catch (err) {
                    reject(new Error(`Could not read yt-dlp audio metadata: ${err.message}`));
                }
            }
        );
    });
    ytAudioPending.set(videoId, pending);
    pending.finally(() => ytAudioPending.delete(videoId)).catch(() => {});
    return pending;
}

// GET a same-origin, loudness-normalised audio stream for a YouTube video id.
// No auth: the overlay (OBS browser source / background tab) has no session,
// same as the other /api/channels endpoints.
app.get('/api/yt-audio/:videoId', async (req, res) => {
    const videoId = String(req.params.videoId || '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'Invalid video id.' });
    }

    let source;
    const cached = ytAudioCache.get(videoId);
    if (cached && cached.expires > Date.now()) {
        source = cached.source;
    } else {
        try {
            source = await resolveYouTubeAudioSource(videoId);
            ytAudioCache.set(videoId, { source, expires: Date.now() + YT_AUDIO_TTL_MS });
        } catch (e) {
            console.error(`yt-dlp failed for ${videoId}:`, e.message || e);
            return res.status(502).json({
                error: e.code === 'ENOENT' ? 'yt-dlp is not installed on the server.' : 'Could not resolve YouTube audio.',
                code: e.code === 'ENOENT' ? 'YTDLP_MISSING' : 'YOUTUBE_RESOLVE_FAILED'
            });
        }
    }

    if (!res.destroyed) streamNormalizedAudio(source, res, videoId, () => ytAudioCache.delete(videoId));
});

// Transcodes a (possibly remote) audio source through ffmpeg with loudness
// normalisation and streams the result to the client same-origin. `res` must
// not have been responded to yet.
function streamNormalizedAudio(source, res, label, onFailure = () => {}) {
    const headers = Object.entries(source.headers || {}).map(([name, value]) => `${name}: ${value}\r\n`).join('');
    const ff = spawn('ffmpeg', [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        ...(headers ? ['-headers', headers] : []),
        '-i', source.url,
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

    res.setHeader('Cache-Control', 'no-store');

    ff.stdout.once('data', () => {
        sentData = true;
        res.setHeader('Content-Type', 'audio/mpeg');
    });
    // A failed/empty ffmpeg stdout must not end the response with a fake 200
    // before its close event can send a useful JSON 502.
    ff.stdout.pipe(res, { end: false });

    ff.on('error', err => {
        console.error(`ffmpeg failed to start for ${label}:`, err.message || err);
        onFailure();
        if (!res.headersSent) res.status(502).json({ error: 'Audio transcode failed.', code: 'AUDIO_TRANSCODE_FAILED' });
        else if (!res.writableEnded) res.destroy();
    });

    ff.on('close', code => {
        if (res.destroyed) return;
        if (code !== 0 && sentData) {
            onFailure();
            // Truncating a stream is a network failure, not a completed song.
            res.destroy();
            return;
        }
        if (!sentData) {
            console.error(`ffmpeg exited ${code} for ${label}:`, stderrTail.trim());
            onFailure();
            if (!res.headersSent) res.status(502).json({ error: 'No playable audio was produced.', code: 'AUDIO_TRANSCODE_FAILED' });
        }
        if (!res.writableEnded) res.end();
    });

    // Client changed/skipped tracks — stop transcoding immediately.
    res.on('close', () => {
        if (!ff.killed) ff.kill('SIGKILL');
    });
}

// ── Overlay endpoints (no auth — used by OBS browser source) ─────────────────

app.get('/api/channels/:ch/audio-settings', (req, res) => {
    res.json({ settings: audioSettings.get(req.params.ch) });
});

app.post('/api/channels/:ch/audio-settings', requireAuth, (req, res) => {
    const channel = req.params.ch;
    if (!hasAccess(req.session.user, channel))
        return res.status(403).json({ error: 'Access denied.' });
    try {
        const settings = audioSettings.update(channel, req.body);
        io.to(`ch:${channel}`).emit('audio:settings', { channel, settings });
        res.json({ success: true, settings });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not save audio settings.' });
    }
});

// Get the current (first) item — respects play mode.
// For 'mylist'/'switch' sources, owner songs are routed THROUGH the Basti queue
// (front row) so they appear in the top slot for the Twitch bot. We push the
// head My List item to Basti, then always read the current item from Basti.
app.get('/api/channels/:ch/current', async (req, res) => {
    const ch = req.params.ch;
    return withPlaybackLock(ch, async () => {
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
            if (!topIsOwner) promotedMyListByChannel.delete(ch);

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
            const waitingFor = personalListWaitByChannel.get(ch);
            const waitingForCurrent = waitingFor && waitingFor === songIdentity(media[0]);
            if (!waitingForCurrent) personalListWaitByChannel.delete(ch);
            const playNext = getMyList(ch)[0]?._playNext === true;
            const wantMyList =
                !waitingForCurrent && !topIsOwner && hasMyListSong &&
                (playNext || effectiveSource === 'mylist' || !hasViewerSong);

            if (wantMyList) {
                const pushed = await promoteMyListHeadToBasti(ch);
                if (pushed) {
                    const data = await bastiGet(`/getallmedia/${ch}`);
                    media = Array.isArray(data.media) ? data.media : [];
                }
            }

            const current = media[0]
                ? { ...decorateOwnerSong(ch, media[0]), _source: isOwnerSong(media[0], ch) ? 'mylist' : 'requests' }
                : null;
            const playbackId = playbackIdFor(ch, current);
            if (current) current._playbackId = playbackId;
            res.json({ current });
        } catch (e) {
            console.error('current failed:', e.message || e);
            res.status(502).json({ error: 'Could not reach api.bastiwood.com' });
        }
    });
});

// Advance the queue (video ended in overlay).
// Everything (owner songs included) now lives in the Basti queue, so advancing
// is simply removing index 0 from Basti. In 'switch' mode we flip whose turn is
// next so the following /current call promotes a My List song (or not).
app.post('/api/channels/:ch/next', async (req, res) => {
    const ch = req.params.ch;
    return withPlaybackLock(ch, async () => {
        const modeData = loadChannelMode(ch);
        const { mode } = modeData;

        try {
            // Multiple overlays can report the same finish. Old reports must not
            // remove a newly promoted item (especially a one-song loop).
            if (req.body.playbackId && req.body.playbackId !== playbackByChannel.get(ch)?.id)
                return res.json({ success: true, advanced: false });
            await bastiPost(`/removemedia/${ch}/0`);
            personalListWaitByChannel.delete(ch);
            playbackByChannel.delete(ch);
            promotedMyListByChannel.delete(ch);
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

// ── Local music: saved YouTube playlists and uploaded MP3s ───────────────────

function songIdentity(item) {
    return item ? JSON.stringify([item.id || null, item.media || item.url, item.username]) : null;
}

function decorateOwnerSong(channel, item) {
    const playing = promotedMyListByChannel.get(channel);
    if (!playing || !isOwnerSong(item, channel)) return item;
    const sameMedia = (parseYouTubeVideoId(playing.url) && parseYouTubeVideoId(playing.url) === parseYouTubeVideoId(item.media || item.url))
        || playing.url === (item.media || item.url);
    return sameMedia ? { ...item, song_name: playing.title, title: playing.title, Platform: playing.platform } : item;
}

async function loadSavedPlaylist(channel, playlist, cancelled = () => false, save = false) {
    return withPlaybackLock(channel, async () => {
        const upstream = await bastiGet(`/getallmedia/${encodeURIComponent(channel)}`);
        if (cancelled()) return false;
        const playing = promotedMyListByChannel.get(channel);
        if (save) musicLibrary.saveAndLoad(channel, playlist);
        else saveChannelMyList(channel, { items: playlist.items });
        // The new playlist owns the complete upcoming list, including old
        // loop entries and one-off uploads. Let the current song finish first.
        if (playing) retiredMyListSongs.add(playing);
        const current = songIdentity(upstream.media?.[0]);
        if (current) personalListWaitByChannel.set(channel, current);
        else personalListWaitByChannel.delete(channel);
        const mode = loadChannelMode(channel);
        mode.mode = 'mylist';
        saveChannelMode(channel, mode);
        io.to(`ch:${channel}`).emit('queue:update', { channel });
        return true;
    });
}

const playlistImporter = createPlaylistImporter({
    spawn,
    onSave: (channel, playlist, cancelled) => loadSavedPlaylist(channel, playlist, cancelled, true),
    onChange: (channel, job) => io.to(`ch:${channel}`).emit('local:import:update', { channel, job })
});

app.post('/api/local/:channel/playlist-import', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    try {
        const job = playlistImporter.start(req.params.channel, req.body);
        res.status(202).json({ success: true, job });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

app.get('/api/local/:channel/playlist-import', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    res.json({ job: playlistImporter.status(req.params.channel) });
});

app.delete('/api/local/:channel/playlist-import/:id', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    try {
        res.json({ success: true, job: playlistImporter.cancel(req.params.channel, req.params.id) });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

app.get('/api/local/:channel/playlists', requireAuth, (req, res) => {
    if (!hasAccess(req.session.user, req.params.channel))
        return res.status(403).json({ error: 'Access denied.' });
    res.json({ playlists: musicLibrary.playlists(req.params.channel) });
});

app.post('/api/local/:channel/playlists/:id/load', requireAuth, async (req, res) => {
    const channel = req.params.channel;
    if (!hasAccess(req.session.user, channel))
        return res.status(403).json({ error: 'Access denied.' });
    const playlist = musicLibrary.playlist(channel, req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Saved playlist not found.' });
    try {
        await loadSavedPlaylist(channel, playlist);
        res.json({ success: true, total: playlist.items.length });
    } catch {
        res.status(502).json({ error: 'Could not load the playlist. Your music list was kept.' });
    }
});

app.delete('/api/local/:channel/playlists/:id', requireAuth, (req, res) => {
    const channel = req.params.channel;
    if (!hasAccess(req.session.user, channel))
        return res.status(403).json({ error: 'Access denied.' });
    if (!musicLibrary.removePlaylist(channel, req.params.id))
        return res.status(404).json({ error: 'Saved playlist not found.' });
    io.to(`ch:${channel}`).emit('local:library:update', { channel });
    res.json({ success: true });
});

function localFileEntry(channel, folder, name) {
    const parts = [channel, ...(folder ? [folder] : []), name];
    return { url: `/api/local-media/${parts.map(encodeURIComponent).join('/')}`,
        title: name, platform: 'local', addedAt: new Date().toISOString() };
}

async function queueLocalEntries(channel, entries, playNext) {
    return withPlaybackLock(channel, async () => {
        if (playNext) {
            const upstream = await bastiGet(`/getallmedia/${encodeURIComponent(channel)}`);
            const current = songIdentity(upstream.media?.[0]);
            if (current) personalListWaitByChannel.set(channel, current);
        }
        const data = loadChannelMyList(channel);
        if (playNext) data.items.unshift(...entries.map(entry => ({ ...entry, _playNext: true })));
        else data.items.push(...entries);
        saveChannelMyList(channel, data);
        io.to(`ch:${channel}`).emit('queue:update', { channel });
        return data.items.length;
    });
}

// A single saved MP3 goes next, even in Requests mode. Folder adds append.
app.post('/api/local/:channel/queue', requireAuth, async (req, res) => {
    const channel = req.params.channel;
    if (!hasAccess(req.session.user, channel))
        return res.status(403).json({ error: 'Access denied.' });
    const { folder = '', filename } = req.body;
    if (typeof folder !== 'string' || sanitisePath(folder) !== folder
        || (filename !== undefined && (typeof filename !== 'string' || !filename
            || sanitisePath(filename) !== filename || !filename.toLowerCase().endsWith('.mp3'))))
        return res.status(400).json({ error: 'Invalid folder or MP3 filename.' });
    try {
        let files = await listLocalFiles(channel, folder);
        if (filename !== undefined) files = files.filter(file => file.folder === folder && file.name === filename);
        if (files.length === 0) return res.status(404).json({ error: 'No MP3 files found.' });
        const entries = files.map(file => localFileEntry(channel, file.folder, file.name));
        const total = await queueLocalEntries(channel, entries, filename !== undefined);
        res.json({ success: true, added: files.length, total, playNext: filename !== undefined });
    } catch {
        res.status(502).json({ error: 'Could not queue the files. Please try again.' });
    }
});

function localMediaDir(channel, folder = '') {
    const dir = path.join(LOCAL_MEDIA_ROOT, sanitisePath(channel), sanitisePath(folder));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function sanitisePath(segment) {
    // Strip anything that isn't a safe filename character; collapse dots & slashes.
    // Returns '' for empty/blank input — callers must handle empty segments
    // (e.g. path.join already ignores empty strings).
    return String(segment || '')
        .replace(/\.\./g, '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/^\.+/, '')
        .trim();
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
            const ext = path.extname(file.originalname);
            const base = sanitisePath(path.basename(file.originalname, ext)) || 'Audio';
            const dir = localMediaDir(req.params.channel, req.params.folder || '');
            let filename = `${base}.mp3`;
            let suffix = 2;
            while (true) {
                try {
                    // Reserve the name before Multer opens its write stream.
                    // Equal filenames in a batch must not overwrite each other.
                    fs.closeSync(fs.openSync(path.join(dir, filename), 'wx'));
                    return cb(null, filename);
                } catch (err) {
                    if (err.code !== 'EEXIST') return cb(err);
                    filename = `${base} (${suffix++}).mp3`;
                }
            }
        }
    }),
    fileFilter(req, file, cb) {
        // Browser multipart filenames are UTF-8; Busboy's legacy default is
        // Latin-1. Recover their original spelling before saving or reporting.
        const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
        if (!decoded.includes('\uFFFD')) file.originalname = decoded;
        const ext = path.extname(file.originalname).toLowerCase();
        const mime = (file.mimetype || '').toLowerCase();
        // Accept .mp3 extension OR any common MP3 MIME type (browsers/OSes vary).
        const validMime = ['audio/mpeg', 'audio/mp3', 'audio/x-mp3', 'audio/mpeg3', 'audio/x-mpeg'].includes(mime);
        if (ext !== '.mp3' && !validMime) {
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
        const folders = entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
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
            if (e.isDirectory() && !e.name.startsWith('.')) {
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

// Uploads are saved and inserted immediately after the currently playing song.
app.post('/api/local/:channel/upload', requireAuth, uploadLocalFilesEndpoint);
app.post('/api/local/:channel/upload/:folder', requireAuth, uploadLocalFilesEndpoint);

function uploadLocalFilesEndpoint(req, res) {
    const channel = req.params.channel;
    if (!hasAccess(req.session.user, channel))
        return res.status(403).json({ error: 'Access denied.' });
    const folder = req.params.folder || '';
    if (sanitisePath(folder) !== folder)
        return res.status(400).json({ error: 'Invalid folder.' });
    localUpload.array('files', 20)(req, res, async err => {
        if (err) return res.status(400).json({ error: String(err.message || err) });
        const files = req.files || [];
        if (!files.length) return res.status(400).json({ error: 'Select an MP3 file to upload.' });
        const saved = [];
        const warnings = [];
        for (const file of files) {
            try {
                await normalizeAudioFile(file.path);
                saved.push(localFileEntry(channel, folder, file.filename));
            } catch {
                fs.rmSync(file.path, { force: true });
                warnings.push(`${file.originalname} could not be read as audio.`);
            }
        }
        if (!saved.length) return res.status(422).json({ error: warnings.join(' ') });
        io.to(`ch:${channel}`).emit('local:library:update', { channel });
        try {
            await queueLocalEntries(channel, saved, true);
            res.json({ success: true, uploaded: saved.length, queued: saved.length, warnings });
        } catch {
            res.status(502).json({ error: 'Files were saved, but could not be queued. Use Play next to try again.', uploaded: saved.length });
        }
    });
}

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

    return withPlaybackLock(ch, async () => {
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

            const entry = { url: mediaUrl, title: filename, platform: 'local', _playNext: true };

            // Remove the currently-playing item first so the new one plays immediately.
            try { await bastiPost(`/removemedia/${encodeURIComponent(ch)}/0`); } catch {}

            // Push the local song to the front of Basti.
            await pushOwnerSongToBasti(ch, entry);
            playbackByChannel.delete(ch);
            promotedMyListByChannel.set(ch, entry);
            personalListWaitByChannel.delete(ch);

            io.to(`ch:${ch}`).emit('queue:update', { channel: ch });
            res.json({ success: true, url: mediaUrl });
        } catch (e) {
            console.error('playLocalFileNow failed:', e.message || e);
            res.status(500).json({ error: 'Could not play file.' });
        }
    });
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
