// Key names as the user's keyboard shows them. A Mac has Return, Option and Command; others Enter, Alt and Ctrl.
// Option is reported as altKey, so code checks the same properties everywhere.

export function isMac(nav) {
    const n = nav || globalThis.navigator;
    const platform = (n && n.userAgentData && n.userAgentData.platform) || (n && n.platform) || '';
    return /mac/i.test(platform);
}

// a key's name in the UI language, as Chrome's menus write it (key_* in _locales: "Maj", "Entrée"); English when
// there is none (tests)
function keyName(id, english) {
    const text = globalThis.chrome && chrome.i18n && chrome.i18n.getMessage('key_' + id);
    return text || english;
}

/**
 * label for 'enter' | 'alt' | 'mod' (the key that also opens a new window with a click) | 'shift' | 'esc' | 'delete'
 * (a Mac's delete key, ⌫, is Backspace to the page)
 */
export function keyLabel(key, mac) {
    const m = mac === undefined ? isMac() : mac;
    const labels = {
        enter: m ? keyName('return', 'Return') : keyName('enter', 'Enter'),
        alt: m ? '⌥ ' + keyName('option', 'Option') : keyName('alt', 'Alt'),
        mod: m ? '⌘' : keyName('ctrl', 'Ctrl'),
        shift: '⇧ ' + keyName('shift', 'Shift'),
        esc: keyName('esc', 'Esc'),
        delete: m ? '⌫' : keyName('delete', 'Delete'),
    };
    if (!(key in labels)) {
        throw new Error('Unknown key: ' + key);
    }
    return labels[key];
}

/**
 * A key with modifiers as the keyboard shows it: keyCombo(['shift', 'enter']) → "⇧ Return" on a Mac,
 * "Shift+Enter" elsewhere. Names as in keyLabel; anything else (e.g. 'F10') is shown as it is.
 */
export function keyCombo(keys, mac) {
    const m = mac === undefined ? isMac() : mac;
    const modifiers = m ? {shift: '⇧', alt: '⌥', mod: '⌘'} :
        {shift: keyName('shift', 'Shift'), alt: keyName('alt', 'Alt'), mod: keyName('ctrl', 'Ctrl')};
    const names = keys.map((key) => modifiers[key] || (key === 'enter' || key === 'esc' ? keyLabel(key, m) : key));
    return names.join(m ? ' ' : '+');
}

/** true for clicks that should open a new window: Shift, Ctrl (not on a Mac, where it is a right-click) or ⌘ */
export function wantsNewWindow(event, mac) {
    const m = mac === undefined ? isMac() : mac;
    return event.shiftKey || (m ? event.metaKey : event.ctrlKey) || event.button === 1;
}
