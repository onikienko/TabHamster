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
//   {g: {name, index, tabs}, h, synced, base, trashed?, removing?}
//   synced: sync holds exactly this version; base: {h, name, index} of the sync version it was based on;
//   trashed: time it was deleted (hidden, purged after 30 days); removing: sync removal not done yet.
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

    async function pipe(bytes, transform) {
        const stream = new Blob([bytes]).stream().pipeThrough(transform);
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function deflate(str) {
        return bytesToBase64(await pipe(encoder.encode(str), new CompressionStream('deflate-raw')));
    }

    async function inflate(b64) {
        return decoder.decode(await pipe(base64ToBytes(b64), new DecompressionStream('deflate-raw')));
    }

    function normalizeGroup(group) {
        return {
            name: typeof group.name === 'string' ? group.name : '',
            index: Number.isFinite(group.index) ? group.index : 0,
            tabs: Array.isArray(group.tabs) ? group.tabs : [],
        };
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
        const tabs_json = JSON.stringify(g.tabs);
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
            return {status: 'ok', group: base, h: hash(JSON.stringify(item.tabs)), w: null, n: 0};
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

    /**
     * @param {Object} options
     * @param {Object} options.sync chrome.storage.sync (limits are read from it)
     * @param {Object} options.local chrome.storage.local
     * @param {function(): number} [options.now]
     * @param {function(): number} [options.random]
     * @param {string} [options.conflict_suffix] added to the name of a group copy made on an edit conflict
     */
    function createGroupStore(options) {
        const sync = options.sync;
        const local = options.local;
        const now = options.now || Date.now;
        const random = options.random || Math.random;
        const conflict_suffix = options.conflict_suffix || ' (conflict)';

        let queue = Promise.resolve();

        function exclusive(fn) {
            const run = queue.then(fn);
            queue = run.catch(function () {});
            return run;
        }

        function localKey(key) {
            return LOCAL_PREFIX + key.slice(GROUP_PREFIX.length);
        }

        async function readRecords() {
            const items = await local.get(null);
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

        function freeKey(records, sync_items) {
            let t = now();
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
            if (final_bytes > sync.QUOTA_BYTES) {
                throw new Error('QUOTA_BYTES quota exceeded');
            }
            const final_count = Object.keys(sync_items).length - old.length +
                new_keys.filter(k => sync_items[k] === undefined).length;
            if (final_count > sync.MAX_ITEMS) {
                throw new Error('MAX_ITEMS quota exceeded');
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
                    if (remote.status === 'missing') {
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
                    g: {name: rec.g.name + conflict_suffix, index: nextIndex(records), tabs: rec.g.tabs},
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
                        delete records[key].removing;
                        await putRecord(records, key, records[key]);
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
                    h: hash(JSON.stringify(g.tabs)),
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

        async function removeNow(key) {
            const records = await readRecords();
            const rec = records[key];
            if (rec) {
                rec.trashed = now();
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

        async function restoreNow(key) {
            const records = await readRecords();
            const rec = records[key];
            if (!rec) {
                return {synced: false, error: 'Group not found'};
            }
            delete rec.trashed;
            delete rec.removing;
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
                    out[key] = {name: rec.g.name, index: rec.g.index, tabs: rec.g.tabs, synced: rec.synced};
                }
            });
            return out;
        }

        async function listTrashNow() {
            const records = await readRecords();
            return Object.keys(records).filter(function (key) {
                return records[key].trashed;
            }).map(function (key) {
                const rec = records[key];
                return {key, name: rec.g.name, index: rec.g.index, tabs: rec.g.tabs, trashed: rec.trashed};
            }).sort(function (a, b) {
                return b.trashed - a.trashed;
            });
        }

        async function usageNow() {
            const records = await readRecords();
            const unsynced = Object.keys(records).filter(function (key) {
                return !records[key].trashed && !records[key].synced;
            }).length;
            return {bytes: await sync.getBytesInUse(null), quota: sync.QUOTA_BYTES, unsynced};
        }

        return {
            /** @returns {Promise<Object>} {key: {name, index, tabs, synced}} for groups that aren't deleted */
            list: () => exclusive(listNow),
            /** @returns {Promise<Array>} deleted groups kept for 30 days, newest first */
            listTrash: () => exclusive(listTrashNow),
            /**
             * @returns {Promise<{synced: boolean, error?: string, copy?: string}>} saved locally even when sync
             *   fails; `copy` is set when the group was edited on another device too and this version became a copy
             */
            save: (key, group) => exclusive(() => saveNow({[key]: group})).then(res => res[key]),
            /** @returns {Promise<Object>} {key: {synced, error?}}; one sync write for small groups (reorder) */
            saveMany: (groups) => exclusive(() => saveNow(groups)),
            /** @returns {Promise<{synced: boolean, error?: string}>} the group goes to trash */
            remove: (key) => exclusive(() => removeNow(key)),
            /** @returns {Promise<{synced: boolean, error?: string}>} brings a group back from trash */
            restore: (key) => exclusive(() => restoreNow(key)),
            /** @returns {Promise<{errors: Object, copies: Object}>} */
            reconcile: () => exclusive(reconcileNow),
            /** @returns {Promise<{converted: number}>} */
            migrate: () => exclusive(migrateNow),
            /** @returns {Promise<{bytes: number, quota: number, unsynced: number}>} */
            usage: () => exclusive(usageNow),
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
        writeId,
        writeIdTime,
        normalizeGroup,
        chunkedHeader,
        encodeGroup,
        decodeGroup,
        createGroupStore,
    };
}());

if (typeof module !== 'undefined' && module.exports) {
    module.exports = groupStore;
}
