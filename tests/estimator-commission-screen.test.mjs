// D6b Hub > My commission (employee-estimator-commission.js) on the real UI kit in a vm with a small DOM: the one read it
// makes, the estimator's own rows with their projected or earned 7%, the not-approved notice with no amount, and errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage, FixedDate } from './helpers/hub-dom.mjs';

const ROW = (id, extra = {}) => ({ id, jobId: id.split(':')[0], jobDate: '2026-10-19', channel: 'direct', state: 'earned', rate: 0.07, projectedCommission: 86.42, earnedCommission: 86.42, earnedAt: '2026-10-20T16:00:00.000Z', reviewReasons: [], ...extra });
const APPROVED = () => ({ ok: true, generatedAt: '2026-10-21T18:00:00.000Z', terms: { verified: true, approvedAt: '2026-10-20T16:00:00.000Z', percent: 7 }, truncated: false,
  rows: [ROW('j1:appointment_setter:estimator', { channel: 'door_to_door', projectedCommission: 210, earnedCommission: 210 }), ROW('j2:direct_estimator'),
    ROW('j4:direct_estimator', { jobDate: '2026-10-24', state: 'awaiting_collection', projectedCommission: 70, earnedCommission: null, earnedAt: null })], totals: { projected: 70, earned: 296.42 } });
const HELD = () => ({ ok: true, generatedAt: '2026-10-21T18:00:00.000Z', terms: { verified: false, approvedAt: null, percent: 7 }, truncated: false,
  rows: [ROW('j2:direct_estimator', { state: 'review_required', projectedCommission: null, earnedCommission: null, earnedAt: null, reviewReasons: ['commission_terms_unapproved'] })], totals: { projected: 0, earned: 0 } });
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
const flush = async (rounds = 60) => { for (let index = 0; index < rounds; index++) await Promise.resolve(); };

function screen(answer = () => reply(APPROVED())) {
  const document = createDocument(), calls = [];
  const hubFetch = async (url, init = {}) => { calls.push({ url, method: init.method || 'GET' }); return answer(url); };
  const context = { console, URL, URLSearchParams, Intl, Promise, Map, Set, Error, JSON, Object, Array, Math, AbortController, crypto, structuredClone, Date: FixedDate, Node: document.Node, document,
    sessionStorage: storage({ egc_u: 'Estimator.One' }), setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, location: { href: 'https://easygaragecleaning.com/employee' } };
  context.window = context;
  vm.createContext(context);
  for (const file of ['employee-ui-kit.js', 'employee-estimator-commission.js']) vm.runInContext(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), context, { filename: file });
  const host = document.createElement('main');
  document.body.append(host);
  const mounted = context.EGCEstimatorCommission.mount(host, Object.freeze({ identity: 'Estimator.One', role: 'sales', capabilities: ['crew'], hubFetch, toast() {}, askAction: async () => null, go() {}, screen: 'my_commission' }));
  const root = () => host.querySelector('.egc-commission'), text = () => root()?.textContent || '';
  return { calls, root, text, mounted, module: context.EGCEstimatorCommission };
}

test('My commission reads the signed-in estimator\'s own rows once and shows each share, earned or projected, with the totals', async () => {
  const ui = screen();
  await ui.mounted; await flush();
  assert.deepEqual(ui.calls, [{ url: '/api/estimator-commission', method: 'GET' }]);
  const rows = ui.root().querySelectorAll('.ec-row');
  assert.deepEqual(rows.map(row => row.querySelector('.ec-share').textContent), ['$210.00 earned', '$86.42 earned', '$70.00 once paid in full']);
  assert.match(rows[0].textContent, /Set at the door by a door-to-door rep/);
  assert.match(rows[1].textContent, /Your walkthrough sale/);
  assert.match(rows[2].textContent, /Waiting for full payment/);
  assert.match(ui.text(), /Earned\$296\.42/);
  assert.match(ui.text(), /Projected\$70\.00/);
  assert.doesNotMatch(ui.text(), /Not approved yet/);
  assert.equal(ui.module.canLeave(), true);
});

test('before the owner approves the terms the screen says so and shows no amount', async () => {
  const ui = screen(() => reply(HELD()));
  await ui.mounted; await flush();
  assert.match(ui.text(), /Not approved yet: the owner has not approved the estimator terms/);
  assert.doesNotMatch(ui.text(), /\$\d/);
  assert.match(ui.root().querySelector('.ec-row').textContent, /Held for review.*No amount yet|No amount yet/s);
  assert.match(ui.root().querySelector('.ec-reasons').textContent, /the owner has not approved the terms yet/);
  const empty = screen(() => reply({ ...HELD(), rows: [] }));
  await empty.mounted; await flush();
  assert.match(empty.text(), /No walkthrough sales yet/);
});

test('a failed read is an error with Retry, never an empty commission', async () => {
  let fail = true;
  const ui = screen(() => fail ? reply({ ok: false, code: 'estimator_commission_unavailable', error: 'down' }, 503) : reply(APPROVED()));
  await ui.mounted; await flush();
  assert.match(ui.text(), /Your commission is unavailable/);
  assert.doesNotMatch(ui.text(), /No walkthrough sales yet/);
  fail = false;
  ui.root().querySelectorAll('button').find(node => node.textContent === 'Retry').click();
  await flush();
  assert.equal(ui.root().querySelectorAll('.ec-row').length, 3);
});
