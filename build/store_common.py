# What the store scripts (amo.py, cws.py, edge.py) share: the keys file, HTTP, the package, asking before sending.

import os, sys, json, time, urllib.request, urllib.error
from zipfile import ZipFile

CUR_PATH = os.path.dirname(os.path.abspath(__file__))
PRJ_PATH = os.path.dirname(CUR_PATH)
WORK_PATH = os.path.join(PRJ_PATH, '.work')
# KEY=value lines, kept out of git
KEYS_FILE = os.path.join(WORK_PATH, 'store-keys.env')
RELEASES_PATH = os.path.join(CUR_PATH, 'releases')
POLL_EVERY = 5
POLL_LIMIT = 300


def fail(*message):
    print('Error.', *message)
    sys.exit(1)


def readText(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def readKeys(names):
    # from the environment first, then from the keys file; None when one is missing
    found = {name: os.environ.get(name) for name in names}
    if os.path.isfile(KEYS_FILE):
        for line in readText(KEYS_FILE).splitlines():
            name, sep, value = line.partition('=')
            name = name.strip()
            if sep and name in found and not found[name]:
                found[name] = value.strip()
    return found if all(found.values()) else None


def needKeys(names):
    keys = readKeys(names)
    if not keys:
        fail('no keys: %s, in the environment or in %s' % (', '.join(names), os.path.relpath(KEYS_FILE, PRJ_PATH)))
    return keys


def http(method, url, headers=None, body=None, timeout=300):
    # (status, the answer's JSON or text, the answer's headers); an error status comes back too, the caller decides
    headers = dict(headers or {})
    headers.setdefault('User-Agent', 'TabHamster-build')
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, body, headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, text, got = response.status, response.read().decode('utf-8', 'replace'), response.headers
    except urllib.error.HTTPError as error:
        status, text, got = error.code, error.read().decode('utf-8', 'replace'), error.headers
    except urllib.error.URLError as error:
        fail(method, url, 'failed:', error.reason)
    try:
        return status, json.loads(text) if text else None, got
    except ValueError:
        return status, text, got


def expect(answer, what):
    status, body = answer[0], answer[1]
    if status >= 400:
        fail(what, 'failed (HTTP %d):' % status, json.dumps(body, indent=2, ensure_ascii=False)
             if isinstance(body, (dict, list)) else body)
    return body


def poll(what, check):
    # calls check() until it returns something other than None
    deadline = time.time() + POLL_LIMIT
    while True:
        result = check()
        if result is not None:
            return result
        if time.time() > deadline:
            fail(what, 'is still in progress after %d s' % POLL_LIMIT)
        time.sleep(POLL_EVERY)


def confirm(question):
    if input(question + ' Type "y" to go on: ').strip().lower() != 'y':
        print('Stopped, nothing sent.')
        sys.exit(1)


def manifestVersion():
    return json.loads(readText(os.path.join(PRJ_PATH, 'manifest.json')))['version']


def zipManifest(path):
    # the manifest in a store zip: at the top (Firefox) or in the project folder (Chrome, Edge)
    with ZipFile(path) as z:
        name = min((n for n in z.namelist() if n.split('/')[-1] == 'manifest.json'), key=len)
        return json.loads(z.read(name))


def chromiumPackage():
    # the Chrome Web Store and Edge Add-ons zip of the version in manifest.json, or None when it isn't built
    version = manifestVersion()
    path = os.path.join(RELEASES_PATH, version + '.zip')
    if not os.path.isfile(path):
        return version, path, False
    if zipManifest(path)['version'] != version:
        fail(os.path.relpath(path, PRJ_PATH), 'has another version inside')
    return version, path, True


def readBytes(path):
    with open(path, 'rb') as f:
        return f.read()
