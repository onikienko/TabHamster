#! /usr/bin/python3

##########################################################################
# Chrome Extensions builder
# This is a part of Chrome Extensions Box
# Read more on GitHub - https://github.com/onikienko/chrome-extensions-box
##########################################################################

import os, re, json, fnmatch, zipfile, datetime, time, shutil, sys
from zipfile import ZipFile

# the build folder and the project around it, wherever the script is run from
CUR_PATH = os.path.dirname(os.path.abspath(__file__))
PRJ_PATH = os.path.dirname(CUR_PATH)
PRJ_DIR_NAME = os.path.basename(PRJ_PATH)
BUILD_PATH = os.path.join(CUR_PATH, 'releases')
PACKAGE_FILE = os.path.join(CUR_PATH, 'build.json')
MANIFEST_FILE = os.path.join(PRJ_PATH, 'manifest.json')

# both store packages: <version>.zip (Chrome Web Store, Edge Add-ons) and <version>-firefox.zip
ARG_ALL = '--all'
# Firefox: a zip with the manifest rewritten for Firefox, or a folder to run with `npx web-ext run -s build/firefox`
ARG_FIREFOX = '--firefox'
ARG_FIREFOX_DEV = '--firefox-dev'
# with --firefox-dev: keeps copying changed files into the folder
ARG_WATCH = '--watch'
FIREFOX_DEV_PATH = os.path.join(CUR_PATH, 'firefox')
# the add-on id can't change once listed: Firefox Sync keeps storage.sync per id
FIREFOX_ID = '@TabHamster'
FIREFOX_MIN_VERSION = '140.0'
# optional in Chrome (an install warning there), required in Firefox (granted without asking there)
FIREFOX_REQUIRED = ['tabGroups']
# Chrome only: the _favicon/ icon cache
FIREFOX_DROPPED = ['favicon']

# TODO collect and print errors after creating a package
# errors = []


def getJSON(json_file):
    try:
        f = open(json_file, 'rt', encoding='utf-8')
        j = json.load(f)
        f.close()
        return j
    except:
        print('Error reading', json_file, 'file')
        sys.exit(1)


def isNameMatch(name, match_list):
    for pt in match_list:
        if fnmatch.fnmatch(name, pt):
            return True
    return False


def writeToChangelogFile():
    if changelog['filename']:
        print('\nWriting to changelog file ...')
        changelog_path = os.path.join(BUILD_PATH, changelog['filename'])

        if changelog['datetimeformat']:
            try:
                timestamp = ' (' + datetime.datetime.now().strftime(changelog['datetimeformat']) + ')'
            except ValueError:
                print('Invalid changelog.datetimeformat string in package.json')
                timestamp = ''
        else:
            timestamp = ''
        try:
            if not os.path.isfile(changelog_path):
                f = open(changelog_path, 'w', encoding='utf-8')
                f.close()

            with open(changelog_path, 'r+', encoding='utf-8') as f:
                lines = f.readlines()
                f.seek(0)
                f.writelines([build_version + timestamp + '\n'] + lines)

            f.close()
            print('Ok\n')
        except Exception:
            print('Error reading or writing changelog file\n')


def backgroundScripts(worker):
    # Firefox runs a background page, not a service worker: the files the worker loads with importScripts come first
    worker_path = os.path.join(PRJ_PATH, worker)
    with open(worker_path, encoding='utf-8') as f:
        found = re.search(r"^\s*importScripts\(([^)]*)\)", f.read(), re.M)
    if not found:
        raise ValueError('No importScripts(...) in ' + worker)
    base = os.path.dirname(worker)
    names = re.findall(r"'([^']+)'", found.group(1))
    return [base + '/' + name for name in names] + [worker]


def firefoxManifest(manifest):
    m = dict(manifest)
    m.pop('minimum_chrome_version', None)
    m['background'] = {'scripts': backgroundScripts(manifest['background']['service_worker'])}
    optional = [p for p in m.pop('optional_permissions', []) if p not in FIREFOX_REQUIRED]
    m['permissions'] = [p for p in m['permissions'] if p not in FIREFOX_DROPPED] + \
        [p for p in manifest.get('optional_permissions', []) if p in FIREFOX_REQUIRED]
    if optional:
        m['optional_permissions'] = optional
    # the button starts in the toolbar, not in the extensions menu (Firefox only): the welcome page then has no
    # pinning steps, which follow Chrome's menu (Firefox pins from the ⋯ menu instead)
    m['action'] = dict(m['action'], default_area='navbar')
    m['browser_specific_settings'] = {'gecko': {
        'id': FIREFOX_ID,
        'strict_min_version': FIREFOX_MIN_VERSION,
        'data_collection_permissions': {'required': ['none']},
    }}
    return json.dumps(m, indent=4, ensure_ascii=False) + '\n'


def isIncluded(root, name):
    # the same rules as the zip: build.json "exclude" for the folder and every parent folder up to the project
    rel = os.path.relpath(os.path.join(root, name), PRJ_PATH)
    return not any(isNameMatch(part, exclude) for part in rel.split(os.sep))


def projectFiles():
    # the files the zip gets, with their modification times
    files = {}
    for root, dirs, names in os.walk(PRJ_PATH):
        dirs[:] = [d for d in dirs if isIncluded(root, d)]
        for name in names:
            if isIncluded(root, name):
                path = os.path.join(root, name)
                files[os.path.relpath(path, PRJ_PATH)] = os.path.getmtime(path)
    return files


def syncFirefoxDev(known):
    # copies new and changed files (Firefox doesn't load an extension's files through symlinks), removes deleted ones
    files = projectFiles()
    changed = [rel for rel, mtime in files.items() if known.get(rel) != mtime]
    with open(MANIFEST_FILE, encoding='utf-8') as f:
        manifest = json.load(f)
    # the manifest lists the files the worker loads with importScripts: a changed worker writes it again too
    worker = os.path.normpath(manifest['background']['service_worker'])
    if worker in changed and 'manifest.json' not in changed:
        changed.append('manifest.json')
    for rel in changed:
        dest = os.path.join(FIREFOX_DEV_PATH, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if rel == 'manifest.json':
            with open(dest, 'w', encoding='utf-8') as f:
                f.write(firefoxManifest(manifest))
        else:
            shutil.copy2(os.path.join(PRJ_PATH, rel), dest)
        if known:
            print('Copied', rel)
    for rel in set(known) - set(files):
        try:
            os.remove(os.path.join(FIREFOX_DEV_PATH, rel))
        except FileNotFoundError:
            pass
        print('Removed', rel)
    return files


def writeFirefoxDev(watch):
    if os.path.isdir(FIREFOX_DEV_PATH):
        shutil.rmtree(FIREFOX_DEV_PATH)
    known = syncFirefoxDev({})
    print('Firefox folder:', FIREFOX_DEV_PATH)
    print('Run: npx web-ext run -s', os.path.relpath(FIREFOX_DEV_PATH, PRJ_PATH))
    if watch:
        print('Watching for changes (Ctrl+C to stop) ...')
    while watch:
        time.sleep(1)
        try:
            known = syncFirefoxDev(known)
        except (OSError, ValueError) as error:
            # a file in the middle of being saved: the next round copies it
            print('Error:', error)

# get and check manifest version
try:
    build_version = getJSON(MANIFEST_FILE)['version']
except KeyError:
    print('Error. Check "manifest.json" file. "version" is not defined')
    sys.exit(1)
firefox_dev = ARG_FIREFOX_DEV in sys.argv
# False: the Chrome Web Store and Edge Add-ons zip, True: the Firefox one
targets = [False, True] if ARG_ALL in sys.argv else [ARG_FIREFOX in sys.argv]


def zipBasename(firefox):
    return build_version + ('-firefox' if firefox else '') + '.zip'


if not firefox_dev:
    for target in targets:
        if os.path.exists(os.path.join(BUILD_PATH, zipBasename(target))):
            print('Error.', zipBasename(target), 'already exists')
            sys.exit(1)
# the Firefox manifest can be made: it needs the worker's importScripts line
if firefox_dev or True in targets:
    try:
        firefoxManifest(getJSON(MANIFEST_FILE))
    except (OSError, ValueError) as error:
        print('Error.', error)
        sys.exit(1)

# get package info
try:
    package = getJSON(PACKAGE_FILE)
    exclude, reminder, changelog = package['exclude'], package['reminder'], package['changelog']
except Exception:
    print('Error in build.json file')
    sys.exit(1)

if firefox_dev:
    try:
        writeFirefoxDev(ARG_WATCH in sys.argv)
    except KeyboardInterrupt:
        pass
    sys.exit()

if reminder:
    i = input(reminder + ' ' + ' Press "y" (then "ENTER") to continue or just  "ENTER" to abort: ')
    if i.lower() != 'y':
        sys.exit(1)


def buildZip(firefox):
    zipname = os.path.join(BUILD_PATH, zipBasename(firefox))
    print('Building', os.path.relpath(zipname, PRJ_PATH), '...')
    files = sorted(projectFiles())
    with ZipFile(zipname, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in files:
            # addons.mozilla.org wants manifest.json at the top of the zip, Chrome takes the project folder
            arcname = rel.replace(os.sep, '/')
            if not firefox:
                arcname = PRJ_DIR_NAME + '/' + arcname
            if firefox and rel == 'manifest.json':
                z.writestr(arcname, firefoxManifest(getJSON(MANIFEST_FILE)))
            else:
                z.write(os.path.join(PRJ_PATH, rel), arcname)
    print(len(files), 'files' + (', manifest.json written for Firefox' if firefox else ''))


os.makedirs(BUILD_PATH, exist_ok=True)
for target in targets:
    buildZip(target)

# one changelog line per version: the Chrome build writes it
if False in targets:
    writeToChangelogFile()

print('Done!')
