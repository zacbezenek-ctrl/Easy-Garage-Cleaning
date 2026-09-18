# Architecture

```
GoHighLevel
   |
   | signed webhooks + reconciliation
   v
EGC API / workers
   |
   +--> Postgres (canonical normalized data)
   +--> object storage (audio / images)
   +--> Redis (queue / locks)
   |
   +--> EGC Portal
   +--> EGC MCP
```

## Design rules

1. Postgres is the operational system of record. GHL remains the CRM and communications provider.
2. Webhooks provide low-latency updates; reconciliation repairs missed events.
3. Every provider object keeps its provider ID and raw payload for debugging.
4. Booking queries use `appointment_created_at`, not appointment start time.
5. Automated outreach and human outreach are stored separately.
6. Call transcripts are persisted locally so analytical queries never depend on a live GHL call.
7. Voice walkthrough extraction is a draft until a human approves it.
8. MCP is read-only in V1.

## HighLevel API

The client uses `https://services.leadconnectorhq.com` and the current `Version: v3` request header. The call recording and transcription endpoints are represented explicitly in `packages/ghl`.

## Webhook verification

GHL's current webhook signature is `X-GHL-Signature` using Ed25519. The API verifies the raw body before parsing it. Do not downgrade this to a shared query-string secret.
