// Order of saved groups: the list shows them by `index`, highest first. Every change to a group rewrites it in
// sync storage (all its tabs), so a move changes only the moved group's index: it takes a number between its new
// neighbours. When there is no number between them (equal indexes from older versions, or after very many moves
// into one place) every group is numbered again.

/**
 * Index for a group put at `pos` among the others.
 * @param {number[]} others indexes of the other groups in display order (highest first), without the moved one
 * @param {number} pos 0 = top, others.length = bottom
 * @returns {number|null} null when there is no room between the neighbours
 */
export function indexAt(others, pos) {
    const above = pos > 0 ? others[pos - 1] : undefined;
    const below = pos < others.length ? others[pos] : undefined;
    if (above === undefined && below === undefined) {
        return 1;
    }
    if (above === undefined) {
        return Math.floor(below) + 1;
    }
    if (below === undefined) {
        return Math.ceil(above) - 1;
    }
    // a whole number if there is one between them, otherwise the middle
    const whole = Math.floor((above + below) / 2);
    if (whole > below && whole < above) {
        return whole;
    }
    const middle = (above + below) / 2;
    return middle > below && middle < above ? middle : null;
}

/**
 * Indexes for all groups in the given order (top first): n ... 1. Only the ones that change.
 * @param {string[]} keys
 * @param {Object} groups {key: {index}}
 * @returns {Object} {key: index}
 */
export function renumber(keys, groups) {
    const changes = {};
    keys.forEach((key, i) => {
        const index = keys.length - i;
        if (groups[key].index !== index) {
            changes[key] = index;
        }
    });
    return changes;
}

/**
 * New indexes for moving `key` to `pos` in `keys` (display order, top first). `pos` counts without the moved group.
 * @returns {Object} {key: index}, usually just the moved group
 */
export function moveTo(keys, groups, key, pos) {
    const others = keys.filter((k) => k !== key);
    const index = indexAt(others.map((k) => groups[k].index), pos);
    if (index !== null) {
        return {[key]: index};
    }
    others.splice(pos, 0, key);
    return renumber(others, groups);
}
