const test = require('node:test');
const assert = require('node:assert/strict');
const gs = require('../js/group_store.js');
const {makeClock, createStorageArea, createSyncArea, createSyncNetwork, MINUTE, HOUR} = require('./chrome_mock.js');
const {mulberry32, makeTabs, makeGroup, int} = require('./helpers.js');

const DAY = 24 * HOUR;
const QUOTA_ERROR = 'QUOTA_BYTES quota exceeded';
const RATE_ERROR = 'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.';

function makeDevice({clock = makeClock(), sync = createSyncArea(clock), seed = 1} = {}) {
    const local = createStorageArea({clock});
    const store = gs.createGroupStore({sync, local, now: clock, random: mulberry32(seed)});
    return {clock, sync, local, store};
}

// a device connected to a sync network; `dev` is its connection for upload/download
function makeNetDevice(net, clock, seed) {
    const dev = net.addDevice();
    return Object.assign(makeDevice({clock, sync: dev.area, seed}), {dev});
}

async function twoSyncedDevices(group) {
    const clock = makeClock();
    const net = createSyncNetwork(clock);
    const a = makeNetDevice(net, clock, 1);
    const b = makeNetDevice(net, clock, 2);
    if (group) {
        await a.store.save('tg_1', group);
        net.syncAll();
        await b.store.reconcile();
    }
    return {clock, net, a, b};
}

// 0.3.0 item: unused color, titles cut to 49 chars
function oldItem(n, seed) {
    return {
        name: 'old ' + seed,
        index: seed,
        color: '',
        tabs: makeTabs(n, seed).map(t => Object.assign({}, t, {title: t.title.slice(0, 49)})),
    };
}

function plain(group) {
    return {name: group.name, index: group.index, tabs: group.tabs};
}

function plainList(list) {
    const out = {};
    Object.keys(list).forEach(key => out[key] = plain(list[key]));
    return out;
}

async function syncGroups(area) {
    const items = await area.get(null);
    const out = {};
    for (const key of Object.keys(items).filter(gs.isGroupKey)) {
        out[key] = await gs.decodeGroup(key, items);
    }
    return out;
}

async function chunkKeys(area) {
    return Object.keys(await area.get(null)).filter(gs.isChunkKey);
}

// fill sync with non-group items up to about `target` bytes
async function fill(sync, target) {
    let i = 0;
    while (await sync.getBytesInUse(null) < target - 8000) {
        sync.rawSet({['filler_' + i++]: 'x'.repeat(7900)});
    }
    const rest = target - await sync.getBytesInUse(null) - ('filler_' + i).length - 2;
    if (rest > 0) {
        sync.rawSet({['filler_' + i]: 'x'.repeat(rest)});
    }
}

function failWrites(area, message, op) {
    area.beforeWrite = function (write_op) {
        if (!op || op === write_op) {
            throw new Error(message);
        }
    };
}

test('save small, medium and big groups', async () => {
    const {store, sync} = makeDevice();
    const groups = {tg_1000: makeGroup(1, 1), tg_2000: makeGroup(20, 2), tg_3000: makeGroup(400, 3)};
    for (const key of Object.keys(groups)) {
        assert.deepEqual(await store.save(key, groups[key]), {synced: true});
    }
    const list = await store.list();
    assert.deepEqual(plainList(list), groups);
    Object.values(list).forEach(g => assert.equal(g.synced, true));

    const remote = await syncGroups(sync);
    Object.keys(groups).forEach(key => assert.deepEqual(remote[key].group, groups[key]));
    const items = await sync.get(null);
    assert.ok(Array.isArray(items.tg_1000.tabs));
    assert.equal(typeof items.tg_2000.d, 'string');
    assert.ok(items.tg_3000.n >= 2);
});

test('chunked update: new chunks, then header, then old chunks go', async () => {
    const {store, sync} = makeDevice();
    await store.save('tg_1', makeGroup(400, 1));
    const old_w = (await sync.get('tg_1')).tg_1.w;
    const mark = sync.log.length;

    assert.deepEqual(await store.save('tg_1', makeGroup(400, 2)), {synced: true});
    const ops = sync.log.slice(mark);
    const new_w = (await sync.get('tg_1')).tg_1.w;
    assert.notEqual(new_w, old_w);
    assert.equal(ops.length, 3);
    assert.equal(ops[0].op, 'set');
    assert.ok(ops[0].keys.every(k => gs.parseChunkKey(k).w === new_w));
    assert.deepEqual(ops[1], {op: 'set', keys: ['tg_1']});
    assert.equal(ops[2].op, 'remove');
    assert.ok(ops[2].keys.every(k => gs.parseChunkKey(k).w === old_w));
    assert.equal((await chunkKeys(sync)).length, (await sync.get('tg_1')).tg_1.n);
});

test('saveMany swaps two groups with one write', async () => {
    const {store, sync} = makeDevice();
    const a = makeGroup(20, 1);
    const b = makeGroup(20, 2);
    await store.save('tg_1', a);
    await store.save('tg_2', b);
    const mark = sync.log.length;
    const res = await store.saveMany({
        tg_1: Object.assign({}, a, {index: b.index}),
        tg_2: Object.assign({}, b, {index: a.index}),
    });
    assert.deepEqual(res, {tg_1: {synced: true}, tg_2: {synced: true}});
    assert.deepEqual(sync.log.slice(mark), [{op: 'set', keys: ['tg_1', 'tg_2']}]);
    const remote = await syncGroups(sync);
    assert.equal(remote.tg_1.group.index, b.index);
    assert.equal(remote.tg_2.group.index, a.index);
});

test('sync full: saved locally, pushed once there is room', async () => {
    const {store, sync} = makeDevice();
    await fill(sync, 98000);
    const mark = sync.log.length;
    const group = makeGroup(100, 1);

    assert.deepEqual(await store.save('tg_1', group), {synced: false, error: QUOTA_ERROR});
    assert.equal(sync.log.length, mark, 'no write was tried');
    const list = await store.list();
    assert.deepEqual(plain(list.tg_1), group);
    assert.equal(list.tg_1.synced, false);
    assert.equal((await store.usage()).unsynced, 1);

    sync.rawRemove(Object.keys(await sync.get(null)).filter(k => k.startsWith('filler_')));
    await store.reconcile();
    assert.equal((await store.list()).tg_1.synced, true);
    assert.deepEqual((await syncGroups(sync)).tg_1.group, group);
    assert.equal((await store.usage()).unsynced, 0);
});

test('write rate limit: saves stay local and go to sync later', async () => {
    const {store, sync, clock} = makeDevice();
    const results = [];
    for (let i = 0; i < 130; i++) {
        results.push(await store.save('tg_' + (1000 + i), makeGroup(1, i)));
    }
    assert.equal(results.filter(r => r.synced).length, 120);
    assert.deepEqual(results[125], {synced: false, error: RATE_ERROR});

    clock.advance(MINUTE + 1);
    await store.reconcile();
    const list = await store.list();
    assert.equal(Object.keys(list).length, 130);
    assert.ok(Object.values(list).every(g => g.synced));
    assert.equal(Object.keys(await syncGroups(sync)).length, 130);
});

test('a group whose header cannot fit stays local', async () => {
    const {store, sync} = makeDevice();
    const group = makeGroup(400, 1, 'n'.repeat(9000));
    const res = await store.save('tg_1', group);
    assert.equal(res.synced, false);
    assert.match(res.error, /header is too big/);
    assert.deepEqual(plain((await store.list()).tg_1), group);
    assert.deepEqual(await sync.get(null), {});
});

test('nearly full sync: old chunks are removed before new ones are written', async () => {
    const {store, sync} = makeDevice();
    await store.save('tg_1', makeGroup(600, 1));
    await fill(sync, 92000);
    const mark = sync.log.length;

    const updated = makeGroup(600, 2);
    assert.deepEqual(await store.save('tg_1', updated), {synced: true});
    assert.deepEqual(sync.log.slice(mark).map(e => e.op), ['remove', 'set', 'set']);
    assert.deepEqual((await syncGroups(sync)).tg_1.group, updated);
});

test('remove goes to trash, restore brings the group back', async () => {
    const {store, sync} = makeDevice();
    const group = makeGroup(400, 1);
    await store.save('tg_1', group);

    assert.deepEqual(await store.remove('tg_1'), {synced: true});
    assert.deepEqual(await store.list(), {});
    assert.deepEqual(await sync.get(null), {}, 'header and chunks are gone');
    const trash = await store.listTrash();
    assert.equal(trash.length, 1);
    assert.equal(trash[0].key, 'tg_1');

    assert.deepEqual(await store.restore('tg_1'), {synced: true});
    assert.deepEqual(plain((await store.list()).tg_1), group);
    assert.deepEqual((await syncGroups(sync)).tg_1.group, group);
    assert.deepEqual(await store.listTrash(), []);
});

test('a failed sync removal is retried, not undone', async () => {
    const {store, sync} = makeDevice();
    await store.save('tg_1', makeGroup(20, 1));
    failWrites(sync, RATE_ERROR, 'remove');

    assert.deepEqual(await store.remove('tg_1'), {synced: false, error: RATE_ERROR});
    assert.deepEqual(await store.list(), {});
    await store.reconcile();
    assert.deepEqual(await store.list(), {}, 'still in sync, but stays deleted');

    sync.beforeWrite = null;
    await store.reconcile();
    assert.deepEqual(await sync.get(null), {});
    assert.deepEqual(await store.list(), {});
    assert.equal((await store.listTrash()).length, 1);
});

test('reconcile follows changes from another device', async () => {
    const {clock, net, a, b} = await twoSyncedDevices();
    await a.store.save('tg_1', makeGroup(3, 1));
    await a.store.save('tg_2', makeGroup(400, 2));
    net.syncAll();
    await b.store.reconcile();
    assert.deepEqual(plainList(await b.store.list()), plainList(await a.store.list()));

    await a.store.save('tg_1', makeGroup(3, 1, 'renamed'));
    await a.store.save('tg_2', makeGroup(400, 22));
    net.syncAll();
    await b.store.reconcile();
    assert.deepEqual(plainList(await b.store.list()), plainList(await a.store.list()));

    await a.store.remove('tg_1');
    net.syncAll();
    await b.store.reconcile();
    assert.deepEqual(Object.keys(await b.store.list()), ['tg_2']);
    assert.deepEqual((await b.store.listTrash()).map(g => g.key), ['tg_1']);

    clock.advance(31 * DAY);
    await b.store.reconcile();
    assert.deepEqual(await b.store.listTrash(), []);
});

test('a local edit that could not sync is pushed later', async () => {
    const {net, a, b} = await twoSyncedDevices(makeGroup(20, 1));
    failWrites(b.sync, RATE_ERROR);
    const edited = Object.assign(makeGroup(20, 2), {name: 'group 1', index: 1});
    assert.equal((await b.store.save('tg_1', edited)).synced, false);

    b.sync.beforeWrite = null;
    await b.store.reconcile();
    net.syncAll();
    await a.store.reconcile();
    assert.deepEqual(plain((await a.store.list()).tg_1), edited);
});

test('tabs edited on two devices: both versions are kept', async () => {
    const {net, a, b} = await twoSyncedDevices(makeGroup(20, 1));
    const from_a = Object.assign(makeGroup(20, 2), {name: 'group 1', index: 1});
    const from_b = Object.assign(makeGroup(20, 3), {name: 'group 1', index: 1});

    await a.store.save('tg_1', from_a);
    // b edits before it has seen a's change, and can't reach sync
    failWrites(b.sync, RATE_ERROR);
    assert.equal((await b.store.save('tg_1', from_b)).synced, false);
    b.sync.beforeWrite = null;

    net.upload(a.dev);
    net.download(b.dev);
    const res = await b.store.reconcile();
    const copy_key = res.copies.tg_1;
    assert.ok(copy_key);

    const list = await b.store.list();
    assert.deepEqual(plain(list.tg_1), from_a);
    assert.deepEqual(list[copy_key].tabs, from_b.tabs);
    assert.equal(list[copy_key].name, 'group 1 (conflict)');

    net.syncAll();
    await a.store.reconcile();
    assert.deepEqual(plainList(await a.store.list()), plainList(list));
});

test('a conflict copy of an unnamed group stays unnamed', async () => {
    const {net, a, b} = await twoSyncedDevices(makeGroup(20, 1, ''));
    await a.store.save('tg_1', makeGroup(20, 2, ''));
    failWrites(b.sync, RATE_ERROR);
    await b.store.save('tg_1', makeGroup(20, 3, ''));
    b.sync.beforeWrite = null;

    net.upload(a.dev);
    net.download(b.dev);
    const copy_key = (await b.store.reconcile()).copies.tg_1;
    const list = await b.store.list();
    assert.equal(list[copy_key].name, '');
    assert.deepEqual(list[copy_key].tabs, makeTabs(20, 3));
});

test('rename on one device and new tabs on another are merged', async () => {
    const {net, a, b} = await twoSyncedDevices(makeGroup(20, 1));
    failWrites(a.sync, RATE_ERROR);
    await a.store.save('tg_1', makeGroup(20, 1, 'renamed on a'));
    a.sync.beforeWrite = null;
    const tabs_b = makeTabs(20, 5);
    await b.store.save('tg_1', {name: 'group 1', index: 1, tabs: tabs_b});

    net.upload(b.dev);
    net.download(a.dev);
    const res = await a.store.reconcile();
    assert.deepEqual(res.copies, {});
    assert.deepEqual(plainList(await a.store.list()), {tg_1: {name: 'renamed on a', index: 1, tabs: tabs_b}});

    net.syncAll();
    await b.store.reconcile();
    assert.deepEqual(plainList(await b.store.list()), plainList(await a.store.list()));
});

test('chunks that arrive before their header are not deleted', async () => {
    const {net, a, b} = await twoSyncedDevices();
    const group = makeGroup(400, 1);
    await a.store.save('tg_1', group);
    net.upload(a.dev);

    net.download(b.dev, gs.isChunkKey);
    await b.store.reconcile();
    assert.deepEqual(await b.store.list(), {});
    assert.ok((await chunkKeys(b.sync)).length >= 2, 'chunks kept');
    assert.equal(b.dev.outbox.size, 0, 'b wrote nothing');

    net.download(b.dev);
    await b.store.reconcile();
    assert.deepEqual(plain((await b.store.list()).tg_1), group);
});

test('a header that arrives before its chunks keeps the old version until they come', async () => {
    const {net, a, b} = await twoSyncedDevices(makeGroup(400, 1));
    const updated = makeGroup(400, 2);
    updated.name = 'group 1';
    updated.index = 1;
    await a.store.save('tg_1', updated);
    net.upload(a.dev);

    net.download(b.dev, gs.isGroupKey);
    await b.store.reconcile();
    const list = await b.store.list();
    assert.deepEqual(plain(list.tg_1), makeGroup(400, 1));
    assert.equal(b.dev.outbox.size, 0, 'b wrote nothing');

    net.download(b.dev);
    await b.store.reconcile();
    assert.deepEqual(plain((await b.store.list()).tg_1), updated);
});

test('a header whose chunks never come is repaired from the local copy after a day', async () => {
    const {clock, net, a, b} = await twoSyncedDevices(makeGroup(400, 1));
    await a.store.save('tg_1', Object.assign(makeGroup(400, 2), {name: 'group 1', index: 1}));
    net.upload(a.dev);
    // chunks get lost on the way
    Array.from(net.server.keys()).filter(gs.isChunkKey).forEach(k => net.server.delete(k));
    net.download(b.dev);

    await b.store.reconcile();
    assert.equal((await syncGroups(b.sync)).tg_1.status, 'incomplete');
    clock.advance(DAY + 1);
    await b.store.reconcile();
    const remote = await syncGroups(b.sync);
    assert.equal(remote.tg_1.status, 'ok');
    assert.deepEqual(remote.tg_1.group, makeGroup(400, 1));
});

test('a rename racing a removal on another device: the edit wins, nothing breaks', async () => {
    const {net, a, b} = await twoSyncedDevices(makeGroup(400, 1));
    await b.store.remove('tg_1');
    net.upload(b.dev);
    // a hasn't seen the removal yet
    await a.store.save('tg_1', makeGroup(400, 1, 'renamed'));
    net.upload(a.dev);
    net.download(a.dev);
    net.download(b.dev);
    assert.equal((await syncGroups(a.sync)).tg_1.status, 'ok');

    await a.store.reconcile();
    await b.store.reconcile();
    const expected = {tg_1: Object.assign(makeGroup(400, 1), {name: 'renamed'})};
    assert.deepEqual(plainList(await a.store.list()), expected);
    assert.deepEqual(plainList(await b.store.list()), expected, 'edit wins over the removal');
    assert.equal((await syncGroups(b.sync)).tg_1.status, 'ok');
});

test('leftover chunks are removed after a day, chunks in use stay', async () => {
    const {store, sync, clock} = makeDevice();
    const group = makeGroup(400, 1);
    await store.save('tg_1', group);
    const in_use = await chunkKeys(sync);
    const orphan = gs.chunkKey('tg_99', gs.writeId(clock(), Math.random), 0);
    sync.rawSet({[orphan]: 'AAAA'});

    await store.reconcile();
    assert.ok((await chunkKeys(sync)).includes(orphan));
    clock.advance(DAY + 1);
    await store.reconcile();
    assert.deepEqual((await chunkKeys(sync)).sort(), in_use.sort());
    assert.deepEqual((await syncGroups(sync)).tg_1.group, group);
});

test('0.3.0 overwriting a chunked group: its tabs win, old chunks go', async () => {
    const {store, sync} = makeDevice();
    await store.save('tg_1', makeGroup(400, 1));
    const header = (await sync.get('tg_1')).tg_1;
    // 0.3.0 keeps the other fields and replaces tabs
    const tabs = makeTabs(5, 9);
    sync.rawSet({tg_1: Object.assign({}, header, {tabs})});

    await store.reconcile();
    assert.deepEqual((await store.list()).tg_1.tabs, tabs);
    assert.deepEqual(await chunkKeys(sync), []);
});

test('everything removed from sync goes to trash, nothing is lost', async () => {
    const {store, sync} = makeDevice();
    const groups = {};
    for (let i = 1; i <= 5; i++) {
        groups['tg_' + i] = makeGroup(i * 50, i);
        await store.save('tg_' + i, groups['tg_' + i]);
    }
    sync.rawRemove(Object.keys(await sync.get(null)));

    await store.reconcile();
    assert.deepEqual(await store.list(), {});
    assert.equal((await store.listTrash()).length, 5);
    for (const key of Object.keys(groups)) {
        assert.deepEqual(await store.restore(key), {synced: true});
    }
    assert.deepEqual(plainList(await store.list()), groups);
    const remote = await syncGroups(sync);
    Object.keys(groups).forEach(key => assert.deepEqual(remote[key].group, groups[key]));
});

test('a group in a newer format is left alone', async () => {
    const {store, sync} = makeDevice();
    const group = makeGroup(20, 1);
    await store.save('tg_1', group);
    const newer = {v: 3, name: 'from the future', index: 1, x: 'abc'};
    sync.rawSet({tg_1: newer});
    const mark = sync.log.length;

    await store.reconcile();
    assert.equal(sync.log.length, mark);
    assert.deepEqual((await sync.get('tg_1')).tg_1, newer);
    assert.deepEqual(plain((await store.list()).tg_1), group);
});

test('migration from 0.3.0', async () => {
    const {store, sync, local} = makeDevice();
    const old = {};
    for (let i = 1; i <= 30; i++) {
        old['tg_' + (1700000000000 + i)] = oldItem(1 + (i % 40), i);
    }
    const options = {date_format: 'eu', pinned: 0, cur_win: 1, active_tab: '#saved', session_watcher: 1};
    sync.rawSet(Object.assign({}, old, options));
    const before = await sync.getBytesInUse(null);

    const res = await store.migrate();
    assert.ok(res.converted >= 25, 'converted ' + res.converted);
    assert.ok(await sync.getBytesInUse(null) < before);
    assert.equal(sync.log.filter(e => e.op === 'set').length, 2, 'batches of 20');
    assert.equal(sync.log.filter(e => e.op === 'remove').length, 0);

    const items = await sync.get(null);
    Object.keys(options).forEach(k => assert.equal(items[k], options[k]));
    const remote = await syncGroups(sync);
    const list = await store.list();
    Object.keys(old).forEach(function (key) {
        assert.deepEqual(remote[key].group, plain(old[key]));
        assert.deepEqual(plain(list[key]), plain(old[key]));
        assert.equal(list[key].synced, true);
    });

    const mark = sync.log.length + local.log.length;
    assert.deepEqual(await store.migrate(), {converted: 0});
    assert.equal(sync.log.length + local.log.length, mark, 'second run writes nothing');
});

test('migration survives being stopped at any write', async () => {
    const old = {};
    for (let i = 1; i <= 30; i++) {
        old['tg_' + (1700000000000 + i)] = oldItem(1 + (i % 40), i);
    }

    async function run(stop_after) {
        const clock = makeClock();
        const sync = createSyncArea(clock);
        sync.rawSet(old);
        const before = await sync.getBytesInUse(null);
        const local = createStorageArea({clock});
        let writes = 0;
        const stop = function () {
            if (writes++ >= stop_after) {
                throw new Error('service worker stopped');
            }
        };
        sync.beforeWrite = stop;
        local.beforeWrite = stop;
        try {
            await gs.createGroupStore({sync, local, now: clock}).migrate();
        } catch (e) {
            // stopped
        }
        sync.beforeWrite = null;
        local.beforeWrite = null;
        assert.ok(await sync.getBytesInUse(null) <= before);
        const remote = await syncGroups(sync);
        Object.keys(old).forEach(key => assert.deepEqual(remote[key].group, plain(old[key])));

        // next service worker start
        const store = gs.createGroupStore({sync, local, now: clock});
        await store.migrate();
        assert.deepEqual(plainList(await store.list()), Object.fromEntries(
            Object.keys(old).map(key => [key, plain(old[key])])));
        assert.ok(await sync.getBytesInUse(null) < before);
        return writes;
    }

    const total = await run(Infinity);
    for (let stop_after = 0; stop_after < total; stop_after++) {
        await run(stop_after);
    }
});

test('migration converts one by one when a batch fails', async () => {
    const {store, sync} = makeDevice();
    const old = {};
    for (let i = 1; i <= 25; i++) {
        old['tg_' + (1700000000000 + i)] = oldItem(20, i);
    }
    sync.rawSet(old);
    sync.beforeWrite = function (op, keys) {
        if (op === 'set' && keys.length > 1) {
            throw new Error(RATE_ERROR);
        }
    };
    assert.deepEqual(await store.migrate(), {converted: 25});
    const items = await sync.get(null);
    Object.keys(old).forEach(key => assert.equal(items[key].v, 2));
});

test('calls are queued', async () => {
    const {store, sync} = makeDevice();
    const versions = [makeGroup(400, 1), makeGroup(20, 2), makeGroup(400, 3)];
    await Promise.all(versions.map(g => store.save('tg_1', g)));
    assert.deepEqual(plain((await store.list()).tg_1), versions[2]);
    assert.deepEqual((await syncGroups(sync)).tg_1.group, versions[2]);
    assert.equal((await chunkKeys(sync)).length, (await sync.get('tg_1')).tg_1.n);
});

test('usage', async () => {
    const {store, sync} = makeDevice();
    await store.save('tg_1', makeGroup(20, 1));
    failWrites(sync, RATE_ERROR);
    await store.save('tg_2', makeGroup(20, 2));
    assert.deepEqual(await store.usage(), {
        bytes: await sync.getBytesInUse(null),
        quota: sync.QUOTA_BYTES,
        unsynced: 1,
    });
});

test('fuzz: two devices end up with the same groups', async () => {
    let converged = 0;
    for (let seed = 1; seed <= 20; seed++) {
        const rnd = mulberry32(seed);
        const {clock, net, a, b} = await twoSyncedDevices();
        const devices = [a, b];
        let next_key = 0;
        const tabCount = () => rnd() < 0.15 ? 100 + int(rnd, 150) : int(rnd, 40);

        for (let step = 0; step < 120; step++) {
            clock.advance(int(rnd, 20000));
            const d = devices[int(rnd, 2)];
            const list = await d.store.list();
            const keys = Object.keys(list);
            const r = rnd();
            if ((r < 0.25 && keys.length < 10) || !keys.length) {
                const key = 'tg_' + (1800000000000 + next_key++ * 2 + devices.indexOf(d));
                await d.store.save(key, makeGroup(tabCount(), int(rnd, 1e6)));
            } else if (r < 0.45) {
                const key = keys[int(rnd, keys.length)];
                await d.store.save(key, Object.assign({}, list[key], {tabs: makeTabs(tabCount(), int(rnd, 1e6))}));
            } else if (r < 0.55) {
                const key = keys[int(rnd, keys.length)];
                await d.store.save(key, Object.assign({}, list[key], {name: 'n' + step}));
            } else if (r < 0.65) {
                await d.store.remove(keys[int(rnd, keys.length)]);
            } else if (r < 0.7) {
                const trash = await d.store.listTrash();
                if (trash.length) {
                    await d.store.restore(trash[int(rnd, trash.length)].key);
                }
            } else if (r < 0.8) {
                d.sync.beforeWrite = d.sync.beforeWrite ? null : function () {
                    throw new Error(RATE_ERROR);
                };
            } else if (r < 0.9) {
                net.upload(d.dev);
                const other = devices[1 - devices.indexOf(d)];
                net.download(other.dev, () => rnd() < 0.7);
            } else {
                await d.store.reconcile();
            }
        }

        devices.forEach(d => d.sync.beforeWrite = null);
        clock.advance(HOUR + 1);
        // like onChanged in the extension: keep reconciling until nobody has anything new to send
        let results;
        let rounds = 0;
        do {
            assert.ok(rounds++ < 10, 'seed ' + seed + ': devices keep writing');
            net.syncAll();
            results = [await a.store.reconcile(), await b.store.reconcile()];
        } while (a.dev.outbox.size || b.dev.outbox.size);
        net.syncAll();

        const remote = await syncGroups(a.sync);
        const lists = [await a.store.list(), await b.store.list()];
        lists.forEach(function (list, i) {
            const where = 'seed ' + seed + ', device ' + 'ab'[i] + ', ';
            Object.keys(list).forEach(function (key) {
                if (list[key].synced) {
                    assert.deepEqual(remote[key] && remote[key].group, plain(list[key]), where + key);
                } else {
                    // only a group that doesn't fit in sync may stay on one device
                    assert.match(results[i].errors[key] || '', /QUOTA_BYTES quota exceeded/, where + key);
                }
            });
            Object.keys(remote).filter(key => remote[key].status === 'ok')
                .forEach(key => assert.ok(list[key], where + key + ' is in sync but not listed'));
        });
        if (Object.values(lists[0]).concat(Object.values(lists[1])).every(g => g.synced)) {
            assert.deepEqual(plainList(lists[1]), plainList(lists[0]), 'seed ' + seed);
            converged++;
        }
    }
    assert.ok(converged >= 10, 'only ' + converged + ' runs had everything in sync');
});
