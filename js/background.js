importScripts('storage.js', 'group_store.js');

// The only writer of saved groups. Popup and options pages go through js/group_store_client.js.
const groups = groupStore.createGroupStore({
    sync: chrome.storage.sync,
    local: chrome.storage.local,
    conflict_suffix: ' (' + chrome.i18n.getMessage('bg_conflictCopy') + ')',
});

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
    restore: (key) => groups.restore(key),
    usage: () => groups.usage(),
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
        const session = {
            name: '',
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
