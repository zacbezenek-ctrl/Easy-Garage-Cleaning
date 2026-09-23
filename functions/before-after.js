import { gallerySimplePairs as pairs, gallerySimpleVersion } from './_lib/gallery-simple-data.js';

// Public presentation only. Internal previews and customer records are unchanged.
export const galleryRelease = gallerySimpleVersion;
export const galleryCanonical = 'https://easygaragecleaning.com/before-after';
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function renderPublicGallery() {
 const cards = pairs.map((pair, index) => {
  const title = escape(pair.title);
  const image = state => `<img class="${state}-image" src="${escape(pair[state])}" srcset="${escape(pair[state+'Thumbnail'])} 768w, ${escape(pair[state])} 1600w" sizes="(max-width:760px) calc(100vw - 28px), (max-width:1308px) calc((100vw - 74px)/2), 617px" alt="${state==='before'?'Before':'After'} organization example: ${title}" width="1600" height="1200" loading="${index===0?'eager':'lazy'}" decoding="async"${index===0&&state==='after'?' fetchpriority="high"':''}>`;
  return `<article class="card" data-search="${escape((pair.title+' '+pair.keywords+' '+pair.caption).toLowerCase())}" data-scene="${escape(pair.id)}">
  <div class="card-heading"><span>${String(index+1).padStart(2,'0')}</span><h2>${title}</h2><button type="button" data-expand hidden aria-label="Enlarge ${title}">Expand ↗</button></div>
  <div class="comparison" style="--position:50%">
   <div class="image-stage">${image('after')}${image('before')}<span class="image-label label-before">Before</span><span class="image-label label-after">After</span><span class="divider" aria-hidden="true"><span>↔</span></span></div>
   <div class="controls" hidden><label>Slide to compare<input type="range" min="0" max="100" value="50" aria-label="Before image percentage for ${title}" aria-valuetext="50 percent before"></label><div class="view-buttons"><button type="button" data-position="100">Before</button><button type="button" data-position="50">Compare</button><button type="button" data-position="0">After</button></div></div>
  </div><p class="simple-caption">${escape(pair.caption)}</p><noscript><p><a href="${escape(pair.before)}">Open before</a> · <a href="${escape(pair.after)}">Open after</a></p></noscript>
 </article>`;
 }).join('\n');
 const shareImage = `https://easygaragecleaning.com${pairs[0].after}`;
 const description = 'Before-and-after garage organization examples. Everyday clutter, simple shelving, black-and-yellow bins, and the same concrete floor. Plan your garage cleanout.';
 const schema = JSON.stringify({'@context':'https://schema.org','@type':'CollectionPage',name:'Garage Before & After Ideas',url:galleryCanonical,description:'Illustrative garage organization layouts for planning your space, not a portfolio of completed customer projects.',isPartOf:{'@id':'https://easygaragecleaning.com/#website'}}).replace(/</g,'\\u003c');
 return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="index,follow"><meta name="referrer" content="strict-origin-when-cross-origin"><meta name="theme-color" content="#101e31"><meta name="egc-gallery-release" content="${galleryRelease}">
<title>Garage Before &amp; After | Easy Garage Cleaning</title><meta name="description" content="${description}"><link rel="canonical" href="${galleryCanonical}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Easy Garage Cleaning"><meta property="og:title" content="Clutter out. Space back."><meta property="og:description" content="Simple garage organization ideas. Shelves, black-and-yellow bins, and room to use your garage again."><meta property="og:url" content="${galleryCanonical}"><meta property="og:image" content="${shareImage}"><meta property="og:image:alt" content="Garage organization example with simple shelving and an original concrete floor"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/gallery-preview-assets/gallery.css?v=${galleryRelease}"><link rel="stylesheet" href="/gallery-live.css?v=${galleryRelease}"><link rel="stylesheet" href="/gallery-simple.css?v=${galleryRelease}"><script defer src="/gallery-simple.js?v=${galleryRelease}"></script><script type="application/ld+json">${schema}</script></head>
<body><a class="skip" href="#gallery">Skip to gallery</a><header class="shell nav public-nav"><a class="brand" href="/">Easy Garage Cleaning</a><nav class="public-links" aria-label="Main navigation"><a href="/garage-turnaround-fort-collins-co">Our services</a><a href="/before-after" aria-current="page">Before &amp; After</a><a href="/projects/">Project stories</a></nav><a class="gallery-cta" href="/book" data-cta="gallery-nav">Free walkthrough ↗</a></header>
<main class="shell"><section class="hero public-hero"><div><p class="eyebrow">Garage cleanouts + organization</p><h1>Before.<br><em>After.</em></h1></div><div class="hero-copy"><p class="intro">Clutter out. Space back.</p><p>Clear out what you don't need. Put what stays on sturdy shelves. Black-and-yellow bins, a cleaner floor, and room to use your garage again.</p><a class="gallery-cta" href="/book" data-cta="gallery-hero">Get my free garage plan ↗</a><p class="concept-note">Example layouts for planning your space.</p></div></section>
<div class="simple-details" aria-label="Organization, not a remodel"><span>Everyday garages</span><span>Practical storage</span><span>Original concrete floors</span></div>
<div class="toolbar"><p id="count" role="status" aria-live="polite">${pairs.length} before &amp; after examples</p><label hidden id="search-label">Find a space<input id="search" type="search" placeholder="Bikes, tools, storage…" autocomplete="off"></label></div><div id="gallery" class="grid">${cards}</div><p id="empty" hidden>No matching spaces. Try another search.</p>
<section class="gallery-next" aria-labelledby="gallery-next-title"><div><p class="eyebrow">Fort Collins + Northern Colorado</p><h2 id="gallery-next-title">Let's make room in your garage.</h2><p>We'll walk through your space, figure out what stays and what goes, and put together a plan that fits. No need to start with a remodel.</p></div><div class="gallery-next-actions"><a class="gallery-cta" href="/book" data-cta="gallery-bottom">Request a free walkthrough ↗</a><a href="tel:+19709991818">Call (970) 999-1818</a><a href="/projects/">View customer-approved project stories</a></div></section></main>
<footer class="shell public-footer"><a class="brand" href="/">Easy Garage Cleaning</a><nav aria-label="Footer"><a href="/book">Book a walkthrough</a><a href="/privacy-policy">Privacy</a><a href="/terms-of-service">Terms</a></nav><p>© 2026 Easy Garage Cleaning · Fort Collins, Colorado</p></footer>
<dialog id="viewer" aria-labelledby="viewer-title"><header><h2 id="viewer-title">Before &amp; after</h2><button type="button" id="close-viewer">Close ×</button></header><p class="concept-note">Example layout for planning your space.</p><div id="viewer-body"></div></dialog></body></html>`;
}

export function onRequest({ request }) {
 const headers = {'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=0, must-revalidate','X-Robots-Tag':'index, follow','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'};
 if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405,headers:{...headers,'Cache-Control':'no-store',Allow:'GET, HEAD','X-Robots-Tag':'noindex'}});
 return new Response(request.method==='HEAD'?null:renderPublicGallery(),{status:200,headers});
}
