// it's copied from ./storage.js file
// had to copy/past here to this code works with mv3 service worker
var storage = {
    area: chrome.storage.sync,
    default_options: {
        date_format: 'eu', // or 'us'
        pinned: 0, //do not add pinned tabs
        cur_win: 1, // save tabs from current window only
        active_tab: '#saved', //or '#sessions'
        session_watcher: 1,  //extension will watch sessions
    },
};

const session_config = {
    session_numbers: 6,
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
    }
});

/*SESSION WATCHER*/

// remove old sessions from chrome.storage.local (if sessions numbers >= config.session_numbers)
function cleanupSessions() {
    chrome.storage.local.get(function (items) {
        var key = (function () {
                var item,
                    id;
                for (item in items) {
                    if (item.indexOf(session_config.prefix) === 0) {
                        id = item;
                        break;
                    }
                }
                return id ? id.slice(session_config.prefix.length) : id;
            }()),
            items_keys = Object.keys(items);

        if (key && items_keys.length >= session_config.session_numbers) {
            items_keys.forEach(function (el) {
                var el_id = el.slice(session_config.prefix.length);
                key = el_id < key ? el_id : key;
            });
            chrome.storage.local.remove(session_config.prefix + key);
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
