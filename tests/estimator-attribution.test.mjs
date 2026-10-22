// One estimator attribution for both estimator boards (functions/_lib/estimator-attribution.js): Open quotes' close
// rates and Estimator accuracy credit the same person for the same quote. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatorOf } from '../functions/_lib/estimator-attribution.js';
import { closeEvents, estimatorOf as openQuotesEstimator, OPEN_QUOTE_FIELDS } from '../functions/_lib/open-quotes.js';
import { accuracyRow, ESTIMATOR_FIELDS } from '../functions/_lib/estimator-accuracy.js';
import { jobActualsRow } from '../functions/_lib/job-actuals.js';

const completed = (id, extra) => ({ id, type: 'job', date: '2026-10-10', customer: `Synthetic ${id}`, status: 'completed', completedAt: '2026-10-10T22:00:00.000Z',
  estimate: { status: 'accepted', amountCents: 100000, acceptedAt: '2026-10-03T17:00:00.000Z' },
  compositeQuote: { breakdown: { source: 'composite', labor: { manHours: 8 }, lines: [] } },
  fieldExecution: { completion: { crewOnSite: { people: 2, hours: 4 } } }, ...extra });

test('a quote an estimator built and the owner sent is credited to the estimator on both boards', () => {
  const job = completed('j-nora', { quoteDraft: { version: 1, createdBy: 'Est.Nora', sentBy: 'ZacB', sentAt: '2026-10-02T16:00:00.000Z' } });
  assert.deepEqual(estimatorOf(job), { key: 'est.nora', evidence: 'quote_builder' });
  assert.equal(openQuotesEstimator(job), 'est.nora');
  assert.equal(closeEvents([job])[0].estimator, 'est.nora', 'Open quotes close rate');
  assert.equal(accuracyRow(jobActualsRow(job), job).estimator, 'est.nora', 'Estimator accuracy');
});

test('an in-person signature beats the builder and the sender, on both boards; a self-run door rep who signs is the signer', () => {
  const job = completed('j-signed', { acceptance: { method: 'in_person_signature', recordedBy: 'Rep.Dana' }, quoteDraft: { version: 1, createdBy: 'Est.Nora', sentBy: 'ZacB', sentAt: '2026-10-02T16:00:00.000Z' } });
  assert.deepEqual(estimatorOf(job), { key: 'rep.dana', evidence: 'walkthrough_signer' });
  assert.equal(openQuotesEstimator(job), 'rep.dana');
  assert.equal(accuracyRow(jobActualsRow(job), job).estimator, 'rep.dana');
  // A rep's own walkthrough records no setter estimator, so the signing rep stays credited.
  assert.deepEqual(estimatorOf(job, { setterKey: 'rep.dana', estimatorKey: '' }), { key: 'rep.dana', evidence: 'walkthrough_signer' });
});

test('the builder beats the sender, and the sender is used only when nobody is named as the builder; both boards read the fields', () => {
  assert.deepEqual(estimatorOf({ quoteDraft: { sentBy: 'ZacB' } }), { key: 'zacb', evidence: 'quote_sender' });
  assert.equal(estimatorOf({ quoteDraft: { savedBy: 'Est.Nora' } }), null, 'saving a draft is not pricing it');
  for (const field of ESTIMATOR_FIELDS) assert.ok(OPEN_QUOTE_FIELDS.includes(field), `Open quotes reads ${field}`);
});
