'use strict';

function getYouTubeId(url) {
    if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
    return String(url).match(/(?:youtube\.com\/(?:watch\?.*?v=|shorts\/|embed\/|v\/|e\/)|youtu\.be\/)([^"&?/\s]{11})/)?.[1] || null;
}
function getSpotifyInfo(url) {
    const match = String(url).match(/spotify\.com\/(track|album|playlist)\/([A-Za-z0-9]+)/);
    return match ? { type: match[1], id: match[2] } : null;
}

const params = new URLSearchParams(window.location.search);
const CHANNEL = (params.get('channel') || '').trim();
const VIDEO_ONLY = params.get('videoOnly') === '1' || window.name === 'mediashare_player';
const CONTROLS = !VIDEO_ONLY && params.get('controls') === '1';
const playerId = globalThis.crypto?.randomUUID?.() || `player_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
let volumePercent = 100;
let audioPaused = false;
let playbackMode = null;
let currentItemId = null;
let currentMediaItem = null;
let skipItemId = null;
let finishedItemId = null;
let currentFetchSequence = 0;
let trackDuration = 0;
let spotifySourceUrl = '';
let advancing = false;
let wakeLock = null;
let pollTimer = null;
let isSeeking = false;
let preparationSequence = 0;
let preparationTimer = null;
let preparingYouTube = false;
let playbackState = null;
let serverTimeOffset = null;
let clockRequest = null;
let mediaBuffering = false;
let pendingClockSeek = false;
let appliedSeekVersion = -1;

const idleScreen = document.getElementById('idle-screen');
const audioCard = document.getElementById('audio-card');
const audioTitle = document.getElementById('audio-title');
const spotifyFrame = document.getElementById('spotify-player');
const playbackStatus = document.getElementById('playback-status');
const playbackMessage = document.getElementById('playback-message');
const playbackRetryBtn = document.getElementById('playback-retry-btn');
const playbackSkipBtn = document.getElementById('playback-skip-btn');
const pauseResumeBtn = document.getElementById('pause-resume-btn');
const ctrlPanel = CONTROLS ? document.getElementById('player-controls') : null;
const seekBar = CONTROLS ? document.getElementById('seek-bar') : null;
const volumeBar = CONTROLS ? document.getElementById('volume-bar') : null;
const volumeInput = CONTROLS ? document.getElementById('volume-percent') : null;
const timeDisplay = CONTROLS ? document.getElementById('time-display') : null;

// A single native video element also plays audio-only files while hidden.
// Its one clock and gain control all MP3s and requested videos together.
const audioEl = document.getElementById('media-player');
audioEl.preload = 'auto';
audioEl.autoplay = false;
audioEl.defaultMuted = VIDEO_ONLY;
audioEl.muted = VIDEO_ONLY;
let audioOutput = null;

function ensureAudioOutput() {
    if (VIDEO_ONLY) return null;
    if (audioOutput) return audioOutput.context;
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextType) return null;
    const context = new AudioContextType();
    const gain = context.createGain();
    // Set the saved level before connecting, avoiding a full-volume first frame.
    gain.gain.value = volumePercent / 100;
    gain.connect(context.destination);
    const source = context.createMediaElementSource(audioEl);
    source.connect(gain);
    audioOutput = { context, source, gain };
    audioEl.volume = 1;
    return context;
}

function applyVolume(value = volumePercent) {
    const parsed = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : Number(value);
    if (!Number.isFinite(parsed)) return false;
    volumePercent = Math.max(0, Math.min(100, parsed));
    if (volumeBar) volumeBar.value = volumePercent;
    if (volumeInput && (volumeInput.value === '' || Number(String(volumeInput.value).replace(',', '.')) !== volumePercent))
        volumeInput.value = volumePercent;
    const level = volumePercent / 100;
    if (VIDEO_ONLY) audioEl.volume = 0;
    else if (audioOutput) {
        audioEl.volume = 1;
        const { context, gain } = audioOutput;
        const currentGain = gain.gain.value;
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setValueAtTime(currentGain, context.currentTime);
        // Ramp for 5 ms to prevent clicks, then use the exact linear gain:
        // 0.5% = 0.005, half the signal gain at 1% = 0.01.
        gain.gain.linearRampToValueAtTime(level, context.currentTime + 0.005);
    } else audioEl.volume = level;
    audioEl.muted = VIDEO_ONLY || level === 0;
    return true;
}

function showPlaybackMessage(message, error = false, preparing = false) {
    playbackStatus.hidden = VIDEO_ONLY || !message || (!error && !CONTROLS);
    playbackMessage.textContent = message;
    playbackRetryBtn.hidden = preparing;
}
function usesNativeAudio() { return playbackMode === 'youtube-audio' || playbackMode === 'youtube-video' || playbackMode === 'local'; }
function nativeAudioFailed() {
    if (!currentMediaItem || !usesNativeAudio()) return;
    stopAudio();
    if (VIDEO_ONLY) {
        currentItemId = null;
        preparationTimer = setTimeout(fetchAndPlay, 1000);
        return;
    }
    showPlaybackMessage(playbackMode.startsWith('youtube-')
        ? `YouTube ${playbackMode === 'youtube-video' ? 'video' : 'audio'} could not be loaded. Retry playback or skip this song.`
        : 'This MP3 could not be loaded. Retry playback or skip this song.', true);
}
function startNativeAudio() {
    if (!audioEl.src || preparingYouTube) return;
    if (pendingClockSeek) return;
    if (VIDEO_ONLY && (!playbackState?.running || !playbackState.started)) { audioEl.pause(); return; }
    if (audioPaused) { audioEl.pause(); return; }
    const requestedId = currentItemId;
    const stillCurrent = () => requestedId === currentItemId && usesNativeAudio();
    const failed = err => {
        if (!stillCurrent() || err?.name === 'AbortError') return;
        if (err?.name === 'NotAllowedError') showPlaybackMessage('Click Play / Retry to allow audio playback.', true);
        else nativeAudioFailed();
    };
    try {
        const context = ensureAudioOutput();
        applyVolume();
        if (context && context.state !== 'running') {
            showPlaybackMessage('Click Play / Retry to allow audio playback.', true);
            context.resume().then(() => {
                if (stillCurrent() && !audioPaused && context.state === 'running' && !audioEl.paused) showPlaybackMessage('');
            }).catch(err => { if (stillCurrent()) showPlaybackMessage('Click Play / Retry to allow audio playback.', true); });
        }
        const pending = audioEl.play();
        if (pending?.then) pending.then(() => {
            if (stillCurrent() && !audioPaused && (!audioOutput || audioOutput.context.state === 'running')) reportPlayback('playing');
        }).catch(failed);
    } catch (err) { failed(err); }
}

function clockPosition() {
    if (!playbackState) return 0;
    const elapsed = playbackState.running ? Math.max(0, Date.now() + (serverTimeOffset || 0) - playbackState.serverNow) / 1000 : 0;
    const duration = getPlaybackDuration() || playbackState.duration;
    return Math.max(0, Math.min(duration || Infinity, playbackState.position + elapsed));
}
function followPlaybackClock(force = false, resume = true) {
    if (!playbackState || playbackState.playbackId !== currentItemId || !usesNativeAudio() || !audioEl.src) return;
    const seekChanged = appliedSeekVersion !== playbackState.seekVersion;
    const leader = playbackState.leaderId === playerId;
    const delta = clockPosition() - (audioEl.currentTime || 0);
    const jumped = force || seekChanged || (!leader && Math.abs(delta) > 0.35);
    if (jumped) {
        try { audioEl.currentTime = clockPosition(); pendingClockSeek = false; }
        catch { pendingClockSeek = true; }
    }
    if (!pendingClockSeek) appliedSeekVersion = playbackState.seekVersion;
    // Small drift is corrected gently; larger drift and shared seeks jump to
    // the common position. The audible leader follows its actual media clock.
    audioEl.playbackRate = !jumped && !leader && Math.abs(delta) > 0.08 && Math.abs(delta) <= 0.35
        ? 1 + Math.max(-0.04, Math.min(0.04, delta * 0.12)) : 1;
    if (audioPaused || (VIDEO_ONLY && !playbackState.started)) { audioEl.pause(); return; }
    if (!playbackState.running && playbackState.started && !leader
        && (VIDEO_ONLY || playbackState.leaseUntil > Date.now() + (serverTimeOffset || 0))) {
        audioEl.pause(); return;
    }
    if (resume && audioEl.paused && !preparingYouTube && !pendingClockSeek) startNativeAudio();
}
function acceptPlaybackState(state, sentAt, receivedAt = Date.now()) {
    if (!state || state.playbackId !== currentItemId || !Number.isFinite(state.position)
        || !Number.isFinite(state.serverNow) || !Number.isFinite(state.revision)) return;
    if (playbackState && (state.revision < playbackState.revision
        || (state.revision === playbackState.revision && state.serverNow < playbackState.serverNow))) return;
    if (sentAt !== undefined) serverTimeOffset = state.serverNow - (sentAt + receivedAt) / 2;
    else if (serverTimeOffset === null) serverTimeOffset = state.serverNow - receivedAt;
    playbackState = state;
    acceptAudioSettings({ paused: state.paused }, state.settingsRevision);
    followPlaybackClock();
}
function syncPlayback(stateOverride) {
    if (!CHANNEL || !currentItemId || advancing) return Promise.resolve();
    const id = currentItemId;
    if (clockRequest?.id === id) {
        if (stateOverride) clockRequest.pending = stateOverride;
        return clockRequest.promise;
    }
    const request = { id, promise: null };
    clockRequest = request;
    const sentAt = Date.now();
    const reporting = !VIDEO_ONLY && usesNativeAudio() && audioEl.src && !preparingYouTube
        && (!audioOutput || audioOutput.context.state === 'running');
    const body = reporting ? { playbackId: id, clientId: playerId, position: audioEl.currentTime || 0,
        duration: getPlaybackDuration() || 0, state: stateOverride || (audioEl.paused ? 'paused' : mediaBuffering ? 'waiting' : 'playing'),
        seekVersion: playbackState?.seekVersion || 0, settingsRevision: serverAudioRevision,
        reportedAt: sentAt + (serverTimeOffset || 0) } : null;
    request.promise = (async () => {
        try {
            const res = await fetch(`/api/channels/${encodeURIComponent(CHANNEL)}/playback${reporting ? '/report' : ''}`,
                reporting ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (id !== currentItemId || advancing) return;
            if (data.playback && data.playback.playbackId !== id) { fetchAndPlay(); return; }
            acceptPlaybackState(data.playback, sentAt);
        } catch { /* A disconnected player keeps running and rejoins on reconnect. */ }
        finally {
            if (clockRequest === request) {
                clockRequest = null;
                if (request.pending && id === currentItemId && !advancing) reportPlayback(request.pending);
            }
        }
    })();
    return request.promise;
}
function reportPlayback(state) {
    if (VIDEO_ONLY || (audioOutput && audioOutput.context.state !== 'running')) return Promise.resolve();
    return syncPlayback(state);
}
async function seekPlayback(position) {
    const id = currentItemId;
    const sentAt = Date.now();
    try {
        const res = await fetch(`/api/channels/${encodeURIComponent(CHANNEL)}/playback/seek`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playbackId: id, position })
        });
        const data = await res.json();
        if (id !== currentItemId) return;
        if (!res.ok) throw new Error(data.error || 'Sign in to the dashboard to seek shared playback.');
        acceptPlaybackState(data.playback, sentAt);
        if (!audioPaused && !audioEl.paused) reportPlayback(mediaBuffering ? 'waiting' : 'playing');
    } catch (err) { if (id === currentItemId) showPlaybackMessage(err.message, true); }
}

function applyAudioSettings(settings) {
    const wasPaused = audioPaused;
    if (typeof settings.volume === 'number') applyVolume(settings.volume);
    if (typeof settings.paused === 'boolean') audioPaused = settings.paused;
    if (pauseResumeBtn) {
        pauseResumeBtn.textContent = audioPaused ? '▶ Resume' : '⏸ Pause';
        pauseResumeBtn.setAttribute('aria-pressed', String(audioPaused));
    }
    if (audioPaused) {
        audioEl.pause();
        stopPoll();
        if (playbackMode === 'spotify') spotifyFrame.src = 'about:blank';
    } else if (wasPaused) {
        if (usesNativeAudio() && audioEl.src) startNativeAudio();
        if (playbackMode === 'spotify') spotifyFrame.src = spotifySourceUrl;
        startPoll();
    }
}

// Keep the latest server state even during a local save. Only the locally edited
// field is optimistic; a pending volume edit must never swallow a remote Pause.
let pendingAudioSettings = {};
let audioSaveTimer = null;
let audioSettingsWrite = Promise.resolve();
let editSerial = 0;
const dirtyAudioFields = {};
let serverAudioRevision = -1;
let serverAudioSettings = { volume: 100, paused: false };
function acceptAudioSettings(settings, revision) {
    if (!settings || typeof settings !== 'object') return;
    if (!Number.isFinite(revision) || revision >= serverAudioRevision) {
        serverAudioSettings = { ...serverAudioSettings, ...settings };
        if (Number.isFinite(revision)) serverAudioRevision = revision;
    }
    const clean = {};
    for (const key of ['volume', 'paused']) if (!dirtyAudioFields[key]) clean[key] = serverAudioSettings[key];
    applyAudioSettings(clean);
}
async function loadSavedAudioSettings() {
    if (!CHANNEL) return;
    try {
        const res = await fetch(`/api/channels/${encodeURIComponent(CHANNEL)}/audio-settings`, { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        acceptAudioSettings(data.settings, data.revision);
    } catch { showPlaybackMessage('Saved audio settings could not be loaded. Check the server update and retry.'); }
}
function flushAudioSettings() {
    clearTimeout(audioSaveTimer);
    audioSaveTimer = null;
    if (!CHANNEL || !Object.keys(pendingAudioSettings).length) return audioSettingsWrite;
    const update = pendingAudioSettings;
    const serials = Object.fromEntries(Object.keys(update).map(key => [key, dirtyAudioFields[key]]));
    pendingAudioSettings = {};
    audioSettingsWrite = audioSettingsWrite.catch(() => {}).then(async () => {
        try {
            const res = await fetch(`/api/channels/${encodeURIComponent(CHANNEL)}/audio-settings`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update), keepalive: true
            });
            const data = await res.json();
            if (!res.ok) throw new Error(res.status === 401
                ? 'Sign in to the dashboard to save audio settings.' : data.error || 'Could not save audio settings.');
            for (const key of Object.keys(update)) if (dirtyAudioFields[key] === serials[key]) delete dirtyAudioFields[key];
            acceptAudioSettings(data.settings, data.revision);
        } catch (err) {
            for (const key of Object.keys(update)) if (dirtyAudioFields[key] === serials[key]) delete dirtyAudioFields[key];
            acceptAudioSettings(serverAudioSettings, serverAudioRevision);
            showPlaybackMessage(err.message, true);
        }
    });
    return audioSettingsWrite;
}
function saveAudioSettings(update, immediate = false) {
    for (const key of Object.keys(update)) dirtyAudioFields[key] = ++editSerial;
    pendingAudioSettings = { ...pendingAudioSettings, ...update };
    clearTimeout(audioSaveTimer);
    if (immediate) return flushAudioSettings();
    audioSaveTimer = setTimeout(flushAudioSettings, 250);
}
function setAudioPaused(paused, persist = true) {
    applyAudioSettings({ paused });
    if (persist) return saveAudioSettings({ paused }, true);
}

function formatTime(sec) {
    sec = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
    return `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`;
}
function getPlaybackDuration() {
    return Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : trackDuration;
}
function updateProgress() {
    if (!CONTROLS || isSeeking || !usesNativeAudio()) return;
    const duration = getPlaybackDuration();
    seekBar.disabled = !duration || !!(audioEl.seekable && !audioEl.seekable.length);
    seekBar.value = duration > 0 ? Math.max(0, Math.min(100, audioEl.currentTime / duration * 100)) : 0;
    timeDisplay.textContent = `${formatTime(audioEl.currentTime)} / ${duration > 0 ? formatTime(duration) : '--:--'}`;
}
function startPoll() {
    if (!CONTROLS) return;
    updateProgress();
    if (!pollTimer) pollTimer = setInterval(updateProgress, 250);
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

if (pauseResumeBtn) pauseResumeBtn.addEventListener('click', () => setAudioPaused(!audioPaused));
playbackRetryBtn.addEventListener('click', () => {
    if (!currentMediaItem) return;
    if (usesNativeAudio() && audioEl.src) { startNativeAudio(); return; }
    // Unlock the output during the gesture, before asynchronous preparation.
    try { ensureAudioOutput()?.resume().catch(() => {}); } catch {}
    const item = currentMediaItem;
    currentItemId = null;
    return playItem(item, { retry: true });
});
playbackSkipBtn.addEventListener('click', () => advance());
if (CONTROLS) {
    ctrlPanel.style.display = 'flex';
    document.getElementById('player-container').style.background = '#11151c';
    seekBar.addEventListener('pointerdown', () => { isSeeking = true; });
    window.addEventListener('pointerup', () => { isSeeking = false; });
    window.addEventListener('pointercancel', () => { isSeeking = false; });
    seekBar.addEventListener('blur', () => { isSeeking = false; });
    seekBar.addEventListener('input', () => {
        const duration = getPlaybackDuration();
        if (duration) timeDisplay.textContent = `${formatTime(seekBar.value / 100 * duration)} / ${formatTime(duration)}`;
    });
    seekBar.addEventListener('change', () => {
        isSeeking = false;
        const duration = getPlaybackDuration();
        if (!duration || !usesNativeAudio()) return;
        try { audioEl.currentTime = seekBar.value / 100 * duration; return seekPlayback(audioEl.currentTime); }
        catch { showPlaybackMessage('This part of the audio has not loaded yet.'); }
    });
    volumeBar.addEventListener('input', () => { applyVolume(volumeBar.value); saveAudioSettings({ volume: volumePercent }); });
    volumeBar.addEventListener('change', () => saveAudioSettings({ volume: volumePercent }, true));
    volumeInput.addEventListener('input', () => {
        if (volumeInput.value !== '' && applyVolume(volumeInput.value)) saveAudioSettings({ volume: volumePercent });
    });
    volumeInput.addEventListener('change', () => {
        if (!applyVolume(volumeInput.value === '' ? volumePercent : volumeInput.value)) { volumeInput.value = volumePercent; return; }
        saveAudioSettings({ volume: volumePercent }, true);
    });
}
applyVolume();
audioEl.addEventListener('ended', () => { if (!VIDEO_ONLY && usesNativeAudio() && !audioPaused) advance(); });
audioEl.addEventListener('error', () => { if (audioEl.src && usesNativeAudio()) nativeAudioFailed(); });
audioEl.addEventListener('playing', () => {
    if (audioPaused) { audioEl.pause(); return; }
    if (usesNativeAudio()) {
        mediaBuffering = false;
        reportPlayback('playing');
        if (!audioOutput || audioOutput.context.state === 'running') showPlaybackMessage('');
        startPoll();
    }
});
['timeupdate', 'durationchange', 'seeked', 'progress'].forEach(event => audioEl.addEventListener(event, updateProgress));
audioEl.addEventListener('loadedmetadata', () => { followPlaybackClock(true); updateProgress(); });
const reportBuffering = () => { mediaBuffering = true; reportPlayback('waiting'); };
audioEl.addEventListener('waiting', reportBuffering);
audioEl.addEventListener('stalled', () => { if (audioEl.readyState < 3) reportBuffering(); });
audioEl.addEventListener('volumechange', () => { if (VIDEO_ONLY) { audioEl.muted = true; audioEl.volume = 0; } });

function stopAudio() {
    try { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); } catch {}
    audioEl.playbackRate = 1;
    mediaBuffering = false;
    pendingClockSeek = false;
}
function cancelPreparation() {
    preparationSequence++;
    clearTimeout(preparationTimer);
    preparationTimer = null;
    preparingYouTube = false;
}
function showIdle() {
    cancelPreparation();
    playbackMode = null;
    isSeeking = false;
    idleScreen.style.display = VIDEO_ONLY ? 'none' : 'flex';
    audioCard.hidden = true;
    audioEl.hidden = true;
    spotifyFrame.style.display = 'none';
    spotifyFrame.src = '';
    stopAudio();
    currentItemId = null;
    currentMediaItem = null;
    playbackState = null;
    appliedSeekVersion = -1;
    trackDuration = 0;
    showPlaybackMessage('');
    stopPoll();
    if (seekBar) { seekBar.value = 0; seekBar.disabled = true; }
    if (timeDisplay) timeDisplay.textContent = '0:00 / 0:00';
}
async function prepareYouTubeMedia(videoId, itemId, retry = false, sequence = preparationSequence) {
    const mediaType = playbackMode === 'youtube-video' ? 'video' : 'audio';
    const stillCurrent = () => sequence === preparationSequence && itemId === currentItemId && playbackMode === 'youtube-' + mediaType;
    if (!stillCurrent()) return;
    preparingYouTube = true;
    showPlaybackMessage(`Preparing YouTube ${mediaType}…`, false, true);
    try {
        const res = await fetch(`/api/yt-${mediaType}/${encodeURIComponent(videoId)}/info${retry ? '?retry=1' : ''}`);
        const data = await res.json();
        if (!stillCurrent()) return;
        if (data.status === 'failed' && data.code === 'YOUTUBE_UNAVAILABLE') {
            preparingYouTube = false;
            if (VIDEO_ONLY) return;
            showPlaybackMessage('Skipping unavailable video…');
            return advance({ mediaType, videoId });
        }
        if (!res.ok || data.status === 'failed') throw new Error(data.error || 'The server could not prepare this song. Retry playback or skip it.');
        if (res.status === 202 || data.status === 'preparing') {
            const message = data.stage === 'downloading' ? `Downloading YouTube ${mediaType}…`
                : data.stage === 'queued' ? 'Waiting to download this song…' : `Preparing and checking ${mediaType}…`;
            showPlaybackMessage(message, false, true);
            preparationTimer = setTimeout(() => prepareYouTubeMedia(videoId, itemId, false, sequence),
                Math.max(500, Math.min(5000, Number(data.retryAfterMs) || 1000)));
            return;
        }
        if (Number.isFinite(data.duration) && data.duration > 0) trackDuration = data.duration;
        preparingYouTube = false;
        showPlaybackMessage('');
        audioEl.src = `/api/yt-${mediaType}/${encodeURIComponent(videoId)}`;
        applyVolume();
        followPlaybackClock(true, false);
        startNativeAudio();
        startPoll();
        updateProgress();
    } catch (err) {
        if (!stillCurrent()) return;
        preparingYouTube = false;
        showPlaybackMessage(err.message || 'Could not prepare this song. Retry playback or skip it.', true);
    }
}
function playNative(item, source, mode, clock) {
    playbackMode = mode;
    isSeeking = false;
    trackDuration = Number.isFinite(item.duration) && item.duration > 0 ? item.duration : 0;
    idleScreen.style.display = 'none';
    spotifyFrame.style.display = 'none';
    audioEl.hidden = mode !== 'youtube-video';
    audioCard.hidden = !CONTROLS || mode === 'youtube-video';
    audioTitle.textContent = item.song_name || item.title || (mode === 'local' ? 'Local audio' : 'YouTube audio');
    if (seekBar) { seekBar.value = 0; seekBar.disabled = !trackDuration; }
    acceptPlaybackState(clock);
    applyVolume();
    if (source) { audioEl.src = source; followPlaybackClock(true, false); startNativeAudio(); }
    startPoll();
}
function playItem(item, { retry = false, playback } = {}) {
    if (!item) { showIdle(); return; }
    const url = item.url || item.media || '';
    const platform = (item.platform || item.Platform || '').toLowerCase();
    const id = item._playbackId || item.id || `${platform}|${url}|${item.song_name || ''}|${item.username || ''}`;
    if (VIDEO_ONLY && (item._source !== 'requests' || !getYouTubeId(url))) { showIdle(); return; }
    if (id === currentItemId) { acceptPlaybackState(playback); return; }
    if (id === skipItemId || id === finishedItemId) { showIdle(); return; }
    cancelPreparation();
    stopAudio();
    stopPoll();
    spotifyFrame.src = '';
    audioEl.hidden = true;
    showPlaybackMessage('');
    skipItemId = null;
    currentItemId = id;
    currentMediaItem = item;
    playbackState = null;
    appliedSeekVersion = -1;
    if (platform === 'local' || /(\/|%2F)api(\/|%2F)local-media(\/|%2F)/.test(url)) {
        const cleanUrl = /^%2fapi%2flocal-media%2f/i.test(url) ? decodeURIComponent(url) : url;
        playNative(item, cleanUrl, 'local', playback);
        return;
    }
    const videoId = getYouTubeId(url);
    if (videoId) {
        // The server labels viewer requests explicitly. Personal songs never
        // reveal video, even if they happen to use the same YouTube ID.
        playNative(item, null, item._source === 'requests' ? 'youtube-video' : 'youtube-audio', playback);
        return prepareYouTubeMedia(videoId, id, retry);
    }
    const spotify = getSpotifyInfo(url);
    if (spotify) {
        playbackMode = 'spotify';
        idleScreen.style.display = 'none';
        audioCard.hidden = true;
        spotifyFrame.style.display = 'block';
        spotifySourceUrl = `https://open.spotify.com/embed/${spotify.type}/${spotify.id}?utm_source=generator&autoplay=1`;
        spotifyFrame.src = audioPaused ? 'about:blank' : spotifySourceUrl;
        if (seekBar) { seekBar.value = 0; seekBar.disabled = true; }
        if (timeDisplay) timeDisplay.textContent = 'Spotify';
        return;
    }
    showPlaybackMessage('This media link cannot be played. Retry playback or skip this song.', true);
}

async function advance(unavailable = null) {
    if (VIDEO_ONLY || !CHANNEL || advancing) return;
    advancing = true;
    const playbackId = currentItemId;
    currentFetchSequence++;
    skipItemId = currentItemId;
    finishedItemId = currentItemId;
    showIdle();
    try {
        const res = await fetch(`/api/channels/${encodeURIComponent(CHANNEL)}/next`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playbackId, ...(unavailable ? { unavailable } : {}) })
        });
        if (!res.ok) throw new Error(res.status);
        if (unavailable && !(await res.json()).advanced) {
            skipItemId = null;
            finishedItemId = null;
        }
    } catch (err) {
        console.error('Failed to advance queue', err);
        skipItemId = null;
        finishedItemId = null;
    } finally { advancing = false; fetchAndPlay(); }
}
async function fetchAndPlay() {
    if (!CHANNEL) { showIdle(); return; }
    if (advancing) return;
    const sequence = ++currentFetchSequence;
    try {
        const res = await fetch(`/api/channels/${encodeURIComponent(CHANNEL)}/current${VIDEO_ONLY ? '?observe=1' : ''}`);
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        if (sequence !== currentFetchSequence || advancing) return;
        if (!data.current) finishedItemId = null;
        await playItem(data.current, { playback: data.playback });
    } catch (err) {
        if (sequence !== currentFetchSequence || advancing) return;
        console.error('Failed to fetch current item', err);
        showIdle();
    }
}
async function requestWakeLock() {
    try {
        if (navigator.wakeLock?.request) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        }
    } catch { /* Playback does not depend on the optional screen wake lock. */ }
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        if (!wakeLock) requestWakeLock();
        syncPlayback();
        if (usesNativeAudio() && audioEl.src && !audioPaused) startNativeAudio();
    }
});
['click', 'keydown', 'touchstart', 'pointerdown'].forEach(event => window.addEventListener(event, () => {
    if (usesNativeAudio() && audioEl.src && !audioPaused
        && (audioEl.paused || (audioOutput && audioOutput.context.state !== 'running'))) startNativeAudio();
}, { passive: true }));
if (CHANNEL) {
    const socket = io();
    socket.on('connect', () => { socket.emit('join:channel', CHANNEL); loadSavedAudioSettings(); syncPlayback(); });
    socket.on('queue:update', (payload = {}) => { if (!payload.channel || payload.channel === CHANNEL) fetchAndPlay(); });
    socket.on('audio:settings', ({ channel, settings, revision }) => { if (channel === CHANNEL) acceptAudioSettings(settings, revision); });
    socket.on('playback:sync', state => { if (state?.channel === CHANNEL) acceptPlaybackState(state); });
    setInterval(syncPlayback, 2000);
    setInterval(() => { if (!advancing) { fetchAndPlay(); loadSavedAudioSettings(); } }, 10000);
    requestWakeLock();
}
async function initOverlay() { await loadSavedAudioSettings(); await fetchAndPlay(); }
initOverlay();
