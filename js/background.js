importScripts('storage.js', 'group_store.js', 'backup.js');

// The only writer of saved groups. Popup and options pages go through js/group_store_client.js.
const groups = groupStore.createGroupStore({
    sync: chrome.storage.sync,
    local: chrome.storage.local,
    conflict_suffix: ' (' + chrome.i18n.getMessage('bg_conflictCopy') + ')',
    // an open popup shows "2 groups synced"; with no page open there is nobody to answer, that's fine
    on_synced: keys => chrome.runtime.sendMessage({msg: 'groupsSynced', keys}).catch(() => {}),
});

// state before the last restore from a backup, for "Undo last restore"
const RESTORE_UNDO_KEY = 'restore_undo';

function withoutSyncFlags(list) {
    const out = {};
    Object.keys(list).forEach(function (key) {
        out[key] = {name: list[key].name, index: list[key].index, tabs: list[key].tabs};
    });
    return out;
}

// replace_groups: groups not in `data` go to trash; otherwise groups are left alone when `data` has none.
// A changed session_watcher option is picked up by the storage listener (watchSessions).
async function applyBackup(data, replace_groups) {
    let result = {errors: {}};

    if (replace_groups || Object.keys(data.groups).length) {
        result = await groups.replaceAll(data.groups);
    }
    if (Object.keys(data.options).length) {
        await chrome.storage.sync.set(data.options);
    }
    return result;
}

// parsed backup text, or {error} with the code from backup.parseText
async function readBackup(text) {
    try {
        return {data: await backup.parseText(text)};
    } catch (e) {
        if (e.code) {
            return {error: e.code};
        }
        throw e;
    }
}

// what restoring `data` does: groups and tabs in it, settings or not, and how many current groups go to trash
// (not in the backup, or there with another name or tabs: replaceAll keeps that version in trash).
// replace_groups: as applyBackup's (groups go even when `data` has none)
async function restorePlan(data, replace_groups) {
    const keys = Object.keys(data.groups);
    const list = await groups.list();
    const current = Object.keys(list);
    return {
        groups: keys.length,
        tabs: keys.reduce((sum, key) => sum + data.groups[key].tabs.length, 0),
        options: Object.keys(data.options).length > 0,
        current: current.length,
        trashed: keys.length || replace_groups ? current.filter(key => !data.groups.hasOwnProperty(key) ||
            !groupStore.sameContent(list[key], data.groups[key])).length : 0,
    };
}

const group_ops = {
    list: async function () {
        try {
            await groups.reconcile();
        } catch (e) {
            console.error('TabHamster: reconcile failed', e);
        }
        return groups.list();
    },
    listTrash: () => groups.listTrash(),
    save: (key, group) => groups.save(key, group),
    setTabs: (key, tabs, seen_h, keep_old) => groups.setTabs(key, tabs, seen_h, keep_old),
    removeTab: (key, seen, index) => groups.removeTab(key, seen, index),
    editTab: (key, seen, index, edit) => groups.editTab(key, seen, index, edit),
    addTab: (key, tab, duplicate) => groups.addTab(key, tab, duplicate),
    moveTab: (key, seen, index, pos) => groups.moveTab(key, seen, index, pos),
    moveTabTo: (key, seen, index, to, pos) => groups.moveTabTo(key, seen, index, to, pos),
    rename: (key, name) => groups.rename(key, name),
    setIndex: (indexes) => groups.setIndex(indexes),
    remove: (key) => groups.remove(key),
    discard: (key, saved) => groups.discard(key, saved),
    restore: (key) => groups.restore(key),
    usage: () => groups.usage(),
    sizes: () => groups.sizes(),

    exportBackup: async function () {
        const options = await chrome.storage.sync.get(storage.default_options);
        return backup.exportText(withoutSyncFlags(await groups.list()), options, chrome.storage.sync);
    },
    // what importBackup would do, nothing is changed: {groups, tabs, options, current, trashed} (see restorePlan)
    // or {error: 'not_backup' | 'damaged' | 'empty'}
    previewBackup: async function (text) {
        const read = await readBackup(text);
        return read.error ? {error: read.error} : restorePlan(read.data);
    },
    // {groups: number, errors} or {error: 'not_backup' | 'damaged' | 'empty'} when nothing was changed
    importBackup: async function (text) {
        const read = await readBackup(text);
        if (read.error) {
            return {error: read.error};
        }
        const plan = await restorePlan(read.data);
        await chrome.storage.local.set({[RESTORE_UNDO_KEY]: {
            time: Date.now(),
            restored: plan.groups,
            trashed: plan.trashed,
            groups: withoutSyncFlags(await groups.list()),
            options: await chrome.storage.sync.get(storage.default_options),
        }});
        const result = await applyBackup(read.data, false);
        return {groups: plan.groups, errors: result.errors};
    },
    // what undoRestore would do: {groups, tabs, options, current, trashed} (see restorePlan) or {error: 'nothing_to_undo'}
    previewUndoRestore: async function () {
        const snapshot = (await chrome.storage.local.get(RESTORE_UNDO_KEY))[RESTORE_UNDO_KEY];
        return snapshot ? restorePlan(snapshot, true) : {error: 'nothing_to_undo'};
    },
    undoRestore: async function () {
        const snapshot = (await chrome.storage.local.get(RESTORE_UNDO_KEY))[RESTORE_UNDO_KEY];
        if (!snapshot) {
            return {error: 'nothing_to_undo'};
        }
        const result = await applyBackup(snapshot, true);
        await chrome.storage.local.remove(RESTORE_UNDO_KEY);
        return {groups: Object.keys(snapshot.groups).length, errors: result.errors};
    },
    // the restore that can be undone: {time, restored: groups from the backup, trashed: groups it sent to trash}
    // (counts are null for a restore made by 0.4.0), or null
    restoreInfo: async function () {
        const snapshot = (await chrome.storage.local.get(RESTORE_UNDO_KEY))[RESTORE_UNDO_KEY];
        return snapshot ? {
            time: snapshot.time,
            restored: snapshot.hasOwnProperty('restored') ? snapshot.restored : null,
            trashed: snapshot.hasOwnProperty('trashed') ? snapshot.trashed : null,
        } : null;
    },
};

// Opening saved groups and sessions. Done here, not in the popup: a new window takes the focus and closes the popup,
// and the opening has to finish anyway. tabs: [{url, pinned?}]. Answers {failed: number of tabs that didn't open}.

// a new tab page: it can take the first opened tab instead of staying empty next to them, and it isn't a page a
// session's tab went through (Edge has its own)
function isBlankUrl(url) {
    return /^(chrome:\/\/(newtab|new-tab-page)\/?|edge:\/\/newtab\/?|about:blank)$/.test(url || '');
}

function isBlankTab(tab) {
    return !!tab && isBlankUrl(tab.pendingUrl || tab.url);
}

// one by one, in order: a tab that can't be opened (a bad address) doesn't stop the others.
// {failed: how many didn't open, error: the last error}
async function createTabs(windowId, tabs, activeFirst) {
    let failed = 0;
    let error = null;
    for (let i = 0; i < tabs.length; i++) {
        try {
            await chrome.tabs.create({windowId, url: tabs[i].url, pinned: !!tabs[i].pinned, active: activeFirst && i === 0});
        } catch (e) {
            failed++;
            error = e;
        }
    }
    return {failed, error};
}

const open_ops = {
    // into the popup's window; a blank new tab there takes the first tab
    current: async function (tabs, windowId) {
        const [active] = await chrome.tabs.query(windowId ? {active: true, windowId} : {active: true, lastFocusedWindow: true});
        let rest = tabs;
        if (isBlankTab(active)) {
            try {
                await chrome.tabs.update(active.id, {url: tabs[0].url, pinned: !!tabs[0].pinned});
                rest = tabs.slice(1);
            } catch (e) {
                // open it as a new tab like the others
            }
        }
        const res = await createTabs(active ? active.windowId : windowId, rest, rest === tabs);
        // nothing opened: the popup stays open (an opened tab would close it) and says why
        if (res.failed === tabs.length) {
            throw res.error;
        }
        return {failed: res.failed};
    },
    // opens with the first tab Chrome accepts (a refused one leaves no window), the rest follow
    window: async function (tabs) {
        let error;
        for (let i = 0; i < tabs.length; i++) {
            let win;
            try {
                win = await chrome.windows.create({focused: true, url: tabs[i].url});
            } catch (e) {
                error = e;
                continue;
            }
            if (tabs[i].pinned) {
                await chrome.tabs.update(win.tabs[0].id, {pinned: true});
            }
            return {failed: i + (await createTabs(win.id, tabs.slice(i + 1), false)).failed};
        }
        throw error;
    },
    // a session's window: into the popup's window if all it has is a blank new tab (Chrome just started), else new
    blankOrWindow: async function (tabs, windowId) {
        const here = windowId ? await chrome.tabs.query({windowId}) : [];
        return here.length === 1 && isBlankTab(here[0]) ? open_ops.current(tabs, windowId) : open_ops.window(tabs);
    },
    // without "Allow in Incognito" the extension can open the window but can't add tabs to it later: all at once.
    // One address Chrome refuses fails the whole window: then once more without the kinds it refuses
    // (javascript:, and chrome: debug pages like chrome://crash).
    incognito: async function (tabs) {
        const urls = tabs.map(tab => tab.url);
        try {
            await chrome.windows.create({incognito: true, focused: true, url: urls});
            return {failed: 0};
        } catch (e) {
            const rest = urls.filter(url => !/^\s*(javascript|chrome):/i.test(url));
            if (!rest.length || rest.length === urls.length) {
                throw e;
            }
            await chrome.windows.create({incognito: true, focused: true, url: rest});
            return {failed: urls.length - rest.length};
        }
    },
};

const session_config = {
    session_numbers: 30,
    prefix: 'tg_',
    // pages kept per tab; closed tabs kept per session, by themselves or with their window (the oldest go first)
    trail: 10,
    closed: 500,
    // a title change alone writes at most this often (some titles change every second: timers, "(3) Inbox")
    title_wait: 10000,
    // how long after the worker starts a new session waits to know why it started (startEvents)
    start_wait: 1000,
};

chrome.runtime.onInstalled.addListener(function (details) {

    // good place to set default options
    function setDefaults(callback) {
        storage.area.get(function (stored_options) {
            var default_options = storage.default_options,
                option,
                new_options = {};

            for (option in default_options) {
                if (!stored_options.hasOwnProperty(option)) {
                    new_options[option] = default_options[option];
                }
            }
            if (Object.keys(new_options).length !== 0) {
                // save to area if new default options is appeared
                storage.area.set(new_options, function () {
                    if (typeof callback === 'function') {
                        callback();
                    }
                });
            } else {
                if (typeof callback === 'function') {
                    callback();
                }
            }
        });
    }

    switch (details.reason) {
        case 'install': // if ext is first installed
            setDefaults(function () {
                // how to pin TabHamster to the toolbar
                chrome.tabs.create({'url': 'welcome.html'});
            });
            break;
        case 'update':
            setDefaults();
            break;
        default:
            break;
    }
});

chrome.runtime.onUpdateAvailable.addListener(function (details) {
    chrome.runtime.reload();
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    switch (msg.msg) {
        case 'open':
            if (!open_ops.hasOwnProperty(msg.how) || !Array.isArray(msg.tabs) || !msg.tabs.length) {
                sendResponse({error: 'Nothing to open'});
                break;
            }
            open_ops[msg.how](msg.tabs, msg.windowId).then(function (result) {
                sendResponse({result});
            }, function (e) {
                sendResponse({error: e.message});
            });
            return true;
        case 'groups':
            if (!group_ops.hasOwnProperty(msg.op)) {
                sendResponse({error: 'Unknown operation: ' + msg.op});
                break;
            }
            group_ops[msg.op].apply(null, msg.args || []).then(function (result) {
                sendResponse({result});
            }, function (e) {
                sendResponse({error: e.message});
            });
            return true; // answer comes later
    }
});

// another device changed saved groups
let reconcile_timer = null;
chrome.storage.onChanged.addListener(function (changes, area_name) {
    if (area_name !== 'sync' || !Object.keys(changes).some(k => groupStore.isGroupKey(k) || groupStore.isChunkKey(k))) {
        return;
    }
    clearTimeout(reconcile_timer);
    reconcile_timer = setTimeout(function () {
        groups.reconcile().catch(e => console.error('TabHamster: reconcile failed', e));
    }, 500);
});

// every service worker start: convert 0.3.0 data (once), then catch up with sync
groups.migrate().then(() => groups.reconcile()).catch(e => console.error('TabHamster: startup sync failed', e));

/*SESSION WATCHER*/

// A session is one browser run and keeps every tab opened during it: where it is (or was when it closed), the pages
// it went through (its trail), and what was closed. Events say that something happened, a query says what is true
// now: a write merges the open tabs and windows into the stored session (mergeSession), so a missed event is put
// right by the next write. Stored as (v: 2):
//   {name: '', updated, v: 2, tabs: [{id, url, title, pinned, windowId, at, closed?, groupId?, trail?}],
//    windows: {<windowId>: {closed}}}
// at: when the tab got to its address. closed: when the tab was closed by itself; a window closed with its tabs is
// in `windows` instead, its tabs aren't marked. trail: [{url, title, at}], oldest first. groupId: a Chrome tab group
// (names and colours come with `tabGroups`, PLAN.md 1.1.0). Sessions from before (no v) are snapshots of the tabs.

// Session writes and switching sessions on or off run one after another: two writes at once could each start a
// session, and a write still running when sessions are turned off could start one again after the switch.
let session_queue = Promise.resolve();

function inSessionQueue(fn) {
    session_queue = session_queue.then(fn).catch(e => console.error('TabHamster: session update failed', e));
    return session_queue;
}

// What happened since the last write, for the next one to take: addresses a tab went through ({url, title, at} by
// tab id), windows closing (their tabs go with them, not one by one), tab ids Chrome replaced (old id -> new id).
function newNotes() {
    return {steps: new Map(), closing: new Set(), replaced: new Map()};
}

let session_notes = newNotes();

// Why the worker started: a new browser run ('browser'), the extension installed or updated ('install', 'update';
// reloading an unpacked extension is an update too). Chrome sends these right after the worker starts.
const worker_start = Date.now();
const start_events = new Set();
chrome.runtime.onStartup.addListener(() => start_events.add('browser'));
chrome.runtime.onInstalled.addListener(details => start_events.add(details.reason));

function startEvents() {
    const wait = worker_start + session_config.start_wait - Date.now();
    return new Promise(resolve => setTimeout(resolve, Math.max(0, wait))).then(() => start_events);
}

// remove the oldest session from chrome.storage.local (if sessions numbers >= config.session_numbers).
// Only `tg_` keys are sessions: local storage also holds saved group copies (`lg_`).
async function cleanupSessions() {
    const local = chrome.storage.local;
    // only the keys are needed (getKeys: Chrome 130+)
    const keys = local.getKeys ? await local.getKeys() : Object.keys(await local.get(null));
    const session_keys = keys.filter(function (key) {
        return key.indexOf(session_config.prefix) === 0;
    });

    if (session_keys.length >= session_config.session_numbers) {
        const time = key => parseInt(key.slice(session_config.prefix.length), 10);
        session_keys.sort((a, b) => time(a) - time(b));
        await chrome.storage.local.remove(session_keys[0]);
    }
}

async function sessionsOn() {
    const options = await storage.area.get({session_watcher: storage.default_options.session_watcher});
    return !!options.session_watcher;
}

/**
 * The current session's key; starts one if there is none. Chrome clears session storage when the browser starts
 * and when the extension is updated or reloaded: after an update (in the same browser run, so the same tab ids) the
 * session goes on. `fresh`: sessions were just turned on, a new one starts.
 */
async function currentSessionId(fresh) {
    const session_storage = await chrome.storage.session.get('session_id');
    if (session_storage.session_id) {
        return {session_id: session_storage.session_id, continued: false};
    }
    if (!fresh) {
        const events = await startEvents();
        const last = events.has('update') && !events.has('browser') &&
            (await chrome.storage.local.get('session_last')).session_last;
        if (last) {
            await chrome.storage.session.set({session_id: last});
            return {session_id: last, continued: true};
        }
    }
    return {session_id: await startSession(), continued: false};
}

async function startSession() {
    const session_id = session_config.prefix + Date.now();
    await chrome.storage.session.set({session_id});
    await chrome.storage.local.set({session_last: session_id});
    return session_id;
}

// A session goes on after an update only in the same browser run: some tab still open with its id and address.
// (Tab ids start again in a new run; an update at browser start could come without onStartup.)
function sameRun(stored, open) {
    return !!stored && stored.v === 2 && stored.tabs.some(tab => !tab.closed && !(stored.windows || {})[tab.windowId] &&
        open.some(now => now.id === tab.id && (now.url || now.pendingUrl) === tab.url));
}

/**
 * An open tab as stored: where it was at the last write (`before`), the addresses it went through since (`steps`)
 * and where it is now. A new address puts the one before into the trail (not a new tab page); the same address
 * again (a reload) adds nothing.
 */
function sessionTab(tab, before, steps, now) {
    const url = tab.url || tab.pendingUrl || '';
    // a tab still loading a new address can have the page before's title: none is better than a wrong one (its load
    // ending writes again, onUpdated). A page of a single-page app keeps the title it has: it may well be the same.
    const title = before && url !== before.url && tab.status === 'loading' && tab.title === before.title ? '' : tab.title;
    const path = (before ? [{url: before.url, title: before.title, at: before.at}] : [])
        .concat(steps, [{url, title, at: now}]);
    const trail = before && before.trail ? before.trail.slice() : [];
    let here = null;
    path.forEach(function (step) {
        if (here && step.url !== here.url) {
            if (!isBlankUrl(here.url)) {
                trail.push(here);
            }
            here = null;
        }
        here = here ? {url: here.url, title: step.title || here.title, at: here.at} :
            {url: step.url, title: step.title || '', at: step.at};
    });
    const stored = {id: tab.id, url, title: here.title, pinned: !!tab.pinned, windowId: tab.windowId, at: here.at};
    if (tab.groupId >= 0) {
        stored.groupId = tab.groupId;
    }
    if (trail.length) {
        stored.trail = trail.slice(-session_config.trail);
    }
    return stored;
}

/**
 * The session after a write: `stored` (null for a new one), the open tabs (in Chrome's order), the ids of the open
 * windows, the notes since the last write. A stored tab that isn't open any more was closed by itself if its window
 * is still open, else its window was closed (all its tabs stay, as they were). Null when there are no tabs.
 */
function mergeSession(stored, open, window_ids, notes, now) {
    const before = new Map();
    const windows = Object.assign({}, stored && stored.windows);
    // a session from before (a snapshot, no tab ids) is not continued: it starts again from the open tabs
    if (stored && stored.v === 2) {
        stored.tabs.forEach(function (tab) {
            before.set(notes.replaced.has(tab.id) ? notes.replaced.get(tab.id) : tab.id, tab);
        });
    }
    // the tabs of a closing window stay as they were at the last write (Chrome removes them one by one)
    let tabs = open.filter(tab => !notes.closing.has(tab.windowId)).map(function (tab) {
        const was = before.get(tab.id);
        before.delete(tab.id);
        // a window with open tabs isn't closed (a close that was cancelled)
        delete windows[tab.windowId];
        return sessionTab(tab, was, notes.steps.get(tab.id) || [], now);
    });
    before.forEach(function (tab) {
        if (tab.closed || windows[tab.windowId]) {
            tabs.push(tab);
        } else if (window_ids.has(tab.windowId) && !notes.closing.has(tab.windowId)) {
            tabs.push(Object.assign({}, tab, {closed: now}));
        } else {
            windows[tab.windowId] = {closed: now};
            tabs.push(tab);
        }
    });
    // closed by themselves or with their window: only the newest are kept
    const closedAt = tab => tab.closed || (windows[tab.windowId] ? windows[tab.windowId].closed : 0);
    const closed = tabs.filter(closedAt).sort((a, b) => closedAt(a) - closedAt(b));
    if (closed.length > session_config.closed) {
        const dropped = new Set(closed.slice(0, closed.length - session_config.closed));
        tabs = tabs.filter(tab => !dropped.has(tab));
    }
    if (!tabs.length) {
        return null;
    }
    const used = new Set(tabs.map(tab => String(tab.windowId)));
    Object.keys(windows).forEach(function (id) {
        if (!used.has(id)) {
            delete windows[id];
        }
    });
    return {name: '', updated: now, v: 2, tabs, windows};
}

// not recorded: DevTools windows, and incognito tabs (seen only with "Allow in Incognito" on)
function recorded(tab) {
    return !tab.incognito && !(tab.url || '').startsWith('chrome-devtools://');
}

// writes the current session (starts one if there is none; a session without tabs isn't stored); only in the queue
async function writeSession(fresh) {
    let {session_id, continued} = await currentSessionId(fresh);
    // what came in so far; what comes during this write is for the next one
    const notes = session_notes;
    session_notes = newNotes();
    const [tabs, wins, items] = await Promise.all([
        chrome.tabs.query({}), chrome.windows.getAll(), chrome.storage.local.get(session_id)]);
    if (continued && !sameRun(items[session_id], tabs)) {
        session_id = await startSession();
    }
    const window_ids = new Set(wins.filter(win => !win.incognito).map(win => win.id));
    // a window still closing is closing at the next write too
    notes.closing.forEach(function (id) {
        if (window_ids.has(id)) {
            session_notes.closing.add(id);
        }
    });
    const session = mergeSession(items[session_id] || null, tabs.filter(recorded), window_ids, notes, Date.now());
    if (!session) {
        return;
    }
    if (!items[session_id]) {
        await cleanupSessions();
    }
    await chrome.storage.local.set({[session_id]: session});
}

// Tab events come in bursts (restoring 100 tabs fires hundreds), and a write reads all tabs, so one write that has
// not started yet covers every event before it. The flag drops when the write starts: an event during a write
// queues one more, which reads the tabs again and so sees that event's change.
let session_write_waiting = null;
let title_timer = null;

function updateCurrentSession() {
    if (session_write_waiting) {
        return session_write_waiting;
    }
    session_write_waiting = inSessionQueue(async function () {
        session_write_waiting = null;
        // this write takes the titles too
        clearTimeout(title_timer);
        title_timer = null;
        if (await sessionsOn()) {
            await writeSession(false);
        }
    });
    return session_write_waiting;
}

// A new address goes into the tab's notes at once: two in one burst both reach the trail. Its title comes later
// (at this point the tab still has the page before's).
function onUpdated(tab_id, change_info) {
    const steps = session_notes.steps;
    if (change_info.url) {
        if (!steps.has(tab_id)) {
            steps.set(tab_id, []);
        }
        steps.get(tab_id).push({url: change_info.url, title: '', at: Date.now()});
    } else if (change_info.title && steps.has(tab_id)) {
        const list = steps.get(tab_id);
        list[list.length - 1].title = change_info.title;
    }
    if (change_info.url || 'pinned' in change_info || 'groupId' in change_info) {
        updateCurrentSession();
    } else if ((change_info.title || change_info.status === 'complete') && !title_timer) {
        // a load that ended brings the title, also one the same as the page before's (no title change comes then)
        title_timer = setTimeout(function () {
            title_timer = null;
            updateCurrentSession();
        }, session_config.title_wait);
    }
}

function onTabRemoved(tab_id, remove_info) {
    if (remove_info && remove_info.isWindowClosing) {
        session_notes.closing.add(remove_info.windowId);
    }
    updateCurrentSession();
}

function onWindowRemoved(window_id) {
    session_notes.closing.add(window_id);
    updateCurrentSession();
}

// prerendered pages and discarded tabs come back under a new id: the session keeps the tab
function onReplaced(added_id, removed_id) {
    session_notes.replaced.set(removed_id, added_id);
    if (session_notes.steps.has(removed_id)) {
        session_notes.steps.set(added_id, session_notes.steps.get(removed_id));
        session_notes.steps.delete(removed_id);
    }
    updateCurrentSession();
}

const session_events = [
    [chrome.tabs.onUpdated, onUpdated],
    [chrome.tabs.onMoved, updateCurrentSession],
    [chrome.tabs.onAttached, updateCurrentSession],
    [chrome.tabs.onRemoved, onTabRemoved],
    [chrome.tabs.onReplaced, onReplaced],
    [chrome.windows.onRemoved, onWindowRemoved],
];

// Listeners are added when the service worker starts (Chrome wakes it only for those), then removed if sessions
// are turned off. The Settings switch changes it at once. Turned off, the current session ends: on again starts a new
// one (`fresh`).
function watchSessions(on, fresh) {
    return inSessionQueue(async function () {
        session_events.forEach(function ([event, listener]) {
            if (on && !event.hasListener(listener)) {
                event.addListener(listener);
            } else if (!on && event.hasListener(listener)) {
                event.removeListener(listener);
            }
        });
        if (!on) {
            await chrome.storage.session.remove('session_id');
            return;
        }
        const session_storage = await chrome.storage.session.get('session_id');
        if (!session_storage.session_id) {
            await writeSession(fresh);
        }
    });
}

session_events.forEach(([event, listener]) => event.addListener(listener));

sessionsOn().then(on => watchSessions(on, false), e => console.error('TabHamster: reading the sessions option failed', e));

chrome.storage.onChanged.addListener(function (changes, area_name) {
    if (area_name === 'sync' && changes.session_watcher) {
        const value = changes.session_watcher.newValue;
        watchSessions(!!(value === undefined ? storage.default_options.session_watcher : value), true);
    }
});
