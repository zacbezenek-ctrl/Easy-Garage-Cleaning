import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const blocks = html => [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => JSON.parse(m[1]));
function* objects(value) {
  if (value && typeof value === 'object') {
    if (!Array.isArray(value)) yield value;
    for (const child of Object.values(value)) yield* objects(child);
  }
}
const urls = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]));
const pages = urls.map(url => ({ url: url.href, html: read(url.pathname.endsWith('/') ? url.pathname.slice(1) + 'index.html' : url.pathname.slice(1) + '.html') }));

test('public business schema identifies EGC rather than a city map or placeholder location', () => {
  let businesses = 0;
  for (const page of pages) for (const block of blocks(page.html)) for (const node of objects(block)) {
    if (node['@type'] !== 'LocalBusiness' || !node.name || node['@id'] !== 'https://easygaragecleaning.com/#business') continue;
    businesses++;
    assert.ok(node.sameAs.some(p => p.includes('bbb.org/us/co/fort-collins/profile/garage-organizers/easy-garage-cleaning-')), page.url);
    assert.ok(!node.sameAs.includes('https://www.google.com/maps/place/Fort+Collins,+CO'), page.url);
    assert.notEqual(node.address?.streetAddress, 'Fort Collins', page.url);
    assert.notDeepEqual(node.geo, { '@type': 'GeoCoordinates', latitude: 40.58526, longitude: -105.084419 }, page.url);
  }
  assert.ok(businesses >= 30, 'scan must reach the actual generated business entities');
});

test('homepage schema has the actual page title and no unsupported FAQ search URL', () => {
  const html = read('index.html');
  const nodes = blocks(html).flatMap(block => [...objects(block)]);
  const page = nodes.find(n => n['@type'] === 'WebPage');
  assert.equal(page.name, html.match(/<title>(.*?)<\/title>/)[1]);
  assert.ok(!nodes.some(n => n['@type'] === 'SearchAction'));
  assert.ok(nodes.some(n => n['@type'] === 'ContactAction'), 'real contact actions stay');
});

test('metadata normalization is idempotent and preserves visible text, prices, other entities and future business profiles', () => {
  const run = spawnSync('python3', ['-c', `
import json
from _seo_metadata import normalize_schema_metadata
business = {'@type':'LocalBusiness','@id':'https://easygaragecleaning.com/#business','name':'Easy Garage Cleaning','sameAs':['https://www.google.com/maps/place/Fort+Collins,+CO','https://example.test/verified-profile'],'description':'Synthetic price $123','address':{'streetAddress':'Fort Collins'},'geo':{'@type':'GeoCoordinates','latitude':40.58526,'longitude':-105.084419}}
other = {'@type':'LocalBusiness','@id':'https://example.test/other','name':'Synthetic other business','geo':{'latitude':40.58526,'longitude':-105.084419}}
text = '<html><head><title>Title &amp; More</title><meta name="description" content="Synthetic &amp; text"><link rel="canonical" href="https://easygaragecleaning.com/example"><script type="application/ld+json">'+json.dumps([business,other])+'</script></head><body><p>Visible synthetic price $123</p></body></html>'
once = normalize_schema_metadata(text)
assert once == normalize_schema_metadata(once)
assert '<body><p>Visible synthetic price $123</p></body>' in once
data=json.loads(once.split('application/ld+json">')[1].split('</script>')[0])
assert data[0]['description'] == 'Synthetic price $123'
assert 'https://example.test/verified-profile' in data[0]['sameAs']
assert data[1] == other
assert normalize_schema_metadata('<script type="application/ld+json">invalid</script>') == '<script type="application/ld+json">invalid</script>'
print('ok')
`], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'ok');
});

test('sitemap keeps canonical discoverable URLs without invented modification dates', () => {
  assert.equal(urls.length, new Set(urls.map(u => u.href)).size);
  assert.ok(urls.length >= 60);
  assert.doesNotMatch(read('sitemap.xml'), /<lastmod>/);
  for (const page of pages) {
    assert.ok(page.html.includes(`rel="canonical" href="${page.url}"`), page.url);
    assert.doesNotMatch(page.html.match(/<meta name="robots"[^>]*>/)?.[0] || '', /noindex/i, page.url);
  }
});
