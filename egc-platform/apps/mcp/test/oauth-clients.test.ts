import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READ_SCOPE, verifiedMcpPrincipal, WRITE_SCOPE } from "../src/oauth.js";
import { extraRedirectUris, METADATA_DOCUMENT_CLIENTS, REGISTERED_CLIENT_ID } from "../src/oauth/clients.js";
import { clientMetadata } from "../src/oauth/register.js";
import { beginAttempt, LOGIN_MAX_FAILURES_PER_ACCOUNT, LOGIN_MAX_FAILURES_TOTAL, loginRules, REGISTER_MAX } from "../src/oauth/rate-limit.js";
import { CHATGPT, CLAUDE_CIMD, CLAUDE_REDIRECT, codeFrom, NOW, ORIGIN, pkce, SHARED_PASSWORD, SHARED_USER, startOAuth } from "./oauth-harness.js";
import { memoryOAuthStore } from "./oauth-memory-store.js";

const env = { ...process.env };
let oauth: Awaited<ReturnType<typeof startOAuth>>;
beforeEach(async () => {
  for (const key of ["MCP_PUBLIC_ORIGIN", "MCP_BEARER_TOKEN", "MCP_OAUTH_EXTRA_REDIRECTS", "MCP_OAUTH_HUB_IDENTITY_ENABLED", "MCP_OAUTH_SHARED_LOGIN_ENABLED", "DATABASE_URL"]) delete process.env[key];
  Object.assign(process.env, { MCP_OAUTH_USER: SHARED_USER, MCP_OAUTH_PASSWORD: SHARED_PASSWORD, MCP_OAUTH_DCR_ENABLED: "true" });
  oauth = await startOAuth();
});
afterEach(async () => { await oauth.close(); process.env = { ...env }; });
const principal = (token: string, scope = READ_SCOPE) => verifiedMcpPrincipal(`Bearer ${token}`, scope, { store: oauth.store, now: () => oauth.clock.now });

describe("authorization server metadata", () => {
  it("advertises revocation always and dynamic registration only when enabled", async () => {
    const metadata = await oauth.json(await oauth.request("/.well-known/oauth-authorization-server"));
    expect(metadata.body).toMatchObject({ issuer: ORIGIN, registration_endpoint: `${ORIGIN}/oauth/register`, revocation_endpoint: `${ORIGIN}/oauth/revoke`, token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true });
    process.env.MCP_OAUTH_DCR_ENABLED = "false";
    const off = await oauth.json(await oauth.request("/.well-known/oauth-authorization-server"));
    expect(off.body).not.toHaveProperty("registration_endpoint");
    expect(off.body.revocation_endpoint).toBe(`${ORIGIN}/oauth/revoke`);
    expect((await oauth.register()).status).toBe(404);
  });
  it("publishes protected-resource metadata for the origin and each MCP endpoint", async () => {
    for (const [path, resource] of [["", ORIGIN], ["/mcp", `${ORIGIN}/mcp`], ["/mcp/oauth", `${ORIGIN}/mcp/oauth`]]) {
      const metadata = await oauth.json(await oauth.request(`/.well-known/oauth-protected-resource${path}`));
      expect(metadata.body).toMatchObject({ resource, authorization_servers: [ORIGIN], scopes_supported: [READ_SCOPE, WRITE_SCOPE, "offline_access"] });
    }
  });
});

describe("full PKCE flows", () => {
  it("ChatGPT (client ID metadata document) keeps working: code, refresh rotation, and single use", async () => {
    const { verifier, challenge } = pkce();
    const page = await oauth.request(`/oauth/authorize?${new URLSearchParams(oauth.authorizeFields(CHATGPT, challenge))}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Authorize ChatGPT");expect(html).toContain("ChatGPT (chatgpt.com)");expect(html).not.toContain("Continue with Employee Hub");
    const authorized = await oauth.authorizeWithPassword(CHATGPT, challenge);
    expect(authorized.status).toBe(302);
    const location = new URL(authorized.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(CHATGPT.redirectUri);
    expect(location.searchParams.get("iss")).toBe(ORIGIN);expect(location.searchParams.get("state")).toBe("synthetic-state");
    const code = codeFrom(authorized);
    const tokens = await oauth.exchange(CHATGPT, code, verifier);
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "egc:read egc:write" });
    expect(tokens.body.access_token).toMatch(/^egc_at_[A-Za-z0-9_-]{43}$/);expect(tokens.body.refresh_token).toMatch(/^egc_rt_[A-Za-z0-9_-]{54}$/);
    const [grant] = [...oauth.tokens.values()];
    expect(grant!.accessTokenHash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify([...oauth.tokens.values()])).not.toContain(tokens.body.access_token);
    expect(await principal(tokens.body.access_token, WRITE_SCOPE)).toEqual({ id: `mcp-oauth-grant:${grant!.id}` });
    // Code reuse fails, even with the right verifier.
    expect((await oauth.exchange(CHATGPT, code, verifier)).body.error).toBe("invalid_grant");
    const rotated = await oauth.refresh(CHATGPT.clientId, tokens.body.refresh_token);
    expect(rotated.status).toBe(200);expect(rotated.body.refresh_token).not.toBe(tokens.body.refresh_token);
    expect(await principal(tokens.body.access_token)).toBeNull();
    expect(await principal(rotated.body.access_token, WRITE_SCOPE)).toEqual({ id: `mcp-oauth-grant:${grant!.id}` });
    // Refresh reuse fails and does not disturb the rotated grant.
    expect((await oauth.refresh(CHATGPT.clientId, tokens.body.refresh_token)).body.error).toBe("invalid_grant");
    expect(await principal(rotated.body.access_token)).not.toBeNull();
    // Omitting resource means this server; resource may also name an MCP endpoint.
    expect((await oauth.refresh(CHATGPT.clientId, rotated.body.refresh_token, { resource: `${ORIGIN}/mcp` })).status).toBe(200);
  });
  it("Claude's client ID metadata document client completes the flow with no registration, even with DCR off", async () => {
    // The server advertises client_id_metadata_document_supported, so Claude sends its document URL
    // as client_id (MCP authorization 2025-11-25 prefers that over DCR) and never calls /oauth/register.
    process.env.MCP_OAUTH_DCR_ENABLED = "false";
    const metadata = await oauth.json(await oauth.request("/.well-known/oauth-authorization-server"));
    expect(metadata.body.client_id_metadata_document_supported).toBe(true);expect(metadata.body).not.toHaveProperty("registration_endpoint");
    expect(METADATA_DOCUMENT_CLIENTS.get(CLAUDE_CIMD.clientId)).toEqual({ clientId: CLAUDE_CIMD.clientId, clientName: "Claude", redirectUris: [CLAUDE_REDIRECT], registered: false });
    const { verifier, challenge } = pkce();
    const resource = { resource: `${ORIGIN}/mcp/oauth` };
    const page = await oauth.request(`/oauth/authorize?${new URLSearchParams(oauth.authorizeFields(CLAUDE_CIMD, challenge, resource))}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Claude (claude.ai) is asking to connect");expect(html).toContain("Authorize Claude");
    const authorized = await oauth.authorizeWithPassword(CLAUDE_CIMD, challenge, resource);
    expect(authorized.status).toBe(302);
    const location = new URL(authorized.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(CLAUDE_REDIRECT);
    expect(location.searchParams.get("iss")).toBe(ORIGIN);expect(location.searchParams.get("state")).toBe("synthetic-state");
    const code = codeFrom(authorized);
    const tokens = await oauth.exchange(CLAUDE_CIMD, code, verifier, resource);
    expect(tokens.status).toBe(200);expect(tokens.body).toMatchObject({ token_type: "Bearer", scope: "egc:read egc:write" });
    expect(oauth.clients.size).toBe(0);
    const grant = [...oauth.tokens.values()][0]!;
    expect(grant).toMatchObject({ clientId: CLAUDE_CIMD.clientId, resource: ORIGIN, principalId: null });
    expect(await principal(tokens.body.access_token, WRITE_SCOPE)).toEqual({ id: `mcp-oauth-grant:${grant.id}` });
    expect((await oauth.exchange(CLAUDE_CIMD, code, verifier, resource)).body.error).toBe("invalid_grant");
    // The grant belongs to Claude's document URL: another client cannot refresh or revoke it.
    expect((await oauth.refresh(CHATGPT.clientId, tokens.body.refresh_token)).body.error).toBe("invalid_grant");
    const rotated = await oauth.refresh(CLAUDE_CIMD.clientId, tokens.body.refresh_token, resource);
    expect(rotated.status).toBe(200);
    expect((await oauth.form("/oauth/revoke", { token: rotated.body.refresh_token, client_id: CHATGPT.clientId })).status).toBe(400);
    expect((await oauth.form("/oauth/revoke", { token: rotated.body.refresh_token, client_id: CLAUDE_CIMD.clientId })).status).toBe(200);
    expect(await principal(rotated.body.access_token)).toBeNull();
  });
  it("only Claude's exact document URL and the redirect it declares are accepted; other metadata URLs are never fetched", async () => {
    const realFetch = globalThis.fetch, outbound: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(oauth.base)) outbound.push(url);
      return realFetch(input, init);
    }) as typeof fetch;
    const { challenge } = pkce();
    try {
      for (const client of [
        { ...CLAUDE_CIMD, redirectUri: "https://claude.com/api/mcp/auth_callback" },
        { ...CLAUDE_CIMD, redirectUri: CHATGPT.redirectUri },
        { clientId: `${CLAUDE_CIMD.clientId}/`, redirectUri: CLAUDE_REDIRECT },
        { clientId: `${CLAUDE_CIMD.clientId}?x=1`, redirectUri: CLAUDE_REDIRECT },
        { clientId: "https://evil.example/oauth/mcp-oauth-client-metadata", redirectUri: CLAUDE_REDIRECT },
        { clientId: "http://claude.ai/oauth/mcp-oauth-client-metadata", redirectUri: CLAUDE_REDIRECT }
      ]) {
        expect((await oauth.request(`/oauth/authorize?${new URLSearchParams(oauth.authorizeFields(client, challenge))}`)).status, JSON.stringify(client)).toBe(400);
        const posted = await oauth.authorizeWithPassword(client, challenge);
        expect(posted.status, JSON.stringify(client)).toBe(400);expect(posted.headers.get("location")).toBeNull();
      }
    } finally { globalThis.fetch = realFetch; }
    expect(outbound).toEqual([]);expect(oauth.codes.size).toBe(0);
  });
  it("a Claude client registered with RFC 7591 completes the same flow against the /mcp/oauth resource", async () => {
    const registered = await oauth.register();
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", client_id_issued_at: NOW.valueOf() / 1000 });
    expect(registered.body.client_id).toMatch(REGISTERED_CLIENT_ID);
    const claude = { clientId: registered.body.client_id as string, redirectUri: CLAUDE_REDIRECT };
    const { verifier, challenge } = pkce();
    const page = await oauth.request(`/oauth/authorize?${new URLSearchParams(oauth.authorizeFields(claude, challenge, { resource: `${ORIGIN}/mcp/oauth` }))}`);
    expect(page.status).toBe(200);expect(await page.text()).toContain("Claude (claude.ai)");
    const authorized = await oauth.authorizeWithPassword(claude, challenge, { resource: `${ORIGIN}/mcp/oauth` });
    expect(authorized.status).toBe(302);expect(authorized.headers.get("location")).toMatch(/^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=egc_ac_/);
    const tokens = await oauth.exchange(claude, codeFrom(authorized), verifier, { resource: `${ORIGIN}/mcp/oauth` });
    expect(tokens.status).toBe(200);
    const grant = [...oauth.tokens.values()][0]!;
    expect(grant).toMatchObject({ clientId: claude.clientId, resource: ORIGIN, principalId: null });
    expect(await principal(tokens.body.access_token, WRITE_SCOPE)).toEqual({ id: `mcp-oauth-grant:${grant.id}` });
    // The token is not usable by another client.
    expect((await oauth.refresh(CHATGPT.clientId, tokens.body.refresh_token)).body.error).toBe("invalid_grant");
    expect((await oauth.refresh(claude.clientId, tokens.body.refresh_token)).status).toBe(200);
  });
});

describe("rejections", () => {
  it("registration accepts only allowlisted redirect URIs and registers every client as a public PKCE client", async () => {
    for (const [metadata, error] of [
      [{ redirect_uris: ["https://evil.example/callback"] }, "invalid_redirect_uri"],
      [{ redirect_uris: [`${CLAUDE_REDIRECT}?x=1`] }, "invalid_redirect_uri"],
      [{ redirect_uris: [] }, "invalid_redirect_uri"],
      [{ redirect_uris: [CLAUDE_REDIRECT, CLAUDE_REDIRECT] }, "invalid_redirect_uri"],
      [{ redirect_uris: [CLAUDE_REDIRECT], grant_types: ["client_credentials"] }, "invalid_client_metadata"],
      [{ redirect_uris: [CLAUDE_REDIRECT], response_types: ["token"] }, "invalid_client_metadata"],
      [{ redirect_uris: [CLAUDE_REDIRECT], client_name: 7 }, "invalid_client_metadata"]
    ] as const) {
      const response = await oauth.register(metadata as Record<string, unknown>);
      expect(response.status, JSON.stringify(metadata)).toBe(400);expect(response.body.error).toBe(error);
    }
    expect(oauth.clients.size).toBe(0);
    const text = await oauth.request("/oauth/register", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    expect(text.status).toBe(400);
    // RFC 7591 3.2.1: a client asking for a secret is registered as public and told so, not refused.
    for (const [name, method] of [["Synthetic Basic", "client_secret_basic"], ["Synthetic Post", "client_secret_post"], ["Synthetic Odd", 7]] as const) {
      const registered = await oauth.register({ client_name: name, redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: method });
      expect(registered.status).toBe(201);expect(registered.body.token_endpoint_auth_method).toBe("none");expect(registered.body).not.toHaveProperty("client_secret");
    }
    expect(oauth.clients.size).toBe(3);
    expect(clientMetadata({ redirect_uris: ["https://claude.com/api/mcp/auth_callback"], client_name: "  Claude‮\u0000 Desktop  " })).toEqual({ clientName: "Claude Desktop", redirectUris: ["https://claude.com/api/mcp/auth_callback"] });
  });
  it("extra redirects come only from MCP_OAUTH_EXTRA_REDIRECTS and must be exact https (or loopback http) URLs", async () => {
    expect(extraRedirectUris("https://inspector.example/callback, http://127.0.0.1:6274/oauth/callback http://evil.example/cb https://a.example/cb#frag https://user:pw@a.example/cb https://a.example not a url")).toEqual(["https://inspector.example/callback", "http://127.0.0.1:6274/oauth/callback"]);
    expect((await oauth.register({ redirect_uris: ["https://inspector.example/callback"] })).status).toBe(400);
    process.env.MCP_OAUTH_EXTRA_REDIRECTS = "https://inspector.example/callback";
    const registered = await oauth.register({ redirect_uris: ["https://inspector.example/callback"] });
    expect(registered.status).toBe(201);
    const client = { clientId: registered.body.client_id as string, redirectUri: "https://inspector.example/callback" };
    expect((await oauth.request(`/oauth/authorize?${new URLSearchParams(oauth.authorizeFields(client, pkce().challenge))}`)).status).toBe(200);
    // Removing the entry takes it away from the already registered client too.
    delete process.env.MCP_OAUTH_EXTRA_REDIRECTS;
    expect((await oauth.request(`/oauth/authorize?${new URLSearchParams(oauth.authorizeFields(client, pkce().challenge))}`)).status).toBe(400);
  });
  it("refuses unknown clients, unknown redirects, resource mismatch, PKCE mismatch and expired codes", async () => {
    const { verifier, challenge } = pkce();
    const registered = await oauth.register();
    const claude = { clientId: registered.body.client_id as string, redirectUri: CLAUDE_REDIRECT };
    for (const fields of [
      oauth.authorizeFields({ clientId: "egc_client_" + "a".repeat(32), redirectUri: CLAUDE_REDIRECT }, challenge),
      oauth.authorizeFields({ clientId: "https://evil.example/client.json", redirectUri: CLAUDE_REDIRECT }, challenge),
      oauth.authorizeFields({ ...claude, redirectUri: "https://claude.com/api/mcp/auth_callback" }, challenge),
      oauth.authorizeFields({ ...CHATGPT, redirectUri: CLAUDE_REDIRECT }, challenge),
      oauth.authorizeFields(claude, challenge, { resource: "https://other-resource.example" }),
      oauth.authorizeFields(claude, challenge, { resource: `${ORIGIN}/other` }),
      oauth.authorizeFields(claude, challenge, { code_challenge_method: "plain" })
    ]) {
      expect((await oauth.request(`/oauth/authorize?${new URLSearchParams(fields)}`)).status, JSON.stringify(fields)).toBe(400);
      const posted = await oauth.form("/oauth/authorize", { ...fields, username: SHARED_USER, password: SHARED_PASSWORD });
      expect(posted.status).toBe(400);expect(posted.headers.get("location")).toBeNull();
    }
    expect(oauth.codes.size).toBe(0);
    const code = codeFrom(await oauth.authorizeWithPassword(claude, challenge));
    expect((await oauth.exchange(claude, code, verifier, { resource: "https://other-resource.example" })).body.error).toBe("invalid_grant");
    expect((await oauth.exchange(claude, code, pkce().verifier)).body.error).toBe("invalid_grant");
    expect((await oauth.exchange({ ...claude, redirectUri: "https://claude.com/api/mcp/auth_callback" }, code, verifier)).body.error).toBe("invalid_grant");
    expect((await oauth.exchange(CHATGPT, code, verifier)).body.error).toBe("invalid_grant");
    expect((await oauth.exchange({ ...claude, clientId: "egc_client_" + "b".repeat(32) }, code, verifier)).body.error).toBe("invalid_client");
    oauth.advance(5 * 60_000);
    expect((await oauth.exchange(claude, code, verifier)).body.error).toBe("invalid_grant");
  });
  it("expired access and refresh tokens stop working at their injected expiry", async () => {
    const { verifier, challenge } = pkce();
    const tokens = await oauth.exchange(CHATGPT, codeFrom(await oauth.authorizeWithPassword(CHATGPT, challenge)), verifier);
    oauth.advance(60 * 60_000 - 1);
    expect(await principal(tokens.body.access_token)).not.toBeNull();
    oauth.advance(1);
    expect(await principal(tokens.body.access_token)).toBeNull();
    oauth.advance(30 * 24 * 60 * 60_000);
    expect((await oauth.refresh(CHATGPT.clientId, tokens.body.refresh_token)).body.error).toBe("invalid_grant");
  });
});

describe("RFC 7009 revocation", () => {
  async function connected() {
    const { verifier, challenge } = pkce();
    return (await oauth.exchange(CHATGPT, codeFrom(await oauth.authorizeWithPassword(CHATGPT, challenge)), verifier)).body;
  }
  it.each(["refresh_token", "access_token"] as const)("revoking the %s invalidates both access and refresh", async (kind) => {
    const tokens = await connected();
    const response = await oauth.form("/oauth/revoke", { token: tokens[kind], token_type_hint: kind, client_id: CHATGPT.clientId });
    expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await principal(tokens.access_token)).toBeNull();
    expect((await oauth.refresh(CHATGPT.clientId, tokens.refresh_token)).body.error).toBe("invalid_grant");
    expect([...oauth.tokens.values()][0]!.revokedAt).toEqual(NOW);
    // Repeating the revocation is harmless.
    expect((await oauth.form("/oauth/revoke", { token: tokens[kind] })).status).toBe(200);
  });
  it("unknown tokens succeed quietly; another client's token, or no token, is refused", async () => {
    const tokens = await connected();
    expect((await oauth.form("/oauth/revoke", { token: "egc_at_unknown" })).status).toBe(200);
    const wrong = await oauth.json(await oauth.form("/oauth/revoke", { token: tokens.access_token, client_id: "egc_client_" + "c".repeat(32) }));
    expect(wrong).toEqual({ status: 400, body: { error: "invalid_client", error_description: "The token was not issued to this client." } });
    expect(await principal(tokens.access_token)).not.toBeNull();
    expect((await oauth.form("/oauth/revoke", {})).status).toBe(400);
  });
  it("a revocation that lands between a refresh claim and its rotation wins", async () => {
    const tokens = await connected();
    const grant = [...oauth.tokens.values()][0]!;
    const { store } = oauth;
    expect(await store.claimRefresh(grant.id, grant.refreshTokenHash, "claim-marker", NOW)).toBe(true);
    await store.revokeToken(grant.id, NOW);
    expect(await store.rotateToken(grant.id, "claim-marker", { accessTokenHash: "a", refreshTokenHash: "b", accessExpiresAt: NOW, refreshExpiresAt: NOW }, NOW)).toBe(false);
    expect(oauth.tokens.get(grant.id)!.revokedAt).toEqual(NOW);
    expect(await principal(tokens.access_token)).toBeNull();
  });
});

describe("failed sign-in lockout", () => {
  it(`refuses every attempt after ${LOGIN_MAX_FAILURES_PER_ACCOUNT} failures inside the window, even the right password, until they age out`, async () => {
    const { challenge } = pkce();
    for (let attempt = 0; attempt < LOGIN_MAX_FAILURES_PER_ACCOUNT; attempt++) {
      expect((await oauth.authorizeWithPassword(CHATGPT, challenge, {}, "wrong-password-attempt")).status).toBe(401);
      oauth.advance(60_000);
    }
    const locked = await oauth.authorizeWithPassword(CHATGPT, challenge);
    expect(locked.status).toBe(429);expect(locked.headers.get("retry-after")).toBe("900");expect(locked.headers.get("location")).toBeNull();
    expect(await locked.text()).toContain("Too many failed sign-in attempts");
    expect(oauth.codes.size).toBe(0);
    // Another username has its own bucket.
    expect((await oauth.authorizeWithPassword(CHATGPT, challenge, {}, "wrong", "someone-else")).status).toBe(401);
    // Fifteen minutes after the refused attempt, every earlier attempt has left the window.
    oauth.advance(15 * 60_000);
    const allowed = await oauth.authorizeWithPassword(CHATGPT, challenge);
    expect(allowed.status).toBe(302);
    // The successful attempt is not kept as a failure.
    expect([...oauth.attempts.values()].filter((row) => row.occurredAt.valueOf() === oauth.clock.now.valueOf())).toEqual([]);
  });
  it("attempts refused while locked are not counted, so the lock ends once the first failure is 15 minutes old", async () => {
    const { challenge } = pkce();
    for (let attempt = 0; attempt < LOGIN_MAX_FAILURES_PER_ACCOUNT; attempt++) {
      expect((await oauth.authorizeWithPassword(CHATGPT, challenge, {}, "wrong-password-attempt")).status).toBe(401);
      oauth.advance(60_000);
    }
    const counted = oauth.attempts.size;
    // Hammering the locked door (even with the right password) adds nothing to the window.
    for (let minute = 0; minute < 10; minute++) {
      expect((await oauth.authorizeWithPassword(CHATGPT, challenge)).status).toBe(429);
      expect((await oauth.authorizeWithPassword(CHATGPT, challenge, {}, "wrong-password-attempt")).status).toBe(429);
      oauth.advance(60_000);
    }
    expect(oauth.attempts.size).toBe(counted);
    // 15 minutes after the first failure, it has aged out and the right password gets in.
    oauth.clock.now = new Date(NOW.valueOf() + 15 * 60_000 + 1);
    expect((await oauth.authorizeWithPassword(CHATGPT, challenge)).status).toBe(302);
  });
  it(`the ${LOGIN_MAX_FAILURES_TOTAL}-failure server-wide ceiling never refuses the right username and password, and does not reveal the username`, async () => {
    const { challenge } = pkce();
    for (let i = 0; i < LOGIN_MAX_FAILURES_TOTAL; i++) expect((await oauth.authorizeWithPassword(CHATGPT, challenge, {}, "wrong", `spray-${i}`)).status).toBe(401);
    // Past the ceiling every failure is answered the same way, whatever the username.
    const unknown = await oauth.authorizeWithPassword(CHATGPT, challenge, {}, "wrong", "spray-next");
    const known = await oauth.authorizeWithPassword(CHATGPT, challenge, {}, "wrong-password-attempt");
    expect([unknown.status, known.status]).toEqual([429, 429]);expect(unknown.headers.get("retry-after")).toBe("900");expect(known.headers.get("retry-after")).toBe("900");
    expect(await unknown.text()).toBe(await known.text());
    const allowed = await oauth.authorizeWithPassword(CHATGPT, challenge);
    expect(allowed.status).toBe(302);expect(allowed.headers.get("location")).toMatch(/^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect\?code=egc_ac_/);
    // The ceiling is still reported by the limiter itself, and usernames are stored only as digests.
    const memory = memoryOAuthStore();
    for (let i = 0; i < LOGIN_MAX_FAILURES_TOTAL; i++) expect((await beginAttempt(memory.store, loginRules(`spray-${i}`), NOW)).allowed).toBe(true);
    expect(await beginAttempt(memory.store, loginRules(SHARED_USER), NOW)).toMatchObject({ allowed: false, refused: ["login:all"], retryAfterSeconds: 900 });
    expect((await beginAttempt(memory.store, loginRules(SHARED_USER), new Date(NOW.valueOf() + 15 * 60_000))).allowed).toBe(true);
    expect(loginRules(SHARED_USER)[0].bucket).not.toContain(SHARED_USER);
  });
  it("limits new dynamic registrations per hour; refused ones are not counted and a repeat registration is never blocked", async () => {
    const first = await oauth.register();
    expect(first.status).toBe(201);
    for (let i = 1; i < REGISTER_MAX; i++) expect((await oauth.register({ client_name: `Synthetic flood ${i}`, redirect_uris: [CLAUDE_REDIRECT] })).status).toBe(201);
    oauth.advance(30 * 60_000);
    for (let i = 0; i < 5; i++) {
      const limited = await oauth.register({ client_name: `Synthetic flood extra ${i}`, redirect_uris: [CLAUDE_REDIRECT] });
      expect(limited.status).toBe(429);expect(limited.body.error).toBe("temporarily_unavailable");
    }
    expect(oauth.attempts.size).toBe(REGISTER_MAX);expect(oauth.clients.size).toBe(REGISTER_MAX);
    // Claude registering again with the same metadata gets the same public client, limit or not.
    const repeat = await oauth.register();
    expect(repeat.status).toBe(201);
    expect(repeat.body).toMatchObject({ client_id: first.body.client_id, client_id_issued_at: NOW.valueOf() / 1000, client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none" });
    // A different redirect list is a different client.
    expect((await oauth.register({ client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT, "https://claude.com/api/mcp/auth_callback"] })).status).toBe(429);
    // One hour after the first registrations, the refused attempts left nothing behind.
    oauth.advance(30 * 60_000);
    expect((await oauth.register({ client_name: "Synthetic after the hour", redirect_uris: [CLAUDE_REDIRECT] })).status).toBe(201);
  });
});

describe("shared login rollback flag", () => {
  it("MCP_OAUTH_SHARED_LOGIN_ENABLED=false removes the password form and retires shared-login grants", async () => {
    const { verifier, challenge } = pkce();
    const tokens = (await oauth.exchange(CHATGPT, codeFrom(await oauth.authorizeWithPassword(CHATGPT, challenge)), verifier)).body;
    process.env.MCP_OAUTH_SHARED_LOGIN_ENABLED = "false";
    const page = await (await oauth.request(`/oauth/authorize?${new URLSearchParams(oauth.authorizeFields(CHATGPT, challenge))}`)).text();
    expect(page).not.toContain('name="password"');expect(page).toContain("No sign-in method is enabled on this server.");
    expect((await oauth.authorizeWithPassword(CHATGPT, challenge)).status).toBe(403);
    expect(await principal(tokens.access_token)).toBeNull();
    expect((await oauth.refresh(CHATGPT.clientId, tokens.refresh_token)).body.error).toBe("invalid_grant");
    // Any value other than "false" keeps today's behaviour.
    process.env.MCP_OAUTH_SHARED_LOGIN_ENABLED = "no";
    expect(await principal(tokens.access_token)).not.toBeNull();
  });
});

describe("storage failures", () => {
  it("fail closed without leaking storage detail", async () => {
    const failing = await startOAuth();
    const broken = new Error("synthetic private SQL detail");
    for (const key of Object.keys(failing.store) as (keyof typeof failing.store)[]) (failing.store as any)[key] = async () => { throw broken; };
    try {
      const token = await failing.form("/oauth/token", { grant_type: "authorization_code", client_id: "egc_client_" + "d".repeat(32), code: "x", code_verifier: "y", redirect_uri: CLAUDE_REDIRECT });
      expect(token.status).toBe(503);expect(await token.text()).not.toContain("synthetic private");
      const login = await failing.authorizeWithPassword(CHATGPT, pkce().challenge);
      expect(login.status).toBe(503);expect(await login.text()).not.toContain("synthetic private");expect(login.headers.get("location")).toBeNull();
      expect(await verifiedMcpPrincipal("Bearer egc_at_x", READ_SCOPE, { store: failing.store }).catch(() => "threw")).toBe("threw");
    } finally { await failing.close(); }
  });
});
