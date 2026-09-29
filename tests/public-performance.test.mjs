import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { googleFontsUrl, renderPublicGallery, stylesVersion } from '../functions/before-after.js';
import { gallerySimplePairs } from '../functions/_lib/gallery-simple-data.js';
import { sourceFiles } from './source-files.mjs';

// SITE-4: the public pages stay fast on a phone. Nothing render-blocking from Google Fonts,
// small header/footer logos, responsive priority hero images, no full-size CloudFront image
// above the fold, and the shared page script as one immutable, content-versioned file.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
// Mirrors PRIVATE_HTML / PRIVATE_DIRS in _generate_site.py (tests/nav-a11y.test.mjs uses the same split).
const privateNames = new Set(['business-hub.html', 'client-login.html', 'copilot.html', 'customer-portal.html', 'dispatch.html', 'hub-login-setup.html', 'message-templates.html', 'quote.html', 'sop.html', 'tyler-contract.html']);
const privateDirs = new Set(['crew', 'contracts', 'docs', 'egc-platform', 'functions', 'tests', 'tools', 'scripts', 'auth-verifier', 'internal-gallery-assets', 'venv', 'field-qa', 'test-results', 'dist', 'node_modules']);
const publicPages = [
  ...sourceFiles(root)
    .map(entry => relative(root, join(entry.parentPath, entry.name)))
    .filter(rel => rel.endsWith('.html') && !privateNames.has(rel.split(sep).at(-1)) && !rel.split(sep).at(-1).startsWith('employee'))
    .filter(rel => !rel.split(sep).slice(0, -1).some(part => part.startsWith('.') || privateDirs.has(part)))
    .map(rel => ({ rel, html: read(rel) })),
  { rel: 'functions/before-after.js renderPublicGallery()', html: renderPublicGallery() },
];
const generator = read('_generate_site.py');
const STYLES_VERSION = generator.match(/^STYLES_VERSION = "(\d{8}[a-z])"$/m)[1];
const GOOGLE_FONTS_URL = generator.match(/^GOOGLE_FONTS_URL = "([^"]+)"$/m)[1];
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
const withoutNoscript = html => html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
const fontLinks = html => [...html.matchAll(/<link\b[^>]*\bhref="https:\/\/fonts\.googleapis\.com\/css2?\?[^"]*"[^>]*>/g)].map(match => match[0]);

// Real pixel width of a committed WebP or PNG, so srcset w descriptors can be checked against the files.
function imageWidth(path) {
  const bytes = readFileSync(join(root, path));
  if (bytes.toString('ascii', 1, 4) === 'PNG') return bytes.readUInt32BE(16);
  assert.equal(bytes.toString('ascii', 0, 4) + bytes.toString('ascii', 8, 12), 'RIFFWEBP', path);
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return bytes.readUInt16LE(26) & 0x3fff;
  if (chunk === 'VP8L') return (bytes.readUInt32LE(21) & 0x3fff) + 1;
  if (chunk === 'VP8X') return bytes.readUIntLE(24, 3) + 1;
  throw new Error(`${path}: unknown WebP chunk ${chunk}`);
}
function srcset(value) {
  return (value || '').split(',').map(item => item.trim()).filter(Boolean).map(item => { const [url, width] = item.split(/\s+/); return { url, width: Number(width?.replace(/w$/, '')) }; });
}

// CSS font matching (CSS Fonts 4, 5.2) for one family's available weights.
function matchWeight(wanted, available) {
  if (available.includes(wanted)) return wanted;
  const up = available.filter(w => w > wanted).sort((a, b) => a - b), down = available.filter(w => w < wanted).sort((a, b) => b - a);
  if (wanted >= 400 && wanted <= 500) return up.find(w => w <= 500) ?? down[0] ?? up[0];
  return wanted < 400 ? down[0] ?? up[0] : up[0] ?? down[0];
}
function fontFaces(url) {
  const faces = [];
  for (const part of new URL(url.replace(/&amp;/g, '&')).search.slice(1).split('&').filter(item => item.startsWith('family='))) {
    const [family, spec] = decodeURIComponent(part.slice(7)).split(':');
    if (!spec) continue;
    const [axes, values] = spec.split('@'), names = axes.split(','), tuples = values.split(';');
    faces.push({ family, names, tuples, key: tuples.map(tuple => tuple.split(',').map(value => Number(value.split('..')[0]))) });
  }
  return faces;
}

test('no public page waits on a Google Fonts stylesheet before its first render', () => {
  const failures = [], deferred = [];
  for (const page of publicPages) {
    const visible = withoutNoscript(page.html);
    for (const tag of fontLinks(visible)) {
      const rel = attr(tag, 'rel');
      if (rel === 'stylesheet' && attr(tag, 'media') !== 'print') failures.push(`${page.rel}: ${tag}`);
      if (rel === 'stylesheet') {
        deferred.push(page.rel);
        assert.equal(attr(tag, 'onload'), "this.media='all'", page.rel);
        const noscript = page.html.slice(page.html.indexOf(tag) + tag.length).match(/^\s*<noscript><link\b[^>]*href="([^"]+)"[^>]*><\/noscript>/);
        assert.equal(noscript?.[1], attr(tag, 'href'), `${page.rel}: a deferred font stylesheet needs its noscript copy`);
      } else assert.equal(rel, 'preload', `${page.rel}: ${tag}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(deferred.length >= 60, `expected the whole marketing site, found ${deferred.length} deferred font links`);
  const gallery = renderPublicGallery();
  assert.equal(googleFontsUrl, GOOGLE_FONTS_URL, 'the gallery loads the same font stylesheet as the generated pages');
  assert.ok(gallery.includes(`<link href="${GOOGLE_FONTS_URL}" rel="stylesheet" media="print" onload="this.media='all'"><noscript><link href="${GOOGLE_FONTS_URL}" rel="stylesheet"></noscript>`));
});

test('Google Fonts URLs are valid and request only weights the page CSS uses', () => {
  for (const page of publicPages) {
    const urls = [...new Set(fontLinks(page.html).map(tag => attr(tag, 'href')))];
    if (!urls.length) continue;
    // Google answers an unsorted or repeated tuple list with HTTP 400, and the page falls back to system fonts.
    for (const url of urls) for (const face of fontFaces(url)) {
      const keys = face.key.map(key => key.join(','));
      for (let index = 1; index < keys.length; index++) {
        const [a, b] = [face.key[index - 1], face.key[index]], order = a.findIndex((value, at) => value !== b[at]);
        assert.ok(order >= 0 && a[order] < b[order], `${page.rel}: ${face.family} tuples must be strictly ascending (${keys.join(';')})`);
      }
    }
    let css = [...page.html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n') + [...page.html.matchAll(/\sstyle="([^"]*)"/g)].map(match => match[1]).join(';');
    for (const [tag] of page.html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)) {
      const href = attr(tag, 'href')?.match(/^\/([^?"]+\.css)/)?.[1];
      if (href && existsSync(join(root, href))) css += read(href);
    }
    // Normal text is 400 and headings/strong are bold (700); every other weight must be written in the CSS.
    const used = new Set([400, 700, ...[...css.matchAll(/font-weight:\s*(\d{3})/g)].map(match => Number(match[1]))]);
    for (const url of urls) for (const face of fontFaces(url)) {
      const wght = face.names.indexOf('wght'), ital = face.names.indexOf('ital');
      for (const italic of [0, 1]) {
        const weights = face.key.filter(key => (ital < 0 ? 0 : key[ital]) === italic).map(key => key[wght]);
        if (!weights.length) continue;
        const matched = new Set([...used].map(weight => matchWeight(weight, weights)));
        for (const weight of weights) assert.ok(matched.has(weight), `${page.rel}: ${face.family}${italic ? ' italic' : ''} ${weight} is requested but no CSS weight uses it`);
      }
    }
  }
});

test('the header and footer logos are small WebP files sized for the screen, with PNG fallbacks', () => {
  const styles = read('styles.css');
  const logos = [...styles.matchAll(/url\('(\/images\/brand\/[^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(logos)].sort(), ['/images/brand/egc-logo-horizontal-primary-368.png', '/images/brand/egc-logo-horizontal-primary-368.webp', '/images/brand/egc-logo-horizontal-primary-552.webp',
    '/images/brand/egc-logo-horizontal-white-368.png', '/images/brand/egc-logo-horizontal-white-368.webp', '/images/brand/egc-logo-horizontal-white-704.webp']);
  for (const path of new Set(logos)) {
    assert.ok(statSync(join(root, path)).size <= 30 * 1024, `${path} is over 30 KB`);
    assert.equal(imageWidth(path.slice(1)), Number(path.match(/-(\d+)\.\w+$/)[1]), path);
  }
  // 1x screens take the 368px file; denser ones a file about 3x the widest phone box (181px header, 235px footer).
  for (const [name, dense] of [['primary', 552], ['white', 704]]) {
    const logo = size => `url\\('/images/brand/egc-logo-horizontal-${name}-${size}'\\)`;
    const rule = styles.match(new RegExp(`background-image:image-set\\(${logo('368\\.webp')} type\\('image/webp'\\) 1x,${logo(`${dense}\\.webp`)} type\\('image/webp'\\) 2x,${logo('368\\.png')} type\\('image/png'\\) 1x\\)`));
    assert.ok(rule, `${name} logo is served as WebP by screen density with a PNG image-set fallback`);
    // A browser without image-set keeps the plain PNG declared just before it.
    assert.match(styles, new RegExp(`${logo('368\\.png')}[^;]*;background-image:image-set`));
  }
  // The customer portal draws the same lockup as <img> tags: the small WebP files, never the 2400px PNG.
  const portal = read('customer-portal.html'), images = [...portal.matchAll(/<img\b[^>]*egc-logo-horizontal[^>]*>/g)].map(match => match[0]);
  assert.equal(images.length, 2);
  for (const tag of images) {
    assert.equal(attr(tag, 'src'), '/images/brand/egc-logo-horizontal-primary-368.webp');
    assert.equal(Number(attr(tag, 'width')), imageWidth('images/brand/egc-logo-horizontal-primary-368.webp'));
    const candidates = srcset(attr(tag, 'srcset'));
    assert.deepEqual(candidates.map(item => item.width), [368, 552]);
    for (const candidate of candidates) assert.equal(imageWidth(candidate.url.slice(1)), candidate.width, candidate.url);
    assert.ok(attr(tag, 'sizes'), tag);
  }
  assert.doesNotMatch(portal, /egc-logo-horizontal-primary\.png/);
});

test('the first hero image is a responsive priority image and its srcset widths match the files', () => {
  let heroes = 0;
  for (const page of publicPages) {
    const hero = page.html.match(/<header class="hero[^"]*"[^>]*>([\s\S]*?)<\/header>/)?.[1];
    const first = hero?.match(/<img\b[^>]*>/);
    if (!first) continue;
    heroes++;
    const tag = first[0], picture = hero.slice(0, first.index).match(/<picture>(?:(?!<\/picture>)[\s\S])*$/)?.[0] || '';
    const candidates = srcset(attr(tag, 'srcset') || attr(picture.match(/<source\b[^>]*>/)?.[0] || '', 'srcset'));
    assert.equal(attr(tag, 'fetchpriority'), 'high', `${page.rel}: first hero image needs fetchpriority="high"`);
    assert.equal(attr(tag, 'loading'), null, `${page.rel}: the priority hero image is never lazy`);
    assert.ok(candidates.length >= 2, `${page.rel}: first hero image needs a srcset`);
    assert.ok(attr(tag, 'sizes') || attr(picture.match(/<source\b[^>]*>/)?.[0] || '', 'sizes'), `${page.rel}: srcset needs sizes`);
    for (const candidate of candidates) assert.equal(imageWidth(candidate.url.slice(1)), candidate.width, `${page.rel}: ${candidate.url}`);
    if (hero.includes('class="hero-ba"')) assert.deepEqual(candidates.map(item => item.width), [600, 1200], page.rel);
  }
  assert.ok(heroes >= 20, `expected every service and city hero, found ${heroes}`);
});

test('no public image above the fold is a full-size CloudFront image, and gallery thumbnails are local', () => {
  const cloudfront = /d8j0ntlcm91z4\.cloudfront\.net/;
  for (const page of publicPages) {
    for (const [tag] of page.html.matchAll(/<img\b[^>]*>/g)) {
      if (attr(tag, 'loading') === 'lazy') continue;
      assert.doesNotMatch(attr(tag, 'src') || '', cloudfront, `${page.rel}: eager image served from CloudFront: ${tag}`);
      for (const candidate of srcset(attr(tag, 'srcset'))) assert.doesNotMatch(candidate.url, cloudfront, page.rel);
    }
  }
  const gallery = renderPublicGallery(), cards = [...gallery.matchAll(/<img class="(before|after)-image"[^>]*>/g)].map(match => match[0]);
  assert.equal(cards.length, gallerySimplePairs.length * 2);
  for (const [index, pair] of gallerySimplePairs.entries()) for (const [offset, state] of ['after', 'before'].entries()) {
    const tag = cards[index * 2 + offset], thumb = pair[`${state}Thumbnail`];
    assert.equal(attr(tag, 'src'), pair[state], 'src stays the full image, which the expanded viewer shows');
    if (thumb.startsWith('/') && thumb !== pair[state]) {
      const candidates = srcset(attr(tag, 'srcset'));
      assert.deepEqual(candidates.map(item => item.url), [thumb, pair[state]]);
      for (const candidate of candidates) assert.equal(imageWidth(candidate.url.slice(1)), candidate.width, candidate.url);
      assert.match(attr(tag, 'sizes'), /calc\(100vw - 36px\)$/);
    } else assert.equal(attr(tag, 'srcset'), null, `${pair.id}: no local thumbnail, no srcset`);
    if (index === 0) assert.equal(attr(tag, 'loading'), 'eager');
  }
  assert.match(cards[0], /srcset="\/images\/garage-after-768\.webp 768w, \/images\/garage-after\.webp 1200w"/, 'the first, eager card uses local -768 thumbnails');
});

test('site-forms.js is one immutable file whose ?v= is its content hash', () => {
  const script = read('site-forms.js'), version = createHash('sha256').update(script.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
  const headers = read('_headers');
  assert.match(headers, /^\/site-forms\.js\n {2}Cache-Control: public, max-age=31536000, immutable$/m);
  assert.match(script, /function initNavDrawer\(\)\{/);
  assert.match(script, /document\.querySelectorAll\('\.multi-step-form'\)\.forEach\(initMultiStepForm\)/);
  assert.match(generator, /^SITE_FORMS_VERSION = hashlib\.sha256\(SITE_FORMS_JS\.encode\("utf-8"\)\)\.hexdigest\(\)\[:12\]$/m);
  let loaders = 0;
  for (const page of publicPages) {
    const tags = [...page.html.matchAll(/<script\b[^>]*src="\/site-forms\.js[^"]*"[^>]*><\/script>/g)].map(match => match[0]);
    if (!tags.length) {
      // Hand-written pages keep their own inline copy; nothing else may drive a multi-step form.
      if (page.html.includes('class="multi-step-form"')) assert.match(page.html, /function initMultiStepForm\(form\)\{/, `${page.rel} has a multi-step form but no script for it`);
      continue;
    }
    loaders++;
    assert.equal(tags.length, 1, page.rel);
    assert.equal(tags[0], `<script src="/site-forms.js?v=${version}" defer></script>`, `${page.rel}: stale or non-deferred site-forms.js`);
    assert.doesNotMatch(page.html, /function initMultiStepForm\(form\)\{|function initNavDrawer\(\)\{/, `${page.rel} runs site-forms.js and an inline copy`);
  }
  assert.ok(loaders >= 40, `expected every generated page to load site-forms.js, found ${loaders}`);
});

test('pages build on one styles.css version and carry no inline footer stopgap', () => {
  assert.equal(stylesVersion, STYLES_VERSION, 'functions/before-after.js uses STYLES_VERSION from _generate_site.py');
  const styles = read('styles.css');
  assert.match(styles, /@media\(max-width:640px\)\{\.site-footer \.foot-brand a,\.site-footer \.foot-col a,\.site-footer \.foot-bar a\{display:inline-flex;align-items:center;min-height:44px\}\}/);
  for (const page of publicPages) {
    if (!page.html.includes('/styles.css')) continue;
    for (const [, version] of page.html.matchAll(/\/styles\.css\?v=([^"']+)/g)) assert.equal(version, STYLES_VERSION, page.rel);
    assert.doesNotMatch(page.html, /<style id="footer-tap">/, `${page.rel}: the footer tap rule lives in styles.css now`);
  }
});

test('pages that load site-enhancements.js render its booking bar in the HTML', () => {
  let bars = 0;
  for (const page of publicPages) {
    if (!page.html.includes('<script src="/site-enhancements.js')) continue;
    const main = page.html.match(/<main\b[^>]*\bid="main-content"[^>]*>/);
    assert.ok(main, page.rel);
    const after = page.html.slice(main.index + main[0].length);
    assert.ok(after.startsWith('<nav id="egc-customer-access" class="egc-customer-access" aria-label="Booking and customer portal">'), `${page.rel}: the bar is the first thing in main, so the script never inserts it above the hero`);
    assert.equal((page.html.match(/id="egc-customer-access"/g) || []).length, 1, page.rel);
    assert.match(after, /^<nav[^>]*><div class="egc-customer-access-inner">[\s\S]*?<a href="\/book">Book a Free Walkthrough<\/a><a href="\/customer-portal">Customer Portal<\/a>/);
    assert.equal(after.includes('class="egc-business-contact"'), page.rel === 'book.html', page.rel);
    bars++;
  }
  assert.ok(bars >= 40, `expected the generated pages, found ${bars}`);
  assert.match(read('styles.css'), /\.egc-customer-access\{background:#f4f2ec;/);
});

// The bar site-enhancements.js builds (run against a minimal DOM), serialized like the generator writes it.
function scriptedCustomerAccess(pathname) {
  const element = tag => ({ tag, id: '', className: '', href: '', textContent: '', attributes: [], children: [],
    setAttribute(name, value) { this.attributes.push([name, String(value)]); },
    appendChild(child) { this.children.push(child); return child; },
    insertBefore(child, before) { this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child); return child; },
    get firstChild() { return this.children[0] || null; } });
  const main = element('main'), head = element('head');
  const document = { readyState: 'complete', head, getElementById: id => (id === 'main-content' ? main : null), createElement: element,
    createTextNode: text => ({ text }), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  vm.runInNewContext(read('site-enhancements.js'), { window: { location: { pathname } }, document });
  const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = node => {
    if (!node.tag) return escape(node.text);
    const attrs = [['id', node.id], ['class', node.className], ...node.attributes, ['href', node.href]].filter(([, value]) => value).map(([name, value]) => ` ${name}="${value}"`).join('');
    return `<${node.tag}${attrs}>${node.children.length ? node.children.map(html).join('') : escape(node.textContent)}</${node.tag}>`;
  };
  assert.equal(main.children.length, 1);
  return html(main.children[0]);
}

test('the booking bar in the HTML matches the one site-enhancements.js builds, business contact included', () => {
  // BOOK_BUSINESS_CONTACT in _generate_site.py and site-enhancements.js carry the same partnership contact;
  // the script is no-cache so it updates live, and book.html must not keep an old phone or email.
  for (const [pathname, page] of [['/book', 'book.html'], ['/pricing', 'pricing.html'], ['/', 'index.html']]) {
    const html = read(page), start = html.indexOf('<nav id="egc-customer-access"');
    assert.ok(start >= 0, page);
    assert.equal(html.slice(start, html.indexOf('</nav>', start) + 6), scriptedCustomerAccess(pathname), `${page}: the static bar and site-enhancements.js differ`);
  }
  assert.match(scriptedCustomerAccess('/book'), /<p class="egc-business-contact">Business partnerships: [^<]+<a href="tel:\+1\d{10}">[^<]+<\/a> \| <a href="mailto:[^"@]+@easygaragecleaning\.com">/);
  assert.doesNotMatch(scriptedCustomerAccess('/pricing'), /egc-business-contact/);
});
