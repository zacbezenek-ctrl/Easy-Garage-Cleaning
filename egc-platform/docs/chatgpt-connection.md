# Connect EGC MCP to ChatGPT

The EGC MCP uses Streamable HTTP at:

`https://<mcp-host>/mcp`

It exposes customer-specific data, so the ChatGPT connection uses OAuth 2.1 with PKCE rather than a custom static API-key header.

## Server discovery endpoints

The deployed MCP exposes:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/oauth/authorize`
- `/oauth/token`
- `/mcp`
- `/health`

The OAuth scope is:

`egc:read`

All MCP tools are read-only.

## Authentication behavior

ChatGPT can initialize the MCP and discover its tools before account linking.

When ChatGPT invokes a protected EGC tool without a valid token, the server returns an MCP tool error with:

`_meta["mcp/www_authenticate"]`

That challenge points ChatGPT to the protected-resource metadata and triggers account linking.

The authorization server:

- accepts the stable ChatGPT CIMD client identifier;
- uses authorization code + PKCE S256;
- binds tokens to the exact `MCP_PUBLIC_ORIGIN` resource;
- issues one-hour access tokens;
- issues rotating refresh tokens;
- stores only SHA-256 token/code hashes in Postgres.

## ChatGPT setup

After the Railway MCP domain is live:

1. Open ChatGPT Settings.
2. Enable Developer mode under Security & login if it is not already enabled.
3. Open Plugins and add a custom MCP/server in developer mode.
4. Enter the exact server URL:
   `https://<mcp-host>/mcp`
5. ChatGPT should discover the EGC tools.
6. Invoke an EGC tool. ChatGPT should show the account-link flow.
7. Sign in with `MCP_OAUTH_USER` and `MCP_OAUTH_PASSWORD`.
8. Complete authorization and return to ChatGPT.
9. Re-run the tool.

## Acceptance prompt

Use:

> How many leads still need to be contacted from the last 3 days? Give me everyone who hasn't responded. Read their call transcripts. Tell me everyone who booked in the last 3 days and exactly what each job is.

Expected behavior:

- automated GHL messages do not count as human outreach;
- a customer counts as responding to the current follow-up only if the response happened after the latest human outreach;
- recent bookings filter on appointment creation time, not scheduled appointment time;
- booking results include job scope, opportunity context, recent messages, and stored call transcripts;
- when GHL did not provide a trustworthy booking creation timestamp, the record is not silently backfilled with appointment start time.

## Additional useful prompts

- "What jobs do we have tomorrow and what does each crew need to know?"
- "Show me unanswered inbound calls from the last 7 days."
- "Which open opportunities have gone stale for more than 7 days?"
- "Summarize the current pipeline."
- "Give me the last 30 days of lead conversion state."
- "Show the current job counts by status."
- "Pull the customer history for this lead."
