import test from 'node:test';
import assert from 'node:assert/strict';
import {isMac, keyLabel, keyCombo, wantsNewWindow} from '../js/ui/platform.js';

test('isMac from userAgentData, then platform', () => {
    assert.equal(isMac({userAgentData: {platform: 'macOS'}}), true);
    assert.equal(isMac({platform: 'MacIntel'}), true);
    assert.equal(isMac({platform: 'Win32'}), false);
    assert.equal(isMac({}), false);
});

test('keyLabel per platform', () => {
    assert.equal(keyLabel('enter', true), 'Return');
    assert.equal(keyLabel('enter', false), 'Enter');
    assert.equal(keyLabel('alt', true), '⌥ Option');
    assert.throws(() => keyLabel('nope', true));
});

test('keyCombo: Mac symbols, + elsewhere', () => {
    assert.equal(keyCombo(['enter'], true), 'Return');
    assert.equal(keyCombo(['shift', 'enter'], true), '⇧ Return');
    assert.equal(keyCombo(['shift', 'enter'], false), 'Shift+Enter');
    assert.equal(keyCombo(['shift', 'F10'], false), 'Shift+F10');
    assert.equal(keyCombo(['esc'], false), 'Esc');
});

test('wantsNewWindow: Shift, ⌘ on a Mac, Ctrl elsewhere, middle button', () => {
    assert.equal(wantsNewWindow({shiftKey: true}, false), true);
    assert.equal(wantsNewWindow({metaKey: true}, true), true);
    assert.equal(wantsNewWindow({ctrlKey: true}, true), false);
    assert.equal(wantsNewWindow({ctrlKey: true}, false), true);
    assert.equal(wantsNewWindow({button: 1}, false), true);
    assert.equal(wantsNewWindow({button: 0}, false), false);
});
