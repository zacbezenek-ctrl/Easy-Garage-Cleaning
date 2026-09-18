# Architecture

```
GoHighLevel
   ^
   | v3 reads/writes + signed webhooks + reconciliation
   v
EGC API / workers
   |
   +--> Postgres (canonical normalized data)
   +--> persistent audio storage
   |
   +--> EGC Portal
   +--> EGC MCP
```

## Design rules

1. Postgres is the canonical EGC operational layer. GHL remains the CRM and communications provider.
2. Webhooks provide low-latency updates; reconciliation repairs missed events.
3. Every provider object keeps its provider ID and raw payload for debugging.
4. Booking queries use `appointment_created_at`, not appointment start time.
5. Automated outreach and human outreach are stored separately.
6. Call transcripts are persisted locally so analytical queries never depend on a live GHL call.
7. Voice walkthrough extraction remains a draft until approved.
8. MCP permissions are split into `egc:read` and `egc:write`.
9. MCP writes are limited to operational CRM/job actions; payment/refund/delete/send-message actions are intentionally excluded.
10. GHL mutations are mirrored into Postgres immediately and audited. Periodic reconciliation remains the repair path.

## HighLevel API

The client uses `https://services.leadconnectorhq.com` with HighLevel's current `Version: v3` header.

The GHL client supports current contact upsert/update/tag operations, opportunity create/update and pipeline discovery, appointment create/update/calendar discovery, call recording/transcription, notes, and synchronization reads.

## Webhook verification

GHL's current webhook signature is `X-GHL-Signature` using Ed25519. The API verifies the exact raw request bytes before processing the parsed JSON body.
