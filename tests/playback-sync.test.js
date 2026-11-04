'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlaybackClock } = require('../scrs/backend/playback-clock');
const { createTestServer } = require('./helpers/server');
const { setImmediate: nextTick } = require('node:timers/promises');
async function until(predicate) {
    for (let i = 0; i < 2000; i++) { if (predicate()) return; await nextTick(); }
    throw new Error('Clock socket event was not received');
}

function clockHarness() {
    let time = 100000;
    const events = [];
    const clock = createPlaybackClock({ now: () => time, onChange: state => events.push(state) });
    clock.select('alice', 'track-a', { paused: false }, 0);
    const report = (extra = {}) => clock.report('alice', { playbackId: 'track-a', clientId: 'main_player',
        position: 0, duration: 180, state: 'playing', seekVersion: 0, settingsRevision: 0, ...extra });
    return { clock, report, events, advance: ms => { time += ms; }, now: () => time };
}

test('the shared clock starts on actual playback; late followers cannot restart it at zero', () => {
    const h = clockHarness();
    h.advance(30000);
    assert.equal(h.clock.snapshot('alice').position, 0);
    assert.equal(h.clock.snapshot('alice').started, false);
    assert.equal(h.report().accepted, true);
    h.advance(45000);
    assert.equal(h.clock.snapshot('alice').position, 45);
    h.report({ position: 45 });
    assert.equal(h.report({ clientId: 'late_player', position: 0 }).accepted, false);
    assert.equal(h.clock.snapshot('alice').position, 45);
    assert.equal(h.report({ clientId: 'silent_viewer', observer: true }).accepted, false);
});

test('pause freezes the position, resume continues it and stale setting reports cannot restart it', () => {
    const h = clockHarness();
    h.report(); h.advance(10000);
    h.clock.settings('alice', { paused: true }, 1);
    h.advance(20000);
    assert.equal(h.clock.snapshot('alice').position, 10);
    assert.equal(h.clock.snapshot('alice').running, false);
    assert.equal(h.report({ position: 0 }).accepted, false);
    h.clock.settings('alice', { paused: false }, 2);
    h.advance(3000);
    assert.equal(h.clock.snapshot('alice').position, 13);
    assert.equal(h.clock.snapshot('alice').running, true);
});

test('seeks are shared while paused and old leader reports cannot overwrite a newer seek', () => {
    const h = clockHarness();
    h.report(); h.advance(5000);
    const seek = h.clock.seek('alice', { playbackId: 'track-a', position: 80 });
    assert.equal(seek.playback.position, 80);
    assert.equal(h.report({ position: 5 }).accepted, false);
    assert.equal(h.report({ position: 80, seekVersion: 1 }).accepted, true);
    h.clock.settings('alice', { paused: true }, 1);
    h.clock.seek('alice', { playbackId: 'track-a', position: 50 });
    h.advance(2000);
    assert.equal(h.clock.snapshot('alice').position, 50);
    assert.throws(() => h.clock.seek('alice', { playbackId: 'track-a', position: -1 }), { status: 400 });
    h.clock.seek('alice', { playbackId: 'track-a', position: 999 });
    assert.equal(h.clock.snapshot('alice').position, 180);
});

test('buffering freezes followers; a follower can take over after the audible leader disconnects', () => {
    const h = clockHarness();
    h.report(); h.advance(3000);
    h.report({ position: 3, state: 'waiting' });
    h.advance(2000);
    assert.equal(h.clock.snapshot('alice').position, 3);
    assert.equal(h.report({ clientId: 'obs_player', position: 3 }).accepted, false);
    h.advance(5000);
    assert.equal(h.report({ clientId: 'obs_player', position: 3 }).accepted, true);
    h.advance(1000);
    assert.equal(h.clock.snapshot('alice').position, 4);
    assert.equal(h.report({ position: 0 }).accepted, false);
});

test('changing tracks ignores late reports, seeks and states from the previous playback', () => {
    const h = clockHarness(); h.report(); h.advance(5000);
    h.clock.select('alice', 'track-b', { paused: false }, 0);
    assert.equal(h.report({ position: 5 }).accepted, false);
    assert.equal(h.clock.seek('alice', { playbackId: 'track-a', position: 90 }).accepted, false);
    assert.equal(h.clock.snapshot('alice').position, 0);
    assert.equal(h.clock.snapshot('alice').started, false);
    h.clock.select('alice', null, { paused: false }, 0);
    assert.equal(h.clock.snapshot('alice'), null);
});

test('clock HTTP reads and silent observers do not promote songs; seeks require channel access and broadcast to real sockets', { timeout: 10000 }, async t => {
    let time = 100000;
    const h = await createTestServer({ now: () => time, realSockets: true });
    t.after(() => h.close());
    const cookie = await h.login();
    await h.request('/api/mylist/alice/add', { method: 'POST', cookie, body: { url: 'https://youtu.be/AAAAAAAAAAA' } });
    assert.equal((await h.request('/api/channels/alice/current?observe=1')).data.current, null);
    assert.equal((await h.request('/api/channels/alice/playback')).data.playback, null);
    assert.equal(h.calls.filter(call => call.action === 'setmediatop').length, 0);
    h.queues.set('alice', [{ id: 'request', media: 'https://youtu.be/BBBBBBBBBBB', username: 'viewer' }]);
    const current = (await h.request('/api/channels/alice/current')).data.current;
    const bundle = require('node:path').join(require('node:path').dirname(require.resolve('socket.io/package.json')), 'client-dist/socket.io.js');
    const client = require(bundle).io(h.base, { transports: ['websocket'], reconnection: false });
    t.after(() => client.disconnect());
    const updates = [];
    client.on('playback:sync', state => updates.push(state));
    client.on('connect', () => client.emit('join:channel', 'alice'));
    await until(() => updates.length);
    const report = { playbackId: current._playbackId, clientId: 'main_player', position: 0,
        duration: 180, state: 'playing', seekVersion: 0, settingsRevision: 0 };
    assert.equal((await h.request('/api/channels/alice/playback/report', { method: 'POST', body: report })).data.accepted, true);
    time += 30000;
    assert.equal((await h.request('/api/channels/alice/playback')).data.playback.position, 30);
    assert.equal((await h.request('/api/channels/alice/playback/seek', { method: 'POST', body: { playbackId: current._playbackId, position: 70 } })).status, 401);
    assert.equal((await h.request('/api/channels/bob/playback/seek', { method: 'POST', cookie, body: { playbackId: current._playbackId, position: 70 } })).status, 403);
    const seek = await h.request('/api/channels/alice/playback/seek', { method: 'POST', cookie, body: { playbackId: current._playbackId, position: 70 } });
    assert.equal(seek.data.playback.position, 70);
    await until(() => updates.some(state => state.seekVersion === 1));
    assert.equal(updates.at(-1).position, 70);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
    await h.request('/api/channels/alice/audio-settings', { method: 'POST', cookie, body: { paused: true } });
    time += 10000;
    assert.equal((await h.request('/api/channels/alice/playback')).data.playback.position, 70);
});
