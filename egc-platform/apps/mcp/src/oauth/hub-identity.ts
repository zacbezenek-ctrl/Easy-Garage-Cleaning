import express, { type Express } from "express";
import { createServiceKeyResolver, MCP_GRANT_NONCE, mcpGrantLabel, SERVICE_ORIGINS, ServiceAuthenticationError, verifyMcpGrant, type McpGrantClaims, type ServiceKeyResolver } from "@egc/operations";
import { bindingCookie, bindingCookieName, readCookie } from "./binding.js";
import { AUTH_CODE_TTL_MS, guarded, hash, messagePage, randomToken, secureEqual, sendHtml, text, WRITE_SCOPE, type OAuthContext } from "./common.js";
import { beginAttempt, discardAttempt, hubStartRules } from "./rate-limit.js";

// The Employee Hub names the approving user. Off until the owner deploys the Hub side;
// the shared connector login stays available until MCP_OAUTH_SHARED_LOGIN_ENABLED=false.
export const hubIdentityEnabled = () => process.env.MCP_OAUTH_HUB_IDENTITY_ENABLED === "true";
export const sharedLoginEnabled = () => process.env.MCP_OAUTH_SHARED_LOGIN_ENABLED !== "false";
export const HUB_GRANT_PATH = "/api/mcp-grant";
export const GRANT_REQUEST_TTL_MS = 10 * 60_000;
// A Hub-approved grant is re-approved in the Hub at least this often (the refresh-token lifetime),
// so a role change or a rotated Hub key cannot ride a refresh chain for long.
export const HUB_GRANT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const DELEGATE_USER = /^[a-z0-9][a-z0-9_.@-]{0,119}$/;
export const WRITE_ROLES: ReadonlySet<string> = new Set(["owner", "manager"]);

let resolver: ServiceKeyResolver | undefined;
// Hub public keys come only from the pinned Hub origin (service-auth v2).
export const hubKeyResolver = () => resolver ??= createServiceKeyResolver();

export function verifyHubGrant(assertion: unknown, options: { resource: string; now: Date; resolveKey?: ServiceKeyResolver | undefined }) {
  return verifyMcpGrant(assertion, { resource: options.resource, now: options.now.valueOf(), resolveKey: options.resolveKey ?? hubKeyResolver() });
}

/** Only a business Hub user may connect, and only an owner or manager grant may carry egc:write. */
export function hubGrantScopes(requested: readonly string[], claims: McpGrantClaims): string[] | null {
  if (claims.businessAccess !== true || !DELEGATE_USER.test(claims.hubUser)) return null;
  return WRITE_ROLES.has(claims.role) ? [...requested] : requested.filter((scope) => scope !== WRITE_SCOPE);
}

export function hubGrantUrl(nonce: string, clientLabel: string, scopes: readonly string[]) {
  const url = new URL(HUB_GRANT_PATH, SERVICE_ORIGINS.hub);
  url.searchParams.set("grant", nonce);
  url.searchParams.set("client", clientLabel);
  url.searchParams.set("scope", scopes.join(" "));
  return url.toString();
}

export type HubGrantStart = { started: true; url: string; cookie: string } | { started: false; retryAfterSeconds: number };

/**
 * Starts a Hub approval for an already validated authorization request. The nonce is single use
 * and expires in ten minutes; the returned cookie binds it to this browser. Starts are capped
 * server-wide (hubStartRules); a refused start stores nothing and is not counted.
 */
export async function startHubGrant(ctx: OAuthContext, request: { clientId: string; redirectUri: string; codeChallenge: string; scopes: string[]; state: string | null; clientLabel: string }): Promise<HubGrantStart> {
  const now = ctx.now();
  const limit = await beginAttempt(ctx.store, hubStartRules(), now);
  if (!limit.allowed) {
    await discardAttempt(ctx.store, limit.ids);
    return { started: false, retryAfterSeconds: limit.retryAfterSeconds };
  }
  const nonce = randomToken(32), binding = randomToken(32), clientLabel = mcpGrantLabel(request.clientLabel);
  await ctx.store.insertGrantRequest({
    nonceHash: hash(nonce), clientId: request.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge,
    resource: ctx.origin, scopes: request.scopes, state: request.state, clientLabel, bindingHash: hash(binding),
    expiresAt: new Date(now.valueOf() + GRANT_REQUEST_TTL_MS)
  }, now);
  return { started: true, url: hubGrantUrl(nonce, clientLabel, request.scopes), cookie: bindingCookie(bindingCookieName(nonce), binding, GRANT_REQUEST_TTL_MS / 1000) };
}

const page = (res: express.Response, status: number, title: string, message: string) =>
  void sendHtml(res, status, messagePage(title, message));

/**
 * The Hub posts its signed grant here. The principal comes only from the verified
 * assertion, and the authorization request only from the nonce that assertion names,
 * so two concurrent approvals can never swap users. The request must come back to the
 * browser that started it, and the Hub must have shown the same client label and access.
 */
export function registerHubCallback(app: Express, ctx: OAuthContext) {
  app.post("/oauth/hub-callback", express.urlencoded({ extended: false, limit: "16kb" }), guarded(async (req, res) => {
    if (!hubIdentityEnabled()) return page(res, 404, "Hub sign-in is off", "Employee Hub sign-in is not enabled on this server.");
    const grant = text(req.body?.grant), assertion = text(req.body?.assertion);
    if (!MCP_GRANT_NONCE.test(grant) || !assertion) return page(res, 400, "Connection not approved", "This approval is incomplete. Start again from your AI assistant.");
    const cookieName = bindingCookieName(grant), binding = readCookie(req.headers.cookie, cookieName);
    res.append("Set-Cookie", bindingCookie(cookieName, "", 0));
    let claims: McpGrantClaims;
    try {
      claims = await verifyHubGrant(assertion, { resource: ctx.origin, now: ctx.now(), resolveKey: ctx.resolveHubKey });
    } catch (error) {
      if (error instanceof ServiceAuthenticationError && error.status >= 500) return page(res, 503, "Connection unavailable", "The Employee Hub could not be reached to verify this approval. Nothing was connected. Start again in a few minutes.");
      return page(res, 400, "Connection not approved", "This Employee Hub approval could not be verified or has expired. Nothing was connected. Start again from your AI assistant.");
    }
    if (claims.grantNonce !== grant) return page(res, 400, "Connection not approved", "This Employee Hub approval does not match the connection request. Nothing was connected.");
    const now = ctx.now();
    const request = await ctx.store.consumeGrantRequest(hash(claims.grantNonce), now);
    if (!request || request.resource !== ctx.origin) return page(res, 400, "Connection expired", "This connection request expired or was already used. Start again from your AI assistant.");
    if (!binding || !secureEqual(hash(binding), request.bindingHash)) return page(res, 403, "Connection not approved", "Finish this connection in the same browser where you started it from your AI assistant, with cookies allowed. Nothing was connected.");
    if (claims.client !== request.clientLabel || claims.scope.split(" ").includes(WRITE_SCOPE) !== request.scopes.includes(WRITE_SCOPE)) return page(res, 400, "Connection not approved", "The Employee Hub approval did not match this connection request. Nothing was connected. Start again from your AI assistant.");
    const scopes = hubGrantScopes(request.scopes, claims);
    if (!scopes) return page(res, 403, "Connection not allowed", "Only Employee Hub owners and managers can connect an AI assistant. Nothing was connected.");
    const code = `egc_ac_${randomToken(32)}`;
    await ctx.store.insertCode({
      codeHash: hash(code), clientId: request.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge,
      resource: request.resource, scopes, expiresAt: new Date(now.valueOf() + AUTH_CODE_TTL_MS),
      principalId: claims.hubUser, principalRole: claims.role, principalAssertion: assertion
    }, now);
    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("iss", ctx.origin);
    if (request.state) redirect.searchParams.set("state", request.state);
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer").redirect(303, redirect.toString());
  }, true));
}
