# Deployment checklist

The canonical production runbook is `railway-deployment.md`.

## Required infrastructure

- PostgreSQL
- Node.js 22-compatible runtimes for API, MCP, worker and portal
- Persistent filesystem volume on the API service for V1 walkthrough audio, or S3/R2

Redis is not required by the current V1 worker.

## Secret handling

Store values only in Railway variables/secrets. Never commit values to Git.

Required or conditionally required variables include:

- `DATABASE_URL`
- `GHL_LOCATION_ID`
- `GHL_PRIVATE_INTEGRATION_TOKEN`
- `GHL_WRITEBACK_ENABLED`
- `API_BEARER_TOKEN`
- `OPENAI_API_KEY`
- `MCP_PUBLIC_ORIGIN`
- `MCP_ALLOWED_HOSTS`
- `MCP_OAUTH_USER`
- `MCP_OAUTH_PASSWORD`
- `PORTAL_BASIC_USER`
- `PORTAL_BASIC_PASSWORD`
- `STORAGE_DRIVER`
- `STORAGE_PATH`

`MCP_BEARER_TOKEN` is optional and is not used by ChatGPT OAuth.

## Database

Initial migration files are checked into:

`packages/database/migrations/`

The worker executes the deterministic runtime migrator before starting reconciliation. API/MCP/portal health checks remain HTTP 503 until the migrated database is available.

## GHL

The worker uses the configured private integration token for read synchronization. When `GHL_WRITEBACK_ENABLED=true`, durable contact-note writes use the shared outbox with provider read-back, lease fencing and explicit unknown-outcome recovery.

The API verifies GHL webhook signatures. Webhooks provide low latency and the worker's periodic reconciliation repairs missed events.

## Portal

The existing Cloudflare Employee Hub is authoritative for operational jobs, visits, customers, scope and financial evidence. The Railway portal always directs walkthrough entry to the Employee Hub, including while `EGC_OPERATIONS_ENABLED=false`; its contact-only upload and approval proxy routes return HTTP 409 with the Hub URL. Do not reopen the legacy recording flow as a workaround for an unavailable Hub bridge. Deploy and verify both the signed Cloudflare bridge and Railway API. Service credentials never appear in browser code.

The v2 bridge uses `EGC_OPERATIONS_SERVICE_AUTH=v2` with `EGC_OPERATIONS_ENABLED=true` on the API. It derives separate Ed25519 signing seeds using HKDF-SHA256 from the API's existing `API_BEARER_TOKEN` and the Hub's existing `HUB_SESSION_SECRET`. Secrets stay in their original runtime. Native Hub code selects v2 when no mode is configured and its server session secret is at least 32 characters; an explicit false feature flag always disables it. Explicit legacy mode retains the old shared-key configuration only for a deliberate legacy deployment; a failed v2 signature never falls back to it. MCP retains its separately configured issuer key.

Public keys are published at `https://easygaragecleaning.com/api/operations-service-keys` and `https://egc-api-production-faeb.up.railway.app/operations/service-keys`. Verifiers only fetch those exact pinned URLs, reject redirects, and cache keys for at most 60 seconds. Requests bind issuer, audience, workspace, method, path, actor, request body and a 60-second expiry. Single-use nonces are claimed atomically in PostgreSQL or the dedicated Firestore `operations_service_nonces` collection, with expired receipt cleanup. An ambiguous request is retried with a fresh envelope and the same durable operation request ID. Root-secret rotation changes the derived key; allow the bounded cache expiry before retrying.

Validate both public key endpoints first, then a signed read-only Hub calendar/evidence request and replay rejection before operational repair writes. A Pages build and an isolated Workers smoke do not establish production database access. Existing Hub human session checks and endpoint role permissions remain required.

Reporting pages read the canonical customer event ledger and show source evidence, intent, next actions and stale-provider discrepancies. The signed Hub `portal.evidence` command reads exact-contact operational records independently of scheduled dates, including unscheduled accepted estimates and verified customer receipts. Calendar reconciliation still uses the Hub's authoritative dates and collision locks. A HighLevel outage must leave saved Hub work visible with provider reconciliation pending.

The first canonical reporting release remains production-acceptance pending until the actual deployed revision, signed bridge, customer histories and Meta responses are verified. Record results in [the operational release status](../../docs/operations-release-status.md). The root Hub uses `no-store` assets and has no service worker; confirm the release asset versions after deployment and reload the page.

## MCP

The MCP exposes Streamable HTTP at `/mcp` and OAuth discovery/authorization endpoints on the same HTTPS origin. Read tools require `egc:read`; bounded audited writes require `egc:write`. Durable requests use stable request IDs. Approving a draft never sends a message, collects a payment or changes a booking by itself.

See `chatgpt-connection.md` for the exact ChatGPT connection flow.

## Production validation

1. Confirm the worker migrates the database and stays running.
2. Confirm real GHL contacts synchronize.
3. Confirm messages, opportunities, appointments and calls synchronize.
4. Confirm at least one recent call transcript is persisted.
5. Confirm portal pages load real records.
6. Confirm MCP OAuth metadata endpoints return valid JSON.
7. Confirm MCP `/health` returns HTTP 200.
8. Connect the MCP in ChatGPT and complete OAuth.
9. Run the three-day EGC lead-audit acceptance prompt.
