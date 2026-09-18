# Easy Garage Cleaning Platform

Canonical operational backend for Easy Garage Cleaning.

## Workspace

- `apps/api` — GHL webhook receiver + voice walkthrough API
- `apps/mcp` — read-only OAuth-protected EGC MCP for ChatGPT
- `apps/portal` — authenticated internal operations portal
- `apps/worker` — GHL reconciliation, transcript sync, webhook repair, write-back outbox
- `packages/database` — Postgres schema, migrations, runtime migration runner
- `packages/ghl` — typed GoHighLevel v3 client
- `packages/schemas` — shared job/walkthrough contracts
- `packages/storage` — filesystem or S3-compatible walkthrough audio storage
- `services/lead-audit` — canonical lead state and booking logic

The marketing website at the repository root remains independent.

## Security

Credentials are never committed to Git. Put GHL credentials, OpenAI keys, database URLs, OAuth credentials, and internal service passwords only in the deployment secret/variable store.

The ChatGPT MCP is read-only and uses OAuth 2.1 + PKCE. The optional `MCP_BEARER_TOKEN` is only for internal diagnostics.

## Local startup

1. Copy `.env.example` to `.env`.
2. Start Postgres with `docker compose up -d`.
3. Install dependencies with `pnpm install`.
4. Run `pnpm db:migrate`.
5. Run `pnpm dev`.

## Production

See:

- `docs/railway-deployment.md`
- `docs/chatgpt-connection.md`
- `docs/mcp-tools.md`
- `docs/walkthrough-system.md`

## V1 acceptance target

From ChatGPT, the MCP must answer:

- who needs human contact from the last N days;
- who received human outreach but has not replied since the latest outreach;
- who booked in the last N days using booking creation time;
- what each booked customer wants;
- call transcripts and job briefs;
- tomorrow's jobs, unanswered calls, stale opportunities, pipeline and operating metrics.

The voice walkthrough saves a draft structured scope first. A human reviews/edits it before approval and optional GHL note write-back.
