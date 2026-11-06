#! /usr/bin/python3

# Chrome Web Store from the command line (API v2):
#   python3 build/cws.py check              the published and the submitted version and their states; changes nothing
#   python3 build/cws.py submit [--staged]  uploads build/releases/<version>.zip and submits it for review; with
#                                           --staged it waits after approval until Publish in the dashboard
# The store listing (descriptions, screenshots) has no API: edit it in the dashboard before submitting, the
# submission takes it along.
# Keys: CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN (an OAuth client of a Google Cloud project with the Chrome
# Web Store API on, the token from the OAuth Playground with the chromewebstore scope) and CWS_PUBLISHER_ID (dashboard,
# Publisher, Settings), from the environment or from .work/store-keys.env.

import os, sys, urllib.parse
from store_common import PRJ_PATH, fail, http, expect, poll, confirm, needKeys, readKeys, chromiumPackage, readBytes

# the same as STORES in js/options/main.js
ITEM_ID = 'mkfjjmjmnplabnplceaekkjcmdddokee'
API = 'https://chromewebstore.googleapis.com/'
KEY_NAMES = ('CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PUBLISHER_ID')
ARG_STAGED = '--staged'


def session(keys):
    # (the item's API name, the headers with a fresh access token)
    form = urllib.parse.urlencode({'client_id': keys['CWS_CLIENT_ID'], 'client_secret': keys['CWS_CLIENT_SECRET'],
                                   'refresh_token': keys['CWS_REFRESH_TOKEN'], 'grant_type': 'refresh_token'})
    answer = expect(http('POST', 'https://oauth2.googleapis.com/token',
                         {'Content-Type': 'application/x-www-form-urlencoded'}, form.encode()), 'Access token')
    name = 'publishers/%s/items/%s' % (keys['CWS_PUBLISHER_ID'], ITEM_ID)
    return name, {'Authorization': 'Bearer ' + answer['access_token']}


def revision(status):
    # "1.1.0 PUBLISHED" from a fetchStatus revision
    if not status:
        return 'none'
    versions = [channel.get('crxVersion', '?') for channel in status.get('distributionChannels', [])]
    return '%s %s' % (', '.join(versions) or '?', status.get('state', '?'))


def fetchStatus(name, headers):
    return expect(http('GET', API + 'v2/%s:fetchStatus' % name, headers), 'Status')


def showStatus(status):
    print('Published:', revision(status.get('publishedItemRevisionStatus')))
    print('Submitted:', revision(status.get('submittedItemRevisionStatus')))
    if status.get('takenDown') or status.get('warned'):
        print('Policy:', 'taken down' if status.get('takenDown') else 'warned', '(see the dashboard)')


def commandCheck():
    version, path, built = chromiumPackage()
    problems = [] if built else ['no %s: python3 build/build.py' % os.path.relpath(path, PRJ_PATH)]
    for problem in problems:
        print('Problem:', problem)
    keys = readKeys(KEY_NAMES)
    if not keys:
        print('No Chrome Web Store keys (%s): store not checked' % ', '.join(KEY_NAMES))
    else:
        showStatus(fetchStatus(*session(keys)))
    sys.exit(1 if problems else 0)


def commandSubmit():
    version, path, built = chromiumPackage()
    if not built:
        fail('no %s: python3 build/build.py' % os.path.relpath(path, PRJ_PATH))
    staged = ARG_STAGED in sys.argv
    name, headers = session(needKeys(KEY_NAMES))
    showStatus(fetchStatus(name, headers))
    confirm('Upload %s to the Chrome Web Store and submit it for review%s (with the listing as it is in the '
            'dashboard).' % (os.path.basename(path), ', staged: Publish in the dashboard after approval' if staged
                             else ', published as soon as it is approved'))
    print('Uploading', os.path.basename(path), '...')
    upload = expect(http('POST', API + 'upload/v2/%s:upload' % name, dict(headers, **{
        'Content-Type': 'application/zip'}), readBytes(path)), 'Upload')
    state = upload.get('uploadState')
    if state == 'IN_PROGRESS':
        print('Processing ...')

        def uploadState():
            current = fetchStatus(name, headers).get('lastAsyncUploadState')
            return None if current == 'IN_PROGRESS' else current
        state = poll('The upload', uploadState)
    if state != 'SUCCEEDED':
        fail('the upload ended as', state, upload)
    print('Uploaded', upload.get('crxVersion') or version)
    published = expect(http('POST', API + 'v2/%s:publish' % name, headers,
                            {'publishType': 'STAGED_PUBLISH' if staged else 'DEFAULT_PUBLISH'}), 'Submitting')
    for warning in (published.get('warningInfo') or {}).get('warnings', []):
        print('Warning:', warning.get('reason'), warning.get('description'))
    print('Submitted', version + ':', published.get('state'))


COMMANDS = {'check': commandCheck, 'submit': commandSubmit}

if __name__ == '__main__':
    args = [arg for arg in sys.argv[1:] if arg != ARG_STAGED]
    if len(args) != 1 or args[0] not in COMMANDS or (ARG_STAGED in sys.argv and args[0] != 'submit'):
        print('Usage: python3 build/cws.py check | submit [--staged]')
        sys.exit(2)
    COMMANDS[args[0]]()
