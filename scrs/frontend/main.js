'use strict';

let currentChannel = null;
let socket         = null;
let user           = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const navUser       = document.getElementById('nav-user');
const logoutBtn     = document.getElementById('logout-btn');
const tabList       = document.getElementById('channel-tab-list');
const previewFrame  = document.getElementById('preview-frame');
const overlayUrl    = document.getElementById('overlay-url');
const nowPlaying    = document.getElementById('now-playing-info');
const queueCount    = document.getElementById('queue-count');
const queueEmpty    = document.getElementById('queue-empty');
const queueTable    = document.getElementById('queue-table');
const queueTbody    = document.getElementById('queue-tbody');

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
    const title = esc(item?.song_name || 'Unknown Title');
    const url = getMediaUrl(item);
    if (!url) return `<span class="media-link">${title}</span>`;
    return `<a class="media-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="Open media link">${title}</a>`;
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderMedia(media) {
    // media[0] = now playing, media[1..] = upcoming
    const current  = media[0] ?? null;
    const upcoming = media.slice(1);

    // Now playing
    if (current) {
        nowPlaying.innerHTML = `
            <div class="now-playing-card">
                ${getThumbnailHtml(current)}
                ${platformTag(current.Platform)}
                <span class="now-playing-title">${renderTitle(current)}</span>
                <span class="now-playing-user">by ${esc(current.username)}</span>
                <button class="button is-danger is-small ml-auto skip-btn" title="Skip">✕ Skip</button>
            </div>`;
        nowPlaying.querySelector('.skip-btn')
            .addEventListener('click', () => removeMedia(0));
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

// ── Channel switching ─────────────────────────────────────────────────────────

function switchChannel(channel) {
    if (channel === currentChannel) return;
    if (socket && currentChannel) socket.emit('leave:channel', currentChannel);

    currentChannel = channel;

    tabList.querySelectorAll('li').forEach(li =>
        li.classList.toggle('is-active', li.dataset.channel === channel));

    const overlayPath = `/HTML/overlay.html?channel=${encodeURIComponent(channel)}`;
    previewFrame.src  = overlayPath;
    overlayUrl.textContent = `${window.location.origin}${overlayPath}`;

    if (socket) socket.emit('join:channel', channel);
    loadMedia();
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
    socket.on('queue:update', ({ channel }) => { if (channel === currentChannel) loadMedia(); });

    switchChannel(channels[0]);
}

init();
