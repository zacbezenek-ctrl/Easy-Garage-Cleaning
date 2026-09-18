# Deployment checklist

## Required managed services

- PostgreSQL
- Redis (for the next queue iteration)
- Node 20+ runtime for API, MCP and worker
- Object storage before enabling voice audio upload

## Secrets

Set these only in the deployment secret store:

- `DATABASE_URL`
- `REDIS_URL`
- `GHL_LOCATION_ID`
- `GHL_PRIVATE_INTEGRATION_TOKEN` (new, rotated)
- `GHL_CLIENT_SECRET` (new, rotated)
- `GHL_WEBHOOK_PUBLIC_KEY`
- `MCP_BEARER_TOKEN`
- `OPENAI_API_KEY`
- storage credentials

Do not deploy with the GHL token or client secret previously pasted into ChatGPT.

## Processes

- API: `pnpm --filter @egc/api build && node apps/api/dist/server.js`
- MCP: `pnpm --filter @egc/mcp build && node apps/mcp/dist/server.js`
- Worker: `pnpm --filter @egc/worker build && node apps/worker/dist/worker.js`

## First production validation

1. Run database migrations.
2. Start worker with a read-capable replacement GHL private integration token.
3. Confirm at least one real contact syncs.
4. Confirm a conversation and its messages sync.
5. Confirm a call recording URL and transcript are persisted.
6. Connect ChatGPT to the deployed `/mcp` endpoint.
7. Run the 3-day lead audit acceptance query.
