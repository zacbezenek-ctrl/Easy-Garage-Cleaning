# Lighthouse CI: mobile performance and accessibility (SITE-5)

Every pull request and push to `main` that touches a page, shared stylesheet or script, the crew screens, the portals or
this harness runs Lighthouse on a phone profile. The goal is a median score of **90 or more for both performance and
accessibility** on every page listed below. SITE-4 brought every measured page to 90 or above (see "After the SITE-4
performance pass" below), so the check is **enforced by default**: the workflow reads
`LIGHTHOUSE_ENFORCE: ${{ vars.LIGHTHOUSE_ENFORCE || 'true' }}`, and setting the repository variable to `false` makes it
warn-only again.

## What is measured

| Setting | Value |
| --- | --- |
| Device | `formFactor: mobile`, 375x812 viewport at device pixel ratio 3 |
| Throttling | `simulate` (Lighthouse's default mobile slow 4G and 4x CPU model) |
| Categories | `performance`, `accessibility` only |
| Runs | 3 per page; the assertion uses the **median** score |
| Assertion | `minScore: 0.9` as `error` for both categories |
| Blocked hosts | `googletagmanager.com`, `connect.facebook.net`, `clarity.ms` (analytics-loader.js starts them only after interaction or 2.5 s after load) |
| Lighthouse | `@lhci/cli@0.15.1` (bundles Lighthouse 12.6.1), installed into `/tmp` in CI with `--ignore-scripts`, never into `package.json` |

Pages (`tests/lighthouse/lighthouserc.cjs`):

| Path | What it is |
| --- | --- |
| `/` | Home page |
| `/garage-cleanouts-fort-collins-co`, `/junk-removal-loveland-co`, `/couch-removal-fort-collins-co` | Service and city pages |
| `/book`, `/pricing` | Conversion pages |
| `/blog/how-much-does-garage-cleanout-cost-fort-collins` | Blog article |
| `/garage-turnaround-fort-collins-co` | Landing page |
| `/before-after` | The committed static fallback (`before-after.html`); production renders it through `functions/before-after.js` |
| `/client-login` | Shipped Client Login form, with its real `GET /api/customer-login` readiness probe answered by a synthetic 405 ready response. Automatically detects static, directory-index and Pages Function entry points |
| `/customer-portal` | Customer portal with the synthetic `/api/customer-portal` fixture (signed-in project view) |
| `/business-hub` | Business Client Hub with the synthetic `/api/business-hub` fixture (signed-in company overview) |
| `/field-today` | Harness `tests/lighthouse/pages/field-today.html` that mounts the real `employee-field-today.js` and `.css` (crew Today) |

## How the pages are served

`tests/lighthouse/serve.mjs` is a zero-dependency Node server that behaves like Cloudflare Pages for the parts that
matter to a page load:

- `/x` serves `x.html`, `/x.html` redirects (308) to `/x`, `/dir/` serves `dir/index.html` and `/dir` redirects to `/dir/`.
- Unknown paths return `404.html` with a real 404 status (and `/404` is a 404, as the middleware makes it).
- The same private-path denial as `functions/_middleware.js` (`/tests`, `/docs`, `/scripts`, `_*` files, `package.json`, …),
  plus dot folders (except `/.well-known`) and `node_modules`. A test proves the denial matches the middleware path by path.
- A subset of `_headers` (exact paths and `*` wildcards) is applied, and HTML, CSS, JS, JSON and SVG are sent with brotli or
  gzip like the CDN, so transfer sizes in the simulation are realistic.
- `/api/customer-portal`, `/api/business-hub`, `/api/field-jobs`, `/api/hub-auth` and legacy `/api/client-login` return synthetic
  fixtures from `tests/lighthouse/fixtures/`. Every name is labeled "Synthetic", phones use the 555 exchange and email
  addresses use `example.invalid`; a test enforces this and rejects the real Hub usernames and business phone numbers.
- `GET /api/customer-login` returns the production readiness contract: 405 with `CUSTOMER_LOGIN_METHOD_NOT_ALLOWED`.
  This keeps the shipped sign-in form visible; no sign-in request is accepted or sent.
- The server is read-only: every method other than GET and HEAD returns 405, and it never calls the network.
- The clock is fixed at `2026-09-22T15:00:00Z`. The crew Today screen asks for the browser's Mountain date, so the
  field-jobs fixture (anchored to 2026-09-22) is moved to the requested date to always show a current and a next job.
- The harness page is reachable only as `/field-today`. Its real path is under `/tests`, which production denies.
- `/client-login` runs its Pages Function when one exists, as Cloudflare does: `onRequestGet` (or `onRequest`, including
  handler arrays) gets the request, an **empty `env`** (no secrets or bindings) and a `next()` that serves the static file.
  The server process replaces `fetch` with one that always throws, so a function cannot reach the network. A function that
  needs a real binding fails with a 500 instead of being measured as a different page. `/before-after` stays the static
  fallback on purpose.

The old `/api/client-login` fixture remains for compatibility. Client Login itself uses `/api/customer-login`; the
browser check waits for its 405 readiness response and verifies that both phone and email entry remain usable.

`tests/browser/test_lighthouse_pages_ui.py` proves the fixtures still produce the signed-in screens Lighthouse is meant
to score. It starts `serve.mjs` exactly as `lhci` does, loads `/client-login`, `/customer-portal`, `/business-hub` and `/field-today` in a
375x812 phone context with an installed clock (Tokyo and Los Angeles zones), and requires `#portal` with the fixture's
welcome, service, address and estimate number, the business `#app` (not `#gate`) with the fixture company, and the crew
current and next job for the Mountain date. It also requires no `pageerror`, no unexpected same-origin 4xx/5xx (the
Client Login readiness 405 is expected), no horizontal
scroll and no analytics on the crew harness. If a fixture drifts from the real API shape, this check fails before
Lighthouse can quietly score an error or sign-in screen.

## CI workflow

`.github/workflows/egc-lighthouse.yml`:

The path filters cover every root page, stylesheet and script (`styles.css`, `site-enhancements.js` and
`analytics-loader.js` are also named explicitly), `images/**`, the blog, the crew screens, the portals, every Client Login
shape, `_headers`, this harness and the render check.

1. Runs `node --test tests/lighthouse/*.test.mjs` (the same tests also run under `npm test` through `tests/lighthouse-ci.test.mjs`).
2. Installs `@lhci/cli@0.15.1` with `npm install --prefix /tmp/egc-lighthouse-tools --no-save --no-package-lock --ignore-scripts`,
   runs it with `npx --no-install`, and saves `npm ls --all` to `test-results/lighthouse/tool-versions.txt`.
3. Uses the runner's Google Chrome (`CHROME_PATH`).
4. Installs `playwright==1.57.0` with pip and runs `tests/browser/test_lighthouse_pages_ui.py` on the runner's Chrome. This is
   a hard failure: if it fails, the harness would be measuring the wrong screens.
5. `lhci collect` (always required to succeed; a page that fails to load is a harness bug), then `lhci assert`.
   The assert step fails the job unless the `LIGHTHOUSE_ENFORCE` repository variable is set to something other than `true`
   (unset means `true`); then it emits a warning annotation instead.
6. `lhci upload --target=filesystem` writes every run's HTML and JSON report plus `manifest.json` into
   `test-results/lighthouse/`, and `tests/lighthouse/summary.mjs` writes the median score table into the job summary.
   The summary counts only fully measured pages as passing or below 90. It lists pages that are missing a score, and
   required pages that do not exist yet (Client Login), separately as "not measured". The first run records the baseline.
7. Uploads `test-results/` (reports, tool versions, render screenshots) and `.lighthouseci/` as the
   `egc-lighthouse-<run>-<attempt>` artifact (30 days). Reports are never sent to temporary public storage.

Why the Lighthouse tool's dependencies are not locked: the repository convention keeps CI tools out of `package.json` and
the lockfile, so no second lockfile is committed for this check. `@lhci/cli` is pinned exactly, and the bundled
Lighthouse version comes from that release. Its transitive dependencies resolve from the release's own semver ranges on each
run. `--ignore-scripts` means none of them can run install-time code; when this was checked, no package in the 0.15.1 tree
had an install script. The resolved tree for each run is in the artifact's `tool-versions.txt`. If a score changes without
a site change, diff that file against an earlier run.

## Run it locally

```sh
npm install --prefix /tmp/egc-lighthouse-tools --no-save --no-package-lock --ignore-scripts @lhci/cli@0.15.1
export CHROME_PATH=/path/to/chrome            # e.g. /opt/pw-browsers/chromium-1194/chrome-linux/chrome
PLAYWRIGHT_CHROMIUM_EXECUTABLE="$CHROME_PATH" python3 tests/browser/test_lighthouse_pages_ui.py
npx --no-install --prefix /tmp/egc-lighthouse-tools lhci collect --config=tests/lighthouse/lighthouserc.cjs
npx --no-install --prefix /tmp/egc-lighthouse-tools lhci assert --config=tests/lighthouse/lighthouserc.cjs
npx --no-install --prefix /tmp/egc-lighthouse-tools lhci upload --config=tests/lighthouse/lighthouserc.cjs
node tests/lighthouse/summary.mjs             # reads test-results/lighthouse/manifest.json
rm -rf .lighthouseci
```

Reports go to `test-results/lighthouse/` by default. Set `LIGHTHOUSE_REPORT_DIR` to write them somewhere else; a relative
path resolves against the working directory. `lhci collect` always writes its raw runs to `.lighthouseci/` in the working
directory. That folder, `test-results/` and a legacy `lighthouse-reports/` folder are gitignored, and
`tests/source-files.mjs` skips them, so leftover reports never break `npm test` or end up in a commit.

To look at the pages yourself: `node tests/lighthouse/serve.mjs` and open http://127.0.0.1:9393/ (set `LIGHTHOUSE_PORT`
to change the port). Running as root (containers) adds `--no-sandbox` for Chrome automatically.

## Baseline measured while building SITE-5 (2026-09-27)

A full local run of this exact configuration (`@lhci/cli` 0.15.1, Lighthouse 12.6.1, Chromium 141 headless, 3 runs per
page, 36 runs in all). Median scores:

| Page | Performance | Accessibility | Result |
| --- | ---: | ---: | --- |
| `/` | 96 (88, 96, 96) | 91 | pass |
| `/garage-cleanouts-fort-collins-co` | **83** (83, 76, 84) | 93 | performance below 90 |
| `/junk-removal-loveland-co` | **85** (83, 85, 89) | 93 | performance below 90 |
| `/couch-removal-fort-collins-co` | 94 (93, 94, 94) | 92 | pass |
| `/book` | **87** (89, 87, 87) | 90 | performance below 90 |
| `/pricing` | 93 (92, 93, 96) | 92 | pass |
| `/blog/how-much-does-garage-cleanout-cost-fort-collins` | 97 (88, 97, 98) | 92 | pass |
| `/garage-turnaround-fort-collins-co` | **85** (84, 85, 85) | 93 | performance below 90 |
| `/before-after` (static fallback) | **89** (89, 91, 86) | 91 | performance below 90 |
| `/customer-portal` (fixture) | 93 (93, 93, 96) | 96 | pass |
| `/business-hub` (fixture) | 100 (99, 100, 100) | 95 | pass |
| `/field-today` (crew Today harness) | 100 | 100 | pass |

`lhci assert` exits 1 on this baseline (5 of 12 pages below 90 for performance; every page passes accessibility), so the
check stays warn-only until SITE-3 and SITE-4 land. The threshold is **not** lowered.

Measurement caveats. The container had 4 shared vCPUs under heavy load from parallel builds (load average 23 to 51), and
Lighthouse's CPU benchmark index ranged from 253 to 2249 between runs, so CPU-bound metrics (LCP render delay, TBT) are
pessimistic here. It also had no outbound network: the Google Fonts stylesheets and the CloudFront gallery images failed
instead of loading. The first CI run on a GitHub runner, recorded in its job summary and artifact, is the authoritative
baseline.

### Failing audits to fix (median run)

Performance, pages below 90:

- `/garage-cleanouts-fort-collins-co`: `largest-contentful-paint` 4.0 s (score 0.50; LCP is the `h1.hero-title` text, and all of
  it is render delay: TTFB 458 ms, render delay 3540 ms) and `cumulative-layout-shift` 0.118 (0.85; `header#top` hero).
  Also `uses-responsive-images` (`/images/garage-before.webp` −104 KiB, `/images/garage-after.webp` −78 KiB).
- `/junk-removal-loveland-co`: `largest-contentful-paint` 3.7 s (0.58; `p.hero-sub`, render delay 3232 ms) and
  `cumulative-layout-shift` 0.118 (0.85; `header#top`). Same `uses-responsive-images` savings.
- `/book`: `largest-contentful-paint` 2.8 s (0.83; `p.hero-sub`, render delay 2340 ms) and `cumulative-layout-shift` 0.191
  (0.64; `section#top` hero).
- `/garage-turnaround-fort-collins-co`: `largest-contentful-paint` 4.0 s (0.49; `h1.hero-title`, render delay 3550 ms) and
  `speed-index` 3.8 s (0.84). Render-blocking: the Google Fonts stylesheet (est. 780 ms), `/styles.css` and
  `/garage-turnaround.css` (312 ms each). `uses-responsive-images` −193 KiB.
- `/before-after`: `largest-contentful-paint` 3.3 s (0.71; `h1.hero-title`, render delay 2793 ms) and `speed-index` 5.2 s
  (0.61). Render-blocking: the Google Fonts stylesheet (780 ms), `/gallery-simple.css` and `/styles.css` (318 ms each).
  `uses-responsive-images` −108 KiB.

Shared causes seen across the public pages:

- The layout shift on every page that loads `site-enhancements.js` (home, service, book, pricing) comes from its customer
  access bar (`#egc-customer-access`), which the deferred script inserts at the top of `main#main-content` after the hero
  has painted. Pages without that script (`/garage-turnaround-fort-collins-co`, `/before-after`, the blog) have a CLS of 0.
- The LCP is always hero text, so it is gated by render-blocking CSS (`/styles.css`, 79 KB) and the Google Fonts
  stylesheet, not by an image download.
- `modern-image-formats`: the header logos `/images/brand/egc-logo-horizontal-primary.png` (−139 KiB) and
  `egc-logo-horizontal-white.png` (−82 KiB) are PNGs.

Accessibility (all pages pass 90, but these audits fail and cost points):

- `aria-hidden-focus` on every public page: `aside#nav-drawer` is `aria-hidden="true"` while its links stay focusable.
- `color-contrast`: `.hero-eyebrow`, `a.hero-phone`, `.qa-label`, `.section-num`, `.step-num`, `a.content-link` on public
  pages; `.eyebrow`, `.qs-label`, `td.price-highlight` on the blog; `#channel-state`, the submit `.btn` and `.progress-step`
  in the customer portal; `#workspace-kicker` in the business hub.
- `heading-order` on `/` (`#turnaround-plan .hero-form-heading > h3`) and `/book` (`.book-layout .quote-form > h3`): the
  form heading skips a level.

## After the SITE-4 performance pass (2026-09-28)

The same configuration, run locally before and after SITE-4 on the same busy container (4 shared vCPUs, load average 26 to
53, benchmark index 327 to 2367). Median of 3 runs:

| Page | Performance before | Performance after | Accessibility after |
| --- | ---: | ---: | ---: |
| `/` | 91 | 97 | 95 |
| `/garage-cleanouts-fort-collins-co` | **83** | 99 | 97 |
| `/junk-removal-loveland-co` | **84** | 99 | 96 |
| `/couch-removal-fort-collins-co` | 92 | 100 | 96 |
| `/book` | **87** | 100 | 94 |
| `/pricing` | 93 | 100 | 96 |
| `/blog/how-much-does-garage-cleanout-cost-fort-collins` | 98 | 100 | 96 |
| `/garage-turnaround-fort-collins-co` | **85** | 97 | 97 |
| `/before-after` (static fallback) | 91 | 97 | 96 |
| `/customer-portal` (fixture) | 96 | 99 | 96 |
| `/business-hub` (fixture) | 100 | 100 | 95 |
| `/field-today` (crew Today harness) | 100 | 100 | 100 |

Accessibility did not change (it was 94 to 100 before as well). The before column is the unchanged tree measured the same
morning. On a slow run the customer portal scored 72: its loading screen's 80px top margin collapsed through `<main>`, so
the whole page jumped (CLS 0.92) when the project rendered. `main` is now a block formatting context and the loading screen
holds the viewport, so that shift is gone (checked by `tests/browser/test_lighthouse_pages_ui.py`), and its font stylesheet
no longer blocks rendering.

What moved the numbers:

- **Cumulative layout shift 0.118 to 0.191 is now 0** on every page: pages that load `site-enhancements.js` ship its booking and
  customer-portal bar in the HTML (`render_customer_access` in `_generate_site.py`, styled by `styles.css`), so the script
  no longer inserts it above the painted hero. The script still builds the bar on any page without it.
- **LCP 3.7 to 4.0 s is now 1.7 to 2.1 s** on the service, city and turnaround pages: the hero before/after images are
  `srcset` 600w/1200w WebP (`images/garage-{before,after}-600.webp`) with `sizes` and `fetchpriority="high"` on the first one,
  so a phone downloads about 90 KB instead of 236 KB before the hero text settles.
- **No render-blocking Google Fonts stylesheet** on any public page (`defer_google_fonts` patches hand-written pages to the
  `media="print"` swap with a `<noscript>` copy; `functions/before-after.js` uses the same URL). `ads.html`, `apply.html` and
  `thank-you.html` asked Google for an unsorted weight list, which Google answers with HTTP 400, so they never had their fonts;
  `google_fonts_url` sorts and de-duplicates the tuples.
- The header and footer logos are 368px WebP (11 KB and 7 KB) with 4 KB PNG fallbacks through `image-set`, instead of 2400px
  PNGs (195 KB and 135 KB). Screens above 1x get a sharper WebP about 3x the widest phone box (552px header, 18 KB; 704px
  footer, 16 KB), and the customer portal's two logo `<img>` tags use the same files in a `srcset`.
- The generated pages' 11.6 KB inline nav, reveal and multi-step form script is `/site-forms.js` (deferred, immutable, `?v=` is
  its content hash), and the footer 44px rule moved from the inline `<style id="footer-tap">` into `styles.css` (`20260928a`).

## Home page pass (2026-10-21)

`/` was the one page sitting at the bar on GitHub runners: CI medians of 88 (runs such as 88, 86, 95), with LCP pinned at
3.0 s and up to 350 ms of TBT. Two causes, both read from a failing run's reports and local traces:

- **Photo bytes before the hero paints.** A 3x phone needs about 1030 device pixels for the hero, and the `srcset` jumped
  from 824w to the 96 KB 1646w file. The Results gallery below loaded its 1200-1646px originals (525 KB), and Chrome fetches
  lazy images that close to the fold right away, so all of it shared the slow-4G simulation with the hero.
  Now the hero has `job-before-after-1-1080.webp` (51 KB). The gallery uses `<picture>` with `sizes`: the existing
  600w/768w garage files, plus 824w/1080w/1646w WebP for `job-before-after-2` and 600w/1000w WebP for `job-pile`.
  The gallery images are still lazy and keep their JPEG fallbacks (`patch_home_gallery_images`).
- **Two full relayouts from Google Fonts.** The `media="print"` stylesheet applied after first paint, so Chrome
  re-laid out the whole page (about 65 ms observed, about 260 ms at 4x CPU), and again when the woff2 files arrived. Those
  were the long tasks behind the TBT. The home page now declares the same families and weights inline from `/fonts/`
  (latin and latin-ext, OFL, `home_font_head`) before `styles.css` and preloads Inter, so the first layout already
  has them. `/fonts/*` is cached like `/images/*`. The other public pages still load Google Fonts.

The same configuration run locally (Chromium 141, 3 runs per page). `main` and the branch were measured back to back:

| Page | Performance `main` | Performance after | Accessibility after |
| --- | ---: | ---: | ---: |
| `/` | 95 | **98** (98, 98, 98) | 100 |
| `/garage-cleanouts-fort-collins-co` | 100 | 99 | 100 |
| `/junk-removal-loveland-co` | 99 | 99 | 100 |
| `/couch-removal-fort-collins-co` | 100 | 100 | 100 |
| `/book`, `/pricing`, the blog article | 100 | 100 | 100 |
| `/garage-turnaround-fort-collins-co` | 99 | 99 | 100 |
| `/before-after` (static fallback) | 97 | 97 | 100 |
| `/client-login`, `/customer-portal`, `/business-hub`, `/field-today` | 100 | 100 | 100 |

Five runs of `/` alone gave 98 every time (LCP 2.3 s, TBT 0 to 15 ms), against 62, 90, 94, 94, 95 on `main`. With three
cores busy-looping they gave 98, 98, 98, 99, 99. `tests/home-performance.test.mjs` checks every referenced file and
WebP width, the gallery markup, the font declarations and the cache rule.

## Differences from production

- No `functions/_middleware.js` in the loop: no CSP, and no HTMLRewriter business-hub link in the navigation.
- HTTP/1.1 on loopback instead of Cloudflare's HTTP/2 and HTTP/3.
- `/before-after` is the static fallback, not the Pages Function render.
- The portal, business hub and crew pages show fixed synthetic data. They measure the signed-in screens, not live Firestore.

## Owner checklist

- Enforcement is the workflow default: `.github/workflows/egc-lighthouse.yml` sets
  `LIGHTHOUSE_ENFORCE: ${{ vars.LIGHTHOUSE_ENFORCE || 'true' }}` in the assert and summary steps. Set the repository
  variable `LIGHTHOUSE_ENFORCE` (Settings, Secrets and variables, Actions, Variables) to `false` only to make the check
  warn-only again, for example while a runner's job summary shows a page below 90.
- Then consider making "EGC Lighthouse (mobile)" a required status check on `main`.
- `/before-after`: only the local photo pair has `-768` card thumbnails. The six concept pairs still load their full-size
  CloudFront PNGs (lazy and below the fold, so the score holds). On a machine that can reach CloudFront, save a 768x576 WebP
  of each of those twelve images under `images/gallery-simple/` with a name ending in `-768.webp` (the size and quality 83
  that `tools/gallery/import-simple.py` uses for its thumbnails; do not rerun that importer, it rewrites the data file
  without the photo pair), then point each pair's `beforeThumbnail`/`afterThumbnail` in
  `functions/_lib/gallery-simple-data.js` at them. `renderPublicGallery()` adds the `srcset` with no code change; re-render
  `before-after.html` with `node scripts/render-before-after.mjs`.
