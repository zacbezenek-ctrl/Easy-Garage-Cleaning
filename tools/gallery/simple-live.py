#!/usr/bin/env python3
"""Read-only verification of the public gallery release and its exact assets."""
import concurrent.futures
import hashlib
import json
import re
import time
import urllib.request
from pathlib import Path

BASE='https://easygaragecleaning.com'
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'simple-page-review'
OUT.mkdir(exist_ok=True)
manifest=json.loads((ROOT/'gallery-simple.json').read_text())

def get(path):
    request=urllib.request.Request(path if path.startswith('http') else BASE+path,headers={'User-Agent':'Mozilla/5.0 EGC public gallery release verification','Cache-Control':'no-cache'})
    with urllib.request.urlopen(request,timeout=30) as response:
        assert response.status==200,(path,response.status)
        return response.read(32*1024*1024)

error='Deployment not checked'
for attempt in range(30):
    try:
        html=get('/before-after')
        assert ('name="egc-gallery-release" content="'+manifest['release']+'"').encode() in html,'Public HTML is not yet the tested release'
        assert len(re.findall(rb'class="ba-card"',html))==4
        assert b'/gallery-simple.js' in html and b'/gallery-simple.css' in html
        assert not re.search(rb'\bAI\b|AI-generated|gallery-showcase|gallery-ideal-assets',html,re.I)
        for pair in manifest['pairs']:
            for state in ['before','after']:
                assert ('src="'+pair[state]+'"').encode() in html
        break
    except Exception as exc:
        error=str(exc)
        print(f'Waiting for public release ({attempt+1}/30): {error}',flush=True)
        if attempt==29:
            (OUT/'live-report.json').write_text(json.dumps({'passed':False,'error':error,'release':manifest['release']},indent=2))
            raise
        time.sleep(10)

paths=['/gallery-simple.js','/gallery-simple.css','/styles.css']
for pair in manifest['pairs']:
    for key in ['before','after','beforeThumbnail','afterThumbnail']:
        paths.append(pair[key] if pair[key].startswith('/') else pair[key].replace(BASE,''))

def check(path):
    actual=get(path)
    digest=hashlib.sha256(actual).hexdigest()
    if path.startswith('/'):
        expected_digest=hashlib.sha256((ROOT/path.lstrip('/')).read_bytes()).hexdigest()
        assert digest==expected_digest,(path,'content hash mismatch')
    return {'path':path,'status':200,'bytes':len(actual),'sha256':digest}

with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
    assets=list(pool.map(check,paths))
result={'passed':True,'url':BASE+'/before-after','release':manifest['release'],'cards':4,'htmlSha256':hashlib.sha256(html).hexdigest(),'verifiedAssets':assets,'checkedAtUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
(OUT/'live-report.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
