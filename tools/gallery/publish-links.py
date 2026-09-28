"""Idempotently add public gallery discovery without changing existing forms or scripts.

_generate_site.py calls apply(root) at the end of every build; running this file
directly patches the repository it lives in.
"""
from pathlib import Path
import re

GALLERY_URL = 'https://easygaragecleaning.com/before-after'


def add_inside(text, pattern, marker, insertion):
    match = re.search(pattern, text, re.S)
    if not match:
        raise RuntimeError('Expected homepage section was not found: ' + marker)
    block = match.group(0)
    if 'href="/before-after"' in block:
        return text
    if marker not in block:
        raise RuntimeError('Expected homepage insertion point was not found: ' + marker)
    new = block.replace(marker, insertion + marker, 1)
    return text[:match.start()] + new + text[match.end():]


def link_homepage(text):
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
    text = add_inside(text, r'<aside class="nav-drawer"[\s\S]*?</aside>', '<a href="/blog/" class="drawer-link-row">', '<a href="/before-after" class="drawer-link-row">Before &amp; After</a>\n  ')
    text = add_inside(text, r'<div class="foot-col">\s*<h3>Company</h3>[\s\S]*?</div>', '</ul>', '<li><a href="/before-after">Before &amp; After</a></li>\n      ')
    return add_inside(text, r'<section class="gallery" id="work"[\s\S]*?</section>', '</section>', '<div class="wrap" style="padding-top:24px"><a class="btn-primary" href="/before-after">Explore garage before &amp; after ideas →</a></div>\n')


def list_in_sitemap(s):
    if f'<loc>{GALLERY_URL}</loc>' in s:
        return s
    if '</urlset>' not in s:
        raise RuntimeError('Expected sitemap urlset root')
    return s.replace('</urlset>', f'  <url><loc>{GALLERY_URL}</loc><lastmod>2026-09-23</lastmod><changefreq>monthly</changefreq><priority>0.8</priority></url>\n</urlset>', 1)


def apply(root):
    root = Path(root)
    for name, patch in (('index.html', link_homepage), ('sitemap.xml', list_in_sitemap)):
        path = root / name
        text = path.read_text(encoding='utf-8')
        patched = patch(text)
        if patched != text:
            path.write_text(patched, encoding='utf-8')


if __name__ == '__main__':
    apply(Path(__file__).resolve().parents[2])
    print('Public gallery navigation, homepage CTA, footer and sitemap integrated.')
