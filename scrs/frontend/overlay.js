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

let ytPlayer       = null;   // muted iframe player (video picture only, in audio mode)
let ytApiReady     = false;
let pendingVideoId = null;   // loaded before API was ready
let currentItemId  = null;
let skipItemId     = null;   // ID of last removed item — skip if it comes back
let finishedItemId = null;   // ID of last *finished/empty* item — never replay it
let ytFallbackTimer = null;

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
audioEl.volume   = 1;

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

// In audio mode the seek/volume/time all read from the <audio> element.
function startPoll() {
    if (!CONTROLS || pollTimer) return;
    pollTimer = setInterval(() => {
        if (isSeeking) return;
        if (YT_AUDIO_MODE) {
            const dur = audioEl.duration;
            const cur = audioEl.currentTime;
            if (dur > 0 && isFinite(dur)) {
                seekBar.value = (cur / dur) * 100;
                timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
            }
            return;
        }
        if (!ytPlayer || typeof ytPlayer.getCurrentTime !== 'function') return;
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
        let dur;
        if (YT_AUDIO_MODE) dur = audioEl.duration;
        else if (ytPlayer && typeof ytPlayer.getDuration === 'function') dur = ytPlayer.getDuration();
        if (!dur || isNaN(dur) || !isFinite(dur)) return;
        const sec = (seekBar.value / 100) * dur;
        timeDisplay.textContent = `${formatTime(sec)} / ${formatTime(dur)}`;
    });
    seekBar.addEventListener('change', () => {
        isSeeking = false;
        if (YT_AUDIO_MODE) {
            const dur = audioEl.duration;
            if (!dur || isNaN(dur) || !isFinite(dur)) return;
            audioEl.currentTime = (seekBar.value / 100) * dur;
            // Keep the muted video picture roughly in sync if it's present.
            if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
                try { ytPlayer.seekTo(audioEl.currentTime, true); } catch {}
            }
            return;
        }
        if (!ytPlayer || typeof ytPlayer.seekTo !== 'function') return;
        const dur = ytPlayer.getDuration();
        if (!dur || isNaN(dur)) return;
        ytPlayer.seekTo((seekBar.value / 100) * dur, true);
    });

    // Volume
    volumeBar.addEventListener('input', () => {
        const vol = Number(volumeBar.value);
        if (YT_AUDIO_MODE) {
            audioEl.muted  = vol === 0;
            audioEl.volume = Math.max(0, Math.min(1, vol / 100));
            return;
        }
        if (!ytPlayer || typeof ytPlayer.setVolume !== 'function') return;
        if (vol === 0) { ytPlayer.mute(); }
        else { ytPlayer.unMute(); ytPlayer.setVolume(vol); }
    });
}

// ── Audio element events (audio-mode playback authority) ───────────────────────

audioEl.addEventListener('ended', () => { advance(); });
audioEl.addEventListener('error', () => {
    if (!audioEl.src) return;            // ignore the empty-src reset
    console.error('Audio element error, advancing.');
    advance();
});
audioEl.addEventListener('playing', () => { if (CONTROLS) startPoll(); });
audioEl.addEventListener('pause',   () => { /* keep poll; user may resume via seek */ });

function clearYouTubeFallbackTimer() {
    if (ytFallbackTimer) {
        clearTimeout(ytFallbackTimer);
        ytFallbackTimer = null;
    }
}

function fallbackEmbed(videoId) {
    // Use enablejsapi=1 so we can still drive seek/volume from the controls.
    const origin = encodeURIComponent(window.location.origin);
    const src = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?enablejsapi=1&autoplay=1&controls=0&rel=0&modestbranding=1&playsinline=1&origin=${origin}`;
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
                            event.target.unMute();
                            if (CONTROLS && volumeBar) event.target.setVolume(Number(volumeBar.value));
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
    } finally {
        advancing = false;
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
    idleScreen.style.display   = 'none';
    spotifyFrame.style.display = 'none';
    ytContainer.style.display  = 'block';

    if (CONTROLS && seekBar)     { seekBar.value = 0; seekBar.disabled = false; }
    if (CONTROLS && timeDisplay) timeDisplay.textContent = '0:00 / 0:00';

    // 1) Start the audio (the part that must survive a background tab).
    audioEl.src = `/api/yt-audio/${encodeURIComponent(videoId)}`;
    if (CONTROLS && volumeBar) {
        const vol = Number(volumeBar.value);
        audioEl.muted  = vol === 0;
        audioEl.volume = Math.max(0, Math.min(1, vol / 100));
    } else {
        audioEl.muted  = false;
        audioEl.volume = 1;
    }
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
                playsinline:    1,
                controls:       0,
                rel:            0,
                modestbranding: 1,
                enablejsapi:    1,
                origin:         window.location.origin
            },
            events: {
                onReady(event) {
                    event.target.unMute();
                    if (CONTROLS && volumeBar) event.target.setVolume(Number(volumeBar.value));
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
    stopAudio();
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

// First user gesture: retry audio playback in case autoplay was blocked on a
// fresh window load. Cheap and safe — play() on an already-playing element is a
// no-op.
['click', 'keydown', 'touchstart', 'pointerdown'].forEach(ev =>
    window.addEventListener(ev, () => {
        if (YT_AUDIO_MODE && audioEl.src && audioEl.paused) {
            audioEl.play().catch(() => {});
        }
    }, { passive: true }));

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
