#! /usr/bin/python3

##########################################################################
# Chrome Extensions builder
# This is a part of Chrome Extensions Box
# Read more on GitHub - https://github.com/onikienko/chrome-extensions-box
##########################################################################

import os, json, fnmatch, zipfile, datetime, urllib.request, shutil, sys
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

# get and check manifest version
try:
    build_version = getJSON(MANIFEST_FILE)['version']
except KeyError:
    print('Error. Check "manifest.json" file. "version" is not defined')
    exit()
if os.path.exists(os.path.join(BUILD_PATH, build_version + '.zip')):
    print('Error. Version', build_version, 'already exists')
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

if reminder:
    i = input(reminder + ' ' + ' Press "y" (then "ENTER") to continue or just  "ENTER" to abort: ')
    if i.lower() != 'y':
        exit()

if not os.path.isdir(BUILD_PATH):
    os.makedirs(BUILD_PATH)

zipname = os.path.join(BUILD_PATH, build_version + '.zip')
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
                arcname = fullname[len(PRJ_PAR_DIR):]
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

writeToChangelogFile()

print('Done!')
input('\nPress "Enter" to exit')