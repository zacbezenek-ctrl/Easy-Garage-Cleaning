# Connect EGC MCP to ChatGPT

The EGC MCP uses Streamable HTTP at:

`https://<mcp-host>/mcp`

It exposes customer-specific data and bounded operational writes, so the connection uses OAuth 2.1 with PKCE.

## OAuth scopes

- `egc:read` — reads, analytics, transcripts, customer/job history and live GHL reference data.
- `egc:write` — contact/tag/assignment, opportunity, appointment, customer-state reconciliation and user-confirmed outcomes, message delivery-status reconciliation and Meta conversion sync in both modes; in Action Center mode also internal actions, daily-brief snapshots, exact Hub notes, visit schedules, job operational scope and dispatched/in-progress/completed status, project links and recording processing retries; in legacy mode also job/note, task and walkthrough mutations.

What `egc:write` can do depends on the server mode, and the consent page and `/mcp-info` describe the live mode:

- No payment, charge or refund tool is provided.
- Legacy mode (`EGC_OPERATIONS_ENABLED=false`): write access can send customer SMS/email through `conversations.send_message`, `send_sms` and `egc.send_followup` (verified recipient, do-not-contact checks, durable execution ledger), and can delete provider appointments.
- Action Center mode (`EGC_OPERATIONS_ENABLED=true`): those one-step sends are paused and refused with `direct_send_disabled_in_operations_mode` unless the operator sets `EGC_MCP_DIRECT_SENDS_ENABLED=true`. Queue the exact draft with `actions.propose` (kind `followup_message`) for owner/manager approval in the Employee Hub; approval does not send. Sending an approved draft needs the Hub one-tap send (Phase 3) or MCP two-step confirmation (Phase 6), and neither is enabled yet, so until then an approved `followup_message` action has no send or completion path and can only be cancelled. Legacy job, task and walkthrough-draft writes and appointment deletion are disabled.
- Appointment tools trigger GHL's own customer notifications only when `runAutomations` is explicitly `true` (default `false`).
- `egc.safety_policy` (read) reports the live mode, send policy and the class of every registry tool.

## Server discovery endpoints

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `/oauth/authorize`
- `/oauth/token`
- `/mcp`
- `/mcp-info` — plain-text description of the live access policy
- `/health`

## Authentication behavior

ChatGPT can initialize the MCP and discover tools before account linking. Protected tool invocation returns an MCP `mcp/www_authenticate` challenge when the required scope is missing.

The authorization server uses authorization code + PKCE S256, resource-bound tokens, one-hour access tokens, rotating refresh tokens, and SHA-256 token/code hashes in Postgres.

The optional static `MCP_BEARER_TOKEN` (internal diagnostics only) is read-only. It is accepted for `egc:write` tools only while `MCP_BEARER_WRITE_ENABLED=true`, which startup verifications that write (`EGC_OPERATIONS_CANARY_ON_START`, the dry-run sync in `META_CAPI_VERIFY_ON_START`, and `META_CAPI_TEST_ON_START`) need for the duration of that check. Without it the canary fails with `verification_bearer_write_disabled` and the Meta verification skips its write-scoped checks and logs `bearer_write_disabled`.

Audit rows record the verified principal: `mcp-oauth-grant:<grant id>` for an OAuth connection or `mcp-service-grant` for the static bearer.

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
- writes require `egc:write`; the static bearer is read-only unless explicitly enabled;
- contact creation uses GHL upsert;
- duplicate exact appointment creates are blocked;
- all writes create EGC audit-log entries attributed to the verified principal;
- one-step customer messaging is blocked in Action Center mode unless explicitly enabled; appointment deletion is legacy-mode only;
- payments and refunds are not MCP tools.
