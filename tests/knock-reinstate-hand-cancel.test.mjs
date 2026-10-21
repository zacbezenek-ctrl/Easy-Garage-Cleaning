import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeWorld, saleBatch } from './helpers/knock-bridge-fixture.mjs';

// A Hub cancel (or restore) that failed tells the office to finish it in Dispatch. When the office does, and the sale
// is reinstated (or cancelled again) later, the Hub job follows the sale instead of the earlier failure being cleared
// as moot while the job stays the other way. Synthetic data only.

const jobsOf = w => w.docs('jobs/').filter(row => row.type === 'job' && !row.recordType);
const pick = (row, ...keys) => Object.fromEntries(keys.map(key => [key, row?.[key]]));
// The office's change in Dispatch, made by hand while the bridge could not reach the Hub.
const byHand = (w, path, status) => { const { revision: _revision, ...data } = w.fake.get(path); w.fake.put(path, { ...data, status, ...('pipelineStatus' in data ? { pipelineStatus: status } : {}), ...(status === 'cancelled' ? { cancelledBy: 'office' } : {}) }); };

test('a sale reinstated after the office cancelled its Hub job by hand in Dispatch restores that job', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch();
  await w.send(events);
  await w.book('sale', saleId);
  const [job] = jobsOf(w);
  w.setDispatchDown(true);
  const down = await w.admin({ action: 'sale.status', saleId, status: 'cancelled' });
  assert.match(down.body.hub.message, /Cancel it in Dispatch\.$/);
  w.setDispatchDown(false);
  byHand(w, job.path, 'cancelled');
  const back = await w.admin({ action: 'sale.status', saleId, status: 'booked' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(pick(back.body.hub, 'action', 'status', 'message'), { action: 'restore', status: 'done', message: 'Its Hub job was restored.' });
  assert.equal(w.fake.get(job.path).status, 'scheduled', 'the crew goes to the reinstated sale');
  assert.equal(back.body.sale.handoff.job.hubCancelled, false);
});

test('a sale cancelled again after the office rebooked its Hub job by hand in Dispatch cancels that job', async () => {
  const w = await bridgeWorld();
  const { saleId, events } = saleBatch();
  await w.send(events);
  await w.book('sale', saleId);
  const [job] = jobsOf(w);
  await w.admin({ action: 'sale.status', saleId, status: 'cancelled' });
  w.setDispatchDown(true);
  const down = await w.admin({ action: 'sale.status', saleId, status: 'booked' });
  assert.match(down.body.hub.message, /Rebook it in Dispatch\.$/);
  w.setDispatchDown(false);
  byHand(w, job.path, 'scheduled');
  const again = await w.admin({ action: 'sale.status', saleId, status: 'cancelled' });
  assert.deepEqual(pick(again.body.hub, 'action', 'status', 'message'), { action: 'cancel', status: 'done', message: 'Its Hub job was cancelled too.' });
  assert.equal(w.fake.get(job.path).status, 'cancelled', 'no crew goes to a customer who used the right to cancel');
  assert.equal(again.body.sale.handoff.job.hubCancelled, true);
});
