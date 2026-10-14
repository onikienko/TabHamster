// Saved groups storage.
// Sync item formats at `tg_<ms>` (decoder checks them in this order):
//   1. {name, index, tabs}           v1 shape: written by 0.3.0, or by 0.4.0 when compression doesn't help
//   2. {v: 2, name, index, h, d}     tabs JSON, deflate-raw + base64, in one item
//   3. {v: 2, name, index, h, w, n}  header; data split into `tc_<ms>_<w>_<i>` chunk items
// name/index stay plain so 0.3.0 can still list groups. 0.4.0 never writes `v` together with `tabs`.
// 0.3.0 also writes an unused `color: ''`; it is ignored on read and never written.
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
     *   status: 'ok' | 'missing' | 'incomplete' (chunks not here yet) | 'corrupt'
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
    };
}());

if (typeof module !== 'undefined' && module.exports) {
    module.exports = groupStore;
}
