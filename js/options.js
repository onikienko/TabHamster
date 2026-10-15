var main_tabs = new Tabs('#main_tabs');

document.addEventListener('optionSaved', function (event) {
    // reload extension after toggle session watcher option
    if (event.detail.val.hasOwnProperty('session_watcher') && event.detail.success) {
        chrome.runtime.reload();
    }
}, false);

// Backup tab: backup text and file, restore, undo of the last restore, recently deleted groups.
// Saved groups are read and written by the background service worker (js/group_store_client.js).
var backupUI = {
    MESSAGE_KEY: 'backup_message', // shown after the page reloads

    // key of a message from _locales
    showMessage: function (key, is_error) {
        var el = document.getElementById('backup_msg');

        el.textContent = chrome.i18n.getMessage(key);
        el.className = is_error ? 'error' : 'ok';
    },

    // option values on the page are from before the restore: reload, then show the message
    reloadWithMessage: function (key) {
        sessionStorage.setItem(this.MESSAGE_KEY, key);
        location.reload();
    },

    formatTime: function (time) {
        return utils.formatDate(new Date(time), this.date_format);
    },

    // title of a group the way the popup shows it: its name, or the date it was saved
    groupTitle: function (key, group) {
        return group.name || this.formatTime(parseInt(key.slice('tg_'.length), 10));
    },

    showBackupText: function () {
        groupStoreClient.exportBackup().then(function (text) {
            document.getElementById('backup_text').value = text;
        });
    },

    download: function () {
        groupStoreClient.exportBackup().then(function (text) {
            var link = document.createElement('a'),
                url = URL.createObjectURL(new Blob([text], {type: 'application/json'})),
                now = new Date(),
                // local date, not UTC
                today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(function (n) {
                    return String(n).padStart(2, '0');
                }).join('-');

            link.href = url;
            link.download = 'tabhamster-backup-' + today + '.json';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function () {
                URL.revokeObjectURL(url);
            }, 1000);
        });
    },

    restore: function () {
        var self = this,
            text = document.getElementById('restore_text').value,
            error_keys = {
                not_backup: 'o_backup_error_notBackup',
                damaged: 'o_backup_error_damaged',
                empty: 'o_backup_error_empty',
            };

        if (!text.trim()) {
            this.showMessage('o_backup_error_notBackup', true);
            return;
        }
        groupStoreClient.importBackup(text).then(function (res) {
            if (res.error) {
                self.showMessage(error_keys[res.error] || 'o_backup_error_other', true);
            } else {
                self.reloadWithMessage('o_backup_restored');
            }
        }, function () {
            self.showMessage('o_backup_error_other', true);
        });
    },

    // put the chosen file into the text area; Restore button does the rest
    readFile: function (file) {
        var self = this;

        file.text().then(function (text) {
            document.getElementById('restore_text').value = text;
        }, function () {
            self.showMessage('o_backup_error_notBackup', true);
        });
    },

    showUndoRestore: function () {
        var self = this;

        groupStoreClient.restoreInfo().then(function (time) {
            document.getElementById('undo_restore').style.display = time ? 'block' : 'none';
            if (time) {
                document.getElementById('undo_restore_time').textContent = '(' + self.formatTime(time) + ')';
            }
        });
    },

    undoRestore: function () {
        var self = this;

        groupStoreClient.undoRestore().then(function (res) {
            if (res.error) {
                self.showUndoRestore();
            } else {
                self.reloadWithMessage('o_backup_undone');
            }
        }, function () {
            self.showMessage('o_backup_error_other', true);
        });
    },

    showTrash: function () {
        var self = this,
            list = document.getElementById('trash_list');

        groupStoreClient.listTrash().then(function (groups) {
            list.textContent = '';
            document.getElementById('trash_empty').style.display = groups.length ? 'none' : 'block';
            groups.forEach(function (group) {
                var item = document.createElement('li'),
                    title = document.createElement('strong'),
                    info = document.createElement('span'),
                    button = document.createElement('button');

                title.textContent = self.groupTitle(group.key, group);
                info.textContent = ' ' + chrome.i18n.getMessage('p_tabsNumbers_text') + ' ' + group.tabs.length +
                    ', ' + chrome.i18n.getMessage('o_trash_deletedAt') + ' ' + self.formatTime(group.trashed) + ' ';
                button.textContent = chrome.i18n.getMessage('o_trash_restoreButton');
                button.onclick = function () {
                    button.disabled = true;
                    groupStoreClient.restore(group.key).then(function () {
                        self.showTrash();
                        self.showBackupText();
                    });
                };
                item.appendChild(title);
                item.appendChild(info);
                item.appendChild(button);
                list.appendChild(item);
            });
        });
    },

    go: function (date_format) {
        var self = this,
            message = sessionStorage.getItem(this.MESSAGE_KEY);

        this.date_format = date_format;
        if (message) {
            sessionStorage.removeItem(this.MESSAGE_KEY);
            this.showMessage(message, false);
        }
        this.showBackupText();
        this.showUndoRestore();
        this.showTrash();

        document.getElementById('download_btn').onclick = function () {
            self.download();
        };
        document.getElementById('restore_btn').onclick = function () {
            self.restore();
        };
        document.getElementById('undo_restore_btn').onclick = function () {
            self.undoRestore();
        };
        document.getElementById('restore_file').onchange = function () {
            if (this.files.length) {
                self.readFile(this.files[0]);
            }
        };
    },
};

document.addEventListener('optionsPageReady', function () {
    storage.area.get(storage.default_options, function (options) {
        backupUI.go(options.date_format);
    });
}, false);
