import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { ServiceKeyResolver } from "@egc/operations";
import type { OAuthStore } from "./store.js";

export type OAuthContext = { origin: string; store: OAuthStore; now: () => Date; resolveHubKey?: ServiceKeyResolver | undefined };

export const READ_SCOPE = "egc:read";
export const WRITE_SCOPE = "egc:write";
export const SCOPES_SUPPORTED = [READ_SCOPE, WRITE_SCOPE, "offline_access"];
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
export const AUTH_CODE_TTL_MS = 5 * 60_000;
// MCP endpoints a client may name as its RFC 8707 resource. Tokens are always bound to the origin.
export const MCP_PATHS = ["/mcp", "/mcp/oauth"] as const;

export function publicOrigin() {
  const configured = process.env.MCP_PUBLIC_ORIGIN?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MCP_PUBLIC_ORIGIN is required in production");
    }
    return "http://localhost:4200";
  }

  const url = new URL(configured);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("MCP_PUBLIC_ORIGIN must use https in production");
  }
  return url.origin;
}

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function secureEqual(actual: string, expected: string) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requestedScopes(value: unknown) {
  const scopes = String(value ?? READ_SCOPE)
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  if (scopes.includes(WRITE_SCOPE) && !scopes.includes(READ_SCOPE)) scopes.push(READ_SCOPE);
  if (!scopes.includes(READ_SCOPE)) scopes.push(READ_SCOPE);
  return [...new Set(scopes.filter((scope) => SCOPES_SUPPORTED.includes(scope)))];
}

/** An omitted resource means this server; any other value must name this origin or one of its MCP endpoints. */
export function canonicalResource(value: unknown, origin: string) {
  if (value === undefined || value === null || value === "") return origin;
  if (typeof value !== "string") return null;
  return value === origin || MCP_PATHS.some((path) => value === origin + path) ? origin : null;
}

export const text = (value: unknown) => typeof value === "string" ? value : "";

export function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status)
    .set("Cache-Control", "no-store")
    .json({ error, error_description: description });
}

export function htmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export const PAGE_STYLE = `body{font-family:Inter,system-ui,sans-serif;background:#f5f5f3;color:#151515;margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box}
main{width:min(440px,100%);box-sizing:border-box;background:#fff;border:1px solid #deded8;border-radius:20px;padding:24px;box-shadow:0 18px 60px rgba(0,0,0,.08);overflow-wrap:anywhere}
h1{margin:0 0 8px;font-size:26px;letter-spacing:-.04em}p{color:#666;line-height:1.5}.error{color:#b42318;background:#fef3f2;padding:10px;border-radius:10px}
label{display:block;font-size:13px;font-weight:700;margin:16px 0 6px}input[type=text],input[type=password]{width:100%;box-sizing:border-box;min-height:44px;padding:12px;border:1px solid #cfcfc8;border-radius:10px;font:inherit;font-size:16px}
button{width:100%;min-height:48px;margin-top:20px;padding:13px;border:0;border-radius:11px;background:#111;color:#fff;font:inherit;font-weight:800;cursor:pointer}
button.secondary{background:#fff;color:#111;border:1px solid #cfcfc8}.or{text-align:center;margin:20px 0 0;font-size:13px}
small{display:block;color:#777;margin-top:14px}`;

/** A plain status page for the browser leg of the flow. Every value is escaped. */
export function messagePage(title: string, message: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${htmlEscape(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>${htmlEscape(title)}</h1>
<p class="error" role="alert">${htmlEscape(message)}</p>
</main>
</body>
</html>`;
}

/** Browser pages of the flow are never cached, framed or sent as a referrer. Forms post to 'self' and then redirect to the client or the Hub, so form-action is left open. */
export function sendHtml(res: Response, status: number, body: string) {
  res.status(status)
    .set("Cache-Control", "no-store")
    .set("Referrer-Policy", "no-referrer")
    .set("X-Frame-Options", "DENY")
    .set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
    .type("html")
    .send(body);
}

/** Storage and verifier failures never reach the client as exception text. */
export function guarded(handler: (req: Request, res: Response) => Promise<void>, browser = false): RequestHandler {
  return async (req, res) => {
    try { await handler(req, res); }
    catch {
      if (res.headersSent) return;
      if (browser) sendHtml(res, 503, messagePage("Connection unavailable", "EGC could not complete this step right now. Nothing was connected. Start again from your AI assistant in a few minutes."));
      else oauthError(res, 503, "temporarily_unavailable", "The authorization server is temporarily unavailable. Try again.");
    }
  };
}
