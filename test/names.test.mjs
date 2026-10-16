import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeName, sameName, findByName, countByName} from '../js/names.js';

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
