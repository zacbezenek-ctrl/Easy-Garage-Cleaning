#!/usr/bin/env python3
"""Import the six owner-requested planning comparisons. No customer records are used."""
import hashlib
import io
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'images/gallery-simple'
REVIEW = ROOT / 'simple-review'
OUT.mkdir(parents=True, exist_ok=True)
REVIEW.mkdir(parents=True, exist_ok=True)
manifest = json.loads((ROOT / 'tools/gallery/simple-import.json').read_text())
assert manifest['release'] == '20260923-simple-v1'
assert len(manifest['pairs']) == 6

def download(url):
    parsed = urllib.parse.urlparse(url)
    assert parsed.scheme == 'https' and parsed.hostname == 'd8j0ntlcm91z4.cloudfront.net'
    assert parsed.path.startswith('/user_3JjgIOWHcjk4PKqJNGDT7ggmCDm/')
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={'User-Agent':'EGC-Gallery-Import/1.0'})
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read(45_000_001)
            assert len(data) <= 45_000_000
            image = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert('RGB')
            image.load()
            assert 1200 <= image.width <= 8192 and abs(image.width / image.height - 4/3) < .015
            return image, hashlib.sha256(data).hexdigest()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)

pairs, report = [], []
for index, item in enumerate(manifest['pairs']):
    assert re.fullmatch('[a-z0-9-]+', item['id'])
    before, before_hash = download(item['beforeUrl'])
    after, after_hash = download(item['afterUrl'])
    assert before.size == after.size
    width, height = after.size
    # Lock unobstructed foreground concrete only, never copy new furniture.
    # In the narrow garage the new shelf extends farther toward the camera.
    start_fraction, end_fraction = (.82, .85) if item['id'] == 'single-car' else (.72, .75)
    begin, end = int(height * start_fraction), int(height * end_fraction)
    mask = Image.new('L', (width, height), 0)
    draw = ImageDraw.Draw(mask)
    for y in range(begin, end):
        draw.line((0, y, width, y), fill=round(255 * (y-begin) / max(1, end-begin)))
    draw.rectangle((0, end, width, height), fill=255)
    before = Image.composite(after, before, mask)
    floor_box = (0, end, width, height)
    assert before.crop(floor_box).tobytes() == after.crop(floor_box).tobytes()
    entry = {key:item[key] for key in ['id','title','caption','keywords']}
    entry.update({'type':'concept','customerProject':False,'width':1600,'height':1200})
    for state, image in [('before',before),('after',after)]:
        full = image.resize((1600,1200), Image.Resampling.LANCZOS)
        stream = io.BytesIO()
        full.save(stream, format='WEBP', lossless=True, method=6)
        data = stream.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        filename = f"{item['id']}-{state}-{digest[:10]}.webp"
        (OUT / filename).write_bytes(data)
        thumbname = filename.replace('.webp','-768.webp')
        full.resize((768,576), Image.Resampling.LANCZOS).save(OUT / thumbname,format='WEBP',quality=83,method=6)
        entry[state] = '/images/gallery-simple/' + filename
        entry[state+'Thumbnail'] = '/images/gallery-simple/' + thumbname
        entry[state+'Sha256'] = digest
    pairs.append(entry)
    pair_preview = Image.new('RGB',(1600,650),'white')
    for x,state,image in [(0,'BEFORE',before),(800,'AFTER',after)]:
        pair_preview.paste(image.resize((800,600),Image.Resampling.LANCZOS),(x,50))
        ImageDraw.Draw(pair_preview).text((x+16,16),item['title']+' | '+state,fill='black')
    pair_preview.save(REVIEW / f"{index+1:02d}-{item['id']}.jpg",quality=93)
    report.append({'id':item['id'],'beforeSourceSha256':before_hash,'afterSourceSha256':after_hash,'sourceSize':[width,height],'referenceEdited':True,'identicalForegroundFromRow':end,'sourceForegroundSha256':hashlib.sha256(after.crop(floor_box).tobytes()).hexdigest(),'visualReview':'pending'})

module = '// Owner-requested organization examples. Generation provenance is retained in tools/gallery/simple-import.json.\n'
module += 'export const gallerySimpleVersion = '+json.dumps(manifest['release'])+';\n'
module += 'export const gallerySimplePairs = '+json.dumps(pairs,indent=2)+';\n'
(ROOT / 'functions/_lib/gallery-simple-data.js').write_text(module)
(ROOT / 'gallery-simple.json').write_text(json.dumps({'release':manifest['release'],'pairs':pairs},indent=2)+'\n')
(REVIEW / 'asset-report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'release':manifest['release'],'pairs':len(pairs),'assets':len(list(OUT.glob('*.webp'))),'review':str(REVIEW)},indent=2))
