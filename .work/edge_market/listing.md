# TabHamster on Edge Add-ons (Microsoft Partner Center)

Draft: CRX ID `pifbgknmgjnlibbcbdblinmmlmdihkgc`, Store ID `0RDCK9S95JNP`, product ID
`7f6534d2-cfc5-4bf0-88ab-fb6148818236`. Publisher: Mykhailo Onikiienko (individual account, seller ID 68011500).
Dashboard: https://partner.microsoft.com/dashboard/microsoftedge/overview

## Packages

`build/releases/1.0.0.zip`, the same zip as the Chrome Web Store. Name and short description come from
`_locales/*/messages.json` (`extName`, `extDescr`); all 6 languages should be detected.

## Availability

- Visibility: Public
- Markets: all markets

## Properties

- Category: Productivity
- Website: https://github.com/onikienko/TabHamster
- Support contact: https://github.com/onikienko/TabHamster/issues
- Mature content: no

## Privacy

Privacy policy URL: https://onikienko.github.io/browser-extensions/tabhamster-privacy

Single purpose:
```
Save open tabs as named groups and restore them later, and keep a list of recent browser sessions (tabs and windows, with the ones that were closed) to restore them.
```

Permission justifications:

storage
```
Saved tab groups and settings are kept in chrome.storage.sync, so they reach the user's other computers through browser sync. chrome.storage.local keeps the browser sessions (the last 30), a local copy of every group, groups deleted in the last 30 days (so they can be restored), and the undo copy of a restore from a backup file. chrome.storage.session keeps the ID of the current session. Nothing is sent anywhere else.
```

tabs
```
Reads the address and title of open tabs to save them as a group, to add the current tab to a group, and to open saved groups and sessions in tabs and windows. Tab and window events (opened, address changed, moved, closed) keep the session list up to date: every tab opened during a browser session, what was closed, and the pages each tab went through. This data stays in the browser and is only shown to the user.
```

favicon
```
Shows each saved tab's icon in the list, taken from the browser's own icon cache (the _favicon API). No network request is made for it.
```

unlimitedStorage
```
chrome.storage.local holds a full copy of the user's saved tab groups (and groups deleted in the last 30 days), so saving a group never fails when sync storage (100 KB) is full. It also holds the last 30 browser sessions, which with their closed tabs and visited pages can take several MB. The data stays on the user's computer.
```

Remote code: No, I am not using remote code.

Data usage: tick nothing under "What user data do you plan to collect" (the same answer as on the Chrome Web Store:
nothing reaches the developer; groups go through the browser's own sync, sessions stay on the computer). Tick all the
certifications under "I certify that the following disclosures are true".

## Store listings (each language)

| Field | File |
|---|---|
| Description | `descr.<lang>.txt` (Edge copies: "Edge" instead of "Chrome", "InPrivate" instead of incognito, and a paragraph on installing from the same store everywhere) |
| Extension logo (300 x 300) | `logo_300x300.png` (then "Duplicate this logo for all languages") |
| Small promotional tile (440 x 280) | `promo_img/promo_440x280.png` |
| Large promotional tile (1400 x 560) | `promo_img/promo_1400x560.png` |
| Screenshots (1280 x 800, up to 6) | `screenshots/en/1-save.png` ... `5-dark.png`, in order (then Duplicate) |

Search terms (at most 7 terms, 21 words, 30 characters each):

- en: tab manager, session manager, save tabs, tab groups, restore tabs, sync tabs, tab saver
- es: gestor de pestañas, gestor de sesiones, guardar pestañas, grupos de pestañas, restaurar pestañas, sincronizar pestañas
- fr: gestionnaire d’onglets, gestionnaire de sessions, enregistrer les onglets, groupes d’onglets, restaurer les onglets
- hu: fülkezelő, munkamenet-kezelő, fülek mentése, fülcsoportok, fülek visszaállítása
- sr: менаџер картица, менаџер сесија, чување картица, групе картица, враћање картица
- uk: менеджер вкладок, менеджер сесій, зберегти вкладки, групи вкладок, відновити вкладки, синхронізація вкладок

## Notes for certification

```
TabHamster saves open tabs as named groups and keeps a list of recent browser sessions. No account or login is needed.

To test:
1. Open a few tabs, click the TabHamster icon and press Enter (or click "Save N tabs"). The tabs are saved as a group named by the date; type a name first to name it.
2. Click the group to see its tabs; "Open" opens them, the group's menu has more actions (replace with open tabs, rename, open in an incognito (InPrivate) window, copy links, delete with Undo).
3. The "Sessions" tab lists the current and past browser sessions; "Restore" reopens a session's windows.
4. Settings (the icon at the bottom right of the popup): theme, backup and restore, recently deleted groups, help.

Data: groups are kept in chrome.storage.sync (browser sync) and in chrome.storage.local; sessions only in chrome.storage.local. The extension makes no network requests of its own, except the optional "Load missing icons from sites" (Settings > General, off until the user allows it), which loads /favicon.ico from the saved sites. Source code: https://github.com/onikienko/TabHamster
```

Review can take up to 7 business days.
