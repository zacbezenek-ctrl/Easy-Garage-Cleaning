import { queryPublishedCaseStudies } from '../_lib/case-studies.js';

function esc(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function imageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.toString() : '';
  } catch { return ''; }
}

export async function onRequestGet({ params, env, next }) {
  const slug = String(params.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 90);
  if (!slug) return next();
  let jobs = [];
  try { jobs = await queryPublishedCaseStudies(env, { slug, limit: 3 }); } catch { return next(); }
  const study = jobs[0]?.caseStudy;
  if (!study) return next();
  const title = `${study.title} | Easy Garage Cleaning`;
  const description = String(study.description || `${study.serviceType} case study in ${study.city}.`).slice(0, 160);
  const canonical = `https://easygaragecleaning.com/projects/${encodeURIComponent(study.slug)}`;
  const before = imageUrl(study.beforePhotoUrl);
  const after = imageUrl(study.afterPhotoUrl);
  const photos = before || after ? `<section class="photos">${before ? `<figure><img src="${esc(before)}" alt="Before ${esc(study.serviceType)} in ${esc(study.city)}" loading="lazy"><figcaption>Before</figcaption></figure>` : ''}${after ? `<figure><img src="${esc(after)}" alt="After ${esc(study.serviceType)} in ${esc(study.city)}" loading="lazy"><figcaption>After</figcaption></figure>` : ''}</section>` : '';
  const place = [study.neighborhood, study.city, 'Colorado'].filter(Boolean).join(', ');
  const schema = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Article', headline: study.title, description, datePublished: study.publishedAt, dateModified: study.updatedAt, author: { '@type': 'Organization', name: 'Easy Garage Cleaning' }, publisher: { '@type': 'Organization', name: 'Easy Garage Cleaning', url: 'https://easygaragecleaning.com/' }, about: { '@type': 'Service', name: study.serviceType, areaServed: place }, mainEntityOfPage: canonical });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(canonical)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:type" content="article"><meta property="og:url" content="${esc(canonical)}"><script type="application/ld+json">${schema.replace(/</g, '\\u003c')}</script><style>:root{--ink:#17221d;--green:#184d3a;--lime:#d9f26b;--cream:#f6f2e8}*{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--ink);font:17px/1.6 system-ui,-apple-system,sans-serif}nav,main,footer{max-width:1120px;margin:auto}nav{display:flex;align-items:center;justify-content:space-between;padding:22px 24px;font-weight:800}nav a{color:var(--ink);text-decoration:none}.brand{font-size:21px}.book{background:var(--ink);color:white;padding:11px 17px;border-radius:99px}.hero{padding:72px 24px 48px}.eyebrow{font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:var(--green);font-weight:900}h1{font-size:clamp(42px,7vw,78px);line-height:.96;letter-spacing:-.055em;max-width:900px;margin:14px 0 24px}h2{font-size:clamp(27px,4vw,42px);line-height:1.08;margin:0 0 16px}.lead{max-width:760px;font-size:21px}.facts{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.facts span{background:white;border:1px solid #d8d3c7;border-radius:99px;padding:8px 14px;font-weight:750}.photos{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;padding:0 24px 56px}.photos figure{margin:0;background:white;border-radius:20px;overflow:hidden;box-shadow:0 15px 40px #17221d18}.photos img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block}.photos figcaption{padding:12px 17px;font-weight:900}.story{padding:0 24px 70px;display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.story article{background:white;border:1px solid #ded8cb;border-radius:20px;padding:28px}.story b{color:var(--green);font-size:12px;letter-spacing:.14em}.cta{margin:0 24px 70px;background:var(--green);color:white;border-radius:28px;padding:clamp(30px,6vw,64px);display:flex;justify-content:space-between;align-items:center;gap:25px}.cta h2{max-width:610px}.cta a{background:var(--lime);color:var(--ink);padding:14px 20px;border-radius:99px;text-decoration:none;font-weight:900;white-space:nowrap}footer{padding:0 24px 40px;color:#526058}@media(max-width:750px){.story,.photos{grid-template-columns:1fr}.cta{align-items:flex-start;flex-direction:column}.hero{padding-top:48px}}</style></head><body><nav><a class="brand" href="/">EASY GARAGE CLEANING</a><a class="book" href="/book.html">Free walkthrough</a></nav><main><header class="hero"><p class="eyebrow">Real Northern Colorado project</p><h1>${esc(study.title)}</h1><p class="lead">${esc(description)}</p><div class="facts"><span>${esc(place)}</span><span>${esc(study.serviceType)}</span>${study.duration ? `<span>${esc(study.duration)}</span>` : ''}</div></header>${photos}<section class="story"><article><b>THE PROBLEM</b><h2>What needed to change</h2><p>${esc(study.customerProblem)}</p></article><article><b>THE WORK</b><h2>What the crew did</h2><p>${esc(study.workCompleted)}</p></article><article><b>THE RESULT</b><h2>How it finished</h2><p>${esc(study.result)}</p></article></section><section class="cta"><div><p class="eyebrow" style="color:var(--lime)">Your garage is next</p><h2>Start with a free on-site walkthrough and one exact price.</h2></div><a href="/book.html">Schedule walkthrough</a></section></main><footer>Easy Garage Cleaning · Fort Collins, Loveland, Windsor, and Northern Colorado</footer></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'index, follow' } });
}
