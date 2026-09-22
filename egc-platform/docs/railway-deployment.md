# Railway production deployment

This runbook deploys the EGC operational platform as four services plus managed Postgres.

## Services

Create one Railway project with:

- `egc-postgres` — managed PostgreSQL.
- `egc-worker` — background GHL reconciliation, transcript synchronization, webhook repair, outbox write-back, and database migrations.
- `egc-api` — verified GHL webhook receiver, canonical operations service, recording processor and inbound-reply reconciliation.
- `egc-mcp` — OAuth-protected, scoped and audited read/write tools for ChatGPT.
- `egc-portal` — legacy authenticated platform views. The existing Cloudflare Employee Hub remains the operational schedule, customer, project and job authority.

Redis is not required by the current V1 worker.

## Repository source

Use the GitHub repository:

`zacbezenek-ctrl/Easy-Garage-Cleaning`

Deploy the reviewed and merged `main` commit. Verify the actual deployment's commit hash; a redeploy of an old deployment can reuse its old source snapshot.

With the connected Railway tools, update each existing service's `EGC_RELEASE_SHA` to the merged commit using `set_variables` with `skipDeploys:false`. This triggers a new source deployment from the configured branch. Confirm `list_deployments.meta.commitHash` equals the intended commit before proceeding; the environment variable alone is not proof. This path deployed commit `153fb907ae2b483c5ffc4f52f77567223b219562` on September 22 after the generic `redeploy` action reused the previous source snapshot. Do not create replacement services to work around source selection.

All application services use repository root `/` as the build context, with watch path `/egc-platform/**`.

Set the custom Dockerfile paths:

| Service | Dockerfile |
| --- | --- |
| egc-api | `/egc-platform/infra/docker/Dockerfile.api` |
| egc-mcp | `/egc-platform/infra/docker/Dockerfile.mcp` |
| egc-worker | `/egc-platform/infra/docker/Dockerfile.worker` |
| egc-portal | `/egc-platform/infra/docker/Dockerfile.portal` |

Railway injects `PORT`; the API, MCP, and portal honor it automatically.

## Networking

Generate public HTTPS domains for:

- `egc-mcp` — required for ChatGPT.
- `egc-api` — required for GHL webhooks and voice walkthrough proxy traffic if the portal cannot use private networking.
- `egc-portal` — internal staff access.

The worker requires no public domain.

Use private networking from portal to API when possible. Set `API_URL` to the API service's Railway private URL.

## Postgres

Attach the managed Postgres `DATABASE_URL` to all four application services.

The worker runs checked-in Drizzle migrations before starting. API and MCP use pre-deploy command `pnpm --filter @egc/database migrate:runtime`. The migrator serializes concurrent migration runners with a PostgreSQL advisory lock. API and MCP readiness checks also verify the communication ledger; HTTP 200 alone is not functional acceptance.

## Persistent audio

For V1, attach a persistent Railway volume to `egc-api` at:

`/data/egc`

Set:

```
STORAGE_DRIVER=filesystem
STORAGE_PATH=/data/egc
```

R2/S3 can replace this later without changing the walkthrough database model.

## Shared / service variables

Never commit secret values.

### All DB-backed services

```
NODE_ENV=production
DATABASE_URL=<Railway Postgres reference>
```

### egc-worker

```
GHL_LOCATION_ID=<EGC GHL location>
GHL_PRIVATE_INTEGRATION_TOKEN=<private integration token>
GHL_WRITEBACK_ENABLED=true
```

The OAuth client secret is not required for the private-integration-token sync path. Keep it available only if/when the deployment switches to GHL OAuth.

### egc-api

```
API_BEARER_TOKEN=<random 32+ byte value>
OPENAI_API_KEY=<OpenAI API key>
GHL_LOCATION_ID=<EGC location>
GHL_PRIVATE_INTEGRATION_TOKEN=<existing private integration token>
STORAGE_DRIVER=filesystem
STORAGE_PATH=/data/egc
```

### egc-mcp

```
MCP_PUBLIC_ORIGIN=https://<egc-mcp-public-domain>
MCP_ALLOWED_HOSTS=<egc-mcp-hostname>
MCP_OAUTH_USER=<private EGC admin username>
MCP_OAUTH_PASSWORD=<random 20+ character password>
```

`MCP_BEARER_TOKEN` is optional and should only be set for internal diagnostic clients. ChatGPT uses OAuth.

### egc-portal

```
API_URL=<egc-api private or public origin>
API_BEARER_TOKEN=<same value as egc-api>
PORTAL_BASIC_USER=<private staff username>
PORTAL_BASIC_PASSWORD=<random strong password>
```

## Health checks

Configure:

- egc-api: `/health`
- egc-mcp: `/health`
- egc-portal: `/api/health`

The worker is a background process and should use process/restart monitoring instead of HTTP health checks.

## Initial validation

After the worker is live:

1. Verify the migration runner exits successfully and the worker remains running.
2. Verify contacts begin appearing in Postgres.
3. Verify conversations/messages, opportunities, appointments, and calls reconcile.
4. Verify a recent call transcript appears in `call_transcripts`.
5. Open the portal and confirm lead/customer/pipeline pages render live records.
6. Check `https://<mcp-host>/.well-known/oauth-protected-resource`.
7. Check `https://<mcp-host>/.well-known/oauth-authorization-server`.
8. Check `https://<mcp-host>/health` returns HTTP 200.
9. Connect the MCP in ChatGPT and complete the OAuth login.
10. Run the EGC three-day lead audit acceptance prompt.

## GHL webhook

Configure GHL to send supported webhook events to:

`https://<egc-api-host>/webhooks/ghl`

The receiver verifies the GHL Ed25519 signature. Webhooks provide low latency; the five-minute worker reconciliation remains the repair/fallback path.

Register subscriptions in the authenticated HighLevel Marketplace app configuration. A private integration token alone does not register webhooks. The receiver rejects missing/invalid signatures and other locations before queuing, persists duplicate-safe receipts, and returns a retryable failure if persistence fails. Unsupported/deletion payloads remain visible for review instead of silently deleting operational history.

## Employee Hub activation

Deploy the root site and Pages Functions to the existing Cloudflare Pages project. Keep `EGC_OPERATIONS_ENABLED=false` until both sides of the signed bridge are deployed and verified. Existing Meta variables and behavior are independent; do not alter them as part of this release.

| Variable | Services |
| --- | --- |
| `EGC_OPERATIONS_WORKSPACE=egc` | API, MCP, Cloudflare |
| `EGC_OPERATIONS_ENABLED=true` | API, MCP, Cloudflare and legacy Railway portal, after bridge verification |
| `EGC_OPERATIONS_API_ORIGIN` | MCP and Cloudflare; existing API HTTPS origin |
| `EGC_PORTAL_ORIGIN` | API; existing Employee Hub HTTPS origin |
| `EGC_OPERATIONS_MCP_SIGNING_SECRET` | Identical strong server-only secret on API and MCP |
| `EGC_OPERATIONS_PORTAL_SIGNING_SECRET` | Identical strong server-only secret on API and Cloudflare |
| `GHL_WALKTHROUGH_CALENDAR_ID`, `GHL_JOBS_CALENDAR_ID` | API; verified existing provider calendars |

Use distinct cryptographically random signing keys. Never put keys in browser code, requests shown to users, logs or Git. Hub requests carry the authenticated user's actual role; MCP requests carry the verified integration principal. Human recording/draft approvals require a real signed-in Hub owner or manager.

After activation, the API independently processes unanswered replies every minute. It uses an explicitly configured verified owner or the sole authoritative Hub owner; unresolved ownership remains an exception. Automatic reconciliation begins at durable activation, with explicit bounded historical reconciliation available through MCP. Shared appointment and note ledgers protect native Hub and MCP retries. Unknown provider outcomes require verification, never a blind replacement.

Temporarily set `EGC_OPERATIONS_VERIFY_ON_START=true` on MCP to verify authenticated loopback discovery and an existing read without exposing tokens. With the bridge enabled, `EGC_OPERATIONS_CANARY_ON_START=true` additionally creates and completes one clearly labeled, unlinked internal task per release. It sends no customer communication and makes no provider booking. Inspect the allowlisted `operations_startup_verification` log, then remove the temporary flags.

Complete the [production acceptance matrix](../../docs/operations-production-acceptance.md). Keep blocked live scenarios explicit; isolated tests do not certify live recordings, webhook subscriptions, payment evidence or Hub deployment.
