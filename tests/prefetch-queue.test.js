'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { upcomingMedia } = require('../scrs/backend/prefetch-queue');
const viewer = id => ({ id });
const owner = (id, extra) => ({ id, owner: true, ...extra });
const isOwner = item => !!item?.owner;
function lookahead(queue, personal, settings = {}, count = 5) {
    const before = JSON.stringify({ queue, personal });
    const result = upcomingMedia({ queue, personal, mode: { mode: 'requests', ...settings }, isOwner, count });
    assert.equal(JSON.stringify({ queue, personal }), before);
    return result.map(item => item.id);
}

test('request playback excludes current and falls back to personal songs after viewer requests', () => {
    assert.deepEqual(lookahead([viewer('current'), viewer('a'), viewer('b')], [owner('c')]), ['a', 'b', 'c']);
    assert.deepEqual(lookahead([], [], {}, 3), []);
});

test('My List takes priority and loop rotates through the current song at the tail', () => {
    assert.deepEqual(lookahead([owner('current'), viewer('r')], [owner('a'), owner('b')], { mode: 'mylist' }), ['a', 'b', 'r']);
    assert.deepEqual(lookahead([owner('c'), viewer('r')], [owner('a'), owner('b'), owner('c')],
        { mode: 'mylist', mylistLoop: true }), ['a', 'b', 'c', 'a', 'b']);
});

test('alternating plans flip the turn after the current song and handle an exhausted source', () => {
    const queue = [owner('current'), viewer('r1'), viewer('r2')];
    assert.deepEqual(lookahead(queue, [owner('m1'), owner('m2')], { mode: 'switch', switchTurn: 'mylist' }), ['r1', 'm1', 'r2', 'm2']);
    assert.deepEqual(lookahead([viewer('current'), viewer('r')], [owner('m1'), owner('m2')],
        { mode: 'switch', switchTurn: 'requests' }), ['m1', 'r', 'm2']);
    assert.deepEqual(lookahead(queue, [], { mode: 'switch', switchTurn: 'mylist' }), ['r1', 'r2']);
});

test('Play next uploads take priority once and queued owner tracks are not promoted over', () => {
    assert.deepEqual(lookahead([viewer('current'), viewer('r')], [owner('upload', { _playNext: true }), owner('m')],
        { mylistLoop: true }), ['upload', 'r', 'm', 'm', 'm']);
    assert.deepEqual(lookahead([viewer('current'), owner('queued'), viewer('r')], [owner('m')],
        { mode: 'mylist' }), ['queued', 'm', 'r']);
    assert.deepEqual(lookahead([viewer('current'), viewer('r')], [owner('m')], {}, 0), []);
});
