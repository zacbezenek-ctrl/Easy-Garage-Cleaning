# Local proposal: Team Lead job operations

Prepared from `d2f35c8` (main including PR 268). This patch is local only. No remote branch, issue, pull request, deployment, live role change or environment change was created.

## Exact permission change

`jobs.operate` is a new, separate capability, available only when the dedicated `EGC_TEAM_LEAD_JOB_OPERATIONS` is exactly `true`. The role matrix grants it to owner, manager and team_lead. Other roles retain their current capabilities. With the flag off, this capability grants nothing. The new flag defaults off; all existing flag defaults are unchanged. It works without enabling EGC_STAFF_ROLE_ACCESS or EGC_STAFF_ROLE_PERMISSIONS.

| Capability | Team Lead, flag on |
| --- | --- |
| Read operational job and customer details across crews | Allowed through the redacted API |
| Create, schedule, assign, edit, cancel operational jobs | Allowed through `/api/job-operations` |
| Complete a job on another crew | Allowed through `/api/field-jobs`, subject to existing safety/closeout checks |
| Restore, no-show, delete, edit closed history | Denied |
| Independent supervisor sign-off / self-sign-off | Denied; existing manager and anti-self rules unchanged |
| Customer messages, photo publication, CRM retry controls | No new permission |
| Quotes, pricing, payments, payroll, account settings | No new permission |
| Manage crew records, vehicles, availability, company blocks, recurring plans | Denied |
| Direct Firestore business reads or writes | No change; rules remain untouched |

No manager role, `businessAccess`, `dispatch.write` or `schedule.book` is granted to a Team Lead. Existing combinations of independently assigned roles remain additive. The assigned crew lead payment/expense exception still requires actual assignment/lead status; unrelated jobs continue to be refused by those APIs.

## Implementation

The new crew page is `/crew/job-operations`. The crew schedule links to it when the authenticated profile advertises `jobs.operate`. Its static shell joins the crew service worker; API responses and mutations are not cached or queued. Unknown outcomes retain the exact in-memory request body and request ID for retry. Every mutation names the expected signed-in user. Reloading drops that in-memory pending state; server receipts still prevent replaying the same ID twice.

The scoped API reads the existing canonical schedule, customer search, job search, openings and drive-time services. It returns explicitly projected operational fields, names and contact details, crew membership and vehicle labels. It excludes financial readiness, quote data, purchases/material costs, raw notes, management notes, provider links, payroll, full staff profiles and unknown nested fields. Currency amounts in retained operational text are removed with the existing crew-money helper.

Schedule mutation inputs are allowlisted: dates/times, assigned crew and lead, crew/vehicle IDs, crew size, travel buffer, title, address, service type, work/access/customer instructions, equipment, skills, arrival window and assignment segments. The only actions are `schedule.create`, `schedule.update` and `schedule.cancel`. Creates are operational jobs for an existing customer. An explicit prior operational job may select verified property/account lineage; walkthrough/template copying is refused.

Mutations reuse the existing dispatcher transaction implementation with a scoped authorization callback. They retain revision preconditions, idempotency receipts, global and daily locks, conflicts, owner rules, lifecycle constraints and segment validation. Existing crew snapshots and payroll records are not rewritten retroactively. Hidden segment notes are retained by stable segment ID when the scoped API replaces a segment plan. Customer-message tag/mirror enqueueing is suppressed for this scoped scheduling path; ordinary office paths and their flags are unchanged. Existing provider-linked schedule bookkeeping remains part of the canonical mutation.

All-crew completion is a narrow exception in the field API: other field actions still need assignment. It does not set manager status, bypass required photos/checklists/expense closeout, or allow early multi-day completion. It writes normal completion evidence, which remains visible to the anti-self-sign-off checks. For the newly authorized unrelated-job completion, it does not enqueue completion tags or CRM sends. Existing assigned-field behavior is preserved.

## Validation and handoff

`tests/team-lead-job-operations.test.mjs` covers the exact flag/role matrix, positive operations, forbidden actions/fields/targets, redaction, unrelated payment/expense/publication denial, stale revisions, repeated and changed retries, concurrent duplicate requests, conflict checks, split jobs, role revocation, safety evidence, multi-day completion, payroll preservation and sign-off restrictions. `tests/team-lead-job-operations-ui.test.mjs` exercises the real page script in the repository DOM harness, including text-safe rendering, account/revision binding, exact retry and no offline queue.

Test execution evidence and environment limitations are recorded in the local handoff beside the patch. Existing broad role/access assertions remain unchanged; none were skipped or weakened. Crew asset references/cache keys were updated; Hub asset keys were not changed.

## Publication and activation checks

1. Review this local patch, especially the operational field/action allowlists and completion exception. Reconcile it with the then-current main without modifying another agent's work.
2. Run the full root and 400-day shifted-clock suites, syntax and generator checks, Firestore emulator suites, and the applicable field/dispatch browser tests in the normal CI environment. The local Windows sandbox cannot substitute for real browser/emulator validation.
3. In a separately authorized preview environment, test Team Lead with `EGC_TEAM_LEAD_JOB_OPERATIONS=false`, then `true`, while the broader role/access switches remain off; test owner, manager, Sales, Phone, crew lead and crew accounts too. Verify all financial/communication endpoints remain denied for an unrelated job and direct Firestore access stays restricted. Test a multi-day job and an uncertain network response.
4. Use the repository's usual draft-PR and CI process. Merge only after required CI, browser and emulator checks pass; never bypass branch protection. Production deploys from main. Verify deployment before activating the narrow flag.
5. Separately review whether the dedicated job-operations flag is on and which accounts have the owner-set Team Lead role. Activate only EGC_TEAM_LEAD_JOB_OPERATIONS after the required validation. Do not enable broader role/access flags or modify live roles merely to deploy code. Keeping the flag off leaves the new operations capability unavailable. Rollback can revert this code or disable the existing flag, but disabling it removes only the new cross-crew job-operations capability.
