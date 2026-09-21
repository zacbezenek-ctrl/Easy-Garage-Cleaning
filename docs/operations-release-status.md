# Unified operations release evidence

This release preserves the existing Meta conversion implementation and configuration. It does not change ad delivery, optimization targets or attribution. The authoritative operational records remain in the existing Employee Hub; PostgreSQL holds normalized provider evidence and durable actions, recordings and execution ledgers.

## Verified before deployment

- Native Employee Hub regression suite: 547 passing tests.
- Browser acceptance: 11 Action Center scenarios and 5 recording-review scenarios passed against isolated fixtures.
- Full platform typecheck, unit/HTTP test tasks and application builds passed. PostgreSQL tests exercise actual migrations, task revisions/approvals, native/provider scheduling, recordings, inbound replies, communications, timeline, notes and lease recovery using an isolated loopback database. Final CI results and deployed revisions are recorded with the pull request and release report.
- Migration generation reported no schema drift. Migration files are additive and preserve the prior Meta ledger migration. Runtime migration is serialized between services.
- Explicit synthetic validation contacts stay available for audit but are excluded from general business lead cohorts by their exact validation source or `egc-test` tag. Ordinary customer names containing “test” are not excluded.

## Live routing repair

The actual service-choice router and relevant entry triggers were corrected. Eleven verified transformation leads were removed from the wrong active junk-removal nurture; three valid removal-only enrollments remained active. No customer was messaged or re-enrolled as a repair.

Three controlled, live router executions passed: transformation to the garage flow, removal-only to the junk flow, and unknown answers to manual review. The retained synthetic contact had DND enabled and no phone or email. Cleanup verified no active workflows and completed the synthetic review task. This verifies router behavior, not fresh Facebook form delivery. Exact evidence is in [the routing record](ghl-live-routing-2026-09-20.md).

## Rollout and remaining live checks

Railway deployment begins with unified operations disabled. Existing workflows remain available until the signed Hub/API/MCP bridge has been deployed and verified. No signing keys are exposed to the browser or stored in source.

At the last authenticated-surface check, the Employee Hub, Cloudflare dashboard and HighLevel developer Marketplace required user sign-in. Therefore the following are not certified by local tests or HTTP readiness:

- Cloudflare production revision, matching server-side bridge secrets and coordinated feature activation.
- Native Hub verification of the reported historical visit/job cases. Provider read-back already showed one active appointment and two cancelled appointments in each reported case; no additional cancellation was inferred necessary.
- Marketplace app webhook subscriptions and a verified live signed receipt.
- Production recording/transcription/review, exact Hub mutation read-back, and the rest of the [25-case production acceptance matrix](operations-production-acceptance.md).

Do not label these checks passed until their exact deployed records and source evidence are observed. Existing verified quotes/payments may be read for acceptance; do not manufacture signatures, sales or charges. Activation and configuration steps are in the [Railway runbook](../egc-platform/docs/railway-deployment.md).
