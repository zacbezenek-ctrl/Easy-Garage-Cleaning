# Testing EGC

Every suite runs against synthetic data only. No test reaches production Firestore, HighLevel, Stripe, Google, or any other external host. External traffic is refused or aborted, not mocked in passing.

| Layer | Where | Runs with |
| --- | --- | --- |
| Hub contract tests | `tests/*.test.mjs` | `node --test tests/*.test.mjs` (`npm test`) |
| Pages Functions through the router | `tests/helpers/pages-router.mjs` | used by any `tests/*.test.mjs` |
| Firestore rules and emulator acceptance | `tests/firestore-emulator.test.mjs`, `tests/emulator-harness.test.mjs`, `tests/*.browser.mjs` | `node scripts/emulator-exec.mjs …` |
| Device e2e (iPhone 375x812, Pixel 7, iPad Mini 768, desktop 1440; Hub shell also 320, 390, 414, 844x390, iPad 820/1180, 1366) | `tests/e2e/*.spec.mjs` | `npx playwright test -c tests/e2e/playwright.config.mjs` |
| Isolated UI modules | `tests/browser/test_*_ui.py` | `python3 tests/browser/test_x_ui.py` |
| Platform (API, MCP, worker) | `egc-platform/**` | `pnpm test`; Postgres `*.check.mjs` |

## Root suite

```sh
npm install --ignore-scripts --no-audit --no-fund
node --test tests/*.test.mjs          # also: npm test
npm run check                          # node --check employee-suite.js
```

Tests inject time. Never assert against the real clock; the suite must still pass with `Date` shifted +400 days (see the clock-shift guard below). Emulator-only tests skip unless `EGC_FIREBASE_EMULATOR_TEST=1`.

Repo-wide scans go through `sourceFiles(root)` in `tests/source-files.mjs`. It skips agent
worktrees (`.claude/`, `worktrees/`), dependencies, build output and local QA captures
(`test-results/`, `field-qa/`, `.lighthouseci/`). Add to its ignore set instead of writing a new
directory walker. The public-copy scan in `tests/seo-walkthrough.test.mjs` and the legacy-quote
scan in `tests/legacy-quote-removal.test.mjs` are built on it.

### Clock rule for acceptance tests

Acceptance tests run on an injected clock, never the real one:

- Call a handler factory directly with a fixed clock, for example `crewAvailabilityHandlers({session, storage, now: () => new Date(NOW)})`.
- Or go through `createPagesRouter({now})` or `createHubServer()`/`startEmulatorHarness()`. These default to `HARNESS_NOW` (`2026-09-22T12:00:00.000Z`) and expose it as `hub.clock`. Derive every date from that clock (`addDays(denverToday(hub.clock()), 1)`) and move it with `hub.clock.set(iso)` or `hub.clock.advance(ms)`. Do not use far-future dates to dodge the real clock.
- A new API that reads time must export a factory that takes `{now}` and build its production instance with no arguments: `const handlers = xHandlers(); export const onRequestGet = handlers.get;`. The router can rebind only that shape. `await router.clockedRoutes()` lists which routes and handlers run on the injected clock. The router test fails when a route exports a `{now}` factory but none of its handlers come from it.

## Clock-shift guard

The root suite also runs with the process clock moved 400 days ahead (the `shifted-clock` job
proposed for `.github/workflows/egc-root-ci.yml`; until the repository owner adds it, run it
locally). A test that reads the real clock instead of an injected one then fails today, not on
the day its hard-coded date passes:

```sh
NODE_OPTIONS="--import=$(node -p 'require("node:url").pathToFileURL("tests/helpers/shift-clock.mjs").href')" \
EGC_CLOCK_SHIFT_DAYS=400 node --test tests/*.test.mjs
```

Pass the preload as an absolute `file:` URL. `NODE_OPTIONS` reaches every child `node`, and
`tests/site-generator.test.mjs` starts one in a temporary working directory, where a relative
`--import=./tests/...` fails with `ERR_MODULE_NOT_FOUND`. `--import` also needs a URL rather
than a bare `C:\...` path on Windows.

`tests/helpers/shift-clock.mjs` loads `tests/helpers/clock-shift-core.mjs`, which moves
`Date.now()`, `new Date()`, `Date()`, `new (date.constructor)()`, the `Date.now` property
descriptor and `Intl.DateTimeFormat#format()`/`#formatToParts()` called without a date. Explicit
dates, `Date.parse`, `Date.UTC` and `node:test` mock timers stay exact.
`tests/shift-clock.test.mjs` pins all of this.

### Browser code in vm realms

Every `node:vm` context has its own native `Date`, which the preload never touches. A test that
runs front-end code in a realm must import the drop-in helper instead of `node:vm`:

```js
import vm from './helpers/vm-realm.mjs';
```

`createContext`, `runInNewContext` and `Script#runInNewContext` from the helper give each new
realm the same shift as the test process. Without the preload they are plain `node:vm` realms. A
sandbox that passes its own `Date` (the host `Date` or a fixed clock) keeps it. Every root test
that runs code in a realm without its own `Date` uses the helper; the rest pass the host `Date`
(shifted) or a fixed clock in the sandbox.

### Known blind spots

A green shifted run does not prove these read an injected clock:

| Blind spot | Why | Where it matters |
| --- | --- | --- |
| Realms made with `node:vm` directly | The realm has its own native `Date` | Any new test that imports `node:vm` instead of `tests/helpers/vm-realm.mjs` and gives the sandbox no `Date`. No current root test does |
| `Intl.DateTimeFormat#format()` without a date, in a realm whose sandbox passes its own `Date` but not `Intl` | Only the realm's `Date` is replaced | No current front-end code calls `format()` without a date |
| `performance.timeOrigin`, `performance.now()`, `process.hrtime()` | Left real on purpose; `tests/shift-clock.test.mjs` measures the shift against them | Timing, not calendar logic |
| Worker threads | `--import` preloads do not run in workers | No root test starts a worker |
| Child processes started without this process's `NODE_OPTIONS` | They run on the real clock | `tests/shift-clock.test.mjs` (deliberate); Python runs in `tests/site-generator.test.mjs`, which pin `EGC_SITE_BUILD_DATE` |
| Browser tests (`tests/browser/*.py`, `tests/*.browser.mjs`) | The browser has its own clock | They install a fixed clock with `page.clock.install` |
| Postgres `now()`, the Firestore emulator, the egc-platform Vitest suite | Separate processes or runners | `*.check.mjs`, `tests/firestore-emulator.test.mjs`, `egc-platform` (Vitest uses `vi.setSystemTime`) |
| Backward shifts | Only forward shifts run in CI | Session cookies minted on the real clock and verified under a mocked earlier date (see `tests/field-execution.test.mjs`) fail at negative shifts |

## Pages Functions router

`tests/helpers/pages-router.mjs` maps every `functions/api/**/*.js` file to `/api/<path>` the way Cloudflare Pages does. A new API needs no harness edits.

- `index.js` serves its directory. `[id].js` becomes `params.id`, and `[[path]].js` becomes `params.path` as an array of one or more segments. Files and directories starting with `_` never route.
- Precedence matches Pages: more segments first, then static before `[param]` before `[[catch-all]]`. Within a route, `onRequest<Method>` wins over `onRequest`. When a route has no handler for the method, the next matching route may answer.
- Unknown paths return 404. A known path without a matching method returns 405 with `Allow`. (Pages would fall through to static assets. The harness answers loudly instead.)
- `functions/_middleware.js` and nested `_middleware.js` files run outermost first, as in production (CSP, `no-store`, the business write guard). Pass `middleware:false` to call handlers bare.
- The context is `{request, env, params, data, functionPath, next, waitUntil, passThroughOnException}`. `waitUntil` promises collect in `router.background`, and `await router.settle()` returns their `allSettled` results. A throwing handler becomes a 500 recorded in `router.errors`.
- `now` (a `Date`, ISO string, epoch ms, or a function that returns one) injects the clock. For each module, the router calls every exported synchronous factory whose first parameter destructures `now` (`dispatchHandlers`, `crewAvailabilityHandlers`, `createCustomerPortalHandlers`, `jobPaymentVerifier`, …) with `{now: clock}`. It then swaps each exported `onRequest*` for the matching handler from that clocked instance. Handlers are matched by key (`onRequestGet` to `get`, `GET`, `onRequestGet` or `handleGet`) and by identical closure source. When two closures share source text, the router matches by key only and never guesses. Session, storage, and other dependencies keep their production defaults, so pair the router with the emulator, `firestoreMemory()`, or a `fetch` stub. A factory built with arguments at module level (`xHandlers({storage})`) is left alone, because rebuilding it with only `{now}` would drop them. Async functions are never called. Without `now`, the exports run exactly as in production.
- `tests/helpers/firestore-memory.mjs` `firestoreMemory({fallback})` is an in-memory Firestore REST fake for the production `firestoreFetch` path. It handles document GET, collection list scans, `:runQuery` (AND-ed field filters, `limit`), and `:commit` with `exists`/`updateTime` preconditions. Use it when a router test needs real storage behavior without the emulator. `fallback` receives every non-Firestore request (pass the original `fetch` so loopback test servers stay reachable). All other hosts are refused.

```js
import {createPagesRouter} from './helpers/pages-router.mjs';
const router = createPagesRouter({env: {HUB_SESSION_SECRET: 'synthetic-…'}, now: '2026-09-22T12:00:00.000Z'});
const response = await router.fetch(new Request('https://easygaragecleaning.com/api/hub-auth'));
await router.settle();
```

## Emulator harness

`tests/helpers/emulator-harness.mjs` extracts the `tests/dispatch-field.browser.mjs` pattern. That file itself is unchanged.

- `createHubServer({env})` starts a server on `127.0.0.1` (`HARNESS_HOST`) that serves the site and routes `/api/*` through the router. It binds `127.0.0.1` rather than `localhost` because the Playwright guard in `tests/e2e/helpers/test.mjs` lets only that hostname through, so harness pages can run under the device projects. It exposes `login(user)` (real `/api/hub-auth`, returns the cookie), `api(path,{user,body})`, `authenticate(context,user)` (adds the cookie to a Playwright context), `loginPage(page,user)` (the real crew form), `apiErrors`, `serverErrors`, `clock`, and `close()`.
- The harness clock: `now` defaults to `HARNESS_NOW`. `hub.clock` is a `testClock()`, a function that returns a fresh `Date`, plus `iso()`, `set(value)`, and `advance(ms)`. Every clocked handler reads it on every request (see the clock rule above). Pass `now:'…'` for another fixed start or a function for your own clock. `now:null` gives the real clock, which acceptance tests must not use. A `router` you pass keeps its own clock.
- `startEmulatorHarness({projectId:'demo-egc-…'})` adds `@firebase/rules-unit-testing` with the real `firestore.rules`, `clearFirestore()`, and seeded users (`hubUsers()` hashes them with `hashHubCredential`; the password is `SYNTHETIC_PASSWORD`). It also adds `seed(db => …)` and `readDoc('jobs/id')`, and takes `now` like `createHubServer`.
- `drive:true` (or `harnessHosts({drive:true})` without the emulator) answers `www.googleapis.com` and `oauth2.googleapis.com` with the `tests/helpers/field-fixture.mjs` Drive fake. It sets synthetic `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN` in `env`, and `harness.drive` exposes the stored `files` and `calls`. `hosts:{name: handler}` adds or overrides synthetic hosts. Every other Google host stays refused.
- `emulatorFetch()` rewrites `projects/egcw-1ec83/` to the demo project in the URL and body, and sends `Authorization: Bearer owner`. It passes loopback through and throws `External network refused…` for every other host. Demo project IDs are enforced.

## Parallel-safe Firestore emulator

Never run two suites on the checked-in `firebase.emulator.json` (8089) or `firebase.field-day.json` (8090). `scripts/emulator-exec.mjs` picks free Firestore, websocket, hub, and logging ports. It writes a gitignored `.firebase-emulator.<pid>.json` next to `firestore.rules` and runs `firebase emulators:exec` from a private `test-results/emulator-<pid>/` log directory. The command still runs from your current directory. Afterward it removes the config. It keeps the logs only when the command fails or with `--keep-logs`. Non-`demo-*` projects are refused.

```sh
npm install --no-save --ignore-scripts firebase-tools@15.30.2 @firebase/rules-unit-testing@5.0.2 firebase@12.19.0 playwright@1.63.0
EGC_FIREBASE_EMULATOR_TEST=1 node scripts/emulator-exec.mjs --project demo-egc-field-rules \
  'node --test tests/firestore-emulator.test.mjs tests/emulator-harness.test.mjs'
FIELD_PLAYWRIGHT_MODULE=$PWD/node_modules/playwright/index.mjs node scripts/emulator-exec.mjs \
  --project demo-egc-dispatch-day --config firebase.field-day.json 'node tests/dispatch-field.browser.mjs'
```

Options: `--project` (default `demo-egc-field-rules`), `--config` (base config, default `firebase.emulator.json`), `--keep-logs`, and `--` before a multi-word command. Only the Firestore emulator runs. Ctrl-C reaches firebase through the process group, and SIGTERM is forwarded, so the Java emulator shuts down cleanly. Two concurrent runs pass side by side (rules suite plus harness suite). Java 21 is required.

The free ports are released before Java binds them, so another process can take one in that gap. When firebase fails on a taken port before your command starts, the run is retried once with fresh ports. A taken port shows up as `EADDRINUSE`, "port taken", "is not open on", "configured port is already in use", or Java "Address already in use", in the output or in `firebase-debug.log`/`firestore-debug.log`. A marker file shows whether the command started. A command that already ran is never rerun, even if its own output mentions `EADDRINUSE`. The result reports `attempts` and `retriedPorts`.

## Device e2e (Playwright)

```sh
npm install --no-save --ignore-scripts @playwright/test@1.63.0 playwright@1.63.0   # never add to package.json
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npx --no-install playwright test -c tests/e2e/playwright.config.mjs
npx --no-install playwright test -c tests/e2e/playwright.config.mjs --project=iphone-375 hub-shells
```

- The projects are `iphone-375` (iPhone 13 descriptor in Chromium, 375x812 at 3x), `android-pixel7` (412px wide), `tablet-768` (iPad Mini descriptor, 768x1024, touch; runs `public-pages.spec.mjs` only), and `desktop-1440` (1440x900). The timezone is `America/Denver`, and pages open with `page.clock.install` at `2026-09-22T18:00:00Z`.
- `hub-shell-mobile.spec.mjs` (MOBILE-HUB) runs only in the extra projects `phone-320` (iPhone SE), `phone-390`, `phone-414`, `phone-landscape` (844x390), `ipad-820` and `ipad-1180` (iPad Pro 11, portrait and landscape, touch) and `laptop-1366`, plus `iphone-375` and `desktop-1440`. It opens the signed-in Employee Hub with the Firebase compat SDK stubbed and every `/api/*` answered by `tests/e2e/helpers/hub-fixture.mjs` (long-name synthetic data; the finance job is the real `moneyProjection`), then checks each main view and the sign-in screen for horizontal scroll, 44px targets, 16px fields, AA contrast on sampled text, no public `/styles.css`, and the safe-area top inset, and checks Create job, Record payment and a Hub action dialog are centred (a bottom sheet on phones) with the save reachable. On the phone projects it then sets a 47px status bar and a 34px home indicator (`--egc-safe-top`/`--egc-safe-bottom`) and checks that Create job, Record payment and the Hub modal sit between them, that the recurring plan stays a full-screen sheet whose header and footer take the insets, and that every close and save takes the tap; each view also checks the topbar's Refresh is named exactly "Refresh". `hubReady(page)` waits for a DOM condition (content in `#ops-main`, no loading skeleton), never a delay.
- The web server is `node scripts/visual-audit-server.mjs` on a free port (`EGC_E2E_PORT`), so parallel checkouts never test each other's files. A guard in `tests/e2e/helpers/test.mjs` aborts every request not addressed to 127.0.0.1 and fails any test with an uncaught page error.
- `public-pages.spec.mjs` covers every public page: `publicPages()` in `tests/e2e/helpers/public-pages.mjs` lists each `*.html` on disk outside `PRIVATE_DIRS` in `_generate_site.py` (read from the generator, plus every dot-directory), minus the staff pages that `staff-paths.js` gates or lists as staff sign-in and crew-app files, minus legacy files that `_redirects` answers with a 3xx. That is every generated page, the hand-written ones (FAQ, blog, apply, thank-you, the legacy city pages), before-after, and the signed-out customer shells (`customer-portal.html`, `business-hub.html`, `quote.html`). `tests/e2e-public-pages.test.mjs` proves the list matches the generator and the sitemap and never contains a staff page, so a new page is covered the day it is added. Every page must fit 320px (checked once, in the iPhone project), 375, 412, 768 and 1440 with no horizontal scroll, and have no sub-44px tap target on the three touch projects; before-after's compare slider and buttons are also checked at 1023px, the top of the tablet range. `hub-shells.spec.mjs` covers dispatch (board and create dialog), crew sign-in, day list, and job with photos, employee sign-in, the customer portal (access help and project), and the business hub (gate, overview, and request form). The shells use `route()` fixtures like the Python tests, and crew payloads come from the real `fieldJobProjection`. `mobile-invariants.spec.mjs` proves each check catches a real violation.
- Specs are named `*.spec.mjs`, so the root `node --test tests/*.test.mjs` glob ignores them. Output goes to `test-results/e2e/` and `test-results/e2e-report.json`.
- CI: `.github/workflows/egc-mobile-e2e.yml` runs on pushes and pull requests that touch root `*.html`/`*.css`/`*.js`, `blog/**`, `projects/**`, `crew/**`, `images/**`, `functions/_lib/**`, `_redirects`, `_generate_site.py`, `scripts/visual-audit-server.mjs`, `tests/source-files.mjs`, `tests/e2e/**`, `tests/e2e-public-pages.test.mjs`, `tests/mobile-allowlist.test.mjs`, or the workflow itself. `public-pages.spec.mjs` builds its page list from `_redirects`, `_generate_site.py` and `tests/source-files.mjs`, which is why those are listed. `functions/_lib/**` is needed because the crew fixtures come from `fieldJobProjection`, which imports `job-assignment.js`, `operations-portal-records.js`, and `field-execution-time.js`. If you add a spec fixture that imports from another directory, add that directory to both `paths` lists.

Invariants (`tests/e2e/helpers/mobile-invariants.mjs`):

| Check | Rule | Enforcement |
| --- | --- | --- |
| `assertNoHorizontalScroll` | `documentElement`, `body` scroll width and `innerWidth` ≤ viewport + 1px, which also catches overflow clipped by `body{overflow-x:hidden}` | Hard error |
| `assertTapTargets(page, selector)` | Every visible, on-screen link (`a[href]`, `role=link`), button (`button`, `role=button/tab/menuitem/checkbox/radio/switch`), field, and `summary` is ≥ 44x44, or one of its `<label>` boxes is. Touch projects only. The single exemption: a link that is not `tel:`/`sms:`/`mailto:`, has computed `display:inline`, has a nearest non-inline ancestor that is a `<p>` or `<li>`, and sits in a `<p>`/`<li>` that has words of its own outside every link and button. A link alone in a list item (footer and nav lists), a block or inline-block link, and a link in a `<div>` are all measured. An inline control is measured line by line: every line fragment (`getClientRects()`, padding included) must be 44px tall and 44px wide or a whole line, so a link that wraps into two short lines fails even when its combined box is 44px. Padding must also take taps at the top and bottom of every fragment. Every control, exempt links included, must keep its own words: points on the midline and lower third of each line of its text must hit the control itself, not a different control painted over it (`covered by …`). Fixed and sticky bars never count as the covering control. | Ratchet |
| `assertInputKeyboards` | Phone fields need `type=tel` or `inputmode=tel`, and email fields need `type=email` or `inputmode=email`. Both also need `autocomplete` (the matching token, or `off` where staff type someone else's details). ZIP, money, and quantity fields need a numeric type or `inputmode`. Search and filter boxes are exempt. | Ratchet |
| `assertCameraCapture` | An image upload offers `capture="environment"` alongside a library picker without `capture` | Hard error (known gaps use `assertKnownMissingCamera`, below) |

### Ratchet allowlist

`tests/e2e/mobile-allowlist.json` lists existing tap-target and keyboard debt. A new violation fails the build, and so does a listed one that no longer occurs, until you delete it. The list only shrinks. After an intentional change, rerun with `EGC_E2E_UPDATE_ALLOWLIST=1`, review the diff, and commit it. The global teardown rewrites only the keys that ran. Never regenerate the list to hide a new violation.

Current debt: no tap-target entries. MOBILE-TAP cleared all 441 (60 page keys on iPhone 375 and Pixel 7), and PUBLIC-TAP cleared the rest of the public site (602 on iPhone 375, Pixel 7 and iPad Mini 768 across the blog, FAQ, what-we-take, thank-you, apply, projects and the legacy city pages) with an empty allowlist, so any sub-44px control on any public page now fails. Two keyboard entries remain, both free-text fields where the suggested keypad would block the input:

- `hub:employee hub sign in`: `lqm-amount` (the lead "Mark as Quoted" amount) takes a range such as "$350–$425", which a decimal keypad cannot type.
- `hub:business hub service request form`: `onsiteContact` takes a name and a mobile number in one field ("Name and mobile number"), so a phone keypad would block the name. Splitting it into name and phone fields removes the entry.

How the fixes are built, so new pages follow the same pattern:

- Public pages: one `@media(max-width:1023px)` block in `styles.css` (phones and tablets). Footer list links, the nav logo, the banner link and its dismiss button (a 32px circle inside a 44px button, `background-clip:content-box`) get `min-height:44px`; the footer list drops its 8px gap, so its rows are 44px apart at every width (52px on phones and about 39px on tablets before). A measured link that sits in a line of text becomes `display:inline-flex;align-items:center;min-height:44px`: every `tel:`/`sms:`/`mailto:` link in a `<p>`, the lead-form consent links (`.sms-consent`), links in `<div>` copy (`.def-block`, `div.faq-a`, `.ba-caption`, `.compare-mini-col`), and standalone link rows (`.parent-service-link`, `.turnaround-proof-link`, and `p.faq-more`/`p.more-link`, classes that `_generate_site.py` puts on the "See full FAQ", "View all projects", comparison and review/service-area rows). An inline-flex box is an atomic part of its line, so the line grows around it and no neighbour's hit box reaches its words. Never grow a text link's hit box with vertical padding: it overlaps the lines above and below, and `position:relative` on two such links makes the later one steal the earlier one's taps.
- The rest of the public site: a second `@media(max-width:1023px)` block right after the first. Links that stand alone in a list item or card (blog table of contents and related reading, the blog index "Read more" links, project cards, what-we-take "Learn more" and category links, thank-you steps, the apply page, the estate page's legacy footer, the PPC top-bar phone) are inline-flex 44px boxes; blog card titles and the FAQ sidebar are 44px flex rows. The FAQ page's single-line questions (`.faq-sections summary.faq-q`) get 11px vertical padding that negative margins hand back, so the page does not move (scoped to `.faq-sections` so the home page accordion keeps its own padding). Horizontal scroll at 320px came from fixed-width headers and atomic links: the nav logo may shrink (it is a `background-size:contain` image), the apply page logo drops the shared image logo it was drawing behind its text, the estate price row wraps, `tel:`/`sms:`/`mailto:` links in a `<p>` may wrap anywhere inside their inline-flex box, and the blog index grid column is `minmax(min(320px,100%),1fr)`. The before-after slider is 44px tall up to 1023px (`gallery-simple.css`). A standalone link row in a hand-written page gets `class="more-link"`.
- Links in the running text of a `<p>` or `<li>` (the exemption above) keep their inline layout and get no padding.
- Hub shells: each module's own stylesheet (`employee-dispatch.css`, `crew/job.css`, the customer portal's inline `<style>`) and, for the Employee Hub sign-in and portal bar, `employee-mobile.css`.
- `styles.css` is served `immutable`, so any change to it bumps its `?v=` version everywhere: `HEAD` and the `patch_static_pages` regex in `_generate_site.py`, `functions/before-after.js`, the private shells (`employee.html`, `copilot.html`, `quote.html`), then `EGC_SITE_BUILD_DATE=<buildDate> npm run site:build`. `tests/public-audit-fixes.test.mjs` pins the version to the file's SHA-256 (`STYLES_RELEASE`), so a change or a merge that combines two branches' edits fails until the version and the pin are updated.

Layout impact of the tap-target block against the stylesheet before it (Chromium, fonts blocked as in the e2e run; home, book, FAQ, blog, pricing, about, two service pages, a city page and before-after): on phones (320-412px) most pages are 105-176px shorter because the footer list lost its gap (before-after 64px), while the home page is 53-89px taller and the flat-rate junk removal page up to 54px taller, from lines that hold a 44px link. Tablets grow: at 768px pages are 145-337px taller (143-157px of it is the footer; before-after 66px), and at 1023px 29-231px. Desktop (1440px) is unchanged. The second (PUBLIC-TAP) block leaves home, book, pricing, garage-guard, FAQ, about, reviews, the city and service pages, privacy and terms at their height at 375, 768 and 1440 (one legacy city page moves 1px at 768); at 375 the blog index is 429px taller, what-we-take 292px, before-after 196px (the 44px slider), blog posts -20 to +190px depending on their table of contents, and apply, thank-you, projects and the estate page 23-53px; at 768 the blog index is 226px taller, what-we-take 146px, before-after 169px, blog posts +20 to +340px, and apply, thank-you, projects and the estate page 15-39px. The signed-out customer portal's consent label (`.help-consent`) is 44px tall only up to 1023px, so the portal is 13px taller at 768 and unchanged at 375. No public page changes height at 1440. The public-page e2e now runs 320, 375, 412 and 768; review 1023 screenshots after changing either block.

### Known camera gaps (TODO)

Each entry below is in the spec's `KNOWN_NO_CAMERA`. The camera test for that page still has to load the page and find its image upload and its library picker (`assertKnownMissingCamera`). Only the missing `capture="environment"` option is tolerated, so a broken page, a missing upload, or a fixture error fails normally. Once the camera option is added, the test fails until you delete the entry here and in the spec. The page then moves to the full `assertCameraCapture`. Overflow has no known-failure escape hatch.

- [ ] `/book.html`: the walkthrough form photo input is library-only. Add a `capture="environment"` "Take a photo" input beside it.
- [ ] `/pricing.html`: same form, same fix.
- [x] `customer portal project`: fixed by PHOTO (a `#photo-camera` `capture="environment"` input sits beside `#photo-input`); the known gap was removed from `hub-shells.spec.mjs`.

No page scrolls horizontally at 375, 412 (Pixel 7), or 1440.

The signed-in Employee Hub dashboard is covered by `hub-shell-mobile.spec.mjs`, which answers the gstatic Firebase compat script with a local stub (`hubFixtures` in `tests/e2e/helpers/hub-fixture.mjs`).

## Python browser tests

```sh
python3 -m venv .venv && . .venv/bin/activate && pip install playwright==1.57.0
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome python3 tests/browser/test_dispatch_ui.py
```

These tests mount one module on a stub page with `page.route` fixtures. They run at `timezone_id='Asia/Tokyo'` to catch device-timezone bugs.

The Hub shell tests (`test_hub_shell_ui.py`, `test_hub_mobile_ui.py`, `test_hub_shell_mobile_ui.py`) load the real `employee.html` through `tests/browser/hub_shell_harness.py`. `open_page(width, height, profile, mobile=, touch=)` sets the viewport (touch gives `(pointer:coarse)`), `settle()` waits for the Hub to finish loading, and `audit(scope)` runs the layout probe: page overflow, clipped or ellipsised text, 44x44 targets, fields under 16px, generic font fallbacks, low-contrast text, dialogs outside the viewport, overlapping controls, visible `aria-hidden` content, and leaked public section padding. `dialog_box()` and `contrast()` measure one dialog or a list of selectors; `test_hub_shell_mobile_ui.py`'s `inset_problems()` repeats the dialog check under a 47px status bar and a 34px home indicator.

## Test environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `EGC_FIREBASE_EMULATOR_TEST` | emulator tests | `1` enables emulator-only tests (otherwise skipped) |
| `FIRESTORE_EMULATOR_HOST` | emulator tests | Set by `emulators:exec`. It must be loopback. |
| `GCLOUD_PROJECT` | emulator | Set by `emulators:exec` to the `--project` value |
| `EGC_FIREBASE_TEST_MODULES` | emulator tests, `emulator-exec` | Directory whose `node_modules` holds firebase-tools and rules-unit-testing (for example a `/tmp` prefix) |
| `EGC_FIREBASE_BIN` | `emulator-exec` | Override the firebase CLI (tests point it at a fake) |
| `FIELD_PLAYWRIGHT_MODULE` | `dispatch-field.browser.mjs`, `field-execution.browser.mjs` | Absolute path to `playwright/index.mjs` |
| `FIELD_BROWSER_ENGINE`, `FIELD_BROWSER_CHANNEL`, `FIELD_QA_OUTPUT` | `field-execution.browser.mjs` | Engine, channel, and screenshot directory |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | all browser tests | Chromium binary to launch instead of a downloaded one |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright | Browser cache directory (see the container recipe) |
| `EGC_E2E_PORT` | e2e | Fixed audit-server port (default: a free port) |
| `EGC_E2E_REUSE_SERVER` | e2e | `1` reuses a server already on `EGC_E2E_PORT` |
| `EGC_E2E_WORKERS` | e2e | Worker count: a positive integer (passed as a number) or a percentage such as `25%` (default `50%`). Anything else stops the config with an error. |
| `EGC_E2E_UPDATE_ALLOWLIST` | e2e | `1` rewrites the ratchet allowlist from this run |
| `EGC_VISUAL_AUDIT_PORT` | `scripts/visual-audit-server.mjs` | Listen port (default 8765) |
| `EGC_TEST_SITE_ROOT` | `portal-invitation-ui.test.mjs` | Alternate site root |
| `CI` | e2e | Forbids `test.only` and keeps traces for failures |
| `EGC_CLOCK_SHIFT_DAYS`, `NODE_OPTIONS=--import=<file: URL of tests/helpers/shift-clock.mjs>` | clock-shift guard | Days to move the process clock (the CI job uses 400) and the preload that applies it |
| `DATABASE_URL`, `EGC_OPERATIONS_TEST=isolated` (also `EGC_META_TEST`, `EGC_CUSTOMER_STATE_TEST`) | platform `*.check.mjs` | Loopback `egc_operations_test` database guard |
| `TZ` | `tests/hub-field-integration.test.mjs` | Set to `Asia/Tokyo` inside one test and restored afterwards, to prove Denver dates do not follow the machine time zone. Leave it unset. |
| `EGC_ACCEPTANCE_MCP_URL`, `MCP_BEARER_TOKEN` | `scripts/operations-acceptance.mjs` | MCP endpoint and bearer token for the read-only operations acceptance report. Owner-run against a real deployment; never used by the test suites. |

Platform unit tests set and restore the feature flags they exercise (`OPENAI_API_KEY`, `META_CAPI_*`, `MCP_BEARER_*`, `EGC_OPERATIONS_*`, `EGC_MCP_DIRECT_SENDS_ENABLED`). Leave those unset when you run the suites. The operations scripts `scripts/backfill-arrival-windows.mjs` and `scripts/repair-stale-schedule-instants.mjs` read production credentials (`FIREBASE_SERVICE_ACCOUNT_JSON`, `EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_*`), which are documented in `.env.example`. No test reads them.

## Container recipe (Claude Code agents)

- Chromium is preinstalled at `/opt/pw-browsers`. Never run `playwright install`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
- Playwright 1.63 looks for build 1243 when a script ignores `executablePath`. Point `PLAYWRIGHT_BROWSERS_PATH` at a directory that symlinks 1243 to the installed 1194:
  ```sh
  B=$TMPDIR/pwb
  mkdir -p $B/chromium-1243/chrome-linux64 $B/chromium_headless_shell-1243/chrome-headless-shell-linux64
  ln -sf /opt/pw-browsers/chromium-1194/chrome-linux/chrome $B/chromium-1243/chrome-linux64/chrome
  ln -sf /opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell $B/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell
  touch $B/chromium-1243/INSTALLATION_COMPLETE $B/chromium_headless_shell-1243/{INSTALLATION_COMPLETE,DEPENDENCIES_VALIDATED}
  export PLAYWRIGHT_BROWSERS_PATH=$B
  ```
- For Python, create a venv and run `pip install playwright==1.57.0`. That version uses build 1194 directly.
- Install emulator and Playwright tooling with `npm install --no-save --ignore-scripts …` in a single command. A later `--no-save` install prunes packages that an earlier one added. Delete the generated `package-lock.json`; the root lockfile is not committed.
- Firestore emulator: always go through `scripts/emulator-exec.mjs`, so concurrent agents never share 8089/8090 or the hub/logging ports.
- Postgres: give each agent its own cluster instead of sharing `egc_operations_test` (its tables are truncated per test):
  ```sh
  P=5561   # any free port; pg_lsclusters shows the ones in use
  pg_createcluster 16 agent$P -p $P -- --auth-local=trust && pg_ctlcluster 16 agent$P start
  psql -h /var/run/postgresql -p $P -U postgres -c "create role egc_test login superuser password 'isolated_ci_only'" -c 'create database egc_operations_test owner egc_test'
  export DATABASE_URL=postgres://egc_test:isolated_ci_only@localhost:$P/egc_operations_test EGC_OPERATIONS_TEST=isolated
  # afterwards: pg_ctlcluster 16 agent$P stop && pg_dropcluster 16 agent$P
  ```
- Platform checks: work in a scratch copy with `pnpm install --no-frozen-lockfile && pnpm build:packages && pnpm typecheck && pnpm test && pnpm build`, or restore `egc-platform/apps/portal/next-env.d.ts` afterwards.
