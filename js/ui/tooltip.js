// Tooltips drawn by the page instead of the browser's `title`: they show the keys that do the same thing, come
// sooner, follow the theme and appear for keyboard users too. One at a time, under the element (above it if there
// is no room), always inside the page: a popup can't draw outside its window.
//
// setTip(element, {text, sub?, keys?, bold?, align?, focus?})
//   text   first line; `bold` for a name
//   sub    second, muted line
//   keys   ['Return'] or ['⇧ Return']: key caps after the text (platform.js keyCombo)
//   align  'center' (default) under the element, or 'start' at its left edge (names, tab rows)
//   focus  false: not shown when the element gets keyboard focus (rows moved through with ↑ ↓)
//   quiet  for rows of a list: only after a longer rest, never at once after another tooltip (moving the pointer
//          over the list shows nothing)
//   when   (element) => boolean: shown only then (e.g. only when the row cuts its text off)
// The text is for sighted users; the element keeps its own name for screen readers (aria-label), and a tooltip
// shown on keyboard focus is also its description while it shows.

import {h} from './dom.js';

// hover this long before the first tooltip shows; after one was shown, the next one shows at once for a moment
const DELAY_MS = 400;
const QUIET_MS = 800;
const WARM_MS = 300;
const GAP = 6;
const MARGIN = 8;

const tips = new WeakMap();
let box = null;
let anchor = null;
// shown for keyboard focus (it stays while Tab scrolls its element into view)
let byKeys = false;
// the element waiting for its delay
let pending = null;
let timer = null;
// until when the next tooltip shows without the delay
let warmUntil = 0;

/** give an element a tooltip (or remove it with null); the element should not have a `title` as well */
export function setTip(element, spec) {
    if (spec) {
        tips.set(element, spec);
    } else {
        tips.delete(element);
        if (anchor === element) {
            hideTip();
        }
    }
    return element;
}

function ensureBox() {
    if (!box) {
        box = h('div', {class: 'tip', id: 'tooltip', role: 'tooltip', hidden: true});
        document.body.append(box);
    }
    return box;
}

/** the element with a tooltip at or around `node` */
function owner(node) {
    for (let n = node; n && n !== document.body; n = n.parentElement) {
        if (tips.has(n)) {
            return n;
        }
    }
    return null;
}

function place(el, spec) {
    // measured at the corner: at its last place near the right edge it would be squeezed
    box.style.top = '0';
    box.style.left = '0';
    const r = el.getBoundingClientRect();
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    let top = r.bottom + GAP;
    if (top + height > window.innerHeight - MARGIN) {
        const above = r.top - GAP - height;
        top = above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - height - MARGIN);
    }
    const wanted = spec.align === 'start' ? r.left : r.left + r.width / 2 - width / 2;
    box.style.top = Math.round(top) + 'px';
    box.style.left = Math.round(Math.max(MARGIN, Math.min(wanted, window.innerWidth - width - MARGIN))) + 'px';
}

function show(el, byKeyboard) {
    clearTimeout(timer);
    pending = null;
    const spec = tips.get(el);
    // not over an open menu (its ⋯ button; names use aria-expanded for their tab list, not a menu), not while dragging
    if (!spec || !el.isConnected || (el.hasAttribute('aria-haspopup') && el.getAttribute('aria-expanded') === 'true') ||
        document.body.classList.contains('dragging') || (spec.when && !spec.when(el))) {
        return;
    }
    hideTip();
    ensureBox();
    const keys = spec.keys && spec.keys.length ?
        h('span', {class: 'tip-keys'}, spec.keys.map((key) => h('kbd', null, key))) : null;
    box.replaceChildren(
        h('div', {class: 'tip-line'}, h('span', {class: spec.bold ? 'tip-name' : 'tip-text', dir: 'auto'}, spec.text), keys));
    if (spec.sub) {
        box.append(h('div', {class: 'tip-sub', dir: 'auto'}, spec.sub));
    }
    box.hidden = false;
    place(el, spec);
    anchor = el;
    byKeys = byKeyboard;
    if (byKeyboard && !el.hasAttribute('aria-describedby')) {
        el.setAttribute('aria-describedby', 'tooltip');
        el.dataset.tipDescribed = '1';
    }
}

/** hide the tooltip (the page calls it when it draws its list again) */
export function hideTip() {
    clearTimeout(timer);
    pending = null;
    if (box && !box.hidden) {
        box.hidden = true;
        warmUntil = Date.now() + WARM_MS;
    }
    if (anchor && anchor.dataset.tipDescribed) {
        anchor.removeAttribute('aria-describedby');
        delete anchor.dataset.tipDescribed;
    }
    anchor = null;
    byKeys = false;
}

// Scrolling hides a tooltip shown under the pointer. One shown for the keyboard follows its element (Tab scrolls the
// focused element into view right after focusin) and goes only when the element leaves the view.
function onScroll(e) {
    if (!byKeys || !anchor) {
        hideTip();
        return;
    }
    const r = anchor.getBoundingClientRect();
    // the part of the page that scrolled (the list), or the window
    const view = e.target instanceof Element ? e.target.getBoundingClientRect() : {top: 0, bottom: window.innerHeight};
    if (r.bottom <= view.top || r.top >= view.bottom) {
        hideTip();
    } else {
        place(anchor, tips.get(anchor));
    }
}

function later(el) {
    if (el === pending) {
        return;
    }
    const spec = tips.get(el);
    if (spec.when && !spec.when(el)) {
        hideTip();
        return;
    }
    clearTimeout(timer);
    if (!spec.quiet && (box && !box.hidden || Date.now() < warmUntil)) {
        show(el, false);
    } else {
        // the one shown so far goes, the next one waits
        hideTip();
        pending = el;
        timer = setTimeout(() => show(el, false), spec.quiet ? QUIET_MS : DELAY_MS);
    }
}

document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') {
        return;
    }
    const el = owner(e.target);
    if (el && el !== anchor) {
        later(el);
    } else if (!el) {
        hideTip();
    }
});
document.addEventListener('pointerout', (e) => {
    const el = owner(e.target);
    if (el && !el.contains(e.relatedTarget)) {
        hideTip();
    }
});
document.addEventListener('focusin', (e) => {
    const el = owner(e.target);
    if (el && el === e.target && tips.get(el).focus !== false && el.matches(':focus-visible')) {
        show(el, true);
    } else if (anchor && !anchor.contains(e.target)) {
        hideTip();
    }
});
document.addEventListener('focusout', (e) => {
    if (anchor && e.target === anchor) {
        hideTip();
    }
});
// a click, a key (Tab shows the next one through focusin), scrolling or leaving the window
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('keydown', hideTip, true);
document.addEventListener('scroll', onScroll, true);
window.addEventListener('blur', hideTip);
// the element was drawn again or removed under the pointer
new MutationObserver(() => {
    if (anchor && !anchor.isConnected) {
        hideTip();
    }
}).observe(document.documentElement, {childList: true, subtree: true});
