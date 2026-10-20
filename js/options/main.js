// Settings page. Design: work-docs/design/boards/Settings.dc.html, decisions: work-docs/PLAN.md sections 7 and 8 (M8).
// Options live in chrome.storage.sync (defaults in js/storage.js) and apply as soon as they change.
// Saved groups, Recently deleted and backups go through the group store in the background (groupStoreClient).

import {h, clear} from '../ui/dom.js';
import {icon, logo} from '../ui/icons.js';
import {t, plural, uiLanguage} from '../ui/i18n.js';
import {keyLabel} from '../ui/platform.js';
import {keyTime, numericDate, dayTime, kilobytes} from '../ui/format.js';
import {showBar} from '../ui/bar.js';
import {applyTheme} from '../ui/theme.js';
import {backupRows, renderRestoreInfo} from './backup.js';

const lang = uiLanguage();
const GITHUB = 'https://github.com/onikienko/TabHamster';
const PRIVACY = 'https://onikienko.github.io/browser-extensions/privacy-policy';
// waiting groups named in the sync section; the rest are counted
const NAMES_SHOWN = 3;

const state = {
    options: null,
    groups: {},
    usage: null,
    trash: [],
    // the restore that can be undone: {time, restored, trashed} or null
    restore: null,
};

const el = {
    nav: document.getElementById('nav'),
    main: document.getElementById('main'),
    sync: h('div', {class: 'sync'}),
    trash: h('div', {class: 'trash'}),
};

// controls showing an option: each one redraws itself from state.options
const updaters = [];

/* ---------- data ---------- */

async function loadOptions() {
    // global `storage` from js/storage.js
    state.options = await chrome.storage.sync.get(globalThis.storage.default_options);
}

/** groups, sync usage, Recently deleted and the last restore, then draws what shows them */
async function loadGroups() {
    const [groups, usage, trash, restore] = await Promise.all([
        groupStoreClient.list().catch(() => ({})),
        groupStoreClient.usage().catch(() => null),
        groupStoreClient.listTrash().catch(() => []),
        groupStoreClient.restoreInfo().catch(() => null),
    ]);
    Object.assign(state, {groups, usage, trash, restore});
    renderSync();
    renderTrash();
    renderRestoreInfo(state.restore);
}

/** after a restore or its undo: options and groups both changed */
async function reloadAll() {
    await loadOptions();
    applyTheme(state.options.theme);
    renderOptions();
    await loadGroups();
}

/** name of a group as the popup shows it: its own, or the date it was saved */
function groupName(key, group) {
    return group.name || numericDate(keyTime(key), state.options.date_format);
}

/* ---------- options ---------- */

function renderOptions() {
    updaters.forEach((update) => update());
}

async function setOption(name, value) {
    const before = state.options[name];
    if (before === value) {
        return;
    }
    state.options[name] = value;
    if (name === 'theme') {
        applyTheme(value);
    }
    renderOptions();
    try {
        await chrome.storage.sync.set({[name]: value});
    } catch (e) {
        console.error('TabHamster: option not saved', e);
        state.options[name] = before;
        if (name === 'theme') {
            applyTheme(before);
        }
        renderOptions();
        showBar(t('s_optionFailed'));
    }
}

/** label and description on the left, the control on the right; `labelFor` makes the title a <label> */
function row(titleId, title, text, control, labelFor) {
    return h('div', {class: 'row'},
        h('div', {class: 'row-label'},
            h(labelFor ? 'label' : 'span', {class: 'row-title', id: titleId, for: labelFor}, title),
            text ? h('p', {class: 'row-text'}, text) : null),
        control);
}

/** on/off option stored as 1 / 0 (like 0.3.0 did) */
function switchControl(name, labelId) {
    const button = h('button', {
        class: 'switch', type: 'button', role: 'switch', 'aria-labelledby': labelId,
        onClick: () => setOption(name, state.options[name] ? 0 : 1),
    }, h('span', {class: 'knob'}));
    updaters.push(() => button.setAttribute('aria-checked', String(!!state.options[name])));
    return button;
}

function themeControl(labelId) {
    const buttons = ['system', 'light', 'dark'].map((value) => h('button', {
        class: 'seg-item', type: 'button', role: 'radio', dataset: {value},
        onClick: () => setOption('theme', value),
    }, t('s_theme_' + value)));
    const group = h('div', {class: 'seg', role: 'radiogroup', 'aria-labelledby': labelId}, buttons);
    // arrows move the choice, like native radio buttons
    group.addEventListener('keydown', (e) => {
        const steps = {ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1};
        const index = buttons.indexOf(document.activeElement);
        let next = null;
        if (e.key in steps) {
            next = (index + steps[e.key] + buttons.length) % buttons.length;
        } else if (e.key === 'Home' || e.key === 'End') {
            next = e.key === 'Home' ? 0 : buttons.length - 1;
        }
        if (next !== null && index !== -1) {
            e.preventDefault();
            setOption('theme', buttons[next].dataset.value);
            buttons[next].focus();
        }
    });
    updaters.push(() => {
        const current = state.options.theme === 'light' || state.options.theme === 'dark' ? state.options.theme : 'system';
        buttons.forEach((button) => {
            const on = button.dataset.value === current;
            button.setAttribute('aria-checked', String(on));
            button.tabIndex = on ? 0 : -1;
        });
    });
    return group;
}

/** the two formats shown as today's date in them */
function dateFormatControl(id) {
    const now = Date.now();
    const select = h('select', {class: 'select', id, onChange: () => setOption('date_format', select.value)},
        h('option', {value: 'eu'}, t('s_dateFormat_dayFirst', numericDate(now, 'eu'))),
        h('option', {value: 'us'}, t('s_dateFormat_yearFirst', numericDate(now, 'us'))));
    updaters.push(() => {
        select.value = state.options.date_format === 'us' ? 'us' : 'eu';
    });
    return select;
}

/* ---------- sections ---------- */

const SECTIONS = [
    {id: 'general', title: 's_general', build: general},
    {id: 'saving', title: 's_saving', build: saving},
    {id: 'sync', title: 's_sync', build: () => [el.sync]},
    {id: 'backup', title: 's_backup', build: () => backupRows({reloadAll})},
    {id: 'deleted', title: 'o_trash_legend', build: deleted},
    {id: 'help', title: 'o_tabs_help', build: help},
    {id: 'about', title: 'o_tabs_about', build: about},
];

function general() {
    return [
        row('theme_label', t('s_theme'), t('s_theme_text'), themeControl('theme_label')),
        row('date_label', t('o_dateFormat_text'), t('s_dateFormat_text'), dateFormatControl('date_format'), 'date_format'),
        row('sessions_label', t('s_sessions'), t('s_sessions_text'), switchControl('session_watcher', 'sessions_label')),
    ];
}

function saving() {
    return [
        row('cur_win_label', t('s_curWin'), t('s_curWin_text'), switchControl('cur_win', 'cur_win_label')),
        row('pinned_label', t('o_savedTabs_pinned'), t('s_pinned_text'), switchControl('pinned', 'pinned_label')),
    ];
}

/** "Tax return, Trip, Work and 2 more" */
function nameList(keys) {
    const names = keys.slice(0, NAMES_SHOWN).map((key) => '“' + groupName(key, state.groups[key]) + '”');
    if (keys.length > NAMES_SHOWN) {
        names.push(t('s_andMore', keys.length - NAMES_SHOWN));
    }
    try {
        return new Intl.ListFormat(lang, {type: 'conjunction'}).format(names);
    } catch (e) {
        return names.join(', ');
    }
}

// meter and numbers as in the popup footer, the explanation, and the groups waiting for room
function renderSync() {
    const box = clear(el.sync);
    const usage = state.usage;
    const keys = Object.keys(state.groups);
    const tabs = keys.reduce((sum, key) => sum + state.groups[key].tabs.length, 0);
    if (usage) {
        const share = usage.quota ? usage.bytes / usage.quota : 0;
        const percent = share > 0 && share < 0.01 ? '<1%' : Math.round(share * 100) + '%';
        box.append(
            h('div', {class: 'usage'},
                icon('cloud', 18),
                h('span', {class: 'usage-used num'},
                    t('s_syncUsed', [kilobytes(usage.bytes, lang), kilobytes(usage.quota, lang, 0)])),
                h('span', {class: 'usage-count num'},
                    plural('s_groupsCount', keys.length) + ', ' + plural('p_tabsCount', tabs))),
            h('div', {
                    class: ['meter', share >= 0.95 ? 'full' : share >= 0.8 ? 'warn' : ''],
                    role: 'img', 'aria-label': t('p_syncStorageUsed', percent),
                },
                h('span', {style: {width: Math.min(100, share * 100) + '%'}})));
    }
    box.append(h('p', {class: 'text'}, t('s_sync_text', usage ? kilobytes(usage.quota, lang, 0) : '100')));
    const waiting = keys.filter((key) => state.groups[key].synced === false)
        .sort((a, b) => state.groups[b].index - state.groups[a].index);
    if (waiting.length) {
        box.append(h('div', {class: 'note warn'},
            icon('notSynced', 18),
            h('div', null,
                h('p', {class: 'note-title'}, plural('s_unsynced', waiting.length, [nameList(waiting)])),
                h('p', null, plural('s_unsyncedHint', waiting.length)))));
    }
}

function deleted() {
    return [el.trash, h('p', {class: 'text after'}, t('o_trash_info'))];
}

async function restoreGroup(group, button) {
    const name = groupName(group.key, group);
    button.disabled = true;
    try {
        const res = await groupStoreClient.restore(group.key);
        await loadGroups();
        showBar(t('s_groupRestored', name) + (res.synced ? '' :
            ' ' + t(/quota/i.test(res.error || '') ? 'p_notSyncedYet' : 'p_savedLocally_later')));
    } catch (e) {
        console.error('TabHamster: restore failed', e);
        button.disabled = false;
        showBar(t('p_syncStorageDefault_error'));
    }
}

function trashRow(group) {
    const name = groupName(group.key, group);
    const meta = [plural('p_tabsCount', group.tabs.length), dayTime(group.trashed, lang)];
    if (group.by === 'sync') {
        meta.push(t('s_deletedElsewhere'));
    } else if (group.by === 'restore') {
        meta.push(t('s_deletedByRestore'));
    }
    const button = h('button', {class: 'btn tonal', type: 'button', 'aria-label': t('s_restoreGroup', name)},
        t('o_trash_restoreButton'));
    button.addEventListener('click', () => restoreGroup(group, button));
    return h('li', {class: 'row'},
        h('div', {class: 'row-label'},
            h('span', {class: 'row-title ellipsis', title: name}, name),
            h('p', {class: 'row-text'}, meta.join(' · '))),
        button);
}

function renderTrash() {
    const box = clear(el.trash);
    if (!state.trash.length) {
        box.append(h('p', {class: 'row empty'}, t('o_trash_empty')));
        return;
    }
    box.append(h('ul', {class: 'rows'}, state.trash.map(trashRow)));
}

function help() {
    const enter = keyLabel('enter');
    const tips = [
        [enter, t('s_help_enter')],
        [t('s_help_typeKey'), t('s_help_type')],
        [t('s_help_downKey', enter), t('s_help_down')],
        [t('s_help_clickKey'), t('s_help_click', enter)],
        [t('s_help_shiftKey', keyLabel('shift')), t('s_help_shift')],
        ['→ ←', t('s_help_arrows')],
        [t('s_help_moveKey', keyLabel('alt')), t('s_help_move')],
        [keyLabel('esc'), t('s_help_esc')],
        ['⋯', t('s_help_more')],
        [t('s_help_sessionsKey'), t('s_help_sessions')],
    ];
    return [h('dl', {class: 'keys'}, tips.map(([key, text]) => h('div', {class: 'row'},
        h('dt', null, key), h('dd', null, text))))];
}

// translators of the store texts and the extension, by language
const TRANSLATORS = [
    ['es', 'Martin Irigaray', 'https://github.com/martinib77'],
    ['hu', 'Zoltan Mihics', 'https://github.com/Med1on'],
    ['fr', 'Aurélien Léger', 'https://github.com/Dexyne'],
    ['sr', 'Sijera', null],
];

function languageName(code) {
    try {
        const name = new Intl.DisplayNames([lang], {type: 'language'}).of(code);
        return name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
    } catch (e) {
        return code;
    }
}

function person(name, url) {
    return url ? h('a', {href: url, target: '_blank', rel: 'noopener'}, name) : name;
}

function about() {
    return [
        h('p', {class: 'about-text'}, t('s_about_free'), ' ',
            h('a', {href: GITHUB, target: '_blank', rel: 'noopener'}, t('s_about_source')), ' · ',
            h('a', {href: PRIVACY, target: '_blank', rel: 'noopener'}, t('s_about_privacy'))),
        h('dl', {class: 'credits'},
            h('dt', null, t('s_about_translations')),
            h('dd', null, TRANSLATORS.map(([code, name, url], i) =>
                [i ? ', ' : '', languageName(code) + ': ', person(name, url)])),
            h('dt', null, t('s_about_thanks')),
            h('dd', null, person('Ricardo J. Barberis', 'https://github.com/richarson'))),
        h('p', {class: 'ukraine'}, h('span', {class: 'flag', 'aria-hidden': 'true'}), t('s_about_ukraine')),
    ];
}

/* ---------- page ---------- */

function build() {
    el.nav.setAttribute('aria-label', t('s_nav'));
    for (const section of SECTIONS) {
        el.nav.append(h('a', {href: '#' + section.id, dataset: {section: section.id}}, t(section.title)));
        el.main.append(h('section', {id: section.id, 'aria-labelledby': section.id + '_title'},
            h('h2', {id: section.id + '_title'}, t(section.title)),
            section.build()));
    }
}

// the side menu marks the section at the top of the window
function watchSections() {
    const links = [...el.nav.querySelectorAll('a')];
    const mark = (id) => links.forEach((link) =>
        link.setAttribute('aria-current', String(link.dataset.section === id)));
    const update = () => {
        const sections = [...el.main.querySelectorAll('section')];
        // at the bottom of the page the last sections can't reach the top: mark the last one
        const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
        let current = sections[0];
        for (const section of sections) {
            if (section.getBoundingClientRect().top <= 80) {
                current = section;
            }
        }
        mark(atEnd ? sections[sections.length - 1].id : current.id);
    };
    window.addEventListener('scroll', update, {passive: true});
    window.addEventListener('resize', update);
    update();
}

let groupsTimer = null;

function listenForChanges() {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') {
            return;
        }
        const defaults = globalThis.storage.default_options;
        let options = false;
        for (const name of Object.keys(changes)) {
            if (defaults.hasOwnProperty(name)) {
                const value = changes[name].newValue;
                state.options[name] = value === undefined ? defaults[name] : value;
                options = true;
            }
        }
        if (options) {
            applyTheme(state.options.theme);
            renderOptions();
        }
        // groups changed here or on another computer: the background catches up first
        if (Object.keys(changes).some((name) => /^t[gc]_/.test(name))) {
            clearTimeout(groupsTimer);
            groupsTimer = setTimeout(loadGroups, 800);
        }
    });
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.msg === 'groupsSynced') {
            loadGroups();
        }
    });
}

async function start() {
    document.documentElement.lang = lang;
    document.title = t('s_title');
    document.getElementById('title').textContent = t('s_title');
    document.getElementById('logo').append(logo(46, 'TabHamster'));
    document.getElementById('version').textContent = t('s_version', chrome.runtime.getManifest().version);

    await loadOptions();
    applyTheme(state.options.theme);
    build();
    renderOptions();
    await loadGroups();
    listenForChanges();
    watchSections();
    // the page is built after load, so the browser couldn't jump to the section itself (popup: #backup)
    const target = location.hash && document.getElementById(location.hash.slice(1));
    if (target) {
        target.scrollIntoView({behavior: 'instant'});
    }
}

start();
