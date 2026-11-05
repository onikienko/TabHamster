var storage = {
    area: chrome.storage.sync,
    default_options: {
        date_format: 'local', // or 'local_numeric', 'eu', 'us' (js/ui/format.js dateName); 'eu' in older versions
        pinned: 0, //do not add pinned tabs
        cur_win: 1, // save tabs from current window only
        active_tab: '#saved', //or '#sessions'
        session_watcher: 1, //extension will watch sessions
        theme: 'system', // or 'light', 'dark'
        site_icons: 'ask', // or 'load', 'off': icons Chrome doesn't have come from the sites (js/ui/favicons.js)
        open_in_front: 0 // 1: opened tabs come to the front one by one, placed by the browser (js/background.js)
    }
};