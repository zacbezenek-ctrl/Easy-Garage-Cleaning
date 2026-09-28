// Real Chromium through the real MCP OAuth routes (registerOauthRoutes from egc-platform/apps/mcp/dist,
// in-memory store, fixed clock) and the real Hub approval page and middleware (/api/mcp-grant), served at
// the Hub's pinned origin https://easygaragecleaning.com, to Claude's callback https://claude.ai/api/mcp/auth_callback.
// The AI client is Claude's client ID metadata document client. Every host resolves to loopback
// (--host-resolver-rules, anything else fails to resolve); the two https hosts use a throwaway self-signed
// certificate made with openssl for this run. No external network.
// Needs the platform built first (cd egc-platform && pnpm build:packages && pnpm --filter @egc/mcp build).
// Run: FIELD_PLAYWRIGHT_MODULE=<playwright>/index.mjs [PLAYWRIGHT_CHROMIUM_EXECUTABLE=...] node tests/mcp-grant.browser.mjs
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { mcpGrantHandlers } from '../functions/api/mcp-grant.js';
import { onRequest as middleware } from '../functions/_middleware.js';
import { servicePublicKeySet } from '../egc-platform/services/operations/src/service-auth.ts';
import { memoryOAuthStore } from '../egc-platform/apps/mcp/test/oauth-memory-store.ts';

const MCP_DIST = new URL('../egc-platform/apps/mcp/dist/oauth.js', import.meta.url);
if (!existsSync(fileURLToPath(MCP_DIST))) throw new Error('Build the platform first: cd egc-platform && pnpm build:packages && pnpm --filter @egc/mcp build');
const express = createRequire(new URL('../egc-platform/apps/mcp/package.json', import.meta.url))('express');

const NOW = '2026-09-22T12:00:00.000Z';
const HUB = 'https://easygaragecleaning.com', CLAUDE = 'https://claude.ai';
const CLAUDE_CLIENT_ID = `${CLAUDE}/oauth/mcp-oauth-client-metadata`, REDIRECT = `${CLAUDE}/api/mcp/auth_callback`;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const readBody = async incoming => { const chunks = []; for await (const chunk of incoming) chunks.push(chunk); return Buffer.concat(chunks); };

// A certificate for the two https hosts, valid only for this run and never written to the repository.
function throwawayCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'egc-mcp-grant-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=easygaragecleaning.com', '-addext', 'subjectAltName=DNS:easygaragecleaning.com,DNS:claude.ai', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const tls = throwawayCertificate();

const hubServer = createHttpsServer(tls), mcpServer = createHttpServer(), claudeServer = createHttpsServer(tls);
const [hubPort, mcpPort, claudePort] = [await listen(hubServer), await listen(mcpServer), await listen(claudeServer)];
// localhost is a secure context, so the MCP's __Host- binding cookie works over http as it does over https in production.
const MCP = `http://localhost:${mcpPort}`;
const hubEnv = {
  HUB_SESSION_SECRET: 'synthetic-mcp-grant-browser-hub-session-root-0123456789', EGC_MCP_PUBLIC_ORIGIN: MCP,
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'test', role: 'owner' }, TylerG: { passwordHash: 'test', role: 'manager' } }),
};
const hubKey = (await servicePublicKeySet({ service: 'hub', rootSecret: hubEnv.HUB_SESSION_SECRET, workspace: 'egc' })).keys[0];

// MCP: the real OAuth routes, configured as in production with Hub sign-in on.
for (const key of ['DATABASE_URL', 'MCP_OAUTH_SHARED_LOGIN_ENABLED', 'MCP_OAUTH_DCR_ENABLED', 'MCP_OAUTH_EXTRA_REDIRECTS', 'MCP_BEARER_TOKEN']) delete process.env[key];
Object.assign(process.env, { NODE_ENV: 'test', MCP_PUBLIC_ORIGIN: MCP, MCP_OAUTH_HUB_IDENTITY_ENABLED: 'true', MCP_OAUTH_USER: 'synthetic-owner', MCP_OAUTH_PASSWORD: 'synthetic-shared-connector-password-0123456789' });
const { registerOauthRoutes, verifiedMcpPrincipal, WRITE_SCOPE } = await import(MCP_DIST.href);
const memory = memoryOAuthStore();
const resolveHubKey = async (service, workspace, kid) => {
  if (service !== 'hub' || workspace !== 'egc' || kid !== hubKey.kid) throw Object.assign(new Error('unknown_service_key'), { code: 'unknown_service_key', status: 401 });
  return hubKey;
};
const mcpApp = express();
registerOauthRoutes(mcpApp, () => ({ operations: true, directSends: false, moneyTools: false }), { store: memory.store, now: () => new Date(NOW), resolveHubKey });
const mcpSeen = [], serverErrors = [];
mcpServer.on('request', (incoming, outgoing) => {
  const seen = { method: incoming.method, path: new URL(incoming.url, MCP).pathname, origin: incoming.headers.origin ?? null, referer: incoming.headers.referer ?? null, site: incoming.headers['sec-fetch-site'] ?? null, binding: /__Host-egc_hub_grant_[a-f0-9]{24}=/.test(incoming.headers.cookie ?? ''), status: 0 };
  mcpSeen.push(seen);
  outgoing.on('finish', () => { seen.status = outgoing.statusCode; if (outgoing.statusCode >= 500) serverErrors.push(`MCP ${seen.method} ${seen.path} ${outgoing.statusCode}`); });
  mcpApp(incoming, outgoing);
});

// Hub: the real handlers behind the real middleware, with an in-memory create-only store and the same fixed clock.
const rows = new Map(), hubSeen = [];
const storage = () => ({ async commit(writes) {
  for (const write of writes) if (rows.has(`${write.collection}/${write.id}`)) throw Object.assign(new Error('conflict'), { code: 'dispatch_revision_conflict' });
  for (const write of writes) rows.set(`${write.collection}/${write.id}`, structuredClone(write.patch));
} });
const hubRoute = mcpGrantHandlers({ storage, now: () => new Date(NOW) });
hubServer.on('request', async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, HUB), bytes = await readBody(incoming);
    hubSeen.push({ method: incoming.method, path: url.pathname, origin: incoming.headers.origin ?? null, site: incoming.headers['sec-fetch-site'] ?? null, session: /egc_hub_session=/.test(incoming.headers.cookie ?? '') });
    const request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(bytes.length ? { body: bytes } : {}) });
    const handler = url.pathname === '/api/mcp-grant' ? hubRoute[incoming.method === 'POST' ? 'post' : 'get'] : null;
    const response = await middleware({ request, env: hubEnv, next: async () => handler ? handler({ request, env: hubEnv }) : new Response('Not found', { status: 404 }) });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { serverErrors.push(error.stack); outgoing.writeHead(500); outgoing.end(); }
});

// Claude: its OAuth callback.
const claudeSeen = [];
claudeServer.on('request', (incoming, outgoing) => {
  const url = new URL(incoming.url, CLAUDE);
  if (url.pathname === new URL(REDIRECT).pathname) claudeSeen.push(Object.fromEntries(url.searchParams));
  outgoing.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  outgoing.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connected</title></head><body><main><h1>Connector connected</h1></main></body></html>');
});

const { chromium } = await import(pathToFileURL(process.env.FIELD_PLAYWRIGHT_MODULE).href);
const browser = await chromium.launch({
  headless: true,
  args: ['--no-proxy-server', `--host-resolver-rules=MAP easygaragecleaning.com 127.0.0.1:${hubPort}, MAP claude.ai 127.0.0.1:${claudePort}, EXCLUDE localhost, MAP * ~NOTFOUND`],
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
});
const pageErrors = [], cspViolations = [], foreignHosts = [];
async function phone(user) {
  // ignoreHTTPSErrors accepts only this run's throwaway certificate for the two loopback-mapped https hosts.
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Tokyo', ignoreHTTPSErrors: true });
  if (user) {
    const [cookie] = (await createHubSessionCookie(hubEnv, user)).split(';');
    const at = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, at), value: cookie.slice(at + 1), domain: 'easygaragecleaning.com', path: '/', httpOnly: true, secure: true, sameSite: 'Strict' }]);
  }
  const tab = await context.newPage();
  tab.setDefaultTimeout(12000);
  tab.on('pageerror', error => pageErrors.push(error.message));
  tab.on('console', message => { if (/Content Security Policy|Refused to/i.test(message.text())) cspViolations.push(message.text()); });
  tab.on('request', request => { const host = new URL(request.url()).hostname; if (!['easygaragecleaning.com', 'localhost', 'claude.ai'].includes(host)) foreignHosts.push(host); });
  return { context, tab };
}
const pkce = () => { const verifier = randomBytes(48).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; };
/** Claude sends its user to the real MCP consent page, and they continue with the Employee Hub. */
async function startConnection(tab, state) {
  const { verifier, challenge } = pkce();
  const authorize = new URL('/oauth/authorize', MCP);
  authorize.search = new URLSearchParams({ client_id: CLAUDE_CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: `${MCP}/mcp/oauth`, scope: 'egc:read egc:write', state }).toString();
  await tab.goto(authorize.href);
  await tab.getByText('Claude (claude.ai) is asking to connect').waitFor();
  await Promise.all([tab.waitForURL(url => url.href.startsWith(`${HUB}/api/mcp-grant?`)), tab.getByRole('button', { name: 'Continue with Employee Hub' }).click()]);
  return { link: tab.url(), verifier };
}
const callbacks = () => mcpSeen.filter(seen => seen.path === '/oauth/hub-callback');

let failed = false;
try {
  await mkdir('test-results', { recursive: true });
  // 1. The owner who started the connection approves it on a phone; Claude's callback gets a code it can redeem.
  const owner = await phone('ZacB');
  const started = await startConnection(owner.tab, 'synthetic-owner-state');
  const arrival = hubSeen.at(-1);
  assert.deepEqual([arrival.method, arrival.site, arrival.session], ['GET', 'cross-site', false], 'the Hub is a different site and its Strict session cookie stays home on arrival');
  assert.deepEqual(mcpSeen.filter(seen => seen.method === 'POST' && seen.path === '/oauth/authorize').map(seen => [seen.site, seen.status]), [['same-origin', 303]]);
  await owner.tab.getByRole('heading', { name: 'Connect an AI assistant' }).waitFor();
  await owner.tab.getByText('Claude (claude.ai)', { exact: true }).waitFor();
  await owner.tab.getByText('Name in this approval link (not verified by the Hub):').waitFor();
  const layout = await owner.tab.evaluate(() => ({ scroll: document.documentElement.scrollWidth <= innerWidth, button: document.querySelector('button').getBoundingClientRect().height, referrer: document.querySelector('meta[name=referrer]').content }));
  assert.equal(layout.scroll, true, 'no horizontal scroll at 375px'); assert.ok(layout.button >= 44, `tap target ${layout.button}px`); assert.equal(layout.referrer, 'same-origin');
  await owner.tab.screenshot({ path: 'test-results/mcp-grant-approval-375.png', fullPage: true });
  await Promise.all([owner.tab.waitForURL(url => url.href.startsWith(`${REDIRECT}?`)), owner.tab.getByRole('button', { name: 'Approve connection' }).click()]);
  const approval = hubSeen.find(seen => seen.method === 'POST');
  assert.deepEqual(approval, { method: 'POST', path: '/api/mcp-grant', origin: HUB, site: 'same-origin', session: true }, 'the approval POST carries the real Origin and the session');
  const [callback] = callbacks();
  assert.equal(callback.status, 303, 'the real /oauth/hub-callback accepts the approval'); assert.equal(callback.binding, true, 'the SameSite=None binding cookie returns with the cross-site relay POST');
  assert.equal(callback.referer, null, 'the relay sends no referrer'); assert.equal(callback.site, 'cross-site');
  await owner.tab.getByRole('heading', { name: 'Connector connected' }).waitFor();
  assert.equal(claudeSeen.length, 1); assert.equal(claudeSeen[0].state, 'synthetic-owner-state'); assert.equal(claudeSeen[0].iss, MCP); assert.match(claudeSeen[0].code, /^egc_ac_/);
  assert.equal([...rows.keys()].filter(key => key.startsWith('mcp_grant_nonces/')).length, 1);
  assert.deepEqual((await owner.context.cookies(MCP)).filter(cookie => cookie.name.startsWith('__Host-egc_hub_grant_')), [], 'the callback clears the binding cookie');
  // Claude's server redeems the code with its PKCE verifier; the grant acts for the Hub owner with write access.
  const exchange = await fetch(`${MCP}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLAUDE_CLIENT_ID, redirect_uri: REDIRECT, code: claudeSeen[0].code, code_verifier: started.verifier, resource: `${MCP}/mcp/oauth` }) });
  const tokens = await exchange.json();
  assert.equal(exchange.status, 200, JSON.stringify(tokens)); assert.equal(tokens.scope, 'egc:read egc:write');
  const principal = await verifiedMcpPrincipal(`Bearer ${tokens.access_token}`, WRITE_SCOPE, { store: memory.store, now: () => new Date(NOW) });
  assert.deepEqual(principal.delegate, { user: 'zacb', role: 'owner' }); assert.match(principal.id, /^mcp:zacb:/);
  assert.equal(memory.clients.size, 0, 'Claude connected with its metadata document, without registering');
  console.log('PASS: Claude (metadata-document client) -> real MCP consent -> real Hub approval with the real Origin -> real hub-callback with the binding cookie -> Claude callback -> owner write token.');

  // 2. An approval link sent to someone else: the manager approves in their own browser and nothing connects.
  const attacker = await phone(null);
  const forwarded = await startConnection(attacker.tab, 'synthetic-attacker-state');
  const manager = await phone('TylerG');
  await manager.tab.goto(forwarded.link);
  await Promise.all([manager.tab.waitForURL(url => url.href === `${MCP}/oauth/hub-callback`), manager.tab.getByRole('button', { name: 'Approve connection' }).click()]);
  await manager.tab.getByText('Finish this connection in the same browser where you started it').waitFor();
  assert.deepEqual(callbacks().map(seen => [seen.binding, seen.status]), [[true, 303], [false, 403]]);
  console.log('PASS: an approval link opened in another browser is approved in the Hub but connects nothing.');

  // 3. A doctored link on the real Hub domain shows its text only as an unverified name, and approving it connects nothing.
  const spoof = await phone('TylerG');
  const doctored = new URL((await startConnection(spoof.tab, 'synthetic-spoof-state')).link);
  doctored.searchParams.set('client', 'EGC Payroll Assistant (easygaragecleaning.com)');
  await spoof.tab.goto(doctored.href);
  await spoof.tab.getByText('Name in this approval link (not verified by the Hub):').waitFor();
  await spoof.tab.getByText('EGC Payroll Assistant (easygaragecleaning.com)', { exact: true }).waitFor();
  assert.equal(await spoof.tab.getByText('EGC Payroll Assistant (easygaragecleaning.com) wants').count(), 0, 'the link text is never the subject of the sentence');
  await Promise.all([spoof.tab.waitForURL(url => url.href === `${MCP}/oauth/hub-callback`), spoof.tab.getByRole('button', { name: 'Approve connection' }).click()]);
  await spoof.tab.getByText('did not match this connection request').waitFor();
  assert.deepEqual(callbacks().map(seen => [seen.binding, seen.status]), [[true, 303], [false, 403], [true, 400]]);
  console.log('PASS: a doctored client name is labelled unverified in the Hub and its approval connects nothing.');

  assert.equal(claudeSeen.length, 1, 'Claude\'s callback is reached only by the honest approval');
  assert.equal(memory.codes.size, 1); assert.equal(memory.tokens.size, 1);
  assert.deepEqual(cspViolations, []); assert.deepEqual(pageErrors, []); assert.deepEqual(foreignHosts, []); assert.deepEqual(serverErrors, []);
} catch (error) {
  failed = true;
  console.error(error);
  console.error(JSON.stringify({ hubSeen, mcpSeen, claudeSeen, cspViolations, pageErrors, serverErrors, foreignHosts }, null, 2));
} finally {
  await browser.close();
  for (const server of [hubServer, mcpServer, claudeServer]) server.close();
}
if (failed) process.exit(1);
