# Internal before-and-after preview

Requested by Zac on September 23, 2026 for infrastructure testing, not customer publication.

## Route and access

`/internal/before-after` is rendered by a Pages Function only after verification of the existing signed Hub session. Configured owners/managers and existing business-access users may enter. Other users and anonymous requests are denied. Sign in at `/employee`, then revisit the preview. No new password or subscription is needed.

`/internal-gallery-assets/*` has its own catch-all Pages Function, with the same server-side authorization and an exact allowlist. Authentication is required for direct image, CSS and JavaScript requests too. Both page and assets send private/no-store caching and noindex headers. The page has no static HTML copy or client-side auth bypass. Noindex is supplemental, not access control.

## Presentation

24 generated before/after pairs (48 selected images) from the existing PR 63 asset tree. Plain Before/After labels, native keyboard sliders, pointer dragging, search and full-size comparisons. No visible AI disclaimers, simulated-result captions or badges on this internal screen. No invented customer names, testimonials, project dates, measured results or prices. No marketing analytics, forms or booking CTAs.

Generation provenance and original review states remain in the server-side fixture module: 17 previously approved, seven pending. The preview includes pending pairs for internal examination only; it does not mark them approved or add them to a public manifest. The original public-gallery branch and its disclosures are untouched by this change. The public homepage, navigation, sitemap and customer-project publishing flow are also untouched.

Source: `5ea44a1509ca3bcb301d2ceb37e4a5301ce86b7c`. Asset tree: `4eab106018b2190dff288773ef8132f9a08e2ba0`. Existing generated WebPs are reused; no new generation credits are spent.

## Verification

Run `node --test tests/gallery-preview.test.mjs` and `node --check internal-gallery-assets/gallery.js`. Tests exercise actual Hub token verification with synthetic credentials, anonymous/crew/expired/tampered denial, owner/manager access, no-store/HEAD behavior, exact asset allowlisting, retained review counts, no analytics and removal of visible disclosures.

After release, verify anonymous page and image denial on the real hostname, then verify the full screen using a signed owner/manager session. A successful merge is not proof of a live deployment. This route depends on the existing Pages Functions hosting and existing Hub sign-in configuration. Do not publish it using static-only hosting, which cannot execute server authentication. The repository itself is public, so this protects the hosted test page, not the confidentiality of the repository's source/image files.
