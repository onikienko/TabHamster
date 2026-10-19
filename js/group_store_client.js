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
        /** groups that aren't deleted: {key: {name, index, tabs, synced}}; catches up with sync first */
        list: function () {
            return call('list', []);
        },
        /** deleted groups kept for 30 days, newest first */
        listTrash: function () {
            return call('listTrash', []);
        },
        /** {synced, error?, copy?} */
        save: function (key, group) {
            return call('save', [key, group]);
        },
        /** {key: {synced, error?, copy?}} */
        saveMany: function (groups) {
            return call('saveMany', [groups]);
        },
        /** {synced, error?} */
        remove: function (key) {
            return call('remove', [key]);
        },
        /** {synced, error?}; like remove, but the group is not kept in Recently deleted (undo of a new save) */
        discard: function (key) {
            return call('discard', [key]);
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
        /** {groups, errors} or {error: 'not_backup' | 'damaged' | 'empty'} when nothing was changed */
        importBackup: function (text) {
            return call('importBackup', [text]);
        },
        /** {groups, errors} or {error: 'nothing_to_undo'} */
        undoRestore: function () {
            return call('undoRestore', []);
        },
        /** time of the restore that can be undone, or null */
        restoreInfo: function () {
            return call('restoreInfo', []);
        },
    };
}());
