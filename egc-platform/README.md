# Easy Garage Cleaning Platform

Canonical operational backend for Easy Garage Cleaning.

## Workspace

- `apps/api` — GHL webhook receiver + voice walkthrough API
- `apps/mcp` — OAuth-protected EGC MCP for ChatGPT with scoped read/write operations
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

The ChatGPT MCP uses OAuth 2.1 + PKCE with separate `egc:read` and `egc:write` scopes. Write access is intentionally limited to EGC operations: contacts/tags/assignment, opportunities, appointments, internal jobs/notes, and walkthroughs. It does not expose payment/refund/delete/send-message tools.

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

From ChatGPT, the MCP must be able to:

- identify who needs human contact and who has not replied since the latest human outreach;
- read calls/transcripts, bookings, job briefs, customer history, pipeline, and operating metrics;
- create/update contacts and tags/assignment in GHL;
- create/update opportunities including stage, status, owner, and value;
- create/update/reschedule appointments and link them to jobs;
- create/update EGC jobs, pricing/schedule/scope, and job notes;
- create/edit/approve walkthrough drafts and turn approved scope into a job;
- mirror approved operational notes back to GHL.

The voice walkthrough saves a draft structured scope first. A human can review/edit it in the portal, or ChatGPT can edit/approve it with `egc:write`.
