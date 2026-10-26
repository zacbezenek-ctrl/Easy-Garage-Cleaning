import test from 'node:test';
import assert from 'node:assert/strict';
import { RENDER_LIMIT, garageRenderHandlers } from '../functions/api/garage-render.js';
import { RATE_LIMITS } from '../functions/_lib/rate-limit.js';
import { memory } from './helpers/customer-login-fixture.mjs';

const NOW = '2026-09-22T15:00:00.000Z';
const env = { HUB_SESSION_SECRET: 'synthetic-garage-render-secret-0123456789abcdef', openaiapi: 'synthetic-openai-key' };
const at = ms => new Date(Date.parse(NOW) + ms);
const photo = 'data:image/png;base64,AAAA';
const request = body => new Request('https://easygaragecleaning.com/api/garage-render', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function harness({ user = 'Synthetic.Estimator', store = memory({}) } = {}) {
  const state = { store, calls: 0, user, clock: at(0) };
  const openai = async () => { state.calls += 1; return Response.json({ data: [{ b64_json: 'AAAA' }] }); };
  state.post = garageRenderHandlers({ session: async () => state.user ? { user: state.user } : null, storage: () => store, openai, now: () => state.clock }).post;
  state.render = async (body = { image: photo }) => state.post({ request: request(body), env });
  return state;
}

test('each Hub account gets 20 renders in any 24 hours; the next one never reaches OpenAI', async () => {
  const h = harness();
  assert.equal(RENDER_LIMIT.limit, 20);
  for (let index = 0; index < RENDER_LIMIT.limit; index += 1) {
    h.clock = at(index * 60000);
    assert.equal((await h.render()).status, 200, `render ${index + 1}`);
  }
  assert.equal(h.calls, 20);
  h.clock = at(23 * 3600000);
  const denied = await h.render();
  assert.equal(denied.status, 429);
  const body = await denied.json();
  assert.equal(body.code, 'RENDER_LIMIT');
  assert.equal(body.resetAt, at(86400000).toISOString(), 'a slot opens 24 hours after the earliest render');
  assert.equal(h.calls, 20, 'a denied render costs nothing');
  h.clock = at(86400000);
  assert.equal((await h.render()).status, 200, 'the earliest render has left the 24-hour window');
  assert.equal(h.calls, 21);
});

test('the cap is per account, and a malformed request does not use one up', async () => {
  const store = memory({}), first = harness({ store }), second = harness({ store, user: 'Synthetic.Other' });
  for (let index = 0; index < RENDER_LIMIT.limit; index += 1) await first.render();
  assert.equal((await first.render()).status, 429);
  assert.equal((await second.render({ hint: 'no photo' })).status, 400);
  const counters = [...store.rows].filter(([key]) => key.startsWith(`${RATE_LIMITS}/`));
  assert.equal(counters.length, 1, 'only the first account has a counter');
  assert.equal((await second.render()).status, 200, 'another account still renders');
  assert.ok([...store.rows].every(([, row]) => !JSON.stringify(row).includes('synthetic.')), 'the counter never stores the account name');
});

test('when the count cannot be read, nothing is sent to OpenAI', async () => {
  const h = harness();
  h.store.hooks.failRead = () => true;
  const response = await h.render();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'RENDER_LIMIT_UNAVAILABLE');
  assert.equal(h.calls, 0);
});

test('without a Hub session nothing is counted or sent', async () => {
  const h = harness({ user: '' });
  assert.equal((await h.render()).status, 401);
  assert.equal(h.calls, 0);
  assert.equal(h.store.commits.length, 0);
});
