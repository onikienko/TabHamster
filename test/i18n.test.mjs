import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// chrome.i18n for one Chrome UI language, with the texts of one of our locales (what Chrome falls back to)
function fakeChrome(ui, folder) {
    const messages = JSON.parse(fs.readFileSync(new URL('../_locales/' + folder + '/messages.json', import.meta.url), 'utf8'));
    globalThis.chrome = {
        i18n: {
            getUILanguage: () => ui,
            getMessage(key, args) {
                const m = messages[key];
                if (!m) {
                    return '';
                }
                let text = m.message;
                for (const [name, p] of Object.entries(m.placeholders || {})) {
                    const i = parseInt(p.content.slice(1), 10) - 1;
                    text = text.split('$' + name.toUpperCase() + '$').join(args ? String(args[i]) : '');
                }
                return text;
            },
        },
    };
}

// a fresh module each time: plural() keeps its rules
let n = 0;
async function i18n(ui, folder) {
    fakeChrome(ui, folder);
    return import('../js/ui/i18n.js?' + n++);
}

test('uiLanguage: Chrome\'s variant when the texts are in its language', async () => {
    assert.equal((await i18n('en-GB', 'en')).uiLanguage(), 'en-GB');
    assert.equal((await i18n('uk', 'uk')).uiLanguage(), 'uk');
    assert.equal((await i18n('es-419', 'es')).uiLanguage(), 'es-419');
});

test('uiLanguage: the texts\' language when Chrome\'s has no translation', async () => {
    assert.equal((await i18n('pt-BR', 'en')).uiLanguage(), 'en');
    assert.equal((await i18n('de', 'en')).uiLanguage(), 'en');
});

test('plural forms follow the texts\' language', async () => {
    // Portuguese 0 is "one", Croatian 21 is "one": with English texts both are "other"
    assert.equal((await i18n('pt-BR', 'en')).plural('p_tabsCount', 0), '0 tabs');
    assert.equal((await i18n('hr', 'en')).plural('p_tabsCount', 21), '21 tabs');
    const uk = await i18n('uk', 'uk');
    assert.equal(uk.plural('p_tabsCount', 21), '21 вкладка');
    assert.equal(uk.plural('p_tabsCount', 22), '22 вкладки');
    assert.equal(uk.plural('p_tabsCount', 25), '25 вкладок');
});

test('isolate wraps right-to-left text only', async () => {
    const {isolate} = await i18n('en', 'en');
    assert.equal(isolate('Work'), 'Work');
    assert.equal(isolate('עבודה'), '⁨עבודה⁩');
});
