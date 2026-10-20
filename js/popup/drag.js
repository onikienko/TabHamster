// Reordering saved groups by dragging a row. Pointer events, not HTML drag and drop (its ghost image and drop
// effects don't suit a popup). A floating copy of the row follows the pointer while the row itself (dimmed) moves
// to where it will land and the other rows slide out of its way. The list scrolls while the pointer is near its
// top or bottom edge. Esc puts the row back.

import {h} from '../ui/dom.js';

// px the pointer moves before a press becomes a drag (a shorter move is still a click)
const THRESHOLD = 5;
// px from the list's top or bottom edge where it scrolls, and the fastest scroll in px per frame
const EDGE = 36;
const MAX_SPEED = 14;
const SLIDE_MS = 120;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * @param {HTMLElement} list holds `.item` elements with `data-key`, each with a `.row`
 * @param {Object} options
 * @param {function(): boolean} options.enabled checked when a press starts
 * @param {function(HTMLElement): Node[]} options.ghost content of the floating copy of an item
 * @param {function(string, number): void} options.drop key and new place among the other items (0 = top)
 * @param {function(): void} [options.ended] a drag ended (dropped or not), after `drop`
 */
export function enableDrag(list, {enabled, ghost, drop, ended}) {
    let press = null;
    let drag = null;

    function items() {
        return Array.from(list.querySelectorAll(':scope > .item'));
    }

    // Moves an item in the list; the items whose place changed slide from where they were (FLIP)
    function place(moved, before) {
        const all = items();
        const from = reducedMotion.matches ? null : new Map(all.map((item) => [item, item.getBoundingClientRect().top]));
        list.insertBefore(moved, before);
        if (!from) {
            return;
        }
        for (const item of all) {
            item.style.transition = 'none';
            item.style.transform = '';
            const dy = from.get(item) - item.getBoundingClientRect().top;
            if (dy) {
                item.style.transform = 'translateY(' + dy + 'px)';
            }
        }
        // the start positions take effect before the slide begins
        list.getBoundingClientRect();
        for (const item of all) {
            item.style.transition = 'transform ' + SLIDE_MS + 'ms ease-out';
            item.style.transform = '';
        }
    }

    // The row swaps with a neighbour once the floating copy's middle passes the neighbour's middle. Measured on
    // the layout (offsetTop), not on rows that are still sliding; after a swap the way back needs the copy to
    // pass the neighbour's new middle, so the rows don't flicker at the boundary.
    function update() {
        const listTop = list.getBoundingClientRect().top;
        const middle = drag.y - drag.offset + drag.ghost.offsetHeight / 2 - listTop + list.scrollTop;
        const mid = (item) => item.offsetTop + item.offsetHeight / 2;
        let next = drag.item.nextElementSibling;
        while (next && next.classList.contains('item') && middle > mid(next)) {
            place(drag.item, next.nextElementSibling);
            next = drag.item.nextElementSibling;
        }
        let prev = drag.item.previousElementSibling;
        while (prev && prev.classList.contains('item') && middle < mid(prev)) {
            place(drag.item, prev);
            prev = drag.item.previousElementSibling;
        }
    }

    function tick() {
        const r = list.getBoundingClientRect();
        let dy = 0;
        if (drag.y < r.top + EDGE) {
            dy = -Math.ceil(MAX_SPEED * Math.min(1, (r.top + EDGE - drag.y) / EDGE));
        } else if (drag.y > r.bottom - EDGE) {
            dy = Math.ceil(MAX_SPEED * Math.min(1, (drag.y - (r.bottom - EDGE)) / EDGE));
        }
        if (dy) {
            const before = list.scrollTop;
            list.scrollTop += dy;
            if (list.scrollTop !== before) {
                update();
            }
        }
        drag.frame = requestAnimationFrame(tick);
    }

    function move(y) {
        drag.y = y;
        drag.ghost.style.top = Math.round(y - drag.offset) + 'px';
        update();
    }

    function onKey(e) {
        if (e.key === 'Escape') {
            // not to the page (it clears the search) or Chrome (it closes the popup)
            e.preventDefault();
            e.stopPropagation();
            finish(false);
        }
    }

    // the click that ends a drag on the group's name must not open the group
    function swallow(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    function start(e) {
        // the list may have been drawn again since the press (a save finishing): the same group's new row
        const item = press.item.isConnected ? press.item :
            items().find((other) => other.dataset.key === press.item.dataset.key);
        if (!item) {
            press = null;
            return;
        }
        const rect = item.querySelector('.row').getBoundingClientRect();
        const copy = h('div', {class: 'drag-ghost', 'aria-hidden': 'true'}, ghost(item));
        copy.style.left = Math.round(rect.left) + 'px';
        copy.style.width = Math.round(rect.width) + 'px';
        document.body.append(copy);
        drag = {
            item, key: item.dataset.key, ghost: copy, y: e.clientY, offset: press.y - rect.top,
            from: items().indexOf(item), home: item.nextSibling, pointerId: e.pointerId,
        };
        // the row moves, not its open tab list (class `dragging` hides it)
        item.classList.add('dragging');
        document.body.classList.add('dragging');
        // on the list, not the row: moving the row in the list would end a capture on it
        list.setPointerCapture(e.pointerId);
        document.addEventListener('keydown', onKey, true);
        move(e.clientY);
        drag.frame = requestAnimationFrame(tick);
    }

    function finish(commit) {
        press = null;
        if (!drag) {
            return;
        }
        // cleared first: releasing the capture can come back here through lostpointercapture
        const d = drag;
        drag = null;
        cancelAnimationFrame(d.frame);
        document.removeEventListener('keydown', onKey, true);
        if (list.hasPointerCapture(d.pointerId)) {
            list.releasePointerCapture(d.pointerId);
        }
        if (!commit) {
            place(d.item, d.home);
        }
        d.ghost.remove();
        d.item.classList.remove('dragging');
        document.body.classList.remove('dragging');
        window.addEventListener('click', swallow, true);
        setTimeout(() => window.removeEventListener('click', swallow, true), 0);
        const pos = items().indexOf(d.item);
        // the row is gone if the list was drawn again meanwhile: nothing to drop
        if (commit && d.item.isConnected && pos >= 0 && pos !== d.from) {
            drop(d.key, pos);
        }
        if (ended) {
            ended();
        }
    }

    list.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || drag || !enabled()) {
            return;
        }
        const row = e.target.closest('.item > .row');
        // the row's buttons (chevron, Open, new window, ⋯) are for clicking; the name can be dragged
        if (!row || !list.contains(row) || (e.target.closest('button') && !e.target.closest('.name'))) {
            return;
        }
        press = {item: row.parentElement, x: e.clientX, y: e.clientY, pointerId: e.pointerId};
    });
    list.addEventListener('pointermove', (e) => {
        if (drag) {
            if (e.pointerId === drag.pointerId) {
                move(e.clientY);
            }
            return;
        }
        if (!press || e.pointerId !== press.pointerId) {
            return;
        }
        // released outside the list (no pointerup here): the press is over
        if (!(e.buttons & 1)) {
            press = null;
            return;
        }
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) >= THRESHOLD) {
            start(e);
        }
    });
    list.addEventListener('pointerup', () => finish(true));
    list.addEventListener('pointercancel', () => finish(false));
    // e.g. the list was drawn again under the pointer
    list.addEventListener('lostpointercapture', () => finish(false));
}
