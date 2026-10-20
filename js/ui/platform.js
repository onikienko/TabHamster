// Key names as the user's keyboard shows them. A Mac has Return, Option and Command; others Enter, Alt and Ctrl.
// Option is reported as altKey, so code checks the same properties everywhere.

export function isMac(nav) {
    const n = nav || globalThis.navigator;
    const platform = (n && n.userAgentData && n.userAgentData.platform) || (n && n.platform) || '';
    return /mac/i.test(platform);
}

/** label for 'enter' | 'alt' | 'mod' (the key that also opens a new window with a click) | 'shift' | 'esc' */
export function keyLabel(key, mac) {
    const m = mac === undefined ? isMac() : mac;
    const labels = {
        enter: m ? 'Return' : 'Enter',
        alt: m ? '⌥ Option' : 'Alt',
        mod: m ? '⌘' : 'Ctrl',
        shift: '⇧ Shift',
        esc: 'Esc',
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
    const modifiers = m ? {shift: '⇧', alt: '⌥', mod: '⌘'} : {shift: 'Shift', alt: 'Alt', mod: 'Ctrl'};
    const names = keys.map((key) => modifiers[key] || (key === 'enter' || key === 'esc' ? keyLabel(key, m) : key));
    return names.join(m ? ' ' : '+');
}

/** true for clicks that should open a new window: Shift, Ctrl (not on a Mac, where it is a right-click) or ⌘ */
export function wantsNewWindow(event, mac) {
    const m = mac === undefined ? isMac() : mac;
    return event.shiftKey || (m ? event.metaKey : event.ctrlKey) || event.button === 1;
}
