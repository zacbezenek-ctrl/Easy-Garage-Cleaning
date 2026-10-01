# Public website audit — October 1, 2026

Status: draft PR #101 and Cloudflare branch preview prepared; **not approved for production**. Desktop preview inspected; mobile screenshots, final CI, pricing approval and production recovery remain open.

## Critical production finding

At 19:34 UTC the actual cloud browser opened https://easygaragecleaning.com/ and received Cloudflare Error 1102, “Worker exceeded resource limits.” One reload reproduced the error. Ray IDs: a43de70c3aa04871-DFW and a43de7ad0a204871-DFW. This is a runtime failure, not an anti-bot challenge. Restore availability and verify the deployed revision before launch.

## Changes prepared

- Replaced the stale summer promotion with a year-round free-walkthrough message
- Preview/local marketing analytics now stay disabled; canonical production host tracking is preserved
- Homepage now explicitly presents junk removal and garage cleaning as two service paths, with direct service links and appropriate lead-form project options
- A responsive SVG box-truck load guide is integrated into the homepage, pricing page and both principal Fort Collins junk-removal pages
- Eight native slider positions, keyboard value descriptions, shortcut buttons, animated cargo fill, reduced-motion styling and a no-JavaScript booking fallback
- Independent public pricing configuration with exact integer-cent tiers, validation and an honest quote-required fallback; no private crew pricing, customer data or authenticated API is used
- Idempotent generator integration prevents regenerated service pages from losing the component
- One contradictory “never by volume” paragraph has been replaced with walkthrough-confirmed pricing language

## Decisions still required

The repository does not establish an approved public truck-volume schedule or the actual truck capacity. Populate `PUBLIC_LOAD_PRICING.tierCents` only after approval of all eight tiers, and `capacityCubicYards` only after confirming the truck's usable capacity. Do not publish internal walkthrough tables as consumer pricing. Until configured, the interface is a load visualization, **not a numerical price estimator**.

Existing public prices conflict across pages: the homepage advertises $400–$3,500, the pricing page includes $99–$650+ ranges, and the separate curbside offer is $139 for up to 4 cubic yards. These were not arbitrarily rewritten. Confirm current public service pricing and reconcile page text, FAQs, structured data and metadata before launch.

## Verification

- Focused final Node suite before the seasonal-copy update: 48/48 passing (estimator, public performance structural checks, pricing privacy, security hardening and generator reproducibility)
- Estimator JavaScript syntax and Python installer/generator compilation pass
- Installer runs byte-for-byte idempotently; the complete generator also reproduces checked-in output twice while preserving private surfaces
- Local links/assets and duplicate IDs checked on homepage, pricing, junk removal, garage cleaning and booking: no missing local targets or duplicate IDs
- Unit coverage includes all eight unconfigured tiers, exact configured prices, invalid configurations, out-of-range inputs, preset changes, aria values and cargo fill updates
- Added isolated desktop/mobile acceptance script `tests/browser/test_public_load_estimator_ui.py` for 320, 375, 768 and 1440 pixels, reduced motion, keyboard, no-JS and screenshots
- Local browser tests could not start: environment denies Chromium's process-singleton socket, including the escalated run. Cloud browser also refuses the local preview URL. A real Cloudflare preview subsequently provided desktop visual verification of the homepage, truck slider, garage-cleaning page, junk-removal page and quote anchor. Slider keyboard endpoints worked; observed pages had no horizontal overflow or broken loaded images. Final mobile screenshots are produced by the isolated CI device suite; mobile/Lighthouse/lead-submission pass is not claimed here.
- Complete local root suite at the initial implementation: 4,365 passed, 11 skipped, zero failures. Final remote CI must be checked for the final head.
- No real lead submissions, payments, customer messages or production deployment were performed. The first preview exposed the existing all-host analytics initialization; the follow-up host guard prevents live marketing script loads on preview/local hosts. The authorized branch and draft PR were published for review.

## Release checklist

1. Restore and verify production homepage availability
2. Confirm public load tiers, truck capacity and current service ranges
3. Run the added browser acceptance script and existing public navigation/performance suites on a supported browser runner; inspect before/after desktop and mobile screenshots
4. Validate form happy/error states with locally intercepted requests; do not submit test customers into production
5. Run all required CI on the exact final revision and review this change separately from Hub sender release work
6. Obtain publication approval; then verify the deployed revision, both service routes and booking path in production
