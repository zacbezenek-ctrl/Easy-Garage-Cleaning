// GHL-TRACK-1, flag off. With EGC_GHL_TAG_OUTBOX unset the Hub's HighLevel requests are exactly today's: the browser
// path (POST /api/highlevel for schedule, lifecycle, closeout and Game Plan syncs) makes the same requests with the same
// headers and bodies, in the same order, as the code before the outbox. The snapshot was recorded from that code
// (UPDATE_SNAPSHOTS=1 on the base commit) with a fake HighLevel that records every request, an in-memory Firestore and
// a fixed clock. Synthetic data only, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { scheduleTagWrites } from '../functions/_lib/ghl-tag-outbox.js';
import { FLAG_OFF_ENV, FLAG_OFF_JOBS, highLevelRequestLog } from './helpers/ghl-track-fixture.mjs';

const SNAPSHOT = new URL('./snapshots/ghl-track-flag-off.snap', import.meta.url);

test('flag off: the HighLevel request log of the browser sync paths is byte-identical to the code before the outbox', async t => {
  const { text } = await highLevelRequestLog(t);
  if (process.env.UPDATE_SNAPSHOTS === '1') { mkdirSync(new URL('./snapshots/', import.meta.url), { recursive: true }); writeFileSync(SNAPSHOT, text); }
  assert.ok(existsSync(SNAPSHOT), 'the snapshot was recorded from the code before GHL-TRACK-1');
  assert.equal(text, readFileSync(SNAPSHOT, 'utf8'), 'a flag-off HighLevel request changed');
});

test('flag off after it was on: visits that still point at outbox entries sync exactly as before', async t => {
  const jobs = {};
  for (const [id, job] of Object.entries(FLAG_OFF_JOBS)) jobs[id] = { ...job, ghlTagEntry: (await scheduleTagWrites({ jobId: id, after: { ...job, status: 'scheduled', pipelineStatus: 'scheduled' }, action: 'schedule.create', requestId: randomUUID(), now: '2026-09-22T18:00:00.000Z' })).pointer };
  for (const env of [FLAG_OFF_ENV, { ...FLAG_OFF_ENV, EGC_GHL_TAG_OUTBOX: 'TRUE' }, { ...FLAG_OFF_ENV, EGC_GHL_TAG_OUTBOX: '1' }]) {
    const { text } = await highLevelRequestLog(t, env, jobs);
    assert.equal(text, readFileSync(SNAPSHOT, 'utf8'), `EGC_GHL_TAG_OUTBOX=${env.EGC_GHL_TAG_OUTBOX}`);
    t.mock.restoreAll(); t.mock.timers.reset();
  }
});
