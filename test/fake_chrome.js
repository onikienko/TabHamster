// Fake chrome.* API for trying the extension pages in a normal browser tab (test/popup_harness.html, test/options_harness.html).
// The real js/background.js runs in the same page. Storage is kept in localStorage, so reloading the
// page is like reopening the popup. From the console:
//   fakeChrome.sync_error = 'Resource::kQuotaBytes quota exceeded'   // every sync write fails with this message
//   fakeChrome.sync_error = null
//   fakeChrome.reset()                                       // empty all storage and reload
// URL parameters: ?tabs=N open tabs to save (default 8), ?lang=uk messages from _locales/uk,
// ?delay=ms slow answers from the background (a service worker that is waking up).
(function () {
    'use strict';

    var params = new URLSearchParams(location.search);
    var root = new URL('../', location.href).href;
    var encoder = new TextEncoder();
    var SYNC_LIMITS = {
        QUOTA_BYTES: 102400,
        QUOTA_BYTES_PER_ITEM: 8192,
        MAX_ITEMS: 512,
        MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
        MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
    };

    function getText(path) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', root + path, false);
        xhr.send();
        return xhr.responseText;
    }

    function event() {
        var listeners = [];
        return {
            listeners: listeners,
            addListener: function (fn) {
                listeners.push(fn);
            },
            removeListener: function (fn) {
                var i = listeners.indexOf(fn);
                if (i !== -1) {
                    listeners.splice(i, 1);
                }
            },
            hasListener: function (fn) {
                return listeners.indexOf(fn) !== -1;
            },
        };
    }

    // promise, or callback with chrome.runtime.lastError set while it runs
    function finish(promise, callback) {
        if (typeof callback === 'function') {
            promise.then(function (value) {
                callback(value);
            }, function (e) {
                chrome.runtime.lastError = {message: e.message};
                try {
                    callback();
                } finally {
                    chrome.runtime.lastError = undefined;
                }
            });
        }
        return promise;
    }

    function createArea(name, limits) {
        var storage_key = 'fake_chrome_' + name;
        var data = JSON.parse(localStorage.getItem(storage_key) || '{}');

        function size(key, value) {
            return encoder.encode(key + JSON.stringify(value)).length;
        }

        function changed(changes) {
            localStorage.setItem(storage_key, JSON.stringify(data));
            setTimeout(function () {
                chrome.storage.onChanged.listeners.forEach(function (fn) {
                    fn(changes, name);
                });
            }, 0);
        }

        function pick(keys) {
            var out = {};
            if (keys === null || keys === undefined) {
                return JSON.parse(JSON.stringify(data));
            }
            var defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
            var list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
            list.forEach(function (key) {
                if (data.hasOwnProperty(key)) {
                    out[key] = JSON.parse(JSON.stringify(data[key]));
                } else if (defaults[key] !== undefined) {
                    out[key] = defaults[key];
                }
            });
            return out;
        }

        var area = {
            get: function (keys, callback) {
                if (typeof keys === 'function') {
                    callback = keys;
                    keys = null;
                }
                return finish(Promise.resolve(pick(keys)), callback);
            },
            set: function (items, callback) {
                return finish(new Promise(function (resolve) {
                    var copy = JSON.parse(JSON.stringify(items));
                    var next = Object.assign({}, data, copy);
                    var changes = {};
                    if (limits) {
                        if (fakeChrome.sync_error) {
                            throw new Error(fakeChrome.sync_error);
                        }
                        Object.keys(copy).forEach(function (key) {
                            if (size(key, copy[key]) > limits.QUOTA_BYTES_PER_ITEM) {
                                throw new Error('Resource::kQuotaBytesPerItem quota exceeded');
                            }
                        });
                        if (Object.keys(next).reduce(function (sum, key) {
                            return sum + size(key, next[key]);
                        }, 0) > limits.QUOTA_BYTES) {
                            throw new Error('Resource::kQuotaBytes quota exceeded');
                        }
                    }
                    Object.keys(copy).forEach(function (key) {
                        changes[key] = {oldValue: data[key], newValue: copy[key]};
                    });
                    data = next;
                    changed(changes);
                    resolve();
                }), callback);
            },
            remove: function (keys, callback) {
                return finish(new Promise(function (resolve) {
                    var changes = {};
                    if (limits && fakeChrome.sync_error) {
                        throw new Error(fakeChrome.sync_error);
                    }
                    (typeof keys === 'string' ? [keys] : keys).forEach(function (key) {
                        if (data.hasOwnProperty(key)) {
                            changes[key] = {oldValue: data[key]};
                            delete data[key];
                        }
                    });
                    changed(changes);
                    resolve();
                }), callback);
            },
            getBytesInUse: function (keys, callback) {
                if (typeof keys === 'function') {
                    callback = keys;
                    keys = null;
                }
                var all = pick(keys);
                return finish(Promise.resolve(Object.keys(all).reduce(function (sum, key) {
                    return sum + size(key, all[key]);
                }, 0)), callback);
            },
        };
        if (limits) {
            Object.assign(area, limits);
        }
        return area;
    }

    var lang = params.get('lang') || 'en';
    var messages = JSON.parse(getText('_locales/' + lang + '/messages.json'));
    var english = JSON.parse(getText('_locales/en/messages.json'));

    function getMessage(key, substitutions) {
        var entry = messages[key] || english[key];
        var subs = substitutions === undefined ? [] : [].concat(substitutions);
        if (!entry) {
            return '';
        }
        return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, function (all, name) {
            var placeholder = entry.placeholders && entry.placeholders[name.toLowerCase()];
            return placeholder ? placeholder.content.replace(/\$(\d)/g, function (m, n) {
                return subs[n - 1] === undefined ? '' : subs[n - 1];
            }) : all;
        });
    }

    var SITES = [
        ['https://github.com/onikienko/TabHamster', 'GitHub - onikienko/TabHamster: Session manager and tabs saver'],
        ['https://developer.chrome.com/docs/extensions/reference/api/storage', 'chrome.storage | API | Chrome for Developers'],
        ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Some video - YouTube'],
        ['https://uk.wikipedia.org/wiki/Україна', 'Україна - Вікіпедія'],
        ['https://stackoverflow.com/questions/2153190/compress-strings', 'javascript - How to compress strings? - Stack Overflow'],
        ['https://news.ycombinator.com/', 'Hacker News'],
        ['https://example.com/?q=<b>"quotes"</b>&x=1', '<b>Tricky</b> "title" & <img src=x onerror="console.warn(\'XSS\')">'],
        ['https://docs.google.com/document/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit', 'Plan - Google Docs'],
    ];

    var tab_count = parseInt(params.get('tabs') || '8', 10);
    var delay = parseInt(params.get('delay') || '0', 10);

    function fakeTabs() {
        var tabs = [];
        for (var i = 0; i < tab_count; i++) {
            var site = SITES[i % SITES.length];
            tabs.push({
                id: i + 1,
                windowId: 1,
                pinned: i === 0,
                url: site[0] + (i >= SITES.length ? '#' + i : ''),
                title: site[1] + (i >= SITES.length ? ' (' + i + ')' : ''),
            });
        }
        return tabs;
    }

    var chrome = {
        storage: {
            sync: createArea('sync', SYNC_LIMITS),
            local: createArea('local', null),
            session: createArea('session', null),
            onChanged: event(),
        },
        runtime: {
            lastError: undefined,
            onInstalled: event(),
            onMessage: event(),
            onUpdateAvailable: event(),
            reload: function () {
                location.reload();
            },
            getURL: function (path) {
                return root + path.replace(/^\//, '');
            },
            sendMessage: function (msg) {
                var copy = JSON.parse(JSON.stringify(msg));
                return new Promise(function (resolve) {
                    var waiting = false;
                    chrome.runtime.onMessage.listeners.forEach(function (fn) {
                        if (fn(copy, {}, function (res) {
                            setTimeout(function () {
                                resolve(JSON.parse(JSON.stringify(res)));
                            }, delay);
                        }) === true) {
                            waiting = true;
                        }
                    });
                    if (!waiting) {
                        resolve(undefined);
                    }
                });
            },
        },
        tabs: {
            query: function (filter, callback) {
                return finish(Promise.resolve(fakeTabs()), callback);
            },
            create: function (props) {
                console.log('chrome.tabs.create', props);
            },
            remove: function () {},
            onUpdated: event(),
            onMoved: event(),
            onAttached: event(),
            onRemoved: event(),
            onReplaced: event(),
        },
        windows: {
            create: function (props, callback) {
                console.log('chrome.windows.create', props);
                if (callback) {
                    callback({id: 2, tabs: [{id: 100}]});
                }
            },
        },
        i18n: {getMessage: getMessage},
    };

    Object.defineProperty(window, 'chrome', {value: chrome, configurable: true, writable: true});

    // background.js loads its helpers with importScripts, relative to js/
    window.importScripts = function () {
        [].forEach.call(arguments, function (file) {
            (0, eval)(getText('js/' + file) + '\n//# sourceURL=' + root + 'js/' + file);
        });
    };

    window.fakeChrome = {
        sync_error: null,
        reset: function () {
            ['sync', 'local', 'session'].forEach(function (name) {
                localStorage.removeItem('fake_chrome_' + name);
            });
            location.reload();
        },
        // replace this document with an extension page, background.js running before its scripts
        loadPage: function (page) {
            var html = getText(page)
                .replace('<head>', '<head><base href="' + root + '">')
                .replace('<script', '<script src="js/background.js"></script>\n<script');
            document.open();
            document.write(html);
            document.close();
        },
    };
}());
