import express, { type Express } from "express";
import { allowedRedirectUris } from "./clients.js";
import { guarded, oauthError, randomToken, SCOPES_SUPPORTED, type OAuthContext } from "./common.js";
import { beginAttempt, discardAttempt, registrationRules } from "./rate-limit.js";

const MAX_BODY_BYTES = 16 * 1024;
// RFC 7591 is off unless the operator enables it, so today's metadata is unchanged by default.
export const registrationEnabled = () => process.env.MCP_OAUTH_DCR_ENABLED === "true";

type Metadata = { clientName: string; redirectUris: string[] };
type Refusal = { error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };
const refuse = (error: Refusal["error"], description: string): Refusal => ({ error, description });
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * Code + refresh grants and redirect URIs on the live allowlist. Every client is registered as a
 * public PKCE client: a requested token_endpoint_auth_method is not refused but answered with
 * "none" (RFC 7591 section 3.2.1 lets the server register different metadata).
 */
export function clientMetadata(body: unknown): Metadata | Refusal {
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse("invalid_client_metadata", "Client metadata must be a JSON object.");
  const input = body as Record<string, unknown>;
  const uris = input.redirect_uris;
  if (!stringArray(uris) || uris.length < 1 || uris.length > 5 || new Set(uris).size !== uris.length) return refuse("invalid_redirect_uri", "Provide one to five distinct redirect URIs.");
  const allowed = allowedRedirectUris();
  if (!uris.every((uri) => allowed.has(uri))) return refuse("invalid_redirect_uri", "A redirect URI is not on this server's allowlist.");
  const grants = input.grant_types;
  if (grants !== undefined && (!stringArray(grants) || !grants.includes("authorization_code") || grants.some((grant) => grant !== "authorization_code" && grant !== "refresh_token"))) return refuse("invalid_client_metadata", "Supported grant types are authorization_code and refresh_token.");
  const responses = input.response_types;
  if (responses !== undefined && (!stringArray(responses) || responses.some((type) => type !== "code"))) return refuse("invalid_client_metadata", "Only the code response type is supported.");
  if (input.client_name !== undefined && typeof input.client_name !== "string") return refuse("invalid_client_metadata", "client_name must be text.");
  const name = (input.client_name ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return { clientName: name || "MCP client", redirectUris: uris };
}

export function registerClientRegistration(app: Express, ctx: OAuthContext) {
  app.post("/oauth/register", express.json({ limit: "16kb" }), guarded(async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!registrationEnabled()) {
      oauthError(res, 404, "invalid_request", "Dynamic client registration is not enabled on this server.");
      return;
    }
    if (!req.is("application/json")) {
      oauthError(res, 400, "invalid_client_metadata", "Send client metadata as application/json.");
      return;
    }
    if (Number(req.header("content-length") ?? 0) > MAX_BODY_BYTES || Buffer.byteLength(JSON.stringify(req.body ?? null)) > MAX_BODY_BYTES) {
      oauthError(res, 413, "invalid_client_metadata", "Client metadata is too large.");
      return;
    }
    const metadata = clientMetadata(req.body);
    if ("error" in metadata) {
      oauthError(res, 400, metadata.error, metadata.description);
      return;
    }
    // Public clients with the same name and allowlisted redirects are interchangeable, so a repeat
    // registration gets the existing client and never counts against (or is blocked by) the limit.
    let client = await ctx.store.clientByMetadata(metadata.clientName, metadata.redirectUris);
    const now = ctx.now();
    if (!client) {
      const limit = await beginAttempt(ctx.store, registrationRules(), now);
      if (!limit.allowed) {
        await discardAttempt(ctx.store, limit.ids);
        res.set("Retry-After", String(limit.retryAfterSeconds));
        oauthError(res, 429, "temporarily_unavailable", "Too many client registrations. Try again later.");
        return;
      }
      client = { clientId: `egc_client_${randomToken(24)}`, clientName: metadata.clientName, redirectUris: metadata.redirectUris, createdAt: now };
      await ctx.store.insertClient(client);
    }
    res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.valueOf() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES_SUPPORTED.join(" ")
    });
  }));
}
