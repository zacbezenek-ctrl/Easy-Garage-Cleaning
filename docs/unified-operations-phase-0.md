# Unified operations: Phase 0 findings and first foundation slice

Product owner: Zac / Easy Garage Cleaning  
Specification date: September 18, 2026  
Status: **Draft implementation. Not deployed. Not a completed Phase 0 or first usable release.**

## Non-negotiable authority boundary

The existing EGC Employee Hub remains authoritative for project, visit, job,
approved scope and quote records until a separately approved cutover. HighLevel
is a communications/intake provider, not the EGC operational calendar. PostgreSQL
UUIDs do not establish identity with Firestore document IDs.

This change extends `@egc/lead-audit` and reads the EXISTING `tasks` table. It does
not add a second task database, introduce a replacement portal, migrate records,
create visits, send customer communications, or alter scheduled briefings.

## Observations verified in this build session

| Evidence | Observation | Limitation |
| --- | --- | --- |
| GitHub main, `zacbezenek-ctrl/Easy-Garage-Cleaning` | Inspected commit `21337fac2e19a3545a010badb10dd80b35afe592`; tree `7257724cb301e71518fad26f2713bbae9899093f`. | Source revision is not deployment parity. |
| Railway `Easy Garage Cleaning Ops` | Production API, MCP, worker, platform portal and PostgreSQL each reported a successful latest deployment. | Does not prove source synchronization or the deployed Employee Hub revision. |
| Railway MCP deployment `e5924adc-24cf-439a-8a48-19848453036e` | Reported commit `17273b9954ed5df7131de7c2cbb3ddb9ddb1347a`, branch main, created `2026-09-18T19:32:00.524Z`. | Behind inspected main. No redeploy was requested or performed. |
| Connected EGC registry | 50 tools exposed; appointment creation described as a GHL write; `egc.followups_due` has a recent-lead `days` filter; no task or exact-approval tools were exposed. | The connected registry can lag deployed code. Do not infer missing data from missing tool exposure. |
| `services/lead-audit/src/index.ts` | `recentLeadRows` filters lead creation time. `enrichLeadAuditRow` treats BOOKED as terminal and can drop a customer-last reply from follow-up. | Left unchanged; replacing a candidate heuristic is not equivalent to implementing canonical obligations. |
| `functions/api/employee-hub.js` | Uses the existing session/role helpers and Firestore job reads. | Cloudflare production revision and cross-store identity bridge not verified. |
| `functions/api/operations-event.js` | Sends configured webhooks directly and returns their status; no durable outbox is implemented in this file. | No claim that every other integration path was audited. |
| `packages/database/src/schema.ts` | Existing tasks have ID, status, due time, owner and platform entity links, but not the complete revision/approval/waiting model from the brief. | Existing task rows cannot be represented as version-approved actions. |

No credentials were fetched or copied. The single EGC data read was a job-status
count health check; no customer records were mutated. No real-recipient test was run.

## Implemented in this slice

### Pure rules: `src/operations-core.ts`

- Due/review selection uses task timing, independent of lead age, booking state,
  or last communication direction. Blocked work remains visible. Missing owners,
  times and revisions produce exceptions rather than inferred values.
- Snapshot membership and counts are immutable in memory and deterministic for
  the same input. Pagination operates on that snapshot, not a new live query.
- Coverage explicitly distinguishes observed counts from known complete totals.
  An unavailable/missing required source yields `totalDue: null`, not a false zero.
- Job links require exact source-qualified visit/customer/project identities.
  There is no latest-job fallback. Conflicting mappings remain exceptions.
- SHA-256 approval fingerprints cover exact action/revision, recipient/channel,
  payload, quote/job revisions, conversation watermark, send window and policy revision.
- Dispatch preflight rejects missing authorization, restricted/unknown contact
  permission, stale source context, unresolved dependencies, invalid approvals,
  expired send windows, cancelled/blocked tasks and already-attempted executions.
- Source pagination requires strictly advancing IDs and propagates failures.

**Important:** `evaluateDispatchPreconditions` is only a necessary policy check.
It cannot authenticate a user, approve a message, acquire a durable execution
claim, or send anything. The future service must obtain its inputs server-side,
revalidate them inside the claim transaction and enforce all legacy send paths.
A `readyForAtomicClaim: true` result is NOT permission to bypass that service.

### Read adapter: `src/operations-read.ts`

`readExistingTaskQueue` reads every page of open/nonterminal existing task rows in
one PostgreSQL repeatable-read, read-only transaction. It includes undated and
ownerless rows so they can become exceptions. There is no lead-age join/filter.

It returns `persisted: false`, `authority: existing_platform_tasks_only`, and
`portalParityVerified: false`. Portal project mapping and communication-obligation
coverage remain explicitly unknown. Legacy rows retain their real IDs and receive
`revision: null` until a reviewed migration adds real revisions.

This is an INTERNAL service export, not a registered API/MCP endpoint. Caller-side
server authorization is required before any future exposure. Database failures
propagate; they are not converted into an empty task queue.

### Test entry point

From `egc-platform/services/lead-audit`:

```sh
npm run test:operations
```

The standalone strict TypeScript configuration compiles the pure rules without
requiring provider credentials, then runs `node:test`. The package's normal
`test` script runs the existing Vitest suite followed by these checks. No new
runtime dependencies or lockfile dependency changes are needed.

Verified locally on Node 22.16.0 / TypeScript 5.8.3: **32 tests passed, 0 failed, 0 skipped.** The repository-pinned TypeScript 6 toolchain still requires CI verification. These cover the pure
rules and mock page collection. They are NOT PostgreSQL, portal, MCP, concurrency,
provider-delivery, recording, or production end-to-end acceptance tests. The new
PostgreSQL adapter was not run against a database in this session. Full workspace
build/typecheck and existing Vitest results must be checked in CI before merge.

## Explicitly NOT implemented or claimed

- No portal-native calendar/job API adapter or Firestore/PostgreSQL bridge.
- No synthetic booking traced end to end through portal and connector.
- No task schema migration, persisted action revisions, waiting states or audit history.
- No saved approval ledger, transactional outbox, execution receipts or timeout reconciler.
- No change to existing raw sends; shared policy enforcement still needs wiring.
- No durable brief storage or matching UI/MCP endpoints. Snapshots here are in memory.
- No Action Center integration in the existing Employee Hub.
- No recording upload/consent/transcription/review pipeline changes.
- No business conversion improvements, collected-cash assertions or production parity claims.

## Build order after this draft

| Next slice | Required proof |
| --- | --- |
| EGC-01: deployed authority and native portal access | Identify deployed Employee Hub revision; trace isolated customer/project/visit/job; explicit mappings; portal/native connector IDs match. No GHL calendar substitution. |
| EGC-02/03: shared timeline and canonical tasks | Preserve source event IDs/times; extend existing task storage with revisions and exact portal links; owner/due/review invariants; source-backed backfill and reconciliation. |
| EGC-04: real authorization and execution service | Authenticated actor from session/token; exact stored approvals; atomic execution claim; all raw send routes controlled; ambiguous provider results reconciled; replay/concurrency tests. |
| EGC-05: first usable release | Persist brief snapshots; expose the same task query in Employee Hub and MCP; complete paginated counts, source freshness, authorized UI controls. |
| EGC-06: recordings | Durable accepted uploads; consent/access; evidence-linked extraction; explicit review; notes approval never authorizes messaging. |
| EGC-07: monitored rollout | All 20 user-specified acceptance scenarios; role/security tests; isolated recipients; one sender per workflow; rollback and owner sign-off. |

Phase 0 is still open until the deployed portal and synthetic identity/parity
checks pass. The first usable release is still open until EGC-01 through EGC-05
are integrated and tested. Do not merge-and-deploy this branch as a claim that
unified operations or controlled messaging is complete.

## Technical references

The database adapter uses the transaction options documented by Drizzle and
PostgreSQL; repeatable-read is for consistent PostgreSQL pagination, not a claim
of atomic cross-store synchronization. Tests use Node's built-in test runner.

- https://orm.drizzle.team/docs/transactions
- https://www.postgresql.org/docs/current/transaction-iso.html
- https://nodejs.org/api/test.html
