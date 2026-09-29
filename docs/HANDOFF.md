# Easy Garage Cleaning Hub handoff

Snapshot: **2026-09-29**. Read current GitHub checks before a merge. This snapshot records code and test evidence; it does not claim production deployment or activation.

## What this is

The Employee Hub connects office work, crew jobs, customer portals, HighLevel and the Railway operations services. The owner authorized completing the mobile Hub, Walkthroughs, transcript intake and office handoff, using existing credentials. The original queue remains serial and no unrelated new units start. Owner instructions are preserved verbatim in [decisions.md](handoff/decisions.md).

## Release state

- GitHub main was `59d617acda3422de90537b9c87a11f8be34b93f8` at the last check.
- [Batch 8 PR #86](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/pull/86) originally contained SALES-BOOKING, WT-OUTCOME, FIX-DISPATCH-QUEUE and MOBILE-HUB at `6cc4cad8`. Its old Dispatch browser failure is addressed by reusing the loaded queue when switching views, preventing a second fetch from replacing a row while someone taps Find a time.
- The completion candidate adds credits **889f307**, handoff **d173e71**, then FIELD-PAY **d769ac5**, in that order. FIELD-PAY source is **2b1c1b8ace9deccd8b827f89a42c76e17d9fa00f**. Final combined CI, including the new real Firestore checks, is pending at this snapshot.
- [Batch 9 PR #87](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/pull/87), branch `codex/hub-ios-walkthrough-completion`, passed all eight workflows at **bf191d92c9de6ce394b8166d9fd53039d7e25104**. It awaits Batch 8, then reintegration and fresh checks on its resulting head.
- Neither batch has been merged to main or deployed by this task at this snapshot. Use live PR checks for newer results; historical successful heads are not evidence for later commits.

## Completed work

**Collected credits:** the Verified collected tile counts verified cash after subtracting applied gift credits. Credit-only payments settle the bill while showing zero cash; mixed payments count the cash portion; inconsistent splits show review. Primary and independent review and **159 targeted tests** passed.

**FIELD-PAY:** the assigned lead collects the exact remaining balance through Stripe or submits a private cash/check receipt photo. Cash/check stays pending until manager approval atomically updates the existing money ledger and receipt decision. Durable card claims, frozen retry IDs, current balance/assignment checks, private per-session evidence and existing Review queues protect interrupted requests. Direct browser edits wait while a card checkout is active. Approved payments have a native HighLevel note handoff and a visible manager retry state. See [FIELD-PAY.md](FIELD-PAY.md).

FIELD-PAY primary and independent review findings were addressed. The final combined local payment, money, review and automation tests passed **139/139**; its focused browser tests passed **15/15 Chromium and 15/15 WebKit**, including manager finance badges and retry states. Existing crew drafts **8/8**, tips **3/3** and field expenses **23/23** also passed. The original unpublished candidate's reported review is not claimed for this implementation.

**Walkthroughs and office handoff:** PR #87 contains the role-correct phone menu, audio/recording intake, pasted or uploaded TXT/MD/VTT/SRT transcripts, exact-visit permission checks, reviewed scope and assigned Hub tasks. The office sees the saved customer, copyable instructions and a verified HighLevel contact link or search fallback. Tasks and notes require review where specified; the implementation does not automatically send customer messages. Existing OpenAI configuration is reused.

PR #87's eight green workflows are Root, Platform, Operations Integration, Firestore, Business Hub, Mobile Device E2E, Lighthouse and Action Center. Its local browser evidence also includes Walkthroughs **10/10**, Hub mobile **18/18**, Action Center **32/32** and recordings **13/13 WebKit**. These results belong to the stated PR head.

## Rules and launch order

1. Keep units serial, tested and reviewed. Merge Batch 8 only when FIELD-PAY is included and all required checks on its final head pass. The remaining completed work lands through Batch 9 after its own checks.
2. FIELD-PAY ships with **EGC_FIELD_PAY_ENABLED off**. New intake requires it, **MONEY_API_ENABLED=true** and **MONEY_UNIFIED_TOTALS=true**. Publish the private Firestore rules first and verify the existing money backfill/shadow rollout prerequisites. Keep pending payment evidence and review recovery available during rollback.
3. **FIX-REFUNDS and GHL-TRACK-2 remain parked and off.** Their implementation commits and exact activation flag names were not located. The PR reports refunds reviewed once and milestone tags needing a clean review; this is reported state, not evidence of reviewed source. Obtain the actual source, record review state in commit and handoff, and merge disabled.
4. HighLevel owns customer communication and follow-ups. The payment handoff reuses its existing payment-received tag only after verified money and the native note outbox; downstream workflow review remains recorded in the automation registry. No live messages or charges were used for tests.
5. Never infer production readiness from synthetic tests or a configured-key badge. Verify deployed revisions, rules, permissions and real-account acceptance separately.

Machine-readable queue and state: [launch-order.json](handoff/launch-order.json), [unit-status.json](handoff/unit-status.json), [follow-ups.json](handoff/follow-ups.json).

## Parked inventory

The promised **41 authoritative specs** were not found in the inspected checkout or published PR head: **0/41 located**. The seven reported running builds have not been identified. [spec-inventory.json](handoff/spec-inventory.json) records these gaps. Obtain those sources and IDs; do not fabricate requirements or mark absent work complete. These inventory gaps are separate from the implemented transcript-to-office flow.

## How to verify and run

- Root: `npm install --ignore-scripts`, then `npm test`. CI repeats the suite with its injected clock shifted 400 days.
- Platform: from `egc-platform/`, `pnpm install --frozen-lockfile`, `pnpm build:packages`, `pnpm typecheck`, `pnpm test`, `pnpm build`; use the workflow's PostgreSQL checks when platform behavior changes.
- FIELD-PAY browser: `python tests/browser/test_field_pay_ui.py`; set `EGC_TEST_BROWSER=webkit` for iPhone engine coverage. Walkthrough, mobile and recording suites are in `tests/browser/`.
- Real database rules and atomic operations: use `.github/workflows/egc-firestore-ci.yml` and its isolated loopback emulators. Never point emulator tests at production.
- Automation inventory: `node scripts/automation-inventory.mjs --check`. Registration records the writer; it does not approve a downstream customer workflow.
- On Windows, existing full-suite POSIX/line-ending fixtures can differ; Linux CI on the final head is the merge gate. The new emulator tests have not yet run at this snapshot.

## Production and owner actions

The read-only Railway snapshot showed API, MCP and worker at `8081d74b677bf2ff47523bf246236cdc4fbf4708` and portal at `038c1186ba7c69aafca34d82854fa11677a88bf2`. The older API lacks recording.transcript. Existing API configuration names, including OPENAI_API_KEY, are present; no key values were printed or replaced.

The owner signed into the live Hub, and its office pages are accessible. Integrations reports the main Hub/HighLevel/Firebase/OpenAI/Stripe connections configured. Google Drive and Firebase sign-out verification still report setup needed; the cause of the latter has not been established. FIELD-PAY photos use private Firestore storage and do not depend on Drive.

Firebase and Cloudflare release-console sign-in has been requested and remains pending at this snapshot. Hub login does not provide those administrative sessions. After green merges, publish the reviewed Firebase rules/indexes, verify Cloudflare's actual deployment and flags, and deploy the same merged release to all four existing Railway services. Do not replace services or keys. Follow [GO-LIVE.md](GO-LIVE.md) and `egc-platform/docs/railway-deployment.md`.

Finish with authorized synthetic live acceptance: assigned walkthrough transcript draft, manager review and one office task, correct customer/contact association, retry without duplication, role denial and phone layout. A real customer send or card charge is not part of this test. Record actual outcomes before calling the release production verified.

## Continue from here

Fetch current heads/checks; complete Batch 8 CI and merge gate; integrate Batch 8 into PR #87; resolve shared asset versions and handoff status; rerun checks; merge Batch 9; publish matching services/rules; complete the live acceptance above. Refresh this handoff and the release evidence with actual results. Keep the original queue's missing specs, unlocated units and owner configuration work visible.
