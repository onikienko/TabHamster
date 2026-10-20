// The theme chosen in Settings: <html data-theme>, and a copy in localStorage for js/ui/theme_boot.js
// (so the next page opens in it without a flash of the other theme).

/** 'system' | 'light' | 'dark'; anything else counts as 'system' */
export function applyTheme(theme) {
    const value = theme === 'light' || theme === 'dark' ? theme : 'system';
    document.documentElement.setAttribute('data-theme', value);
    try {
        localStorage.setItem('theme', value);
    } catch (e) {
        // the boot script will follow the system next time
    }
    return value;
}
