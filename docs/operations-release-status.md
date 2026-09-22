# Canonical customer intelligence release status

The first production deployment of this canonical reporting release is pending verification. This release changes reporting and Meta conversion preparation to use the shared customer event ledger. It preserves the existing dataset, campaign mapping and original lead attribution. The Employee Hub remains authoritative for walkthroughs, jobs, customers, scope and financial evidence. PostgreSQL stores normalized provider facts, extracted call/message evidence, user-confirmed assertions and durable reconciliation/conversion ledgers. See [the implementation and rollout record](customer-intelligence-release.md).

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

GitHub check runs confirm the existing Cloudflare Pages integration deployed repository commit `32a6946ce25e2e691438e2087b4b7b8963078382` successfully on September 21, 2026 at 02:41:33 UTC. That prior deployment is `a7957e12-9b86-4456-bdce-f14e9f1e38b2` in Pages project `easy-garage-cleaning`; it does not contain this release. Production Hub HTML, JavaScript and CSS return `Cache-Control: no-store`; no service worker caches the Hub. This release versions the assets as `20260922intelligence` and `20260922booking`, so a normal reload obtains the deployed files. Verify both the new GitHub Cloudflare check and public asset contents after deployment.

The native Hub now retains a save identity through ambiguous Firestore responses and verifies the exact saved record before retrying. It uses Denver wall times independently of browser time zone. A provider outage permits an authoritative Hub save with explicit provider reconciliation pending. The signed `portal.evidence` read follows exact contact identities and includes unscheduled accepted work, verified processor receipts and separately identified staff-confirmed customer receipts. It does not substitute a calendar scan for complete sales evidence.

At the last authenticated-surface check, the Employee Hub, Cloudflare dashboard and HighLevel developer Marketplace required user sign-in. Therefore the following are not certified by local tests or HTTP readiness:

- This release's Cloudflare production revision and coordinated v2 bridge activation. The old shared portal signing key was absent at preparation. V2 removes that shared-secret dependency, but the exact deployed public key routes and signed production reads still require verification. Direct Cloudflare administration remains unavailable: repository/environment secret inventories contain no deployment token, the Wrangler identity belongs to another account, and the browser requires a password. An existing explicit false Hub feature flag would still block activation and must not be bypassed.
- Native Hub verification of the reported historical visit/job cases. Provider read-back already showed one active appointment and two cancelled appointments in each reported case; no additional cancellation was inferred necessary.
- Marketplace app webhook subscriptions and a verified live signed receipt.
- Production recording/transcription/review, exact Hub mutation read-back, and the rest of the [25-case production acceptance matrix](operations-production-acceptance.md).

Do not label these checks passed until their exact deployed records and source evidence are observed. Existing verified quotes/payments may be read for acceptance; do not manufacture signatures, sales or charges. Activation and configuration steps are in the [Railway runbook](../egc-platform/docs/railway-deployment.md).
