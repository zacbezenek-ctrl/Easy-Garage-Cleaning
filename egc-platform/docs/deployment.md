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

The existing Cloudflare Employee Hub is authoritative for operational jobs, visits, customers, scope and financial evidence. While `EGC_OPERATIONS_ENABLED=false`, the Railway portal retains its existing legacy recording upload and approval workflow. Only records without managed Hub linkage can use legacy approval, even during rollback. Once enabled, the Railway recording page directs work to the Hub and the API/MCP reject legacy recording mutations. Deploy and verify both the Cloudflare signed bridge and Railway API before enabling unified operations; set the flag consistently on API, MCP, worker and portal. Service credentials never appear in browser code.

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
