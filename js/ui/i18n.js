// Texts for the pages: chrome.i18n messages, plural forms, placeholders. The pages' static markup has no texts of
// its own; js/popup/main.js and js/options/main.js set them.

// Hebrew, Arabic, Syriac, Thaana, NKo... and their presentation forms
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/**
 * Right-to-left text (a group name, a tab title) inside a sentence: isolated (FSI ... PDI), so the quotes and words
 * around it stay where they belong. The UI languages are all left-to-right, so only user text can have it.
 */
export function isolate(text) {
    return RTL.test(text) ? '\u2068' + text + '\u2069' : text;
}

function subs(substitutions) {
    return substitutions === undefined ? undefined :
        (Array.isArray(substitutions) ? substitutions : [substitutions]).map((value) => isolate(String(value)));
}

/** t('p_open') → message from _locales; the key itself if it is missing (easy to spot) */
export function t(key, substitutions) {
    return chrome.i18n.getMessage(key, subs(substitutions)) || key;
}

/**
 * The language the texts are in, for plural forms, dates and <html lang>. Chrome's own language when the texts are in
 * it (keeps its variant: en-GB writes dates "15 Oct"); otherwise, a language without a translation (pt, de, pl...),
 * the language of the texts Chrome falls back to, so "0 tab" or English text with German dates don't happen.
 */
export function uiLanguage() {
    const texts = chrome.i18n.getMessage('locale') || 'en';
    const ui = (chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || texts;
    return ui.split(/[-_]/)[0].toLowerCase() === texts.toLowerCase() ? ui : texts;
}

let rules = null;

/**
 * plural('p_tabsCount', 5) → message `p_tabsCount_<form>` for the UI language's plural form
 * (one, few, many, other: Intl.PluralRules), falling back to `p_tabsCount_other`. The count is $1,
 * more substitutions follow as $2, $3...
 */
export function plural(key, count, more) {
    if (!rules) {
        try {
            rules = new Intl.PluralRules(uiLanguage());
        } catch (e) {
            rules = new Intl.PluralRules('en');
        }
    }
    const args = subs([count].concat(more || []));
    return chrome.i18n.getMessage(key + '_' + rules.select(count), args) ||
        chrome.i18n.getMessage(key + '_other', args) || key;
}
