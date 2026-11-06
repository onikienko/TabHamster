#! /usr/bin/python3

# Firefox Add-ons (addons.mozilla.org) from the command line:
#   python3 build/amo.py check     checks the listing files and, with the keys, the add-on and its slug on AMO;
#                                  changes nothing
#   python3 build/amo.py submit    uploads build/releases/<version>-firefox.zip as a new listed version; the first
#                                  one creates the add-on together with its listing
#   python3 build/amo.py listing   sends the listing again: summary, description, links, category, privacy policy,
#                                  screenshots
# The listing is in .work/firefox_market: amo.json, descr.<lang>.txt, privacy.md, the screenshots.
# Keys (AMO Developer Hub, Tools, Manage API Keys): AMO_JWT_ISSUER and AMO_JWT_SECRET, from the environment or from
# .work/store-keys.env (KEY=value lines, kept out of git).

import os, re, sys, json, time, hmac, hashlib, base64, uuid, mimetypes, urllib.request, urllib.error, urllib.parse
from zipfile import ZipFile

CUR_PATH = os.path.dirname(os.path.abspath(__file__))
PRJ_PATH = os.path.dirname(CUR_PATH)
MARKET_PATH = os.path.join(PRJ_PATH, '.work', 'firefox_market')
KEYS_FILE = os.path.join(PRJ_PATH, '.work', 'store-keys.env')
API = 'https://addons.mozilla.org/api/v5/'
# our _locales folders and AMO's names for them
LOCALES = {'en': 'en-US', 'es': 'es-ES', 'fr': 'fr', 'hu': 'hu', 'sr': 'sr', 'uk': 'uk'}
SUMMARY_MAX = 250
# where privacy.md stops being the page around the policy (title, date) and becomes the policy
PRIVACY_START = 'TabHamster is a browser extension'
UPLOAD_WAIT = 300


def fail(*message):
    print('Error.', *message)
    sys.exit(1)


def readText(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def keys():
    found = {name: os.environ.get(name) for name in ('AMO_JWT_ISSUER', 'AMO_JWT_SECRET')}
    if os.path.isfile(KEYS_FILE):
        for line in readText(KEYS_FILE).splitlines():
            name, sep, value = line.partition('=')
            if sep and name.strip() in found and not found[name.strip()]:
                found[name.strip()] = value.strip()
    if not all(found.values()):
        return None
    return found['AMO_JWT_ISSUER'], found['AMO_JWT_SECRET']


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=')


def token(issuer, secret):
    # AMO takes a JWT signed with HS256, a new one for each request, valid at most 5 minutes
    now = int(time.time())
    head = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    claims = b64(json.dumps({'iss': issuer, 'jti': uuid.uuid4().hex, 'iat': now, 'exp': now + 60}).encode())
    signature = b64(hmac.new(secret.encode(), head + b'.' + claims, hashlib.sha256).digest())
    return (head + b'.' + claims + b'.' + signature).decode()


def multipart(fields, files):
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n'
                      % (boundary, name, value)).encode())
    for name, path in files.items():
        kind = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        with open(path, 'rb') as f:
            content = f.read()
        parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"; filename="%s"\r\nContent-Type: %s\r\n\r\n'
                      % (boundary, name, os.path.basename(path), kind)).encode() + content + b'\r\n')
    parts.append(('--%s--\r\n' % boundary).encode())
    return b''.join(parts), 'multipart/form-data; boundary=' + boundary


def call(method, path, data=None, files=None):
    # returns (status, the answer's JSON or text); errors come back as a status too, the caller decides
    headers = {'Authorization': 'JWT ' + token(*keys()), 'User-Agent': 'TabHamster-build'}
    body = None
    if files is not None:
        body, headers['Content-Type'] = multipart(data or {}, files)
    elif data is not None:
        body = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(path if path.startswith('https:') else API + path, body, headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            status, text = response.status, response.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as error:
        status, text = error.code, error.read().decode('utf-8', 'replace')
    except urllib.error.URLError as error:
        fail(method, path, 'failed:', error.reason)
    try:
        return status, json.loads(text) if text else None
    except ValueError:
        return status, text


def expect(answer, what):
    status, body = answer
    if status >= 400:
        fail(what, 'failed (HTTP %d):' % status, json.dumps(body, indent=2, ensure_ascii=False)
             if isinstance(body, (dict, list)) else body)
    return body


def translated(texts):
    return {LOCALES[lang]: text for lang, text in texts.items()}


def privacyPolicy():
    # privacy.md is the page on GitHub Pages; AMO shows plain text: no headings marks, a wrapped line joined again
    text = readText(os.path.join(MARKET_PATH, 'privacy.md'))
    start = text.find(PRIVACY_START)
    if start < 0:
        fail('privacy.md has no "%s"' % PRIVACY_START)
    lines = []
    for line in text[start:].strip().splitlines():
        if line.startswith('  ') and lines and lines[-1]:
            lines[-1] += ' ' + line.strip()
        else:
            lines.append(line[3:] if line.startswith('## ') else line)
    return '\n'.join(lines)


def listing():
    # the listing files, and what's wrong with them
    data = json.loads(readText(os.path.join(MARKET_PATH, 'amo.json')))
    problems = []
    descriptions = {}
    for lang in LOCALES:
        path = os.path.join(MARKET_PATH, 'descr.%s.txt' % lang)
        if os.path.isfile(path):
            descriptions[lang] = readText(path).strip()
        else:
            problems.append('no ' + os.path.relpath(path, PRJ_PATH))
        summary = data['summary'].get(lang)
        if not summary:
            problems.append('no %s summary in amo.json' % lang)
        elif len(summary) > SUMMARY_MAX:
            problems.append('the %s summary has %d characters, AMO takes %d' % (lang, len(summary), SUMMARY_MAX))
    for shot in data['screenshots']:
        if not os.path.isfile(os.path.join(MARKET_PATH, shot['file'])):
            problems.append('no screenshot ' + shot['file'])
    return data, descriptions, problems


def package():
    # the Firefox zip of the version in manifest.json, its add-on ID from the manifest inside
    version = json.loads(readText(os.path.join(PRJ_PATH, 'manifest.json')))['version']
    path = os.path.join(CUR_PATH, 'releases', version + '-firefox.zip')
    if not os.path.isfile(path):
        return version, path, None
    with ZipFile(path) as z:
        manifest = json.loads(z.read('manifest.json'))
    return version, path, manifest['browser_specific_settings']['gecko']['id']


def buildGuid():
    # the add-on ID build.py writes into the Firefox manifest, for a check before the zip is built
    found = re.search(r"^FIREFOX_ID = '([^']+)'", readText(os.path.join(CUR_PATH, 'build.py')), re.M)
    if not found:
        fail('no FIREFOX_ID in build/build.py')
    return found.group(1)


def addonPath(guid):
    return 'addons/addon/%s/' % urllib.parse.quote(guid, safe='')


def remoteState(guid, slug):
    # (our add-on on AMO or None, a problem with the slug or None)
    status, addon = call('GET', addonPath(guid))
    if status == 401:
        fail('AMO refused the keys:', addon)
    if status == 200:
        return addon, None
    if status != 404:
        expect((status, addon), 'Looking up ' + guid)
    status, other = call('GET', addonPath(slug))
    if status == 404:
        return None, None
    if status == 200:
        return None, 'the slug "%s" is your add-on %s (%s), not %s' % (slug, other.get('guid'), other.get('status'),
                                                                       guid)
    return None, 'the slug "%s" belongs to another add-on (HTTP %d): change "slug" in amo.json' % (slug, status)


def confirm(question):
    if input(question + ' Type "y" to go on: ').strip().lower() != 'y':
        print('Stopped, nothing sent.')
        sys.exit(1)


def waitForUpload(upload):
    # AMO validates the upload after taking it; the add-on or version can be made only from a valid one
    print('Validating on AMO ...')
    deadline = time.time() + UPLOAD_WAIT
    while not upload['processed']:
        if time.time() > deadline:
            fail('AMO is still validating after %d s; see %s' % (UPLOAD_WAIT, upload['url']))
        time.sleep(5)
        upload = expect(call('GET', 'addons/upload/%s/' % upload['uuid']), 'Upload status')
    validation = upload.get('validation') or {}
    for message in validation.get('messages', []):
        print(' ', message.get('type', '').upper() + ':', message.get('message'),
              '(%s)' % message['file'] if message.get('file') else '')
    print('Errors: %s, warnings: %s, notices: %s' % (validation.get('errors'), validation.get('warnings'),
                                                     validation.get('notices')))
    if not upload['valid']:
        fail('AMO did not accept the package')
    return upload['uuid']


def sendListing(guid, data, descriptions):
    print('Listing ...')
    expect(call('PATCH', addonPath(guid), {
        'summary': translated(data['summary']),
        'description': translated(descriptions),
        'homepage': {'en-US': data['homepage']},
        'support_url': {'en-US': data['support_url']},
        'categories': data['categories'],
    }), 'Listing')
    print('Privacy policy ...')
    expect(call('PATCH', addonPath(guid) + 'eula_policy/', {'privacy_policy': {'en-US': privacyPolicy()}}),
           'Privacy policy')
    # the new screenshots go up before the old ones are removed: a failure leaves too many, never none
    old = [preview['id'] for preview in expect(call('GET', addonPath(guid)), 'Add-on').get('previews', [])]
    for position, shot in enumerate(data['screenshots']):
        print('Screenshot', shot['file'], '...')
        preview = expect(call('POST', addonPath(guid) + 'previews/', {'position': position},
                              {'image': os.path.join(MARKET_PATH, shot['file'])}), 'Screenshot ' + shot['file'])
        expect(call('PATCH', addonPath(guid) + 'previews/%s/' % preview['id'],
                    {'caption': translated(shot['caption'])}), 'Caption of ' + shot['file'])
    for preview in old:
        expect(call('DELETE', addonPath(guid) + 'previews/%s/' % preview), 'Removing an old screenshot')
    if old:
        print('Removed', len(old), 'old screenshots')


def commandCheck():
    data, descriptions, problems = listing()
    version, path, guid = package()
    notes = data['release_notes'].get(version)
    if not notes:
        problems.append('no release notes for %s in amo.json' % version)
    if not guid:
        problems.append('no %s: python3 build/build.py --firefox' % os.path.relpath(path, PRJ_PATH))
    print('Listing: %d languages, %d screenshots, privacy policy %d characters'
          % (len(descriptions), len(data['screenshots']), len(privacyPolicy())))
    for problem in problems:
        print('Problem:', problem)
    if not keys():
        print('No AMO keys (AMO_JWT_ISSUER, AMO_JWT_SECRET): AMO not checked')
    else:
        addon, slug = remoteState(guid or buildGuid(), data['slug'])
        if addon:
            print('On AMO: %s, %s, latest listed version %s' % (addon['url'], addon['status'],
                                                                (addon.get('current_version') or {}).get('version')))
        elif slug:
            problems.append(slug)
            print('Problem:', slug)
        else:
            print('Not on AMO yet: submit creates it at the slug "%s"' % data['slug'])
    sys.exit(1 if problems else 0)


def commandSubmit():
    data, descriptions, problems = listing()
    version, path, guid = package()
    if not guid:
        fail('no %s: python3 build/build.py --firefox' % os.path.relpath(path, PRJ_PATH))
    notes = data['release_notes'].get(version)
    if not notes:
        fail('no release notes for %s in amo.json' % version)
    if not keys():
        fail('no AMO keys: AMO_JWT_ISSUER and AMO_JWT_SECRET')
    addon, slug = remoteState(guid, data['slug'])
    if not addon:
        if slug:
            fail(slug)
        if problems:
            fail('the listing for a new add-on:', '; '.join(problems))
    confirm('%s %s to addons.mozilla.org as a listed version%s.' % (
        'Submit' if addon else 'Create the add-on %s with' % guid, os.path.basename(path),
        '' if addon else ', with the listing in .work/firefox_market'))
    print('Uploading', os.path.basename(path), '...')
    upload = expect(call('POST', 'addons/upload/', {'channel': 'listed'}, {'upload': path}), 'Upload')
    upload_id = waitForUpload(upload)
    version_data = {'upload': upload_id, 'license': data['license'], 'release_notes': translated(notes),
                    'approval_notes': data['approval_notes'], 'compatibility': ['firefox']}
    if addon:
        expect(call('POST', addonPath(guid) + 'versions/', version_data), 'Version ' + version)
    else:
        created = expect(call('POST', 'addons/addon/', {
            'slug': data['slug'],
            'default_locale': 'en-US',
            'categories': data['categories'],
            'summary': translated(data['summary']),
            'description': translated(descriptions),
            'homepage': {'en-US': data['homepage']},
            'support_url': {'en-US': data['support_url']},
            'version': version_data,
        }), 'Creating the add-on')
        print('Created:', created.get('url'))
        # the notes for the reviewers, in case the create call leaves them out of the version
        expect(call('PATCH', addonPath(guid) + 'versions/%s/' % version, {'approval_notes': data['approval_notes']}),
               'Notes to reviewer')
        sendListing(guid, data, descriptions)
    print('Submitted', version, 'for review. Status: https://addons.mozilla.org/developers/addons')


def commandListing():
    data, descriptions, problems = listing()
    if problems:
        fail('; '.join(problems))
    version, path, guid = package()
    if not guid:
        fail('no %s to read the add-on ID from: python3 build/build.py --firefox' % os.path.relpath(path, PRJ_PATH))
    if not keys():
        fail('no AMO keys: AMO_JWT_ISSUER and AMO_JWT_SECRET')
    addon, slug = remoteState(guid, data['slug'])
    if not addon:
        fail('the add-on is not on AMO yet: submit creates it with the listing')
    confirm('Replace the listing of %s (texts, privacy policy, %d screenshots).' % (addon['url'],
                                                                                   len(data['screenshots'])))
    sendListing(guid, data, descriptions)
    print('Done')


COMMANDS = {'check': commandCheck, 'submit': commandSubmit, 'listing': commandListing}

if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print('Usage: python3 build/amo.py check|submit|listing')
        sys.exit(2)
    COMMANDS[sys.argv[1]]()
