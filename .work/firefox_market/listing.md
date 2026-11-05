# TabHamster on Firefox Add-ons (addons.mozilla.org)

Developer Hub: https://addons.mozilla.org/developers/ (sign in with a Mozilla account).
Submit a New Add-on › On this site (listed).

## Package

`cd build && python3 build.py -m --firefox` writes `build/releases/<version>-firefox.zip` (not minified: `-m`).
Add-on ID `@TabHamster` (in the generated manifest, permanent: Firefox Sync keeps storage.sync per ID).
Compatible: Firefox for desktop only (not Android: the manifest's `strict_min_version` 140.0, and Android needs 142 for
`data_collection_permissions`; `web-ext lint` warns about it).

Source code question ("Do You Need to Submit Source Code?"): **No**. The package isn't minified, concatenated or
transpiled; the files are the repository's as they are. The only generated file is `manifest.json`, which
`build/build.py` (`firefoxManifest`) makes from the repository's `manifest.json`.

## Describe Add-on (per language: en, es, fr, hu, sr, uk)

Name: TabHamster (from `_locales/*/messages.json`, `extName`).

Add-on URL: `https://addons.mozilla.org/firefox/addon/tabhamster/` (slug `tabhamster`, if free).

Summary (at most 250 characters; AMO first fills it from the manifest's `extDescr`, replace it with these):

- en: `Save open tabs as named groups and find them again. Sessions keep everything that was open in your last 30 browser sessions. Groups sync through Firefox Sync. Free and open source.`
- es: `Guarde las pestañas abiertas como grupos con nombre y vuelva a encontrarlas. Las sesiones guardan todo lo que estuvo abierto en sus últimas 30 sesiones del navegador. Los grupos se sincronizan con Firefox Sync. Gratis y de código abierto.`
- fr: `Enregistrez les onglets ouverts en groupes nommés et retrouvez-les. Les sessions gardent tout ce qui était ouvert lors de vos 30 dernières sessions. Les groupes se synchronisent avec Firefox. Gratuit et open source.`
- hu: `Mentse a megnyitott füleket elnevezett csoportokba, és találja meg őket újra. A munkamenetek mindent megőriznek, ami az utolsó 30 munkamenetben nyitva volt. A csoportok a Firefox szinkronizálással szinkronizálódnak. Ingyenes, nyílt forráskódú.`
- sr: `Сачувајте отворене картице као именоване групе и поново их пронађите. Сесије чувају све што је било отворено у последњих 30 сесија прегледача. Групе се синхронизују преко Firefox синхронизације. Бесплатно и отвореног кода.`
- uk: `Зберігайте відкриті вкладки в групи з назвами й легко знаходьте їх знову. Сесії зберігають усе, що було відкрито в останніх 30 сесіях браузера. Групи синхронізуються через Firefox. Безплатно, з відкритим кодом.`

Description: `descr.<lang>.txt` (from the Edge copies: Firefox Sync with Add-ons, private window, no tab groups switch
since Firefox has them always on, and a line on moving from Chrome or Edge with a backup file; no tab indents, since
AMO collapses them).

Categories: Tabs.
Tags (AMO's own list; pick the ones it offers): tab manager, session, productivity.

Support email: (optional, leave empty). Support website: https://github.com/onikienko/TabHamster/issues
Homepage: https://github.com/onikienko/TabHamster
License: GNU General Public License v3.0.

Privacy policy: "This add-on has a privacy policy": yes, the text of `privacy.md` (from "TabHamster is a browser
extension" on), once the published one is updated with it. Firefox shows the data consent from the manifest
(`data_collection_permissions: none`): no data collected.

## Media

Icon: from the manifest (`img/ext_icons/128.png`), no upload needed.
Screenshots (1280 x 800), in order, from `screenshots/en/` (the same as the Chrome Web Store and Edge; the popup looks
the same in Firefox). Captions (AMO lets each have one):

1. `1-save.png`: Save open tabs as a group. Press Enter. Name it, or let the date do it.
2. `2-search.png`: Find any tab. Search group names, tab titles and addresses as you type.
3. `3-sessions.png`: Everything that was open. Your last 30 sessions, with the tabs and windows you closed.
4. `4-menu.png`: Arrange it your way. Drag groups and tabs. Edit, move and remove tabs. Undo any change.
5. `5-dark.png`: Light or dark. Tab groups keep their names and colors.

## Version notes (release notes)

en: `First version for Firefox, with everything TabHamster 1.2.0 has in Chrome and Edge.`

## Notes to reviewer

```
TabHamster saves open tabs as named groups and keeps a list of recent browser sessions. No account or login is needed. The package is not minified or bundled: the files are the ones in https://github.com/onikienko/TabHamster (only manifest.json is generated for Firefox by build/build.py).

To test:
1. Open a few tabs, click the TabHamster toolbar button and press Enter (or click "Save N tabs"). The tabs are saved as a group named by the date; type a name first to name it.
2. Click the group to see its tabs; "Open" opens them, the group's menu has more actions (replace with open tabs, rename, open in a private window, copy links, delete with Undo). Opening in a private window needs "Run in Private Windows" allowed for the add-on; without it the popup says where to allow it.
3. The "Sessions" tab lists the current and past browser sessions; "Restore" reopens a session's windows.
4. Settings (the icon at the bottom right of the popup): theme, backup and restore, recently deleted groups, help.
5. Tab groups: put some tabs in a tab group, save the window, close it, and open the group: the tab group comes back with its name and color.

Permissions: storage (groups in storage.sync and storage.local, sessions in storage.local), tabs (addresses and titles of open tabs, to save them and to keep the session list), unlimitedStorage (a local copy of every group, the last 30 sessions, and the site icon cache), tabGroups (tab groups' names and colors in saved groups and sessions).

Site icons: Firefox gives extensions no access to its icon cache, so the background keeps the icon of each site the tabs show (tab.favIconUrl, scaled to 32 px) in IndexedDB, up to 20,000 sites (js/icon_cache.js); tabs in private windows are left out; Settings > General shows how many and has Clear. Nothing leaves the computer.

Network: the add-on makes no requests of its own, except the optional "Load missing icons from sites" (Settings > General, off until the user allows it), which loads /favicon.ico from the saved sites.
```
