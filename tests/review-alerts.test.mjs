import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hubPage, createDocument, FixedDate } from './helpers/hub-dom.mjs';

// A stand-in for employee-review-alerts.js that records what the shell hands it.
function stubAlerts(context) {
  const calls = { mount: [], unmount: 0 };
  context.EGCReviewAlerts = { mount(slot, ctx) { calls.mount.push({ slot, ctx }); }, unmount() { calls.unmount++; } };
  return calls;
}

test('the Command Center gives the review alert one slot at the top, kept across background renders, for business viewers only', () => {
  let calls;
  const page = hubPage({ before(context) { calls = stubAlerts(context); } });
  page.api.install();
  assert.equal(page.api.S.active, 'today');
  const main = page.main(), slot = main.querySelector('#ops-review-alerts');
  assert.ok(slot, 'the slot exists on the Command Center');
  assert.equal(main.firstElementChild, slot, 'the alert leads the Command Center');
  assert.equal(calls.mount.at(-1).slot, slot);
  assert.equal(typeof calls.mount.at(-1).ctx.go, 'function'); assert.deepEqual([...calls.mount.at(-1).ctx.capabilities], ['crew', 'business', 'owner']);
  const mounts = calls.mount.length;
  page.api.render();
  assert.equal(calls.mount.length, mounts + 1, 'a background render hands the alert its (new) slot again');
  assert.equal(main.querySelectorAll('#ops-review-alerts').length, 1, 'never two slots');
  page.api.go('customers');
  assert.equal(main.querySelector('#ops-review-alerts'), null);
  assert.ok(calls.unmount >= 1, 'leaving the Command Center unmounts the alert');
  let crewCalls;
  const crew = hubPage({ user: 'Synthetic.Crew', business: false, role: 'crew', before(context) { crewCalls = stubAlerts(context); } });
  crew.api.install(); crew.api.go('today');
  assert.equal(crewCalls.mount.length, 0, 'crew never load business review counts');
  assert.equal(crew.main().querySelector('#ops-review-alerts'), null);
});

function alertModule(responses) {
  const document = createDocument(), listeners = {}, reads = [];
  const context = { document, Node: document.Node, console, Promise, Object, Array, String, Number, Error, JSON, Date: FixedDate,
    addEventListener: (name, listener) => { (listeners[name] ||= []).push(listener); } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../employee-review-alerts.js', import.meta.url), 'utf8'), context, { filename: 'employee-review-alerts.js' });
  const hubFetch = async path => { reads.push(path); const [status, body] = responses[path]; return { ok: status === 200, status, json: async () => body }; };
  const slot = document.createElement('div');
  document.body.append(slot);
  const went = [];
  return { context, slot, reads, went, listeners, mount: () => context.EGCReviewAlerts.mount(slot, { hubFetch, go: view => went.push(view) }), flush: async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); } };
}
const clear = () => ({
  '/api/stripe-reviews': [200, { ok: true, paymentReviews: [], membershipReviews: [] }],
  '/api/message-sends': [200, { ok: true, sends: [] }],
  '/api/portal-documents-admin': [200, { ok: true, insurance: { state: 'current' } }],
});

test('the alert counts every waiting item, flags the certificate, and is empty only when every queue was read and is clear', async () => {
  const waiting = { ...clear(), '/api/stripe-reviews': [200, { ok: true, paymentReviews: [{}, {}], membershipReviews: [{}] }], '/api/portal-documents-admin': [200, { ok: true, insurance: { state: 'missing' } }] };
  const page = alertModule(waiting);
  page.mount(); await page.flush();
  assert.deepEqual(page.reads.sort(), ['/api/message-sends', '/api/portal-documents-admin', '/api/stripe-reviews']);
  assert.equal(page.slot.querySelector('h2').textContent, '4 items are waiting for a person');
  const rows = page.slot.querySelectorAll('button').map(button => button.querySelector('strong').textContent);
  assert.deepEqual(rows, ['2 card payments are held for review', '1 Garage Guard member needs a customer link', 'No insurance certificate is uploaded']);
  page.slot.querySelectorAll('button')[2].click(); page.slot.querySelectorAll('button')[0].click();
  assert.deepEqual(page.went, ['settings', 'reviews']);
  assert.equal(page.slot.innerHTML, '', 'built from DOM nodes, never an HTML string');

  const quiet = alertModule(clear());
  quiet.mount(); await quiet.flush();
  assert.equal(quiet.slot.childNodes.length, 0, 'nothing to show when every queue is clear');

  const broken = alertModule({ ...clear(), '/api/message-sends': [503, { ok: false, code: 'messaging_unavailable' }] });
  broken.mount(); await broken.flush();
  assert.deepEqual(broken.slot.querySelectorAll('strong').map(node => node.textContent), ['Review queues could not be checked'], 'an unread queue is never shown as clear');

  const denied = alertModule({ ...clear(), '/api/portal-documents-admin': [403, { ok: false }] });
  denied.mount(); await denied.flush();
  assert.equal(denied.slot.childNodes.length, 0, 'a screen the viewer may not use is simply left out');

  // A send still inside its delivery window is not counted as waiting for a person.
  const sending = alertModule({ ...clear(), '/api/message-sends': [200, { ok: true, sends: [{ inFlight: true }, { inFlight: false }, { inFlight: false }] }] });
  sending.mount(); await sending.flush();
  assert.deepEqual(sending.slot.querySelectorAll('strong').map(node => node.textContent), ['2 messages have an unknown outcome']);
  assert.match(sending.slot.querySelector('small').textContent, /Nothing is resent while its outcome is unknown\./);
  assert.doesNotMatch(sending.slot.textContent, /Nothing is resent automatically/, 'the automation may resend a message a person marks not delivered');
  const onlySending = alertModule({ ...clear(), '/api/message-sends': [200, { ok: true, sends: [{ inFlight: true }] }] });
  onlySending.mount(); await onlySending.flush();
  assert.equal(onlySending.slot.childNodes.length, 0, 'nothing to act on while the only message may still be sending');

  // A held charge Stripe shows refunded is the owner's to settle; a partial refund names the amount kept, which is on no job.
  const refund = (extra = {}) => ({ reason: 'payment_refunded', amountCents: 50000, refundedCents: 20000, keptCents: 30000, ...extra });
  const partial = alertModule({ ...clear(), '/api/stripe-reviews': [200, { ok: true, paymentReviews: [refund()], membershipReviews: [] }] });
  partial.mount(); await partial.flush();
  assert.equal(partial.slot.querySelector('small').textContent, 'Stripe confirmed the charge but it was not applied to the job. Reconcile it, or the owner records the refund. Stripe shows a refund on it, so only the owner settles it. $200.00 of $500.00 was refunded, so the $300.00 kept is not on the job until it is recorded under Estimates & payments.');
  const several = alertModule({ ...clear(), '/api/stripe-reviews': [200, { ok: true, paymentReviews: [refund(), refund({ refundedCents: 10000, keptCents: 40000 }), refund({ refundedCents: 50000, keptCents: 0 }), { reason: 'payment_exceeds_balance', amountCents: 50000 }], membershipReviews: [] }] });
  several.mount(); await several.flush();
  assert.match(several.slot.querySelector('small').textContent, /Stripe shows a refund on 3 of them; only the owner settles those\. 2 were only partly refunded: the \$700\.00 kept is not on any job until it is recorded under Estimates & payments\.$/);
  const plain = alertModule({ ...clear(), '/api/stripe-reviews': [200, { ok: true, paymentReviews: [{ reason: 'payment_exceeds_balance' }], membershipReviews: [] }] });
  plain.mount(); await plain.flush();
  assert.equal(plain.slot.querySelector('small').textContent, 'Stripe confirmed the charge but it was not applied to the job. Reconcile it, or the owner records the refund.');

  // A refund on a charge the job already counts is not "kept money on no job": the job counts the full charge and is reduced by the amount refunded.
  const onJob = alertModule({ ...clear(), '/api/stripe-reviews': [200, { ok: true, paymentReviews: [refund({ recordedOnJob: true })], membershipReviews: [] }] });
  onJob.mount(); await onJob.flush();
  assert.equal(onJob.slot.querySelector('small').textContent, 'Stripe shows $200.00 of $500.00 refunded on a charge the job already counts as paid. Only the owner settles it: record the refund, then reduce the job’s payment by the $200.00 refunded.');
  assert.doesNotMatch(onJob.slot.textContent, /not applied to the job|kept is not on/);
  const mixed = alertModule({ ...clear(), '/api/stripe-reviews': [200, { ok: true, paymentReviews: [refund(), refund({ recordedOnJob: true, refundedCents: 50000, keptCents: 0 }), refund({ recordedOnJob: true, refundedCents: 10000, keptCents: 40000 }), { reason: 'payment_exceeds_balance', amountCents: 50000, recordedOnJob: true }], membershipReviews: [] }] });
  mixed.mount(); await mixed.flush();
  assert.equal(mixed.slot.querySelector('small').textContent, 'Stripe confirmed the charge but it was not applied to the job. Reconcile it, or the owner records the refund. Stripe shows a refund on it, so only the owner settles it. $200.00 of $500.00 was refunded, so the $300.00 kept is not on the job until it is recorded under Estimates & payments. Stripe shows refunds on 2 charges their jobs already count as paid ($600.00 refunded in all). Only the owner settles them: record each refund, then reduce each job’s payment by the amount refunded. One held charge is now on its job: mark it reconciled to close its review.');
  const fullOnJob = alertModule({ ...clear(), '/api/stripe-reviews': [200, { ok: true, paymentReviews: [refund({ recordedOnJob: true, refundedCents: 50000, keptCents: 0 })], membershipReviews: [] }] });
  fullOnJob.mount(); await fullOnJob.flush();
  assert.match(fullOnJob.slot.querySelector('small').textContent, /^Stripe shows the full \$500\.00 refunded on a charge the job already counts as paid\./);

  // A follow-up after a refund the owner recorded earlier (priorRefundedCents): the job was reduced by that already,
  // so the alert names only the difference and an owner acting from it never reduces the job twice.
  const alertText = async reviews => { const page = alertModule({ ...clear(), '/api/stripe-reviews': [200, { ok: true, paymentReviews: reviews, membershipReviews: [] }] }); page.mount(); await page.flush(); return page.slot.querySelector('small').textContent; };
  const later = await alertText([refund({ recordedOnJob: true, refundedCents: 40000, keptCents: 10000, priorRefundedCents: 10000 })]);
  assert.equal(later, 'Stripe shows $400.00 of $500.00 refunded on a charge the job already counts as paid. Only the owner settles it: record the refund, then reduce the job’s payment by $300.00 more ($400.00 refunded in all, $100.00 recorded earlier).');
  assert.doesNotMatch(later, /by the \$400\.00 refunded/);
  assert.equal(await alertText([refund({ recordedOnJob: true, refundedCents: 50000, keptCents: 0, priorRefundedCents: 30000 })]),
    'Stripe shows the full $500.00 refunded on a charge the job already counts as paid. Only the owner settles it: record the refund, then reduce the job’s payment by $200.00 more ($500.00 refunded in all, $300.00 recorded earlier).');
  assert.equal(await alertText([{ reason: 'payment_refunded', recordedOnJob: true, priorRefundedCents: 10000 }]),
    'Stripe shows a refund on a charge the job already counts as paid. Only the owner settles it: record the refund, then reduce the job’s payment by the amount refunded beyond the $100.00 recorded earlier.');
  // Stripe now shows no more than was recorded (a refund failed while the follow-up was open): no amount to reduce is named.
  assert.equal(await alertText([refund({ recordedOnJob: true, refundedCents: 10000, keptCents: 40000, priorRefundedCents: 20000 })]),
    'Stripe shows $100.00 of $500.00 refunded on a charge the job already counts as paid. Only the owner settles it: record the refund, then check the job’s payment against Stripe before changing it: $200.00 was recorded earlier.');
  assert.equal(await alertText([refund({ recordedOnJob: true, refundedCents: 40000, keptCents: 10000, priorRefundedCents: 10000 }), refund({ recordedOnJob: true })]),
    'Stripe shows refunds on 2 charges their jobs already count as paid ($500.00 more to reduce in all, $100.00 recorded earlier). Only the owner settles them: record each refund, then reduce each job’s payment by the amount refunded, less any refund recorded earlier on that charge.');

  const cached = alertModule(waiting);
  cached.mount(); await cached.flush(); cached.mount(); await cached.flush();
  assert.equal(cached.reads.length, 3, 'a background render reuses the recent counts');
  cached.listeners['egc:signout'][0]();
  assert.equal(cached.slot.childNodes.length, 0, 'sign-out clears the counts');
});
