// Runs js/background.js in a sandbox with a fake chrome API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createStorageArea, createSyncArea} = require('./chrome_mock.js');
const {makeGroup, makeTabs} = require('./helpers.js');

const ROOT = path.join(__dirname, '..');
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));

function event() {
    const listeners = [];
    return {
        listeners,
        addListener: fn => listeners.push(fn),
        removeListener: fn => listeners.splice(listeners.indexOf(fn), 1),
        hasListener: fn => listeners.includes(fn),
    };
}

function startBackground({sync = createSyncArea(), local = createStorageArea()} = {}) {
    const chrome = {
        storage: {sync, local, session: createStorageArea(), onChanged: event()},
        runtime: {onInstalled: event(), onMessage: event(), onUpdateAvailable: event(), reload() {}},
        tabs: {
            query: (filter, callback) => callback([]),
            create() {},
            remove() {},
            onUpdated: event(),
            onMoved: event(),
            onAttached: event(),
            onRemoved: event(),
            onReplaced: event(),
        },
        windows: {create() {}},
        i18n: {getMessage: key => EN[key] ? EN[key].message : ''},
    };
    const context = vm.createContext({
        chrome, console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Blob, Response,
        CompressionStream, DecompressionStream, btoa, atob, structuredClone,
    });
    context.importScripts = function (...files) {
        files.forEach(function (file) {
            const code = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
            vm.runInContext(code, context, {filename: file});
        });
    };
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/background.js'), 'utf8'), context, {filename: 'background.js'});

    function send(msg) {
        return new Promise(function (resolve) {
            chrome.runtime.onMessage.listeners.forEach(fn => fn(msg, {}, resolve));
        }).then(res => JSON.parse(JSON.stringify(res))); // objects from the sandbox have their own prototypes
    }

    function groups(op, ...args) {
        return send({msg: 'groups', op, args});
    }

    return {chrome, send, groups};
}

async function waitFor(check, ms = 3000) {
    const start = Date.now();
    while (!(await check())) {
        if (Date.now() - start > ms) {
            throw new Error('timed out');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

function oldItem(n, seed) {
    return {name: 'old ' + seed, index: seed, color: '', tabs: makeTabs(n, seed)};
}

test('on start: 0.3.0 groups are migrated and listed', async () => {
    const sync = createSyncArea();
    const old = {};
    for (let i = 1; i <= 5; i++) {
        old['tg_' + (1700000000000 + i)] = oldItem(10 * i, i);
    }
    sync.rawSet(Object.assign({date_format: 'us'}, old));
    const bg = startBackground({sync});

    const res = await bg.groups('list');
    assert.deepEqual(Object.keys(res.result).sort(), Object.keys(old).sort());
    Object.keys(old).forEach(function (key) {
        assert.deepEqual(res.result[key], {name: old[key].name, index: old[key].index, tabs: old[key].tabs, synced: true});
    });
    const items = await sync.get(null);
    Object.keys(old).forEach(key => assert.equal(items[key].v, 2));
    assert.equal(items.date_format, 'us');
    assert.equal((await bg.chrome.storage.local.get('migration_v2')).migration_v2, 'done');
});

test('message API: save, remove, restore, usage', async () => {
    const bg = startBackground();
    const group = makeGroup(300, 1);

    assert.deepEqual(await bg.groups('save', 'tg_1', group), {result: {synced: true}});
    assert.deepEqual((await bg.groups('list')).result.tg_1, Object.assign({synced: true}, group));
    assert.deepEqual(await bg.groups('saveMany', {tg_2: makeGroup(5, 2)}), {result: {tg_2: {synced: true}}});

    assert.deepEqual(await bg.groups('remove', 'tg_1'), {result: {synced: true}});
    assert.deepEqual(Object.keys((await bg.groups('list')).result), ['tg_2']);
    assert.deepEqual((await bg.groups('listTrash')).result.map(g => g.key), ['tg_1']);
    assert.deepEqual(await bg.groups('restore', 'tg_1'), {result: {synced: true}});

    const usage = (await bg.groups('usage')).result;
    assert.equal(usage.quota, 102400);
    assert.equal(usage.unsynced, 0);
    assert.ok(usage.bytes > 0);
});

test('message API: unknown operation', async () => {
    const bg = startBackground();
    assert.deepEqual(await bg.groups('drop_everything'), {error: 'Unknown operation: drop_everything'});
});

test('a sync change from another device reaches the local copy', async () => {
    const sync = createSyncArea();
    const bg = startBackground({sync});
    await bg.groups('list');

    const item = oldItem(3, 7);
    sync.rawSet({tg_1700000000007: item});
    bg.chrome.storage.onChanged.listeners.forEach(fn => fn({tg_1700000000007: {newValue: item}}, 'sync'));

    await waitFor(async () => (await bg.chrome.storage.local.get('lg_1700000000007')).lg_1700000000007);
    const rec = (await bg.chrome.storage.local.get('lg_1700000000007')).lg_1700000000007;
    assert.deepEqual(rec.g.tabs, item.tabs);
    assert.equal(rec.synced, true);
});

test('session rotation counts only sessions, not saved group copies', async () => {
    const local = createStorageArea();
    const t0 = 1700000000000;
    for (let i = 0; i < 30; i++) {
        local.rawSet({['tg_' + (t0 + i)]: {name: '', tabs: []}});
    }
    for (let i = 0; i < 40; i++) {
        const g = makeGroup(1, i);
        local.rawSet({['lg_' + (t0 - 1000 + i)]: {g, h: 'x', synced: false, base: null}});
    }
    const bg = startBackground({local});

    await waitFor(async function () {
        const keys = Object.keys(await local.get(null));
        return !keys.includes('tg_' + t0) && keys.filter(k => k.startsWith('tg_')).length === 30;
    });
    await bg.groups('list');
    const keys = Object.keys(await local.get(null));
    assert.equal(keys.filter(k => k.startsWith('lg_')).length, 40);
    assert.ok(keys.includes('tg_' + (t0 + 1)), 'only the oldest session went');
});
