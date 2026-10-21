// Home page mobile performance (Lighthouse `/`): sized WebP files for the hero and the Results gallery, and self-hosted
// fonts declared before the first layout, so phones download less before the hero paints and the page is laid out once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = file => readFileSync(join(root, file), 'utf8');
const home = read('index.html');
const head = home.split('</head>', 1)[0];

// Pixel width of a WebP file (lossy VP8, lossless VP8L or extended VP8X header).
function webpWidth(file) {
  const b = readFileSync(join(root, file));
  assert.equal(b.toString('ascii', 0, 4), 'RIFF', `${file} is a RIFF file`);
  assert.equal(b.toString('ascii', 8, 12), 'WEBP', `${file} is a WebP file`);
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return b.readUInt16LE(26) & 0x3fff;
  if (chunk === 'VP8L') return (b.readUInt32LE(21) & 0x3fff) + 1;
  if (chunk === 'VP8X') return b.readUIntLE(24, 3) + 1;
  throw new Error(`${file}: unknown WebP chunk ${chunk}`);
}

function srcsetEntries(srcset) {
  return srcset.split(',').map(part => part.trim().split(/\s+/)).map(([url, w]) => ({ url, width: Number(w.replace(/w$/, '')) }));
}

test('every image and font the home page references is in the repository', () => {
  const urls = new Set([...home.matchAll(/(?:src|href|srcset|imagesrcset)="([^"]+)"/g)].flatMap(([, value]) => value.split(',').map(part => part.trim().split(/\s+/)[0])));
  const local = [...urls].filter(url => /^\/(?:images|fonts)\//.test(url));
  assert.ok(local.length >= 15, local.join(' '));
  for (const url of local) assert.ok(existsSync(join(root, url)), `${url} is missing`);
  for (const [, url] of home.matchAll(/url\((\/fonts\/[^)]+)\)/g)) assert.ok(existsSync(join(root, url)), `${url} is missing`);
});

test('a 3x phone gets a 1080w hero instead of the 1646w original, and every srcset width is the real file width', () => {
  const preload = head.match(/<link rel="preload" as="image"[^>]+imagesrcset="([^"]+)"[^>]*fetchpriority="high">/);
  assert.ok(preload, 'the hero image is preloaded with high priority');
  const hero = home.match(/<figure class="hero-result">\s*<picture><source type="image\/webp" srcset="([^"]+)" sizes="([^"]+)"><img [^>]*fetchpriority="high"/);
  assert.ok(hero, 'the hero picture keeps its WebP source and high priority');
  assert.equal(preload[1], hero[1], 'the preload and the picture choose from the same files');
  assert.deepEqual(srcsetEntries(hero[1]).map(entry => entry.width), [824, 1080, 1646]);
  for (const [, srcset] of home.matchAll(/srcset="([^"]+\.webp [^"]+)"/g)) {
    for (const { url, width } of srcsetEntries(srcset)) assert.equal(webpWidth(url), width, `${url} is ${width}px wide`);
  }
});

test('the Results gallery serves sized WebP files, stays lazy and keeps its JPEG fallbacks and dimensions', () => {
  const gallery = home.match(/<section class="gallery" id="work"[\s\S]*?<\/section>/)[0];
  const pictures = [...gallery.matchAll(/<picture><source type="image\/webp" srcset="([^"]+)" sizes="([^"]+)"><img src="(\/images\/[^"]+\.jpg)" alt="[^"]+" loading="lazy" decoding="async" width="\d+" height="\d+"><\/picture>/g)];
  assert.equal(pictures.length, 4, gallery);
  assert.equal((gallery.match(/<img /g) || []).length, 4, 'no gallery image is left without a sized WebP source');
  for (const [, srcset, sizes, fallback] of pictures) {
    const entries = srcsetEntries(srcset);
    assert.ok(entries[0].width <= 824, `${fallback}: the smallest file suits a phone (${srcset})`);
    assert.match(sizes, /^\(min-width: 768px\) \d+vw, calc\((?:50|100)vw - \d+px\)$/);
    assert.ok(existsSync(join(root, fallback)), fallback);
  }
});

test('the home page hosts its fonts and declares them before the first layout', () => {
  assert.doesNotMatch(home, /fonts\.googleapis\.com|fonts\.gstatic\.com/, 'no third-party font stylesheet that re-lays out the page when it applies');
  const style = head.match(/<style id="egc-fonts">([^<]+)<\/style>/);
  assert.ok(style, 'the @font-face rules are inline in <head>');
  assert.ok(head.indexOf('id="egc-fonts"') < head.indexOf('/styles.css'), 'fonts are declared before the main stylesheet');
  const faces = [...style[1].matchAll(/@font-face\{font-family:'([^']+)';font-style:(\w+);font-weight:([\d ]+);font-display:swap;src:url\((\/fonts\/[^)]+\.woff2)\) format\('woff2'\);unicode-range:[^}]+\}/g)];
  assert.equal(faces.length, (style[1].match(/@font-face/g) || []).length, 'every face swaps and names a woff2 file');
  const declared = new Set(faces.map(([, family, fontStyle, weight]) => `${family} ${fontStyle} ${weight}`));
  // The families and weights the Google Fonts link requested: Inter 400-900, JetBrains Mono 400, Fraunces 400-700 and italic 400.
  assert.deepEqual([...declared].sort(), ['Fraunces italic 400', 'Fraunces normal 400 700', 'Inter normal 400 900', 'JetBrains Mono normal 400']);
  assert.match(head, /<link rel="preload" href="\/fonts\/inter-latin-v20\.woff2" as="font" type="font\/woff2" crossorigin>/);
  for (const name of ['inter', 'jetbrainsmono', 'fraunces']) assert.match(read(`fonts/OFL-${name}.txt`), /SIL OPEN FONT LICENSE Version 1\.1/);
});

test('self-hosted fonts are cached like images and allowed by the site CSP', () => {
  assert.match(read('_headers'), /\n\/fonts\/\*\n  Cache-Control: public, max-age=31536000, immutable\n/);
  assert.match(read('functions/_middleware.js'), /font-src 'self'/);
});
