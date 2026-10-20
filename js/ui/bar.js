// The dark bar above the footer: "Saved 12 tabs as …" with Undo. Hides after a few seconds,
// not while the pointer or the keyboard is on it. One bar at a time; a new message replaces the old one.
// It is part of the layout (before #footer), not an overlay: a short popup grows instead of being covered,
// and the page shrinks its list while it is shown (body.has-bar).
// Screen readers read it from a live region that is always there (one made and filled at once is often missed).

import {h} from './dom.js';

const SHOW_MS = 5000;
let bar = null;
let timer = null;
let held = false;
// what the bar's action is about (a group key), for hideBarAbout
let about = null;

function hide() {
    clearTimeout(timer);
    about = null;
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
        bar = h('div', {class: 'bar', hidden: true});
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
        const live = h('div', {class: 'bar-live', role: 'status', 'aria-live': 'polite'}, bar);
        const footer = document.getElementById('footer');
        if (footer) {
            footer.before(live);
        } else {
            document.body.append(live);
        }
    }
    return bar;
}

// module scripts run once the page is parsed: the live region is in place before the first message
ensure();

/**
 * showBar('Saved 12 tabs as "x"', {label: 'Undo', run: async () => {...}, about: 'tg_1'})
 * The action runs once; the bar hides when it is pressed. `about` (optional): what the action is about, see hideBarAbout.
 */
export function showBar(text, action) {
    const el = ensure();
    about = (action && action.about) || null;
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

/** hides the bar if its action is about `what` (an Undo that a later change to the same group would make wrong) */
export function hideBarAbout(what) {
    if (what && what === about) {
        hide();
    }
}

export {hide as hideBar};
