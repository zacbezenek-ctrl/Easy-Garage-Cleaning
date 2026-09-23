# Repeatable EGC gallery production

## Current access
Higgsfield generation succeeded after the account upgrade on September 23, 2026. Requests used `nano_banana_pro`; returned job statuses report `nano_banana_2`. Preserve both identifiers and do not imply that the exact Google Pro backend was independently verified. A GPT Image 2.5 benchmark submission failed with a rate limit; no comparison result exists from that request.

## One library, two kinds of evidence
- Existing EGC photography remains separate from simulated concepts.
- Every generated before/after pair is a fictional visualization, visibly labeled `AI-generated concept · Not a customer job`.
- Never convert a generated after image into customer-job evidence, reviews, a completed-job claim, a quoted project price, or customer-approved case study.

## Repeatable production flow
1. Generate a before image through the connected Higgsfield tool, or use an explicitly authorized source photo.
2. Generate the after as a reference edit using the completed before job ID. Do not independently generate two unrelated rooms.
3. Wait for terminal generation outcomes. Respect rate limits; never retry an unknown submission outcome blindly.
4. Append actual completed job IDs and exact returned URLs to `docs/gallery-generation-registry.json` on a `feat/before-after-gallery-*` branch. New pairs start with review status `pending`.
5. The GitHub workflow imports registered results, optimizes first-party WebP files, creates paired review sheets, runs browser tests, archives evidence, and saves prepared assets to that feature branch. It does not publish pending pairs.
6. Visually inspect the source/edit pair: doors, windows, rails, room dimensions, light direction, permanent floor markings and supported shelves. Check useful objects for unacceptable disappearance and bikes/tools for malformed geometry. Reject pairs with structural drift or false renovation. This cannot be established just by a successful model request.
7. Record `approved` with reviewer, review date and concrete notes only after inspection. The same workflow updates the public manifest for those pairs; rejected and pending pairs stay hidden.
8. Release through a reviewed pull request and verify deployment. Never equate generation, a commit, passing checks, merging and public availability.

## Scope of automation
This is a reusable, on-request generation and automatic asset-preparation/publication pipeline. The GitHub workflow does not have a Higgsfield API credential, does not run unattended paid generation, and is not a recurring schedule. No additional model subscription or key is needed for generating through the current ChatGPT Higgsfield connection. A future always-on generator requires its own authorized service credentials/trigger and explicit credit limits. Do not pretend a consumer subscription automatically supplies that server integration.

## Cost and retry limits
The tool estimated two credits per 2K Nano Banana Pro image on September 23. One source plus one edit estimates four credits per pair before retries. The original 24-pair target therefore estimates 96 credits, not a guarantee of actual charges. New model prices and account balance must be checked at run time. Do not buy additional plans or credit packs, silently change billing source, or exhaust the account with unlimited retries.

## Local/CI commands
`python -m pip install Pillow==11.3.0`

`python tools/gallery/prepare.py`

`python tools/gallery/validate.py`

`NODE_PATH=/path/to/playwright/node_modules node tools/gallery/browser-test.cjs`

The prepare script downloads only exact account-scoped, registered output URLs, blocks redirects, checks formats/dimensions/size, produces versioned filenames, preserves pending status, and never executes source content. No private customer records or CRM access is involved.
