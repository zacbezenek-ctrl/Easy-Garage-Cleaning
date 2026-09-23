# Public before-and-after gallery

Requested: September 23, 2026. Publish the existing gallery on the customer-facing website.

Canonical route: `https://easygaragecleaning.com/before-after`.

The route is public and does not require Employee Hub authentication. It reuses all 24 existing generated pairs and 48 selected optimized WebP assets already available through the device-preview asset routes. It adds booking calls to action, main-site navigation, canonical/share metadata, structured data and search-engine index permission. The page identifies the collection as AI-generated design concepts rather than completed customer projects. The gallery's comparisons, search, full-size viewer, keyboard/pointer controls, mobile layout and no-JavaScript photo links are retained.

The existing `/internal/before-after` route and its server-side access controls remain unchanged. The device-test `/before-after-preview` route remains unchanged. No customer records, customer-approved stories, forms, payments, credentials, conversion events, or image-model billing settings are changed. No new image generation is required for this release.

The original provenance/review records are retained, not silently promoted: 17 pairs were reviewed earlier and seven remain pending in the source registry. The public gallery is a clearly identified inspiration collection; inclusion is not proof of an actual customer job, exact architectural fidelity, or an attainable identical outcome.

`tools/gallery/publish-links.py` makes narrow, idempotent updates to the homepage's desktop/mobile navigation, Company footer, gallery CTA and sitemap. It leaves all forms/scripts unchanged. The desktop Blog link is replaced by Before & After to avoid adding width; Blog remains in mobile navigation and the existing footer.

`EGC Public Gallery` prepares those deterministic link changes only on a same-repository `feat/gallery-live-*` branch and refuses a push when the branch has moved. Pull-request checks validate public routing, methods, metadata, the 48 selected files, preserved staff access and static discovery links. Preparation does not deploy main by itself; merge and live HTTP/browser verification are separate release steps.

Live acceptance: anonymous HTTP 200 at `/before-after`, correct release marker, 24 cards, 48 image files accessible without cookies, functioning search/sliders/full-size dialog, no horizontal overflow on desktop/390px/320px, valid booking links, homepage navigation and sitemap entry, and retained HTTP 401 for the private staff page. Record actual deployment and browser results in the release PR; do not infer success from a commit alone.
