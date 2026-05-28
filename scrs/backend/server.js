'use strict';
require('dotenv').config();

const express  = require('express');
const session  = require('express-session');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
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

// GET all media for an owner (dashboard)
app.get('/api/media/:owner', requireAuth, async (req, res) => {
    if (!hasAccess(req.session.user, req.params.owner))
        return res.status(403).json({ error: 'Access denied.' });
    try {
        const data = await bastiGet(`/getallmedia/${req.params.owner}`);
        res.json(data);
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

// ── Overlay endpoints (no auth — used by OBS browser source) ─────────────────

// Get the current (first) item
app.get('/api/channels/:ch/current', async (req, res) => {
    try {
        const data = await bastiGet(`/getallmedia/${req.params.ch}`);
        const media = Array.isArray(data.media) ? data.media : [];
        res.json({ current: media[0] ?? null });
    } catch {
        res.status(502).json({ error: 'Could not reach api.bastiwood.com' });
    }
});

// Advance the queue (video ended in overlay)
app.post('/api/channels/:ch/next', async (req, res) => {
    try {
        await bastiPost(`/removemedia/${req.params.ch}/0`);
        io.to(`ch:${req.params.ch}`).emit('queue:update', { channel: req.params.ch });
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
