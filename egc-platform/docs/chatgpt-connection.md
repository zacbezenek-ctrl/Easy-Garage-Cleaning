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

- `/.well-known/oauth-protected-resource` (also `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource/mcp/oauth` for clients that derive it from the endpoint URL)
- `/.well-known/oauth-authorization-server` — advertises `revocation_endpoint`, and `registration_endpoint` when `MCP_OAUTH_DCR_ENABLED=true`
- `/oauth/authorize`
- `/oauth/token`
- `/oauth/revoke` — RFC 7009 token revocation
- `/oauth/register` — RFC 7591 dynamic client registration (only when `MCP_OAUTH_DCR_ENABLED=true`; see [claude-connection.md](claude-connection.md))
- `/oauth/hub-callback` — receives the Employee Hub's signed approval
- `/mcp` — tools are discoverable before account linking (ChatGPT)
- `/mcp/oauth` — every request needs a token (Claude and other spec-following clients)
- `/mcp-info` — plain-text description of the live access policy
- `/health`

## Authentication behavior

ChatGPT can initialize the MCP and discover tools before account linking. Protected tool invocation returns an MCP `mcp/www_authenticate` challenge when the required scope is missing.

The authorization server uses authorization code + PKCE S256, resource-bound tokens, one-hour access tokens, rotating refresh tokens, and SHA-256 token/code hashes in Postgres. The token format and hashing are unchanged, so existing ChatGPT grants keep working. ChatGPT is still identified by its client ID metadata document (`https://chatgpt.com/oauth/client.json`), and Claude by its own (`https://claude.ai/oauth/mcp-oauth-client-metadata`); both documents are pinned in the server, not fetched, and no other metadata-document URL is accepted. Dynamically registered clients must use an allowlisted redirect URI. The `resource` parameter may be omitted or name the origin or an MCP endpoint (`/mcp`, `/mcp/oauth`); tokens are always bound to the origin.

### Who a grant acts for

There are two ways to approve a connection on the consent page:

- **Continue with Employee Hub** (`MCP_OAUTH_HUB_IDENTITY_ENABLED=true`). The MCP stores the validated request under a single-use nonce and sends the browser to `https://easygaragecleaning.com/api/mcp-grant`. A signed-in Hub owner or manager approves it there; the Hub claims the nonce once in `mcp_grant_nonces` (server-only Firestore collection, audited in `hub_audit`) and returns a 60-second Ed25519 assertion `{hubUser, role, businessAccess, grantNonce, resource, scope, client}` with audience `egc-mcp`, signed with the existing Hub service key from `/api/operations-service-keys`. `scope` and `client` are the access and client label the Hub approval page showed. The MCP verifies the signature, audience, lifetime, its own origin and the nonce; checks that the approval came back to the browser that started it (a per-request `__Host-egc_hub_grant_*` cookie, `SameSite=None`, ten minutes) and that the signed label and access match the stored request; then stores `principal_id`/`principal_role` on the grant. Tools run as `mcp:<hub user>:<grant id>` with `delegate {user, role}`, and the operations envelope forwards the Hub assertion so the API re-verifies it and refuses writes from any delegate who is not an owner or manager. Only owner and manager grants get `egc:write`; owner-only tools require an owner delegate. A Hub grant must be re-approved 30 days after approval.
- **Shared connector login** (`MCP_OAUTH_USER`/`MCP_OAUTH_PASSWORD`), today's behavior, kept while `MCP_OAUTH_SHARED_LOGIN_ENABLED` is not `false`. Its grants act as `mcp-oauth-grant:<grant id>`. Setting the flag to `false` removes the password form and refuses every shared-login grant.

**Continue with Employee Hub** starts are capped at 300 per 15 minutes server-wide (HTTP 429 past that; refused starts store nothing). A shared-login username is locked while it has 5 failed attempts in the last 15 minutes, even for the right password; attempts refused while locked are not counted. Past 30 failures across all usernames, failures are answered with HTTP 429, but the right username and password still sign in (details in [claude-connection.md](claude-connection.md#sign-in-protection)). The rollout order is in [claude-connection.md](claude-connection.md#rollout-order-hub-identity).

The optional static `MCP_BEARER_TOKEN` (internal diagnostics only) is read-only. It is accepted for `egc:write` tools only while `MCP_BEARER_WRITE_ENABLED=true`, which startup verifications that write (`EGC_OPERATIONS_CANARY_ON_START`, the dry-run sync in `META_CAPI_VERIFY_ON_START`, and `META_CAPI_TEST_ON_START`) need for the duration of that check. Without it the canary fails with `verification_bearer_write_disabled` and the Meta verification skips its write-scoped checks and logs `bearer_write_disabled`.

Audit rows record the verified principal: `mcp:<hub user>:<grant id>` for a Hub-approved connection, `mcp-oauth-grant:<grant id>` for a shared-login connection, or `mcp-service-grant` for the static bearer.

## ChatGPT setup

1. Deploy the MCP to a stable public HTTPS origin.
2. Open ChatGPT Settings.
3. Enable Developer mode under Security & login if needed.
4. Add a custom MCP/server in Plugins developer mode.
5. Enter `https://<mcp-host>/mcp`.
6. Complete the account-link flow: choose **Continue with Employee Hub** and approve in the Hub (or, while it is enabled, use the shared connector login).
7. Authorize `egc:read` and `egc:write` for full EGC operations (write is granted only to owner and manager approvals).

## Read acceptance prompt

> How many leads still need to be contacted from the last 3 days? Give me everyone who hasn't responded. Read their call transcripts. Tell me everyone who booked in the last 3 days and exactly what each job is.

## Write acceptance prompt

> Find a test contact, create an EGC job, create/link an open opportunity, book a test appointment with automations disabled, add an operations note, then update the job scope. Do not send customer messages.

Verify in both Postgres/portal and GHL before enabling production write use.

## Expected safeguards

- automation messages do not count as human outreach;
- appointment creation time is separate from scheduled time;
- writes require `egc:write`, granted only to owner and manager Hub approvals (or the shared login); the static bearer is read-only unless explicitly enabled;
- contact creation uses GHL upsert;
- duplicate exact appointment creates are blocked;
- all writes create EGC audit-log entries attributed to the verified principal;
- one-step customer messaging is blocked in Action Center mode unless explicitly enabled; appointment deletion is legacy-mode only;
- payments and refunds are not MCP tools.
