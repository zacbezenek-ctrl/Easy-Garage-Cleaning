#!/usr/bin/env python3
"""Import completed Higgsfield concepts. Publication requires recorded visual approval.

This utility does NOT generate images or consume model credits. It downloads only
explicitly registered completed outputs, creates first-party WebP assets and review
sheets, and adds approved pairs to the gallery manifest. It never calls a CRM.
"""
from __future__ import annotations
import hashlib
import io
import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, build_opener, HTTPRedirectHandler
from uuid import UUID
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / 'docs/gallery-generation-registry.json'
ASSETS = ROOT / 'images/before-after/concepts'
REVIEW = ROOT / 'gallery-review'
MAX_BYTES = 32 * 1024 * 1024
URL_RE = re.compile(r'https://d8j0ntlcm91z4\.cloudfront\.net/user_3JjgIOWHcjk4PKqJNGDT7ggmCDm/hf_[0-9]{8}_[0-9]{6}_([a-f0-9-]{36})\.png\Z')
SLUG_RE = re.compile(r'[a-z0-9][a-z0-9-]{0,79}\Z')
Image.MAX_IMAGE_PIXELS = 40_000_000

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Redirects are not accepted for registered generation outputs')

def validate_pair(pair: dict) -> None:
    if not SLUG_RE.fullmatch(pair.get('id', '')):
        raise ValueError('Invalid scene ID')
    for key, maximum in [('title', 120), ('caption', 360)]:
        if not isinstance(pair.get(key), str) or not 1 <= len(pair[key]) <= maximum:
            raise ValueError(f'Invalid {key}: {pair["id"]}')
    review = pair.get('review', {})
    if review.get('status') not in ['pending', 'approved', 'rejected']:
        raise ValueError('Explicit review status is required')
    if review['status'] == 'approved':
        if not all(isinstance(review.get(k), str) and review[k].strip() for k in ['reviewer', 'reviewedAt', 'notes']):
            raise ValueError('Approval requires reviewer, date and actual visual-review notes')
    for side in ['before', 'after']:
        source = pair[side]
        job = str(UUID(source['jobId']))
        match = URL_RE.fullmatch(source['url'])
        if not match or match.group(1) != job:
            raise ValueError('URL must match the exact completed Higgsfield job and account')

def fetch_asset(pair: dict, side: str) -> tuple[str, dict]:
    source = pair[side]
    destination = ASSETS / f'{pair["id"]}-{side}-{source["jobId"][:8]}.webp'
    if not destination.exists():
        opener = build_opener(NoRedirect)
        request = Request(source['url'], headers={'User-Agent': 'EGC-Gallery-Asset-Importer/1.0'})
        with opener.open(request, timeout=60) as response:
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError('Generation exceeds the asset size limit')
        with Image.open(io.BytesIO(raw)) as original:
            if original.format not in ['PNG', 'JPEG', 'WEBP']:
                raise ValueError('Unsupported source image format')
            original.load()
            image = ImageOps.exif_transpose(original).convert('RGB')
        if image.width < 600 or image.height < 450:
            raise ValueError('Generation resolution is insufficient')
        if not 1.2 <= image.width / image.height <= 1.5:
            raise ValueError('Generation aspect ratio differs from the expected 4:3 scene')
        image.thumbnail((1440, 1080), Image.Resampling.LANCZOS)
        # No source metadata is copied to the public asset.
        buffer = io.BytesIO()
        image.save(buffer, 'WEBP', quality=84, method=6)
        destination.write_bytes(buffer.getvalue())
    with Image.open(destination) as image:
        dimensions = [image.width, image.height]
    return side, {'path': '/' + destination.relative_to(ROOT).as_posix(), 'dimensions': dimensions,
                  'bytes': destination.stat().st_size, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
                  'jobId': source['jobId']}

def prepare_pair(pair: dict) -> tuple[dict, dict]:
    validate_pair(pair)
    assets = dict(fetch_asset(pair, side) for side in ['before', 'after'])
    if assets['before']['dimensions'] != assets['after']['dimensions']:
        raise ValueError(f'Mismatched output geometry: {pair["id"]}')
    return pair, assets

def contact_sheet(rows: list[tuple[dict, dict]], number: int) -> None:
    width, row_height = 1100, 455
    sheet = Image.new('RGB', (width, row_height * len(rows)), '#f4f0e9')
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype('DejaVuSans.ttf', 18)
        small = ImageFont.truetype('DejaVuSans.ttf', 14)
    except OSError:
        font = small = ImageFont.load_default()
    for index, (pair, assets) in enumerate(rows):
        top = index * row_height
        draw.text((14, top + 9), f'{pair["id"]} | {pair["review"]["status"]} | AI concept, not customer work', fill='#122137', font=font)
        for side_index, side in enumerate(['before', 'after']):
            x = 12 + side_index * 550
            with Image.open(ROOT / assets[side]['path'].lstrip('/')) as image:
                image.thumbnail((526, 395), Image.Resampling.LANCZOS)
                sheet.paste(image, (x, top + 42))
            draw.text((x + 7, top + 431), side.upper(), fill='#122137', font=small)
    sheet.save(REVIEW / f'contact-sheet-{number:02}.jpg', quality=93)

def main() -> None:
    data = json.loads(SOURCES.read_text())
    if data.get('schemaVersion') != 1 or not isinstance(data.get('pairs'), list) or len(data['pairs']) > 48:
        raise ValueError('Unsupported generation registry')
    ids = [pair['id'] for pair in data['pairs']]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate scene IDs')
    ASSETS.mkdir(parents=True, exist_ok=True)
    REVIEW.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(prepare_pair, data['pairs']))
    manifest_path = ROOT / 'before-after-concepts.json'
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'concepts': []}
    published = {item['id']: item for item in old.get('concepts', [])}
    report = []
    for pair, assets in rows:
        if pair['review']['status'] == 'approved':
            published[pair['id']] = {'id': pair['id'], 'type': 'concept', 'status': 'published',
                'visualReviewPassed': True, 'title': pair['title'], 'caption': pair['caption'],
                'before': assets['before']['path'], 'after': assets['after']['path']}
        else:
            published.pop(pair['id'], None)
        report.append({'id': pair['id'], 'review': pair['review'], 'assets': assets})
    manifest_path.write_text(json.dumps({'schemaVersion': 1, 'concepts': sorted(published.values(), key=lambda x: x['id'])}, indent=2) + '\n')
    (REVIEW / 'asset-report.json').write_text(json.dumps({'registeredPairs': len(rows), 'publishedPairs': len(published), 'pairs': report}, indent=2) + '\n')
    for start in range(0, len(rows), 4):
        contact_sheet(rows[start:start + 4], start // 4 + 1)
    print(json.dumps({'registeredPairs': len(rows), 'optimizedImages': len(rows) * 2, 'publishedPairs': len(published), 'heldPairs': len(rows) - len(published)}))

if __name__ == '__main__':
    main()
