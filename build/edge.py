#! /usr/bin/python3

# Edge Add-ons from the command line (Update API v1.1):
#   python3 build/edge.py check    the package, the notes and the keys; changes nothing (the API has no call that reads
#                                  the add-on's state)
#   python3 build/edge.py submit   uploads build/releases/<version>.zip into the draft and submits the draft for
#                                  certification, with the notes from .work/edge_market/listing.md
# The listing (descriptions, screenshots) has no API: edit the draft in Partner Center first (save, don't publish),
# the submission takes it along.
# Keys (Partner Center, Microsoft Edge, Publish API): EDGE_CLIENT_ID, EDGE_API_KEY, and EDGE_PRODUCT_ID (the GUID on
# the extension's overview page, not the Store ID), from the environment or from .work/store-keys.env. API keys expire:
# Partner Center shows when.

import os, re, sys
from store_common import PRJ_PATH, WORK_PATH, fail, readText, http, expect, poll, confirm, needKeys, readKeys, \
    chromiumPackage, readBytes

API = 'https://api.addons.microsoftedge.microsoft.com/v1/products/%s/'
KEY_NAMES = ('EDGE_CLIENT_ID', 'EDGE_API_KEY', 'EDGE_PRODUCT_ID')
LISTING_FILE = os.path.join(WORK_PATH, 'edge_market', 'listing.md')
NOTES_HEADING = '## Notes for certification'
# an operation that doesn't exist: refused keys get 401 or 403 (403 for made-up keys, checked 2026-11-06), accepted
# ones 404
NO_OPERATION = '00000000-0000-0000-0000-000000000000'


def certificationNotes():
    # the first code block under the heading in listing.md
    text = readText(LISTING_FILE)
    found = re.search(re.escape(NOTES_HEADING) + r'\s+```\n(.*?)\n```', text, re.S)
    if not found:
        fail('no notes under "%s" in %s' % (NOTES_HEADING, os.path.relpath(LISTING_FILE, PRJ_PATH)))
    return found.group(1).strip()


def session(keys):
    return API % keys['EDGE_PRODUCT_ID'], {'Authorization': 'ApiKey ' + keys['EDGE_API_KEY'],
                                           'X-ClientID': keys['EDGE_CLIENT_ID']}


def operationId(answer, what):
    # a 202 with the operation in the Location header (the ID, or a URL that ends with it)
    status, body, headers = answer
    expect(answer, what)
    location = headers.get('Location') or ''
    if status != 202 or not location:
        fail(what, 'got HTTP %d without an operation:' % status, body)
    return location.rstrip('/').split('/')[-1]


def waitFor(url, headers, what):
    def check():
        answer = expect(http('GET', url, headers), what)
        return None if answer.get('status') == 'InProgress' else answer
    answer = poll(what, check)
    if answer.get('status') != 'Succeeded':
        fail(what, 'failed:', answer.get('errorCode') or '', answer.get('message') or '', answer.get('errors') or '')
    return answer


def commandCheck():
    version, path, built = chromiumPackage()
    problems = [] if built else ['no %s: python3 build/build.py' % os.path.relpath(path, PRJ_PATH)]
    notes = certificationNotes()
    print('Notes for certification: %d characters' % len(notes))
    for problem in problems:
        print('Problem:', problem)
    keys = readKeys(KEY_NAMES)
    if not keys:
        print('No Edge keys (%s): store not checked' % ', '.join(KEY_NAMES))
    else:
        base, headers = session(keys)
        status = http('GET', base + 'submissions/operations/' + NO_OPERATION, headers)[0]
        if status == 404:
            print('Keys accepted')
        else:
            problems.append('Edge refused the keys or the product ID (HTTP %d; expired? see Partner Center, Publish '
                            'API)' % status)
            print('Problem:', problems[-1])
    sys.exit(1 if problems else 0)


def commandSubmit():
    version, path, built = chromiumPackage()
    if not built:
        fail('no %s: python3 build/build.py' % os.path.relpath(path, PRJ_PATH))
    notes = certificationNotes()
    base, headers = session(needKeys(KEY_NAMES))
    confirm('Upload %s to Edge Add-ons and submit the draft for certification (with the listing as it is in the '
            'Partner Center draft).' % os.path.basename(path))
    print('Uploading', os.path.basename(path), '...')
    upload = operationId(http('POST', base + 'submissions/draft/package', dict(headers, **{
        'Content-Type': 'application/zip'}), readBytes(path)), 'Upload')
    print('Processing ...')
    print(waitFor(base + 'submissions/draft/package/operations/' + upload, headers, 'The upload').get('message'))
    print('Submitting ...')
    publish = operationId(http('POST', base + 'submissions', headers, {'notes': notes}), 'Submitting')
    print(waitFor(base + 'submissions/operations/' + publish, headers, 'The submission').get('message'))
    print('Submitted', version, 'for certification (up to 7 business days)')


COMMANDS = {'check': commandCheck, 'submit': commandSubmit}

if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print('Usage: python3 build/edge.py check|submit')
        sys.exit(2)
    COMMANDS[sys.argv[1]]()
