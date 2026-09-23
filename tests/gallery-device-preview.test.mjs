import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {onRequest,renderPublicGalleryPreview,publicGalleryAsset,publicGalleryVersion} from '../functions/before-after-preview.js';
import {onRequest as assetRequest} from '../functions/gallery-preview-assets/_middleware.js';
import {galleryPreviewPairs,galleryPreviewProvenance} from '../functions/_lib/gallery-preview-data.js';
const root = new URL('../',import.meta.url);
const read = path => readFileSync(new URL(path,root));
const request = (path='/before-after-preview',method='GET') => new Request('https://easygaragecleaning.com'+path,{method});

test('anonymous GET and HEAD open the public test, without sessions or cookies',async()=>{
 const response=onRequest({request:request()});assert.equal(response.status,200);assert.match(await response.text(),new RegExp(publicGalleryVersion));
 assert.equal(response.headers.get('Cache-Control'),'no-store');assert.match(response.headers.get('X-Robots-Tag'),/noindex/);assert.equal(response.headers.get('Set-Cookie'),null);
 const head=onRequest({request:request('/before-after-preview','HEAD')});assert.equal(head.status,200);assert.equal(await head.text(),'');
 const write=onRequest({request:request('/before-after-preview','POST')});assert.equal(write.status,405);assert.equal(write.headers.get('Allow'),'GET, HEAD');
});

test('24 complete concepts and a compact page/modal origin label, without customer-result claims',()=>{
 const html=renderPublicGalleryPreview();assert.equal((html.match(/class="card" /g)||[]).length,24);
 assert.equal((html.match(/class="before-image"/g)||[]).length,24);assert.equal((html.match(/class="after-image"/g)||[]).length,24);
 assert.match(html,/AI-generated design concepts\. Not completed customer projects\./);assert.match(html,/AI-generated concept, not a completed customer project\./);
 assert.equal((html.match(/alt="AI-generated/g)||[]).length,48);
 assert.doesNotMatch(html,/\/internal-gallery-assets\/|\/employee|analytics-loader|fb-capture|<form|application\/ld\+json|customer-approved/i);
 assert.match(html,/noindex,nofollow,noarchive,noimageindex/);assert.match(html,/<noscript>/);
});

test('the 48 selected raster assets are exact copies; rejected versions are absent',()=>{
 const expected=galleryPreviewPairs.flatMap(pair=>[pair.before,pair.after]);
 const files=readdirSync(new URL('gallery-preview-assets/images/',root));assert.equal(files.length,48);
 for(const path of expected){assert.deepEqual(read(publicGalleryAsset(path).slice(1)),read(path.slice(1)));}
 assert(!files.some(path=>/293cd4db|7ad9e383/.test(path)));
 assert.deepEqual(read('gallery-preview-assets/gallery.css'),read('internal-gallery-assets/gallery.css'));
 assert.deepEqual(read('gallery-preview-assets/gallery.js'),read('internal-gallery-assets/gallery.js'));
});

test('public assets require no session but enforce exact paths, methods and cache headers',async()=>{
 let called=0;const next=async()=>{called++;return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/webp'}});};
 const path=publicGalleryAsset(galleryPreviewPairs[0].after);
 const response=await assetRequest({request:request(path),next});assert.equal(response.status,200);assert.equal(called,1);assert.equal(response.headers.get('Content-Type'),'image/webp');assert.match(response.headers.get('X-Robots-Tag'),/noimageindex/);assert.equal(response.headers.get('Cache-Control'),'no-store');
 const head=await assetRequest({request:request(path,'HEAD'),next});assert.equal(await head.text(),'');
 for(const path of ['/gallery-preview-assets/unknown.json','/gallery-preview-assets/images/03-four-bikes-after-293cd4db.webp','/gallery-preview-assets/images/%2e%2e%2finternal.json']){const r=await assetRequest({request:request(path),next:()=>assert.fail('must not reach assets')});assert.equal(r.status,404);}
 assert.equal((await assetRequest({request:request(path,'POST'),next:()=>assert.fail('no write')})).status,405);
});

test('original source provenance and pending visual reviews are not changed',()=>{
 assert.equal(galleryPreviewProvenance.type,'ai-generated-concept');assert.equal(galleryPreviewProvenance.customerProject,false);
 assert.equal(galleryPreviewPairs.filter(pair=>pair.reviewStatus==='approved').length,17);
 assert.equal(galleryPreviewPairs.filter(pair=>pair.reviewStatus==='pending').length,7);
});

test('public test is not added to marketing navigation or sitemap; staff authentication remains',()=>{
 for(const path of ['index.html','sitemap.xml','site-enhancements.js']) assert.doesNotMatch(read(path).toString(),/before-after-preview|gallery-preview-assets/);
 assert.match(read('functions/internal/before-after.js').toString(),/galleryPreviewAccess/);
 assert.match(read('functions/_lib/gallery-preview-auth.js').toString(),/getHubSession/);
});
