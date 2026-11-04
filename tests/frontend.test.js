'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setImmediate: nextTick } = require('node:timers/promises');
const { createTestServer } = require('./helpers/server');
const { createDownloader } = require('./helpers/downloader');

// Exercise the real frontend event handlers against the real local API.
// Minimal DOM/audio stand-ins keep this suite runnable without a browser or
// live media services; these checks do not claim to verify visual layout.
function frontend(h, file, cookie, options = {}) {
    const elements = new Map();
    const errors = [];
    const audios = [];
    const plays = [];
    const outputs = [];
    const windowHandlers = new Map();
    const documentHandlers = new Map();
    const socketHandlers = new Map();
    const timers = new Map();
    let timerSerial = 0;
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            id, value: '', textContent: '', innerHTML: '', checked: false,
            disabled: false, style: {}, dataset: {}, handlers: new Map(), attributes: {},
            setAttribute(name, value) { this.attributes[name] = value; },
            getAttribute(name) { return this.attributes[name]; },
            removeAttribute(name) { delete this.attributes[name]; },
            classList: { add() {}, remove() {}, toggle() {} },
            addEventListener(event, handler) { this.handlers.set(event, handler); },
            querySelectorAll() { return []; }, querySelector() { return null; },
            async fire(event, data = {}) { return this.handlers.get(event)?.(data); }
        });
        if (id === 'media-player' && !elements.get(id).mediaInitialized) {
            const media = elements.get(id);
            Object.assign(media, { mediaInitialized: true, src: '', paused: true, currentTime: 0, duration: NaN,
                play() { this.paused = false; plays.push(this.src); return Promise.resolve(); },
                pause() { this.paused = true; }, load() {},
                removeAttribute(name) { if (name === 'src') this.src = ''; delete this.attributes[name]; } });
            audios.push(media);
        }
        return elements.get(id);
    }
    const tabs = ['requests', 'mylist', 'local'].map(tab => {
        const li = element('tab-' + tab);
        li.dataset.tab = tab;
        return li;
    });
    element('queue-type-tabs').querySelectorAll = () => tabs;
    const context = vm.createContext({
        document: { getElementById: element, addEventListener(event, handler) { documentHandlers.set(event, handler); }, visibilityState: 'visible', hidden: false },
        window: { location: { origin: h.base, search: options.search || '?channel=alice&controls=1', href: '' },
            addEventListener(event, handler) { windowHandlers.set(event, handler); },
            ...(options.audioContext === false ? {} : { AudioContext: class {
                constructor() { this.state = options.suspended ? 'suspended' : 'running'; this.currentTime = 0; this.destination = {}; outputs.push(this); }
                createGain() { this.gain = { value: 1, cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime(value) { this.value = value; } };
                    return { gain: this.gain, connect: target => { this.destinationTarget = target; this.levelAtConnect = this.gain.value; } }; }
                createMediaElementSource(audio) { this.audio = audio; this.sourceCount = (this.sourceCount || 0) + 1; return { connect: target => { this.sourceTarget = target; } }; }
                resume() { if (!options.blockResume) this.state = 'running'; return Promise.resolve(); }
            } }) },
        navigator: {}, URLSearchParams, FormData, Blob,
        console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
        setTimeout(callback, delay) { const id = ++timerSerial; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }, setInterval() { return 1; }, clearInterval() {},
        io: () => ({ on(event, handler) { socketHandlers.set(event, handler); }, emit() {} }),
        fetch: (url, request = {}) => /\/api\/yt-(?:audio|video)\/[A-Za-z0-9_-]{11}\/info(?:\?|$)/.test(url)
            ? (options.info ? options.info(url) : Promise.resolve(new Response(JSON.stringify({ status: 'ready', duration: 180 }), { headers: { 'Content-Type': 'application/json' } })))
            : fetch(h.base + url, { ...request, headers: { ...request.headers, ...(cookie ? { Cookie: cookie } : {}) } }),
    });
    const source = fs.readFileSync(path.resolve(__dirname, '../scrs/frontend', file), 'utf8');
    const ready = vm.runInContext(source, context, { filename: file });
    return { context, elements, errors, audios, plays, outputs, windowHandlers, documentHandlers, ready,
        runTimer(delay) {
            const next = [...timers].find(([, timer]) => timer.delay === delay);
            if (!next) throw new Error('No timer for ' + delay);
            timers.delete(next[0]); return next[1].callback();
        },
        emitSocket: (event, payload) => socketHandlers.get(event)?.(payload),
        run: code => vm.runInContext(code, context) };
}

async function until(predicate) {
    for (let i = 0; i < 1000; i++) {
        if (predicate()) return;
        await nextTick();
    }
    throw new Error('Frontend did not reach expected state');
}

async function setup(t, options = {}) {
    const h = await createTestServer({ random: () => 0, ...options });
    t.after(() => h.close());
    const cookie = await h.login();
    h.api = (url, method = 'GET', body) => h.request(url, { method, body, cookie });
    h.cookie = cookie;
    h.add = id => h.api('/api/mylist/alice/add', 'POST', { url: 'https://youtu.be/' + id });
    return h;
}

test('dashboard handlers save loop, shuffle the list and restore channel settings on reload', async t => {
    const h = await setup(t);
    const ui = frontend(h, 'main.js', h.cookie);
    await ui.ready;
    await ui.run('loadMode()');
    await ui.elements.get('tab-mylist').fire('click');
    await ui.run('loadMyList()');
    const shuffle = ui.elements.get('mylist-shuffle-btn');
    assert.equal(shuffle.disabled, true);
    const input = ui.elements.get('mylist-url-input');
    const add = ui.elements.get('mylist-add-btn');
    input.value = 'https://youtu.be/AAAAAAAAAAA';
    await add.fire('click');
    assert.equal(shuffle.disabled, true);
    input.value = 'https://youtu.be/BBBBBBBBBBB';
    await add.fire('click');
    assert.equal(shuffle.disabled, false);
    const loop = ui.elements.get('mylist-loop-btn');
    await loop.fire('click');
    assert.equal((await h.api('/api/mode/alice')).data.mylistLoop, true);
    assert.equal(ui.elements.get('mylist-playback-status').textContent, 'Loop on.');
    const before = (await h.api('/api/mylist/alice')).data.items.map(item => item.title);
    await shuffle.fire('click');
    const after = (await h.api('/api/mylist/alice')).data.items.map(item => item.title);
    assert.deepEqual(after, before.reverse());
    assert.equal(ui.elements.get('mylist-playback-status').textContent, 'My List shuffled.');
    const reload = frontend(h, 'main.js', h.cookie);
    await reload.ready;
    await reload.run('loadMode()');
    assert.equal(reload.elements.get('mylist-loop-btn').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(ui.errors, []);
    assert.deepEqual(reload.errors, []);
});

test('failed loop saves restore the button and show an actionable error', async t => {
    const h = await setup(t);
    const ui = frontend(h, 'main.js', h.cookie);
    await ui.ready;
    await ui.run('loadMode()');
    const original = ui.context.fetch;
    ui.context.fetch = (url, options = {}) => options.method === 'POST' && url === '/api/mode/alice'
        ? Promise.resolve(new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }))
        : original(url, options);
    const loop = ui.elements.get('mylist-loop-btn');
    await loop.fire('click');
    assert.equal(loop.getAttribute('aria-pressed'), 'false');
    assert.equal(loop.disabled, false);
    assert.match(ui.elements.get('mylist-playback-status').textContent, /Please try again/);
});

test('Loop and Shuffle are real buttons above every tab panel', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../HTML/main.html'), 'utf8');
    const toolbar = html.indexOf('id="mylist-playback-controls"');
    const tabs = html.indexOf('id="queue-type-tabs"');
    assert.ok(toolbar > 0 && toolbar < tabs);
    for (const id of ['mylist-loop-btn', 'mylist-shuffle-btn']) {
        const position = html.indexOf(`id="${id}"`);
        assert.ok(position > toolbar && position < tabs);
        assert.match(html.slice(html.lastIndexOf('<button', position), html.indexOf('>', position)), /type="button"/);
    }
    assert.equal(html.includes('mylist-loop-toggle'), false);
});

test('Local Music imports and loads saved YouTube links and restores them on reload', async t => {
    const downloader = createDownloader();
    const h = await setup(t, { spawn: downloader.spawn });
    const ui = frontend(h, 'main.js', h.cookie);
    await ui.ready;
    await ui.elements.get('tab-local').fire('click');
    ui.elements.get('local-playlist-url').value = 'https://youtube.com/playlist?list=PLtest123';
    await ui.elements.get('local-playlist-import-btn').fire('click');
    await h.settleImport();
    await ui.run('loadLocalImport()');
    await ui.run('loadLocalFiles()');
    assert.match(ui.elements.get('local-playlist-status').textContent, /Playlist saved and loaded: 2 songs saved/);
    assert.equal(ui.elements.get('local-playlist-import-btn').disabled, false);
    assert.equal(ui.elements.get('local-playlist-cancel-btn').hidden, true);
    assert.match(ui.elements.get('local-saved-playlists').innerHTML, /Test playlist/);
    assert.equal(ui.elements.get('local-queue-folder-btn').disabled, true);
    const list = (await h.api('/api/mylist/alice')).data.items;
    assert.equal(list.length, 2);
    assert.ok(list.every(item => item.platform === 'youtube'));
    assert.equal(ui.elements.get('mylist-shuffle-btn').disabled, false);
    await ui.elements.get('mylist-loop-btn').fire('click');
    assert.equal((await h.api('/api/mode/alice')).data.mylistLoop, true);
    const reload = frontend(h, 'main.js', h.cookie);
    await reload.ready;
    await reload.run('loadLocalImport()');
    assert.match(reload.elements.get('local-playlist-status').textContent, /2 songs saved/);
    assert.deepEqual(ui.errors, []);
    assert.deepEqual(reload.errors, []);
});

test('playlist import button displays invalid URL feedback and can be retried', async t => {
    const h = await setup(t);
    const ui = frontend(h, 'main.js', h.cookie);
    await ui.ready;
    ui.elements.get('local-playlist-url').value = 'https://example.com/playlist?list=bad';
    await ui.elements.get('local-playlist-import-btn').fire('click');
    assert.match(ui.elements.get('local-playlist-status').textContent, /YouTube playlist URL/);
    assert.equal(ui.elements.get('local-playlist-import-btn').disabled, false);
});

test('the cancellation button stops reading metadata and keeps the music list', async t => {
    const downloader = createDownloader({ blockMetadata: true });
    const h = await setup(t, { spawn: downloader.spawn });
    const ui = frontend(h, 'main.js', h.cookie);
    await ui.ready;
    ui.elements.get('local-playlist-url').value = 'https://youtube.com/playlist?list=PLtest123';
    await ui.elements.get('local-playlist-import-btn').fire('click');
    await until(() => downloader.blocked.length > 0);
    assert.equal(ui.elements.get('local-playlist-cancel-btn').hidden, false);
    await ui.elements.get('local-playlist-cancel-btn').fire('click');
    await h.settleImport();
    await ui.run('loadLocalImport()');
    assert.match(ui.elements.get('local-playlist-status').textContent, /Import cancelled/);
    assert.equal(ui.elements.get('local-playlist-import-btn').disabled, false);
});

test('overlay ended events restart a one-song loop without replaying it on ordinary polls', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    await h.api('/api/mode/alice', 'POST', { mylistLoop: true });
    const ui = frontend(h, 'overlay.js');
    await ui.ready;
    assert.deepEqual(ui.plays, ['/api/yt-audio/AAAAAAAAAAA']);
    await ui.run('fetchAndPlay()');
    assert.equal(ui.plays.length, 1);
    const firstId = ui.run('currentItemId');
    ui.audios[0].handlers.get('ended')();
    ui.audios[0].handlers.get('ended')(); // duplicate native event while advancing
    await until(() => ui.plays.length === 2);
    assert.notEqual(ui.run('currentItemId'), firstId);
    assert.deepEqual(ui.plays, ['/api/yt-audio/AAAAAAAAAAA', '/api/yt-audio/AAAAAAAAAAA']);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
    assert.deepEqual(ui.errors, []);
});

test('overlay ignores a stale current response arriving after advancement', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    await h.api('/api/mode/alice', 'POST', { mylistLoop: true });
    const ui = frontend(h, 'overlay.js');
    await ui.ready;
    const original = ui.context.fetch;
    let release;
    let held = false;
    let holdNext = true;
    ui.context.fetch = async (url, options) => {
        const res = await original(url, options);
        if (holdNext && url.endsWith('/current')) {
            holdNext = false;
            held = true;
            await new Promise(resolve => { release = resolve; });
        }
        return res;
    };
    const stale = ui.run('fetchAndPlay()');
    await until(() => held);
    await ui.run('advance()');
    await until(() => ui.plays.length === 2);
    const newId = ui.run('currentItemId');
    release();
    await stale;
    assert.equal(ui.run('currentItemId'), newId);
    assert.equal(ui.plays.length, 2);
    assert.deepEqual(ui.errors, []);
});

test('a failed personal YouTube song stays queued with its video hidden', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const ui = frontend(h, 'overlay.js');
    await ui.ready;
    const id = ui.run('currentItemId');
    ui.audios[0].handlers.get('error')();
    assert.equal(ui.run('playbackMode'), 'youtube-audio');
    assert.equal(ui.run('currentItemId'), id);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
    assert.match(ui.elements.get('playback-message').textContent, /YouTube audio could not be loaded/);
    assert.equal(ui.context.window.onYouTubeIframeAPIReady, undefined);
    await ui.elements.get('playback-retry-btn').fire('click');
    assert.equal(ui.plays.length, 2);
    await ui.elements.get('playback-skip-btn').fire('click');
    await until(() => h.calls.some(call => call.action === 'removemedia'));
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
});

test('legacy iframe parameters still use one native audio output and only its ending advances', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const ui = frontend(h, 'overlay.js', undefined, { search: '?channel=alice&controls=1&ytmode=iframe' });
    await ui.ready;
    assert.equal(ui.run('playbackMode'), 'youtube-audio');
    assert.equal(ui.plays.length, 1);
    assert.equal(ui.outputs.length, 1);
    assert.equal(ui.outputs[0].sourceCount, 1);
    ui.audios[0].handlers.get('ended')();
    await until(() => h.calls.some(call => call.action === 'removemedia'));
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
});

test('autoplay denial keeps native playback selected and offers a user-gesture retry', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const ui = frontend(h, 'overlay.js');
    await ui.ready;
    const audio = ui.audios[0];
    audio.play = () => Promise.reject(Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' }));
    ui.run('startNativeAudio()');
    await nextTick();
    assert.equal(ui.run('playbackMode'), 'youtube-audio');
    assert.match(ui.elements.get('playback-message').textContent, /allow audio playback/);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
    audio.play = () => Promise.resolve();
    await ui.elements.get('playback-retry-btn').fire('click');
    assert.equal(ui.run('playbackMode'), 'youtube-audio');
});

test('a failed local MP3 stays queued for Retry or an explicit Skip', async t => {
    const h = await setup(t);
    fs.mkdirSync(path.join(h.localRoot, 'alice'), { recursive: true });
    fs.writeFileSync(path.join(h.localRoot, 'alice', 'test.mp3'), 'test');
    await h.api('/api/local/alice/queue', 'POST', { filename: 'test.mp3' });
    const ui = frontend(h, 'overlay.js');
    await ui.ready;
    const id = ui.run('currentItemId');
    ui.audios[0].handlers.get('error')();
    assert.equal(ui.run('currentItemId'), id);
    assert.match(ui.elements.get('playback-message').textContent, /MP3 could not be loaded/);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
    await ui.elements.get('playback-retry-btn').fire('click');
    assert.equal(ui.plays.length, 2);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
});

test('volume is restored per user channel and saved after editing the player control', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    await h.api('/api/channels/alice/audio-settings', 'POST', { volume: 23.5 });
    const ui = frontend(h, 'overlay.js', h.cookie);
    await ui.ready;
    assert.equal(ui.run('volumePercent'), 23.5);
    assert.equal(ui.audios[0].volume, 1);
    assert.equal(ui.outputs[0].gain.value, 0.235);
    assert.equal(ui.elements.get('volume-percent').value, 23.5);
    ui.elements.get('volume-percent').value = '37.5';
    await ui.elements.get('volume-percent').fire('change');
    await ui.run('flushAudioSettings()');
    assert.equal((await h.api('/api/channels/alice/audio-settings')).data.settings.volume, 37.5);
    assert.equal((await h.api('/api/channels/bob/audio-settings')).data.settings.volume, 100);
    const reload = frontend(h, 'overlay.js', h.cookie);
    await reload.ready;
    assert.equal(reload.run('volumePercent'), 37.5);
});

test('restored pause prevents autoplay and Pause/Resume controls the native audio without skipping', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    await h.api('/api/channels/alice/audio-settings', 'POST', { volume: 40, paused: true });
    const ui = frontend(h, 'overlay.js', h.cookie);
    await ui.ready;
    assert.equal(ui.plays.length, 0);
    assert.equal(ui.audios[0].autoplay, false);
    assert.equal(ui.elements.get('pause-resume-btn').getAttribute('aria-pressed'), 'true');
    await ui.elements.get('pause-resume-btn').fire('click');
    assert.equal(ui.audios[0].paused, false);
    assert.equal(ui.plays.length, 1);
    await ui.elements.get('pause-resume-btn').fire('click');
    assert.equal(ui.audios[0].paused, true);
    assert.equal((await h.api('/api/channels/alice/audio-settings')).data.settings.paused, true);
    ui.elements.get('volume-percent').value = '18.25';
    await ui.elements.get('volume-percent').fire('change');
    await ui.run('flushAudioSettings()');
    assert.equal(ui.audios[0].paused, true);
    assert.equal((await h.api('/api/channels/alice/audio-settings')).data.settings.volume, 18.25);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
});

test('audio-only controls work without loading YouTube scripts, iframe mounts or visibility shims', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../HTML/overlay.html'), 'utf8');
    assert.equal(html.includes('youtube.com/iframe_api'), false);
    assert.equal(html.includes('id="yt-player"'), false);
    assert.equal(html.includes('Object.defineProperty(document'), false);
    assert.match(html, /id="audio-card"/);
    assert.match(html, /id="audio-title"/);
});

test('dashboard pause broadcasts to both preview and anonymous OBS without changing the song', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const dashboard = frontend(h, 'main.js', h.cookie);
    await dashboard.ready;
    await dashboard.run('loadChannelAudioSettings()');
    const preview = frontend(h, 'overlay.js', h.cookie);
    const obs = frontend(h, 'overlay.js');
    await Promise.all([preview.ready, obs.ready]);
    const playing = obs.run('currentItemId');
    await dashboard.elements.get('pause-current-btn').fire('click');
    const paused = h.events.filter(event => event.event === 'audio:settings').at(-1).payload;
    preview.emitSocket('audio:settings', paused);
    obs.emitSocket('audio:settings', paused);
    assert.equal(preview.audios[0].paused, true);
    assert.equal(obs.audios[0].paused, true);
    assert.equal(obs.run('currentItemId'), playing);
    await dashboard.elements.get('pause-current-btn').fire('click');
    const resumed = h.events.filter(event => event.event === 'audio:settings').at(-1).payload;
    preview.emitSocket('audio:settings', resumed);
    obs.emitSocket('audio:settings', resumed);
    assert.equal(preview.audios[0].paused, false);
    assert.equal(obs.audios[0].paused, false);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
});

test('saved playlist Load and Delete buttons act on the saved snapshot', async t => {
    const downloader = createDownloader();
    const h = await setup(t, { spawn: downloader.spawn });
    await h.api('/api/local/alice/playlist-import', 'POST', { url: 'https://youtube.com/playlist?list=PLtest123' });
    await h.settleImport();
    const ui = frontend(h, 'main.js', h.cookie);
    await ui.ready;
    function button(dataset) {
        return { dataset, handlers: {}, disabled: false,
            addEventListener(name, handler) { this.handlers[name] = handler; },
            fire(name) { return this.handlers[name](); } };
    }
    const load = button({ playlistLoad: 'PLtest123' });
    const remove = button({ playlistDelete: 'PLtest123' });
    ui.elements.get('local-saved-playlists').querySelectorAll = selector => selector.includes('data-playlist-load') ? [load] : [remove];
    await ui.run('loadLocalPlaylists()');
    await h.add('CCCCCCCCCCC');
    assert.equal((await h.api('/api/mylist/alice')).data.items.length, 3);
    await load.fire('click');
    assert.equal((await h.api('/api/mylist/alice')).data.items.length, 2);
    assert.equal(load.disabled, false);
    assert.match(ui.elements.get('mylist-playback-status').textContent, /My List replaced with 2/);
    await remove.fire('click');
    assert.equal((await h.api('/api/local/alice/playlists')).data.playlists.length, 0);
    assert.equal((await h.api('/api/mylist/alice')).data.items.length, 2);
    assert.deepEqual(ui.errors, []);
});

test('pasting a playlist in My List saves it and replaces previous songs too', async t => {
    const downloader = createDownloader();
    const h = await setup(t, { spawn: downloader.spawn });
    await h.add('CCCCCCCCCCC');
    const ui = frontend(h, 'main.js', h.cookie);
    await ui.ready;
    ui.elements.get('mylist-url-input').value = 'https://youtube.com/playlist?list=PLtest123';
    await ui.elements.get('mylist-add-btn').fire('click');
    assert.match(ui.elements.get('mylist-add-status').textContent, /Reading playlist/);
    await h.settleImport();
    await ui.run('loadLocalImport()');
    assert.deepEqual((await h.api('/api/mylist/alice')).data.items.map(item => item.title), ['First song', 'Second song']);
    assert.equal((await h.api('/api/local/alice/playlists')).data.playlists.length, 1);
});

test('the Upload button saves a named audio file and queues it next', async t => {
    const downloader = createDownloader();
    const h = await setup(t, { spawn: downloader.spawn });
    await h.add('AAAAAAAAAAA');
    const ui = frontend(h, 'main.js', h.cookie);
    await ui.ready;
    ui.elements.get('local-file-input').files = [new File(['ID3 test'], 'Announcement.mp3', { type: 'audio/mpeg' })];
    await ui.elements.get('local-file-input').fire('change');
    assert.match(ui.elements.get('local-upload-status').textContent, /1 queued after the current song/);
    const list = (await h.api('/api/mylist/alice')).data.items;
    assert.equal(list[0].title, 'Announcement.mp3');
    assert.equal(list[1].title, 'AAAAAAAAAAA');
    assert.equal(ui.elements.get('local-file-input').value, '');
    assert.deepEqual(ui.errors, []);
});

test('local playback preserves encoded filename characters in the audio URL', async t => {
    const h = await setup(t);
    const name = 'A & B #1 + 50%.mp3';
    fs.mkdirSync(path.join(h.localRoot, 'alice'), { recursive: true });
    fs.writeFileSync(path.join(h.localRoot, 'alice', name), 'ID3 test');
    await h.api('/api/local/alice/queue', 'POST', { filename: name });
    const ui = frontend(h, 'overlay.js', h.cookie);
    await ui.ready;
    await until(() => ui.audios[0]?.src);
    assert.equal(ui.audios[0].src, '/api/local-media/alice/' + encodeURIComponent(name));
    assert.equal((await fetch(h.base + ui.audios[0].src)).status, 200);
});

test('Stream Deck changes pause and volume in the preview and anonymous OBS player', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const preview = frontend(h, 'overlay.js', h.cookie);
    const obs = frontend(h, 'overlay.js');
    await Promise.all([preview.ready, obs.ready]);
    const playing = obs.run('currentItemId');
    const token = (await h.api('/api/streamdeck/alice/connection', 'POST')).data.token;
    async function command(body) {
        const result = await h.request('/api/streamdeck/control', { method: 'POST',
            body: { requestId: require('node:crypto').randomUUID(), ...body }, headers: { Authorization: 'Bearer ' + token } });
        assert.equal(result.status, 200);
        const update = h.events.filter(event => event.event === 'audio:settings').at(-1).payload;
        preview.emitSocket('audio:settings', update);
        obs.emitSocket('audio:settings', update);
    }
    await command({ action: 'adjust-volume', delta: -35 });
    assert.equal(preview.run('volumePercent'), 65);
    assert.equal(obs.run('volumePercent'), 65);
    assert.equal(preview.audios[0].volume, 1);
    assert.equal(obs.audios[0].volume, 1);
    assert.equal(preview.outputs[0].gain.value, 0.65);
    assert.equal(obs.outputs[0].gain.value, 0.65);
    await command({ action: 'toggle-pause' });
    assert.equal(preview.audios[0].paused, true);
    assert.equal(obs.audios[0].paused, true);
    assert.equal(obs.run('currentItemId'), playing);
    await command({ action: 'toggle-pause' });
    assert.equal(preview.audios[0].paused, false);
    assert.equal(obs.audios[0].paused, false);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
});

test('fractional volume uses one linear gain and accepts decimal commas', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const ui = frontend(h, 'overlay.js', h.cookie);
    await ui.ready;
    const input = ui.elements.get('volume-percent');
    input.value = '1';
    await input.fire('change');
    await ui.run('flushAudioSettings()');
    const one = ui.outputs[0].gain.value;
    input.value = '0,5';
    await input.fire('change');
    await ui.run('flushAudioSettings()');
    assert.equal(ui.outputs[0].gain.value, one / 2);
    assert.equal(ui.outputs[0].gain.value, 0.005);
    assert.equal(ui.audios[0].volume, 1);
    assert.equal((await h.api('/api/channels/alice/audio-settings')).data.settings.volume, 0.5);
    await h.add('BBBBBBBBBBB');
    await ui.run('advance()');
    await until(() => ui.plays.length === 2);
    assert.equal(ui.outputs.length, 1);
    assert.equal(ui.outputs[0].sourceCount, 1);
    assert.equal(ui.outputs[0].gain.value, 0.005);
});

test('browsers without Web Audio retain fractional native volume', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    await h.api('/api/channels/alice/audio-settings', 'POST', { volume: 0.5 });
    const ui = frontend(h, 'overlay.js', h.cookie, { audioContext: false });
    await ui.ready;
    assert.equal(ui.outputs.length, 0);
    assert.equal(ui.audios[0].volume, 0.005);
    assert.equal(ui.plays.length, 1);
});

test('a suspended audio output asks for a gesture and resumes without changing the track', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const options = { suspended: true, blockResume: true };
    const ui = frontend(h, 'overlay.js', h.cookie, options);
    await ui.ready;
    assert.match(ui.elements.get('playback-message').textContent, /allow audio playback/);
    const playing = ui.run('currentItemId');
    options.blockResume = false;
    ui.windowHandlers.get('pointerdown')();
    await nextTick();
    assert.equal(ui.outputs[0].state, 'running');
    assert.equal(ui.run('currentItemId'), playing);
    assert.equal(ui.outputs.length, 1);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
});

test('remote Pause is applied during a pending volume save and stale acknowledgements cannot undo it', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const token = (await h.api('/api/streamdeck/alice/connection', 'POST')).data.token;
    const ui = frontend(h, 'overlay.js', h.cookie);
    await ui.ready;
    const original = ui.context.fetch;
    let release;
    let held = false;
    ui.context.fetch = async (url, options = {}) => {
        const res = await original(url, options);
        if (options.method === 'POST' && url.endsWith('/audio-settings')) {
            held = true;
            await new Promise(resolve => { release = resolve; });
        }
        return res;
    };
    ui.elements.get('volume-percent').value = '1';
    await ui.elements.get('volume-percent').fire('change');
    await until(() => held);
    const control = body => h.request('/api/streamdeck/control', { method: 'POST', body: {
        requestId: require('node:crypto').randomUUID(), ...body
    }, headers: { Authorization: 'Bearer ' + token } });
    await control({ action: 'adjust-volume', delta: -0.5 });
    const volumeUpdate = h.events.filter(event => event.event === 'audio:settings').at(-1).payload;
    ui.emitSocket('audio:settings', volumeUpdate);
    await control({ action: 'toggle-pause' });
    const paused = h.events.filter(event => event.event === 'audio:settings').at(-1).payload;
    ui.emitSocket('audio:settings', paused);
    assert.equal(ui.audios[0].paused, true, 'Pause is never ignored behind a volume write');
    release();
    await ui.run('audioSettingsWrite');
    assert.equal(ui.audios[0].paused, true);
    assert.equal(ui.outputs[0].gain.value, 0.005);
    assert.equal(ui.elements.get('volume-percent').value, 0.5);
    ui.emitSocket('audio:settings', volumeUpdate);
    assert.equal(ui.audios[0].paused, true, 'an older socket event cannot undo Pause either');
});

test('YouTube duration metadata replaces the iframe duration clock', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const ui = frontend(h, 'overlay.js', h.cookie);
    await ui.ready;
    await until(() => ui.run('trackDuration') === 180);
    ui.audios[0].duration = Infinity;
    ui.audios[0].currentTime = 45;
    ui.run('updateProgress()');
    assert.equal(ui.elements.get('seek-bar').value, 25);
    assert.equal(ui.elements.get('time-display').textContent, '0:45 / 3:00');
    assert.equal(ui.elements.get('audio-card').hidden, false);
    assert.equal(ui.elements.get('audio-title').textContent, 'AAAAAAAAAAA');
});

test('a saved quiet level is applied before connecting the audio graph', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    await h.api('/api/channels/alice/audio-settings', 'POST', { volume: 0.5 });
    const ui = frontend(h, 'overlay.js', h.cookie);
    await ui.ready;
    assert.equal(ui.outputs[0].levelAtConnect, 0.005);
    assert.equal(ui.outputs[0].gain.value, 0.005);
});

test('a stale dashboard settings read cannot undo a newer Stream Deck Pause', async t => {
    const h = await setup(t);
    const ui = frontend(h, 'main.js', h.cookie);
    await ui.ready;
    await ui.run('loadChannelAudioSettings()');
    const original = ui.context.fetch;
    let release;
    let held = false;
    ui.context.fetch = async (url, options) => {
        const res = await original(url, options);
        if (url.endsWith('/audio-settings')) { held = true; await new Promise(resolve => { release = resolve; }); }
        return res;
    };
    const pending = ui.run('loadChannelAudioSettings()');
    await until(() => held);
    await h.api('/api/channels/alice/audio-settings', 'POST', { paused: true });
    ui.emitSocket('audio:settings', h.events.filter(event => event.event === 'audio:settings').at(-1).payload);
    release();
    await pending;
    assert.equal(ui.elements.get('pause-current-btn').textContent, '▶ Resume');
});

test('late preparation from a skipped song cannot play over the next track or change its clock', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    await h.add('BBBBBBBBBBB');
    const ui = frontend(h, 'overlay.js', h.cookie);
    await ui.ready;
    const original = ui.context.fetch;
    let release;
    let held = false;
    ui.context.fetch = async (url, options) => {
        if (url === '/api/yt-audio/AAAAAAAAAAA/info') {
            held = true;
            await new Promise(resolve => { release = resolve; });
            return new Response(JSON.stringify({ duration: 999 }));
        }
        return original(url, options);
    };
    const pending = ui.run("prepareYouTubeMedia('AAAAAAAAAAA', currentItemId)");
    await until(() => held);
    await ui.run('advance()');
    await until(() => ui.plays.length === 2 && ui.run('trackDuration') === 180);
    release();
    await pending;
    assert.equal(ui.run('trackDuration'), 180);
    assert.equal(ui.plays.length, 2);
});

test('the player waits for preparation and preserves saved pause and volume while downloading', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    await h.api('/api/channels/alice/audio-settings', 'POST', { volume: 0.5, paused: true });
    let checks = 0;
    const ui = frontend(h, 'overlay.js', h.cookie, { info: async () => {
        checks++;
        return new Response(JSON.stringify(checks < 3 ? { status: 'preparing', stage: checks === 1 ? 'downloading' : 'checking', retryAfterMs: 1000 }
            : { status: 'ready', duration: 250 }), { status: checks < 3 ? 202 : 200 });
    } });
    await ui.ready;
    assert.equal(ui.audios[0].src, '');
    assert.equal(ui.plays.length, 0);
    assert.match(ui.elements.get('playback-message').textContent, /Downloading/);
    assert.equal(ui.elements.get('playback-retry-btn').hidden, true);
    assert.equal(ui.elements.get('playback-status').hidden, false);
    await ui.runTimer(1000);
    assert.match(ui.elements.get('playback-message').textContent, /checking/);
    assert.equal(ui.plays.length, 0);
    await ui.runTimer(1000);
    assert.equal(ui.audios[0].src, '/api/yt-audio/AAAAAAAAAAA');
    assert.equal(ui.run('trackDuration'), 250);
    assert.equal(ui.run('preparingYouTube'), false);
    assert.equal(ui.plays.length, 0);
    await ui.elements.get('pause-resume-btn').fire('click');
    assert.equal(ui.plays.length, 1);
    assert.equal(ui.outputs[0].gain.value, 0.005);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
});

test('preparation errors show the server reason, keep the song queued and allow explicit Retry', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const checks = [];
    const ui = frontend(h, 'overlay.js', h.cookie, { info: async url => {
        checks.push(url);
        return new Response(JSON.stringify(url.includes('?retry=1') ? { status: 'ready', duration: 180 }
            : { status: 'failed', code: 'YOUTUBE_RATE_LIMIT', error: 'YouTube is rate-limiting this server. Wait a little and retry.' }), { status: url.includes('?retry=1') ? 200 : 502 });
    } });
    await ui.ready;
    const current = ui.run('currentItemId');
    assert.equal(ui.plays.length, 0);
    assert.match(ui.elements.get('playback-message').textContent, /rate-limiting/);
    assert.equal(ui.elements.get('playback-retry-btn').hidden, false);
    await ui.elements.get('playback-retry-btn').fire('click');
    assert.deepEqual(checks, ['/api/yt-audio/AAAAAAAAAAA/info', '/api/yt-audio/AAAAAAAAAAA/info?retry=1']);
    assert.equal(ui.run('currentItemId'), current);
    assert.equal(ui.plays.length, 1);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
});

test('Skip cancels pending preparation polls and starts the next prepared song once', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    await h.add('BBBBBBBBBBB');
    const ui = frontend(h, 'overlay.js', h.cookie, { info: async url => new Response(JSON.stringify(url.includes('AAAAAAAAAAA')
        ? { status: 'preparing', stage: 'downloading' } : { status: 'ready', duration: 180 }), { status: url.includes('AAAAAAAAAAA') ? 202 : 200 }) });
    await ui.ready;
    assert.equal(ui.plays.length, 0);
    await ui.elements.get('playback-skip-btn').fire('click');
    await until(() => ui.plays.length === 1);
    assert.equal(ui.plays[0], '/api/yt-audio/BBBBBBBBBBB');
    assert.throws(() => ui.runTimer(1000), /No timer/);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
});

test('viewer requests show native MP4 video and shared controls; the same song in My List stays audio-only', async t => {
    const h = await setup(t);
    h.queues.set('alice', [{ id: 'request-a', media: 'https://youtu.be/AAAAAAAAAAA', username: 'viewer' }]);
    await h.add('AAAAAAAAAAA');
    await h.api('/api/channels/alice/audio-settings', 'POST', { volume: 0.5, paused: true });
    const ui = frontend(h, 'overlay.js', h.cookie);
    await ui.ready;
    const media = ui.audios[0];
    assert.equal(ui.run('playbackMode'), 'youtube-video');
    assert.equal(media.src, '/api/yt-video/AAAAAAAAAAA');
    assert.equal(media.hidden, false);
    assert.equal(ui.elements.get('audio-card').hidden, true);
    assert.equal(ui.plays.length, 0);
    media.handlers.get('ended')();
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
    const remotePause = async paused => {
        await h.api('/api/channels/alice/audio-settings', 'POST', { paused });
        ui.emitSocket('audio:settings', h.events.filter(event => event.event === 'audio:settings').at(-1).payload);
    };
    await remotePause(false);
    assert.equal(ui.plays.length, 1);
    assert.equal(ui.outputs[0].gain.value, 0.005);
    assert.equal(ui.outputs[0].audio, media);
    await remotePause(true);
    assert.equal(media.paused, true);
    await remotePause(false);
    media.handlers.get('ended')();
    await until(() => media.src === '/api/yt-audio/AAAAAAAAAAA');
    assert.equal(ui.run('playbackMode'), 'youtube-audio');
    assert.equal(media.hidden, true);
    assert.equal(ui.elements.get('audio-card').hidden, false);
    assert.equal(ui.audios.length, 1);
    assert.equal(ui.outputs.length, 1);
    assert.equal(ui.outputs[0].sourceCount, 1);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
});

test('anonymous OBS shows video for a requested song without a YouTube iframe or extra audio source', async t => {
    const h = await setup(t);
    h.queues.set('alice', [{ id: 'request-a', media: 'https://youtu.be/AAAAAAAAAAA', username: 'viewer' }]);
    const ui = frontend(h, 'overlay.js', undefined, { search: '?channel=alice' });
    await ui.ready;
    assert.equal(ui.audios[0].hidden, false);
    assert.equal(ui.audios[0].src, '/api/yt-video/AAAAAAAAAAA');
    assert.equal(ui.outputs.length, 1);
    assert.equal(ui.elements.get('audio-card').hidden, true);
    assert.equal(ui.context.window.onYouTubeIframeAPIReady, undefined);
});

test('a confirmed private requested video is skipped automatically and the next request plays as video', async t => {
    const tools = require('./helpers/media-tools').createMediaTools({ downloadFailure: call => call.args.at(-1).endsWith('AAAAAAAAAAA') ? 'Private video' : null });
    const h = await setup(t, { cacheSpawn: tools.spawn });
    h.queues.set('alice', ['A', 'B'].map(id => ({ id, media: 'https://youtu.be/' + id.repeat(11), username: 'viewer' })));
    await assert.rejects(h.youtubeVideoCache.prepare('AAAAAAAAAAA'), { code: 'YOUTUBE_UNAVAILABLE' });
    const ui = frontend(h, 'overlay.js', undefined, { info: async url => new Response(JSON.stringify(url.includes('AAAAAAAAAAA')
        ? { status: 'failed', code: 'YOUTUBE_UNAVAILABLE', error: 'Private video' }
        : { status: 'ready', duration: 180 }), { status: url.includes('AAAAAAAAAAA') ? 502 : 200 }) });
    await ui.ready;
    await until(() => ui.plays.length === 1);
    assert.equal(ui.plays[0], '/api/yt-video/BBBBBBBBBBB');
    assert.equal(ui.audios[0].hidden, false);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
});

test('an all-private looping personal list becomes idle after one verified skip instead of looping forever', async t => {
    const tools = require('./helpers/media-tools').createMediaTools({ downloadFailure: 'Private video' });
    const h = await setup(t, { cacheSpawn: tools.spawn });
    await h.add('AAAAAAAAAAA');
    await h.add('AAAAAAAAAAA');
    await h.api('/api/mode/alice', 'POST', { mylistLoop: true });
    await assert.rejects(h.youtubeCache.prepare('AAAAAAAAAAA'), { code: 'YOUTUBE_UNAVAILABLE' });
    const ui = frontend(h, 'overlay.js', undefined, { info: async () => new Response(JSON.stringify({
        status: 'failed', code: 'YOUTUBE_UNAVAILABLE', error: 'Private video' }), { status: 502 }) });
    await ui.ready;
    await until(() => h.calls.some(call => call.action === 'removemedia') && ui.run('currentItemId') === null);
    assert.equal(ui.plays.length, 0);
    assert.equal(ui.audios[0].hidden, true);
    assert.equal((await h.api('/api/mylist/alice')).data.items.length, 0);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
});
