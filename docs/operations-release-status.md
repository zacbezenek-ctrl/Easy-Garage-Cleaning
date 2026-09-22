# Canonical customer intelligence release status

Production revision `637373b98e579405bc20757a65c37a12d95b1687` is verified on all four Railway application services and Cloudflare Pages as of September 22, 2026, 08:03 UTC. End-to-end business-history acceptance remains in progress: semantic extraction still has incomplete sources, verified legacy bookings need migration into the native Portal, and no new production Meta conversions have been transmitted during this repair. Do not equate deployment with final acceptance.

Reporting and Meta conversion preparation now use the shared customer event ledger. The existing dataset, campaign mapping and original lead attribution are preserved. The Employee Hub remains authoritative for walkthroughs, jobs, customers, scope and financial evidence. PostgreSQL stores normalized provider facts, extracted call/message evidence, user-confirmed assertions and durable reconciliation/conversion ledgers. See [the implementation and rollout record](customer-intelligence-release.md).

## Verified production checkpoint

- GitHub PRs 55 and 56 merged. All three PR CI workflows and the observed main deployment checks passed for revision `637373b`.
- Railway API deployment `bc707268-8f7e-46b3-80fc-785de740c904`, worker `09abe182-242e-4537-9833-0de3ec5cc9e0`, and reporting portal `1801e92d-0931-401b-a7fb-d9edf0146a6e` report SUCCESS with that exact source commit. MCP deployment `b9237e80-ca91-4e58-b03b-11e97cab9ae7` verified the same revision before the subsequent shadow-backfill configuration restart.
- Cloudflare Pages deployment `7d6836dc-a73a-41af-b193-dc524b3f9702` and password-verifier build `1a0bf784-5f97-4b09-94ca-503e570bfcee` succeeded for the same source revision. Public API and Hub service-key endpoints return public keys successfully.
- At 07:48:36 UTC, the actual authenticated MCP startup check passed MCP discovery, existing contact reads, API operations reads, both Hub owners, and the complete native Hub calendar window. The test used normal service authentication and did not create production fixtures.
- The worker imports four durable, source-linked owner assertions for previously confirmed outcomes. Undated outcomes retain unknown occurrence dates and amounts. One internal fixture was excluded after an exact phone match to the live GHL agency-owner user; the original tags were preserved.
- All relevant local and cloud reporting schedules were updated to use canonical evidence, explicit coverage, separate media-quote and walkthrough pipelines, and Portal authority. Previously paused schedules remain paused.
- Meta remains in shadow mode. The reviewed historical boundary is September 16 at 00:00 America/Denver (`2026-09-16T06:00:00Z`). This configuration does not relax event-age, source-evidence, attribution, exclusion or accepted-delivery protections. Worker configuration applies with its next deployment; final backfill requires verified provider acceptance and replay checks.
- PR 57 stages exact-source Portal booking adoption and distinct work occurrences with both publishing gates disabled. Its initial CI passed; subsequent extraction, history and report-scope changes require fresh checks before release.

## Verified before deployment

- Native Employee Hub regression suite: the latest full run passed 580 tests, including native booking retry/time-zone, unscheduled financial evidence, multi-day interval preservation and service authentication cases. Final CI totals belong with the deployed revision.
- Browser acceptance for this change: 12 Action Center scenarios and 2 native booking scenarios passed against isolated fixtures. The native tests run in a Tokyo browser time zone and verify Denver scheduling, response-lost Firestore recovery, provider outage behavior and daylight-saving validation. The previous release's 5 recording-review scenarios remain separate evidence until rerun for this revision.
- Portal typecheck, operations build and 37 operations unit tests passed. Isolated PostgreSQL 17.9 migrations ran twice, followed by 9 lead-audit operations tests, 27 operations integration tests and 6 legacy walkthrough tests. Customer-state and Meta validation are tracked in the canonical release record. Local results do not certify production history.
- Migration files are additive and preserve the prior Meta ledger migration. Runtime migration is serialized between services.
- The v2 service bridge compiles with Pages Functions and passes an actual isolated Cloudflare Workers runtime smoke: its public key matches the Node implementation, a Node-signed read is accepted, unsigned access is denied, and the same signed request is rejected on replay. The smoke uses synthetic credentials and mocked data. A Workers-specific `redirect: "error"` incompatibility was found and corrected: requests now use manual redirects and reject redirect responses.
- Explicit synthetic validation contacts stay available for audit but are excluded from general business lead cohorts by their exact validation source or `egc-test` tag. Ordinary customer names containing “test” are not excluded.

## Live routing repair

The actual service-choice router and relevant entry triggers were corrected. Eleven verified transformation leads were removed from the wrong active junk-removal nurture; three valid removal-only enrollments remained active. No customer was messaged or re-enrolled as a repair.

Three controlled, live router executions passed: transformation to the garage flow, removal-only to the junk flow, and unknown answers to manual review. The retained synthetic contact had DND enabled and no phone or email. Cleanup verified no active workflows and completed the synthetic review task. This verifies router behavior, not fresh Facebook form delivery. Exact evidence is in [the routing record](ghl-live-routing-2026-09-20.md).

## Rollout and remaining live checks

The v2 Hub/API bridge uses independently derived Ed25519 keys from existing server secrets, pinned production HTTPS origins, short-lived signed requests, and durable single-use nonces. It does not require a new shared secret or expose a private key. API activation requires `EGC_OPERATIONS_ENABLED=true` and `EGC_OPERATIONS_SERVICE_AUTH=v2`. The Hub selects v2 when its existing session secret is valid and the mode is unset; an explicit `EGC_OPERATIONS_ENABLED=false` remains a kill switch. Deploy both sides, verify public key publication and signed read-only access, then verify bounded repair behavior. Walkthrough entry in the Railway portal always directs to the existing Employee Hub; contact-only recording upload and approval proxies return a Hub redirect instruction even while the bridge is disabled.

The existing GitHub Cloudflare integration now deploys this release, as recorded above. Production Hub HTML, JavaScript and CSS return `Cache-Control: no-store`; no service worker caches the Hub. The assets are versioned as `20260922intelligence` and `20260922booking`, so a normal reload obtains the deployed files. Continue checking both the source revision and deployed contents on subsequent releases.

The native Hub now retains a save identity through ambiguous Firestore responses and verifies the exact saved record before retrying. It uses Denver wall times independently of browser time zone. A provider outage permits an authoritative Hub save with explicit provider reconciliation pending. The signed `portal.evidence` read follows exact contact identities and includes unscheduled accepted work, verified processor receipts and separately identified staff-confirmed customer receipts. It does not substitute a calendar scan for complete sales evidence.

At the last authenticated-surface check, the Employee Hub, Cloudflare dashboard and HighLevel developer Marketplace required user sign-in. Therefore the following are not certified by local tests or HTTP readiness:

- Direct Cloudflare administration remains unavailable, but the existing GitHub deployment path and signed v2 production reads are verified. Firebase security-rule deployment for the separate field-operations release still requires an authenticated administration path; emulator tests do not certify published production rules.
- Complete native Hub reconstruction of historical visit/job cases. Provider read-back and duplicate/cancellation history are retained; native adoption remains disabled until its exact-source plans and shared dispatch locks are reviewed.
- Final source-by-source comparison for the recent lead cohort, reconciliation of purpose conflicts, and accepted production Meta backfill with a no-duplicate replay.
- The connected workspace still advertises some older tool schemas, including a UUID-only legacy job brief. The server exposes current Portal tools, but callers must use supported contact history and canonical report paths until the connector schema is refreshed. No authentication or schema restrictions are bypassed.
- Marketplace app webhook subscriptions and a verified live signed receipt.
- Production recording/transcription/review, exact Hub mutation read-back, and the rest of the [25-case production acceptance matrix](operations-production-acceptance.md).

Do not label these checks passed until their exact deployed records and source evidence are observed. Existing verified quotes/payments may be read for acceptance; do not manufacture signatures, sales or charges. Activation and configuration steps are in the [Railway runbook](../egc-platform/docs/railway-deployment.md).
