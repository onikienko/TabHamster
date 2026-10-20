import test from 'node:test';
import assert from 'node:assert/strict';
import {parseQuery, matchesAll, segments, search} from '../js/search.js';

test('parseQuery splits words and drops duplicates (any case)', () => {
    assert.deepEqual(parseQuery('  trip  to Tofino TRIP '), ['trip', 'to', 'Tofino']);
    assert.deepEqual(parseQuery(''), []);
    assert.deepEqual(parseQuery(undefined), []);
});

test('matchesAll: every word, any order, any case, special characters are literal', () => {
    assert.ok(matchesAll('Tofino trip photos', parseQuery('trip to tofino')));
    assert.ok(!matchesAll('Tofino photos', parseQuery('trip tofino')));
    assert.ok(matchesAll('C++ (draft) [v2]', parseQuery('c++ (draft) [v2]')));
    assert.ok(matchesAll('Київ: погода', parseQuery('КИЇВ')));
    assert.ok(!matchesAll('anything', []));
});

test('segments marks matches and merges overlaps', () => {
    assert.deepEqual(segments('Extensions dev', ['dev']), [
        {text: 'Extensions ', hit: false}, {text: 'dev', hit: true}]);
    assert.deepEqual(segments('Frontend Developer', ['dev', 'deve']), [
        {text: 'Frontend ', hit: false}, {text: 'Deve', hit: true}, {text: 'loper', hit: false}]);
    assert.deepEqual(segments('Tofino trip', ['tofino', 'trip']), [
        {text: 'Tofino', hit: true}, {text: ' ', hit: false}, {text: 'trip', hit: true}]);
    assert.deepEqual(segments('abc', []), [{text: 'abc', hit: false}]);
});

test('segments: a word that starts a word is highlighted only there, else wherever it is', () => {
    const hits = (text, query) => segments(text, parseQuery(query)).filter((p) => p.hit).map((p) => p.text);
    assert.deepEqual(hits('Tofino trip photos', 'trip to tofino'), ['Tofino', 'trip']);
    assert.deepEqual(hits('Trip to Tofino', 'trip to tofino'), ['Trip', 'to', 'Tofino']);
    // only inside words: still shown, so it's clear why the group is in the list
    assert.deepEqual(hits('Tofino trip photos', 'oto'), ['oto']);
    // after punctuation, in addresses, in other scripts
    assert.deepEqual(hits('developer.chrome.com', 'chrome'), ['chrome']);
    assert.deepEqual(hits('dev.to/x', 'to'), ['to']);
    assert.deepEqual(hits('Погода: Київ', 'киї'), ['Киї']);
    assert.deepEqual(hits('Погода: Київ', 'од'), ['од']);
    // no word starts in Japanese text: matched where it is
    assert.deepEqual(hits('東京の天気', '天気'), ['天気']);
});

const items = [
    {key: 'mc', name: 'Morning coffee', tabs: [{title: 'CBC News', url: 'https://www.cbc.ca/news'}]},
    {key: 'ed', name: 'Extensions dev', tabs: [{title: 'chrome.storage', url: 'https://developer.chrome.com/docs'}]},
    {key: 'ja', name: 'Job applications', tabs: [
        {title: 'Frontend Developer, Vancouver', url: 'https://ca.indeed.com/1'},
        {title: 'Shopify careers', url: 'https://www.shopify.com/careers'}]},
    {key: 'rl', name: 'Reading list', tabs: [
        {title: 'Why I quit web dev for a month', url: 'https://dev.to/x'},
        {title: 'Long read', url: 'https://example.com/a'}]},
];

test('search: name matches first, then groups matching through their tabs', () => {
    const res = search(items, 'dev');
    assert.deepEqual(res.map((r) => r.key), ['ed', 'ja', 'rl']);
    assert.equal(res[0].byName, true);
    assert.deepEqual(res[1], {key: 'ja', byName: false, tabIndexes: [0]});
    assert.deepEqual(res[2], {key: 'rl', byName: false, tabIndexes: [0]});
});

test('search matches tab addresses too', () => {
    assert.deepEqual(search(items, 'indeed').map((r) => r.key), ['ja']);
    assert.deepEqual(search(items, 'cbc.ca').map((r) => r.key), ['mc']);
});

test('search: every word must be in the name, or in one tab', () => {
    assert.deepEqual(search(items, 'shopify careers').map((r) => r.key), ['ja']);
    assert.deepEqual(search(items, 'coffee shopify'), []);
});

test('empty query returns everything in order', () => {
    assert.deepEqual(search(items, '  ').map((r) => r.key), ['mc', 'ed', 'ja', 'rl']);
});
