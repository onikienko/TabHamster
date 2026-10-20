// Saved groups storage.
// Sync item formats at `tg_<ms>` (decoder checks them in this order):
//   1. {name, index, tabs}           v1 shape: written by 0.3.0, or by 0.4.0 when compression doesn't help
//   2. {v: 2, name, index, h, d}     tabs JSON, deflate-raw + base64, in one item
//   3. {v: 2, name, index, h, w, n}  header; data split into `tc_<ms>_<w>_<i>` chunk items
// name/index stay plain so 0.3.0 can still list groups. 0.4.0 never writes `v` together with `tabs`.
// 0.3.0 also writes an unused `color: ''`; it is ignored on read and never written.
// An item with `v` above 2 comes from a newer TabHamster: it is left alone.
//
// Every group also has a local record in chrome.storage.local at `lg_<ms>`:
//   {g: {name, index, tabs}, h, synced, base, trashed?, trashed_by?, removing?}
//   synced: sync holds exactly this version; base: {h, name, index} of the sync version it was based on;
//   trashed: time it was deleted (hidden, purged after 30 days); trashed_by: 'here' (deleted on this computer),
//   'sync' (gone from sync: deleted on another computer), 'restore' (not in a restored backup, or the version a restore
//   replaced) or 'replace' (the version a Replace replaced), missing before 1.0.0;
//   removing: sync removal not done yet.
// Only the background service worker writes groups (one store instance, all calls queued).
var groupStore = (function () {
    'use strict';

    const GROUP_PREFIX = 'tg_';
    const CHUNK_PREFIX = 'tc_';
    // stay this far below QUOTA_BYTES_PER_ITEM, for anything itemBytes() can't see
    const ITEM_MARGIN = 64;
    // parsed from the right: w (base36) and i never contain '_', a group id might (hand-edited backups)
    const CHUNK_KEY_RE = new RegExp('^' + CHUNK_PREFIX + '(.+)_([0-9a-z]+)_([0-9]+)$');

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    function isGroupKey(key) {
        return key.startsWith(GROUP_PREFIX);
    }

    function isChunkKey(key) {
        return key.startsWith(CHUNK_PREFIX);
    }

    function chunkKey(key, w, i) {
        return CHUNK_PREFIX + key.slice(GROUP_PREFIX.length) + '_' + w + '_' + i;
    }

    // 'tc_<id>_<w>_<i>' -> {key: 'tg_<id>', w, i}
    function parseChunkKey(chunk_key) {
        const m = CHUNK_KEY_RE.exec(chunk_key);
        if (!m) {
            return null;
        }
        return {key: GROUP_PREFIX + m[1], w: m[2], i: parseInt(m[3], 10)};
    }

    function countMatches(str, re) {
        const m = str.match(re);
        return m ? m.length : 0;
    }

    // Bytes chrome.storage.sync counts for one item: key + value as written by Chromium's JSON writer.
    // It escapes '<' (1 -> 6 bytes) and U+2028/U+2029 (3 -> 6 bytes), JSON.stringify doesn't.
    function itemBytes(key, value) {
        const json = JSON.stringify(value);
        return encoder.encode(key).length +
            encoder.encode(json).length +
            5 * countMatches(json, /</g) +
            3 * countMatches(json, /[\u2028\u2029]/g);
    }

    // cyrb53: 53-bit string hash, enough to tell whether tabs changed
    function hash(str) {
        let h1 = 0xdeadbeef;
        let h2 = 0x41c6ce57;
        for (let i = 0; i < str.length; i++) {
            const ch = str.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }

    // Tabs as JSON with object keys in sorted order. chrome.storage gives objects back with their keys sorted, so a hash
    // of tabs in the order they were made would change on the way through sync.
    function tabsJson(tabs) {
        return JSON.stringify(tabs, function (k, v) {
            if (!v || typeof v !== 'object' || Array.isArray(v)) {
                return v;
            }
            const out = {};
            Object.keys(v).sort().forEach(key => out[key] = v[key]);
            return out;
        });
    }

    // what the store calls `h`: tells whether tabs changed
    function tabsHash(tabs) {
        return hash(tabsJson(tabs));
    }

    // write ID: base36 time + 4 random chars, so chunk age can be told from its key
    function writeId(now, random) {
        const rnd = Math.floor(random() * 1679616).toString(36).padStart(4, '0');
        return now.toString(36) + rnd;
    }

    function writeIdTime(w) {
        return parseInt(w.slice(0, -4), 36);
    }

    function bytesToBase64(bytes) {
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    }

    function base64ToBytes(str) {
        const bin = atob(str);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
        }
        return bytes;
    }

    // inflated tabs of one group: far more than sync can hold (100 KB compressed); a crafted backup can't make more
    const MAX_INFLATED = 16 * 1024 * 1024;

    async function pipe(bytes, transform, max = Infinity) {
        const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader();
        const parts = [];
        let length = 0;
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
            length += read.value.length;
            if (length > max) {
                await reader.cancel();
                throw new Error('Too big');
            }
            parts.push(read.value);
        }
        const out = new Uint8Array(length);
        let at = 0;
        for (const part of parts) {
            out.set(part, at);
            at += part.length;
        }
        return out;
    }

    async function deflate(str) {
        return bytesToBase64(await pipe(encoder.encode(str), new CompressionStream('deflate-raw')));
    }

    async function inflate(b64) {
        return decoder.decode(await pipe(base64ToBytes(b64), new DecompressionStream('deflate-raw'), MAX_INFLATED));
    }

    function normalizeGroup(group) {
        return {
            name: typeof group.name === 'string' ? group.name : '',
            index: Number.isFinite(group.index) ? group.index : 0,
            tabs: Array.isArray(group.tabs) ? group.tabs : [],
        };
    }

    // same name and tabs: addresses, titles, pinned (not the place, not tab ids: a backup restore renumbers them)
    function sameContent(a, b) {
        const x = normalizeGroup(a);
        const y = normalizeGroup(b);
        const tabs = g => JSON.stringify(g.tabs.map(tab => [tab && tab.url, tab && tab.title, !!(tab && tab.pinned)]));
        return x.name === y.name && tabs(x) === tabs(y);
    }

    function chunkedHeader(group, h, w, n) {
        return {v: 2, name: group.name, index: group.index, h, w, n};
    }

    /**
     * Sync items for one group.
     * @param {string} key group key, 'tg_<ms>'
     * @param {{name: string, index: number, tabs: Array}} group
     * @param {number} quota_per_item chrome.storage.sync.QUOTA_BYTES_PER_ITEM
     * @param {number} [now] current time in ms, used for the write ID of a chunked group
     * @param {function(): number} [random] random source for the write ID
     * @returns {Promise<{items: Object, h: string, w: (string|null), n: number}>}
     *   items to set() in sync; h: tabs hash; w: write ID (null when not chunked);
     *   n: number of chunk items (0 when the group fits in one item)
     * @throws {Error} quota_per_item is missing, or the key or header can't fit in one sync item
     */
    async function encodeGroup(key, group, quota_per_item, now = Date.now(), random = Math.random) {
        if (!Number.isInteger(quota_per_item)) {
            throw new Error('quota_per_item is required');
        }
        const item_max_bytes = quota_per_item - ITEM_MARGIN;
        const g = normalizeGroup(group);
        const tabs_json = tabsJson(g.tabs);
        const h = hash(tabs_json);
        const v1 = {name: g.name, index: g.index, tabs: g.tabs};
        const v1_bytes = itemBytes(key, v1);
        const d = await deflate(tabs_json);
        const single = {v: 2, name: g.name, index: g.index, h, d};
        const single_bytes = itemBytes(key, single);

        if (v1_bytes <= item_max_bytes && v1_bytes <= single_bytes) {
            return {items: {[key]: v1}, h, w: null, n: 0};
        }
        if (single_bytes <= item_max_bytes) {
            return {items: {[key]: single}, h, w: null, n: 0};
        }

        const w = writeId(now, random);
        // a chunk item is its key + 2 quotes + base64 text (nothing to escape); 9999 stands in for the longest index
        const chunk_chars = item_max_bytes - encoder.encode(chunkKey(key, w, 9999)).length - 2;
        if (chunk_chars < 1024) {
            throw new Error('Group key is too long for sync storage');
        }
        const items = {};
        let n = 0;
        for (let i = 0; i < d.length; i += chunk_chars) {
            items[chunkKey(key, w, n)] = d.slice(i, i + chunk_chars);
            n++;
        }
        const header = chunkedHeader(g, h, w, n);
        if (itemBytes(key, header) > item_max_bytes) {
            throw new Error('Group header is too big for sync storage');
        }
        items[key] = header;
        return {items, h, w, n};
    }

    async function decodeTabs(b64, h) {
        let tabs;
        try {
            const tabs_json = await inflate(b64);
            if (h !== undefined && hash(tabs_json) !== h) {
                return null;
            }
            tabs = JSON.parse(tabs_json);
        } catch (e) {
            return null;
        }
        return Array.isArray(tabs) ? tabs : null;
    }

    /**
     * Read one group from sync items (the group item plus any chunk items).
     * @param {string} key group key, 'tg_<ms>'
     * @param {Object} items sync items containing the group item and its chunks (extra items are ignored)
     * @returns {Promise<{status: string, group?: Object, h?: string, w?: string|null, n?: number}>}
     *   status: 'ok' | 'missing' | 'incomplete' (chunks not here yet) | 'newer' (format from a newer version) | 'corrupt'
     */
    async function decodeGroup(key, items) {
        const item = items[key];
        if (!item || typeof item !== 'object') {
            return {status: item === undefined ? 'missing' : 'corrupt'};
        }
        const base = normalizeGroup(item);

        if (Array.isArray(item.tabs)) {
            return {status: 'ok', group: base, h: tabsHash(item.tabs), w: null, n: 0};
        }

        if (typeof item.v === 'number' && item.v > 2) {
            return {status: 'newer'};
        }

        if (typeof item.d === 'string') {
            const tabs = await decodeTabs(item.d, item.h);
            if (!tabs) {
                return {status: 'corrupt'};
            }
            base.tabs = tabs;
            return {status: 'ok', group: base, h: item.h, w: null, n: 0};
        }

        if (typeof item.w === 'string' && Number.isInteger(item.n) && item.n > 0) {
            let d = '';
            for (let i = 0; i < item.n; i++) {
                const chunk = items[chunkKey(key, item.w, i)];
                if (typeof chunk !== 'string') {
                    return {status: 'incomplete', h: item.h, w: item.w, n: item.n};
                }
                d += chunk;
            }
            const tabs = await decodeTabs(d, item.h);
            if (!tabs) {
                return {status: 'corrupt'};
            }
            base.tabs = tabs;
            return {status: 'ok', group: base, h: item.h, w: item.w, n: item.n};
        }

        return {status: 'corrupt'};
    }

    const LOCAL_PREFIX = 'lg_';
    const MIGRATION_KEY = 'migration_v2';
    const MIGRATION_BATCH = 20;
    const DAY = 24 * 60 * 60 * 1000;
    const TRASH_KEEP_MS = 30 * DAY;
    // chunks can arrive before their header; a header can arrive before its chunks
    const CHUNK_GRACE_MS = DAY;
    const NOT_FOUND = 'Group not found';
    // sync space groups leave free for settings (theme, date format...: about 150 bytes), so changing one never fails
    // because groups filled sync to the last byte
    const OPTIONS_RESERVE = 1024;

    /**
     * @param {Object} options
     * @param {Object} options.sync chrome.storage.sync (limits are read from it)
     * @param {Object} options.local chrome.storage.local
     * @param {function(): number} [options.now]
     * @param {function(): number} [options.random]
     * @param {string} [options.conflict_suffix] added to the name of a group copy made on an edit conflict
     * @param {function(Array<string>)} [options.on_synced] called with the keys of groups that waited for sync
     *   (saved on this computer only) and are in sync now, e.g. after other groups were deleted
     */
    function createGroupStore(options) {
        const sync = options.sync;
        const local = options.local;
        const now = options.now || Date.now;
        const random = options.random || Math.random;
        const conflict_suffix = options.conflict_suffix || ' (conflict)';
        const on_synced = options.on_synced || null;

        let queue = Promise.resolve();

        function exclusive(fn) {
            const run = queue.then(fn);
            queue = run.catch(function () {});
            return run;
        }

        function waitingKeys(records) {
            return Object.keys(records).filter(key => !records[key].trashed && !records[key].synced);
        }

        // A call that can change groups: tells on_synced about groups that waited for sync before it and are
        // in sync after it. `own`: the groups the call itself saves, their result already says it.
        function change(fn, own = []) {
            return exclusive(async function () {
                const waiting = on_synced ? waitingKeys(await readRecords()).filter(key => !own.includes(key)) : [];
                const res = await fn();
                if (waiting.length) {
                    const records = await readRecords();
                    const synced = waiting.filter(key => records[key] && !records[key].trashed && records[key].synced);
                    if (synced.length) {
                        try {
                            on_synced(synced);
                        } catch (e) {
                            console.error('TabHamster: on_synced failed', e);
                        }
                    }
                }
                return res;
            });
        }

        function localKey(key) {
            return LOCAL_PREFIX + key.slice(GROUP_PREFIX.length);
        }

        // only the lg_ items: local storage also holds sessions and the restore snapshot (getKeys: Chrome 130+)
        async function readRecords() {
            const items = local.getKeys ?
                await local.get((await local.getKeys()).filter(k => k.startsWith(LOCAL_PREFIX))) :
                await local.get(null);
            const records = {};
            Object.keys(items).forEach(function (k) {
                if (k.startsWith(LOCAL_PREFIX)) {
                    records[GROUP_PREFIX + k.slice(LOCAL_PREFIX.length)] = items[k];
                }
            });
            return records;
        }

        async function putRecord(records, key, rec) {
            records[key] = rec;
            await local.set({[localKey(key)]: rec});
        }

        async function dropRecord(records, key) {
            delete records[key];
            await local.remove(localKey(key));
        }

        function sigOf(group, h) {
            return {h, name: group.name, index: group.index};
        }

        function sameSig(a, b) {
            return !!a && !!b && a.h === b.h && a.name === b.name && a.index === b.index;
        }

        // sync's copy is broken: this one is no longer "synced" until it is pushed again
        async function markUnsynced(records, key, rec) {
            rec.synced = false;
            await putRecord(records, key, rec);
        }

        function recordFromRemote(remote) {
            return {g: remote.group, h: remote.h, synced: true, base: sigOf(remote.group, remote.h)};
        }

        function isStale(w) {
            return now() - writeIdTime(w) > CHUNK_GRACE_MS;
        }

        function chunkKeysOf(key, sync_items) {
            return Object.keys(sync_items).filter(function (k) {
                const parsed = isChunkKey(k) && parseChunkKey(k);
                return parsed && parsed.key === key;
            });
        }

        function bytesOf(items, keys) {
            return keys.reduce(function (sum, k) {
                return items[k] === undefined ? sum : sum + itemBytes(k, items[k]);
            }, 0);
        }

        // a group key nothing uses, from the time `from` (ms) on
        function freeKey(records, sync_items, from = now()) {
            let t = from;
            while (records[GROUP_PREFIX + t] || sync_items[GROUP_PREFIX + t]) {
                t++;
            }
            return GROUP_PREFIX + t;
        }

        function nextIndex(records) {
            return Object.keys(records).reduce(function (max, k) {
                return records[k].trashed ? max : Math.max(max, records[k].g.index);
            }, 0) + 1;
        }

        // a group's tabs changed here and on another device: this version is kept as a copy at the top
        function conflictCopy(records, group) {
            // an unnamed group stays unnamed: the list shows the copy's own date
            return {name: group.name ? group.name + conflict_suffix : '', index: nextIndex(records), tabs: group.tabs};
        }

        // Sync writes for one group: new chunks, then the group item, then old chunks go.
        // Always a complete new version: reusing chunks for a rename could point a header at chunks
        // another device has just removed.
        async function planPush(key, group, sync_items) {
            const enc = await encodeGroup(key, group, sync.QUOTA_BYTES_PER_ITEM, now(), random);
            const plan = {key, chunks: {}, main: {}, old_chunks: []};
            const current = sync_items[key];
            const current_w = current && typeof current.w === 'string' ? current.w : null;

            Object.keys(enc.items).forEach(function (k) {
                if (k === key) {
                    plan.main[k] = enc.items[k];
                } else {
                    plan.chunks[k] = enc.items[k];
                }
            });
            if (current_w) {
                plan.old_chunks = chunkKeysOf(key, sync_items).filter(function (k) {
                    return parseChunkKey(k).w === current_w;
                });
            }
            return plan;
        }

        // At most 3 write operations for any number of groups. Throws Chrome's quota messages.
        async function writePlans(plans, sync_items) {
            const chunks = Object.assign({}, ...plans.map(p => p.chunks));
            const main = Object.assign({}, ...plans.map(p => p.main));
            const old = [].concat(...plans.map(p => p.old_chunks));
            const new_keys = Object.keys(chunks).concat(Object.keys(main));

            const in_use = await sync.getBytesInUse(null);
            const added = bytesOf(chunks, Object.keys(chunks)) + bytesOf(main, Object.keys(main));
            const replaced = bytesOf(sync_items, new_keys);
            const old_bytes = bytesOf(sync_items, old);
            const final_bytes = in_use + added - replaced - old_bytes;
            // same messages as Chrome's own errors (Chrome 155)
            // into the settings' reserve only by a write that doesn't grow what is there (sync filled before 1.0.0)
            if (final_bytes > sync.QUOTA_BYTES ||
                (final_bytes > sync.QUOTA_BYTES - OPTIONS_RESERVE && final_bytes > in_use)) {
                throw new Error('Resource::kQuotaBytes quota exceeded');
            }
            const final_count = Object.keys(sync_items).length - old.length +
                new_keys.filter(k => sync_items[k] === undefined).length;
            if (final_count > sync.MAX_ITEMS) {
                throw new Error('Resource::kMaxItems quota exceeded');
            }

            if (final_bytes + old_bytes <= sync.QUOTA_BYTES) {
                if (Object.keys(chunks).length) {
                    await sync.set(chunks);
                }
                await sync.set(main);
                if (old.length) {
                    await sync.remove(old);
                }
            } else {
                // no room for old and new chunks at once: drop the old ones first. The group item stays,
                // so other devices see it as incomplete and keep their local copy meanwhile.
                await sync.remove(old);
                if (Object.keys(chunks).length) {
                    await sync.set(chunks);
                }
                await sync.set(main);
            }
        }

        // Push local records to sync; marks them synced. Returns {key: error message} for failures.
        async function pushKeys(keys, records, sync_items) {
            const errors = {};
            let plans = [];
            for (const key of keys) {
                try {
                    plans.push(await planPush(key, records[key].g, sync_items));
                } catch (e) {
                    errors[key] = e.message;
                }
            }
            if (!plans.length) {
                return errors;
            }
            try {
                await writePlans(plans, sync_items);
            } catch (e) {
                if (plans.length === 1) {
                    errors[plans[0].key] = e.message;
                    return errors;
                }
                // one group may be the problem: try them one by one
                const written = [];
                for (const plan of plans) {
                    try {
                        await writePlans([plan], await sync.get(null));
                        written.push(plan);
                    } catch (e2) {
                        errors[plan.key] = e2.message;
                    }
                }
                plans = written;
            }
            for (const plan of plans) {
                const rec = records[plan.key];
                rec.synced = true;
                rec.base = sigOf(rec.g, rec.h);
                await putRecord(records, plan.key, rec);
            }
            return errors;
        }

        async function removeFromSync(keys, sync_items) {
            const all = [];
            keys.forEach(function (key) {
                all.push(key, ...chunkKeysOf(key, sync_items));
            });
            await sync.remove(all);
        }

        // Decide what one group needs. Writes local records only; sync work goes to todo.
        async function reconcileKey(key, records, remote, sync_items, todo) {
            const rec = records[key];

            if (!rec) {
                if (remote.status === 'ok') {
                    await putRecord(records, key, recordFromRemote(remote));
                }
                return;
            }

            if (rec.trashed) {
                if (rec.removing) {
                    if (remote.status === 'missing' && rec.discarded) {
                        await dropRecord(records, key);
                    } else if (remote.status === 'missing') {
                        delete rec.removing;
                        await putRecord(records, key, rec);
                    } else {
                        todo.remove.add(key);
                    }
                } else if (remote.status === 'ok') {
                    // saved again on another device
                    await putRecord(records, key, recordFromRemote(remote));
                } else if (remote.status === 'missing' && now() - rec.trashed > TRASH_KEEP_MS) {
                    await dropRecord(records, key);
                }
                return;
            }

            if (rec.synced) {
                switch (remote.status) {
                    case 'ok':
                        if (!sameSig(rec.base, sigOf(remote.group, remote.h))) {
                            await putRecord(records, key, recordFromRemote(remote));
                        }
                        return;
                    case 'missing':
                        // deleted on another device (or sync data was reset): hide, keep for a while
                        rec.trashed = now();
                        rec.trashed_by = 'sync';
                        await putRecord(records, key, rec);
                        return;
                    case 'incomplete':
                        // same content as ours, so nothing newer is on its way: its chunks are gone. Repair now.
                        if (remote.h === rec.h || isStale(remote.w)) {
                            await markUnsynced(records, key, rec);
                            todo.push.add(key);
                        }
                        return;
                    case 'corrupt':
                        await markUnsynced(records, key, rec);
                        todo.push.add(key);
                        return;
                }
                return;
            }

            // local changes that are not in sync yet
            switch (remote.status) {
                case 'missing':
                case 'corrupt':
                    todo.push.add(key);
                    return;
                case 'incomplete':
                    // wait only while another device's newer version may still be on its way
                    if (remote.h === rec.h || (rec.base && remote.h === rec.base.h) || isStale(remote.w)) {
                        todo.push.add(key);
                    }
                    return;
                case 'newer':
                    return;
            }

            // three-way merge against the sync version this edit started from
            const remote_sig = sigOf(remote.group, remote.h);
            const base = rec.base;
            if (sameSig(remote_sig, sigOf(rec.g, rec.h))) {
                await putRecord(records, key, recordFromRemote(remote));
                return;
            }
            let tabs;
            let h;
            if (base && remote.h === base.h) {
                tabs = rec.g.tabs;
                h = rec.h;
            } else if (base && rec.h === base.h) {
                tabs = remote.group.tabs;
                h = remote.h;
            } else if (rec.h === remote.h) {
                tabs = rec.g.tabs;
                h = rec.h;
            } else {
                // tabs changed here and on another device: keep both
                const copy_key = freeKey(records, sync_items);
                const copy = {
                    g: conflictCopy(records, rec.g),
                    h: rec.h,
                    synced: false,
                    base: null,
                };
                await putRecord(records, copy_key, copy);
                await putRecord(records, key, recordFromRemote(remote));
                todo.push.add(copy_key);
                todo.copies[key] = copy_key;
                return;
            }
            const name = base && rec.g.name === base.name ? remote.group.name : rec.g.name;
            const index = base && rec.g.index === base.index ? remote.group.index : rec.g.index;
            const merged = {g: {name, index, tabs}, h, synced: false, base: remote_sig};
            if (sameSig(remote_sig, sigOf(merged.g, h))) {
                await putRecord(records, key, recordFromRemote(remote));
                return;
            }
            await putRecord(records, key, merged);
            todo.push.add(key);
        }

        // Bring the given groups (all when keys is omitted) in line with sync, then push what's left.
        // Returns {errors: {key: message}, copies: {key: key of the copy made on a conflict}}
        async function syncKeys(records, keys) {
            const sync_items = await sync.get(null);
            const todo = {push: new Set(), remove: new Set(), copies: {}};
            const all_keys = keys || Array.from(new Set(
                Object.keys(records).concat(Object.keys(sync_items).filter(isGroupKey))));
            for (const key of all_keys) {
                await reconcileKey(key, records, await decodeGroup(key, sync_items), sync_items, todo);
            }
            const errors = await pushKeys(Array.from(todo.push), records, sync_items);
            if (todo.remove.size) {
                try {
                    await removeFromSync(Array.from(todo.remove), sync_items);
                    for (const key of todo.remove) {
                        if (records[key].discarded) {
                            await dropRecord(records, key);
                        } else {
                            delete records[key].removing;
                            await putRecord(records, key, records[key]);
                        }
                    }
                } catch (e) {
                    todo.remove.forEach(function (key) {
                        errors[key] = e.message;
                    });
                }
            }
            return {errors, copies: todo.copies};
        }

        // Remove chunk items that no header uses (crashed writes, groups 0.3.0 overwrote).
        async function collectGarbage() {
            const sync_items = await sync.get(null);
            const garbage = Object.keys(sync_items).filter(function (k) {
                if (!isChunkKey(k)) {
                    return false;
                }
                const chunk = parseChunkKey(k);
                if (!chunk) {
                    return true;
                }
                const head = sync_items[chunk.key];
                const head_w = head && typeof head === 'object' && typeof head.w === 'string' ? head.w : null;
                if (head_w === chunk.w) {
                    const in_use = !Array.isArray(head.tabs) && typeof head.d !== 'string' &&
                        Number.isInteger(head.n) && chunk.i < head.n;
                    return !in_use;
                }
                // may belong to a header that hasn't arrived yet
                return isStale(chunk.w);
            });
            if (garbage.length) {
                await sync.remove(garbage);
            }
        }

        function result(records, key, done) {
            const rec = records[key];
            const res = {synced: !!rec && rec.synced};
            if (done.errors[key]) {
                res.error = done.errors[key];
            }
            if (done.copies[key]) {
                // edited on another device too: sync's version stays at key, this one was saved as a copy
                res.copy = done.copies[key];
            }
            return res;
        }

        async function saveNow(groups) {
            const records = await readRecords();
            const keys = Object.keys(groups);
            for (const key of keys) {
                const g = normalizeGroup(groups[key]);
                const old = records[key];
                await putRecord(records, key, {
                    g,
                    h: tabsHash(g.tabs),
                    synced: false,
                    base: old ? old.base : null,
                });
            }
            let done = {errors: {}, copies: {}};
            try {
                done = await syncKeys(records, keys);
            } catch (e) {
                keys.forEach(function (key) {
                    done.errors[key] = e.message;
                });
            }
            const out = {};
            keys.forEach(function (key) {
                out[key] = result(records, key, done);
            });
            return out;
        }

        // Changes made to groups as they are now, not as the caller last saw them, so a change that came from another
        // device meanwhile stays. edits: {key: function(group) -> changed group}. A deleted group comes back,
        // unless skip_trashed. Answers like saveNow; a group that isn't there: {synced: false, error: NOT_FOUND}.
        async function editNow(edits, skip_trashed) {
            const records = await readRecords();
            const groups = {};
            const out = {};
            Object.keys(edits).forEach(function (key) {
                const rec = records[key];
                if (!rec || rec.discarded || (skip_trashed && rec.trashed)) {
                    out[key] = {synced: false, error: NOT_FOUND};
                } else {
                    groups[key] = edits[key](rec.g);
                }
            });
            return Object.assign(out, Object.keys(groups).length ? await saveNow(groups) : {});
        }

        // A version of a group that is about to be replaced, kept in trash under a key of its own next to the original's
        // time, so an unnamed group shows about the same date (only on this computer, never in sync).
        // taken: more keys it must not use. Returns the key.
        async function keepInTrash(records, sync_items, key, trashed_by, taken = {}) {
            const time = parseInt(key.slice(GROUP_PREFIX.length), 10);
            const copy_key = freeKey(Object.assign({}, taken, records), sync_items, Number.isFinite(time) ? time + 1 : now());
            const rec = records[key];
            await putRecord(records, copy_key, {g: rec.g, h: rec.h, synced: false, base: null, trashed: now(), trashed_by});
            return copy_key;
        }

        // New tabs for a group; its name and place stay as they are now. seen_h: hash of the tabs the caller started
        // from. If the group's tabs have changed since (on another device), the caller's version is saved as a copy.
        // The answer has `h`, the hash of the group's tabs now (pass it to the next setTabs, e.g. an undo).
        // keep_old: the version replaced goes to trash ('replace'); the answer's `kept` is its key.
        async function setTabsNow(key, tabs, seen_h, keep_old) {
            const records = await readRecords();
            const rec = records[key];
            if (!rec || rec.discarded) {
                return {synced: false, error: NOT_FOUND};
            }
            const g = normalizeGroup({name: rec.g.name, index: rec.g.index, tabs});
            if (seen_h !== undefined && seen_h !== rec.h && tabsHash(g.tabs) !== rec.h) {
                const copy_key = freeKey(records, await sync.get(null));
                const res = (await saveNow({[copy_key]: conflictCopy(records, g)}))[copy_key];
                return Object.assign(res, {copy: copy_key, h: rec.h});
            }
            let kept = null;
            if (keep_old && !rec.trashed && !sameContent(rec.g, g)) {
                kept = await keepInTrash(records, await sync.get(null), key, 'replace');
            }
            // a copy can still be made here: sync may have a newer version this computer hasn't seen yet
            const res = (await saveNow({[key]: g}))[key];
            const now_rec = (await local.get(localKey(key)))[localKey(key)];
            return Object.assign(res, {h: now_rec.h}, kept ? {kept} : {});
        }

        async function removeNow(key) {
            const records = await readRecords();
            const rec = records[key];
            if (rec) {
                rec.trashed = now();
                rec.trashed_by = 'here';
                rec.removing = true;
                await putRecord(records, key, rec);
            }
            try {
                await removeFromSync([key], await sync.get(null));
            } catch (e) {
                return {synced: false, error: e.message};
            }
            if (rec) {
                delete rec.removing;
                await putRecord(records, key, rec);
            }
            return {synced: true};
        }

        // Undo of a save that created the group: gone everywhere and not kept in trash. If sync can't be
        // changed now, the record waits (hidden) until a reconcile removes it from sync, then it is dropped.
        // saved: the group as that save wrote it; changed since (renamed, moved, edited on another device), it goes
        // to trash instead, like remove.
        async function discardNow(key, saved) {
            const records = await readRecords();
            const rec = records[key];
            if (!rec) {
                return {synced: true};
            }
            if (saved) {
                const g = normalizeGroup(saved);
                if (!sameSig(sigOf(rec.g, rec.h), sigOf(g, tabsHash(g.tabs)))) {
                    return removeNow(key);
                }
            }
            rec.trashed = now();
            rec.removing = true;
            rec.discarded = true;
            await putRecord(records, key, rec);
            try {
                await removeFromSync([key], await sync.get(null));
            } catch (e) {
                return {synced: false, error: e.message};
            }
            await dropRecord(records, key);
            return {synced: true};
        }

        // Restore from a backup: the given groups replace all current ones. Writes before it deletes, so an
        // interruption leaves old and new groups, never neither. Replaced groups go to trash; so does the current
        // version of a group the backup changes, under a key of its own (only on this computer, never in sync).
        async function replaceAllNow(groups) {
            const records = await readRecords();
            const changed = Object.keys(groups).filter(function (key) {
                return records[key] && !records[key].trashed && !sameContent(records[key].g, groups[key]);
            });
            if (changed.length) {
                const sync_items = await sync.get(null);
                for (const key of changed) {
                    // not at a key the backup brings
                    await keepInTrash(records, sync_items, key, 'restore', groups);
                }
            }
            await saveNow(groups);
            const after = await readRecords();
            const others = Object.keys(after).filter(function (key) {
                return !after[key].trashed && !groups.hasOwnProperty(key);
            });
            for (const key of others) {
                after[key].trashed = now();
                after[key].trashed_by = 'restore';
                after[key].removing = true;
                await putRecord(after, key, after[key]);
            }
            if (others.length) {
                try {
                    await removeFromSync(others, await sync.get(null));
                    for (const key of others) {
                        delete after[key].removing;
                        await putRecord(after, key, after[key]);
                    }
                } catch (e) {
                    // removal is retried by the next reconcile
                }
            }
            // backup groups that didn't fit in sync next to the old ones can go there now
            const done = await syncKeys(await readRecords());
            return {saved: Object.keys(groups).length, removed: others.length + changed.length, errors: done.errors};
        }

        async function restoreNow(key) {
            const records = await readRecords();
            const rec = records[key];
            if (!rec) {
                return {synced: false, error: NOT_FOUND};
            }
            delete rec.trashed;
            delete rec.trashed_by;
            delete rec.removing;
            delete rec.discarded;
            rec.synced = false;
            await putRecord(records, key, rec);
            let done;
            try {
                done = await syncKeys(records, [key]);
            } catch (e) {
                done = {errors: {[key]: e.message}, copies: {}};
            }
            return result(records, key, done);
        }

        async function reconcileNow() {
            const done = await syncKeys(await readRecords());
            await collectGarbage();
            return done;
        }

        // 0.3.0 -> 0.4.0: local copy of everything first, then convert v1 items in place
        // where the new item is smaller, so sync usage only goes down.
        async function migrateNow() {
            const flag = await local.get(MIGRATION_KEY);
            if (flag[MIGRATION_KEY] === 'done') {
                return {converted: 0};
            }
            await syncKeys(await readRecords());

            const all = await sync.get(null);
            const v1_keys = Object.keys(all).filter(function (k) {
                return isGroupKey(k) && all[k] && Array.isArray(all[k].tabs);
            });
            let converted = 0;
            for (let i = 0; i < v1_keys.length; i += MIGRATION_BATCH) {
                const batch = v1_keys.slice(i, i + MIGRATION_BATCH);
                // re-read: another device may have changed them meanwhile
                const current = await sync.get(batch);
                const items = {};
                for (const key of batch) {
                    const item = current[key];
                    if (!item || !Array.isArray(item.tabs)) {
                        continue;
                    }
                    let enc;
                    try {
                        enc = await encodeGroup(key, item, sync.QUOTA_BYTES_PER_ITEM, now(), random);
                    } catch (e) {
                        continue;
                    }
                    if (enc.n === 0 && !Array.isArray(enc.items[key].tabs) &&
                        itemBytes(key, enc.items[key]) < itemBytes(key, item)) {
                        items[key] = enc.items[key];
                    }
                }
                const keys = Object.keys(items);
                if (!keys.length) {
                    continue;
                }
                try {
                    await sync.set(items);
                    converted += keys.length;
                } catch (e) {
                    // a group that fails stays v1 and converts on its next save
                    for (const key of keys) {
                        try {
                            await sync.set({[key]: items[key]});
                            converted++;
                        } catch (e2) {
                            // keep going
                        }
                    }
                }
            }
            await local.set({[MIGRATION_KEY]: 'done'});
            return {converted};
        }

        async function listNow() {
            const records = await readRecords();
            const out = {};
            Object.keys(records).forEach(function (key) {
                const rec = records[key];
                if (!rec.trashed) {
                    out[key] = {name: rec.g.name, index: rec.g.index, tabs: rec.g.tabs, h: rec.h, synced: rec.synced};
                }
            });
            return out;
        }

        async function listTrashNow() {
            const records = await readRecords();
            return Object.keys(records).filter(function (key) {
                return records[key].trashed && !records[key].discarded;
            }).map(function (key) {
                const rec = records[key];
                return {key, name: rec.g.name, index: rec.g.index, tabs: rec.g.tabs, trashed: rec.trashed,
                    by: rec.trashed_by || null};
            }).sort(function (a, b) {
                return b.trashed - a.trashed;
            });
        }

        async function usageNow() {
            const records = await readRecords();
            return {bytes: await sync.getBytesInUse(null), quota: sync.QUOTA_BYTES, unsynced: waitingKeys(records).length};
        }

        // Space each group takes in sync: its item and chunks, so what deleting it frees. A group that is not
        // in sync gets the space it needs to get there (bytes null if it can't fit in sync at all).
        async function sizesNow() {
            const records = await readRecords();
            const sync_items = await sync.get(null);
            const out = {};
            for (const key of Object.keys(records)) {
                const rec = records[key];
                if (rec.trashed) {
                    continue;
                }
                if (rec.synced) {
                    out[key] = {bytes: bytesOf(sync_items, [key].concat(chunkKeysOf(key, sync_items))), synced: true};
                    continue;
                }
                let bytes = null;
                try {
                    const enc = await encodeGroup(key, rec.g, sync.QUOTA_BYTES_PER_ITEM, now(), random);
                    bytes = bytesOf(enc.items, Object.keys(enc.items));
                } catch (e) {
                    // too big for one sync item: stays on this computer
                }
                out[key] = {bytes, synced: false};
            }
            return out;
        }

        return {
            /**
             * @returns {Promise<Object>} {key: {name, index, tabs, h, synced}} for groups that aren't deleted;
             *   h: hash of the tabs, for setTabs
             */
            list: () => exclusive(listNow),
            /**
             * @returns {Promise<Array>} deleted groups kept for 30 days, newest first:
             *   {key, name, index, tabs, trashed, by: 'here' | 'sync' | 'restore' | 'replace' | null (not known)}
             */
            listTrash: () => exclusive(listTrashNow),
            /**
             * @returns {Promise<{synced: boolean, error?: string, copy?: string}>} saved locally even when sync
             *   fails; `copy` is set when the group was edited on another device too and this version became a copy
             */
            save: (key, group) => change(() => saveNow({[key]: group}), [key]).then(res => res[key]),
            /** @returns {Promise<Object>} {key: {synced, error?}}; one sync write for small groups */
            saveMany: (groups) => change(() => saveNow(groups), Object.keys(groups)),
            /**
             * @returns {Promise<{synced: boolean, error?: string, copy?: string, kept?: string, h: string}>} new tabs,
             *   the name and place stay; `copy` is set when the tabs changed after seen_h and this version became a copy;
             *   keep_old: the replaced version goes to trash, `kept` is its key
             */
            setTabs: (key, tabs, seen_h, keep_old) => change(() => setTabsNow(key, tabs, seen_h, keep_old), [key]),
            /** @returns {Promise<{synced: boolean, error?: string}>} new name, tabs and place stay */
            rename: (key, name) => change(() => editNow({[key]: g => ({name, index: g.index, tabs: g.tabs})}), [key])
                .then(res => res[key]),
            /**
             * @param {Object} indexes {key: index}
             * @returns {Promise<Object>} {key: {synced, error?}}; only the place changes (reorder), one sync write for
             *   small groups; deleted groups are left alone
             */
            setIndex: (indexes) => change(() => editNow(Object.fromEntries(Object.keys(indexes).map(key =>
                [key, g => ({name: g.name, index: indexes[key], tabs: g.tabs})])), true), Object.keys(indexes)),
            /** @returns {Promise<{synced: boolean, error?: string}>} the group goes to trash */
            remove: (key) => change(() => removeNow(key)),
            /**
             * @param {string} key
             * @param {Object} [saved] the group as the save wrote it: if it changed since, it goes to trash (remove)
             * @returns {Promise<{synced: boolean, error?: string}>} like remove, but not kept in trash (undo of a new save)
             */
            discard: (key, saved) => change(() => discardNow(key, saved)),
            /** @returns {Promise<{synced: boolean, error?: string}>} brings a group back from trash */
            restore: (key) => change(() => restoreNow(key), [key]),
            /**
             * @returns {Promise<{saved: number, removed: number, errors: Object}>} groups not given go to trash, and
             *   the current versions of groups given with another name or tabs (removed counts both)
             */
            replaceAll: (groups) => change(() => replaceAllNow(groups), Object.keys(groups)),
            /** @returns {Promise<{errors: Object, copies: Object}>} */
            reconcile: () => change(reconcileNow),
            /** @returns {Promise<{converted: number}>} */
            migrate: () => change(migrateNow),
            /** @returns {Promise<{bytes: number, quota: number, unsynced: number}>} */
            usage: () => exclusive(usageNow),
            /**
             * @returns {Promise<Object>} {key: {bytes, synced}} for groups that aren't deleted: bytes the group takes
             *   in sync, or (not synced) the bytes it needs there, null if it can't fit
             */
            sizes: () => exclusive(sizesNow),
        };
    }

    return {
        GROUP_PREFIX,
        CHUNK_PREFIX,
        isGroupKey,
        isChunkKey,
        chunkKey,
        parseChunkKey,
        itemBytes,
        hash,
        tabsHash,
        writeId,
        writeIdTime,
        normalizeGroup,
        sameContent,
        chunkedHeader,
        encodeGroup,
        decodeGroup,
        createGroupStore,
    };
}());

if (typeof module !== 'undefined' && module.exports) {
    module.exports = groupStore;
}
