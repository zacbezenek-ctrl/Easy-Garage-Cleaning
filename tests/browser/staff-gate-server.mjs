/* Cloudflare Pages look-alike for tests/browser/test_staff_gate_ui.py: the real functions/_middleware.js runs with
   EGC_STAFF_PAGE_GATE=on in front of the static site (served by tests/lighthouse/serve.mjs) and the real /api/hub-auth.
   Synthetic staff only, a fixed server clock, and no network. Other /api/* routes answer 404 so pages show their error state. */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createPagesHandler } from '../lighthouse/serve.mjs';
import { onRequest as middleware } from '../../functions/_middleware.js';
import * as hubAuth from '../../functions/api/hub-auth.js';
import { createHubCredentialHash } from '../../functions/_lib/hub-session.js';

export const READY_MESSAGE = 'EGC staff gate server listening on';
export const FIXED_NOW = '2026-09-28T16:00:00.000Z';
export const STAFF = Object.freeze({
  manager: { username: 'tylerg', password: 'synthetic-manager-password', displayName: 'Synthetic Manager', role: 'manager' },
  crew: { username: 'synthetic.crew', password: 'synthetic-crew-password', displayName: 'Synthetic Crew', role: 'crew' },
});

export async function staffGateEnv() {
  const users = {};
  for (const person of Object.values(STAFF)) users[person.username] = { passwordHash: await createHubCredentialHash(person.password), displayName: person.displayName, role: person.role, payType: 'hourly', hourlyRate: 0 };
  return { EGC_STAFF_PAGE_GATE: 'on', HUB_SESSION_SECRET: 'synthetic-staff-gate-session-secret-0123456789', HUB_AUTH_USERS_JSON: JSON.stringify(users) };
}

const HUB_AUTH = { GET: hubAuth.onRequestGet, POST: hubAuth.onRequestPost, DELETE: hubAuth.onRequestDelete, OPTIONS: hubAuth.onRequestOptions };

export function createStaffGateServer({ env }) {
  const pages = createPagesHandler();
  const staticFile = (request, url) => {
    const headers = Object.fromEntries([...request.headers].filter(([name]) => name !== 'host'));
    const out = pages({ method: request.method, url: url.pathname + url.search, headers: { ...headers, 'accept-encoding': 'identity' } });
    const kept = Object.entries(out.headers).filter(([name]) => name !== 'content-length');
    return new Response(out.status === 308 || request.method === 'HEAD' ? null : out.body, { status: out.status, headers: kept });
  };
  const next = (request, url) => async () => {
    if (url.pathname === '/api/hub-auth') {
      const handler = HUB_AUTH[request.method];
      return handler ? handler({ request, env }) : new Response(null, { status: 405 });
    }
    if (url.pathname.startsWith('/api/')) return Response.json({ ok: false, code: 'STAFF_GATE_FIXTURE_MISSING', error: 'This endpoint is not part of the staff gate test.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return staticFile(request, url);
  };
  return createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
      const method = incoming.method || 'GET';
      const request = new Request(`http://${incoming.headers.host || '127.0.0.1'}${incoming.url}`, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(chunks) });
      const url = new URL(request.url);
      const response = await middleware({ request, env, params: {}, data: {}, next: next(request, url), waitUntil() {}, passThroughOnException() {} });
      const out = {};
      for (const [name, value] of response.headers) if (name !== 'content-length' && name !== 'content-encoding' && name !== 'set-cookie') out[name] = value;
      // Production is https only. On this http://127.0.0.1 server upgrade-insecure-requests would send every followed
      // redirect (the Pages pretty-URL 308s the crew service worker precaches through) to an https port that does not exist.
      if (out['content-security-policy']) out['content-security-policy'] = out['content-security-policy'].replace(/;\s*upgrade-insecure-requests\b/, '');
      const cookies = response.headers.getSetCookie();
      if (cookies.length) out['set-cookie'] = cookies;
      outgoing.writeHead(response.status, out);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error);
      outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      outgoing.end('The staff gate test server failed.');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixed = Date.parse(FIXED_NOW);
  Date.now = () => fixed;
  globalThis.fetch = async () => { throw new Error('The staff gate test server never calls the network.'); };
  const server = createStaffGateServer({ env: await staffGateEnv() });
  server.listen(Number(process.env.STAFF_GATE_PORT || 0), '127.0.0.1', () => console.log(`${READY_MESSAGE} http://127.0.0.1:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
}
