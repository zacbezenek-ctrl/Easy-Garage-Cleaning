#!/usr/bin/env python3
"""Generate service, city, project, comparison, item, and about pages for Easy Garage Cleaning."""
import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).parent
SITE = "https://easygaragecleaning.com"
PHONE = "+19709991818"
PHONE_DISPLAY = "(970) 999-1818"
FORM_KEY = "3c4fe752-ac1d-45b9-89dd-4275ea162d22"
GA4_ID = "G-J0W6Y4MMP9"
TODAY = date.today().isoformat()

TAGLINE = "The easiest way to reclaim your garage"
EMAIL = "contact@easygaragecleaning.com"

AREA_SERVED = [
    {"@type": "City", "name": "Fort Collins"},
    {"@type": "City", "name": "Loveland"},
    {"@type": "City", "name": "Windsor"},
    {"@type": "City", "name": "Timnath"},
    {"@type": "City", "name": "Wellington"},
    {"@type": "City", "name": "Severance"},
    {"@type": "City", "name": "LaPorte"},
]

KNOWS_ABOUT = [
    "Garage cleanout",
    "Junk removal",
    "Garage cleaning",
    "Garage organization",
    "Furniture removal",
    "Appliance removal",
    "Mattress disposal",
    "Storage unit cleanout",
    "Yard debris removal",
    "Northern Colorado hauling",
    "Habitat ReStore donation",
    "Flat-rate photo quotes",
]

SERVICE_DEFINITIONS = {
    "Junk Removal": ("What is junk removal?", "Junk removal is professional hauling of unwanted furniture, appliances, boxes, and clutter from your home or garage. Easy Garage Cleaning provides flat-rate junk removal in Fort Collins from photos — we lift, haul, donate usable items, and recycle the rest with no hourly billing."),
    "Garage Cleanout": ("What is a garage cleanout?", "A garage cleanout is a full haul-out of unwanted garage contents — furniture, boxes, tools, and clutter — followed by donation drop-offs and a floor sweep so you can park inside again. We quote flat-rate from photos; labor, hauling, and dump fees are included."),
    "Garage Cleaning": ("What is garage cleaning?", "Garage cleaning is a post-cleanout reset: sweeping floors, removing dust and cobwebs, and wiping accessible surfaces after junk is gone. It turns an empty garage into a truly clean, usable space — often booked with a garage cleanout in Fort Collins."),
    "Garage Organization": ("What is garage organization?", "Garage organization is structured zoning after a cleanout — shelving plans, labeled bins, and layout so items have a permanent home. Easy Garage Cleaning helps Northern Colorado homeowners keep garages clear long-term, not just empty for a week."),
    "Furniture Removal": ("What is furniture removal?", "Furniture removal is pickup and haul-away of couches, beds, dressers, tables, and other bulky pieces from your garage or home. We carry items out, donate what's usable to local charities, and dispose of the rest with a flat-rate photo quote."),
    "Appliance Removal": ("What is appliance removal?", "Appliance removal covers fridges, washers, dryers, water heaters, and other large appliances hauled from your property. Working units may go to Habitat ReStore Fort Collins; we handle heavy lifting and proper disposal with flat-rate pricing."),
    "Mattress Removal": ("What is mattress removal?", "Mattress removal is haul-away of mattresses and box springs from garages, bedrooms, or curbside. We handle the weight and disposal requirements so you do not need a truck rental — quoted flat from photos before we arrive."),
    "Storage Unit Cleanout": ("What is a storage unit cleanout?", "A storage unit cleanout empties a paid storage unit in one trip — boxes, furniture, and forgotten items hauled, donated, or disposed. Ideal when monthly fees exceed the value of what's inside; we quote flat from photos of the unit."),
    "Yard Debris Removal": ("What is yard debris removal?", "Yard debris removal hauls branches, lawn equipment, outdoor furniture, and garage-stored yard clutter from your property. We load, haul, and recycle or dispose — common after storms or when clearing space for parking."),
    "Couch Removal": ("What is couch removal?", "Couch removal is single-item pickup of sofas, sectionals, and loveseats from your garage or home. We navigate stairs and tight spaces, donate usable upholstery when possible, and quote a flat rate from photos — typically $99–$150 for one piece."),
    "Hot Tub Removal": ("What is hot tub removal?", "Hot tub removal includes on-site dismantling and haul-away of spas and hot tubs from patios or garages. We handle the weight and disposal logistics so you avoid DIY injury and dump runs — quoted flat after photos of access and size."),
    "Treadmill Removal": ("What is treadmill removal?", "Treadmill removal is heavy exercise equipment haul-away from garages or basements. We disassemble when needed, carry out safely, and recycle or dispose — flat-rate from photos without hourly surprises."),
    "Refrigerator Removal": ("What is refrigerator removal?", "Refrigerator removal is freon-safe pickup of fridges and freezers from garages or kitchens. Working units may be donated to Habitat ReStore; we handle doors, weight, and disposal rules with a flat photo quote."),
    "Shed Cleanout": ("What is a shed cleanout?", "A shed cleanout empties a detached shed or backyard workshop — tools, lumber, old equipment, and clutter hauled in one visit. We sweep the floor and leave a usable space, with flat-rate pricing from photos."),
}

BLOG_PUBLISHED = {
    "how-much-does-garage-cleanout-cost-fort-collins.html": "2025-10-15",
    "how-to-prepare-for-garage-cleanout.html": "2025-10-22",
    "fort-collins-junk-removal-what-you-can-cant-throw-away.html": "2025-11-01",
    "junk-removal-vs-dumpster-rental-fort-collins.html": "2025-11-08",
    "garage-cleanout-vs-storage-unit-fort-collins.html": "2025-11-15",
    "got-junk-vs-local-junk-removal-fort-collins.html": "2025-11-22",
    "diy-junk-removal-vs-hiring-professionals-fort-collins.html": "2025-12-01",
    "garage-organization-after-cleanout-fort-collins.html": "2025-12-08",
    "garage-organizing-ideas-two-car-garage.html": "2025-12-15",
    "habitat-for-humanity-restore-fort-collins.html": "2026-01-10",
    "tax-deduction-donating-junk.html": "2026-01-18",
    "what-to-do-with-old-appliances-fort-collins.html": "2026-02-01",
    "estate-cleanout-checklist-colorado.html": "2026-02-15",
    "index.html": "2026-03-01",
}

NORTHERO_RELATED = [
    ("/garage-cleanouts-fort-collins-co.html", "Garage Cleanouts — Fort Collins"),
    ("/junk-removal-fort-collins-co.html", "Junk Removal — Fort Collins"),
    ("/garage-cleanouts-loveland-co.html", "Garage Cleanouts — Loveland"),
    ("/junk-removal-windsor-co.html", "Junk Removal — Windsor"),
    ("/junk-removal-wellington-co.html", "Junk Removal — Wellington"),
    ("/book.html", "Book Online"),
    ("/blog/", "Guides & Comparisons"),
    ("/", "Home"),
]

SHARED_CSS = r"""
:root{--navy:#0a1628;--navy-soft:#14243d;--navy-line:rgba(255,255,255,0.08);--ink:#0a1628;--paper:#f5f1ea;--paper-warm:#ebe4d6;--white:#fff;--accent:#ff5b1f;--accent-deep:#d94208;--muted:#6b7280;--text:#334155;--muted-dark:rgba(245,241,234,0.6);--font-display:'Fraunces',Georgia,serif;--font-body:'Inter',system-ui,sans-serif;--font-mono:'JetBrains Mono',ui-monospace,monospace;--radius:2px;--maxw:1240px}
*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}body{font-family:var(--font-body);color:var(--ink);background:var(--paper);line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden}a{color:inherit;text-decoration:none}a.content-link{color:var(--accent-deep);font-weight:600;text-decoration:underline;text-underline-offset:2px}.wrap{max-width:var(--maxw);margin:0 auto;padding:0 18px}.mono{font-family:var(--font-mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.btn-primary{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:var(--white);padding:14px 22px;font-weight:700;font-size:15px;border:none;border-radius:var(--radius);cursor:pointer;font-family:inherit;transition:background .2s,transform .2s;box-shadow:0 4px 20px -6px rgba(255,91,31,.5)}.btn-primary:hover{background:var(--accent-deep);transform:translateY(-1px)}.btn-secondary{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:transparent;color:var(--ink);padding:13px 22px;font-weight:600;font-size:15px;border:1px solid rgba(10,22,40,.2);border-radius:var(--radius)}.btn-secondary:hover{border-color:var(--accent);color:var(--accent-deep)}
.nav{position:sticky;top:0;z-index:50;background:rgba(245,241,234,.95);border-bottom:1px solid rgba(10,22,40,.08);backdrop-filter:blur(8px)}.nav-inner{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;max-width:var(--maxw);margin:0 auto}.logo{font-family:var(--font-display);font-weight:900;font-size:18px;letter-spacing:-.02em;display:flex;align-items:center;gap:6px;flex-shrink:0}.logo-mark{display:inline-block;width:9px;height:9px;background:var(--accent);border-radius:50%}.nav-links{display:none;gap:22px;list-style:none;font-size:13px;font-weight:500}.nav-links a:hover{color:var(--accent-deep)}.nav-right{display:none;align-items:center;gap:14px;flex-shrink:0}.nav-phone{font-weight:600;font-size:14px;white-space:nowrap}.nav-phone:hover{color:var(--accent)}.nav-cta{background:var(--accent);color:var(--white);padding:10px 16px;font-size:13px;font-weight:700;border-radius:var(--radius);white-space:nowrap}.nav-cta:hover{background:var(--accent-deep)}.nav-mobile-cta{display:block}@media(min-width:1024px){.nav-links{display:flex}.nav-right{display:flex}.nav-mobile-cta{display:none}}
.trust-strip{background:var(--white);border-bottom:1px solid rgba(10,22,40,.08);padding:14px 0}.trust-strip-inner{display:flex;flex-wrap:wrap;gap:10px 20px;justify-content:center;font-size:12px;font-weight:600;color:var(--text)}.trust-strip-inner span{display:inline-flex;align-items:center;gap:6px}.trust-strip-inner span::before{content:'';width:6px;height:6px;background:var(--accent);border-radius:50%}
section{padding:56px 0}@media(min-width:900px){section{padding:88px 0}}.section-head{margin-bottom:36px}.section-num{color:var(--accent-deep);margin-bottom:10px;display:block}h2.section-title{font-family:var(--font-display);font-weight:500;font-size:clamp(26px,5vw,44px);line-height:1.08;letter-spacing:-.025em;max-width:22ch}h2.section-title em{font-style:italic;font-weight:400;color:var(--accent-deep)}.section-sub{color:var(--text);font-size:16px;max-width:58ch;margin-top:12px}
.hero{padding:32px 0 48px}.hero-grid{display:grid;grid-template-columns:1fr;gap:32px;align-items:center}.hero-eyebrow{display:inline-flex;align-items:center;gap:10px;margin-bottom:14px;color:var(--accent-deep);font-size:11px}.hero-eyebrow::before{content:'';width:16px;height:1px;background:var(--accent-deep)}h1.hero-title{font-family:var(--font-display);font-weight:500;font-size:clamp(32px,7vw,54px);line-height:1.02;letter-spacing:-.03em;color:var(--ink);max-width:18ch}h1.hero-title em{font-style:italic;font-weight:400;color:var(--accent-deep)}.hero-sub{font-size:16px;color:var(--text);max-width:48ch;margin-top:14px;line-height:1.55}.hero-ctas{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}.hero-trust{display:flex;flex-wrap:wrap;gap:10px 16px;margin-top:24px;padding-top:20px;border-top:1px solid rgba(10,22,40,.1)}.trust-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--text)}.trust-badge::before{content:'';width:6px;height:6px;background:var(--accent);border-radius:50%;flex-shrink:0}.hero-ba{display:grid;grid-template-columns:1fr 1fr;gap:3px;background:var(--ink);padding:3px;border-radius:4px}.hero-ba-cell{aspect-ratio:4/5;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}.hero-ba-cell.before{background:repeating-linear-gradient(135deg,#2a3a4f 0 6px,#1a2a3f 6px 12px),#1a2a3f;color:rgba(255,255,255,.5)}.hero-ba-cell.after{background:radial-gradient(circle at 30% 20%,rgba(255,91,31,.12),transparent 60%),var(--paper-warm);color:var(--ink)}.hero-ba-label{position:absolute;top:10px;left:10px;font-family:var(--font-mono);font-size:9px;letter-spacing:.18em;background:rgba(0,0,0,.75);color:var(--paper);padding:4px 8px}.hero-ba-cell.after .hero-ba-label{background:var(--accent);color:var(--white)}.hero-ba-icon{font-family:var(--font-display);font-size:40px;font-style:italic;opacity:.4}@media(min-width:900px){.hero{padding:56px 0 72px}.hero-grid{grid-template-columns:1.05fr .95fr;gap:48px}.hero-sub{font-size:17px}}
.body-copy{background:var(--white)}.body-copy-inner{max-width:68ch;font-size:16px;line-height:1.7;color:var(--text)}.body-copy-inner p{margin-bottom:16px}.body-copy-inner h2{font-family:var(--font-display);font-size:clamp(22px,3vw,32px);font-weight:500;margin:32px 0 12px;letter-spacing:-.02em}
.problem{background:var(--navy);color:var(--paper)}.problem h2.section-title{color:var(--paper)}.problem h2.section-title em{color:var(--accent)}.problem .section-sub{color:var(--muted-dark)}.problem-list{display:grid;grid-template-columns:1fr;gap:14px;margin-top:28px}@media(min-width:640px){.problem-list{grid-template-columns:repeat(2,1fr)}}.problem-item{display:flex;gap:14px;align-items:flex-start;padding:18px;background:var(--navy-soft);border:1px solid var(--navy-line);border-radius:4px}.problem-icon{width:32px;height:32px;background:rgba(255,91,31,.15);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}.problem-item h3{font-size:15px;font-weight:600;margin-bottom:4px}.problem-item p{font-size:14px;color:var(--muted-dark);line-height:1.5}
.process{background:var(--paper)}.steps{display:grid;grid-template-columns:1fr;gap:20px;margin-top:32px}@media(min-width:768px){.steps{grid-template-columns:repeat(3,1fr)}}.step{position:relative;padding:28px 24px;background:var(--white);border:1px solid rgba(10,22,40,.08);border-top:3px solid var(--accent);border-radius:4px}.step-num{font-family:var(--font-mono);font-size:11px;letter-spacing:.15em;color:var(--accent);margin-bottom:12px}.step h3{font-family:var(--font-display);font-size:22px;font-weight:500;margin-bottom:10px;letter-spacing:-.02em}.step p{font-size:14px;color:var(--text);line-height:1.55}
.items{background:var(--paper-warm)}.items-grid{display:grid;grid-template-columns:1fr;gap:20px;margin-top:32px}@media(min-width:768px){.items-grid{grid-template-columns:1fr 1fr}}.items-col{background:var(--white);border:1px solid rgba(10,22,40,.08);padding:24px;border-radius:4px}.items-col h3{font-family:var(--font-display);font-size:20px;margin-bottom:12px}.items-col ul{margin-left:18px;color:var(--text);font-size:14px;line-height:1.7}.items-col.yes{border-top:3px solid #22c55e}.items-col.no{border-top:3px solid var(--accent)}
.pricing{background:var(--ink);color:var(--paper)}.pricing h2.section-title{color:var(--paper)}.pricing h2.section-title em{color:var(--accent)}.pricing .section-sub{color:var(--muted-dark)}.pricing-grid{display:grid;grid-template-columns:1fr;gap:16px;margin-top:32px}@media(min-width:640px){.pricing-grid{grid-template-columns:repeat(2,1fr)}}@media(min-width:900px){.pricing-grid{grid-template-columns:repeat(4,1fr)}}.price-card{background:var(--navy-soft);border:1px solid var(--navy-line);padding:28px 22px;border-radius:4px}.price-card.featured{border-color:var(--accent);background:linear-gradient(160deg,#1a2e52,#0a1628)}.price-tier{font-family:var(--font-mono);font-size:10px;letter-spacing:.15em;color:var(--muted-dark);margin-bottom:10px}.price-range{font-family:var(--font-display);font-size:36px;font-weight:700;letter-spacing:-.03em;line-height:1;margin-bottom:8px;color:var(--accent)}.price-name{font-size:17px;font-weight:600;margin-bottom:8px}.price-desc{font-size:13px;color:var(--muted-dark);line-height:1.5}.pricing-disclaimer{margin-top:24px;padding:16px 18px;background:rgba(255,255,255,.04);border:1px solid var(--navy-line);border-radius:4px;font-size:13px;color:var(--muted-dark);line-height:1.6}
.local{background:var(--paper)}.local-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:28px;max-width:800px}@media(min-width:700px){.local-grid{grid-template-columns:repeat(4,1fr)}}.local-item{padding:14px 16px;background:var(--paper-warm);border:1px solid rgba(10,22,40,.08);font-size:14px;font-weight:500;border-radius:3px}.local-item strong{display:block;font-family:var(--font-display);font-size:17px;font-weight:600;margin-bottom:2px}.local-item span{color:var(--muted);font-size:11px;font-family:var(--font-mono);letter-spacing:.06em;text-transform:uppercase}.local-item a:hover strong{color:var(--accent-deep)}.neighborhoods{margin-top:24px;font-size:15px;color:var(--text);max-width:68ch;line-height:1.65}
.faq{background:var(--paper-warm)}.faq-list{max-width:860px;margin:32px auto 0}.faq-item{padding:20px 0;border-bottom:1px solid rgba(10,22,40,.12)}.faq-q{font-family:var(--font-display);font-size:clamp(18px,2.5vw,22px);font-weight:500;line-height:1.3;letter-spacing:-.015em;margin-bottom:10px;display:flex;gap:14px;align-items:flex-start}.faq-q-num{color:var(--accent-deep);font-family:var(--font-mono);font-size:12px;flex-shrink:0;padding-top:4px}.faq-a{color:var(--text);font-size:15px;line-height:1.65;max-width:68ch;padding-left:36px}
.gallery{background:var(--paper)}.gallery-grid{display:grid;grid-template-columns:1fr;gap:24px;margin-top:32px}@media(min-width:768px){.gallery-grid{grid-template-columns:repeat(3,1fr)}}.ba-pair{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:var(--ink);padding:2px}.ba-cell{aspect-ratio:1/1.05;position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center}.ba-cell.before{background:repeating-linear-gradient(135deg,#2a3a4f 0 6px,#1a2a3f 6px 12px),#1a2a3f;color:rgba(255,255,255,.6)}.ba-cell.after{background:radial-gradient(circle at 30% 20%,rgba(255,91,31,.15),transparent 60%),var(--paper-warm);color:var(--ink)}.ba-label{position:absolute;top:10px;left:10px;font-family:var(--font-mono);font-size:9px;letter-spacing:.18em;background:rgba(0,0,0,.7);color:var(--paper);padding:4px 8px}.ba-cell.after .ba-label{background:var(--accent);color:var(--white)}.ba-icon{font-family:var(--font-display);font-size:40px;font-style:italic;opacity:.45}.ba-caption{font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;color:var(--muted);margin-top:12px}.ba-caption strong{color:var(--ink);font-weight:500}
.related{background:var(--white)}.links{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.links a{background:var(--paper);border:1px solid rgba(10,22,40,.1);padding:10px 16px;font-size:14px;font-weight:500;border-radius:3px}.links a:hover{border-color:var(--accent);color:var(--accent-deep)}
.compare-table{width:100%;border-collapse:collapse;margin:24px 0;font-size:14px}.compare-table th,.compare-table td{border:1px solid rgba(10,22,40,.12);padding:12px 14px;text-align:left;vertical-align:top}.compare-table th{background:var(--paper-warm);font-weight:600}.compare-table tr:nth-child(even) td{background:rgba(245,241,234,.5)}
.video-section{background:var(--paper-warm)}.video-wrap{aspect-ratio:16/9;background:var(--navy-soft);border:1px solid var(--navy-line);border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--muted-dark);font-size:14px;margin-top:24px}
.final-cta{background:var(--navy);color:var(--paper)}.final-cta h2.section-title{color:var(--paper)}.final-cta h2.section-title em{color:var(--accent)}.final-cta .section-sub{color:var(--muted-dark)}.cta-layout{display:grid;grid-template-columns:1fr;gap:40px;margin-top:32px;align-items:start}@media(min-width:900px){.cta-layout{grid-template-columns:1fr 1.1fr;gap:56px}}.cta-points{display:flex;flex-direction:column;gap:16px}.cta-point{display:flex;gap:12px;align-items:flex-start;font-size:15px;color:var(--muted-dark)}.cta-point::before{content:'✓';color:var(--accent);font-weight:700;flex-shrink:0}.quote-form{background:var(--navy-soft);border:1px solid var(--navy-line);padding:28px 24px;border-radius:4px}.quote-form h3{font-family:var(--font-display);font-size:22px;font-weight:500;margin-bottom:6px}.quote-form .form-note{font-size:13px;color:var(--muted-dark);margin-bottom:20px}.form-row{display:grid;grid-template-columns:1fr;gap:14px;margin-bottom:14px}@media(min-width:540px){.form-row.two{grid-template-columns:1fr 1fr}}.field label{display:block;font-family:var(--font-mono);font-size:10px;letter-spacing:.15em;color:var(--muted-dark);margin-bottom:6px;text-transform:uppercase}.field input,.field select,.field textarea{width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:3px;color:var(--paper);font-family:inherit;font-size:16px;padding:12px 14px;outline:none}.field input::placeholder,.field textarea::placeholder{color:rgba(245,241,234,.35)}.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--accent)}.field select option{background:var(--navy-soft);color:var(--paper)}.field textarea{resize:vertical;min-height:80px}.form-submit{width:100%;margin-top:6px}
.form-steps{display:flex;gap:8px;margin-bottom:20px}.form-step-dot{flex:1;height:4px;background:rgba(255,255,255,.15);border-radius:2px;transition:background .2s}.form-step-dot.active,.form-step-dot.done{background:var(--accent)}.form-panel{display:none}.form-panel.active{display:block}.form-nav{display:flex;gap:10px;margin-top:16px}.form-nav .btn-secondary{color:var(--paper);border-color:rgba(255,255,255,.25)}.form-step-label{font-family:var(--font-mono);font-size:10px;letter-spacing:.12em;color:var(--muted-dark);margin-bottom:14px;text-transform:uppercase}.service-picker{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px}@media(min-width:480px){.service-picker{grid-template-columns:repeat(3,1fr)}}.service-pick-card{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:14px 12px;background:rgba(255,255,255,.04);border:2px solid rgba(255,255,255,.12);border-radius:4px;cursor:pointer;transition:border-color .2s,background .2s;min-height:88px}.service-pick-card:hover{border-color:rgba(255,91,31,.5)}.service-pick-card input{position:absolute;opacity:0;width:0;height:0}.service-pick-card:has(input:checked){border-color:var(--accent);background:rgba(255,91,31,.12)}.spc-icon{font-size:20px;line-height:1}.spc-title{font-size:13px;font-weight:700;color:var(--paper);line-height:1.2}.spc-desc{font-size:11px;color:var(--muted-dark);line-height:1.3}.hero-phone{display:inline-flex;align-items:center;gap:8px;font-family:var(--font-display);font-size:clamp(20px,4vw,26px);font-weight:600;color:var(--accent-deep);margin-bottom:12px;letter-spacing:-.02em}.hero-phone:hover{color:var(--accent)}.hero-phone-sub{font-size:12px;font-weight:500;color:var(--muted);font-family:var(--font-body);margin-left:4px}.def-block{background:var(--white);border-left:3px solid var(--accent);padding:16px 20px;margin:24px 0;border-radius:0 4px 4px 0;font-size:15px;line-height:1.65;color:var(--text)}.def-block strong{font-family:var(--font-display);font-weight:500;font-size:17px;display:block;margin-bottom:6px;color:var(--ink)}
footer{background:var(--ink);color:var(--muted-dark);padding:36px 0;border-top:1px solid var(--navy-line);font-size:13px}.foot{display:flex;flex-direction:column;gap:14px;align-items:flex-start;justify-content:space-between}.foot .logo{color:var(--paper)}.foot-links{display:flex;flex-wrap:wrap;gap:12px 20px}.foot-links a:hover{color:var(--accent)}.community{margin-top:20px;font-size:12px;line-height:1.6;max-width:52ch}.foot-entity{margin-top:14px;font-size:12px;line-height:1.65;max-width:58ch}.foot-nap{margin-bottom:6px}.foot-nap a:hover{color:var(--accent)}.foot-area{color:var(--muted-dark)}@media(min-width:700px){.foot{flex-direction:row;align-items:flex-start}}
.mobile-sticky-cta{position:fixed;bottom:0;left:0;right:0;z-index:100;display:none;grid-template-columns:1fr 1fr 1fr;gap:6px;background:var(--ink);border-top:1px solid var(--navy-line);padding:8px 10px 12px}.mobile-cta-btn{padding:12px 6px;font-weight:700;font-size:12px;text-align:center;border-radius:3px;font-family:var(--font-body)}.mobile-cta-call,.mobile-cta-text{background:var(--navy-soft);color:var(--paper);border:1px solid var(--navy-line)}.mobile-cta-quote{background:var(--accent);color:var(--white)}@media(max-width:1023px){.mobile-sticky-cta{display:grid}body{padding-bottom:72px}}
.reveal{opacity:0;transform:translateY(16px);transition:opacity .7s ease,transform .7s ease}.reveal.visible{opacity:1;transform:translateY(0)}
.article-wrap{max-width:740px;margin:0 auto;padding:0 18px}.article-body{padding-bottom:80px;font-size:16px;line-height:1.75}.article-body h2{font-family:var(--font-display);font-size:26px;font-weight:500;margin:40px 0 14px;letter-spacing:-.02em}.article-body p{margin-bottom:18px}.article-body ul,.article-body ol{margin:0 0 18px 24px}
"""

GTAG_BLOCK = """<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-J0W6Y4MMP9"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());

  gtag('config', 'G-J0W6Y4MMP9');
  gtag('config', 'AW-18102284288');
</script>
"""

TRACKING_BLOCK = """
<!--
  MERCHANT SETUP CHECKLIST — optional tags:
  1. Microsoft Clarity: replace CLARITY_PROJECT_ID with your project ID
  2. Google Search Console: uncomment meta verification tag below
  3. CallRail: see body comment block for dynamic number swap
  4. AggregateRating: add real review count in schema when available
-->
<!-- Google Search Console: <meta name="google-site-verification" content="YOUR_VERIFICATION_CODE" /> -->
<!-- Microsoft Clarity: replace CLARITY_PROJECT_ID -->
<script type="text/javascript">
(function(c,l,a,r,i,t,y){{c[a]=c[a]||function(){{(c[a].q=c[a].q||[]).push(arguments)}};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);}})(window,document,"clarity","script","CLARITY_PROJECT_ID");
</script>
"""

CALLRAIL_BLOCK = """
<!--
  CALLRAIL / DYNAMIC NUMBER INSERTION
  1. Create a CallRail account and add easygaragecleaning.com
  2. Install their swap.js snippet OR use their GTM integration
  3. Replace displayed (970) 999-1818 with your tracking pool number in their dashboard
  4. Example: <script src="https://cdn.callrail.com/companies/XXXX/swap.js"></script>
-->
"""

HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
""" + GTAG_BLOCK + """
""" + TRACKING_BLOCK + """
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{title}</title>
<meta name="description" content="{desc}" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="{canonical}" />
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
<meta name="theme-color" content="#ff5b1f" />
<meta property="og:type" content="{og_type}" />
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
""" + CALLRAIL_BLOCK

NAV = """
<nav class="nav" aria-label="Primary">
  <div class="nav-inner">
    <a href="/" class="logo" aria-label="Easy Garage Cleaning Home"><span class="logo-mark"></span>Easy Garage</a>
    <ul class="nav-links">
      <li><a href="/junk-removal-fort-collins-co.html">Junk Removal</a></li>
      <li><a href="/garage-cleanouts-fort-collins-co.html">Garage Cleanouts</a></li>
      <li><a href="/garage-cleaning-fort-collins-co.html">Garage Cleaning</a></li>
      <li><a href="{service_areas_href}">Service Areas</a></li>
      <li><a href="{reviews_href}">Reviews</a></li>
      <li><a href="/about.html">About</a></li>
    </ul>
    <div class="nav-right">
      <a href="tel:{phone}" class="nav-phone">{phone_display}</a>
      <a href="{quote_href}" class="nav-cta">Get Free Quote</a>
    </div>
    <a href="{quote_href}" class="nav-cta nav-mobile-cta" aria-label="Get Free Quote">Quote</a>
  </div>
</nav>
<div class="trust-strip" aria-label="Trust signals">
  <div class="wrap trust-strip-inner">
    <span>Response within 5 minutes</span><span>No hidden fees</span><span>Only pay after approving quote</span><span>We do all lifting</span><span>Text photos now</span><span>Same-day availability</span>
  </div>
</div>
"""

FOOTER = """
<footer>
  <div class="wrap foot">
    <div>
      <div class="logo"><span class="logo-mark"></span>Easy Garage Cleaning</div>
      <p class="community">Trusted by Northern Colorado homeowners. Community partners: <a href="https://www.fcgov.com/chamber/" rel="noopener">Fort Collins Chamber</a> (member), <a href="/blog/habitat-for-humanity-restore-fort-collins.html">Habitat ReStore Fort Collins</a>, CSU alumni network. Donation &amp; recycling partners on every job.</p>
    </div>
    <div class="foot-links">
      <a href="/junk-removal-fort-collins-co.html">Junk Removal</a>
      <a href="/garage-cleanouts-fort-collins-co.html">Garage Cleanouts</a>
      <a href="/book.html">Book Online</a>
      <a href="/about.html">About</a>
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
  <a href="{quote_href}" class="mobile-cta-btn mobile-cta-quote">Quote</a>
</div>
<script>
const io=new IntersectionObserver((entries)=>{{entries.forEach(e=>{{if(e.isIntersecting){{e.target.classList.add('visible');io.unobserve(e.target);}}}});}},{{threshold:0.08}});
document.querySelectorAll('.reveal').forEach(el=>io.observe(el));
document.querySelectorAll('.multi-step-form').forEach(initMultiStepForm);
function initMultiStepForm(form){{
  let step=1;const panels=form.querySelectorAll('.form-panel');const dots=form.querySelectorAll('.form-step-dot');const total=panels.length;
  const show=(n)=>{{panels.forEach((p,i)=>p.classList.toggle('active',i+1===n));dots.forEach((d,i)=>{{d.classList.toggle('active',i+1===n);d.classList.toggle('done',i+1<n);}});step=n;const lbl=form.querySelector('.form-step-label');if(lbl){{const names=['What do you need?','Where are you located?','Upload photos','Contact & timing'];lbl.textContent='Step '+n+' of '+total+(names[n-1]?': '+names[n-1]:'');}}}};
  function validateStep(n){{
    const panel=panels[n-1];
    if(n===1){{const svc=form.querySelector('[name="Service type"]:checked');if(!svc){{panel.querySelector('.service-picker')?.scrollIntoView({{behavior:'smooth',block:'center'}});return false;}}}}
    if(n===2){{const city=form.querySelector('[name="City"]');if(city&&!city.value){{city.focus();return false;}}}}
    return true;
  }}
  form.querySelectorAll('[data-next]').forEach(b=>b.addEventListener('click',()=>{{if(!validateStep(step))return;if(step<total)show(step+1);}}));
  form.querySelectorAll('[data-prev]').forEach(b=>b.addEventListener('click',()=>{{if(step>1)show(step-1);}}));
  form.addEventListener('submit',()=>{{
    const svc=form.querySelector('[name="Service type"]:checked')||form.querySelector('[name="Service type"]');
    const desc=form.querySelector('[name="Photo description"]');const city=form.querySelector('[name="City"]');
    const combined=form.querySelector('[name="What to remove"]');
    if(combined&&svc){{const parts=[svc.value||svc.options?.[svc.selectedIndex]?.value,city&&city.value?city.value:'',desc&&desc.value?desc.value:''].filter(Boolean);combined.value=parts.join(' — ');}}
  }});
  show(1);
}}
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

VIDEO_HTML = """
<section class="video-section" aria-labelledby="video-heading">
  <div class="wrap">
    <div class="section-head reveal"><span class="mono section-num">Watch</span>
      <h2 class="section-title" id="video-heading">See a Real <em>Garage Transformation</em></h2>
      <p class="section-sub">Video placeholder — replace VIDEO_ID with your YouTube video ID.</p>
    </div>
    <div class="video-wrap reveal">
      <!-- Replace VIDEO_ID: <iframe width="100%" height="100%" src="https://www.youtube.com/embed/VIDEO_ID" title="Garage cleanout Fort Collins" frameborder="0" allowfullscreen loading="lazy"></iframe> -->
      YouTube embed placeholder — owner to add VIDEO_ID
    </div>
  </div>
</section>
"""

QUOTE_FORM = """
<section class="final-cta" id="quote" aria-labelledby="cta-heading">
  <div class="wrap">
    <div class="section-head reveal"><span class="mono section-num">Ready?</span>
      <h2 class="section-title" id="cta-heading">{cta_title}</h2>
      <p class="section-sub">Get a free flat-rate quote in 5 minutes. Text photos or complete the steps below — we'll call you right back.</p>
    </div>
    <div class="cta-layout reveal">
      <div class="cta-points">
        <div class="cta-point">Response within 5 minutes</div>
        <div class="cta-point">No hidden fees — only pay after approving quote</div>
        <div class="cta-point">We do all lifting — you don't touch a thing</div>
        <div class="cta-point">Same-day availability when schedule allows</div>
        <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:12px;">
          <a href="tel:{phone}" class="btn-primary">Call {phone_display}</a>
          <a href="sms:{phone}?body={sms_body}" class="btn-secondary" style="color:var(--paper);border-color:rgba(255,255,255,.25);">Text Photos</a>
        </div>
      </div>
      <div class="quote-form">
        <h3>Get Free Quote</h3>
        <p class="form-step-label">Step 1 of 4: What do you need?</p>
        <form class="multi-step-form" action="https://api.web3forms.com/submit" method="POST" enctype="multipart/form-data">
          <input type="hidden" name="access_key" value="{form_key}">
          <input type="hidden" name="subject" value="{form_subject}">
          <input type="hidden" name="from_name" value="Easy Garage Cleaning Website">
          <input type="hidden" name="redirect" value="{SITE}/thank-you.html">
          <input type="checkbox" name="botcheck" class="sr-only" tabindex="-1" autocomplete="off">
          <input type="hidden" name="What to remove" value="">
          <div class="form-steps" aria-hidden="true"><div class="form-step-dot active"></div><div class="form-step-dot"></div><div class="form-step-dot"></div><div class="form-step-dot"></div></div>
          <div class="form-panel active" data-step="1">
            <div class="service-picker" role="radiogroup" aria-label="Service type">
              <label class="service-pick-card"><input type="radio" name="Service type" value="Garage Cleanout"{default_garage} required><span class="spc-icon">🏠</span><span class="spc-title">Garage Cleanout</span><span class="spc-desc">Full haul-out &amp; sweep</span></label>
              <label class="service-pick-card"><input type="radio" name="Service type" value="Junk Removal"{default_junk}><span class="spc-icon">🚛</span><span class="spc-title">Junk Removal</span><span class="spc-desc">Single items to full loads</span></label>
              <label class="service-pick-card"><input type="radio" name="Service type" value="Furniture Removal"><span class="spc-icon">🛋️</span><span class="spc-title">Furniture</span><span class="spc-desc">Couches, beds, dressers</span></label>
              <label class="service-pick-card"><input type="radio" name="Service type" value="Appliance Removal"><span class="spc-icon">🔌</span><span class="spc-title">Appliances</span><span class="spc-desc">Fridges, washers, dryers</span></label>
              <label class="service-pick-card"><input type="radio" name="Service type" value="Mattress Removal"><span class="spc-icon">🛏️</span><span class="spc-title">Mattress</span><span class="spc-desc">Mattress &amp; box spring</span></label>
              <label class="service-pick-card"><input type="radio" name="Service type" value="Storage Unit Cleanout"><span class="spc-icon">📦</span><span class="spc-title">Storage Unit</span><span class="spc-desc">Empty a paid unit fast</span></label>
              <label class="service-pick-card"><input type="radio" name="Service type" value="Garage Organization"><span class="spc-icon">🗂️</span><span class="spc-title">Organization</span><span class="spc-desc">Zones, shelves, bins</span></label>
              <label class="service-pick-card"><input type="radio" name="Service type" value="Other"><span class="spc-icon">❓</span><span class="spc-title">Other</span><span class="spc-desc">Not sure — we'll help</span></label>
            </div>
            <button type="button" class="btn-primary form-submit" data-next style="margin-top:12px;">Next: Location →</button>
          </div>
          <div class="form-panel" data-step="2">
            <div class="form-row"><div class="field"><label for="city-{form_id}">City</label>
              <select id="city-{form_id}" name="City" required>
                <option value="">Select your city…</option>
                <option value="Fort Collins"{sel_fc}>Fort Collins</option>
                <option value="Loveland"{sel_lo}>Loveland</option>
                <option value="Windsor"{sel_wi}>Windsor</option>
                <option value="Timnath"{sel_ti}>Timnath</option>
                <option value="Wellington"{sel_we}>Wellington</option>
                <option value="Severance">Severance</option>
                <option value="LaPorte">LaPorte</option>
                <option value="Other Northern Colorado">Other Northern Colorado</option>
              </select>
            </div></div>
            <div class="form-row"><div class="field"><label for="zip-{form_id}">Zip code (optional)</label><input type="text" id="zip-{form_id}" name="Zip code" inputmode="numeric" placeholder="80525" autocomplete="postal-code" /></div></div>
            <div class="form-nav"><button type="button" class="btn-secondary" data-prev>← Back</button><button type="button" class="btn-primary" data-next>Next: Photos →</button></div>
          </div>
          <div class="form-panel" data-step="3">
            <div class="form-row"><div class="field"><label for="photos-{form_id}">Upload photos (recommended)</label><input type="file" id="photos-{form_id}" name="Photos" accept="image/*" multiple /></div></div>
            <div class="form-row"><div class="field"><label for="photo-desc-{form_id}">Describe what we see (optional)</label><textarea id="photo-desc-{form_id}" name="Photo description" placeholder="Wide shot of garage, couch in corner, etc."></textarea></div></div>
            <p class="form-note" style="margin-bottom:12px;">No photos? Text them to {phone_display} — often faster.</p>
            <div class="form-nav"><button type="button" class="btn-secondary" data-prev>← Back</button><button type="button" class="btn-primary" data-next>Next: Contact →</button></div>
          </div>
          <div class="form-panel" data-step="4">
            <div class="form-row two">
              <div class="field"><label for="name-{form_id}">Name</label><input type="text" id="name-{form_id}" name="Name" required autocomplete="name" placeholder="Your name" /></div>
              <div class="field"><label for="phone-f-{form_id}">Phone</label><input type="tel" id="phone-f-{form_id}" name="Phone" required autocomplete="tel" inputmode="tel" placeholder="(970) 555-1234" /></div>
            </div>
            <div class="form-row"><div class="field"><label for="email-{form_id}">Email (optional)</label><input type="email" id="email-{form_id}" name="Email" autocomplete="email" placeholder="you@email.com" /></div></div>
            <div class="form-row"><div class="field"><label for="timing-{form_id}">Preferred timing</label>
              <select id="timing-{form_id}" name="Preferred timing">
                <option value="ASAP / Same-day">ASAP / Same-day</option>
                <option value="This week">This week</option>
                <option value="Next week">Next week</option>
                <option value="Flexible">Flexible — just getting a quote</option>
              </select>
            </div></div>
            <div class="form-nav"><button type="button" class="btn-secondary" data-prev>← Back</button><button type="submit" class="btn-primary form-submit">Get Free Quote →</button></div>
          </div>
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
      <h2 class="section-title" id="process-heading">Three steps to <em>reclaim your space</em></h2>
      <p class="section-sub">No truck visit needed for most quotes. Text us photos and we'll tell you exactly what it costs.</p>
    </div>
    <div class="steps reveal">
      <div class="step"><div class="step-num">Step 01</div><h3>Send Photos</h3><p>Text photos to <a href="sms:{phone}">{phone_display}</a>, or upload them below. Wide shots work best.</p></div>
      <div class="step"><div class="step-num">Step 02</div><h3>Fast Quote</h3><p>We respond within 5 minutes with a flat-rate price. Only pay after you approve — no hidden fees.</p></div>
      <div class="step"><div class="step-num">Step 03</div><h3>We Handle It</h3><p>We do all the lifting, haul everything, donate usable items, sweep, and hand you a donation receipt.</p></div>
    </div>
  </div>
</section>
"""

LOCAL_FC = """
<section class="local" id="service-area" aria-labelledby="local-heading">
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
      <a href="/garage-cleanouts-loveland-co.html" class="local-item"><strong>Loveland</strong><span>Garage cleanouts</span></a>
      <a href="/junk-removal-loveland-co.html" class="local-item"><strong>Loveland Junk</strong><span>20 min south</span></a>
      <a href="/garage-cleanouts-windsor-co.html" class="local-item"><strong>Windsor</strong><span>Garage cleanouts</span></a>
      <a href="/junk-removal-wellington-co.html" class="local-item"><strong>Wellington</strong><span>15 min north</span></a>
    </div>
    <p class="neighborhoods reveal">We serve <strong>Old Town</strong>, <strong>Midtown</strong>, <strong>Fossil Creek</strong>, the <strong>Harmony corridor</strong>, <strong>South College</strong>, <strong>Centerra</strong>, <strong>Mariana Butte</strong>, and surrounding Larimer County neighborhoods. Also see <a href="/garage-cleanouts-loveland-co.html" class="content-link">garage cleanouts in Loveland</a> and <a href="/junk-removal-windsor-co.html" class="content-link">junk removal in Windsor</a>.</p>
  </div>
</section>"""


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def faq_schema(faqs):
    entities = [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": re.sub(r"<[^>]+>", "", a)}} for q, a in faqs]
    return json.dumps({"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": entities}, ensure_ascii=False)


def business_schema():
    return {
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
        "@id": f"{SITE}/#business",
        "name": "Easy Garage Cleaning",
        "alternateName": "Easy Garage Cleaning LLC",
        "description": "Garage reclaiming specialist — cleanouts, junk removal, and organization in Fort Collins and Northern Colorado.",
        "url": SITE,
        "telephone": PHONE,
        "email": "contact@easygaragecleaning.com",
        "image": f"{SITE}/og-image.png",
        "logo": f"{SITE}/android-chrome-512x512.png",
        "priceRange": "$$",
        "address": {"@type": "PostalAddress", "streetAddress": "Fort Collins", "addressLocality": "Fort Collins", "addressRegion": "CO", "postalCode": "80525", "addressCountry": "US"},
        "geo": {"@type": "GeoCoordinates", "latitude": 40.585260, "longitude": -105.084419},
        "areaServed": AREA_SERVED,
        "openingHoursSpecification": [{"@type": "OpeningHoursSpecification", "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], "opens": "07:00", "closes": "19:00"}],
        "founder": {"@type": "Person", "name": "Zac Bezenek", "url": f"{SITE}/about.html"},
        "sameAs": [
            "https://www.google.com/maps/place/Fort+Collins,+CO",
            "https://www.facebook.com/PLACEHOLDER",
            "https://www.instagram.com/PLACEHOLDER",
            "https://www.yelp.com/biz/PLACEHOLDER",
        ],
    }


def howto_schema():
    return json.dumps({
        "@context": "https://schema.org",
        "@type": "HowTo",
        "name": "How to book a garage cleanout in Fort Collins",
        "description": "Get a flat-rate garage cleanout quote from Easy Garage Cleaning in three simple steps.",
        "totalTime": "PT5M",
        "step": [
            {"@type": "HowToStep", "position": 1, "name": "Send photos", "text": f"Text photos of your garage or junk to {PHONE_DISPLAY}, or upload them in the quote form at easygaragecleaning.com. Wide shots work best."},
            {"@type": "HowToStep", "position": 2, "name": "Get a flat-rate quote", "text": "We respond within 5 minutes with a firm price. No hourly billing, no truck visit required for most jobs."},
            {"@type": "HowToStep", "position": 3, "name": "We reclaim your garage", "text": "We haul everything, donate usable items, sweep the floor, and hand you a donation receipt. You only pay after approving the quote."},
        ],
    }, ensure_ascii=False)


def website_schema():
    return json.dumps({
        "@context": "https://schema.org",
        "@type": "WebSite",
        "@id": f"{SITE}/#website",
        "name": "Easy Garage Cleaning",
        "url": SITE,
        "description": "Garage cleanouts and junk removal in Fort Collins and Northern Colorado.",
        "publisher": {"@id": f"{SITE}/#business"},
        "potentialAction": {
            "@type": "SearchAction",
            "target": {"@type": "EntryPoint", "urlTemplate": f"{SITE}/faq.html?q={{search_term_string}}"},
            "query-input": "required name=search_term_string",
        },
    }, ensure_ascii=False)


def webpage_schema(title, desc, url):
    return json.dumps({
        "@context": "https://schema.org",
        "@type": "WebPage",
        "@id": f"{url}#webpage",
        "url": url,
        "name": title,
        "description": desc,
        "isPartOf": {"@id": f"{SITE}/#website"},
        "about": {"@id": f"{SITE}/#business"},
        "speakable": {
            "@type": "SpeakableSpecification",
            "cssSelector": [".hero-sub", ".faq-q", ".faq-a", ".def-block"],
        },
    }, ensure_ascii=False)


def service_schema(name, desc, slug, stype):
    return json.dumps([
        business_schema(),
        {"@context": "https://schema.org", "@type": "Service", "name": name, "description": desc, "provider": {"@type": "LocalBusiness", "@id": f"{SITE}/#business"}, "areaServed": {"@type": "City", "name": "Fort Collins", "addressRegion": "CO"}, "serviceType": stype},
        {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": f"{SITE}/"},
            {"@type": "ListItem", "position": 2, "name": name, "item": f"{SITE}/{slug}"},
        ]},
    ], ensure_ascii=False)


def faq_html(faqs):
    out = ['<section class="faq" id="faq" aria-labelledby="faq-heading"><div class="wrap"><div class="section-head reveal"><span class="mono section-num">FAQ</span><h2 class="section-title" id="faq-heading">Questions we get <em>a lot</em></h2></div><div class="faq-list reveal">']
    for i, (q, a) in enumerate(faqs, 1):
        out.append(f'<div class="faq-item"><h3 class="faq-q"><span class="faq-q-num">Q.{i:02d}</span>{esc(q)}</h3><p class="faq-a">{a}</p></div>')
    out.append('</div><p style="text-align:center;margin-top:24px;" class="reveal"><a href="/faq.html" class="content-link">See full FAQ →</a></p></div></section>')
    return "\n".join(out)


def problem_html(problems, title, sub):
    items = "".join(f'<div class="problem-item"><span class="problem-icon">{icon}</span><div><h3>{esc(h)}</h3><p>{p}</p></div></div>' for icon, h, p in problems)
    return f'<section class="problem" aria-labelledby="problem-heading"><div class="wrap"><div class="section-head reveal"><span class="mono section-num">Sound familiar?</span><h2 class="section-title" id="problem-heading">{title}</h2><p class="section-sub">{sub}</p></div><div class="problem-list reveal">{items}</div></div></section>'


def body_copy_html(html):
    if not html:
        return ""
    return f'<section class="body-copy"><div class="wrap"><div class="body-copy-inner reveal">{html}</div></div></section>'


def items_html(yes_title, yes_items, no_items):
    y = "".join(f"<li>{x}</li>" for x in yes_items)
    n = "".join(f"<li>{x}</li>" for x in no_items)
    return f'<section class="items" aria-labelledby="items-heading"><div class="wrap"><div class="section-head reveal"><span class="mono section-num">What we haul</span><h2 class="section-title" id="items-heading">{yes_title}</h2></div><div class="items-grid reveal"><div class="items-col yes"><h3>We take</h3><ul>{y}</ul></div><div class="items-col no"><h3>We can\'t take</h3><ul>{n}</ul></div></div></div></section>'


def related_html(links):
    a = "".join(f'<a href="{href}">{label}</a>' for href, label in links)
    return f'<section class="related"><div class="wrap"><div class="section-head reveal"><span class="mono section-num">Related</span><h2 class="section-title">More ways we <em>help</em></h2></div><div class="links reveal">{a}</div></div></section>'


def fmt(template, **kwargs):
    defaults = {
        "phone": PHONE, "phone_display": PHONE_DISPLAY, "form_key": FORM_KEY, "SITE": SITE,
        "default_garage": "", "default_junk": "", "og_type": "website",
        "quote_href": "#quote", "service_areas_href": "/#service-area", "reviews_href": "/#reviews",
        "form_id": "q", "sel_fc": "", "sel_lo": "", "sel_wi": "", "sel_ti": "", "sel_we": "",
    }
    defaults.update(kwargs)
    return template.format(**defaults)


def quote_form_for(stype, **kwargs):
    dg = ' checked' if 'garage' in stype.lower() and 'junk' not in stype.lower() and 'organization' not in stype.lower() else ''
    dj = ' checked' if stype.lower() == 'junk removal' else ''
    city = kwargs.pop("city_default", "")
    sel = {"sel_fc": "", "sel_lo": "", "sel_wi": "", "sel_ti": "", "sel_we": ""}
    key = {"Fort Collins": "sel_fc", "Loveland": "sel_lo", "Windsor": "sel_wi", "Timnath": "sel_ti", "Wellington": "sel_we"}.get(city, "")
    if key:
        sel[key] = " selected"
    form_id = re.sub(r"[^a-z0-9]", "", stype.lower())[:12] or "q"
    return fmt(QUOTE_FORM, default_garage=dg, default_junk=dj, form_id=form_id, **sel, **kwargs)


def page_shell(title, desc, canonical, schema, body, og_type="website", quote_href="#quote"):
    extra = f'\n<script type="application/ld+json">{webpage_schema(title, desc, canonical)}</script>'
    return HEAD.format(title=title, desc=desc, canonical=canonical, schema=schema + extra, css=SHARED_CSS, SITE=SITE, og_type=og_type) + fmt(NAV, quote_href=quote_href) + body + fmt(FOOTER, quote_href=quote_href)


def render_service(s):
    from _services_data import NO_ITEMS
    slug = s["slug"]
    canonical = f"{SITE}/{slug}"
    schema = f'<script type="application/ld+json">{service_schema(s["h1"], s["desc"], slug, s["stype"])}</script>\n<script type="application/ld+json">{faq_schema(s["faqs"])}</script>\n<script type="application/ld+json">{howto_schema()}</script>'
    trust = '<span class="trust-badge">No hidden fees</span><span class="trust-badge">We do all lifting</span><span class="trust-badge">Text photos now</span>'
    hero = f"""<header class="hero" id="top"><div class="wrap hero-grid"><div><div class="hero-eyebrow mono">Fort Collins &amp; Northern Colorado</div>
<a href="tel:{PHONE}" class="hero-phone">{PHONE_DISPLAY}<span class="hero-phone-sub">· 5-min quote response</span></a>
<h1 class="hero-title">{esc(s["h1"])} — <em>{esc(s["hero_em"])}</em></h1>
<p class="hero-sub">{s["hero_sub"]}</p>
<div class="hero-ctas"><a href="#quote" class="btn-primary">Get Free Quote</a>
<a href="sms:{PHONE}?body={s['sms'].replace(' ', '%20')}" class="btn-secondary">Text Photos for Estimate</a></div>
<div class="hero-trust"><span class="trust-badge">Locally owned</span><span class="trust-badge">Flat-rate pricing</span><span class="trust-badge">Same-day available</span><span class="trust-badge">5-min response</span>{trust}</div></div>
<div class="hero-ba"><div class="hero-ba-cell before"><span class="hero-ba-label">BEFORE</span><span class="hero-ba-icon">?</span></div>
<div class="hero-ba-cell after"><span class="hero-ba-label">AFTER</span><span class="hero-ba-icon">✓</span></div></div></div></header>"""
    items = items_html(s["yes_title"], s["yes"], NO_ITEMS) if s.get("show_items", True) else ""
    video = VIDEO_HTML if s.get("show_video") else ""
    body = "<main>" + "\n".join([
        hero,
        body_copy_html(s.get("body_copy", "")),
        problem_html(s["problems"], s["problem_title"], s["problem_sub"]),
        fmt(PROCESS_HTML),
        items,
        fmt(PRICING_HTML),
        LOCAL_FC,
        faq_html(s["faqs"]),
        GALLERY_HTML.format(ba1=s["ba"][0], ba2=s["ba"][1], ba3=s["ba"][2]),
        video,
        related_html(s["related"]),
        quote_form_for(s["stype"], cta_title=s["cta"], form_subject=s["form_subject"], sms_body=s["sms"].replace(" ", "%20")),
    ]) + "</main>"
    return page_shell(s["title"], s["desc"], canonical, schema, body)


def render_city(c):
    slug = c["slug"]
    canonical = f"{SITE}/{slug}"
    schema = f'<script type="application/ld+json">{service_schema(c["h1"], c["desc"], slug, c["service"])}</script>\n<script type="application/ld+json">{faq_schema(c["faqs"])}</script>'
    hero = f"""<header class="hero" id="top"><div class="wrap hero-grid"><div><div class="hero-eyebrow mono">Serving {c["city"]}, CO</div>
<a href="tel:{PHONE}" class="hero-phone">{PHONE_DISPLAY}<span class="hero-phone-sub">· 5-min quote response</span></a>
<h1 class="hero-title">{esc(c["h1"])}</h1>
<p class="hero-sub">{c["intro"]}</p>
<div class="hero-ctas"><a href="#quote" class="btn-primary">Get Free Quote</a>
<a href="sms:{PHONE}?body=Hi!%20I%20need%20{c['service'].replace(' ', '%20')}%20in%20{c['city']}." class="btn-secondary">Text Photos for Estimate</a></div>
<div class="hero-trust"><span class="trust-badge">Flat-rate pricing</span><span class="trust-badge">Fully insured</span><span class="trust-badge">Same-day available</span><span class="trust-badge">No travel surcharge</span></div></div>
<div class="hero-ba"><div class="hero-ba-cell before"><span class="hero-ba-label">BEFORE</span><span class="hero-ba-icon">?</span></div>
<div class="hero-ba-cell after"><span class="hero-ba-label">AFTER</span><span class="hero-ba-icon">✓</span></div></div></div></header>"""
    local = f"""<section class="local"><div class="wrap"><div class="section-head reveal"><span class="mono section-num">{c["city"]} neighborhoods</span>
<h2 class="section-title">We know <em>{c["city"]}</em></h2><p class="neighborhoods reveal">{c["neighborhoods"]}</p></div></div></section>"""
    related = related_html(c.get("related", [
        (c["related_city"], c["related_label"]),
        ("/garage-cleanouts-fort-collins-co.html", "Fort Collins Garage Cleanouts"),
        ("/junk-removal-fort-collins-co.html", "Fort Collins Junk Removal"),
        ("/projects/fort-collins-garage-cleanout-old-town.html", "Sample Project"),
        ("/", "Home"),
    ]))
    body = "<main>" + "\n".join([
        hero,
        body_copy_html(c.get("body_copy", "")),
        fmt(PROCESS_HTML),
        fmt(PRICING_HTML),
        local,
        faq_html(c["faqs"]),
        GALLERY_HTML.format(ba1=f"{c['city']} job 1", ba2=f"{c['city']} job 2", ba3=f"{c['city']} job 3"),
        related,
        quote_form_for(c["service"], cta_title=f"Book {c['service']} in {c['city']} <em>today</em>", form_subject=f"{c['service'].title()} Quote - {c['city']}", city_default=c["city"], sms_body=f"Hi!%20I%20need%20{c['service'].replace(' ', '%20')}%20in%20{c['city']}."),
    ]) + "</main>"
    return page_shell(c["title"], c["desc"], canonical, schema, body)


def render_project(p):
    slug = p["slug"]
    canonical = f"{SITE}/{slug}"
    schema = json.dumps([
        {"@context": "https://schema.org", "@type": "Article", "headline": p["h1"], "description": p["desc"], "url": canonical, "author": {"@type": "Person", "name": "Zac Bezenek"}},
        {"@context": "https://schema.org", "@type": "ImageObject", "contentUrl": f"{SITE}/og-image.png", "description": f"Before/after placeholder — {p['h1']}"},
    ], ensure_ascii=False)
    content = f"""<main><section class="hero"><div class="wrap">
<h1 class="hero-title" style="max-width:none">{esc(p["h1"])}</h1>
<p class="hero-sub">{p["desc"]}</p>
<p class="mono" style="color:var(--accent-deep);margin-top:12px;">PLACEHOLDER CASE STUDY — swap photos when available</p>
</div></section>
{body_copy_html(p.get("body_copy", ""))}
<section class="process"><div class="wrap">
<div class="section-head"><span class="mono section-num">Project details</span><h2 class="section-title">Job <em>summary</em></h2></div>
<div class="steps"><div class="step"><div class="step-num">Location</div><h3>{esc(p["city"])} — {esc(p["neighborhood"])}</h3><p>Service type: {esc(p["job_type"])}</p></div>
<div class="step"><div class="step-num">Timeline</div><h3>{esc(p["time"])}</h3><p>Same-day completion from quote to clear space.</p></div>
<div class="step"><div class="step-num">Result</div><h3>Client parked inside same day</h3><p>{p["result"]}</p></div></div>
</div></section>
{GALLERY_HTML.format(ba1="Before — placeholder", ba2="After — placeholder", ba3="Detail — placeholder")}
<section class="items"><div class="wrap"><div class="section-head"><span class="mono section-num">Scope</span><h2 class="section-title">Customer <em>problem</em></h2><p class="section-sub">{p["problem"]}</p>
<h2 class="section-title" style="margin-top:32px">What we <em>removed</em></h2><p class="section-sub">{p["removed"]}</p></div></div></section>
{related_html(p.get("related", [("/garage-cleanouts-fort-collins-co.html", "Garage Cleanouts"), ("/junk-removal-fort-collins-co.html", "Junk Removal"), ("/", "Home")]))}
{fmt(PRICING_HTML)}
{quote_form_for(p["job_type"], cta_title="Get a quote like this <em>for your home</em>", form_subject=f"Project Inquiry - {p['city']}", city_default=p["city"], sms_body="Hi!%20I%20saw%20your%20project%20page%20and%20need%20a%20quote.")}
</main>"""
    return page_shell(p["title"], p["desc"], canonical, f'<script type="application/ld+json">{schema}</script>', content)


def render_item_page(item):
    from _services_data import NO_ITEMS
    slug = item["slug"]
    canonical = f"{SITE}/{slug}"
    schema = f'<script type="application/ld+json">{service_schema(item["h1"], item["desc"], slug, item["stype"])}</script>\n<script type="application/ld+json">{faq_schema(item["faqs"])}</script>'
    hero = f"""<header class="hero" id="top"><div class="wrap"><div class="hero-eyebrow mono">Fort Collins, CO</div>
<h1 class="hero-title" style="max-width:none">{esc(item["h1"])}</h1>
<p class="hero-sub">{item["hero_sub"]}</p>
<div class="hero-ctas"><a href="#quote" class="btn-primary">Get Free Quote</a>
<a href="sms:{PHONE}?body={item['sms'].replace(' ', '%20')}" class="btn-secondary">Text Photos</a></div></div></header>"""
    body = "<main>" + "\n".join([
        hero,
        body_copy_html(item.get("body_copy", "")),
        fmt(PROCESS_HTML),
        items_html(item["yes_title"], item["yes"], NO_ITEMS),
        fmt(PRICING_HTML),
        faq_html(item["faqs"]),
        related_html(item["related"]),
        quote_form_for(item["stype"], cta_title=item["cta"], form_subject=item["form_subject"], sms_body=item["sms"].replace(" ", "%20")),
    ]) + "</main>"
    return page_shell(item["title"], item["desc"], canonical, schema, body)


def render_comparison(cmp):
    slug = cmp["slug"]
    canonical = f"{SITE}/{slug}"
    schema = f'<script type="application/ld+json">{faq_schema(cmp.get("faqs", []))}</script>' if cmp.get("faqs") else ""
    article = f"""<main><article class="article-wrap">
<header class="hero"><div class="hero-eyebrow mono">Fort Collins Guide</div>
<h1 class="hero-title" style="max-width:none">{esc(cmp["h1"])}</h1>
<p class="hero-sub">{cmp["intro"]}</p>
<div class="hero-ctas" style="margin-top:20px"><a href="#quote" class="btn-primary">Get Free Quote</a></div>
</header>
<div class="article-body reveal">
{cmp["content"]}
<p><strong>Ready to reclaim your garage?</strong> Text photos to <a href="sms:{PHONE}" class="content-link">{PHONE_DISPLAY}</a> or <a href="#quote" class="content-link">request a flat-rate quote</a>. Response within 5 minutes.</p>
</div>
</article>
{related_html(cmp.get("related", [("/garage-cleanouts-fort-collins-co.html", "Garage Cleanouts"), ("/junk-removal-fort-collins-co.html", "Junk Removal"), ("/blog/", "More Guides")]))}
{quote_form_for("Garage Cleanout", cta_title="Get your <em>Fort Collins quote</em>", form_subject=f"Comparison Page - {cmp['h1'][:40]}", city_default="Fort Collins", sms_body="Hi!%20I%20read%20your%20comparison%20guide%20and%20need%20a%20quote.")}
</main>"""
    return page_shell(cmp["title"], cmp["desc"], canonical, schema, article, og_type="article")


def render_book():
    title = "Book Garage Cleanout or Junk Removal | Fort Collins CO"
    desc = "Book your garage cleanout or junk removal in Fort Collins. Choose service, location, upload photos, and get a flat-rate quote in 5 minutes."
    canonical = f"{SITE}/book.html"
    schema = f"""<script type="application/ld+json">{json.dumps(business_schema(), ensure_ascii=False)}</script>
<script type="application/ld+json">{howto_schema()}</script>"""
    body = f"""<main>
<section class="hero"><div class="wrap">
<div class="hero-eyebrow mono">Book online</div>
<a href="tel:{PHONE}" class="hero-phone">{PHONE_DISPLAY}<span class="hero-phone-sub">· 5-min quote response</span></a>
<h1 class="hero-title" style="max-width:none">Book your <em>garage reclaiming</em> service</h1>
<p class="hero-sub">Choose what you need, tell us where you are, upload photos, and we'll call back with a flat-rate price — no obligation, no hidden fees.</p>
</div></section>
{fmt(PROCESS_HTML)}
{quote_form_for("Garage Cleanout", cta_title="Complete your <em>free quote</em>", form_subject="Book Page Quote Request", sms_body="Hi!%20I'm%20booking%20on%20your%20website%20and%20need%20a%20quote.")}
</main>"""
    return page_shell(title, desc, canonical, schema, body, quote_href="#quote")


def render_about():
    title = "About Easy Garage Cleaning | Zac Bezenek, Fort Collins"
    desc = "Meet Zac Bezenek — CSU student-run garage reclaiming specialist in Fort Collins. Local roots, flat-rate quotes, owner on every job."
    canonical = f"{SITE}/about.html"
    schema = json.dumps([
        business_schema(),
        {"@context": "https://schema.org", "@type": "Person", "name": "Zac Bezenek", "jobTitle": "Owner", "worksFor": {"@type": "LocalBusiness", "@id": f"{SITE}/#business"}, "url": canonical, "email": "contact@easygaragecleaning.com"},
    ], ensure_ascii=False)
    body = f"""<main>
<section class="hero"><div class="wrap hero-grid"><div>
<div class="hero-eyebrow mono">About us</div>
<a href="tel:{PHONE}" class="hero-phone">{PHONE_DISPLAY}<span class="hero-phone-sub">· Owner on every job</span></a>
<h1 class="hero-title">Garage reclaiming, <em>built in Fort Collins</em></h1>
<p class="hero-sub">Easy Garage Cleaning isn't a franchise call center — it's Zac Bezenek and a local crew helping Northern Colorado homeowners park in their garage again.</p>
<div class="hero-ctas"><a href="#quote" class="btn-primary">Get Free Quote</a><a href="tel:{PHONE}" class="btn-secondary">Call {PHONE_DISPLAY}</a></div>
</div>
<div class="hero-ba"><div class="hero-ba-cell before" style="grid-column:span 2;aspect-ratio:16/10"><span class="hero-ba-label">PHOTO</span><span class="hero-ba-icon">Truck</span></div></div>
</div></section>
<section class="body-copy"><div class="wrap"><div class="body-copy-inner reveal">
<h2>Zac's story</h2>
<p>I'm Zac Bezenek — a Colorado State University student and Northern Colorado native. I started Easy Garage Cleaning because I kept seeing neighbors park outside in hail and snow while their garages filled with stuff they'd deal with "someday."</p>
<p>We're not generic junk haulers. We specialize in <strong>garage reclaiming</strong> — emptying the space, donating what's usable to <a href="/blog/habitat-for-humanity-restore-fort-collins.html" class="content-link">Habitat ReStore Fort Collins</a>, sweeping the floor, and handing you keys to a garage that works again.</p>
<h2>Why we exist</h2>
<p>Franchise haulers charge hourly and surprise you at the end. We quote flat from photos, respond within 5 minutes, and only start after you approve. No hidden fees. We do all the lifting.</p>
<h2>Local roots &amp; professionalism</h2>
<p>Colorado-registered LLC. General liability and commercial auto insurance on every job. Owner on site — you'll know exactly who's coming to your home.</p>
<p>Community involvement: donation partner with Habitat ReStore, supporter of local recycling, and proud to serve Fort Collins, Loveland, Windsor, and surrounding towns.</p>
</div></div></section>
{VIDEO_HTML}
{fmt(PRICING_HTML)}
{quote_form_for("Garage Cleanout", cta_title="Reclaim your garage <em>today</em>", form_subject="About Page Quote", sms_body="Hi!%20I%20visited%20your%20about%20page%20and%20need%20a%20quote.")}
</main>"""
    return page_shell(title, desc, canonical, f'<script type="application/ld+json">{schema}</script>', body)


def generate_sitemap(urls):
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for loc, priority in urls:
        lines += [f"  <url><loc>{loc}</loc><lastmod>{TODAY}</lastmod><changefreq>monthly</changefreq><priority>{priority}</priority></url>"]
    lines.append("</urlset>")
    (ROOT / "sitemap.xml").write_text("\n".join(lines) + "\n", encoding="utf-8")


def patch_static_pages():
    trust = fmt("""<div class="trust-strip" aria-label="Trust signals">
  <div class="wrap trust-strip-inner">
    <span>Response within 5 minutes</span><span>No hidden fees</span><span>Only pay after approving quote</span><span>We do all lifting</span><span>Text photos now</span><span>Same-day availability</span>
  </div>
</div>""")
    unified_nav = fmt(NAV, quote_href="/#quote", service_areas_href="/#service-area", reviews_href="/#reviews")
    sticky = fmt("""<div class="mobile-sticky-cta" aria-label="Quick contact">
  <a href="tel:{phone}" class="mobile-cta-btn mobile-cta-call">Call</a>
  <a href="sms:{phone}?body=Hi!%20I'd%20like%20a%20quote." class="mobile-cta-btn mobile-cta-text">Text</a>
  <a href="{quote_href}" class="mobile-cta-btn mobile-cta-quote">Quote</a>
</div>""", quote_href="/#quote")
    sticky_css = "<style>@media(max-width:1023px){.mobile-sticky-cta{position:fixed;bottom:0;left:0;right:0;z-index:100;display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;background:#0a1628;border-top:1px solid rgba(255,255,255,.08);padding:8px 10px 12px}body{padding-bottom:72px}}</style>"
    patterns = ["index.html", "faq.html", "about.html", "book.html", "blog/*.html", "loveland-garage-cleanout.html", "windsor-garage-cleanout.html", "wellington-junk-removal.html", "timnath-junk-removal.html", "old-town-fort-collins-junk-removal.html", "privacy-policy.html", "thank-you.html", "employee.html", "ads.html"]
    for pattern in patterns:
        for path in ROOT.glob(pattern):
            text = path.read_text(encoding="utf-8")
            orig = text
            if 'class="trust-strip"' not in text and '<nav class="nav"' in text:
                text = re.sub(r"(</nav>\s*)", r"\1\n" + trust + "\n", text, count=1)
            if '<nav class="nav"' in text and 'Service Areas' not in text:
                text = re.sub(r"<nav class=\"nav\"[\s\S]*?</nav>", unified_nav.strip(), text, count=1)
            if 'mobile-sticky-cta' not in text:
                text = text.replace('</body>', sticky + sticky_css + '\n</body>')
            elif 'mobile-cta-quote">Get Quote</a>' in text:
                text = text.replace('mobile-cta-quote">Get Quote</a>', 'mobile-cta-quote">Quote</a>')
            if GA4_ID not in text:
                had_aw = 'AW-18102284288' in text
                for pat in (
                    r"<!-- Google tag \(gtag\.js\) -->[\s\S]*?</script>\s*",
                    r"<script async src=\"https://www\.googletagmanager\.com/gtag/js\?id=[^\"]+\"></script>\s*"
                    r"<script>[\s\S]*?</script>\s*",
                ):
                    text = re.sub(pat, "", text, count=1)
                block = GTAG_BLOCK if had_aw else GTAG_BLOCK.replace(
                    "  gtag('config', 'AW-18102284288');\n", ""
                )
                text = re.sub(r"(<head[^>]*>\s*\n)", r"\1" + block + "\n", text, count=1, flags=re.I)
            if text != orig:
                path.write_text(text, encoding="utf-8")


def main():
    from _services_data import SERVICES, CITIES, PROJECTS, ITEM_PAGES, COMPARISON_PAGES

    generated = []
    sitemap_urls = [(f"{SITE}/", "1.0"), (f"{SITE}/about.html", "0.8"), (f"{SITE}/book.html", "0.9")]

    for s in SERVICES:
        (ROOT / s["slug"]).write_text(render_service(s), encoding="utf-8")
        generated.append(s["slug"])
        sitemap_urls.append((f"{SITE}/{s['slug']}", "0.9"))

    for c in CITIES:
        (ROOT / c["slug"]).write_text(render_city(c), encoding="utf-8")
        generated.append(c["slug"])
        sitemap_urls.append((f"{SITE}/{c['slug']}", "0.9"))

    (ROOT / "projects").mkdir(exist_ok=True)
    for p in PROJECTS:
        path = ROOT / p["slug"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(render_project(p), encoding="utf-8")
        generated.append(p["slug"])
        sitemap_urls.append((f"{SITE}/{p['slug']}", "0.6"))

    for item in ITEM_PAGES:
        (ROOT / item["slug"]).write_text(render_item_page(item), encoding="utf-8")
        generated.append(item["slug"])
        sitemap_urls.append((f"{SITE}/{item['slug']}", "0.8"))

    (ROOT / "blog").mkdir(exist_ok=True)
    for cmp in COMPARISON_PAGES:
        path = ROOT / cmp["slug"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(render_comparison(cmp), encoding="utf-8")
        generated.append(cmp["slug"])
        sitemap_urls.append((f"{SITE}/{cmp['slug']}", "0.7"))

    (ROOT / "about.html").write_text(render_about(), encoding="utf-8")
    generated.append("about.html")

    (ROOT / "book.html").write_text(render_book(), encoding="utf-8")
    generated.append("book.html")

    blog_posts = list(ROOT.glob("blog/*.html"))
    for bp in blog_posts:
        if bp.name != "index.html":
            sitemap_urls.append((f"{SITE}/blog/{bp.name}", "0.7"))
    sitemap_urls += [(f"{SITE}/blog/", "0.8"), (f"{SITE}/faq.html", "0.8"), (f"{SITE}/privacy-policy.html", "0.3"), (f"{SITE}/llms.txt", "0.5"), (f"{SITE}/ai.txt", "0.5")]

    generate_sitemap(sitemap_urls)
    patch_static_pages()

    print("Generated:", len(generated), "pages")
    for g in generated:
        print(" ", g)


if __name__ == "__main__":
    main()
