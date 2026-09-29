// Private portal links: where a {{portalLink}} or {{payLink}} lands, how long
// it lives, that `next` is an allow-list and that a business-account job never
// gets a homeowner link. The production link providers, the session exchange
// and Firestore REST storage run over an in-memory Firestore; the clock is
// always injected and no other host is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { portalLinkProviders } from '../functions/_lib/message-links.js';
import { PORTAL_HOME, PORTAL_INVOICE, PORTAL_PAY, portalLanding, portalNext } from '../functions/_lib/portal-landing.js';
import { verifyCustomerPortalAccessToken, verifyCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { customerPortalSessionHandler } from '../functions/api/customer-portal-session.js';
import { moneyDocumentHandlers } from '../functions/api/money-document.js';
import { readFileSync } from 'node:fs';
import { messagingStorage } from '../functions/_lib/message-send-store.js';
import { firestoreMemory } from './helpers/firestore-memory.mjs';

const NOW = '2026-09-22T18:00:00.000Z', DAY = 86400000, ORIGIN = 'https://easygaragecleaning.com';
const ENV = Object.freeze({ HUB_SESSION_SECRET: 'synthetic-portal-landing-secret-0123456789abcdef', CUSTOMER_PORTAL_SECRET: 'synthetic-portal-landing-portal-secret', FIREBASE_API_KEY: 'firebase-test-portal-landing' });
// A completed job with an issued invoice: $1,234.56 quoted, $200 paid, $1,034.56 due.
const invoiceJob = (overrides = {}) => ({
  type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', phone: '(970) 555-0123', email: 'synthetic@example.invalid', highlevelContactId: 'contact-1',
  date: '2026-09-15', status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-15T20:00:00.000Z', notify: true,
  estimate: { number: 'EST-JOB001', status: 'accepted', amount: 1234.56, validUntil: '2026-10-05', depositRequired: 300 },
  payment: { amount: 200, verified: true },
  invoice: { number: 'INV-JOB001', status: 'issued', amount: 1234.56, balance: 1034.56, dueDate: '2026-10-01', issuedAt: '2026-09-16T15:00:00.000Z' },
  ...overrides,
});
const accessOf = link => new URL(link).searchParams.get('access');
const exchange = (env, link, at = NOW) => customerPortalSessionHandler({ now: () => new Date(at) })({ env, request: new Request(link.replace('https://easygaragecleaning.com', ORIGIN)) });

function world(t, jobs) {
  const memory = firestoreMemory();
  for (const [id, data] of Object.entries(jobs)) memory.put(`jobs/${id}`, data);
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => memory.fetch(input, options));
  const store = messagingStorage(ENV), read = id => store.read('jobs', id);
  return { memory, read, links: portalLinkProviders({ env: ENV, read, now: () => Date.parse(NOW) }) };
}

test('the pay link names the right job, lives 30 days and lands on the payment card; next=invoice opens the printable invoice', async t => {
  const w = world(t, { 'job-1': invoiceJob(), 'job-void': invoiceJob({ invoice: { ...invoiceJob().invoice, status: 'void' } }) });
  const job = await w.read('job-1');
  const payLink = await w.links.payLink({ kind: 'deposit_reminder', audience: 'customer', job, purpose: 'send' }), portalLink = await w.links.portalLink({ kind: 'review_request', audience: 'customer', job, purpose: 'send' });
  assert.equal(new URL(payLink).searchParams.get('next'), 'pay', 'every pay link opens the payment card');
  assert.equal(new URL(portalLink).searchParams.get('next'), null, 'plain portal links keep their old shape');
  const claims = await verifyCustomerPortalAccessToken(ENV, accessOf(payLink), Date.parse(NOW));
  assert.deepEqual([claims.jobId, claims.linkRoot, claims.linkVersion, claims.expiresAt], ['job-1', 'job-1', 0, Date.parse(NOW) + 30 * DAY]);
  assert.ok(await verifyCustomerPortalAccessToken(ENV, accessOf(payLink), Date.parse(NOW) + 30 * DAY - 1));
  assert.equal(await verifyCustomerPortalAccessToken(ENV, accessOf(payLink), Date.parse(NOW) + 30 * DAY), null, 'expired after 30 days');

  const documents = { ...ENV, MONEY_DOCUMENT_ENABLED: 'true' };
  const landed = await exchange(documents, payLink);
  assert.deepEqual([landed.status, landed.headers.get('Location'), landed.headers.get('Cache-Control'), landed.headers.get('Referrer-Policy')], [303, PORTAL_PAY, 'no-store', 'no-referrer']);
  const session = await verifyCustomerPortalSessionToken(ENV, landed.headers.get('Set-Cookie').split(';')[0].split('=')[1], Date.parse(NOW));
  assert.equal(session.jobId, 'job-1', 'the session is for the job the link names');
  assert.equal((await exchange(documents, portalLink)).headers.get('Location'), PORTAL_HOME);
  assert.equal((await exchange(documents, `${portalLink}&next=invoice`)).headers.get('Location'), PORTAL_INVOICE, 'an issued invoice opens as the printable document');
  assert.equal((await exchange(ENV, `${portalLink}&next=invoice`)).headers.get('Location'), PORTAL_PAY, 'without printable documents the invoice link opens the payment card');
  for (const next of ['https://evil.example.invalid/', '//evil.example.invalid', '/employee.html', 'INVOICE', 'pay#x', '']) {
    const response = await exchange(documents, `${portalLink}&next=${encodeURIComponent(next)}`);
    assert.equal(response.headers.get('Location'), PORTAL_HOME, `next=${next} is not on the allow-list`);
  }
  const voided = await w.links.portalLink({ kind: 'review_request', audience: 'customer', job: await w.read('job-void'), purpose: 'send' });
  assert.equal((await exchange(documents, `${voided}&next=invoice`)).headers.get('Location'), PORTAL_PAY, 'an invoice that is no longer issued is never shown as current');
  const expired = await exchange(documents, payLink, new Date(Date.parse(NOW) + 30 * DAY).toISOString());
  assert.deepEqual([expired.status, expired.headers.get('Location'), expired.headers.get('Set-Cookie')], [303, '/customer-portal?error=invalid', null]);
  assert.equal(await w.links.payLink({ kind: 'deposit_reminder', audience: 'crew', job, purpose: 'send' }), undefined);
  const stored = JSON.stringify([...w.memory.documents.values()]);
  assert.ok(!stored.includes(accessOf(payLink)) && !/access=/.test(stored), 'minting a link stores nothing');
});

test('landing and next helpers accept only the allow-list', () => {
  assert.deepEqual(['invoice', 'pay', 'Pay', 'receipt', undefined, null, 5].map(portalNext), ['invoice', 'pay', '', '', '', '', '']);
  const job = { id: 'job-1', ...invoiceJob() }, env = { MONEY_DOCUMENT_ENABLED: 'true' };
  assert.equal(portalLanding('invoice', { env, job, viewer: { permissions: { view: true } }, now: NOW }), PORTAL_INVOICE);
  assert.equal(portalLanding('invoice', { env, job, viewer: { permissions: { view: false } }, now: NOW }), PORTAL_PAY);
  assert.equal(portalLanding('invoice', { env, job: { ...job, estimate: { amount: 'not money' } }, now: NOW }), PORTAL_PAY, 'unreadable money never opens a document');
  assert.equal(portalLanding('invoice', { env, job, now: 'not a time' }), PORTAL_PAY);
  assert.equal(portalLanding('pay', { env, job, now: NOW }), PORTAL_PAY);
  assert.equal(portalLanding(undefined, { env, job, now: NOW }), PORTAL_HOME);
});

test('a next=invoice link opened from webmail lands on the portal, whose own link opens the invoice same-origin', async t => {
  const w = world(t, { 'job-1': invoiceJob() }), documents = { ...ENV, MONEY_DOCUMENT_ENABLED: 'true' };
  const portalLink = await w.links.portalLink({ kind: 'review_request', audience: 'customer', job: await w.read('job-1'), purpose: 'send' });
  // Webmail opens the link: a cross-site navigation, and the 303 that follows stays cross-site.
  const landed = await customerPortalSessionHandler({ now: () => new Date(NOW) })({ env: documents, request: new Request(`${portalLink}&next=invoice`.replace('https://easygaragecleaning.com', ORIGIN), { headers: { 'Sec-Fetch-Site': 'cross-site' } }) });
  const location = landed.headers.get('Location'), cookie = landed.headers.get('Set-Cookie').split(';')[0];
  assert.deepEqual([landed.status, location, PORTAL_INVOICE], [303, '/customer-portal#invoice', '/customer-portal#invoice'], 'the landing is the portal page, never an API that refuses cross-site requests');
  assert.ok(new URL(location, ORIGIN).pathname === PORTAL_HOME && new URL(location, ORIGIN).origin === ORIGIN, 'same site, a portal page');
  const documentsApi = moneyDocumentHandlers({ now: () => new Date(NOW) });
  const open = headers => documentsApi.get({ env: documents, request: new Request(`${ORIGIN}/api/money-document?kind=invoice`, { headers: { Cookie: cookie, Accept: 'text/html', ...headers } }) });
  // Landing straight on the document (the old target) is refused on that cross-site chain.
  const refused = await open({ 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /Open this document from Easy Garage Cleaning/);
  // The portal's View invoice link is a same-origin navigation (the portal sends no Referer): the invoice opens.
  const opened = await open({ 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(opened.status, 200);
  assert.match(opened.headers.get('Content-Type'), /^text\/html/);
  assert.match(await opened.text(), /INV-JOB001/);
  // The portal page focuses that link for #invoice (browser-tested in tests/browser/test_money_document_ui.py).
  const portal = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
  assert.match(portal, /\['#pay','#invoice'\]\.includes\(location\.hash\)/);
  assert.match(portal, /link\.getAttribute\('href'\)==='\/api\/money-document\?kind=invoice'/);
});

// FIX-B2B-BILLING: the refusal names the link layer (link_not_allowed_business_account; the message policies refuse
// these jobs first as business_account_job) and also covers a visit whose account root is the company project.
test('business-linked jobs never get a homeowner portal or pay link', async t => {
  const w = world(t, {
    'job-1': invoiceJob({ businessAccountId: 'acct-synthetic' }),
    'root-1': invoiceJob({ businessAccountId: 'acct-synthetic', customerPortalLinkVersion: 2 }),
    'visit-2': invoiceJob({ customerAccountOwnerJobId: 'root-1' }),
  });
  for (const id of ['job-1', 'visit-2']) {
    const job = await w.read(id);
    for (const provider of ['payLink', 'portalLink']) {
      await assert.rejects(w.links[provider]({ kind: 'deposit_reminder', audience: 'customer', job, purpose: 'send' }),
        error => error.code === 'messaging_not_eligible' && error.status === 409 && error.details?.reason === 'link_not_allowed_business_account', `${id} ${provider}`);
      await assert.rejects(w.links[provider]({ kind: 'review_request', audience: 'customer', job, purpose: 'preview' }), error => error.details?.reason === 'link_not_allowed_business_account', `${id} ${provider} preview`);
    }
  }
  // Unlinking the company restores the homeowner link.
  w.memory.put('jobs/root-1', invoiceJob({ customerPortalLinkVersion: 2 }));
  const claims = await verifyCustomerPortalAccessToken(ENV, accessOf(await w.links.portalLink({ kind: 'review_request', audience: 'customer', job: await w.read('visit-2'), purpose: 'send' })), Date.parse(NOW));
  assert.deepEqual([claims.jobId, claims.linkRoot, claims.linkVersion], ['visit-2', 'root-1', 2]);
});
