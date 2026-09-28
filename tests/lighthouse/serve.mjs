/* Zero-dependency Cloudflare Pages look-alike for Lighthouse CI. Read-only: synthetic API fixtures, no network writes, fixed clock. */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const FIXED_NOW = '2026-09-22T15:00:00.000Z';
export const DEFAULT_PORT = 9393;
export const READY_MESSAGE = 'EGC Lighthouse server listening on';
// Same denial as functions/_middleware.js PRIVATE_PATH, so /tests stays unreachable exactly as in production.
export const PRIVATE_PATH = /^(?:\/(?:auth-verifier|contracts|docs|scripts|tests|egc-platform|functions|tools|\.github|\.claude|node_modules)(?:\/|$)|\/(?:sop|tyler-contract)(?:\.html)?\/?$|\/EGC-Lead-System-SOP\.pdf$|\/(?:package(?:-lock)?\.json|README\.md|firebase(?:\.emulator|\.field-day)?\.json|firestore\.rules|pnpm-(?:lock|workspace)\.yaml|\.firebaserc|\.env(?:\.example)?|_[^/]+)(?:$|\/)|\/.*\.py\/?$)/i;
// Local checkouts also hold dot folders and installed packages that never deploy (/.well-known is public).
const LOCAL_ONLY = /(?:^|\/)(?:\.(?!well-known(?:\/|$))[^/]*|node_modules)(?:\/|$)/;
// Harness pages live under /tests (blocked above); they are reachable only through these aliases.
export const HARNESS = Object.freeze({ '/field-today': 'tests/lighthouse/pages/field-today.html' });
export const FIXTURE_APIS = Object.freeze(['/api/business-hub', '/api/client-login', '/api/customer-portal', '/api/field-jobs', '/api/hub-auth']);
// Pages Functions that production routes ahead of static files. Only Client Login is wired: /before-after is measured as its
// committed static fallback. The lookup is shared with lighthouserc.cjs so the audited URL list and the server always agree.
const { clientLoginFunction } = createRequire(import.meta.url)('./lighthouserc.cjs');
export const FUNCTION_ROUTES = Object.freeze({ '/client-login': clientLoginFunction });
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|manifest\+json|xml)|image\/svg)/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_STATUSES = new Set(['all', 'active', 'completed', 'cancelled']);
const FIELD_COMPLETED = new Set(['completed', 'paid', 'invoiced', 'review_requested']);

const fileAt = path => { try { const info = statSync(path); return info.isFile() ? info : null; } catch { return null; } };
const inside = (root, pathname) => { const full = resolve(root, '.' + pathname); return full === root || full.startsWith(root.endsWith(sep) ? root : root + sep) ? full : null; };
const denverDate = instant => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
const validDay = value => DAY.test(value || '') && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value ? value : '';
const shiftDay = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function parseHeadersFile(text) {
  const rules = []; let rule = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { rule = { pattern: line.trim(), headers: [] }; rules.push(rule); continue; }
    const match = /^\s+([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (rule && match) rule.headers.push([match[1], match[2]]);
  }
  return rules.map(({ pattern, headers }) => ({ pattern, headers, test: new RegExp('^' + pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$') }));
}

export function headersFor(rules, pathname) {
  const out = {};
  for (const rule of rules) if (rule.test.test(pathname)) for (const [name, value] of rule.headers) { const key = name.toLowerCase(); out[key] = out[key] && key !== 'cache-control' ? `${out[key]}, ${value}` : value; }
  return out;
}

export function loadFixtures(dir = new URL('./fixtures/', import.meta.url)) {
  const read = name => JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8'));
  return Object.freeze({ businessHub: read('business-hub'), clientLogin: read('client-login'), customerPortal: read('customer-portal'), fieldJobs: read('field-jobs'), hubAuth: read('hub-auth') });
}

// The saved field day is anchored to fixture.date; it moves to the requested Mountain date so the crew screen always has a current job.
export function fieldJobsResponse(fixture, params, now) {
  const requested = params.get('date'), date = requested ? validDay(requested) : denverDate(now), days = Number(params.get('days') || 1), status = params.get('status') || 'all';
  if (!date || !Number.isInteger(days) || days < 1 || days > 7 || !FIELD_STATUSES.has(status)) return [400, { ok: false, code: 'FIELD_INVALID_REQUEST', error: 'Choose a valid Mountain date, 1–7 days and a supported status filter.' }];
  const offset = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${fixture.date}T12:00:00Z`)) / 86400000), endDate = shiftDay(date, days - 1);
  const jobs = fixture.jobs.map(job => ({ ...job, date: shiftDay(job.date, offset), endDate: shiftDay(job.endDate || job.date, offset) }))
    .filter(job => job.date <= endDate && job.endDate >= date)
    .filter(job => status === 'all' || (status === 'active' ? !FIELD_COMPLETED.has(job.status) && job.status !== 'cancelled' : status === 'completed' ? FIELD_COMPLETED.has(job.status) : job.status === 'cancelled'));
  return [200, { ...fixture, jobs, date, endDate, generatedAt: new Date(now).toISOString() }];
}

export function fixtureApi(pathname, params, { fixtures, now }) {
  if (pathname === '/api/business-hub') return [200, fixtures.businessHub];
  if (pathname === '/api/client-login') return [200, fixtures.clientLogin];
  if (pathname === '/api/customer-portal') return [200, fixtures.customerPortal];
  if (pathname === '/api/field-jobs') return fieldJobsResponse(fixtures.fieldJobs, params, now);
  if (pathname === '/api/hub-auth') return [200, fixtures.hubAuth];
  return [404, { ok: false, code: 'LIGHTHOUSE_FIXTURE_MISSING', error: 'This endpoint has no synthetic Lighthouse fixture.' }];
}

function locate(root, pathname) {
  const file = rel => { const full = inside(root, '/' + rel.replace(/^\/+/, '')); return full && fileAt(full) ? full : null; };
  if (HARNESS[pathname]) return { file: join(root, HARNESS[pathname]) };
  if (pathname.endsWith('/index.html')) return file(pathname) ? { redirect: pathname.slice(0, -'index.html'.length) } : null;
  if (pathname.endsWith('.html')) return file(pathname) ? { redirect: pathname.slice(0, -'.html'.length) } : null;
  if (pathname.endsWith('/')) {
    const index = file(pathname + 'index.html');
    if (index) return { file: index };
    return pathname !== '/' && file(pathname.slice(0, -1) + '.html') ? { redirect: pathname.slice(0, -1) } : null;
  }
  const exact = file(pathname);
  if (exact) return { file: exact };
  const page = file(pathname + '.html');
  if (page) return { file: page };
  return file(pathname + '/index.html') ? { redirect: pathname + '/' } : null;
}

function encode(body, type, acceptEncoding, cache, key) {
  if (!COMPRESSIBLE.test(type) || body.length < 256) return { body, encoding: '' };
  const accepted = String(acceptEncoding || '').toLowerCase(), encoding = /\bbr\b/.test(accepted) ? 'br' : /\bgzip\b/.test(accepted) ? 'gzip' : '';
  if (!encoding) return { body, encoding };
  const id = `${encoding}:${key}`;
  if (key && cache.has(id)) return { body: cache.get(id), encoding };
  const packed = encoding === 'br' ? brotliCompressSync(body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length } }) : gzipSync(body, { level: 9 });
  if (key) cache.set(id, packed);
  return { body: packed, encoding };
}

export function createPagesHandler({ root = ROOT, now = () => FIXED_NOW, fixtures = loadFixtures() } = {}) {
  const base = resolve(root), rules = parseHeadersFile(fileAt(join(base, '_headers')) ? readFileSync(join(base, '_headers'), 'utf8') : ''), cache = new Map();
  const finish = (request, status, headers, raw, key = '') => {
    const { body, encoding } = encode(raw, headers['content-type'] || '', request.headers?.['accept-encoding'], cache, key);
    if (encoding) { headers['content-encoding'] = encoding; headers.vary = 'Accept-Encoding'; }
    headers['content-length'] = String(body.length);
    return { status, headers, body: request.method === 'HEAD' ? Buffer.alloc(0) : body };
  };
  const json = (request, status, value, extra = {}) => finish(request, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', ...extra }, Buffer.from(JSON.stringify(value)));
  const notFound = (request, pathname) => {
    const page = join(base, '404.html'), info = fileAt(page);
    const body = info ? readFileSync(page) : Buffer.from('<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found</title><h1>Not found</h1></html>');
    return finish(request, 404, { 'content-type': TYPES['.html'], 'cache-control': 'no-store', ...headersFor(rules, pathname), 'x-robots-tag': 'noindex, nofollow' }, body, info ? `${page}:${info.mtimeMs}` : '');
  };
  return function handle(request) {
    const method = String(request.method || 'GET').toUpperCase(), req = { ...request, method };
    let url, pathname;
    try { url = new URL(request.url || '/', 'http://127.0.0.1'); pathname = decodeURIComponent(url.pathname); }
    catch { return finish(req, 400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, Buffer.from('Bad request')); }
    const api = pathname.startsWith('/api/');
    if (method !== 'GET' && method !== 'HEAD') {
      return api ? json(req, 405, { ok: false, code: 'LIGHTHOUSE_READ_ONLY', error: 'The Lighthouse server is read-only and never writes.' }, { allow: 'GET, HEAD' })
        : finish(req, 405, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', allow: 'GET, HEAD' }, Buffer.from('Method not allowed'));
    }
    if (api) { const [status, value] = fixtureApi(pathname, url.searchParams, { fixtures, now: now() }); return json(req, status, value); }
    // The middleware also turns the explicit /404 page into a real 404 status.
    if (pathname === '/404' || pathname.includes('\0') || PRIVATE_PATH.test(pathname) || LOCAL_ONLY.test(pathname)) return notFound(req, pathname);
    const pageFunction = FUNCTION_ROUTES[pathname]?.(base);
    return pageFunction ? runPageFunction(pageFunction, req, url, pathname) : serveStatic(req, url, pathname);
  };
  function serveStatic(req, url, pathname) {
    const found = locate(base, pathname);
    if (!found) return notFound(req, pathname);
    if (found.redirect) return finish(req, 308, { location: found.redirect + url.search, 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' }, Buffer.alloc(0));
    const info = fileAt(found.file);
    if (!info) return notFound(req, pathname);
    const type = TYPES[extname(found.file).toLowerCase()] || 'application/octet-stream';
    return finish(req, 200, { 'content-type': type, 'cache-control': 'public, max-age=0, must-revalidate', ...headersFor(rules, pathname) }, readFileSync(found.file), `${found.file}:${info.mtimeMs}`);
  }
  // Runs a Pages Function the way Cloudflare does for GET and HEAD, with an empty env (no secrets) and next() serving the static
  // file. A function that throws or needs a real binding fails loudly with a 5xx instead of being measured as a different page.
  async function runPageFunction(file, req, url, pathname) {
    const module = await import(pathToFileURL(file).href);
    // HEAD mirrors GET here, as it does for static files; browsers and Lighthouse only navigate with GET.
    const chain = [].concat((req.method === 'HEAD' && module.onRequestHead) || module.onRequestGet || module.onRequest || []).filter(fn => typeof fn === 'function');
    if (!chain.length) return serveStatic(req, url, pathname);
    const plain = { ...req, method: 'GET', headers: { ...req.headers, 'accept-encoding': 'identity' } };
    const assetResponse = () => {
      const inner = serveStatic(plain, url, pathname), headers = Object.fromEntries(Object.entries(inner.headers).filter(([name]) => name !== 'content-length'));
      return new Response(inner.status === 308 || req.method === 'HEAD' ? null : inner.body, { status: inner.status, headers });
    };
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers || {})) if (typeof value === 'string' && name !== 'host') headers.set(name, value);
    const request = new Request(`http://${req.headers?.host || '127.0.0.1'}${url.pathname}${url.search}`, { method: req.method, headers });
    const context = { request, env: {}, params: {}, data: {}, functionPath: pathname, waitUntil() {}, passThroughOnException() {} };
    const dispatch = index => index < chain.length ? chain[index]({ ...context, next: async () => dispatch(index + 1) }) : assetResponse();
    const response = await dispatch(0);
    const out = Object.fromEntries([...response.headers].filter(([name]) => name !== 'content-length' && name !== 'content-encoding'));
    return finish(req, response.status, out, Buffer.from(await response.arrayBuffer()));
  }
}

export function createPagesServer(options = {}) {
  const handle = createPagesHandler(options);
  return createServer((request, response) => {
    response.sendDate = false;
    const send = ({ status, headers, body }) => { response.writeHead(status, headers); response.end(body); };
    const fail = error => { console.error(error); send({ status: 500, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from('The Pages Function failed in the Lighthouse server.') }); };
    // Static files and fixtures answer synchronously; only a Pages Function route resolves later.
    try { const result = handle({ method: request.method, url: request.url, headers: request.headers }); if (typeof result?.then === 'function') result.then(send, fail); else send(result); }
    catch (error) { fail(error); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Read-only and offline: a Pages Function that tries to reach the network fails instead of touching production data.
  globalThis.fetch = async () => { throw new Error('The EGC Lighthouse server never calls the network.'); };
  const port = process.env.LIGHTHOUSE_PORT ? Number(process.env.LIGHTHOUSE_PORT) : DEFAULT_PORT, server = createPagesServer();
  server.listen(port, '127.0.0.1', () => console.log(`${READY_MESSAGE} http://127.0.0.1:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
}
