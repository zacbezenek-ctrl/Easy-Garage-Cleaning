"""Keep public structured data tied to the business and the rendered page."""
import copy
import html
import json
import re

SITE = "https://easygaragecleaning.com"
# Existing public profiles linked in the site's footer. A city map is not the business.
BUSINESS_PROFILES = [
    "https://www.facebook.com/profile.php?id=61560763061868",
    "https://www.instagram.com/easygaragecleaning/",
    "https://www.linkedin.com/company/easygaragecleaning",
    "https://nextdoor.com/pages/easy-garage-cleaning-fort-collins-co/",
    "https://www.bbb.org/us/co/fort-collins/profile/garage-organizers/easy-garage-cleaning-0805-46155789",
    "https://www.thumbtack.com/co/fort-collins/junk-removal/easy-garage-cleaning/service/577746408076951557",
]
_JSON_LD = re.compile(r'(<script\b[^>]*\btype=["\']application/ld\+json["\'][^>]*>)(.*?)(</script>)', re.I | re.S)


def normalize_schema_metadata(text):
    """Correct known legacy metadata without changing visible copy or other entities."""
    text = re.sub(r'\n?<meta\s+name="(?:geo.position|ICBM)"\s+content="40\.585260[;,] ?-105\.084419"\s*/?>', '', text)
    title = re.search(r'<title>(.*?)</title>', text, re.I | re.S)
    description = re.search(r'<meta\s+name="description"\s+content="([^"]*)"', text, re.I)
    canonical = re.search(r'<link\s+rel="canonical"\s+href="([^"]*)"', text, re.I)
    is_article = bool(canonical and '/blog/' in canonical.group(1) and not canonical.group(1).endswith('/'))
    byline = re.search(r'<(div|p) class="article-meta[^\"]*"[^>]*>([\s\S]*?)</\1>', text)
    visible_update = bool(byline and re.search(r'\bUpdated\b', byline.group(2), re.I))
    article_published = article_modified = None

    def clean(value):
        nonlocal article_published, article_modified
        if isinstance(value, list):
            for child in value:
                clean(child)
        elif isinstance(value, dict):
            if is_article and value.get('@type') == 'BlogPosting':
                article_published = value.get('datePublished')
                if visible_update:
                    article_modified = value.get('dateModified')
                else:
                    # Legacy generated dates advanced with a build, not an editorial update.
                    value.pop('dateModified', None)
            if value.get('@type') == 'LocalBusiness' and value.get('@id') == SITE + '/#business' and value.get('name'):
                profiles = value.get('sameAs', [])
                profiles = [profiles] if isinstance(profiles, str) else profiles
                profiles = profiles if isinstance(profiles, list) else []
                value['sameAs'] = list(dict.fromkeys([
                    p for p in profiles if isinstance(p, str)
                    and p != 'https://www.google.com/maps/place/Fort+Collins,+CO'
                ] + BUSINESS_PROFILES))
                address = value.get('address', {})
                if isinstance(address, dict) and address.get('streetAddress') == 'Fort Collins':
                    del address['streetAddress']
                geo = value.get('geo', {})
                # Legacy city-centre coordinates are not a verified customer-facing location.
                if isinstance(geo, dict) and geo.get('latitude') == 40.58526 and geo.get('longitude') == -105.084419:
                    del value['geo']
            if value.get('@type') == 'WebSite' and value.get('@id') == SITE + '/#website':
                actions = value.get('potentialAction')
                if isinstance(actions, list):
                    value['potentialAction'] = [a for a in actions if not (
                        isinstance(a, dict) and a.get('@type') == 'SearchAction'
                        and isinstance(a.get('target'), dict)
                        and a['target'].get('urlTemplate') in (
                            SITE + '/faq?q={search_term_string}', SITE + '/faq.html?q={search_term_string}'))]
            if value.get('@type') == 'WebPage' and canonical and value.get('url') == html.unescape(canonical.group(1)):
                if title:
                    value['name'] = html.unescape(title.group(1))
                if description:
                    value['description'] = html.unescape(description.group(1))
            for child in value.values():
                clean(child)

    def patch(match):
        try:
            original = json.loads(match.group(2))
        except ValueError:
            return match.group(0)
        updated = copy.deepcopy(original)
        clean(updated)
        if updated == original:
            return match.group(0)
        # Preserve the script boundary even if future metadata contains HTML.
        serialized = json.dumps(updated, ensure_ascii=False).replace('<', '\\u003c')
        return match.group(1) + serialized + match.group(3)

    text = _JSON_LD.sub(patch, text)
    if is_article and article_published:
        for name, value in [('published', article_published), ('modified', article_modified)]:
            pattern = r'<meta property="article:' + name + r'_time" content="[^\"]*"\s*/?>'
            replacement = '<meta property="article:' + name + '_time" content="' + html.escape(str(value), quote=True) + '" />' if value else ''
            text = re.sub(pattern, lambda _: replacement, text)
    return text
