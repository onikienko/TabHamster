// Group names: no two groups share a name. Names compare after trimming and collapsing spaces,
// ignoring case but not accents ("Trip to Tofino" = "trip  to tofino", "Cafe" ≠ "Café").
// Nothing looser: a matching name means Replace, so "かな" ≠ "カナ", "Ｗｏｒｋ" ≠ "Work", "2" ≠ "²"
// (Intl.Collator's 'accent' sensitivity treats those as the same).
// Groups saved without a name (shown as their date) never clash.

// the same on every computer: Unicode case mapping, not the language's
function nameKey(name) {
    return normalizeName(name).normalize('NFC').toLowerCase();
}

export function normalizeName(name) {
    return String(name === undefined || name === null ? '' : name).trim().replace(/\s+/g, ' ');
}

export function sameName(a, b) {
    const x = nameKey(a);
    const y = nameKey(b);
    return x !== '' && y !== '' && x === y;
}

// creation time from the `tg_<ms>` key
function keyTime(key) {
    const ms = parseInt(String(key).slice(3), 10);
    return Number.isFinite(ms) ? ms : 0;
}

/**
 * Key of the group with this name, or null. If several groups already share it (older versions allowed that),
 * the most recently created one.
 * @param {Object} groups {key: {name}}
 * @param {string} name
 * @param {string} [exceptKey] a group to ignore (the one being renamed)
 */
export function findByName(groups, name, exceptKey) {
    let found = null;
    for (const key of Object.keys(groups)) {
        if (key !== exceptKey && sameName(groups[key].name, name) && (found === null || keyTime(key) > keyTime(found))) {
            found = key;
        }
    }
    return found;
}

/** the name, or "name (2)", "name (3)"... if a group already has it */
export function freeName(groups, name) {
    let free = name;
    for (let n = 2; findByName(groups, free); n++) {
        free = name + ' (' + n + ')';
    }
    return free;
}

/** how many groups have this name */
export function countByName(groups, name) {
    return Object.keys(groups).filter((key) => sameName(groups[key].name, name)).length;
}
