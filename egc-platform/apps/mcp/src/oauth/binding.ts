import { createHash } from "node:crypto";

// The browser that starts a Hub approval gets a cookie named for that request, and only that
// browser can finish it, so an approval link sent to someone else connects nothing. It must be
// SameSite=None: the Hub hands the browser back with a cross-site form POST. Dependency-free so
// the Hub's browser acceptance test sets exactly this cookie.
export const BINDING_COOKIE_PREFIX = "__Host-egc_hub_grant_";
export const bindingCookieName = (nonce: string) =>
  BINDING_COOKIE_PREFIX + createHash("sha256").update(`egc/hub-grant-binding\n${nonce}`).digest("hex").slice(0, 24);
export const bindingCookie = (name: string, value: string, maxAgeSeconds: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${maxAgeSeconds}`;

export function readCookie(header: string | undefined, name: string) {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}
