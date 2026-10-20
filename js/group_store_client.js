// Saved groups for the popup and options pages. The store itself runs in the background service worker
// (js/background.js), so all writes go through one place even if the page closes mid-save.
// Every method returns a Promise with the store's result (see createGroupStore in js/group_store.js).
// The background also sends {msg: 'groupsSynced', keys} to open pages when groups that waited for sync got there.
var groupStoreClient = (function () {
    'use strict';

    function call(op, args) {
        return chrome.runtime.sendMessage({msg: 'groups', op: op, args: args}).then(function (res) {
            if (!res) {
                throw new Error('No answer from the background service worker');
            }
            if (res.error) {
                throw new Error(res.error);
            }
            return res.result;
        });
    }

    return {
        /** groups that aren't deleted: {key: {name, index, tabs, h, synced}}; catches up with sync first */
        list: function () {
            return call('list', []);
        },
        /** deleted groups kept for 30 days, newest first */
        listTrash: function () {
            return call('listTrash', []);
        },
        /** {synced, error?, copy?}; for a new group (changes to a saved one: setTabs, rename, setIndex) */
        save: function (key, group) {
            return call('save', [key, group]);
        },
        /**
         * {synced, error?, copy?, h}: new tabs, name and place as they are now. seen_h: `h` of the tabs that were
         * changed; if they changed on another computer since, this version is saved as a copy (`copy` is its key)
         */
        setTabs: function (key, tabs, seen_h) {
            return call('setTabs', [key, tabs, seen_h]);
        },
        /** {synced, error?}: new name, tabs and place as they are now */
        rename: function (key, name) {
            return call('rename', [key, name]);
        },
        /** {key: {synced, error?}} for {key: index}: tabs and name as they are now */
        setIndex: function (indexes) {
            return call('setIndex', [indexes]);
        },
        /** {synced, error?} */
        remove: function (key) {
            return call('remove', [key]);
        },
        /**
         * {synced, error?}; like remove, but the group is not kept in Recently deleted (undo of a new save).
         * saved: the group as it was saved; if it has changed since, it goes to Recently deleted after all
         */
        discard: function (key, saved) {
            return call('discard', [key, saved]);
        },
        /** {synced, error?} */
        restore: function (key) {
            return call('restore', [key]);
        },
        /** {bytes, quota, unsynced} */
        usage: function () {
            return call('usage', []);
        },
        /** {key: {bytes, synced}}: space each group takes in sync (or needs there, null if it can't fit) */
        sizes: function () {
            return call('sizes', []);
        },
        /** backup text with saved groups and options */
        exportBackup: function () {
            return call('exportBackup', []);
        },
        /**
         * what importBackup would do, without changing anything: {groups, tabs, options, current, trashed}
         * or {error: 'not_backup' | 'damaged' | 'empty'}
         */
        previewBackup: function (text) {
            return call('previewBackup', [text]);
        },
        /** {groups, errors} or {error: 'not_backup' | 'damaged' | 'empty'} when nothing was changed */
        importBackup: function (text) {
            return call('importBackup', [text]);
        },
        /** {groups, errors} or {error: 'nothing_to_undo'} */
        undoRestore: function () {
            return call('undoRestore', []);
        },
        /** {time, restored, trashed} of the restore that can be undone (counts null if made by 0.4.0), or null */
        restoreInfo: function () {
            return call('restoreInfo', []);
        },
    };
}());
