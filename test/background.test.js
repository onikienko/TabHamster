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

// windows and tabs that record what the background does with them. `active`: the active tab of window 1
function fakeBrowser(active) {
    const calls = [];
    // copies: objects from the sandbox have their own prototypes
    const record = (...call) => calls.push(JSON.parse(JSON.stringify(call)));
    let next_id = 100;
    return {
        calls,
        tabs: {
            query: (filter, callback) => (callback ? callback([]) : Promise.resolve(active ? [active] : [])),
            create: async function (props) {
                record('create', props);
                if (/^bad:/.test(props.url)) {
                    throw new Error('Cannot open ' + props.url);
                }
                return {id: next_id++, windowId: props.windowId};
            },
            update: async function (id, props) {
                record('update', id, props);
                return {id};
            },
        },
        windows: {
            create: async function (props) {
                record('window', props);
                const urls = [].concat(props.url || []);
                return {id: 7, tabs: urls.map(() => ({id: next_id++, windowId: 7}))};
            },
        },
    };
}

function startBackground({sync = createSyncArea(), local = createStorageArea(), browser = fakeBrowser()} = {}) {
    const chrome = {
        storage: {sync, local, session: createStorageArea(), onChanged: event()},
        runtime: {onInstalled: event(), onMessage: event(), onUpdateAvailable: event(), reload() {}},
        tabs: {
            query: browser.tabs.query,
            create: browser.tabs.create,
            update: browser.tabs.update,
            remove() {},
            onUpdated: event(),
            onMoved: event(),
            onAttached: event(),
            onRemoved: event(),
            onReplaced: event(),
        },
        windows: browser.windows,
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

const TABS = [
    {url: 'https://a.example/', pinned: true},
    {url: 'https://b.example/'},
    {url: 'https://c.example/'},
];

test('open in the current window: new tabs in order, the first one active', async () => {
    const browser = fakeBrowser({id: 1, windowId: 1, url: 'https://news.example/'});
    const bg = startBackground({browser});
    assert.deepEqual(await bg.send({msg: 'open', how: 'current', tabs: TABS, windowId: 1}), {result: {failed: 0}});
    assert.deepEqual(browser.calls, [
        ['create', {windowId: 1, url: 'https://a.example/', pinned: true, active: true}],
        ['create', {windowId: 1, url: 'https://b.example/', pinned: false, active: false}],
        ['create', {windowId: 1, url: 'https://c.example/', pinned: false, active: false}],
    ]);
});

test('open in the current window: a blank new tab takes the first tab', async () => {
    const browser = fakeBrowser({id: 1, windowId: 1, url: 'chrome://newtab/'});
    const bg = startBackground({browser});
    await bg.send({msg: 'open', how: 'current', tabs: TABS, windowId: 1});
    assert.deepEqual(browser.calls, [
        ['update', 1, {url: 'https://a.example/', pinned: true}],
        ['create', {windowId: 1, url: 'https://b.example/', pinned: false, active: false}],
        ['create', {windowId: 1, url: 'https://c.example/', pinned: false, active: false}],
    ]);
});

test('open in a new window: the window opens with the first tab, the rest follow; bad ones are skipped', async () => {
    const browser = fakeBrowser();
    const bg = startBackground({browser});
    const tabs = TABS.concat({url: 'bad:x'}, {url: 'https://d.example/'});
    assert.deepEqual(await bg.send({msg: 'open', how: 'window', tabs}), {result: {failed: 1}});
    assert.deepEqual(browser.calls.map(c => c[0] === 'window' ? c[1].url : c[0] === 'update' ? 'pin' : c[1].url), [
        'https://a.example/', 'pin', 'https://b.example/', 'https://c.example/', 'bad:x', 'https://d.example/']);
    assert.ok(browser.calls.filter(c => c[0] === 'create').every(c => c[1].windowId === 7 && !c[1].active));
});

test('open in incognito: one window with all tabs', async () => {
    const browser = fakeBrowser();
    const bg = startBackground({browser});
    await bg.send({msg: 'open', how: 'incognito', tabs: TABS});
    assert.deepEqual(browser.calls, [['window', {incognito: true, focused: true, url: TABS.map(t => t.url)}]]);
});

test('open: nothing to open, unknown way', async () => {
    const bg = startBackground();
    assert.deepEqual(await bg.send({msg: 'open', how: 'current', tabs: []}), {error: 'Nothing to open'});
    assert.deepEqual(await bg.send({msg: 'open', how: 'elsewhere', tabs: TABS}), {error: 'Nothing to open'});
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

const OPTIONS = {date_format: 'us', pinned: 1, cur_win: 0, active_tab: '#saved', session_watcher: 1};

async function backgroundWithGroups(groups_by_key) {
    const sync = createSyncArea();
    sync.rawSet(OPTIONS);
    const bg = startBackground({sync});
    for (const key of Object.keys(groups_by_key)) {
        await bg.groups('save', key, groups_by_key[key]);
    }
    return bg;
}

function listWithoutFlags(list) {
    const out = {};
    Object.keys(list).forEach(key => out[key] = {name: list[key].name, index: list[key].index, tabs: list[key].tabs});
    return out;
}

test('backup: export is readable JSON that restores the same groups and options', async () => {
    const groups = {tg_1700000000001: makeGroup(5, 1), tg_1700000000002: makeGroup(30, 2)};
    const bg = await backgroundWithGroups(groups);
    const text = (await bg.groups('exportBackup')).result;

    assert.ok(text.startsWith('{'), 'fits 0.3.0, so plain JSON');
    const data = JSON.parse(text);
    assert.deepEqual(data.tg_1700000000002, groups.tg_1700000000002);
    Object.keys(OPTIONS).forEach(key => assert.equal(data[key], OPTIONS[key]));

    const other = startBackground();
    assert.deepEqual(await other.groups('importBackup', text), {result: {groups: 2, errors: {}}});
    assert.deepEqual(listWithoutFlags((await other.groups('list')).result), groups);
    assert.equal((await other.chrome.storage.sync.get('date_format')).date_format, 'us');
});

test('backup: too big for 0.3.0 gets a first line 0.3.0 rejects, 0.4.0 skips it', async () => {
    const groups = {};
    for (let i = 1; i <= 4; i++) {
        groups['tg_' + (1700000000000 + i)] = makeGroup(400, i);
    }
    const bg = await backgroundWithGroups(groups);
    const text = (await bg.groups('exportBackup')).result;

    assert.ok(text.startsWith('TabHamster backup. Restore it with TabHamster 0.4.0 or newer.\n'));
    assert.throws(() => JSON.parse(text), 'what 0.3.0 does first');
    const other = startBackground();
    assert.equal((await other.groups('importBackup', text)).result.groups, 4);
    assert.deepEqual(listWithoutFlags((await other.groups('list')).result), groups);
});

test('backup: restoring a 0.3.0 backup replaces groups, and can be undone', async () => {
    const current = {tg_1700000000001: makeGroup(5, 1), tg_1700000000002: makeGroup(5, 2)};
    const bg = await backgroundWithGroups(current);
    const old_backup = {
        date_format: 'eu',
        pinned: 0,
        tg_1600000000001: {name: 'from 0.3.0', index: 1, color: '', tabs: [
            {url: 'https://example.com/', title: 'Example', id: 5},
            {url: 'https://example.org/', id: 5, pinned: true},
        ]},
    };

    assert.deepEqual(await bg.groups('importBackup', JSON.stringify(old_backup)), {result: {groups: 1, errors: {}}});
    assert.deepEqual(listWithoutFlags((await bg.groups('list')).result), {tg_1600000000001: {name: 'from 0.3.0', index: 1, tabs: [
        {url: 'https://example.com/', title: 'Example', id: 0},
        {url: 'https://example.org/', title: 'https://example.org/', id: 1, pinned: true},
    ]}});
    assert.deepEqual((await bg.groups('listTrash')).result.map(g => g.key).sort(), Object.keys(current));
    assert.equal((await bg.chrome.storage.sync.get('date_format')).date_format, 'eu');
    assert.equal(typeof (await bg.groups('restoreInfo')).result, 'number');

    assert.deepEqual(await bg.groups('undoRestore'), {result: {groups: 2, errors: {}}});
    assert.deepEqual(listWithoutFlags((await bg.groups('list')).result), current);
    assert.equal((await bg.chrome.storage.sync.get('date_format')).date_format, 'us');
    assert.equal((await bg.groups('restoreInfo')).result, null);
    assert.deepEqual(await bg.groups('undoRestore'), {result: {error: 'nothing_to_undo'}});
});

test('backup: bad input changes nothing', async () => {
    const current = {tg_1700000000001: makeGroup(5, 1)};
    const bg = await backgroundWithGroups(current);
    const damaged = JSON.stringify({tg_1: {v: 2, name: 'x', index: 1, h: 'abc', w: 'lzz0aaaa', n: 2}, pinned: 1});
    const cases = [
        ['hello', 'not_backup'],
        ['[]', 'not_backup'],
        ['null', 'not_backup'],
        ['"text"', 'not_backup'],
        ['{}', 'empty'],
        ['{"something": 1}', 'empty'],
        [damaged, 'damaged'],
    ];
    for (const [text, code] of cases) {
        assert.deepEqual(await bg.groups('importBackup', text), {result: {error: code}}, text);
    }
    assert.deepEqual(listWithoutFlags((await bg.groups('list')).result), current);
    assert.deepEqual((await bg.groups('listTrash')).result, []);
    assert.equal((await bg.groups('restoreInfo')).result, null);
});

test('backup: raw sync data with chunks can be restored', async () => {
    const groups = {tg_1700000000001: makeGroup(400, 1), tg_1700000000002: makeGroup(3, 2)};
    const bg = await backgroundWithGroups(groups);
    const raw = await bg.chrome.storage.sync.get(null);
    assert.ok(Object.keys(raw).some(k => k.startsWith('tc_')), 'has chunks');

    const other = startBackground();
    assert.equal((await other.groups('importBackup', JSON.stringify(raw))).result.groups, 2);
    assert.deepEqual(listWithoutFlags((await other.groups('list')).result), groups);
});

test('backup: options only leave groups alone', async () => {
    const current = {tg_1700000000001: makeGroup(5, 1)};
    const bg = await backgroundWithGroups(current);
    assert.deepEqual(await bg.groups('importBackup', '{"date_format": "eu"}'), {result: {groups: 0, errors: {}}});
    assert.deepEqual(listWithoutFlags((await bg.groups('list')).result), current);
    assert.equal((await bg.chrome.storage.sync.get('date_format')).date_format, 'eu');
});
