// Small DOM builder. Text always goes in as text (never as HTML), so titles and URLs from tabs are safe.

const SVG_NS = 'http://www.w3.org/2000/svg';

function apply(el, attrs) {
    for (const [name, value] of Object.entries(attrs || {})) {
        if (value === undefined || value === null || value === false) {
            continue;
        }
        if (name === 'class') {
            el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value);
        } else if (name === 'style' && typeof value === 'object') {
            Object.assign(el.style, value);
        } else if (name === 'dataset') {
            Object.assign(el.dataset, value);
        } else if (name.startsWith('on') && typeof value === 'function') {
            el.addEventListener(name.slice(2).toLowerCase(), value);
        } else if (value === true) {
            el.setAttribute(name, '');
        } else {
            el.setAttribute(name, String(value));
        }
    }
}

function append(el, children) {
    for (const child of children.flat(Infinity)) {
        if (child === undefined || child === null || child === false) {
            continue;
        }
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}

/** h('button', {class: 'btn', onClick: fn}, 'Save') */
export function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    apply(el, attrs);
    append(el, children);
    return el;
}

/** SVG element; children are more svg() calls */
export function svg(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs || {})) {
        if (value !== undefined && value !== null && value !== false) {
            el.setAttribute(name, String(value));
        }
    }
    append(el, children);
    return el;
}

/** remove all children */
export function clear(el) {
    el.replaceChildren();
    return el;
}
