import test from 'node:test';
import assert from 'node:assert/strict';
import {tabGroupFields, tabGroupRuns} from '../js/ui/tab_groups.js';

test('tabGroupFields: tab groups numbered in the order of their first tab, names and colors kept', () => {
    const groups = [
        {id: 7, title: 'Trip', color: 'yellow', collapsed: false},
        {id: 3, title: '', color: 'blue', collapsed: true},
    ];
    const tabs = [{groupId: -1}, {groupId: 3}, {groupId: 3}, {}, {groupId: 7}, {groupId: 3}];
    assert.deepEqual(tabGroupFields(tabs, groups), [
        null,
        {i: 1, t: '', c: 'blue', x: true},
        {i: 1, t: '', c: 'blue', x: true},
        null,
        {i: 2, t: 'Trip', c: 'yellow'},
        {i: 1, t: '', c: 'blue', x: true},
    ]);
});

test('tabGroupFields: a tab group that wasn\'t read (no permission) leaves its tabs plain', () => {
    assert.deepEqual(tabGroupFields([{groupId: 3}, {groupId: 4}], []), [null, null]);
    assert.deepEqual(tabGroupFields([{groupId: 3}, {groupId: 4}], [{id: 4, title: 'A', color: 'red'}]),
        [null, {i: 1, t: 'A', c: 'red'}]);
});

test('tabGroupRuns: the first of each run of neighbours starts it; an unknown color is grey', () => {
    const a = {id: 1, t: 'Trip', c: 'yellow'};
    const b = {id: 2, t: '', c: 'magenta'};
    assert.deepEqual(tabGroupRuns([null, a, a, b, null, a]), [
        null,
        {t: 'Trip', c: 'yellow', start: true},
        {t: 'Trip', c: 'yellow', start: false},
        {t: '', c: 'grey', start: true},
        null,
        {t: 'Trip', c: 'yellow', start: true},
    ]);
});
