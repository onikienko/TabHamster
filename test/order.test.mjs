import test from 'node:test';
import assert from 'node:assert/strict';
import {indexAt, renumber, moveTo} from '../js/order.js';

test('indexAt: top, bottom, between, alone', () => {
    assert.equal(indexAt([5, 3, 1], 0), 6);
    assert.equal(indexAt([5, 3, 1], 3), 0);
    assert.equal(indexAt([9, 3, 1], 1), 6);
    assert.equal(indexAt([5, 4], 1), 4.5);
    assert.equal(indexAt([], 0), 1);
    assert.equal(indexAt([2.5], 0), 3);
    assert.equal(indexAt([2.5], 1), 2);
});

test('indexAt: no room between equal neighbours', () => {
    assert.equal(indexAt([4, 4], 1), null);
    assert.equal(indexAt([1 + Number.EPSILON, 1], 1), null);
});

test('indexAt keeps finding room for many moves into one place', () => {
    let above = 2;
    const below = 1;
    for (let i = 0; i < 40; i++) {
        const index = indexAt([above, below], 1);
        assert.ok(index > below && index < above);
        above = index;
    }
});

test('renumber gives n..1 and lists only changes', () => {
    assert.deepEqual(renumber(['a', 'b', 'c'], {a: {index: 3}, b: {index: 7}, c: {index: 1}}), {b: 2});
});

const groups = {a: {index: 4}, b: {index: 3}, c: {index: 2}, d: {index: 1}};
const keys = ['a', 'b', 'c', 'd'];

test('moveTo changes only the moved group', () => {
    assert.deepEqual(moveTo(keys, groups, 'd', 0), {d: 5});
    assert.deepEqual(moveTo(keys, groups, 'a', 3), {a: 0});
    assert.deepEqual(moveTo(keys, groups, 'a', 1), {a: 2.5});
    assert.deepEqual(moveTo(keys, groups, 'c', 0), {c: 5});
});

test('moveTo renumbers when the neighbours are equal', () => {
    const tied = {a: {index: 3}, b: {index: 2}, c: {index: 2}, d: {index: 1}};
    // a between b and c: b, a, c, d = 4, 3, 2, 1, so only b changes
    assert.deepEqual(moveTo(keys, tied, 'a', 1), {b: 4});
    assert.deepEqual(moveTo(['b', 'c', 'a', 'd'], {a: {index: 2}, b: {index: 2}, c: {index: 2}, d: {index: 1}}, 'd', 1),
        {b: 4, d: 3, a: 1});
});
