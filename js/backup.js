// Backup text: saved groups and options as readable JSON, in the same shape 0.3.0 used
// ({option: value, ..., 'tg_<ms>': {name, index, tabs}}). Runs in the background service worker,
// needs storage.js and group_store.js.
var backup = (function () {
    'use strict';

    // first line of a backup that 0.3.0 can't restore (too big for its sync storage): 0.3.0 wipes
    // everything before it writes, so it must reject the file. 0.4.0 skips this line.
    const NEWER_ONLY_LINE = 'TabHamster backup. Restore it with TabHamster 0.4.0 or newer.';

    function fail(code) {
        const e = new Error('Backup: ' + code);
        e.code = code;
        return e;
    }

    /**
     * @param {Object} groups {key: {name, index, tabs}}
     * @param {Object} options extension options
     * @param {Object} sync_limits chrome.storage.sync (QUOTA_BYTES_PER_ITEM, QUOTA_BYTES): what 0.3.0 could restore
     * @returns {string}
     */
    function exportText(groups, options, sync_limits) {
        const data = Object.assign({}, options);
        let total = 0;
        let fits_old_version = true;

        Object.keys(groups).sort().forEach(function (key) {
            data[key] = {name: groups[key].name, index: groups[key].index, tabs: groups[key].tabs};
        });
        Object.keys(data).forEach(function (key) {
            const bytes = groupStore.itemBytes(key, data[key]);
            total += bytes;
            fits_old_version = fits_old_version && bytes <= sync_limits.QUOTA_BYTES_PER_ITEM;
        });
        fits_old_version = fits_old_version && total <= sync_limits.QUOTA_BYTES;

        const json = JSON.stringify(data, null, 2);
        return fits_old_version ? json : NEWER_ONLY_LINE + '\n' + json;
    }

    // the choices each text option has; on/off options are 0 or 1
    const CHOICES = {
        date_format: ['eu', 'us'],
        active_tab: ['#saved', '#sessions'],
        theme: ['system', 'light', 'dark'],
    };

    // an option value as the extension uses it, or undefined (the current setting stays): a hand-edited backup can
    // have "pinned": 2 or a theme that doesn't exist
    function cleanOption(key, value) {
        const fallback = storage.default_options[key];
        if (typeof fallback === 'number') {
            return typeof value === 'number' || typeof value === 'boolean' ? (value ? 1 : 0) : undefined;
        }
        if (CHOICES[key]) {
            return CHOICES[key].includes(value) ? value : undefined;
        }
        return typeof value === typeof fallback ? value : undefined;
    }

    function cleanTabs(tabs) {
        return tabs.filter(function (tab) {
            return tab && typeof tab === 'object' && typeof tab.url === 'string';
        }).map(function (tab, i) {
            const clean = {url: tab.url, title: typeof tab.title === 'string' ? tab.title : tab.url, id: i};
            if (tab.pinned === true) {
                clean.pinned = true;
            }
            return clean;
        });
    }

    /**
     * Reads a backup made by any version: 0.3.0 text, 0.4.0 export, or raw sync data with chunks.
     * @param {string} text
     * @returns {Promise<{groups: Object, options: Object}>}
     * @throws {Error} with code 'not_backup', 'damaged' (some groups can't be read) or 'empty'
     */
    async function parseText(text) {
        let body = String(text).trim();
        let data;

        if (body.indexOf(NEWER_ONLY_LINE) === 0) {
            body = body.slice(NEWER_ONLY_LINE.length).trim();
        }
        try {
            data = JSON.parse(body);
        } catch (e) {
            throw fail('not_backup');
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw fail('not_backup');
        }

        const options = {};
        Object.keys(storage.default_options).forEach(function (key) {
            const value = cleanOption(key, data[key]);
            if (data.hasOwnProperty(key) && value !== undefined) {
                options[key] = value;
            }
        });

        const groups = {};
        for (const key of Object.keys(data).filter(groupStore.isGroupKey)) {
            const res = await groupStore.decodeGroup(key, data);
            if (res.status !== 'ok') {
                throw fail('damaged');
            }
            groups[key] = {name: res.group.name, index: res.group.index, tabs: cleanTabs(res.group.tabs)};
        }

        if (!Object.keys(groups).length && !Object.keys(options).length) {
            throw fail('empty');
        }
        return {groups, options};
    }

    return {NEWER_ONLY_LINE, exportText, parseText};
}());
