"""Public-site experience, applied after legacy page generation.

Keep the public presentation independent of quoting and staff workflows. Existing
approved pricing is preserved rather than duplicated into a second source.
"""
import hashlib
import html
import json
import re


SERVICES = [
    ('01', 'The whole garage', 'One plan for the cleanout, storage, organization and cleaning.', '/garage-turnaround-fort-collins-co', 'Explore garage turnaround'),
    ('02', 'Clear the clutter', 'Keep what matters. Let our crew carry out what no longer belongs.', '/garage-cleanouts-fort-collins-co', 'Explore garage cleanouts'),
    ('03', 'Give everything a place', 'Build useful storage zones around your tools, gear and everyday life.', '/garage-organization-fort-collins-co', 'Explore garage organization'),
    ('04', 'Just the junk', 'Furniture, appliances or a bigger load. Find the right removal service.', '/junk-removal-fort-collins-co', 'Explore junk removal'),
]

GUIDES = {
    'garage-cleanouts-fort-collins-co.html': ('What a garage cleanout can include', 'Start with what you want the garage to do.', [
        ('A clear keep / remove plan', 'Walk the space with us and identify what stays, what goes and anything that needs special care. You stay in control of those decisions.'),
        ('The lifting and haul-out', 'We plan the carrying route, load the approved items and include the agreed hauling and disposal in your flat-rate scope.'),
        ('A usable next step', 'A clear-out and floor sweep may be all you need. If storage, organization or deeper cleaning would help, include them in your walkthrough plan.')], '/blog/how-to-prepare-for-garage-cleanout', 'How to prepare for your cleanout'),
    'garage-cleaning-fort-collins-co.html': ('Garage cleaning, explained', 'Clear space is only the beginning.', [
        ('Agree on the surfaces', 'Show us the floors, shelves and accessible surfaces you want cleaned. We confirm the tasks and access before quoting the work.'),
        ('Make room to clean', 'A garage packed with stored belongings may need sorting or a cleanout first. Your plan makes that order clear before the crew arrives.'),
        ('Set the right expectations', 'Tell us about oil stains, peeling coatings or anything unusual. Cleaning is not the same as floor repair or restoration; confirm what can be addressed during the walkthrough.')], '/garage-cleanouts-fort-collins-co', 'Need to clear the space first?'),
    'garage-organization-fort-collins-co.html': ('Organization built around your routine', 'A place for the car. A place for everything else.', [
        ('Plan the parking and walkways', 'Start with the space you need to move around the car, open doors and reach everyday items. Storage works around that layout.'),
        ('Create practical zones', 'Group tools, sports gear, seasonal items and household supplies by how you use them. Keep frequent-use items easy to reach.'),
        ('Choose the right storage', 'Review shelving, bins and wall storage in your plan. We agree on products and installation scope before adding them to the job.')], '/blog/garage-organizing-ideas-two-car-garage', 'See two-car garage organization ideas'),
    'garage-turnaround-fort-collins-co.html': ('One coordinated garage turnaround', 'Four parts. One plan for your space.', [
        ('Remove and reset', 'Decide what no longer belongs, then clear the approved items so the garage has room for its new layout.'),
        ('Store and organize', 'Choose storage that fits your belongings and create zones for the things you use, instead of rebuilding the same piles.'),
        ('Clean and walk it together', 'Finish the agreed cleaning tasks and review the result with the crew. Your walkthrough quote defines the complete scope.')], '/projects/', 'See photos of our work'),
    'junk-removal-fort-collins-co.html': ('Choose the right kind of junk removal', 'A few items or a full clear-out.', [
        ('Tell us what needs to go', 'Furniture, appliances, boxes and garage clutter each create a different load. Include bulky items and unusual materials when describing the job.'),
        ('Show us the access', 'Stairs, narrow doorways and carrying distance affect how the crew handles the work. Confirm the route and scope before the removal.'),
        ('Check items before booking', 'Not every material can go in the truck. Review accepted items and ask about paint, chemicals, fuel, batteries or anything that needs special handling.')], '/what-we-take', 'Check what we take'),
    'furniture-removal-fort-collins-co.html': ('Make room without moving it yourself', 'Furniture removal starts with a clear route.', [
        ('Identify the pieces', 'Tell us about sofas, sectionals, dressers, tables and any pieces that are unusually heavy or may need disassembly.'),
        ('Plan the carry-out', 'Show us stairs, corners and doorways. The walkthrough lets us plan how the furniture leaves the property.'),
        ('Agree on the destination', 'Reusable furniture may be suitable for donation, subject to condition and local acceptance. The plan also covers items that cannot be donated.')], '/what-we-take', 'See accepted items and exceptions'),
    'appliance-removal-fort-collins-co.html': ('Before an appliance leaves your home', 'Get the details right before pickup.', [
        ('Identify the appliance', 'Tell us the type, approximate size and current location. Refrigerators and other appliances can need different disposal handling.'),
        ('Confirm disconnection', 'Ask what must be disconnected before the crew arrives. Gas, water and electrical work should be handled by the appropriate qualified professional.'),
        ('Clear the access route', 'Point out stairs and tight doorways. Remove personal contents and confirm the agreed pickup scope with the team.')], '/blog/what-to-do-with-old-appliances-fort-collins', 'Read the local appliance guide'),
    'storage-unit-cleanout-fort-collins-co.html': ('A clear plan for the storage unit', 'Keep the essentials. Reclaim the space.', [
        ('Sort what stays', 'Identify the belongings you want to keep before the haul-out. Set aside documents, valuables and personal items.'),
        ('Confirm facility access', 'Check gate hours, access permissions, elevator rules and where the truck may park. Share those details with the team.'),
        ('Review the whole unit', 'A walkthrough accounts for the amount of material and carrying route so the approved scope is clear before work starts.')], '/blog/garage-cleanout-vs-storage-unit-fort-collins', 'Compare a cleanout and continued storage'),
}


def _cards():
    return ''.join(f'<a class="egc-path" href="{url}"><span class="egc-path-number">{num}</span><h3>{title}</h3><p>{desc}</p><span class="egc-path-link">{cta} <span aria-hidden="true">↗</span></span></a>' for num, title, desc, url, cta in SERVICES)


def _photo(name, alt, caption, widths=(824, 1080, 1646), height=615, wide=False):
    sources = ', '.join('/images/' + name + (f'-{w}' if w != widths[-1] else '') + f'.webp {w}w' for w in widths)
    sizes = '(min-width: 1240px) 1160px, calc(100vw - 40px)' if wide else '(min-width: 1240px) 565px, (min-width: 768px) 48vw, calc(100vw - 40px)'
    return f'<figure class="egc-project-photo"><picture><source type="image/webp" srcset="{sources}" sizes="{sizes}"><img src="/images/{name}.jpg" alt="{alt}" width="{widths[-1]}" height="{height}" loading="lazy" decoding="async"></picture><figcaption>{caption}</figcaption></figure>'


def _home(text):
    title = 'Garage Cleanouts in Fort Collins | Easy Garage Cleaning'
    description = 'Garage cleanouts, organization and junk removal in Fort Collins and Northern Colorado. Start with a free on-site walkthrough and one clear, flat-rate plan.'
    text = re.sub(r'<title>[^<]*</title>', '<title>' + title + '</title>', text, count=1)
    for names, content in [('description|og:description|twitter:description', description), ('og:title|twitter:title', title)]:
        text = re.sub(r'(<meta\s+(?:name|property)="(?:' + names + r')"\s+content=")[^"]*(")', lambda m: m.group(1) + html.escape(content, quote=True) + m.group(2), text)
    # Preserve the approved responsive hero, public photo gallery and pricing copy.
    hero = re.search(r'<figure class="hero-result">[\s\S]*?</figure>', text)
    gallery = re.search(r'<section class="gallery" id="work"[\s\S]*?</section>', text)
    pricing = re.search(r'<section class="pricing" id="pricing"[\s\S]*?</section>', text)
    if not (hero and gallery and pricing):
        raise ValueError('Homepage overhaul requires the existing hero, gallery and pricing sections')
    gallery_html = gallery.group(0).replace('Before. <em>After.</em> Same garage, same day.', 'Less clutter. <em>More possibility.</em>')
    gallery_html = re.sub(r'\s*<div class="wrap(?: egc-gallery-actions)?" style="padding-top:24px">[\s\S]*?</div>', '', gallery_html)
    gallery_html = gallery_html.replace('</section>', '<div class="wrap egc-gallery-actions" style="padding-top:24px"><a class="btn-primary" href="/projects/" data-gallery-cta="projects">See more of our work →</a><a class="egc-text-link" href="/before-after">Explore garage before &amp; after ideas →</a></div>\n</section>')
    body = f'''<main id="main-content">
<header class="hero hero-premium egc-home-hero" id="top">
  <div class="wrap hero-grid">
    <div class="egc-hero-copy"><div class="hero-eyebrow mono">Garage cleanouts · Fort Collins, Colorado</div>
      <h1 class="hero-title">Room for your car.<br><em>And your life.</em></h1>
      <p class="hero-sub">We remove the junk, plan the storage, organize what stays and clean the space. One local crew to help you take your garage back.</p>
      <div class="hero-ctas"><a class="btn-primary" href="/book" data-cta="hero-plan">Request Free Walkthrough <span aria-hidden="true">↗</span></a></div>
      <p class="hero-contact">Talk through your project: <a href="tel:+19709991818">(970) 999-1818</a></p>
      <ul class="egc-assurance" aria-label="Your walkthrough"><li>Free on-site plan</li><li>Price approved first</li><li>Locally owned &amp; insured</li></ul>
    </div>
    <div class="hero-visual">{hero.group(0)}<div class="egc-photo-note"><span class="egc-dot" aria-hidden="true"></span><p>Start with the space you have.<br><strong>Build the garage you need.</strong></p></div></div>
  </div>
</header>
<section class="egc-paths" id="services" aria-labelledby="services-heading"><div class="wrap"><div class="egc-section-heading"><div><span class="mono section-num">Find your starting point</span><h2 class="section-title" id="services-heading">What would make the<br><em>biggest difference?</em></h2></div><p>You do not need to figure out every detail. Start with the result you want; we will build the plan together.</p></div><div class="egc-path-grid">{_cards()}</div><p class="egc-inline-links">Also helping with <a href="/garage-cleaning-fort-collins-co">garage cleaning</a>, <a href="/furniture-removal-fort-collins-co">furniture</a>, <a href="/appliance-removal-fort-collins-co">appliances</a> and <a href="/storage-unit-cleanout-fort-collins-co">storage units</a>.</p></div></section>
{gallery_html}
<section class="egc-process" id="process" aria-labelledby="process-heading"><div class="wrap"><div class="egc-section-heading"><div><span class="mono section-num">A complete garage plan</span><h2 class="section-title" id="process-heading">Four steps.<br><em>One accountable crew.</em></h2></div><p>Your garage may need all four, or just a few. Your approved scope decides what we do.</p></div><ol class="egc-steps"><li><span>01</span><h3>Remove</h3><p>Clear out the unwanted items and make room to work.</p></li><li><span>02</span><h3>Store</h3><p>Choose shelving and storage that fit the space and the things you keep.</p></li><li><span>03</span><h3>Organize</h3><p>Give tools, seasonal items and everyday gear a practical home.</p></li><li><span>04</span><h3>Clean</h3><p>Finish the agreed cleaning tasks and walk through the result together.</p></li></ol><a class="egc-text-link" href="/garage-turnaround-fort-collins-co">See what a full turnaround includes <span aria-hidden="true">→</span></a></div></section>
{pricing.group(0)}
<section class="egc-local" aria-labelledby="egc-local-heading"><div class="wrap egc-two-column"><div><span class="mono section-num">Your local garage crew</span><h2 class="section-title" id="egc-local-heading">Based in Fort Collins.<br><em>Built around your home.</em></h2><p>We work with homeowners across Northern Colorado. Tell us where you are and what you want to change; we will confirm the service and availability for your address.</p><a class="egc-text-link" href="/about">Meet Easy Garage Cleaning →</a></div><div class="egc-area-panel"><h3>Explore your service area</h3><div class="egc-area-links"><a href="/garage-cleanouts-fort-collins-co">Fort Collins ↗</a><a href="/garage-cleanouts-loveland-co">Loveland ↗</a><a href="/garage-cleanouts-windsor-co">Windsor ↗</a><a href="/garage-cleanouts-wellington-co">Wellington ↗</a><a href="/timnath-junk-removal">Timnath ↗</a><a href="/service-areas">All service areas ↗</a></div><p>See independent feedback on our <a href="/reviews">reviews page</a>.</p></div></div></section>
<section class="egc-home-faq" aria-labelledby="faq-heading"><div class="wrap egc-two-column"><div><span class="mono section-num">Before we get started</span><h2 class="section-title" id="faq-heading">A clearer plan.<br><em>Fewer unknowns.</em></h2><p>More details in our <a href="/faq">frequently asked questions</a>.</p></div><div>
<details class="home-details"><summary>Do I need to empty the garage first?</summary><p>No. The walkthrough is a chance to see the space as it is. Point out anything you want to keep, valuables and items that need special care. We agree on sorting and removal responsibilities in the plan.</p></details>
<details class="home-details"><summary>How do you price a garage project?</summary><p>We review the amount of material, access, cleaning and any storage work at a free on-site walkthrough. You approve one flat-rate scope before work begins. <a href="/pricing">See the pricing guide</a>.</p></details>
<details class="home-details"><summary>What is the No-Surprise Quote Guarantee?</summary><p>If the job matches the scope approved during the walkthrough, your quoted price is locked. No hourly add-ons, no "we found more than expected" fees at the end. If something unexpected comes up, we talk to you first.</p></details>
<details class="home-details"><summary>Can you just pick up a few items?</summary><p>Yes. Start with our <a href="/junk-removal-fort-collins-co">junk removal service</a>. If you can stage a small load outside, check the separate <a href="/flat-rate-junk-removal-fort-collins-co">curbside pickup option</a> and its current terms.</p></details>
<details class="home-details"><summary>What happens to the items you remove?</summary><p>We identify reusable items that may be accepted by local donation partners and plan disposal for the rest. Condition and acceptance rules matter. <a href="/what-we-take">Check accepted items and exceptions</a>.</p></details>
</div></div></section>
<section class="final-cta home-request egc-final" id="quote" aria-labelledby="cta-heading"><div class="wrap"><span class="mono section-num">The first step is simple</span><h2 id="cta-heading">Let’s see what your<br><em>garage could be.</em></h2><p>A free walkthrough. A practical plan. A clear price before you commit.</p><a class="btn-primary" href="/book" data-cta="final-walkthrough">Request Free Walkthrough ↗</a></div></section>
</main>'''
    text = re.sub(r'<main\b[^>]*>[\s\S]*?</main>', lambda _: body, text, count=1)
    text = text.replace('class="home-simple"', 'class="home-simple home-overhaul"')
    # The old FAQ and booking tutorial no longer describe the visible homepage.
    # Keep business, service, breadcrumb and page entities; omit stale rich-result markup.
    def current_schema(match):
        try:
            value = json.loads(match.group(1))
        except ValueError:
            return match.group(0)
        return '' if isinstance(value, dict) and value.get('@type') in ('FAQPage', 'HowTo') else match.group(0)
    text = re.sub(r'\s*<script type="application/ld\+json">([\s\S]*?)</script>', current_schema, text)
    return text


def _guide(path):
    title, lead, rows, href, label = GUIDES[path]
    cards = ''.join(f'<article><span class="egc-step-number">0{i}</span><h3>{h}</h3><p>{d}</p></article>' for i, (h, d) in enumerate(rows, 1))
    return f'<section class="egc-service-guide" id="service-guide" aria-labelledby="service-guide-heading"><div class="wrap"><span class="mono section-num">Know what to expect</span><h2 class="section-title" id="service-guide-heading">{title}</h2><p class="section-sub">{lead}</p><div class="egc-guide-grid">{cards}</div><div class="egc-guide-footer"><a class="egc-text-link" href="{href}">{label} →</a><a class="btn-primary" href="/book">Plan my project ↗</a></div></div></section>'


def _projects(text):
    photos = _photo('job-before-after-1', 'Garage before and after an Easy Garage Cleaning cleanout', 'Before and after · Garage cleanout', wide=True) + _photo('job-before-after-2', 'A second garage before and after an Easy Garage Cleaning cleanout', 'Before and after · Another garage reset') + _photo('job-pile', 'Outdoor pile of items ready for junk removal', 'Before pickup · A junk removal load', widths=(600, 1000), height=750)
    body = f'''<main id="main-content"><section class="hero egc-projects-hero"><div class="wrap"><span class="hero-eyebrow mono">Photos from our work</span><h1 class="hero-title">Real spaces.<br><em>A fresh start.</em></h1><p class="hero-sub">See garages we have helped clear and reset in Northern Colorado. Every project starts with the space you have and the result you want.</p><div class="hero-ctas"><a class="btn-primary" href="/book">Request Free Walkthrough ↗</a></div></div></section><section class="egc-projects-section" aria-labelledby="project-photos-heading"><div class="wrap"><h2 id="project-photos-heading" class="section-title">A look at <em>the work.</em></h2><p class="section-sub">Cleanouts, cleared space and loads ready to leave.</p><div class="egc-project-grid">{photos}</div><p class="egc-photo-disclosure">Your walkthrough sets the scope: what leaves, what stays, and how you want to use the space.</p></div></section><section class="egc-paths" aria-labelledby="project-next-heading"><div class="wrap"><h2 class="section-title" id="project-next-heading">What does <em>your space need?</em></h2><div class="egc-path-grid">{_cards()}</div></div></section><section class="final-cta egc-final"><div class="wrap"><h2 class="section-title">Picture your <em>next chapter.</em></h2><p>Start with a free walkthrough and a plan for your garage.</p><a class="btn-primary" href="/book">Let’s plan your project ↗</a></div></section></main>'''
    # The Pages Function inserts only consent-approved stories at this marker.
    # Keep that independent publishing path usable alongside the static photos.
    stories = re.search(r'<div class="project-cards[^\"]*" id="dynamic-projects">([\s\S]*?)</div>', text)
    published = stories.group(1) if stories else '<!-- DYNAMIC_PROJECTS -->'
    published = re.sub(r'<article class="project-card reveal" id="projects-empty">[\s\S]*?</article>', '', published)
    story_section = '<section class="egc-published-projects" aria-label="Customer-approved project stories"><div class="wrap"><div class="project-cards" id="dynamic-projects">' + published + '</div></div></section>'
    body = body.replace('<section class="egc-paths"', story_section + '<section class="egc-paths"', 1)
    return re.sub(r'<main\b[^>]*>[\s\S]*?</main>', lambda _: body, text, count=1)


def apply_public_experience(text, relative_path, root):
    path = str(relative_path).replace('\\', '/')
    # Remove a prior pass before applying the current page policy.
    text = re.sub(r'\s*<link rel="stylesheet" href="/public-experience\.css\?v=[^"]+">', '', text)
    def clean_body(match):
        return re.sub(r'class="([^"]*)"', lambda c: 'class="' + ' '.join(word for word in c.group(1).split() if word not in ('egc-public', 'home-overhaul')) + '"', match.group(0))
    text = re.sub(r'<body\b[^>]*>', clean_body, text, count=1)
    is_article = path.startswith('blog/') and path != 'blog/index.html'
    if path not in ('index.html', 'projects/index.html') and path not in GUIDES and not is_article:
        return text
    # A private workflow must never acquire public marketing presentation.
    if re.search(r'<meta\b[^>]*name=["\']robots["\'][^>]*content=["\'][^"\']*noindex', text, re.I):
        return text
    version = hashlib.sha256((root / 'public-experience.css').read_bytes()).hexdigest()[:12]
    text = text.replace('</head>', f'<link rel="stylesheet" href="/public-experience.css?v={version}">\n</head>', 1)
    text = re.sub(r'<body([^>]*)>', lambda m: '<body' + (re.sub(r'class="([^"]*)"', lambda c: 'class="' + c.group(1).replace(' egc-public', '') + ' egc-public"', m.group(1)) if 'class="' in m.group(1) else m.group(1) + ' class="egc-public"') + '>', text, count=1)
    if path == 'index.html':
        text = _home(text)
        text = text.replace('home-simple egc-public', 'home-simple home-overhaul egc-public')
    elif path == 'projects/index.html':
        text = _projects(text)
    elif path in GUIDES:
        text = re.sub(r'<section class="egc-service-guide"[\s\S]*?</section>\n?', '', text)
        text = re.sub(r'<nav class="egc-page-nav"[\s\S]*?</nav>', '', text)
        destinations = [('service-guide', 'What to expect'), ('pricing', 'Pricing'), ('faq', 'Common questions')]
        links = ''.join(f'<a href="#{target}">{label}</a>' for target, label in destinations if target == 'service-guide' or f'id="{target}"' in text)
        page_nav = '<nav class="egc-page-nav" aria-label="On this page"><div class="wrap"><span>On this page</span>' + links + '<a href="/book">Request a walkthrough →</a></div></nav>'
        text = text.replace('</header>', '</header>' + page_nav, 1)
        marker = re.search(r'<section\b[^>]*class="[^"]*pricing[^\"]*"', text)
        if marker:
            text = text[:marker.start()] + _guide(path) + '\n' + text[marker.start():]
        else:
            text = text.replace('</main>', _guide(path) + '</main>', 1)
    elif is_article:
        # Remove the empty decorative image and duplicate legacy-injected byline.
        # The first, authored byline remains; do not manufacture a fresh article date.
        text = re.sub(r'<div class="article-hero-strip[^\"]*"[^>]*>[\s\S]*?</div>\n?', '', text)
        bylines = list(re.finditer(r'<(div|p) class="article-meta[^\"]*"[^>]*>[\s\S]*?</\1>', text))
        for byline in reversed(bylines[1:]):
            text = text[:byline.start()] + text[byline.end():]
        text = re.sub(r'<aside class="egc-article-next"[\s\S]*?</aside>', '', text)
        service = '/garage-organization-fort-collins-co' if 'organiz' in path else '/junk-removal-fort-collins-co' if any(w in path for w in ('junk', 'appliance', 'donat', 'restore')) else '/garage-cleanouts-fort-collins-co'
        block = f'<aside class="egc-article-next" aria-label="Put this guide into practice"><div class="wrap"><div><span class="mono section-num">Put the plan into practice</span><h2>Want a hand with your garage?</h2><p>Get a local crew and a clear scope for the work you want done.</p></div><div class="egc-next-actions"><a class="btn-primary" href="/book">Request Free Walkthrough ↗</a><a class="egc-text-link" href="{service}">Explore the service →</a></div></div></aside>'
        if '</main>' in text:
            text = text.replace('</main>', block + '</main>', 1)
        else:
            text = text.replace('<footer', block + '<footer', 1)
    return text
