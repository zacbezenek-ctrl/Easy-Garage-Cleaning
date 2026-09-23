import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createHubSessionToken } from '../functions/_lib/hub-session.js';
import { galleryPreviewAccess } from '../functions/_lib/gallery-preview-auth.js';
import { galleryPreviewPairs, galleryPreviewAssetPaths, galleryPreviewProvenance } from '../functions/_lib/gallery-preview-data.js';
import { renderGalleryPreview } from '../functions/_lib/gallery-preview-view.js';
import { onRequest as page } from '../functions/internal/before-after.js';
import { onRequest as assets } from '../functions/internal-gallery-assets/[[path]].js';
globalThis.crypto ||= webcrypto;
// Synthetic fixtures only, never a deployed account or credential.
const env={HUB_SESSION_SECRET:'isolated-preview-unit-test-secret-not-for-deployment',HUB_AUTH_USERS_JSON:JSON.stringify({testowner:{passwordHash:'0'.repeat(64),role:'owner'},testmanager:{passwordHash:'0'.repeat(64),role:'manager'},testcrew:{passwordHash:'0'.repeat(64),role:'crew'}})};
async function req(user='testowner',path='/internal/before-after',options={}){const token=await createHubSessionToken(env,user);return new Request('https://easygaragecleaning.com'+path,{...options,headers:{Cookie:'egc_hub_session='+token,...options.headers}});}

test('24 complete pairs, exact existing assets, original origin and review states retained',()=>{
 assert.equal(galleryPreviewPairs.length,24);assert.equal(new Set(galleryPreviewPairs.map(p=>p.id)).size,24);
 assert.equal(galleryPreviewPairs.filter(p=>p.reviewStatus==='approved').length,17);
 assert.equal(galleryPreviewPairs.filter(p=>p.reviewStatus==='pending').length,7);
 assert.equal(galleryPreviewProvenance.type,'ai-generated-concept');assert.equal(galleryPreviewProvenance.customerProject,false);
 for(const p of galleryPreviewPairs)for(const path of [p.before,p.after]){assert(galleryPreviewAssetPaths.has(path));assert(existsSync(new URL('..'+path,import.meta.url)),path);}
});
test('anonymous page and direct images are denied before any content',async()=>{
 const request=new Request('https://easygaragecleaning.com/internal/before-after?preview=1');
 assert.equal((await page({request,env})).status,401);
 let calls=0;const r=await assets({request:new Request('https://easygaragecleaning.com'+galleryPreviewPairs[0].after),env,next:()=>{calls++;return new Response('should not be seen');}});
 assert.equal(r.status,401);assert.equal(calls,0);assert(!(await r.text()).includes('should not be seen'));
});
test('owner and manager may render; crew and unsigned role headers may not',async()=>{
 for(const user of ['testowner','testmanager'])assert.equal((await page({request:await req(user),env})).status,200);
 assert.equal((await page({request:await req('testcrew'),env})).status,403);
 assert.equal((await page({request:new Request('https://easygaragecleaning.com/internal/before-after',{headers:{'x-role':'owner','x-email':'zac.bezenek@easygaragecleaning.com'}}),env})).status,401);
});
test('tampered and expired signed cookies are denied',async()=>{
 const token=await createHubSessionToken(env,'testowner');
 for(const value of [token.slice(0,-3)+'XXX',await createHubSessionToken(env,'testowner',Date.now()-13*60*60*1000)]){
  const r=await page({env,request:new Request('https://easygaragecleaning.com/internal/before-after',{headers:{Cookie:'egc_hub_session='+value}})});assert.equal(r.status,401);
 }
});
test('missing and malformed auth configuration fail closed',async()=>{
 const request=await req();assert.notEqual((await page({request,env:{}})).status,200);
 assert.notEqual((await page({request,env:{...env,HUB_AUTH_USERS_JSON:'not JSON'}})).status,200);
});
test('read-only methods, private caching and HEAD behavior',async()=>{
 assert.equal((await galleryPreviewAccess(await req('testowner','/internal/before-after',{method:'POST'}),env)).status,405);
 const r=await page({env,request:await req()});assert.match(r.headers.get('Cache-Control'),/no-store/);assert.equal(r.headers.get('Vary'),'Cookie');assert.match(r.headers.get('X-Robots-Tag'),/noindex/);
 const head=await page({env,request:await req('testowner','/internal/before-after',{method:'HEAD'})});assert.equal(head.status,200);assert.equal(await head.text(),'');
});
test('asset allowlist denies traversal and obsolete rejected outputs',async()=>{
 for(const p of ['/internal-gallery-assets/nope.webp','/internal-gallery-assets/images/03-four-bikes-after-293cd4db.webp','/internal-gallery-assets/images/%2e%2e%2fdocs/private.json']){
  let calls=0;const r=await assets({request:await req('testowner',p),env,next:()=>{calls++;return new Response('bad');}});assert.equal(r.status,404);assert.equal(calls,0);
 }
 const r=await assets({request:await req('testowner',galleryPreviewPairs[0].after),env,next:async()=>new Response('asset bytes',{headers:{'Content-Type':'image/webp','Cache-Control':'public,max-age=31536000'}})});
 assert.equal(r.status,200);assert.equal(await r.text(),'asset bytes');assert.match(r.headers.get('Cache-Control'),/no-store/);
});
test('internal view has plain labels, no visible disclosure, analytics, public CTAs or forged customer claims',()=>{
 const html=renderGalleryPreview();assert.equal((html.match(/class="card"/g)||[]).length,24);assert.equal((html.match(/<img /g)||[]).length,48);
 assert(!/AI-generated|not a customer|simulated|disclaimer|concept/i.test(html));assert(!/analytics-loader|fb-capture|\/book|application\/ld\+json/.test(html));
 assert(html.includes('noindex,nofollow'));assert(html.includes('>Before<'));assert(html.includes('>After<'));
 const js=readFileSync(new URL('../internal-gallery-assets/gallery.js',import.meta.url),'utf8');assert(!/fetch\(|sendBeacon|fbq\(|gtag\(/.test(js));
});
