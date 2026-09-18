# Railway production deployment

This runbook deploys the EGC operational platform as four services plus managed Postgres.

## Services

Create one Railway project with:

- `egc-postgres` — managed PostgreSQL.
- `egc-worker` — background GHL reconciliation, transcript synchronization, webhook repair, outbox write-back, and database migrations.
- `egc-api` — verified GHL webhook receiver and voice walkthrough API.
- `egc-mcp` — read-only, OAuth-protected MCP server for ChatGPT.
- `egc-portal` — authenticated internal operations portal.

Redis is not required by the current V1 worker.

## Repository source

Use the GitHub repository:

`zacbezenek-ctrl/Easy-Garage-Cleaning`

Deploy the branch containing the platform until PR #40 is merged, then switch production to `main`.

All application services use repository root `/egc-platform` as the build context.

Set the custom Dockerfile paths:

| Service | Dockerfile |
| --- | --- |
| egc-api | `/infra/docker/Dockerfile.api` |
| egc-mcp | `/infra/docker/Dockerfile.mcp` |
| egc-worker | `/infra/docker/Dockerfile.worker` |
| egc-portal | `/infra/docker/Dockerfile.portal` |

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

The worker runs checked-in Drizzle migrations before starting. API, MCP, and portal health endpoints return HTTP 503 until the migrated `contacts` table is available, preventing premature traffic activation.

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
