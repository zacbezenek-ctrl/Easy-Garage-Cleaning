# Connect EGC MCP to Claude

Claude connects as a **custom connector** over Streamable HTTP. Use the OAuth-required endpoint:

`https://<mcp-host>/mcp/oauth`

`/mcp/oauth` serves the same tools as `/mcp` but follows the MCP authorization spec: every request needs a bearer token, and a missing or insufficient one gets an HTTP `401`/`403` with a `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp/oauth"` challenge. That 401 is what makes Claude start the sign-in. (`/mcp` keeps unauthenticated tool discovery for ChatGPT, which Claude would treat as a server with no sign-in.)

Claude identifies itself with its client ID metadata document: it sends `https://claude.ai/oauth/mcp-oauth-client-metadata` as the OAuth `client_id`, so no client ID or secret is entered anywhere and nothing is registered. The server advertises `client_id_metadata_document_supported: true`, and the MCP authorization spec (2025-11-25) has clients use a metadata document before dynamic registration whenever the server supports it. RFC 7591 dynamic client registration (`MCP_OAUTH_DCR_ENABLED=true`) is the fallback for clients that do not use one.

The server does not fetch metadata documents. It accepts exactly two, pinned from what each publishes: Claude's (name `Claude`, redirect URI `https://claude.ai/api/mcp/auth_callback` only, public client) and ChatGPT's (`https://chatgpt.com/oauth/client.json`). Any other URL used as a `client_id` is refused with "Unsupported OAuth client." If Claude or ChatGPT changes the redirect URIs in its published document, update `METADATA_DOCUMENT_CLIENTS` in `apps/mcp/src/oauth/clients.ts` to match.

## Server prerequisites (Railway `egc-mcp`)

| Variable | Value |
| --- | --- |
| `MCP_PUBLIC_ORIGIN` | `https://<mcp-host>` (already set for ChatGPT) |
| `MCP_ALLOWED_HOSTS` | `<mcp-host>` (already set) |
| `MCP_OAUTH_DCR_ENABLED` | Optional. `true` publishes `registration_endpoint` and accepts `/oauth/register` for clients that register dynamically (Claude and ChatGPT do not need it). Unset: no dynamic registration (today's metadata). |
| `MCP_OAUTH_HUB_IDENTITY_ENABLED` | `true` to sign in with the Employee Hub (recommended; see the rollout below). |
| `MCP_OAUTH_SHARED_LOGIN_ENABLED` | Leave unset while rolling out. `false` removes the shared connector password. |
| `MCP_OAUTH_EXTRA_REDIRECTS` | Optional. Space- or comma-separated exact redirect URIs for other OAuth clients (https, or http only on localhost/127.0.0.1). |

Dynamic registration accepts only these redirect URIs: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, `https://chatgpt.com/connector_platform_oauth_redirect`, plus `MCP_OAUTH_EXTRA_REDIRECTS`. A registered client keeps only the URIs that are still on that list, so removing an extra redirect also removes it from clients that registered with it. Every client is registered as a public client with PKCE S256: a request for `client_secret_basic` or `client_secret_post` is not refused, the response says `token_endpoint_auth_method: none` and no secret is issued (RFC 7591 section 3.2.1). A registration with the same client name and redirect URIs as an existing client returns that client.

## Add the connector in Claude

1. Open Claude (claude.ai or the Claude desktop app) as the person who will use EGC.
2. Go to **Settings > Connectors** and choose **Add custom connector**. (On a Team or Enterprise plan an owner adds it under **Admin settings > Connectors** first; members then connect it from **Settings > Connectors**.)
3. Name: `EGC Ops`. Remote MCP server URL: `https://<mcp-host>/mcp/oauth`.
4. Leave **Advanced settings** (OAuth Client ID and Client Secret) empty. Choose **Add**.
5. Choose **Connect**. Claude opens the EGC consent page, which shows `Claude (claude.ai)` and the live access statement.
6. Choose **Continue with Employee Hub**. On the Hub page, check the client name, the access and that the MCP host is yours, then choose **Approve connection**. If you are not signed in to the Employee Hub in that browser, sign in in the new tab it offers, come back, and approve again. Finish in the same browser you started in, with cookies allowed: an approval link opened anywhere else is approved in the Hub but connects nothing. (While the shared login is still enabled you may instead enter the shared connector username and password.)
7. Claude returns to the connector list as connected. In a chat, turn the connector on from the tools menu.

Only a signed-in Hub **owner or manager** can approve. The grant acts as `mcp:<hub user>:<grant id>` on behalf of that user and role, which audit rows record. Only owner and manager grants carry `egc:write`; owner-only tools require the owner's grant.

The client name on the Hub approval page comes from the approval link, so anyone can make a real `easygaragecleaning.com/api/mcp-grant` link that shows any text (up to 120 characters, escaped, no markup). The page therefore labels it "Name in this approval link (not verified by the Hub)" and never makes it the subject of a sentence. Approving such a link connects nothing, for the reasons below; what remains is that the page can display misleading text.

What the Hub page shows is what is granted. The Hub signs the client label and access (`egc:read`, or `egc:read egc:write`) its approval page displayed, and the MCP refuses the approval unless both match the request it stored, so editing the approval link cannot turn a write request into one that looks read-only or rename the client. The MCP also sets a per-request `__Host-egc_hub_grant_*` cookie (`HttpOnly`, `Secure`, `SameSite=None`, ten minutes) when **Continue with Employee Hub** is chosen on its own consent page, and `/oauth/hub-callback` refuses an approval that returns without it. The Hub approval page uses `Referrer-Policy: same-origin` so the browser sends its real `Origin` on the approval; every other page in the flow sends no referrer.

Claude Code and other local clients that use a random `http://localhost:<port>` callback cannot be allow-listed exactly and are not supported by this flow.

## Disconnecting and revoking

- A client that supports RFC 7009 revokes its grant through `POST /oauth/revoke` when you disconnect it; revoking either the access or the refresh token ends both.
- A Hub-approved grant can be refreshed for at most 30 days after approval (the refresh-token lifetime); after that the user approves again in the Hub. This bounds how long a demoted or removed manager keeps a connection they approved; to end it sooner, revoke it as below.
- Turning off the shared login (`MCP_OAUTH_SHARED_LOGIN_ENABLED=false`) stops every shared-password grant at once.
- To cut off one Hub user immediately without their client (for example after a role change or when someone leaves), an operator runs `update oauth_tokens set revoked_at = now() where principal_id = '<hub user>' and revoked_at is null;` against the MCP database. The Hub has no screen for this yet.

## Sign-in protection

- A shared-password username is locked while it has 5 failed attempts in the last 15 minutes. While locked even the right password is refused (HTTP 429 with `Retry-After: 900`). Attempts refused while locked are not counted, so the lock ends once the oldest of those failures is 15 minutes old, however often the locked login is tried.
- Past 30 failures across all usernames in 15 minutes, every failed attempt is answered with HTTP 429 whatever the username, but the right username and password still sign in. Someone who does not know the username cannot lock the shared login.
- Trade-off: someone who knows the shared username can keep it locked with about one wrong password every three minutes. The remedy is **Continue with Employee Hub**, which has no shared password to lock, and then `MCP_OAUTH_SHARED_LOGIN_ENABLED=false`; changing `MCP_OAUTH_USER` also ends the lock.
- **Continue with Employee Hub** stores a pending request before anyone signs in, so starts are capped at 300 per 15 minutes across the server. Past that, the consent page answers HTTP 429 with `Retry-After: 900` and stores nothing; refused starts are not counted, and requests already started can still be approved. The shared login and Hub approvals already in progress are not affected. Trade-off: a sustained flood of starts can delay new Hub sign-ins until the flood stops for 15 minutes; the shared login still works while it is enabled.
- Dynamic registration is limited to 20 new clients per hour. Refused registrations are not counted, and a registration with the same name and redirect URIs as an existing client returns that client without counting, so a flood of other registrations cannot stop Claude from reconnecting. It can delay a brand-new client name until the hour passes; turning `MCP_OAUTH_DCR_ENABLED` off and on does not clear the count.
- All three are stored in Postgres (`oauth_rate_limit_events`), so they hold across restarts and instances.

## Rollout order (Hub identity)

1. Deploy. The pre-deploy migrator applies `0014_oauth_clients` (new `oauth_clients`, `oauth_grant_requests` and `oauth_rate_limit_events` tables and nullable `principal_*` columns). Nothing changes yet: the shared login, existing ChatGPT grants and today's metadata keep working.
2. Cloudflare Pages (Hub): set `EGC_MCP_PUBLIC_ORIGIN=https://<mcp-host>` (bare origin). Deploy the Hub and the MCP from the same commit: the Hub's signed approval now carries the approved access and client label, and each side refuses the other's older format. Signed service keys must be active (`HUB_SESSION_SECRET` of 32+ characters, `EGC_OPERATIONS_SERVICE_AUTH` unset or `v2`, `EGC_OPERATIONS_ENABLED` not `false`) so `/api/operations-service-keys` publishes the Hub key the MCP verifies. Check that `https://easygaragecleaning.com/api/mcp-grant?grant=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` shows the approval page, not "Connections are off".
3. Railway (`egc-mcp`): set `MCP_OAUTH_HUB_IDENTITY_ENABLED=true`. The consent page now offers **Continue with Employee Hub** above the shared login. Claude and ChatGPT need no registration; set `MCP_OAUTH_DCR_ENABLED=true` only for another MCP client that registers dynamically.
4. Add Claude as above and reconnect ChatGPT with **Continue with Employee Hub**. Confirm new audit rows show `mcp:<hub user>:<grant id>`.
5. Set `MCP_OAUTH_SHARED_LOGIN_ENABLED=false`. The password form disappears and shared-login grants stop working.

Rollback: unset `MCP_OAUTH_SHARED_LOGIN_ENABLED` to restore the shared login (unexpired shared grants work again; they were refused, not deleted), or unset `MCP_OAUTH_HUB_IDENTITY_ENABLED` to stop new Hub approvals. Existing Hub grants keep working until revoked or 30 days old.

## Rotating the Hub key (`HUB_SESSION_SECRET`)

Each Hub-approved grant stores the Hub's signed approval, and the operations API re-verifies it against the Hub's current public key on every Employee Hub call. Rotating `HUB_SESSION_SECRET` (which also signs Hub sessions and service requests) therefore invalidates every Hub-approved connection at once: the MCP token still works for tools that do not call the Employee Hub, but every call that does is refused with `delegate_invalid`, and the tool result tells the user to disconnect, reconnect and approve again. To make that a clean cut-over instead of a partial outage:

1. Rotate the secret in Cloudflare Pages and redeploy the Hub.
2. Revoke every Hub-approved grant in the MCP database: `update oauth_tokens set revoked_at = now() where principal_id is not null and revoked_at is null;`. Clients then get a 401 and ask to reconnect.
3. Each user reconnects the connector and approves again in the Employee Hub.

Shared-login grants are not affected by a Hub key rotation.
