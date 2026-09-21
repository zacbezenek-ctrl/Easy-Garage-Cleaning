# MCP Tools

The EGC MCP has two OAuth scopes:

- `egc:read` — query EGC/GHL operational data.
- `egc:write` — perform bounded operational mutations.

No payment collection or refund tools are exposed. Explicitly authorized messages use a durable execution ledger and verified provider identity; accepted and delivered are distinct states. Human approvals remain tied to the exact reviewed revision.

## Meta conversion feedback

- `meta.conversions.preview(days=7, from?, to?, limit=100)` — read-only downstream event candidates, eligibility reasons, matching quality, and send/skip explanations. No ledger writes or transmissions.
- `meta.conversions.status(days=30, from?, to?, limit=100)` — configuration readiness, last sync, pending/failures/recent accepted events, matching and attribution health, and conversion rates for morning-brief reporting.
- `meta.conversions.sync(days=7, from?, to?, limit=100, dryRun=true)` — `egc:write`; reconcile and send eligible unsynced conversions with durable idempotency. Explicitly set `dryRun=false` to request transmission; server configuration, activation, and event-age gates still apply.
- `meta.conversions.retry(days=7, from?, to?, limit=100, eventIds?, dryRun=true)` — `egc:write`; retry failed events using their original IDs. Accepted events remain protected. Event IDs are optional and limited to 100.
- `meta.conversions.test()` — `egc:write`; send a synthetic diagnostic using the server's `META_CAPI_TEST_EVENT_CODE`, with no customer data or user-supplied payload.

Date filters accept ISO 8601 timestamps with an explicit UTC offset. Preview/status allow a 1–90 day lookback; sync/retry allow 1–7 days. These tools cannot enable production mode, change the destination, change ad optimization, or authorize historical backfill. Public results omit matching values and credentials. The backend worker independently reconciles every minute, so delivery does not depend on the morning brief or an MCP call. See [Meta conversions deployment and operations](meta-conversions.md) for configuration and activation.

For deployment verification, temporarily set `META_CAPI_VERIFY_ON_START=true` on the MCP service. After listening, it uses the existing server-side `MCP_BEARER_TOKEN` against its own loopback MCP endpoint to verify discovery, preview, dry-run sync, status, and the existing lead-conversion funnel. Logs contain only tool names and allowlisted aggregate counts. The diagnostic does not send Meta events or expose an additional HTTP endpoint.

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

## Raw normalized read tools

- `contacts.search(query, limit)`
- `contacts.get(contactId)`
- `leads.search(state?, days, limit)`
- `leads.get(leadId)`
- `conversations.search(contactId, limit)`
- `conversations.get(conversationId, messageLimit)`
- `calls.search(contactId?, days, limit)`
- `calls.get(callId)`
- `calls.transcript(contactId, days=30)`
- `opportunities.search(contactId?, status?, limit)`
- `opportunities.get(opportunityId)`
- `appointments.search(contactId?, daysPast, daysFuture, limit)`
- `jobs.search(contactId?, status?, limit)`
- `jobs.get(jobId)`
- `walkthroughs.search(contactId?, status?, limit)`
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

`conversations.send_message`, `send_sms` and `egc.send_followup` require explicit authorization, a stable `requestId`, verified recipient/contact and channel DND checks. The ledger stores intent before the send. Retries reuse the original execution, and unresolved identical sends remain blocked even with a new request ID. `communications.executions` and `communications.reconcile` expose safe status/recovery. These tools never infer delivery from a generic successful HTTP request.

## Acceptance query

> How many leads still need to be contacted from the last three days? Give me everyone who hasn't responded. Read their call transcripts. Tell me everyone who booked in the last three days and exactly what each job is.

Booking tools filter by booking creation timestamp. Appointment start time is stored separately. Missing creation time is left unknown rather than fabricated from appointment start time.

## Acceptance write workflow

A connected `egc:write` client should be able to execute:

> Read the exact saved Hub visit, schedule the authorized time on its correct calendar, append the crew instruction at the current job revision, and read back the same visit, provider appointment, project and note IDs.

Resolve exact customer, project, visit and owner IDs before bounded writes. Reuse request IDs on retries. Customer approval, sales value, completion and payment evidence remain separate facts; a scheduled appointment is not a sale. See the [25-case production acceptance matrix](../../docs/operations-production-acceptance.md) for release evidence requirements.
