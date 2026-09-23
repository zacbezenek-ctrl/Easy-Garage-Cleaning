#!/usr/bin/env python3
"""Verify the deployed public gallery, not just a successful Git commit.

Read-only HTTP requests. No analytics execution, customer data or form submissions.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import hashlib
import json
import os
import time
ROOT = Path(__file__).resolve().parents[2]
BASE = 'https://easygaragecleaning.com'
REVISION = os.environ.get('GITHUB_SHA', 'manual')[:12]
REPORT = ROOT / 'gallery-live-report.json'
EXPECTED = json.loads((ROOT / 'before-after-concepts.json').read_text())

def fetch(path):
    separator = '&' if '?' in path else '?'
    url = BASE + path + separator + 'egc_release=' + REVISION
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0 EGC-Gallery-Release-Verification/1.0', 'Cache-Control': 'no-cache'})
    with urlopen(request, timeout=25) as response:
        if response.status != 200:
            raise ValueError(f'{path}: HTTP {response.status}')
        return response.read()

def verify_asset(path):
    expected = (ROOT / path.lstrip('/')).read_bytes()
    actual = fetch(path)
    if hashlib.sha256(expected).digest() != hashlib.sha256(actual).digest():
        raise ValueError(f'Deployed asset differs: {path}')
    return path

def verify():
    html = fetch('/before-after').decode()
    if 'Less stuff.' not in html or 'before-after-compare.js' not in html:
        raise ValueError('Public page is not the current gallery build')
    if json.loads(fetch('/before-after-concepts.json')) != EXPECTED:
        raise ValueError('Public gallery manifest has not reached the current approved version')
    home = fetch('/').decode()
    if 'data-gallery-discovery="static"' not in home:
        raise ValueError('Homepage gallery discovery link not deployed')
    if '<loc>https://easygaragecleaning.com/before-after</loc>' not in fetch('/sitemap.xml').decode():
        raise ValueError('Public sitemap entry not deployed')
    paths = ['/before-after.css', '/before-after.js', '/before-after-polish.css', '/before-after-compare.js']
    for concept in EXPECTED['concepts']:
        paths.extend([concept['before'], concept['after']])
    with ThreadPoolExecutor(max_workers=6) as pool:
        checked = list(pool.map(verify_asset, paths))
    return {'verified': True, 'revision': REVISION, 'page': BASE + '/before-after',
            'approvedConceptPairs': len(EXPECTED['concepts']), 'sha256VerifiedAssets': len(checked),
            'homepageLink': True, 'sitemapEntry': True, 'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}

errors = []
for attempt in range(1, 13):
    try:
        result = verify()
        REPORT.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
        break
    except (OSError, ValueError, HTTPError) as error:
        errors.append({'attempt': attempt, 'error': str(error)})
        print(f'Deployment not yet verified, attempt {attempt}: {error}', flush=True)
        if attempt == 12:
            result = {'verified': False, 'revision': REVISION, 'errors': errors}
            REPORT.write_text(json.dumps(result, indent=2) + '\n')
            raise SystemExit('Public deployment verification did not pass. A commit or merge is not proof the page is live.')
        time.sleep(20)
