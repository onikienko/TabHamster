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

// replace_groups: groups not in `data` go to trash; otherwise groups are left alone when `data` has none
async function applyBackup(data, replace_groups) {
    const before = await chrome.storage.sync.get(storage.default_options);
    let result = {errors: {}};

    if (replace_groups || Object.keys(data.groups).length) {
        result = await groups.replaceAll(data.groups);
    }
    if (Object.keys(data.options).length) {
        await chrome.storage.sync.set(data.options);
    }
    if (data.options.hasOwnProperty('session_watcher') && data.options.session_watcher !== before.session_watcher) {
        // session watcher listeners are set up when the service worker starts
        setTimeout(() => chrome.runtime.reload(), 500);
    }
    return result;
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
    saveMany: (items) => groups.saveMany(items),
    remove: (key) => groups.remove(key),
    discard: (key) => groups.discard(key),
    restore: (key) => groups.restore(key),
    usage: () => groups.usage(),
    sizes: () => groups.sizes(),

    exportBackup: async function () {
        const options = await chrome.storage.sync.get(storage.default_options);
        return backup.exportText(withoutSyncFlags(await groups.list()), options, chrome.storage.sync);
    },
    // {groups: number, errors} or {error: 'not_backup' | 'damaged' | 'empty'} when nothing was changed
    importBackup: async function (text) {
        let data;
        try {
            data = await backup.parseText(text);
        } catch (e) {
            if (e.code) {
                return {error: e.code};
            }
            throw e;
        }
        await chrome.storage.local.set({[RESTORE_UNDO_KEY]: {
            time: Date.now(),
            groups: withoutSyncFlags(await groups.list()),
            options: await chrome.storage.sync.get(storage.default_options),
        }});
        const result = await applyBackup(data, false);
        return {groups: Object.keys(data.groups).length, errors: result.errors};
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
    // time of the restore that can be undone, or null
    restoreInfo: async function () {
        const snapshot = (await chrome.storage.local.get(RESTORE_UNDO_KEY))[RESTORE_UNDO_KEY];
        return snapshot ? snapshot.time : null;
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
    window: async function (tabs) {
        const win = await chrome.windows.create({focused: true, url: tabs[0].url});
        if (tabs[0].pinned) {
            await chrome.tabs.update(win.tabs[0].id, {pinned: true});
        }
        return {failed: await createTabs(win.id, tabs.slice(1), false)};
    },
    // without "Allow in Incognito" the extension can open the window but can't add tabs to it later: all at once
    incognito: async function (tabs) {
        await chrome.windows.create({incognito: true, focused: true, url: tabs.map(tab => tab.url)});
        return {failed: 0};
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
        case 'openLinksInNewWindow':
            chrome.windows.create({'type': 'normal', 'focused': true}, function (win) {
                msg.links.forEach(function (el) {
                    chrome.tabs.create({'windowId': win.id, 'url': el.url, 'pinned': el.pinned});
                });
                chrome.tabs.remove(win.tabs[0].id); // remove default New Tab Page
                //sendResponse({msg: 'OK'});
                //window.close();
            });
            break;
        case 'openLinksInCurrentWindow':
            msg.links.forEach(function (el) {
                chrome.tabs.create({'url': el.url, 'pinned': el.pinned});
            });
            break;
        case 'openWindowLinksInCurrentWindow':
            msg.links.forEach(function (el) {
                if (el.windowId === parseInt(msg.window_id, 10)) {
                    chrome.tabs.create({'url': el.url, 'pinned': el.pinned});
                }
            });
            break;
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

chrome.tabs.onUpdated.addListener(onUpdated);
chrome.tabs.onMoved.addListener(updateCurrentSession);
chrome.tabs.onAttached.addListener(updateCurrentSession);
chrome.tabs.onRemoved.addListener(updateCurrentSession);
chrome.tabs.onReplaced.addListener(updateCurrentSession);

storage.area.get({session_watcher: storage.default_options.session_watcher}, async function (from_storage) {
    if (!from_storage.session_watcher) {
        chrome.tabs.onUpdated.hasListener(onUpdated) && chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onMoved.hasListener(updateCurrentSession) && chrome.tabs.onMoved.removeListener(updateCurrentSession);
        chrome.tabs.onAttached.hasListener(updateCurrentSession) && chrome.tabs.onAttached.removeListener(updateCurrentSession);
        chrome.tabs.onRemoved.hasListener(updateCurrentSession) && chrome.tabs.onRemoved.removeListener(updateCurrentSession);
        chrome.tabs.onReplaced.hasListener(updateCurrentSession) && chrome.tabs.onReplaced.removeListener(updateCurrentSession);
    } else {
        const session_storage = await chrome.storage.session.get('session_id');
        if (!session_storage.session_id) {
            updateCurrentSession();
        }
    }
});
