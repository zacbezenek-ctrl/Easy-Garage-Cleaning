// R5 / D9b: the HighLevel schedule note carries the signed walkthrough's job breakdown. The note is built inside the
// dispatch save, before the handoff's commit adds the breakdown and time on site, so the handoff hands them to it
// (store.scheduleMirrorFacts); a later Dispatch change reads them from the saved job. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { GHL_SCHEDULE_MIRROR, scheduleMirrorNote, scheduleMirrorWrites } from '../functions/_lib/ghl-schedule-mirror.js';
import { NOW, ON_ENV, estimator, fixture, signedPlan } from './helpers/estimator-fixture.mjs';

const sign = async env => {
  const f = fixture(env);
  await saveWalkthroughHandoff(f.store, estimator, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w1', sourceRevision: f.rows.get('jobs/w1').revision, plan: signedPlan(1) }, NOW,
    { env, compositeState: async () => { throw new Error('a walkthrough-priced handoff reads no builder state'); } });
  const [entry] = f.writesTo(GHL_SCHEDULE_MIRROR);
  return { f, note: entry.patch.note.body, job: f.job(f.rows.get('jobs/w1').convertedJobId) };
};

test('the signed handoff\'s HighLevel note names the removal scope, keep and remove items and time on site from the saved breakdown', async () => {
  const { note, job } = await sign(ON_ENV);
  assert.equal(job.jobBreakdown.summary, 'Removal: About 1 truckload · 2-car garage · Medium full; Remove / donate: Old cartons; Keep: Blue bicycle');
  assert.match(note, /\nJob breakdown:\nRemoval: About 1 truckload · 2-car garage · Medium full; Remove \/ donate: Old cartons; Keep: Blue bicycle\n/);
  assert.match(note, /\nEstimated time on site: 180 minutes\n/);
  assert.match(note, /\nScope: Synthetic crew brief\n/, 'the crew brief line the note already had stays');
  assert.doesNotMatch(note, /\$\s?\d/, 'never a price');
  // A later Dispatch move builds its note from the saved job, which carries the same breakdown.
  const later = scheduleMirrorNote({ kind: 'rescheduled', job: { ...job, date: '2026-10-20' } });
  assert.match(later.body, /\nJob breakdown:\nRemoval: About 1 truckload/);
});

test('with structured materials off the note has no breakdown section, and a writer that names no facts writes the note as before', async () => {
  const { note } = await sign({ ...ON_ENV, EGC_JOB_MATERIALS: 'false' });
  assert.doesNotMatch(note, /Job breakdown/);
  assert.match(note, /\nEstimated time on site: 180 minutes\n/);
  const after = { type: 'job', status: 'scheduled', date: '2026-10-19', time: '09:30', endTime: '12:30', customerId: 'c1', address: '1 Synthetic Way', jobInstructions: 'Brief' };
  const plain = await scheduleMirrorWrites({ ghlScheduleMirror: true }, { jobId: 'job-1', after, action: 'schedule.create', requestId: 'req-1', now: NOW });
  const named = await scheduleMirrorWrites({ ghlScheduleMirror: true, scheduleMirrorFacts: {} }, { jobId: 'job-1', after, action: 'schedule.create', requestId: 'req-1', now: NOW });
  assert.deepEqual(named, plain);
  assert.equal(plain[0].patch.note.body, scheduleMirrorNote({ kind: 'scheduled', job: { ...after, id: 'job-1' } }).body);
  assert.deepEqual(await scheduleMirrorWrites({ ghlScheduleMirror: false, scheduleMirrorFacts: { jobBreakdown: { summary: 'Removal: x' } } }, { jobId: 'job-1', after, action: 'schedule.create', requestId: 'req-1', now: NOW }), [], 'mirror off: nothing');
});

test('the breakdown reads the crew brief\'s copy of its lines when the job has no summary, one line per section and clipped', () => {
  const job = { type: 'job', status: 'scheduled', date: '2026-10-19', time: '09:30', endTime: '12:30', jobInstructions: { keepItems: 'Bike', jobBreakdown: ['Removal: Old cartons', '', 'Shelving: 2 × Metal shelf', 42, `Storage: ${'x'.repeat(500)}`] } };
  const body = scheduleMirrorNote({ kind: 'scheduled', job }).body;
  assert.match(body, /\nKeep: Bike\nJob breakdown:\nRemoval: Old cartons\nShelving: 2 × Metal shelf\nStorage: x{391}\n/);
});
