// Welcome page: opened on install (js/background.js) and from Settings, Help. Shows how to pin TabHamster to the
// toolbar, unless it is pinned already. Decisions: work-docs/PLAN.md section 8.
// Pinned or not: chrome.action.getUserSettings (Chrome 91+); onUserSettingsChanged (Chrome 130+) updates the page
// when the user pins it from the drawing. Browsers without them always show the drawing.

import {logo} from './ui/icons.js';
import {t, uiLanguage} from './ui/i18n.js';
import {applyTheme} from './ui/theme.js';

const el = (id) => document.getElementById(id);

/** true / false, or null when the browser can't tell */
async function isPinned() {
    try {
        return chrome.action && chrome.action.getUserSettings ?
            (await chrome.action.getUserSettings()).isOnToolbar : null;
    } catch (e) {
        return null;
    }
}

// pinned before the page opened: the short page without the drawing
function showPinned(pinned) {
    el('intro').hidden = pinned;
    el('drawing').hidden = pinned;
    el('pinned_title').hidden = !pinned;
    el('save_text').textContent = t(pinned ? 'w_save' : 'w_saveThen');
}

async function start() {
    document.documentElement.lang = uiLanguage();
    document.title = t('w_title');
    el('logo').append(logo(46, 'TabHamster'));
    el('heading').textContent = t('w_heading');
    el('hidden_text').textContent = t('w_hidden');
    el('pinned_heading').textContent = t('w_pinned');
    el('menu_title').textContent = t('w_menu');
    el('art').setAttribute('aria-label', t('w_drawing'));
    el('step1').textContent = t('w_step1');
    el('step2').textContent = t('w_step2');
    el('sync_text').textContent = t('w_sync');
    el('backup_link').textContent = t('w_backup');

    const [{theme}, pinned] = await Promise.all([
        chrome.storage.sync.get({theme: 'system'}).catch(() => ({theme: 'system'})),
        isPinned(),
    ]);
    applyTheme(theme);
    showPinned(pinned === true);
    el('welcome').hidden = false;

    if (chrome.action && chrome.action.onUserSettingsChanged) {
        chrome.action.onUserSettingsChanged.addListener((settings) => {
            // pinned from the drawing: the steps get checks and "Done"; unpinned on the short page: the drawing
            if (!el('pinned_title').hidden && !settings.isOnToolbar) {
                showPinned(false);
            }
            el('drawing').classList.toggle('pinned', !!settings.isOnToolbar);
            el('done').textContent = settings.isOnToolbar ? t('w_done') : '';
        });
    }
}

start();
