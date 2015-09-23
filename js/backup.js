var backup = {
    storage_area: chrome.storage.sync,

    getStoredKeys: function (callback) {
        var stored_keys = [];

        this.storage_area.get(function (storage_items) {
            var storage_key_name;

            // collect saved groups and extension options keys
            for (storage_key_name in storage_items) {
                if (storage_key_name.indexOf('tg_') === 0 || storage.default_options.hasOwnProperty(storage_key_name)) {
                    stored_keys.push(storage_key_name);
                }
            }
            callback(stored_keys);
        });
    },

    getBackupData: function (callback) {
        var self = this;

        this.getStoredKeys(function (stored_keys) {
            self.storage_area.get(stored_keys, function (storage_items) {
                callback(JSON.stringify(storage_items));
            });
        });
    },

    cleanupBeforeReplace: function (callback) {
        var self = this;

        this.getStoredKeys(function (stored_keys) {
            self.storage_area.remove(stored_keys, function () {
                callback(chrome.runtime.lastError);
            });
        });
    },

    replaceFromBackup: function (backup_data, callback) {
        var backup,
            storage_area = this.storage_area;

        try {
            backup = JSON.parse(backup_data);
        } catch(e) {
            callback('error');
        }

        if (backup && typeof backup === 'object') {
            this.cleanupBeforeReplace(function (cleanup_error) {
                if (!cleanup_error) {
                    storage_area.set(backup, function () {
                        callback(chrome.runtime.lastError);
                    });
                } else {
                    callback(cleanup_error);
                }
            });
        }
    }
};