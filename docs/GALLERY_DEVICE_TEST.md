# Public cross-device gallery test

Route: `/before-after-preview`.

Zac authorized public access on September 23, 2026 so the gallery could be tested on another device without signing in. This is a public, unlisted test gallery, not an authenticated page. Noindex is a crawler directive, not access control; anyone with the URL can open or share it.

The route renders the same 24 fictional before/after pairs using 48 existing WebP assets. A compact label identifies them as AI-generated design concepts, not completed customer projects; the full-size viewer also retains that distinction. The existing search, sliders, keyboard controls and full-size view are reused. No new image generation or purchases were performed.

The public copy contains only the 48 selected images and the gallery CSS/JavaScript. Two obsolete rejected image versions were excluded. Source provenance and the original 17 approved / seven pending visual-review statuses remain unchanged; public device testing does not mark pending concepts as approved customer case studies.

The staff-only `/internal/before-after` route, its asset permissions and Hub authentication are unchanged. No navigation or sitemap link, analytics, booking form, customer record or conversion event is added. Page and asset responses request no caching and no indexing.

Validation: `node --test tests/gallery-device-preview.test.mjs tests/gallery-preview.test.mjs`. Separately test the actual deployed public URL in a fresh browser without cookies, confirm all 48 images, mobile layout, search, comparison buttons, keyboard/pointer and expanded view. Keep production release evidence in the PR; a commit alone is not deployment proof.
