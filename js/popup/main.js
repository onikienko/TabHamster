// Popup: saved groups and sessions. Design: work-docs/design/boards (E), decisions: work-docs/PLAN.md section 7.
// Saved groups come from the group store in the background service worker (groupStoreClient),
// sessions from chrome.storage.local (written by the session watcher in js/background.js).

import {h, clear} from '../ui/dom.js';
import {icon, logo} from '../ui/icons.js';
import {t, plural, uiLanguage} from '../ui/i18n.js';
import {wantsNewWindow} from '../ui/platform.js';
import {keyTime, numericDate, shortDate, shortTime, hostOf, faviconUrl} from '../ui/format.js';

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
};

const el = {
    field: document.getElementById('field'),
    save: document.getElementById('save'),
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

function openInThisWindow(tabs) {
    chrome.runtime.sendMessage({msg: 'openLinksInCurrentWindow', links: tabs});
}

function openInNewWindow(tabs) {
    chrome.runtime.sendMessage({msg: 'openLinksInNewWindow', links: tabs});
    window.close();
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

function restoreSession(session) {
    for (const tabs of sessionWindows(session)) {
        chrome.runtime.sendMessage({msg: 'openLinksInNewWindow', links: tabs});
    }
    window.close();
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

function sessionName(key) {
    const ms = keyTime(key);
    if (key === state.currentSession) {
        return t('p_currentSessionSince', shortTime(ms, lang));
    }
    return shortDate(ms, lang) + ', ' + shortTime(ms, lang);
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
        h('span', {class: 'tab-title ellipsis'}, tab.title || tab.url),
        h('span', {class: 'domain ellipsis'}, hostOf(tab.url)));
}

// saved groups and sessions both use tg_<ms> keys, so an id includes the view
function chevron(id) {
    const open = state.expanded.has(id);
    return h('button', {
        class: 'chev', type: 'button', 'aria-expanded': String(open),
        'aria-label': t(open ? 'p_collapseGroup' : 'p_expandGroup'),
        onClick: () => {
            if (open) {
                state.expanded.delete(id);
            } else {
                state.expanded.add(id);
            }
            renderList();
        },
    }, icon(open ? 'chevronDown' : 'chevronRight', 14));
}

function groupItem(key) {
    const group = state.groups[key];
    const name = groupName(key, group);
    const open = (e) => (wantsNewWindow(e) ? openInNewWindow(group.tabs) : openInThisWindow(group.tabs));
    const item = h('div', {class: 'item', dataset: {key}},
        h('div', {class: 'row'},
            chevron('saved:' + key),
            h('button', {
                class: 'name ellipsis', type: 'button', title: name, onClick: open,
                onAuxclick: (e) => e.button === 1 && openInNewWindow(group.tabs),
            }, name),
            group.synced === false ? h('span', {class: 'local'}, icon('notSynced', 14, t('p_notSynced_title'))) : null,
            h('span', {class: 'meta num'}, plural('p_tabsCount', group.tabs.length)),
            h('span', {class: 'meta date num'}, shortDate(keyTime(key), lang)),
            h('div', {class: 'actions'},
                h('button', {class: 'open', type: 'button', onClick: () => openInThisWindow(group.tabs)}, t('p_open')),
                h('button', {
                    class: 'ib', type: 'button', 'aria-label': t('p_openNewWindow'), title: t('p_openNewWindow'),
                    onClick: () => openInNewWindow(group.tabs),
                }, icon('newWindow', 16)))));
    if (state.expanded.has('saved:' + key)) {
        item.append(h('div', {class: 'tab-list'}, group.tabs.map(tabRow)));
    }
    return item;
}

function sessionItem(key) {
    const session = state.sessions[key];
    const current = key === state.currentSession;
    const windows = sessionWindows(session);
    const name = sessionName(key);
    const item = h('div', {class: 'item', dataset: {key}},
        h('div', {class: 'row'},
            current ? h('span', {class: 'live', 'aria-hidden': 'true'}) : chevron('sessions:' + key),
            h('button', {
                class: 'name ellipsis', type: 'button', title: name,
                onClick: () => (current ? null : restoreSession(session)),
            }, name),
            h('span', {class: 'meta num'}, plural('p_windowsCount', windows.length)),
            h('span', {class: 'meta date num'}, plural('p_tabsCount', session.tabs.length)),
            current ? null : h('div', {class: 'actions'},
                h('button', {class: 'open', type: 'button', onClick: () => restoreSession(session)}, t('p_open')))));
    if (!current && state.expanded.has('sessions:' + key)) {
        item.append(h('div', {class: 'tab-list'}, windows.map((tabs, i) => [
            h('div', {class: 'win-title'}, icon('window', 14),
                t('p_window_text') + ' ' + (i + 1) + ', ' + plural('p_tabsCount', tabs.length)),
            tabs.map(tabRow),
        ])));
    }
    return item;
}

function renderTabs() {
    const sessionsOn = !!state.options.session_watcher;
    el.tabs.hidden = !sessionsOn;
    const saved = state.view === 'saved' || !sessionsOn;
    el.tabSaved.setAttribute('aria-selected', String(saved));
    el.tabSessions.setAttribute('aria-selected', String(!saved));
    el.list.setAttribute('aria-labelledby', saved ? 'tab_saved' : 'tab_sessions');
    el.countSaved.textContent = String(Object.keys(state.groups).length);
    el.countSessions.textContent = String(Object.keys(state.sessions).length);
}

function renderList() {
    clear(el.list);
    if (state.view === 'sessions' && state.options.session_watcher) {
        el.list.append(...sortedSessionKeys().map(sessionItem));
        return;
    }
    if (state.groupsError) {
        el.list.append(h('p', {class: 'message'}, t('p_loadError')));
        return;
    }
    el.list.append(...sortedGroupKeys().map(groupItem));
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
    clear(el.save);
    el.save.append(h('span', {class: 'ellipsis'}, plural('p_saveTabs', state.openTabs)), icon('enter', 14));
}

function render() {
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

async function start() {
    document.documentElement.lang = lang;
    document.getElementById('logo').append(logo(46, 'TabHamster'));
    document.getElementById('field_icon').append(icon('search', 16));

    state.options = await loadOptions();
    applyTheme(state.options.theme);
    state.view = state.options.active_tab === '#sessions' ? 'sessions' : 'saved';

    const [tabs] = await Promise.all([queryTabsToSave(), loadGroups(), loadSessions(), loadUsage()]);
    state.openTabs = tabs.length;
    render();

    el.tabSaved.addEventListener('click', () => switchView('saved'));
    el.tabSessions.addEventListener('click', () => switchView('sessions'));
}

start();
