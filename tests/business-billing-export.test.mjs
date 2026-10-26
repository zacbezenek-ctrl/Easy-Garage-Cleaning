import test from 'node:test';
import assert from 'node:assert/strict';
import { uid } from '../functions/_lib/business-hub-core.js';
import { billingFixture } from './helpers/business-billing-fixture.mjs';

async function fixture({ administrator = false } = {}) {
  const h = billingFixture(), account = await h.account();
  const north = await h.project(account, 'north', 120.11), south = await h.project(account, 'south', 230.22);
  const payer = await h.member(account, 'billing');
  assert.equal((await h.call({ action: 'set_billing_contact', memberId: payer.id, requestId: uid() }, account.cookie)).status, 200);
  const cookie = administrator ? account.cookie : payer.cookie, requestId = uid();
  const input = { action: 'prepare_business_payment', jobIds: ['north', 'south'], requestId };
  assert.equal((await h.call(input, cookie)).status, 201);
  return { h, account, payer, north, south, cookie, requestId, input };
}
const snapshot = records => JSON.stringify([...records]);

test('review CSV uses current authorized invoice cents without exposing internal identities', async () => {
  const f = await fixture(), before = snapshot(f.h.records);
  const response = await f.h.download(f.requestId, f.cookie), csv = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/csv; charset=utf-8');
  assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="egc-invoice-review.csv"');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(csv, /"INV-north","north","Synthetic Member","[a-f0-9]+@example.invalid","USD","12011","120\.11"/);
  assert.match(csv, /"INV-south","south","Synthetic Member","[a-f0-9]+@example.invalid","USD","23022","230\.22"/);
  assert.match(csv, /"TOTAL","","","","USD","35033","350\.33"\r\n$/);
  for (const hidden of [f.account.id, f.payer.id, f.north, f.south, f.requestId, '_version', 'jobVersion', 'stripe']) assert.equal(csv.includes(hidden), false, hidden);
  assert.equal(snapshot(f.h.records), before, 'download performs no writes');
  const repeated = await f.h.download(f.requestId, f.cookie);
  assert.equal(await repeated.text(), csv);
  assert.equal(snapshot(f.h.records), before, 'duplicate download remains read-only');
});

test('review export requires its original authorized actor and company', async () => {
  const f = await fixture(), other = await f.h.account(), viewer = await f.h.member(f.account, 'viewer'), manager = await f.h.member(f.account, 'manager');
  assert.equal((await f.h.download(f.requestId)).status, 401);
  assert.equal((await f.h.download(f.requestId, other.cookie)).status, 404);
  assert.equal((await f.h.download(f.requestId, f.account.cookie)).status, 404);
  assert.equal((await f.h.download(f.requestId, viewer.cookie)).status, 403);
  assert.equal((await f.h.download(f.requestId, manager.cookie)).status, 403);
  assert.equal((await f.h.download('bad', f.cookie)).status, 400);
  assert.equal((await f.h.download(uid(), f.cookie)).status, 404);
  f.h.setStaff({ user: 'synthetic.owner', role: 'sales', businessAccess: false });
  assert.equal((await f.h.download(f.requestId, '', f.account.query)).status, 403);
});

test('revoked sessions and newly narrowed property access cannot download old reviews', async () => {
  const f = await fixture();
  await f.h.call({ action: 'set_member_properties', memberId: f.payer.id, propertyIds: [f.north], requestId: uid() }, f.account.cookie);
  assert.equal((await f.h.download(f.requestId, f.cookie)).status, 403);
  await f.h.call({ action: 'revoke_member', memberId: f.payer.id }, f.account.cookie);
  assert.equal((await f.h.download(f.requestId, f.cookie)).status, 401);
});

test('changed or revoked billing recipient invalidates an administrator-created review', async () => {
  for (const revoke of [false, true]) {
    const f = await fixture({ administrator: true });
    if (revoke) await f.h.call({ action: 'revoke_member', memberId: f.payer.id }, f.account.cookie);
    else await f.h.call({ action: 'set_billing_contact', memberId: null, requestId: uid() }, f.account.cookie);
    assert.equal((await f.h.download(f.requestId, f.cookie)).status, 409);
  }
});

test('payments, changed amounts, refund reviews, unlinks and cancelled reviews refuse stale CSV', async () => {
  for (const change of ['payment', 'amount', 'refund', 'unlink', 'cancel']) {
    const f = await fixture();
    if (change === 'payment') await f.h.change('jobs', 'north', { payment: { amount: 20, verified: true } });
    if (change === 'amount') await f.h.change('jobs', 'north', { estimate: { amount: 180, status: 'accepted' } });
    if (change === 'refund') await f.h.change('jobs', 'north', { refunds: [{ amount: 10 }] });
    if (change === 'unlink') await f.h.call({ action: 'unlink_project', jobId: 'north' }, '', f.account.query);
    if (change === 'cancel') await f.h.call({ action: 'cancel_business_payment', requestId: f.requestId }, f.cookie);
    const response = await f.h.download(f.requestId, f.cookie);
    assert.ok([403, 409].includes(response.status), change);
    assert.match(response.headers.get('Content-Type'), /application\/json/, 'no partial CSV leaks');
  }
});

test('formula-like invoice and display fields are escaped, including leading whitespace and quotes', async () => {
  const f = await fixture();
  const account = await f.h.store.read('business_accounts', f.account.id);
  account.properties.find(p => p.id === f.north).name = '\t=HYPERLINK("x")';
  const payer = account.members.find(m => m.id === f.payer.id);
  payer.name = ' +SUM(1,2)'; payer.email = '@SUM(1,2)';
  await f.h.change('business_accounts', f.account.id, account);
  const job = await f.h.store.read('jobs', 'north'); job.invoice.number = '=1+1';
  await f.h.change('jobs', 'north', job);
  const requestId = uid();
  assert.equal((await f.h.call({ action: 'prepare_business_payment', jobIds: ['north'], requestId }, f.cookie)).status, 201);
  const csv = await (await f.h.download(requestId, f.cookie)).text();
  assert.match(csv, /"'=1\+1","'\t=HYPERLINK\(""x""\)","' \+SUM\(1,2\)","'@SUM\(1,2\)"/);
});

test('an invoice mutation during export is detected before any CSV is returned', async () => {
  const f = await fixture(), original = f.h.store.jobs;
  let calls = 0;
  f.h.store.jobs = async ids => {
    const rows = await original(ids);
    if (++calls === 1) await f.h.change('jobs', 'north', { payment: { amount: 20, verified: true } });
    return rows;
  };
  const response = await f.h.download(f.requestId, f.cookie);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /changed during export/);
});

test('a recipient mutation during export is detected before any CSV is returned', async () => {
  const f = await fixture(), original = f.h.store.jobs;
  let changed = false;
  f.h.store.jobs = async ids => {
    const rows = await original(ids);
    if (!changed) { changed = true; await f.h.change('business_accounts', f.account.id, { billingContactMemberId: null }); }
    return rows;
  };
  assert.equal((await f.h.download(f.requestId, f.cookie)).status, 409);
});
