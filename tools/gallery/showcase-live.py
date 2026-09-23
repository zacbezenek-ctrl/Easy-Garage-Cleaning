"""Read-only public website delivery check. Does not call backend/admin/customer APIs."""
from hashlib import sha256
from pathlib import Path
import json
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
BASE = 'https://easygaragecleaning.com'
EXPECTED = json.loads((ROOT / 'gallery-showcase.json').read_text())
REPORT = ROOT / 'showcase-live-report.json'

def get(path):
    request = Request(BASE + path, headers={'User-Agent': 'Mozilla/5.0 EGC public gallery release verification', 'Cache-Control': 'no-cache'})
    with urlopen(request, timeout=20) as response:
        if response.status != 200:
            raise RuntimeError(f'{path}: HTTP {response.status}')
        return response.read(15 * 1024 * 1024)

def verify():
    page = get('/before-after').decode('utf-8')
    if 'gallery-preview-assets/gallery.js' not in page or 'public-hero' not in page:
        raise RuntimeError('Public gallery HTML is not the expected page')
    actual = json.loads(get('/gallery-showcase.json'))
    if actual != EXPECTED or len(actual.get('images', [])) != 6:
        raise RuntimeError('Public showcase manifest is not the six-image release')
    files = ['/gallery-preview-assets/gallery.js', '/gallery-live.css']
    for image in EXPECTED['images']:
        files.extend([image['src'], image['thumbnail']])
    hashes = {}
    for path in files:
        expected_hash = sha256((ROOT / path.lstrip('/')).read_bytes()).hexdigest()
        actual_hash = sha256(get(path)).hexdigest()
        if actual_hash != expected_hash:
            raise RuntimeError(f'{path}: public file differs from the released asset')
        hashes[path] = actual_hash
    return {'verified': True, 'url': BASE + '/before-after', 'release': EXPECTED['release'],
            'showcaseImages': 6, 'assetFiles': 12, 'verifiedHashes': hashes}

attempts = []
for attempt in range(18):
    try:
        result = verify()
        result['attempts'] = attempts
        REPORT.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
        break
    except Exception as error:
        attempts.append({'attempt': attempt + 1, 'error': str(error)})
        REPORT.write_text(json.dumps({'verified': False, 'attempts': attempts}, indent=2) + '\n')
        print(str(error), flush=True)
        if attempt == 17:
            raise SystemExit('Public delivery was not verified; see showcase-live-report.json')
        time.sleep(10)
