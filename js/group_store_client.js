// Saved groups for the popup and options pages. The store itself runs in the background service worker
// (js/background.js), so all writes go through one place even if the page closes mid-save.
// Every method returns a Promise with the store's result (see createGroupStore in js/group_store.js).
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
        /** {synced, error?} */
        restore: function (key) {
            return call('restore', [key]);
        },
        /** {bytes, quota, unsynced} */
        usage: function () {
            return call('usage', []);
        },
    };
}());
