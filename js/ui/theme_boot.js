// Runs in <head> before the page paints: the theme chosen in Settings, remembered in localStorage,
// so a dark-theme user doesn't see a flash of the light page. The pages confirm it from sync storage later.
(function () {
    'use strict';
    var theme = 'system';
    try {
        theme = localStorage.getItem('theme') || 'system';
    } catch (e) {
        // storage blocked: follow the system
    }
    document.documentElement.setAttribute('data-theme', theme);
}());
