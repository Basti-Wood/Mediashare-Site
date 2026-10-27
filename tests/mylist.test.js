'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestServer } = require('./helpers/server');

const songs = ['AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC'];

async function setup(t, ids = songs, options = {}) {
    const h = await createTestServer(options);
    t.after(() => h.close());
    const cookie = await h.login();
    h.api = (route, method = 'GET', body) => h.request(route, { method, body, cookie });
    h.list = async () => (await h.api('/api/mylist/alice')).data.items;
    h.current = async () => (await h.request('/api/channels/alice/current')).data.current;
    h.next = item => h.request('/api/channels/alice/next', { method: 'POST', body: { playbackId: item._playbackId } });
    h.mode = body => h.api('/api/mode/alice', 'POST', body);
    for (const id of ids) {
        const added = await h.api('/api/mylist/alice/add', 'POST', { url: `https://youtu.be/${id}` });
        assert.equal(added.status, 200);
    }
    return h;
}

const titles = items => items.map(item => item.title);
const idOf = item => item.media.split('/').pop();

test('loop defaults off, is channel-specific and updates without resetting alternate turns', async t => {
    const h = await setup(t, []);
    assert.equal((await h.api('/api/mode/alice')).data.mylistLoop, false);
    await h.mode({ mode: 'switch' });
    await h.request('/api/channels/alice/next', { method: 'POST' });
    const updated = await h.mode({ mylistLoop: true });
    assert.equal(updated.data.mode, 'switch');
    assert.equal(updated.data.switchTurn, 'mylist');
    const bob = await h.login('bob');
    assert.equal((await h.request('/api/mode/bob', { cookie: bob })).data.mylistLoop, false);
});

test('settings and shuffle enforce authentication and channel access', async t => {
    const h = await setup(t);
    assert.equal((await h.request('/api/mylist/alice/shuffle', { method: 'POST' })).status, 401);
    assert.equal((await h.request('/api/mode/alice', { method: 'POST', body: { mylistLoop: true } })).status, 401);
    assert.equal((await h.api('/api/mylist/bob/shuffle', 'POST')).status, 403);
    assert.equal((await h.api('/api/mode/bob', 'POST', { mylistLoop: true })).status, 403);
});

test('invalid settings reject the whole update', async t => {
    const h = await setup(t, []);
    for (const body of [{}, { mylistLoop: 'true' }, { mylistLoop: 1 }, { mylistLoop: null }, { mode: 'invalid', mylistLoop: true }, { mode: 'mylist', mylistLoop: [] }])
        assert.equal((await h.mode(body)).status, 400);
    const state = (await h.api('/api/mode/alice')).data;
    assert.equal(state.mode, 'requests');
    assert.equal(state.mylistLoop, false);
});

test('shuffle changes upcoming order, preserving every entry and duplicate', async t => {
    const h = await setup(t, [...songs, songs[0]], { random: () => 0 });
    const before = await h.list();
    const shuffled = await h.api('/api/mylist/alice/shuffle', 'POST');
    assert.equal(shuffled.status, 200);
    assert.notDeepEqual(shuffled.data.items, before);
    assert.deepEqual(titles(shuffled.data.items).sort(), titles(before).sort());
    assert.deepEqual(await h.list(), shuffled.data.items);
    assert.equal(h.calls.length, 0);
    assert.ok(h.events.some(event => event.event === 'queue:update' && event.payload.channel === 'alice'));
});

test('shuffle is safe for an empty or one-song list', async t => {
    const h = await setup(t, []);
    assert.deepEqual((await h.api('/api/mylist/alice/shuffle', 'POST')).data.items, []);
    await h.api('/api/mylist/alice/add', 'POST', { url: `https://youtu.be/${songs[0]}` });
    const before = await h.list();
    assert.deepEqual((await h.api('/api/mylist/alice/shuffle', 'POST')).data.items, before);
});

test('with loop off, songs are consumed once and the list ends', async t => {
    const h = await setup(t);
    await h.mode({ mode: 'mylist' });
    for (const id of songs) {
        const item = await h.current();
        assert.equal(idOf(item), id);
        await h.next(item);
    }
    assert.equal(await h.current(), null);
    assert.deepEqual(await h.list(), []);
});

test('loop cycles the complete list and displays upcoming playback order', async t => {
    const h = await setup(t);
    await h.mode({ mode: 'mylist', mylistLoop: true });
    for (let i = 0; i < 8; i++) {
        const item = await h.current();
        assert.equal(idOf(item), songs[i % songs.length]);
        assert.equal((await h.list()).length, songs.length);
        assert.equal(titles(await h.list()).at(-1), songs[i % songs.length]);
        await h.next(item);
    }
});

test('one-song loops get fresh playback IDs while concurrent polls promote only once', async t => {
    const h = await setup(t, [songs[0]]);
    await h.mode({ mylistLoop: true });
    const ids = new Set();
    for (let i = 0; i < 4; i++) {
        const current = await Promise.all([h.current(), h.current(), h.current()]);
        assert.equal(new Set(current.map(item => item._playbackId)).size, 1);
        assert.equal(h.calls.filter(call => call.action === 'setmediatop').length, i + 1);
        assert.equal(idOf(current[0]), songs[0]);
        ids.add(current[0]._playbackId);
        await h.next(current[0]);
    }
    assert.equal(ids.size, 4);
});

test('duplicate finish events cannot skip the next playback', async t => {
    const h = await setup(t, [songs[0]]);
    await h.mode({ mylistLoop: true });
    const first = await h.current();
    await Promise.all([h.next(first), h.next(first)]);
    const second = await h.current();
    const stale = await h.next(first);
    assert.equal(stale.data.advanced, false);
    assert.equal((await h.current())._playbackId, second._playbackId);
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 1);
});

test('enabling and disabling loop during a song includes the current song without an extra replay', async t => {
    const h = await setup(t, [songs[0]]);
    const first = await h.current();
    assert.equal((await h.list()).length, 0);
    await h.mode({ mylistLoop: true });
    assert.equal((await h.list()).length, 1);
    await h.next(first);
    const second = await h.current();
    assert.notEqual(second._playbackId, first._playbackId);
    await h.mode({ mylistLoop: false });
    assert.equal((await h.list()).length, 0);
    await h.next(second);
    assert.equal(await h.current(), null);
});

test('shuffle during playback keeps the current song and viewer queue unchanged', async t => {
    const h = await setup(t, songs, { random: () => 0 });
    const viewer = { id: 'viewer', media: 'https://youtu.be/DDDDDDDDDDD', username: 'viewer', Platform: 'youtube' };
    h.queues.set('alice', [viewer]);
    await h.mode({ mode: 'mylist', mylistLoop: true });
    const current = await h.current();
    const before = titles(await h.list()).sort();
    await h.api('/api/mylist/alice/shuffle', 'POST');
    assert.equal((await h.current())._playbackId, current._playbackId);
    assert.deepEqual(titles(await h.list()).sort(), before);
    assert.deepEqual(h.queues.get('alice').at(-1), viewer);
});

test('alternate mode interleaves viewer requests with the looping personal list', async t => {
    const h = await setup(t, [songs[0]]);
    h.queues.set('alice', ['viewer1', 'viewer2'].map((username, i) => ({ id: username, username, media: `https://youtu.be/${songs[i + 1]}`, Platform: 'youtube' })));
    await h.mode({ mode: 'switch', mylistLoop: true });
    for (const source of ['requests', 'mylist', 'requests', 'mylist', 'mylist']) {
        const current = await h.current();
        assert.equal(current._source, source);
        await h.next(current);
    }
    assert.equal((await h.list()).length, 1);
});

test('clear and remove prevent looping entries from coming back', async t => {
    const h = await setup(t, [songs[0]]);
    await h.mode({ mylistLoop: true });
    let current = await h.current();
    await h.api('/api/mylist/alice/remove/0', 'POST');
    await h.next(current);
    assert.equal(await h.current(), null);
    await h.api('/api/mylist/alice/add', 'POST', { url: `https://youtu.be/${songs[1]}` });
    current = await h.current();
    await h.api('/api/mylist/alice', 'DELETE');
    await h.next(current);
    assert.equal(await h.current(), null);
});

test('failed upstream promotions never consume or duplicate an item', async t => {
    const h = await setup(t, [songs[0]]);
    await h.mode({ mylistLoop: true });
    const before = await h.list();
    for (const kind of ['network', 'http', 'payload']) {
        h.failPromotion(kind);
        assert.equal(await h.current(), null);
        assert.deepEqual(await h.list(), before);
    }
    assert.equal(idOf(await h.current()), songs[0]);
    assert.equal((await h.list()).length, 1);
});

test('clearing the list during a slow promotion never resurrects its entry', async t => {
    const h = await setup(t, [songs[0]]);
    await h.mode({ mylistLoop: true });
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    h.beforePromotion(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = h.current();
    await ready;
    await h.api('/api/mylist/alice', 'DELETE');
    release();
    const current = await pending;
    assert.deepEqual(await h.list(), []);
    await h.next(current);
    assert.equal(await h.current(), null);
});
