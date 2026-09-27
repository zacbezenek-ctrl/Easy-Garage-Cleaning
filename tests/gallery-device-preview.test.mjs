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
});

// gallery-preview-assets/gallery.js intentionally diverged from the internal copy in 2d4f5d5 (public
// showcase loading and inspiration framing). These checks cover the behavior that matters instead of
// byte identity: it runs without a backend, filters and counts cards, and only loads a validated,
// same-origin, credential-free showcase manifest.
function fakeGalleryPage({publicPage=false,cards=[],manifest=null,fetchFails=false,withGallery=true}={}) {
 const made=[],fetches=[],prepended=[];
 const node=(tag='div')=>{const el={tagName:tag.toUpperCase(),dataset:{},hidden:false,textContent:'',className:'',children:[],attributes:{},listeners:{},style:{setProperty(){}},
  appendChild(child){this.children.push(child);return child;},setAttribute(name,value){this.attributes[name]=String(value);},removeAttribute(name){delete this.attributes[name];},
  addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);},querySelectorAll:()=>[],querySelector:()=>null};made.push(el);return el;};
 const cardNodes=cards.map(search=>Object.assign(node('article'),{dataset:{search}}));
 const grid=Object.assign(node(),{
  querySelectorAll(selector){return selector==='.card'?[...prepended,...cardNodes]:[];},
  prepend(fragment){prepended.unshift(...fragment.children);},contains:()=>true,
 });
 const byId={gallery:withGallery?grid:null,search:Object.assign(node('input'),{value:''}),'search-label':Object.assign(node('label'),{hidden:true}),count:node('p'),empty:Object.assign(node('p'),{hidden:true}),viewer:null};
 const eyebrow=node('p'),description=Object.assign(node('meta'),{content:'original'});
 const document={title:'Original',getElementById:id=>byId[id]??null,createElement:node,createDocumentFragment:()=>node('fragment'),
  querySelector(selector){if(selector==='.public-hero')return publicPage?node('section'):null;if(selector==='.public-hero .eyebrow')return eyebrow;if(selector==='meta[name="description"]')return description;return null;},
  querySelectorAll:()=>[]};
 const fetch=async(url,options)=>{fetches.push({url,options});if(fetchFails)throw new Error('offline');return {ok:true,json:async()=>structuredClone(manifest)};};
 return {document,fetch,byId,grid,prepended,cardNodes,fetches,eyebrow,description,made};
}
async function runGallery(page) {
 const warnings=[];
 new Function('document','fetch','console',read('gallery-preview-assets/gallery.js').toString())(page.document,page.fetch,{warn:message=>warnings.push(message)});
 for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
 return warnings;
}
const showcaseItem=(id,extra={})=>({id,title:'Title '+id,caption:'Caption '+id,tags:'bikes shelves',kind:'design-concept',src:`/images/gallery-showcase/${id}.webp`,thumbnail:`/images/gallery-showcase/${id}-768.webp`,width:1448,height:1086,...extra});

test('gallery script is presentation-only: no analytics, backend calls, storage or internal assets',()=>{
 const source=read('gallery-preview-assets/gallery.js').toString();
 assert.doesNotMatch(source,/fbq|gtag|analytics|sendBeacon|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|\/api\/|\/employee|internal-gallery-assets/);
 assert.deepEqual([...source.matchAll(/fetch\(([^,)]+)/g)].map(match=>match[1]),["'/gallery-showcase.json'"]);
 assert.match(source,/credentials:'omit'/);
 assert.doesNotThrow(()=>new Function(source));
});

test('pages without the gallery grid are left untouched',async()=>{
 const page=fakeGalleryPage({withGallery:false,publicPage:true});
 assert.deepEqual(await runGallery(page),[]);
 assert.equal(page.fetches.length,0);assert.equal(page.document.title,'Original');assert.equal(page.byId['search-label'].hidden,true);
});

test('internal preview search filters cards and keeps an accurate transformation count',async()=>{
 const page=fakeGalleryPage({cards:['four bikes wall','workbench corner','bikes ceiling hoist']});
 await runGallery(page);
 assert.equal(page.fetches.length,0,'the internal preview never loads the public showcase');
 assert.equal(page.byId['search-label'].hidden,false);assert.equal(page.byId.count.textContent,'3 transformations');
 page.byId.search.value='  BIKES ';page.byId.search.listeners.input[0]();
 assert.deepEqual(page.cardNodes.map(card=>card.hidden),[false,true,false]);assert.equal(page.byId.count.textContent,'2 transformations');assert.equal(page.byId.empty.hidden,true);
 page.byId.search.value='workbench';page.byId.search.listeners.input[0]();assert.equal(page.byId.count.textContent,'1 transformation');
 page.byId.search.value='kayak';page.byId.search.listeners.input[0]();assert.equal(page.byId.count.textContent,'0 transformations');assert.equal(page.byId.empty.hidden,false);
});

test('public page loads only a valid, deduplicated, capped showcase manifest ahead of existing cards',async()=>{
 const images=[showcaseItem('first'),showcaseItem('first'),showcaseItem('hotlinked',{src:'https://retailer.example/x.webp'}),showcaseItem('wrong-kind',{kind:'customer-project'}),showcaseItem('wrong-size',{width:800}),
  ...Array.from({length:30},(_,index)=>showcaseItem('extra-'+index))];
 const page=fakeGalleryPage({publicPage:true,cards:['existing concept'],manifest:{schemaVersion:1,release:'r-test',images}});
 assert.deepEqual(await runGallery(page),[]);
 assert.equal(page.fetches.length,1);assert.equal(page.fetches[0].url,'/gallery-showcase.json');assert.equal(page.fetches[0].options.credentials,'omit');
 assert.equal(page.prepended.length,24);assert.equal(page.prepended[0].dataset.showcaseId,'first');
 assert.equal(page.prepended.filter(card=>card.dataset.showcaseId==='first').length,1);
 assert(!page.prepended.some(card=>['hotlinked','wrong-kind','wrong-size'].includes(card.dataset.showcaseId)));
 assert.equal(page.grid.dataset.showcaseRelease,'r-test');assert.equal(page.byId.count.textContent,'25 designs');
 assert.equal(page.document.title,'Garage Design Inspiration | Easy Garage Cleaning');assert.equal(page.eyebrow.textContent,'Garage design inspiration');
 assert.notEqual(page.description.content,'original');
});

test('public page keeps the existing gallery when the showcase is unavailable or malformed',async()=>{
 const offline=fakeGalleryPage({publicPage:true,cards:['existing concept'],fetchFails:true});
 assert.equal((await runGallery(offline)).length,1);assert.equal(offline.prepended.length,0);assert.equal(offline.byId.count.textContent,'1 design');
 const future=fakeGalleryPage({publicPage:true,cards:['existing concept'],manifest:{schemaVersion:2,images:[showcaseItem('a')]}});
 assert.deepEqual(await runGallery(future),[]);assert.equal(future.prepended.length,0);assert.equal(future.grid.dataset.showcaseRelease,undefined);
 const empty=fakeGalleryPage({publicPage:true,cards:['existing concept'],manifest:{schemaVersion:1,images:[showcaseItem('x',{src:'/elsewhere/x.webp'})]}});
 await runGallery(empty);assert.equal(empty.prepended.length,0);
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
