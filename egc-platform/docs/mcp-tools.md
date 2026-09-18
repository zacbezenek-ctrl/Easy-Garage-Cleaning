# MCP Tools

The EGC MCP has two OAuth scopes:

- `egc:read` — query EGC/GHL operational data.
- `egc:write` — perform bounded operational mutations.

No payment, refund, delete, or direct customer-message tools are exposed.

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
- `egc.customer_history(contactId)`
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

- `appointments.create(...)`
- `appointments.update(appointmentId, changes)`

Writes support calendar, start/end time, status, assigned user, description/address, and optional EGC job linking. Exact duplicate contact/calendar/start-time creates are blocked locally. GHL automations are disabled by default unless `runAutomations=true`.

### EGC jobs

- `jobs.create(contactId, ...)`
- `jobs.update(jobId, changes)`
- `jobs.add_note(jobId, type, body)`

Job updates support status, address, scope, add-ons, access, labor, schedule, price, and deposit values.

### Walkthroughs

- `walkthroughs.create_draft(contactId, extraction, ...)`
- `walkthroughs.update_draft(walkthroughId, ...)`
- `walkthroughs.approve(walkthroughId, extraction?)`

Approval creates a job when needed or updates the linked job scope and can queue GHL note write-back.

## Acceptance query

> How many leads still need to be contacted from the last three days? Give me everyone who hasn't responded. Read their call transcripts. Tell me everyone who booked in the last three days and exactly what each job is.

Booking tools filter by booking creation timestamp. Appointment start time is stored separately. Missing creation time is left unknown rather than fabricated from appointment start time.

## Acceptance write workflow

A connected `egc:write` client should be able to execute:

> Pull up Peggy, move the opportunity to won at $2,800, book the correct calendar for Tuesday at 9, create/link the EGC job using the walkthrough scope, and add the crew note.

The model should use reference tools to resolve pipeline/calendar/user IDs, then call bounded write tools. Every write is audited.
