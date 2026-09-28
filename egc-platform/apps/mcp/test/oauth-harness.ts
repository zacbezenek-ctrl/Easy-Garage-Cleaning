import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { registerOauthRoutes, type AccessMode, type OAuthDependencies } from "../src/oauth.js";
import { memoryOAuthStore } from "./oauth-memory-store.js";

export const ORIGIN = "http://localhost:4200";
export const NOW = new Date("2026-09-22T12:00:00.000Z");
export const SHARED_USER = "synthetic-owner";
export const SHARED_PASSWORD = "synthetic-shared-connector-password-0123456789";
export const CHATGPT = { clientId: "https://chatgpt.com/oauth/client.json", redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect" };
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
// Claude's published client ID metadata document: client_id is the document URL itself.
export const CLAUDE_CIMD = { clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata", redirectUri: CLAUDE_REDIRECT };
const MODE: AccessMode = { operations: true, directSends: false, moneyTools: false };

export function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** A real HTTP server around registerOauthRoutes with an in-memory store and a movable clock. */
export async function startOAuth(deps: Omit<OAuthDependencies, "store" | "now"> = {}) {
  const memory = memoryOAuthStore();
  const clock = { now: new Date(NOW) };
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  registerOauthRoutes(app, () => MODE, { ...deps, store: memory.store, now: () => new Date(clock.now) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init });
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    request(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
  const json = async (response: Response) => ({ status: response.status, body: await response.json() as Record<string, any> });
  const advance = (ms: number) => { clock.now = new Date(clock.now.valueOf() + ms); };
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));

  async function register(metadata: Record<string, unknown> = { client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none" }) {
    return json(await request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata) }));
  }

  function authorizeFields(client: { clientId: string; redirectUri: string }, challenge: string, extra: Record<string, string> = {}) {
    return { client_id: client.clientId, redirect_uri: client.redirectUri, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: ORIGIN, scope: "egc:read egc:write", state: "synthetic-state", ...extra };
  }

  /** Shared-login authorization; returns the redirect Location. */
  async function authorizeWithPassword(client: { clientId: string; redirectUri: string }, challenge: string, extra: Record<string, string> = {}, password = SHARED_PASSWORD, username = SHARED_USER) {
    return form("/oauth/authorize", { ...authorizeFields(client, challenge, extra), username, password });
  }

  async function exchange(client: { clientId: string; redirectUri: string }, code: string, verifier: string, extra: Record<string, string> = {}) {
    return json(await form("/oauth/token", { grant_type: "authorization_code", client_id: client.clientId, redirect_uri: client.redirectUri, code, code_verifier: verifier, resource: ORIGIN, ...extra }));
  }

  async function refresh(clientId: string, refreshToken: string, extra: Record<string, string> = {}) {
    return json(await form("/oauth/token", { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource: ORIGIN, ...extra }));
  }

  return { ...memory, base, clock, advance, close, request, form, json, register, authorizeFields, authorizeWithPassword, exchange, refresh };
}

export const codeFrom = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("code")!;
