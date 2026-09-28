import type { OAuthStore } from "./store.js";

export const CHATGPT_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
export const CHATGPT_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
// Claude's client ID metadata document (https://claude.ai/oauth/mcp-oauth-client-metadata) names
// itself as client_id, declares exactly this one redirect URI and token_endpoint_auth_method "none".
export const CLAUDE_CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
export const CLAUDE_CIMD_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
export const CLAUDE_REDIRECT_URIS: readonly string[] = Object.freeze([CLAUDE_CIMD_REDIRECT_URI, "https://claude.com/api/mcp/auth_callback"]);
export const REGISTERED_CLIENT_ID = /^egc_client_[A-Za-z0-9_-]{32}$/;

export type OAuthClient = { clientId: string; clientName: string; redirectUris: readonly string[]; registered: boolean };

const builtIn = (clientId: string, clientName: string, redirectUris: string[]): OAuthClient =>
  Object.freeze({ clientId, clientName, redirectUris: Object.freeze(redirectUris), registered: false });

/**
 * Clients that identify themselves with a client ID metadata document URL (CIMD). The server
 * advertises client_id_metadata_document_supported, so these clients send that URL as client_id
 * and never call /oauth/register. Their documents are pinned here rather than fetched: no other
 * CIMD URL is accepted, and each keeps only the redirect URIs its published document declares.
 */
export const METADATA_DOCUMENT_CLIENTS: ReadonlyMap<string, OAuthClient> = new Map([
  [CHATGPT_CLIENT_ID, builtIn(CHATGPT_CLIENT_ID, "ChatGPT", [CHATGPT_REDIRECT_URI])],
  [CLAUDE_CLIENT_ID, builtIn(CLAUDE_CLIENT_ID, "Claude", [CLAUDE_CIMD_REDIRECT_URI])]
]);

const loopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** Exact redirect URIs from MCP_OAUTH_EXTRA_REDIRECTS: https, or http only on loopback, with no credentials or fragment. Anything else is ignored. */
export function extraRedirectUris(value = process.env.MCP_OAUTH_EXTRA_REDIRECTS ?? "") {
  return value.split(/[\s,]+/).filter((entry) => {
    if (!entry) return false;
    try {
      const url = new URL(entry);
      return url.href === entry && !url.username && !url.password && !url.hash &&
        (url.protocol === "https:" || url.protocol === "http:" && loopback(url.hostname));
    } catch { return false; }
  });
}

/** The live allowlist. Registered clients keep only the URIs that are still on it. */
export function allowedRedirectUris(): ReadonlySet<string> {
  return new Set([...CLAUDE_REDIRECT_URIS, CHATGPT_REDIRECT_URI, ...extraRedirectUris()]);
}

export async function resolveClient(clientId: string, store: OAuthStore): Promise<OAuthClient | null> {
  const pinned = METADATA_DOCUMENT_CLIENTS.get(clientId);
  if (pinned) return pinned;
  if (!REGISTERED_CLIENT_ID.test(clientId)) return null;
  const row = await store.client(clientId);
  if (!row) return null;
  const allowed = allowedRedirectUris();
  return { clientId: row.clientId, clientName: row.clientName, redirectUris: row.redirectUris.filter((uri) => allowed.has(uri)), registered: true };
}

/** A self-declared client name is shown with the host that will receive the code, which the allowlist fixes. */
export function clientLabel(client: OAuthClient, redirectUri: string) {
  let host = "";
  try { host = new URL(redirectUri).host; } catch { /* validated before display */ }
  return host ? `${client.clientName} (${host})` : client.clientName;
}
