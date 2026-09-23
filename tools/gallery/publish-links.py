"""Idempotently add public gallery discovery without changing existing forms or scripts."""
from pathlib import Path
import re

home = Path('index.html')
text = home.read_text()
original = text

def add_inside(pattern, marker, insertion):
    global text
    match = re.search(pattern, text, re.S)
    if not match:
        raise RuntimeError('Expected homepage section was not found: ' + marker)
    block = match.group(0)
    if 'href="/before-after"' in block:
        return
    if marker not in block:
        raise RuntimeError('Expected homepage insertion point was not found: ' + marker)
    new = block.replace(marker, insertion + marker, 1)
    text = text[:match.start()] + new + text[match.end():]

# Replace one low-priority desktop link rather than widening the existing navigation.
nav_match = re.search(r'<nav class="nav"[\s\S]*?</nav>', text)
if not nav_match:
    raise RuntimeError('Primary navigation not found')
nav = nav_match.group(0)
if 'href="/before-after"' not in nav:
    target = '<li><a href="/blog/">Blog</a></li>'
    if target not in nav:
        raise RuntimeError('Desktop navigation anchor has changed')
    nav = nav.replace(target, '<li><a href="/before-after">Before &amp; After</a></li>', 1)
    text = text[:nav_match.start()] + nav + text[nav_match.end():]
add_inside(r'<aside class="nav-drawer"[\s\S]*?</aside>', '<a href="/blog/" class="drawer-link-row">', '<a href="/before-after" class="drawer-link-row">Before &amp; After</a>\n  ')
add_inside(r'<div class="foot-col">\s*<h3>Company</h3>[\s\S]*?</div>', '</ul>', '<li><a href="/before-after">Before &amp; After</a></li>\n      ')
add_inside(r'<section class="gallery" id="work"[\s\S]*?</section>', '</section>', '<div class="wrap" style="padding-top:24px"><a class="btn-primary" href="/before-after">Explore garage before &amp; after ideas →</a></div>\n')
if text != original:
    home.write_text(text)

sitemap = Path('sitemap.xml')
s = sitemap.read_text()
url = 'https://easygaragecleaning.com/before-after'
if f'<loc>{url}</loc>' not in s:
    if '</urlset>' not in s:
        raise RuntimeError('Expected sitemap urlset root')
    s = s.replace('</urlset>', f'  <url><loc>{url}</loc><lastmod>2026-09-23</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>\n</urlset>', 1)
    sitemap.write_text(s)
print('Public gallery navigation, homepage CTA, footer and sitemap integrated.')
