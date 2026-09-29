# Easy Garage Cleaning Hub handoff

Snapshot: **2026-09-29**. Read current GitHub checks before a merge. This snapshot records code and test evidence; it does not claim production deployment or activation.

## What this is

The Employee Hub connects office work, crew jobs, customer portals, HighLevel and the Railway operations services. The owner authorized completing the mobile Hub, Walkthroughs, transcript intake and office handoff, using existing credentials. The original queue remains serial and no unrelated new units start. Owner instructions are preserved verbatim in [decisions.md](handoff/decisions.md).

## Release state

- GitHub `main` includes the Batch 8 merge **a0297623276e0d0bed78dbdb789957367b8a60dd**. This records the merge, not a production deployment.
- [Batch 8 PR #86](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/pull/86) originally contained SALES-BOOKING, WT-OUTCOME, FIX-DISPATCH-QUEUE and MOBILE-HUB at `6cc4cad8`. Its old Dispatch browser failure is addressed by reusing the loaded queue when switching views, preventing a second fetch from replacing a row while someone taps Find a time.
- Batch 8 merged credits **889f30744f0c3cbede5775d0e61c1e038d2107fb**, handoff **d173e719903a90b5d91ae42d04f7c1d48af2d401**, then FIELD-PAY **d769ac5385ce82c089359e316d120955f258fed6**, in that order. FIELD-PAY's isolated source was **2b1c1b8ace9deccd8b827f89a42c76e17d9fa00f**. The final PR #86 head **d765eba3a79f269e5c39c9e302fbcdd21124d8df** passed all seven applicable workflows before merge: Business Hub `36629316036`, Root `36629315555`, Firestore `36629315519`, Platform `36629315656`, Mobile Device E2E `36629315606`, Action Center `36629315563`, and Lighthouse `36629315570`. Operations Integration was path-filtered because Batch 8 did not change platform files. Cloudflare and Vercel previews also succeeded.
- [Batch 9 PR #87](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/pull/87), branch `codex/hub-ios-walkthrough-completion`, passed all eight workflows at published combined head **6bfc032f9317a7ceeeeb23863c7f4c7174f2b769**; its earlier **bf191d92c9de6ce394b8166d9fd53039d7e25104** head was also eight-green. These are historical results before the Batch 8 main merge. The final role-fix integration adds Batch 8 head `d765eba` and actual main merge `a029762` (integrated locally at `6d215cc15ad8ae1cda0c0a7029f4a5a10d83cd9d`) and uses shared Hub asset version `20260929hubready3` and crew asset version `20260929fieldpay2`. **231** normal isolated Node tests passed again on this combined tree. Focused field-payment browser cases passed **16/16 Chromium and 16/16 WebKit** on the identical role-fix code at Batch 8 `d765eba`; they have not been rerun locally after this combination. The final PR #87 revision containing this handoff needs its seven applicable workflows green on its own exact head before merge. Business Hub Acceptance is path-filtered for PR #87 because its diff against Batch 8 main changes none of that workflow's listed paths; the last relevant Batch 8 main run **36630649618** succeeded. The prior eight-green heads and that main run do not certify the final PR head.
- Batch 8 is in `main`; Batch 9 is not. The newer Hub and API have not been verified as deployed to production. Use live PR checks for any newer result.

## Completed work

**Collected credits:** the Verified collected tile counts verified cash after subtracting applied gift credits. Credit-only payments settle the bill while showing zero cash; mixed payments count the cash portion; inconsistent splits show review. Primary and independent review and **159 targeted tests** passed.

**FIELD-PAY:** the assigned lead collects the exact remaining balance through Stripe or submits a private cash/check receipt photo. Cash/check stays pending until manager approval atomically updates the existing money ledger and receipt decision. Durable card claims, frozen retry IDs, current balance/assignment checks, private per-session evidence and existing Review queues protect interrupted requests. Direct browser edits wait while a card checkout is active. Approved payments have a native HighLevel note handoff and a visible manager retry state. See [FIELD-PAY.md](FIELD-PAY.md).

FIELD-PAY primary and independent review findings were addressed. Focused local payment, money, review and automation tests passed **139/139**; the wider Batch 8 combination passed **191** tests. The final combined tree passed **231** normal isolated Node tests; the focused **16/16 Chromium and 16/16 WebKit** field-payment browser cases ran on the same role-fix code at Batch 8 `d765eba` before integration. Existing crew drafts **8/8**, tips **3/3** and field expenses **23/23** also passed earlier. The original unpublished candidate's reported review is not claimed for this implementation.

**Walkthroughs and office handoff:** PR #87 contains the role-correct phone menu, audio/recording intake, pasted or uploaded TXT/MD/VTT/SRT transcripts, exact-visit permission checks, reviewed scope and assigned Hub tasks. The office sees the saved customer, copyable instructions and a verified HighLevel contact link or search fallback. Tasks and notes require review where specified; the implementation does not automatically send customer messages. Existing OpenAI configuration is reused.

PR #87's historical eight-green result at `6bfc032` covered Root, Platform, Operations Integration, Firestore, Business Hub, Mobile Device E2E, Lighthouse and Action Center. For the final PR diff after Batch 8 merged to main, Business Hub Acceptance is path-filtered and seven workflows apply: Root, Platform, Operations Integration, Firestore, Mobile Device E2E, Lighthouse and Action Center. Local browser evidence also includes Walkthroughs **10/10**, Hub mobile **18/18**, Action Center **32/32** and recordings **13/13 WebKit**. These results belong to the stated earlier head.

## Rules and launch order

1. Keep units serial, tested and reviewed. Batch 8 met its FIELD-PAY and seven-check gate and merged to `main`. The remaining completed work lands through Batch 9 only after its final combined head passes all seven applicable checks.
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
- On Windows, existing full-suite POSIX/line-ending fixtures can differ; Linux CI on the final head is the merge gate. Batch 8's final `d765eba` head passed its seven applicable workflows, including the real Firestore emulator checks. The final Batch 9 head must pass its seven applicable workflows, including Operations Integration and both dedicated WebKit suites. Business Hub Acceptance is not applicable to this PR diff under its path filter; its last relevant main run `36630649618` passed. Earlier green heads do not replace the final applicable checks.

## Production and owner actions

The read-only Railway snapshot showed API, MCP and worker at `8081d74b677bf2ff47523bf246236cdc4fbf4708` and portal at `038c1186ba7c69aafca34d82854fa11677a88bf2`. The older API lacks recording.transcript. Existing API configuration names, including OPENAI_API_KEY, are present; no key values were printed or replaced.

The owner signed into the live Hub, and its office pages are accessible. Integrations reports the main Hub/HighLevel/Firebase/OpenAI/Stripe connections configured. Google Drive and Firebase sign-out verification still report setup needed; the cause of the latter has not been established. FIELD-PAY photos use private Firestore storage and do not depend on Drive.

Firebase and Cloudflare release-console sign-in has been requested and remains pending at this snapshot. Hub login does not provide those administrative sessions. After green merges, publish the reviewed Firebase rules/indexes, verify Cloudflare's actual deployment and flags, and deploy the same merged release to all four existing Railway services. Do not replace services or keys. Follow [GO-LIVE.md](GO-LIVE.md) and `egc-platform/docs/railway-deployment.md`.

Finish with authorized synthetic live acceptance: assigned walkthrough transcript draft, manager review and one office task, correct customer/contact association, retry without duplication, role denial and phone layout. A real customer send or card charge is not part of this test. Record actual outcomes before calling the release production verified.

## Continue from here

Fetch current PR #87 head/checks and confirm it contains the Batch 8 main merge state. Keep both WebKit jobs, role-safe Dispatch links and matching asset versions. Require the seven applicable workflows on the final PR #87 head before its merge; record Business Hub Acceptance as path-filtered, with its last relevant main run `36630649618` green. Then publish matching services/rules and complete live acceptance. Record its actual merge SHA and results here. Keep the original queue's missing specs, unlocated units and owner configuration work visible.
