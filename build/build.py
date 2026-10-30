#! /usr/bin/python3

##########################################################################
# Chrome Extensions builder
# This is a part of Chrome Extensions Box
# Read more on GitHub - https://github.com/onikienko/chrome-extensions-box
##########################################################################

import os, re, json, fnmatch, zipfile, datetime, time, urllib.request, shutil, sys
from zipfile import ZipFile
from urllib.parse import urlencode
from urllib.error import HTTPError, URLError

CUR_PATH = os.path.abspath(os.curdir)
PRJ_PATH = os.path.abspath(os.pardir)
PRJ_PAR_DIR, PRJ_DIR_NAME = os.path.split(PRJ_PATH)
BUILD_PATH = os.path.join(CUR_PATH, 'releases')
PACKAGE_FILE = os.path.join(CUR_PATH, 'build.json')
MANIFEST_FILE = os.path.join(PRJ_PATH, 'manifest.json')
TMP_DIR = os.path.join(CUR_PATH, 'tmp')

ARG_NO_MINIFY = '-m'
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

exclude_dirs = []
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
        exit()


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


def minifyJs(file_path, arcname):
    print('Start minifying', arcname[1:])

    try:
        f = open(file_path, encoding='utf-8')
        data = urllib.parse.urlencode({'js_code': f.read(), 'utf-8': 'utf-8'})
        data = data.encode('utf-8')
        req = urllib.request.Request(url='http://marijnhaverbeke.nl/uglifyjs')
        minified = urllib.request.urlopen(req, data).read().decode('utf-8')
    except (HTTPError, URLError) as error:
        print('HTTP or URL error:', error)
        print(arcname[1:], 'was not minified')
        return file_path

    try:
        if not os.path.isdir(TMP_DIR):
            os.makedirs(TMP_DIR)
        tmp_file_path = os.path.join(TMP_DIR, os.path.basename(file_path))
        tmp_file = open(tmp_file_path, 'w+', encoding='utf-8')
        tmp_file.write(minified)
        tmp_file.close()
    except Exception:
        print('Error during the creation temp file')
        print(arcname[1:], 'was not minified')
        return file_path

    print('Ok. File was minified')
    return tmp_file_path


def backgroundScripts(worker):
    # Firefox runs a background page, not a service worker: the files the worker loads with importScripts come first
    worker_path = os.path.join(PRJ_PATH, worker)
    with open(worker_path, encoding='utf-8') as f:
        found = re.search(r"^\s*importScripts\(([^)]*)\)", f.read(), re.M)
    if not found:
        print('Error. No importScripts(...) in', worker)
        exit()
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
    for rel, mtime in files.items():
        if known.get(rel) == mtime:
            continue
        dest = os.path.join(FIREFOX_DEV_PATH, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if rel == 'manifest.json':
            with open(MANIFEST_FILE, encoding='utf-8') as f:
                manifest = json.load(f)
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
    exit()
firefox = ARG_FIREFOX in sys.argv
firefox_dev = ARG_FIREFOX_DEV in sys.argv
zip_basename = build_version + ('-firefox' if firefox else '') + '.zip'
if not firefox_dev and os.path.exists(os.path.join(BUILD_PATH, zip_basename)):
    print('Error.', zip_basename, 'already exists')
    exit()

# get package info
try:
    package = getJSON(PACKAGE_FILE)
    exclude, minify, reminder, changelog = package['exclude'], package['minify'], package['reminder'], package[
        "changelog"]
    if ARG_NO_MINIFY not in sys.argv:
        for index, dirname in enumerate(minify['dirs']):
            minify['dirs'][index] = os.path.abspath(dirname)
    else:
        minify['dirs'] = []
except Exception:
    print('Error in build.json file')
    exit()

if firefox_dev:
    try:
        writeFirefoxDev(ARG_WATCH in sys.argv)
    except KeyboardInterrupt:
        pass
    exit()

if reminder:
    i = input(reminder + ' ' + ' Press "y" (then "ENTER") to continue or just  "ENTER" to abort: ')
    if i.lower() != 'y':
        exit()

if not os.path.isdir(BUILD_PATH):
    os.makedirs(BUILD_PATH)

zipname = os.path.join(BUILD_PATH, zip_basename)
z = ZipFile(zipname, 'w', zipfile.ZIP_DEFLATED)
print('\nStart building package ', os.path.abspath(zipname), '...\n')

for root, dirs, files in os.walk(PRJ_PATH):
    is_exclude_dir = root.startswith(tuple(exclude_dirs))
    if (isNameMatch(os.path.basename(root), exclude) or is_exclude_dir) and root != PRJ_PATH:
        if not is_exclude_dir:
            exclude_dirs.append(root)
        continue
    else:
        for name in files:
            if not isNameMatch(name, exclude):
                fullname = os.path.join(root, name)
                # addons.mozilla.org wants manifest.json at the top of the zip, Chrome takes the project folder
                arcname = fullname[len(PRJ_PATH if firefox else PRJ_PAR_DIR):]
                if firefox and fullname == MANIFEST_FILE:
                    z.writestr(arcname[1:], firefoxManifest(getJSON(MANIFEST_FILE)))
                    print(arcname[1:], 'was written for Firefox\n')
                    continue
                if len(minify['dirs']) > 0 and root.startswith(tuple(minify['dirs'])) and fnmatch.fnmatch(name,
                                                                                                          '*.js') and not isNameMatch(
                        name,
                        minify[
                            'exclude']):
                    fullname = minifyJs(fullname, arcname)
                z.write(fullname, arcname)
                print(arcname[1:], 'was added to the package\n')
z.close()
print('Package was created')

if os.path.exists(TMP_DIR):
    print('\nDeleting temporary files...')
    shutil.rmtree(TMP_DIR, ignore_errors=False, onerror=None)
    print('Ok')

# one changelog line per version: the Chrome build writes it
if not firefox:
    writeToChangelogFile()

print('Done!')
input('\nPress "Enter" to exit')