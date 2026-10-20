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
    setTabs: (key, tabs, seen_h) => groups.setTabs(key, tabs, seen_h),
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

// a new tab page that can take the first opened tab instead of staying empty next to them
function isBlankTab(tab) {
    return !!tab && /^(chrome:\/\/(newtab|new-tab-page)\/?|about:blank)$/.test(tab.pendingUrl || tab.url || '');
}

// one by one, in order: a tab that can't be opened (a bad address) doesn't stop the others
async function createTabs(windowId, tabs, activeFirst) {
    let failed = 0;
    for (let i = 0; i < tabs.length; i++) {
        try {
            await chrome.tabs.create({windowId, url: tabs[i].url, pinned: !!tabs[i].pinned, active: activeFirst && i === 0});
        } catch (e) {
            failed++;
        }
    }
    return failed;
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
        const failed = await createTabs(active ? active.windowId : windowId, rest, rest === tabs);
        return {failed};
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
            return {failed: i + await createTabs(win.id, tabs.slice(i + 1), false)};
        }
        throw error;
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
                // show options page
                chrome.tabs.create({'url': 'options.html#help'});
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

// remove the oldest session from chrome.storage.local (if sessions numbers >= config.session_numbers).
// Only `tg_` keys are sessions: local storage also holds saved group copies (`lg_`).
function cleanupSessions() {
    chrome.storage.local.get(function (items) {
        const session_keys = Object.keys(items).filter(function (key) {
            return key.indexOf(session_config.prefix) === 0;
        });

        if (session_keys.length >= session_config.session_numbers) {
            const time = key => parseInt(key.slice(session_config.prefix.length), 10);
            session_keys.sort((a, b) => time(a) - time(b));
            chrome.storage.local.remove(session_keys[0]);
        }
    });
}

async function updateCurrentSession() {
    const session_storage = await chrome.storage.session.get('session_id');
    let session_id = session_storage.session_id;
    if (!session_id) {
        session_id = session_config.prefix + (new Date()).getTime();
        await chrome.storage.session.set({session_id});

        cleanupSessions();
    }
    chrome.tabs.query({}, function (tabs) {
        // updated: when the session last changed, so the popup can show "14:02–23:05" (sessions from 0.4.0 don't have it)
        const session = {
            name: '',
            updated: Date.now(),
            tabs: [],
        };
        const obj = {};
        tabs.forEach(function (tab) {
            const obj = {};
            if (!tab.url.startsWith('chrome-devtools://')) {
                obj.pinned = tab.pinned;
                obj.title = tab.title;
                obj.url = tab.url;
                obj.windowId = tab.windowId;
                session.tabs.push(obj);
            }
        });

        obj[session_id] = session;
        chrome.storage.local.set(obj);
    });
}

function onUpdated(tab_id, change_info) {
    if (change_info.url) {
        updateCurrentSession();
    }
}

const session_events = [
    [chrome.tabs.onUpdated, onUpdated],
    [chrome.tabs.onMoved, updateCurrentSession],
    [chrome.tabs.onAttached, updateCurrentSession],
    [chrome.tabs.onRemoved, updateCurrentSession],
    [chrome.tabs.onReplaced, updateCurrentSession],
];

// Listeners are added when the service worker starts (Chrome wakes it only for those), then removed if sessions
// are turned off. The Settings switch changes it at once. Turned off, the current session ends: on again starts a new one.
async function watchSessions(on) {
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
        await updateCurrentSession();
    }
}

session_events.forEach(([event, listener]) => event.addListener(listener));

storage.area.get({session_watcher: storage.default_options.session_watcher}, function (from_storage) {
    watchSessions(!!from_storage.session_watcher);
});

chrome.storage.onChanged.addListener(function (changes, area_name) {
    if (area_name === 'sync' && changes.session_watcher) {
        const value = changes.session_watcher.newValue;
        watchSessions(!!(value === undefined ? storage.default_options.session_watcher : value));
    }
});
