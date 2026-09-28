import { createHash } from "node:crypto";
import type { Express } from "express";
import express from "express";
import type { ServiceKeyResolver } from "@egc/operations";
import { clientLabel, resolveClient, type OAuthClient } from "./oauth/clients.js";
import {
  ACCESS_TOKEN_TTL_MS, AUTH_CODE_TTL_MS, canonicalResource, guarded, hash, htmlEscape, MCP_PATHS, oauthError, PAGE_STYLE,
  publicOrigin, randomToken, READ_SCOPE, REFRESH_TOKEN_TTL_MS, requestedScopes, SCOPES_SUPPORTED, secureEqual, sendHtml, text, WRITE_SCOPE,
  type OAuthContext
} from "./oauth/common.js";
import { DELEGATE_USER, HUB_GRANT_MAX_AGE_MS, hubIdentityEnabled, registerHubCallback, sharedLoginEnabled, startHubGrant, WRITE_ROLES } from "./oauth/hub-identity.js";
import { attemptSucceeded, beginAttempt, discardAttempt, loginRules } from "./oauth/rate-limit.js";
import { registerClientRegistration, registrationEnabled } from "./oauth/register.js";
import { registerRevocation } from "./oauth/revoke.js";
import { postgresOAuthStore, type GrantPrincipal, type OAuthStore } from "./oauth/store.js";

export { READ_SCOPE, WRITE_SCOPE } from "./oauth/common.js";
export type { OAuthStore } from "./oauth/store.js";

export type AccessMode = { operations: boolean; directSends: boolean; moneyTools: boolean };
export type AccessStatement = { read: string; write: string; sends: string; approvals: string; payments: string };

// Approval of a queued draft does not send it, and no send path for approved drafts exists yet. Say exactly that.
export const DIRECT_SENDS_PAUSED = "One-step MCP customer sends are paused in Action Center mode. Queue the exact draft with actions.propose (kind followup_message) for owner or manager approval in the Employee Hub; approval does not send. Sending an approved draft needs the Employee Hub one-tap send or MCP two-step confirmation, and neither is enabled on this server yet. An operator can restore one-step sends with EGC_MCP_DIRECT_SENDS_ENABLED=true.";

// The consent page and /mcp-info must describe the live server policy, not an aspiration.
export function accessStatement(mode: AccessMode): AccessStatement {
  return {
    read: "Read access (egc:read) retrieves business records, including customer names, phone numbers, email addresses, messages, call transcripts, jobs, schedules and reports.",
    write: mode.operations
      ? "Write access (egc:write) can change internal actions and save daily-brief snapshots; change exact Employee Hub notes, visit schedules, job operational scope and dispatched, in-progress or completed status, and project links (with revision checks); change contacts, tags and opportunities; reconcile customer state and record user-confirmed outcomes; retry recording processing and reconcile message delivery status; create, update, cancel and reconcile provider appointments; and sync conversion events to Meta when the server allows it. Legacy job, task and walkthrough-draft writes and appointment deletion are disabled."
      : "Write access (egc:write) can create and change contacts, tags, opportunities, jobs, notes, internal tasks and walkthrough drafts; reconcile customer state and record user-confirmed outcomes; reconcile message delivery status; create, reschedule, cancel, reconcile or delete provider appointments; and sync conversion events to Meta when the server allows it. Employee Hub record, schedule, project, recording and action writes need Action Center mode and are not active.",
    sends: (mode.operations && !mode.directSends
      ? DIRECT_SENDS_PAUSED
      : "Write access can send SMS and email to customers when you ask it to; each send checks the verified recipient and do-not-contact settings and is recorded.")
      + " Appointment tools trigger the provider's own customer notifications only when runAutomations is explicitly set to true.",
    approvals: mode.operations
      ? "Action drafts and recording reviews require a signed-in Hub owner or manager; this connector cannot approve them."
      : "Managed Hub recordings require a signed-in owner or manager to approve; legacy walkthrough drafts can be approved here.",
    payments: mode.moneyTools
      ? "Tools that move money show a preview and require an explicit confirmation before anything is charged or refunded."
      : "No payment, charge or refund tool is provided."
  };
}

export const accessLines = (access: AccessStatement) => [access.read, access.write, access.sends, access.approvals, access.payments];

// The static service bearer is for internal diagnostics; it gains write scope only by explicit opt-in.
export const bearerWriteEnabled = () => process.env.MCP_BEARER_WRITE_ENABLED === "true";

export type OAuthDependencies = { store?: OAuthStore; now?: () => Date; resolveHubKey?: ServiceKeyResolver };
let productionStore: OAuthStore | undefined;
const defaultStore = () => productionStore ??= postgresOAuthStore();

const AUTHORIZE_FIELDS = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "resource", "scope", "state"] as const;
type AuthorizeRequest = { client: OAuthClient; redirectUri: string; codeChallenge: string; scopes: string[]; state: string | null };

async function validateAuthorizeParams(params: URLSearchParams, ctx: OAuthContext): Promise<AuthorizeRequest | { error: string }> {
  const client = await resolveClient(params.get("client_id") ?? "", ctx.store);
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const state = params.get("state");

  if (!client) return { error: "Unsupported OAuth client." };
  if (!client.redirectUris.includes(redirectUri)) return { error: "Invalid redirect URI." };
  if (params.get("response_type") !== "code") return { error: "Only authorization code flow is supported." };
  if (!codeChallenge || codeChallenge.length > 128) return { error: "PKCE code challenge is required." };
  if (params.get("code_challenge_method") !== "S256") return { error: "Only PKCE S256 is supported." };
  if (canonicalResource(params.get("resource"), ctx.origin) === null) return { error: "Invalid OAuth resource." };
  if (state && state.length > 2048) return { error: "The OAuth state is too long." };
  return { client, redirectUri, codeChallenge, scopes: requestedScopes(params.get("scope")), state: state || null };
}

function authorizationPage(params: URLSearchParams, access: AccessStatement, options: { request?: AuthorizeRequest; error?: string } = {}) {
  const hidden = AUTHORIZE_FIELDS.map((key) => {
    const value = params.get(key);
    return value === null
      ? ""
      : `<input type="hidden" name="${key}" value="${htmlEscape(value)}">`;
  }).join("");
  const request = options.request;
  const label = request ? clientLabel(request.client, request.redirectUri) : "This client";
  const hub = Boolean(request) && hubIdentityEnabled();
  const shared = Boolean(request) && sharedLoginEnabled();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect Easy Garage Cleaning</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>Connect EGC Ops</h1>
<p>${htmlEscape(label)} is asking to connect to EGC with the scope shown below. This describes what the server allows right now.</p>
${accessLines(access).map((line) => `<p>${htmlEscape(line)}</p>`).join("\n")}
${options.error ? `<p class="error" role="alert">${htmlEscape(options.error)}</p>` : ""}
${hub ? `<form method="post" action="/oauth/authorize">
${hidden}<input type="hidden" name="login" value="hub">
<button type="submit">Continue with Employee Hub</button>
</form>
<small>You approve as your Employee Hub user. Only owners and managers can connect, and only they can allow write access.</small>` : ""}
${hub && shared ? `<p class="or">or use the shared connector login</p>` : ""}
${shared ? `<form method="post" action="/oauth/authorize">
${hidden}
<label for="username">Username</label>
<input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit"${hub ? ` class="secondary"` : ""}>Authorize ${htmlEscape(request!.client.clientName)}</button>
</form>` : ""}
${request && !hub && !shared ? `<p class="error" role="alert">No sign-in method is enabled on this server.</p>` : ""}
<small>Scope: ${htmlEscape(params.get("scope") ?? READ_SCOPE)}</small>
</main>
</body>
</html>`;
}

function authorizeParams(source: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const key of AUTHORIZE_FIELDS) {
    const value = source[key];
    if (typeof value === "string") params.set(key, value);
  }
  return params;
}

async function issueTokens(ctx: OAuthContext, input: { clientId: string; resource: string; scopes: string[]; principal: GrantPrincipal }, now: Date) {
  const accessToken = `egc_at_${randomToken(32)}`;
  const refreshToken = `egc_rt_${randomToken(40)}`;
  await ctx.store.insertToken({
    accessTokenHash: hash(accessToken),
    refreshTokenHash: hash(refreshToken),
    clientId: input.clientId,
    resource: input.resource,
    scopes: input.scopes,
    accessExpiresAt: new Date(now.valueOf() + ACCESS_TOKEN_TTL_MS),
    refreshExpiresAt: new Date(now.valueOf() + REFRESH_TOKEN_TTL_MS),
    ...input.principal
  }, now);
  return tokenResponse(accessToken, refreshToken, input.scopes);
}

const tokenResponse = (accessToken: string, refreshToken: string, scopes: string[]) => ({
  access_token: accessToken,
  token_type: "Bearer",
  expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  refresh_token: refreshToken,
  scope: scopes.join(" ")
});

export function oauthSecurityMetadata(scopes: string[] = [READ_SCOPE]) {
  const schemes = [{ type: "oauth2" as const, scopes }];
  return {
    securitySchemes: schemes,
    _meta: { securitySchemes: schemes }
  };
}

export function registerOauthRoutes(app: Express, accessMode: () => AccessMode, deps: OAuthDependencies = {}) {
  const origin = publicOrigin();
  const ctx: OAuthContext = { origin, store: deps.store ?? defaultStore(), now: deps.now ?? (() => new Date()), resolveHubKey: deps.resolveHubKey };
  const access = () => accessStatement(accessMode());
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource`;
  const protectedResource = (resource: string) => ({
    resource,
    authorization_servers: [origin],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/mcp-info`
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300").json(protectedResource(origin));
  });
  // RFC 9728 path-suffixed metadata for clients that derive it from the MCP endpoint URL.
  for (const path of MCP_PATHS) {
    app.get(`/.well-known/oauth-protected-resource${path}`, (_req, res) => {
      res.set("Cache-Control", "public, max-age=300").json(protectedResource(origin + path));
    });
  }

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.set("Cache-Control", "public, max-age=300").json({
      issuer: origin,
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      revocation_endpoint_auth_methods_supported: ["none"],
      ...(registrationEnabled() ? { registration_endpoint: `${origin}/oauth/register` } : {}),
      client_id_metadata_document_supported: true,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: SCOPES_SUPPORTED
    });
  });

  app.get("/mcp-info", (_req, res) => {
    res.set("Cache-Control", "no-store").type("text/plain").send([
      "Easy Garage Cleaning MCP. Endpoints: /mcp (tools are discoverable before sign-in) and /mcp/oauth (every request needs a token, for clients such as Claude). OAuth scopes: egc:read (reads) and egc:write (bounded writes).",
      ...accessLines(access())
    ].join("\n"));
  });

  app.get("/oauth/authorize", guarded(async (req, res) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === "string") params.set(key, value);
    }

    const request = await validateAuthorizeParams(params, ctx);
    if ("error" in request) {
      sendHtml(res, 400, authorizationPage(params, access(), { error: request.error }));
      return;
    }

    sendHtml(res, 200, authorizationPage(params, access(), { request }));
  }, true));

  app.post(
    "/oauth/authorize",
    express.urlencoded({ extended: false, limit: "32kb" }),
    guarded(async (req, res) => {
      const params = authorizeParams(req.body ?? {});
      const request = await validateAuthorizeParams(params, ctx);
      if ("error" in request) {
        sendHtml(res, 400, authorizationPage(params, access(), { error: request.error }));
        return;
      }

      if (req.body?.login === "hub") {
        if (!hubIdentityEnabled()) {
          sendHtml(res, 400, authorizationPage(params, access(), { request, error: "Employee Hub sign-in is not enabled on this server." }));
          return;
        }
        // Only this consent page may start a Hub approval, so another site cannot plant the browser binding.
        const site = req.header("sec-fetch-site");
        if (site && site !== "same-origin") {
          sendHtml(res, 403, authorizationPage(params, access(), { request, error: "Start the connection from your AI assistant, then continue on this page." }));
          return;
        }
        const started = await startHubGrant(ctx, { clientId: request.client.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge, scopes: request.scopes, state: request.state, clientLabel: clientLabel(request.client, request.redirectUri) });
        if (!started.started) {
          res.set("Retry-After", String(started.retryAfterSeconds));
          sendHtml(res, 429, authorizationPage(params, access(), { request, error: "Too many Employee Hub connection requests right now. Wait 15 minutes and try again." }));
          return;
        }
        res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer").append("Set-Cookie", started.cookie).redirect(303, started.url);
        return;
      }

      if (!sharedLoginEnabled()) {
        sendHtml(res, 403, authorizationPage(params, access(), { request, error: "The shared connector login is turned off. Continue with Employee Hub instead." }));
        return;
      }

      const configuredUser = process.env.MCP_OAUTH_USER ?? "";
      const configuredPassword = process.env.MCP_OAUTH_PASSWORD ?? "";
      const username = text(req.body?.username);
      const password = text(req.body?.password);
      const now = ctx.now();
      // Every attempt is logged before the password is checked. A locked username is refused even
      // with the right password, and that refusal is not counted, so the lock ends once its oldest
      // failure leaves the window. The server-wide ceiling never refuses the right username and password.
      const rules = loginRules(username);
      const attempt = await beginAttempt(ctx.store, rules, now);
      const tooMany = () => {
        res.set("Retry-After", String(attempt.retryAfterSeconds));
        sendHtml(res, 429, authorizationPage(params, access(), { request, error: "Too many failed sign-in attempts. Wait 15 minutes and try again." }));
      };
      if (attempt.refused.includes(rules[0].bucket)) {
        await discardAttempt(ctx.store, attempt.ids);
        tooMany();
        return;
      }

      if (
        configuredUser.length < 1 ||
        configuredPassword.length < 20 ||
        !secureEqual(username, configuredUser) ||
        !secureEqual(password, configuredPassword)
      ) {
        if (!attempt.allowed) tooMany();
        else sendHtml(res, 401, authorizationPage(params, access(), { request, error: "Invalid EGC MCP credentials." }));
        return;
      }
      await attemptSucceeded(ctx.store, attempt.ids);

      const code = `egc_ac_${randomToken(32)}`;
      await ctx.store.insertCode({
        codeHash: hash(code),
        clientId: request.client.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: origin,
        scopes: request.scopes,
        expiresAt: new Date(now.valueOf() + AUTH_CODE_TTL_MS),
        principalId: null,
        principalRole: null,
        principalAssertion: null
      }, now);

      const redirect = new URL(request.redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("iss", origin);
      if (request.state) redirect.searchParams.set("state", request.state);

      res.set("Cache-Control", "no-store").redirect(302, redirect.toString());
    }, true)
  );

  app.post(
    "/oauth/token",
    express.urlencoded({ extended: false, limit: "32kb" }),
    guarded(async (req, res) => {
      res.set("Cache-Control", "no-store");
      const grantType = text(req.body?.grant_type);
      const clientId = text(req.body?.client_id);
      const client = await resolveClient(clientId, ctx.store);

      if (!client) {
        oauthError(res, 400, "invalid_client", "Unsupported OAuth client.");
        return;
      }
      const now = ctx.now();

      if (grantType === "authorization_code") {
        const code = text(req.body?.code);
        const redirectUri = text(req.body?.redirect_uri);
        const verifier = text(req.body?.code_verifier);
        const resource = canonicalResource(req.body?.resource, origin);

        if (!code || !client.redirectUris.includes(redirectUri) || !verifier || !resource) {
          oauthError(res, 400, "invalid_grant", "Authorization code request is invalid.");
          return;
        }

        const record = await ctx.store.code(hash(code));
        if (
          !record ||
          record.usedAt ||
          record.expiresAt.valueOf() <= now.valueOf() ||
          record.clientId !== clientId ||
          record.redirectUri !== redirectUri ||
          record.resource !== resource
        ) {
          oauthError(res, 400, "invalid_grant", "Authorization code is expired or invalid.");
          return;
        }

        const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
        if (!secureEqual(expectedChallenge, record.codeChallenge)) {
          oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
          return;
        }

        if (!await ctx.store.consumeCode(record.id, now)) {
          oauthError(res, 400, "invalid_grant", "Authorization code was already used.");
          return;
        }

        if (record.principalId === null && !sharedLoginEnabled()) {
          oauthError(res, 400, "invalid_grant", "The shared connector login is turned off.");
          return;
        }

        res.json(await issueTokens(ctx, {
          clientId,
          resource,
          scopes: record.scopes,
          principal: { principalId: record.principalId, principalRole: record.principalRole, principalAssertion: record.principalAssertion }
        }, now));
        return;
      }

      if (grantType === "refresh_token") {
        const refreshToken = text(req.body?.refresh_token);
        const resource = canonicalResource(req.body?.resource, origin);
        if (!refreshToken || !resource) {
          oauthError(res, 400, "invalid_grant", "Refresh token request is invalid.");
          return;
        }

        const record = await ctx.store.tokenByRefresh(hash(refreshToken));
        if (
          !record ||
          record.revokedAt ||
          record.refreshExpiresAt.valueOf() <= now.valueOf() ||
          record.clientId !== clientId ||
          record.resource !== resource ||
          // A shared-login grant ends when that login is turned off; a Hub grant must be re-approved periodically.
          (record.principalId === null ? !sharedLoginEnabled() : record.createdAt.valueOf() + HUB_GRANT_MAX_AGE_MS <= now.valueOf())
        ) {
          oauthError(res, 400, "invalid_grant", "Refresh token is expired or invalid.");
          return;
        }

        // Claim the presented refresh token atomically before issuing its
        // replacement. Concurrent reuse of the same refresh token must fail.
        const claimHash = hash(`claimed:${randomToken(24)}`);
        if (!await ctx.store.claimRefresh(record.id, hash(refreshToken), claimHash, now)) {
          oauthError(res, 400, "invalid_grant", "Refresh token was already used.");
          return;
        }

        const accessToken = `egc_at_${randomToken(32)}`;
        const nextRefreshToken = `egc_rt_${randomToken(40)}`;
        // A revocation that lands between the claim and this write wins: the grant stays revoked.
        if (!await ctx.store.rotateToken(record.id, claimHash, {
          accessTokenHash: hash(accessToken),
          refreshTokenHash: hash(nextRefreshToken),
          accessExpiresAt: new Date(now.valueOf() + ACCESS_TOKEN_TTL_MS),
          refreshExpiresAt: new Date(now.valueOf() + REFRESH_TOKEN_TTL_MS)
        }, now)) {
          oauthError(res, 400, "invalid_grant", "Refresh token is expired or invalid.");
          return;
        }

        res.json(tokenResponse(accessToken, nextRefreshToken, record.scopes));
        return;
      }

      oauthError(res, 400, "unsupported_grant_type", "Supported grants are authorization_code and refresh_token.");
    })
  );

  registerClientRegistration(app, ctx);
  registerRevocation(app, ctx);
  registerHubCallback(app, ctx);

  return {
    origin,
    resourceMetadataUrl,
    oauthEndpointResourceMetadataUrl: `${resourceMetadataUrl}/mcp/oauth`,
    scope: READ_SCOPE
  };
}

export function mcpAuthenticateChallenge(
  resourceMetadataUrl: string,
  requiredScope = READ_SCOPE,
  error = "invalid_token"
) {
  return `Bearer resource_metadata="${resourceMetadataUrl}", scope="${requiredScope}", error="${error}", error_description="Connect your Easy Garage Cleaning account to continue"`;
}

export type DelegateRole = "owner" | "manager" | "sales" | "crew_lead" | "crew";
export type VerifiedMcpPrincipal = { id: string; delegate?: { user: string; role: DelegateRole }; assertion?: string };
const DELEGATE_ROLES: ReadonlySet<string> = new Set(["owner", "manager", "sales", "crew_lead", "crew"]);

/**
 * Resolves a bearer token to its principal. A Hub-approved grant acts as
 * mcp:<hub user>:<grant id> on behalf of that user and role; a shared-login grant
 * keeps its mcp-oauth-grant:<grant id> identity while that login is enabled.
 */
export async function verifiedMcpPrincipal(
  authorization: string | undefined,
  requiredScope = READ_SCOPE,
  deps: Pick<OAuthDependencies, "store" | "now"> = {}
): Promise<VerifiedMcpPrincipal | null> {
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";

  const serviceToken = process.env.MCP_BEARER_TOKEN ?? "";
  if (
    token &&
    serviceToken.length >= 32 &&
    secureEqual(token, serviceToken)
  ) {
    return requiredScope === READ_SCOPE || bearerWriteEnabled() ? { id: "mcp-service-grant" } : null;
  }

  if (!token) return null;

  const record = await (deps.store ?? defaultStore()).tokenByAccess(hash(token));
  const now = (deps.now ?? (() => new Date()))();
  if (
    !record ||
    record.revokedAt ||
    record.accessExpiresAt.valueOf() <= now.valueOf() ||
    record.resource !== publicOrigin() ||
    !record.scopes.includes(requiredScope)
  ) return null;

  if (record.principalId === null) return sharedLoginEnabled() ? { id: `mcp-oauth-grant:${record.id}` } : null;
  const role = record.principalRole ?? "";
  if (!DELEGATE_USER.test(record.principalId) || !DELEGATE_ROLES.has(role) || !record.principalAssertion) return null;
  if (requiredScope === WRITE_SCOPE && !WRITE_ROLES.has(role)) return null;
  return { id: `mcp:${record.principalId}:${record.id}`, delegate: { user: record.principalId, role: role as DelegateRole }, assertion: record.principalAssertion };
}

export async function authenticatedMcpPrincipal(
  authorization: string | undefined,
  requiredScope = READ_SCOPE,
  deps: Pick<OAuthDependencies, "store" | "now"> = {}
) {
  return (await verifiedMcpPrincipal(authorization, requiredScope, deps))?.id ?? null;
}

export async function authorizeMcpRequest(authorization:string|undefined,requiredScope=READ_SCOPE) {
  return Boolean(await authenticatedMcpPrincipal(authorization,requiredScope));
}
