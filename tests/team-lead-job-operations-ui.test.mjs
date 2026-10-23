import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { createDocument } from './helpers/hub-dom.mjs';
import { staffGatedPath } from '../staff-paths.js';

const source = readFileSync(new URL('../crew/job-operations.js', import.meta.url), 'utf8');
const job = { id: 'job-1', revision: 'revision-1', type: 'job', status: 'scheduled', customer: '<img src=x>', customerId: 'customer-1', jobInstructions: 'Keep shelving', date: '2026-09-24', time: '09:00', endDate: '2026-09-24', endTime: '11:00', assignedCrew: ['crew.one'], crewLead: 'crew.one' };
const board = { ok: true, viewer: { id: 'Team.Lead' }, jobs: [job], roster: [{ id: 'crew.one', name: 'One' }, { id: 'crew.two', name: 'Two' }], crews: [], vehicles: [] };
const text = node => node.nodeType === 3 ? node.data : node.childNodes.map(text).join(' ');
async function page({ online = true, respond } = {}) {
  const document = createDocument(), root = document.createElement('div'), message = document.createElement('p');
  root.id = 'content'; message.id = 'message'; document.body.append(root, message);
  const calls = [], navigator = { onLine: online };
  const context = vm.createContext({ document, navigator, AbortController, setTimeout, clearTimeout, crypto, console, encodeURIComponent, fetch: async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
    if (respond) return respond(url, options, calls);
    return Response.json(url.includes('view=job') ? { ...board, job } : board);
  } });
  context.window = context; vm.runInContext(source, context);
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
  await settle();
  const click = async label => { const button = root.querySelectorAll('button').find(node => text(node).includes(label)); assert.ok(button, label); button.click(); await settle(); };
  return { root, message, calls, navigator, click, settle };
}
test('operations page is staff gated and offers only the approved job controls', async () => {
  assert.equal(staffGatedPath('/crew/job-operations'), true);
  assert.equal(staffGatedPath('/crew/job-operations.js'), true);
  const view = await page();
  assert.equal(view.root.querySelectorAll('img').length, 0, 'customer names are text, never HTML');
  await view.click('<img src=x>');
  for (const label of ['Save job', 'Cancel job', 'Complete job']) assert.match(text(view.root), new RegExp(label));
  assert.doesNotMatch(text(view.root), /Restore|No.show|Send message|Sign off|Payment|Payroll|Recurring/);
});
test('edit posts current revision and account, and an uncertain retry keeps the exact body', async () => {
  let posts = 0;
  const view = await page({ respond: (url, options) => {
    if (options.method === 'POST') { posts++; if (posts === 1) throw new Error('Lost response'); return Response.json({ ok: true }); }
    return Response.json(url.includes('view=job') ? { ...board, job } : board);
  } });
  await view.click('<img src=x>');
  const form = view.root.querySelector('form');
  const crew = form.querySelector('[name="assignedCrew"]'); crew.selectedOptions = [{ value: 'crew.two' }];
  form.dispatchEvent({ type: 'submit', preventDefault() {} }); await view.settle();
  const first = view.calls.find(call => call.options.method === 'POST');
  const body = JSON.parse(first.options.body);
  assert.equal(body.expectedRevision, 'revision-1'); assert.equal(body.expectedUser, 'Team.Lead');
  assert.deepEqual(body.changes.assignedCrew, ['crew.two']);
  assert.equal(body.action, 'schedule.update');
  await view.click('Check / retry save');
  assert.equal(view.calls.filter(call => call.options.method === 'POST')[1].options.body, first.options.body);
});
test('offline does not fetch, queue or retain customer/job data', async () => {
  const view = await page({ online: false });
  assert.equal(view.calls.length, 0); assert.match(text(view.message), /Reconnect/);
  assert.equal(view.root.childNodes.length, 0);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|outbox/);
});
