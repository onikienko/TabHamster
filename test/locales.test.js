// Every locale has the keys of en, with the same placeholders. Extra keys only for plural forms (_few, _many...).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '_locales');
const read = (lang) => JSON.parse(fs.readFileSync(path.join(DIR, lang, 'messages.json'), 'utf8'));
const EN = read('en');
const LANGS = fs.readdirSync(DIR).filter((lang) => lang !== 'en');
const PLURAL = /^(.*)_(zero|one|two|few|many|other)$/;

// $COUNT$ → 'count'; $$ is a literal dollar sign
function used(message) {
    return new Set([...message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map((m) => m[1].toLowerCase()));
}

function contents(placeholders) {
    return Object.fromEntries(Object.entries(placeholders || {}).map(([name, p]) => [name.toLowerCase(), p.content]));
}

// the en entry a key is checked against: itself, or the _other form of its plural
function source(key) {
    const plural = key.match(PLURAL);
    return EN[key] || (plural && EN[plural[1] + '_other']);
}

test('locales: the six languages', () => {
    assert.deepEqual(LANGS.sort(), ['es', 'fr', 'hu', 'sr', 'uk']);
});

for (const lang of LANGS) {
    const messages = read(lang);

    test(lang + ': has every en key', () => {
        assert.deepEqual(Object.keys(EN).filter((key) => !messages[key]), []);
    });

    test(lang + ': no keys that en doesn\'t have, other than plural forms', () => {
        assert.deepEqual(Object.keys(messages).filter((key) => !source(key)), []);
    });

    test(lang + ': placeholders defined and used like in en', () => {
        for (const [key, entry] of Object.entries(messages)) {
            const en = source(key);
            if (!en) {
                continue;
            }
            assert.equal(typeof entry.message, 'string', key);
            assert.deepEqual(contents(entry.placeholders), contents(en.placeholders), key + ': placeholders');
            const defined = Object.keys(contents(entry.placeholders));
            for (const name of used(entry.message)) {
                assert.ok(defined.includes(name), key + ': $' + name.toUpperCase() + '$ is not defined');
            }
            for (const name of used(en.message)) {
                assert.ok(used(entry.message).has(name), key + ': $' + name.toUpperCase() + '$ is missing');
            }
        }
    });
}

// keys that end in _other but aren't plurals; plurals whose count starts above 0
const NOT_PLURAL = ['o_backup_error'];
const LOWEST = {p_sameNameGroups: 2};

for (const lang of ['en'].concat(LANGS)) {
    const messages = read(lang);

    test(lang + ': every plural message has the forms the language needs', () => {
        const rules = new Intl.PluralRules(lang);
        const bases = Object.keys(messages).filter((key) => key.endsWith('_other')).map((key) => key.slice(0, -6))
            .filter((base) => !NOT_PLURAL.includes(base));
        const missing = new Set();
        for (const base of bases) {
            for (let n = LOWEST[base] || 0; n <= 200; n++) {
                const form = rules.select(n);
                // "many" in es / fr is for millions: _other reads right
                if (!messages[base + '_' + form] && form !== 'many') {
                    missing.add(base + '_' + form);
                }
            }
        }
        assert.deepEqual([...missing], []);
    });

    test(lang + ': no empty texts', () => {
        assert.deepEqual(Object.keys(messages).filter((key) => !messages[key].message.trim()), []);
    });

    test(lang + ': locale is the folder name', () => {
        assert.equal(messages.locale.message, lang);
    });
}
