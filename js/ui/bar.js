// The dark bar above the footer: "Saved 12 tabs as …" with Undo. Hides after a few seconds,
// not while the pointer or the keyboard is on it; a question (`stay`) waits for its answer.
// One bar at a time; a new message replaces the old one.
// It is part of the layout (before #footer), not an overlay: a short popup grows instead of being covered,
// and the page shrinks its list while it is shown (body.has-bar).
// Screen readers read it from a live region that is always there (one made and filled at once is often missed).

import {h} from './dom.js';

const SHOW_MS = 5000;
let bar = null;
let timer = null;
let held = false;
let stays = false;
// what the bar's action is about (group keys), for hideBarAbout
let about = [];

function hide() {
    clearTimeout(timer);
    about = [];
    stays = false;
    if (bar) {
        bar.hidden = true;
        bar.replaceChildren();
        document.body.classList.remove('has-bar');
    }
}

function schedule() {
    clearTimeout(timer);
    if (!held && !stays) {
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
 * The text can be a list of strings and elements (a ? button with a tooltip).
 * One of the actions runs, once; the bar hides when one is pressed. `about` (optional): what the action is about (a
 * group key or a list of them), see hideBarAbout. A list of actions makes buttons in that order; `stay` keeps the bar
 * until one is pressed (or another message replaces it).
 */
export function showBar(text, action, {stay = false} = {}) {
    const el = ensure();
    const actions = [action || []].flat();
    about = [(actions[0] && actions[0].about) || []].flat();
    stays = stay;
    el.replaceChildren(h('span', {class: 'bar-text'}, text));
    let done = false;
    for (const each of actions) {
        el.append(h('button', {
            class: 'bar-action', type: 'button',
            onClick: async () => {
                if (done) {
                    return;
                }
                done = true;
                held = false;
                hide();
                await each.run();
            },
        }, each.label));
    }
    el.hidden = false;
    document.body.classList.add('has-bar');
    schedule();
}

/** hides the bar if its action is about `what` (an Undo that a later change to the same group would make wrong) */
export function hideBarAbout(what) {
    if (what && about.includes(what)) {
        hide();
    }
}

/** a message is on the bar (a question can wait for it instead of replacing it and its Undo) */
export function barShown() {
    return !!bar && !bar.hidden;
}

export {hide as hideBar};
