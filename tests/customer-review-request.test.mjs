import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from './helpers/vm-realm.mjs';
import { readJob } from '../functions/_lib/firestore-job.js';
import { customerReviewUrl } from '../functions/api/customer-portal.js';
import { NOW, env, portalStore, portalCookie, portalHandlers, portalView, portalPost, portalScript, fakeDom } from './helpers/portal-fixture.mjs';

const html = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
const DEFAULT_URL = 'https://search.google.com/local/writereview?placeid=ChIJ17AGfBiyRIsRyJ3k4mDtX8Q';
const job = extra => ({ type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', address: '100 Synthetic Street', serviceType: 'Garage Turnaround', total: 600, status: 'scheduled', ...extra });
const paid = { payment: { amount: 600, verified: true } };
const done = extra => job({ status: 'completed', completedAt: '2026-09-22T16:00:00Z', ...paid, ...extra });
const click = (id = randomUUID()) => ({ action: 'record_review_click', request_id: id });

test('the review card stays hidden until the job is both completed and paid', async t => {
  const cases = {
    scheduled: [job(paid), false],
    arrived: [job({ status: 'arrived', ...paid }), false],
    inProgress: [job({ status: 'in_progress', startedAt: '2026-09-22T15:00:00Z', ...paid }), false],
    completedUnpaid: [job({ status: 'completed' }), false],
    completedPartial: [job({ status: 'completed', payment: { amount: 300, verified: true } }), false],
    completedUnverified: [job({ status: 'completed', payment: { amount: 600, verified: false, stripeSessions: [] } }), false],
    pipelinePaidWithBalance: [job({ status: 'paid', payment: { amount: 100, verified: true } }), false],
    zeroTotal: [job({ status: 'completed', total: 0 }), false],
    completedPaid: [done(), true],
    reviewRequestedPaid: [done({ status: 'review_requested' }), true],
    paidStage: [done({ status: 'paid' }), true],
  };
  portalStore(t, Object.fromEntries(Object.entries(cases).map(([id, [value]]) => [id, value])));
  const handlers = portalHandlers();
  for (const [id, [, eligible]] of Object.entries(cases)) {
    const view = await portalView(handlers, await portalCookie(id));
    assert.equal(view.status, 200, id);
    assert.equal(view.body.review.eligible, eligible, id);
    assert.equal(view.body.review.url, eligible ? DEFAULT_URL : '', `${id}: the link is only shown after completion`);
  }
});

test('the configured https review URL is used and anything else falls back to the default place', async t => {
  assert.equal(customerReviewUrl({}), DEFAULT_URL);
  assert.equal(customerReviewUrl({ GOOGLE_REVIEW_URL: 'https://g.page/r/SyntheticPlace/review' }), 'https://g.page/r/SyntheticPlace/review');
  for (const value of ['http://g.page/r/SyntheticPlace/review', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:secret@g.page/r/x', '//g.page/r/x', 'not a url', `https://g.page/${'x'.repeat(600)}`, '   ']) {
    assert.equal(customerReviewUrl({ GOOGLE_REVIEW_URL: value }), DEFAULT_URL, value);
  }
  portalStore(t, { 'job-1': done() });
  const configured = await portalView(portalHandlers(), await portalCookie(), { ...env, GOOGLE_REVIEW_URL: 'https://g.page/r/SyntheticPlace/review' });
  assert.equal(configured.body.review.url, 'https://g.page/r/SyntheticPlace/review');
  const unsafe = await portalView(portalHandlers(), await portalCookie(), { ...env, GOOGLE_REVIEW_URL: 'javascript:alert(document.cookie)' });
  assert.equal(unsafe.body.review.url, DEFAULT_URL);
});

test('a review click is recorded once per request id and sends nothing', async t => {
  const f = portalStore(t, { 'job-1': done({ reviewStatus: 'requested', reviewRequestedAt: '2026-09-22T16:30:00Z' }) });
  const handlers = portalHandlers(), cookie = await portalCookie(), id = randomUUID();
  const first = await portalPost(handlers, cookie, click(id));
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, recorded: true, duplicate: false });
  const replay = await portalPost(handlers, cookie, click(id.toUpperCase()));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.duplicate, true);
  let saved = f.job('job-1');
  assert.equal(saved.reviewClicks.length, 1);
  assert.deepEqual(saved.reviewClicks[0], { requestId: id, clickedAt: NOW, viewer: 'customer' });
  assert.equal(saved.reviewClickCount, 1);
  assert.equal(saved.reviewClickedAt, NOW);
  assert.equal(saved.reviewLastClickedAt, NOW);
  assert.equal(saved.reviewStatus, 'requested', 'the staff review-request state is left untouched');
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0].fields.sort(), ['reviewClickCount', 'reviewClickedAt', 'reviewClicks', 'reviewLastClickedAt']);
  assert.match(f.writes[0].precondition, /^2026-09-22T/);
  const later = '2026-09-23T15:00:00.000Z';
  assert.equal((await portalPost(portalHandlers(later), cookie, click())).status, 200);
  saved = f.job('job-1');
  assert.equal(saved.reviewClickCount, 2);
  assert.equal(saved.reviewClickedAt, NOW, 'the first visit time is kept');
  assert.equal(saved.reviewLastClickedAt, later);
  assert.equal(f.calls.every(call => call.host === 'firestore.googleapis.com'), true, 'no provider, SMS or email call is made');
});

test('review clicks are refused before completion and without a valid request id', async t => {
  const f = portalStore(t, { early: job({ status: 'in_progress', startedAt: '2026-09-22T15:00:00Z', ...paid }), unpaid: job({ status: 'completed' }), ready: done() });
  const handlers = portalHandlers();
  for (const id of ['early', 'unpaid']) {
    const refused = await portalPost(handlers, await portalCookie(id), click());
    assert.equal(refused.status, 409, id);
    assert.equal(refused.body.code, 'CUSTOMER_PORTAL_REVIEW_NOT_READY');
  }
  for (const request_id of [undefined, '', 'review-1', 'not-a-uuid-at-all-1234567890', 42, { id: randomUUID() }]) {
    const invalid = await portalPost(handlers, await portalCookie('ready'), { action: 'record_review_click', request_id });
    assert.equal(invalid.status, 400, String(request_id));
    assert.equal(invalid.body.code, 'CUSTOMER_PORTAL_REQUEST_INVALID');
  }
  assert.equal(f.writes.length, 0);
});

test('a click racing another job update is retried on the fresh revision exactly once', async t => {
  const f = portalStore(t, { 'job-1': done() });
  let edited = false;
  const handlers = portalHandlers(NOW, { read: async (testEnv, id) => { const row = await readJob(testEnv, id); if (!edited) { edited = true; f.edit('job-1', { customerPhotoCount: 2 }); } return row; } });
  const result = await portalPost(handlers, await portalCookie(), click());
  assert.equal(result.status, 200);
  assert.equal(result.body.recorded, true);
  assert.equal(f.rejected.length, 1, 'the first write carried the stale revision');
  assert.equal(f.writes.length, 1);
  const saved = f.job('job-1');
  assert.equal(saved.customerPhotoCount, 2, 'the concurrent update is preserved');
  assert.equal(saved.reviewClicks.length, 1);
});

test('a replay that lands after a conflict is recognised on the fresh read', async t => {
  const id = randomUUID(), f = portalStore(t, { 'job-1': done() });
  let edited = false;
  // Another request with the same id wins between our read and our write.
  const handlers = portalHandlers(NOW, { read: async (testEnv, jobId) => { const row = await readJob(testEnv, jobId); if (!edited) { edited = true; f.edit('job-1', { reviewClicks: [{ requestId: id, clickedAt: NOW, viewer: 'customer' }], reviewClickCount: 1, reviewClickedAt: NOW, reviewLastClickedAt: NOW }); } return row; } });
  const result = await portalPost(handlers, await portalCookie(), click(id));
  assert.equal(result.status, 200);
  assert.equal(result.body.duplicate, true);
  assert.equal(f.writes.length, 0);
  assert.equal(f.job('job-1').reviewClickCount, 1);
});

test('repeat visits inside a minute are noted once per viewer so the count cannot be inflated', async t => {
  const person = { id: 'person-1', name: 'Synthetic Person', email: 'person@example.invalid', status: 'active', permissions: { view: true, decide: false, pay: false, rebook: false } };
  const f = portalStore(t, { 'job-1': done({ customerCollaborators: [person] }) });
  const cookie = await portalCookie(), collaborator = await portalCookie('job-1', { actorId: 'person-1', permissions: person.permissions });
  assert.equal((await portalPost(portalHandlers(), cookie, click())).body.recorded, true);
  for (const at of [NOW, '2026-09-22T18:00:00.500Z', '2026-09-22T18:00:59.999Z']) {
    const again = await portalPost(portalHandlers(at), cookie, click());
    assert.equal(again.status, 200, at);
    assert.deepEqual(again.body, { ok: true, recorded: false, duplicate: false }, at);
  }
  assert.equal(f.writes.length, 1, 'fresh request ids inside the window do not touch the job');
  assert.equal((await portalPost(portalHandlers('2026-09-22T18:00:30.000Z'), collaborator, click())).body.recorded, true, 'another viewer in the same minute is still noted');
  assert.equal((await portalPost(portalHandlers('2026-09-22T18:00:45.000Z'), collaborator, click())).body.recorded, false);
  assert.equal((await portalPost(portalHandlers('2026-09-22T18:01:00.000Z'), cookie, click())).body.recorded, true, 'the window reopens after a minute');
  const saved = f.job('job-1');
  assert.equal(saved.reviewClickCount, 3);
  assert.deepEqual(saved.reviewClicks.map(item => [item.viewer, item.clickedAt]), [['customer', NOW], ['collaborator', '2026-09-22T18:00:30.000Z'], ['customer', '2026-09-22T18:01:00.000Z']]);
  assert.equal(f.writes.length, 3);
});

test('a burst of concurrent taps with fresh ids writes the job once', async t => {
  const f = portalStore(t, { 'job-1': done() });
  let arrived = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  // Every request reads the same revision before any of them writes.
  const handlers = portalHandlers(NOW, { read: async (testEnv, id) => { const row = await readJob(testEnv, id); if (++arrived === 5) release(); await barrier; return row; } });
  const cookie = await portalCookie();
  const results = await Promise.all(Array.from({ length: 5 }, () => portalPost(handlers, cookie, click())));
  assert.deepEqual(results.map(result => result.status), [200, 200, 200, 200, 200]);
  assert.equal(results.filter(result => result.body.recorded).length, 1);
  assert.equal(f.rejected.length, 4, 'the losers hit a real precondition failure and re-read');
  assert.equal(f.writes.length, 1);
  assert.equal(f.job('job-1').reviewClickCount, 1);
});

test('collaborators and viewers are attributed without exposing other data', async t => {
  const person = { id: 'person-1', name: 'Synthetic Person', email: 'person@example.invalid', status: 'active', permissions: { view: true, decide: false, pay: false, rebook: false } };
  const f = portalStore(t, { 'job-1': done({ customerCollaborators: [person] }) });
  const cookie = await portalCookie('job-1', { actorId: 'person-1', permissions: person.permissions });
  const view = await portalView(portalHandlers(), cookie);
  assert.equal(view.body.review.eligible, true, 'view-only people may still see the review link');
  assert.equal((await portalPost(portalHandlers(), cookie, click())).status, 200);
  assert.deepEqual(f.job('job-1').reviewClicks.map(({ viewer, actorId }) => ({ viewer, actorId })), [{ viewer: 'collaborator', actorId: 'person-1' }]);
  assert.equal(JSON.stringify(view.body).includes('reviewClicks'), false, 'click history stays staff-side');
});

test('the portal renders the review link only when eligible and only for https', () => {
  const dom = fakeDom(), context = { $: dom.node, URL };
  vm.runInNewContext(portalScript(html, ['function renderReview(']), context);
  const card = dom.node('review-referral'), link = dom.node('review-link');
  card.classList.add('hidden');
  context.renderReview({ appointment: { status: 'completed' }, review: { eligible: false, url: '' } });
  assert.equal(card.classList.contains('hidden'), true);
  assert.equal(link.hasAttribute('href'), false);
  context.renderReview({ review: { eligible: true, url: 'https://g.page/r/SyntheticPlace/review' } });
  assert.equal(card.classList.contains('hidden'), false);
  assert.equal(link.href, 'https://g.page/r/SyntheticPlace/review');
  for (const url of ['javascript:alert(1)', 'http://g.page/r/x', 'https://user:pass@g.page/r/x', '']) {
    context.renderReview({ review: { eligible: true, url } });
    assert.equal(card.classList.contains('hidden'), true, url);
    assert.equal(link.hasAttribute('href'), false, url);
  }
  context.renderReview({});
  assert.equal(card.classList.contains('hidden'), true, 'older payloads without review data keep the card hidden');
  assert.doesNotMatch(html, /writereview\?placeid=/, 'the review URL comes from server config only');
  assert.match(html, /id="review-link" target="_blank" rel="noopener noreferrer"/);
});

test('clicking the review link records one request id and retries only network failures', async () => {
  const run = async ({ eligible = true, preview = false, failures = [] } = {}) => {
    const dom = fakeDom(), calls = [];
    const context = {
      $: dom.node, crypto: globalThis.crypto, localPreview: preview,
      portalData: { review: { eligible } },
      api: async body => { calls.push(body); const failure = failures.shift(); if (failure) throw failure; return { ok: true }; },
    };
    vm.runInNewContext(portalScript(html, ['function reviewRequestId(', "$('review-link').addEventListener('click'"]), context);
    dom.node('review-link').listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    return calls;
  };
  const once = await run();
  assert.equal(once.length, 1);
  assert.equal(once[0].action, 'record_review_click');
  assert.match(once[0].request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal((await run({ eligible: false })).length, 0);
  assert.equal((await run({ preview: true })).length, 0);
  const retried = await run({ failures: [new TypeError('Synthetic network failure')] });
  assert.equal(retried.length, 2);
  assert.equal(retried[0].request_id, retried[1].request_id, 'the retry is idempotent');
  assert.equal((await run({ failures: [Object.assign(new Error('Not ready'), { code: 'CUSTOMER_PORTAL_REVIEW_NOT_READY' })] })).length, 1);
});

test('the fallback request id generator produces RFC 4122 v4 ids', () => {
  const context = { crypto: { getRandomValues: array => globalThis.crypto.getRandomValues(array) } };
  vm.runInNewContext(portalScript(html, ['function reviewRequestId(']), context);
  const ids = new Set(Array.from({ length: 50 }, () => context.reviewRequestId()));
  assert.equal(ids.size, 50);
  for (const value of ids) assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('staff see the review request state on the communication board', () => {
  const line = suite.split('\n').find(item => item.startsWith('function reviewRequestState('));
  assert.ok(line);
  const context = {};
  vm.runInNewContext(line, context);
  const state = context.reviewRequestState;
  assert.equal(state({}), '');
  assert.equal(state({ reviewStatus: 'requested', reviewRequestedAt: '2026-09-22T16:30:00Z' }), 'Review requested Sep 22 · link not opened yet');
  assert.equal(state({ communicationLog: [{ event: 'review-requested', status: 'needs_attention', attemptedAt: '2026-09-20T16:00:00Z' }] }), '', 'a failed trigger is not a request');
  assert.equal(state({ communicationLog: [{ event: 'review-requested', status: 'triggered', attemptedAt: '2026-09-21T16:00:00Z' }] }), 'Review requested Sep 21 · link not opened yet');
  assert.equal(state({ reviewRequestedAt: '2026-09-22T16:30:00Z', reviewClickedAt: '2026-09-23T03:00:00Z', reviewLastClickedAt: '2026-09-23T03:00:00Z', reviewClickCount: 1 }), 'Review requested Sep 22 · Customer opened review link Sep 22');
  assert.equal(state({ reviewClickedAt: '2026-09-23T15:00:00Z', reviewLastClickedAt: '2026-09-24T15:00:00Z', reviewClickCount: 3 }), 'Customer opened review link Sep 24 (3 visits)');
  const board = suite.slice(suite.indexOf('function communicationBoard('), suite.indexOf('\n', suite.indexOf('function communicationBoard(')));
  assert.match(board, /review=reviewRequestState\(j\)/);
  assert.match(board, /\$\{review\?`<p>\$\{esc\(review\)\}<\/p>`:''\}/, 'staff text is escaped');
});
