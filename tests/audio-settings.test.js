'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAudioSettings } = require('../scrs/backend/audio-settings');
const { createTestServer } = require('./helpers/server');

async function setup(t) {
    const h = await createTestServer();
    t.after(() => h.close());
    const cookie = await h.login();
    h.api = (channel, method = 'GET', body) => h.request(`/api/channels/${channel}/audio-settings`, { method, body, cookie });
    return h;
}

test('OBS can read audio settings; changes require authentication and channel access', async t => {
    const h = await setup(t);
    assert.deepEqual((await h.request('/api/channels/alice/audio-settings')).data.settings, { volume: 100, paused: false });
    assert.equal((await h.request('/api/channels/alice/audio-settings', { method: 'POST', body: { volume: 20 } })).status, 401);
    assert.equal((await h.api('bob', 'POST', { paused: true })).status, 403);
});

test('volume and pause persist after recreating the settings store and remain isolated per user channel', async t => {
    const h = await setup(t);
    const saved = await h.api('alice', 'POST', { volume: 23.75, paused: true });
    assert.equal(saved.status, 200);
    const restored = createAudioSettings(path.join(h.localRoot, '.audio-settings'));
    assert.deepEqual(restored.get('alice'), { volume: 23.75, paused: true });
    assert.deepEqual(restored.get('bob'), { volume: 100, paused: false });
    await h.api('alice', 'POST', { volume: 55 });
    assert.deepEqual((await h.api('alice')).data.settings, { volume: 55, paused: true });
    const notification = h.events.filter(event => event.event === 'audio:settings').at(-1);
    assert.equal(notification.room, 'ch:alice');
    assert.deepEqual(notification.payload.settings, { volume: 55, paused: true });
});

test('invalid audio settings are rejected without changing saved preferences', async t => {
    const h = await setup(t);
    for (const body of [{}, { volume: -1 }, { volume: 101 }, { volume: '30' }, { volume: null },
        { paused: 'false' }, { volume: 20, paused: null }])
        assert.equal((await h.api('alice', 'POST', body)).status, 400);
    assert.deepEqual((await h.api('alice')).data.settings, { volume: 100, paused: false });
    const store = createAudioSettings(path.join(h.localRoot, '.audio-settings'));
    for (const value of [null, [], 0, 'invalid']) assert.throws(() => store.update('alice', value), { status: 400 });
});
