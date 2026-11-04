'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTick } = require('node:timers/promises');
const { createTestServer } = require('./helpers/server');
const { createMediaTools } = require('./helpers/media-tools');
const A = 'AAAAAAAAAAA', B = 'BBBBBBBBBBB', C = 'CCCCCCCCCCC', D = 'DDDDDDDDDDD';
async function until(predicate) {
    for (let i = 0; i < 2000; i++) { if (predicate()) return; await nextTick(); }
    throw new Error('Download priority did not reach expected state');
}
const downloads = tools => tools.calls.filter(call => call.command === 'yt-dlp');
const release = (tools, id) => tools.pending.findLast(item => item.call.args.at(-1).endsWith(id) && !item.call.signals.length)?.run();

test('viewer downloads interrupt a running personal prefetch and it resumes without failing its promise', async t => {
    const tools = createMediaTools({ blockDownloads: true });
    const h = await createTestServer({ cacheSpawn: tools.spawn });
    t.after(() => h.close());
    h.youtubeCache.plan('alice', null, [A, B]);
    const personal = h.youtubeCache.prepare(A, { priority: 1, direct: false });
    await until(() => tools.pending.some(item => item.call.args.at(-1).endsWith(A)));
    const first = downloads(tools)[0];
    h.youtubeVideoCache.plan('alice', C, [D]);
    await until(() => first.signals.includes('SIGTERM') && tools.pending.some(item => item.call.args.at(-1).endsWith(D)));
    await until(() => h.youtubeCache.status(A).stage === 'queued');
    assert.equal(h.youtubeCache.status(A).status, 'preparing');
    assert.equal(downloads(tools).some(call => call.args.at(-1).endsWith(B)), false);
    release(tools, C);
    await h.youtubeVideoCache.prepare(C);
    assert.equal(downloads(tools).filter(call => call.args.at(-1).endsWith(A)).length, 1);
    release(tools, D);
    await h.youtubeVideoCache.prepare(D);
    await until(() => downloads(tools).filter(call => call.args.at(-1).endsWith(A)).length === 2);
    await until(() => tools.pending.filter(item => item.call.args.at(-1).endsWith(A) && !item.call.signals.length).length === 1);
    release(tools, A);
    await personal;
    assert.equal(h.youtubeCache.status(A).status, 'ready');
    await until(() => tools.pending.some(item => item.call.args.at(-1).endsWith(B)));
    release(tools, B);
    await h.youtubeCache.prepare(B, { priority: 1, direct: false });
});

test('viewer requests warm ahead of personal lookahead even in My List mode, while current audio remains playable', async t => {
    const tools = createMediaTools({ blockDownloads: true });
    const h = await createTestServer({ cacheSpawn: tools.spawn });
    t.after(() => h.close());
    const cookie = await h.login();
    for (const id of ['M', 'N', 'O']) await h.request('/api/mylist/alice/add', { method: 'POST', cookie, body: { url: 'https://youtu.be/' + id.repeat(11) } });
    h.queues.set('alice', [A, B].map(id => ({ id, media: 'https://youtu.be/' + id, username: 'viewer' })));
    await h.request('/api/mode/alice', { method: 'POST', cookie, body: { mode: 'mylist' } });
    const current = (await h.request('/api/channels/alice/current')).data.current;
    assert.equal(current._source, 'mylist');
    await until(() => tools.pending.length === 2);
    assert.ok(downloads(tools)[0].args.at(-1).endsWith(A));
    assert.ok(downloads(tools)[1].args.at(-1).endsWith('MMMMMMMMMMM'));
    assert.equal(downloads(tools).some(call => call.args.at(-1).endsWith('NNNNNNNNNNN')), false);
    release(tools, 'MMMMMMMMMMM');
    await h.youtubeCache.prepare('MMMMMMMMMMM');
    assert.equal(h.youtubeCache.status('MMMMMMMMMMM').status, 'ready');
    release(tools, A);
    await h.youtubeVideoCache.prepare(A);
    await until(() => tools.pending.some(item => item.call.args.at(-1).endsWith(B)));
    assert.equal(downloads(tools).some(call => call.args.at(-1).endsWith('NNNNNNNNNNN')), false);
    release(tools, B);
    await h.youtubeVideoCache.prepare(B);
    await until(() => downloads(tools).some(call => call.args.at(-1).endsWith('NNNNNNNNNNN')));
    assert.equal(h.calls.filter(call => call.action === 'removemedia').length, 0);
});
