var main_tabs = new Tabs('#main_tabs');

document.addEventListener('optionSaved', function (event) {
    // reload extension after toggle session watcher option
    if (event.detail.val.hasOwnProperty('session_watcher') && event.detail.success) {
        chrome.runtime.reload();
    }
}, false);

document.addEventListener('optionsPageReady', function () {
    var restore_btn = document.getElementById('restore_btn');

    backup.getBackupData(function (data) {
        document.getElementById('backup_text').value = data;
    });

    restore_btn.onclick = function () {
        backup.replaceFromBackup(document.getElementById('restore_text').value, function (error) {
            if (error) {
                quick_options.showMessage('error');
            } else {
                chrome.runtime.reload();
            }
        })
    }
}, false);