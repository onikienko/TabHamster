const test = require('node:test');
const assert = require('node:assert/strict');
const gs = require('../js/group_store.js');
const {makeClock, createStorageArea, createSyncArea, createSyncNetwork, MINUTE, HOUR} = require('./chrome_mock.js');
const {mulberry32, makeTabs, makeGroup, int} = require('./helpers.js');

const DAY = 24 * HOUR;
const QUOTA_ERROR = 'Resource::kQuotaBytes quota exceeded';
const RATE_ERROR = 'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.';

function makeDevice({clock = makeClock(), sync = createSyncArea(clock), seed = 1, on_synced} = {}) {
    const local = createStorageArea({clock});
    const store = gs.createGroupStore({sync, local, now: clock, random: mulberry32(seed), on_synced});
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

test('groups leave 1 KB of sync for settings; a write that shrinks a group may still use it', async () => {
    const {store, sync} = makeDevice();
    await store.save('tg_1', makeGroup(40, 1));
    // filled up to 600 bytes below the quota (as 0.4.0 could leave it)
    await fill(sync, sync.QUOTA_BYTES - 600);
    assert.deepEqual(await store.save('tg_2', makeGroup(3, 2)), {synced: false, error: QUOTA_ERROR});
    await sync.set({theme: 'dark', date_format: 'us'});
    // fewer tabs: smaller, so it goes to sync even inside the reserve
    assert.equal((await store.setTabs('tg_1', makeTabs(20, 1))).synced, true);
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

test('discard: gone everywhere, not in trash', async () => {
    const {store, sync} = makeDevice();
    await store.save('tg_1', makeGroup(400, 1));
    await store.save('tg_2', makeGroup(20, 2));

    assert.deepEqual(await store.discard('tg_1'), {synced: true});
    assert.deepEqual(Object.keys(await store.list()), ['tg_2']);
    assert.deepEqual(await store.listTrash(), []);
    assert.deepEqual(Object.keys(await syncGroups(sync)), ['tg_2'], 'header and chunks are gone');
    assert.deepEqual(await store.discard('tg_404'), {synced: true}, 'unknown key: nothing to do');
});

test('discard of a group changed since it was saved: it goes to trash instead', async () => {
    const {net, a, b} = await twoSyncedDevices();
    const saved = makeGroup(3, 1);
    await a.store.save('tg_1', saved);
    await a.store.save('tg_2', makeGroup(3, 2));
    await a.store.save('tg_3', makeGroup(3, 3));
    net.syncAll();
    await b.store.reconcile();

    await a.store.rename('tg_1', 'renamed');
    await a.store.setIndex({tg_2: 9});
    await b.store.setTabs('tg_3', makeTabs(1, 9));
    net.syncAll();
    await a.store.reconcile();
    for (const [key, group] of [['tg_1', saved], ['tg_2', makeGroup(3, 2)], ['tg_3', makeGroup(3, 3)]]) {
        assert.deepEqual(await a.store.discard(key, group), {synced: true});
    }
    const trash = await a.store.listTrash();
    assert.deepEqual(trash.map(g => [g.key, g.name, g.by]).sort(),
        [['tg_1', 'renamed', 'here'], ['tg_2', 'group 2', 'here'], ['tg_3', 'group 3', 'here']]);
    assert.deepEqual(await a.store.list(), {});

    // unchanged: gone for good
    await a.store.save('tg_4', makeGroup(2, 4));
    assert.deepEqual(await a.store.discard('tg_4', makeGroup(2, 4)), {synced: true});
    assert.equal((await a.store.listTrash()).length, 3);
});

test('a discard that cannot reach sync finishes on a later reconcile', async () => {
    const {store, sync, local} = makeDevice();
    await store.save('tg_1', makeGroup(20, 1));
    failWrites(sync, RATE_ERROR, 'remove');

    assert.deepEqual(await store.discard('tg_1'), {synced: false, error: RATE_ERROR});
    assert.deepEqual(await store.list(), {});
    assert.deepEqual(await store.listTrash(), [], 'hidden while waiting');
    await store.reconcile();
    assert.deepEqual(await store.list(), {}, 'still in sync, but stays discarded');

    sync.beforeWrite = null;
    await store.reconcile();
    assert.deepEqual(await sync.get(null), {});
    assert.deepEqual(Object.keys(await local.get(null)).filter(k => k.startsWith('lg_')), [], 'record dropped');
});

test('a discarded group brought back while its removal waits is an ordinary group again', async () => {
    const {store, sync} = makeDevice();
    await store.save('tg_1', makeGroup(3, 1));
    failWrites(sync, RATE_ERROR, 'remove');
    assert.equal((await store.discard('tg_1')).synced, false);
    sync.beforeWrite = null;
    // meanwhile gone from sync (removed on another computer), so restore pushes this record as it is
    await sync.remove('tg_1');

    assert.deepEqual(await store.restore('tg_1'), {synced: true});
    await store.reconcile();
    assert.deepEqual(plainList(await store.list()), {tg_1: makeGroup(3, 1)}, 'not dropped by the reconcile');
    await store.remove('tg_1');
    assert.deepEqual((await store.listTrash()).map(g => g.key), ['tg_1'], 'a later delete shows in trash');
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

// a popup open on a: it read tg_1, then b added a tab, which a has seen (reconciled) or not yet (only in sync)
async function staleView(reconciled) {
    const devices = await twoSyncedDevices(makeGroup(3, 1));
    const {net, a, b} = devices;
    const seen = (await a.store.list()).tg_1;
    const tabs_b = seen.tabs.concat({url: 'https://new.example/', title: 'from b'});
    await b.store.save('tg_1', {name: 'group 1', index: 1, tabs: tabs_b});
    net.syncAll();
    if (reconciled) {
        await a.store.reconcile();
    }
    return Object.assign(devices, {seen, tabs_b});
}

for (const reconciled of [true, false]) {
    const when = reconciled ? 'after' : 'before';

    test('a move or rename from an old view keeps tabs added on another device (' + when + ' reconcile)', async () => {
        const {net, a, b, tabs_b} = await staleView(reconciled);
        assert.deepEqual(await a.store.setIndex({tg_1: 5}), {tg_1: {synced: true}});
        assert.deepEqual(await a.store.rename('tg_1', 'renamed'), {synced: true});
        net.syncAll();
        await b.store.reconcile();
        const expected = {tg_1: {name: 'renamed', index: 5, tabs: tabs_b}};
        assert.deepEqual(plainList(await a.store.list()), expected);
        assert.deepEqual(plainList(await b.store.list()), expected);
    });

    test('tabs changed from an old view: kept as a copy next to the other device\'s (' + when + ' reconcile)', async () => {
        const {net, a, b, seen, tabs_b} = await staleView(reconciled);
        const tabs_a = seen.tabs.concat({url: 'https://other.example/', title: 'from a'});
        const res = await a.store.setTabs('tg_1', tabs_a, seen.h);
        assert.ok(res.copy);
        assert.equal(res.synced, true);
        assert.equal(res.h, gs.tabsHash(tabs_b));
        net.syncAll();
        await b.store.reconcile();
        const expected = {
            tg_1: {name: 'group 1', index: 1, tabs: tabs_b},
            [res.copy]: {name: 'group 1 (conflict)', index: 2, tabs: tabs_a},
        };
        assert.deepEqual(plainList(await a.store.list()), expected);
        assert.deepEqual(plainList(await b.store.list()), expected);
    });
}

test('setTabs keeps the current name and place, and answers the new hash', async () => {
    const {net, a, b} = await twoSyncedDevices(makeGroup(3, 1));
    const seen = (await a.store.list()).tg_1;
    await b.store.rename('tg_1', 'renamed on b');
    await b.store.setIndex({tg_1: 7});
    net.syncAll();
    await a.store.reconcile();

    const tabs = makeTabs(4, 9);
    const res = await a.store.setTabs('tg_1', tabs, seen.h);
    assert.deepEqual(res, {synced: true, h: gs.tabsHash(tabs)});
    assert.deepEqual(plainList(await a.store.list()), {tg_1: {name: 'renamed on b', index: 7, tabs}});
    // an undo with that hash puts the old tabs back
    assert.deepEqual(await a.store.setTabs('tg_1', seen.tabs, res.h), {synced: true, h: seen.h});
    assert.deepEqual((await a.store.list()).tg_1.tabs, seen.tabs);
});

test('setTabs with keep_old: the replaced version goes to trash; an undo takes it out again', async () => {
    const {store, sync} = makeDevice();
    const old = makeGroup(3, 1);
    await store.save('tg_1000', old);
    const seen = (await store.list()).tg_1000;

    const tabs = makeTabs(2, 5);
    const res = await store.setTabs('tg_1000', tabs, seen.h, true);
    assert.deepEqual(res, {synced: true, h: gs.tabsHash(tabs), kept: 'tg_1001'});
    const trash = await store.listTrash();
    assert.deepEqual(trash.map(g => [g.key, g.by]), [['tg_1001', 'replace']]);
    assert.deepEqual(plain(trash[0]), old);
    assert.deepEqual(Object.keys(await syncGroups(sync)), ['tg_1000'], 'kept on this computer only');

    // the popup's Undo
    await store.setTabs('tg_1000', old.tabs, res.h);
    assert.deepEqual(await store.discard(res.kept), {synced: true});
    assert.deepEqual(await store.listTrash(), []);
    assert.deepEqual(plainList(await store.list()), {tg_1000: old});

    // the same tabs again: nothing to keep
    assert.equal((await store.setTabs('tg_1000', old.tabs, undefined, true)).kept, undefined);
    assert.deepEqual(await store.listTrash(), []);
});

test('removeTab, editTab, addTab from an old view work on the tabs as they are now: no copy, nothing undone', async () => {
    const {store} = makeDevice();
    const t = makeTabs(5, 1).map((tab, i) => Object.assign(tab, {id: i}));
    await store.save('tg_1', {name: 'g', index: 1, tabs: t});
    // the popup's view, not read again between the changes
    const seen = (await store.list()).tg_1;

    const first = await store.removeTab('tg_1', seen.tabs[0], 0);
    assert.deepEqual(first, {synced: true, h: gs.tabsHash(t.slice(1)), before: t});
    assert.deepEqual(await store.removeTab('tg_1', seen.tabs[2], 2), {synced: true, h: gs.tabsHash([t[1], t[3], t[4]]),
        before: t.slice(1)});
    const edit = {url: 'https://x.example/', title: 'X'};
    await store.editTab('tg_1', seen.tabs[3], 3, edit);
    const now = [t[1], {url: edit.url, title: 'X', id: 3}, t[4]];
    assert.deepEqual(plainList(await store.list()), {tg_1: {name: 'g', index: 1, tabs: now}});

    // a tab that is gone: nothing to do
    const h = gs.tabsHash(now);
    assert.deepEqual(await store.removeTab('tg_1', seen.tabs[0], 0), {synced: true, h, unchanged: true});
    assert.deepEqual(await store.editTab('tg_1', seen.tabs[3], 3, {title: 'Y'}), {synced: true, h, unchanged: true});

    // a new tab gets an id of its own; an address the group has is not added again
    const added = await store.addTab('tg_1', {url: 'https://new.example/', title: 'New'});
    assert.deepEqual(added.before, now);
    assert.deepEqual((await store.list()).tg_1.tabs.at(-1), {url: 'https://new.example/', title: 'New', id: 5});
    assert.deepEqual(await store.addTab('tg_1', {url: t[4].url, title: 'again'}),
        {synced: true, h: added.h, unchanged: true});

    // the popup's Undo
    await store.setTabs('tg_1', added.before, added.h);
    assert.deepEqual(plainList(await store.list()), {tg_1: {name: 'g', index: 1, tabs: now}});
    assert.deepEqual(await store.removeTab('tg_9', t[0], 0), {synced: false, error: 'Group not found'});
});

test('removeTab keeps a change made on another computer meanwhile', async () => {
    const tabs = makeTabs(4, 1).map((tab, i) => Object.assign(tab, {id: i}));
    const {net, a, b} = await twoSyncedDevices({name: 'g', index: 1, tabs});
    const seen = (await a.store.list()).tg_1;
    await b.store.editTab('tg_1', tabs[1], 1, {title: 'from b'});
    net.syncAll();
    await a.store.reconcile();

    const res = await a.store.removeTab('tg_1', seen.tabs[3], 3);
    assert.equal(res.copy, undefined);
    assert.deepEqual(plainList(await a.store.list()),
        {tg_1: {name: 'g', index: 1, tabs: [tabs[0], Object.assign({}, tabs[1], {title: 'from b'}), tabs[2]]}});
});

test('findTab: the same id and address, the one at the place given if more match; nextTabId', () => {
    const tabs = [{url: 'u', id: 0}, {url: 'v', id: 1}, {url: 'u', id: 0}, {url: 'w', title: 'old'}];
    assert.equal(gs.findTab(tabs, {url: 'u', id: 0}, 2), 2);
    assert.equal(gs.findTab(tabs, {url: 'u', id: 0}, 1), 0);
    assert.equal(gs.findTab(tabs, {url: 'w', title: 'edited elsewhere'}, 0), 3);
    assert.equal(gs.findTab(tabs, {url: 'v', id: 2}, 1), -1);
    assert.equal(gs.findTab(tabs, {url: 'x', id: 1}, 1), -1);

    assert.equal(gs.nextTabId([]), 0);
    assert.equal(gs.nextTabId([{id: 0}, {id: 1}, {id: '2'}]), 3, '0.4.0 stores an edited tab\'s id as text');
    assert.equal(gs.nextTabId([{id: 4}, {}, {id: null}, {id: ''}, {id: 'x'}, {id: 1.5}]), 5);
});

test('edits of a group that is gone; a move leaves a deleted group alone, other edits bring it back', async () => {
    const {store} = makeDevice();
    await store.save('tg_1', makeGroup(3, 1));
    await store.save('tg_2', makeGroup(3, 2));
    await store.discard('tg_2');
    const not_found = {synced: false, error: 'Group not found'};
    assert.deepEqual(await store.rename('tg_2', 'x'), not_found);
    assert.deepEqual(await store.setTabs('tg_2', makeTabs(1, 3)), not_found);
    assert.deepEqual(await store.rename('tg_9', 'x'), not_found);

    await store.remove('tg_1');
    assert.deepEqual(await store.setIndex({tg_1: 4}), {tg_1: not_found});
    assert.deepEqual(await store.list(), {});
    assert.deepEqual(await store.rename('tg_1', 'back'), {synced: true});
    assert.deepEqual(plainList(await store.list()), {tg_1: {name: 'back', index: 1, tabs: makeTabs(3, 1)}});
    assert.deepEqual(await store.listTrash(), []);
});

test('a small group edited right after its save: its own write read back from sync is not another device\'s', async () => {
    const {store, sync} = makeDevice();
    // keys not in sorted order, as the popup makes them; sync gives them back sorted
    const tabs = [{url: 'https://a.example/', title: 'A', id: 0}, {url: 'https://b.example/', title: 'B', id: 1}];
    await store.save('tg_1', {name: 'small', index: 1, tabs});
    assert.ok(Array.isArray((await sync.get('tg_1')).tg_1.tabs), 'stored with plain tabs');
    assert.equal((await syncGroups(sync)).tg_1.h, (await store.list()).tg_1.h);

    const edited = tabs.concat({url: 'https://c.example/', title: 'C', id: 2});
    assert.deepEqual(await store.setTabs('tg_1', edited, (await store.list()).tg_1.h), {synced: true, h: gs.tabsHash(edited)});
    assert.deepEqual(plainList(await store.list()), {tg_1: {name: 'small', index: 1, tabs: edited}}, 'no conflict copy');
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

test('replaceAll: backup groups replace the current ones, which go to trash', async () => {
    const {store, sync} = makeDevice();
    await store.save('tg_1', makeGroup(20, 1));
    await store.save('tg_2', makeGroup(400, 2));
    const backup = {tg_2: makeGroup(30, 22), tg_3: makeGroup(5, 3)};

    assert.deepEqual(await store.replaceAll(backup), {saved: 2, removed: 2, errors: {}});
    assert.deepEqual(plainList(await store.list()), backup);
    const trash = await store.listTrash();
    // tg_3 is the backup's
    assert.deepEqual(trash.map(g => g.key).sort(), ['tg_1', 'tg_4'], 'the version of tg_2 it replaced is kept as tg_4');
    assert.deepEqual(trash.map(g => g.by), ['restore', 'restore']);
    assert.deepEqual(plain(trash.find(g => g.key === 'tg_4')), makeGroup(400, 2));
    const remote = await syncGroups(sync);
    assert.deepEqual(Object.keys(remote).sort(), ['tg_2', 'tg_3']);
    assert.deepEqual(await chunkKeys(sync), [], 'old chunks of tg_2 are gone');
});

test('replaceAll: a version the backup changes is kept in trash; one it has as it is, or with other tab ids, is not', async () => {
    const {store, sync} = makeDevice();
    const same = makeGroup(5, 1);
    await store.save('tg_100', same);
    await store.save('tg_200', makeGroup(5, 2));
    await store.save('tg_300', makeGroup(5, 3));
    const backup = {
        tg_100: Object.assign({}, same, {index: 9, tabs: same.tabs.map((tab, i) => Object.assign({}, tab, {id: 50 + i}))}),
        tg_200: makeGroup(5, 2, 'renamed in the backup'),
        tg_300: makeGroup(6, 3),
    };
    const res = await store.replaceAll(backup);
    assert.equal(res.removed, 2);
    const trash = await store.listTrash();
    assert.deepEqual(trash.map(g => [g.key, g.name]).sort(), [['tg_201', 'group 2'], ['tg_301', 'group 3']]);
    assert.deepEqual(trash.find(g => g.key === 'tg_301').tabs, makeTabs(5, 3));
    assert.deepEqual(plainList(await store.list()), backup);
    assert.deepEqual(Object.keys(await syncGroups(sync)).sort(), ['tg_100', 'tg_200', 'tg_300'], 'copies stay local');

    // brought back: a group of its own, synced
    assert.deepEqual(await store.restore('tg_301'), {synced: true});
    assert.deepEqual(Object.keys(await syncGroups(sync)).sort(), ['tg_100', 'tg_200', 'tg_300', 'tg_301']);
});

test('replaceAll with a nearly full sync: the backup still ends up in sync', async () => {
    const {store, sync} = makeDevice();
    for (let i = 1; i <= 6; i++) {
        await store.save('tg_' + i, makeGroup(250, i));
    }
    const backup = {};
    for (let i = 11; i <= 16; i++) {
        backup['tg_' + i] = makeGroup(250, i);
    }
    // old and new together don't fit: the new ones are first saved on this computer only
    assert.ok(await sync.getBytesInUse(null) > sync.QUOTA_BYTES / 2);

    const res = await store.replaceAll(backup);
    assert.equal(res.removed, 6);
    assert.deepEqual(res.errors, {});
    const list = await store.list();
    assert.deepEqual(plainList(list), backup);
    assert.ok(Object.values(list).every(g => g.synced));
    assert.deepEqual(Object.keys(await syncGroups(sync)).sort(), Object.keys(backup).sort());
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

test('without storage.getKeys (Chrome before 130) records are read from everything', async () => {
    const {store, local} = makeDevice();
    delete local.getKeys;
    local.rawSet({tg_1: {name: '', tabs: []}, restore_undo: {groups: {}}});
    await store.save('tg_2', makeGroup(3, 2));
    assert.deepEqual(plainList(await store.list()), {tg_2: makeGroup(3, 2)});
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

test('sizes: the space each group takes in sync, or needs there', async () => {
    const {store, sync} = makeDevice();
    await store.save('tg_1', makeGroup(20, 1));
    await store.save('tg_2', makeGroup(600, 2));
    await store.save('tg_3', makeGroup(400, 3, 'n'.repeat(9000)));
    await store.save('tg_4', makeGroup(5, 4));
    await store.remove('tg_4');
    failWrites(sync, RATE_ERROR);
    await store.save('tg_5', makeGroup(20, 5));

    const sizes = await store.sizes();
    const items = await sync.get(null);
    assert.deepEqual(Object.keys(sizes).sort(), ['tg_1', 'tg_2', 'tg_3', 'tg_5'], 'deleted groups are left out');
    assert.deepEqual(sizes.tg_1, {bytes: gs.itemBytes('tg_1', items.tg_1), synced: true});
    assert.ok((await chunkKeys(sync)).length > 1, 'tg_2 is chunked');
    assert.equal(sizes.tg_1.bytes + sizes.tg_2.bytes, await sync.getBytesInUse(null), 'item and chunks counted');
    assert.deepEqual(sizes.tg_3, {bytes: null, synced: false}, 'can never fit');
    assert.equal(sizes.tg_5.synced, false);

    sync.beforeWrite = null;
    await store.reconcile();
    assert.equal(await sync.getBytesInUse(null), sizes.tg_1.bytes + sizes.tg_2.bytes + sizes.tg_5.bytes,
        'what a group needs is what it takes once synced');
    assert.deepEqual((await store.sizes()).tg_5, {bytes: sizes.tg_5.bytes, synced: true});
});

test('on_synced: groups that waited for sync and got there', async () => {
    const calls = [];
    const {store, sync} = makeDevice({on_synced: keys => calls.push(keys)});
    await store.save('tg_1', makeGroup(400, 1));
    await fill(sync, 102000);
    assert.equal((await store.save('tg_2', makeGroup(100, 2))).synced, false);
    assert.equal((await store.save('tg_3', makeGroup(20, 3))).synced, false);
    assert.deepEqual(calls, []);

    // the call's own groups are not news: their result says it
    sync.rawRemove(['filler_0']);
    assert.deepEqual(await store.save('tg_3', makeGroup(21, 3)), {synced: true});
    assert.deepEqual(calls, []);

    await store.remove('tg_1');
    assert.deepEqual(calls, [], 'remove alone pushes nothing');
    await store.reconcile();
    assert.deepEqual(calls, [['tg_2']]);
    await store.reconcile();
    assert.deepEqual(calls, [['tg_2']], 'once');
});

test('a discard waiting for sync while another device saves the group again: nothing is lost', async () => {
    const {net, a, b} = await twoSyncedDevices(makeGroup(5, 1));
    failWrites(a.sync, RATE_ERROR, 'remove');
    assert.equal((await a.store.discard('tg_1')).synced, false);
    a.sync.beforeWrite = null;
    await b.store.setTabs('tg_1', makeTabs(7, 9));
    net.upload(b.dev);
    net.download(a.dev);
    // a finishes its discard: the group goes from sync, and b keeps its version in Recently deleted
    await a.store.reconcile();
    net.syncAll();
    await b.store.reconcile();
    assert.deepEqual(await a.store.list(), {});
    assert.deepEqual(await b.store.list(), {});
    const trash = await b.store.listTrash();
    assert.deepEqual(trash.map(g => [g.key, g.by, g.tabs.length]), [['tg_1', 'sync', 7]]);
});

test('on_synced: replaceAll doesn\'t report the groups it saved itself', async () => {
    const calls = [];
    const {store, sync} = makeDevice({on_synced: keys => calls.push(keys)});
    await store.save('tg_1', makeGroup(400, 1));
    await fill(sync, 102000);
    assert.equal((await store.save('tg_2', makeGroup(100, 2))).synced, false);
    // tg_1 goes to trash and frees room; tg_2 is in the backup, so its result says it
    const res = await store.replaceAll({tg_2: makeGroup(100, 2)});
    assert.deepEqual(res.errors, {});
    assert.equal((await store.list()).tg_2.synced, true);
    assert.deepEqual(calls, []);
});

test('renumbering many groups with sync nearly full: one by one, the rest go later', async () => {
    const {store, sync} = makeDevice();
    for (let i = 1; i <= 20; i++) {
        await store.save('tg_' + i, makeGroup(2, i, 'g' + i));
    }
    // too little room for 20 headers that each grow by 2 digits
    await fill(sync, sync.QUOTA_BYTES - 1024 - 20);
    const indexes = {};
    for (let i = 1; i <= 20; i++) {
        indexes['tg_' + i] = 100 + i;
    }
    const res = await store.setIndex(indexes);
    const synced = Object.values(res).filter(r => r.synced).length;
    assert.ok(synced > 0 && synced < 20, synced + ' synced');
    assert.ok(Object.values(res).filter(r => !r.synced).every(r => r.error === QUOTA_ERROR));
    const list = await store.list();
    assert.ok(Object.keys(indexes).every(key => list[key].index === indexes[key]), 'all moved here');

    sync.rawRemove(['filler_0']);
    await store.reconcile();
    const remote = await syncGroups(sync);
    assert.ok(Object.keys(indexes).every(key => remote[key].group.index === indexes[key]), 'all in sync later');
});

test('0.4.0 trash records (no trashed_by) list as deleted by someone not known', async () => {
    const {store, local} = makeDevice();
    local.rawSet({lg_1: {g: makeGroup(3, 1), h: gs.tabsHash(makeTabs(3, 1)), synced: false, base: null, trashed: Date.now()}});
    assert.deepEqual((await store.listTrash()).map(g => [g.key, g.by]), [['tg_1', null]]);
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
                    assert.match(results[i].errors[key] || '', /kQuotaBytes quota exceeded/, where + key);
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
