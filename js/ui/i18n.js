// Texts for elements built in JS. Static markup keeps using {{ key }} (js/helpers/localizer.js).

/** t('p_saveTabs', ['12']) → message from _locales; the key itself if it is missing (easy to spot) */
export function t(key, substitutions) {
    const subs = substitutions === undefined ? undefined :
        (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
    return chrome.i18n.getMessage(key, subs) || key;
}
