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

function startOfDay(ms) {
    return new Date(ms).setHours(0, 0, 0, 0);
}

/**
 * "Today", "Yesterday" (in the language, from Intl), otherwise like shortDate.
 * relative false: always the date (for text that stays, like a group name).
 */
export function dayName(ms, lang, now, relative = true) {
    const today = now === undefined ? Date.now() : now;
    // rounded: a day with a clock change is 23 or 25 hours
    const days = Math.round((startOfDay(today) - startOfDay(ms)) / 864e5);
    if (relative && (days === 0 || days === 1)) {
        const word = new Intl.RelativeTimeFormat(lang, {numeric: 'auto'}).format(-days, 'day');
        return word.charAt(0).toLocaleUpperCase(lang) + word.slice(1);
    }
    return shortDate(ms, lang, today);
}

/** "Yesterday, 14:02" */
export function dayTime(ms, lang, now, relative = true) {
    return dayName(ms, lang, now, relative) + ', ' + shortTime(ms, lang);
}

/** when a session ran: "Yesterday, 14:02–23:05", across days "Oct 11, 10:02–Oct 12, 01:51" */
export function interval(start, end, lang, now, relative = true) {
    const to = startOfDay(start) === startOfDay(end) ? shortTime(end, lang) : dayTime(end, lang, now, relative);
    return dayTime(start, lang, now, relative) + '–' + to;
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
