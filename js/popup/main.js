// Popup: saved groups and sessions. Design: work-docs/design/boards (E), decisions: work-docs/PLAN.md section 7.
// Saved groups come from the group store in the background service worker (groupStoreClient),
// sessions from chrome.storage.local (written by the session watcher in js/background.js).

import {h, clear} from '../ui/dom.js';
import {icon, logo} from '../ui/icons.js';
import {t, plural, uiLanguage} from '../ui/i18n.js';
import {wantsNewWindow, keyLabel} from '../ui/platform.js';
import {keyTime, numericDate, shortDate, shortTime, dayTime, interval, hostOf, faviconUrl} from '../ui/format.js';
import {showBar} from '../ui/bar.js';
import {openMenu, closeMenu, isMenuOpen} from '../ui/menu.js';
import {normalizeName, findByName, countByName} from '../names.js';
import {parseQuery, segments, search} from '../search.js';
import {moveTo} from '../order.js';
import {enableDrag} from './drag.js';

const lang = uiLanguage();

const state = {
    options: null,
    groups: {},
    groupsError: null,
    sessions: {},
    currentSession: null,
    usage: null,
    openTabs: 0,
    view: 'saved',
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
    tabs: document.querySelector('.tabs'),
    tabSaved: document.getElementById('tab_saved'),
    tabSessions: document.getElementById('tab_sessions'),
    countSaved: document.getElementById('count_saved'),
    countSessions: document.getElementById('count_sessions'),
    list: document.getElementById('list'),
    footer: document.getElementById('footer'),
};

/* ---------- data ---------- */

async function loadOptions() {
    // global `storage` from js/storage.js
    return chrome.storage.sync.get(globalThis.storage.default_options);
}

async function loadGroups() {
    try {
        state.groups = await groupStoreClient.list();
        state.groupsError = null;
    } catch (e) {
        state.groups = {};
        state.groupsError = e;
    }
}

async function loadSessions() {
    const [local, session] = await Promise.all([
        chrome.storage.local.get(null),
        chrome.storage.session.get('session_id'),
    ]);
    // local storage also holds copies of saved groups (lg_) and store records; sessions are tg_ keys
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
        showBar(t('p_openFailed', (res && res.error) || ''));
        return false;
    }
    return true;
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
    const done = await Promise.all(sessionWindows(session).map((tabs) => openTabs('window', tabs)));
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

/** a tab as a saved group keeps it */
function savedTab(tab) {
    return tab.pinned ? {url: tab.url, title: tab.title, pinned: true} : {url: tab.url, title: tab.title};
}

function nextIndex() {
    return Object.values(state.groups).reduce((max, g) => Math.max(max, g.index || 0), 0) + 1;
}

/** second sentence of the bar when the group stayed on this computer */
function notSyncedNote(res) {
    if (res.synced) {
        return '';
    }
    return ' ' + t(/quota/i.test(res.error || '') ? 'p_notSyncedYet' : 'p_savedLocally_later');
}

async function afterChange(freshKey) {
    await Promise.all([loadGroups(), loadUsage()]);
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
}

/** Undo button for the bar: runs `undo`, then shows the groups as they are */
function undoAction(undo) {
    return {
        label: t('p_undo_btn'),
        run: async () => {
            try {
                await undo();
            } catch (e) {
                console.error('TabHamster: undo failed', e);
                showBar(t('p_syncStorageDefault_error'));
            }
            await afterChange(null);
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
        const tabs = (await queryTabsToSave()).map(savedTab);
        if (!tabs.length) {
            showBar(t('p_nothingToSave'));
            return;
        }
        const intent = saveIntent();
        let key;
        let text;
        let undo;
        if (intent.kind === 'replace') {
            key = intent.key;
            const before = state.groups[key];
            const res = await groupStoreClient.save(key, {name: before.name, index: before.index, tabs});
            text = plural('p_replaced', tabs.length, [groupName(key, before)]) + notSyncedNote(res);
            undo = () => groupStoreClient.save(key, {name: before.name, index: before.index, tabs: before.tabs});
        } else {
            key = 'tg_' + Date.now();
            const res = await groupStoreClient.save(key, {name: intent.name, index: nextIndex(), tabs});
            text = plural('p_savedAs', tabs.length, [intent.name || numericDate(keyTime(key), state.options.date_format)]) +
                notSyncedNote(res);
            undo = () => groupStoreClient.discard(key);
        }
        el.field.value = '';
        state.view = 'saved';
        state.expanded.delete('saved:' + key);
        await afterChange(key);
        showBar(text, undoAction(undo));
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

/** the group keeps its key, name and place, only its tabs change; the bar says `text` and can undo it */
async function setTabs(key, tabs, text) {
    const before = state.groups[key];
    const res = await groupStoreClient.save(key, {name: before.name, index: before.index, tabs});
    await afterChange(key);
    showBar(text + notSyncedNote(res),
        undoAction(() => groupStoreClient.save(key, {name: before.name, index: before.index, tabs: before.tabs})));
}

async function replaceWithOpenTabs(key) {
    const tabs = (await queryTabsToSave()).map(savedTab);
    if (!tabs.length) {
        showBar(t('p_nothingToSave'));
        return;
    }
    await setTabs(key, tabs, plural('p_replaced', tabs.length, [groupName(key, state.groups[key])]));
}

async function addTab(key, tab) {
    const group = state.groups[key];
    const name = groupName(key, group);
    if (group.tabs.some((saved) => saved.url === tab.url)) {
        showBar(t('p_alreadyInGroup', name));
        return;
    }
    await setTabs(key, group.tabs.concat(savedTab(tab)), t('p_tabAdded', [tab.title || tab.url, name]));
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
    await afterChange(null);
    // its row (and the focus with it) is gone
    if (document.activeElement === document.body) {
        el.field.focus();
    }
    showBar(t('p_deleted', name), undoAction(() => groupStoreClient.restore(key)));
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
    if (!group || !button.isConnected) {
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
        {icon: 'pencil', label: t('p_rename'), run: () => startRename(key)},
        '-',
        {icon: 'incognito', label: t('p_openIncognito'), run: () => openElsewhere('incognito', group.tabs)},
        {icon: 'copy', label: t('p_copyLinks'), run: () => copyLinks(group)},
        '-',
        {icon: 'trash', label: t('p_delete'), danger: true, run: act(() => deleteGroup(key))},
    ].filter(Boolean), {label: groupName(key, group), onClose: () => row.classList.remove('menu-open')});
}

/* ---------- order ---------- */

// moves show at once and are written one after another; the groups are read back after the last one
let moving = Promise.resolve();
let movesLeft = 0;

/** puts a group at `pos` among the others (0 = top); usually only its own index changes (js/order.js) */
function moveGroup(key, pos) {
    const changes = moveTo(sortedGroupKeys(), state.groups, key, pos);
    const items = {};
    for (const [k, index] of Object.entries(changes)) {
        const group = state.groups[k];
        state.groups[k] = Object.assign({}, group, {index});
        items[k] = {name: group.name, index, tabs: group.tabs};
    }
    render();
    movesLeft++;
    moving = moving.then(() => groupStoreClient.saveMany(items)).catch((e) => {
        console.error('TabHamster: move failed', e);
        showBar(t('p_syncStorageDefault_error'));
    }).then(() => (--movesLeft === 0 ? afterChange(null) : null));
}

/** the saved groups are shown (not sessions) and not filtered: only then can they be reordered */
function canReorder() {
    return (state.view === 'saved' || !state.options.session_watcher) && !state.words.length && !state.renaming;
}

/* ---------- session actions ---------- */

/** the name, or "name (2)", "name (3)"... if a group already has it */
function freeName(name) {
    let free = name;
    for (let n = 2; findByName(state.groups, free); n++) {
        free = name + ' (' + n + ')';
    }
    return free;
}

async function saveSessionAsGroup(key) {
    const session = state.sessions[key];
    const start = keyTime(key);
    // the session's dates, not "Yesterday": the name stays
    const name = freeName(session.updated ? interval(start, session.updated, lang, undefined, false) :
        dayTime(start, lang, undefined, false));
    const tabs = session.tabs.map(savedTab);
    const groupKey = 'tg_' + Date.now();
    const res = await groupStoreClient.save(groupKey, {name, index: nextIndex(), tabs});
    await afterChange(null);
    showBar(plural('p_savedAs', tabs.length, [name]) + notSyncedNote(res),
        undoAction(() => groupStoreClient.discard(groupKey)));
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
    ], {label: sessionName(key), onClose: () => row.classList.remove('menu-open')});
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
        spellcheck: 'false', 'aria-label': t('p_groupName_label'),
    });
    const error = h('div', {class: 'rename-error', id: 'rename_error', hidden: true});
    const ok = h('button', {class: 'ib', type: 'button', 'aria-label': t('p_saveName'), title: t('p_saveName')},
        icon('check', 16));
    const cancel = h('button', {class: 'ib', type: 'button', 'aria-label': t('p_cancelRename'), title: t('p_cancelRename')},
        icon('close', 15));
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
        if (commit && name !== group.name) {
            try {
                await groupStoreClient.save(key, {name, index: group.index, tabs: group.tabs});
            } catch (e) {
                console.error('TabHamster: rename failed', e);
                showBar(t('p_syncStorageDefault_error'));
            }
            await afterChange(null);
        } else {
            render();
        }
        if (refocus) {
            focusName(key);
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

/* ---------- search ---------- */

function runSearch() {
    const query = el.field.value;
    state.words = parseQuery(query);
    state.results.saved = search(sortedGroupKeys().map((key) => ({
        key, name: groupName(key, state.groups[key]), tabs: state.groups[key].tabs,
    })), query);
    state.results.sessions = search(sortedSessionKeys().map((key) => ({
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
}

/** text with the searched words in <mark> */
function marked(text) {
    return state.words.length ?
        segments(text, state.words).map((part) => (part.hit ? h('mark', {class: 'hit'}, part.text) : part.text)) :
        text;
}

/** group names and tab rows in the list, in order: ↑ ↓ move between them */
function listStops() {
    return Array.from(el.list.querySelectorAll('.name, .tab-row'));
}

/* ---------- rendering ---------- */

function sortedGroupKeys() {
    return Object.keys(state.groups).sort((a, b) => state.groups[b].index - state.groups[a].index);
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

function favicon(url) {
    const box = h('span', {class: 'fav', 'aria-hidden': 'true'});
    const img = h('img', {src: faviconUrl(url), alt: '', width: 16, height: 16});
    img.addEventListener('error', () => box.replaceChildren(icon('globe', 14)), {once: true});
    box.append(img);
    return box;
}

function tabRow(tab) {
    return h('a', {class: 'tab-row', href: tab.url, target: '_blank', title: tab.url},
        favicon(tab.url),
        tab.pinned ? h('span', {class: 'pinned'}, icon('pin', 13, t('p_pinned'))) : null,
        h('span', {class: 'tab-title ellipsis'}, marked(tab.title || tab.url)),
        h('span', {class: 'domain ellipsis'}, marked(hostOf(tab.url))));
}

// saved groups and sessions both use tg_<ms> keys, so an id includes the view.
// `auto`: found through its tabs while searching, so open unless closed by hand
function isExpanded(id, auto) {
    return auto ? !state.searchClosed.has(id) : state.expanded.has(id);
}

function chevron(id, auto) {
    const open = isExpanded(id, auto);
    return h('button', {
        class: 'chev', type: 'button', 'aria-expanded': String(open),
        'aria-label': t(open ? 'p_collapseGroup' : 'p_expandGroup'),
        onClick: () => {
            const set = auto ? state.searchClosed : state.expanded;
            if (set.has(id)) {
                set.delete(id);
            } else {
                set.add(id);
            }
            renderList();
        },
    }, icon(open ? 'chevronDown' : 'chevronRight', 14));
}

/** "9 tabs", or "2 of 9 tabs" for an item found through its tabs */
function tabCount(total, result, partial) {
    return partial ? plural('p_tabsMatching', total, [result.tabIndexes.length]) : plural('p_tabsCount', total);
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
            h('button', {
                class: 'name ellipsis', type: 'button', title: name, onClick: open,
                onAuxclick: (e) => e.button === 1 && openInNewWindow(group.tabs),
            }, marked(name)),
            group.synced === false ? h('span', {class: 'local'}, icon('notSynced', 14, t('p_notSynced_title'))) : null,
            h('span', {class: ['meta', 'num', partial && 'partial']}, tabCount(group.tabs.length, result, partial)),
            h('span', {class: 'meta date num'}, shortDate(keyTime(key), lang)),
            h('div', {class: 'actions'},
                h('button', {
                    class: 'open', type: 'button', onClick: open,
                    onAuxclick: (e) => e.button === 1 && openInNewWindow(group.tabs),
                }, t('p_open')),
                h('button', {
                    class: 'ib', type: 'button', 'aria-label': t('p_openNewWindow'), title: t('p_openNewWindow'),
                    onClick: () => openInNewWindow(group.tabs),
                }, icon('newWindow', 16)),
                h('button', {
                    class: 'ib more', type: 'button', 'aria-label': t('p_moreActions'), title: t('p_moreActions'),
                    'aria-haspopup': 'menu', 'aria-expanded': 'false',
                    onClick: (e) => groupMenu(key, e.currentTarget),
                }, icon('more', 16)))));
    if (isExpanded('saved:' + key, partial)) {
        const tabs = partial ? result.tabIndexes.map((i) => group.tabs[i]) : group.tabs;
        item.append(h('div', {class: 'tab-list'}, tabs.map(tabRow)));
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
            h('button', {
                class: 'name ellipsis', type: 'button', title: name,
                onClick: () => (current ? null : restoreSession(session)),
            }, marked(name)),
            h('span', {class: 'meta num'}, plural('p_windowsCount', windows.length)),
            h('span', {class: ['meta', 'date', 'num', partial && 'partial']},
                tabCount(session.tabs.length, result, partial)),
            // the live session is open right now: nothing to restore
            current ? null : h('div', {class: 'actions'},
                h('button', {class: 'open', type: 'button', onClick: () => restoreSession(session)}, t('p_restore')),
                h('button', {
                    class: 'ib more', type: 'button', 'aria-label': t('p_moreActions'), title: t('p_moreActions'),
                    'aria-haspopup': 'menu', 'aria-expanded': 'false',
                    onClick: (e) => sessionMenu(key, e.currentTarget),
                }, icon('more', 16)))));
    if (!current && isExpanded('sessions:' + key, partial)) {
        const found = partial ? new Set(result.tabIndexes.map((i) => session.tabs[i])) : null;
        item.append(h('div', {class: 'tab-list'}, windows.map((tabs, i) => {
            const shown = found ? tabs.filter((tab) => found.has(tab)) : tabs;
            return shown.length ? [
                h('div', {class: 'win-title'}, icon('window', 14),
                    h('span', {class: 'spacer'}, plural('p_windowTitle', tabs.length, [i + 1])),
                    h('button', {class: 'link', type: 'button', onClick: () => openElsewhere('window', tabs)},
                        t('p_openWindow'))),
                shown.map(tabRow),
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
    el.list.setAttribute('aria-labelledby', saved ? 'tab_saved' : 'tab_sessions');
    el.countSaved.textContent = String(state.results.saved.length);
    el.countSessions.textContent = String(state.results.sessions.length);
}

function renderList() {
    closeMenu(false);
    // the focused group name gets the focus back after the list is drawn again (Alt+↑ ↓ moves, reloads)
    const focused = document.activeElement && document.activeElement.classList.contains('name') &&
        el.list.contains(document.activeElement) ? document.activeElement.closest('.item').dataset.key : null;
    drawList();
    if (focused) {
        focusName(focused);
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
    return h('button', {
        class: 'ib', type: 'button', 'aria-label': t('p_optionsBtn'), title: t('p_optionsBtn'),
        onClick: () => chrome.runtime.openOptionsPage(),
    }, icon('settings', 17));
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
        const percent = share > 0 && share < 0.01 ? '<1%' : Math.round(share * 100) + '%';
        el.footer.append(
            h('span', null, t('p_syncStorage')),
            h('div', {
                    class: ['meter', share >= 0.95 ? 'full' : share >= 0.8 ? 'warn' : ''],
                    role: 'img', 'aria-label': t('p_syncStorageUsed', percent),
                },
                h('span', {style: {width: Math.min(100, share * 100) + '%'}})),
            h('span', {class: 'num'}, percent));
    }
    el.footer.append(h('span', {class: 'spacer'}));
    const unsynced = Object.values(state.groups).filter((g) => g.synced === false).length;
    if (unsynced) {
        el.footer.append(h('button', {class: 'not-synced', type: 'button'},
            icon('notSynced', 14), plural('p_notSyncedGroups', unsynced)));
    }
    el.footer.append(settingsButton());
}

function renderSave() {
    const intent = saveIntent();
    const label = intent.kind === 'replace' ? t('p_replaceGroup') :
        intent.name ? t('p_saveAs', intent.name) : plural('p_saveTabs', state.openTabs);
    el.clear.hidden = !el.field.value;
    clear(el.save);
    el.save.title = label;
    el.save.append(h('span', {class: 'ellipsis'}, label), icon('enter', 14));
    el.field.placeholder = t(Object.keys(state.groups).length || state.groupsError ?
        'p_field_placeholder' : 'p_field_placeholder_first');
}

function render() {
    runSearch();
    renderTabs();
    renderList();
    renderFooter();
    renderSave();
}

/* ---------- start ---------- */

function applyTheme(theme) {
    const value = theme === 'light' || theme === 'dark' ? theme : 'system';
    document.documentElement.setAttribute('data-theme', value);
    try {
        localStorage.setItem('theme', value);
    } catch (e) {
        // the boot script will follow the system next time
    }
}

function switchView(view) {
    state.view = view;
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
        save();
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
    }
});
el.field.addEventListener('input', () => onQuery());
el.save.addEventListener('click', () => save());
el.clear.addEventListener('click', () => clearSearch());

// ↑ ↓ between group names and tabs (Enter opens the focused one), ↑ from the first goes back to the field.
// Alt (Option) + ↑ ↓ moves the focused group.
el.list.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.altKey) {
        const item = e.target.closest && e.target.closest('.item');
        if (!item || !canReorder() || !item.querySelector(':scope > .row')) {
            return;
        }
        e.preventDefault();
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
    } else if (e.key === 'Escape' && el.field.value) {
        e.preventDefault();
        clearSearch();
    }
});

async function start() {
    document.documentElement.lang = lang;
    document.getElementById('logo').append(logo(46, 'TabHamster'));
    document.getElementById('field_icon').append(icon('search', 16));
    el.clear.setAttribute('aria-label', t('p_clearSearch'));
    el.clear.title = t('p_clearSearch');
    el.clear.append(icon('close', 15));

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
        ghost: (item) => {
            const group = state.groups[item.dataset.key];
            return [
                icon('grip', 16),
                h('span', {class: 'ellipsis'}, groupName(item.dataset.key, group)),
                h('span', {class: 'num'}, plural('p_tabsCount', group.tabs.length)),
            ];
        },
        drop: moveGroup,
    });
    el.tabSaved.addEventListener('click', () => switchView('saved'));
    el.tabSessions.addEventListener('click', () => switchView('sessions'));
}

start();
