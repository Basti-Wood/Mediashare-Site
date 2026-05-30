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
const CHANNEL   = (params.get('channel') || '').trim();
const CONTROLS  = params.get('controls') === '1';

let ytPlayer       = null;
let ytApiReady     = false;
let pendingVideoId = null;   // loaded before API was ready
let currentItemId  = null;
let skipItemId     = null;   // ID of last removed item — skip if it comes back
let finishedItemId = null;   // ID of last *finished/empty* item — never replay it
let ytFallbackTimer = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const idleScreen    = document.getElementById('idle-screen');
const ytContainer   = document.getElementById('yt-player');
const spotifyFrame  = document.getElementById('spotify-player');

// ── Controls (visible when ?controls=1) ───────────────────────────────────────

let pollTimer  = null;
let isSeeking  = false;

const ctrlPanel   = CONTROLS ? document.getElementById('player-controls') : null;
const seekBar     = CONTROLS ? document.getElementById('seek-bar')        : null;
const volumeBar   = CONTROLS ? document.getElementById('volume-bar')      : null;
const timeDisplay = CONTROLS ? document.getElementById('time-display')    : null;

function formatTime(sec) {
    sec = Math.floor(sec || 0);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function startPoll() {
    if (!CONTROLS || pollTimer) return;
    pollTimer = setInterval(() => {
        if (isSeeking || !ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
        const state = typeof ytPlayer.getPlayerState === 'function' ? ytPlayer.getPlayerState() : -1;
        if (state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.PAUSED) return;
        const dur = ytPlayer.getDuration();
        const cur = ytPlayer.getCurrentTime();
        if (dur > 0) {
            seekBar.value = (cur / dur) * 100;
            timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
        }
    }, 500);
}

function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

if (CONTROLS) {
    ctrlPanel.style.display = 'flex';

    // Seek
    seekBar.addEventListener('mousedown',  () => { isSeeking = true; });
    seekBar.addEventListener('touchstart', () => { isSeeking = true; }, { passive: true });
    seekBar.addEventListener('input', () => {
        if (!ytPlayer || typeof ytPlayer.getDuration !== 'function') return;
        const dur = ytPlayer.getDuration();
        const sec = (seekBar.value / 100) * dur;
        timeDisplay.textContent = `${formatTime(sec)} / ${formatTime(dur)}`;
    });
    seekBar.addEventListener('change', () => {
        isSeeking = false;
        if (!ytPlayer || typeof ytPlayer.seekTo !== 'function') return;
        ytPlayer.seekTo((seekBar.value / 100) * ytPlayer.getDuration(), true);
    });

    // Volume
    volumeBar.addEventListener('input', () => {
        const vol = Number(volumeBar.value);
        if (!ytPlayer || typeof ytPlayer.setVolume !== 'function') return;
        if (vol === 0) { ytPlayer.mute(); }
        else { ytPlayer.unMute(); ytPlayer.setVolume(vol); }
    });
}

function clearYouTubeFallbackTimer() {
    if (ytFallbackTimer) {
        clearTimeout(ytFallbackTimer);
        ytFallbackTimer = null;
    }
}

function fallbackEmbed(videoId) {
    const src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&controls=0&rel=0&modestbranding=1&playsinline=1`;
    ytContainer.innerHTML = `
        <iframe
            data-fallback="1"
            width="100%"
            height="100%"
            src="${src}"
            title="YouTube video player"
            frameborder="0"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            referrerpolicy="strict-origin-when-cross-origin">
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
    skipItemId     = currentItemId;  // remember removed item so we don't replay it
    finishedItemId = currentItemId;  // and never auto-replay the finished item
    currentItemId  = null;
    showIdle();                      // blank the screen immediately
    try {
        await fetch(`/api/channels/${encodeURIComponent(CHANNEL)}/next`, { method: 'POST' });
        // The server emits queue:update after this POST, which triggers fetchAndPlay().
        // fetchAndPlay → playItem will handle the next item (or stay idle if queue empty).
    } catch (e) {
        console.error('Failed to advance queue', e);
        skipItemId = null;
    }
}

// ── Play an item ──────────────────────────────────────────────────────────────

// Fully tear down the YouTube player so a finished video can't be replayed.
function destroyYouTubePlayer() {
    if (ytPlayer && typeof ytPlayer.destroy === 'function') {
        try { ytPlayer.destroy(); } catch {}
    }
    ytPlayer = null;
    pendingVideoId = null;
    // Re-create the target div the API needs (destroy() removes it).
    ytContainer.innerHTML = '';
}

function showIdle() {
    idleScreen.style.display   = 'flex';
    ytContainer.style.display  = 'none';
    spotifyFrame.style.display = 'none';
    spotifyFrame.src = '';
    clearYouTubeFallbackTimer();
    destroyYouTubePlayer();          // clear completely — no lingering replayable video
    currentItemId = null;
    stopPoll();
    if (CONTROLS && seekBar)     { seekBar.value = 0; seekBar.disabled = false; }
    if (CONTROLS && timeDisplay) timeDisplay.textContent = '0:00 / 0:00';
}

function playYouTube(videoId) {
    idleScreen.style.display   = 'none';
    spotifyFrame.style.display = 'none';
    ytContainer.style.display  = 'block';
    stopPoll();
    if (CONTROLS && seekBar)     { seekBar.value = 0; seekBar.disabled = false; }
    if (CONTROLS && timeDisplay) timeDisplay.textContent = '0:00 / 0:00';

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
            width:  '100%',
            height: '100%',
            videoId,
            playerVars: {
                autoplay:       1,
                playsinline:    1,
                controls:       0,
                rel:            0,
                modestbranding: 1
            },
            events: {
                onReady(event) {
                    event.target.unMute();
                    if (CONTROLS && volumeBar) event.target.setVolume(Number(volumeBar.value));
                    event.target.playVideo();
                    startPoll();
                },
                onStateChange(event) {
                    if (event.data === YT.PlayerState.ENDED) advance();
                    if (CONTROLS) {
                        if (event.data === YT.PlayerState.PLAYING) startPoll();
                        else if (event.data === YT.PlayerState.PAUSED ||
                                 event.data === YT.PlayerState.ENDED)  stopPoll();
                    }
                },
                onError() {
                    console.error('YouTube player error, advancing.');
                    advance();
                }
            }
        });
    } else {
        ytPlayer.loadVideoById(videoId);
        ytPlayer.unMute();
        if (CONTROLS && volumeBar) ytPlayer.setVolume(Number(volumeBar.value));
        ytPlayer.playVideo();
        startPoll();
    }
}

function playSpotify(info) {
    idleScreen.style.display   = 'none';
    ytContainer.style.display  = 'none';
    spotifyFrame.style.display = 'block';
    clearYouTubeFallbackTimer();
    stopPoll();
    if (CONTROLS && seekBar)     { seekBar.value = 0; seekBar.disabled = true; }
    if (CONTROLS && timeDisplay) timeDisplay.textContent = 'Spotify';

    spotifyFrame.src =
        `https://open.spotify.com/embed/${info.type}/${info.id}?utm_source=generator&autoplay=1`;
}

function playItem(item) {
    if (!item) { showIdle(); return; }

    // api.bastiwood.com uses capital-P Platform and .media for the URL
    const url      = item.url || item.media || '';
    const platform = (item.platform || item.Platform || '').toLowerCase();
    const id       = item.id || `${platform}|${url}|${item.song_name || ''}|${item.username || ''}`;

    if (id === currentItemId) return;   // already playing this
    if (id === skipItemId) { showIdle(); return; }  // just removed — API hasn't updated yet
    if (id === finishedItemId) { showIdle(); return; }  // finished song lingering in API — don't replay
    skipItemId    = null;
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
        // If the queue is genuinely empty, forget the finished marker so the
        // *next* freshly-added song (even if identical) plays normally.
        if (!data.current) finishedItemId = null;
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
