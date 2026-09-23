# EGC before-and-after gallery: production brief

Requested September 23, 2026. Scope: add a gallery to the existing marketing website and produce a large photorealistic image collection through Higgsfield. Do not change operations, CRM, payments, customer records or the existing customer-approved project publishing workflow.

## Implemented in this change

- New `/before-after` page, served from `before-after.html`, with dedicated CSS and JavaScript.
- Three distinct photo sets already published on the existing EGC website. These are reused assets, not newly generated images or newly verified customer case studies.
- An interactive same-view comparison for `garage-before` / `garage-after`; keyboard-native range control, direct photo dragging and before/compare/after buttons.
- Two original composite photo comparisons, kept intact. Their camera angles differ, so they are NOT presented as pixel-aligned sliders.
- Responsive layout, reduced-motion handling, accessible filter buttons, enlarged-photo dialog with Escape/focus return, no-JavaScript photo links, existing walkthrough booking and telephone links.
- Non-destructive gallery discovery links in the existing home gallery and Company footer through `site-enhancements.js`; the pre-existing contact widget is preserved. The existing script has an immutable cache policy: clients already holding its old version may need a refresh before the new discovery links appear. The new page itself is directly addressable independently of that script.
- A separate, initially empty concept manifest. Pending, rejected, malformed or unreviewed concepts do not appear as placeholder cards. Only first-party raster images are accepted, and both images must successfully load before a card appears.
- Concept disclosures are hard-coded in the UI, not optional author-provided text. Generated images must never be presented as actual jobs.

## Actual generation state: blocked, not completed

Higgsfield returned `Requires basic plan or higher.` on all six initial submission attempts. The batch reported zero submitted jobs. There are no generated job IDs or new images from those attempts. No plan change or purchase was made.

The remaining user-owned dependency is to enable a Higgsfield Basic-or-higher account with image generation available, or connect the intended eligible account. Do not ask for credentials in chat. A successful connection alone is not proof of generation entitlement; verify with the next authorized submission.

## Prepared collection

`docs/before-after-generation-plan.json` contains 24 distinct scene briefs plus the shared photographic continuity prompt: family garages, single-car spaces, bike storage, workshops, camping gear, seasonal bins, garden tools, move-in clutter, downsizing, sports, winter gear, utility access and practical full organization.

Target: 24 two-panel concept masters, split into 48 before/after image assets. Proposed settings are GPT Image 2.5, high quality, 4K, 21:9, one master per scene. Higgsfield's September 23 estimate was 4.25 credits per master / 102 credits for 24; re-estimate at resumption. This estimate is not a subscription purchase, a charge, or a claim that images exist.

## Completion procedure after generation access is available

1. Re-estimate the planned settings. Submit in batches of at most six, keeping stable scene indices and exact returned job IDs. Omit `use_unlim` unless the user has chosen a payment source when prompted by Higgsfield. Never retry an unknown-outcome request blindly.
2. Wait for actual terminal job results in groups of at most eight. Record failures separately. Display the collected successful results through the required Higgsfield batch gallery.
3. Visually compare each before/after pair. Doors, windows, rails, ceiling height, viewpoint and permanent floor marks must match. Reject architectural changes, implausible storage, malformed bikes/tools and floating objects. A prompt is not visual QA evidence.
4. Confirm a clean 50/50 split with no gutter, then export optimized WebP panels, preferably around 1200–1600 pixels wide. Use unique versioned names under `images/before-after/concepts/`; avoid overwriting immutable-cached assets.
5. Add only approved outputs to `before-after-concepts.json` using the contract below. Preserve job IDs in the production log. Missing or unreviewed outputs stay out of the public manifest.
6. Test desktop and phone layout, filter behavior, image loading, labels, booking links and accessibility. Merge through the existing release path and verify the actual public page, rather than claiming that a Git commit proves deployment.

Manifest entry example (illustrative paths; create real files before publishing):

```json
{
  "id": "01-family-garage",
  "type": "concept",
  "status": "published",
  "visualReviewPassed": true,
  "title": "Room for the family car",
  "caption": "An illustrative layout with usable wall storage and a clear parking area.",
  "before": "/images/before-after/concepts/01-family-garage-before-v1.webp",
  "after": "/images/before-after/concepts/01-family-garage-after-v1.webp"
}
```

## Acceptance checks

- Exactly three existing photo sets before any concept publication; never count a blocked request as an image.
- Only valid, approved, fully available concept pairs can produce additional cards; every such card visibly says AI-generated concept and not a customer job.
- Before button = 100% before; After = 0% before; range keyboard Home/End and dragging work.
- Organization filter shows the matched pair; Cleanouts shows the three existing sets; reset restores all.
- Composite links open large intact photos and remain plain usable links when JavaScript is off.
- Desktop and 390px/320px viewports have no horizontal overflow.
- Existing contact widget, homepage content, customer-approved projects and booking workflow remain unchanged apart from additive discovery links.

Release evidence belongs in the pull request and final task report. Code written, tests passed, merged and publicly deployed are separate states; report only the states actually verified.
