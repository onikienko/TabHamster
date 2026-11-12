import test from 'node:test';
import assert from 'node:assert/strict';
import {parseQuery, matchesAll, segments, search, urlMatchExcerpt} from '../js/search.js';

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
        {text: 'Tofino trip', hit: true}]);
    assert.deepEqual(segments('abc', []), [{text: 'abc', hit: false}]);
});

test('segments joins matches across whitespace, preserving punctuation and unmatched words', () => {
    assert.deepEqual(segments('Sunshine Coast, BC', parseQuery('sunshine coast')), [
        {text: 'Sunshine Coast', hit: true}, {text: ', BC', hit: false}]);
    assert.deepEqual(segments('Sunshine  Coast\u00a0BC', parseQuery('sunshine coast bc')), [
        {text: 'Sunshine  Coast\u00a0BC', hit: true}]);
    assert.deepEqual(segments('Sunshine, Coast', parseQuery('sunshine coast')), [
        {text: 'Sunshine', hit: true}, {text: ', ', hit: false}, {text: 'Coast', hit: true}]);
    assert.deepEqual(segments('Sunshine and Coast', parseQuery('sunshine coast')), [
        {text: 'Sunshine', hit: true}, {text: ' and ', hit: false}, {text: 'Coast', hit: true}]);
});

test('segments: a word that starts a word is highlighted only there, else wherever it is', () => {
    const hits = (text, query) => segments(text, parseQuery(query)).filter((p) => p.hit).map((p) => p.text);
    assert.deepEqual(hits('Tofino trip photos', 'trip to tofino'), ['Tofino trip']);
    assert.deepEqual(hits('Trip to Tofino', 'trip to tofino'), ['Trip to Tofino']);
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

test('URL excerpts expose path matches with context and omit unrelated ends', () => {
    const url = 'https://example.com/guides/sunshine-coast/places-to-stay';
    assert.equal(urlMatchExcerpt('Travel guide', url, parseQuery('sunshine coast')),
        '….com/guides/sunshine-coast/places-to-s…');
});

test('URL excerpts are absent when the title explains the match or the URL does not match', () => {
    assert.equal(urlMatchExcerpt('Sunshine Coast', 'https://example.com/sunshine-coast', ['SUNSHINE', 'coast']), '');
    assert.equal(urlMatchExcerpt('Travel guide', 'https://example.com/guides', ['sunshine']), '');
    assert.equal(urlMatchExcerpt('Travel guide', 'https://example.com/guides', []), '');
    assert.equal(urlMatchExcerpt('', undefined, ['sunshine']), '');
});

test('URL excerpts explain queries split between title and URL', () => {
    const url = 'https://example.com/' + 'a'.repeat(50) + '/coast/' + 'b'.repeat(50);
    const excerpt = urlMatchExcerpt('Sunshine', url, parseQuery('sunshine coast'));
    assert.equal(excerpt, '…' + 'a'.repeat(11) + '/coast/' + 'b'.repeat(11) + '…');
});

test('URL excerpts keep distant query words, ordered by URL position without duplicated context', () => {
    const url = 'https://example.com/coast/' + 'a'.repeat(80) + '/sunshine/coast';
    const excerpt = urlMatchExcerpt('Travel guide', url, ['sunshine', 'coast']);
    assert.ok(excerpt.indexOf('coast') < excerpt.indexOf('sunshine'));
    assert.ok(excerpt.length < url.length);
    assert.ok(!excerpt.includes('a'.repeat(24)));
    assert.equal(urlMatchExcerpt('Travel guide', url, ['coast', 'sunshine']), excerpt);
});

test('URL excerpts handle long hostnames, query strings, literal punctuation and non-Latin text', () => {
    const url = 'https://' + 'a'.repeat(60) + '.sunshine.example.com/?topic=C++&city=Київ';
    for (const word of ['sunshine', 'C++', 'КИЇВ']) {
        const excerpt = urlMatchExcerpt('Travel guide', url, [word]);
        assert.ok(matchesAll(excerpt, [word]));
        assert.ok(segments(excerpt, [word]).some((part) => part.hit));
    }
    assert.equal(urlMatchExcerpt('', 'about:blank', ['blank']), 'about:blank');
});

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
