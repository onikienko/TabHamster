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

/** true if every word is in the text */
export function matchesAll(text, words) {
    const s = String(text || '');
    return words.length > 0 && words.every((w) => wordRegExp(w).test(s));
}

/**
 * The text split into parts for highlighting: [{text, hit}]. Overlapping matches merge.
 * Without words it is one part that is not a hit.
 */
export function segments(text, words) {
    const s = String(text || '');
    const ranges = [];
    for (const w of words) {
        const re = wordRegExp(w);
        let m;
        while ((m = re.exec(s)) !== null) {
            ranges.push([m.index, m.index + m[0].length]);
            if (m[0].length === 0) {
                re.lastIndex++;
            }
        }
    }
    if (!ranges.length) {
        return [{text: s, hit: false}];
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [ranges[0].slice()];
    for (const [start, end] of ranges.slice(1)) {
        const last = merged[merged.length - 1];
        if (start <= last[1]) {
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
