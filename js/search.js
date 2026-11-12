// Search in the popup: filters groups (and sessions) by name and by the titles and addresses of their tabs.
// Case-insensitive, words in any order: every word of the query has to be found.
// A group whose name matches comes first. A group that matches only through its tabs is shown with those tabs.

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** query words, without duplicates; [] for an empty query */
export function parseQuery(query) {
    const words = String(query || '').trim().split(/\s+/).filter(Boolean);
    const seen = new Set();
    return words.filter((w) => {
        const k = w.toLocaleLowerCase();
        if (seen.has(k)) {
            return false;
        }
        seen.add(k);
        return true;
    });
}

function wordRegExp(word) {
    return new RegExp(escapeRegExp(word), 'giu');
}

/** the word where a word of the text starts: at the start or after something that is not a letter, mark or digit */
function wordStartRegExp(word) {
    return new RegExp('(?<![\\p{L}\\p{M}\\p{N}])' + escapeRegExp(word), 'giu');
}

function ranges(s, re) {
    const found = [];
    let m;
    while ((m = re.exec(s)) !== null) {
        found.push([m.index, m.index + m[0].length]);
        if (m[0].length === 0) {
            re.lastIndex++;
        }
    }
    return found;
}

/** true if every word is in the text */
export function matchesAll(text, words) {
    const s = String(text || '');
    return words.length > 0 && words.every((w) => wordRegExp(w).test(s));
}

/**
 * The text split into parts for highlighting: [{text, hit}]. Overlapping matches and those separated only by
 * whitespace merge.
 * A word found where a word of the text starts is highlighted only there ("to" lights up "Tofino", not the middle
 * of "photos"); otherwise wherever it is found. Without words it is one part that is not a hit.
 */
export function segments(text, words) {
    const s = String(text || '');
    const hits = [];
    for (const w of words) {
        const starts = ranges(s, wordStartRegExp(w));
        hits.push(...(starts.length ? starts : ranges(s, wordRegExp(w))));
    }
    if (!hits.length) {
        return [{text: s, hit: false}];
    }
    hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [hits[0].slice()];
    for (const [start, end] of hits.slice(1)) {
        const last = merged[merged.length - 1];
        if (start <= last[1] || /^\s+$/.test(s.slice(last[1], start))) {
            last[1] = Math.max(last[1], end);
        } else {
            merged.push([start, end]);
        }
    }
    const parts = [];
    let pos = 0;
    for (const [start, end] of merged) {
        if (start > pos) {
            parts.push({text: s.slice(pos, start), hit: false});
        }
        parts.push({text: s.slice(start, end), hit: true});
        pos = end;
    }
    if (pos < s.length) {
        parts.push({text: s.slice(pos), hit: false});
    }
    return parts;
}

/**
 * URL excerpts for query words absent from the title. Keep context around the first match of each word,
 * joining nearby excerpts and replacing omitted text with an ellipsis. No unexplained URL matches: ''.
 */
export function urlMatchExcerpt(title, url, words) {
    const s = String(url || '');
    const excerpts = [];
    for (const word of words) {
        if (matchesAll(title, [word])) {
            continue;
        }
        const match = wordStartRegExp(word).exec(s) || wordRegExp(word).exec(s);
        if (match) {
            excerpts.push([Math.max(0, match.index - 12), Math.min(s.length, match.index + match[0].length + 12)]);
        }
    }
    excerpts.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of excerpts) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) {
            last[1] = Math.max(last[1], end);
        } else {
            merged.push([start, end]);
        }
    }
    return merged.map(([start, end], i) => (i || start ? '…' : '') + s.slice(start, end) +
        (i === merged.length - 1 && end < s.length ? '…' : '')).join('');
}

/**
 * @param {Array<{key: string, name: string, tabs: Array<{title?: string, url?: string}>}>} items in display order
 * @param {string} query
 * @returns {Array<{key: string, byName: boolean, tabIndexes: number[]}>} matching items, name matches first,
 *   otherwise in the given order. tabIndexes: tabs that match on their own (title or address).
 *   Empty query: every item, byName false, no tabIndexes.
 */
export function search(items, query) {
    const words = parseQuery(query);
    if (!words.length) {
        return items.map((item) => ({key: item.key, byName: false, tabIndexes: []}));
    }
    const byName = [];
    const byTabs = [];
    for (const item of items) {
        const nameHit = matchesAll(item.name, words);
        const tabIndexes = [];
        (item.tabs || []).forEach((tab, i) => {
            if (matchesAll((tab.title || '') + '\n' + (tab.url || ''), words)) {
                tabIndexes.push(i);
            }
        });
        if (nameHit) {
            byName.push({key: item.key, byName: true, tabIndexes});
        } else if (tabIndexes.length) {
            byTabs.push({key: item.key, byName: false, tabIndexes});
        }
    }
    return byName.concat(byTabs);
}
