// The logo and the line icons used in the pages. Icons draw with currentColor.

import {svg} from './dom.js';

// redrawn from .work/chrome_market/promo_img/promo_1400x560.psd (Arial "^ ^" and "( °.° )"), viewBox 261 x 199
export function logo(width, label) {
    const height = Math.round(width * 199 / 261);
    return svg('svg', {
            class: 'logo', width, height, viewBox: '0 0 261 199',
            role: label ? 'img' : null, 'aria-label': label || null, 'aria-hidden': label ? null : 'true',
        },
        svg('g', {fill: 'var(--logo)'},
            svg('path', {d: 'M74 42 89 6h8l15 36h-7.5L93 15.5 81.5 42Z'}),
            svg('path', {d: 'M146 42 161 6h8l15 36h-7.5L165 15.5 153.5 42Z'}),
            svg('path', {d: 'M85 125 115 138.5v7L85 159v-8.5l21-8.5-21-8.5Z'}),
            svg('path', {d: 'M170 126 140 138.5v7L170 158v-8l-21-8 21-8Z'}),
            svg('rect', {x: 124, y: 157, width: 12, height: 11})),
        svg('g', {fill: 'none', stroke: 'var(--logo)', 'stroke-width': 6},
            svg('path', {d: 'M31 77C4.3 108 4.3 160 31 191M230 77C256.7 108 256.7 160 230 191', 'stroke-width': 10.5}),
            svg('ellipse', {cx: 99, cy: 103, rx: 9.5, ry: 10.5}),
            svg('ellipse', {cx: 155, cy: 103, rx: 9.5, ry: 10.5})));
}

// 24 x 24 line icons: [tag, attrs] lists
const ICONS = {
    search: [['circle', {cx: 11, cy: 11, r: 7}], ['path', {d: 'm20 20-3.5-3.5'}]],
    chevronRight: [['path', {d: 'm9 18 6-6-6-6'}]],
    chevronDown: [['path', {d: 'm6 9 6 6 6-6'}]],
    newWindow: [['path', {d: 'M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6'}], ['path', {d: 'm21 3-9 9'}],
        ['path', {d: 'M15 3h6v6'}]],
    more: [['circle', {cx: 5, cy: 12, r: 1.8, fill: 'currentColor', stroke: 'none'}],
        ['circle', {cx: 12, cy: 12, r: 1.8, fill: 'currentColor', stroke: 'none'}],
        ['circle', {cx: 19, cy: 12, r: 1.8, fill: 'currentColor', stroke: 'none'}]],
    notSynced: [['path', {d: 'm2 2 20 20'}], ['path', {d: 'M5.8 5.8A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.3-.2'}],
        ['path', {d: 'M21.5 16.5A4.5 4.5 0 0 0 17.5 10h-1.8A7 7 0 0 0 10 5.1'}]],
    cloud: [['path', {d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z'}]],
    enter: [['path', {d: 'M9 10 4 15l5 5'}], ['path', {d: 'M20 4v7a4 4 0 0 1-4 4H4'}]],
    close: [['path', {d: 'M18 6 6 18'}], ['path', {d: 'm6 6 12 12'}]],
    check: [['path', {d: 'M20 6 9 17l-5-5'}]],
    settings: [['path', {d: 'M20 7h-9'}], ['path', {d: 'M14 17H5'}], ['circle', {cx: 17, cy: 17, r: 3}],
        ['circle', {cx: 7, cy: 7, r: 3}]],
    replace: [['path', {d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8'}], ['path', {d: 'M21 3v5h-5'}],
        ['path', {d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16'}], ['path', {d: 'M8 16H3v5'}]],
    plus: [['path', {d: 'M5 12h14'}], ['path', {d: 'M12 5v14'}]],
    pencil: [['path', {d: 'M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z'}]],
    incognito: [['path', {d: 'M10.7 5.1a10.7 10.7 0 0 1 11.2 6.6 1 1 0 0 1 0 .7 10.7 10.7 0 0 1-1.4 2.5'}],
        ['path', {d: 'M14.1 14.2a3 3 0 0 1-4.2-4.2'}],
        ['path', {d: 'M17.5 17.5a10.8 10.8 0 0 1-15.4-5.2 1 1 0 0 1 0-.7 10.8 10.8 0 0 1 4.4-5.1'}],
        ['path', {d: 'm2 2 20 20'}]],
    copy: [['rect', {width: 14, height: 14, x: 8, y: 8, rx: 2}],
        ['path', {d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'}]],
    trash: [['path', {d: 'M3 6h18'}], ['path', {d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6'}],
        ['path', {d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'}]],
    window: [['rect', {x: 3, y: 4, width: 18, height: 16, rx: 2}], ['path', {d: 'M3 9h18'}]],
    computer: [['rect', {x: 2, y: 3, width: 20, height: 14, rx: 2}], ['path', {d: 'M8 21h8'}], ['path', {d: 'M12 17v4'}]],
    download: [['path', {d: 'M12 3v12'}], ['path', {d: 'm7 10 5 5 5-5'}], ['path', {d: 'M5 21h14'}]],
    pin: [['path', {d: 'M12 17v5'}],
        ['path', {d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'}]],
    grip: [['circle', {cx: 9, cy: 6, r: 1.6, fill: 'currentColor', stroke: 'none'}],
        ['circle', {cx: 9, cy: 12, r: 1.6, fill: 'currentColor', stroke: 'none'}],
        ['circle', {cx: 9, cy: 18, r: 1.6, fill: 'currentColor', stroke: 'none'}],
        ['circle', {cx: 15, cy: 6, r: 1.6, fill: 'currentColor', stroke: 'none'}],
        ['circle', {cx: 15, cy: 12, r: 1.6, fill: 'currentColor', stroke: 'none'}],
        ['circle', {cx: 15, cy: 18, r: 1.6, fill: 'currentColor', stroke: 'none'}]],
    globe: [['circle', {cx: 12, cy: 12, r: 9}], ['path', {d: 'M3 12h18'}],
        ['path', {d: 'M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18'}]],
};

/** icon('search', 16) → decorative svg; pass a label for a meaningful one */
export function icon(name, size, label) {
    const parts = ICONS[name];
    if (!parts) {
        throw new Error('Unknown icon: ' + name);
    }
    return svg('svg', {
            class: 'icon icon-' + name, width: size || 16, height: size || 16, viewBox: '0 0 24 24',
            fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            role: label ? 'img' : null, 'aria-label': label || null, 'aria-hidden': label ? null : 'true',
        },
        parts.map(([tag, attrs]) => svg(tag, attrs)));
}
