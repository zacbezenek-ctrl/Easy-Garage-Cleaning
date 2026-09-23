import { galleryPreviewPairs } from './_lib/gallery-preview-data.js';
import { publicGalleryAsset } from './before-after-preview.js';

// Public inspiration gallery. No authentication, customer records or paid-generation calls.
// Reuse the existing fictional pairs without changing their original provenance/review records.
export const galleryRelease = '20260923-public-gallery-v1';
export const galleryCanonical = 'https://easygaragecleaning.com/before-after';
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function renderPublicGallery() {
 const cards = galleryPreviewPairs.map((pair, index) => {
  const title = escape(pair.title), before = escape(publicGalleryAsset(pair.before)), after = escape(publicGalleryAsset(pair.after));
  return `<article class="card" data-search="${escape(pair.title.toLowerCase())}" data-scene="${escape(pair.id)}">
  <div class="card-heading"><span>${String(index+1).padStart(2,'0')}</span><h2>${title}</h2><button type="button" data-expand aria-label="Enlarge ${title}">Expand ↗</button></div>
  <div class="comparison" style="--position:50%">
   <div class="image-stage"><img class="after-image" src="${after}" alt="AI-generated after concept: ${title}" width="1600" height="1200" loading="${index===0?'eager':'lazy'}" decoding="async"${index===0?' fetchpriority="high"':''}><img class="before-image" src="${before}" alt="AI-generated before concept: ${title}" width="1600" height="1200" loading="${index===0?'eager':'lazy'}" decoding="async"><span class="image-label label-before">Before</span><span class="image-label label-after">After</span><span class="divider" aria-hidden="true"><span>↔</span></span></div>
   <div class="controls" hidden><label>Slide to compare<input type="range" min="0" max="100" value="50" aria-label="Before image percentage for ${title}" aria-valuetext="50 percent before"></label><div class="view-buttons"><button type="button" data-position="100">Before</button><button type="button" data-position="50">Compare</button><button type="button" data-position="0">After</button></div></div>
  </div><noscript><p><a href="${before}">Open before</a> · <a href="${after}">Open after</a></p></noscript>
 </article>`;
 }).join('\n');
 const shareImage = `https://easygaragecleaning.com${publicGalleryAsset(galleryPreviewPairs[0].after)}`;
 const schema = JSON.stringify({'@context':'https://schema.org','@type':'CollectionPage',name:'Garage Before & After Ideas',url:galleryCanonical,description:'AI-generated garage cleanout and organization concepts. Not completed customer projects.',isPartOf:{'@id':'https://easygaragecleaning.com/#website'}}).replace(/</g,'\\u003c');
 return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="index,follow"><meta name="referrer" content="strict-origin-when-cross-origin"><meta name="theme-color" content="#101e31"><meta name="egc-gallery-release" content="${galleryRelease}">
<title>Garage Before &amp; After Ideas | Easy Garage Cleaning</title><meta name="description" content="Explore 24 garage cleanout and organization concepts with interactive before-and-after sliders. Plan your own garage turnaround in Northern Colorado."><link rel="canonical" href="${galleryCanonical}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Easy Garage Cleaning"><meta property="og:title" content="Before. After. More room for what matters."><meta property="og:description" content="Explore garage organization ideas, then get a plan for your space. AI-generated design concepts, not completed customer projects."><meta property="og:url" content="${galleryCanonical}"><meta property="og:image" content="${shareImage}"><meta property="og:image:alt" content="AI-generated organized garage concept"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/gallery-preview-assets/gallery.css?v=${galleryRelease}"><link rel="stylesheet" href="/gallery-live.css?v=${galleryRelease}"><script defer src="/gallery-preview-assets/gallery.js?v=${galleryRelease}"></script><script type="application/ld+json">${schema}</script></head>
<body><a class="skip" href="#gallery">Skip to gallery</a><header class="shell nav public-nav"><a class="brand" href="/">Easy Garage Cleaning</a><nav class="public-links" aria-label="Main navigation"><a href="/garage-turnaround-fort-collins-co">Our services</a><a href="/before-after" aria-current="page">Before &amp; After</a><a href="/projects/">Project stories</a></nav><a class="gallery-cta" href="/book" data-cta="gallery-nav">Free walkthrough ↗</a></header>
<main class="shell"><section class="hero public-hero"><div><p class="eyebrow">Garage cleanouts + organization</p><h1>Before.<br><em>After.</em></h1></div><div class="hero-copy"><p class="intro">More room for what matters.</p><p>Room to park. A place for your tools. Storage that makes sense. Explore a few ways to get your garage back.</p><a class="gallery-cta" href="/book" data-cta="gallery-hero">Get my free garage plan ↗</a><p class="concept-note">AI-generated design concepts. Not completed customer projects.</p></div></section>
<div class="toolbar"><p id="count" role="status" aria-live="polite">${galleryPreviewPairs.length} transformations</p><label hidden id="search-label">Find a space<input id="search" type="search" placeholder="Bikes, workbench, storage…" autocomplete="off"></label></div><div id="gallery" class="grid">${cards}</div><p id="empty" hidden>No matching spaces. Try another search.</p>
<section class="gallery-next" aria-labelledby="gallery-next-title"><div><p class="eyebrow">Fort Collins + Northern Colorado</p><h2 id="gallery-next-title">Let's plan your garage.</h2><p>We will walk through your space, talk about what stays and what goes, and agree on the scope before work begins.</p></div><div class="gallery-next-actions"><a class="gallery-cta" href="/book" data-cta="gallery-bottom">Request a free walkthrough ↗</a><a href="tel:+19709991818">Call (970) 999-1818</a><a href="/projects/">View customer-approved project stories</a></div></section></main>
<footer class="shell public-footer"><a class="brand" href="/">Easy Garage Cleaning</a><nav aria-label="Footer"><a href="/book">Book a walkthrough</a><a href="/privacy-policy">Privacy</a><a href="/terms-of-service">Terms</a></nav><p>© 2026 Easy Garage Cleaning · Fort Collins, Colorado</p></footer>
<dialog id="viewer" aria-labelledby="viewer-title"><header><h2 id="viewer-title">Before &amp; after</h2><button type="button" id="close-viewer">Close ×</button></header><p class="concept-note">AI-generated design concept, not a completed customer project.</p><div id="viewer-body"></div></dialog></body></html>`;
}

export function onRequest({ request }) {
 const headers = {'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=0, must-revalidate','X-Robots-Tag':'index, follow','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'};
 if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405,headers:{...headers,'Cache-Control':'no-store',Allow:'GET, HEAD','X-Robots-Tag':'noindex'}});
 return new Response(request.method==='HEAD'?null:renderPublicGallery(),{status:200,headers});
}
