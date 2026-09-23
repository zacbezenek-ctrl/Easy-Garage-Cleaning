import { galleryPreviewPairs } from './_lib/gallery-preview-data.js';

// Public device-test copy of fictional fixtures, not a customer-results page.
// Original staff routes, credentials, source provenance and review states are untouched.
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const publicGalleryAsset = path => path.replace(/^\/internal-gallery-assets\//, '/gallery-preview-assets/');
export const publicGalleryVersion = '20260923-public-device-v1';

export function renderPublicGalleryPreview() {
 const cards = galleryPreviewPairs.map((pair, index) => {
  const title = escape(pair.title), before = escape(publicGalleryAsset(pair.before)), after = escape(publicGalleryAsset(pair.after));
  return `<article class="card" data-search="${escape(pair.title.toLowerCase())}">
  <div class="card-heading"><span>${String(index + 1).padStart(2,'0')}</span><h2>${title}</h2><button type="button" data-expand aria-label="Enlarge ${title}">Expand ↗</button></div>
  <div class="comparison" style="--position:50%">
   <div class="image-stage"><img class="after-image" src="${after}" alt="AI-generated after concept: ${title}" width="1600" height="1200" loading="${index === 0 ? 'eager' : 'lazy'}" decoding="async"><img class="before-image" src="${before}" alt="AI-generated before concept: ${title}" width="1600" height="1200" loading="${index === 0 ? 'eager' : 'lazy'}" decoding="async"><span class="image-label label-before">Before</span><span class="image-label label-after">After</span><span class="divider" aria-hidden="true"><span>↔</span></span></div>
   <div class="controls" hidden><label>Slide to compare<input type="range" min="0" max="100" value="50" aria-label="Before image percentage for ${title}" aria-valuetext="50 percent before"></label><div class="view-buttons"><button type="button" data-position="100">Before</button><button type="button" data-position="50">Compare</button><button type="button" data-position="0">After</button></div></div>
  </div>
  <noscript><p><a href="${before}">Open before</a> · <a href="${after}">Open after</a></p></noscript>
 </article>`;
 }).join('\n');
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive,noimageindex"><meta name="referrer" content="no-referrer"><meta name="egc-gallery-preview-version" content="${publicGalleryVersion}"><title>Before &amp; After Concepts | Easy Garage Cleaning</title><meta name="description" content="Public device-test gallery of AI-generated garage organization concepts, not completed customer projects."><meta property="og:title" content="EGC Before &amp; After Concept Gallery"><meta property="og:description" content="AI-generated design concepts for testing the gallery on different devices. Not completed customer projects."><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/gallery-preview-assets/gallery.css?v=${publicGalleryVersion}"><link rel="stylesheet" href="/gallery-preview-assets/public.css?v=${publicGalleryVersion}"><script defer src="/gallery-preview-assets/gallery.js?v=${publicGalleryVersion}"></script></head><body><a class="skip" href="#gallery">Skip to gallery</a><header class="shell nav"><a class="brand" href="/">Easy Garage Cleaning</a><a href="/">Back to website ↗</a></header><main class="shell"><section class="hero"><p class="eyebrow">Design test gallery</p><h1>Before.<br><em>After.</em></h1><p class="intro">More room for what matters.</p><p class="concept-note">AI-generated design concepts. Not completed customer projects.</p></section><div class="toolbar"><p id="count" role="status" aria-live="polite">${galleryPreviewPairs.length} transformations</p><label hidden id="search-label">Find a space<input id="search" type="search" placeholder="Bikes, workbench, storage…" autocomplete="off"></label></div><div id="gallery" class="grid">${cards}</div><p id="empty" hidden>No matching spaces. Try another search.</p></main><footer class="shell"><p>Easy Garage Cleaning</p><a href="/">Back to website</a></footer><dialog id="viewer" aria-labelledby="viewer-title"><header><h2 id="viewer-title">Before &amp; after</h2><button type="button" id="close-viewer">Close ×</button></header><p class="concept-note">AI-generated concept, not a completed customer project.</p><div id="viewer-body"></div></dialog></body></html>`;
}

export function onRequest({ request }) {
 const headers = {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow, noarchive, noimageindex','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
 if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed', {status:405, headers:{...headers,Allow:'GET, HEAD'}});
 return new Response(request.method === 'HEAD' ? null : renderPublicGalleryPreview(), {status:200,headers});
}
