# AGENTS.md — shared playbook for coding agents

Read this before every task. It applies to every agent (Claude Code, Codex, ChatGPT) working on this repo.
Production deploys from `main`. Several agents work in parallel, so stay inside your claimed area.
Deeper detail is in `docs/testing.md` (tests), `docs/HIGHLEVEL-BOUNDARY.md` (HighLevel), `docs/env-inventory.md`
(variables) and `docs/GO-LIVE.md` / `docs/OWNER-GO-LIVE-CHECKLIST.md` (what the owner turns on).

## 1. What the system is

Easy Garage Cleaning (EGC) is a garage cleanout, organization and junk-removal business in Northern Colorado. The
site is Cloudflare Pages (static pages plus Pages Functions in `functions/`) on Firestore, plus a Railway
service in `egc-platform/`.

| Area | Files | Used by |
| --- | --- | --- |
| Employee Hub | `employee.html`, `employee-*.js/css` (`employee-suite.js` is the core), `dispatch.html`, `hub-sw.js` | Owner and office: dispatch, money, staff, catalog and pricing, Knock admin |
| Estimator walkthrough | `crew/gameplan.html`, `crew/quote-draft.js` (quote builder), `crew/walkthrough-*.js`, `crew/gameplan-*.js` | Estimators (the Sales role) at the customer's garage |
| Crew apps | `crew/index.html`, `crew/job.html` + `job.js`, `crew/schedule.html`, `crew/field-*.js`, `crew/sw.js` (offline shell) | Crew on phones |
| Door-to-door | `crew/knock.html`, `crew/knock-*.js` (`knock-admin.js` is the office side) | Door-to-door reps |
| Customer side | `customer-portal.html`, `client-login.html`, `quote.html`, `book.html`, `business-hub.html` | Homeowners and business clients |
| Public site | `*.html` at the root, `blog/`, `projects/`, built by `_generate_site.py` | Prospects |
| API | `functions/api/**` (one route per file), shared logic in `functions/_lib/**`, middleware in `functions/_middleware.js` | All of the above |
| Platform | `egc-platform/apps/{api,mcp,worker,portal}` (pnpm workspace, Railway) | Background workers, MCP, the signed bridge |
| Rules and data | `firestore.rules`, `firestore.indexes.json`, `functions/_data/` | — |

## 2. How to run checks

CI is `.github/workflows/egc-*.yml`. Root CI runs on every PR; the rest run only when their `paths:` match.
Run what your change touches before pushing. Recent `main` run times are given below.

**Root CI** (`egc-root-ci.yml`, always runs, about 2–3 min):
```sh
npm install --ignore-scripts --no-audit --no-fund
node --test tests/*.test.mjs              # ~5,300 tests, about 100 s locally; same as `npm test`
shopt -s globstar nullglob; for f in *.js crew/*.js functions/**/*.js; do node --check "$f"; done
node scripts/render-before-after.mjs --check
node scripts/funnel-definitions.mjs --check
node scripts/automation-inventory.mjs --check
```
**The 400-day shifted clock** (same workflow, `shifted-clock` job). A test that reads the real date fails here:
```sh
NODE_OPTIONS="--import=$(node -p 'require("node:url").pathToFileURL("tests/helpers/shift-clock.mjs").href')" \
EGC_CLOCK_SHIFT_DAYS=400 node --test tests/*.test.mjs
```
**Firestore emulator and field browser tests** (`egc-firestore-ci.yml`, about 3–4 min; Java 21). Install the tools in
one command (a later `--no-save` install prunes the earlier one), then always go through `scripts/emulator-exec.mjs`
so parallel agents never share ports:
```sh
npm install --no-save --ignore-scripts firebase-tools@15.30.2 @firebase/rules-unit-testing@5.0.2 firebase@12.19.0 playwright@1.63.0
EGC_FIREBASE_EMULATOR_TEST=1 node scripts/emulator-exec.mjs --project demo-egc-field-rules \
  'node --test --test-concurrency=1 tests/firestore-emulator*.test.mjs'
FIELD_PLAYWRIGHT_MODULE=$PWD/node_modules/playwright/index.mjs node tests/field-execution.browser.mjs
```
The workflow also runs `tests/dispatch-field.browser.mjs`, `field-multiday.browser.mjs`, `knock-emulator.test.mjs` and
`knock.browser.mjs`; copy the exact lines from the workflow.

**Mobile device e2e** (`egc-mobile-e2e.yml`, about 3–5 min). Never add Playwright to `package.json`:
```sh
npm install --no-save --ignore-scripts @playwright/test@1.63.0 playwright@1.63.0
node --test tests/mobile-allowlist.test.mjs
npx --no-install playwright test -c tests/e2e/playwright.config.mjs
```
**Python browser tests** (`tests/browser/test_*_ui.py`, Playwright 1.57.0 in a venv): Action Center CI (WebKit, about
12 min), Business Hub Acceptance (about 1 min) and others. **Lighthouse** (about 8–9 min) asserts performance and
accessibility ≥ 0.9. **Platform** (`egc-platform-ci.yml`): `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build`.

In a Claude Code container, Chromium is at `/opt/pw-browsers`; follow "Container recipe" in `docs/testing.md`
(build-1243 symlinks, per-agent Postgres cluster). Never run `playwright install` there.

**Known flaky spots**, all with fixes already in place; do not paper over a new failure as "flaky":
- Emulator port races: `emulator-exec.mjs` claims each run's ports under a cross-process lock, and retries once with fresh ports when firebase exits before the command starts.
- Two cold emulators downloading the jar together: CI runs `firebase setup:emulators:firestore` first.
- Feed tests once flaked on random ids containing `1437`/`7777`; they now use deterministic ids. Use fixed ids too.
- Tests that read the real clock fail only under the shifted clock or after a date passes. Inject time.

## 3. Conventions

**Cache keys (`?v=`).** Crew and Hub assets are cached by URL: `crew/sw.js` and `hub-sw.js` keep device copies of the
versioned files, and `styles.css`, `site-forms.js` and `booking-slots.js` are served `immutable` (`_headers`).
When you change a versioned crew file (`crew/**`) or one of the `immutable` files, bump its `?v=` in **every** place
that references it: the HTML pages, the `ASSETS` list in `crew/sw.js` (and its `VERSION` when the shell changes),
and the tests that pin the key (`tests/crew-service-worker.test.mjs` and others; grep for the old key).
**Hub files are the exception: never bump them.** The `?v=` keys on `/employee-*.js|css` in `employee.html` and the
`v:` values in the `employee-hub-screens.js` registry stay as they are. `/employee*` is served `no-store` and
`hub-sw.js` asks the network first with the saved copy's ETag, so a changed Hub file is never served stale
(`tests/hub-pwa.test.mjs`), and bumps there only made parallel PRs conflict. The one cost is a stalled connection,
where a device may run one older Hub file until the next load.
A `styles.css` change follows the steps in `docs/testing.md` (`STYLES_RELEASE` in `tests/public-audit-fixes.test.mjs`).

**Launch defaults (`functions/_lib/launch-defaults.js`).** Features are behind env switches compared to exactly
`"true"`. `LAUNCH_DEFAULTS` lists the switches the owner chose to have on without Cloudflare;
`functions/_middleware.js` fills each unset one into `env`. A value set in Cloudflare always wins, so `"false"` turns
it off. Handlers called directly in tests see their env unchanged. Add a switch here only on an owner decision, and
keep the file's comment saying which switches stay off and why (e.g. `EGC_STAFF_ROLE_ACCESS`, `EGC_GHL_SCHEDULE_MIRROR`).

**Money stays out of crew views.** Crew never see a customer's prices. `functions/_lib/crew-money.js`
(`stripCrewMoney`, `signedBriefJob`) removes amounts from crew-visible text; `functions/_lib/field-execution.js`
applies it. Any new field shown to crew goes through these helpers. Estimators see prices; crew do not.

**Generated files: never edit by hand; regenerate and commit, and the checked-in file must match the generator.**
| File | Regenerate with | Checked by |
| --- | --- | --- |
| `docs/env-inventory.md` | `node scripts/env-inventory.mjs --write` (edit the `.env.example` comment first) | `tests/env-inventory.test.mjs` |
| `docs/automation-registry.md` | `node scripts/automation-inventory.mjs --write` (from `functions/_lib/automation-registry-data.js`) | Root CI `--check` |
| Funnel definition copies | `node scripts/funnel-definitions.mjs --write` | Root CI `--check` |
| Static Before & After fallback | `node scripts/render-before-after.mjs` | Root CI `--check` |
| Public site pages | `EGC_SITE_BUILD_DATE=<recorded date> npm run site:build` (`_generate_site.py`) | `tests/site-generator.test.mjs` |
| `functions/_data/walkthrough-services.js` | `node scripts/generate-walkthrough-services.mjs --write` | `tests/pricing-config.test.mjs` |
| Conversation catalog index | `node scripts/generate-catalog-index.mjs --write` | `tests/catalog-index.test.mjs` |

Use the build date the failing test prints. A new code path that reads an env variable must be documented in
`.env.example`, or `tests/env-inventory.test.mjs` fails.

**Test style.** `node:test` + `node:assert/strict`, files named `tests/<area>.test.mjs` (e2e specs are `*.spec.mjs`).
Synthetic data only; no test reaches production or any external host. Inject the clock: an API that reads time
exports a factory taking `{now}` and builds its production instance with no arguments
(`const handlers = xHandlers(); export const onRequestGet = handlers.get;`). Use `tests/helpers/pages-router.mjs`,
`firestore-memory.mjs` and `emulator-harness.mjs` instead of writing new harnesses; run browser code in realms via
`tests/helpers/vm-realm.mjs`; walk files with `sourceFiles()` from `tests/source-files.mjs`. Money is integer cents.

**Never skip, disable, quarantine or weaken a test** to get green, and never regenerate a ratchet
(`tests/e2e/mobile-allowlist.json`) to hide a new violation. Fix the code, or fix a test that is genuinely wrong
and say why in the PR.

## 4. Business rules agents must not break

Each rule is an owner decision recorded in the code. Changing one needs the owner, not an agent.

- **Deposit 25% / 75%.** A quote signed on the walkthrough takes 25% on the signing day and 75% on the job day
  (`SIGNED_25_75`); a sent quote takes 25% when the customer approves it and 75% on the job day (`SENT_25_75`).
  `functions/_lib/quote-payment-policy.js` (`snapshotQuotePaymentPolicy` rejects any other split). A job keeps the
  terms it was signed on.
- **Labor line $53.00 per man-hour.** `DEFAULT_LABOR_RATE_CENTS = 5300` in `functions/_lib/composite-quote.js`. The
  owner's rate in Firestore (`pricingMenuApprovals/current` → `laborRatePerManHourCents`, set on Hub Menu prices)
  overrides it. The rate is never read from the browser; the server re-prices.
- **Junk-only quotes: $1,000 per truck, no Labor line** (owner decision 2026-10-21, was $750; partial loads scale
  from it). At least one truck load and otherwise only special-handling
  items and access charges (`junkOnly`, `HAULING_GROUPS` in `functions/_lib/composite-quote.js`). Special items or
  access without a truck are not junk-only and keep the Labor line. Any garage work needs the Labor line.
- **Minimum pickup $250 on hauling-only quotes** (owner decision 2026-10-21), unless an audited "truck already nearby"
  waiver applies. A builder quote whose menu lines are all hauling (`HAULING_GROUPS`, with or without a truck load) and
  totals under $250 gets a "Minimum pickup" line up to $250 (`functions/_lib/pickup-minimum.js`, server-only). The waiver
  needs a reason and a same-day scheduled job in the same 5-digit ZIP code, or the owner. The winter sale never takes a
  pickup below $250. Approved or signed jobs keep their waiver when moved (an audited note); an unapproved one is
  checked again for its new day.
- **Customers see Labor as one amount**, "Labor", never the man-hours, the rate or hourly wording (D-LABOR-TEXT,
  `functions/_lib/composite-quote.js`). Man-hours stay in the staff breakdown.
- **Draft prices can be saved but never sent.** Owner-unapproved menu prices may sit on an unsent draft;
  `functions/_lib/quote-draft.js` re-checks `compositeApproval()` at send preview and send
  (`quote_draft_composite_prices_unapproved`).
- **Commission rates** (`CHANNEL_PERCENTS` in `crew/knock-money.js`): door-to-door direct sale 25%, appointment setter
  13%, estimator 7%. One job pays once and the shares never stack (`functions/_lib/estimator-commission.js`,
  `functions/_lib/knock-setters.js`). Rows show no amount until the owner approves the terms.
- **The Hub is the source of truth; HighLevel is a second record.** HighLevel owns customer messages and follow-ups;
  the Hub owns the schedule, jobs and money and only tells HighLevel. Never add a HighLevel write or a customer send
  that is not a real, flagged send: register it in `functions/_lib/automation-registry-data.js` and follow
  `docs/HIGHLEVEL-BOUNDARY.md`. New flags compare to exactly `"true"` and default off.

## 5. Multi-agent rules

1. **One agent per area at a time.** Before starting, open (or take) a GitHub issue describing the area and label it
   `agent:claude` or `agent:codex`. Check open issues and draft PRs first; if another agent holds the area, pick
   other work or ask the owner. Link your PR to the issue (`Closes #N`).
2. **Small, focused draft PRs.** One change per PR, opened as a draft, driven to green CI. Do not mark it ready or
   merge it; the owner merges.
3. **Never push to another agent's branch**, and never rewrite history on a shared branch. Work on your own branch
   named for your agent and topic (Claude sessions use `claude/<topic>`).
4. **Hot files** — change most often and collide most; comment on the owning issue before editing and keep edits small:
   `crew/gameplan.html`, `crew/quote-draft.js`, `functions/_lib/walkthrough-handoff.js`, `functions/_lib/quote-draft.js`,
   `functions/_lib/launch-defaults.js`, `employee-suite.js`, plus `employee.html`, `crew/sw.js` and its test,
   `.env.example`/`docs/env-inventory.md` (regenerate, don't hand-merge) and `_generate_site.py`.
   Refresh the list with `git log --format= --name-only | sort | uniq -c | sort -rn | head -40`.
5. **Merges, not rebases.** Bring `main` into your branch with a merge commit (`Merge main (…) into the <topic> branch`)
   and resolve conflicts there; regenerate generated files rather than hand-merging them. PRs land on `main` as merge
   commits (`Merge pull request #N: <title>`). After a merge that combined two branches' edits, re-run the root suite:
   the `?v=` pins and `STYLES_RELEASE` catch content that changed without a bump.
6. **No secrets in the repo.** Values live in Cloudflare and Railway. `.env.example` documents names only;
   `tests/env-inventory.test.mjs` fails on a live Stripe key, webhook secret or private key. Tests use `demo-*`
   Firestore projects and synthetic values.
   **This repo is public.** Anything in a commit, issue, PR, review or comment can be read by anyone. Never paste
   customer data (names, addresses, phone numbers, emails), secrets or env values, margins or costs, or anyone's
   pay into them. Use synthetic data in tests and examples, and cite a file path rather than restating internal numbers.
7. **PR descriptions are for the owner.** Plain English, no jargon first. Say what changes for which people (owner,
   office, estimators, crew, door-to-door reps, customers), what stays off and what switch turns it on, and what the
   owner must do, if anything. Then list the tests you ran. Commit messages follow the same style: one sentence on
   what changed for whom (see `git log`).

## Code Review Rules

Every automated reviewer (Claude Code Review, Codex code review) follows these rules. Flag only what would hurt the
business or its customers if merged. Do not post style, naming, formatting or wording nits.

Flag:
- **Real bugs**: wrong results, crashes, lost or duplicated writes, races, a missing `await`, off-by-one dates, or
  time read from the real clock instead of an injected one.
- **Security and privacy**: an auth or role check skipped (staff gate, crew scope, business-account isolation,
  `firestore.rules`), a secret or customer data in code, logs or responses, or data from one customer shown to another.
- **Broken business rules** (section 4): money reaching a crew view; a deposit split or due rule other than the ones in
  `quote-payment-policy.js`; a Labor line on a junk-only quote, or a missing one on garage work; man-hours or the
  rate shown to a customer; an unapproved draft price that can be sent; commission shares that stack or change;
  a price or labor rate taken from the browser; a new HighLevel write or customer send that is unflagged or unregistered.
- **Broken conventions that fail later**: a changed crew or `immutable` asset without a `?v=` bump (never a Hub
  `/employee-*` file), a hand-edited generated file, a new env read missing from `.env.example`, or a skipped,
  disabled or weakened test.

For each finding, name the file and line, the input or path that triggers it, and what goes wrong. If you cannot
trace a realistic path, don't post it.
