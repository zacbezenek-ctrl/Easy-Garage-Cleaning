import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { onRequest, renderPublicGallery, galleryCanonical } from '../functions/before-after.js';
import { galleryPreviewPairs } from '../functions/_lib/gallery-preview-data.js';
import { galleryPublicPairs, galleryFeaturedIds } from '../functions/_lib/gallery-public-data.js';
import { publicGalleryAsset } from '../functions/before-after-preview.js';

const html = renderPublicGallery();
test('anonymous GET returns public indexable gallery, not a Hub sign-in page', async () => {
 const response = onRequest({request:new Request(galleryCanonical)});
 assert.equal(response.status,200);
 assert.equal(response.headers.get('X-Robots-Tag'),'index, follow');
 assert.match(response.headers.get('Cache-Control'),/^public,/);
 assert.equal(response.headers.get('Set-Cookie'),null);
 assert.equal(await response.text(),html);
 assert.doesNotMatch(html,/Sign in required|Design test gallery|internal-gallery-assets|name="robots" content="noindex/);
});
test('HEAD is bodyless; methods that could mutate are denied', async () => {
 assert.equal(await onRequest({request:new Request(galleryCanonical,{method:'HEAD'})}).text(),'');
 for(const method of ['POST','PUT','PATCH','DELETE']) assert.equal(onRequest({request:new Request(galleryCanonical,{method})}).status,405);
});
test('24 distinct scenes and all 48 selected public assets are included exactly once',()=>{
 assert.equal(galleryPublicPairs.length,24);
 assert.deepEqual(galleryPublicPairs.map(p=>p.id).sort(),galleryPreviewPairs.map(p=>p.id).sort());
 assert.equal((html.match(/class="card"/g)||[]).length,24);
 assert.equal((html.match(/class="after-image"/g)||[]).length,24);
 assert.equal((html.match(/class="before-image"/g)||[]).length,24);
 const selected=new Set();
 for(const pair of galleryPublicPairs) for(const path of [pair.before,pair.after]) {
  const publicPath=publicGalleryAsset(path);assert(existsSync('.'+publicPath));assert(html.includes(`src="${publicPath}"`));selected.add(publicPath);
 }
 assert.equal(selected.size,48);
});
test('the eight refreshed black-storage concepts lead in curated order',()=>{
 const expected=['24-complete-organization','01-family-garage','23-winter-parking','04-working-bench','05-seasonal-storage','09-moving-boxes','03-four-bikes','02-single-car'];
 assert.deepEqual(galleryFeaturedIds,expected);
 assert.deepEqual([...html.matchAll(/data-scene="([^"]+)"/g)].slice(0,8).map(m=>m[1]),expected);
 for(const pair of galleryPublicPairs.slice(0,8)) {
  assert.equal(pair.visualReviewPassed,true);assert.equal(pair.type,'concept');assert.equal(pair.customerProject,false);
  assert(pair.before.startsWith('/gallery-ideal-assets/'));assert(pair.after.startsWith('/gallery-ideal-assets/'));
  assert.equal(pair.width,1168);assert.equal(pair.height,880);
 }
 assert.match(html,/property="og:image" content="https:\/\/easygaragecleaning\.com\/gallery-ideal-assets\/images\/24-complete-organization-after-24c80cfd\.webp"/);
 assert.match(html,/03-four-bikes-after-951c8c03\.webp/);
 assert.doesNotMatch(html,/1606723b/);
});
test('canonical, sharing metadata, schema and meaningful concept context are present',()=>{
 assert(html.includes(`<link rel="canonical" href="${galleryCanonical}">`));
 assert.match(html,/property="og:image"/);assert.match(html,/name="twitter:card" content="summary_large_image"/);
 assert.match(html,/AI-generated design concepts\. Not completed customer projects\./);
 assert.equal((html.match(/AI-generated (?:before|after) concept:/g)||[]).length,48);
 const schema=JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
 assert.equal(schema['@type'],'CollectionPage');assert.equal(schema.url,galleryCanonical);
 assert.doesNotMatch(html,/customer review|job completed|testimonial|data-customer-id/i);
});
test('booking links, phone, search, sliders, no-JavaScript access and dialog are retained',()=>{
 assert.equal((html.match(/data-cta="gallery-/g)||[]).length,3);
 assert.match(html,/href="\/book"/);assert.match(html,/tel:\+19709991818/);
 assert.match(html,/id="search"/);assert.match(html,/id="viewer"/);assert.match(html,/id="viewer-body"/);
 assert.equal((html.match(/type="range"/g)||[]).length,24);
 assert.equal((html.match(/<noscript>/g)||[]).length,24);
});
test('staff authentication and preview provenance have not been weakened',()=>{
 const route=readFileSync('functions/internal/before-after.js','utf8');
 assert.match(route,/galleryPreviewAccess/);assert.match(route,/if \(denied\)/);
 const data=readFileSync('functions/_lib/gallery-preview-data.js','utf8');
 assert.match(data,/customerProject: false/);assert.match(data,/reportedModel: 'nano_banana_2'/);
 assert.equal(galleryPreviewPairs.filter(p=>p.reviewStatus==='pending').length,7);
});
test('static homepage discovery and sitemap publish the canonical route',()=>{
 const home=readFileSync('index.html','utf8'),sitemap=readFileSync('sitemap.xml','utf8');
 assert.match(home,/<nav class="nav"[\s\S]*?href="\/before-after"[\s\S]*?<\/nav>/);
 assert.match(home,/<aside class="nav-drawer"[\s\S]*?href="\/before-after"[\s\S]*?<\/aside>/);
 assert.match(home,/<h3>Company<\/h3>[\s\S]*?href="\/before-after"/);
 assert(home.includes('Explore garage before &amp; after ideas'));
 assert.equal(sitemap.split(`<loc>${galleryCanonical}</loc>`).length-1,1);
});
