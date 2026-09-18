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

The client uses `https://services.leadconnectorhq.com` with HighLevel's current `Version: v3` API header. Recording retrieval returns WAV bytes; transcription uses the separate v3 transcription route.

## Webhook verification

GHL's current webhook signature is `X-GHL-Signature` using Ed25519. The API verifies the exact raw request bytes before processing the parsed JSON body.
