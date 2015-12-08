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
        case 'install': // if ext is  first installed
            var ua = navigator.userAgent;
            // browser name to local storage (src="opera://favicon/http://www.google.com/" or "chrome://favicon")
            localStorage.browser = ua.indexOf('OPR/') === -1 ? 'chrome' : 'opera';
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
storage.area.get('session_watcher', function (from_storage) {
    if (from_storage.session_watcher) {
        (function () {
            var config = {
                    session_numbers: 30,
                    prefix: 'tg_'
                },
                session_id = config.prefix + (new Date()).getTime(); //current session id

            localStorage.session_id = session_id;

            // remove old sessions from chrome.storage.local (if sessions numbers >= config.session_numbers)
            chrome.storage.local.get(function (items) {
                var key = (function () {
                        var item,
                            id;
                        for (item in items) {
                            if (item.indexOf(config.prefix) === 0) {
                                id = item;
                                break;
                            }
                        }
                        return id ? id.slice(config.prefix.length) : id;
                    }()),
                    items_keys = Object.keys(items);

                if (key && items_keys.length >= config.session_numbers) {
                    items_keys.forEach(function (el) {
                        var el_id = el.slice(config.prefix.length);
                        key = el_id < key ? el_id : key;
                    });
                    chrome.storage.local.remove(config.prefix + key);
                }
            });

            function updateCurrentSession() {
                chrome.tabs.query({}, function (tabs) {
                    var session = {
                            name: '',
                            tabs: []
                        },
                        obj = {};
                    tabs.forEach(function (tab) {
                        var obj = {};
                        if (tab.url.indexOf('chrome-devtools://') !== 0) {
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

            /* tabs event listeners*/
            chrome.tabs.onUpdated.addListener(function (tab_id, change_info) {
                if (change_info.url) {
                    updateCurrentSession();
                }
            });
            chrome.tabs.onMoved.addListener(function () {
                updateCurrentSession();
            });
            chrome.tabs.onAttached.addListener(function () {
                updateCurrentSession();
            });
            chrome.tabs.onRemoved.addListener(function () {
                updateCurrentSession();
            });
            chrome.tabs.onReplaced.addListener(function () {
                updateCurrentSession();
            });

            updateCurrentSession();
        }());
    }
});


// TODO index optimization for groups and links. (on startup)