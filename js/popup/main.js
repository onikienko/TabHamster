// Popup: saved groups and sessions. Design: work-docs/design/boards (E), decisions: work-docs/PLAN.md section 7.
// Saved groups come from the group store in the background service worker (groupStoreClient),
// sessions from chrome.storage.local (written by the session watcher in js/background.js).

import {h, clear} from '../ui/dom.js';
import {icon, logo} from '../ui/icons.js';
import {t, plural, uiLanguage} from '../ui/i18n.js';
import {wantsNewWindow, keyLabel, keyCombo, isMac} from '../ui/platform.js';
import {keyTime, numericDate, listDate, fullDate, shortTime, dayTime, interval, hostOf, withScheme, kilobytes} from '../ui/format.js';
import {knownIcon, chromeIcon, siteIcon, siteIconFailed} from '../ui/favicons.js';
import {showBar, hideBarAbout, barShown} from '../ui/bar.js';
import {setTip} from '../ui/tooltip.js';
import {applyTheme} from '../ui/theme.js';
import {openMenu, closeMenu, isMenuOpen} from '../ui/menu.js';
import {normalizeName, findByName, countByName, freeName} from '../names.js';
import {parseQuery, segments, search} from '../search.js';
import {moveTo} from '../order.js';
import {enableDrag} from './drag.js';

const lang = uiLanguage();
const numbers = new Intl.NumberFormat(lang);
// "45%", "45 %" in French
const percents = new Intl.NumberFormat(lang, {style: 'percent', maximumFractionDigits: 0});
// key caps in tooltips
const ENTER = keyCombo(['enter']);
const ESC = keyCombo(['esc']);
const DELETE = keyLabel('delete');

const state = {
    options: null,
    groups: {},
    groupsError: null,
    sessions: {},
    currentSession: null,
    // the saved tab being edited: {key, index, tab} (see tabIndexIn), tab and index null for a new link at the end
    editingTab: null,
    usage: null,
    openTabs: 0,
    view: 'saved',
    // saved groups shown: all (null), only those not in sync ('unsynced'), or by space in sync ('biggest')
    filter: null,
    // {key: {bytes, synced}} from the store while a filter is on
    sizes: null,
    // reloads in progress: a "groups synced" message from the background meanwhile is about one of ours
    busy: 0,
    expanded: new Set(),
    // words typed in the field and what they found ({saved, sessions}: results of search())
    words: [],
    results: {saved: [], sessions: []},
    // groups found through their tabs open by themselves while searching; these were closed by hand
    searchClosed: new Set(),
    ready: false,
    // Enter pressed before the data has loaded still saves (once it has)
    pendingSave: false,
    saving: false,
    // key of the group just saved, highlighted for a moment
    fresh: null,
    // key of the group whose name is being edited in its row
    renaming: null,
    // the popup's window: "open in this window" goes there
    windowId: undefined,
};

const el = {
    field: document.getElementById('field'),
    save: document.getElementById('save'),
    clear: document.getElementById('clear'),
    fieldIcon: document.getElementById('field_icon'),
    chip: document.getElementById('chip'),
    chipText: document.getElementById('chip_text'),
    chipClear: document.getElementById('chip_clear'),
    tabs: document.querySelector('.tabs'),
    tabSaved: document.getElementById('tab_saved'),
    tabSessions: document.getElementById('tab_sessions'),
    countSaved: document.getElementById('count_saved'),
    countSessions: document.getElementById('count_sessions'),
    list: document.getElementById('list'),
    footer: document.getElementById('footer'),
    // screen readers hear what a search found (announceResults)
    found: h('div', {class: 'sr-only', role: 'status', 'aria-live': 'polite'}),
};

/* ---------- data ---------- */

async function loadOptions() {
    // global `storage` from js/storage.js
    return chrome.storage.sync.get(globalThis.storage.default_options);
}

async function loadGroups() {
    try {
        state.groups = await groupStoreClient.list();
        pendingTabChanges.forEach(applyTabChange);
        state.groupsError = null;
    } catch (e) {
        state.groups = {};
        state.groupsError = e;
    }
}

// tab changes shown before the background has made them: {key, change(tabs) -> tabs} (showTabChange)
const pendingTabChanges = new Set();

function applyTabChange(entry) {
    const group = state.groups[entry.key];
    if (group) {
        state.groups[entry.key] = Object.assign({}, group, {tabs: entry.change(group.tabs)});
    }
}

/**
 * Shows a tab change at once, so a click or key right after it is about the tabs as they will be. Until the
 * background answers, groups read meanwhile (an earlier change's reload) get it too. Returns a function to call
 * once it has answered.
 */
function showTabChange(key, change) {
    const entry = {key, change};
    pendingTabChanges.add(entry);
    applyTabChange(entry);
    return () => pendingTabChanges.delete(entry);
}

/** local storage also holds copies of saved groups (lg_) and store records; sessions are tg_ keys */
async function readSessionItems() {
    const local = chrome.storage.local;
    // only those (getKeys: Chrome 130+)
    return local.getKeys ? local.get((await local.getKeys()).filter((key) => key.startsWith('tg_'))) : local.get(null);
}

async function loadSessions() {
    const [local, session] = await Promise.all([
        readSessionItems(),
        chrome.storage.session.get('session_id'),
    ]);
    state.sessions = {};
    for (const key of Object.keys(local)) {
        if (key.startsWith('tg_') && local[key] && Array.isArray(local[key].tabs)) {
            state.sessions[key] = local[key];
        }
    }
    state.currentSession = session.session_id || null;
}

async function loadUsage() {
    try {
        state.usage = await groupStoreClient.usage();
    } catch (e) {
        state.usage = null;
    }
}

async function loadSizes() {
    try {
        state.sizes = state.filter ? await groupStoreClient.sizes() : null;
    } catch (e) {
        state.sizes = null;
    }
}

/** groups saved on this computer only, waiting for room in sync */
function waitingKeys() {
    return Object.keys(state.groups).filter((key) => state.groups[key].synced === false);
}

/** reads the groups again; returns how many of those that waited for sync (except `except`) are in it now */
async function reload(except) {
    const waiting = waitingKeys().filter((key) => key !== except);
    state.busy++;
    try {
        await Promise.all([loadGroups(), loadUsage(), loadSizes()]);
    } finally {
        state.busy--;
    }
    return waiting.filter((key) => state.groups[key] && state.groups[key].synced).length;
}

/** tabs that Save would take: this window (or all, see Settings), pinned ones only if turned on */
async function queryTabsToSave() {
    const tabs = await chrome.tabs.query(state.options.cur_win ? {currentWindow: true} : {});
    return tabs.filter((tab) => !tab.pinned || state.options.pinned === 1);
}

/* ---------- opening ---------- */

// the background opens them (open_ops in js/background.js): a new window closes the popup mid-way
async function openTabs(how, tabs) {
    let res;
    try {
        res = await chrome.runtime.sendMessage({msg: 'open', how, tabs, windowId: state.windowId});
    } catch (e) {
        res = {error: e.message};
    }
    if (!res || res.error) {
        // Chrome's reason is English and for developers: the console has it
        console.error('TabHamster: open failed', res && res.error);
        showBar(t('p_openFailed'));
        return false;
    }
    return true;
}

/** a click handler that ignores the second click of a double click (it would save or open twice) */
function single(fn) {
    return (e) => {
        if (e.detail > 1) {
            return;
        }
        fn(e);
    };
}

function openInThisWindow(tabs) {
    openTabs('current', tabs);
}

/** in a new window ('window') or an incognito one ('incognito'); the popup closes unless that failed */
async function openElsewhere(how, tabs) {
    if (await openTabs(how, tabs)) {
        window.close();
    }
}

function openInNewWindow(tabs) {
    openElsewhere('window', tabs);
}

/** tabs of a session, one list per window, in their order */
function sessionWindows(session) {
    const windows = new Map();
    for (const tab of session.tabs) {
        const id = tab.windowId === undefined ? 0 : tab.windowId;
        if (!windows.has(id)) {
            windows.set(id, []);
        }
        windows.get(id).push(tab);
    }
    return Array.from(windows.values());
}

async function restoreSession(session) {
    // the first window may go into this one, if it is only a blank new tab
    const done = await Promise.all(sessionWindows(session).map((tabs, i) => openTabs(i === 0 ? 'blankOrWindow' : 'window', tabs)));
    if (done.every(Boolean)) {
        window.close();
    }
}

/* ---------- saving ---------- */

/**
 * What Save (and Enter) would do with the text in the field:
 * {kind: 'new', name} ('' = named by date), or {kind: 'replace', key, name} when a group already has that name
 */
function saveIntent() {
    const name = normalizeName(el.field.value);
    if (!name) {
        return {kind: 'new', name: ''};
    }
    const key = findByName(state.groups, name);
    return key ? {kind: 'replace', key, name: state.groups[key].name} : {kind: 'new', name};
}

/**
 * A tab as a saved group keeps it. `id`: a number no other tab of the group has (its place when the group is saved):
 * 0.4.0 finds a tab by it to remove or edit it.
 */
function savedTab(tab, id) {
    return tab.pinned ? {url: tab.url, title: tab.title, id, pinned: true} : {url: tab.url, title: tab.title, id};
}

/**
 * Where a saved tab a row showed (`at`: {index, tab}) is in `tabs` now: the one with the same id and address, at
 * `index` if more match; -1 if it is gone. The same test as the store's findTab, which does the change.
 */
function tabIndexIn(tabs, at) {
    const same = (tab) => sameTab(tab, at.tab);
    return same(tabs[at.index]) ? at.index : tabs.findIndex(same);
}

/** the same saved tab: id and address (the title may have been edited) */
function sameTab(a, b) {
    return !!a && !!b && a.url === b.url && a.id === b.id;
}

function nextIndex() {
    return Object.values(state.groups).reduce((max, g) => Math.max(max, g.index || 0), 0) + 1;
}

/**
 * Undo of new tabs for a saved group: the old tabs back, and their copy in Recently deleted goes (Replace keeps one).
 * If the change was saved as a copy (the tabs had changed on another computer), the copy goes.
 */
function undoTabs(key, before, res) {
    return async () => {
        if (res.copy) {
            await groupStoreClient.discard(res.copy);
            return;
        }
        await groupStoreClient.setTabs(key, before.tabs, res.h);
        if (res.kept) {
            await groupStoreClient.discard(res.kept);
        }
    };
}

/** the hash of a group's tabs from a change's answer: a Replace sent before the groups are read again needs it */
function keepHash(key, res) {
    if (state.groups[key] && res.h) {
        state.groups[key] = Object.assign({}, state.groups[key], {h: res.h});
    }
}

/** second sentence of the bar when the group stayed on this computer */
function notSyncedNote(res) {
    if (res.synced) {
        return '';
    }
    return ' ' + t(/quota/i.test(res.error || '') ? 'p_notSyncedYet' : 'p_savedLocally_later');
}

/** shows the groups as they are after a change; returns how many waiting groups got into sync meanwhile */
async function afterChange(freshKey) {
    const synced = await reload(freshKey);
    state.fresh = freshKey || null;
    render();
    if (freshKey) {
        setTimeout(() => {
            if (state.fresh === freshKey) {
                state.fresh = null;
                // not a new render: it would close a menu or a rename opened meanwhile
                for (const item of el.list.querySelectorAll('.item.fresh')) {
                    item.classList.remove('fresh');
                }
            }
        }, 2500);
    }
    return synced;
}

/**
 * Undo button for the bar: runs `undo`, then shows the groups as they are. `about`: the group it changes back; a rename
 * or move of that group hides the bar
 */
function undoAction(undo, about) {
    return {
        label: t('p_undo_btn'),
        about,
        run: async () => {
            try {
                await undo();
            } catch (e) {
                console.error('TabHamster: undo failed', e);
                showBar(t('p_syncStorageDefault_error'));
                await afterChange(null);
                return;
            }
            const synced = await afterChange(null);
            if (synced) {
                showBar(plural('p_groupsSynced', synced));
            }
        },
    };
}

async function save() {
    if (!state.ready) {
        state.pendingSave = true;
        return;
    }
    if (state.saving) {
        return;
    }
    state.saving = true;
    try {
        // the list didn't load (no answer from the background): once more, for the name check and the place at the
        // top; if it still fails, the tabs are saved anyway
        if (state.groupsError) {
            await loadGroups();
        }
        const tabs = (await queryTabsToSave()).map(savedTab);
        if (!tabs.length) {
            showBar(t('p_nothingToSave'));
            return;
        }
        const intent = saveIntent();
        let key;
        let text;
        let undo;
        let fresh;
        if (intent.kind === 'replace') {
            key = intent.key;
            const before = state.groups[key];
            const res = await groupStoreClient.setTabs(key, tabs, before.h, true);
            text = (res.copy ? t('p_savedAsCopy', groupName(key, before)) :
                plural('p_replaced', tabs.length, [groupName(key, before)])) + notSyncedNote(res);
            undo = undoTabs(key, before, res);
            fresh = res.copy || key;
        } else {
            key = 'tg_' + Date.now();
            const group = {name: intent.name, index: nextIndex(), tabs};
            const res = await groupStoreClient.save(key, group);
            text = plural('p_savedAs', tabs.length, [intent.name || numericDate(keyTime(key), state.options.date_format)]) +
                notSyncedNote(res);
            undo = () => groupStoreClient.discard(key, group);
            fresh = key;
        }
        el.field.value = '';
        state.view = 'saved';
        state.expanded.delete('saved:' + key);
        await afterChange(fresh);
        showBar(text, undoAction(undo, fresh));
    } catch (e) {
        console.error('TabHamster: save failed', e);
        showBar(t('p_syncStorageDefault_error'));
    } finally {
        state.saving = false;
    }
}

/* ---------- group actions (⋯ menu, rename) ---------- */

/** wraps an action: a failure shows a message instead of disappearing */
function act(fn) {
    return async () => {
        try {
            await fn();
        } catch (e) {
            console.error('TabHamster: action failed', e);
            showBar(t('p_syncStorageDefault_error'));
        }
    };
}

/**
 * The group keeps its key, name and place, only its tabs change; the bar says `text` (or that the change became a
 * copy) and can undo it. keepOld: the old version goes to Recently deleted (Replace)
 */
async function setTabs(key, tabs, text, keepOld = false) {
    const before = state.groups[key];
    const res = await groupStoreClient.setTabs(key, tabs, before.h, keepOld);
    keepHash(key, res);
    await afterChange(res.copy || key);
    showBar((res.copy ? t('p_savedAsCopy', groupName(key, before)) : text) + notSyncedNote(res),
        undoAction(undoTabs(key, before, res), res.copy || key));
}

async function replaceWithOpenTabs(key) {
    const tabs = (await queryTabsToSave()).map(savedTab);
    if (!tabs.length) {
        showBar(t('p_nothingToSave'));
        return;
    }
    await setTabs(key, tabs, plural('p_replaced', tabs.length, [groupName(key, state.groups[key])]), true);
}

/**
 * After a tab change the background made to the tabs as they were then (removeTab, editTab, addTab): the bar says
 * `text` (or that the change became a copy) and can undo it; `unchanged`, nothing was done, it says `nothing`.
 */
async function tabChanged(key, name, res, text, nothing) {
    if (!res.h) {
        // the group is gone (deleted on another computer)
        await afterChange(null);
        throw new Error(res.error);
    }
    keepHash(key, res);
    await afterChange(res.unchanged ? null : res.copy || key);
    if (res.unchanged) {
        showBar(nothing);
        return;
    }
    showBar((res.copy ? t('p_savedAsCopy', name) : text) + notSyncedNote(res),
        undoAction(undoTabs(key, {tabs: res.before}, res), res.copy || key));
}

async function addTab(key, tab) {
    const name = groupName(key, state.groups[key]);
    // its id comes from the store
    const res = await groupStoreClient.addTab(key, savedTab(tab));
    await tabChanged(key, name, res, t('p_tabAdded', [tab.title || tab.url, name]), t('p_alreadyInGroup', name));
}

async function copyLinks(group) {
    try {
        await navigator.clipboard.writeText(group.tabs.map((tab) => tab.url).join('\n'));
        showBar(plural('p_linksCopied', group.tabs.length));
    } catch (e) {
        console.error('TabHamster: copy failed', e);
        showBar(t('p_copyFailed'));
    }
}

async function deleteGroup(key) {
    const name = groupName(key, state.groups[key]);
    await groupStoreClient.remove(key);
    state.expanded.delete('saved:' + key);
    // the space it took may let groups that waited get into sync ("Make room")
    const synced = await afterChange(null);
    // its row (and the focus with it) is gone
    if (document.activeElement === document.body) {
        el.field.focus();
    }
    showBar(synced ? plural('p_deletedSynced', synced, [name]) : t('p_deleted', name),
        undoAction(() => groupStoreClient.restore(key), key));
}

async function groupMenu(key, button) {
    if (isMenuOpen(button)) {
        closeMenu(true);
        return;
    }
    const [toSave, [current]] = await Promise.all([
        queryTabsToSave(),
        chrome.tabs.query({active: true, currentWindow: true}),
    ]);
    const group = state.groups[key];
    if (!button.isConnected) {
        // the row was drawn again meanwhile (after the click that ended a rename or a tab edit)
        button = el.list.querySelector('.item[data-key="' + CSS.escape(key) + '"] > .row .more');
    }
    if (!group || !button) {
        return;
    }
    const row = button.closest('.row');
    row.classList.add('menu-open');
    openMenu(button, [
        {
            icon: 'replace', label: t('p_replaceWithOpen'),
            sub: plural(state.options.cur_win ? 'p_tabsInWindow' : 'p_openTabsCount', toSave.length),
            run: act(() => replaceWithOpenTabs(key)),
        },
        current ? {
            icon: 'plus', label: t('p_addCurrentTab'), sub: current.title || current.url,
            run: act(() => addTab(key, current)),
        } : null,
        {icon: 'link', label: t('p_addLink'), run: () => startTabEdit(key, null)},
        {icon: 'pencil', label: t('p_rename'), run: () => startRename(key)},
        '-',
        {icon: 'incognito', label: t('p_openIncognito'), run: () => openElsewhere('incognito', group.tabs)},
        {icon: 'copy', label: t('p_copyLinks'), run: () => copyLinks(group)},
        '-',
        {icon: 'trash', label: t('p_delete'), danger: true, run: act(() => deleteGroup(key))},
    ].filter(Boolean), {label: groupName(key, group), onClose: () => menuClosed(row)});
}

/* ---------- order ---------- */

// moves (of groups, and of tabs inside a group) show at once; the background writes them in the order they come; the
// groups are read back after the last one
let movesLeft = 0;

function moveDone() {
    return --movesLeft === 0 ? afterChange(null) : null;
}

/** puts a group at `pos` among the others (0 = top); usually only its own index changes (js/order.js) */
function moveGroup(key, pos) {
    const changes = moveTo(sortedGroupKeys(), state.groups, key, pos);
    hideBarAbout(key);
    for (const [k, index] of Object.entries(changes)) {
        state.groups[k] = Object.assign({}, state.groups[k], {index});
    }
    render();
    movesLeft++;
    // sent at once, not after the previous one: the background does them in order, and a popup closed right after
    // a few quick moves still gets them all saved
    groupStoreClient.setIndex(changes).catch((e) => {
        console.error('TabHamster: move failed', e);
        showBar(t('p_syncStorageDefault_error'));
    }).then(moveDone);
}

/** tabs with the one at `i` put at `pos` among the others; the same tabs if it is gone (-1) */
function withTabAt(tabs, i, pos) {
    if (i === -1) {
        return tabs;
    }
    const rest = tabs.filter((tab, k) => k !== i);
    rest.splice(pos, 0, tabs[i]);
    return rest;
}

/** puts a saved tab (`at`: a row's tab, see tabRow) at `pos` among its group's other tabs; no bar (as group moves) */
function moveTab(at, pos) {
    const group = state.groups[at.key];
    if (!group || tabIndexIn(group.tabs, at) === -1) {
        return;
    }
    // an Undo for the group's tabs as they were would undo this move too
    hideBarAbout(at.key);
    const saved = showTabChange(at.key, (tabs) => withTabAt(tabs, tabIndexIn(tabs, at), pos));
    render();
    movesLeft++;
    groupStoreClient.moveTab(at.key, at.tab, at.index, pos).then((res) => {
        if (res.error) {
            throw new Error(res.error);
        }
        keepHash(at.key, res);
    }).catch((e) => {
        console.error('TabHamster: tab move failed', e);
        showBar(t('p_syncStorageDefault_error'));
    }).finally(saved).then(moveDone);
}

/**
 * Moves a saved tab (`at`) into another group, at `pos` among its tabs (null: at the end). A group left without tabs
 * is deleted; Undo brings back both. Not when the other group has the address already (as Add current tab).
 */
async function moveTabTo(at, to, pos) {
    const from = state.groups[at.key];
    const dest = state.groups[to];
    const i = from ? tabIndexIn(from.tabs, at) : -1;
    if (i === -1 || !dest) {
        render();
        return;
    }
    const toName = groupName(to, dest);
    const fromName = groupName(at.key, from);
    if (dest.tabs.some((tab) => tab.url === at.tab.url)) {
        render();
        showBar(t('p_alreadyInGroup', toName));
        return;
    }
    hideBarAbout(at.key);
    hideBarAbout(to);
    const index = pos === null ? dest.tabs.length : pos;
    // shown at once; a group left without tabs goes from the list until the groups are read again
    const saved = [
        showTabChange(to, (tabs) => (tabs.some((tab) => tab.url === at.tab.url) ? tabs :
            tabs.slice(0, index).concat(at.tab, tabs.slice(index)))),
        showTabChange(at.key, (tabs) => {
            const j = tabIndexIn(tabs, at);
            return j === -1 ? tabs : tabs.filter((tab, k) => k !== j);
        }),
    ];
    if (from.tabs.length === 1) {
        delete state.groups[at.key];
        state.expanded.delete('saved:' + at.key);
    }
    render();
    let res;
    try {
        res = await groupStoreClient.moveTabTo(at.key, at.tab, at.index, to, index);
    } finally {
        saved.forEach((done) => done());
    }
    if (res.unchanged) {
        await afterChange(null);
        showBar(res.exists ? t('p_alreadyInGroup', toName) : t('p_tabGone', fromName));
        return;
    }
    if (!res.to) {
        // a group is gone (deleted on another computer)
        await afterChange(null);
        throw new Error(res.error);
    }
    keepHash(to, res.to);
    if (!res.from.removed) {
        keepHash(at.key, res.from);
    }
    await afterChange(res.to.copy || to);
    const copy = res.to.copy ? toName : res.from.copy ? fromName : null;
    const text = copy ? t('p_savedAsCopy', copy) :
        res.from.removed ? t('p_movedDeleted', [toName, fromName]) : t('p_movedTo', toName);
    showBar(text + notSyncedNote(res.to), undoAction(async () => {
        await undoTabs(to, {tabs: res.to.before}, res.to)();
        await (res.from.removed ? groupStoreClient.restore(at.key) :
            undoTabs(at.key, {tabs: res.from.before}, res.from)());
    }, [to, at.key]));
}

/** a tab row dropped (js/popup/drag.js): into group `to` at `pos` among its other tabs, null at the end */
function dropTab(link, to, pos) {
    const at = rowTabs.get(link);
    if (!at) {
        render();
    } else if (to === at.key) {
        moveTab(at, pos);
    } else {
        act(() => moveTabTo(at, to, pos))();
    }
}

/** the saved groups are shown (not sessions) and not filtered: only then can they be reordered */
function canReorder() {
    return (state.view === 'saved' || !state.options.session_watcher) && !state.words.length && !state.renaming && !state.editingTab &&
        !state.filter;
}

/* ---------- not synced ---------- */

/** 'unsynced', 'biggest' or null (all groups); only on the Saved groups tab (switching tabs removes it) */
async function setFilter(filter) {
    state.filter = filter;
    el.list.scrollTop = 0;
    await loadSizes();
    render();
}

/** sync storage has no room for a group that waits for it */
function syncIsFull() {
    if (!state.usage || !state.sizes) {
        return false;
    }
    const free = state.usage.quota - state.usage.bytes;
    return waitingKeys().some((key) => state.sizes[key] && state.sizes[key].bytes > free);
}

/** "97", "100": KB used and the quota */
function usageKB() {
    return [kilobytes(state.usage.bytes, lang, 0), kilobytes(state.usage.quota, lang, 0)];
}

/** above the groups that are not synced: why, that they are safe, and a way to make room */
function unsyncedNote() {
    const count = waitingKeys().length;
    const full = syncIsFull();
    return h('div', {class: 'note warn'},
        h('p', {class: 'note-title'}, plural('p_unsyncedNote_title', count)),
        h('p', null, full ? plural('p_unsyncedNote_full', count, usageKB()) : plural('p_unsyncedNote_later', count)),
        full ? h('button', {class: 'link', type: 'button', onClick: () => setFilter('biggest')}, t('p_makeRoom')) : null);
}

/** space the group takes in sync storage; for "Biggest first" */
function sizeOf(key) {
    const size = state.sizes && state.sizes[key];
    return size && size.synced && state.groups[key].synced !== false ? size.bytes : null;
}

function sizeMeta(key) {
    const bytes = sizeOf(key);
    return h('span', {class: ['meta', 'size', 'num', bytes !== null && 'strong']},
        bytes !== null ? t('p_kb', kilobytes(bytes, lang)) : t('p_notInSync'));
}

// the background says groups that waited for sync got there (on_synced in js/background.js)
async function onGroupsSynced() {
    const synced = await reload();
    if (!synced) {
        return;
    }
    // waits while a menu, a rename or a tab edit is open (render)
    render();
    showBar(plural('p_groupsSynced', synced));
}

/* ---------- session actions ---------- */

async function saveSessionAsGroup(key) {
    const session = state.sessions[key];
    const start = keyTime(key);
    // the session's dates, not "Yesterday": the name stays
    const name = freeName(state.groups, session.updated ? interval(start, session.updated, lang, undefined, false) :
        dayTime(start, lang, undefined, false));
    const tabs = session.tabs.map(savedTab);
    const groupKey = 'tg_' + Date.now();
    const group = {name, index: nextIndex(), tabs};
    const res = await groupStoreClient.save(groupKey, group);
    await afterChange(null);
    showBar(plural('p_savedAs', tabs.length, [name]) + notSyncedNote(res),
        undoAction(() => groupStoreClient.discard(groupKey, group), groupKey));
}

async function deleteSession(key) {
    const session = state.sessions[key];
    await chrome.storage.local.remove(key);
    delete state.sessions[key];
    state.expanded.delete('sessions:' + key);
    render();
    if (document.activeElement === document.body) {
        el.field.focus();
    }
    showBar(t('p_sessionDeleted'), {
        label: t('p_undo_btn'),
        run: async () => {
            await chrome.storage.local.set({[key]: session});
            state.sessions[key] = session;
            render();
        },
    });
}

function sessionMenu(key, button) {
    if (isMenuOpen(button)) {
        closeMenu(true);
        return;
    }
    const session = state.sessions[key];
    const row = button.closest('.row');
    row.classList.add('menu-open');
    openMenu(button, [
        {icon: 'plus', label: t('p_saveAsGroup'), sub: t('p_saveAsGroup_sub'), run: act(() => saveSessionAsGroup(key))},
        {
            icon: 'window', label: t('p_openInThisWindow'), sub: plural('p_allTabsOneWindow', session.tabs.length),
            run: () => openInThisWindow(session.tabs),
        },
        {icon: 'copy', label: t('p_copyLinks'), run: () => copyLinks(session)},
        '-',
        {icon: 'trash', label: t('p_delete'), danger: true, run: act(() => deleteSession(key))},
    ], {label: sessionName(key), onClose: () => menuClosed(row)});
}

/** a ⋯ menu closed: the list is drawn if it waited for that (render), after what was chosen has started */
function menuClosed(row) {
    row.classList.remove('menu-open');
    setTimeout(renderIfWaiting);
}

function focusName(key) {
    const name = el.list.querySelector('.item[data-key="' + CSS.escape(key) + '"] .name');
    if (name) {
        name.focus();
    }
}

function startRename(key) {
    state.renaming = key;
    renderList();
    const input = el.list.querySelector('.rename-input');
    if (input) {
        input.focus();
        input.select();
    }
}

/**
 * The row of a group being renamed. Enter or ✓ saves, Esc or × cancels. Clicking elsewhere saves a name
 * that can be used and cancels one that belongs to another group. Empty: the group is named by its date again.
 */
function renameRow(key) {
    const group = state.groups[key];
    const input = h('input', {
        class: 'rename-input', type: 'text', value: group.name, maxlength: 200, autocomplete: 'off',
        spellcheck: 'false', dir: 'auto', 'aria-label': t('p_groupName_label'),
    });
    const error = h('div', {class: 'rename-error', id: 'rename_error', hidden: true});
    const ok = setTip(h('button', {class: 'ib', type: 'button', 'aria-label': t('p_saveName')}, icon('check', 16)),
        {text: t('p_saveName'), keys: [ENTER]});
    const cancel = setTip(h('button', {class: 'ib', type: 'button', 'aria-label': t('p_cancelRename')}, icon('close', 15)),
        {text: t('p_cancelRename'), keys: [ESC]});
    const row = h('div', {class: 'rename'}, h('div', {class: 'rename-line'}, h('span', {class: 'chev-space'}), input, ok, cancel),
        error);

    // true if the typed name can be used (changing only the capitals of its own name can)
    const check = () => {
        const name = normalizeName(input.value);
        const other = name ? findByName(state.groups, name, key) : null;
        input.setAttribute('aria-invalid', String(!!other));
        if (other) {
            input.setAttribute('aria-describedby', 'rename_error');
        } else {
            input.removeAttribute('aria-describedby');
        }
        error.textContent = other ? t('p_nameTaken', state.groups[other].name) : '';
        error.hidden = !other;
        ok.disabled = !!other;
        return !other;
    };
    let done = false;
    const finish = async (commit, refocus) => {
        if (done) {
            return;
        }
        done = true;
        state.renaming = null;
        const name = normalizeName(input.value);
        const changed = commit && name !== group.name;
        if (changed) {
            hideBarAbout(key);
            state.groups[key] = Object.assign({}, state.groups[key], {name});
        }
        if (refocus) {
            render();
            focusName(key);
        } else {
            // ended by a click elsewhere (the focus leaves on mousedown) or by Tab: drawn again once the focus has
            // moved, and after the click (render waits while the button is down), so the click still lands
            setTimeout(render);
        }
        if (changed) {
            try {
                await groupStoreClient.rename(key, name);
            } catch (e) {
                console.error('TabHamster: rename failed', e);
                showBar(t('p_syncStorageDefault_error'));
            }
            await afterChange(null);
        }
    };

    input.addEventListener('input', check);
    input.addEventListener('keydown', (e) => {
        if (e.isComposing) {
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            if (check()) {
                finish(true, true);
            }
        } else if (e.key === 'Escape') {
            // not to the list (it would clear the search) or to Chrome (it would close the popup)
            e.preventDefault();
            e.stopPropagation();
            finish(false, true);
        }
    });
    ok.addEventListener('click', () => finish(true, true));
    cancel.addEventListener('click', () => finish(false, true));
    row.addEventListener('focusout', (e) => {
        if (!row.contains(e.relatedTarget)) {
            finish(check(), false);
        }
    });
    return row;
}

/* ---------- tab actions (saved groups only) ---------- */

/** at: {key, index, tab}, a row's tab (tabRow) */
async function removeTab(at) {
    const group = state.groups[at.key];
    const i = group ? tabIndexIn(group.tabs, at) : -1;
    if (i === -1) {
        return;
    }
    // gone from the list at once: a click or Delete right after it is about the next tab. The background removes
    // it from the tabs as they are by then (an earlier change may still be saving)
    const saved = showTabChange(at.key, (tabs) => {
        const j = tabIndexIn(tabs, at);
        return j === -1 ? tabs : tabs.filter((tab, k) => k !== j);
    });
    redrawItem(at.key);
    const name = groupName(at.key, group);
    let res;
    try {
        res = await groupStoreClient.removeTab(at.key, at.tab, at.index);
    } finally {
        saved();
    }
    await tabChanged(at.key, name, res, t('p_tabRemoved'), t('p_tabGone', name));
}

/** the editor in place of a row's tab (at: {index, tab}), or a new last row for a link (at null) */
function startTabEdit(key, at) {
    closeMenu(false);
    state.renaming = null;
    state.editingTab = {key, index: at ? at.index : null, tab: at ? at.tab : null};
    renderList();
    const input = el.list.querySelector('.tab-editor .tab-input');
    if (input) {
        input.focus();
        input.select();
    } else {
        // the tab is gone (removed on another computer): nothing to edit
        state.editingTab = null;
        render();
    }
}

function focusTab(key, index) {
    const row = el.list.querySelector('a.tab-row[data-key="' + CSS.escape(key) + '"][data-index="' + index + '"]');
    if (row) {
        row.focus();
    } else {
        focusName(key);
    }
}

/**
 * Title and address of a saved tab, or of a new link (editing.tab null). Enter or ✓ saves, Esc or × cancels; clicking
 * elsewhere saves an address that can be used and cancels otherwise. An empty title is fine: the address shows.
 */
function tabEditor(key, editing) {
    const tab = editing.tab;
    const title = h('input', {
        class: 'tab-input', type: 'text', value: tab ? tab.title || '' : '', maxlength: 1000, autocomplete: 'off',
        spellcheck: 'false', dir: 'auto', 'aria-label': t('p_tabTitle_label'), placeholder: t('p_tabTitle_placeholder'),
    });
    const url = h('input', {
        class: 'tab-input url', type: 'text', value: tab ? tab.url : '', autocomplete: 'off', spellcheck: 'false',
        dir: 'ltr', 'aria-label': t('p_tabUrl_label'), placeholder: 'https://',
    });
    const ok = setTip(h('button', {class: 'ib', type: 'button', 'aria-label': t('p_saveTab')}, icon('check', 16)),
        {text: t('p_saveTab'), keys: [ENTER]});
    const cancel = setTip(h('button', {class: 'ib', type: 'button', 'aria-label': t('p_cancelTabEdit')}, icon('close', 15)),
        {text: t('p_cancelTabEdit'), keys: [ESC]});
    const box = h('div', {class: 'tab-editor'},
        h('div', {class: 'tab-editor-line'}, title, ok, cancel),
        h('div', {class: 'tab-editor-line'}, url));

    // not empty, and not a javascript: address (Chrome doesn't open them, a backup import drops them)
    const check = () => {
        const usable = url.value.trim() !== '' && !/^\s*javascript:/i.test(url.value);
        ok.disabled = !usable;
        return usable;
    };
    check();
    url.addEventListener('input', check);

    let done = false;
    const finish = async (commit, refocus) => {
        if (done) {
            return;
        }
        done = true;
        state.editingTab = null;
        const group = state.groups[key];
        if (!group) {
            // deleted on another computer meanwhile
            setTimeout(render);
            return;
        }
        const newUrl = url.value.trim() ? withScheme(url.value.trim()) : '';
        const newTitle = title.value.trim();
        const name = groupName(key, group);
        // where the tab is now (an earlier change may have been shown since the editor opened)
        const at = tab ? tabIndexIn(group.tabs, editing) : -1;
        const exists = !tab && group.tabs.some((saved) => saved.url === newUrl);
        if (commit && newUrl && exists) {
            showBar(t('p_alreadyInGroup', name));
        }
        const changed = commit && newUrl && !exists && (!tab || newUrl !== tab.url || newTitle !== (tab.title || ''));
        // shown at once; the background makes the change to the tabs as they are by then. A new link's id comes
        // from the store
        const saved = changed ? showTabChange(key, (tabs) => {
            if (!tab) {
                return tabs.some((other) => other.url === newUrl) ? tabs : tabs.concat({url: newUrl, title: newTitle});
            }
            const i = tabIndexIn(tabs, editing);
            return i === -1 ? tabs :
                tabs.map((other, j) => (j === i ? Object.assign({}, other, {url: newUrl, title: newTitle}) : other));
        }) : null;
        if (refocus) {
            render();
            focusTab(key, tab ? (at === -1 ? editing.index : at) : state.groups[key].tabs.length - 1);
        } else {
            // ended by a click elsewhere (the focus leaves on mousedown) or by Tab: drawn again once the focus has
            // moved, and after the click (render waits while the button is down), so the click still lands
            setTimeout(render);
        }
        if (!changed) {
            return;
        }
        try {
            const res = await (tab ? groupStoreClient.editTab(key, tab, editing.index, {url: newUrl, title: newTitle}) :
                groupStoreClient.addTab(key, {url: newUrl, title: newTitle})).finally(saved);
            await tabChanged(key, name, res, tab ? t('p_tabChanged') : t('p_tabAdded', [newTitle || newUrl, name]),
                t(tab ? 'p_tabGone' : 'p_alreadyInGroup', name));
        } catch (e) {
            console.error('TabHamster: tab edit failed', e);
            showBar(t('p_syncStorageDefault_error'));
            await afterChange(null);
        }
    };

    box.addEventListener('keydown', (e) => {
        if (e.isComposing) {
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            if (check()) {
                finish(true, true);
            }
        } else if (e.key === 'Escape') {
            // not to the list (it would clear the search) or to Chrome (it would close the popup)
            e.preventDefault();
            e.stopPropagation();
            finish(false, true);
        }
    });
    ok.addEventListener('click', () => finish(true, true));
    cancel.addEventListener('click', () => finish(false, true));
    box.addEventListener('focusout', (e) => {
        if (!box.contains(e.relatedTarget)) {
            finish(check(), false);
        }
    });
    return box;
}

/* ---------- search ---------- */

function runSearch() {
    const query = el.field.value;
    state.words = parseQuery(query);
    state.results.saved = search(shownGroupKeys().map((key) => ({
        key, name: groupName(key, state.groups[key]), tabs: state.groups[key].tabs,
    })), query);
    // the live session isn't searched: its tabs are open anyway, and a match there has nothing to show or do
    const sessionKeys = state.words.length ? sortedSessionKeys().filter((key) => key !== state.currentSession) :
        sortedSessionKeys();
    state.results.sessions = search(sessionKeys.map((key) => ({
        key, name: sessionName(key), tabs: state.sessions[key].tabs,
    })), query);
}

function clearSearch() {
    el.field.value = '';
    el.field.focus();
    onQuery();
}

function onQuery() {
    if (!parseQuery(el.field.value).length) {
        state.searchClosed.clear();
    }
    if (!state.ready) {
        return;
    }
    el.list.scrollTop = 0;
    render();
    announceResults();
}

let announceTimer = null;

/** "4 groups found" once typing pauses (the list changes silently for a screen reader) */
function announceResults() {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
        if (!state.words.length) {
            el.found.textContent = '';
            return;
        }
        const sessions = state.view === 'sessions' && !!state.options.session_watcher;
        const count = state.results[sessions ? 'sessions' : 'saved'].length;
        el.found.textContent = count ? plural(sessions ? 'p_foundSessions' : 'p_foundGroups', count) :
            t(sessions ? 'p_noSessionsMatch' : 'p_noGroupsMatch', normalizeName(el.field.value));
    }, 600);
}

/** text with the searched words in <mark> */
function marked(text) {
    return state.words.length ?
        segments(text, state.words).map((part) => (part.hit ? h('mark', {class: 'hit'}, part.text) : part.text)) :
        text;
}

/** group names and tab rows in the list, in order: ↑ ↓ move between them */
function listStops() {
    return Array.from(el.list.querySelectorAll('button.name, .tab-row'));
}

// buttons of a row (Open, new window, ⋯, Restore) and "Open window" of a session's windows
const ITEM_BUTTONS = '.row button:not(.name):not(.chev), .win-title button';

/**
 * Tab enters the list at one place: the focused group or tab, else the first one (↑ ↓ move it). From there Tab goes
 * through that item's buttons and on out of the list, not through every row.
 */
function setStop(stop) {
    const item = stop && stop.closest('.item');
    for (const node of el.list.querySelectorAll('button.name, .tab-row, ' + ITEM_BUTTONS)) {
        node.tabIndex = node === stop || (item && item.contains(node) && node.matches(ITEM_BUTTONS)) ? 0 : -1;
    }
}

/* ---------- rendering ---------- */

function sortedGroupKeys() {
    return Object.keys(state.groups).sort((a, b) => state.groups[b].index - state.groups[a].index);
}

/** saved groups for the list: all, only those not in sync, or by space in sync (biggest first, not synced last) */
function shownGroupKeys() {
    const keys = sortedGroupKeys();
    if (state.filter === 'unsynced') {
        return keys.filter((key) => state.groups[key].synced === false);
    }
    if (state.filter === 'biggest') {
        const bytes = (key) => {
            const size = sizeOf(key);
            return size === null ? -1 : size;
        };
        return keys.sort((a, b) => bytes(b) - bytes(a));
    }
    return keys;
}

function sortedSessionKeys() {
    return Object.keys(state.sessions).sort((a, b) => keyTime(b) - keyTime(a));
}

function groupName(key, group) {
    return group.name || numericDate(keyTime(key), state.options.date_format);
}

/**
 * "Current session, since 09:12", "Yesterday, 14:02–23:05", "Oct 11, 10:02–Oct 12, 01:51";
 * "Started Oct 9, 21:40" for sessions from 0.4.0, which don't know when they last changed
 */
function sessionName(key) {
    const start = keyTime(key);
    if (key === state.currentSession) {
        const today = new Date(start).toDateString() === new Date().toDateString();
        return t('p_currentSessionSince', today ? shortTime(start, lang) : dayTime(start, lang, undefined, false));
    }
    const updated = state.sessions[key].updated;
    return updated ? interval(start, updated, lang) : t('p_sessionStarted', dayTime(start, lang, undefined, false));
}

/** the element cuts its text off ("…") */
function isCut(node) {
    return node.scrollWidth > node.clientWidth;
}

// the question about icons from the sites was shown since the popup opened
let iconsAsked = false;

/** stores the answer about icons from the sites; the rows show it at once */
async function setSiteIcons(value) {
    state.options.site_icons = value;
    render();
    try {
        await chrome.storage.sync.set({site_icons: value});
    } catch (e) {
        console.error('TabHamster: option not saved', e);
    }
}

function askSiteIcons() {
    // not over another message: it would take its Undo away; a later drawing of the list asks
    if (iconsAsked || barShown()) {
        return;
    }
    iconsAsked = true;
    // what loading costs, in the words of Settings: the sites see the IP address
    const about = t('s_siteIcons_text');
    showBar([t('p_siteIcons_ask'), setTip(h('button', {class: 'bar-help', type: 'button', 'aria-label': about},
        icon('help', 16)), {text: about})], [
        {label: t('p_siteIcons_load'), run: () => setSiteIcons('load')},
        {label: t('p_siteIcons_no'), run: () => setSiteIcons('off')},
    ], {stay: true});
}

/** Chrome's icon, else the site's own /favicon.ico if allowed, else a globe */
function showFavicon(box, url, chromeSrc) {
    const site = chromeSrc ? null : siteIcon(url);
    const src = chromeSrc || (state.options.site_icons === 'load' ? site : null);
    if (!src) {
        box.replaceChildren(icon('globe', 14));
        if (site && state.options.site_icons === 'ask') {
            askSiteIcons();
        }
        return;
    }
    const img = h('img', {src, alt: '', width: 16, height: 16, referrerpolicy: 'no-referrer'});
    img.addEventListener('error', () => {
        if (src === site) {
            siteIconFailed(url);
        }
        box.replaceChildren(icon('globe', 14));
    }, {once: true});
    box.replaceChildren(img);
}

function favicon(url) {
    const box = h('span', {class: 'fav', 'aria-hidden': 'true'});
    const known = knownIcon(url);
    if (known !== undefined) {
        showFavicon(box, url, known);
    } else {
        // the box keeps its size meanwhile: nothing moves when the icon comes
        chromeIcon(url).then((src) => showFavicon(box, url, src));
    }
    return box;
}

// a saved group's tab row (its link) -> {key, index, tab}: what it showed, for Delete and F2
const rowTabs = new WeakMap();

/**
 * A tab of a group or session: a link that opens it. A saved group's tab (`at`: {key, index}) also has Edit and
 * Remove, shown over the end of the row on hover or when the row has the focus with keys (Delete, F2).
 */
function tabRow(tab, at) {
    const title = h('span', {class: 'tab-title ellipsis', dir: 'auto'}, marked(tab.title || tab.url));
    // only for a title the row cuts off: the full title and the address
    const link = setTip(h('a', {
        class: 'tab-row', href: tab.url, target: '_blank',
        dataset: at ? {key: at.key, index: String(at.index)} : {},
        'aria-keyshortcuts': at ? (isMac() ? 'Backspace F2' : 'Delete F2') : null,
        // a saved tab is dragged to another place (js/popup/drag.js), not as a link
        draggable: at ? 'false' : null,
    },
    favicon(tab.url),
    tab.pinned ? h('span', {class: 'pinned'}, icon('pin', 13, t('p_pinned'))) : null,
    title,
    h('span', {class: 'domain ellipsis'}, marked(hostOf(tab.url)))),
    {text: tab.title || tab.url, sub: tab.title ? tab.url : null, align: 'start', focus: false, quiet: true,
        when: () => isCut(title)});
    if (!at) {
        return h('div', {class: 'tab-item'}, link);
    }
    const shown = {key: at.key, index: at.index, tab};
    rowTabs.set(link, shown);
    // not Tab stops: the keys do the same on the focused row
    return h('div', {class: 'tab-item'}, link, h('div', {class: 'tab-actions'},
        setTip(h('button', {
            class: 'ib', type: 'button', tabindex: '-1', 'aria-label': t('p_editTab'),
            onClick: () => startTabEdit(at.key, shown),
        }, icon('pencil', 15)), {text: t('p_editTab'), keys: ['F2']}),
        setTip(h('button', {
            class: 'ib', type: 'button', tabindex: '-1', 'aria-label': t('p_removeTab'),
            onClick: act(() => removeTab(shown)),
        }, icon('close', 15)), {text: t('p_removeTab'), keys: [DELETE]})));
}

// saved groups and sessions both use tg_<ms> keys, so an id includes the view.
// `auto`: found through its tabs while searching, so open unless closed by hand
function isExpanded(id, auto) {
    return auto ? !state.searchClosed.has(id) : state.expanded.has(id);
}

function toggleItem(id, auto) {
    const set = auto ? state.searchClosed : state.expanded;
    if (set.has(id)) {
        set.delete(id);
    } else {
        set.add(id);
    }
    renderList();
}

// for the mouse: the name does the same and is the one keyboard stop (→ ← Space)
function chevron(id, auto) {
    const open = isExpanded(id, auto);
    return h('button', {
        class: 'chev', type: 'button', tabindex: -1, 'aria-hidden': 'true',
        onClick: single(() => toggleItem(id, auto)),
    }, icon(open ? 'chevronDown' : 'chevronRight', 14));
}

/**
 * The name of a group or session: a click (or Space) shows its tabs, Enter opens it (`open(event)`).
 * `newWindow`: Shift, Ctrl / ⌘ or middle click open it in a new window (nobody does that by accident).
 * dataset.toggle lets → ← in the list expand and collapse it. `sub`: the tooltip's second line (the row shows only
 * short details); `details`: what the row shows after the name, in words (screen readers).
 */
function nameButton(id, auto, label, sub, open, newWindow, details) {
    const button = h('button', {
        class: 'name ellipsis', type: 'button', dir: 'auto', 'aria-expanded': String(isExpanded(id, auto)),
        'aria-description': details.filter(Boolean).join(', '),
        dataset: {toggle: id, auto: auto ? '1' : ''},
        onClick: single((e) => (newWindow && wantsNewWindow(e) ? newWindow() : toggleItem(id, auto))),
        onAuxclick: single((e) => newWindow && e.button === 1 && newWindow()),
        onKeydown: (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                // not the button's own click
                e.preventDefault();
                // a held Enter repeats: open once
                if (!e.repeat) {
                    open(e);
                }
            }
        },
    }, marked(label));
    // only for a name the row cuts off; not on keyboard focus: ↑ ↓ go through the names one after another
    return setTip(button, {text: label, sub, bold: true, align: 'start', focus: false, quiet: true, when: isCut});
}

/** "9 tabs", or "2 of 9 tabs" for an item found through its tabs */
function tabCount(total, result, partial) {
    return partial ? plural('p_tabsMatching', total, [result.tabIndexes.length]) : plural('p_tabsCount', total);
}

/** a number in a column of the list ("9", "2/9" while searching); screen readers get the words */
function countMeta(column, shown, words, before) {
    return h('span', {class: ['meta', 'num', column]},
        before || null, h('span', {'aria-hidden': 'true'}, shown), h('span', {class: 'sr-only'}, words));
}

function tabsMeta(total, result, partial) {
    return countMeta('count', partial ? numbers.format(result.tabIndexes.length) + '/' + numbers.format(total) :
        numbers.format(total), tabCount(total, result, partial));
}

/**
 * The row's details, and its buttons: on hover they cover the end of the row, so nothing moves.
 * Each details column is as wide as its widest entry in the list (fitColumns).
 */
function rowEnd(details, actions) {
    return [h('div', {class: 'end-meta'}, details), actions];
}

// columns of the row details; fitColumns sets --w-<column> on the list
const COLUMNS = ['count', 'date', 'size', 'wins'];

function fitColumns() {
    for (const column of COLUMNS) {
        el.list.style.removeProperty('--w-' + column);
    }
    // all reads after the writes above: one layout
    const widths = {};
    for (const meta of el.list.querySelectorAll('.end-meta > .meta')) {
        const column = COLUMNS.find((c) => meta.classList.contains(c));
        if (column) {
            widths[column] = Math.max(widths[column] || 0, meta.getBoundingClientRect().width);
        }
    }
    for (const [column, width] of Object.entries(widths)) {
        el.list.style.setProperty('--w-' + column, Math.ceil(width) + 'px');
    }
}

// Shift+Enter on the group's name, or Shift-click on it or on Open
const NEW_WINDOW_TIP = {
    text: t('p_openNewWindow'), sub: t('p_tip_shiftClick', isMac() ? '⇧' : 'Shift'), keys: [keyCombo(['shift', 'enter'])],
};

/** ⋯ of a row; the menu key / Shift+F10 opens it too (no such key on a Mac) */
function moreButton(onOpen) {
    return setTip(h('button', {
        class: 'ib more', type: 'button', 'aria-label': t('p_moreActions'),
        'aria-haspopup': 'menu', 'aria-expanded': 'false',
        onClick: (e) => onOpen(e.currentTarget),
    }, icon('more', 16)), {text: t('p_moreActions'), keys: isMac() ? [] : [keyCombo(['shift', 'F10'])]});
}

function groupItem(result, target) {
    const key = result.key;
    const group = state.groups[key];
    const name = groupName(key, group);
    const partial = state.words.length > 0 && !result.byName;
    const open = (e) => (wantsNewWindow(e) ? openInNewWindow(group.tabs) : openInThisWindow(group.tabs));
    const item = h('div', {class: ['item', state.fresh === key && 'fresh', target && 'target'], dataset: {key}},
        state.renaming === key ? renameRow(key) : h('div', {class: 'row'},
            chevron('saved:' + key, partial),
            // the row shows only the number and a short date: the tooltip has the rest
            nameButton('saved:' + key, partial, name,
                plural('p_tabsCount', group.tabs.length) + ' · ' + fullDate(keyTime(key), lang), open,
                () => openInNewWindow(group.tabs), [
                    group.synced === false && t('p_notSynced_title'),
                    tabCount(group.tabs.length, result, partial),
                    state.filter === 'biggest' ? sizeMeta(key).textContent : fullDate(keyTime(key), lang),
                ]),
            group.synced === false ? h('span', {class: 'local'}, icon('notSynced', 16, t('p_notSynced_title'))) : null,
            rowEnd([
                tabsMeta(group.tabs.length, result, partial),
                state.filter === 'biggest' ? sizeMeta(key) : h('span', {class: 'meta date num'}, listDate(keyTime(key), lang)),
            ], h('div', {class: 'actions'},
                // the size is what "Biggest first" is about: it stays next to the buttons
                state.filter === 'biggest' ? sizeMeta(key) : null,
                setTip(h('button', {
                    class: 'open', type: 'button', onClick: single(open),
                    onAuxclick: single((e) => e.button === 1 && openInNewWindow(group.tabs)),
                }, t('p_open')), {text: t('p_openInThisWindow'), keys: [ENTER]}),
                setTip(h('button', {
                    class: 'ib', type: 'button', 'aria-label': t('p_openNewWindow'),
                    onClick: single(() => openInNewWindow(group.tabs)),
                }, icon('newWindow', 16)), NEW_WINDOW_TIP),
                moreButton((button) => groupMenu(key, button))))));
    const editing = state.editingTab && state.editingTab.key === key ? state.editingTab : null;
    if (isExpanded('saved:' + key, partial) || editing) {
        const indexes = partial ? result.tabIndexes : group.tabs.map((tab, i) => i);
        // the tab may have another place than when its editor was opened (an earlier change shown meanwhile)
        const edited = editing && editing.tab ? tabIndexIn(group.tabs, editing) : -1;
        const rows = indexes.map((i) => (i === edited ? tabEditor(key, editing) : tabRow(group.tabs[i], {key, index: i})));
        if (editing && !editing.tab) {
            rows.push(tabEditor(key, editing));
        }
        item.append(h('div', {class: 'tab-list'}, rows));
    }
    return item;
}

function sessionItem(result) {
    const key = result.key;
    const session = state.sessions[key];
    const current = key === state.currentSession;
    const partial = state.words.length > 0 && !result.byName;
    const windows = sessionWindows(session);
    const name = sessionName(key);
    const item = h('div', {class: 'item', dataset: {key}},
        h('div', {class: 'row'},
            current ? h('span', {class: 'live', 'aria-hidden': 'true'}) : chevron('sessions:' + key, partial),
            current ? setTip(h('span', {class: 'name ellipsis'}, marked(name)),
                {text: name, align: 'start', focus: false, quiet: true, when: isCut}) :
                nameButton('sessions:' + key, partial, name,
                    (windows.length > 1 ? plural('p_windowsCount', windows.length) + ' · ' : '') +
                    plural('p_tabsCount', session.tabs.length), () => restoreSession(session), null, [
                        windows.length > 1 && plural('p_windowsCount', windows.length),
                        tabCount(session.tabs.length, result, partial),
                    ]),
            rowEnd([
                // one window is the usual case: only the tabs then
                windows.length > 1 ? countMeta('wins', numbers.format(windows.length),
                    plural('p_windowsCount', windows.length), icon('window', 13)) : null,
                tabsMeta(session.tabs.length, result, partial),
            // the live session is open right now: nothing to restore
            ], current ? null : h('div', {class: 'actions'},
                setTip(h('button', {class: 'open', type: 'button', onClick: single(() => restoreSession(session))}, t('p_restore')),
                    {text: t('p_restore_tip'), keys: [ENTER]}),
                moreButton((button) => sessionMenu(key, button))))));
    if (!current && isExpanded('sessions:' + key, partial)) {
        const found = partial ? new Set(result.tabIndexes.map((i) => session.tabs[i])) : null;
        item.append(h('div', {class: 'tab-list'}, windows.map((tabs, i) => {
            const shown = found ? tabs.filter((tab) => found.has(tab)) : tabs;
            return shown.length ? [
                h('div', {class: 'win-title'}, icon('window', 14),
                    h('span', {class: 'spacer'}, plural('p_windowTitle', tabs.length, [i + 1])),
                    h('button', {class: 'link', type: 'button', onClick: single(() => openElsewhere('window', tabs))},
                        t('p_openWindow'))),
                shown.map((tab) => tabRow(tab)),
            ] : null;
        })));
    }
    return item;
}

function emptyState() {
    return h('div', {class: 'empty'},
        h('span', {class: 'empty-logo'}, logo(118)),
        h('h2', null, t('p_empty_title')),
        h('p', null, t('p_empty_text', keyLabel('enter'))),
        h('p', null, t('p_empty_sync')),
        h('a', {href: chrome.runtime.getURL('options.html#backup'), target: '_blank'}, t('p_empty_restore')));
}

function noMatches(sessions) {
    const query = normalizeName(el.field.value);
    return h('div', {class: 'no-match'},
        icon('searchOff', 34),
        h('h2', null, t(sessions ? 'p_noSessionsMatch' : 'p_noGroupsMatch', query)),
        h('p', null, plural('p_noMatch_text', state.openTabs, [keyLabel('enter')])));
}

/** what Enter will do to a group with the typed name, above the list */
function replaceNote(key) {
    const group = state.groups[key];
    // the name goes in bold: put a marker in its place, then split on it
    const MARK = '\uE000';
    const first = plural('p_replaceNote', group.tabs.length, [MARK]).split(MARK);
    const second = [plural('p_replaceNote_text', state.openTabs, [keyLabel('enter')])];
    const same = countByName(state.groups, group.name);
    if (same > 1) {
        second.push(' ' + plural('p_sameNameGroups', same));
    }
    return h('div', {class: 'note', role: 'status'},
        h('p', null, first[0], h('b', null, group.name), first.slice(1).join('')),
        h('p', null, second));
}

function renderTabs() {
    const sessionsOn = !!state.options.session_watcher;
    el.tabs.hidden = !sessionsOn;
    const saved = state.view === 'saved' || !sessionsOn;
    el.tabSaved.setAttribute('aria-selected', String(saved));
    el.tabSessions.setAttribute('aria-selected', String(!saved));
    // one Tab stop, ← → switch (el.tabs keydown)
    el.tabSaved.tabIndex = saved ? 0 : -1;
    el.tabSessions.tabIndex = saved ? -1 : 0;
    el.list.setAttribute('aria-labelledby', saved ? 'tab_saved' : 'tab_sessions');
    el.countSaved.textContent = String(state.results.saved.length);
    el.countSessions.textContent = String(state.results.sessions.length);
}

/**
 * What has the focus in the list, to give it back after the list is drawn again: {key} (a group or session: its name,
 * a button, a session's tab) or {key, shown, pos} (a saved tab's row: rowTabs, its place among the group's rows)
 */
function listFocus() {
    const node = document.activeElement;
    const item = el.list.contains(node) && node.closest('.item');
    if (!item) {
        return null;
    }
    const shown = rowTabs.get(node);
    return shown ? {key: item.dataset.key, shown, pos: Array.from(item.querySelectorAll('a.tab-row')).indexOf(node)} :
        {key: item.dataset.key};
}

/** the same saved tab gets the focus again, or the one now in its place (it was removed), or the group's name */
function restoreFocus(was) {
    if (!was) {
        return;
    }
    const item = el.list.querySelector('.item[data-key="' + CSS.escape(was.key) + '"]');
    const rows = was.shown && item ? Array.from(item.querySelectorAll('a.tab-row')) : [];
    const row = rows.find((node) => rowTabs.get(node) && sameTab(rowTabs.get(node).tab, was.shown.tab)) ||
        rows[Math.min(was.pos, rows.length - 1)];
    if (row) {
        row.focus();
    } else {
        focusName(was.key);
    }
}

function renderList() {
    closeMenu(false);
    // focus in a group comes back after the list is drawn again (Alt+↑ ↓ moves, reloads, a removed tab)
    const focused = listFocus();
    drawList();
    fitColumns();
    restoreFocus(focused);
    const stops = listStops();
    setStop(stops.includes(document.activeElement) ? document.activeElement : stops[0]);
}

/** draws one saved group's row again and leaves the rest of the list (and what the pointer is on) alone */
function redrawItem(key) {
    const item = el.list.querySelector('.item[data-key="' + CSS.escape(key) + '"]');
    runSearch();
    const result = state.results.saved.find((r) => r.key === key);
    if (!item || !result || !state.groups[key]) {
        return;
    }
    const focused = listFocus();
    const stop = listStops().find((node) => node.tabIndex === 0);
    const fresh = groupItem(result, item.classList.contains('target'));
    item.replaceWith(fresh);
    setStop(stop && stop.isConnected ? stop : fresh.querySelector('button.name'));
    if (focused && focused.key === key) {
        restoreFocus(focused);
    }
}

function drawList() {
    clear(el.list);
    if (state.view === 'sessions' && state.options.session_watcher) {
        const results = state.results.sessions;
        el.list.append(...(results.length || !state.words.length ? results.map(sessionItem) : [noMatches(true)]));
        return;
    }
    if (state.groupsError) {
        el.list.append(h('p', {class: 'message'}, t('p_loadError')));
        return;
    }
    if (!Object.keys(state.groups).length) {
        el.list.append(emptyState());
        return;
    }
    if (state.filter === 'unsynced') {
        el.list.append(unsyncedNote());
    } else if (state.filter === 'biggest' && state.usage) {
        el.list.append(h('p', {class: 'hint'}, t('p_biggestHint', usageKB())));
    }
    const results = state.results.saved;
    if (!results.length) {
        el.list.append(noMatches(false));
        return;
    }
    // a group with the typed name: Enter replaces it, so it comes first, under a note that says so
    const intent = saveIntent();
    const target = intent.kind === 'replace' ? intent.key : null;
    if (target) {
        el.list.append(replaceNote(target));
    }
    el.list.append(...results.filter((r) => r.key === target).concat(results.filter((r) => r.key !== target))
        .map((r) => groupItem(r, r.key === target)));
}

function settingsButton() {
    return setTip(h('button', {
        class: 'ib', type: 'button', 'aria-label': t('p_optionsBtn'),
        onClick: () => chrome.runtime.openOptionsPage(),
    }, icon('settings', 17)), {text: t('p_optionsBtn')});
}

function renderFooter() {
    clear(el.footer);
    if (state.view === 'sessions' && state.options.session_watcher) {
        el.footer.append(icon('computer', 14), h('span', {class: 'spacer'}, t('p_sessionsFooter')), settingsButton());
        return;
    }
    const usage = state.usage;
    if (usage) {
        const share = usage.quota ? usage.bytes / usage.quota : 0;
        const percent = share > 0 && share < 0.01 ? '<' + percents.format(0.01) : percents.format(Math.round(share * 100) / 100);
        // a cloud instead of words: "Sync storage" took a line of its own in longer languages
        el.footer.append(setTip(h('span', {class: 'storage'},
            icon('cloud', 18),
            h('div', {
                    class: ['meter', share >= 0.95 ? 'full' : share >= 0.8 ? 'warn' : ''],
                    role: 'img', 'aria-label': t('p_syncStorageUsed', percent),
                },
                h('span', {style: {width: Math.min(100, share * 100) + '%'}})),
            h('span', {class: 'num'}, percent)),
        {text: t('p_syncStorage_title', [kilobytes(usage.bytes, lang), kilobytes(usage.quota, lang, 0)])}));
    }
    el.footer.append(h('span', {class: 'spacer'}));
    const unsynced = waitingKeys().length;
    if (unsynced) {
        const pressed = state.filter === 'unsynced';
        el.footer.append(setTip(h('button', {
            class: 'not-synced', type: 'button', 'aria-pressed': String(pressed),
            onClick: () => setFilter(pressed ? null : 'unsynced'),
        }, icon('notSynced', 18), plural('p_notSyncedGroups', unsynced)), {text: t('p_showNotSynced')}));
    }
    el.footer.append(settingsButton());
}

function renderSave() {
    const intent = saveIntent();
    const label = intent.kind === 'replace' ? t('p_replaceGroup') :
        intent.name ? t('p_saveAs', intent.name) : plural('p_saveTabs', state.openTabs);
    el.clear.hidden = !el.field.value;
    clear(el.save);
    setTip(el.save, null);
    el.save.removeAttribute('aria-label');
    // while typing the field keeps room to type (css/popup.css) and "Save as “…”" can't fit a name in any language:
    // only "Save", "Replace" then (the name is in the field); the full label is the tooltip
    const short = !!intent.name;
    const text = h('span', {class: 'save-text'},
        short ? t(intent.kind === 'replace' ? 'p_replaceShort' : 'p_saveShort') : label);
    el.save.append(text, icon('enter', 14));
    // a chip in the field can leave room for no text at all: only the ↵ icon
    if (isCut(text)) {
        text.remove();
    }
    if (short || !text.isConnected) {
        el.save.setAttribute('aria-label', label);
        setTip(el.save, {text: label, keys: [ENTER]});
    }
    el.field.placeholder = t(state.filter ? 'p_field_placeholder_' + state.filter :
        Object.keys(state.groups).length || state.groupsError ? 'p_field_placeholder' : 'p_field_placeholder_first');
}

function renderFilter() {
    el.chip.hidden = !state.filter;
    el.fieldIcon.hidden = !!state.filter;
    el.chipText.textContent = state.filter ? t(state.filter === 'unsynced' ? 'p_filterUnsynced' : 'p_filterBiggest') : '';
}

// The list isn't drawn again while that would take away what is in use, but once that ends (renderIfWaiting): a drag
// (the dragged row), a rename or a tab edit (its input; the focusout would end it and save what was typed so far),
// a ⋯ menu, a mouse button held down (the click would land on nothing). The footer is drawn meanwhile, except during
// a drag or a press.
let renderWaits = false;
let pointerDown = false;

function render() {
    const dragging = document.body.classList.contains('dragging');
    // an editor's state without its editor (the item went away some other way) mustn't stop the list for good
    if ((state.renaming || state.editingTab) && !el.list.querySelector('.rename, .tab-editor')) {
        state.renaming = null;
        state.editingTab = null;
    }
    if (dragging || pointerDown || state.renaming || state.editingTab || document.querySelector('.menu')) {
        renderWaits = true;
        if (!dragging && !pointerDown) {
            renderFooter();
        }
        return;
    }
    renderWaits = false;
    // nothing waits for sync any more: back to all groups
    if (state.filter && !waitingKeys().length) {
        state.filter = null;
        state.sizes = null;
    }
    renderFilter();
    runSearch();
    renderTabs();
    renderList();
    renderFooter();
    renderSave();
}

/** draws what render() put off */
function renderIfWaiting() {
    if (renderWaits) {
        render();
    }
}

/* ---------- start ---------- */

function switchView(view) {
    state.view = view;
    if (view === 'sessions') {
        state.filter = null;
    }
    chrome.storage.sync.set({active_tab: view === 'sessions' ? '#sessions' : '#saved'});
    render();
}

// listen at once: Enter typed while the data is still loading must not be lost
el.field.addEventListener('keydown', (e) => {
    if (e.isComposing) {
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        // a held Enter repeats: one save
        if (!e.repeat) {
            save();
        }
    } else if (e.key === 'ArrowDown' && !e.altKey) {
        const first = listStops()[0];
        if (first) {
            e.preventDefault();
            first.focus();
        }
    } else if (e.key === 'Escape' && el.field.value) {
        // handled here, so Chrome doesn't close the popup; with an empty field Esc still closes it
        e.preventDefault();
        clearSearch();
    } else if ((e.key === 'Escape' || e.key === 'Backspace') && !el.field.value && state.filter) {
        // an empty field: Esc or Backspace removes the chip first
        e.preventDefault();
        setFilter(null);
    }
});
el.field.addEventListener('input', () => onQuery());
el.save.addEventListener('click', single(() => save()));
el.clear.addEventListener('click', () => clearSearch());

// ↑ ↓ between group names and tabs (Enter opens the focused one), ↑ from the first goes back to the field;
// → ← show and hide a group's tabs.
// Alt (Option) + ↑ ↓ moves the focused group, or the focused tab inside its group.
el.list.addEventListener('keydown', (e) => {
    // a saved group's tab: Delete (⌫ on a Mac) removes it, F2 edits it
    const tabAt = rowTabs.get(e.target);
    if (tabAt && (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'F2') && !e.repeat) {
        e.preventDefault();
        if (e.key === 'F2') {
            startTabEdit(tabAt.key, tabAt);
        } else {
            act(() => removeTab(tabAt))();
        }
        return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.altKey) {
        const item = e.target.closest && e.target.closest('.item');
        if (!item || !canReorder() || !item.querySelector(':scope > .row')) {
            return;
        }
        e.preventDefault();
        if (tabAt) {
            const group = state.groups[tabAt.key];
            const pos = tabAt.index + (e.key === 'ArrowUp' ? -1 : 1);
            if (group && pos >= 0 && pos < group.tabs.length) {
                moveTab(tabAt, pos);
            }
            return;
        }
        const keys = sortedGroupKeys();
        const pos = keys.indexOf(item.dataset.key) + (e.key === 'ArrowUp' ? -1 : 1);
        if (pos >= 0 && pos < keys.length) {
            moveGroup(item.dataset.key, pos);
        }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const stops = listStops();
        const i = stops.indexOf(document.activeElement);
        if (i === -1) {
            return;
        }
        e.preventDefault();
        const next = stops[i + (e.key === 'ArrowDown' ? 1 : -1)];
        (next || (e.key === 'ArrowUp' ? el.field : stops[i])).focus();
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.altKey) {
        // as in a tree: → shows a group's tabs, ← hides them; ← on a tab goes back to its group
        const target = document.activeElement;
        if (target.dataset && target.dataset.toggle) {
            e.preventDefault();
            const auto = !!target.dataset.auto;
            if (isExpanded(target.dataset.toggle, auto) !== (e.key === 'ArrowRight')) {
                toggleItem(target.dataset.toggle, auto);
            }
        } else if (e.key === 'ArrowLeft' && target.classList.contains('tab-row')) {
            const name = target.closest('.item').querySelector('button.name');
            if (name) {
                e.preventDefault();
                name.focus();
            }
        }
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        // the menu key (Shift+F10) opens the ⋯ menu of the focused group or session
        const row = e.target.closest && e.target.closest('.row');
        const more = row && row.querySelector('.more');
        if (more) {
            e.preventDefault();
            menuKeyAt = Date.now();
            more.click();
        }
    } else if (e.key === 'Escape' && el.field.value) {
        e.preventDefault();
        clearSearch();
    } else if (e.key === 'Escape' && state.filter) {
        e.preventDefault();
        setFilter(null);
        el.field.focus();
    }
});

// Chrome's own menu would follow the menu key's ⋯ menu
let menuKeyAt = 0;
el.list.addEventListener('contextmenu', (e) => {
    if (Date.now() - menuKeyAt < 1000) {
        e.preventDefault();
    }
});
el.list.addEventListener('focusin', (e) => {
    if (e.target.matches('button.name, .tab-row')) {
        setStop(e.target);
    }
});

// Saved groups / Sessions: ← → (Home, End) switch, as in other tab lists
el.tabs.addEventListener('keydown', (e) => {
    const views = {ArrowLeft: null, ArrowRight: null, Home: 'saved', End: 'sessions'};
    if (!(e.key in views) || !state.ready) {
        return;
    }
    e.preventDefault();
    const view = views[e.key] || (state.view === 'saved' ? 'sessions' : 'saved');
    if (view !== state.view) {
        switchView(view);
    }
    (view === 'saved' ? el.tabSaved : el.tabSessions).focus();
});

// Keys in use: the focused row looks selected, not the one under a resting pointer; moving the pointer takes over.
// Not :focus-visible: Chrome doesn't count focus that came from a click (Alt+↓ on a group just clicked).
document.addEventListener('keydown', (e) => {
    if (/^(Arrow|Tab$|Home$|End$)/.test(e.key)) {
        document.body.classList.add('keyboard');
    }
}, true);
document.addEventListener('pointermove', () => document.body.classList.remove('keyboard'), true);
document.addEventListener('pointerdown', () => document.body.classList.remove('keyboard'), true);
// render() waits while a button is down; drawn after the click (it comes right after pointerup)
document.addEventListener('pointerdown', () => {
    pointerDown = true;
}, true);
for (const type of ['pointerup', 'pointercancel']) {
    document.addEventListener(type, () => {
        pointerDown = false;
        setTimeout(renderIfWaiting);
    }, true);
}

async function start() {
    document.documentElement.lang = lang;
    // static texts are set here, before anything else is drawn (group names and titles are never translated)
    document.getElementById('field_label').textContent = t('p_field_label');
    el.field.placeholder = t('p_field_placeholder');
    el.tabSaved.prepend(t('p_tabName_Saved'));
    el.tabSessions.prepend(t('p_tabName_Sessions'));
    document.body.append(el.found);
    document.getElementById('logo').append(logo(46, 'TabHamster'));
    document.getElementById('field_icon').append(icon('search', 16));
    el.clear.setAttribute('aria-label', t('p_clearSearch'));
    setTip(el.clear, {text: t('p_clearSearch'), keys: [ESC]});
    el.clear.append(icon('close', 15));
    el.chipClear.setAttribute('aria-label', t('p_removeFilter'));
    setTip(el.chipClear, {text: t('p_removeFilter'), keys: [ESC]});
    el.chipClear.append(icon('close', 12));
    el.chipClear.addEventListener('click', () => {
        el.field.focus();
        setFilter(null);
    });

    state.options = await loadOptions();
    applyTheme(state.options.theme);
    state.view = state.options.active_tab === '#sessions' ? 'sessions' : 'saved';

    const [tabs, win] = await Promise.all([
        queryTabsToSave(), chrome.windows.getCurrent(), loadGroups(), loadSessions(), loadUsage()]);
    state.openTabs = tabs.length;
    state.windowId = win.id;
    render();
    state.ready = true;
    if (state.pendingSave) {
        state.pendingSave = false;
        save();
    }

    enableDrag(el.list, {
        enabled: canReorder,
        // the floating copy looks like the row (name, not-synced mark, count, date), without its buttons
        ghost: (item) => {
            const row = item.querySelector('.row').cloneNode(true);
            row.querySelector('.actions').remove();
            row.querySelectorAll('[data-toggle]').forEach((node) => node.removeAttribute('data-toggle'));
            // column widths are set on the list, the copy is outside it
            for (const column of ['count', 'date', 'size', 'wins']) {
                row.style.setProperty('--w-' + column, el.list.style.getPropertyValue('--w-' + column));
            }
            return row;
        },
        drop: moveGroup,
        // the floating copy of a tab: its row without Edit and Remove
        tabGhost: (item) => item.querySelector('.tab-row').cloneNode(true),
        dropTab,
        ended: renderIfWaiting,
    });
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.msg === 'groupsSynced' && !state.busy) {
            onGroupsSynced();
        }
    });
    el.tabSaved.addEventListener('click', () => switchView('saved'));
    el.tabSessions.addEventListener('click', () => switchView('sessions'));
}

start();
