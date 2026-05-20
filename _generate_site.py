#!/usr/bin/env python3
"""Generate service, city, and project pages for Easy Garage Cleaning."""
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).parent
SITE = "https://easygaragecleaning.com"
PHONE = "+19709991818"
PHONE_DISPLAY = "(970) 999-1818"
FORM_KEY = "3c4fe752-ac1d-45b9-89dd-4275ea162d22"

SHARED_CSS = r"""
:root{--navy:#0a1628;--navy-soft:#14243d;--navy-line:rgba(255,255,255,0.08);--ink:#0a1628;--paper:#f5f1ea;--paper-warm:#ebe4d6;--white:#fff;--accent:#ff5b1f;--accent-deep:#d94208;--muted:#6b7280;--text:#334155;--muted-dark:rgba(245,241,234,0.6);--font-display:'Fraunces',Georgia,serif;--font-body:'Inter',system-ui,sans-serif;--font-mono:'JetBrains Mono',ui-monospace,monospace;--radius:2px;--maxw:1240px}
*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}body{font-family:var(--font-body);color:var(--ink);background:var(--paper);line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden}a{color:inherit;text-decoration:none}.wrap{max-width:var(--maxw);margin:0 auto;padding:0 18px}.mono{font-family:var(--font-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.btn-primary{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:var(--white);padding:14px 22px;font-weight:700;font-size:15px;border:none;border-radius:var(--radius);cursor:pointer;font-family:inherit;transition:background .2s,transform .2s;box-shadow:0 4px 20px -6px rgba(255,91,31,.5)}.btn-primary:hover{background:var(--accent-deep);transform:translateY(-1px)}.btn-secondary{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:transparent;color:var(--ink);padding:13px 22px;font-weight:600;font-size:15px;border:1px solid rgba(10,22,40,.2);border-radius:var(--radius)}.btn-secondary:hover{border-color:var(--accent);color:var(--accent-deep)}
.nav{position:sticky;top:0;z-index:50;background:rgba(245,241,234,.95);border-bottom:1px solid rgba(10,22,40,.08);backdrop-filter:blur(8px)}.nav-inner{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;max-width:var(--maxw);margin:0 auto}.logo{font-family:var(--font-display);font-weight:900;font-size:18px;letter-spacing:-.02em;display:flex;align-items:center;gap:6px;flex-shrink:0}.logo-mark{display:inline-block;width:9px;height:9px;background:var(--accent);border-radius:50%}.nav-links{display:none;gap:22px;list-style:none;font-size:13px;font-weight:500}.nav-links a:hover{color:var(--accent-deep)}.nav-right{display:none;align-items:center;gap:14px;flex-shrink:0}.nav-phone{font-weight:600;font-size:14px;white-space:nowrap}.nav-phone:hover{color:var(--accent)}.nav-cta{background:var(--accent);color:var(--white);padding:10px 16px;font-size:13px;font-weight:700;border-radius:var(--radius);white-space:nowrap}.nav-cta:hover{background:var(--accent-deep)}.nav-mobile-cta{display:block}@media(min-width:1024px){.nav-links{display:flex}.nav-right{display:flex}.nav-mobile-cta{display:none}}
section{padding:56px 0}@media(min-width:900px){section{padding:88px 0}}.section-head{margin-bottom:36px}.section-num{color:var(--accent-deep);margin-bottom:10px;display:block}h2.section-title{font-family:var(--font-display);font-weight:500;font-size:clamp(26px,5vw,44px);line-height:1.08;letter-spacing:-.025em;max-width:22ch}h2.section-title em{font-style:italic;font-weight:400;color:var(--accent-deep)}.section-sub{color:var(--text);font-size:16px;max-width:58ch;margin-top:12px}
.hero{padding:32px 0 48px}.hero-grid{display:grid;grid-template-columns:1fr;gap:32px;align-items:center}.hero-eyebrow{display:inline-flex;align-items:center;gap:10px;margin-bottom:14px;color:var(--accent-deep);font-size:11px}.hero-eyebrow::before{content:'';width:16px;height:1px;background:var(--accent-deep)}h1.hero-title{font-family:var(--font-display);font-weight:500;font-size:clamp(32px,7vw,54px);line-height:1.02;letter-spacing:-.03em;color:var(--ink);max-width:18ch}h1.hero-title em{font-style:italic;font-weight:400;color:var(--accent-deep)}.hero-sub{font-size:16px;color:var(--text);max-width:48ch;margin-top:14px;line-height:1.55}.hero-ctas{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}.hero-trust{display:flex;flex-wrap:wrap;gap:10px 16px;margin-top:24px;padding-top:20px;border-top:1px solid rgba(10,22,40,.1)}.trust-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--text)}.trust-badge::before{content:'';width:6px;height:6px;background:var(--accent);border-radius:50%;flex-shrink:0}.hero-ba{display:grid;grid-template-columns:1fr 1fr;gap:3px;background:var(--ink);padding:3px;border-radius:4px}.hero-ba-cell{aspect-ratio:4/5;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}.hero-ba-cell.before{background:repeating-linear-gradient(135deg,#2a3a4f 0 6px,#1a2a3f 6px 12px),#1a2a3f;color:rgba(255,255,255,.5)}.hero-ba-cell.after{background:radial-gradient(circle at 30% 20%,rgba(255,91,31,.12),transparent 60%),var(--paper-warm);color:var(--ink)}.hero-ba-label{position:absolute;top:10px;left:10px;font-family:var(--font-mono);font-size:9px;letter-spacing:.18em;background:rgba(0,0,0,.75);color:var(--paper);padding:4px 8px}.hero-ba-cell.after .hero-ba-label{background:var(--accent);color:var(--white)}.hero-ba-icon{font-family:var(--font-display);font-size:40px;font-style:italic;opacity:.4}@media(min-width:900px){.hero{padding:56px 0 72px}.hero-grid{grid-template-columns:1.05fr .95fr;gap:48px}.hero-sub{font-size:17px}}
.problem{background:var(--navy);color:var(--paper)}.problem h2.section-title{color:var(--paper)}.problem h2.section-title em{color:var(--accent)}.problem .section-sub{color:var(--muted-dark)}.problem-list{display:grid;grid-template-columns:1fr;gap:14px;margin-top:28px}@media(min-width:640px){.problem-list{grid-template-columns:repeat(2,1fr)}}.problem-item{display:flex;gap:14px;align-items:flex-start;padding:18px;background:var(--navy-soft);border:1px solid var(--navy-line);border-radius:4px}.problem-icon{width:32px;height:32px;background:rgba(255,91,31,.15);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}.problem-item h3{font-size:15px;font-weight:600;margin-bottom:4px}.problem-item p{font-size:14px;color:var(--muted-dark);line-height:1.5}
.process{background:var(--paper)}.steps{display:grid;grid-template-columns:1fr;gap:20px;margin-top:32px}@media(min-width:768px){.steps{grid-template-columns:repeat(3,1fr)}}.step{position:relative;padding:28px 24px;background:var(--white);border:1px solid rgba(10,22,40,.08);border-top:3px solid var(--accent);border-radius:4px}.step-num{font-family:var(--font-mono);font-size:11px;letter-spacing:.15em;color:var(--accent);margin-bottom:12px}.step h3{font-family:var(--font-display);font-size:22px;font-weight:500;margin-bottom:10px;letter-spacing:-.02em}.step p{font-size:14px;color:var(--text);line-height:1.55}
.items{background:var(--paper-warm)}.items-grid{display:grid;grid-template-columns:1fr;gap:20px;margin-top:32px}@media(min-width:768px){.items-grid{grid-template-columns:1fr 1fr}}.items-col{background:var(--white);border:1px solid rgba(10,22,40,.08);padding:24px;border-radius:4px}.items-col h3{font-family:var(--font-display);font-size:20px;margin-bottom:12px}.items-col ul{margin-left:18px;color:var(--text);font-size:14px;line-height:1.7}.items-col.yes{border-top:3px solid #22c55e}.items-col.no{border-top:3px solid var(--accent)}
.pricing{background:var(--ink);color:var(--paper)}.pricing h2.section-title{color:var(--paper)}.pricing h2.section-title em{color:var(--accent)}.pricing .section-sub{color:var(--muted-dark)}.pricing-grid{display:grid;grid-template-columns:1fr;gap:16px;margin-top:32px}@media(min-width:640px){.pricing-grid{grid-template-columns:repeat(2,1fr)}}@media(min-width:900px){.pricing-grid{grid-template-columns:repeat(4,1fr)}}.price-card{background:var(--navy-soft);border:1px solid var(--navy-line);padding:28px 22px;border-radius:4px}.price-card.featured{border-color:var(--accent);background:linear-gradient(160deg,#1a2e52,#0a1628)}.price-tier{font-family:var(--font-mono);font-size:10px;letter-spacing:.15em;color:var(--muted-dark);margin-bottom:10px}.price-range{font-family:var(--font-display);font-size:36px;font-weight:700;letter-spacing:-.03em;line-height:1;margin-bottom:8px;color:var(--accent)}.price-name{font-size:17px;font-weight:600;margin-bottom:8px}.price-desc{font-size:13px;color:var(--muted-dark);line-height:1.5}.pricing-disclaimer{margin-top:24px;padding:16px 18px;background:rgba(255,255,255,.04);border:1px solid var(--navy-line);border-radius:4px;font-size:13px;color:var(--muted-dark);line-height:1.6}
.local{background:var(--paper)}.local-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:28px;max-width:800px}@media(min-width:700px){.local-grid{grid-template-columns:repeat(4,1fr)}}.local-item{padding:14px 16px;background:var(--paper-warm);border:1px solid rgba(10,22,40,.08);font-size:14px;font-weight:500;border-radius:3px}.local-item strong{display:block;font-family:var(--font-display);font-size:17px;font-weight:600;margin-bottom:2px}.local-item span{color:var(--muted);font-size:11px;font-family:var(--font-mono);letter-spacing:.06em;text-transform:uppercase}.local-item a:hover strong{color:var(--accent-deep)}.neighborhoods{margin-top:24px;font-size:15px;color:var(--text);max-width:68ch;line-height:1.65}
.faq{background:var(--paper-warm)}.faq-list{max-width:860px;margin:32px auto 0}.faq-item{padding:20px 0;border-bottom:1px solid rgba(10,22,40,.12)}.faq-q{font-family:var(--font-display);font-size:clamp(18px,2.5vw,22px);font-weight:500;line-height:1.3;letter-spacing:-.015em;margin-bottom:10px;display:flex;gap:14px;align-items:flex-start}.faq-q-num{color:var(--accent-deep);font-family:var(--font-mono);font-size:12px;flex-shrink:0;padding-top:4px}.faq-a{color:var(--text);font-size:15px;line-height:1.65;max-width:68ch;padding-left:36px}
.gallery{background:var(--paper)}.gallery-grid{display:grid;grid-template-columns:1fr;gap:24px;margin-top:32px}@media(min-width:768px){.gallery-grid{grid-template-columns:repeat(3,1fr)}}.ba-pair{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:var(--ink);padding:2px}.ba-cell{aspect-ratio:1/1.05;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}.ba-cell.before{background:repeating-linear-gradient(135deg,#2a3a4f 0 6px,#1a2a3f 6px 12px),#1a2a3f;color:rgba(255,255,255,.6)}.ba-cell.after{background:radial-gradient(circle at 30% 20%,rgba(255,91,31,.15),transparent 60%),var(--paper-warm);color:var(--ink)}.ba-label{position:absolute;top:10px;left:10px;font-family:var(--font-mono);font-size:9px;letter-spacing:.18em;background:rgba(0,0,0,.7);color:var(--paper);padding:4px 8px}.ba-cell.after .ba-label{background:var(--accent);color:var(--white)}.ba-icon{font-family:var(--font-display);font-size:40px;font-style:italic;opacity:.45}.ba-caption{font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;color:var(--muted);margin-top:12px}.ba-caption strong{color:var(--ink);font-weight:500}
.related{background:var(--white)}.links{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.links a{background:var(--paper);border:1px solid rgba(10,22,40,.1);padding:10px 16px;font-size:14px;font-weight:500;border-radius:3px}.links a:hover{border-color:var(--accent);color:var(--accent-deep)}
.final-cta{background:var(--navy);color:var(--paper)}.final-cta h2.section-title{color:var(--paper)}.final-cta h2.section-title em{color:var(--accent)}.final-cta .section-sub{color:var(--muted-dark)}.cta-layout{display:grid;grid-template-columns:1fr;gap:40px;margin-top:32px;align-items:start}@media(min-width:900px){.cta-layout{grid-template-columns:1fr 1.1fr;gap:56px}}.cta-points{display:flex;flex-direction:column;gap:16px}.cta-point{display:flex;gap:12px;align-items:flex-start;font-size:15px;color:var(--muted-dark)}.cta-point::before{content:'✓';color:var(--accent);font-weight:700;flex-shrink:0}.quote-form{background:var(--navy-soft);border:1px solid var(--navy-line);padding:28px 24px;border-radius:4px}.quote-form h3{font-family:var(--font-display);font-size:22px;font-weight:500;margin-bottom:6px}.quote-form .form-note{font-size:13px;color:var(--muted-dark);margin-bottom:20px}.form-row{display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:14px}@media(min-width:540px){.form-row.two{grid-template-columns:1fr 1fr}}.field label{display:block;font-family:var(--font-mono);font-size:10px;letter-spacing:.15em;color:var(--muted-dark);margin-bottom:6px;text-transform:uppercase}.field input,.field select,.field textarea{width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:3px;color:var(--paper);font-family:inherit;font-size:16px;padding:12px 14px;outline:none}.field input::placeholder,.field textarea::placeholder{color:rgba(245,241,234,.35)}.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--accent)}.field select option{background:var(--navy-soft);color:var(--paper)}.field textarea{resize:vertical;min-height:80px}.form-submit{width:100%;margin-top:6px}
footer{background:var(--ink);color:var(--muted-dark);padding:36px 0;border-top:1px solid var(--navy-line);font-size:13px}.foot{display:flex;flex-direction:column;gap:14px;align-items:flex-start;justify-content:space-between}.foot .logo{color:var(--paper)}.foot-links{display:flex;flex-wrap:wrap;gap:12px 20px}.foot-links a:hover{color:var(--accent)}@media(min-width:700px){.foot{flex-direction:row;align-items:center}}
.mobile-sticky-cta{position:fixed;bottom:0;left:0;right:0;z-index:100;display:none;grid-template-columns:1fr 1fr 1fr;gap:6px;background:var(--ink);border-top:1px solid var(--navy-line);padding:8px 10px 12px}.mobile-cta-btn{padding:12px 6px;font-weight:700;font-size:12px;text-align:center;border-radius:3px;font-family:var(--font-body)}.mobile-cta-call,.mobile-cta-text{background:var(--navy-soft);color:var(--paper);border:1px solid var(--navy-line)}.mobile-cta-quote{background:var(--accent);color:var(--white)}@media(max-width:1023px){.mobile-sticky-cta{display:grid}body{padding-bottom:72px}}
.reveal{opacity:0;transform:translateY(16px);transition:opacity .7s ease,transform .7s ease}.reveal.visible{opacity:1;transform:translateY(0)}
"""

HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18102284288"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){{dataLayer.push(arguments);}}gtag('js',new Date());gtag('config','AW-18102284288');</script>
<!-- Google Analytics: replace AW-18102284288 with GA4 property ID when available -->
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{title}</title>
<meta name="description" content="{desc}" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="{canonical}" />
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
<meta name="theme-color" content="#ff5b1f" />
<meta property="og:type" content="website" />
<meta property="og:url" content="{canonical}" />
<meta property="og:title" content="{title}" />
<meta property="og:description" content="{desc}" />
<meta property="og:image" content="{SITE}/og-image.png" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,700;1,9..144,400&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
{schema}
<style>{css}</style>
</head>
<body>
"""

NAV = """
<nav class="nav" aria-label="Primary">
  <div class="nav-inner">
    <a href="/" class="logo" aria-label="Easy Garage Cleaning Home"><span class="logo-mark"></span>Easy Garage</a>
    <ul class="nav-links">
      <li><a href="/junk-removal-fort-collins-co.html">Junk Removal</a></li>
      <li><a href="/garage-cleanouts-fort-collins-co.html">Garage Cleanouts</a></li>
      <li><a href="/garage-cleaning-fort-collins-co.html">Garage Cleaning</a></li>
      <li><a href="/#service-area">Service Areas</a></li>
      <li><a href="/faq.html">FAQ</a></li>
    </ul>
    <div class="nav-right">
      <a href="tel:{phone}" class="nav-phone">{phone_display}</a>
      <a href="#quote" class="nav-cta">Get Free Quote</a>
    </div>
    <a href="#quote" class="nav-cta nav-mobile-cta" aria-label="Get Free Quote">Quote</a>
  </div>
</nav>
"""

FOOTER = """
<footer>
  <div class="wrap foot">
    <div class="logo"><span class="logo-mark"></span>Easy Garage Cleaning</div>
    <div class="foot-links">
      <a href="/junk-removal-fort-collins-co.html">Junk Removal</a>
      <a href="/garage-cleanouts-fort-collins-co.html">Garage Cleanouts</a>
      <a href="/faq.html">FAQ</a>
      <a href="/blog/">Blog</a>
      <a href="/privacy-policy.html">Privacy</a>
      <a href="tel:{phone}">{phone_display}</a>
    </div>
    <div>&copy; 2026 Easy Garage Cleaning LLC · Fort Collins, CO · Licensed &amp; Insured</div>
  </div>
</footer>
<div class="mobile-sticky-cta" aria-label="Quick contact">
  <a href="tel:{phone}" class="mobile-cta-btn mobile-cta-call">Call</a>
  <a href="sms:{phone}?body=Hi!%20I'd%20like%20a%20quote." class="mobile-cta-btn mobile-cta-text">Text</a>
  <a href="#quote" class="mobile-cta-btn mobile-cta-quote">Get Quote</a>
</div>
<script>
const io=new IntersectionObserver((entries)=>{{entries.forEach(e=>{{if(e.isIntersecting){{e.target.classList.add('visible');io.unobserve(e.target);}}}});}},{{threshold:0.08}});
document.querySelectorAll('.reveal').forEach(el=>io.observe(el));
</script>
</body></html>
"""

PRICING_HTML = """
<section class="pricing" id="pricing" aria-labelledby="pricing-heading">
  <div class="wrap">
    <div class="section-head reveal"><span class="mono section-num">Pricing</span>
      <h2 class="section-title" id="pricing-heading">Transparent ranges. <em>Locked quotes</em> before we start.</h2>
      <p class="section-sub">Text photos for an exact flat-rate quote. These ranges help you know what to expect — no hourly billing.</p>
    </div>
    <div class="pricing-grid reveal">
      <div class="price-card"><div class="price-tier">Pickup</div><div class="price-range">$99–150</div><div class="price-name">Single-item haul</div><p class="price-desc">One appliance, mattress, couch, or bulky item.</p></div>
      <div class="price-card"><div class="price-tier">Small load</div><div class="price-range">$250–400</div><div class="price-name">Partial cleanout</div><p class="price-desc">A corner of the garage or a few furniture pieces.</p></div>
      <div class="price-card featured"><div class="price-tier">Medium</div><div class="price-range">$400–650</div><div class="price-name">Standard garage</div><p class="price-desc">Most single-car or moderately full two-car garages.</p></div>
      <div class="price-card"><div class="price-tier">Large</div><div class="price-range">$650+</div><div class="price-name">Full garage / estate</div><p class="price-desc">Packed two-car garages or multi-space cleanouts.</p></div>
    </div>
    <p class="pricing-disclaimer reveal">All quotes are flat-rate and include labor, hauling, dump fees, and donation drop-offs. Final price depends on volume and access — text photos for your exact number. <a href="#quote" style="color:var(--accent);font-weight:600;">Get Free Quote →</a></p>
  </div>
</section>
"""

GALLERY_HTML = """
<section class="gallery" aria-labelledby="gallery-heading">
  <div class="wrap">
    <div class="section-head reveal"><span class="mono section-num">Results</span>
      <h2 class="section-title" id="gallery-heading">Before. <em>After.</em> Same day.</h2>
      <p class="section-sub">Placeholder photos — owner to swap with real job images.</p>
    </div>
    <div class="gallery-grid reveal">
      <div><div class="ba-pair"><div class="ba-cell before"><span class="ba-label">BEFORE</span><span class="ba-icon">B.</span></div><div class="ba-cell after"><span class="ba-label">AFTER</span><span class="ba-icon">A.</span></div></div><div class="ba-caption"><strong>{ba1}</strong> · Photo coming soon</div></div>
      <div><div class="ba-pair"><div class="ba-cell before"><span class="ba-label">BEFORE</span><span class="ba-icon">B.</span></div><div class="ba-cell after"><span class="ba-label">AFTER</span><span class="ba-icon">A.</span></div></div><div class="ba-caption"><strong>{ba2}</strong> · Photo coming soon</div></div>
      <div><div class="ba-pair"><div class="ba-cell before"><span class="ba-label">BEFORE</span><span class="ba-icon">B.</span></div><div class="ba-cell after"><span class="ba-label">AFTER</span><span class="ba-icon">A.</span></div></div><div class="ba-caption"><strong>{ba3}</strong> · Photo coming soon</div></div>
    </div>
  </div>
</section>
"""

QUOTE_FORM = """
<section class="final-cta" id="quote" aria-labelledby="cta-heading">
  <div class="wrap">
    <div class="section-head reveal"><span class="mono section-num">Ready?</span>
      <h2 class="section-title" id="cta-heading">{cta_title}</h2>
      <p class="section-sub">Get a free flat-rate quote in 5 minutes. Text photos or fill out the form — we'll call you right back.</p>
    </div>
    <div class="cta-layout reveal">
      <div class="cta-points">
        <div class="cta-point">5-minute quote response, Mon–Sat 7 AM–7 PM</div>
        <div class="cta-point">Same-day and next-day slots often available</div>
        <div class="cta-point">Flat-rate pricing — No-Surprise Quote Guarantee</div>
        <div class="cta-point">Donation receipts included on every job</div>
        <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:12px;">
          <a href="tel:{phone}" class="btn-primary">Call {phone_display}</a>
          <a href="sms:{phone}?body={sms_body}" class="btn-secondary" style="color:var(--paper);border-color:rgba(255,255,255,.25);">Text Photos</a>
        </div>
      </div>
      <div class="quote-form">
        <h3>Get Free Quote</h3>
        <p class="form-note">We'll call you within 5 minutes during business hours.</p>
        <form action="https://api.web3forms.com/submit" method="POST" enctype="multipart/form-data">
          <input type="hidden" name="access_key" value="{form_key}">
          <input type="hidden" name="subject" value="{form_subject}">
          <input type="hidden" name="from_name" value="Easy Garage Cleaning Website">
          <input type="hidden" name="redirect" value="{SITE}/thank-you.html">
          <input type="checkbox" name="botcheck" class="sr-only" tabindex="-1" autocomplete="off">
          <div class="form-row two">
            <div class="field"><label for="name">Name</label><input type="text" id="name" name="Name" required autocomplete="name" placeholder="Your name" /></div>
            <div class="field"><label for="phone">Phone</label><input type="tel" id="phone" name="Phone" required autocomplete="tel" inputmode="tel" placeholder="(970) 555-1234" /></div>
          </div>
          <div class="form-row"><div class="field"><label for="city">City</label><input type="text" id="city" name="City" required placeholder="{city_placeholder}" value="{city_default}" /></div></div>
          <div class="form-row"><div class="field"><label for="items">What to remove</label><textarea id="items" name="What to remove" required placeholder="{items_placeholder}"></textarea></div></div>
          <div class="form-row"><div class="field"><label for="photos">Upload photos (optional)</label><input type="file" id="photos" name="Photos" accept="image/*" multiple loading="lazy" /></div></div>
          <button type="submit" class="btn-primary form-submit">Get Free Quote →</button>
        </form>
      </div>
    </div>
  </div>
</section>
"""

PROCESS_HTML = """
<section class="process" aria-labelledby="process-heading">
  <div class="wrap">
    <div class="section-head reveal"><span class="mono section-num">How it works</span>
      <h2 class="section-title" id="process-heading">Three steps to a <em>clear space</em></h2>
      <p class="section-sub">No truck visit needed for most quotes. Text us photos and we'll tell you exactly what it costs.</p>
    </div>
    <div class="steps reveal">
      <div class="step"><div class="step-num">Step 01</div><h3>Send Photos</h3><p>Text photos to <a href="sms:{phone}">{phone_display}</a>, or upload them below. Wide shots work best.</p></div>
      <div class="step"><div class="step-num">Step 02</div><h3>Fast Quote</h3><p>We respond within 5 minutes with a flat-rate price. The number we quote is the number you pay.</p></div>
      <div class="step"><div class="step-num">Step 03</div><h3>We Handle It</h3><p>We arrive, haul everything, donate usable items, sweep, and hand you a donation receipt.</p></div>
    </div>
  </div>
</section>
"""


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def faq_schema(faqs):
    entities = [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faqs]
    return json.dumps({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": entities}, ensure_ascii=False)


def service_schema(name, desc, slug, stype):
    return json.dumps([
        {"@context": "https://schema.org", "@type": "LocalBusiness", "@id": f"{SITE}/#business", "name": "Easy Garage Cleaning", "telephone": PHONE, "url": SITE, "email": "contact@easygaragecleaning.com"},
        {"@context": "https://schema.org", "@type": "Service", "name": name, "description": desc, "provider": {"@type": "LocalBusiness", "@id": f"{SITE}/#business"}, "areaServed": {"@type": "City", "name": "Fort Collins", "addressRegion": "CO"}, "serviceType": stype},
        {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE}/"},
            {"@type": "ListItem", "position": 2, "name": name, "item": f"{SITE}/{slug}"}
        ]}
    ], ensure_ascii=False)


def faq_html(faqs):
    out = ['<section class="faq" id="faq" aria-labelledby="faq-heading"><div class="wrap"><div class="section-head reveal"><span class="mono section-num">FAQ</span><h2 class="section-title" id="faq-heading">Questions we get <em>a lot</em></h2></div><div class="faq-list reveal">']
    for i, (q, a) in enumerate(faqs, 1):
        out.append(f'<div class="faq-item"><h3 class="faq-q"><span class="faq-q-num">Q.{i:02d}</span>{esc(q)}</h3><p class="faq-a">{a}</p></div>')
    out.append('</div><p style="text-align:center;margin-top:24px;" class="reveal"><a href="/faq.html" style="font-weight:600;color:var(--accent-deep);">See full FAQ →</a></p></div></section>')
    return "\n".join(out)


def problem_html(problems, title, sub):
    items = "".join(f'<div class="problem-item"><span class="problem-icon">{icon}</span><div><h3>{esc(h)}</h3><p>{p}</p></div></div>' for icon, h, p in problems)
    return f'<section class="problem" aria-labelledby="problem-heading"><div class="wrap"><div class="section-head reveal"><span class="mono section-num">Sound familiar?</span><h2 class="section-title" id="problem-heading">{title}</h2><p class="section-sub">{sub}</p></div><div class="problem-list reveal">{items}</div></div></section>'


def items_html(yes_title, yes_items, no_items):
    y = "".join(f"<li>{x}</li>" for x in yes_items)
    n = "".join(f"<li>{x}</li>" for x in no_items)
    return f'<section class="items" aria-labelledby="items-heading"><div class="wrap"><div class="section-head reveal"><span class="mono section-num">What we haul</span><h2 class="section-title" id="items-heading">{yes_title}</h2></div><div class="items-grid reveal"><div class="items-col yes"><h3>We take</h3><ul>{y}</ul></div><div class="items-col no"><h3>We can\'t take</h3><ul>{n}</ul></div></div></div></section>'


def related_html(links):
    a = "".join(f'<a href="{href}">{label}</a>' for href, label in links)
    return f'<section class="related"><div class="wrap"><div class="section-head reveal"><span class="mono section-num">Related</span><h2 class="section-title">More ways we <em>help</em></h2></div><div class="links reveal">{a}</div></div></section>'


LOCAL_FC = """
<section class="local" aria-labelledby="local-heading">
  <div class="wrap">
    <div class="section-head reveal"><span class="mono section-num">Service area</span>
      <h2 class="section-title" id="local-heading">Fort Collins &amp; <em>neighborhoods</em></h2>
      <p class="section-sub">Based in Fort Collins — no hidden travel fees for our core service area.</p>
    </div>
    <div class="local-grid reveal">
      <div class="local-item"><strong>Old Town</strong><span>Fort Collins</span></div>
      <div class="local-item"><strong>Midtown</strong><span>Fort Collins</span></div>
      <div class="local-item"><strong>Fossil Creek</strong><span>Fort Collins</span></div>
      <div class="local-item"><strong>Harmony</strong><span>Fort Collins</span></div>
      <a href="/loveland-garage-cleanout.html" class="local-item"><strong>Loveland</strong><span>20 min south</span></a>
      <a href="/windsor-garage-cleanout.html" class="local-item"><strong>Windsor</strong><span>15 min east</span></a>
      <a href="/wellington-junk-removal.html" class="local-item"><strong>Wellington</strong><span>15 min north</span></a>
      <a href="/old-town-fort-collins-junk-removal.html" class="local-item"><strong>Old Town FC</strong><span>Neighborhood</span></a>
    </div>
    <p class="neighborhoods reveal">We serve <strong>Old Town</strong>, <strong>Midtown</strong>, <strong>Fossil Creek</strong>, the <strong>Harmony corridor</strong>, <strong>South College</strong>, <strong>Centerra</strong>, <strong>Mariana Butte</strong>, and surrounding Larimer County neighborhoods.</p>
  </div>
</section>"""


def fmt(template, **kwargs):
    defaults = {"phone": PHONE, "phone_display": PHONE_DISPLAY, "form_key": FORM_KEY, "SITE": SITE}
    defaults.update(kwargs)
    return template.format(**defaults)


def render_service(s):
    from _services_data import NO_ITEMS
    slug = s["slug"]
    canonical = f"{SITE}/{slug}"
    schema = f'<script type="application/ld+json">{service_schema(s["h1"], s["desc"], slug, s["stype"])}</script>\n<script type="application/ld+json">{faq_schema(s["faqs"])}</script>'
    hero = f"""<header class="hero" id="top"><div class="wrap hero-grid"><div><div class="hero-eyebrow mono">Fort Collins &amp; Northern Colorado</div>
<h1 class="hero-title">{esc(s["h1"])} — <em>{esc(s["hero_em"])}</em></h1>
<p class="hero-sub">{s["hero_sub"]}</p>
<div class="hero-ctas"><a href="#quote" class="btn-primary">Get Free Quote</a>
<a href="sms:{PHONE}?body={s['sms'].replace(' ', '%20')}" class="btn-secondary">Text Photos for Estimate</a></div>
<div class="hero-trust"><span class="trust-badge">Locally owned</span><span class="trust-badge">Flat-rate pricing</span><span class="trust-badge">Same-day available</span><span class="trust-badge">5-min response</span></div></div>
<div class="hero-ba"><div class="hero-ba-cell before"><span class="hero-ba-label">BEFORE</span><span class="hero-ba-icon">?</span></div>
<div class="hero-ba-cell after"><span class="hero-ba-label">AFTER</span><span class="hero-ba-icon">✓</span></div></div></div></header>"""
    items = items_html(s["yes_title"], s["yes"], NO_ITEMS) if s.get("show_items", True) else ""
    gallery = GALLERY_HTML.format(ba1=s["ba"][0], ba2=s["ba"][1], ba3=s["ba"][2])
    body = "\n".join([
        HEAD.format(title=s["title"], desc=s["desc"], canonical=canonical, schema=schema, css=SHARED_CSS, SITE=SITE),
        fmt(NAV),
        "<main>",
        hero,
        problem_html(s["problems"], s["problem_title"], s["problem_sub"]),
        fmt(PROCESS_HTML),
        items,
        fmt(PRICING_HTML),
        LOCAL_FC,
        faq_html(s["faqs"]),
        gallery,
        related_html(s["related"]),
        fmt(QUOTE_FORM, cta_title=s["cta"], form_subject=s["form_subject"], city_placeholder="Fort Collins, Loveland, etc.", city_default="", items_placeholder=s["items_ph"], sms_body=s["sms"].replace(" ", "%20")),
        "</main>",
        fmt(FOOTER),
    ])
    return body


def render_city(c):
    slug = c["slug"]
    canonical = f"{SITE}/{slug}"
    schema = f'<script type="application/ld+json">{service_schema(c["h1"], c["desc"], slug, c["service"])}</script>\n<script type="application/ld+json">{faq_schema(c["faqs"])}</script>'
    hero = f"""<header class="hero" id="top"><div class="wrap hero-grid"><div><div class="hero-eyebrow mono">Serving {c["city"]}, CO</div>
<h1 class="hero-title">{esc(c["h1"])}</h1>
<p class="hero-sub">{c["intro"]}</p>
<div class="hero-ctas"><a href="#quote" class="btn-primary">Get Free Quote</a>
<a href="sms:{PHONE}?body=Hi!%20I%20need%20{c['service'].replace(' ', '%20')}%20in%20{c['city']}." class="btn-secondary">Text Photos for Estimate</a></div>
<div class="hero-trust"><span class="trust-badge">Flat-rate pricing</span><span class="trust-badge">Fully insured</span><span class="trust-badge">Same-day available</span><span class="trust-badge">No travel surcharge</span></div></div>
<div class="hero-ba"><div class="hero-ba-cell before"><span class="hero-ba-label">BEFORE</span><span class="hero-ba-icon">?</span></div>
<div class="hero-ba-cell after"><span class="hero-ba-label">AFTER</span><span class="hero-ba-icon">✓</span></div></div></div></header>"""
    local = f"""<section class="local"><div class="wrap"><div class="section-head reveal"><span class="mono section-num">{c["city"]} neighborhoods</span>
<h2 class="section-title">We know <em>{c["city"]}</em></h2><p class="neighborhoods reveal">{c["neighborhoods"]}</p></div></div></section>"""
    related = related_html([
        (c["related_city"], c["related_label"]),
        ("/garage-cleanouts-fort-collins-co.html", "Fort Collins Garage Cleanouts"),
        ("/junk-removal-fort-collins-co.html", "Fort Collins Junk Removal"),
        ("/", "Home"),
    ])
    body = "\n".join([
        HEAD.format(title=c["title"], desc=c["desc"], canonical=canonical, schema=schema, css=SHARED_CSS, SITE=SITE),
        fmt(NAV),
        "<main>",
        hero,
        fmt(PROCESS_HTML),
        fmt(PRICING_HTML),
        local,
        faq_html(c["faqs"]),
        GALLERY_HTML.format(ba1=f"{c['city']} job 1", ba2=f"{c['city']} job 2", ba3=f"{c['city']} job 3"),
        related,
        fmt(QUOTE_FORM, cta_title=f"Book {c['service']} in {c['city']} <em>today</em>", form_subject=f"{c['service'].title()} Quote - {c['city']}", city_placeholder=f"{c['city']}, CO", city_default=c["city"], items_placeholder=f"Describe your {c['service']} needs in {c['city']}", sms_body=f"Hi!%20I%20need%20{c['service'].replace(' ', '%20')}%20in%20{c['city']}."),
        "</main>",
        fmt(FOOTER),
    ])
    return body


def render_project(p):
    slug = p["slug"]
    canonical = f"{SITE}/{slug}"
    schema = json.dumps({"@context": "https://schema.org", "@type": "Article", "headline": p["h1"], "description": p["desc"], "url": canonical, "author": {"@type": "Person", "name": "Zac Bezenek"}}, ensure_ascii=False)
    content = f"""<main><section class="hero"><div class="wrap">
<h1 class="hero-title" style="max-width:none">{esc(p["h1"])}</h1>
<p class="hero-sub">{p["desc"]}</p>
<p class="mono" style="color:var(--accent-deep);margin-top:12px;">PLACEHOLDER CASE STUDY — swap photos when available</p>
</div></section>
<section class="process"><div class="wrap">
<div class="section-head"><span class="mono section-num">Project details</span><h2 class="section-title">Job <em>summary</em></h2></div>
<div class="steps"><div class="step"><div class="step-num">Location</div><h3>{esc(p["city"])} — {esc(p["neighborhood"])}</h3><p>Service type: {esc(p["job_type"])}</p></div>
<div class="step"><div class="step-num">Timeline</div><h3>{esc(p["time"])}</h3><p>Same-day completion from quote to clear space.</p></div>
<div class="step"><div class="step-num">Result</div><h3>Client parked inside same day</h3><p>{p["result"]}</p></div></div>
</div></section>
{GALLERY_HTML.format(ba1="Before — placeholder", ba2="After — placeholder", ba3="Detail — placeholder")}
<section class="items"><div class="wrap"><div class="section-head"><span class="mono section-num">Scope</span><h2 class="section-title">Customer <em>problem</em></h2><p class="section-sub">{p["problem"]}</p>
<h2 class="section-title" style="margin-top:32px">What we <em>removed</em></h2><p class="section-sub">{p["removed"]}</p></div></div></section>
{fmt(PRICING_HTML)}
{fmt(QUOTE_FORM, cta_title="Get a quote like this <em>for your home</em>", form_subject=f"Project Inquiry - {p['city']}", city_placeholder="Your city", city_default=p["city"], items_placeholder="Describe your project", sms_body="Hi!%20I%20saw%20your%20project%20page%20and%20need%20a%20quote.")}
</main>"""
    return HEAD.format(title=p["title"], desc=p["desc"], canonical=canonical, schema=f'<script type="application/ld+json">{schema}</script>', css=SHARED_CSS, SITE=SITE) + fmt(NAV) + content + fmt(FOOTER)


def patch_nav(content):
    content = re.sub(r'\.nav-cta\s*\{[^}]*background:\s*var\(--ink\)[^}]*\}', '.nav-cta{background:var(--accent);color:var(--white);padding:10px 16px;font-size:13px;font-weight:700;border-radius:2px}.nav-cta:hover{background:var(--accent-deep)}', content)
    content = content.replace('href="/#contact"', 'href="/#quote"')
    content = content.replace('Get a Quote', 'Get Free Quote')
    if 'mobile-sticky-cta' not in content:
        sticky = f"""
<div class="mobile-sticky-cta" aria-label="Quick contact">
  <a href="tel:{PHONE}" class="mobile-cta-btn mobile-cta-call" style="padding:12px 6px;font-weight:700;font-size:12px;text-align:center;border-radius:3px;background:#14243d;color:#f5f1ea;border:1px solid rgba(255,255,255,.08);">Call</a>
  <a href="sms:{PHONE}" class="mobile-cta-btn mobile-cta-text" style="padding:12px 6px;font-weight:700;font-size:12px;text-align:center;border-radius:3px;background:#14243d;color:#f5f1ea;border:1px solid rgba(255,255,255,.08);">Text</a>
  <a href="/#quote" class="mobile-cta-btn mobile-cta-quote" style="padding:12px 6px;font-weight:700;font-size:12px;text-align:center;border-radius:3px;background:#ff5b1f;color:#fff;">Get Quote</a>
</div>
<style>@media(max-width:1023px){{.mobile-sticky-cta{{position:fixed;bottom:0;left:0;right:0;z-index:100;display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;background:#0a1628;padding:8px 10px 12px}}body{{padding-bottom:72px}}}}</style>"""
        content = content.replace('</body>', sticky + '\n</body>')
    return content


def main():
    from _services_data import SERVICES, CITIES, PROJECTS, NO_ITEMS

    generated = []
    for s in SERVICES:
        path = ROOT / s["slug"]
        path.write_text(render_service(s), encoding="utf-8")
        generated.append(s["slug"])

    for c in CITIES:
        path = ROOT / c["slug"]
        path.write_text(render_city(c), encoding="utf-8")
        generated.append(c["slug"])

    (ROOT / "projects").mkdir(exist_ok=True)
    for p in PROJECTS:
        path = ROOT / p["slug"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(render_project(p), encoding="utf-8")
        generated.append(p["slug"])

    for pattern in ["faq.html", "blog/*.html", "loveland-garage-cleanout.html", "windsor-garage-cleanout.html", "wellington-junk-removal.html", "timnath-junk-removal.html", "old-town-fort-collins-junk-removal.html", "privacy-policy.html", "thank-you.html"]:
        for path in ROOT.glob(pattern):
            text = path.read_text(encoding="utf-8")
            new = patch_nav(text)
            if new != text:
                path.write_text(new, encoding="utf-8")

    blog_links = {
        "fort-collins-junk-removal-what-you-can-cant-throw-away.html": '<p style="margin-top:24px">Need items hauled? See our <a href="/junk-removal-fort-collins-co.html">Fort Collins junk removal service</a> or <a href="/garage-cleanouts-fort-collins-co.html">garage cleanouts</a>.</p>',
        "what-to-do-with-old-appliances-fort-collins.html": '<p style="margin-top:24px">We haul appliances — <a href="/appliance-removal-fort-collins-co.html">appliance removal in Fort Collins</a>.</p>',
        "how-much-does-garage-cleanout-cost-fort-collins.html": '<p style="margin-top:24px"><a href="/garage-cleanouts-fort-collins-co.html">Get a garage cleanout quote</a> — flat-rate pricing.</p>',
        "how-to-prepare-for-garage-cleanout.html": '<p style="margin-top:24px"><a href="/garage-cleanouts-fort-collins-co.html">Book a Fort Collins garage cleanout</a>.</p>',
        "garage-organizing-ideas-two-car-garage.html": '<p style="margin-top:24px"><a href="/garage-organization-fort-collins-co.html">Garage organization service</a> in Fort Collins.</p>',
    }
    for fname, link in blog_links.items():
        path = ROOT / "blog" / fname
        if path.exists():
            text = path.read_text(encoding="utf-8")
            if link not in text:
                text = text.replace("</article>", link + "\n    </article>")
                path.write_text(text, encoding="utf-8")

    print("Generated:", len(generated), "pages")
    for g in generated:
        print(" ", g)


if __name__ == "__main__":
    main()
