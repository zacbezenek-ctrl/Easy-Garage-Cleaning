# Easy Garage Cleaning Platform

Canonical operational backend for Easy Garage Cleaning.

## What this workspace contains

- `apps/api` — internal HTTP API + verified GHL webhook receiver
- `apps/mcp` — read-only EGC MCP for ChatGPT and other MCP clients
- `apps/worker` — reconciliation and transcript sync worker
- `packages/database` — normalized Postgres schema and DB connection
- `packages/ghl` — typed GoHighLevel v3 client
- `packages/schemas` — shared job / walkthrough contracts
- `services/lead-audit` — business-level lead state and booking logic

The marketing website at the repository root is intentionally independent from this workspace.

## Security

Do not reuse credentials that were pasted into chat or committed anywhere. Rotate the GHL private integration token and OAuth client secret before deployment, then place replacement values only in deployment secrets.

## Local startup

1. Copy `.env.example` to `.env`.
2. Start Postgres + Redis with `docker compose up -d`.
3. Install dependencies with `pnpm install`.
4. Run migrations with `pnpm db:generate && pnpm db:migrate`.
5. Start API, MCP and worker with `pnpm dev`.

## V1 acceptance target

The MCP should answer, from the normalized database:

- who needs human contact from the last N days;
- who received outreach but never responded;
- who booked in the last N days, based on booking creation time;
- what each booked customer wants;
- call transcripts and job briefs.

The voice walkthrough writes a draft structured scope first. A human must approve before GHL write-back is enabled.
