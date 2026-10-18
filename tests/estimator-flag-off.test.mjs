// Estimator integration, flags off. With EGC_QUOTE_BUILDER_ENABLED, EGC_DISPATCH_CREW_AUTO_ASSIGN, EGC_JOB_MATERIALS and
// EGC_GHL_SCHEDULE_MIRROR unset, the signed walkthrough handoff stores and answers exactly what it did before the
// estimator integration, even when the page sends the new fields (a builder selection on the quote, a chosen crew in
// the logistics): every stored document and every answer of this scenario is compared with a snapshot recorded from
// the code before the change (UPDATE_SNAPSHOTS=1 on c382a9e). The scenario: a manager signs a walkthrough into a new job;
// an estimator saves a walkthrough-priced quote draft and signs it into a scheduled job; the estimator asks for the
// handoff preparation, the crew openings view and a price release, which are refused as before; a manager signs a line
// carrying purchase fields (refused as before) and a plan with a false builder selection (not read); the crew projection
// of a buy material Dispatch saved with a store, SKU and product page. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { saveQuoteDraft } from '../functions/_lib/quote-draft.js';
import { handoffHandlers } from '../functions/api/walkthrough-handoff.js';
import { fieldJobProjection } from '../functions/_lib/field-execution.js';
import { BASE_ENV, NOW, MON, TUE, client, estimator, fixture, owner, selection, signedPlan } from './helpers/estimator-fixture.mjs';

const SNAPSHOT = new URL('./snapshots/estimator-flag-off.snap', import.meta.url);
const ids = ['0f6c1f7e-2a51-4c1e-9d1a-5b0e7a1c0001', '0f6c1f7e-2a51-4c1e-9d1a-5b0e7a1c0002', '0f6c1f7e-2a51-4c1e-9d1a-5b0e7a1c0003', '0f6c1f7e-2a51-4c1e-9d1a-5b0e7a1c0004', '0f6c1f7e-2a51-4c1e-9d1a-5b0e7a1c0005', '0f6c1f7e-2a51-4c1e-9d1a-5b0e7a1c0006'];
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const line = (label, value) => `## ${label}\n${JSON.stringify(sorted(value))}\n`;

async function scenario(env) {
  const f = fixture(env), out = [];
  const api = actor => handoffHandlers({ session: async () => actor, storage: () => f.store, now: () => new Date(NOW), stripe: () => null });
  const call = async (actor, method, path, body) => {
    const response = await api(actor)[method]({ request: new Request(`https://easygaragecleaning.com${path}`, method === 'post' ? { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), env });
    return { status: response.status, body: await response.json() };
  };
  // A manager signs walkthrough w1; the page also sends a builder selection and a chosen crew, which the flags-off server ignores.
  // The selection is the one recorded (before builder quotes had labor), so the bytes compare like for like.
  const plan = signedPlan(1, { quote: { composite_pricing: selection({ labor: null }) }, logistics: { crew_id: 'crew_one' } });
  out.push(line('manager signs w1', await call(owner, 'post', '/api/walkthrough-handoff', { requestId: ids[0], customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: 'w1r', plan })));
  // An estimator saves a walkthrough-priced quote draft for w2 and signs it into a scheduled job.
  const draftLines = [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', quantity: 1, unitCents: 140000, totalCents: 140000 }];
  const draft = await saveQuoteDraft(f.store, estimator, { requestId: ids[1], customerId: 'c2', sourceWalkthroughId: 'w2', sourceRevision: 'w2r', draft: { client: client(2), title: 'Garage reset', scope: 'Cleanout and reset.', line_items: draftLines, valid_until: '2026-10-30', catalog_version: '', crew_size: 2, estimated_duration_min: 180 } }, NOW, { env });
  out.push(line('estimator prepares w2', await call(estimator, 'get', `/api/walkthrough-handoff?sourceWalkthroughId=w2&jobId=${draft.job.id}`)));
  const job = f.job(draft.job.id);
  out.push(line('estimator signs the w2 draft', await call(estimator, 'post', '/api/walkthrough-handoff', { requestId: ids[2], customerId: 'c2', sourceWalkthroughId: 'w2', sourceRevision: f.rows.get('jobs/w2').revision, jobId: job.id, expectedRevision: job.revision,
    plan: signedPlan(2, { date: TUE, quote: { line_items: [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', quantity: 1, unitCents: 140000, totalCents: 140000 }] }, logistics: { crew_id: 'crew_two' } }) })));
  out.push(line('crew openings view', await call(estimator, 'get', `/api/walkthrough-handoff?view=crew_openings&startDate=${MON}&durationMinutes=180`)));
  out.push(line('price release', await call(estimator, 'post', '/api/walkthrough-handoff', { action: 'prices.release', requestId: ids[3], jobId: job.id, expectedRevision: f.job(job.id).revision })));
  const purchaseLines = [{ id: 'cleanout', kind: 'service', name: 'Garage cleanout and reset', quantity: 1, unitCents: 128000, totalCents: 128000 }, { id: 'totes', kind: 'product', name: 'Storage totes', quantity: 2, unitCents: 6000, totalCents: 12000, sku: '341048322', store: 'The Home Depot', productUrl: 'https://www.homedepot.com/p/1' }];
  out.push(line('manager signs w3 with purchase fields', await call(owner, 'post', '/api/walkthrough-handoff', { requestId: ids[4], customerId: 'c3', sourceWalkthroughId: 'w3', sourceRevision: 'w3r', plan: signedPlan(3, { quote: { line_items: purchaseLines } }) })));
  out.push(line('manager signs w4 with a false builder selection', await call(owner, 'post', '/api/walkthrough-handoff', { requestId: ids[5], customerId: 'c4', sourceWalkthroughId: 'w4', sourceRevision: 'w4r', plan: signedPlan(4, { date: TUE, quote: { composite_pricing: false } }) })));
  out.push(line('crew projection of a buy material', fieldJobProjection({ id: 'j-buy', type: 'job', materials: [{ id: 'm-buy', name: 'Storage totes', quantity: 8, source: 'buy', purchaseState: 'to_buy', unitsPerPack: 4, packs: 2, store: 'The Home Depot', sku: '341048322', productUrl: 'https://www.homedepot.com/p/1' }] }).materials));
  for (const [key, value] of [...f.rows.entries()].sort(([a], [b]) => a.localeCompare(b))) out.push(line(key, value));
  return out.join('');
}

test('flags off: the signed handoff, its answers and every stored document match the recording from before the estimator integration', async () => {
  const text = await scenario(BASE_ENV);
  if (process.env.UPDATE_SNAPSHOTS === '1') { mkdirSync(new URL('./snapshots/', import.meta.url), { recursive: true }); writeFileSync(SNAPSHOT, text); }
  assert.ok(existsSync(SNAPSHOT), 'the snapshot was recorded from the code before the estimator integration');
  assert.equal(text, readFileSync(SNAPSHOT, 'utf8').replace(/\r\n/g, '\n'), 'a flags-off handoff changed');
  // Any value but exactly "true" is off.
  for (const value of ['TRUE', '1', 'yes']) {
    const env = { ...BASE_ENV, EGC_QUOTE_BUILDER_ENABLED: value, EGC_DISPATCH_CREW_AUTO_ASSIGN: value, EGC_JOB_MATERIALS: value, EGC_GHL_SCHEDULE_MIRROR: value };
    assert.equal(await scenario(env), text, value);
  }
});
