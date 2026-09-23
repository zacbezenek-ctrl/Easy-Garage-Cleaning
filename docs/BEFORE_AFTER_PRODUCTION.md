# EGC before-and-after gallery — production record

Updated September 23, 2026. This supersedes the initial blocked-account brief. Paid Higgsfield generation now works; the earlier `Requires basic plan or higher` rejection is resolved.

## Image production

The 24-scene collection has been rendered using a separate before image and a reference-based after edit for every scene. Fifty image jobs completed: 48 selected before/after outputs plus two rejected initial edits. The bicycle edit duplicated bikes; the first sports edit duplicated balls. Replacements were generated from their original before images. All exact source/output job IDs and review decisions are recorded in `gallery-generation-registry.json`.

The account balance was 280 credits at the first successful paid generation check and 180 after these 50 jobs. No subscription upgrade or additional credit purchase was performed by the assistant.

Requests used `nano_banana_pro`, 2K, 4:3. Higgsfield returned `nano_banana_2` in job metadata; both names are retained. The exact provider backend must not be represented as independently verified. A requested GPT Image comparison was rate-limited before job creation, so no head-to-head model benchmark was completed.

## What is built

`/before-after` is a new page in the existing EGC marketing website, not a replacement site. It preserves three pre-existing website photo sets and keeps them separate from clearly labeled simulated concepts. The page includes mobile/desktop layouts, category filters, the original comparison slider, full-size before/after concept comparisons, accessible keyboard controls, enlarged-photo dialogs, existing walkthrough and phone links, and a no-JavaScript fallback for the original photographs.

Static homepage and Company-footer links make the gallery discoverable without waiting for JavaScript. The homepage enhancement script URL is versioned, and the page has a sitemap entry. Existing customer-approved project publishing, CRM, appointments, customer records, payments and conversion-event logic are not changed.

## Review and publication contract

A completed model job is not proof of a good image. The registry stores pending, approved or rejected status. Approval requires an actual paired visual inspection plus reviewer, date and concrete notes. Every public concept card and full-size comparison clearly says it is AI-generated and not a completed customer job. Do not invent job prices, dates, testimonials, locations or measured outcomes for these images.

Only approved pairs with valid, available first-party images enter `before-after-concepts.json`. This manifest, not a historical count in a document, determines the publishable collection. Registry entries with pending or rejected review stay out of the public page.

## Automated preparation and verification

`EGC Gallery Assets` imports registered completed outputs, makes versioned WebP assets, creates paired review sheets, runs static checks and real Chromium desktop/phone tests, and saves only to the feature branch. It rejects an unexpected branch movement instead of forcing a push. Visual inspection also caught oversized thumbnail margins; `height:auto` and an explicit thumbnail-ratio regression test fix that issue.

After release to main, `EGC Gallery Live Check` independently verifies the public page, exact approved manifest, homepage link, sitemap and SHA-256 hashes of the generated image assets and gallery scripts/styles. Read-only HTTP checks do not execute analytics or submit customer forms. A merge or hosting-provider deployment message alone is not considered proof that the custom-domain page is current.

## Release evidence and next run

PR #63 contains the release history and final verification outcome. Before representing the gallery as live, check that PR's actual merged state and the public live-check result. Review sheets, screenshots and test results are retained in the Actions artifacts.

For another batch: generate a source; edit that exact source; register actual completed output IDs; inspect; record review; let asset preparation and browser tests run; release; verify the public page. This supports on-request production through the existing ChatGPT/Higgsfield connection. It is not an unattended paid-generation service or a new scheduled task.
