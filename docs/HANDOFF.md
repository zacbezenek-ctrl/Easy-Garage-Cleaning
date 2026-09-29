# Easy Garage Cleaning Hub handoff

Snapshot: **2026-09-29**. Batch 8 and Batch 9 are merged and matching Hub and Railway revisions are deployed. The transcript production fix is under review, live transcript processing has not passed, and the payment flag remains off.

## What this is

The Employee Hub connects office work, crew jobs, customer portals, HighLevel and the Railway operations services. The owner authorized completing the mobile Hub, Walkthroughs, transcript intake and office handoff, using existing credentials. The original queue remains serial and no unrelated new units start. Owner instructions are preserved verbatim in [decisions.md](handoff/decisions.md).

## Release state

- GitHub `main` includes the Batch 8 merge **a0297623276e0d0bed78dbdb789957367b8a60dd** and Batch 9 merge **5ed437cfb218d5edf3f17bd3df95b975cf62919c**. The merged Batch 9 tree exactly matches its final PR head **bb41f03c56d129b77128ca9a5e8597ec7a4c6612**.
- [Batch 8 PR #86](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/pull/86) originally contained SALES-BOOKING, WT-OUTCOME, FIX-DISPATCH-QUEUE and MOBILE-HUB at `6cc4cad8`. Its old Dispatch browser failure is addressed by reusing the loaded queue when switching views, preventing a second fetch from replacing a row while someone taps Find a time.
- Batch 8 merged credits **889f30744f0c3cbede5775d0e61c1e038d2107fb**, handoff **d173e719903a90b5d91ae42d04f7c1d48af2d401**, then FIELD-PAY **d769ac5385ce82c089359e316d120955f258fed6**, in that order. FIELD-PAY's isolated source was **2b1c1b8ace9deccd8b827f89a42c76e17d9fa00f**. The final PR #86 head **d765eba3a79f269e5c39c9e302fbcdd21124d8df** passed all seven applicable workflows before merge: Business Hub `36629316036`, Root `36629315555`, Firestore `36629315519`, Platform `36629315656`, Mobile Device E2E `36629315606`, Action Center `36629315563`, and Lighthouse `36629315570`. Operations Integration was path-filtered because Batch 8 did not change platform files. Cloudflare and Vercel previews also succeeded.
- [Batch 9 PR #87](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/pull/87), branch `codex/hub-ios-walkthrough-completion`, passed all seven applicable workflows at final head **bb41f03c56d129b77128ca9a5e8597ec7a4c6612** before its `main` merge. Root, Platform, Operations Integration, Firestore, Mobile Device E2E, Lighthouse and Action Center were green; both dedicated Action Center WebKit suites passed. Business Hub Acceptance was path-filtered because the PR diff against Batch 8 main changed none of its listed paths; the relevant Batch 8 `main` run **36630649618** passed. Earlier heads **6bfc032** and **bf191d9** each passed eight workflows before Batch 8 merged. The final integration uses Hub assets `20260929hubready3` and crew assets `20260929fieldpay2`; **231** normal isolated Node tests passed on the combined tree and focused field-payment browser cases passed **16/16 Chromium and 16/16 WebKit** on identical Batch 8 role-fix code before integration. All six applicable checks on Batch 9's `main` push also passed.
- Cloudflare's production check succeeded at Batch 9 merge **5ed437c**; live Hub DOM showed matching `hubready3` recording, operations and suite assets, and the signed owner opened the Audio & transcript workspace. All four existing Railway services reported successful deployments with actual commit metadata **5ed437c**. API, MCP and portal health returned that release. This proves revision alignment, not live workflow acceptance.

## Completed work

**Collected credits:** the Verified collected tile counts verified cash after subtracting applied gift credits. Credit-only payments settle the bill while showing zero cash; mixed payments count the cash portion; inconsistent splits show review. Primary and independent review and **159 targeted tests** passed.

**FIELD-PAY:** the assigned lead collects the exact remaining balance through Stripe or submits a private cash/check receipt photo. Cash/check stays pending until manager approval atomically updates the existing money ledger and receipt decision. Durable card claims, frozen retry IDs, current balance/assignment checks, private per-session evidence and existing Review queues protect interrupted requests. Direct browser edits wait while a card checkout is active. Approved payments have a native HighLevel note handoff and a visible manager retry state. See [FIELD-PAY.md](FIELD-PAY.md).

FIELD-PAY primary and independent review findings were addressed. Focused local payment, money, review and automation tests passed **139/139**; the wider Batch 8 combination passed **191** tests. The final combined tree passed **231** normal isolated Node tests; the focused **16/16 Chromium and 16/16 WebKit** field-payment browser cases ran on the same role-fix code at Batch 8 `d765eba` before integration. Existing crew drafts **8/8**, tips **3/3** and field expenses **23/23** also passed earlier. The original unpublished candidate's reported review is not claimed for this implementation.

**Walkthroughs and office handoff:** PR #87 contains the role-correct phone menu, audio/recording intake, pasted or uploaded TXT/MD/VTT/SRT transcripts, exact-visit permission checks, reviewed scope and assigned Hub tasks. The office sees the saved customer, copyable instructions and a verified HighLevel contact link or search fallback. Tasks and notes require review where specified; the implementation does not automatically send customer messages. Existing OpenAI configuration is reused.

PR #87's final seven applicable checks passed at `bb41f03`; Business Hub Acceptance was path-filtered and its last relevant Batch 8 `main` run passed. Local browser evidence also includes Walkthroughs **10/10**, Hub mobile **18/18**, Action Center **32/32** and recordings **13/13 WebKit**. The live synthetic transcript is a separate, currently failing production acceptance check.

## Rules and launch order

1. Keep units serial, tested and reviewed. Batch 8 and Batch 9 met their exact-head checks and merged to `main` in order. The production transcript schema repair on `codex/transcript-production-schema-fix` is under review; its new checks and deployment remain required before repeating the saved transcript.
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
- On Windows, existing full-suite POSIX/line-ending fixtures can differ; Linux CI on the exact head is the merge gate. Batch 8's final `d765eba` head passed seven applicable workflows and Batch 9's `bb41f03` head passed seven, including Operations Integration and both dedicated WebKit suites. Business Hub Acceptance was path-filtered for Batch 9; its last relevant Batch 8 main run `36630649618` passed. Apply the same exact-head gate to the pending transcript fix.

## Production and owner actions

The Cloudflare production check and live asset DOM matched `5ed437c`. Railway API, MCP, worker and portal each reported successful deployments with actual commit metadata `5ed437c`; API, MCP and portal health returned that release. Existing server configuration names, including `OPENAI_API_KEY`, were reused; key values were not printed or replaced. Effective production flags and Firebase rules/indexes still need administrative verification. `EGC_FIELD_PAY_ENABLED` remains off.

The Hub UI created synthetic visit `dispatch_beef26f85e694eb4b57d7a47a3c324d1` for **INTERNAL TEST — Hub release 2026-09-29** (`hub-release-20260929@example.invalid`), assigned to Zac, unscheduled, with no phone or HighLevel contact and reminders off. The UI confirmed one **Needs a time** card. The owner opened Audio & transcript, saved a test transcript, and processing **failed**. The original record persisted; no office task or customer send occurred. A static audit found unsupported default annotations in the strict extraction schema; the correction and safer diagnostics are under review on `codex/transcript-production-schema-fix` and are **not deployed**. After that fix passes and deploys, retry the **same saved transcript** and verify one manager-reviewed task, correct missing-contact fallback, role denial and phone layout. Do not describe the transcript flow as live accepted yet.

A live Batch 8 crew job loaded owner review and confirmed balance with collection disabled. Regular job photos displayed “Photo storage is unavailable…” while completion requires before and after photos. The readiness check requires `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REFRESH_TOKEN` together. The live `/api/drive-auth` page said “Drive setup — missing config” and requested the client ID and secret; its route would return 404 if the refresh token were present. Thus the refresh binding is absent and at least one client binding is missing or unusable; no values were read. Cloudflare Production Drive OAuth must be completed as a Hub manager using the company Google account and the existing client with exact redirect `https://easygaragecleaning.com/api/drive-auth`, then a regular job photo upload must be verified. FIELD-PAY receipt evidence uses private Firestore storage and is separate from this blocker.

Firebase/Google and Cloudflare administrative sign-in remains pending at this snapshot; Hub login does not provide those sessions. Verify and publish reviewed Firebase rules/indexes, release flags and Google Drive binding without replacing existing services or keys. Follow [GO-LIVE.md](GO-LIVE.md) and `egc-platform/docs/railway-deployment.md`. A real customer send or card charge is outside synthetic acceptance.

## Continue from here

Finish review of `codex/transcript-production-schema-fix`, require exact-head CI, merge and deploy matching Hub/API revisions, then retry the existing saved synthetic transcript. Confirm a single reviewed office task and no duplicate customer action. Restore regular job photo storage through Drive OAuth and verify upload, review Firestore rules and release flags, and complete real-device role checks. Keep refunds and milestone tags off and the missing 41 specs and seven build IDs visible until their sources are found.
