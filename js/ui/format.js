// Dates and addresses for display, and addresses as typed.

/** creation time from a `tg_<ms>` key (saved groups and sessions) */
export function keyTime(key) {
    const ms = parseInt(String(key).slice(3), 10);
    return Number.isFinite(ms) ? ms : 0;
}

// Intl formatters are slow to make, and the popup draws three dates per group on every keystroke: one per kind,
// language and options
const formatters = new Map();

function formatter(Kind, lang, options) {
    const key = Kind.name + '|' + lang + '|' + JSON.stringify(options);
    let made = formatters.get(key);
    if (!made) {
        made = new Kind(lang, options);
        formatters.set(key, made);
    }
    return made;
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
    return formatter(Intl.DateTimeFormat, lang, sameYear ? {month: 'short', day: 'numeric'} :
        {month: 'short', day: 'numeric', year: 'numeric'}).format(d);
}

/** date column of the list: "Oct 15" this year, only "2025" for another year (fullDate has the rest) */
export function listDate(ms, lang, now) {
    const d = new Date(ms);
    const year = new Date(now === undefined ? Date.now() : now).getFullYear();
    return d.getFullYear() === year ? formatter(Intl.DateTimeFormat, lang, {month: 'short', day: 'numeric'}).format(d) :
        String(d.getFullYear());
}

/** "September 28, 2025 at 9:52 PM", "28 вересня 2025 р. о 21:52" */
export function fullDate(ms, lang) {
    return formatter(Intl.DateTimeFormat, lang, {dateStyle: 'long', timeStyle: 'short'}).format(new Date(ms));
}

/** "21:52" or "9:52 PM", as the language writes it */
export function shortTime(ms, lang) {
    return formatter(Intl.DateTimeFormat, lang, {hour: 'numeric', minute: '2-digit'}).format(new Date(ms));
}

function startOfDay(ms) {
    return new Date(ms).setHours(0, 0, 0, 0);
}

/**
 * "Today", "Yesterday" (in the language, from Intl), otherwise like shortDate.
 * relative false: always the date (for text that stays, like a group name).
 * capital false: "today", for the middle of a sentence ("Last restore: today, 14:02").
 */
export function dayName(ms, lang, now, relative = true, capital = true) {
    const today = now === undefined ? Date.now() : now;
    // rounded: a day with a clock change is 23 or 25 hours
    const days = Math.round((startOfDay(today) - startOfDay(ms)) / 864e5);
    if (relative && (days === 0 || days === 1)) {
        const word = formatter(Intl.RelativeTimeFormat, lang, {numeric: 'auto'}).format(-days, 'day');
        return capital ? word.charAt(0).toLocaleUpperCase(lang) + word.slice(1) : word;
    }
    return shortDate(ms, lang, today);
}

/** "Yesterday, 14:02" (capital: see dayName) */
export function dayTime(ms, lang, now, relative = true, capital = true) {
    return dayName(ms, lang, now, relative, capital) + ', ' + shortTime(ms, lang);
}

/** when a session ran: "Yesterday, 14:02–23:05", across days "Oct 11, 10:02–Oct 12, 01:51" */
export function interval(start, end, lang, now, relative = true) {
    const to = startOfDay(start) === startOfDay(end) ? shortTime(end, lang) : dayTime(end, lang, now, relative);
    return dayTime(start, lang, now, relative) + '–' + to;
}

/**
 * Bytes as KB (1024 bytes, like Chrome's sync quota of 100 KB) with `digits` decimals, as the language writes
 * numbers: "25.4", "25,4". Rounded down, so nearly full doesn't read as full; anything above 0 shows at least 0.1.
 */
export function kilobytes(bytes, lang, digits = 1) {
    const step = 10 ** digits;
    let kb = Math.floor(bytes / 1024 * step) / step;
    if (digits && bytes > 0) {
        kb = Math.max(kb, 1 / step);
    }
    return formatter(Intl.NumberFormat, lang, {minimumFractionDigits: digits, maximumFractionDigits: digits}).format(kb);
}

// Punycode (RFC 3492), for host names: "xn--d1acufc" -> "домен"
const PUNY = {base: 36, tMin: 1, tMax: 26, skew: 38, damp: 700};

function adapt(delta, points, first) {
    let k = 0;
    delta = first ? Math.floor(delta / PUNY.damp) : delta >> 1;
    delta += Math.floor(delta / points);
    while (delta > ((PUNY.base - PUNY.tMin) * PUNY.tMax) >> 1) {
        delta = Math.floor(delta / (PUNY.base - PUNY.tMin));
        k += PUNY.base;
    }
    return k + Math.floor((PUNY.base - PUNY.tMin + 1) * delta / (delta + PUNY.skew));
}

function punyDigit(code) {
    if (code >= 48 && code <= 57) {
        return code - 22;
    }
    if (code >= 65 && code <= 90) {
        return code - 65;
    }
    if (code >= 97 && code <= 122) {
        return code - 97;
    }
    return PUNY.base;
}

/** the label after "xn--"; throws on a broken one */
function punyDecode(input) {
    const end = input.lastIndexOf('-');
    const out = end > 0 ? Array.from(input.slice(0, end)) : [];
    let pos = end > 0 ? end + 1 : 0;
    let n = 128;
    let i = 0;
    let bias = 72;
    while (pos < input.length) {
        const old = i;
        for (let w = 1, k = PUNY.base; ; k += PUNY.base) {
            const digit = pos < input.length ? punyDigit(input.charCodeAt(pos++)) : PUNY.base;
            if (digit >= PUNY.base) {
                throw new Error('Bad punycode');
            }
            i += digit * w;
            const t = k <= bias ? PUNY.tMin : k >= bias + PUNY.tMax ? PUNY.tMax : k - bias;
            if (digit < t) {
                break;
            }
            w *= PUNY.base - t;
        }
        bias = adapt(i - old, out.length + 1, old === 0);
        n += Math.floor(i / (out.length + 1));
        i %= out.length + 1;
        if (n > 0x10FFFF) {
            throw new Error('Bad punycode');
        }
        out.splice(i++, 0, String.fromCodePoint(n));
    }
    return out.join('');
}

// Cyrillic and Greek letters that look like Latin ones (and digits/hyphens, which every script shares)
const LATIN_LOOKALIKES = {
    Cyrillic: /^[\u0430\u0441\u0435\u043E\u0440\u0445\u0443\u0456\u0458\u0455\u04BB\u0501\u051B\u051D\u04CF\u0475\d-]+$/u,
    Greek: /^[\u03B1\u03BF\u03BD\u03B9\u03C4\u03C5\u03C1\u03BA\d-]+$/u,
};

function decodedLabel(label) {
    return /^xn--/i.test(label) ? punyDecode(label.slice(4).toLowerCase()) : label;
}

// Latin letters mixed with letters of another script ("аpple" with a Cyrillic "а") stay in xn-- form, as Chrome
// shows them: they can pass for another address. So does a Cyrillic or Greek label made only of Latin look-alikes
// ("аррӏе" for apple) unless the last label (the TLD) is in the same script: "аррӏе.com" stays, "домен.укр" is decoded
function readableLabel(label, tld) {
    if (!/^xn--/i.test(label)) {
        return label;
    }
    try {
        const text = decodedLabel(label);
        const mixed = /[a-z]/i.test(text) && /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text);
        if (mixed) {
            return label;
        }
        for (const script of Object.keys(LATIN_LOOKALIKES)) {
            if (LATIN_LOOKALIKES[script].test(text) && !new RegExp('\\p{Script=' + script + '}', 'u').test(tld)) {
                return label;
            }
        }
        return text;
    } catch (e) {
        return label;
    }
}

/**
 * "github.com" for "https://www.github.com/x", "домен.укр" for its xn-- form; the address itself when it has no host
 * (about:blank, data:)
 */
export function hostOf(url) {
    try {
        const host = new URL(url).host;
        if (!host) {
            return String(url);
        }
        const labels = host.replace(/^www\./, '').split('.');
        let tld = labels[labels.length - 1];
        try {
            tld = decodedLabel(tld);
        } catch (e) {
            // a broken xn-- TLD is kept as it is
        }
        return labels.map(label => readableLabel(label, tld)).join('.');
    } catch (e) {
        return String(url || '');
    }
}

/** an address typed without a scheme ("example.com/x") is a web address */
export function withScheme(url) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data|mailto|file|view-source|chrome):/i.test(url) ?
        url : 'https://' + url;
}
