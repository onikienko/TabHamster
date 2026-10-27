// The browser's tab groups (names, colors): an optional permission, PLAN.md 9.1. Required, it would disable
// TabHamster on update until each user accepts its warning. Without it, tabs are saved and opened as in 1.0.0.

const TAB_GROUPS = {permissions: ['tabGroups']};

// the tabGroups API's colors (the same list as groupStore.TAB_GROUP_COLORS, for the background)
export const TAB_GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

/** true when the permission is given */
export async function hasTabGroups() {
    try {
        return await chrome.permissions.contains(TAB_GROUPS);
    } catch (e) {
        return false;
    }
}

/**
 * Asks for it; true when given. Call it straight from a click: the browser asks only during a user gesture, and an
 * `await` before it can end the gesture.
 */
export function requestTabGroups() {
    return chrome.permissions.request(TAB_GROUPS);
}

/** gives it back; true when removed */
export function removeTabGroups() {
    return chrome.permissions.remove(TAB_GROUPS);
}

/** fn(given) each time it is given or removed, here or in the browser's extension settings */
export function watchTabGroups(fn) {
    const has = (p) => !!(p && p.permissions && p.permissions.includes('tabGroups'));
    chrome.permissions.onAdded.addListener((p) => has(p) && fn(true));
    chrome.permissions.onRemoved.addListener((p) => has(p) && fn(false));
}

/** the browser's tab groups ({id, title, color, collapsed}), all windows; none without the permission */
export async function queryTabGroups() {
    if (!chrome.tabGroups || !(await hasTabGroups())) {
        return [];
    }
    try {
        return await chrome.tabGroups.query({});
    } catch (e) {
        console.error('TabHamster: tab groups not read', e);
        return [];
    }
}

/**
 * What a list shows of each tab's browser tab group: {t, c, start} (start: the first of a run of neighbours in the
 * same one, it shows the name), or null.
 * @param {Array<?{id: *, t: string, c: string}>} groups each tab's tab group (id tells them apart), null for none
 */
export function tabGroupRuns(groups) {
    let before = null;
    return groups.map((group) => {
        const shown = group ? {t: group.t, c: TAB_GROUP_COLORS.includes(group.c) ? group.c : 'grey',
            start: !before || before.id !== group.id} : null;
        before = group;
        return shown;
    });
}

/**
 * The `cg` of each tab as a saved group keeps it (format: js/group_store.js), null for a tab in no tab group or in one
 * missing from `groups`. Tabs of one tab group share {i, t, c, x?}: i numbers the tab groups 1, 2... in the order of
 * their first tab, t is the name ('' if none), c the color, x: true if collapsed.
 * @param {Array<{groupId?: number}>} tabs browser tabs
 * @param {Array<{id: number, title?: string, color: string, collapsed?: boolean}>} groups from queryTabGroups
 */
export function tabGroupFields(tabs, groups) {
    const byId = new Map(groups.map((group) => [group.id, group]));
    const numbers = new Map();
    return tabs.map((tab) => {
        const group = tab.groupId >= 0 ? byId.get(tab.groupId) : null;
        if (!group) {
            return null;
        }
        if (!numbers.has(group.id)) {
            numbers.set(group.id, numbers.size + 1);
        }
        const cg = {i: numbers.get(group.id), t: group.title || '', c: group.color};
        if (group.collapsed) {
            cg.x = true;
        }
        return cg;
    });
}
