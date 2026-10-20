// Runs js/background.js in a sandbox with a fake chrome API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createStorageArea, createSyncArea} = require('./chrome_mock.js');
const {makeGroup, makeTabs} = require('./helpers.js');
const {tabsHash} = require('../js/group_store.js');

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
                const bad = urls.find(url => /^(bad|javascript):/.test(url));
                if (bad) {
                    throw new Error('Cannot open ' + bad);
                }
                return {id: 7, tabs: urls.map(() => ({id: next_id++, windowId: 7}))};
            },
        },
    };
}

function startBackground({sync = createSyncArea(), local = createStorageArea(), session = createStorageArea(),
    browser = fakeBrowser()} = {}) {
    // messages the background sends to open pages; like Chrome, it fails when no page listens
    const sent = [];
    const chrome = {
        storage: {sync, local, session, onChanged: event()},
        runtime: {
            onInstalled: event(), onMessage: event(), onUpdateAvailable: event(), reload() {},
            sendMessage(msg) {
                sent.push(JSON.parse(JSON.stringify(msg)));
                return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
            },
        },
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

    return {chrome, send, groups, sent};
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
        assert.deepEqual(res.result[key], {name: old[key].name, index: old[key].index, tabs: old[key].tabs,
            h: tabsHash(old[key].tabs), synced: true});
    });
    const items = await sync.get(null);
    Object.keys(old).forEach(key => assert.equal(items[key].v, 2));
    assert.equal(items.date_format, 'us');
    assert.equal((await bg.chrome.storage.local.get('migration_v2')).migration_v2, 'done');
});

test('message API: save, edits, remove, restore, usage', async () => {
    const bg = startBackground();
    const group = makeGroup(300, 1);

    assert.deepEqual(await bg.groups('save', 'tg_1', group), {result: {synced: true}});
    const h = (await bg.groups('list')).result.tg_1.h;
    assert.deepEqual((await bg.groups('list')).result.tg_1, Object.assign({synced: true, h}, group));
    assert.deepEqual(await bg.groups('save', 'tg_2', makeGroup(5, 2)), {result: {synced: true}});
    assert.deepEqual(await bg.groups('setIndex', {tg_2: 9}), {result: {tg_2: {synced: true}}});
    assert.deepEqual(await bg.groups('rename', 'tg_2', 'renamed'), {result: {synced: true}});
    const tabs = makeTabs(2, 3);
    const set = (await bg.groups('setTabs', 'tg_2', tabs, (await bg.groups('list')).result.tg_2.h)).result;
    assert.equal(set.synced, true);
    assert.equal(set.copy, undefined);
    assert.deepEqual((await bg.groups('list')).result.tg_2, {name: 'renamed', index: 9, tabs, h: set.h, synced: true});

    assert.deepEqual(await bg.groups('remove', 'tg_1'), {result: {synced: true}});
    assert.deepEqual(Object.keys((await bg.groups('list')).result), ['tg_2']);
    assert.deepEqual((await bg.groups('listTrash')).result.map(g => g.key), ['tg_1']);
    assert.deepEqual(await bg.groups('restore', 'tg_1'), {result: {synced: true}});

    const usage = (await bg.groups('usage')).result;
    assert.equal(usage.quota, 102400);
    assert.equal(usage.unsynced, 0);
    assert.ok(usage.bytes > 0);
});

test('message API: sizes; open pages hear when waiting groups get to sync', async () => {
    const sync = createSyncArea();
    const bg = startBackground({sync});
    await bg.groups('save', 'tg_1', makeGroup(400, 1));
    sync.rawSet({filler: 'x'.repeat(102400 - await sync.getBytesInUse(null) - 600)});
    assert.equal((await bg.groups('save', 'tg_2', makeGroup(50, 2))).result.synced, false);

    const sizes = (await bg.groups('sizes')).result;
    assert.equal(sizes.tg_1.synced, true);
    assert.ok(sizes.tg_1.bytes > 1000);
    assert.equal(sizes.tg_2.synced, false);
    assert.ok(sizes.tg_2.bytes > 600, 'needs more than is free');
    assert.deepEqual(bg.sent, []);

    await bg.groups('remove', 'tg_1');
    assert.equal((await bg.groups('list')).result.tg_2.synced, true, 'the list catches up with sync first');
    assert.deepEqual(bg.sent, [{msg: 'groupsSynced', keys: ['tg_2']}]);
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

test('open in the current window: some bad tabs are counted, all bad is an error', async () => {
    const browser = fakeBrowser({id: 1, windowId: 1, url: 'https://news.example/'});
    const bg = startBackground({browser});
    assert.deepEqual(await bg.send({msg: 'open', how: 'current', tabs: [{url: 'bad:1'}].concat(TABS), windowId: 1}),
        {result: {failed: 1}});
    assert.deepEqual(await bg.send({msg: 'open', how: 'current', tabs: [{url: 'bad:1'}, {url: 'bad:2'}], windowId: 1}),
        {error: 'Cannot open bad:2'});
});

test('open in the current window: no active tab found, the tabs still open there', async () => {
    const browser = fakeBrowser();
    const bg = startBackground({browser});
    assert.deepEqual(await bg.send({msg: 'open', how: 'current', tabs: TABS, windowId: 1}), {result: {failed: 0}});
    assert.deepEqual(browser.calls.map(c => [c[0], c[1].windowId, c[1].active]),
        [['create', 1, true], ['create', 1, false], ['create', 1, false]]);
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

test('open in a new window: a first tab Chrome refuses doesn\'t stop the others', async () => {
    const browser = fakeBrowser();
    const bg = startBackground({browser});
    const tabs = [{url: 'bad:1'}, {url: 'javascript:void(0)'}].concat(TABS);
    assert.deepEqual(await bg.send({msg: 'open', how: 'window', tabs}), {result: {failed: 2}});
    assert.deepEqual(browser.calls.map(c => c[0] + ' ' + (c[0] === 'update' ? c[2].pinned : c[1].url)), [
        'window bad:1', 'window javascript:void(0)', 'window https://a.example/', 'update true',
        'create https://b.example/', 'create https://c.example/']);
});

test('open in a new window: nothing Chrome accepts is an error', async () => {
    const bg = startBackground();
    assert.deepEqual(await bg.send({msg: 'open', how: 'window', tabs: [{url: 'bad:1'}, {url: 'bad:2'}]}),
        {error: 'Cannot open bad:2'});
});

test('open a session window: into a window that is only a blank new tab, else a new window', async () => {
    const blank = fakeBrowser({id: 1, windowId: 1, url: 'chrome://newtab/'});
    await startBackground({browser: blank}).send({msg: 'open', how: 'blankOrWindow', tabs: TABS, windowId: 1});
    assert.deepEqual(blank.calls.map(c => c[0]), ['update', 'create', 'create']);

    const busy = fakeBrowser({id: 1, windowId: 1, url: 'https://news.example/'});
    await startBackground({browser: busy}).send({msg: 'open', how: 'blankOrWindow', tabs: TABS, windowId: 1});
    assert.deepEqual(busy.calls.map(c => c[0]), ['window', 'update', 'create', 'create']);
});

test('open in incognito: one window with all tabs', async () => {
    const browser = fakeBrowser();
    const bg = startBackground({browser});
    await bg.send({msg: 'open', how: 'incognito', tabs: TABS});
    assert.deepEqual(browser.calls, [['window', {incognito: true, focused: true, url: TABS.map(t => t.url)}]]);
});

test('open in incognito: a refused address doesn\'t stop the others', async () => {
    const browser = fakeBrowser();
    const bg = startBackground({browser});
    const tabs = TABS.concat({url: 'javascript:void(0)'}, {url: 'chrome://settings/'});
    assert.deepEqual(await bg.send({msg: 'open', how: 'incognito', tabs}), {result: {failed: 2}});
    assert.deepEqual(browser.calls.map(c => c[1].url), [tabs.map(t => t.url), TABS.map(t => t.url)]);

    const only_bad = startBackground();
    assert.deepEqual(await only_bad.send({msg: 'open', how: 'incognito', tabs: [{url: 'bad:1'}, TABS[0]]}),
        {error: 'Cannot open bad:1'});
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

test('the current session is written with the time it last changed', async () => {
    const local = createStorageArea();
    const before = Date.now();
    startBackground({local});
    let session;
    await waitFor(async function () {
        const items = await local.get(null);
        session = Object.keys(items).filter(k => k.startsWith('tg_')).map(k => items[k])[0];
        return !!session;
    });
    assert.ok(session.updated >= before && session.updated <= Date.now());
    assert.deepEqual(session.tabs, []);
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
    const trash = (await bg.groups('listTrash')).result;
    assert.deepEqual(trash.map(g => g.key).sort(), Object.keys(current));
    assert.deepEqual(trash.map(g => g.by), ['restore', 'restore']);
    assert.equal((await bg.chrome.storage.sync.get('date_format')).date_format, 'eu');
    const info = (await bg.groups('restoreInfo')).result;
    assert.equal(typeof info.time, 'number');
    assert.deepEqual([info.restored, info.trashed], [1, 2]);

    assert.deepEqual(await bg.groups('previewUndoRestore'),
        {result: {groups: 2, tabs: 10, options: true, current: 1, trashed: 1}}, 'the restored group goes');
    assert.deepEqual(await bg.groups('undoRestore'), {result: {groups: 2, errors: {}}});
    assert.deepEqual(listWithoutFlags((await bg.groups('list')).result), current);
    assert.equal((await bg.chrome.storage.sync.get('date_format')).date_format, 'us');
    assert.equal((await bg.groups('restoreInfo')).result, null);
    assert.deepEqual(await bg.groups('undoRestore'), {result: {error: 'nothing_to_undo'}});
    assert.deepEqual(await bg.groups('previewUndoRestore'), {result: {error: 'nothing_to_undo'}});
});

test('backup: undo of a restore made with no groups saved: every group goes', async () => {
    const bg = startBackground();
    await bg.groups('importBackup', JSON.stringify({tg_1600000000001: makeGroup(3, 1), tg_1600000000002: makeGroup(3, 2)}));
    assert.equal((await bg.groups('previewUndoRestore')).result.trashed, 2);
    await bg.groups('undoRestore');
    assert.deepEqual((await bg.groups('list')).result, {});
});

test('backup: a restore made by 0.4.0 (no counts in its snapshot) shows and undoes', async () => {
    const current = {tg_1700000000001: makeGroup(5, 1)};
    const bg = await backgroundWithGroups(current);
    await bg.chrome.storage.local.set({restore_undo: {time: 1700000000000, groups: {tg_1600000000001: makeGroup(3, 2)},
        options: OPTIONS}});
    assert.deepEqual((await bg.groups('restoreInfo')).result, {time: 1700000000000, restored: null, trashed: null});
    assert.deepEqual(await bg.groups('undoRestore'), {result: {groups: 1, errors: {}}});
    assert.deepEqual(listWithoutFlags((await bg.groups('list')).result), {tg_1600000000001: makeGroup(3, 2)});
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
        assert.deepEqual(await bg.groups('previewBackup', text), {result: {error: code}}, text);
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

test('backup: hand-edited option values come in as the extension uses them, odd ones are left out', async () => {
    const bg = await backgroundWithGroups({tg_1700000000001: makeGroup(5, 1)});
    const text = JSON.stringify({pinned: 2, cur_win: true, session_watcher: 0, date_format: 'iso', theme: 'pink', active_tab: '#sessions'});
    assert.deepEqual(await bg.groups('importBackup', text), {result: {groups: 0, errors: {}}});
    const options = await bg.chrome.storage.sync.get(['pinned', 'cur_win', 'session_watcher', 'date_format', 'theme', 'active_tab']);
    // date_format and theme as they were (theme never set here)
    assert.deepEqual(options, {pinned: 1, cur_win: 1, session_watcher: 0, date_format: 'us', active_tab: '#sessions'});
});

test('backup: javascript: addresses are left out', async () => {
    const bg = startBackground();
    const text = JSON.stringify({tg_1600000000001: {name: 'x', index: 1, tabs: [
        {url: ' JavaScript:alert(1)', title: 'bad'}, {url: 'https://example.com/', title: 'ok'}]}});
    await bg.groups('importBackup', text);
    assert.deepEqual((await bg.groups('list')).result.tg_1600000000001.tabs, [{url: 'https://example.com/', title: 'ok', id: 0}]);
});

test('backup: preview says what a restore would do and changes nothing', async () => {
    const current = {tg_1700000000001: makeGroup(5, 1), tg_1700000000002: makeGroup(5, 2), tg_1700000000003: makeGroup(5, 3)};
    const bg = await backgroundWithGroups(current);
    const backup_text = JSON.stringify({
        date_format: 'eu',
        tg_1700000000001: makeGroup(7, 11),
        tg_1600000000001: makeGroup(3, 12),
    });
    // 2 not in the backup, 1 changed by it; a group it has as it is doesn't count
    const same_text = JSON.stringify({tg_1700000000001: current.tg_1700000000001, tg_1700000000002: makeGroup(5, 2)});
    assert.equal((await bg.groups('previewBackup', same_text)).result.trashed, 1);

    assert.deepEqual(await bg.groups('previewBackup', backup_text),
        {result: {groups: 2, tabs: 10, options: true, current: 3, trashed: 3}});
    assert.deepEqual(listWithoutFlags((await bg.groups('list')).result), current);
    assert.equal((await bg.chrome.storage.sync.get('date_format')).date_format, 'us');
    assert.equal((await bg.groups('restoreInfo')).result, null);

    // settings only: groups are left alone
    assert.deepEqual(await bg.groups('previewBackup', JSON.stringify({pinned: 0})),
        {result: {groups: 0, tabs: 0, options: true, current: 3, trashed: 0}});
});

test('trash: says where a group was deleted', async () => {
    const bg = await backgroundWithGroups({tg_1: makeGroup(3, 1), tg_2: makeGroup(3, 2)});
    await bg.groups('remove', 'tg_1');
    // gone from sync: deleted on another computer
    await bg.chrome.storage.sync.remove('tg_2');
    await bg.groups('list');

    const trash = (await bg.groups('listTrash')).result;
    assert.deepEqual(trash.map(g => [g.key, g.by]).sort(), [['tg_1', 'here'], ['tg_2', 'sync']]);
    await bg.groups('restore', 'tg_2');
    await bg.groups('remove', 'tg_2');
    assert.equal((await bg.groups('listTrash')).result.find(g => g.key === 'tg_2').by, 'here');
});

// a few turns of the event loop, for the background's storage calls
async function settle() {
    for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

async function sessionKeys(local) {
    return Object.keys(await local.get(null)).filter(k => k.startsWith('tg_'));
}

test('sessions: a start-up and a switch at the same time start one session', async () => {
    const local = createStorageArea();
    const session = createStorageArea();
    // a new session starts by setting session_id (each in its own millisecond in Chrome, so a second one is a second session)
    let started = 0;
    const set = session.set.bind(session);
    session.set = items => {
        started += items.session_id ? 1 : 0;
        return set(items);
    };
    const bg = startBackground({local, session});
    // the worker woke up because the option changed: start-up and the storage listener both see sessions on
    bg.chrome.storage.onChanged.listeners.forEach(fn => fn({session_watcher: {newValue: 1}}, 'sync'));
    bg.chrome.tabs.onRemoved.listeners.forEach(fn => fn(5, {}));
    await settle();
    assert.equal(started, 1);
    assert.equal((await sessionKeys(local)).length, 1);
});

test('sessions: turned off while a session is being written, it stays off', async () => {
    const sync = createSyncArea();
    const bg = startBackground({sync});
    await waitFor(async () => (await bg.chrome.storage.session.get('session_id')).session_id);
    await bg.chrome.storage.session.remove('session_id');
    // a tab event starts a new session; the switch comes before that write is done
    bg.chrome.tabs.onRemoved.listeners.forEach(fn => fn(5, {}));
    await sync.set({session_watcher: 0});
    bg.chrome.storage.onChanged.listeners.forEach(fn => fn({session_watcher: {newValue: 0}}, 'sync'));
    await settle();
    assert.equal((await bg.chrome.storage.session.get('session_id')).session_id, undefined);
    // and later tab events write nothing
    const before = await sessionKeys(bg.chrome.storage.local);
    bg.chrome.tabs.onRemoved.listeners.forEach(fn => fn(6, {}));
    await settle();
    assert.deepEqual(await sessionKeys(bg.chrome.storage.local), before);
});

test('sessions switch: listeners and the current session follow the option without a reload', async () => {
    const bg = startBackground();
    const tabs = bg.chrome.tabs;
    const change = value => bg.chrome.storage.onChanged.listeners.forEach(fn =>
        fn({session_watcher: {newValue: value}}, 'sync'));
    await waitFor(async () => (await bg.chrome.storage.session.get('session_id')).session_id);
    assert.equal(tabs.onRemoved.listeners.length, 1);

    change(0);
    await waitFor(async () => !(await bg.chrome.storage.session.get('session_id')).session_id);
    assert.equal(tabs.onRemoved.listeners.length, 0);
    assert.equal(tabs.onUpdated.listeners.length, 0);

    change(1);
    await waitFor(async () => (await bg.chrome.storage.session.get('session_id')).session_id);
    assert.equal(tabs.onRemoved.listeners.length, 1);
    assert.equal(tabs.onUpdated.listeners.length, 1);
});

test('sessions: a burst of tab events makes a few writes, and the last one has every tab', async () => {
    const local = createStorageArea();
    const open = [];
    let queries = 0;
    let release = null;
    // the first query after `hold` waits, so an event can come while a write is running
    let hold = false;
    const browser = fakeBrowser();
    browser.tabs.query = async function () {
        queries++;
        const snapshot = open.map(tab => ({...tab}));
        if (hold) {
            hold = false;
            await new Promise(resolve => (release = resolve));
        }
        return snapshot;
    };
    const bg = startBackground({local, browser});
    await settle();
    const fire = () => bg.chrome.tabs.onUpdated.listeners.forEach(fn => fn(1, {url: 'x'}));
    const stored = async () => (await local.get(await sessionKeys(local)));
    const lastTabs = async () => Object.values(await stored())[0].tabs;

    // restoring 100 tabs: an event for each
    const queries_before = queries;
    for (let i = 0; i < 100; i++) {
        open.push({url: 'https://example.com/' + i, title: 'T' + i, pinned: false, windowId: 1});
        fire();
    }
    await settle();
    assert.equal(queries - queries_before, 1, 'one write for the whole burst');
    assert.equal((await lastTabs()).length, 100);

    // an event while a write is running: one more write follows it, however many events come
    hold = true;
    open.push({url: 'https://example.com/running', title: 'R', pinned: false, windowId: 1});
    fire();
    await waitFor(() => !!release);
    open.push({url: 'https://example.com/late', title: 'L', pinned: false, windowId: 1});
    for (let i = 0; i < 20; i++) {
        fire();
    }
    release();
    await settle();
    const tabs = await lastTabs();
    assert.equal(tabs.length, 102);
    assert.equal(tabs[101].url, 'https://example.com/late');
    assert.equal(queries - queries_before, 3, 'the running write and one more');
});
