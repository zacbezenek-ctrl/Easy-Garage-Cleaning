# Repeatable EGC gallery production

## Connected generation
Higgsfield generation works through the authorized ChatGPT connection. Requests select `nano_banana_pro`; returned job metadata reports `nano_banana_2`. Both are recorded rather than asserting an independently verified provider backend. No head-to-head model benchmark completed: the attempted alternative-model submission was rate-limited before job creation.

## Production flow

1. Generate a fictional before image or use a specifically authorized real reference photo. A real customer photo requires permission appropriate to its use; this batch uses fictional sources only.
2. Edit that source into an after concept. Corrections may edit the prior after result; retain the original before and the full generation lineage.
3. Wait for terminal results and record exact successful job IDs and returned URLs. Respect rate limits; never blindly resubmit an unknown-outcome request.
4. Register pairs in `docs/gallery-generation-registry.json` on a `feat/before-after-gallery-*` branch with review status `pending`.
5. `EGC Gallery Assets` validates/downloads registered results, creates versioned WebP assets and paired review sheets, integrates page links, and runs real browser tests. Pending or rejected pairs never enter the public manifest.
6. Inspect the actual pair for consistent architecture, viewpoint, believable storage, duplicated possessions and false renovation. Record approval with reviewer/date/concrete notes only after inspection. A successful request is not a visual review.
7. The next asset run updates the approved manifest, tests desktop/mobile layouts and full-size comparison controls, and saves generated changes to the same feature branch. It refuses to push over unexpected branch movement.
8. Merge through the normal release path, then check `EGC Gallery Live Check`. This verifies the actual public page, exact manifest, homepage link, sitemap and deployed asset hashes. A merge or hosting deployment status is not enough by itself.

## Public presentation

Existing website photos remain distinct from generated concepts. Every concept card and its full-size comparison visibly say AI-generated and not a completed customer job. Do not invent customer names, project prices, addresses, completion dates, measured outcomes or testimonials. Keep simulated concepts out of the customer-approved-project publishing flow.

The `/before-after` page includes filtering, full-size sliders, keyboard and pointer controls, mobile layouts, existing booking links, and a no-JavaScript fallback for the original photographs. Static homepage/footer links and the sitemap make it discoverable. The original contact widget, CRM, forms, appointments, payments and conversion logic are not rewritten.

## Tests and retained evidence

The asset workflow archives contact sheets, source registry, optimized images, screenshots, asset hashes and browser reports. Tests cover approved-only selection, missing assets, image decoding, filters, range/button/pointer interactions, Escape/focus return, responsive overflow and existing booking targets. A separate regression test verifies compact 4:3 concept thumbnails at phone and desktop widths; this prevents intrinsic image height from creating large blank margins.

The main-branch live checker makes read-only HTTP requests and does not execute analytics or submit forms. Its report explicitly records failure when the public release cannot be verified.

## Automation boundary

This is on-request image generation plus automated preparation, testing and release verification. It is not an always-on paid image generator and it does not schedule recurring ChatGPT tasks. A future unattended generator needs its own authorized trigger, service credential and explicit spending ceiling. Buying a consumer subscription alone does not provision that backend.

No extra image-model subscription or API key is needed for the current on-request ChatGPT/Higgsfield workflow. Never put account secrets in repository code or ask the user to paste billing credentials into chat.

## Costs

The September 23 estimate was two credits per 2K image: one source plus one edit estimates four credits per pair, or 96 for 24 pairs before retries. Corrections are extra. Check the current estimate and balance before future batches. A documented target does not authorize buying credits or changing plans.

## Reproduce preparation and tests

```sh
python -m pip install Pillow==11.3.0
python tools/gallery/integrate.py
python tools/gallery/prepare.py
python tools/gallery/validate.py
NODE_PATH=/path/to/playwright/node_modules node tools/gallery/browser-test.cjs
NODE_PATH=/path/to/playwright/node_modules node tools/gallery/dialog-test.cjs
```

Run `python tools/gallery/check_live.py` against the release checkout to verify the public deployment. For the actual current outcome, read its report and the latest PR release evidence rather than inferring success from this documentation.
