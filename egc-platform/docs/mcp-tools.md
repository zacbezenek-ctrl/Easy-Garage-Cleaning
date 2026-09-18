# MCP Tools

V1 is intentionally read-only. The MCP reads the normalized EGC Postgres layer rather than querying GoHighLevel live for every question.

## Business tools

- `egc.leads_needing_contact(days=3)`
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

`egc.recent_bookings` is enriched with the latest local job scope, opportunity context, recent messages, and persisted call transcripts so the normal booking question can be answered in one tool call.

`egc.sales_rep_performance` returns observed counts by GHL user ID. It does not rank reps. `egc.walkthrough_conversion` currently measures the voice-walkthrough workflow; a true sales walkthrough-to-job close rate requires mapping the relevant sales appointment type.

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

## Acceptance query

The first end-to-end acceptance test is:

> How many leads still need to be contacted from the last three days? Give me everyone who hasn't responded. Read their call transcripts. Tell me everyone who booked in the last three days and exactly what each job is.

Booking tools filter by the booking creation timestamp. The appointment start timestamp is stored and returned separately. If the provider does not supply a trustworthy booking creation timestamp, the system leaves it unknown rather than substituting the appointment start time.

Lead follow-up state distinguishes human outreach from automation. A customer counts as having replied to the current follow-up only when a response occurred after the latest human outreach.

## Security

The HTTP endpoint requires `Authorization: Bearer <MCP_BEARER_TOKEN>`. Production also requires `MCP_ALLOWED_HOSTS`.

V1 deliberately exposes no send-message, contact deletion, refund, invoice, appointment-cancel, pricing, or other mutation tools.
