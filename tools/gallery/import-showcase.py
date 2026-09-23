"""Import the six authorized conversation images. Only static assets are written."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'tools/gallery/showcase-import.json'
DEST = ROOT / 'images/gallery-showcase'
MAX_BYTES = 12 * 1024 * 1024
ALLOW = re.compile(r'^https://d2ol7oe51mr4n9\.cloudfront\.net/user_3JjgIOWHcjk4PKqJNGDT7ggmCDm/[a-f0-9-]{36}\.png$')

def prepare(item):
    if not re.fullmatch(r'[a-z0-9-]{1,70}', item['id']) or not ALLOW.fullmatch(item['source']):
        raise ValueError('Unapproved source or image identifier')
    with urlopen(Request(item['source'], headers={'User-Agent': 'EGC-Static-Asset-Import/1.0'}), timeout=45) as response:
        if not ALLOW.fullmatch(response.geturl()):
            raise ValueError('Unexpected download redirect')
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES or sha256(data).hexdigest() != item['sha256']:
        raise ValueError('Image source bytes do not match the selected conversation image')
    with Image.open(BytesIO(data)) as original:
        if original.size != (1448, 1086):
            raise ValueError('Unexpected dimensions; do not crop a comparison')
        image = original.convert('RGB')
        # Keep the entire composition, including its before/after divider and labels.
        filename = item['id'] + '-' + item['sha256'][:8]
        full = DEST / (filename + '.webp')
        thumb = DEST / (filename + '-768.webp')
        image.save(full, 'WEBP', quality=86, method=6)
        image.resize((768, 576), Image.Resampling.LANCZOS).save(thumb, 'WEBP', quality=84, method=6)
    return {
        'id': item['id'], 'title': item['title'], 'caption': item['caption'],
        'tags': item['tags'], 'kind': 'design-concept',
        'src': '/' + str(full.relative_to(ROOT)), 'thumbnail': '/' + str(thumb.relative_to(ROOT)),
        'width': 1448, 'height': 1086,
        'sourceSha256': item['sha256'], 'assetSha256': sha256(full.read_bytes()).hexdigest()
    }

if __name__ == '__main__':
    config = json.loads(SOURCE.read_text())
    if config['schemaVersion'] != 1 or len(config['images']) != 6:
        raise ValueError('Expected exactly six authorized showcase images')
    if len({x['id'] for x in config['images']}) != 6:
        raise ValueError('Duplicate image identifiers')
    DEST.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        items = list(pool.map(prepare, config['images']))
    output = {'schemaVersion': 1, 'release': config['release'], 'images': items}
    (ROOT / 'gallery-showcase.json').write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps({'imported': len(items), 'webpFiles': len(items) * 2,
                     'totalBytes': sum(p.stat().st_size for p in DEST.glob('*.webp'))}))
