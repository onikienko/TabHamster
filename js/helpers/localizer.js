/**
 * This is a part of Chrome Extensions Box
 * Read more on GitHub - https://github.com/onikienko/chrome-extensions-box
 *
 * Parse html and replace all {{property name from message.json}} from text nodes, title, alt, value and placeholder attrs
 * with chrome.i18n.getMessage http://developer.chrome.com/extensions/i18n.html
 */
window.addEventListener('load', function () {
    function translator(html) {
        var i,
            length,
            attrs_to_check = ['title', 'alt', 'placeholder', 'value'];

        function replacer(text) {
            return text.replace(/\{\{([\s\S]*?)\}\}/gm, function (str, g1) {
                return chrome.i18n.getMessage(g1.trim()) || str;
            });
        }

        if (html.attributes) {
            attrs_to_check.forEach(function (el) {
                if (html.attributes[el]) {
                    html.attributes[el].value = replacer(html.attributes[el].value);
                }
            });
        }

        if (html.nodeType === 3) { //text node
            html.data = replacer(html.data);
        } else {
            for (i = 0, length = html.childNodes.length; i < length; i++) {
                translator(html.childNodes[i]);
            }
        }
    }

    translator(document.body);
    translator(document.head);
});