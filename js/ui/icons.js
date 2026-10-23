// The logo and the line icons used in the pages. Icons draw with currentColor.

import {svg} from './dom.js';

// The original icon's face: Arial text (.work/icons_psd/128.psd) as paths, from work-docs/icons/face.svg.
// In the icon's 128 grid it sits in the box 20 27.5 95 71.
const LOGO = [
    // brackets and the mouth dot: " (  .  )", Arial
    'M28.56 98.1Q25.07 93.7 22.66 87.79Q20.24 81.88 20.24 75.55Q20.24 69.98 22.05 64.87Q24.16 58.94 28.56 53.05H31.59Q28.75 57.93 27.84 60.02Q26.41 63.25 25.59 66.77Q24.58 71.15 24.58 75.58Q24.58 86.85 31.59 98.1ZM64.35 88V83.2H69.16V88ZM105.93 98.1H102.91Q109.91 86.85 109.91 75.58Q109.91 71.17 108.91 66.84Q108.11 63.32 106.68 60.09Q105.77 57.98 102.91 53.05H105.93Q110.34 58.94 112.45 64.87Q114.25 69.98 114.25 75.55Q114.25 81.88 111.82 87.79Q109.4 93.7 105.93 98.1Z',
    // eyes: "o  o", Arial Bold
    'M50.72 64.2Q50.72 62.97 51.33 61.82Q51.93 60.67 53.05 60.06Q54.16 59.46 55.53 59.46Q57.65 59.46 59 60.83Q60.35 62.21 60.35 64.31Q60.35 66.42 58.99 67.82Q57.62 69.21 55.55 69.21Q54.26 69.21 53.1 68.63Q51.93 68.05 51.33 66.93Q50.72 65.81 50.72 64.2ZM53.25 64.33Q53.25 65.72 53.91 66.46Q54.57 67.2 55.54 67.2Q56.5 67.2 57.16 66.46Q57.81 65.72 57.81 64.32Q57.81 62.94 57.16 62.21Q56.5 61.47 55.54 61.47Q54.57 61.47 53.91 62.21Q53.25 62.94 53.25 64.33ZM71.72 64.2Q71.72 62.97 72.32 61.82Q72.93 60.67 74.04 60.06Q75.15 59.46 76.53 59.46Q78.64 59.46 80 60.83Q81.35 62.21 81.35 64.31Q81.35 66.42 79.98 67.82Q78.62 69.21 76.54 69.21Q75.26 69.21 74.1 68.63Q72.93 68.05 72.32 66.93Q71.72 65.81 71.72 64.2ZM74.25 64.33Q74.25 65.72 74.91 66.46Q75.57 67.2 76.53 67.2Q77.5 67.2 78.16 66.46Q78.81 65.72 78.81 64.32Q78.81 62.94 78.16 62.21Q77.5 61.47 76.53 61.47Q75.57 61.47 74.91 62.21Q74.25 62.94 74.25 64.33Z',
    // ears: "^ ^", Arial
    'M49.2 41.87H45.95L52.15 27.79H54.7L60.94 41.87H57.76L53.42 31.38ZM76.1 41.87H72.84L79.05 27.79H81.6L87.84 41.87H84.66L80.31 31.38Z',
    // cheeks: "> <", Arial Bold
    'M50.11 85.05V81.74L58.34 78.5L50.11 75.3V72.01L61.9 77.11V79.92ZM82.57 85.04 70.8 79.92V77.09L82.57 71.99V75.33L74.36 78.47L82.57 81.73Z',
];

export function logo(width, label) {
    const height = Math.round(width * 71 / 95);
    return svg('svg', {
            class: 'logo', width, height, viewBox: '20 27.5 95 71',
            role: label ? 'img' : null, 'aria-label': label || null, 'aria-hidden': label ? null : 'true',
        },
        svg('g', {fill: 'var(--logo)'}, ...LOGO.map((d) => svg('path', {d}))));
}

// 24 x 24 line icons: [tag, attrs] lists
const ICONS = {
    search: [['circle', {cx: 11, cy: 11, r: 7}], ['path', {d: 'm20 20-3.5-3.5'}]],
    searchOff: [['circle', {cx: 11, cy: 11, r: 7}], ['path', {d: 'm20 20-3.5-3.5'}], ['path', {d: 'M8.5 8.5l5 5'}],
        ['path', {d: 'M13.5 8.5l-5 5'}]],
    chevronRight: [['path', {d: 'm9 18 6-6-6-6'}]],
    chevronDown: [['path', {d: 'm6 9 6 6 6-6'}]],
    history: [['path', {d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'}], ['path', {d: 'M3 3v5h5'}],
        ['path', {d: 'M12 7v5l4 2'}]],
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
    link: [['path', {d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'}],
        ['path', {d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'}]],
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
    closedTab: [['rect', {x: 3, y: 3, width: 18, height: 18, rx: 2}], ['path', {d: 'm15 9-6 6'}], ['path', {d: 'm9 9 6 6'}]],
    computer: [['rect', {x: 2, y: 3, width: 20, height: 14, rx: 2}], ['path', {d: 'M8 21h8'}], ['path', {d: 'M12 17v4'}]],
    download: [['path', {d: 'M12 3v12'}], ['path', {d: 'm7 10 5 5 5-5'}], ['path', {d: 'M5 21h14'}]],
    pin: [['path', {d: 'M12 17v5'}],
        ['path', {d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'}]],
    help: [['circle', {cx: 12, cy: 12, r: 9}], ['path', {d: 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.4'}],
        ['path', {d: 'M12 16.8h.01'}]],
    globe: [['circle', {cx: 12, cy: 12, r: 9}], ['path', {d: 'M3 12h18'}],
        ['path', {d: 'M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18'}]],
};

// each icon is built once for each size and copied after that: a list draws hundreds of them
const built = new Map();

/** icon('search', 16) → decorative svg; pass a label for a meaningful one */
export function icon(name, size, label) {
    const key = name + ' ' + (size || 16);
    if (!built.has(key)) {
        const parts = ICONS[name];
        if (!parts) {
            throw new Error('Unknown icon: ' + name);
        }
        built.set(key, svg('svg', {
                class: 'icon icon-' + name, width: size || 16, height: size || 16, viewBox: '0 0 24 24',
                fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
            },
            parts.map(([tag, attrs]) => svg(tag, attrs))));
    }
    const copy = built.get(key).cloneNode(true);
    if (label) {
        copy.setAttribute('role', 'img');
        copy.setAttribute('aria-label', label);
    } else {
        copy.setAttribute('aria-hidden', 'true');
    }
    return copy;
}
