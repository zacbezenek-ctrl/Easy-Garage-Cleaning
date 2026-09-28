import { MCP_GRANT, MCP_GRANT_NONCE, MCP_GRANT_SCOPES, mcpGrantLabel, signServiceAssertion } from '../../egc-platform/services/operations/src/service-auth.ts';
import { auditWrite } from './hub-audit.js';
import { hasBusinessAccess, isHubOwner } from './hub-session.js';
import { operationsAuthMode, operationsEnabled } from './operations-service-auth.js';

// MCP-OAUTH: a signed-in Hub owner or manager approves one pending MCP OAuth
// authorization. The Hub claims the MCP's grant nonce create-only (so each request is
// approved at most once, by one user) in the same commit as its audit entry, then
// signs a 60-second assertion with the EXISTING Hub service key (service-auth v2,
// published at /api/operations-service-keys). No new key or secret is introduced.
// The assertion carries the access and client label the approval page showed; the MCP
// refuses it unless both match the request it stored.
export const MCP_GRANT_COLLECTION = 'mcp_grant_nonces';
export { MCP_GRANT, MCP_GRANT_NONCE, MCP_GRANT_SCOPES };
const USER = /^[a-z0-9][a-z0-9_.@-]{0,119}$/;
const APPROVERS = new Set(['owner', 'manager']);
const encoder = new TextEncoder();
const fail = (code, message, status) => Object.assign(new Error(message), { code, status });
const sha256Hex = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);

/** The MCP deployment grants are issued for (EGC_MCP_PUBLIC_ORIGIN), plus the signed-service prerequisites. */
export function mcpGrantConfiguration(env = {}) {
  const value = String(env.EGC_MCP_PUBLIC_ORIGIN || '').trim();
  let origin;
  try { origin = new URL(value); } catch { return { configured: false, reason: 'EGC_MCP_PUBLIC_ORIGIN is not set.' }; }
  if (origin.origin !== value || !(origin.protocol === 'https:' || origin.protocol === 'http:' && loopback(origin.hostname))) return { configured: false, reason: 'EGC_MCP_PUBLIC_ORIGIN must be the bare https origin of the MCP server.' };
  let signed = false;
  try { signed = operationsEnabled(env) && operationsAuthMode(env) === 'v2'; } catch { signed = false; }
  if (!signed) return { configured: false, reason: 'Signed service keys (EGC_OPERATIONS_SERVICE_AUTH v2) are not active.' };
  return { configured: true, origin: value, workspace: env.EGC_OPERATIONS_WORKSPACE || 'egc' };
}

/** The client label exactly as the approval page shows it and the assertion signs it (the MCP normalises its copy the same way). */
export const grantDisplayText = value => mcpGrantLabel(value);

export async function mcpGrantReceiptId(grantNonce) {
  return sha256Hex(`egc/mcp-grant/v1\n${grantNonce}`);
}

export async function issueMcpGrant(env, store, session, input = {}, now = new Date().toISOString()) {
  const config = mcpGrantConfiguration(env);
  if (!config.configured) throw fail('mcp_grant_not_configured', 'AI assistant connections are not set up on this Hub yet.', 503);
  if (!session) throw fail('mcp_grant_sign_in_required', 'Sign in to the Employee Hub in this browser, then approve again.', 401);
  const user = String(session.user || '').trim().toLowerCase();
  if (!hasBusinessAccess(session) || !APPROVERS.has(session.role) || !USER.test(user)) throw fail('mcp_grant_forbidden', 'Only Employee Hub owners and managers can connect an AI assistant.', 403);
  const grantNonce = input.grant;
  if (typeof grantNonce !== 'string' || !MCP_GRANT_NONCE.test(grantNonce)) throw fail('mcp_grant_invalid', 'This connection request is not valid. Start again from your AI assistant.', 400);
  const ms = Date.parse(now);
  if (!Number.isFinite(ms)) throw fail('mcp_grant_invalid', 'A valid server time is required to approve this connection.', 400);
  const scope = input.scope ?? MCP_GRANT_SCOPES[0], client = grantDisplayText(input.client);
  if (!MCP_GRANT_SCOPES.includes(scope)) throw fail('mcp_grant_invalid', 'This connection request is not valid. Start again from your AI assistant.', 400);
  const at = new Date(ms).toISOString(), expiresAt = new Date(ms + MCP_GRANT.ttlSeconds * 1000).toISOString();
  const id = await mcpGrantReceiptId(grantNonce);
  // The grant is the owner's only for the Hub owner account; another business user configured as owner delegates as a manager.
  const role = session.role === 'owner' && !isHubOwner(session) ? 'manager' : session.role;
  const actor = { id: user, kind: 'human', role: session.role };
  const audit = auditWrite({ actor, via: 'hub', action: 'mcp.grant.approve', entity: { collection: MCP_GRANT_COLLECTION, id }, after: { mcp: config.origin, role, scope, client: client || null }, now: at });
  try {
    await store.commit([{ collection: MCP_GRANT_COLLECTION, id, patch: { hubUser: user, role, mcp: config.origin, approvedAt: at, expiresAt } }, audit]);
  } catch (error) {
    if (error?.code === 'dispatch_revision_conflict') throw fail('mcp_grant_used', 'This connection request was already approved. Start again from your AI assistant.', 409);
    throw fail('mcp_grant_unavailable', 'The approval could not be saved. Nothing was connected. Start again from your AI assistant.', 503);
  }
  const assertion = await signServiceAssertion({
    service: 'hub', rootSecret: env.HUB_SESSION_SECRET, workspace: config.workspace, ...MCP_GRANT,
    claims: { hubUser: user, role, businessAccess: true, grantNonce, resource: config.origin, scope, client }, now: ms,
  });
  return { assertion, grant: grantNonce, callback: `${config.origin}/oauth/hub-callback`, hubUser: user, role, scope, client, expiresAt };
}
