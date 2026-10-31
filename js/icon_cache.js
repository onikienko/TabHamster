// Site icons for browsers without Chrome's _favicon (Firefox). There tab.favIconUrl is the icon itself (a data:
// address), so the background keeps the icon of every site its tabs show, and the popup reads them from here.
// IndexedDB, not storage.local: apart from the groups, no storage.onChanged on every icon, and an index on `seen` to
// drop the sites not seen for longest. One record per site: {origin, png (Blob), sum (of the data: address), seen}.
var iconCache = (function () {
    const DB_NAME = 'icons';
    const STORE = 'sites';
    const MAX_SITES = 20000;
    // the popup draws icons at 16 px: 32 keeps them sharp on high-density screens
    const SIZE = 32;
    // a known site's icon is written again at most once a day (only `seen` moves): not on every page load
    const DAY = 24 * 60 * 60 * 1000;
    const TRIM_EVERY = 100;

    let opening = null;
    // origin -> {sum, at}: what this run has already looked at
    const noted = new Map();
    let added = 0;

    function open() {
        if (!opening) {
            opening = new Promise(function (resolve, reject) {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => req.result.createObjectStore(STORE, {keyPath: 'origin'}).createIndex('seen', 'seen');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            // the next call tries again
            opening.catch(() => { opening = null; });
        }
        return opening;
    }

    function done(req) {
        return new Promise(function (resolve, reject) {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function sites(mode) {
        return (await open()).transaction(STORE, mode).objectStore(STORE);
    }

    /** the key of a web page's site, or null for any other address */
    function originOf(pageUrl) {
        try {
            const url = new URL(pageUrl);
            return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
        } catch (e) {
            return null;
        }
    }

    // FNV-1a: tells a changed icon from the same one without keeping its address
    function checksum(text) {
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
        }
        return h >>> 0;
    }

    // at most SIZE px, square, centered if it isn't; SVG icons without a size get SIZE
    async function scale(src) {
        const img = new Image();
        img.src = src;
        await img.decode();
        const w = img.naturalWidth || SIZE;
        const h = img.naturalHeight || SIZE;
        const size = Math.min(SIZE, Math.max(w, h));
        const k = size / Math.max(w, h);
        const canvas = new OffscreenCanvas(size, size);
        canvas.getContext('2d').drawImage(img, (size - w * k) / 2, (size - h * k) / 2, w * k, h * k);
        return canvas.convertToBlob({type: 'image/png'});
    }

    /** the kept icon of the page's site as a PNG Blob, or null */
    async function get(pageUrl) {
        const origin = originOf(pageUrl);
        if (!origin) {
            return null;
        }
        const site = await done((await sites('readonly')).get(origin));
        return site ? site.png : null;
    }

    /** keeps the icon a tab on the page shows (its favIconUrl); anything but a data: image is left out */
    async function remember(pageUrl, src) {
        const origin = originOf(pageUrl);
        if (!origin || typeof src !== 'string' || !src.startsWith('data:image/')) {
            return;
        }
        const sum = checksum(src);
        const now = Date.now();
        const last = noted.get(origin);
        if (last && last.sum === sum && now - last.at < DAY) {
            return;
        }
        noted.set(origin, {sum, at: now});
        const had = await done((await sites('readonly')).get(origin));
        if (had && had.sum === sum) {
            if (now - had.seen >= DAY) {
                await done((await sites('readwrite')).put({...had, seen: now}));
            }
            return;
        }
        let png;
        try {
            png = await scale(src);
        } catch (e) {
            // not an image the browser can draw: no icon kept
            return;
        }
        await done((await sites('readwrite')).put({origin, png, sum, seen: now}));
        if (!had && ++added % TRIM_EVERY === 0) {
            await trim();
        }
    }

    /** drops the sites not seen for longest, past `max` */
    async function trim(max = MAX_SITES) {
        const db = await open();
        return new Promise(function (resolve, reject) {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            store.count().onsuccess = function (e) {
                let extra = e.target.result - max;
                if (extra > 0) {
                    store.index('seen').openCursor().onsuccess = function (ev) {
                        const cursor = ev.target.result;
                        if (cursor && extra-- > 0) {
                            cursor.delete();
                            cursor.continue();
                        }
                    };
                }
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    return {get, remember, trim};
}());
