import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { onRequest, renderPublicGallery, galleryCanonical } from '../functions/before-after.js';
import { galleryPreviewPairs } from '../functions/_lib/gallery-preview-data.js';
import { gallerySimplePairs as pairs, gallerySimpleVersion } from '../functions/_lib/gallery-simple-data.js';

const html = renderPublicGallery();
test('anonymous GET is public and indexable without cookies or staff access', async () => {
 const response = onRequest({request:new Request(galleryCanonical)});
 assert.equal(response.status,200);
 assert.equal(response.headers.get('X-Robots-Tag'),'index, follow');
 assert.match(response.headers.get('Cache-Control'),/^public,/);
 assert.equal(response.headers.get('Set-Cookie'),null);
 assert.equal(await response.text(),html);
 assert.doesNotMatch(html,/Sign in required|Design test gallery|internal-gallery-assets|name="robots" content="noindex/);
});
test('HEAD is bodyless and all mutating methods are denied', async () => {
 assert.equal(await onRequest({request:new Request(galleryCanonical,{method:'HEAD'})}).text(),'');
 for(const method of ['POST','PUT','PATCH','DELETE']) assert.equal(onRequest({request:new Request(galleryCanonical,{method})}).status,405);
});
test('six distinct reference-paired examples replace all legacy public images',()=>{
 assert.equal(pairs.length,6);
 assert.equal(new Set(pairs.map(p=>p.id)).size,6);
 assert.equal((html.match(/class="card"/g)||[]).length,6);
 assert.equal((html.match(/class="after-image"/g)||[]).length,6);
 assert.equal((html.match(/class="before-image"/g)||[]).length,6);
 const selected = new Set();
 for(const pair of pairs) {
  assert.equal(pair.type,'concept'); assert.equal(pair.customerProject,false);
  assert.equal(pair.width,1600); assert.equal(pair.height,1200);
  for(const state of ['before','after']) {
   const path=pair[state]; assert.match(path,/^\/images\/gallery-simple\/[a-z0-9-]+\.webp$/);
   assert(existsSync('.'+path)); assert(html.includes(`src="${path}"`)); selected.add(path);
   assert.equal(createHash('sha256').update(readFileSync('.'+path)).digest('hex'),pair[state+'Sha256']);
   assert(existsSync('.'+pair[state+'Thumbnail'])); assert(html.includes(pair[state+'Thumbnail']));
  }
 }
 assert.equal(selected.size,12);
 assert.doesNotMatch(html,/gallery-showcase|gallery-ideal-assets|gallery-preview-assets\/images|gallery-preview-assets\/gallery\.js/);
 assert.match(html, new RegExp('egc-gallery-release" content="'+gallerySimpleVersion));
});
test('metadata and accessible image text contain no production-method wording',()=>{
 assert(html.includes(`<link rel="canonical" href="${galleryCanonical}">`));
 assert.match(html,/property="og:image"/); assert.match(html,/name="twitter:card" content="summary_large_image"/);
 assert.match(html,/Example layouts for planning your space\./);
 assert.doesNotMatch(html,/\bAI\b|AI-generated|artificial intelligence|Higgsfield|GPT|Nano Banana/i);
 assert.equal((html.match(/organization example:/g)||[]).length,12);
 const schema=JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
 assert.equal(schema['@type'],'CollectionPage'); assert.equal(schema.url,galleryCanonical);
 assert.match(schema.description,/not a portfolio of completed customer projects/);
 assert.doesNotMatch(html,/customer review|job completed|testimonial|data-customer-id/i);
});
test('booking links, phone, search, accessible sliders and no-script access remain',()=>{
 assert.equal((html.match(/data-cta="gallery-/g)||[]).length,3);
 assert.match(html,/href="\/book"/); assert.match(html,/tel:\+19709991818/);
 assert.match(html,/id="search"/); assert.match(html,/id="viewer"/); assert.match(html,/id="viewer-body"/);
 assert.equal((html.match(/type="range"/g)||[]).length,6);
 assert.equal((html.match(/<noscript>/g)||[]).length,6);
 assert.match(html,/gallery-simple\.js/);
 const js=readFileSync('gallery-simple.js','utf8');
 assert.doesNotMatch(js,/fetch\(|XMLHttpRequest|gallery-showcase/);
});
test('staff authentication and original preview provenance remain intact',()=>{
 const route=readFileSync('functions/internal/before-after.js','utf8');
 assert.match(route,/galleryPreviewAccess/); assert.match(route,/if \(denied\)/);
 const data=readFileSync('functions/_lib/gallery-preview-data.js','utf8');
 assert.match(data,/customerProject: false/); assert.match(data,/reportedModel: 'nano_banana_2'/);
 assert.equal(galleryPreviewPairs.filter(p=>p.reviewStatus==='pending').length,7);
 const provenance=JSON.parse(readFileSync('tools/gallery/simple-import.json','utf8'));
 assert.equal(provenance.provenance.customerProjects,false);
 assert.equal(provenance.pairs.length,6);
});
test('homepage discovery and sitemap retain the canonical gallery route',()=>{
 const home=readFileSync('index.html','utf8'),sitemap=readFileSync('sitemap.xml','utf8');
 assert.match(home,/<nav class="nav"[\s\S]*?href="\/before-after"[\s\S]*?<\/nav>/);
 assert.match(home,/<aside class="nav-drawer"[\s\S]*?href="\/before-after"[\s\S]*?<\/aside>/);
 assert.match(home,/<h3>Company<\/h3>[\s\S]*?href="\/before-after"/);
 assert(home.includes('Explore garage before &amp; after ideas'));
 assert.equal(sitemap.split(`<loc>${galleryCanonical}</loc>`).length-1,1);
});
