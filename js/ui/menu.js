// Popover menu for a ⋯ button. One at a time. ↑ ↓ Home End move, Enter or Space chooses, Esc closes and
// goes back to the button, Tab or a click outside closes. It sits under the button (above it if there is no room).
// A popup is only as tall as its page, so when the menu doesn't fit either way the page grows for it.

import {h} from './dom.js';
import {icon} from './icons.js';

let current = null;

function place(menu, anchor) {
    const gap = 4;
    const margin = 8;
    const rect = anchor.getBoundingClientRect();
    const height = menu.offsetHeight;
    const width = menu.offsetWidth;
    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - margin) {
        const above = rect.top - gap - height;
        if (above >= margin) {
            top = above;
        } else {
            document.body.style.minHeight = Math.ceil(top + height + margin) + 'px';
            top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
        }
    }
    menu.style.top = Math.round(top) + 'px';
    menu.style.left = Math.round(Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))) + 'px';
}

/** close the open menu; focus: back to its button */
export function closeMenu(focus) {
    if (!current) {
        return;
    }
    const {menu, anchor, cleanup, onClose} = current;
    current = null;
    cleanup();
    menu.remove();
    document.body.style.minHeight = '';
    anchor.setAttribute('aria-expanded', 'false');
    if (focus && anchor.isConnected) {
        anchor.focus();
    }
    if (onClose) {
        onClose();
    }
}

/** true if the menu of this button is open */
export function isMenuOpen(anchor) {
    return !!current && current.anchor === anchor;
}

/**
 * openMenu(button, [{label, sub?, icon, danger?, run}, '-', ...], {label, onClose})
 * '-' is a separator. `sub` is a second, muted line.
 */
export function openMenu(anchor, items, {label, onClose} = {}) {
    closeMenu(false);
    const buttons = [];
    const menu = h('div', {class: 'menu', role: 'menu', 'aria-label': label},
        items.map((item) => {
            if (item === '-') {
                return h('div', {class: 'menu-sep', role: 'separator'});
            }
            const button = h('button', {
                    class: ['menu-item', item.danger && 'danger'], type: 'button', role: 'menuitem', tabindex: '-1',
                    onClick: () => {
                        closeMenu(true);
                        item.run();
                    },
                },
                icon(item.icon, 16),
                h('span', {class: 'menu-text'},
                    h('span', {class: 'menu-label'}, item.label),
                    item.sub ? h('span', {class: 'menu-sub ellipsis'}, item.sub) : null));
            // the item under the pointer takes the focus, so it is the one selected item (and arrows go on from it)
            button.addEventListener('pointermove', () => {
                if (document.activeElement !== button) {
                    button.focus();
                }
            });
            buttons.push(button);
            return button;
        }));

    menu.addEventListener('keydown', (e) => {
        const i = buttons.indexOf(document.activeElement);
        let next = null;
        if (e.key === 'ArrowDown') {
            next = buttons[(i + 1) % buttons.length];
        } else if (e.key === 'ArrowUp') {
            next = buttons[(i - 1 + buttons.length) % buttons.length];
        } else if (e.key === 'Home') {
            next = buttons[0];
        } else if (e.key === 'End') {
            next = buttons[buttons.length - 1];
        } else if (e.key === 'Escape' || e.key === 'Tab') {
            // Esc must not reach the page (it clears the search) or Chrome (it closes the popup)
            e.preventDefault();
            e.stopPropagation();
            closeMenu(true);
            return;
        } else {
            return;
        }
        e.preventDefault();
        next.focus();
    });

    const outside = (e) => {
        if (!menu.contains(e.target) && !anchor.contains(e.target)) {
            closeMenu(false);
        }
    };
    const scrolled = (e) => {
        if (!menu.contains(e.target)) {
            closeMenu(false);
        }
    };
    const resized = () => place(menu, anchor);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', resized);

    current = {
        menu, anchor, onClose,
        cleanup: () => {
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('scroll', scrolled, true);
            window.removeEventListener('resize', resized);
        },
    };
    document.body.append(menu);
    place(menu, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    if (buttons.length) {
        buttons[0].focus();
    }
}
