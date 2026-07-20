"""Rewrite internal links, canonicals, and sitemap entries to extensionless URLs.

Cloudflare Pages serves every page at its extensionless path and 308-redirects
the .html variant to it, so the extensionless form is the only URL Google will
index (confirmed via URL Inspection: .html URLs report "Page with redirect",
Google canonical = extensionless). This pass makes every self-referencing URL
the site emits — canonical tags, og:url, JSON-LD, internal hrefs, meta
refreshes, sitemap.xml, llms/ai indexes — agree with that reality.

Used two ways:
  * `python3 _finalize_urls.py` — one-off pass over the checked-in site
  * imported by _generate_site.py, which calls finalize_site(ROOT) at the end
    of main() so regenerated output stays extensionless
"""
import posixpath
import re
from pathlib import Path

SITE = "https://easygaragecleaning.com"

_ABS_RE = re.compile(r"https?://easygaragecleaning\.com(/[A-Za-z0-9\-/_]*\.html)")
_REFRESH_RE = re.compile(r"(url=)(/[A-Za-z0-9\-/_]*\.html)")
_HREF_RE = re.compile(r'(href=")([^"]+\.html(?:[?#][^"]*)?)(")')


def _map_path(path):
    """/x.html -> /x, /blog/index.html -> /blog/, /index.html -> /"""
    if path.endswith("/index.html"):
        return path[: -len("index.html")]
    if path.endswith(".html"):
        return path[:-5]
    return path


def _rewrite_html(text, file_dir):
    text = _ABS_RE.sub(lambda m: SITE + _map_path(m.group(1)), text)
    text = _REFRESH_RE.sub(lambda m: m.group(1) + _map_path(m.group(2)), text)

    def href(m):
        value = m.group(2)
        if value.startswith(("http://", "https://", "//", "#", "mailto:", "tel:")):
            return m.group(0)
        parts = re.match(r"([^?#]*)([?#].*)?$", value)
        path, suffix = parts.group(1), parts.group(2) or ""
        if not path.endswith(".html"):
            return m.group(0)
        if not path.startswith("/"):
            path = posixpath.normpath(posixpath.join("/", file_dir, path))
        return m.group(1) + _map_path(path) + suffix + m.group(3)

    return _HREF_RE.sub(href, text)


def finalize_site(root):
    root = Path(root)
    changed = []
    for pattern in ("*.html", "blog/*.html", "projects/*.html"):
        for f in sorted(root.glob(pattern)):
            rel_dir = str(f.parent.relative_to(root))
            rel_dir = "" if rel_dir == "." else rel_dir
            text = f.read_text(encoding="utf-8")
            new = _rewrite_html(text, rel_dir)
            if new != text:
                f.write_text(new, encoding="utf-8")
                changed.append(str(f.relative_to(root)))
    for name in ("sitemap.xml", "llms.txt", "llms-full.txt", "ai.txt"):
        f = root / name
        if not f.exists():
            continue
        text = f.read_text(encoding="utf-8")
        new = _ABS_RE.sub(lambda m: SITE + _map_path(m.group(1)), text)
        if new != text:
            f.write_text(new, encoding="utf-8")
            changed.append(name)
    return changed


if __name__ == "__main__":
    for name in finalize_site(Path(__file__).parent):
        print("finalized", name)
