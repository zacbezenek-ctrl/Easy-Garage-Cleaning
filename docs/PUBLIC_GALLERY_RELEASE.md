# Public before-and-after gallery

Requested: September 23, 2026. Publish the existing gallery on the customer-facing website.

Canonical route: `https://easygaragecleaning.com/before-after`.

The route is public and does not require Employee Hub authentication. It reuses all 24 existing generated pairs and 48 selected optimized WebP assets already available through the device-preview asset routes. It adds booking calls to action, main-site navigation, canonical/share metadata, structured data and search-engine index permission. The page identifies the collection as AI-generated design concepts rather than completed customer projects. Comparisons, search, full-size viewer, keyboard/pointer controls, mobile layout and no-JavaScript photo links are retained.

The existing `/internal/before-after` route and its server-side access controls remain unchanged. The device-test `/before-after-preview` route remains unchanged. No customer records, customer-approved stories, forms, payments, credentials, conversion events, or image-model billing settings are changed. No new image generation is required for this release.

The original provenance/review records are retained, not silently promoted: 17 pairs were reviewed earlier and seven remain pending in the source registry. This is an inspiration collection, not proof of an actual customer job, exact architectural fidelity, or an identical attainable outcome.

## Repeatable publication

`tools/gallery/publish-links.py` makes narrow, idempotent updates to the homepage's desktop/mobile navigation, Company footer, gallery CTA and sitemap. It leaves all forms/scripts unchanged. The desktop Blog link is replaced by Before & After to avoid adding width; Blog remains in mobile navigation and the existing footer.

`EGC Public Gallery` prepares these deterministic outputs only on a same-repository `feat/gallery-live-*` branch and refuses a push when that branch has moved. It also renders `before-after.html` directly from `renderPublicGallery()`. That identical static fallback supports static-only hosts and makes the canonical page discoverable to existing static link validation. The PR check asserts that fallback and server-rendered HTML are byte-identical. No link-validation or security assertions were removed or weakened.

Preparation commits only `index.html`, `sitemap.xml` and `before-after.html`. It does not deploy main itself. Merge and live verification remain separate steps. The same generated page retains the collection context, canonical metadata, 24 cards and all controls regardless of hosting mode.

## Completed pre-release evidence

The seven targeted route/content/asset tests passed. All 16 real Chromium checks passed: anonymous 200 and no cookies, 24 cards, before/compare/after buttons, Home/End/arrow keyboard control, pointer dragging, search/empty/reset, independent full-size comparison and Escape/focus restoration, all 48 selected images decoding, canonical and booking targets, no overflow at 1440/1024/768/390/320 pixels, no-JavaScript access, exact preservation of the homepage's form/script blocks and no runtime errors.

The first broader CI run identified a static link-check failure for the new Pages Function route. With the generated static fallback present, the complete local Node 22 suite passed: 929 total, 928 passed, one existing skip, zero failures. The workflow now includes the fallback automatically; this resolves the actual missing-static-target issue rather than excluding the new route from checks.

## Live acceptance

Verify anonymous HTTP 200 at `/before-after`, release marker `20260923-public-gallery-v1`, 24 cards, all 48 image files accessible without cookies, working search/sliders/full-size viewing, phone/desktop layout, booking links, homepage navigation and sitemap, and retained HTTP 401 for the private staff page.

Record actual current CI, merge and production verification in PR #68. These pre-release results do not alone claim the production page is live.
