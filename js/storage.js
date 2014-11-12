var storage = {
    area: chrome.storage.sync,
    default_options: {
        date_format: 'eu', // or 'us'
        pinned: 0, //do not add pinned tabs
        cur_win: 1, // save tabs from current window only
        active_tab: '#saved', //or '#sessions'
        session_watcher: 1  //extension will watch sessions
    }
};