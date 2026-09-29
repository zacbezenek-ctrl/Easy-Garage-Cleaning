# Easy Garage Cleaning Hub handoff

Status snapshot: **2026-09-29**. Refresh the GitHub heads and checks before acting; this file records what was verified at the snapshot, not a claim that a later merge or deployment has happened.

## What this is

The Employee Hub and the linked crew, customer, business, and operations services replace the daily Jobber workflow. `main` deploys through the site's Git integration. The current wrap-up is a controlled merge of already started work, followed by owner checks in a real account and on real devices. The owner's original queue said no new units start. The owner later separately authorized completion of the Hub's iOS Walkthroughs screen and transcript-to-office-task path; that local integration is part of this handoff.

## Verified repository state

At this snapshot, GitHub `main` is `59d617ac` (Batch 7). [Batch 8 PR #86](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/pull/86) is open and draft at `6cc4cad8`; its four committed units are SALES-BOOKING, WT-OUTCOME, FIX-DISPATCH-QUEUE, and MOBILE-HUB. Neither this handoff nor `docs/handoff/` is present at that PR head. The Hub iOS Walkthroughs and transcript-to-office-task implementation, including this handoff, is published in [Batch 9 PR #87](https://github.com/zacbezenek-ctrl/Easy-Garage-Cleaning/pull/87). Its checked CI head is `954390453443c61b0c9263adeab040e7a426827f`. PR #87 remains draft; it is not deployed or merged.

**PR #86** has an older Action Center CI failure: its Dispatch browser suite could not find a visible “Find a time” control (`test_dispatch_ui.py:304`, run `36604534261`). That result belongs to PR #86's `6cc4cad8` head, not PR #87.

At **PR #87 head `9543904`**, Root, Platform, Operations Integration, Firestore, Business Hub, Mobile Device E2E, and Lighthouse completed successfully. In Action Center CI, functions bundle, database/platform, and Chromium browser jobs succeeded; the WebKit job failed because its Linux browser rejected the Chromium-only `--no-sandbox` argument. That launch correction is tested locally and included with this handoff revision. The full PR #87 gate is **not green**; every required workflow must run again on its latest head before merge.

The PR body reports FIELD-PAY awaiting a final minor fix; FIX-HUB-COLLECTED-CREDITS reviewed and next; WT-HANDOFF, OPS-VISIBILITY, and FIX-JOBBER-MONEY in review or queued. It reports FIX-REFUNDS built and reviewed once and GHL-TRACK-2 built but needing another clean review. These statements are from the PR description, not evidence that any of those units has landed. The owner's later queue instruction places credits, handoff, FIELD-PAY, refunds, and milestone tags in that order, followed by seven running builds as each finishes. The seven build IDs and their exact states have not been supplied in this checkout.

## Rules for continuing

1. Keep the queue serial. Review and test each unit at its actual head; fix any failed gate before merging the next.
2. Keep **FIX-REFUNDS** and **GHL-TRACK-2** disabled at merge. Record the review state and exact flag names in each commit and here before any activation decision. Do not infer approval from a merged commit.
3. Merge Batch 8 to `main` only after FIELD-PAY is included and CI is green. Put the remaining completed units in a Batch 9 PR.
4. HighLevel owns customer communication and follow-ups. Hub tracking and tags must not create an unreviewed customer send. See [HIGHLEVEL-BOUNDARY.md](HIGHLEVEL-BOUNDARY.md).
5. Keep owner actions separate from code-complete claims. A checked-in feature or passing synthetic test does not prove its production credentials, Firestore rules, schedules, connected HighLevel workflow, or phone behavior.
6. Preserve the isolated-unit review convention described in [BUILD-PROGRESS.md](BUILD-PROGRESS.md): unit-prefixed commits, adversarial review, affected tests, then full suites before merge. The old **Next** list and phase summary in that file are stale; use its detailed unit history as background, and the dated files here for this queue.

## What is built and what remains

The four Batch 8 units are committed in PR #86, subject to its CI gate and owner acceptance. PR #87 publishes the role-correct Walkthroughs menu, exact-visit recording/transcript intake, phone-first design, reviewed scope and assigned office tasks. This handoff revision includes a tested follow-up: the office handoff reads the saved customer name, phone and matching HighLevel contact link; recording source resolution recovers exact project links; and WebKit CI launches correctly on Linux. These follow-up changes were not part of the checked `9543904` head. Treat all of PR #87 as pending until the latest head is reviewed, CI-green, and launch gates permit merging. See [unit-status.json](handoff/unit-status.json) for the machine-readable snapshot.

This snapshot cannot certify the promised **41 specs for unbuilt or in-flight units**. No such spec set exists in the checked-out branch or PR #86 head. [spec-inventory.json](handoff/spec-inventory.json) records 0/41 located. Obtain the authoritative 41 documents and their IDs, then add them without silently inventing scope or marking units complete. Until then, the future-scope handoff is incomplete.

## Launch order

The owner's stated merge sequence and gates are in [launch-order.json](handoff/launch-order.json). After a green merge, perform the owner checklist and go-live checks in [OWNER-GO-LIVE-CHECKLIST.md](OWNER-GO-LIVE-CHECKLIST.md) and [GO-LIVE.md](GO-LIVE.md). Flags remain at their documented off defaults until their specific verification and owner activation step. A production deployment and live device check have **not** been verified in this snapshot.

## How to verify

- Root contract suite: `npm test` (also run with `EGC_CLOCK_SHIFT_DAYS=400` where the workflow does).
- Platform package suite: from `egc-platform/`, `pnpm test`; run its build/type checks and migrations when that tree changes.
- Affected browser suites: `python -m unittest discover -s tests/browser -p test_walkthroughs_ui.py` and `python -m unittest discover -s tests/browser -p test_hub_shell_mobile_ui.py`. The CI workflow runs the broader Action Center browser suite.
- Firestore emulator and device projects: follow [testing.md](testing.md) and the workflow for changed surfaces. Do not call CI green from a subset or a previous SHA.
- Check GitHub Actions on the **exact merge SHA**. The previously checked PR #87 head has the WebKit CI failure named above; this follow-up requires a fresh full run.

Local checks for the published Hub integration passed: Walkthroughs browser **10/10**, Hub mobile **18/18** including an 844×390 side-notch dialog, Action Center browser **27/27**, and recording browser **13/13 in WebKit**. For this follow-up, focused checks passed: office handoff browser **7/7**, recording API **15/15**, proxy/contact **14/14**, and Dispatch regressions **43/43**. The Linux WebKit launch correction also passed the 13 recording browser cases locally. Windows root-suite fixture checks depend on POSIX file modes and CRLF handling; the Linux CI result on the final head is the merge evidence. Local checks do not replace CI.

## Owner actions and follow-ups

The owner must complete the live checks in the go-live checklist, including staff access, installed iPhone safe areas, walkthrough booking/outcomes, Dispatch queue exits, production rules/session access, and HighLevel behavior. Verify operational flags and integrations in the deployed environment before enabling any parked behavior. [follow-ups.json](handoff/follow-ups.json) separates blockers from live checks. [decisions.md](handoff/decisions.md) preserves the owner's queue instruction verbatim.

## How to resume

1. Read this snapshot and the machine-readable files, then fetch fresh PR, branch, and CI state. Keep PR #86's earlier failure separate from PR #87's current checks.
2. Review the tested office-contact, project-link, and Linux WebKit follow-up. Verify PR #87 checks on its latest head; update status and test evidence with the exact SHA.
3. Follow the serial launch order. Before each merge, verify unit review, flags, CI, and whether the commit and this file carry the latest status.
4. Add the real 41 specs when their source is available; reconcile every ID with the unit status and Batch 9 plan. Do not launch extra units during this wrap-up.
5. Finish the owner checks after deployment. Record actual dates, results, and unresolved issues in this handoff rather than checking boxes based on code alone.
