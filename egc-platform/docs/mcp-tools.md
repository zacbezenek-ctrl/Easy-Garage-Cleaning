# MCP Tools

The EGC MCP has two OAuth scopes:

- `egc:read` — query EGC/GHL operational data.
- `egc:write` — perform bounded operational mutations.

No payment collection or refund tools are exposed. Explicitly authorized messages use a durable execution ledger and verified provider identity; accepted and delivered are distinct states. Human approvals remain tied to the exact reviewed revision.

## Tool registry and safety policy

New tools are declared with `defineTool` (`apps/mcp/src/tools/define.ts`) in a module under `apps/mcp/src/tools/domains/` and listed in `tools/index.ts`. The class (`read`, `write`, `destructive`, `send`, `money`) derives everything else, so metadata and enforcement cannot drift:

- `read` requires `egc:read`; every other class requires `egc:write`, is added to the HTTP write set automatically, and must accept a required UUID `requestId`.
- `destructive`, `send` and `money` are two-step: the definition must provide a side-effect-free `preview` and an optional `confirmToken`. A call without a token returns only the preview; nothing runs without a verified confirmation. No confirmation verifier is installed yet, so these tools are preview-only.
- Inputs must be strict objects (unknown keys are rejected). Thrown errors never reach the client; error payloads keep only a snake_case code and bounded, non-sensitive details (`tools/result.ts`). If a non-read handler throws or returns output that fails its schema, it may already have committed, so the result is `tool_outcome_unknown` with the `requestId` and `retryMode: "same_request_id"`; read tools return `tool_operation_failed`.
- `ownerOnly` tools refuse the static service bearer and require an OAuth grant.
- List tools page with `tools/pagination.ts`: an opaque `cursor` bound to the tool and its exact filters (and optionally anchored to the first page's time, refused after a day), `limit` ≤ 200, and a `{items,page,asOf,coverage}` envelope.

Every registered tool, legacy or registry, has an entry in `apps/mcp/test/fixtures/tool-contracts.ts` (valid and invalid input, class and scope, two-step requirement, and the bridge command, SQL statement, provider call or service it must reach in each mode). `test/tool-contracts.test.ts` builds the full server in both modes on a fixed clock and fails when a tool has no entry, when its annotations or scopes disagree with `tool-access.ts`, when a read tool runs any statement other than a select or a session `set`/`show` (a data-modifying CTE or an unrecognised statement counts as a write), or when a tool that writes the send ledger or calls the provider's send, or is listed in `DIRECT_SEND_TOOLS`, is not class `send`.

`egc.safety_policy()` reads the live mode, whether one-step customer sends are enabled, the legacy writes disabled in Action Center mode, and each registry tool's class, scope, request-ID and two-step requirements.

## Meta conversion feedback

- `meta.conversions.preview(days=7, from?, to?, limit=100)` — read-only downstream event candidates, eligibility reasons, matching quality, and send/skip explanations. No ledger writes or transmissions.
- `meta.conversions.status(days=30, from?, to?, limit=100)` — configuration readiness, last sync, pending/failures/recent accepted events, matching and attribution health, and conversion rates for morning-brief reporting.
- `meta.conversions.sync(days=7, from?, to?, limit=100, dryRun=true)` — `egc:write`; reconcile and send eligible unsynced conversions with durable idempotency. Explicitly set `dryRun=false` to request transmission; server configuration, activation, and event-age gates still apply.
- `meta.conversions.retry(days=7, from?, to?, limit=100, eventIds?, dryRun=true)` — `egc:write`; retry failed events using their original IDs. Accepted events remain protected. Event IDs are optional and limited to 100.
- `meta.conversions.test()` — `egc:write`; send a synthetic diagnostic using the server's `META_CAPI_TEST_EVENT_CODE`, with no customer data or user-supplied payload.

Date filters accept ISO 8601 timestamps with an explicit UTC offset. Preview/status allow a 1–90 day lookback; sync/retry allow 1–7 days. These tools cannot enable production mode, change the destination, change ad optimization, or authorize historical backfill. Public results omit matching values and credentials. The backend worker independently reconciles every minute, so delivery does not depend on the morning brief or an MCP call. See [Meta conversions deployment and operations](meta-conversions.md) for configuration and activation.

For deployment verification, temporarily set `META_CAPI_VERIFY_ON_START=true` (and `MCP_BEARER_WRITE_ENABLED=true`, because the dry-run sync and the optional `META_CAPI_TEST_ON_START=true` synthetic test are write-scoped tools) on the MCP service. Without `MCP_BEARER_WRITE_ENABLED=true` the verification skips those write-scoped checks and logs `bearer_write_disabled` instead of an opaque failure. After listening, it uses the existing server-side `MCP_BEARER_TOKEN` against its own loopback MCP endpoint to verify discovery, preview, dry-run sync, status, and the existing lead-conversion funnel. Logs contain only tool names and allowlisted aggregate counts. The diagnostic does not send Meta events or expose an additional HTTP endpoint.

## Live GHL reference tools

Use these before writes when provider IDs are unknown:

- `ghl.pipelines()`
- `ghl.calendars()`
- `ghl.users()`

## Business read tools

- `egc.leads_needing_contact(days=3)`
- `egc.followups_due(days=3)`
- `egc.leads_not_responding(days=3)`
- `egc.recent_bookings(days=3)`
- `egc.customer_history(contactId?, portalJobId?, offset?, limit?)` — with unified operations enabled, one chronology of persisted messages, calls, visits, recordings, actions and notes; exact `portalJobId` adds native financial evidence. At least one exact ID is required.
- `egc.job_brief(jobId)`
- `egc.tomorrows_jobs(timeZone="America/Denver")`
- `egc.unanswered_calls(days=7)`
- `egc.stale_opportunities(staleDays=7)`
- `egc.sales_pipeline(status="open")`
- `egc.jobs_by_status()`
- `egc.lead_conversion_funnel(days=30)`
- `egc.revenue_summary(days=30)`
- `egc.sales_rep_performance(days=30)`
- `egc.addon_attach_rates(days=90)`
- `egc.walkthrough_conversion(days=90)`
- `egc.whats_overdue(owner?, limit=20, cursor?)` — answers "what's overdue?" from the Action Center (registry `read` tool, `apps/mcp/src/tools/domains/followups.ts`, `egc:read` only). With unified operations enabled it pages the bridge `queue` command with `view:"overdue"` (200 per bridge call, at most 5 calls; each later call starts one row before the previous page's end and must repeat that page's last action) and returns `summary:{total,exact,byOwner:[{owner,count,kinds}],byKind}` plus a page of items: title, kind, owner (`null` = unassigned), minutes overdue, up to three `sourceEvidence` excerpts, and a preview of any stored message draft (channel, recipient, subject, the first 280 characters of the body, send window, attachment kinds and labels; links stay behind `actions.review`). An action is overdue when its due time has passed, or its review time when it is waiting on the customer or a provider. It never sends, approves, snoozes or completes anything; a draft goes out only after an owner or manager approves it in the Hub. `owner` is an exact Hub business-user ID (see `egc.operations_owners`); omit it for everyone. Counts cover registered actions only, not commitments nobody recorded. Truthfulness: a malformed bridge page is `operations_response_invalid` and a disabled backend is `operations_not_enabled` (both errors, never an empty list); beyond 996 overdue actions (200, then 199 new per overlapping call) `coverage:{complete:false,reason:"scan_limit_reached"}` and `summary.exact:false`; a queue that moved between bridge calls (a changed total, or an overlap row that does not match, which catches a completion plus a newly overdue action) reports `queue_changed_during_read`. Pages follow the MCP-READS cursor envelope `{items,page,asOf,coverage}`: pass `page.nextCursor` back as `cursor` with the same `owner`; every page keeps the first page's `asOf` and counts only actions overdue at that time, and a later page reports `rows_changed_after_asOf` when a counted action was updated after it. An action completed, snoozed, rescheduled, or reassigned away from the `owner` filter after `asOf` leaves the live queue without being reported, so a later page may skip a row; when a fixed set matters, start a fresh walk (omit `cursor`) or save a stored snapshot with `egc.generate_brief` (a write) and read it with `egc.daily_brief`. In legacy mode the tool returns `operations_not_enabled` before any request. The same overdue queue is the "Overdue follow-ups" widget on the Hub home (Command center for the whole team, My day for the signed-in user).

## Raw normalized read tools

> **Breaking change (2026-09-28, MCP-READS).** Connector owners and scripts that call these tools must update before this deploys:
> - The nine `.search` tools return `{items,page,asOf,coverage}` instead of a bare array; read rows from `items` and follow `page.nextCursor`.
> - `conversations.get` returns `messages` as the same page envelope instead of an array.
> - A `limit` or `messageLimit` above 200 is still accepted but is served 200 rows per call; the rest arrives through `page.nextCursor`, so a walk that used to be one call may now take several.
> - A `.get` for a missing record is an error result (`isError`, e.g. `{error:"job_not_found"}`) instead of a normal result.
> - Unknown input keys are rejected instead of ignored.
>
> Saved ChatGPT or Claude prompts that index the old array, and external scripts that parse it, will break at deploy. There is no compatibility flag.

These read the PostgreSQL provider mirror, not the Employee Hub. The `.search`/`.get` tools are registry `read` tools (`apps/mcp/src/tools/domains/crm-reads.ts`). Each `.search` returns `{items,page:{limit,offset,returned,nextCursor},asOf,coverage}`: every filter runs in SQL before `LIMIT`, ordering has an `id` tie-breaker, and `page.nextCursor` passed back as `cursor` with the same filters reads the next page until it is `null`. A cursor is bound to its tool and exact filters. The original inputs, defaults and maximum `limit` values are still accepted; a page never exceeds 200 rows, so larger requests continue through `nextCursor` instead of being truncated. Unknown input keys are rejected.

A walk is anchored to its first page: the cursor carries that page's time, every later page reports the same `asOf`, and relative windows (`days`, `daysPast`, `daysFuture`) are measured from it, so an appointment that starts between calls cannot shift the offset. A cursor is refused with `invalid_cursor` once its anchor is more than a day old (or in the future); start again without `cursor`. Pages are offsets over a live ordering, so after reading a later page the tool checks for rows matching the same filters that were created or updated after `asOf` (for `leads.search` with `state`, also a canonical snapshot written after `asOf`). If there are any, that page reports `coverage:{complete:false,reason:"rows_changed_after_asOf"}`, because a row may be missing or repeated; start a fresh walk when an exact set matters. A row that is deleted, or stops matching a filter, after `asOf` is not detected by that check.

- `contacts.search(query="", limit=50, cursor?)`
- `contacts.get(contactId)`
- `leads.search(state?, days=30, limit=100, cursor?)`
- `leads.get(leadId)`
- `conversations.search(contactId, limit=50, cursor?)`
- `conversations.get(conversationId, messageLimit=100, cursor?)` — `messages` is a page of the conversation's messages, newest first.
- `calls.search(contactId?, days=30, limit=100, cursor?)`
- `calls.get(callId)`
- `calls.transcript(contactId, days=30)`
- `opportunities.search(contactId?, status?, limit=100, cursor?)`
- `opportunities.get(opportunityId)`
- `appointments.search(contactId?, daysPast=30, daysFuture=90, limit=200, cursor?)` — earliest start first.
- `jobs.search(contactId?, status?, limit=100, cursor?)`
- `jobs.get(jobId)`
- `tasks.search(status?, priority?, assignedUserId?, contactId?, jobId?, opportunityId?, dueBefore?, dueAfter?, limit=100, cursor?)`
- `walkthroughs.search(contactId?, status?, limit=100, cursor?)`
- `walkthroughs.get(walkthroughId)`
- `walkthroughs.transcript(walkthroughId)`

## Write tools

### Contacts / CRM identity

- `contacts.create(contact)` — GHL upsert + local contact/lead normalization.
- `contacts.update(contactId, changes)` — update GHL and local normalized record.
- `contacts.add_tags(contactId, tags)`
- `contacts.remove_tags(contactId, tags)`

Contact assignment through `assignedTo` also updates the local lead assignment.

### Opportunities

- `opportunities.create(...)`
- `opportunities.update(opportunityId, changes)`

Writes support pipeline/stage, status, value, owner, forecast fields, and custom fields. A newly created opportunity can optionally be linked to an EGC job.

### Appointments

- `egc.schedule_visit(requestId, ...)` — authoritative Hub visit create/reschedule/cancel followed by durable provider synchronization.
- `egc.visit_get(portalVisitId)` — exact Hub visit, project/customer links and separate sync state.
- `appointments.create(...)`, `appointments.update(...)`, `appointments.cancel(...)` — provider operations with stable request IDs and shared execution ledger.
- `appointments.operation_status(...)`, `appointments.reconcile(...)` — inspect or verify uncertain provider outcomes without blindly repeating creates.

Writes support calendar, start/end time, status and assignment with exact customer/visit identity. Reuse the original request ID and payload after timeout. Uncertain results remain visible until provider evidence resolves them. GHL automations are disabled by default unless explicitly requested. With unified operations enabled, schedule through the authoritative Hub tools.

### EGC jobs

- `jobs.create(contactId, ...)`
- `jobs.update(jobId, changes)`
- `jobs.add_note(jobId, type, body)`

These legacy PostgreSQL job mutations are disabled when unified operations is enabled. Use `egc.add_job_note`, `egc.update_job_operations`, and `egc.link_project` against exact Employee Hub records with the current revision and stable request ID. Operational instructions preserve signed scope/value. Completion requires the actual occurrence time and evidence; it does not establish a sale or payment.

### Walkthroughs

- `walkthroughs.create_draft(contactId, extraction, ...)`
- `walkthroughs.update_draft(walkthroughId, ...)`
- `walkthroughs.approve(walkthroughId, extraction?)`

While `EGC_OPERATIONS_ENABLED=false`, legacy draft creation, editing and approval remain available for unlinked PostgreSQL walkthroughs. Legacy approval commits the reviewed scope to its PostgreSQL job and queues the existing optional GHL note. It cannot approve or edit a managed Hub recording in either flag state. Once unified operations is enabled, these legacy mutations are blocked. Use the signed-in Employee Hub recording flow: persist audio first, process to a reviewable draft, and let an authenticated owner/manager approve the exact extraction. `recordings.list`, `recordings.get`, and `recordings.retry` inspect or retry managed recordings; MCP cannot impersonate their human reviewer.

### Canonical actions and reporting

- `egc.operations_status`, `egc.operations_owners` — actual readiness, queue/failure/freshness health and verified assignment identities.
- `actions.queue`, `actions.review` — current canonical task records, approvals and history.
- `actions.propose`, `actions.edit`, `actions.snooze`, `actions.cancel`, `actions.complete` — durable internal mutations with stable request ID and revision checks.
- `actions.reconcile_inbound` — create missing review actions for unanswered customer messages, including booked customers. Default uses activation cutoff; optional historical lookback is bounded.
- `actions.complete_from_message` — close the exact reviewed follow-up only after fresh verified delivery evidence matches its approved draft, recipient, revision and approval window.
- `egc.generate_brief`, `egc.daily_brief` — save/read immutable task snapshots with separate current-change indicators.
- `egc.calendar`, `egc.job_brief` — authoritative Employee Hub records, exact IDs and source revision; no name/latest-job fallback.
- `egc.revenue_summary` — with unified operations enabled, actual dated approved quotes, completed work and verified gross cash are separate. Missing values and incomplete refund coverage stay explicit.

### Authorized communication

`conversations.send_message`, `send_sms` and `egc.send_followup` require explicit authorization, a stable `requestId`, verified recipient/contact and channel DND checks. With `EGC_OPERATIONS_ENABLED=true` they are refused with `direct_send_disabled_in_operations_mode` before any ledger or provider access unless `EGC_MCP_DIRECT_SENDS_ENABLED=true`. Queue the exact draft with `actions.propose` (kind `followup_message`) for owner/manager approval in the Employee Hub; approval does not send. Sending an approved draft needs the Hub one-tap send (Phase 3) or MCP two-step confirmation (Phase 6), and neither is enabled yet. Until then `actions.complete_from_message` has no execution ID to verify, so an approved `followup_message` action can only be cancelled. The ledger stores intent before the send. Retries reuse the original execution, and unresolved identical sends remain blocked even with a new request ID. `communications.executions` and `communications.reconcile` expose safe status/recovery. These tools never infer delivery from a generic successful HTTP request.

## Acceptance query

> How many leads still need to be contacted from the last three days? Give me everyone who hasn't responded. Read their call transcripts. Tell me everyone who booked in the last three days and exactly what each job is.

Booking tools filter by booking creation timestamp. Appointment start time is stored separately. Missing creation time is left unknown rather than fabricated from appointment start time.

## Acceptance write workflow

A connected `egc:write` client should be able to execute:

> Read the exact saved Hub visit, schedule the authorized time on its correct calendar, append the crew instruction at the current job revision, and read back the same visit, provider appointment, project and note IDs.

Resolve exact customer, project, visit and owner IDs before bounded writes. Reuse request IDs on retries. Customer approval, sales value, completion and payment evidence remain separate facts; a scheduled appointment is not a sale. See the [25-case production acceptance matrix](../../docs/operations-production-acceptance.md) for release evidence requirements.
