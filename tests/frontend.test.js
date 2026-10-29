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
function frontend(h, file, cookie) {
    const elements = new Map();
    const errors = [];
    const audios = [];
    const plays = [];
    const youtubePlayers = [];
    const socketHandlers = new Map();
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
        return elements.get(id);
    }
    const tabs = ['requests', 'mylist', 'local'].map(tab => {
        const li = element('tab-' + tab);
        li.dataset.tab = tab;
        return li;
    });
    element('queue-type-tabs').querySelectorAll = () => tabs;
    const context = vm.createContext({
        document: { getElementById: element, addEventListener() {}, visibilityState: 'visible', hidden: false },
        window: { location: { origin: h.base, search: '?channel=alice&controls=1', href: '' }, addEventListener() {} },
        navigator: {}, URLSearchParams, FormData, Blob,
        console: { log() {}, warn() {}, error: (...args) => errors.push(args) },
        setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
        io: () => ({ on(event, handler) { socketHandlers.set(event, handler); }, emit() {} }),
        YT: {
            PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2 },
            Player: class {
                constructor(target, options) {
                    this.target = target;
                    this.options = options;
                    this.muted = true;
                    youtubePlayers.push(this);
                }
                mute() { this.muted = true; }
                unMute() { this.muted = false; }
                setVolume(value) { this.volume = value; }
                playVideo() { this.playing = true; this.paused = false; }
                pauseVideo() { this.playing = false; this.paused = true; }
                loadVideoById(id) { this.videoId = id; }
                destroy() { this.destroyed = true; }
                fire(name, data) {
                    if (name === 'onStateChange' && (data === 1 || data === 2)) this.paused = data === 2;
                    return this.options.events[name]?.({ target: this, data });
                }
            }
        },
        fetch: (url, options = {}) => fetch(h.base + url, {
            ...options, headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) }
        }),
        Audio: class {
            constructor() { this.src = ''; this.paused = true; this.handlers = new Map(); audios.push(this); }
            addEventListener(event, handler) { this.handlers.set(event, handler); }
            play() { this.paused = false; plays.push(this.src); return Promise.resolve(); }
            pause() { this.paused = true; }
            load() {}
            removeAttribute(name) { if (name === 'src') this.src = ''; }
        }
    });
    const source = fs.readFileSync(path.resolve(__dirname, '../scrs/frontend', file), 'utf8');
    const ready = vm.runInContext(source, context, { filename: file });
    return { context, elements, errors, audios, plays, youtubePlayers, ready,
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

test('failed audio proxy falls back to audible YouTube playback without consuming the song', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const ui = frontend(h, 'overlay.js');
    await ui.ready;
    ui.context.window.onYouTubeIframeAPIReady();
    const picture = ui.youtubePlayers.at(-1);
    picture.fire('onReady');
    assert.equal(picture.muted, true);
    const id = ui.run('currentItemId');
    ui.audios[0].handlers.get('error')();
    const audible = ui.youtubePlayers.at(-1);
    assert.notEqual(audible, picture);
    assert.equal(picture.destroyed, true);
    audible.fire('onReady');
    assert.equal(audible.muted, false);
    assert.equal(audible.target, 'yt-player-mount');
    assert.equal(ui.run('playbackMode'), 'youtube');
    assert.equal(ui.run('currentItemId'), id);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
    // Muted picture events and failed iframe loads must not skip either.
    picture.fire('onStateChange', 0);
    audible.fire('onError', 100);
    await nextTick();
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
    assert.match(ui.elements.get('playback-message').textContent, /could not play/);
    await ui.elements.get('playback-skip-btn').fire('click');
    await until(() => h.calls.some(call => call.action === 'removemedia'));
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
});

test('late iframe API arrival does not reload native audio and only audible playback endings advance', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const ui = frontend(h, 'overlay.js');
    await ui.ready;
    assert.equal(ui.plays.length, 1);
    ui.context.window.onYouTubeIframeAPIReady();
    assert.equal(ui.plays.length, 1);
    ui.youtubePlayers.at(-1).fire('onStateChange', 0);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
    ui.audios[0].handlers.get('error')();
    const player = ui.youtubePlayers.at(-1);
    player.fire('onReady');
    player.fire('onStateChange', 0);
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
    assert.equal(ui.audios[0].volume, 23.5 / 100 * 0.5);
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

test('pausing the muted YouTube picture pauses native audio and persists the shared state', async t => {
    const h = await setup(t);
    await h.add('AAAAAAAAAAA');
    const ui = frontend(h, 'overlay.js', h.cookie);
    await ui.ready;
    ui.context.window.onYouTubeIframeAPIReady();
    const player = ui.youtubePlayers.at(-1);
    player.fire('onReady');
    player.fire('onStateChange', 1);
    player.fire('onStateChange', 2);
    await ui.run('audioSettingsWrite');
    assert.equal(ui.audios[0].paused, true);
    assert.equal(player.paused, true);
    assert.equal((await h.api('/api/channels/alice/audio-settings')).data.settings.paused, true);
    player.fire('onStateChange', 2); // acknowledge the shared pause
    player.fire('onStateChange', 1); // user resumes using the video controls
    await ui.run('audioSettingsWrite');
    assert.equal(ui.audios[0].paused, false);
    assert.equal((await h.api('/api/channels/alice/audio-settings')).data.settings.paused, false);
    player.fire('onStateChange', 2); // an immediate second pause must also work
    await ui.run('audioSettingsWrite');
    assert.equal(ui.audios[0].paused, true);
    assert.equal((await h.api('/api/channels/alice/audio-settings')).data.settings.paused, true);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
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
