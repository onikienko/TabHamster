// Test data: seeded random generator and realistic-looking tabs.

function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

const WORDS = ['tab', 'session', 'chrome', 'storage', 'sync', 'error', 'how', 'to', 'fix', 'quota',
    'array', 'string', 'json', 'parse', 'react', 'hook', 'state', 'list', 'news', 'review', 'price',
    'best', 'guide', 'python', 'node', 'stream', 'compress', 'deflate', 'window', 'group'];
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function pick(rnd, arr) {
    return arr[Math.floor(rnd() * arr.length)];
}

function int(rnd, max) {
    return Math.floor(rnd() * max);
}

function token(rnd, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
        s += ALNUM[int(rnd, ALNUM.length)];
    }
    return s;
}

function words(rnd, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push(pick(rnd, WORDS));
    }
    return out;
}

function makeTab(rnd, id) {
    const w = words(rnd, 3 + int(rnd, 6));
    const kinds = [
        () => ({
            url: 'https://github.com/' + token(rnd, 8) + '/' + w[0] + '-' + w[1] + '/issues/' + int(rnd, 9999),
            title: w.join(' ') + ' · Issue #' + int(rnd, 9999) + ' · ' + token(rnd, 8) + '/' + w[0],
        }),
        () => ({
            url: 'https://stackoverflow.com/questions/' + (10000000 + int(rnd, 70000000)) + '/' + w.join('-'),
            title: w.join(' ') + ' - Stack Overflow',
        }),
        () => ({
            url: 'https://www.youtube.com/watch?v=' + token(rnd, 11),
            title: w.join(' ') + ' - YouTube',
        }),
        () => ({
            url: 'https://www.google.com/search?q=' + w.join('+') + '&sca_esv=' + token(rnd, 16) + '&ei=' + token(rnd, 22),
            title: w.join(' ') + ' - Google Search',
        }),
        () => ({
            url: 'https://docs.google.com/document/d/' + token(rnd, 44) + '/edit',
            title: w.join(' ') + ' - Google Docs',
        }),
        () => ({
            url: 'https://www.amazon.com/' + w.join('-') + '/dp/B0' + token(rnd, 8).toUpperCase() +
                '/ref=sr_1_' + int(rnd, 40) + '?crid=' + token(rnd, 13) + '&keywords=' + w.join('+') + '&qid=' + int(rnd, 1e9),
            title: 'Amazon.com: ' + w.join(' '),
        }),
    ];
    const tab = pick(rnd, kinds)();
    tab.id = id;
    if (rnd() < 0.05) {
        tab.pinned = true;
    }
    return tab;
}

function makeTabs(n, seed = 1) {
    const rnd = mulberry32(seed);
    const tabs = [];
    for (let i = 0; i < n; i++) {
        tabs.push(makeTab(rnd, i));
    }
    return tabs;
}

function makeGroup(n, seed = 1, name = 'group ' + seed) {
    return {name, index: seed, tabs: makeTabs(n, seed)};
}

// characters that are expensive or tricky for sync size accounting
const NASTY = ['<', '<', '>', '"', '\\', '\n', '\t', '\u0001', '\u2028', '\u2029', 'ї', 'é', '漢', '😀', ' '];

function nastyText(rnd, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
        s += rnd() < 0.5 ? ALNUM[int(rnd, ALNUM.length)] : pick(rnd, NASTY);
    }
    return s;
}

module.exports = {mulberry32, makeTabs, makeGroup, nastyText, int};
