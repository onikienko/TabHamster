const test = require('node:test');
const assert = require('node:assert/strict');
const gs = require('../js/group_store.js');
const {SYNC_LIMITS, chromeItemSize} = require('./chrome_size.js');
const {mulberry32, makeGroup, nastyText, int} = require('./helpers.js');

const KEY = 'tg_1728900000000';
const QUOTA = SYNC_LIMITS.QUOTA_BYTES_PER_ITEM;

function assertItemsFit(items) {
    for (const [key, value] of Object.entries(items)) {
        assert.ok(chromeItemSize(key, value) <= QUOTA, key + ' is ' + chromeItemSize(key, value) + ' bytes');
    }
}

async function roundTrip(group, key = KEY) {
    const enc = await gs.encodeGroup(key, group, QUOTA);
    assertItemsFit(enc.items);
    const dec = await gs.decodeGroup(key, enc.items);
    assert.equal(dec.status, 'ok');
    assert.deepEqual(dec.group, gs.normalizeGroup(group));
    assert.equal(dec.h, enc.h);
    return enc;
}

test('round trip for different group sizes', async () => {
    for (const n of [0, 1, 2, 20, 58, 200, 1000]) {
        await roundTrip(makeGroup(n, n + 1));
    }
});

test('tiny groups are written in exact v1 shape', async () => {
    for (const n of [0, 1]) {
        const enc = await roundTrip(makeGroup(n, 7));
        assert.deepEqual(Object.keys(enc.items), [KEY]);
        assert.deepEqual(Object.keys(enc.items[KEY]), ['name', 'index', 'tabs']);
        assert.equal(enc.n, 0);
    }
});

test('medium group is one compressed item', async () => {
    const enc = await roundTrip(makeGroup(20, 3));
    const item = enc.items[KEY];
    assert.deepEqual(Object.keys(enc.items), [KEY]);
    assert.equal(item.v, 2);
    assert.equal(typeof item.d, 'string');
    assert.equal(item.tabs, undefined);
    assert.equal(item.name, 'group 3');
    assert.equal(item.index, 3);
});

test('big group is a header plus chunks', async () => {
    const enc = await roundTrip(makeGroup(400, 5));
    const header = enc.items[KEY];
    assert.equal(header.v, 2);
    assert.equal(header.w, enc.w);
    assert.equal(header.n, enc.n);
    assert.ok(enc.n >= 2);
    assert.equal(header.tabs, undefined);
    assert.equal(header.d, undefined);
    assert.equal(Object.keys(enc.items).length, enc.n + 1);
    for (let i = 0; i < enc.n; i++) {
        const ck = gs.chunkKey(KEY, enc.w, i);
        assert.equal(typeof enc.items[ck], 'string');
        assert.deepEqual(gs.parseChunkKey(ck), {key: KEY, w: enc.w, i});
    }
});

test('group ids with underscores and odd chunk keys', async () => {
    for (const key of ['tg_my_old_group', 'tg_' + 'x_'.repeat(150) + 'end']) {
        const enc = await roundTrip(makeGroup(400, 15), key);
        assert.ok(enc.n >= 2);
        for (let i = 0; i < enc.n; i++) {
            assert.deepEqual(gs.parseChunkKey(gs.chunkKey(key, enc.w, i)), {key, w: enc.w, i});
        }
    }
    for (const bad of ['tc_', 'tc_123', 'tc_123_abc', 'tc_123_ABC_0', 'tc_123_abc_x', 'tg_123_abc_0']) {
        assert.equal(gs.parseChunkKey(bad), null, bad);
    }
});

test('special characters and huge urls survive', async () => {
    const rnd = mulberry32(42);
    const group = makeGroup(30, 9, 'Назва групи ґ є і ї <b>"x"</b> 😀');
    group.tabs[0].title = '<'.repeat(3000);
    group.tabs[1].title = '\u2028\u2029'.repeat(500);
    group.tabs[2].title = nastyText(rnd, 2000);
    group.tabs[3].url = 'data:text/plain;base64,' + Buffer.from(nastyText(rnd, 40000)).toString('base64');
    await roundTrip(group);
});

test('decoder prefers tabs over v2 fields (0.3.0 overwrote a v2 item)', async () => {
    const tabs = [{url: 'https://example.com/', title: 'Example', id: 0}];
    const items = {[KEY]: {v: 2, name: 'x', index: 4, color: '', h: 'abc', w: 'lzz0aaaa', n: 3, tabs}};
    const dec = await gs.decodeGroup(KEY, items);
    assert.equal(dec.status, 'ok');
    assert.deepEqual(dec.group, {name: 'x', index: 4, tabs});
    assert.equal(dec.n, 0);
});

test('unused color from 0.3.0 is dropped', async () => {
    const tabs = [{url: 'https://example.com/', title: 'Example', id: 0}];
    const dec = await gs.decodeGroup(KEY, {[KEY]: {name: 'x', index: 2, color: '', tabs}});
    assert.deepEqual(dec.group, {name: 'x', index: 2, tabs});
    for (const n of [1, 20, 400]) {
        const enc = await gs.encodeGroup(KEY, {...makeGroup(n, 13), color: 'red'}, QUOTA);
        assert.ok(!('color' in enc.items[KEY]));
    }
});

test('missing chunks make a group incomplete', async () => {
    const enc = await gs.encodeGroup(KEY, makeGroup(400, 11), QUOTA);
    const items = {...enc.items};
    delete items[gs.chunkKey(KEY, enc.w, 1)];
    let dec = await gs.decodeGroup(KEY, items);
    assert.equal(dec.status, 'incomplete');
    assert.equal(dec.w, enc.w);

    // chunks from another write don't count
    const other = await gs.encodeGroup(KEY, makeGroup(400, 11), QUOTA, Date.now() + 1000);
    const mixed = {[KEY]: enc.items[KEY]};
    for (const k of Object.keys(other.items)) {
        if (gs.isChunkKey(k)) {
            mixed[k] = other.items[k];
        }
    }
    dec = await gs.decodeGroup(KEY, mixed);
    assert.equal(dec.status, 'incomplete');
});

test('corrupt and missing items', async () => {
    const good = await gs.encodeGroup(KEY, makeGroup(20, 12), QUOTA);
    const cases = [
        {[KEY]: {v: 2, name: 'x', index: 1, color: '', d: 'not base64 !!!'}},
        {[KEY]: {...good.items[KEY], h: 'wrong'}},
        {[KEY]: {name: 'x', index: 1}},
        {[KEY]: null},
        {[KEY]: 'string'},
    ];
    for (const items of cases) {
        assert.equal((await gs.decodeGroup(KEY, items)).status, 'corrupt');
    }
    assert.equal((await gs.decodeGroup(KEY, {})).status, 'missing');
});

test('encoding needs the quota from the storage area', async () => {
    await assert.rejects(gs.encodeGroup(KEY, makeGroup(1, 1)), /quota_per_item is required/);
});

test('write id keeps its time', () => {
    const rnd = mulberry32(3);
    for (const now of [0, 1728900000000, Date.now()]) {
        const w = gs.writeId(now, rnd);
        assert.match(w, /^[0-9a-z]+$/);
        assert.equal(gs.writeIdTime(w), now);
    }
});

test('itemBytes never undercounts Chromium size', () => {
    const rnd = mulberry32(5);
    for (let i = 0; i < 500; i++) {
        const key = 'tg_' + int(rnd, 1e13);
        const value = {name: nastyText(rnd, 30), index: int(rnd, 100), color: '', tabs: [
            {url: nastyText(rnd, int(rnd, 200)), title: nastyText(rnd, int(rnd, 200)), id: i, pinned: rnd() < 0.5},
        ]};
        assert.ok(gs.itemBytes(key, value) >= chromeItemSize(key, value));
    }
});

test('fuzz: every item fits and round-trips', async () => {
    const rnd = mulberry32(2026);
    for (let i = 0; i < 150; i++) {
        const n = int(rnd, 300);
        const group = {name: nastyText(rnd, int(rnd, 40)), index: int(rnd, 50), tabs: []};
        for (let t = 0; t < n; t++) {
            const tab = rnd() < 0.5
                ? {url: 'https://' + nastyText(rnd, int(rnd, 300)), title: nastyText(rnd, int(rnd, 120)), id: t}
                : makeGroup(1, i * 1000 + t).tabs[0];
            group.tabs.push(tab);
        }
        await roundTrip(group, 'tg_' + (1700000000000 + i));
    }
});

test('incompressible tab near the item limit: v1 shape stays under it', async () => {
    const rnd = mulberry32(78);
    let largest_v1 = 0;
    for (let len = 6000; len <= 8400; len += 50) {
        // random printable ASCII (includes '<') doesn't compress, so v1 shape wins until it stops fitting
        let url = 'https://';
        for (let i = 0; i < len; i++) {
            url += String.fromCharCode(0x21 + int(rnd, 94));
        }
        const enc = await roundTrip({name: 'n', index: 1, tabs: [{url, title: 't', id: 0}]});
        if (Array.isArray(enc.items[KEY].tabs)) {
            largest_v1 = Math.max(largest_v1, chromeItemSize(KEY, enc.items[KEY]));
        }
    }
    assert.ok(largest_v1 > 8000, 'v1 shape was not tested near the limit: ' + largest_v1);
});

test('decodeGroup: data that inflates past 16 MB is damaged, not read', async () => {
    const zlib = require('node:zlib');
    const big = JSON.stringify([{url: 'https://a.example/', title: 'x'.repeat(17 * 1024 * 1024)}]);
    const d = zlib.deflateRawSync(Buffer.from(big)).toString('base64');
    assert.ok(d.length < 100000, 'small when compressed');
    const res = await gs.decodeGroup('tg_1', {tg_1: {v: 2, name: 'bomb', index: 1, h: gs.hash(big), d}});
    assert.equal(res.status, 'corrupt');
});
