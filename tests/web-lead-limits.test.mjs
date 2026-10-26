// SEC-2026-10 M-01: /api/web-lead rate limits and the count-only missing-origin marker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WEB_LEAD_LIMITS, webLeadHandlers } from '../functions/api/web-lead.js';
import { webLeadStorage } from '../functions/_lib/web-lead-intake.js';
import { firestoreMemory } from './helpers/firestore-memory.mjs';

const ORIGIN = 'https://easygaragecleaning.com';
const HOOK = 'https://hooks.example.invalid/catch/synthetic';
const env = { HUB_SESSION_SECRET: 'synthetic-session-secret-for-web-lead-limit-tests', WEBSITE_LEAD_HOOK_URL: HOOK };

function harness(t, { limitStore } = {}) {
  const memory = firestoreMemory(), synced = [], relayed = [], warnings = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(HOOK)) { relayed.push(url); return new Response('ok'); }
    throw new Error('unexpected network call: ' + url);
  });
  const handler = webLeadHandlers({
    now: () => new Date('2026-10-26T18:00:00Z'),
    storage: () => assert.fail('the receipt ledger is off in these tests'),
    sync: async (_env, lead) => { synced.push(lead.phone); return { configured: true, synced: true }; },
    warn: message => warnings.push(JSON.parse(message)),
    limitStore: limitStore || (() => webLeadStorage(env, (_env, url, init) => memory.fetch(url, init))),
  });
  const post = ({ phone = '(970) 555-0100', ip = '198.51.100.7', headers = { Origin: ORIGIN } } = {}) => handler.post({ env, request: new Request(`${ORIGIN}/api/web-lead`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...headers },
    body: JSON.stringify({ name: 'Synthetic Lead', phone, sms_consent: 'yes', source: 'EGC Website' }),
  }) });
  return { post, synced, relayed, warnings, memory };
}

test('M-01: one phone gets at most 5 synced and texted leads a day, from any address, and the visitor still sees success', async t => {
  const h = harness(t);
  for (let i = 0; i < WEB_LEAD_LIMITS.phone.limit; i += 1) assert.equal((await h.post({ ip: `192.0.2.${i + 1}` })).status, 200);
  assert.equal(h.synced.length, 5);
  assert.equal(h.relayed.length, 5);
  const limited = await h.post({ ip: '203.0.113.50', phone: '970-555-0100' });
  assert.equal(limited.status, 200, 'a limited visitor sees the same success');
  assert.deepEqual(await limited.json(), { ok: true, accepted: true });
  assert.equal(h.synced.length, 5, 'nothing more reaches HighLevel');
  assert.equal(h.relayed.length, 5, 'nothing more is texted');
  assert.ok(h.warnings.some(w => w.event === 'web_lead_rate_limited' && w.bucket === 'web_lead_phone'));
  assert.ok(![...h.memory.documents.values()].some(doc => JSON.stringify(doc).includes('9705550100')), 'counters hold no raw phone');
  // A household resubmitting twice with another number is unaffected.
  assert.equal((await h.post({ phone: '(970) 555-0101' })).status, 200);
  assert.equal(h.synced.length, 6);
});

test('M-01: one address gets at most 20 leads an hour', async t => {
  const h = harness(t);
  for (let i = 0; i < WEB_LEAD_LIMITS.ip.limit; i += 1) await h.post({ phone: `(970) 555-${String(1000 + i)}` });
  assert.equal(h.synced.length, 20);
  assert.equal((await h.post({ phone: '(970) 555-2000' })).status, 200);
  assert.equal(h.synced.length, 20);
  assert.equal(h.relayed.length, 20);
  assert.ok(h.warnings.some(w => w.event === 'web_lead_rate_limited' && w.bucket === 'web_lead_ip'));
  assert.equal((await h.post({ phone: '(970) 555-2000', ip: '198.51.100.8' })).status, 200);
  assert.equal(h.synced.length, 21, 'another address is not limited');
});

test('M-01: a lead with neither Origin nor Referer is still delivered and counted, never refused', async t => {
  const h = harness(t);
  const response = await h.post({ headers: {} });
  assert.equal(response.status, 200);
  assert.equal(h.synced.length, 1);
  assert.equal(h.relayed.length, 1);
  assert.ok(h.warnings.some(w => w.event === 'web_lead_originless'));
  assert.equal((await h.post({ headers: { Origin: 'https://evil.example' } })).status, 403, 'a foreign origin is still refused');
});

test('M-01: a counter outage lets the lead through instead of losing it', async t => {
  const h = harness(t, { limitStore: () => ({ read: async () => { throw new Error('down'); }, commit: async () => { throw new Error('down'); } }) });
  assert.equal((await h.post()).status, 200);
  assert.equal(h.synced.length, 1);
  assert.ok(h.warnings.some(w => w.event === 'web_lead_limit_unavailable'));
});
