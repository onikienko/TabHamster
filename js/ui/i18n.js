// Texts for elements built in JS. Static markup keeps using {{ key }} (js/helpers/localizer.js).

function subs(substitutions) {
    return substitutions === undefined ? undefined :
        (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
}

/** t('p_open') → message from _locales; the key itself if it is missing (easy to spot) */
export function t(key, substitutions) {
    return chrome.i18n.getMessage(key, subs(substitutions)) || key;
}

export function uiLanguage() {
    return (chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || 'en';
}

let rules = null;

/**
 * plural('p_tabsCount', 5) → message `p_tabsCount_<form>` for the UI language's plural form
 * (one, few, many, other: Intl.PluralRules), falling back to `p_tabsCount_other`. The count is $1.
 */
export function plural(key, count) {
    if (!rules) {
        try {
            rules = new Intl.PluralRules(uiLanguage());
        } catch (e) {
            rules = new Intl.PluralRules('en');
        }
    }
    const args = subs([count]);
    return chrome.i18n.getMessage(key + '_' + rules.select(count), args) ||
        chrome.i18n.getMessage(key + '_other', args) || key;
}
