// Icons of the sites tabs are on. Chrome's _favicon (the "favicon" permission) only knows sites opened in this
// browser: for any other it answers with its grey globe. Groups synced from another computer are full of those,
// so the popup can load them from the sites themselves instead (option site_icons: 'ask', 'load' or 'off').
// Answers are kept for as long as the page is open: the popup draws its rows again on every change.

// Chrome's icon at 32 px: sharp at 16 px on a high-density screen
const SIZE = 32;
// an address no browser has opened: what _favicon gives for it is the grey globe
const UNKNOWN_PAGE = 'https://tabhamster.invalid/';

// page address -> blob: address of Chrome's icon, null (Chrome has none), or the _favicon address itself (it
// couldn't be checked: shown as before)
const answers = new Map();
// page address -> Promise of the same
const asked = new Map();
// origins whose /favicon.ico didn't load
const failed = new Set();
let blank = null;

/** Chrome's cached favicon for a page */
export function faviconUrl(pageUrl) {
    const url = new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', pageUrl);
    url.searchParams.set('size', String(SIZE));
    return url.toString();
}

async function bytes(url) {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error('favicon ' + res.status);
    }
    return new Uint8Array(await res.arrayBuffer());
}

function same(a, b) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function check(pageUrl) {
    const src = faviconUrl(pageUrl);
    try {
        blank = blank || bytes(faviconUrl(UNKNOWN_PAGE));
        const [mine, globe] = await Promise.all([bytes(src), blank]);
        return same(mine, globe) ? null : URL.createObjectURL(new Blob([mine], {type: 'image/png'}));
    } catch (e) {
        return src;
    }
}

/** what chromeIcon() found for the page, if it has already answered (undefined: not yet) */
export function knownIcon(pageUrl) {
    return answers.get(pageUrl);
}

/** Chrome's icon for the page as an image address, or null when Chrome only has its grey globe for it */
export function chromeIcon(pageUrl) {
    if (!asked.has(pageUrl)) {
        asked.set(pageUrl, check(pageUrl).then((answer) => {
            answers.set(pageUrl, answer);
            return answer;
        }));
    }
    return asked.get(pageUrl);
}

/** the site's own /favicon.ico for a web page, or null (not a web page, or it didn't load before) */
export function siteIcon(pageUrl) {
    let url;
    try {
        url = new URL(pageUrl);
    } catch (e) {
        return null;
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || failed.has(url.origin)) {
        return null;
    }
    return url.origin + '/favicon.ico';
}

/** the site's /favicon.ico didn't load: the page shows its own globe for that site from now on */
export function siteIconFailed(pageUrl) {
    try {
        failed.add(new URL(pageUrl).origin);
    } catch (e) {
        // not an address: siteIcon() never gave one for it
    }
}
