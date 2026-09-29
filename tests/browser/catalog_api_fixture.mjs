// Fixture server for tests/browser/test_catalog_ui.py: the repo's static files, a page that mounts the catalog
// screen on its own, and the REAL /api/catalog handler (functions/api/catalog.js) over catalogStorage and an
// in-memory Firestore REST emulation (409 ALREADY_EXISTS on a create over an existing document, 400
// FAILED_PRECONDITION on a stale updateTime). The clock and the signed-in viewer are injected; POST /__control sets
// them, resets the store or plays "another tab" saving settings or publishing a version. Prints {"port":N} first.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { catalogHandlers } from '../../functions/api/catalog.js';
import { catalogStorage, mutateCatalog, seedCatalog, seedPricingSettings } from '../../functions/_lib/catalog-store.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../../functions/_lib/firestore-job.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS = 'projects/egcw-1ec83/databases/(default)/documents/';
const OWNER = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
const MANAGER = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };
const TYPES = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Catalog harness</title>
<link rel="stylesheet" href="/employee-ui-kit.css"><link rel="stylesheet" href="/employee-catalog.css">
<style>body{margin:0;background:#f1f0ec}main{padding:16px 12px}</style></head>
<body><main id="host"></main><script src="/employee-ui-kit.js"></script><script src="/employee-catalog.js"></script>
<script src="/__mount.js"></script></body></html>`;
const MOUNT = "sessionStorage.setItem('egc_u','zacb');EGCCatalog.mount(document.getElementById('host'),{identity:'zacb',go:view=>{document.body.dataset.went=view;}});";

const state = { docs: new Map(), tick: 0, now: '2026-09-28T05:30:00.000Z', who: 'owner', enabled: true, cache: new Map(), posts: [] };
const stamp = () => `2026-09-28T18:00:00.${String(++state.tick).padStart(6, '0')}Z`;
const error = (status, code) => Response.json({ error: { code, status } }, { status: code });
async function fetcher(_env, url, options = {}) {
  const target = new URL(url);
  if (target.hostname !== 'firestore.googleapis.com') throw new Error('only Firestore is reachable');
  const path = decodeURIComponent(target.pathname.split('/documents')[1] || '');
  if (options.method === 'POST' && path === ':commit') {
    const { writes } = JSON.parse(options.body), keys = writes.map(write => write.update.name.slice(DOCS.length));
    for (const [index, write] of writes.entries()) {
      const current = state.docs.get(keys[index]);
      if (write.currentDocument?.exists === false && current) return error('ALREADY_EXISTS', 409);
      if (write.currentDocument?.updateTime && current?.updateTime !== write.currentDocument.updateTime) return error('FAILED_PRECONDITION', 400);
    }
    const at = stamp();
    for (const [index, write] of writes.entries()) {
      const fields = { ...(state.docs.get(keys[index])?.fields || {}) };
      for (const field of write.updateMask.fieldPaths) fields[field] = write.update.fields[field];
      state.docs.set(keys[index], { fields, updateTime: at });
    }
    return Response.json({ writeResults: writes.map(() => ({ updateTime: at })), commitTime: at });
  }
  const key = path.slice(1), doc = state.docs.get(key);
  return doc ? Response.json({ name: DOCS + key, fields: doc.fields, updateTime: doc.updateTime }) : Response.json({ error: { code: 404, status: 'NOT_FOUND', message: `Document "${DOCS}${key}" not found.` } }, { status: 404 });
}
const storage = env => catalogStorage(env, fetcher);
const handlers = () => catalogHandlers({ session: async () => state.who === 'owner' ? OWNER : state.who === 'manager' ? MANAGER : null, storage, now: () => new Date(state.now), cache: state.cache });
const env = () => (state.enabled ? { CATALOG_QUOTES_ENABLED: 'true' } : {});
const read = key => state.docs.has(key) ? decodeFirestoreFields(state.docs.get(key).fields) : null;

// "Another tab": the owner saves settings or publishes a version outside the page under test.
async function control(body) {
  if (body.reset) { state.docs.clear(); state.cache = new Map(); state.posts = []; state.who = 'owner'; state.enabled = true; }
  if (body.now) state.now = body.now;
  if (body.who) state.who = body.who;
  if (typeof body.enabled === 'boolean') state.enabled = body.enabled;
  const store = storage(env()), result = {};
  if (body.saveSettings) {
    const current = read('pricingSettings/current'), revision = state.docs.get('pricingSettings/current')?.updateTime ?? null;
    const settings = { ...structuredClone(current?.settings || seedPricingSettings()), ...body.saveSettings };
    result.settings = await mutateCatalog(store, OWNER, { action: 'settings.update', requestId: randomUUID(), expectedRevision: revision, settings }, state.now);
  }
  if (body.publish) {
    const pointer = read('catalogVersions/current'), base = pointer ? JSON.parse(read(`catalogVersions/${pointer.version}`).catalogJson) : structuredClone(seedCatalog());
    const catalog = { ...structuredClone(base), catalogVersion: body.publish.version, generatedOn: body.publish.version.slice(0, 10) };
    const item = catalog.items.find(entry => entry.id === body.publish.itemId);
    if (item) item.name = body.publish.name;
    result.publication = await mutateCatalog(store, OWNER, { action: 'catalog.publish', requestId: randomUUID(), basedOnVersion: pointer?.version ?? base.catalogVersion, catalog }, state.now);
  }
  const versions = [...state.docs.keys()].filter(key => key.startsWith('pricingSettingsVersions/')).length;
  return { ok: true, ...result, posts: state.posts, settings: read('pricingSettings/current'), pointer: read('catalogVersions/current'), settingsVersions: versions, receipts: [...state.docs.keys()].filter(key => key.startsWith('catalogOperations/')).length };
}

async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return Buffer.concat(chunks); }
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/__control' && request.method === 'POST') {
      const result = await control(JSON.parse((await body(request)).toString() || '{}'));
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result)); return;
    }
    if (url.pathname === '/api/catalog') {
      const raw = request.method === 'POST' ? await body(request) : null;
      if (raw) try { const parsed = JSON.parse(raw.toString()); state.posts.push({ action: parsed.action, requestId: parsed.requestId, expectedRevision: parsed.expectedRevision, basedOnVersion: parsed.basedOnVersion, confirmCustomerUse: parsed.confirmCustomerUse, settingsVersion: parsed.settings?.settingsVersion, catalogVersion: parsed.catalog?.catalogVersion }); } catch {}
      const headers = new Headers(); for (const name of ['content-type', 'content-length', 'origin', 'referer', 'sec-fetch-site']) if (request.headers[name]) headers.set(name, request.headers[name]);
      const req = new Request(url.href, { method: request.method, headers, body: raw ?? undefined });
      const h = handlers(), answer = request.method === 'POST' ? await h.post({ request: req, env: env() }) : await h.get({ request: req, env: env() });
      response.writeHead(answer.status, Object.fromEntries(answer.headers)); response.end(Buffer.from(await answer.arrayBuffer())); return;
    }
    if (url.pathname === '/catalog-harness') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(HARNESS); return; }
    if (url.pathname === '/__mount.js') { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end(MOUNT); return; }
    const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (request.method !== 'GET' || !file.startsWith(ROOT) || relative(ROOT, file).split(sep).some(part => part.startsWith('.')) || !TYPES[extname(file)]) { response.writeHead(404); response.end(); return; }
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': TYPES[extname(file)], 'Cache-Control': 'no-store' }); response.end(data);
  } catch (failure) {
    if (!response.headersSent) response.writeHead(failure?.code === 'ENOENT' ? 404 : 500);
    response.end();
  }
});
server.listen(0, '127.0.0.1', () => { process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n'); });
process.stdin.on('end', () => server.close(() => process.exit(0)));
process.stdin.resume();
