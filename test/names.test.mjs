import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeName, sameName, findByName, countByName, freeName} from '../js/names.js';

test('normalizeName trims and collapses spaces', () => {
    assert.equal(normalizeName('  Trip   to\tTofino '), 'Trip to Tofino');
    assert.equal(normalizeName(undefined), '');
    assert.equal(normalizeName(null), '');
});

test('sameName ignores case and extra spaces but not accents', () => {
    assert.ok(sameName('Trip to Tofino', 'trip  to TOFINO '));
    assert.ok(sameName('Збережені', 'збережені'));
    assert.ok(!sameName('Cafe', 'Café'));
    assert.ok(!sameName('Work', 'Work 2'));
    assert.ok(sameName('Cafe\u0301', 'CAFÉ'), 'composed and decomposed accents are the same');
});

test('sameName: kana, full-width letters, superscripts and ordinals stay distinct', () => {
    assert.ok(!sameName('かな', 'カナ'));
    assert.ok(!sameName('Ｗｏｒｋ', 'Work'));
    assert.ok(!sameName('Work 2', 'Work ²'));
    assert.ok(!sameName('a', 'ª'));
    assert.ok(sameName('ΟΔΟΣ', 'οδος'));
});

test('empty names never clash', () => {
    assert.ok(!sameName('', ''));
    assert.ok(!sameName('  ', ''));
});

test('findByName returns the matching key, the newest one when several share a name', () => {
    const groups = {
        tg_1000: {name: 'Reading list'},
        tg_3000: {name: 'reading list'},
        tg_2000: {name: 'Trip to Tofino'},
        tg_4000: {name: ''},
    };
    assert.equal(findByName(groups, 'READING LIST'), 'tg_3000');
    assert.equal(findByName(groups, 'trip  to tofino'), 'tg_2000');
    assert.equal(findByName(groups, 'Hockey'), null);
    assert.equal(findByName(groups, ''), null);
});

test('findByName can ignore the group being renamed', () => {
    const groups = {tg_1: {name: 'Work'}, tg_2: {name: 'Home'}};
    assert.equal(findByName(groups, 'work', 'tg_1'), null);
    assert.equal(findByName(groups, 'home', 'tg_1'), 'tg_2');
});

test('countByName', () => {
    const groups = {tg_1: {name: 'Work'}, tg_2: {name: 'work'}, tg_3: {name: 'Home'}};
    assert.equal(countByName(groups, 'WORK'), 2);
    assert.equal(countByName(groups, 'Gym'), 0);
});

test('freeName adds the first free number, matching names as Save does', () => {
    assert.equal(freeName({}, 'Oct 18, 14:02–23:05'), 'Oct 18, 14:02–23:05');
    const groups = {tg_1: {name: 'work'}, tg_2: {name: ' Work  (2)'}, tg_3: {name: ''}};
    assert.equal(freeName(groups, 'Work'), 'Work (3)');
    assert.equal(freeName(groups, 'Work (2)'), 'Work (2) (2)');
    assert.equal(freeName(groups, 'Café'), 'Café');
});
