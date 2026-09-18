# Connect EGC MCP to ChatGPT

The EGC MCP uses Streamable HTTP at:

`https://<mcp-host>/mcp`

It exposes customer-specific data and bounded operational writes, so the connection uses OAuth 2.1 with PKCE.

## OAuth scopes

- `egc:read` — reads, analytics, transcripts, customer/job history and live GHL reference data.
- `egc:write` — contact/tag/assignment, opportunity, appointment, job/note, and walkthrough mutations.

The write scope does not grant payment, refund, deletion, or direct customer-message actions.

## Server discovery endpoints

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/oauth/authorize`
- `/oauth/token`
- `/mcp`
- `/health`

## Authentication behavior

ChatGPT can initialize the MCP and discover tools before account linking. Protected tool invocation returns an MCP `mcp/www_authenticate` challenge when the required scope is missing.

The authorization server uses authorization code + PKCE S256, resource-bound tokens, one-hour access tokens, rotating refresh tokens, and SHA-256 token/code hashes in Postgres.

## ChatGPT setup

1. Deploy the MCP to a stable public HTTPS origin.
2. Open ChatGPT Settings.
3. Enable Developer mode under Security & login if needed.
4. Add a custom MCP/server in Plugins developer mode.
5. Enter `https://<mcp-host>/mcp`.
6. Complete the account-link flow.
7. Authorize `egc:read` and `egc:write` for full EGC operations.

## Read acceptance prompt

> How many leads still need to be contacted from the last 3 days? Give me everyone who hasn't responded. Read their call transcripts. Tell me everyone who booked in the last 3 days and exactly what each job is.

## Write acceptance prompt

> Find a test contact, create an EGC job, create/link an open opportunity, book a test appointment with automations disabled, add an operations note, then update the job scope. Do not send customer messages.

Verify in both Postgres/portal and GHL before enabling production write use.

## Expected safeguards

- automation messages do not count as human outreach;
- appointment creation time is separate from scheduled time;
- writes require `egc:write`;
- contact creation uses GHL upsert;
- duplicate exact appointment creates are blocked;
- all writes create EGC audit-log entries;
- direct messaging, deletes, payments and refunds are not MCP tools.
