import test from 'node:test';
import assert from 'node:assert/strict';
import { uid } from '../functions/_lib/business-hub-core.js';
import { queued } from '../functions/_lib/dispatch-queue.js';
import { businessRequestsHandler } from '../functions/api/business-requests.js';
import { billingFixture } from './helpers/business-billing-fixture.mjs';
import { canDispatch } from '../functions/_lib/dispatch-permissions.js';

async function fixture(options) {
  const h = billingFixture(options);
  if (options?.actor) h.setStaff(options.actor);
  const a = await h.account();
  const propertyId = (await h.call({ action: 'save_property', name: 'Synthetic Warehouse', address: '12 Example Way', access: 'Use the approved entrance', contact: 'Synthetic contact' }, a.cookie)).data.propertyId;
  const serviceRequestId = uid();
  assert.equal((await h.call({ action: 'request_service', requestId: serviceRequestId, propertyId, service: 'Storage cleanout', scope: 'Remove the marked empty boxes only', payer: 'Synthetic Company', purchaseOrder: 'TEST-PO', onsiteContact: 'Synthetic Site Manager', preferredDate: '2026-11-01' }, a.cookie)).status, 201);
  await h.store.commit([{ collection: 'customers', id: 'customer_one', data: { name: 'Synthetic Company Contact', phone: '+13035550100', email: 'customer@example.invalid', initialSource: 'original-test-source' } }]);
  const body = { serviceRequestId, customerId: 'customer_one', accountRevision: (await h.call(null, '', a.query)).data.businessRequestRevision };
  const preview = await h.call({ ...body, action: 'preview_business_request_conversion' }, '', a.query);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const input = { ...body, action: 'convert_business_request', previewToken: preview.data.previewToken, requestId: uid(), sharingAuthorized: true };
  return { h, a, input, propertyId, serviceRequestId };
}

test('stored dispatch permission is rechecked for preview and conversion even with legacy business access', async () => {
  const { h, a, input } = await fixture({ actor: { user: 'configured_manager', role: 'manager', businessAccess: true, staffRoles: ['manager'] }, canCreateJob: actor => canDispatch(actor, { EGC_STAFF_ROLE_PERMISSIONS: 'true' }) });
  h.setStaff({ user: 'configured_manager', role: 'manager', businessAccess: true, staffRoles: ['sales'] });
  assert.equal((await h.call({ ...input, action: 'preview_business_request_conversion' }, '', a.query)).status, 403);
  assert.equal((await h.call(input, '', a.query)).status, 403);
  assert.equal([...h.records.keys()].some(key => key.startsWith('jobs/business_request_')), false);
});
test('manager conversion creates one canonical, unpriced unscheduled job and project atomically', async () => {
  const { h, a, input, propertyId, serviceRequestId } = await fixture();
  const before = await h.store.read('customers', 'customer_one');
  const converted = await h.call({ ...input, total: 1, date: '2026-10-25', notify: true }, '', a.query);
  assert.equal(converted.status, 201, JSON.stringify(converted.data));
  const job = await h.store.read('jobs', converted.data.jobId), account = await h.store.read('business_accounts', a.id), project = await h.store.read('projects', job.projectId);
  assert.equal(queued(job), true); assert.equal(job.status, 'unscheduled'); assert.equal(job.date, ''); assert.deepEqual(job.assignedCrew, []);
  assert.equal(job.address, '12 Example Way'); assert.equal(job.accessInstructions, 'Use the approved entrance');
  assert.equal(job.jobInstructions, 'Remove the marked empty boxes only'); assert.equal(job.businessRequest.payer, 'Synthetic Company');
  assert.equal(job.businessRequest.purchaseOrder, 'TEST-PO'); assert.equal(job.businessRequest.preferredDate, '2026-11-01');
  assert.equal(job.customerId, 'customer_one'); assert.equal(job.businessAccountId, a.id); assert.equal(job.businessPropertyId, propertyId);
  assert.equal(job.notify, false); assert.equal(job.syncStatus, 'not_needed'); assert.equal(job.total, undefined); assert.deepEqual(job.estimate, { status: 'draft' });
  assert.equal(project.customerId, 'customer_one'); assert.equal(project.businessAccountId, a.id);
  assert.equal(account.requests.find(r => r.id === serviceRequestId).jobId, job.id);
  assert.equal(account.projects.find(r => r.jobId === job.id).active, true);
  const after = await h.store.read('customers', 'customer_one');
  assert.deepEqual({ ...before, _version: null }, { ...after, _version: null });
  assert.equal([...h.records.keys()].some(key => /outbox|notification|dispatchOperations/.test(key)), false);
  const client = await h.call(null, a.cookie);
  assert.equal(client.data.requests[0].conversionPreviewToken, undefined);
  assert.equal(client.data.requests[0].convertedBy, undefined);
});
test('retries and two different clicks cannot create a second job or change the selected customer', async () => {
  const { h, a, input } = await fixture();
  const results = await Promise.all([h.call(input, '', a.query), h.call(input, '', a.query)]);
  assert.equal(results.filter(result => result.status === 201).length, 1);
  assert.ok(results.every(result => [201, 200, 409].includes(result.status)));
  assert.equal((await h.call(input, '', a.query)).data.duplicate, true);
  assert.equal((await h.call({ ...input, requestId: uid() }, '', a.query)).data.duplicate, true);
  assert.equal((await h.call({ ...input, customerId: 'other' }, '', a.query)).status, 409);
  assert.equal([...h.records.keys()].filter(key => key.startsWith('jobs/')).length, 1);
  assert.equal([...h.records.keys()].filter(key => key.startsWith('projects/')).length, 1);
});
test('an interrupted atomic commit leaves no partial job or link and the same request retries', async () => {
  const { h, a, input } = await fixture(), commit = h.store.commit;
  let fail = true;
  h.store.commit = async writes => { if (fail && writes.some(w => w.collection === 'jobs')) { fail = false; throw new Error('Synthetic interrupted save'); } return commit(writes); };
  assert.equal((await h.call(input, '', a.query)).status, 503);
  assert.equal([...h.records.keys()].some(key => key.startsWith('jobs/')), false);
  assert.equal((await h.store.read('business_accounts', a.id)).projects.length, 0);
  assert.equal(await h.store.read('business_operations', input.requestId), null);
  assert.equal((await h.call(input, '', a.query)).status, 201);
});
test('preview and conversion deny clients, sales, other companies and unconfirmed sharing', async () => {
  const { h, a, input } = await fixture();
  assert.equal((await h.call(input, a.cookie)).status, 403);
  const other = await h.account(); assert.equal((await h.call(input, '', other.query)).status, 404);
  assert.equal((await h.call({ ...input, sharingAuthorized: false }, '', a.query)).status, 400);
  h.setStaff({ user: 'synthetic.owner', role: 'sales', businessAccess: false });
  assert.equal((await h.call({ ...input, action: 'preview_business_request_conversion' }, '', a.query)).status, 403);
  assert.equal((await h.call(input, '', a.query)).status, 403);
  h.setStaff({ user: 'synthetic.crew', role: 'crew', businessAccess: false });
  assert.equal((await h.call(input, '', a.query)).status, 403);
});
test('closed requests, foreign customers and changed preview evidence cannot convert', async () => {
  for (const kind of ['closed', 'property', 'customer', 'foreign', 'missing']) {
    const { h, a, input, propertyId } = await fixture();
    if (kind === 'closed') await h.call({ action: 'update_request', requestId: input.serviceRequestId, status: 'closed' }, '', a.query);
    if (kind === 'property') await h.call({ action: 'save_property', propertyId, name: 'Changed', address: '99 Changed Way' }, '', a.query);
    if (kind === 'customer') await h.change('customers', 'customer_one', { name: 'Changed Customer' });
    if (kind === 'foreign') await h.change('customers', 'customer_one', { businessAccountId: uid() });
    if (kind === 'missing') input.customerId = 'not_found';
    assert.equal((await h.call(input, '', a.query)).status, 409, kind);
    assert.equal([...h.records.keys()].some(key => key.startsWith('jobs/')), false);
  }
});
test('a customer changed during commit is never copied from stale preview data', async () => {
  const { h, a, input } = await fixture(), commit = h.store.commit;
  let changed = false;
  h.store.commit = async writes => {
    if (!changed && writes.some(w => w.collection === 'jobs')) {
      changed = true; const customer = await h.store.read('customers', 'customer_one');
      await commit([{ collection: 'customers', id: customer.id, data: { ...customer, name: 'Updated Customer' }, version: customer._version }]);
    }
    return commit(writes);
  };
  assert.equal((await h.call(input, '', a.query)).status, 409);
  assert.equal([...h.records.keys()].some(key => key.startsWith('jobs/')), false);
  assert.equal((await h.store.read('customers', 'customer_one')).name, 'Updated Customer');
});
test('replaying after company access was removed cannot re-share the converted job', async () => {
  const { h, a, input } = await fixture(), created = await h.call(input, '', a.query);
  await h.call({ action: 'unlink_project', jobId: created.data.jobId }, '', a.query);
  assert.equal((await h.call(input, '', a.query)).status, 409);
  assert.equal((await h.store.read('jobs', created.data.jobId)).businessAccountId, '');
  assert.equal((await h.store.read('business_accounts', a.id)).projects[0].active, false);
  assert.equal([...h.records.keys()].filter(key => key.startsWith('jobs/')).length, 1);
});
test('queue is staff-only, paged, ownership-filtered and does not expose billing or member data', async () => {
  const accountId = uid(), requestId = uid(), propertyId = uid(); let reads = 0, seenCursor;
  const account = { id: accountId, status: 'active', ownerStaff: 'seller', company: 'Synthetic Co', billingEmail: 'private@example.invalid',
    properties: [{ id: propertyId, name: 'North' }], members: [{ name: 'Private Member' }],
    requests: [{ id: requestId, propertyId, status: 'submitted', service: 'Cleanout', scope: 'Requested scope', createdAt: '2026-10-24T12:00:00Z' }] };
  let actor = { user: 'seller', role: 'sales', businessAccess: false };
  const handler = businessRequestsHandler({ session: async () => actor, store: () => ({ list: async (_, cursor) => { reads++; seenCursor = cursor; return { accounts: [account, { ...account, id: uid(), ownerStaff: 'other' }], next: 'page-two' }; } }) });
  const request = new Request('https://example.invalid/api/business-requests?cursor=page-one');
  const response = await handler({ request, env: {} }), body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(body.requests.length, 1);
    assert.equal(body.ok, true, 'the shared Hub JSON client requires a verified success envelope');
    assert.equal(body.next, 'page-two'); assert.equal(seenCursor, 'page-one'); assert.equal(body.canConvert, false);
  assert.equal(JSON.stringify(body).includes('private@example.invalid'), false); assert.equal(JSON.stringify(body).includes('Private Member'), false);
  actor = { user: 'crew', role: 'crew' }; assert.equal((await handler({ request, env: {} })).status, 403); assert.equal(reads, 1);
  actor = null; assert.equal((await handler({ request, env: {} })).status, 401); assert.equal(reads, 1);
});
