// Backup and restore rows of the Settings page: download or copy the backup, restore from a file or pasted text
// (shown first as a preview, restored on a second click), and undo of the last restore.
// The backup itself is made and read in the background (js/backup.js through groupStoreClient).

import {h, clear} from '../ui/dom.js';
import {icon} from '../ui/icons.js';
import {t, plural, uiLanguage} from '../ui/i18n.js';
import {dayTime} from '../ui/format.js';
import {showBar} from '../ui/bar.js';

const lang = uiLanguage();
const ERRORS = {
    not_backup: 'o_backup_error_notBackup',
    damaged: 'o_backup_error_damaged',
    empty: 'o_backup_error_empty',
};
const COPIED_MS = 2000;

const el = {
    // under the Restore row: pasted text, the preview or an error
    panel: h('div', {class: 'panel', hidden: true}),
    // the restore that can be undone
    undo: h('div', {class: 'row undo', hidden: true}),
    // under it: what undoing it does, before it is done
    undoPanel: h('div', {class: 'panel', hidden: true}),
};

let ctx = null;
// the button that opened the restore panel ("Choose file" or "Paste text instead"): the focus goes back to it
let opener = null;
let chooseButton = null;

/* ---------- back up ---------- */

function today() {
    const now = new Date();
    return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
}

async function download() {
    try {
        const text = await groupStoreClient.exportBackup();
        const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
        const link = h('a', {href: url, download: 'tabhamster-backup-' + today() + '.json'});
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
        console.error('TabHamster: backup failed', e);
        showBar(t('p_syncStorageDefault_error'));
    }
}

// The text comes from the background: a ClipboardItem with a promise keeps the click's permission to copy
// while it is on its way.
async function copyText(button) {
    const text = groupStoreClient.exportBackup();
    try {
        if (globalThis.ClipboardItem && navigator.clipboard.write) {
            await navigator.clipboard.write([new ClipboardItem({
                'text/plain': text.then((value) => new Blob([value], {type: 'text/plain'})),
            })]);
        } else {
            await navigator.clipboard.writeText(await text);
        }
    } catch (e) {
        console.error('TabHamster: copy failed', e);
        showBar(t('s_copyFailed'));
        return;
    }
    button.replaceChildren(icon('check', 14), t('s_copied'));
    clearTimeout(button.timer);
    button.timer = setTimeout(() => button.replaceChildren(t('s_copyText')), COPIED_MS);
}

/* ---------- restore ---------- */

/** focus: back to the button that opened the panel (a removed button would leave the focus nowhere) */
function closePanel(focus = true) {
    clear(el.panel).hidden = true;
    if (focus && opener && opener.isConnected) {
        opener.focus();
    }
}

function errorText(code) {
    return t(ERRORS[code] || 'o_backup_error_other');
}

/** the backup's text, then a preview of what restoring it does; `source`: file name, or null for pasted text */
async function preview(text, source) {
    let res;
    try {
        res = await groupStoreClient.previewBackup(text);
    } catch (e) {
        console.error('TabHamster: backup preview failed', e);
        res = {error: 'other'};
    }
    clear(el.panel).hidden = false;
    if (res.error) {
        el.panel.append(
            h('p', {class: 'error', role: 'alert'}, errorText(res.error)),
            h('div', {class: 'panel-buttons'},
                source === null ? h('button', {class: 'btn plain', type: 'button', onClick: () => pasteBox(text)},
                    t('s_editText')) : null,
                h('button', {class: 'btn tonal', type: 'button', onClick: () => closePanel()}, t('s_cancel'))));
        return;
    }
    const contents = res.groups ?
        plural('s_groupsCount', res.groups) + ', ' + plural('p_tabsCount', res.tabs) +
        (res.options ? ', ' + t('s_preview_andSettings') : '') :
        t('s_preview_settingsOnly');
    let effect = '';
    if (res.groups && res.trashed) {
        effect = plural('s_preview_trashed', res.trashed);
    } else if (res.groups && res.current) {
        effect = t('s_preview_replaced');
    } else if (!res.groups) {
        effect = t('s_preview_groupsStay');
    }
    const restoreButton = h('button', {class: 'btn primary', type: 'button'}, t('o_trash_restoreButton'));
    restoreButton.addEventListener('click', () => restore(text, restoreButton));
    el.panel.append(
        h('p', {class: 'panel-title ellipsis'}, source || t('s_pastedText')),
        h('p', {class: 'num'}, contents),
        effect ? h('p', {class: 'muted'}, effect) : null,
        h('div', {class: 'panel-buttons'},
            h('button', {class: 'btn tonal', type: 'button', onClick: () => closePanel()}, t('s_cancel')),
            restoreButton));
    restoreButton.focus();
}

async function restore(text, button) {
    button.disabled = true;
    let res;
    try {
        res = await groupStoreClient.importBackup(text);
    } catch (e) {
        console.error('TabHamster: restore failed', e);
        res = {error: 'other'};
    }
    if (res.error) {
        button.disabled = false;
        showBar(errorText(res.error));
        return;
    }
    closePanel(false);
    await ctx.reloadAll();
    // the restore can be undone from its row too: the focus goes there
    const undoButton = el.undo.querySelector('button');
    if (undoButton) {
        undoButton.focus();
    }
    showBar(res.groups ? plural('s_restored', res.groups) : t('o_backup_restored'),
        {label: t('p_undo_btn'), run: undoRestore});
}

async function undoRestore() {
    try {
        const res = await groupStoreClient.undoRestore();
        await ctx.reloadAll();
        // its row is gone with the focus in it
        if (!el.undo.contains(document.activeElement) && chooseButton && document.activeElement === document.body) {
            chooseButton.focus();
        }
        if (!res.error) {
            showBar(t('o_backup_undone'));
        }
    } catch (e) {
        console.error('TabHamster: undo restore failed', e);
        showBar(t('o_backup_error_other'));
    }
}

function pasteBox(text) {
    const area = h('textarea', {
        class: 'paste', id: 'restore_text', spellcheck: 'false', autocomplete: 'off',
        placeholder: t('s_pastePlaceholder'),
    });
    area.value = text || '';
    const next = h('button', {class: 'btn primary', type: 'button'}, t('s_continue'));
    next.addEventListener('click', () => {
        if (area.value.trim()) {
            preview(area.value, null);
        } else {
            area.focus();
        }
    });
    clear(el.panel).hidden = false;
    el.panel.append(
        h('label', {class: 'panel-title', for: 'restore_text'}, t('s_pasteLabel')),
        area,
        h('div', {class: 'panel-buttons'},
            h('button', {class: 'btn tonal', type: 'button', onClick: () => closePanel()}, t('s_cancel')),
            next));
    area.focus();
}

function fileInput() {
    const input = h('input', {type: 'file', accept: '.json,.txt,application/json,text/plain', hidden: true});
    input.addEventListener('change', async () => {
        const file = input.files[0];
        input.value = '';
        opener = chooseButton;
        if (!file) {
            return;
        }
        let text;
        try {
            text = await file.text();
        } catch (e) {
            clear(el.panel).hidden = false;
            el.panel.append(h('p', {class: 'error', role: 'alert'}, errorText('not_backup')));
            return;
        }
        preview(text, file.name);
    });
    return input;
}

/* ---------- undo of the last restore ---------- */

function closeUndoPanel(button) {
    clear(el.undoPanel).hidden = true;
    if (button && button.isConnected) {
        button.focus();
    }
}

/** what undoing the last restore does, with Cancel and Undo restore */
async function confirmUndo(button) {
    let res;
    try {
        res = await groupStoreClient.previewUndoRestore();
    } catch (e) {
        console.error('TabHamster: undo restore preview failed', e);
        showBar(t('o_backup_error_other'));
        return;
    }
    if (res.error) {
        await ctx.reloadAll();
        return;
    }
    const confirm = h('button', {class: 'btn primary', type: 'button'}, t('s_undoRestore'));
    confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        closeUndoPanel(null);
        await undoRestore();
    });
    clear(el.undoPanel).hidden = false;
    el.undoPanel.append(
        h('p', {class: 'panel-title'}, t('s_undoPreview_title')),
        h('p', null, t('s_undoPreview_text')),
        res.trashed ? h('p', {class: 'muted'}, plural('s_undoPreview_trashed', res.trashed)) : null,
        h('div', {class: 'panel-buttons'},
            h('button', {class: 'btn tonal', type: 'button', onClick: () => closeUndoPanel(button)}, t('s_cancel')),
            confirm));
    confirm.focus();
}

export function renderRestoreInfo(info) {
    clear(el.undo).hidden = !info;
    clear(el.undoPanel).hidden = true;
    if (!info) {
        return;
    }
    const details = [];
    if (info.restored !== null) {
        details.push(plural('s_lastRestore_groups', info.restored));
    }
    if (info.trashed) {
        details.push(plural('s_lastRestore_trashed', info.trashed));
    }
    const button = h('button', {class: 'btn tonal', type: 'button'}, t('s_undoRestore'));
    button.addEventListener('click', () => confirmUndo(button));
    el.undo.append(
        h('div', {class: 'row-label'},
            h('span', {class: 'row-title'}, t('s_lastRestore', dayTime(info.time, lang, undefined, true, false))),
            details.length ? h('p', {class: 'row-text'}, details.join(' ')) : null),
        button);
}

/** rows of the Backup and restore section; context: {reloadAll} */
export function backupRows(context) {
    ctx = context;
    const input = fileInput();
    chooseButton = h('button', {class: 'btn tonal', type: 'button', onClick: () => {
        opener = chooseButton;
        input.click();
    }}, t('s_chooseFile'));
    const copy = h('button', {class: 'link-btn', type: 'button', 'aria-live': 'polite'}, t('s_copyText'));
    copy.addEventListener('click', () => copyText(copy));
    return [
        h('div', {class: 'row'},
            h('div', {class: 'row-label'},
                h('span', {class: 'row-title'}, t('s_backupFile')),
                h('p', {class: 'row-text'}, t('s_backupFile_text'))),
            h('div', {class: 'row-actions'},
                h('button', {class: 'btn primary', type: 'button', onClick: download},
                    icon('download', 16), t('o_backup_downloadButton')),
                copy)),
        h('div', {class: 'row'},
            h('div', {class: 'row-label'},
                h('span', {class: 'row-title'}, t('s_restore')),
                h('p', {class: 'row-text'}, t('s_restore_text'))),
            h('div', {class: 'row-actions'},
                chooseButton,
                h('button', {class: 'link-btn', type: 'button', onClick: (e) => {
                    opener = e.currentTarget;
                    pasteBox('');
                }}, t('s_pasteText')),
                input)),
        el.panel,
        el.undo,
        el.undoPanel,
    ];
}
