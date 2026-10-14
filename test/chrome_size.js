// chrome.storage.sync rules as Chrome enforces them: documented limits, and item size the way Chromium
// counts it (UTF-8 key length + length of base::JSONWriter output for the value).
// Written independently from js/group_store.js on purpose, so tests can check its byte math.

const SYNC_LIMITS = {
    QUOTA_BYTES: 102400,
    QUOTA_BYTES_PER_ITEM: 8192,
    MAX_ITEMS: 512,
    MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
    MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
};

function hex4(n) {
    return n.toString(16).toUpperCase().padStart(4, '0');
}

function writeString(str) {
    let out = '"';
    for (const ch of str) {
        const cp = ch.codePointAt(0);
        switch (ch) {
            case '\b': out += '\\b'; continue;
            case '\f': out += '\\f'; continue;
            case '\n': out += '\\n'; continue;
            case '\r': out += '\\r'; continue;
            case '\t': out += '\\t'; continue;
            case '\\': out += '\\\\'; continue;
            case '"': out += '\\"'; continue;
            case '<': out += '\\u003C'; continue;
        }
        if (cp === 0x2028 || cp === 0x2029 || cp < 0x20) {
            out += '\\u' + hex4(cp);
        } else if (cp >= 0xD800 && cp <= 0xDFFF) {
            // lone surrogate becomes U+FFFD when converted to UTF-8
            out += '\uFFFD';
        } else {
            out += ch;
        }
    }
    return out + '"';
}

function writeValue(value) {
    if (value === null) {
        return 'null';
    }
    switch (typeof value) {
        case 'boolean':
            return String(value);
        case 'number': {
            if (Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31) {
                return String(value);
            }
            // doubles: JSONWriter adds '.0' when the number has no fraction or exponent
            const s = String(value);
            return /[.eE]/.test(s) ? s : s + '.0';
        }
        case 'string':
            return writeString(value);
        case 'object':
            if (Array.isArray(value)) {
                return '[' + value.map(function (el) {
                    return el === undefined ? 'null' : writeValue(el);
                }).join(',') + ']';
            }
            return '{' + Object.keys(value).filter(function (k) {
                return value[k] !== undefined && typeof value[k] !== 'function';
            }).map(function (k) {
                return writeString(k) + ':' + writeValue(value[k]);
            }).join(',') + '}';
    }
    throw new Error('Unsupported value type: ' + typeof value);
}

function chromeItemSize(key, value) {
    return Buffer.byteLength(key) + Buffer.byteLength(writeValue(value));
}

module.exports = {SYNC_LIMITS, chromeItemSize};
