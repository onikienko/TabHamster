import test from 'node:test';
import assert from 'node:assert/strict';
import {domainToASCII} from 'node:url';
import {keyTime, numericDate, shortDate, shortTime, dayName, dayTime, interval, hostOf, kilobytes, listDate, fullDate} from '../js/ui/format.js';

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

test('hostOf shows xn-- names readable, except Latin mixed with another script', () => {
    // new URL() gives the xn-- form, as Chrome stores tab addresses
    assert.equal(hostOf('https://домен.укр/сторінка'), 'домен.укр');
    assert.equal(hostOf('https://www.пример.срб/'), 'пример.срб');
    assert.equal(hostOf('https://bücher.example/'), 'bücher.example');
    assert.equal(hostOf('https://例え.jp/'), '例え.jp');
    // "аpple" with a Cyrillic а
    assert.equal(hostOf('https://\u0430pple.com/'), domainToASCII('\u0430pple.com'));
});

test('hostOf decodes like Node for many labels', () => {
    const words = ['київ', 'україна', 'Ελλάδα', 'בדיקה', 'テスト', '中文网', 'ñandú', 'straße', 'mañana-123', 'éé', 'ăâîșț'];
    for (const word of words) {
        const ascii = domainToASCII(word + '.example');
        assert.equal(hostOf('https://' + ascii + '/'), new URL('https://' + ascii).host.split('.').map((label, i) =>
            i === 0 ? word.toLowerCase().normalize('NFC') : label).join('.'), word);
    }
});

test('hostOf drops www and copes with addresses without a host', () => {
    assert.equal(hostOf('https://www.github.com/onikienko'), 'github.com');
    assert.equal(hostOf('https://uk.wikipedia.org/wiki/Україна'), 'uk.wikipedia.org');
    assert.equal(hostOf('about:blank'), 'about:blank');
    assert.equal(hostOf('not a url'), 'not a url');
    assert.equal(hostOf(undefined), '');
});

test('dayName: Today, Yesterday, then dates; or always the date', () => {
    const now = new Date(2026, 9, 19, 10, 0).getTime();
    assert.equal(dayName(new Date(2026, 9, 19, 0, 5).getTime(), 'en-US', now), 'Today');
    assert.equal(dayName(new Date(2026, 9, 18, 23, 59).getTime(), 'en-US', now), 'Yesterday');
    assert.equal(dayName(new Date(2026, 9, 17, 12, 0).getTime(), 'en-US', now), 'Oct 17');
    assert.equal(dayName(new Date(2026, 9, 18, 12, 0).getTime(), 'en-US', now, false), 'Oct 18');
    assert.equal(dayName(new Date(2026, 9, 18, 12, 0).getTime(), 'uk', now), 'Учора');
    // mid-sentence
    assert.equal(dayName(new Date(2026, 9, 18, 12, 0).getTime(), 'fr', now, true, false), 'hier');
    assert.equal(dayName(new Date(2026, 9, 19, 12, 0).getTime(), 'uk', now, true, false), 'сьогодні');
});

test('interval: one day, across days, relative or not', () => {
    const now = new Date(2026, 9, 19, 10, 0).getTime();
    const t = (d, h, m) => new Date(2026, 9, d, h, m).getTime();
    const time = (ms) => shortTime(ms, 'en-US');
    assert.equal(interval(t(18, 14, 2), t(18, 23, 5), 'en-US', now), 'Yesterday, ' + time(t(18, 14, 2)) + '–' + time(t(18, 23, 5)));
    assert.equal(interval(t(11, 10, 2), t(12, 1, 51), 'en-US', now),
        'Oct 11, ' + time(t(11, 10, 2)) + '–Oct 12, ' + time(t(12, 1, 51)));
    assert.equal(interval(t(18, 22, 0), t(19, 1, 0), 'en-US', now),
        'Yesterday, ' + time(t(18, 22, 0)) + '–Today, ' + time(t(19, 1, 0)));
    assert.equal(interval(t(18, 14, 2), t(18, 23, 5), 'en-US', now, false), 'Oct 18, ' + time(t(18, 14, 2)) + '–' + time(t(18, 23, 5)));
    assert.equal(dayTime(t(9, 21, 40), 'en-US', now), 'Oct 9, ' + time(t(9, 21, 40)));
});

test('kilobytes: 1024 bytes, rounded down, never 0.0 for something', () => {
    assert.equal(kilobytes(26010, 'en'), '25.4');
    assert.equal(kilobytes(26010, 'uk'), '25,4');
    assert.equal(kilobytes(2048, 'en'), '2.0');
    assert.equal(kilobytes(40, 'en'), '0.1');
    assert.equal(kilobytes(0, 'en'), '0.0');
    assert.equal(kilobytes(102399, 'en', 0), '99');
    assert.equal(kilobytes(102400, 'en', 0), '100');
});

test('listDate: day and month this year, only the year for another one', () => {
    const now = new Date(2026, 9, 19, 12, 0).getTime();
    assert.equal(listDate(new Date(2026, 9, 15).getTime(), 'en', now), 'Oct 15');
    assert.equal(listDate(new Date(2026, 0, 2).getTime(), 'uk', now), new Intl.DateTimeFormat('uk', {month: 'short', day: 'numeric'}).format(new Date(2026, 0, 2)));
    assert.equal(listDate(new Date(2025, 8, 28).getTime(), 'uk', now), '2025');
    assert.match(fullDate(new Date(2025, 8, 28, 21, 52).getTime(), 'en'), /^September 28, 2025.*9:52/);
});
