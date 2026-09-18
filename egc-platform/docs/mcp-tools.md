# MCP Tools

V1 is intentionally read-only.

## Business tools

- `egc.leads_needing_contact(days=3)`
- `egc.leads_not_responding(days=3)`
- `egc.recent_bookings(days=3)`
- `egc.customer_history(contactId)`
- `egc.job_brief(jobId)`

## Raw tools

- `calls.transcript(contactId, days=30)`

The first acceptance test is:

> How many leads still need to be contacted from the last three days? Give me everyone who hasn't responded. Read their call transcripts. Tell me everyone who booked in the last three days and what each job is.

Booking tools filter by the booking's creation timestamp. The appointment start timestamp is returned separately.

## Security

The HTTP endpoint requires `Authorization: Bearer <MCP_BEARER_TOKEN>`. V1 deliberately exposes no send-message, delete, refund, invoice, appointment-cancel, or pricing mutation tools.
