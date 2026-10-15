const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// js/utils.js is a browser script defining a global `utils`
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js/utils.js'), 'utf8') + '\nthis.utils = utils;', context);
const utils = context.utils;

test('escapeHtml makes text safe in HTML text and attributes', () => {
    assert.equal(utils.escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    assert.equal(utils.escapeHtml("Tom & Jerry's"), 'Tom &amp; Jerry&#39;s');
    assert.equal(utils.escapeHtml('https://example.com/?a=1&b=<2>'), 'https://example.com/?a=1&amp;b=&lt;2&gt;');
    assert.equal(utils.escapeHtml('Назва групи ґ є і ї'), 'Назва групи ґ є і ї');
    assert.equal(utils.escapeHtml(42), '42');
});
