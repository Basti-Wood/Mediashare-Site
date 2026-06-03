'use strict';

// Surface ANY uncaught error loudly so we can diagnose the vanishing selector.
window.addEventListener('error', e => {
    console.error('[main.js uncaught]', e.message, 'at', e.filename + ':' + e.lineno);
});
window.addEventListener('unhandledrejection', e => {
    console.error('[main.js unhandled promise]', e.reason);
});

let currentChannel = null;
let socket         = null;
let user           = null;
let activeQueueTab = 'requests';

// ── DOM refs ──────────────────────────────────────────────────────────────────

const navUser         = document.getElementById('nav-user');
const logoutBtn       = document.getElementById('logout-btn');
const tabList         = document.getElementById('channel-tab-list');
const previewFrame    = document.getElementById('preview-frame');
const overlayUrl      = document.getElementById('overlay-url');
const nowPlaying      = document.getElementById('now-playing-info');
const skipCurrentBtn  = document.getElementById('skip-current-btn');
const queueCount      = document.getElementById('queue-count');
const queueEmpty      = document.getElementById('queue-empty');
const queueTable      = document.getElementById('queue-table');
const queueTbody      = document.getElementById('queue-tbody');

// My List DOM refs
const queueTypeTabs   = document.getElementById('queue-type-tabs');
const panelRequests   = document.getElementById('panel-requests');
const panelMylist     = document.getElementById('panel-mylist');
const mylistUrlInput  = document.getElementById('mylist-url-input');
const mylistAddBtn    = document.getElementById('mylist-add-btn');
const mylistAddStatus = document.getElementById('mylist-add-status');
const mylistCount     = document.getElementById('mylist-count');
const mylistEmpty     = document.getElementById('mylist-empty');
const mylistTable     = document.getElementById('mylist-table');
const mylistTbody     = document.getElementById('mylist-tbody');

// Mode selector
const modeSelect      = document.getElementById('mode-select');

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function platformTag(p) {
    const map = { youtube: 'is-danger', spotify: 'is-success' };
    const cls = map[(p || '').toLowerCase()] || 'is-dark';
    return `<span class="tag ${cls} is-small">${esc(p)}</span>`;
}

function getMediaUrl(item) {
    return String(item?.media || item?.url || '').trim();
}

function getYouTubeId(url) {
    if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
    const m = url.match(
        /(?:youtube\.com\/(?:watch\?.*?v=|shorts\/|embed\/|v\/|e\/)|youtu\.be\/)([^"&?/\s]{11})/
    );
    return m ? m[1] : null;
}

function getThumbnailHtml(item) {
    const url = getMediaUrl(item);
    const ytId = getYouTubeId(url);
    if (!ytId) return '<span class="media-thumb media-thumb-placeholder" aria-hidden="true"></span>';
    const thumbUrl = `https://i.ytimg.com/vi/${ytId}/mqdefault.jpg`;
    return `<img class="media-thumb" src="${esc(thumbUrl)}" alt="thumbnail" loading="lazy">`;
}

function renderTitle(item) {
    const title = esc(item?.song_name || item?.title || 'Unknown Title');
    const url = getMediaUrl(item);
    if (!url) return `<span class="media-link">${title}</span>`;
    return `<a class="media-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="Open media link">${title}</a>`;
}

// ── Play mode ────────────────────────────────────────────────────────────────────

async function loadMode() {
    if (!currentChannel) return;
    try {
        const res  = await fetch(`/api/mode/${encodeURIComponent(currentChannel)}`);
        if (!res.ok) return;
        const data = await res.json();
        modeSelect.value = data.mode || 'requests';
    } catch {}
}

modeSelect.addEventListener('change', async () => {
    if (!currentChannel) return;
    try {
        await fetch(`/api/mode/${encodeURIComponent(currentChannel)}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ mode: modeSelect.value })
        });
    } catch (e) {
        console.error('Failed to set mode', e);
    }
});

// ── My List helpers ──────────────────────────────────────────────────────────

function getMylistThumbnailHtml(item) {
    const ytId = getYouTubeId(item.url || '');
    if (!ytId) return '<span class="media-thumb media-thumb-placeholder" aria-hidden="true"></span>';
    return `<img class="media-thumb" src="https://i.ytimg.com/vi/${esc(ytId)}/mqdefault.jpg" alt="thumbnail" loading="lazy">`;
}

function renderMylistTitle(item) {
    const title = esc(item?.title || 'Unknown Title');
    const url   = item?.url || '';
    if (!url) return `<span class="media-link">${title}</span>`;
    return `<a class="media-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`;
}

function mylistPlatformTag(platform) {
    const map = { youtube: 'is-danger', 'youtube-playlist': 'is-warning', spotify: 'is-success' };
    const cls = map[platform] || 'is-dark';
    const label = platform === 'youtube-playlist' ? 'playlist' : (platform || 'other');
    return `<span class="tag ${cls} is-small">${esc(label)}</span>`;
}

function renderMyList(items) {
    mylistCount.textContent = items.length;
    if (items.length === 0) {
        mylistEmpty.style.display = '';
        mylistTable.style.display = 'none';
        return;
    }
    mylistEmpty.style.display = 'none';
    mylistTable.style.display = '';
    mylistTbody.innerHTML = items.map((item, i) => `
        <tr>
            <td>${i + 1}</td>
            <td>${getMylistThumbnailHtml(item)}</td>
            <td>${mylistPlatformTag(item.platform)}</td>
            <td class="queue-title">${renderMylistTitle(item)}</td>
            <td>
                <button class="button is-danger is-small"
                        data-ml-index="${i}" title="Remove">✕</button>
            </td>
        </tr>
    `).join('');
    mylistTbody.querySelectorAll('button[data-ml-index]').forEach(btn => {
        btn.addEventListener('click', () => removeFromMyList(Number(btn.dataset.mlIndex)));
    });
}

// ── My List API ───────────────────────────────────────────────────────────────

async function loadMyList() {
    if (!currentChannel) return;
    try {
        const res  = await fetch(`/api/mylist/${encodeURIComponent(currentChannel)}`);
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        renderMyList(Array.isArray(data.items) ? data.items : []);
    } catch (e) {
        console.error('Failed to load my list', e);
    }
}

async function addToMyList(url) {
    if (!url.trim()) return;
    mylistAddBtn.disabled = true;
    mylistAddStatus.className = 'is-size-7 mb-3 has-text-grey';
    mylistAddStatus.textContent = 'Adding…';
    try {
        const res  = await fetch(`/api/mylist/${encodeURIComponent(currentChannel)}/add`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ url: url.trim() })
        });
        const data = await res.json();
        if (!res.ok) {
            mylistAddStatus.className = 'is-size-7 mb-3 has-text-danger';
            mylistAddStatus.textContent = data.error || 'Failed to add.';
        } else {
            const n = data.added?.length ?? 1;
            if (data.warning) {
                mylistAddStatus.className = 'is-size-7 mb-3 has-text-warning';
                mylistAddStatus.textContent = `Added ${n} song${n !== 1 ? 's' : ''}. ${data.warning}`;
            } else {
                mylistAddStatus.className = 'is-size-7 mb-3 has-text-success';
                mylistAddStatus.textContent = `Added ${n} song${n !== 1 ? 's' : ''}.`;
            }
            mylistUrlInput.value = '';
            await loadMyList();
        }
    } catch {
        mylistAddStatus.className = 'is-size-7 mb-3 has-text-danger';
        mylistAddStatus.textContent = 'Network error.';
    } finally {
        mylistAddBtn.disabled = false;
    }
}

async function removeFromMyList(index) {
    try {
        await fetch(`/api/mylist/${encodeURIComponent(currentChannel)}/remove/${index}`,
                    { method: 'POST' });
        await loadMyList();
    } catch (e) {
        console.error('Failed to remove from my list', e);
    }
}

// ── Queue-type tab switching ──────────────────────────────────────────────────

function setupQueueTypeTabs() {
    queueTypeTabs.querySelectorAll('li[data-tab]').forEach(li => {
        li.addEventListener('click', () => {
            activeQueueTab = li.dataset.tab;
            queueTypeTabs.querySelectorAll('li').forEach(t =>
                t.classList.toggle('is-active', t === li));
            panelRequests.style.display = activeQueueTab === 'requests' ? '' : 'none';
            panelMylist.style.display   = activeQueueTab === 'mylist'   ? '' : 'none';
            if (activeQueueTab === 'mylist') loadMyList();
        });
    });

    mylistAddBtn.addEventListener('click', () => addToMyList(mylistUrlInput.value));
    mylistUrlInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') addToMyList(mylistUrlInput.value);
    });
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderMedia(media) {
    // media[0] = now playing, media[1..] = upcoming
    const current  = media[0] ?? null;
    const upcoming = media.slice(1);

    // Now playing
    if (current) {
        // My List items use .title/.platform; viewer items use .song_name/.Platform.
        const by = current.username ? `by ${esc(current.username)}` : '';
        nowPlaying.innerHTML = `
            <div class="now-playing-card">
                ${getThumbnailHtml(current)}
                ${platformTag(current.Platform || current.platform)}
                <span class="now-playing-title">${renderTitle(current)}</span>
                <span class="now-playing-user">${by}</span>
                <button class="button is-danger is-small ml-auto skip-btn" title="Skip">✕ Skip</button>
            </div>`;
        const skipBtn = nowPlaying.querySelector('.skip-btn');
        if (skipBtn) skipBtn.addEventListener('click', () => removeMedia(0));
    } else {
        nowPlaying.innerHTML = '<span class="has-text-grey">Nothing playing.</span>';
    }

    // Upcoming queue
    queueCount.textContent = upcoming.length;

    if (upcoming.length === 0) {
        queueEmpty.style.display = '';
        queueTable.style.display = 'none';
        return;
    }

    queueEmpty.style.display = 'none';
    queueTable.style.display = '';

    queueTbody.innerHTML = upcoming.map((item, i) => `
        <tr>
            <td>${i + 1}</td>
            <td>${getThumbnailHtml(item)}</td>
            <td>${platformTag(item.Platform)}</td>
            <td class="queue-title">${renderTitle(item)}</td>
            <td>${esc(item.username)}</td>
            <td>
                <button class="button is-danger is-small"
                        data-index="${i + 1}" title="Remove">✕</button>
            </td>
        </tr>
    `).join('');

    queueTbody.querySelectorAll('button[data-index]').forEach(btn => {
        btn.addEventListener('click', () => removeMedia(Number(btn.dataset.index)));
    });
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function loadMedia() {
    if (!currentChannel) return;
    try {
        const res  = await fetch(`/api/media/${encodeURIComponent(currentChannel)}`);
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        renderMedia(Array.isArray(data.media) ? data.media : []);
    } catch (e) {
        console.error('Failed to load media', e);
    }
}

async function removeMedia(index) {
    try {
        await fetch(`/api/media/${encodeURIComponent(currentChannel)}/remove/${index}`,
                    { method: 'POST' });
        // Socket.io will trigger loadMedia() via queue:update
    } catch (e) {
        console.error('Failed to remove media', e);
    }
}

// Skip the currently-playing song: advance the overlay queue (removes index 0
// from Basti and moves to the next item, owner songs included).
async function skipCurrent() {
    if (!currentChannel) return;
    skipCurrentBtn.disabled = true;
    try {
        await fetch(`/api/channels/${encodeURIComponent(currentChannel)}/next`,
                    { method: 'POST' });
        // queue:update via socket.io refreshes the dashboard + overlay.
    } catch (e) {
        console.error('Failed to skip current song', e);
    } finally {
        skipCurrentBtn.disabled = false;
    }
}

if (skipCurrentBtn) skipCurrentBtn.addEventListener('click', skipCurrent);

// ── Channel switching ─────────────────────────────────────────────────────────

function switchChannel(channel) {
    if (channel === currentChannel) return;
    if (socket && currentChannel) socket.emit('leave:channel', currentChannel);

    currentChannel = channel;

    tabList.querySelectorAll('li').forEach(li =>
        li.classList.toggle('is-active', li.dataset.channel === channel));

    const overlayPath    = `/HTML/overlay.html?channel=${encodeURIComponent(channel)}`;
    const previewPath    = `${overlayPath}&controls=1`;
    previewFrame.src     = previewPath;
    if (overlayUrl) overlayUrl.textContent = `${window.location.origin}${overlayPath}`;

    if (socket) socket.emit('join:channel', channel);
    loadMedia();
    loadMode();
    if (activeQueueTab === 'mylist') loadMyList();
}

function buildTabs(channels) {
    tabList.innerHTML = channels.map(ch =>
        `<li data-channel="${esc(ch)}"><a>${esc(ch)}</a></li>`
    ).join('');
    tabList.querySelectorAll('li').forEach(li =>
        li.addEventListener('click', () => switchChannel(li.dataset.channel)));
}

// ── Init ──────────────────────────────────────────────────────────────────────

logoutBtn.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
});

async function init() {
    const res = await fetch('/api/auth/me').catch(() => null);
    if (!res || !res.ok) { window.location.href = '/'; return; }

    user = (await res.json()).user;
    navUser.textContent = `Logged in as ${user.username}`;

    const channels = [user.channel, ...(user.access_accounts || [])];
    buildTabs(channels);

    socket = io();
    socket.on('connect', () => { if (currentChannel) socket.emit('join:channel', currentChannel); });
    socket.on('queue:update', ({ channel }) => {
        if (channel !== currentChannel) return;
        loadMedia();
        // A promoted My List song is consumed from the personal list server-side,
        // so refresh that view too when it's open — otherwise the finished/started
        // song lingers on screen until the user switches tabs.
        if (activeQueueTab === 'mylist') loadMyList();
    });

    setupQueueTypeTabs();
    switchChannel(channels[0]);
}

init();
