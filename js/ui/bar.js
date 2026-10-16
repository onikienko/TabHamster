// The dark bar above the footer: "Saved 12 tabs as …" with Undo. Hides after a few seconds,
// not while the pointer or the keyboard is on it. One bar at a time; a new message replaces the old one.
// It is part of the layout (before #footer), not an overlay: a short popup grows instead of being covered,
// and the page shrinks its list while it is shown (body.has-bar).

import {h} from './dom.js';

const SHOW_MS = 5000;
let bar = null;
let timer = null;
let held = false;

function hide() {
    clearTimeout(timer);
    if (bar) {
        bar.hidden = true;
        bar.replaceChildren();
        document.body.classList.remove('has-bar');
    }
}

function schedule() {
    clearTimeout(timer);
    if (!held) {
        timer = setTimeout(hide, SHOW_MS);
    }
}

function ensure() {
    if (!bar) {
        bar = h('div', {class: 'bar', role: 'status', 'aria-live': 'polite', hidden: true});
        bar.addEventListener('pointerenter', () => {
            held = true;
            clearTimeout(timer);
        });
        bar.addEventListener('pointerleave', () => {
            held = false;
            schedule();
        });
        bar.addEventListener('focusin', () => {
            held = true;
            clearTimeout(timer);
        });
        bar.addEventListener('focusout', () => {
            held = false;
            schedule();
        });
        const footer = document.getElementById('footer');
        if (footer) {
            footer.before(bar);
        } else {
            document.body.append(bar);
        }
    }
    return bar;
}

/**
 * showBar('Saved 12 tabs as "x"', {label: 'Undo', run: async () => {...}})
 * The action runs once; the bar hides when it is pressed.
 */
export function showBar(text, action) {
    const el = ensure();
    el.replaceChildren(h('span', {class: 'bar-text'}, text));
    if (action) {
        let done = false;
        el.append(h('button', {
            class: 'bar-action', type: 'button',
            onClick: async () => {
                if (done) {
                    return;
                }
                done = true;
                held = false;
                hide();
                await action.run();
            },
        }, action.label));
    }
    el.hidden = false;
    document.body.classList.add('has-bar');
    schedule();
}

export {hide as hideBar};
