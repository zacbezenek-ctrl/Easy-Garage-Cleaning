// Open quotes (office, read only): which estimator quotes are open, their age buckets in Denver days, the per-estimator
// close rate with signed-on-site walkthroughs as same-day closes, business-only access on the server, and the bounded,
// masked reads of GET /api/open-quotes (no jobs scan). Synthetic data only; the clock is injected.
process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUCKETS, OPEN_QUOTE_FIELDS, OPEN_QUOTE_RECEIPT_FIELDS, resigned, bucketOf, buildOpenQuotes, closeEvents, closeRates, daysBetween, draftPricesWaiting, openQuote, openQuotesWindow, quoteClosed, quoteTotalCents } from '../functions/_lib/open-quotes.js';
import { openQuotesHandlers, requireOpenQuotesViewer } from '../functions/api/open-quotes.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { readCompositeState } from '../functions/_lib/catalog-store.js';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';
import { readMeter } from './helpers/read-meter.mjs';

const NOW = new Date('2026-10-21T18:00:00.000Z'), TODAY = '2026-10-21';
const OWNER = { user: 'zacb', role: 'owner', businessAccess: true };
const MANAGER = { user: 'tylerg', role: 'manager', businessAccess: true };
const ESTIMATOR = { user: 'Synthetic.Estimator', role: 'sales', businessAccess: false };
const CREW = { user: 'Synthetic.Crew', role: 'crew', businessAccess: false };
// A quote job as saveQuoteDraft and sendQuoteDraft leave it; sentAt is an ISO time.
const quote = (id, sentAt, { by = 'Est.One', cents = 100000, status = 'sent', validUntil = '2026-12-01', ...extra } = {}) => ({ id, type: 'job', status: 'unscheduled', customer: `Synthetic ${id}`,
  estimate: { status, amountCents: cents, amount: cents / 100, validUntil, sentAt }, quoteStatus: status, quoteDraft: { version: 1, createdBy: by, sentBy: by, sentAt }, ...extra });
const approved = approvedAt => ({ status: 'accepted', customerApproval: { status: 'approved', approvedAt } });
const JOBS = [
  quote('q_expired', '2026-09-01T16:00:00.000Z', { validUntil: '2026-10-01', cents: 90000 }),
  quote('q_cold', '2026-09-30T16:00:00.000Z', { validUntil: '2026-10-30', cents: 410000 }),
  quote('q_cooling', '2026-10-10T16:00:00.000Z', { cents: 120000 }),
  quote('q_warm', '2026-10-15T16:00:00.000Z', { by: 'Est.Two', cents: 180000, pricesPendingApproval: { status: 'pending', reason: 'draft_prices' } }),
  // 05:30 UTC on Oct 19 is 11:30 pm on Oct 18 in Denver: 3 days old, not 2.
  quote('q_boundary', '2026-10-19T05:30:00.000Z', { by: 'Est.Two', cents: 75000 }),
  quote('q_fresh', '2026-10-20T16:00:00.000Z', { cents: 250000 }),
  // Approved in the portal four days after it was sent.
  { ...quote('q_approved', '2026-10-01T16:00:00.000Z'), estimate: { status: 'accepted', amountCents: 100000, sentAt: '2026-10-01T16:00:00.000Z' }, customerApproval: { status: 'approved', approvedAt: '2026-10-05T18:00:00.000Z' } },
  // Revised after it was sent: back to draft, so not open, but it was sent.
  quote('q_revised', '2026-10-12T16:00:00.000Z', { by: 'Est.Two', status: 'draft' }),
  quote('q_cancelled', '2026-10-08T16:00:00.000Z', { by: 'Est.Two', status: 'sent' }),
  // Sent, then signed in person a week later: the handoff replaced the estimate (no sentAt) and kept quoteDraft.
  { ...quote('q_signed_later', '2026-10-02T16:00:00.000Z', { by: 'Est.Two' }), estimate: { status: 'accepted', amountCents: 100000 }, customerApproval: { status: 'approved', approvedAt: '2026-10-09T17:00:00.000Z' } },
  // Sent before the 120-day window: expired and not on the board.
  quote('q_old', '2026-05-01T16:00:00.000Z', { validUntil: '2026-06-01' }),
];
JOBS.find(job => job.id === 'q_cancelled').status = 'cancelled';
const SIGNED = [
  { kind: undefined, actorId: 'Est.Two', jobId: 'sig_one', sourceWalkthroughId: 'walk_one', createdAt: '2026-10-18T20:00:00.000Z' },
  // Re-signed after a revision: one close, on the first signature.
  { actorId: 'Est.One', jobId: 'sig_two', sourceWalkthroughId: 'walk_two', createdAt: '2026-10-12T20:00:00.000Z' },
  { actorId: 'Est.One', jobId: 'sig_two', sourceWalkthroughId: 'walk_two', createdAt: '2026-10-05T20:00:00.000Z' },
  // The in-person signature of a quote that was sent first: counted once, as the sent quote.
  { actorId: 'Est.Two', jobId: 'q_signed_later', sourceWalkthroughId: 'walk_three', createdAt: '2026-10-09T17:00:00.000Z' },
  // Another receipt kind in the same ledger is not a signature.
  { kind: 'prices_release', actorId: 'zacb', jobId: 'sig_three', createdAt: '2026-10-10T20:00:00.000Z' },
];

test('Denver days: the window, day differences and buckets at their edges', () => {
  assert.deepEqual(openQuotesWindow(TODAY), { today: TODAY, start: '2026-06-24', since: '2026-06-24T00:00:00.000Z', last30: '2026-09-22', last90: '2026-07-24' });
  assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2, 'across the end of daylight saving time');
  assert.deepEqual([0, 2, 3, 7, 8, 14, 15, 400].map(age => bucketOf(age, false)), ['fresh', 'fresh', 'warm', 'warm', 'cooling', 'cooling', 'cold', 'cold']);
  assert.equal(bucketOf(1, true), 'expired', 'an expired quote is expired whatever its age');
  assert.deepEqual(BUCKETS.map(bucket => bucket.label), ['0–2 days', '3–7 days', '8–14 days', '15+ days', 'Expired']);
});

test('only a sent, undecided, live estimator quote is open', () => {
  const base = quote('q', '2026-10-10T16:00:00.000Z');
  assert.equal(openQuote(base), true);
  assert.equal(openQuote({ ...base, estimate: { ...base.estimate, status: 'draft' } }), false, 'a revision after the send is a draft again');
  assert.equal(openQuote({ ...base, customerApproval: { status: 'approved' } }), false);
  assert.equal(openQuote({ ...base, customerApproval: { status: 'declined' } }), false);
  assert.equal(openQuote({ ...base, customerApproval: { status: 'superseded' } }), true, 'a superseded approval does not close the resent quote');
  assert.equal(openQuote({ ...base, status: 'cancelled' }), false);
  assert.equal(openQuote({ ...base, quoteDraft: undefined }), false, 'not an estimator quote');
  assert.equal(openQuote({ ...base, recordType: 'lock' }), false);
  assert.equal(openQuote({ ...base, type: 'walkthrough' }), false);
  assert.equal(quoteClosed({ customerApproval: { status: 'superseded' }, estimate: { status: 'draft' } }), false);
  assert.deepEqual([quoteTotalCents({ estimate: { amountCents: 12345 } }), quoteTotalCents({ estimate: { amount: 123.45 } }), quoteTotalCents({ estimate: {} })], [12345, 12345, null]);
});

test('draft prices: a held job, a builder breakdown the owner menu refuses, or unknown when the menu is unreadable', async () => {
  const builder = { quoteDraft: { breakdown: { source: 'composite', lines: [] } } };
  assert.equal(draftPricesWaiting({ pricesPendingApproval: { status: 'pending' } }, null), true);
  assert.equal(draftPricesWaiting({ quoteDraft: {} }, null), false, 'no builder pricing, nothing to approve');
  assert.equal(draftPricesWaiting(builder, null), null, 'unknown without the owner\'s menu');
  // The bundled menu with no owner decisions yet refuses this breakdown (compositeApproval), so its prices wait.
  assert.equal(draftPricesWaiting(builder, await readCompositeState({ read: async () => null })), true);
  assert.equal(draftPricesWaiting(builder, { broken: true }), null, 'a menu compositeApproval cannot read is unknown, not a guess');
});

test('the board: open quotes oldest first, Denver ages, buckets with counts and dollar totals', () => {
  const report = buildOpenQuotes({ jobs: JOBS, signed: SIGNED, today: TODAY, asOf: NOW.toISOString() });
  assert.deepEqual(report.rows.map(row => row.jobId), ['q_expired', 'q_cold', 'q_cooling', 'q_warm', 'q_boundary', 'q_fresh']);
  const row = id => report.rows.find(item => item.jobId === id);
  assert.deepEqual([row('q_boundary').sentDay, row('q_boundary').ageDays, row('q_boundary').bucket], ['2026-10-18', 3, 'warm']);
  assert.deepEqual([row('q_cold').ageDays, row('q_cold').daysLeft, row('q_cold').expired], [21, 9, false]);
  assert.deepEqual([row('q_expired').bucket, row('q_expired').daysLeft], ['expired', null]);
  assert.equal(row('q_warm').draftPricesWaiting, true);
  assert.equal(row('q_fresh').estimator, 'Est.One');
  assert.deepEqual(report.buckets.map(bucket => [bucket.id, bucket.count, bucket.totalCents]),
    [['fresh', 1, 250000], ['warm', 2, 255000], ['cooling', 1, 120000], ['cold', 1, 410000], ['expired', 1, 90000]]);
  assert.deepEqual(report.totals, { count: 6, totalCents: 1125000, unpricedCount: 0 });
});

test('close rate per estimator: sent quotes plus same-day on-site signatures, each job once', () => {
  const report = buildOpenQuotes({ jobs: JOBS, signed: SIGNED, today: TODAY });
  const by = window => Object.fromEntries(report.closeRates[window].estimators.map(row => [row.estimator, row]));
  const ninety = by('last90');
  // Est.One: expired, cold, cooling, fresh, approved (4 days) and one on-site signature (0 days).
  assert.deepEqual(pick(ninety['Est.One']), { sent: 6, closed: 2, closePercent: 33.3, signedOnSite: 1, open: 4, lost: 0, averageDaysToClose: 2, averageDaysToCloseSent: 4 });
  // Est.Two: warm, boundary, revised, cancelled (lost), sent then signed 7 days later, and one on-site signature.
  assert.deepEqual(pick(ninety['Est.Two']), { sent: 6, closed: 2, closePercent: 33.3, signedOnSite: 1, open: 3, lost: 1, averageDaysToClose: 3.5, averageDaysToCloseSent: 7 });
  assert.deepEqual([report.closeRates.last90.total.sent, report.closeRates.last90.total.closed, report.closeRates.last90.total.closePercent], [12, 4, 33.3]);
  // The 30-day window starts Sep 22: Est.One's Sep 1 quote drops out.
  assert.deepEqual([by('last30')['Est.One'].sent, by('last30')['Est.One'].closed, by('last30')['Est.One'].closePercent], [5, 2, 40]);
  assert.equal(report.closeRates.last90.estimators.some(row => row.estimator === 'zacb'), false, 'a price release is not a signature');
});

test('close events: a sent quote later signed closes on the signature day when nothing else closed it', () => {
  const sent = quote('q_x', '2026-10-01T16:00:00.000Z', { status: 'sent' });
  const [event] = closeEvents([sent], [{ actorId: 'Est.One', jobId: 'q_x', createdAt: '2026-10-06T16:00:00.000Z' }]);
  assert.deepEqual([event.closed, event.closeDays, event.source], [true, 5, 'sent']);
  const rates = closeRates([{ jobId: 'a', estimator: null, sentDay: '2026-10-01', closed: false, closeDays: null, source: 'sent', lost: false }], '2026-09-22', TODAY);
  assert.deepEqual([rates.estimators[0].estimator, rates.estimators[0].closePercent, rates.estimators[0].averageDaysToClose], [null, 0, null]);
  assert.deepEqual(closeRates([], '2026-09-22', TODAY).total.closePercent, null, 'no quotes, no rate');
});

test('a re-signature is never a new close, even when the first signature is older than the receipts read', () => {
  // Signed on site Jul 20 (outside the 90-day read), re-signed Oct 22 after a revision: the Oct receipt records that the
  // job already had an accepted estimate and an acceptance, so it adds no sent quote and no close.
  const resign = { actorId: 'Est.One', jobId: 'sig_old_job', createdAt: '2026-10-20T20:00:00.000Z', priorEstimate: { status: 'accepted' }, priorAcceptance: { acceptedAt: '2026-07-20T18:00:00.000Z' } };
  // A quote approved in the portal before the 120-day window, then re-signed in person.
  const portalThenSigned = { actorId: 'Est.Two', jobId: 'q_portal_old', createdAt: '2026-10-19T20:00:00.000Z', priorEstimate: { status: 'accepted' }, priorAcceptance: null };
  // A sent quote's first in-person signature has an unaccepted prior estimate and no acceptance: it is a close.
  const firstSignature = { actorId: 'Est.Two', jobId: 'sig_first', createdAt: '2026-10-18T20:00:00.000Z', priorEstimate: { status: 'sent' }, priorAcceptance: null };
  assert.deepEqual([resign, portalThenSigned, firstSignature, { priorAcceptance: {} }].map(resigned), [true, true, false, false]);
  const base = buildOpenQuotes({ jobs: JOBS, signed: SIGNED, today: TODAY }), withResigns = buildOpenQuotes({ jobs: JOBS, signed: [...SIGNED, resign, portalThenSigned], today: TODAY });
  assert.deepEqual(withResigns.closeRates, base.closeRates, 're-signatures change no close rate');
  const withFirst = buildOpenQuotes({ jobs: JOBS, signed: [...SIGNED, firstSignature], today: TODAY });
  assert.equal(withFirst.closeRates.last30.total.sent, base.closeRates.last30.total.sent + 1);
  assert.equal(withFirst.closeRates.last30.total.closed, base.closeRates.last30.total.closed + 1);
  // A job signed and re-signed inside the window still counts once, on the first signature.
  const twice = closeEvents([], [{ actorId: 'Est.One', jobId: 'j', createdAt: '2026-10-05T20:00:00.000Z', priorEstimate: null, priorAcceptance: null },
    { actorId: 'Est.One', jobId: 'j', createdAt: '2026-10-12T20:00:00.000Z', priorEstimate: { status: 'accepted' }, priorAcceptance: { acceptedAt: '2026-10-05T20:00:00.000Z' } }]);
  assert.deepEqual(twice.map(event => [event.jobId, event.sentDay, event.source]), [['j', '2026-10-05', 'signed_on_site']]);
});

const pick = row => ({ sent: row.sent, closed: row.closed, closePercent: row.closePercent, signedOnSite: row.signedOnSite, open: row.open, lost: row.lost, averageDaysToClose: row.averageDaysToClose, averageDaysToCloseSent: row.averageDaysToCloseSent });
const get = (handlers, path = '/api/open-quotes') => handlers.get({ request: new Request(`https://easygaragecleaning.com${path}`), env: {} });

test('access: the owner and managers only, checked on the server', async () => {
  const dispatch = () => ({ sentQuoteJobs: async () => JOBS, handoffLedger: async () => SIGNED });
  for (const [actor, status] of [[OWNER, 200], [MANAGER, 200], [ESTIMATOR, 403], [CREW, 403], [{ ...ESTIMATOR, businessAccess: true }, 403], [null, 401]]) {
    let read = false;
    const handlers = openQuotesHandlers({ session: async () => actor, now: () => NOW, dispatch: () => { read = true; return dispatch(); } });
    const response = await get(handlers), body = await response.json();
    assert.equal(response.status, status, JSON.stringify(actor));
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    if (status !== 200) { assert.equal(body.ok, false); assert.equal(read, false, 'nothing is read for a refused viewer'); assert.equal(JSON.stringify(body).includes('Synthetic q_'), false); }
  }
  assert.throws(() => requireOpenQuotesViewer({ user: 'tylerg', businessAccess: false }), { code: 'open_quotes_forbidden', status: 403 });
  const handlers = openQuotesHandlers({ session: async () => OWNER, now: () => NOW, dispatch });
  assert.equal((await get(handlers, '/api/open-quotes?all=1')).status, 400);
  const failing = openQuotesHandlers({ session: async () => OWNER, now: () => NOW, dispatch: () => ({ sentQuoteJobs: async () => { throw new Error('projects/secret down'); }, handoffLedger: async () => [] }) });
  const down = await get(failing);
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { ok: false, code: 'open_quotes_unavailable', error: 'Open quotes could not be loaded. Retry in a moment.' });
});

test('the owner\'s menu is read only for an open builder quote, and an unreadable one leaves the flag unknown', async () => {
  let reads = 0;
  const builder = { ...quote('q_builder', '2026-10-20T16:00:00.000Z'), quoteDraft: { createdBy: 'Est.One', sentAt: '2026-10-20T16:00:00.000Z', breakdown: { source: 'composite', lines: [] } } };
  const plain = openQuotesHandlers({ session: async () => MANAGER, now: () => NOW, pricing: async () => { reads++; return null; }, dispatch: () => ({ sentQuoteJobs: async () => JOBS, handoffLedger: async () => [] }) });
  assert.equal((await (await get(plain)).json()).sources.prices, 'ok');
  assert.equal(reads, 0, 'no builder quote is open: the menu is not read');
  const down = openQuotesHandlers({ session: async () => MANAGER, now: () => NOW, pricing: async () => { reads++; throw new Error('catalog down'); }, dispatch: () => ({ sentQuoteJobs: async () => [builder], handoffLedger: async () => [] }) });
  const body = await (await get(down)).json();
  assert.equal(reads, 1);
  assert.equal(body.sources.prices, 'unavailable');
  assert.equal(body.rows[0].draftPricesWaiting, null);
});

test('READ-BUDGET: one masked range query on quoteDraft.sentAt and one on the signed receipts; never a jobs scan', async () => {
  const seed = {};
  for (const job of JOBS) seed[`jobs/${job.id}`] = Object.fromEntries(Object.entries(job).filter(([key]) => key !== 'id'));
  // Hundreds of other jobs (scheduled work, walkthroughs, vault records) the board must not read.
  for (let index = 0; index < 300; index++) seed[`jobs/other_${String(index).padStart(3, '0')}`] = { type: index % 3 ? 'job' : 'walkthrough', date: '2026-10-15', customer: `Synthetic other ${index}`, estimate: { status: 'accepted' } };
  for (const [index, row] of SIGNED.entries()) seed[`walkthroughHandoffs/r${index}`] = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));
  seed['walkthroughHandoffs/r_old'] = { actorId: 'Est.One', jobId: 'sig_old', createdAt: '2026-06-01T20:00:00.000Z' };
  const fs = firestoreRest(seed), meter = readMeter(fs);
  const handlers = openQuotesHandlers({ session: async () => OWNER, now: () => NOW, dispatch: env => dispatchStorage(env, fs.fetcher), pricing: async () => { throw new Error('not needed'); } });
  const measured = await meter.measure(async () => (await get(handlers)).json());
  const body = measured.result;
  assert.equal(body.ok, true);
  assert.deepEqual(body.rows.map(row => row.jobId), ['q_expired', 'q_cold', 'q_cooling', 'q_warm', 'q_boundary', 'q_fresh'], 'the real query answers the same board');
  assert.equal(measured.byKey['query:jobs:quoteDraft.sentAt'], JOBS.length - 1, 'only the quotes sent in the window (q_old is not read)');
  assert.equal(measured.byKey['query:walkthroughHandoffs:createdAt'], SIGNED.length, 'only the receipts of the last 90 days');
  assert.equal(measured.total, JOBS.length - 1 + SIGNED.length);
  assert.equal(Object.keys(measured.byKey).some(key => key.startsWith('list:')), false, 'no collection scan');
  const [jobsQuery] = fs.queries('jobs').map(call => call.body.structuredQuery);
  assert.deepEqual(jobsQuery.where, { fieldFilter: { field: { fieldPath: 'quoteDraft.sentAt' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '2026-06-24T00:00:00.000Z' } } });
  assert.deepEqual(jobsQuery.select.fields.map(field => field.fieldPath), [...OPEN_QUOTE_FIELDS], 'masked: no phone, email, address, lines or signatures');
  assert.ok(!OPEN_QUOTE_FIELDS.some(field => /phone|email|address|signature|lineItems|notes/i.test(field)));
  const [receiptQuery] = fs.queries('walkthroughHandoffs').map(call => call.body.structuredQuery);
  assert.deepEqual(receiptQuery.select.fields.map(field => field.fieldPath), [...OPEN_QUOTE_RECEIPT_FIELDS], 'receipts masked: never the signature, plan or amount');
  assert.ok(!OPEN_QUOTE_RECEIPT_FIELDS.some(field => /signature|plan|amount/i.test(field)));
  // A single-field range needs no composite index: nothing new in firestore.indexes.json.
  assert.equal(readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8').includes('quoteDraft'), false);
});

test('the screen is a business-capability manifest line that loads its own files and never builds HTML from strings', () => {
  const manifest = readFileSync(new URL('../employee-hub-screens.js', import.meta.url), 'utf8');
  assert.match(manifest, /\{id:'open_quotes',group:'RUN THE BUSINESS',label:'Open quotes',[^\n]*capability:'business',load:\{js:'employee-open-quotes\.js',css:'employee-open-quotes\.css',v:'20261021openquotes2'\},module:'EGCOpenQuotes'\}/);
  const screen = readFileSync(new URL('../employee-open-quotes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(screen, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'customer names reach the page only as text nodes');
  assert.match(screen, /'\/api\/customer-portal-link'/, 'the one action is the existing portal-link endpoint');
  assert.doesNotMatch(screen, /\/api\/(?:quote-draft|highlevel|money|messag)/, 'no send, money or HighLevel call');
});
