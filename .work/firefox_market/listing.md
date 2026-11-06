# TabHamster on Firefox Add-ons (addons.mozilla.org)

Developer Hub: https://addons.mozilla.org/developers/ (sign in with a Mozilla account).
`python3 build/amo.py check|submit|listing` sends what this file and `amo.json` describe through the AMO API
(keys in `.work/store-keys.env`, see the script's top comment); the rest is set on the Developer Hub by hand.

## Package

`python3 build/build.py --firefox` (or `--all`) writes `build/releases/<version>-firefox.zip` (not minified).
Add-on ID `@TabHamster` (in the generated manifest, permanent: Firefox Sync keeps storage.sync per ID).
Compatible: Firefox for desktop only (not Android: the manifest's `strict_min_version` 140.0, and Android needs 142 for
`data_collection_permissions`; `web-ext lint` warns about it).

Source code question ("Do You Need to Submit Source Code?"): **No**. The package isn't minified, concatenated or
transpiled; the files are the repository's as they are. The only generated file is `manifest.json`, which
`build/build.py` (`firefoxManifest`) makes from the repository's `manifest.json`.

## Describe Add-on (per language: en, es, fr, hu, sr, uk)

Name: TabHamster (from `_locales/*/messages.json`, `extName`).

Add-on URL: `https://addons.mozilla.org/firefox/addon/tab-hamster/` (slug `tab-hamster`, `slug` in `amo.json`).
`tabhamster` is taken by another account's add-on that isn't public (checked 2026-11-06 with the keys: 403, not ours).

Summary (at most 250 characters; AMO first fills it from the manifest's `extDescr`): `summary` in `amo.json`.

Description: `descr.<lang>.txt` (from the Edge copies: Firefox Sync with Add-ons, private window, no tab groups switch
since Firefox has them always on, and a line on moving from Chrome or Edge with a backup file; no tab indents, since
AMO collapses them).

Categories: Tabs.
Tags: none. AMO takes only its own list (`/api/v5/addons/tags/`), and nothing there fits (checked 2026-11-06).

Support email: (optional, leave empty). Support website: https://github.com/onikienko/TabHamster/issues
Homepage: https://github.com/onikienko/TabHamster
License: GNU General Public License v3.0.

Privacy policy: "This add-on has a privacy policy": yes, the text of `privacy.md` (from "TabHamster is a browser
extension" on), once the published one is updated with it. Firefox shows the data consent from the manifest
(`data_collection_permissions: none`): no data collected.

## Media

Icon: from the manifest (`img/ext_icons/128.png`), no upload needed.
Screenshots (1280 x 800), in order, from `screenshots/en/` (the same as the Chrome Web Store and Edge; the popup looks
the same in Firefox), with their captions: `screenshots` in `amo.json`.

## Version notes and notes to reviewer

`release_notes` (per version) and `approval_notes` in `amo.json`.
