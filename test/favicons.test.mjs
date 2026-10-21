import test from 'node:test';
import assert from 'node:assert/strict';

// _favicon answers: the grey globe for pages Chrome doesn't know, their own icon for the rest
const GLOBE = new Uint8Array([1, 2, 3]);
const icons = {'https://known.example/page': new Uint8Array([9, 9, 9])};
let requests = [];
let broken = false;

globalThis.chrome = {runtime: {getURL: (path) => 'chrome-extension://id' + path}};
globalThis.fetch = async (url) => {
    requests.push(url);
    if (broken) {
        return {ok: false, status: 404};
    }
    const page = new URL(url).searchParams.get('pageUrl');
    return {ok: true, arrayBuffer: async () => (icons[page] || GLOBE).buffer};
};
URL.createObjectURL = () => 'blob:icon';

const {faviconUrl, knownIcon, chromeIcon, siteIcon, siteIconFailed} = await import('../js/ui/favicons.js');

test('faviconUrl asks _favicon for the page at 32 px', () => {
    assert.equal(faviconUrl('https://a.example/x?y=1'),
        'chrome-extension://id/_favicon/?pageUrl=https%3A%2F%2Fa.example%2Fx%3Fy%3D1&size=32');
});

test('chromeIcon: Chrome\'s own icon as a blob address, null for its grey globe, each page asked once', async () => {
    requests = [];
    assert.equal(knownIcon('https://known.example/page'), undefined);
    assert.equal(await chromeIcon('https://known.example/page'), 'blob:icon');
    assert.equal(await chromeIcon('https://other.example/'), null);
    assert.equal(knownIcon('https://known.example/page'), 'blob:icon');
    assert.equal(knownIcon('https://other.example/'), null);
    await chromeIcon('https://other.example/');
    // the globe once, then one request per page
    assert.equal(requests.length, 3);
});

test('chromeIcon: when _favicon can\'t be read, the page shows it as before', async () => {
    broken = true;
    try {
        const page = 'https://unread.example/';
        assert.equal(await chromeIcon(page), faviconUrl(page));
    } finally {
        broken = false;
    }
});

test('siteIcon: /favicon.ico of web pages only, none after it failed to load', () => {
    assert.equal(siteIcon('https://a.example/deep/page?q=1#x'), 'https://a.example/favicon.ico');
    assert.equal(siteIcon('http://b.example:8080/'), 'http://b.example:8080/favicon.ico');
    assert.equal(siteIcon('chrome://settings/'), null);
    assert.equal(siteIcon('file:///Users/x/a.html'), null);
    assert.equal(siteIcon('not an address'), null);
    siteIconFailed('https://a.example/other');
    assert.equal(siteIcon('https://a.example/deep/page'), null);
    assert.equal(siteIcon('http://a.example/'), 'http://a.example/favicon.ico');
    siteIconFailed('not an address');
});
