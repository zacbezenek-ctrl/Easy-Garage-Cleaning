import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";
import { MCP_GRANT, SERVICE_ORIGINS, ServiceAuthenticationError, servicePublicKeySet, signServiceAssertion, verifyRequest, type ServiceKeyResolver } from "@egc/operations";
import { READ_SCOPE, verifiedMcpPrincipal, WRITE_SCOPE } from "../src/oauth.js";
import { bindingCookieName } from "../src/oauth/binding.js";
import { HUB_GRANT_MAX_AGE_MS, hubGrantScopes } from "../src/oauth/hub-identity.js";
import { HUB_START_MAX, HUB_START_WINDOW_MS } from "../src/oauth/rate-limit.js";
import { bridgeActor, callOperations, DELEGATE_RECONNECT, operationsPrincipal, runAsPrincipal, type Principal } from "../src/operations.js";
import { defineTool, invokeTool, isOwnerGrant } from "../src/tools/define.js";
import { CHATGPT, CLAUDE_CIMD, CLAUDE_REDIRECT, codeFrom, NOW, ORIGIN, pkce, SHARED_PASSWORD, SHARED_USER, startOAuth } from "./oauth-harness.js";

const HUB_ROOT = "synthetic-hub-root-secret-for-mcp-grants-0123456789";
const hubKey = (await servicePublicKeySet({ service: "hub", rootSecret: HUB_ROOT, workspace: "egc" })).keys[0]!;
const resolveHubKey: ServiceKeyResolver = async (service, workspace, kid) => {
  if (service !== "hub" || workspace !== "egc" || kid !== hubKey.kid) throw Object.assign(new Error("unknown_service_key"), { code: "unknown_service_key", status: 401 });
  return hubKey;
};
type Claims = { hubUser: string; role: string; businessAccess: boolean; grantNonce: string; resource: string; scope: string; client: string };
// Verify an envelope at its own signing instant rather than against the wall clock.
const signedAt = (envelope: string) => JSON.parse(Buffer.from(envelope.split(".")[0]!, "base64url").toString()).iat * 1000;
// What functions/_lib/mcp-grant-assertion.js signs, with the same key derivation.
const hubAssertion = (claims: Claims, options: { now?: Date; rootSecret?: string; aud?: string } = {}) =>
  signServiceAssertion({ service: "hub", rootSecret: options.rootSecret ?? HUB_ROOT, workspace: "egc", typ: MCP_GRANT.typ, aud: options.aud ?? MCP_GRANT.aud, ttlSeconds: MCP_GRANT.ttlSeconds, claims, now: (options.now ?? NOW).valueOf() });

const env = { ...process.env };
let oauth: Awaited<ReturnType<typeof startOAuth>>;
beforeEach(async () => {
  for (const key of ["MCP_PUBLIC_ORIGIN", "MCP_BEARER_TOKEN", "MCP_OAUTH_EXTRA_REDIRECTS", "MCP_OAUTH_SHARED_LOGIN_ENABLED", "DATABASE_URL", "EGC_OPERATIONS_ENABLED"]) delete process.env[key];
  Object.assign(process.env, { MCP_OAUTH_USER: SHARED_USER, MCP_OAUTH_PASSWORD: SHARED_PASSWORD, MCP_OAUTH_DCR_ENABLED: "true", MCP_OAUTH_HUB_IDENTITY_ENABLED: "true" });
  oauth = await startOAuth({ resolveHubKey });
});
afterEach(async () => { await oauth.close(); process.env = { ...env }; vi.restoreAllMocks(); });
const principal = (token: string, scope = READ_SCOPE) => verifiedMcpPrincipal(`Bearer ${token}`, scope, { store: oauth.store, now: () => oauth.clock.now });

/** Starts a Hub approval for a client and returns the grant nonce the Hub would receive and the browser-binding cookie. */
async function startHub(client: { clientId: string; redirectUri: string } = CHATGPT, extra: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const started = await oauth.form("/oauth/authorize", { ...oauth.authorizeFields(client, challenge, extra), login: "hub" }, { "Sec-Fetch-Site": "same-origin" });
  expect(started.status).toBe(303);
  const location = new URL(started.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(`${SERVICE_ORIGINS.hub}/api/mcp-grant`);
  const cookie = started.headers.getSetCookie()[0]!.split(";")[0]!;
  return { grant: location.searchParams.get("grant")!, location, verifier, client, cookie, setCookie: started.headers.getSetCookie() };
}
/** What the Hub signs for an approval of this link as displayed. */
const shown = (started: { grant: string; location: URL }) => ({
  grantNonce: started.grant, resource: ORIGIN, client: started.location.searchParams.get("client")!,
  scope: started.location.searchParams.get("scope")!.split(" ").includes(WRITE_SCOPE) ? "egc:read egc:write" : "egc:read"
});
const callback = (grant: string, assertion: string, cookie = "") => oauth.form("/oauth/hub-callback", { grant, assertion }, { Origin: SERVICE_ORIGINS.hub, ...(cookie ? { Cookie: cookie } : {}) });
async function connect(claims: Pick<Claims, "hubUser" | "role" | "businessAccess">, client = CHATGPT, extra: Record<string, string> = {}) {
  const started = await startHub(client, extra);
  const approved = await callback(started.grant, await hubAssertion({ ...claims, ...shown(started) }), started.cookie);
  expect(approved.status).toBe(303);
  return oauth.exchange(client, codeFrom(approved), started.verifier, extra);
}

describe("Hub identity binding", () => {
  it("the consent page offers Employee Hub sign-in, and the Hub is told who is asking and for which scope", async () => {
    const { challenge } = pkce();
    const page = await (await oauth.request(`/oauth/authorize?${new URLSearchParams(oauth.authorizeFields(CHATGPT, challenge))}`)).text();
    expect(page).toContain("Continue with Employee Hub");expect(page).toContain('name="login" value="hub"');expect(page).toContain('name="password"');
    const { grant, location } = await startHub();
    expect(grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("client")).toBe("ChatGPT (chatgpt.com)");expect(location.searchParams.get("scope")).toBe("egc:read egc:write");
    const [request] = [...oauth.requests.values()];
    expect(request).toMatchObject({ clientId: CHATGPT.clientId, redirectUri: CHATGPT.redirectUri, state: "synthetic-state", clientLabel: "ChatGPT (chatgpt.com)", usedAt: null, expiresAt: new Date(NOW.valueOf() + 10 * 60_000) });
    expect(request!.nonceHash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(request)).not.toContain(grant);
    process.env.MCP_OAUTH_SHARED_LOGIN_ENABLED = "false";
    const hubOnly = await (await oauth.request(`/oauth/authorize?${new URLSearchParams(oauth.authorizeFields(CHATGPT, challenge))}`)).text();
    expect(hubOnly).toContain("Continue with Employee Hub");expect(hubOnly).not.toContain('name="password"');
    // Only the consent page itself may start a Hub approval.
    const planted = await oauth.form("/oauth/authorize", { ...oauth.authorizeFields(CHATGPT, challenge), login: "hub" }, { "Sec-Fetch-Site": "cross-site" });
    expect(planted.status).toBe(403);expect(planted.headers.get("location")).toBeNull();expect(planted.headers.getSetCookie()).toEqual([]);
    expect(oauth.requests.size).toBe(1);
    process.env.MCP_OAUTH_HUB_IDENTITY_ENABLED = "false";
    expect((await oauth.form("/oauth/authorize", { ...oauth.authorizeFields(CHATGPT, challenge), login: "hub" })).status).toBe(400);
  });
  it("binds each approval to the browser that started it with a per-request __Host- cookie", async () => {
    const started = await startHub();
    const [name, value] = started.cookie.split("=") as [string, string];
    expect(name).toBe(bindingCookieName(started.grant));expect(name).toMatch(/^__Host-egc_hub_grant_[a-f0-9]{24}$/);expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // SameSite=None because the Hub returns the browser with a cross-site form POST; never readable by script.
    expect(started.setCookie).toEqual([`${started.cookie}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=600`]);
    expect(JSON.stringify([...oauth.requests.values()])).not.toContain(value);
    const other = await startHub();
    const approve = (target: { grant: string; location: URL }) => hubAssertion({ hubUser: "zacb", role: "owner", businessAccess: true, ...shown(target) });
    // The link opened in another browser (no cookie), a guessed value, another request's cookie, or this name with another request's value.
    const wrong: ((target: { grant: string }) => string)[] = [
      () => "",
      (target) => `${bindingCookieName(target.grant)}=${"A".repeat(43)}`,
      () => other.cookie,
      (target) => `${bindingCookieName(target.grant)}=${other.cookie.split("=")[1]}`
    ];
    for (const cookieFor of wrong) {
      const target = await startHub(), cookie = cookieFor(target);
      const response = await callback(target.grant, await approve(target), cookie);
      expect(response.status, cookie).toBe(403);expect(response.headers.get("location"), cookie).toBeNull();
      expect(await response.text()).toContain("same browser where you started it");
    }
    expect(oauth.codes.size).toBe(0);
    // The browser that started it finishes it, and the callback clears the cookie.
    const done = await callback(started.grant, await approve(started), `${other.cookie}; ${started.cookie}`);
    expect(done.status).toBe(303);expect(done.headers.getSetCookie()).toEqual([`${name}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`]);
  });
  it("a tampered approval link connects nothing: the Hub signs the label and access it showed", async () => {
    const registered = await oauth.register({ client_name: "Synthetic Unknown Tool", redirect_uris: [CLAUDE_REDIRECT] });
    const tool = { clientId: registered.body.client_id as string, redirectUri: CLAUDE_REDIRECT };
    const base = { hubUser: "tylerg", role: "manager", businessAccess: true };
    const cases: [string, typeof tool, (started: Awaited<ReturnType<typeof startHub>>) => Partial<Claims>][] = [
      ["write shown as read", CHATGPT, () => ({ scope: "egc:read" })],
      ["another client's label", tool, () => ({ client: "ChatGPT (chatgpt.com)" })],
      ["label dropped", tool, () => ({ client: "" })],
      ["read shown as write", CHATGPT, () => ({ scope: "egc:read egc:write" })]
    ];
    for (const [label, client, change] of cases) {
      const started = await startHub(client, label === "read shown as write" ? { scope: "egc:read" } : {});
      const response = await callback(started.grant, await hubAssertion({ ...base, ...shown(started), ...change(started) }), started.cookie);
      expect(response.status, label).toBe(400);expect(response.headers.get("location"), label).toBeNull();
      expect(await response.text(), label).toContain("did not match this connection request");
    }
    expect(oauth.codes.size).toBe(0);expect(oauth.tokens.size).toBe(0);
    const honest = await startHub(tool);
    expect(honest.location.searchParams.get("client")).toBe("Synthetic Unknown Tool (claude.ai)");
    expect((await callback(honest.grant, await hubAssertion({ ...base, ...shown(honest) }), honest.cookie)).status).toBe(303);
  });
  it("an approved grant stores and carries the Hub user and role, for ChatGPT and for a DCR Claude client", async () => {
    const tokens = await connect({ hubUser: "zacb", role: "owner", businessAccess: true });
    expect(tokens.status).toBe(200);expect(tokens.body.scope).toBe("egc:read egc:write");
    const grant = [...oauth.tokens.values()][0]!;
    expect(grant).toMatchObject({ principalId: "zacb", principalRole: "owner" });expect(grant.principalAssertion).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const owner = await principal(tokens.body.access_token, WRITE_SCOPE);
    expect(owner).toEqual({ id: `mcp:zacb:${grant.id}`, delegate: { user: "zacb", role: "owner" }, assertion: grant.principalAssertion });
    // The role survives refresh rotation.
    const rotated = await oauth.refresh(CHATGPT.clientId, tokens.body.refresh_token);
    expect((await principal(rotated.body.access_token, WRITE_SCOPE))?.delegate).toEqual({ user: "zacb", role: "owner" });
    const registered = await oauth.register();
    const claude = { clientId: registered.body.client_id as string, redirectUri: CLAUDE_REDIRECT };
    const managerTokens = await connect({ hubUser: "tylerg", role: "manager", businessAccess: true }, claude);
    expect(managerTokens.status).toBe(200);
    expect((await principal(managerTokens.body.access_token, WRITE_SCOPE))?.delegate).toEqual({ user: "tylerg", role: "manager" });
  });
  it("Claude's client ID metadata document client connects through the Employee Hub without registering", async () => {
    process.env.MCP_OAUTH_DCR_ENABLED = "false";
    const resource = { resource: `${ORIGIN}/mcp/oauth` };
    const started = await startHub(CLAUDE_CIMD, resource);
    expect(started.location.searchParams.get("client")).toBe("Claude (claude.ai)");expect(started.location.searchParams.get("scope")).toBe("egc:read egc:write");
    expect([...oauth.requests.values()][0]).toMatchObject({ clientId: CLAUDE_CIMD.clientId, redirectUri: CLAUDE_REDIRECT, resource: ORIGIN, clientLabel: "Claude (claude.ai)" });
    const approved = await callback(started.grant, await hubAssertion({ hubUser: "tylerg", role: "manager", businessAccess: true, ...shown(started) }), started.cookie);
    expect(approved.status).toBe(303);
    const location = new URL(approved.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(CLAUDE_REDIRECT);expect(location.searchParams.get("iss")).toBe(ORIGIN);expect(location.searchParams.get("state")).toBe("synthetic-state");
    // A wrong verifier or another client cannot redeem the code; Claude's own exchange can, once.
    expect((await oauth.exchange(CLAUDE_CIMD, codeFrom(approved), pkce().verifier, resource)).body.error).toBe("invalid_grant");
    expect((await oauth.exchange(CHATGPT, codeFrom(approved), started.verifier, resource)).body.error).toBe("invalid_grant");
    const tokens = await oauth.exchange(CLAUDE_CIMD, codeFrom(approved), started.verifier, resource);
    expect(tokens.status).toBe(200);expect(tokens.body.scope).toBe("egc:read egc:write");
    expect((await oauth.exchange(CLAUDE_CIMD, codeFrom(approved), started.verifier, resource)).body.error).toBe("invalid_grant");
    expect(oauth.clients.size).toBe(0);
    const grant = [...oauth.tokens.values()][0]!;
    expect(grant).toMatchObject({ clientId: CLAUDE_CIMD.clientId, principalId: "tylerg", principalRole: "manager" });
    expect(await principal(tokens.body.access_token, WRITE_SCOPE)).toEqual({ id: `mcp:tylerg:${grant.id}`, delegate: { user: "tylerg", role: "manager" }, assertion: grant.principalAssertion });
    const rotated = await oauth.refresh(CLAUDE_CIMD.clientId, tokens.body.refresh_token, resource);
    expect((await principal(rotated.body.access_token, WRITE_SCOPE))?.delegate).toEqual({ user: "tylerg", role: "manager" });
    // A crew member connecting Claude gets read access only.
    const crew = await connect({ hubUser: "crew1", role: "crew", businessAccess: true }, CLAUDE_CIMD, resource);
    expect(crew.body.scope).toBe(READ_SCOPE);expect(await principal(crew.body.access_token, WRITE_SCOPE)).toBeNull();
  });
  it(`caps Employee Hub starts at ${HUB_START_MAX} per 15 minutes server-wide; refused starts store nothing and are not counted`, async () => {
    const { challenge } = pkce();
    const start = () => oauth.form("/oauth/authorize", { ...oauth.authorizeFields(CHATGPT, challenge), login: "hub" }, { "Sec-Fetch-Site": "same-origin" });
    const earlier = await startHub();
    for (let i = 1; i < HUB_START_MAX; i++) {
      expect((await start()).status).toBe(303);
      if (i % 50 === 49) oauth.advance(60_000);
    }
    expect(oauth.requests.size).toBe(HUB_START_MAX);expect(oauth.attempts.size).toBe(HUB_START_MAX);
    for (let i = 0; i < 5; i++) {
      const refused = await start();
      expect(refused.status).toBe(429);expect(refused.headers.get("retry-after")).toBe("900");
      expect(refused.headers.get("location")).toBeNull();expect(refused.headers.getSetCookie()).toEqual([]);
      expect(await refused.text()).toContain("Too many Employee Hub connection requests");
    }
    expect(oauth.requests.size).toBe(HUB_START_MAX);expect(oauth.attempts.size).toBe(HUB_START_MAX);
    // The cap limits starts only: a request started before it is approved normally.
    const approved = await callback(earlier.grant, await hubAssertion({ hubUser: "zacb", role: "owner", businessAccess: true, ...shown(earlier) }, { now: oauth.clock.now }), earlier.cookie);
    expect(approved.status).toBe(303);
    expect((await oauth.exchange(CHATGPT, codeFrom(approved), earlier.verifier)).status).toBe(200);
    // The shared login has its own limiter and still signs in while Hub starts are capped.
    expect((await oauth.form("/oauth/authorize", { ...oauth.authorizeFields(CHATGPT, challenge), username: SHARED_USER, password: SHARED_PASSWORD })).status).toBe(302);
    // Once the first 50 starts are 15 minutes old, 50 more are allowed, then the cap holds again.
    oauth.clock.now = new Date(NOW.valueOf() + HUB_START_WINDOW_MS);
    for (let i = 0; i < 50; i++) expect((await start()).status).toBe(303);
    expect((await start()).status).toBe(429);
  }, 60_000);
  it("rejects a wrong audience, a wrong key, an expired or mismatched assertion, and a reused or expired request", async () => {
    const base = { hubUser: "zacb", role: "owner", businessAccess: true };
    type Started = Awaited<ReturnType<typeof startHub>>;
    const cases: [string, (started: Started) => Promise<string>, () => void][] = [
      ["wrong audience", (started) => hubAssertion({ ...base, ...shown(started) }, { aud: "egc-operations" }), () => {}],
      ["wrong key", (started) => hubAssertion({ ...base, ...shown(started) }, { rootSecret: `${HUB_ROOT}-other` }), () => {}],
      ["other MCP deployment", (started) => hubAssertion({ ...base, ...shown(started), resource: "https://other-mcp.example.invalid" }), () => {}],
      ["other grant", (started) => hubAssertion({ ...base, ...shown(started), grantNonce: "x".repeat(43) }), () => {}],
      ["expired", (started) => hubAssertion({ ...base, ...shown(started) }), () => oauth.advance(60_000)]
    ];
    for (const [label, sign, before] of cases) {
      const started = await startHub();
      const assertion = await sign(started);
      before();
      const response = await callback(started.grant, assertion, started.cookie);
      expect(response.status, label).toBe(400);expect(response.headers.get("location"), label).toBeNull();
      expect(await response.text(), label).toMatch(/Nothing was connected|does not match/);
    }
    expect(oauth.codes.size).toBe(0);
    // A consumed request cannot be approved twice, even with a fresh valid assertion.
    const once = await startHub();
    expect((await callback(once.grant, await hubAssertion({ ...base, ...shown(once) }, { now: oauth.clock.now }), once.cookie)).status).toBe(303);
    const reused = await callback(once.grant, await hubAssertion({ ...base, ...shown(once) }, { now: oauth.clock.now }), once.cookie);
    expect(reused.status).toBe(400);expect(await reused.text()).toContain("already used");
    // Requests expire after ten minutes.
    const late = await startHub();
    oauth.advance(10 * 60_000);
    expect((await callback(late.grant, await hubAssertion({ ...base, ...shown(late) }, { now: oauth.clock.now }), late.cookie)).status).toBe(400);
    expect(oauth.codes.size).toBe(1);
    // An unreachable Hub key source is reported as unavailable, not as a bad approval.
    const unreachable = await startOAuth({ resolveHubKey: async () => { throw new ServiceAuthenticationError("service_key_source_unavailable", 503); } });
    try {
      const { challenge } = pkce();
      const started = await unreachable.form("/oauth/authorize", { ...unreachable.authorizeFields(CHATGPT, challenge), login: "hub" });
      const location = new URL(started.headers.get("location")!), grant = location.searchParams.get("grant")!;
      const response = await unreachable.form("/oauth/hub-callback", { grant, assertion: await hubAssertion({ ...base, ...shown({ grant, location }) }) }, { Cookie: started.headers.getSetCookie()[0]!.split(";")[0]! });
      expect(response.status).toBe(503);expect(unreachable.requests.size).toBe(1);expect([...unreachable.requests.values()][0]!.usedAt).toBeNull();
    } finally { await unreachable.close(); }
  });
  it("two concurrent grants never swap principals", async () => {
    const first = await startHub(CHATGPT, { state: "state-for-owner" });
    const second = await startHub(CHATGPT, { state: "state-for-manager" });
    const [ownerAssertion, managerAssertion] = await Promise.all([
      hubAssertion({ hubUser: "zacb", role: "owner", businessAccess: true, ...shown(first) }),
      hubAssertion({ hubUser: "tylerg", role: "manager", businessAccess: true, ...shown(second) })
    ]);
    // Cross-wired deliveries are refused and consume nothing.
    expect((await callback(first.grant, managerAssertion, first.cookie)).status).toBe(400);
    expect((await callback(second.grant, ownerAssertion, second.cookie)).status).toBe(400);
    const [managerDone, ownerDone] = await Promise.all([callback(second.grant, managerAssertion, second.cookie), callback(first.grant, ownerAssertion, first.cookie)]);
    const ownerRedirect = new URL(ownerDone.headers.get("location")!), managerRedirect = new URL(managerDone.headers.get("location")!);
    expect(ownerRedirect.searchParams.get("state")).toBe("state-for-owner");expect(managerRedirect.searchParams.get("state")).toBe("state-for-manager");
    const [managerTokens, ownerTokens] = await Promise.all([
      oauth.exchange(CHATGPT, managerRedirect.searchParams.get("code")!, second.verifier),
      oauth.exchange(CHATGPT, ownerRedirect.searchParams.get("code")!, first.verifier)
    ]);
    expect((await principal(ownerTokens.body.access_token))?.delegate).toEqual({ user: "zacb", role: "owner" });
    expect((await principal(managerTokens.body.access_token))?.delegate).toEqual({ user: "tylerg", role: "manager" });
    // Each code is bound to its own PKCE verifier.
    expect(ownerTokens.status).toBe(200);expect(managerTokens.status).toBe(200);
  });
  it("a crew or non-business Hub user cannot obtain egc:write", async () => {
    expect(hubGrantScopes([READ_SCOPE, WRITE_SCOPE], { hubUser: "crew1", role: "crew", businessAccess: true, grantNonce: "x".repeat(43), resource: ORIGIN, scope: "egc:read egc:write", client: "ChatGPT (chatgpt.com)" })).toEqual([READ_SCOPE]);
    expect(hubGrantScopes([READ_SCOPE, WRITE_SCOPE], { hubUser: "sales1", role: "sales", businessAccess: true, grantNonce: "x".repeat(43), resource: ORIGIN, scope: "egc:read egc:write", client: "ChatGPT (chatgpt.com)" })).toEqual([READ_SCOPE]);
    const crew = await connect({ hubUser: "crew1", role: "crew", businessAccess: true });
    expect(crew.body.scope).toBe(READ_SCOPE);
    expect(await principal(crew.body.access_token, WRITE_SCOPE)).toBeNull();
    expect((await principal(crew.body.access_token))?.delegate).toEqual({ user: "crew1", role: "crew" });
    // Even a row that somehow holds egc:write is refused write for a crew delegate.
    const row = [...oauth.tokens.values()].find((token) => token.principalId === "crew1")!;
    row.scopes = [READ_SCOPE, WRITE_SCOPE];
    expect(await principal(crew.body.access_token, WRITE_SCOPE)).toBeNull();
    const started = await startHub();
    const refused = await callback(started.grant, await hubAssertion({ hubUser: "crew2", role: "crew", businessAccess: false, ...shown(started) }), started.cookie);
    expect(refused.status).toBe(403);expect(refused.headers.get("location")).toBeNull();
    expect(await refused.text()).toContain("Only Employee Hub owners and managers can connect");
  });
  it("a Hub grant must be re-approved after 30 days even while it keeps refreshing", async () => {
    expect(HUB_GRANT_MAX_AGE_MS).toBe(30 * 24 * 60 * 60_000);
    let tokens = (await connect({ hubUser: "zacb", role: "owner", businessAccess: true })).body;
    const step = 9 * 24 * 60 * 60_000;
    let elapsed = 0;
    for (; elapsed + step < HUB_GRANT_MAX_AGE_MS; elapsed += step) {
      oauth.advance(step);
      tokens = (await oauth.refresh(CHATGPT.clientId, tokens.refresh_token)).body;
      expect(tokens.access_token).toBeTruthy();
    }
    oauth.advance(HUB_GRANT_MAX_AGE_MS - elapsed);
    expect((await oauth.refresh(CHATGPT.clientId, tokens.refresh_token)).body.error).toBe("invalid_grant");
  });
});

describe("delegated principal at the tool and bridge boundary", () => {
  const principalFor = (delegate?: Principal["delegate"], id = delegate ? `mcp:${delegate.user}:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b` : "mcp-oauth-grant:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b"): Principal =>
    ({ id, kind: "integration", role: "integration", workspace: "egc", ...(delegate ? { delegate } : {}) });
  it("owner-only tools require a delegate whose role is owner", async () => {
    const def = defineTool({ name: "synthetic.owner_read", class: "read", ownerOnly: true, description: "Synthetic owner-only read.", input: z.object({}).strict(), handler: vi.fn(() => ({ ok: true })) });
    const run = (p: Principal) => operationsPrincipal.run(p, () => invokeTool(def, {}));
    expect((await run(principalFor({ user: "tylerg", role: "manager" }))).structuredContent.result).toMatchObject({ error: "owner_grant_required" });
    expect((await run(principalFor({ user: "zacb", role: "owner" }, "mcp:tylerg:3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b"))).structuredContent.result).toMatchObject({ error: "owner_grant_required" });
    expect((await run({ ...principalFor(), id: "mcp-service-grant" })).structuredContent.result).toMatchObject({ error: "owner_grant_required" });
    expect((await run(principalFor({ user: "zacb", role: "owner" }))).structuredContent.result).toEqual({ ok: true });
    expect(isOwnerGrant(principalFor())).toBe(true);
    expect(def.handler).toHaveBeenCalledTimes(1);
  });
  it("forwards the Hub assertion beside a four-field actor, and never without it", async () => {
    const signingKey = "synthetic-mcp-signing-secret-0123456789abcdef";
    Object.assign(process.env, { EGC_OPERATIONS_ENABLED: "true", EGC_OPERATIONS_API_ORIGIN: "https://api.example.invalid", EGC_OPERATIONS_MCP_SIGNING_SECRET: signingKey });
    const envelopes: string[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => { envelopes.push(JSON.parse(String(init!.body)).envelope); return Response.json({ ok: true }); }) as unknown as typeof fetch;
    const delegated = principalFor({ user: "tylerg", role: "manager" });
    const assertion = await hubAssertion({ hubUser: "tylerg", role: "manager", businessAccess: true, grantNonce: "x".repeat(43), resource: ORIGIN, scope: "egc:read egc:write", client: "Claude (claude.ai)" });
    await runAsPrincipal(delegated, assertion, () => callOperations({ command: "status" }, "3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f70", fetcher));
    const claims = verifyRequest(envelopes[0], { mcp: signingKey }, signedAt(envelopes[0]!));
    expect(claims.actor).toEqual(bridgeActor(delegated));expect(Object.keys(claims.actor).sort()).toEqual(["id", "kind", "role", "workspace"]);
    expect(claims.delegate).toEqual({ user: "tylerg", role: "manager", assertion });
    // The principal object itself never exposes the assertion to tool code or logs.
    expect(JSON.stringify(delegated)).not.toContain(assertion.split(".")[1]);
    await runAsPrincipal(principalFor(), undefined, () => callOperations({ command: "status" }, "3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f71", fetcher));
    expect(verifyRequest(envelopes[1], { mcp: signingKey }, signedAt(envelopes[1]!))).not.toHaveProperty("delegate");
    const missing = await runAsPrincipal(principalFor({ user: "zacb", role: "owner" }), undefined, () => callOperations({ command: "status" }, undefined, fetcher));
    expect(missing).toEqual({ error: "verified_principal_required" });expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("a Hub approval the API no longer accepts (for example after a Hub key rotation) tells the user to reconnect", async () => {
    Object.assign(process.env, { EGC_OPERATIONS_ENABLED: "true", EGC_OPERATIONS_API_ORIGIN: "https://api.example.invalid", EGC_OPERATIONS_MCP_SIGNING_SECRET: "synthetic-mcp-signing-secret-0123456789abcdef" });
    const refused = vi.fn(async () => Response.json({ error: "delegate_invalid" }, { status: 403 })) as unknown as typeof fetch;
    const assertion = await hubAssertion({ hubUser: "tylerg", role: "manager", businessAccess: true, grantNonce: "x".repeat(43), resource: ORIGIN, scope: "egc:read egc:write", client: "Claude (claude.ai)" });
    const outcome = await runAsPrincipal(principalFor({ user: "tylerg", role: "manager" }), assertion, () => callOperations({ command: "status" }, "3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f72", refused));
    expect(outcome).toEqual({ error: "delegate_invalid", httpStatus: 403, requestId: "3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f72", instruction: DELEGATE_RECONNECT });
    expect(DELEGATE_RECONNECT).toContain("reconnect the EGC connector");
    const other = vi.fn(async () => Response.json({ error: "delegate_write_forbidden" }, { status: 403 })) as unknown as typeof fetch;
    expect(await runAsPrincipal(principalFor({ user: "crew1", role: "crew" }), assertion, () => callOperations({ command: "status" }, "3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f73", other))).not.toHaveProperty("instruction");
  });
});
