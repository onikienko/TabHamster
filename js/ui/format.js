// Dates, addresses and favicons for display.

/** creation time from a `tg_<ms>` key (saved groups and sessions) */
export function keyTime(key) {
    const ms = parseInt(String(key).slice(3), 10);
    return Number.isFinite(ms) ? ms : 0;
}

function two(n) {
    return String(n).padStart(2, '0');
}

/**
 * Name of a group saved without a name: its date and time in the format chosen in Settings.
 * 'eu': 16-10-2026 21:52, 'us': 2026-10-16 21:52 (same as 0.4.0).
 */
export function numericDate(ms, format) {
    const d = new Date(ms);
    const day = two(d.getDate());
    const month = two(d.getMonth() + 1);
    const time = two(d.getHours()) + ':' + two(d.getMinutes());
    return (format === 'us' ? d.getFullYear() + '-' + month + '-' + day : day + '-' + month + '-' + d.getFullYear()) +
        ' ' + time;
}

/** short date for list columns: "Oct 15", or "Oct 15, 2025" for another year */
export function shortDate(ms, lang, now) {
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date(now === undefined ? Date.now() : now).getFullYear();
    return new Intl.DateTimeFormat(lang, sameYear ? {month: 'short', day: 'numeric'} :
        {month: 'short', day: 'numeric', year: 'numeric'}).format(d);
}

/** "21:52" or "9:52 PM", as the language writes it */
export function shortTime(ms, lang) {
    return new Intl.DateTimeFormat(lang, {hour: 'numeric', minute: '2-digit'}).format(new Date(ms));
}

/** "github.com" for "https://www.github.com/x"; the address itself when it has no host (about:blank, data:) */
export function hostOf(url) {
    try {
        const host = new URL(url).host;
        return host ? host.replace(/^www\./, '') : String(url);
    } catch (e) {
        return String(url || '');
    }
}

/** Chrome's cached favicon for a page (needs the "favicon" permission) */
export function faviconUrl(pageUrl) {
    const url = new URL(chrome.runtime.getURL('/_favicon/'));
    url.searchParams.set('pageUrl', pageUrl);
    url.searchParams.set('size', '32');
    return url.toString();
}
