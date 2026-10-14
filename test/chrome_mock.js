// In-memory chrome.storage areas for tests, and a sync "server" shared by several devices.
const {SYNC_LIMITS, chromeItemSize} = require('./chrome_size.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Clock function with advance(ms), for code that takes `now`.
function makeClock(start = Date.UTC(2026, 9, 14)) {
    let t = start;
    const clock = function () {
        return t;
    };
    clock.advance = function (ms) {
        t += ms;
    };
    return clock;
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

/**
 * chrome.storage area with the promise API (get, set, remove, getBytesInUse).
 * With `limits` (SYNC_LIMITS) it enforces sync quotas with Chrome's error messages.
 * Test hooks: `log` of write calls, `beforeWrite(op, keys)` that can throw to fail a write,
 * `onWrite(changes)` called after a successful write, raw*() to change data without any of that.
 */
function createStorageArea({limits = null, clock = Date.now} = {}) {
    let data = new Map();
    const write_times = [];

    function total(map) {
        let sum = 0;
        map.forEach(function (value, key) {
            sum += chromeItemSize(key, value);
        });
        return sum;
    }

    function checkRate() {
        const t = clock();
        if (write_times.filter(w => w > t - MINUTE).length >= limits.MAX_WRITE_OPERATIONS_PER_MINUTE) {
            throw new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.');
        }
        if (write_times.filter(w => w > t - HOUR).length >= limits.MAX_WRITE_OPERATIONS_PER_HOUR) {
            throw new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.');
        }
        write_times.push(t);
    }

    function startWrite(op, keys) {
        if (area.beforeWrite) {
            area.beforeWrite(op, keys);
        }
        if (limits) {
            checkRate();
        }
    }

    const area = {
        log: [],
        beforeWrite: null,
        onWrite: null,

        async get(keys) {
            const out = {};
            if (keys === null || keys === undefined) {
                data.forEach(function (value, key) {
                    out[key] = clone(value);
                });
                return out;
            }
            const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
            const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
            list.forEach(function (key) {
                if (data.has(key)) {
                    out[key] = clone(data.get(key));
                } else if (defaults[key] !== undefined) {
                    out[key] = clone(defaults[key]);
                }
            });
            return out;
        },

        async set(items) {
            const keys = Object.keys(items);
            startWrite('set', keys);
            const next = new Map(data);
            keys.forEach(function (key) {
                next.set(key, clone(items[key]));
            });
            if (limits) {
                keys.forEach(function (key) {
                    if (chromeItemSize(key, items[key]) > limits.QUOTA_BYTES_PER_ITEM) {
                        throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
                    }
                });
                if (total(next) > limits.QUOTA_BYTES) {
                    throw new Error('QUOTA_BYTES quota exceeded');
                }
                if (next.size > limits.MAX_ITEMS) {
                    throw new Error('MAX_ITEMS quota exceeded');
                }
            }
            data = next;
            area.log.push({op: 'set', keys});
            if (area.onWrite) {
                const changes = {};
                keys.forEach(key => changes[key] = clone(items[key]));
                area.onWrite(changes);
            }
        },

        async remove(keys) {
            const list = typeof keys === 'string' ? [keys] : keys;
            startWrite('remove', list);
            list.forEach(key => data.delete(key));
            area.log.push({op: 'remove', keys: list});
            if (area.onWrite) {
                const changes = {};
                list.forEach(key => changes[key] = undefined);
                area.onWrite(changes);
            }
        },

        async getBytesInUse(keys) {
            if (keys === null || keys === undefined) {
                return total(data);
            }
            const list = typeof keys === 'string' ? [keys] : keys;
            return list.reduce((sum, key) => data.has(key) ? sum + chromeItemSize(key, data.get(key)) : sum, 0);
        },

        rawSet(items) {
            Object.keys(items).forEach(key => data.set(key, clone(items[key])));
        },

        rawRemove(keys) {
            keys.forEach(key => data.delete(key));
        },

        dump() {
            const out = {};
            data.forEach((value, key) => out[key] = clone(value));
            return out;
        },
    };
    if (limits) {
        Object.assign(area, limits);
    }
    return area;
}

function createSyncArea(clock) {
    return createStorageArea({limits: SYNC_LIMITS, clock});
}

/**
 * Several devices with their own sync area, and a server in between.
 * upload(device) sends the device's pending writes; download(device, filter) brings server state
 * (only keys that pass filter, so tests can deliver a header before its chunks or the other way round).
 * Last upload wins per key, like Chrome sync.
 */
function createSyncNetwork(clock) {
    const server = new Map();
    const devices = [];

    function addDevice() {
        const area = createSyncArea(clock);
        const outbox = new Map();
        area.onWrite = function (changes) {
            Object.keys(changes).forEach(key => outbox.set(key, changes[key]));
        };
        const device = {area, outbox};
        devices.push(device);
        return device;
    }

    function upload(device) {
        device.outbox.forEach(function (value, key) {
            if (value === undefined) {
                server.delete(key);
            } else {
                server.set(key, clone(value));
            }
        });
        device.outbox.clear();
    }

    function download(device, filter = () => true) {
        const mine = device.area.dump();
        const keys = new Set(Object.keys(mine).concat(Array.from(server.keys())));
        keys.forEach(function (key) {
            if (device.outbox.has(key) || !filter(key)) {
                return;
            }
            if (!server.has(key)) {
                device.area.rawRemove([key]);
            } else if (JSON.stringify(server.get(key)) !== JSON.stringify(mine[key])) {
                device.area.rawSet({[key]: server.get(key)});
            }
        });
    }

    function syncAll() {
        devices.forEach(upload);
        devices.forEach(device => download(device));
    }

    return {addDevice, upload, download, syncAll, server};
}

module.exports = {makeClock, createStorageArea, createSyncArea, createSyncNetwork, MINUTE, HOUR};
