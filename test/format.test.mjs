import test from 'node:test';
import assert from 'node:assert/strict';
import {keyTime, numericDate, shortDate, hostOf} from '../js/ui/format.js';

test('keyTime reads tg_<ms> keys', () => {
    assert.equal(keyTime('tg_1760000000000'), 1760000000000);
    assert.equal(keyTime('nonsense'), 0);
});

test('numericDate: day first (eu) or year first (us), like 0.4.0', () => {
    const ms = new Date(2026, 9, 6, 9, 5).getTime();
    assert.equal(numericDate(ms, 'eu'), '06-10-2026 09:05');
    assert.equal(numericDate(ms, 'us'), '2026-10-06 09:05');
});

test('shortDate adds the year only for another year', () => {
    const now = new Date(2026, 9, 16).getTime();
    assert.equal(shortDate(new Date(2026, 9, 15).getTime(), 'en-US', now), 'Oct 15');
    assert.equal(shortDate(new Date(2025, 9, 15).getTime(), 'en-US', now), 'Oct 15, 2025');
});

test('hostOf drops www and copes with addresses without a host', () => {
    assert.equal(hostOf('https://www.github.com/onikienko'), 'github.com');
    assert.equal(hostOf('https://uk.wikipedia.org/wiki/Україна'), 'uk.wikipedia.org');
    assert.equal(hostOf('about:blank'), 'about:blank');
    assert.equal(hostOf('not a url'), 'not a url');
    assert.equal(hostOf(undefined), '');
});
