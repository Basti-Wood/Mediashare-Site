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

// Audio-mode switch: by default YouTube playback now runs through a same-origin
// <audio> element fed by the server's yt-dlp resolver (/api/yt-audio/:id). A
// native audio element is NOT suspended by the browser in a background tab, which
// is what kept stopping playback (the old YouTube iframe gets paused when hidden,
// especially in Brave). The muted YouTube iframe is kept ONLY to show the video
// picture when the tab is visible; the audio element is the playback authority
// (timing, volume, seek, and end-of-track all come from it).
//
// Append &ytmode=iframe to fall back to the old iframe-audio behaviour if needed.
const YT_AUDIO_MODE = params.get('ytmode') !== 'iframe';
const MAX_VOLUME = 0.5; // 100% in the controls is half the previous maximum.
let volumePercent = 100;
let playbackMode = null; // 'youtube-audio', 'youtube', 'local', or 'spotify'

let ytPlayer       = null;   // muted iframe player (video picture only, in audio mode)
let ytApiReady     = false;
let pendingVideoId = null;   // loaded before API was ready
let currentItemId  = null;
let skipItemId     = null;   // ID of last removed item — skip if it comes back
let finishedItemId = null;   // ID of last *finished/empty* item — never replay it
let ytFallbackTimer = null;
let currentFetchSequence = 0;

// ── Background-throttle survival ──────────────────────────────────────────────
// The native <audio> element keeps playing in a background tab on its own, and a
// Wake Lock is requested to further reduce throttling while the overlay is open.
let watchdogTimer  = null;
let advancing      = false;   // guards against double-advance (event + watchdog)
let wakeLock       = null;

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator && navigator.wakeLock.request) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
    } catch { /* wake lock not critical — ignore */ }
}

// Re-acquire the wake lock if it was dropped (e.g. on tab hide/show).
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
});

// ── Background-tab pause prevention (visibility spoof) ─────────────────────────
// Kept as defence-in-depth for the muted video iframe so its picture doesn't stall
// when the tab is hidden. The native <audio> element does not need this, but it's
// harmless. The matching inline shim in overlay.html runs before the iframe_api
// script so YouTube's own visibility listener only ever sees "visible".
(function pinVisibilityVisible() {
    try {
        if (Object.getOwnPropertyDescriptor(document, 'visibilityState') === undefined ||
            document.visibilityState !== 'visible') {
            Object.defineProperty(document, 'visibilityState', {
                configurable: true, get() { return 'visible'; }
            });
        }
        if (document.hidden !== false) {
            Object.defineProperty(document, 'hidden', {
                configurable: true, get() { return false; }
            });
        }
    } catch { /* some browsers may refuse redefinition — non-fatal */ }

    window.addEventListener('visibilitychange', e => {
        e.stopImmediatePropagation();
    }, true);
    document.addEventListener('visibilitychange', e => {
        e.stopImmediatePropagation();
    }, true);
})();

// ── DOM refs ──────────────────────────────────────────────────────────────────

const idleScreen    = document.getElementById('idle-screen');
const ytContainer   = document.getElementById('yt-player');
const spotifyFrame  = document.getElementById('spotify-player');

// Hidden same-origin audio element — the playback authority in audio mode.
// Created once and reused. It is never removed, so the browser keeps it alive in
// the background.
const audioEl = new Audio();
audioEl.preload  = 'auto';
audioEl.autoplay = true;
audioEl.volume   = MAX_VOLUME;

// ── Audio normalisation ───────────────────────────────────────────────────────
// Loudness normalisation now happens server-side (ffmpeg loudnorm) for both the
// YouTube proxy (/api/yt-audio/:id) and local MP3 uploads, so every track
// already arrives at the same target loudness. We intentionally do NOT route
// this element through the Web Audio API (createMediaElementSource) — browsers
// silently mute any media element connected to Web Audio if its underlying
// resource is cross-origin without CORS headers, which is exactly what broke
// playback here previously.

// ── Controls (visible when ?controls=1) ───────────────────────────────────────

let pollTimer  = null;
let isSeeking  = false;

const ctrlPanel   = CONTROLS ? document.getElementById('player-controls') : null;
const seekBar     = CONTROLS ? document.getElementById('seek-bar')        : null;
const volumeBar   = CONTROLS ? document.getElementById('volume-bar')      : null;
const volumeInput = CONTROLS ? document.getElementById('volume-percent')  : null;
const timeDisplay = CONTROLS ? document.getElementById('time-display')    : null;

function formatTime(sec) {
    sec = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function usesNativeAudio() {
    return playbackMode === 'youtube-audio' || playbackMode === 'local';
}

function getPlaybackDuration() {
    if (usesNativeAudio() && Number.isFinite(audioEl.duration) && audioEl.duration > 0) {
        return audioEl.duration;
    }
    // The transcoded MP3 stream has no length header and can report Infinity.
    // Use the matching video duration, while keeping the audio clock authoritative.
    if ((playbackMode === 'youtube-audio' || playbackMode === 'youtube') &&
        ytPlayer && typeof ytPlayer.getDuration === 'function') {
        try {
            const duration = ytPlayer.getDuration();
            if (Number.isFinite(duration) && duration > 0) return duration;
        } catch { /* player may still be loading */ }
    }
    return 0;
}

function updateProgress() {
    if (!CONTROLS || isSeeking || !playbackMode || playbackMode === 'spotify') return;
    let current = 0;
    if (usesNativeAudio()) current = audioEl.currentTime;
    else if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
        try { current = ytPlayer.getCurrentTime(); } catch { return; }
    }
    const duration = getPlaybackDuration();
    seekBar.value = duration > 0 ? Math.max(0, Math.min(100, current / duration * 100)) : 0;
    timeDisplay.textContent = `${formatTime(current)} / ${duration > 0 ? formatTime(duration) : '--:--'}`;
}

function startPoll() {
    if (!CONTROLS) return;
    updateProgress();
    if (!pollTimer) pollTimer = setInterval(updateProgress, 250);
}

function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function applyVolume(value = volumePercent, player = ytPlayer) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    volumePercent = Math.max(0, Math.min(100, parsed));
    if (volumeBar) volumeBar.value = volumePercent;
    // Avoid rewriting a matching value while typing a decimal (e.g. "12.").
    if (volumeInput && (volumeInput.value === '' || Number(volumeInput.value) !== volumePercent)) {
        volumeInput.value = volumePercent;
    }
    const level = volumePercent / 100 * MAX_VOLUME;
    audioEl.volume = level;
    audioEl.muted = level === 0;
    if (playbackMode === 'youtube' && player && typeof player.setVolume === 'function') {
        player.setVolume(level * 100);
        if (level === 0) player.mute();
        else player.unMute();
    }
}

if (CONTROLS) {
    ctrlPanel.style.display = 'flex';

    // Release seeking even when a drag ends outside the slider or is cancelled.
    seekBar.addEventListener('pointerdown', () => { isSeeking = true; });
    window.addEventListener('pointerup', () => { isSeeking = false; });
    window.addEventListener('pointercancel', () => { isSeeking = false; });
    seekBar.addEventListener('blur', () => { isSeeking = false; });
    seekBar.addEventListener('input', () => {
        const duration = getPlaybackDuration();
        if (!duration) return;
        const seconds = seekBar.value / 100 * duration;
        timeDisplay.textContent = `${formatTime(seconds)} / ${formatTime(duration)}`;
    });
    seekBar.addEventListener('change', () => {
        isSeeking = false;
        const duration = getPlaybackDuration();
        if (!duration) return;
        const seconds = seekBar.value / 100 * duration;
        if (usesNativeAudio()) {
            audioEl.currentTime = seconds;
            if (playbackMode === 'youtube-audio' && ytPlayer && typeof ytPlayer.seekTo === 'function') {
                try { ytPlayer.seekTo(seconds, true); } catch {}
            }
        } else if (playbackMode === 'youtube' && ytPlayer && typeof ytPlayer.seekTo === 'function') {
            ytPlayer.seekTo(seconds, true);
        }
    });

    volumeBar.addEventListener('input', () => applyVolume(volumeBar.value));
    volumeInput.addEventListener('input', () => {
        // Leave an empty field editable while the user replaces its value.
        if (volumeInput.value !== '') applyVolume(volumeInput.value);
    });
    volumeInput.addEventListener('change', () => applyVolume(
        volumeInput.value === '' ? volumePercent : volumeInput.value
    ));
    applyVolume();
}

audioEl.addEventListener('ended', () => { advance(); });
audioEl.addEventListener('error', () => {
    if (!audioEl.src) return;
    console.error('Audio element error, advancing.');
    advance();
});
audioEl.addEventListener('playing', () => {
    if (usesNativeAudio()) startPoll();
});
['timeupdate', 'durationchange', 'loadedmetadata', 'seeked'].forEach(event =>
    audioEl.addEventListener(event, updateProgress));

function clearYouTubeFallbackTimer() {
    if (ytFallbackTimer) {
        clearTimeout(ytFallbackTimer);
        ytFallbackTimer = null;
    }
}

function fallbackEmbed(videoId) {
    // Use enablejsapi=1 so we can still drive seek/volume from the controls.
    const origin = encodeURIComponent(window.location.origin);
    const src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?enablejsapi=1&autoplay=1&mute=1&controls=0&rel=0&modestbranding=1&playsinline=1&origin=${origin}`;
    ytContainer.innerHTML = `
        <iframe
            id="yt-fallback-iframe"
            data-fallback="1"
            width="100%"
            height="100%"
            src="${src}"
            title="YouTube video player"
            frameborder="0"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            referrerpolicy="strict-origin-when-cross-origin">
        </iframe>`;

    // If the JS API is (or becomes) available, attach a player to the fallback
    // iframe so the seek/volume sliders keep working instead of silently dying.
    const attach = () => {
        if (typeof YT === 'undefined' || !YT.Player) return false;
        try {
            ytPlayer = new YT.Player('yt-fallback-iframe', {
                events: {
                    onReady(event) {
                        if (YT_AUDIO_MODE) {
                            // Video picture only — never let the iframe make sound.
                            event.target.mute();
                        } else {
                            applyVolume(volumePercent, event.target);
                            startPoll();
                            startWatchdog();
                        }
                    },
                    onStateChange(event) {
                        if (YT_AUDIO_MODE) return;   // audio element drives advance()
                        if (event.data === YT.PlayerState.ENDED) advance();
                        if (CONTROLS) {
                            if (event.data === YT.PlayerState.PLAYING) startPoll();
                            else if (event.data === YT.PlayerState.PAUSED ||
                                     event.data === YT.PlayerState.ENDED)  stopPoll();
                        }
                    }
                }
            });
            return true;
        } catch { return false; }
    };
    if (!attach()) {
        // YT script not parsed yet — retry briefly.
        let tries = 0;
        const t = setInterval(() => {
            if (attach() || ++tries > 20) clearInterval(t);
        }, 250);
    }
}

function scheduleFallback(videoId) {
    clearYouTubeFallbackTimer();
    ytFallbackTimer = setTimeout(() => {
        if (ytApiReady) return;
        fallbackEmbed(videoId);
    }, 2500);
}

// ── Watchdog (iframe mode only) ────────────────────────────────────────────────
// In audio mode the <audio> 'ended' event is reliable in the background, so the
// watchdog is not used. It remains for the legacy iframe-audio mode.
function startWatchdog() {
    if (YT_AUDIO_MODE) return;
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
        if (advancing || !ytPlayer) return;
        if (typeof ytPlayer.getCurrentTime !== 'function') return;
        if (typeof ytPlayer.getDuration   !== 'function') return;
        const state = typeof ytPlayer.getPlayerState === 'function'
            ? ytPlayer.getPlayerState() : -1;
        if (state === YT.PlayerState.ENDED) { advance(); return; }
        const dur = ytPlayer.getDuration();
        const cur = ytPlayer.getCurrentTime();
        if (dur > 0 && cur > 0 && dur - cur <= 0.6) advance();
    }, 1000);
}

function stopWatchdog() {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

// ── Advance queue (called when a track finishes) ───────────────────────────────

async function advance() {
    if (!CHANNEL) return;
    if (advancing) return;           // already advancing (event + watchdog race)
    advancing      = true;
    const playbackId = currentItemId;
    currentFetchSequence++;         // ignore any current response started before this finish
    skipItemId     = currentItemId;  // remember removed item so we don't replay it
    finishedItemId = currentItemId;  // and never auto-replay the finished item
    currentItemId  = null;
    showIdle();                      // blank the screen immediately
    try {
        const res = await fetch(`/api/channels/${encodeURIComponent(CHANNEL)}/next`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playbackId })
        });
        if (!res.ok) throw new Error(res.status);
        // The server emits queue:update after this POST, which triggers fetchAndPlay().
        // fetchAndPlay → playItem will handle the next item (or stay idle if queue empty).
    } catch (e) {
        console.error('Failed to advance queue', e);
        skipItemId = null;
        finishedItemId = null;
    } finally {
        advancing = false;
        // A queue:update can arrive during the POST. Always fetch once more
        // afterward so a one-song loop starts its next playback immediately.
        fetchAndPlay();
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

// Stop and clear the audio element (without removing it from the DOM/memory).
function stopAudio() {
    try {
        audioEl.pause();
        audioEl.removeAttribute('src');
        audioEl.load();   // abort any in-flight network fetch
    } catch {}
}

function showIdle() {
    playbackMode = null;
    isSeeking = false;
    idleScreen.style.display   = 'flex';
    ytContainer.style.display  = 'none';
    spotifyFrame.style.display = 'none';
    spotifyFrame.src = '';
    clearYouTubeFallbackTimer();
    destroyYouTubePlayer();          // clear completely — no lingering replayable video
    stopAudio();
    currentItemId = null;
    stopPoll();
    stopWatchdog();
    if (CONTROLS && seekBar)     { seekBar.value = 0; seekBar.disabled = false; }
    if (CONTROLS && timeDisplay) timeDisplay.textContent = '0:00 / 0:00';
}

// Audio-mode YouTube playback: native <audio> drives sound + timing; the muted
// iframe (if the API is ready) just shows the picture.
function playYouTubeAudioMode(videoId) {
    playbackMode = 'youtube-audio';
    isSeeking = false;
    idleScreen.style.display   = 'none';
    spotifyFrame.style.display = 'none';
    ytContainer.style.display  = 'block';

    if (CONTROLS && seekBar)     { seekBar.value = 0; seekBar.disabled = false; }
    if (CONTROLS && timeDisplay) timeDisplay.textContent = '0:00 / 0:00';

    // 1) Start the audio (the part that must survive a background tab).
    audioEl.src = `/api/yt-audio/${encodeURIComponent(videoId)}`;
    applyVolume();
    const p = audioEl.play();
    if (p && p.catch) {
        p.catch(err => {
            // Autoplay may be blocked until a user gesture (first load in a fresh
            // window). The pointerdown handler below retries; log for visibility.
            console.warn('Audio autoplay blocked — click once to start.', err?.message || err);
        });
    }
    if (CONTROLS) startPoll();

    // 2) Show the muted video picture via the iframe, best-effort.
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
                autoplay: 1, playsinline: 1, controls: 0, rel: 0,
                modestbranding: 1, enablejsapi: 1, mute: 1,
                origin: window.location.origin
            },
            events: {
                onReady(event) {
                    event.target.mute();          // picture only — no second audio
                    event.target.playVideo();
                },
                onStateChange() { /* audio element drives advance() */ },
                onError() { /* picture failing is non-fatal in audio mode */ }
            }
        });
    } else {
        ytPlayer.loadVideoById(videoId);
        ytPlayer.mute();
        ytPlayer.playVideo();
    }
}

function playYouTube(videoId) {
    if (YT_AUDIO_MODE) { playYouTubeAudioMode(videoId); return; }
    playbackMode = 'youtube';
    isSeeking = false;

    // ── Legacy iframe-audio mode (&ytmode=iframe) ──
    idleScreen.style.display   = 'none';
    spotifyFrame.style.display = 'none';
    ytContainer.style.display  = 'block';
    stopAudio();
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
                mute:           1,
                playsinline:    1,
                controls:       0,
                rel:            0,
                modestbranding: 1,
                enablejsapi:    1,
                origin:         window.location.origin
            },
            events: {
                onReady(event) {
                    applyVolume(volumePercent, event.target);
                    event.target.playVideo();
                    startPoll();
                    startWatchdog();
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
        applyVolume();
        ytPlayer.playVideo();
        startPoll();
    }
}

function playSpotify(info) {
    playbackMode = 'spotify';
    isSeeking = false;
    destroyYouTubePlayer();
    idleScreen.style.display   = 'none';
    ytContainer.style.display  = 'none';
    spotifyFrame.style.display = 'block';
    clearYouTubeFallbackTimer();
    stopAudio();
    stopPoll();
    if (CONTROLS && seekBar)     { seekBar.value = 0; seekBar.disabled = true; }
    if (CONTROLS && timeDisplay) timeDisplay.textContent = 'Spotify';

    spotifyFrame.src =
        `https://open.spotify.com/embed/${info.type}/${info.id}?utm_source=generator&autoplay=1`;
}

// Play a local MP3 file through the native <audio> element.
// The file is served by our own backend at /api/local-media/....
function playLocalAudio(item) {
    playbackMode = 'local';
    isSeeking = false;
    destroyYouTubePlayer();
    const url = item.url || item.media || '';
    const title = item.song_name || item.title || 'Local File';

    idleScreen.style.display   = 'none';
    ytContainer.style.display  = 'none';
    spotifyFrame.style.display = 'none';
    clearYouTubeFallbackTimer();
    stopPoll();
    if (CONTROLS && seekBar)     { seekBar.value = 0; seekBar.disabled = false; }
    if (CONTROLS && timeDisplay) timeDisplay.textContent = title;

    // Route through the normalised audio element.
    audioEl.src = url;
    applyVolume();
    const p = audioEl.play();
    if (p && p.catch) {
        p.catch(err => console.warn('Local audio autoplay blocked:', err?.message || err));
    }
    if (CONTROLS) startPoll();
}

function playItem(item) {
    if (!item) { showIdle(); return; }

    // api.bastiwood.com uses capital-P Platform and .media for the URL
    const url      = item.url || item.media || '';
    const platform = (item.platform || item.Platform || '').toLowerCase();
    const id       = item._playbackId || item.id || `${platform}|${url}|${item.song_name || ''}|${item.username || ''}`;

    if (id === currentItemId) return;   // already playing this
    if (id === skipItemId) { showIdle(); return; }  // just removed — API hasn't updated yet
    if (id === finishedItemId) { showIdle(); return; }  // finished song lingering in API — don't replay
    skipItemId    = null;
    currentItemId = id;

    if (platform === 'spotify' || getSpotifyInfo(url)) {
        const info = getSpotifyInfo(url);
        if (info) { playSpotify(info); return; }
    }

    // Local MP3 files served by our own backend.
    // Basti may or may not preserve the 'platform' field and may encode '/'
    // in the URL — detect by the local-media path segment (encoded or not).
    if (platform === 'local' || /(\/|%2F)api(\/|%2F)local-media(\/|%2F)/.test(url)) {
        // Ensure we have a clean, decoded URL for the audio element.
        const cleanUrl = decodeURIComponent(url);
        playLocalAudio({ ...item, url: cleanUrl, media: cleanUrl });
        return;
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

// First user gesture: retry audio playback in case autoplay was blocked on a
// fresh window load. Cheap and safe — play() on an already-playing element is a
// no-op.
['click', 'keydown', 'touchstart', 'pointerdown'].forEach(ev =>
    window.addEventListener(ev, () => {
        if (usesNativeAudio() && audioEl.src && audioEl.paused) {
            audioEl.play().catch(() => {});
        }
    }, { passive: true }));

// ── Socket.io + initial load ──────────────────────────────────────────────────

async function fetchAndPlay() {
    if (!CHANNEL) { showIdle(); return; }
    if (advancing) return;
    const sequence = ++currentFetchSequence;
    try {
        const res  = await fetch(`/api/channels/${encodeURIComponent(CHANNEL)}/current`);
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        if (sequence !== currentFetchSequence || advancing) return;
        // If the queue is genuinely empty, forget the finished marker so the
        // *next* freshly-added song (even if identical) plays normally.
        if (!data.current) finishedItemId = null;
        playItem(data.current);
    } catch (e) {
        if (sequence !== currentFetchSequence || advancing) return;
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

    // Safety re-sync: if a queue:update socket message is ever missed (e.g. while
    // the tab was hidden and the socket briefly slept), this low-frequency poll
    // re-checks the current item so the overlay self-heals. playItem() is a no-op
    // when the current item is already playing, so this is cheap.
    setInterval(() => {
        if (!advancing) fetchAndPlay();
    }, 10000);

    // Reduce background throttling while the overlay is open (best-effort).
    requestWakeLock();
}

fetchAndPlay();
