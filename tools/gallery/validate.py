#!/usr/bin/env python3
"""Static asset/provenance checks; not a substitute for visual review."""
import json
import re
from pathlib import Path
from PIL import Image
from prepare import validate_pair
root = Path(__file__).resolve().parents[2]
registry = json.loads((root / 'docs/gallery-generation-registry.json').read_text())
for pair in registry['pairs']:
    validate_pair(pair)
manifest = json.loads((root / 'before-after-concepts.json').read_text())
assert manifest['schemaVersion'] == 1
approved = {p['id'] for p in registry['pairs'] if p['review']['status'] == 'approved'}
for item in manifest['concepts']:
    assert item['id'] in approved, 'Unapproved image reached public manifest'
    assert item['type'] == 'concept' and item['status'] == 'published' and item['visualReviewPassed'] is True
    for side in ['before', 'after']:
        assert re.fullmatch(r'/images/before-after/concepts/[a-z0-9-]+\.webp', item[side])
        file = root / item[side].lstrip('/')
        with Image.open(file) as image:
            image.verify()
        assert file.stat().st_size < 1_000_000
html = (root / 'before-after.html').read_text()
assert len(re.findall(r'<h1\b', html)) == 1
assert 'AI-generated concept' in html and 'not a photograph of work performed by EGC' in html
print(f'PASS: {len(registry["pairs"])} registered pairs; {len(manifest["concepts"])} approved public pairs')
