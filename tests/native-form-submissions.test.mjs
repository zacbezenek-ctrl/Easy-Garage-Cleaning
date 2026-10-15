import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/highlevel.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { FLAG_OFF_ENV } from './helpers/ghl-track-fixture.mjs';

const FORM = 'DeiRNO6itxjLiTk3Nkj0', CONTACT = 'synthetic-contact';
const row = overrides => ({ id: 'submission-1', formId: FORM, contactId: CONTACT, createdAt: '2026-10-15T03:00:00.000Z',
  name: 'Private Name', email: 'private@example.invalid', others: { phone: 'private-phone', eventData: {
    fbc: 'private-fbc', fbp: 'private-fbp', fbEventId: 'private-event-id', campaignId: 'private-campaign', adSource: 'private-ad', fingerprint: 'private-fingerprint',
  } }, ...overrides });
async function read(t, { user = 'ZacB', query = `contactId=${CONTACT}`, body = { submissions: [row()] }, status = 200, networkError = false, origin = '' } = {}) {
  const calls = [];
  const env = { ...FLAG_OFF_ENV, HUB_AUTH_USERS_JSON: JSON.stringify({
    ZacB: { passwordHash: 'synthetic-zac', role: 'owner' }, tylerg: { passwordHash: 'synthetic-manager', role: 'manager' },
    'synthetic-crew': { passwordHash: 'synthetic-crew', role: 'crew' },
  }) };
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    calls.push({ url: new URL(input), init });
    if (networkError) throw new Error('private provider failure');
    return Response.json(body, { status });
  });
  const cookie = user ? (await createHubSessionCookie(env, user)).split(';')[0] : '';
  const response = await onRequestGet({ env, request: new Request(`https://easygaragecleaning.com/api/highlevel?view=native-form-submissions&${query}`, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
  }) });
  return { status: response.status, body: await response.json(), calls, headers: response.headers };
}

test('native submission diagnostic is owner-only and rejects foreign origins before provider reads', async t => {
  for (const [user, expected] of [[null, 401], ['tylerg', 403], ['synthetic-crew', 403]]) {
    const result = await read(t, { user });
    assert.equal(result.status, expected); assert.equal(result.calls.length, 0);
  }
  const result = await read(t, { origin: 'https://foreign.example' });
  assert.equal(result.status, 403); assert.equal(result.calls.length, 0);
});

test('native submission diagnostic fixes provider scope, uses GET v3 and returns only minimized evidence', async t => {
  const result = await read(t, { query: `contactId=${CONTACT}&formId=other&locationId=other&q=other` });
  assert.equal(result.status, 200); assert.equal(result.calls.length, 1);
  const { url, init } = result.calls[0];
  assert.equal(url.origin + url.pathname, 'https://services.leadconnectorhq.com/forms/submissions');
  assert.deepEqual(Object.fromEntries(url.searchParams), { locationId: 'location-1', formId: FORM, q: CONTACT, limit: '100' });
  assert.equal(init.method, 'GET'); assert.equal(init.headers.Version, 'v3');
  assert.equal(init.headers.Authorization, 'Bearer synthetic-ghl-key'); assert.equal(init.body, undefined);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(result.body.submissions, [{ id: 'submission-1', formId: FORM, contactId: CONTACT, createdAt: '2026-10-15T03:00:00.000Z',
    otherKeys: ['eventData', 'phone'], attribution: { eventDataAvailable: true, fbcAvailable: true, fbpAvailable: true,
      fbEventIdAvailable: true, campaignMetadataAvailable: true, adMetadataAvailable: true } }]);
  assert.doesNotMatch(JSON.stringify(result.body), /private|synthetic-ghl-key|fingerprint/);
});

test('broad provider search results never expose a different form or contact', async t => {
  const result = await read(t, { body: { submissions: [row({ formId: 'other' }), row({ contactId: 'other' }), row({ others: {} })], meta: { nextPage: 2 } } });
  assert.equal(result.status, 200); assert.equal(result.body.submissions.length, 1); assert.equal(result.body.moreAvailable, true);
  assert.deepEqual(result.body.submissions[0].attribution, { eventDataAvailable: false, fbcAvailable: false, fbpAvailable: false,
    fbEventIdAvailable: false, campaignMetadataAvailable: false, adMetadataAvailable: false });
});

test('invalid contact selectors fail closed without provider calls', async t => {
  for (const query of ['', 'contactId=', 'contactId=a&contactId=b', 'contactId=%2Fcontacts', `contactId=${'a'.repeat(181)}`]) {
    const result = await read(t, { query });
    assert.equal(result.status, 400); assert.equal(result.calls.length, 0);
  }
});

test('malformed provider responses and rows fail closed', async t => {
  for (const body of [{}, { submissions: {} }, { submissions: Array(101).fill(row()) }, { submissions: [null] },
    { submissions: [row({ contactId: undefined })] }, { submissions: [row({ id: undefined })] },
    { submissions: [row({ createdAt: 'invalid' })] }, { submissions: [row({ others: [] })] }, { submissions: [row({ others: { eventData: 'private' } })] }]) {
    const result = await read(t, { body }); assert.equal(result.status, 424); assert.equal(result.body.submissions, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /private/);
  }
});

test('provider failure exposes status only, never error detail or credential', async t => {
  for (const status of [401, 403, 429, 503]) {
    const result = await read(t, { status, body: { message: 'private failure synthetic-ghl-key' } });
    assert.deepEqual(result.body, { ok: false, error: 'Native form submissions are unavailable.', providerStatus: status });
    assert.equal(result.status, 424);
  }
  const result = await read(t, { networkError: true });
  assert.deepEqual(result.body, { ok: false, error: 'Native form submissions are unavailable.' });
});
