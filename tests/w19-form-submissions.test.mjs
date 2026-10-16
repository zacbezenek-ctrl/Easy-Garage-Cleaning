import test from 'node:test';
import assert from 'node:assert/strict';
import { readW19CustomerEmail, readW19Opportunity, readW19Submission, W19_FORM_ID } from '../functions/_lib/w19-form-submissions.js';

const env = { HIGHLEVEL_API_KEY: 'private-provider-token', HIGHLEVEL_LOCATION_ID: 'location-1' };
const bindings = { submissionId: 'submission-1', contactId: 'contact-1', locationId: 'location-1', jobId: 'job-1',
  reference: 'opaque_completion_reference_123456', issuedAt: '2026-10-15T09:00:00.000Z', expiresAt: '2026-10-22T09:00:00.000Z',
  fieldIds: { jobId: 'verified-job-field-id', reference: 'verified-reference-field-id' } };
const row = overrides => ({ id: bindings.submissionId, contactId: bindings.contactId, formId: W19_FORM_ID,
  createdAt: '2026-10-15T09:10:00.000Z', name: 'private name', email: 'private@example.invalid',
  others: { [bindings.fieldIds.jobId]: bindings.jobId, [bindings.fieldIds.reference]: bindings.reference, unrelated: 'private notes' }, ...overrides });
const page = (rows = [row()], meta = {}) => ({ submissions: rows, meta: { total: rows.length, currentPage: 1, nextPage: null, prevPage: null, ...meta } });
function fetchPages(bodies, calls = []) {
  return async (url, init) => {
    calls.push({ url: new URL(url), init });
    const body = bodies[calls.length - 1];
    assert.notEqual(body, undefined, 'Unexpected extra provider request');
    return body instanceof Response ? body : Response.json(body);
  };
}
async function rejectsCode(promise, code, status = 503) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code); assert.equal(error.status, status);
    assert.doesNotMatch(JSON.stringify(error) + error.message, /private|Bearer|provider-token|opaque_completion/);
    return true;
  });
}

test('W19 receipt verification uses only the known native form and minimizes the result', async () => {
  const calls = [];
  const receipt = await readW19Submission(env, bindings, fetchPages([page()], calls));
  assert.deepEqual(receipt, { submissionId: bindings.submissionId, formId: '7HCRlKJs4VZx4KwNmDa6', contactId: bindings.contactId,
    locationId: bindings.locationId, jobId: bindings.jobId, reference: bindings.reference, createdAt: row().createdAt });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url.origin + url.pathname, 'https://services.leadconnectorhq.com/forms/submissions');
  assert.deepEqual(Object.fromEntries(url.searchParams), { locationId: 'location-1', formId: W19_FORM_ID, q: 'contact-1',
    page: '1', limit: '100', startAt: '2026-10-14', endAt: '2026-10-23' });
  assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error');
  assert.deepEqual(init.headers, { Accept: 'application/json', Authorization: 'Bearer private-provider-token', Version: 'v3' });
  assert.ok(init.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(receipt), /private|email|notes|token/);
});

test('broad search is filtered by exact receipt ID across a complete bounded pagination', async () => {
  const calls = [];
  const others = Array.from({ length: 100 }, (_, i) => row({ id: `unrelated-${i}`, formId: 'another-form', contactId: 'another-contact' }));
  const receipt = await readW19Submission(env, bindings, fetchPages([
    page(others, { total: 101, nextPage: 2 }),
    page([row()], { total: 101, currentPage: 2, prevPage: 1 }),
  ], calls));
  assert.equal(receipt.submissionId, bindings.submissionId);
  assert.equal(calls.length, 2); assert.equal(calls[1].url.searchParams.get('page'), '2');
});

test('an exact ID must match every canonical binding and the exact timestamp window', async () => {
  const changes = [{ formId: 'intake-form' }, { contactId: 'another-contact' }, { locationId: 'another-location' },
    { others: { ...row().others, [bindings.fieldIds.jobId]: 'another-job' } },
    { others: { ...row().others, [bindings.fieldIds.reference]: 'another_completion_reference' } },
    { others: { ...row().others, [bindings.fieldIds.jobId]: ['job-1'] } },
    { others: { ...row().others, [bindings.fieldIds.reference]: 123456 } },
    { others: {} }, { createdAt: '2026-10-15T08:59:59.999Z' }, { createdAt: '2026-10-22T09:00:00.001Z' }];
  for (const change of changes) {
    await rejectsCode(readW19Submission(env, bindings, fetchPages([page([row(change)])])), 'w19-submission-mismatch', 409);
  }
  for (const createdAt of [bindings.issuedAt, bindings.expiresAt, '2026-10-15T03:10:00-06:00']) {
    const receipt = await readW19Submission(env, bindings, fetchPages([page([row({ createdAt, locationId: 'location-1' })])]));
    assert.equal(receipt.createdAt, new Date(createdAt).toISOString());
  }
});

test('missing selected receipt remains pending only after a complete response', async () => {
  await rejectsCode(readW19Submission(env, bindings, fetchPages([page([])])), 'w19-submission-pending', 409);
  await rejectsCode(readW19Submission(env, bindings, fetchPages([page([row({ id: 'different-receipt' })])])), 'w19-submission-pending', 409);
});

test('reference lookup without a receipt ID requires exact bindings and returns the actual provider ID', async () => {
  const input = { ...bindings, submissionId: undefined };
  const partial = [row({ id: 'wrong-form', formId: 'another-form' }), row({ id: 'wrong-contact', contactId: 'another-contact' }),
    row({ id: 'wrong-location', locationId: 'another-location' }),
    row({ id: 'wrong-job', others: { ...row().others, [bindings.fieldIds.jobId]: 'another-job' } }),
    row({ id: 'wrong-reference', others: { ...row().others, [bindings.fieldIds.reference]: 'another-completion-reference' } }),
    row({ id: 'untrusted-answers', others: { jobId: bindings.jobId, reference: bindings.reference } }),
    row({ id: 'array-answer', others: { ...row().others, [bindings.fieldIds.jobId]: [bindings.jobId] } }),
    row({ id: 'before-window', createdAt: '2026-10-15T08:59:59.999Z' }),
    row({ id: 'after-window', createdAt: '2026-10-22T09:00:00.001Z' })];
  const receipt = await readW19Submission(env, input, fetchPages([page([...partial, row({ id: 'actual-provider-receipt' })])]));
  assert.equal(receipt.submissionId, 'actual-provider-receipt');
  assert.equal(receipt.reference, bindings.reference);
  await rejectsCode(readW19Submission(env, input, fetchPages([page(partial)])), 'w19-submission-pending', 409);
  await rejectsCode(readW19Submission(env, input, fetchPages([page([])])), 'w19-submission-pending', 409);
});

test('reference lookup chooses stable earliest timestamp and ID after complete exact matching', async () => {
  const matching = [row({ id: 'earlier-provider-receipt' }), row({ id: 'later-provider-receipt', createdAt: '2026-10-15T10:00:00.000Z' }),
    row({ id: 'a-earlier-tiebreak', createdAt: '2026-10-15T03:10:00-06:00' })];
  for (const rows of [matching, [...matching].reverse()]) {
    const result = await readW19Submission(env, { ...bindings, submissionId: undefined }, fetchPages([page(rows)]));
    assert.equal(result.submissionId, 'a-earlier-tiebreak');
  }
  // A supplied immutable receipt ID continues to select only that exact row.
  const result = await readW19Submission(env, { ...bindings, submissionId: 'later-provider-receipt' }, fetchPages([page(matching)]));
  assert.equal(result.submissionId, 'later-provider-receipt');
});

test('reference lookup scans the complete bounded window and preserves strict pagination before accepting', async () => {
  const input = { ...bindings, submissionId: undefined }, calls = [];
  const partial = Array.from({ length: 100 }, (_, i) => row({ id: `partial-${i}`, contactId: 'another-contact' }));
  const bodies = [page(partial, { total: 101, nextPage: 2 }), page([row({ id: 'provider-page-two' })], { total: 101, currentPage: 2, prevPage: 1 })];
  const result = await readW19Submission(env, input, fetchPages(bodies, calls));
  assert.equal(result.submissionId, 'provider-page-two'); assert.equal(calls.length, 2);
  const first = [...partial]; first[0] = row({ id: 'provider-page-one', createdAt: '2026-10-15T10:00:00.000Z' });
  const earliest = await readW19Submission(env, input, fetchPages([
    page(first, { total: 101, nextPage: 2 }), bodies[1],
  ]));
  assert.equal(earliest.submissionId, 'provider-page-two');
  await rejectsCode(readW19Submission(env, input, fetchPages([page([row()], { total: 2 })])), 'w19-provider-unavailable');
  await rejectsCode(readW19Submission(env, input, fetchPages([page([row()], { nextPage: 2 })])), 'w19-provider-unavailable');
});

test('invalid caller bindings or unavailable configuration never query the provider', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new Error('must not call'); };
  for (const change of [{ submissionId: '' }, { submissionId: null }, { contactId: '../contact' }, { locationId: 1 }, { jobId: null },
    { reference: 'too-short' }, { issuedAt: '2026-10-15' }, { expiresAt: bindings.issuedAt },
    { fieldIds: undefined }, { fieldIds: { jobId: 'field', reference: 'field' } },
    { fieldIds: { jobId: 'field', reference: { id: 'reference' } } }]) {
    await rejectsCode(readW19Submission(env, { ...bindings, ...change }, fetcher), 'w19-invalid-input', 400);
  }
  for (const config of [{}, { ...env, HIGHLEVEL_API_KEY: ' ' }, { ...env, HIGHLEVEL_LOCATION_ID: 'another-location' }]) {
    await rejectsCode(readW19Submission(config, bindings, fetcher), 'w19-configuration');
  }
  const receipt = await readW19Submission({ GHL_API_KEY: 'private-provider-token', GHL_LOCATION_ID: 'location-1' }, bindings, fetchPages([page()]));
  assert.equal(receipt.locationId, 'location-1');
  assert.equal(calls, 0);
});

test('incomplete, repeated, inconsistent, and invalid pagination fails closed even after finding the receipt', async () => {
  for (const meta of [{ total: 2 }, { currentPage: 2 }, { nextPage: 1 }, { nextPage: '2' }, { nextPage: undefined },
    { total: 501 }, { total: -1 }, { total: '1' }, { total: 1.5 }, { prevPage: 0 }, { total: 2, nextPage: 2 }]) {
    await rejectsCode(readW19Submission(env, bindings, fetchPages([page([row()], meta)])), 'w19-provider-unavailable');
  }
  const first = Array.from({ length: 100 }, (_, i) => row({ id: i === 0 ? bindings.submissionId : `row-${i}` }));
  for (const second of [
    page([row()], { total: 101, currentPage: 2, prevPage: 1 }),
    page([row({ id: 'row-100' })], { total: 102, currentPage: 2, prevPage: 1 }),
    page([row({ id: 'row-100' })], { total: 101, currentPage: 1, prevPage: 1 }),
  ]) {
    await rejectsCode(readW19Submission(env, bindings, fetchPages([page(first, { total: 101, nextPage: 2 }), second])), 'w19-provider-unavailable');
  }
  const repeated = page([row(), row()]);
  await rejectsCode(readW19Submission(env, bindings, fetchPages([repeated])), 'w19-provider-unavailable');
});

test('search never follows more than five pages or accepts a cap as a verified receipt', async () => {
  const calls = [];
  const bodies = Array.from({ length: 5 }, (_, p) => page(Array.from({ length: 100 }, (_, i) => row({ id: `page-${p}-row-${i}` })),
    { total: 500, currentPage: p + 1, nextPage: p + 2, prevPage: p === 0 ? null : p }));
  await rejectsCode(readW19Submission(env, bindings, fetchPages(bodies, calls)), 'w19-provider-unavailable');
  assert.equal(calls.length, 5);
});

test('malformed provider shapes or selected data are unavailable rather than verified', async () => {
  const invalid = [null, [], {}, { ...page(), meta: undefined }, { ...page(), submissions: {} },
    { ...page(), locationId: 'another-location' },
    page(Array(101).fill(row())), page([null]), page([row({ id: null })]), page([row({ contactId: 1 })]),
    page([row({ formId: undefined })]), page([row({ createdAt: 'yesterday' })]), page([row({ createdAt: '2026-02-30T09:00:00Z' })]),
    page([row({ createdAt: '2026-10-15T09:10:00' })]), page([row({ others: [] })]),
    page([row({ others: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`field-${i}`, 'private'])) })])];
  for (const body of invalid) await rejectsCode(readW19Submission(env, bindings, fetchPages([body])), 'w19-provider-unavailable');
});

test('provider errors, redirects, non-JSON, invalid UTF-8 and bounded bodies expose no provider details', async () => {
  for (const response of [
    ...[401, 403, 429, 500].map(status => Response.json({ error: 'private-provider-token' }, { status })),
    new Response('private', { status: 302, headers: { Location: 'https://untrusted.example' } }),
    new Response(JSON.stringify(page()), { headers: { 'Content-Type': 'text/plain' } }),
    new Response('{ private malformed json', { headers: { 'Content-Type': 'application/json' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    new Response('private', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(512 * 1024 + 1) } }),
    new Response('private', { headers: { 'Content-Type': 'application/json', 'Content-Length': '7' } }),
    new Response('private', { headers: { 'Content-Type': 'application/json', 'Content-Length': '-1' } }),
    new Response('x'.repeat(512 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
  ]) await rejectsCode(readW19Submission(env, bindings, fetchPages([response])), 'w19-provider-unavailable');
  await rejectsCode(readW19Submission(env, bindings, async () => { throw new Error('private-provider-token'); }), 'w19-provider-unavailable');
});

test('provider GET and body read have a deadline, aborting and cancelling a stalled stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, canceled = false;
  const stream = new ReadableStream({ cancel() { canceled = true; } });
  const promise = readW19Submission(env, bindings, async (_url, init) => {
    signal = init.signal;
    return new Response(stream, { headers: { 'Content-Type': 'application/json' } });
  });
  const rejected = rejectsCode(promise, 'w19-provider-unavailable');
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(signal.aborted, true); assert.equal(canceled, true);
});

test('a stalled provider GET and stalled cancellation cannot extend the request deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const promise = readW19Submission(env, bindings, (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  });
  const rejected = rejectsCode(promise, 'w19-provider-unavailable');
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(signal.aborted, true);
  const stream = new ReadableStream({ cancel() { return new Promise(() => {}); } });
  const stalledCancel = readW19Submission(env, bindings, async () => new Response(stream, { headers: { 'Content-Type': 'text/plain' } }));
  await rejectsCode(stalledCancel, 'w19-provider-unavailable');
});

const opportunityBindings = { opportunityId: 'canonical-opportunity-1', contactId: 'contact-1', locationId: 'location-1' };
const opportunityBody = overrides => ({ opportunity: { id: opportunityBindings.opportunityId, contactId: 'contact-1', locationId: 'location-1',
  monetaryValue: 99999, name: 'private opportunity', contact: { name: 'private name', email: 'private@example.invalid' }, ...overrides } });

test('linked opportunity verification reads the exact canonical ID and returns only verified bindings', async () => {
  const calls = [];
  const result = await readW19Opportunity(env, opportunityBindings, fetchPages([opportunityBody()], calls));
  assert.deepEqual(result, { id: 'canonical-opportunity-1', contactId: 'contact-1', locationId: 'location-1' });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, 'https://services.leadconnectorhq.com/opportunities/canonical-opportunity-1');
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.body, undefined); assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(calls[0].init.headers, { Accept: 'application/json', Authorization: 'Bearer private-provider-token', Version: 'v3' });
  assert.doesNotMatch(JSON.stringify(result), /private|monetaryValue|name|email|token/);
});

test('linked opportunity exact ID, contact, and location mismatches never become authoritative', async () => {
  for (const change of [{ id: 'another-opportunity' }, { contactId: 'another-contact' }, { locationId: 'another-location' }]) {
    await rejectsCode(readW19Opportunity(env, opportunityBindings, fetchPages([opportunityBody(change)])), 'w19-opportunity-mismatch', 409);
  }
  await rejectsCode(readW19Opportunity(env, opportunityBindings, fetchPages([{ ...opportunityBody(), locationId: 'another-location' }])), 'w19-opportunity-mismatch', 409);
});

test('missing canonical opportunity IDs never fall back to a contact search or any provider request', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new Error('must not call'); };
  for (const input of [undefined, {}, { ...opportunityBindings, opportunityId: '' }, { ...opportunityBindings, opportunityId: '../latest' },
    { ...opportunityBindings, contactId: [] }, { ...opportunityBindings, locationId: null }]) {
    await rejectsCode(readW19Opportunity(env, input, fetcher), 'w19-invalid-input', 400);
  }
  for (const config of [{}, { ...env, HIGHLEVEL_LOCATION_ID: 'another-location' }, { ...env, HIGHLEVEL_API_KEY: '' }]) {
    await rejectsCode(readW19Opportunity(config, opportunityBindings, fetcher), 'w19-configuration');
  }
  assert.equal(calls, 0);
});

test('malformed opportunity schemas and HTTP failures remain unavailable with no response-detail leak', async () => {
  for (const body of [null, [], {}, { opportunities: [opportunityBody().opportunity] }, { opportunity: [] },
    opportunityBody({ id: undefined }), opportunityBody({ contactId: undefined }), opportunityBody({ locationId: undefined }),
    opportunityBody({ id: 123 }), opportunityBody({ contactId: { id: 'contact-1' } }), opportunityBody({ locationId: '../location-1' })]) {
    await rejectsCode(readW19Opportunity(env, opportunityBindings, fetchPages([body])), 'w19-provider-unavailable');
  }
  for (const response of [Response.json({ error: 'private-provider-token' }, { status: 404 }),
    Response.json({ error: 'private-provider-token' }, { status: 503 }),
    new Response('x'.repeat(512 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } })]) {
    await rejectsCode(readW19Opportunity(env, opportunityBindings, fetchPages([response])), 'w19-provider-unavailable');
  }
});

test('linked opportunity provider verification shares the bounded GET deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = readW19Opportunity(env, opportunityBindings, (_url, init) => { signal = init.signal; return new Promise(() => {}); });
  const rejected = rejectsCode(pending, 'w19-provider-unavailable');
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(signal.aborted, true);
});

const customerBindings = { contactId: 'contact-1', locationId: 'location-1' };
const customerBody = overrides => ({ contact: { id: 'contact-1', locationId: 'location-1', email: ' Synthetic.Person+Garage@Example.INVALID ',
  name: 'private name', phone: '+13035551234', customFields: [{ id: 'private-field', value: 'private notes' }], ...overrides } });

test('customer email verification GETs the exact linked contact and returns only normalized bound identity', async () => {
  const calls = [];
  const result = await readW19CustomerEmail(env, customerBindings, fetchPages([customerBody()], calls));
  assert.deepEqual(result, { contactId: 'contact-1', locationId: 'location-1', email: 'synthetic.person+garage@example.invalid' });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, 'https://services.leadconnectorhq.com/contacts/contact-1');
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.body, undefined); assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(calls[0].init.headers, { Accept: 'application/json', Authorization: 'Bearer private-provider-token', Version: 'v3' });
  assert.doesNotMatch(JSON.stringify(result), /private|name|phone|customFields|token/);
  const mailto = await readW19CustomerEmail(env, customerBindings, fetchPages([customerBody({ email: 'mailto:SYNTHETIC@example.invalid' })]));
  assert.equal(mailto.email, 'synthetic@example.invalid');
});

test('customer email verification rejects contact or location mismatches without following another record', async () => {
  for (const body of [customerBody({ id: 'another-contact' }), customerBody({ locationId: 'another-location' }),
    { ...customerBody(), locationId: 'another-location' }]) {
    const calls = [];
    await rejectsCode(readW19CustomerEmail(env, customerBindings, fetchPages([body], calls)), 'w19-customer-mismatch', 409);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, '/contacts/contact-1');
    assert.equal(calls[0].init.method, 'GET');
  }
});

test('invalid customer selectors and configuration never search or write provider contacts', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; throw new Error('must not call'); };
  for (const input of [undefined, {}, { ...customerBindings, contactId: '' }, { ...customerBindings, contactId: '../search' },
    { ...customerBindings, contactId: ['contact-1'] }, { ...customerBindings, locationId: null }]) {
    await rejectsCode(readW19CustomerEmail(env, input, fetcher), 'w19-invalid-input', 400);
  }
  for (const config of [{}, { ...env, HIGHLEVEL_LOCATION_ID: 'another-location' }, { ...env, HIGHLEVEL_API_KEY: '' }]) {
    await rejectsCode(readW19CustomerEmail(config, customerBindings, fetcher), 'w19-configuration');
  }
  assert.equal(calls, 0);
});

test('missing or malformed customer identity and email fail closed without fallback addresses', async () => {
  const malformedEmails = ['', 'broken', 'two@@example.invalid', 'no-domain@', 'spaces in@example.invalid', 'a@b',
    `${'x'.repeat(250)}@example.invalid`, null, 42, [], { email: 'synthetic@example.invalid' }];
  for (const body of [null, [], {}, { contacts: [customerBody().contact] }, { contact: [] },
    customerBody({ id: undefined }), customerBody({ id: 1 }), customerBody({ locationId: undefined }),
    customerBody({ email: undefined, emailLower: 'synthetic@example.invalid', additionalEmails: ['synthetic@example.invalid'] }),
    ...malformedEmails.map(email => customerBody({ email }))]) {
    await rejectsCode(readW19CustomerEmail(env, customerBindings, fetchPages([body])), 'w19-provider-unavailable');
  }
});

test('customer provider failures and oversized bodies expose no contact or credential details', async () => {
  for (const response of [
    ...[401, 403, 404, 429, 503].map(status => Response.json({ error: 'private-provider-token synthetic@example.invalid' }, { status })),
    new Response('x'.repeat(512 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify(customerBody()), { headers: { 'Content-Type': 'text/plain' } }),
  ]) await rejectsCode(readW19CustomerEmail(env, customerBindings, fetchPages([response])), 'w19-provider-unavailable');
  await rejectsCode(readW19CustomerEmail(env, customerBindings, async () => { throw new Error('private contact synthetic@example.invalid'); }), 'w19-provider-unavailable');
});

test('customer email provider GET and body share the bounded deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = readW19CustomerEmail(env, customerBindings, (_url, init) => { signal = init.signal; return new Promise(() => {}); });
  const rejected = rejectsCode(pending, 'w19-provider-unavailable');
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(signal.aborted, true);
  let canceled = false;
  const stream = new ReadableStream({ cancel() { canceled = true; } });
  const pendingBody = readW19CustomerEmail(env, customerBindings, async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }));
  const bodyRejected = rejectsCode(pendingBody, 'w19-provider-unavailable');
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(5000);
  await bodyRejected;
  assert.equal(canceled, true);
});
