#!/usr/bin/env python3
"""Idempotent additive integration into the existing static marketing site."""
from pathlib import Path
import re
import xml.etree.ElementTree as ET
ROOT = Path(__file__).resolve().parents[2]
page = ROOT / 'before-after.html'
html = page.read_text()
if 'before-after-polish.css' not in html:
    assert '</head>' in html
    html = html.replace('</head>', '<link rel="stylesheet" href="/before-after-polish.css?v=20260923a">\n<script src="/before-after-compare.js?v=20260923a" defer></script>\n</head>', 1)
html = html.replace('From the existing EGC photo gallery', 'Photo comparisons + clearly labeled design concepts')
page.write_text(html)
index = ROOT / 'index.html'
home = index.read_text()
if 'data-gallery-discovery="static"' not in home:
    marker = '    <div class="gallery-grid gallery-polish reveal">'
    assert home.count(marker) == 1, 'Homepage gallery marker changed; review integration rather than guessing'
    home = home.replace(marker, '    <p style="margin:0 0 24px"><a class="btn-primary" data-gallery-discovery="static" href="/before-after">Explore the before &amp; after gallery →</a></p>\n' + marker, 1)
footer = '<li><a href="/projects/">Projects</a></li>'
new_footer = footer + '\n        <li><a href="/before-after">Before &amp; After</a></li>'
if new_footer not in home:
    assert home.count(footer) == 1, 'Company footer changed; review integration rather than guessing'
    home = home.replace(footer, new_footer, 1)
home = re.sub(r'(/site-enhancements\.js)\?v=[^"\s]+', r'\1?v=20260923gallery', home)
index.write_text(home)
sitemap = ROOT / 'sitemap.xml'
xml = sitemap.read_text()
if '<loc>https://easygaragecleaning.com/before-after</loc>' not in xml:
    assert xml.count('</urlset>') == 1
    xml = xml.replace('</urlset>', '  <url><loc>https://easygaragecleaning.com/before-after</loc><lastmod>2026-09-23</lastmod></url>\n</urlset>')
ET.fromstring(xml)
sitemap.write_text(xml)
print('Integrated static homepage/footer links, current script URL, sitemap and full-size concept comparison')
