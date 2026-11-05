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

// windows and tabs that record what the background does with them. `active`: the active tab of window 1.
// A new tab goes where its index says; without one at the end, or with `after_current` right after the active tab
// (Cent Browser's "Open tab to the right of the current one"); with `vivaldi` right after the active tab whatever the
// index. `before`, `after`: addresses of other tabs left and right of the active one.
// strip(windowId): its tab addresses, '*' on the active.
// tab_groups: the tabGroups permission is given; groups: what chrome.tabGroups.query answers
function fakeBrowser(active, {after_current = false, vivaldi = false, before = [], after = [], tab_groups = false,
    groups = []} = {}) {
    const calls = [];
    let next_group = 1;
    // copies: objects from the sandbox have their own prototypes
    const record = (...call) => calls.push(JSON.parse(JSON.stringify(call)));
    let next_id = 100;
    const strips = {};
    if (active) {
        // an address, or a tab such as {url, pinned: true}
        const other = (tab, i) => ({id: 50 + i, windowId: active.windowId, ...(typeof tab === 'string' ? {url: tab} : tab)});
        strips[active.windowId] = [...before.map(other), {...active, active: true},
            ...after.map((url, i) => other(url, before.length + i))];
    }
    const strip = windowId => (strips[windowId] = strips[windowId] || []);
    const activate = (tabs, tab) => tabs.forEach(t => { t.active = t === tab; });
    return {
        calls,
        strip: windowId => strip(windowId).map(t => t.url + (t.active ? '*' : '')),
        tabs: {
            // the active tab with its place in the window, as the browser gives it
            query: (filter, callback) => (callback ? callback([]) : Promise.resolve(
                !filter.active && filter.windowId ? strip(filter.windowId).slice() :
                    active ? [{...active, index: strip(active.windowId).findIndex(t => t.id === active.id)}] : [])),
            create: async function (props) {
                record('create', props);
                if (/^bad:/.test(props.url)) {
                    throw new Error('Cannot open ' + props.url);
                }
                const tabs = strip(props.windowId);
                const tab = {id: next_id++, windowId: props.windowId, url: props.url};
                const current = tabs.findIndex(t => t.active);
                const at = vivaldi && current >= 0 ? current + 1 : props.index !== undefined ?
                    Math.min(props.index, tabs.length) : after_current && current >= 0 ? current + 1 : tabs.length;
                tabs.splice(at, 0, tab);
                if (props.active) {
                    activate(tabs, tab);
                }
                return {id: tab.id, windowId: tab.windowId, index: at};
            },
            move: async function (id, props) {
                record('move', id, props);
                const tabs = Object.values(strips).find(list => list.some(t => t.id === id));
                const tab = tabs.splice(tabs.findIndex(t => t.id === id), 1)[0];
                tabs.splice(Math.min(props.index, tabs.length), 0, tab);
                return {id, index: tabs.indexOf(tab)};
            },
            update: async function (id, props) {
                record('update', id, props);
                const tabs = Object.values(strips).find(list => list.some(t => t.id === id)) || [];
                const tab = tabs.find(t => t.id === id);
                if (tab && props.url) {
                    tab.url = props.url;
                }
                // pinned: moved to the end of the pinned ones, as browsers do
                if (tab && props.pinned && !tab.pinned) {
                    tabs.splice(tabs.indexOf(tab), 1);
                    tabs.splice(tabs.filter(t => t.pinned).length, 0, tab);
                    tab.pinned = true;
                }
                return tab ? {id, index: tabs.indexOf(tab), pinned: !!tab.pinned} : {id};
            },
            group: async function (options) {
                record('group', options);
                return next_group++;
            },
        },
        tabGroups: tab_groups ? {
            update: async function (id, props) {
                record('tabGroup', id, props);
                if (props.color === 'magenta') {
                    throw new Error('Invalid color');
                }
                return {id};
            },
            query: async () => groups,
            onUpdated: event(),
        } : undefined,
        permissions: {
            contains: async (p) => tab_groups && p.permissions.every(name => name === 'tabGroups'),
            onAdded: event(),
        },
        windows: {
            create: async function (props) {
                record('window', props);
                const urls = [].concat(props.url || []);
                const bad = urls.find(url => /^(bad|javascript):/.test(url));
                if (bad) {
                    throw new Error('Cannot open ' + bad);
                }
                strips[7] = urls.map((url, i) => ({id: next_id++, windowId: 7, url, active: i === 0}));
                return {id: 7, tabs: strips[7].map(t => ({id: t.id, windowId: 7}))};
            },
            getAll: async () => (active ? [{id: active.windowId}] : []),
        },
    };
}

// one open tab, for tests that need a session to be stored (a session without tabs isn't)
const ONE_TAB = {id: 1, url: 'https://example.com/', title: 'Example', pinned: false, windowId: 1};

function startBackground({sync = createSyncArea(), local = createStorageArea(), session = createStorageArea(),
    browser = fakeBrowser(), start_wait = 0, firefox = false,
    icon_cache = {get: async () => null, remember: async () => {}, trim: async () => {}}} = {}) {
    // messages the background sends to open pages; like Chrome, it fails when no page listens
    const sent = [];
    const chrome = {
        storage: {sync, local, session, onChanged: event()},
        runtime: {
            onInstalled: event(), onStartup: event(), onMessage: event(), onUpdateAvailable: event(), reload() {},
            getManifest: () => ({permissions: firefox ? ['storage', 'tabs', 'unlimitedStorage', 'tabGroups'] :
                ['storage', 'tabs', 'favicon', 'unlimitedStorage']}),
            getURL: path => (firefox ? 'moz-extension://uuid/' : 'chrome-extension://id/') + path,
            sendMessage(msg) {
                sent.push(JSON.parse(JSON.stringify(msg)));
                return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
            },
        },
        tabs: {
            query: browser.tabs.query,
            create: browser.tabs.create,
            update: browser.tabs.update,
            group: browser.tabs.group,
            move: browser.tabs.move,
            remove() {},
            onUpdated: event(),
            onMoved: event(),
            onAttached: event(),
            onRemoved: event(),
            onReplaced: event(),
        },
        windows: Object.assign({onRemoved: event()}, browser.windows),
        tabGroups: browser.tabGroups,
        permissions: browser.permissions,
        i18n: {getMessage: key => EN[key] ? EN[key].message : ''},
    };
    const context = vm.createContext({
        chrome, console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Blob, Response,
        CompressionStream, DecompressionStream, btoa, atob, structuredClone,
    });
    // no IndexedDB here: a stand-in for Firefox's icon cache (js/icon_cache.js)
    if (firefox) {
        context.iconCache = icon_cache;
    }
    context.importScripts = function (...files) {
        files.filter(file => !(firefox && file === 'icon_cache.js')).forEach(function (file) {
            const code = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
            vm.runInContext(code, context, {filename: file});
        });
    };
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/background.js'), 'utf8'), context, {filename: 'background.js'});
    // a new session waits this long to learn why the worker started (onStartup, onInstalled)
    vm.runInContext('session_config.start_wait = ' + start_wait, context);

    function send(msg) {
        return new Promise(function (resolve) {
            chrome.runtime.onMessage.listeners.forEach(fn => fn(msg, {}, resolve));
        }).then(res => JSON.parse(JSON.stringify(res))); // objects from the sandbox have their own prototypes
    }

    function groups(op, ...args) {
        return send({msg: 'groups', op, args});
    }

    return {chrome, context, send, groups, sent};
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

// js/group_store_client.js as the pages run it, its messages answered by this background
function pageClient(bg) {
    const context = vm.createContext({chrome: {runtime: {sendMessage: msg => bg.send(JSON.parse(JSON.stringify(msg)))}}});
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/group_store_client.js'), 'utf8'), context, {filename: 'group_store_client.js'});
    return context.groupStoreClient;
}

test('page client: one background operation for each of its calls', () => {
    const bg = startBackground();
    const ops = vm.runInContext('Object.keys(group_ops)', bg.context);
    assert.deepEqual(Object.keys(pageClient(bg)).sort(), [...ops].sort());
});

test('page client: tab changes, add, discard and their arguments reach the store', async () => {
    const bg = startBackground();
    const client = pageClient(bg);
    const t = makeTabs(3, 4).map((tab, i) => Object.assign(tab, {id: i}));
    await client.save('tg_1', {name: 'g', index: 1, tabs: t});
    const seen = (await client.list()).tg_1;

    const removed = await client.removeTab('tg_1', seen.tabs[1], 1);
    assert.deepEqual(JSON.parse(JSON.stringify(removed.before)), t);
    await client.editTab('tg_1', seen.tabs[2], 2, {url: 'https://x.example/', title: 'X'});
    const added = await client.addTab('tg_1', {url: 'https://new.example/', title: 'New', pinned: true});
    assert.equal(added.synced, true);
    assert.equal((await client.addTab('tg_1', {url: 'https://new.example/', title: 'Again'})).unchanged, true);
    const twice = await client.addTab('tg_1', {url: 'https://new.example/', title: 'Again'}, true);
    await client.setTabs('tg_1', twice.before, twice.h);
    assert.deepEqual(JSON.parse(JSON.stringify((await client.list()).tg_1.tabs)), [t[0],
        {url: 'https://x.example/', title: 'X', id: 2}, {url: 'https://new.example/', title: 'New', id: 3, pinned: true}]);
    assert.deepEqual(await client.removeTab('tg_9', t[0], 0), {synced: false, error: 'Group not found'});

    // moves inside a group and to another one
    const moved = await client.moveTab('tg_1', t[0], 0, 2);
    assert.equal(moved.synced, true);
    await client.save('tg_3', {name: 'other', index: 3, tabs: makeTabs(1, 6)});
    const across = await client.moveTabTo('tg_1', t[0], 2, 'tg_3', 0);
    assert.equal(across.to.synced, true);
    assert.deepEqual(JSON.parse(JSON.stringify((await client.list()).tg_3.tabs[0])), Object.assign({}, t[0], {id: 1}));
    await client.setTabs('tg_1', across.from.before, across.from.h);
    await client.discard('tg_3');

    // Undo of a new save: the group goes and isn't kept in Recently deleted
    const group = {name: 'new', index: 2, tabs: makeTabs(2, 5)};
    await client.save('tg_2', group);
    assert.deepEqual(await client.discard('tg_2', group), {synced: true});
    assert.deepEqual(Object.keys(await client.list()), ['tg_1']);
    assert.deepEqual(await client.listTrash(), []);
    // changed since that save (renamed): it goes to Recently deleted after all
    await client.save('tg_3', group);
    await client.rename('tg_3', 'renamed');
    await client.discard('tg_3', group);
    assert.deepEqual((await client.listTrash()).map(g => g.key), ['tg_3']);
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
        ['create', {windowId: 1, url: 'https://a.example/', pinned: true, active: true, index: 1}],
        ['create', {windowId: 1, url: 'https://b.example/', pinned: false, active: false, index: 2}],
        ['create', {windowId: 1, url: 'https://c.example/', pinned: false, active: false, index: 3}],
    ]);
    assert.deepEqual(browser.strip(1), ['https://news.example/', 'https://a.example/*', 'https://b.example/', 'https://c.example/']);
});

test('open in the current window: a browser that opens new tabs next to the current one keeps the order', async () => {
    const browser = fakeBrowser({id: 1, windowId: 1, url: 'https://news.example/'}, {after_current: true});
    const bg = startBackground({browser});
    await bg.send({msg: 'open', how: 'current', tabs: TABS, windowId: 1});
    // without the index: news, a*, c, b
    assert.deepEqual(browser.strip(1), ['https://news.example/', 'https://a.example/*', 'https://b.example/', 'https://c.example/']);
    assert.ok(!browser.calls.some(c => c[0] === 'move'), 'the index is enough');
});

test('open in Vivaldi (a new tab right of the active one whatever the index): moved into place', async () => {
    const browser = fakeBrowser({id: 1, windowId: 1, url: 'https://news.example/'}, {vivaldi: true});
    const bg = startBackground({browser});
    const tabs = [{url: 'https://a.example/'}, {url: 'https://b.example/'}, {url: 'https://c.example/'}, {url: 'https://d.example/'}];
    assert.deepEqual(await bg.send({msg: 'open', how: 'current', tabs, windowId: 1}), {result: {failed: 0}});
    // without the move: news, a*, d, c, b
    assert.deepEqual(browser.strip(1),
        ['https://news.example/', 'https://a.example/*', 'https://b.example/', 'https://c.example/', 'https://d.example/']);
    // b lands right of the active a, already its place
    assert.deepEqual(browser.calls.filter(c => c[0] === 'move').map(c => c[2].index), [3, 4]);

    // a pinned tab isn't moved: the browser keeps it with the pinned ones
    const pinned = fakeBrowser({id: 1, windowId: 1, url: 'https://news.example/'}, {vivaldi: true});
    await startBackground({browser: pinned}).send({msg: 'open', how: 'current', tabs: TABS, windowId: 1});
    assert.ok(!pinned.calls.some(c => c[0] === 'move' && c[1] === 100));
});

test('open with "Switch to each tab as it opens": each tab active, no index, the browser places it, the last stays', async () => {
    for (const after_current of [false, true]) {
        const browser = fakeBrowser({id: 1, windowId: 1, url: 'https://news.example/'}, {after_current});
        const sync = createSyncArea();
        await sync.set({open_in_front: 1});
        const bg = startBackground({browser, sync});
        assert.deepEqual(await bg.send({msg: 'open', how: 'current', tabs: TABS, windowId: 1}), {result: {failed: 0}});
        assert.ok(browser.calls.every(c => c[1].active === true && !('index' in c[1])));
        assert.deepEqual(browser.strip(1), ['https://news.example/', 'https://a.example/', 'https://b.example/', 'https://c.example/*']);
    }
    const browser = fakeBrowser();
    const sync = createSyncArea();
    await sync.set({open_in_front: 1});
    const bg = startBackground({browser, sync});
    assert.deepEqual(await bg.send({msg: 'open', how: 'window', tabs: TABS.concat({url: 'bad:x'})}), {result: {failed: 1}});
    assert.deepEqual(browser.strip(7), ['https://a.example/', 'https://b.example/', 'https://c.example/*']);
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
        ['create', {windowId: 1, url: 'https://b.example/', pinned: false, active: false, index: 1}],
        ['create', {windowId: 1, url: 'https://c.example/', pinned: false, active: false, index: 2}],
    ]);
    assert.deepEqual(browser.strip(1), ['https://a.example/*', 'https://b.example/', 'https://c.example/']);
});

test('open in the current window: a blank new tab among other tabs stays, the tabs go to the end', async () => {
    // Ctrl+T in a browser that opens new tabs next to the current one: it may hold typed text
    for (const after_current of [false, true]) {
        const browser = fakeBrowser({id: 1, windowId: 1, url: 'chrome://newtab/'},
            {after_current, before: ['https://x.example/'], after: ['https://y.example/']});
        const bg = startBackground({browser});
        const tabs = [{url: 'https://a.example/'}, {url: 'https://b.example/'}, {url: 'https://c.example/'}];
        assert.deepEqual(await bg.send({msg: 'open', how: 'current', tabs, windowId: 1}), {result: {failed: 0}});
        assert.ok(!browser.calls.some(c => c[0] === 'update'));
        assert.deepEqual(browser.strip(1), ['https://x.example/', 'chrome://newtab/', 'https://y.example/',
            'https://a.example/*', 'https://b.example/', 'https://c.example/']);
    }
});

test('open in the current window: pinned tabs don\'t count, the blank new tab after them takes the first tab', async () => {
    for (const [tabs, strip] of [
        [TABS, ['https://p.example/', 'https://a.example/*', 'https://b.example/', 'https://c.example/']],
        [TABS.slice(1), ['https://p.example/', 'https://b.example/*', 'https://c.example/']],
    ]) {
        const browser = fakeBrowser({id: 1, windowId: 1, url: 'chrome://newtab/'},
            {before: [{url: 'https://p.example/', pinned: true}]});
        await startBackground({browser}).send({msg: 'open', how: 'current', tabs, windowId: 1});
        assert.equal(browser.calls[0][0], 'update');
        assert.deepEqual(browser.strip(1), strip);
    }
    // a pinned blank tab isn't one the user just opened
    const browser = fakeBrowser({id: 1, windowId: 1, url: 'chrome://newtab/', pinned: true});
    await startBackground({browser}).send({msg: 'open', how: 'current', tabs: TABS, windowId: 1});
    assert.ok(!browser.calls.some(c => c[0] === 'update'));
});

test('open with "Switch to each tab as it opens": a blank new tab is left as it is, as 0.3.0 did', async () => {
    for (const [after_current, strip] of [
        [false, ['https://x.example/', 'chrome://newtab/', 'https://y.example/', 'https://a.example/', 'https://b.example/',
            'https://c.example/*']],
        [true, ['https://x.example/', 'chrome://newtab/', 'https://a.example/', 'https://b.example/', 'https://c.example/*',
            'https://y.example/']],
    ]) {
        const browser = fakeBrowser({id: 1, windowId: 1, url: 'chrome://newtab/'},
            {after_current, before: ['https://x.example/'], after: ['https://y.example/']});
        const sync = createSyncArea();
        await sync.set({open_in_front: 1});
        const bg = startBackground({browser, sync});
        const tabs = [{url: 'https://a.example/'}, {url: 'https://b.example/'}, {url: 'https://c.example/'}];
        assert.deepEqual(await bg.send({msg: 'open', how: 'current', tabs, windowId: 1}), {result: {failed: 0}});
        assert.ok(!browser.calls.some(c => c[0] === 'update'));
        assert.deepEqual(browser.strip(1), strip);
    }
});

test('open in the current window: Firefox\'s new tab pages and Vivaldi\'s and Opera\'s start pages are blank too', async () => {
    for (const url of ['about:newtab', 'about:home', 'about:privatebrowsing', 'chrome://vivaldi-webui/startpage',
        'chrome://vivaldi-webui/startpage?section=Speed-dials&background-color=#363536', 'vivaldi://vivaldi-webui/startpage', 'chrome://startpageshared/', 'chrome://startpage/', 'opera://startpage']) {
        const browser = fakeBrowser({id: 1, windowId: 1, url});
        const bg = startBackground({browser});
        await bg.send({msg: 'open', how: 'current', tabs: TABS, windowId: 1});
        assert.deepEqual(browser.calls[0], ['update', 1, {url: 'https://a.example/', pinned: true}], url);
    }
});

test('firefox: only addresses it shows are opened (add-on pages too), a reader view tab as its page; the rest count as failed', async () => {
    const browser = fakeBrowser();
    const bg = startBackground({browser, firefox: true});
    const tabs = [{url: 'chrome://settings/'}, {url: 'https://a.example/', cg: {i: 1, t: 'A', c: 'blue'}},
        {url: 'mailto:a@example.com'}, {url: 'edge://settings/'}, {url: 'chrome-extension://abc/page.html'},
        {url: 'about:config'}, {url: 'file:///etc/hosts'}, {url: 'about:reader?url=https%3A%2F%2Fb.example%2Fx%3Fy%3D1'},
        {url: 'view-source:http://c.example/'}, {url: 'about:blank'}, {url: 'about:reader?url=%E0%A4%A'},
        {url: 'moz-extension://uuid/options.html#help'}];
    assert.deepEqual(await bg.send({msg: 'open', how: 'window', tabs}), {result: {failed: 7}});
    assert.deepEqual(browser.calls.filter(c => c[0] !== 'update').map(c => c[1].url), [
        'https://a.example/', 'https://b.example/x?y=1', 'view-source:http://c.example/', 'about:blank',
        'moz-extension://uuid/options.html#help']);
});

test('firefox: the icons of the tabs open at start are kept once per browser run, not on each start of the background', async () => {
    const tab = {id: 1, windowId: 1, url: 'https://a.example/', favIconUrl: 'data:image/png;base64,AA', incognito: false};
    const kept = [];
    const icon_cache = {get: async () => null, remember: async (url, src) => { kept.push([url, src]); }, trim: async () => {}};
    const session = createStorageArea();
    startBackground({browser: fakeBrowser(tab), session, icon_cache, firefox: true});
    await waitFor(async () => (await session.get('icons_kept')).icons_kept);
    assert.deepEqual(kept, [['https://a.example/', 'data:image/png;base64,AA']]);
    // stopped while idle and started again for an event: the same run, nothing looked up again
    startBackground({browser: fakeBrowser(tab), session, icon_cache, firefox: true});
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(kept.length, 1);
    // a new browser run (session storage emptied): looked up again
    startBackground({browser: fakeBrowser(tab), session: createStorageArea(), icon_cache, firefox: true});
    await waitFor(() => kept.length === 2);
});

test('firefox: the icons of the tabs open at start are kept one at a time', async () => {
    const tabs = [1, 2, 3].map(n => ({id: n, windowId: 1, url: 'https://s' + n + '.example/',
        favIconUrl: 'data:image/png;base64,A' + n, incognito: false}));
    const browser = fakeBrowser(tabs[0]);
    // all open tabs, in every window
    browser.tabs.query = async () => tabs.slice();
    let running = 0;
    let most = 0;
    const kept = [];
    const icon_cache = {get: async () => null, trim: async () => {}, remember: async (url) => {
        most = Math.max(most, ++running);
        await new Promise(resolve => setTimeout(resolve, 10));
        kept.push(url);
        running--;
    }};
    const session = createStorageArea();
    startBackground({browser, session, icon_cache, firefox: true});
    await waitFor(async () => (await session.get('icons_kept')).icons_kept);
    assert.deepEqual(kept, tabs.map(tab => tab.url));
    assert.equal(most, 1);
});

test('firefox: Settings counts and clears the kept site icons through the background', async () => {
    const calls = [];
    const icon_cache = {get: async () => null, remember: async () => {}, trim: async () => {},
        count: async () => { calls.push('count'); return 7; }, clear: async () => { calls.push('clear'); }};
    const bg = startBackground({icon_cache, firefox: true});
    assert.deepEqual(await bg.send({msg: 'icons', op: 'count'}), {result: 7});
    assert.deepEqual(await bg.send({msg: 'icons', op: 'clear'}), {});
    assert.deepEqual(calls, ['count', 'clear']);
    icon_cache.clear = async () => { throw new Error('blocked'); };
    assert.deepEqual(await bg.send({msg: 'icons', op: 'clear'}), {error: 'blocked'});
});

test('firefox: nothing it can open is an error, and opens nothing', async () => {
    const browser = fakeBrowser();
    const bg = startBackground({browser, firefox: true});
    assert.deepEqual(await bg.send({msg: 'open', how: 'current', tabs: [{url: 'chrome://newtab/'}, {url: 'mailto:x@y.z'}]}),
        {error: 'Nothing this browser can open'});
    assert.deepEqual(browser.calls, []);
});

test('open in a new window: the window opens with the first tab, the rest follow; bad ones are skipped', async () => {
    const browser = fakeBrowser();
    const bg = startBackground({browser});
    const tabs = TABS.concat({url: 'bad:x'}, {url: 'https://d.example/'});
    assert.deepEqual(await bg.send({msg: 'open', how: 'window', tabs}), {result: {failed: 1}});
    assert.deepEqual(browser.calls.map(c => c[0] === 'window' ? c[1].url : c[0] === 'update' ? 'pin' : c[1].url), [
        'https://a.example/', 'pin', 'https://b.example/', 'https://c.example/', 'bad:x', 'https://d.example/']);
    assert.ok(browser.calls.filter(c => c[0] === 'create').every(c => c[1].windowId === 7 && !c[1].active));
    // a failed tab takes no place
    assert.deepEqual(browser.calls.filter(c => c[0] === 'create').map(c => c[1].index), [1, 2, 3, 3]);
    assert.deepEqual(browser.strip(7), ['https://a.example/*', 'https://b.example/', 'https://c.example/', 'https://d.example/']);
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

test('open a session window: into a window that is only a blank new tab (and pinned tabs), else a new window', async () => {
    const blank = fakeBrowser({id: 1, windowId: 1, url: 'chrome://newtab/'});
    await startBackground({browser: blank}).send({msg: 'open', how: 'blankOrWindow', tabs: TABS, windowId: 1});
    assert.deepEqual(blank.calls.map(c => c[0]), ['update', 'create', 'create']);

    const pinned = fakeBrowser({id: 1, windowId: 1, url: 'chrome://newtab/'}, {before: [{url: 'https://p.example/', pinned: true}]});
    await startBackground({browser: pinned}).send({msg: 'open', how: 'blankOrWindow', tabs: TABS, windowId: 1});
    assert.deepEqual(pinned.calls.map(c => c[0]), ['update', 'create', 'create']);

    const among = fakeBrowser({id: 1, windowId: 1, url: 'chrome://newtab/'}, {after: ['https://y.example/']});
    await startBackground({browser: among}).send({msg: 'open', how: 'blankOrWindow', tabs: TABS, windowId: 1});
    assert.deepEqual(among.calls.map(c => c[0]), ['window', 'update', 'create', 'create']);

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
    const tabs = TABS.concat({url: 'javascript:void(0)'}, {url: 'chrome://settings/'}, {url: 'edge://crash/'});
    assert.deepEqual(await bg.send({msg: 'open', how: 'incognito', tabs}), {result: {failed: 3}});
    assert.deepEqual(browser.calls.map(c => c[1].url), [tabs.map(t => t.url), TABS.map(t => t.url)]);

    const only_bad = startBackground();
    assert.deepEqual(await only_bad.send({msg: 'open', how: 'incognito', tabs: [{url: 'bad:1'}, TABS[0]]}),
        {error: 'Cannot open bad:1'});
});

// a saved group's tabs: a, b in "Trip" (yellow), c alone, d, e in an unnamed collapsed blue one, f pinned (never grouped)
const TRIP = {i: 1, t: 'Trip', c: 'yellow'};
const OTHER = {i: 2, t: '', c: 'blue', x: true};
const GROUPED = [
    {url: 'https://a.example/', cg: TRIP}, {url: 'https://b.example/', cg: TRIP}, {url: 'https://c.example/'},
    {url: 'https://d.example/', cg: OTHER}, {url: 'https://e.example/', cg: OTHER},
    {url: 'https://f.example/', pinned: true, cg: OTHER},
];

const groupCalls = (browser) => browser.calls.filter(c => c[0] === 'group' || c[0] === 'tabGroup');

test('open with tab groups: each run of tabs with the same cg is one tab group with its name, color, collapsed', async () => {
    const browser = fakeBrowser({id: 1, windowId: 1, url: 'https://news.example/'}, {tab_groups: true});
    const bg = startBackground({browser});
    assert.deepEqual(await bg.send({msg: 'open', how: 'current', tabs: GROUPED, windowId: 1}), {result: {failed: 0}});
    assert.deepEqual(groupCalls(browser), [
        ['group', {tabIds: [100, 101], createProperties: {windowId: 1}}],
        ['tabGroup', 1, {title: 'Trip', collapsed: false, color: 'yellow'}],
        ['group', {tabIds: [103, 104], createProperties: {windowId: 1}}],
        ['tabGroup', 2, {title: '', collapsed: true, color: 'blue'}],
    ]);
});

test('open with tab groups: a collapsed tab group that holds the tab opened first (the active one) opens expanded', async () => {
    const browser = fakeBrowser(null, {tab_groups: true});
    await startBackground({browser}).send({msg: 'open', how: 'window', tabs: [GROUPED[3], GROUPED[4], GROUPED[2], GROUPED[3]]});
    assert.deepEqual(groupCalls(browser).filter(c => c[0] === 'tabGroup').map(c => c[2].collapsed), [false, true]);
});

test('open with tab groups and "Switch to each tab as it opens": the tab group of the last tab (in front) opens expanded', async () => {
    const tabs = [GROUPED[3], GROUPED[4], GROUPED[2], GROUPED[3], {url: 'bad:1', cg: OTHER}];
    for (const how of ['current', 'window']) {
        const browser = fakeBrowser({id: 1, windowId: 1, url: 'https://news.example/'}, {tab_groups: true});
        const sync = createSyncArea();
        await sync.set({open_in_front: 1});
        await startBackground({browser, sync}).send({msg: 'open', how, tabs, windowId: 1});
        // the last tab didn't open: the one before it is in front
        assert.deepEqual(groupCalls(browser).filter(c => c[0] === 'tabGroup').map(c => c[2].collapsed), [true, false], how);
    }
});

test('open with tab groups: without the permission, no tab groups (not even unnamed ones)', async () => {
    const browser = fakeBrowser({id: 1, windowId: 1, url: 'https://news.example/'});
    const bg = startBackground({browser});
    await bg.send({msg: 'open', how: 'current', tabs: GROUPED, windowId: 1});
    assert.deepEqual(groupCalls(browser), []);
});

test('open with tab groups: a blank new tab, a new window, a tab that didn\'t open, a split run', async () => {
    const blank = fakeBrowser({id: 1, windowId: 1, url: 'chrome://newtab/'}, {tab_groups: true});
    await startBackground({browser: blank}).send({msg: 'open', how: 'current', tabs: GROUPED, windowId: 1});
    assert.deepEqual(groupCalls(blank).filter(c => c[0] === 'group').map(c => c[1].tabIds), [[1, 100], [102, 103]]);

    const browser = fakeBrowser(null, {tab_groups: true});
    const bg = startBackground({browser});
    // b doesn't open: a is a group alone; a 1.0.0 drag split group 2 in two runs: two tab groups of the same name
    const tabs = [GROUPED[0], {url: 'bad:b', cg: TRIP}, GROUPED[2], GROUPED[3], GROUPED[2], GROUPED[4]];
    assert.deepEqual(await bg.send({msg: 'open', how: 'window', tabs}), {result: {failed: 1}});
    assert.deepEqual(groupCalls(browser).filter(c => c[0] === 'group'), [
        ['group', {tabIds: [100], createProperties: {windowId: 7}}],
        ['group', {tabIds: [102], createProperties: {windowId: 7}}],
        ['group', {tabIds: [104], createProperties: {windowId: 7}}],
    ]);
});

test('open with tab groups: incognito groups the tabs it got back; an unknown color is left to the browser', async () => {
    const browser = fakeBrowser(null, {tab_groups: true});
    const bg = startBackground({browser});
    const tabs = [{url: 'javascript:void(0)', cg: TRIP}, GROUPED[0], GROUPED[1]];
    assert.deepEqual(await bg.send({msg: 'open', how: 'incognito', tabs}), {result: {failed: 1}});
    assert.deepEqual(groupCalls(browser), [
        ['group', {tabIds: [100, 101], createProperties: {windowId: 7}}],
        ['tabGroup', 1, {title: 'Trip', collapsed: false, color: 'yellow'}],
    ]);

    const odd = fakeBrowser(null, {tab_groups: true});
    await startBackground({browser: odd}).send({msg: 'open', how: 'window',
        tabs: [{url: 'https://a.example/', cg: {i: 1, t: 'New', c: 'magenta'}}]});
    assert.deepEqual(groupCalls(odd)[1], ['tabGroup', 1, {title: 'New', collapsed: false}]);
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
    startBackground({local, browser: fakeBrowser(ONE_TAB)});
    let session;
    await waitFor(async function () {
        const items = await local.get(null);
        session = Object.keys(items).filter(k => k.startsWith('tg_')).map(k => items[k])[0];
        return !!session;
    });
    assert.ok(session.updated >= before && session.updated <= Date.now());
    assert.equal(session.v, 2);
    assert.deepEqual(session.tabs.map(tab => tab.url), [ONE_TAB.url]);
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
    const bg = startBackground({local, browser: fakeBrowser(ONE_TAB)});

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

test('backup: settings that can\'t be written after the groups are replaced: the answer says so, Undo stays', async () => {
    const current = {tg_1700000000001: makeGroup(5, 1)};
    const bg = await backgroundWithGroups(current);
    const backup = {date_format: 'eu', tg_1600000000001: makeGroup(3, 2)};
    bg.chrome.storage.sync.beforeWrite = function (op, keys) {
        if (op === 'set' && keys.includes('date_format')) {
            throw new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.');
        }
    };
    assert.deepEqual(await bg.groups('importBackup', JSON.stringify(backup)),
        {result: {groups: 1, errors: {}, options_failed: true}});
    assert.deepEqual(listWithoutFlags((await bg.groups('list')).result), {tg_1600000000001: makeGroup(3, 2)});
    assert.equal((await bg.groups('restoreInfo')).result.restored, 1);

    bg.chrome.storage.sync.beforeWrite = null;
    assert.deepEqual(await bg.groups('undoRestore'), {result: {groups: 1, errors: {}}});
    assert.deepEqual(listWithoutFlags((await bg.groups('list')).result), current);
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

test('backup: tabs keep their browser tab groups; odd ones are cleaned up or left out', async () => {
    const tabs = makeTabs(5, 3).map((tab, i) => Object.assign(tab, {id: i}));
    tabs[0].cg = {i: 1, t: 'Trip', c: 'yellow', x: true};
    tabs[1].cg = {i: 1, t: 'Trip', c: 'yellow', x: true};
    const groups = {tg_1700000000001: {name: 'g', index: 1, tabs}};
    const bg = await backgroundWithGroups(groups);
    const text = (await bg.groups('exportBackup')).result;
    const other = startBackground();
    await other.groups('importBackup', text);
    assert.deepEqual(listWithoutFlags((await other.groups('list')).result), groups);

    const data = JSON.parse(text);
    const odd = data.tg_1700000000001.tabs;
    odd[2].cg = {i: 2, t: 'X', c: 'magenta', x: 1};
    odd[3].cg = {i: 0, t: 'Y', c: 'red'};
    odd[4].cg = 'blue';
    await other.groups('importBackup', JSON.stringify(data));
    const back = (await other.groups('list')).result.tg_1700000000001.tabs;
    assert.deepEqual(back.map(tab => tab.cg), [tabs[0].cg, tabs[1].cg, {i: 2, t: 'X', c: 'grey'}, undefined, undefined]);
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

test('backup: the answer about icons from the sites comes back, an odd one is left out', async () => {
    const bg = await backgroundWithGroups({tg_1700000000001: makeGroup(5, 1)});
    await bg.groups('importBackup', JSON.stringify({site_icons: 'load'}));
    assert.equal((await bg.chrome.storage.sync.get('site_icons')).site_icons, 'load');
    await bg.groups('importBackup', JSON.stringify({site_icons: 1}));
    assert.equal((await bg.chrome.storage.sync.get('site_icons')).site_icons, 'load');
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
    const bg = startBackground({local, session, browser: fakeBrowser(ONE_TAB)});
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
        open.push({id: i, url: 'https://example.com/' + i, title: 'T' + i, pinned: false, windowId: 1});
        fire();
    }
    await settle();
    assert.equal(queries - queries_before, 1, 'one write for the whole burst');
    assert.equal((await lastTabs()).length, 100);

    // an event while a write is running: one more write follows it, however many events come
    hold = true;
    open.push({id: 200, url: 'https://example.com/running', title: 'R', pinned: false, windowId: 1});
    fire();
    await waitFor(() => !!release);
    open.push({id: 201, url: 'https://example.com/late', title: 'L', pinned: false, windowId: 1});
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

// mergeSession runs in the background's sandbox (its objects have their own prototypes: compared as JSON).
// notes: {steps: {tabId: [{url, title, at}]}, titles: {tabId: {url, title}}, closing: [windowId], replaced: [[oldId, newId]]}
function merge(bg, stored, open, window_ids, notes = {}, now = 1000, tab_groups = null) {
    const n = bg.context.newNotes();
    Object.entries(notes.steps || {}).forEach(([id, steps]) => n.steps.set(Number(id), steps));
    Object.entries(notes.titles || {}).forEach(([id, seen]) => n.titles.set(Number(id), seen));
    (notes.closing || []).forEach(id => n.closing.add(id));
    (notes.replaced || []).forEach(([from, to]) => n.replaced.set(from, to));
    const session = bg.context.mergeSession(stored, open, new Set(window_ids), n, now, tab_groups);
    return session && JSON.parse(JSON.stringify(session));
}

const openTab = (id, url, windowId = 1) => ({id, url, title: 'T ' + url, pinned: false, windowId});

test('session tab groups: names and colors as now, those of closed windows as last seen, only those a tab is in', () => {
    const bg = startBackground();
    const grouped = (id, url, windowId, groupId) => Object.assign(openTab(id, url, windowId), {groupId});
    const open = [grouped(1, 'https://a.example/', 1, 10), grouped(2, 'https://b.example/', 2, 20),
        grouped(3, 'https://c.example/', 2, 21)];
    const first = merge(bg, null, open, [1, 2], {}, 1000, [
        {id: 10, title: 'Trip', color: 'yellow', collapsed: false, windowId: 1},
        {id: 20, title: '', color: 'blue', collapsed: true, windowId: 2},
        {id: 21, title: 'Gone', color: 'red', collapsed: false, windowId: 2},
        {id: 30, title: 'Not recorded', color: 'red', collapsed: false, windowId: 3},
    ]);
    assert.deepEqual(first.groups, {
        10: {title: 'Trip', color: 'yellow', collapsed: false},
        20: {title: '', color: 'blue', collapsed: true},
        21: {title: 'Gone', color: 'red', collapsed: false},
    });
    // window 2 closed, tab group 10 renamed; tab 3 left its group before
    const second = merge(bg, first, [open[0]], [1], {closing: [2]}, 2000, [
        {id: 10, title: 'Trip 2', color: 'green', collapsed: false, windowId: 1},
    ]);
    assert.deepEqual(second.groups, {
        10: {title: 'Trip 2', color: 'green', collapsed: false},
        20: {title: '', color: 'blue', collapsed: true},
        21: {title: 'Gone', color: 'red', collapsed: false},
    });
    // without the permission (null): the names seen before stay; a tab group no tab is in any more goes
    const third = merge(bg, second, [Object.assign({}, open[0], {groupId: -1})], [1], {}, 3000, null);
    assert.deepEqual(third.groups, {
        20: {title: '', color: 'blue', collapsed: true},
        21: {title: 'Gone', color: 'red', collapsed: false},
    });
    // no tab groups at all: no `groups`
    assert.equal(merge(bg, null, [openTab(1, 'https://a.example/')], [1]).groups, undefined);
});

test('session tab groups: recorded with the permission, a rename makes a write', async () => {
    const tab = Object.assign({}, ONE_TAB, {groupId: 10});
    const groups = [{id: 10, title: 'Trip', color: 'yellow', collapsed: false, windowId: 1}];
    const browser = fakeBrowser(tab, {tab_groups: true, groups});
    browser.tabs.query = async () => [tab];
    const bg = startBackground({browser});
    const stored = async () => {
        const {session_id} = await bg.chrome.storage.session.get('session_id');
        return session_id && (await bg.chrome.storage.local.get(session_id))[session_id];
    };
    await waitFor(async () => (await stored()));
    assert.deepEqual((await stored()).groups, {10: {title: 'Trip', color: 'yellow', collapsed: false}});
    assert.equal(bg.chrome.tabGroups.onUpdated.listeners.length, 1);

    vm.runInContext('session_config.title_wait = 0', bg.context);
    groups[0] = {id: 10, title: 'Trip 2', color: 'yellow', collapsed: true, windowId: 1};
    bg.chrome.tabGroups.onUpdated.listeners.forEach(fn => fn(groups[0]));
    await waitFor(async () => (await stored()).groups[10].title === 'Trip 2');
    assert.deepEqual((await stored()).groups, {10: {title: 'Trip 2', color: 'yellow', collapsed: true}});

    // without the permission: grouping only
    const plain = fakeBrowser(tab);
    plain.tabs.query = async () => [tab];
    const bg2 = startBackground({browser: plain});
    await waitFor(async () => (await bg2.chrome.storage.session.get('session_id')).session_id);
    const {session_id} = await bg2.chrome.storage.session.get('session_id');
    const session = (await bg2.chrome.storage.local.get(session_id))[session_id];
    assert.equal(session.tabs[0].groupId, 10);
    assert.equal(session.groups, undefined);
});

test('session tabs: a new address puts the one before into the trail; a reload or a new tab page does not', () => {
    const bg = startBackground();
    let s = merge(bg, null, [openTab(1, 'chrome://newtab/')], [1], {}, 100);
    assert.deepEqual(s.tabs, [{id: 1, url: 'chrome://newtab/', title: 'T chrome://newtab/', pinned: false, windowId: 1, at: 100}]);
    s = merge(bg, s, [openTab(1, 'https://a.com/')], [1], {}, 200);
    assert.equal(s.tabs[0].trail, undefined, 'a new tab page is not a page the tab went through');
    assert.equal(s.tabs[0].at, 200);
    // two addresses between writes, the second one reloaded
    s = merge(bg, s, [openTab(1, 'https://c.com/')], [1], {steps: {1: [
        {url: 'https://b.com/', title: 'B', at: 250}, {url: 'https://c.com/', title: '', at: 260},
        {url: 'https://c.com/', title: '', at: 270}]}}, 300);
    assert.deepEqual(s.tabs[0].trail, [
        {url: 'https://a.com/', title: 'T https://a.com/', at: 200}, {url: 'https://b.com/', title: 'B', at: 250}]);
    assert.equal(s.tabs[0].at, 260);
    assert.equal(s.tabs[0].title, 'T https://c.com/');
    assert.equal(s.v, 2);
    assert.equal(s.updated, 300);
});

test('session tabs: a trail keeps the last 10 pages', () => {
    const bg = startBackground();
    let s = null;
    for (let i = 0; i < 15; i++) {
        s = merge(bg, s, [openTab(1, 'https://example.com/' + i)], [1], {}, i);
    }
    assert.equal(s.tabs[0].trail.length, 10);
    assert.equal(s.tabs[0].trail[0].url, 'https://example.com/4');
    assert.equal(s.tabs[0].trail[9].url, 'https://example.com/13');
});

test('session tabs: a tab closed by itself is marked; a closed window keeps its tabs as they were', () => {
    const bg = startBackground();
    const open = [openTab(1, 'https://a.com/', 1), openTab(2, 'https://b.com/', 1), openTab(3, 'https://c.com/', 2),
        openTab(4, 'https://d.com/', 3)];
    const first = merge(bg, null, open, [1, 2, 3], {}, 100);
    // tab 2 closed in window 1; window 2 gone; window 3 still there but closing (its tabs went with it)
    const s = merge(bg, first, [open[0]], [1, 3], {closing: [3]}, 200);
    const byId = Object.fromEntries(s.tabs.map(tab => [tab.id, tab]));
    assert.equal(byId[1].closed, undefined);
    assert.equal(byId[2].closed, 200);
    assert.deepEqual(byId[3], first.tabs[2]);
    assert.deepEqual(byId[4], first.tabs[3]);
    assert.deepEqual(s.windows, {2: {closed: 200}, 3: {closed: 200}});
    // later writes leave them as they are
    const again = merge(bg, s, [open[0]], [1], {}, 300);
    assert.deepEqual(again.tabs, s.tabs);
    assert.deepEqual(again.windows, s.windows);
    // the last window closed: it is closed too (the popup shows the windows closed last as the end)
    const last = merge(bg, again, [], [], {}, 400);
    assert.deepEqual(last.windows, {1: {closed: 400}, 2: {closed: 200}, 3: {closed: 200}});
    assert.equal(last.tabs.find(tab => tab.id === 1).closed, undefined);
});

test('session tabs: a tab Chrome gives a new id keeps its trail', () => {
    const bg = startBackground();
    let s = merge(bg, null, [openTab(1, 'https://a.com/')], [1], {}, 100);
    s = merge(bg, s, [openTab(1, 'https://b.com/')], [1], {}, 200);
    s = merge(bg, s, [openTab(9, 'https://b.com/')], [1], {replaced: [[1, 9]]}, 300);
    assert.equal(s.tabs.length, 1);
    assert.equal(s.tabs[0].id, 9);
    assert.equal(s.tabs[0].at, 200);
    assert.deepEqual(s.tabs[0].trail.map(step => step.url), ['https://a.com/']);
});

test('session tabs: only the newest closed tabs are kept; no tabs, no session; a 0.4.0 session starts again', () => {
    const bg = startBackground();
    vm.runInContext('session_config.closed = 2', bg.context);
    const all = [1, 2, 3, 4].map(id => openTab(id, 'https://example.com/' + id));
    let s = merge(bg, null, all, [1], {}, 100);
    // tabs 2, 3 and 4 closed one after another
    for (const id of [2, 3, 4]) {
        s = merge(bg, s, all.filter(tab => tab.id === 1 || tab.id > id), [1], {}, 100 + id);
    }
    assert.deepEqual(s.tabs.map(tab => [tab.id, tab.closed]).sort((a, b) => a[0] - b[0]), [[1, undefined], [3, 103], [4, 104]]);

    assert.equal(merge(bg, null, [], [], {}, 100), null);

    const snapshot = {name: '', updated: 50, tabs: [{url: 'https://old.com/', title: 'Old', pinned: false, windowId: 1}]};
    s = merge(bg, snapshot, [openTab(1, 'https://a.com/')], [1], {}, 100);
    assert.deepEqual(s.tabs.map(tab => tab.url), ['https://a.com/']);
});

test('sessions: a session without tabs is not stored', async () => {
    const bg = startBackground();
    await waitFor(async () => (await bg.chrome.storage.session.get('session_id')).session_id);
    await settle();
    assert.deepEqual(await sessionKeys(bg.chrome.storage.local), []);
});

test('sessions: incognito and DevTools tabs are not recorded; the Chrome tab group of a tab is', async () => {
    const local = createStorageArea();
    const browser = fakeBrowser();
    browser.tabs.query = async () => [
        {id: 1, url: 'https://a.com/', title: 'A', pinned: false, windowId: 1, groupId: 4},
        {id: 2, url: 'https://b.com/', title: 'B', pinned: true, windowId: 1, groupId: -1},
        {id: 3, url: 'https://secret.com/', title: 'S', pinned: false, windowId: 2, incognito: true},
        {id: 4, url: 'chrome-devtools://devtools/bundled/inspector.html', title: 'D', pinned: false, windowId: 3},
    ];
    browser.windows.getAll = async () => [{id: 1}, {id: 2, incognito: true}, {id: 3}];
    startBackground({local, browser});
    await waitFor(async () => (await sessionKeys(local)).length === 1);
    const session = Object.values(await local.get(await sessionKeys(local)))[0];
    assert.deepEqual(session.tabs.map(tab => [tab.id, tab.groupId, tab.pinned]), [[1, 4, false], [2, undefined, true]]);
});

test('sessions: after an update or reload of the extension the session goes on; a new browser run starts one', async () => {
    const old = 'tg_1700000000000';
    // [why the worker started, the stored session's second tab, goes on]: tab 2 still open with its address = same run
    for (const [reason, second, goesOn] of [['update', 'https://c.com/', true], ['browser', 'https://c.com/', false],
        ['install', 'https://c.com/', false], ['update', 'https://other.com/', false]]) {
        const local = createStorageArea();
        local.rawSet({
            [old]: {name: '', updated: 1, v: 2, windows: {}, tabs: [
                {id: 1, url: 'https://a.com/', title: 'A', pinned: false, windowId: 1, at: 1},
                {id: 2, url: second, title: 'C', pinned: false, windowId: 1, at: 1}]},
            session_last: old,
        });
        const browser = fakeBrowser();
        browser.tabs.query = async () => [openTab(1, 'https://b.com/'), openTab(2, 'https://c.com/')];
        browser.windows.getAll = async () => [{id: 1}];
        const bg = startBackground({local, browser, start_wait: 200});
        if (reason === 'browser') {
            bg.chrome.runtime.onStartup.listeners.forEach(fn => fn());
        } else {
            bg.chrome.runtime.onInstalled.listeners.forEach(fn => fn({reason}));
        }
        const what = reason + ' ' + second;
        await waitFor(async () => (await sessionKeys(local)).length === (goesOn ? 1 : 2) &&
            (await local.get(old))[old].tabs[0].url === (goesOn ? 'https://b.com/' : 'https://a.com/'));
        const id = (await bg.chrome.storage.session.get('session_id')).session_id;
        assert.equal(id === old, goesOn, what);
        assert.equal((await local.get('session_last')).session_last, id, what);
        await waitFor(async () => !!(await local.get(id))[id]);
        // the same tab (same id in the same browser run) went on to another page
        const trail = (await local.get(id))[id].tabs[0].trail;
        assert.deepEqual(trail ? trail.map(step => step.url) : [], goesOn ? ['https://a.com/'] : [], what);
    }
});

test('session tabs: tabs that closed with their window count toward the closed tabs kept', () => {
    const bg = startBackground();
    vm.runInContext('session_config.closed = 3', bg.context);
    const open = [openTab(1, 'https://a.com/', 1), openTab(2, 'https://b.com/', 2), openTab(3, 'https://c.com/', 2),
        openTab(4, 'https://d.com/', 3), openTab(5, 'https://e.com/', 3)];
    let s = merge(bg, null, open, [1, 2, 3], {}, 100);
    s = merge(bg, s, open.filter(tab => tab.windowId !== 2), [1, 3], {}, 200);
    s = merge(bg, s, open.filter(tab => tab.windowId === 1), [1], {}, 300);
    // 4 tabs closed with their windows, 3 kept: one of window 2 (closed first) went
    assert.deepEqual(s.tabs.map(tab => tab.id).sort(), [1, 3, 4, 5]);
    assert.deepEqual(s.windows, {2: {closed: 200}, 3: {closed: 300}});
});

test('session tabs: a tab still loading a new address doesn\'t get the page before\'s title', () => {
    const bg = startBackground();
    let s = merge(bg, null, [openTab(1, 'https://a.com/')], [1], {}, 100);
    // still loading: Chrome gives the old title with the new address
    s = merge(bg, s, [{...openTab(1, 'https://b.com/'), title: 'T https://a.com/', status: 'loading'}], [1], {}, 200);
    assert.equal(s.tabs[0].title, '');
    // a title that came for the new address while it loads (not the same as the page before's): still none until loaded
    s = merge(bg, s, [{...openTab(1, 'https://b.com/'), title: 'Half', status: 'loading'}], [1], {}, 220);
    assert.equal(s.tabs[0].title, '');
    // loaded, with the same title (the load ending writes again)
    s = merge(bg, s, [{...openTab(1, 'https://b.com/'), title: 'T https://a.com/', status: 'complete'}], [1], {}, 250);
    assert.equal(s.tabs[0].title, 'T https://a.com/');
    // a single-page app: a new address, loaded, the same title: kept
    s = merge(bg, s, [{...openTab(1, 'https://b.com/#2'), title: 'T https://a.com/', status: 'complete'}], [1], {}, 300);
    assert.deepEqual([s.tabs[0].title, s.tabs[0].trail.map(step => step.title)], ['T https://a.com/', ['T https://a.com/', 'T https://a.com/']]);
});

test('sessions: going on before a page\'s title was written keeps the title with that page', async () => {
    const local = createStorageArea();
    let open = [{...openTab(1, 'https://a.com/'), title: 'Page A', status: 'complete'}];
    const browser = fakeBrowser();
    browser.tabs.query = async () => open.map(tab => ({...tab}));
    browser.windows.getAll = async () => [{id: 1}];
    const bg = startBackground({local, browser});
    vm.runInContext('session_config.title_wait = 5000', bg.context);
    await waitFor(async () => (await sessionKeys(local)).length === 1);
    const update = (change, tab) => bg.chrome.tabs.onUpdated.listeners.forEach(fn => fn(1, change, tab));
    const stored = async () => Object.values(await local.get(await sessionKeys(local)))[0].tabs[0];
    // A -> B: written at once, while B loads with A's title
    open = [{...openTab(1, 'https://b.com/'), title: 'Page A', status: 'loading'}];
    update({url: 'https://b.com/', status: 'loading'}, open[0]);
    await settle();
    assert.deepEqual([(await stored()).url, (await stored()).title], ['https://b.com/', '']);
    // B's title comes (the write for it waits), then B -> C before that write
    open = [{...openTab(1, 'https://b.com/'), title: 'Page B', status: 'complete'}];
    update({title: 'Page B'}, open[0]);
    open = [{...openTab(1, 'https://c.com/'), title: 'Page B', status: 'loading'}];
    update({url: 'https://c.com/', status: 'loading'}, open[0]);
    await settle();
    const tab = await stored();
    assert.deepEqual(tab.trail.map(step => [step.url, step.title]), [['https://a.com/', 'Page A'], ['https://b.com/', 'Page B']]);
    assert.deepEqual([tab.url, tab.title], ['https://c.com/', '']);
});

test('sessions: a title change alone writes once after a while, not each time', async () => {
    const local = createStorageArea();
    const browser = fakeBrowser();
    browser.tabs.query = async () => [openTab(1, 'https://a.com/')];
    browser.windows.getAll = async () => [{id: 1}];
    const bg = startBackground({local, browser});
    vm.runInContext('session_config.title_wait = 150', bg.context);
    await waitFor(async () => (await sessionKeys(local)).length === 1);
    await settle();
    let writes = 0;
    const set = local.set.bind(local);
    local.set = items => {
        writes++;
        return set(items);
    };
    for (let i = 0; i < 20; i++) {
        bg.chrome.tabs.onUpdated.listeners.forEach(fn => fn(1, {title: '(' + i + ') Inbox'}));
    }
    await settle();
    assert.equal(writes, 0, 'not at once');
    await new Promise(resolve => setTimeout(resolve, 200));
    await settle();
    assert.equal(writes, 1, 'one write for all of them');
    // an address change still writes at once
    bg.chrome.tabs.onUpdated.listeners.forEach(fn => fn(1, {url: 'https://b.com/'}));
    await settle();
    assert.equal(writes, 2);
    // a load that ended writes the same way as a title change (its title may be the same as the page before's)
    bg.chrome.tabs.onUpdated.listeners.forEach(fn => fn(1, {status: 'complete'}));
    await settle();
    assert.equal(writes, 2, 'not at once');
    await new Promise(resolve => setTimeout(resolve, 200));
    await settle();
    assert.equal(writes, 3);
});

test('sessions: a window closing marks its window, not each of its tabs', async () => {
    const local = createStorageArea();
    let open = [openTab(1, 'https://a.com/', 1), openTab(2, 'https://b.com/', 2), openTab(3, 'https://c.com/', 2)];
    let windows = [{id: 1}, {id: 2}];
    const browser = fakeBrowser();
    browser.tabs.query = async () => open.map(tab => ({...tab}));
    browser.windows.getAll = async () => windows.map(win => ({...win}));
    const bg = startBackground({local, browser});
    await waitFor(async () => (await sessionKeys(local)).length === 1);
    const stored = async () => Object.values(await local.get(await sessionKeys(local)))[0];
    // Chrome removes the window's tabs one by one (the window is still listed meanwhile), then the window
    open = [open[0], open[2]];
    bg.chrome.tabs.onRemoved.listeners.forEach(fn => fn(2, {windowId: 2, isWindowClosing: true}));
    await settle();
    open = [open[0]];
    bg.chrome.tabs.onRemoved.listeners.forEach(fn => fn(3, {windowId: 2, isWindowClosing: true}));
    windows = [{id: 1}];
    bg.chrome.windows.onRemoved.listeners.forEach(fn => fn(2));
    await settle();
    const session = await stored();
    assert.deepEqual(session.tabs.map(tab => [tab.id, tab.closed]), [[1, undefined], [2, undefined], [3, undefined]]);
    assert.deepEqual(Object.keys(session.windows), ['2']);
    // then a tab closed by itself
    open = [openTab(4, 'https://d.com/', 1)];
    bg.chrome.tabs.onRemoved.listeners.forEach(fn => fn(1, {windowId: 1, isWindowClosing: false}));
    await settle();
    assert.ok((await stored()).tabs.find(tab => tab.id === 1).closed);
});

test('sessions: addresses between two writes reach the trail, with the titles that came for them', async () => {
    const local = createStorageArea();
    let open = [openTab(1, 'https://a.com/')];
    const browser = fakeBrowser();
    browser.tabs.query = async () => open.map(tab => ({...tab}));
    browser.windows.getAll = async () => [{id: 1}];
    const bg = startBackground({local, browser});
    await waitFor(async () => (await sessionKeys(local)).length === 1);
    // hold the next write until all events came
    const queue = bg.context.inSessionQueue(() => new Promise(resolve => setTimeout(resolve, 50)));
    const fire = (change) => bg.chrome.tabs.onUpdated.listeners.forEach(fn => fn(1, change));
    fire({url: 'https://b.com/'});
    fire({title: 'Page B'});
    fire({url: 'https://c.com/'});
    open = [openTab(1, 'https://c.com/')];
    await queue;
    await settle();
    const session = Object.values(await local.get(await sessionKeys(local)))[0];
    assert.deepEqual(session.tabs[0].trail.map(step => [step.url, step.title]),
        [['https://a.com/', 'T https://a.com/'], ['https://b.com/', 'Page B']]);
});
