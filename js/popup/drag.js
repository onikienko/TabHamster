// Reordering by dragging: saved groups (a group's row), and their tabs (a tab's row), inside the group or into another
// one. Pointer events, not HTML drag and drop (its ghost image and drop effects don't suit a popup). A floating copy
// of the row follows the pointer while the row itself (dimmed) moves to where it will land and the other rows slide
// out of its way. The list scrolls while the pointer is near its top or bottom edge. Esc puts the row back.

import {h} from '../ui/dom.js';

// px the pointer moves before a press becomes a drag (a shorter move is still a click)
const THRESHOLD = 5;
// px from the list's top or bottom edge where it scrolls, and the fastest scroll in px per frame
const EDGE = 36;
const MAX_SPEED = 14;
const SLIDE_MS = 120;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * @param {HTMLElement} list holds `.item` elements with `data-key`, each with a `.row` and, while open, a `.tab-list`
 *   of `.tab-item` elements (a saved group's tab has an `a.tab-row` with `data-key` and `data-index`)
 * @param {Object} options
 * @param {function(): boolean} options.enabled checked when a press starts
 * @param {function(HTMLElement): Node[]} options.ghost content of the floating copy of an item
 * @param {function(string, number): void} options.drop key and new place among the other items (0 = top)
 * @param {function(HTMLElement): Node[]} options.tabGhost content of the floating copy of a tab item
 * @param {function(HTMLElement, string, ?number): void} options.dropTab the tab's `a.tab-row`, the key of the group it
 *   goes to, and its new place among that group's other tabs (0 = first; null: the group is closed, at the end)
 * @param {function(): void} [options.ended] a drag ended (dropped or not), after `drop`
 */
export function enableDrag(list, {enabled, ghost, drop, tabGhost, dropTab, ended}) {
    let press = null;
    let drag = null;

    function items() {
        return Array.from(list.querySelectorAll(':scope > .item'));
    }

    // the next (step 1) or previous (-1) item
    function sibling(item, step) {
        let node = item;
        do {
            node = step > 0 ? node.nextElementSibling : node.previousElementSibling;
        } while (node && !node.classList.contains('item'));
        return node;
    }

    function rowOf(item) {
        return item.querySelector(':scope > .row');
    }

    // Runs `change` (it moves the dragged row); what changed place slides from where it was (FLIP): group rows, open
    // tab lists, and tabs inside them (a tab's own slide is on top of its list's). Reads after writes: one layout,
    // also with a few hundred tabs open
    function place(change) {
        const parts = reducedMotion.matches ? [] :
            Array.from(list.querySelectorAll(':scope > .item > .row, :scope > .item > .tab-list, .tab-item'));
        const from = new Map(parts.map((part) => [part, part.getBoundingClientRect().top]));
        change();
        // a tab list made for the dragged tab has nothing to slide from; one it left is gone
        const shown = parts.filter((part) => part.isConnected);
        for (const part of shown) {
            part.style.transition = 'none';
            part.style.transform = '';
        }
        const moved = new Map(shown.map((part) => [part, from.get(part) - part.getBoundingClientRect().top]));
        for (const [part, dy] of moved) {
            const own = dy - (part.classList.contains('tab-item') ? moved.get(part.parentElement) || 0 : 0);
            if (own) {
                part.style.transform = 'translateY(' + own + 'px)';
            }
        }
        // the start positions take effect before the slide begins
        list.getBoundingClientRect();
        for (const part of shown) {
            part.style.transition = 'transform ' + SLIDE_MS + 'ms ease-out';
            part.style.transform = '';
        }
    }

    // top of an element in the list's content, from the layout (offsetTop), not from rows that are still sliding
    function top(el) {
        let y = 0;
        for (let node = el; node && node !== list; node = node.offsetParent) {
            y += node.offsetTop;
        }
        return y;
    }

    function mid(el) {
        return top(el) + el.offsetHeight / 2;
    }

    // The tab goes into another item's tab list, first or last. A closed group gets a list for it alone (it goes at
    // the end there); a list made that way goes again when the tab leaves it
    function intoGroup(item, first) {
        const tab = drag.item;
        place(() => {
            const left = tab.parentElement;
            let tabs = item.querySelector(':scope > .tab-list');
            if (!tabs) {
                tabs = h('div', {class: 'tab-list drop-only'});
                item.append(tabs);
            }
            tabs.insertBefore(tab, first ? tabs.firstChild : null);
            if (left.classList.contains('drop-only')) {
                left.remove();
            }
        });
    }

    // A dragged group swaps with a neighbour once the floating copy's middle passes the neighbour's middle; a dragged
    // tab the same with the tabs of its list. Past its group's first or last tab it goes on into the group above or
    // below: a group's row is that group's, from its top edge (over a closed group's row it goes into that group).
    // After a move the way back needs the copy to pass the neighbour's new middle (or edge), so the rows don't flicker
    // at the boundary.
    function update() {
        const listTop = list.getBoundingClientRect().top;
        const middle = drag.y - drag.offset + drag.ghost.offsetHeight / 2 - listTop + list.scrollTop;
        const it = drag.item;
        if (!drag.tab) {
            let next = sibling(it, 1);
            while (next && middle > mid(next)) {
                place(() => list.insertBefore(it, next.nextSibling));
                next = sibling(it, 1);
            }
            let prev = sibling(it, -1);
            while (prev && middle < mid(prev)) {
                place(() => list.insertBefore(it, prev));
                prev = sibling(it, -1);
            }
            return;
        }
        for (;;) {
            const next = it.nextElementSibling;
            const below = next ? null : sibling(it.closest('.item'), 1);
            if (next && middle > mid(next)) {
                place(() => it.parentElement.insertBefore(it, next.nextSibling));
            } else if (below && middle > top(rowOf(below))) {
                intoGroup(below, true);
            } else {
                break;
            }
        }
        for (;;) {
            const prev = it.previousElementSibling;
            const own = it.closest('.item');
            const above = prev ? null : sibling(own, -1);
            if (prev && middle < mid(prev)) {
                place(() => it.parentElement.insertBefore(it, prev));
            } else if (above && middle < top(rowOf(own))) {
                intoGroup(above, false);
            } else {
                break;
            }
        }
        // the group it would go to, if not its own
        const target = it.closest('.item');
        for (const item of items()) {
            item.classList.toggle('drop-target', item === target && item !== drag.home.item);
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

    // While dragging, the pointer is followed on the whole window, not only while the list has it captured: Chrome
    // can take the capture away (the pointer leaving the popup sideways), and that must not end the drag. Letting go
    // drops the row where it is shown, also when Chrome cancels the pointer or the button came up outside the popup
    // (the next move has no button down). Only Esc puts it back.
    function onDragMove(e) {
        if (e.pointerId !== drag.pointerId) {
            return;
        }
        if (!(e.buttons & 1)) {
            finish(true);
            return;
        }
        move(e.clientY);
    }

    function onDragEnd(e) {
        if (e.pointerId === drag.pointerId) {
            finish(true);
        }
    }

    // the click that ends a drag on a group's name must not open the group, on a tab must not open the tab
    function swallow(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    // what the press is on: the list may have been drawn again since (a save finishing), then the same group's or
    // tab's new row
    function pressed() {
        if (press.item.isConnected) {
            return press.item;
        }
        if (press.tab) {
            const link = list.querySelector('a.tab-row[data-key="' + CSS.escape(press.key) + '"][data-index="' +
                press.index + '"]');
            return link && link.href === press.href ? link.parentElement : null;
        }
        return items().find((other) => other.dataset.key === press.key) || null;
    }

    function start(e) {
        const item = pressed();
        if (!item) {
            press = null;
            return;
        }
        const tab = press.tab;
        const rect = (tab ? item : rowOf(item)).getBoundingClientRect();
        const copy = h('div', {class: ['drag-ghost', tab && 'tab-ghost'], 'aria-hidden': 'true'},
            (tab ? tabGhost : ghost)(item));
        copy.style.left = Math.round(rect.left) + 'px';
        copy.style.width = Math.round(rect.width) + 'px';
        document.body.append(copy);
        drag = {
            tab, item, key: press.key, ghost: copy, y: e.clientY, offset: press.y - rect.top, pointerId: e.pointerId,
            // where it was: a group's place among the items; a tab's group and place in its list
            home: {parent: item.parentElement, next: item.nextSibling, item: tab ? item.closest('.item') : null},
            from: tab ? Array.from(item.parentElement.children).indexOf(item) : items().indexOf(item),
        };
        // a group moves as its row, not with its open tab list (class `dragging` hides it)
        item.classList.add('dragging');
        document.body.classList.add('dragging');
        // on the list, not the row: moving the row in the list would end a capture on it
        list.setPointerCapture(e.pointerId);
        // last on the way up, as the list's own listeners were: the popup sees the button come up first
        window.addEventListener('pointermove', onDragMove);
        window.addEventListener('pointerup', onDragEnd);
        window.addEventListener('pointercancel', onDragEnd);
        document.addEventListener('keydown', onKey, true);
        move(e.clientY);
        drag.frame = requestAnimationFrame(tick);
    }

    function finish(commit) {
        press = null;
        if (!drag) {
            return;
        }
        const d = drag;
        drag = null;
        cancelAnimationFrame(d.frame);
        window.removeEventListener('pointermove', onDragMove);
        window.removeEventListener('pointerup', onDragEnd);
        window.removeEventListener('pointercancel', onDragEnd);
        document.removeEventListener('keydown', onKey, true);
        if (list.hasPointerCapture(d.pointerId)) {
            list.releasePointerCapture(d.pointerId);
        }
        if (!commit && d.home.parent.isConnected) {
            place(() => {
                const left = d.item.parentElement;
                d.home.parent.insertBefore(d.item, d.home.next);
                if (left && left !== d.home.parent && left.classList.contains('drop-only')) {
                    left.remove();
                }
            });
        }
        d.ghost.remove();
        d.item.classList.remove('dragging');
        document.body.classList.remove('dragging');
        for (const item of list.querySelectorAll('.drop-target')) {
            item.classList.remove('drop-target');
        }
        window.addEventListener('click', swallow, true);
        setTimeout(() => window.removeEventListener('click', swallow, true), 0);
        // the row is gone if the list was drawn again meanwhile: nothing to drop
        if (commit && d.item.isConnected) {
            if (d.tab) {
                const tabs = d.item.parentElement;
                const to = d.item.closest('.item');
                const pos = Array.from(tabs.children).indexOf(d.item);
                if (to && (to !== d.home.item || pos !== d.from)) {
                    dropTab(d.item.querySelector('a.tab-row'), to.dataset.key,
                        tabs.classList.contains('drop-only') ? null : pos);
                }
            } else {
                const pos = items().indexOf(d.item);
                if (pos >= 0 && pos !== d.from) {
                    drop(d.key, pos);
                }
            }
        }
        if (ended) {
            ended();
        }
    }

    list.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || drag || !enabled()) {
            return;
        }
        const at = {x: e.clientX, y: e.clientY, pointerId: e.pointerId};
        // a saved group's tab (its Edit and Remove buttons are next to the link, not in it)
        const link = e.target.closest('a.tab-row[data-key]');
        if (link && list.contains(link)) {
            press = Object.assign(at, {tab: true, item: link.parentElement, key: link.dataset.key,
                index: link.dataset.index, href: link.href});
            return;
        }
        const row = e.target.closest('.item > .row');
        // the row's buttons (chevron, Open, new window, ⋯) are for clicking; the name can be dragged
        if (!row || !list.contains(row) || (e.target.closest('button') && !e.target.closest('.name'))) {
            return;
        }
        press = Object.assign(at, {tab: false, item: row.parentElement, key: row.parentElement.dataset.key});
    });
    list.addEventListener('pointermove', (e) => {
        // a drag follows the pointer on the window (onDragMove)
        if (drag || !press || e.pointerId !== press.pointerId) {
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
    // Chrome's own drag (a tab's icon is an image, or a link, or selected text) would cancel this one: the row would
    // go back where it was
    list.addEventListener('dragstart', (e) => {
        if (press || drag) {
            e.preventDefault();
        }
    });
    // a press that didn't become a drag is over
    for (const type of ['pointerup', 'pointercancel']) {
        list.addEventListener(type, () => {
            if (!drag) {
                press = null;
            }
        });
    }
}
