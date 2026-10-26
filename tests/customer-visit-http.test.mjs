import test from 'node:test';
import assert from 'node:assert/strict';
import { readVisitJson } from '../functions/_lib/customer-visit-http.js';
const url = 'https://example.invalid/api/customer-account';
const headers = { Origin: 'https://example.invalid', 'Content-Type': 'application/json', 'X-EGC-Portal': '1' };
test('request bodies are bounded while streaming, even without a content length', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(6001)); }, cancel() { cancelled = true; } });
  await assert.rejects(() => readVisitJson(new Request(url, { method: 'POST', headers, body, duplex: 'half' }), { portal: true }), { status: 413 });
  assert.equal(cancelled, true);
});
test('only same-origin object JSON enters either visit mutation handler', async () => {
  const request = (body, extra = {}) => new Request(url, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.deepEqual(await readVisitJson(request('{"action":"sign_out"}'), { portal: true }), { action: 'sign_out' });
  for (const body of ['[]', 'null', '{']) await assert.rejects(() => readVisitJson(request(body)), { status: 400 });
  await assert.rejects(() => readVisitJson(request('{}', { Origin: 'https://other.invalid' })), { status: 403 });
  await assert.rejects(() => readVisitJson(request('{}', { 'Content-Type': 'text/plain' })), { status: 415 });
});
