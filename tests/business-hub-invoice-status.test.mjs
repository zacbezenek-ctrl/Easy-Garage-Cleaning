// FIX-B2B-BILLING (MONEY-16): the business hub reports each issued invoice's effective status, money-core's
// invoiceStatus(job, now) at the handler's injected clock, so a past-due invoice reads 'overdue' whatever status
// was saved, and money paid in full reads 'paid' once verified (a verified payment, or a verified deposit covering
// it). Due dates are Denver calendar days. Synthetic data only; the clock is always injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessHandler } from '../functions/_lib/business-hub-service.js';
import { projectView, uid } from '../functions/_lib/business-hub-core.js';
import { customerMoneyState, customerPaymentNeedsReview } from '../functions/_lib/customer-payments.js';
import { invoiceStatus } from '../functions/_lib/money-core.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const origin = 'https://easygaragecleaning.com';
// Oct 15 2026 is in MDT (UTC-6): the Denver day ends at 06:00Z on Oct 16.
const BEFORE = Date.parse('2026-10-15T18:00:00.000Z'), LAST_MINUTE = Date.parse('2026-10-16T05:59:00.000Z'), MIDNIGHT = Date.parse('2026-10-16T06:00:00.000Z');
const aid = uid(), pid = uid(), account = { id: aid, projects: [{ jobId: 'job-1', propertyId: pid }] }, link = account.projects[0];
const invoiced = (invoice = {}, extra = {}) => ({
  id: 'job-1', type: 'job', businessAccountId: aid, businessPropertyId: pid, status: 'completed', completedAt: '2026-10-01T20:00:00.000Z',
  estimate: { number: 'EST-1', status: 'accepted', amount: 1200, sentAt: '2026-09-20T12:00:00.000Z' },
  invoice: { number: 'INV-1', status: 'issued', amount: 1200, dueDate: '2026-10-15', issuedAt: '2026-10-01T21:00:00.000Z', ...invoice }, ...extra,
});
const view = (job, now) => projectView(account, link, job, customerMoneyState(job), customerPaymentNeedsReview(job), now);

test('an issued invoice reads overdue from the first Denver minute after its due date, never from the saved status', () => {
  const job = invoiced(), saved = structuredClone(job);
  assert.deepEqual([view(job, BEFORE).invoiceStatus, view(job, LAST_MINUTE).invoiceStatus, view(job, MIDNIGHT).invoiceStatus], ['issued', 'issued', 'overdue']);
  assert.deepEqual(view(job, MIDNIGHT), { ...view(job, BEFORE), invoiceStatus: 'overdue' }, 'only the status changes with the clock');
  assert.deepEqual(job, saved, 'the saved job is never changed');
  // Legacy saved statuses ('sent', 'ready') and a stale 'paid' read their effective status too.
  assert.equal(view(invoiced({ status: 'sent' }), MIDNIGHT).invoiceStatus, 'overdue');
  assert.equal(view(invoiced({ status: 'ready' }), BEFORE).invoiceStatus, 'issued');
  assert.equal(view(invoiced({ status: 'paid' }), MIDNIGHT).invoiceStatus, 'overdue', 'a saved paid status with money still owed is overdue');
  // The DTO keeps the Denver calendar day; the page formats it.
  assert.equal(view(job, MIDNIGHT).dueDate, '2026-10-15');
});

test('paid, partly paid, reviewed and unissued invoices', () => {
  const paid = invoiced({}, { payment: { amount: 1200, verified: true, method: 'check' } });
  assert.deepEqual([view(paid, MIDNIGHT).invoiceStatus, view(paid, MIDNIGHT).balance], ['paid', 0], 'paid in full is never overdue');
  const partial = invoiced({}, { payment: { amount: 500, verified: true, method: 'check' } });
  assert.deepEqual([view(partial, BEFORE).invoiceStatus, view(partial, MIDNIGHT).invoiceStatus, view(partial, BEFORE).balance], ['partial', 'overdue', 700]);
  // A recorded payment awaiting review: no figure and no partly-paid hint; still overdue when money is owed past the due date.
  const review = invoiced({}, { payment: { amount: 500, verified: false, method: 'check' } });
  assert.equal(customerPaymentNeedsReview(review), true);
  assert.deepEqual([view(review, BEFORE).invoiceStatus, view(review, BEFORE).balance, view(review, BEFORE).paymentNeedsReview], ['pending_verification', null, true]);
  assert.equal(view(review, MIDNIGHT).invoiceStatus, 'overdue');
  const whole = invoiced({}, { payment: { amount: 1200, verified: false, method: 'check' } });
  assert.deepEqual([view(whole, BEFORE).invoiceStatus, view(whole, MIDNIGHT).invoiceStatus], ['pending_verification', 'pending_verification']);
  for (const status of ['draft', 'void', 'superseded']) {
    const hidden = view(invoiced({ status }), MIDNIGHT);
    assert.deepEqual([hidden.invoiceStatus, hidden.invoiceNumber, hidden.dueDate, hidden.balance], ['not_issued', '', '', null], status);
  }
  assert.deepEqual([view(invoiced({ dueDate: '' }), MIDNIGHT).invoiceStatus, view(invoiced({ dueDate: '2026-02-30' }), MIDNIGHT).invoiceStatus], ['issued', 'issued'], 'no readable due date is never overdue');
});

test('a job paid in full by a verified deposit reads paid, as its $0.00 balance and review flag say', () => {
  const deposit = invoiced({}, { deposit: { amount: 1200, paidAmount: 1200, verified: true } }), row = view(deposit, MIDNIGHT);
  assert.deepEqual([row.invoiceStatus, row.balance, row.paid, row.paymentNeedsReview], ['paid', 0, 1200, false]);
  // money-core reads nothing owed as paid exactly when the payment review rule sees nothing to review.
  const paidInFull = {
    verifiedDeposit: { deposit: { paidAmount: 1200, verified: true } }, unverifiedDeposit: { deposit: { paidAmount: 1200 } },
    verifiedPayment: { payment: { amount: 1200, verified: true } }, unverifiedPayment: { payment: { amount: 1200 }, deposit: { paidAmount: 1200, verified: true } },
    depositShort: { invoice: { number: 'INV-1', status: 'issued', amount: 1200, paid: 1200, dueDate: '2026-10-15' }, deposit: { paidAmount: 600, verified: true } },
    depositCovers: { invoice: { number: 'INV-1', status: 'issued', amount: 1200, paid: 1200, dueDate: '2026-10-15' }, deposit: { paidAmount: 1200, verified: true } },
  };
  const statuses = Object.fromEntries(Object.entries(paidInFull).map(([name, extra]) => {
    const job = invoiced({}, extra), status = invoiceStatus(job, '2026-10-16T06:00:00.000Z');
    assert.equal(status === 'paid', !customerPaymentNeedsReview(job), name);
    return [name, status];
  }));
  assert.deepEqual(statuses, { verifiedDeposit: 'paid', unverifiedDeposit: 'pending_verification', verifiedPayment: 'paid', unverifiedPayment: 'pending_verification', depositShort: 'pending_verification', depositCovers: 'paid' });
});

// business-hub.js formats the DTO's Denver calendar day; its one-line day() helper runs here in a fresh context.
function hubDay() {
  const line = readFileSync(new URL('../business-hub.js', import.meta.url), 'utf8').split('\n').find(text => text.startsWith('const day = '));
  return vm.runInNewContext(`(${line.slice('const day = '.length).replace(/;\s*$/, '')})`);
}

test('the hub shows a due date only when it is a real calendar day, as money-core reads it', () => {
  const day = hubDay();
  assert.deepEqual(['2026-10-15', '2026-02-28', '2024-02-29'].map(day), ['Oct 15, 2026', 'Feb 28, 2026', 'Feb 29, 2024']);
  for (const value of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-15T00:00', '', null, undefined]) assert.equal(day(value), '', String(value));
  // The same impossible day is never overdue on the server, so the page shows no due date for it at all.
  assert.equal(view(invoiced({ dueDate: '2026-02-30' }), MIDNIGHT).invoiceStatus, 'issued');
});

test('the status needs the injected clock: projectView never reads the real one', () => {
  assert.throws(() => view(invoiced(), undefined), error => error.code === 'money_now_required');
  assert.throws(() => view(invoiced(), 'yesterday'), error => error.code === 'money_invalid_time');
  assert.equal(view(invoiced(), '2026-10-16T06:00:00.000Z').invoiceStatus, 'overdue', 'an ISO instant works too');
  assert.equal(view(invoiced({ status: 'draft' }), undefined).invoiceStatus, 'not_issued', 'an unissued invoice needs no clock');
});

class MemoryStore {
  constructor() { this.records = new Map(); this.clock = 0; this.commits = 0; }
  async read(c, id) { return structuredClone(this.records.get(c + '/' + id) || null); }
  async commit(changes) {
    for (const w of changes) { const old = this.records.get(w.collection + '/' + w.id); if (w.version ? old?._version !== w.version : Boolean(old)) throw Object.assign(new Error('Conflict'), { status: 409, publicMessage: 'Conflict' }); }
    for (const w of changes) { const key = w.collection + '/' + w.id, old = this.records.get(key); this.records.set(key, { ...(w.patch ? old : {}), ...structuredClone(w.data), id: w.id, _version: String(++this.clock) }); }
    this.commits += 1;
  }
  async list(profile) { return { accounts: [...this.records.entries()].filter(([k, v]) => k.startsWith('business_accounts/') && (profile.businessAccess || v.ownerStaff === profile.user)).map(([, v]) => structuredClone(v)), next: '' }; }
  async jobs(ids) { return new Map((await Promise.all(ids.map(i => this.read('jobs', i)))).filter(Boolean).map(j => [j.id, j])); }
}

test('the hub snapshot reports overdue at the handler clock for every role, with no write', async () => {
  const store = new MemoryStore(), staff = { user: 'zacb', displayName: 'Synthetic Owner', businessAccess: true, role: 'owner' };
  let clock = BEFORE;
  const handler = createBusinessHandler({ store, getStaff: async () => staff, finance: customerMoneyState, needsReview: customerPaymentNeedsReview, projectCookie: async () => 'project=; HttpOnly', clearProjectCookie: () => 'project=; Max-Age=0', now: () => clock });
  const call = async (payload, { url = '', cookie = '' } = {}) => { const res = await handler(new Request(origin + '/api/business-hub' + url, { method: payload ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-EGC-Business': '1', Cookie: cookie }, ...(payload ? { body: JSON.stringify(payload) } : {}) })); return { status: res.status, data: await res.json(), cookie: res.headers.get('Set-Cookie') }; };
  const created = await call({ action: 'create_account', company: 'Synthetic Property Co', name: 'Synthetic Admin', email: 'admin@example.invalid' }, { url: '?staff=1' });
  const admin = (await call({ action: 'redeem', invite: created.data.invite })).cookie.split(';')[0], accountId = created.data.accountId;
  const invited = await call({ action: 'invite_member', role: 'viewer', name: 'Synthetic Viewer', email: 'viewer@example.invalid' }, { cookie: admin });
  const viewer = (await call({ action: 'redeem', invite: invited.data.invite })).cookie.split(';')[0];
  const propertyId = (await call({ action: 'save_property', name: 'Synthetic Tower', address: '100 Synthetic Street' }, { cookie: admin })).data.propertyId;
  const { id, businessAccountId, businessPropertyId, ...job } = invoiced();
  await store.commit([{ collection: 'jobs', id: 'job-1', data: job }]);
  assert.equal((await call({ action: 'link_project', propertyId, jobId: 'job-1', sharingAuthorized: true }, { url: `?staff=1&account=${accountId}` })).status, 200);
  const statuses = async () => Promise.all([admin, viewer].map(async cookie => (await call(null, { cookie })).data.projects.map(p => [p.invoiceNumber, p.invoiceStatus, p.dueDate])));
  assert.deepEqual(await statuses(), [[['INV-1', 'issued', '2026-10-15']], [['INV-1', 'issued', '2026-10-15']]]);
  const commits = store.commits, saved = await store.read('jobs', 'job-1');
  clock = MIDNIGHT;
  assert.deepEqual(await statuses(), [[['INV-1', 'overdue', '2026-10-15']], [['INV-1', 'overdue', '2026-10-15']]]);
  assert.deepEqual([store.commits, await store.read('jobs', 'job-1')], [commits, saved], 'reading the hub writes nothing');
  assert.equal(saved.invoice.status, 'issued');
});
