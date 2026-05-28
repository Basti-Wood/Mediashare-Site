function getYouTubeId(url) {
    if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
    const m = url.match(
        /(?:youtube\.com\/(?:watch\?.*?v=|shorts\/|embed\/|v\/|e\/)|youtu\.be\/)([^"&?/\s]{11})/
    );
    return m ? m[1] : null;
}

function getSpotifyInfo(url) {
    const m = url.match(/spotify\.com\/(track|album|playlist)\/([A-Za-z0-9]+)/);
    return m ? { type: m[1], id: m[2] } : null;
}

// ── State ─────────────────────────────────────────────────────────────────────

const params  = new URLSearchParams(window.location.search);
const CHANNEL = (params.get('channel') || '').trim();

let ytPlayer       = null;
let ytApiReady     = false;
let pendingVideoId = null;   // loaded before API was ready
let currentItemId  = null;
let ytFallbackTimer = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const idleScreen    = document.getElementById('idle-screen');
const ytContainer   = document.getElementById('yt-player');
const spotifyFrame  = document.getElementById('spotify-player');

function clearYouTubeFallbackTimer() {
    if (ytFallbackTimer) {
        clearTimeout(ytFallbackTimer);
        ytFallbackTimer = null;
    }
}

function fallbackEmbed(videoId) {
    const src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&playsinline=1`;
    ytContainer.innerHTML = `
        <iframe
            data-fallback="1"
            width="100%"
            height="100%"
            src="${src}"
            title="YouTube video player"
            frameborder="0"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            referrerpolicy="strict-origin-when-cross-origin"
            allowfullscreen>
        </iframe>`;
}

function scheduleFallback(videoId) {
    clearYouTubeFallbackTimer();
    ytFallbackTimer = setTimeout(() => {
        if (ytApiReady) return;
        fallbackEmbed(videoId);
    }, 2500);
}

// ── Advance queue (called when a track finishes) ───────────────────────────────

async function advance() {
    if (!CHANNEL) return;
    currentItemId = null;
    try {
        await fetch(`/api/channels/${encodeURIComponent(CHANNEL)}/next`, { method: 'POST' });
        // Use local refresh as a fallback in case socket delivery is delayed.
        await fetchAndPlay();
    } catch (e) {
        console.error('Failed to advance queue', e);
    }
}

// ── Play an item ──────────────────────────────────────────────────────────────

function showIdle() {
    idleScreen.style.display   = 'flex';
    ytContainer.style.display  = 'none';
    spotifyFrame.style.display = 'none';
    spotifyFrame.src = '';
    clearYouTubeFallbackTimer();
    if (ytPlayer) ytPlayer.stopVideo();
    currentItemId = null;
}

function playYouTube(videoId) {
    idleScreen.style.display   = 'none';
    spotifyFrame.style.display = 'none';
    ytContainer.style.display  = 'block';

    const fallbackIframe = ytContainer.querySelector('iframe[data-fallback="1"]');
    if (fallbackIframe && !ytApiReady) {
        fallbackEmbed(videoId);
        return;
    }

    if (!ytApiReady) {
        pendingVideoId = videoId;
        scheduleFallback(videoId);
        return;
    }

    clearYouTubeFallbackTimer();
    ytContainer.innerHTML = '';

    if (!ytPlayer) {
        ytPlayer = new YT.Player('yt-player', {
            videoId,
            playerVars: {
                autoplay:       1,
                mute:           1,
                playsinline:    1,
                controls:       0,
                rel:            0,
                modestbranding: 1
            },
            events: {
                onReady(event) {
                    event.target.mute();
                    event.target.playVideo();
                },
                onStateChange(event) {
                    if (event.data === YT.PlayerState.ENDED) advance();
                },
                onError() {
                    console.error('YouTube player error, advancing.');
                    advance();
                }
            }
        });
    } else {
        ytPlayer.loadVideoById(videoId);
        ytPlayer.mute();
        ytPlayer.playVideo();
    }
}

function playSpotify(info) {
    idleScreen.style.display   = 'none';
    ytContainer.style.display  = 'none';
    spotifyFrame.style.display = 'block';
    clearYouTubeFallbackTimer();

    spotifyFrame.src =
        `https://open.spotify.com/embed/${info.type}/${info.id}?utm_source=generator&autoplay=1`;
}

function playItem(item) {
    if (!item) { showIdle(); return; }

    // api.bastiwood.com uses capital-P Platform and .media for the URL
    const url      = item.url || item.media || '';
    const platform = (item.platform || item.Platform || '').toLowerCase();
    const id       = item.id || `${platform}|${url}|${item.song_name || ''}|${item.username || ''}`;

    if (id === currentItemId) return;
    currentItemId = id;

    if (platform === 'spotify' || getSpotifyInfo(url)) {
        const info = getSpotifyInfo(url);
        if (info) { playSpotify(info); return; }
    }

    const ytId = getYouTubeId(url);
    if (ytId) { playYouTube(ytId); return; }

    console.warn('Unrecognised media URL, skipping:', url);
    advance();
}

// ── YouTube IFrame API callback (called by the API script) ────────────────────

window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    clearYouTubeFallbackTimer();
    if (pendingVideoId) {
        const id   = pendingVideoId;
        pendingVideoId = null;
        playYouTube(id);
    }
};

// ── Socket.io + initial load ──────────────────────────────────────────────────

async function fetchAndPlay() {
    if (!CHANNEL) { showIdle(); return; }
    try {
        const res  = await fetch(`/api/channels/${encodeURIComponent(CHANNEL)}/current`);
        const data = await res.json();
        playItem(data.current);
    } catch (e) {
        console.error('Failed to fetch current item', e);
        showIdle();
    }
}

if (CHANNEL) {
    const socket = io();

    socket.on('connect', () => {
        socket.emit('join:channel', CHANNEL);
    });

    socket.on('queue:update', (payload = {}) => {
        if (payload.channel && payload.channel !== CHANNEL) return;
        fetchAndPlay();
    });
}

fetchAndPlay();
