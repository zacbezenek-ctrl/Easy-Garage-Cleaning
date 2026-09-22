import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceFieldTime, fieldJobTime } from '../functions/_lib/field-execution-time.js';
import { fieldChecklist, fieldCommand } from '../functions/_lib/field-execution.js';

const actor = { user: 'Crew.One', displayName: 'Crew One' };
const minute = 60000;
const at = time => `2026-09-22T${time}:00.000Z`;
function readyJob() {
  const job = { id: 'test-job', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-09-22', time: '08:00', endTime: '12:00', payment: { amount: 100 }, timeTracking: { legacy: 'preserve' }, fieldExecution: { photos: ['before', 'after'].map(category => ({ id: crypto.randomUUID(), fileId: `image-${category}`, verified: true, category })) } };
  job.fieldExecution.checks = Object.fromEntries(fieldChecklist(job).map(item => [item.id, { completed: true }]));
  return job;
}
function step(job, activity, time) {
  const result = fieldCommand(job, actor, { requestId: crypto.randomUUID(), action: activity === 'completed' ? 'complete' : 'status', status: activity, reason: 'Customer access wait', notes: 'The agreed work and customer walkthrough are complete.', hasIssues: false }, at(time));
  return { job: { ...job, ...result.patch }, event: result.event };
}

test('job time separates work, pauses, waiting, delays, travel and arrival without altering employee labor', () => {
  let job = readyJob(); const events = [];
  for (const [activity, time] of [['dispatched', '14:00'], ['arrived', '14:30'], ['in_progress', '14:45'], ['paused', '15:45'], ['waiting', '16:00'], ['delayed', '16:15'], ['in_progress', '16:30'], ['completed', '18:30']]) {
    const result = step(job, activity, time); job = result.job; events.push(result.event);
  }
  const time = fieldJobTime(job, at('19:00'));
  assert.equal(time.workMs, 180 * minute);
  assert.equal(time.pausedMs, 15 * minute);
  assert.equal(time.waitingMs, 15 * minute);
  assert.equal(time.delayedMs, 15 * minute);
  assert.equal(time.travelMs, 30 * minute);
  assert.equal(time.arrivalMs, 15 * minute);
  assert.equal(time.totalRecordedMs, 270 * minute);
  assert.equal(time.estimatedMs, 240 * minute);
  assert.equal(time.workVarianceMs, -60 * minute);
  assert.equal(time.runningKind, null);
  assert.equal(time.partialHistory, false);
  assert.equal(events[3].timeSegment.durationMs, 60 * minute);
  assert.equal(events[3].timeSegment.actorId, actor.user);
  assert.deepEqual(job.timeTracking, { legacy: 'preserve' });
  assert.deepEqual(job.payment, { amount: 100 });
  assert.deepEqual(fieldJobTime(job, at('23:00')), { ...time, asOf: at('23:00') }, 'completed durations remain frozen');
});

test('repeated active-work status does not restart or double-count the current segment', () => {
  let job = readyJob();
  for (const [activity, time] of [['dispatched', '14:00'], ['arrived', '14:01'], ['in_progress', '14:02'], ['in_progress', '14:30']]) job = step(job, activity, time).job;
  assert.equal(job.fieldExecution.jobTime.current.startedAt, at('14:02'));
  assert.equal(fieldJobTime(job, at('15:02')).workMs, 60 * minute);
  job = step(job, 'paused', '15:02').job;
  assert.equal(fieldJobTime(job, at('15:30')).workMs, 60 * minute);
  assert.equal(fieldJobTime(job, at('15:30')).pausedMs, 28 * minute);
});

test('UTC work segments and Mountain scheduled duration remain correct across midnight and both DST transitions', () => {
  for (const [date, endDate, endTime, start, end, expected] of [
    ['2026-10-31', '2026-11-01', '03:00', '2026-11-01T05:00:00Z', '2026-11-01T10:00:00Z', 300],
    ['2026-03-07', '2026-03-08', '04:00', '2026-03-08T06:00:00Z', '2026-03-08T10:00:00Z', 240],
  ]) {
    let job = { ...readyJob(), date, time: '23:00', endDate, endTime };
    const opened = advanceFieldTime(job, 'in_progress', actor, 'start', start);
    job = { ...job, status: 'in_progress', pipelineStatus: 'in_progress', fieldExecution: { ...job.fieldExecution, activity: 'in_progress', jobTime: opened.clock } };
    const closed = advanceFieldTime(job, null, actor, 'stop', end);
    job.fieldExecution.jobTime = closed.clock;
    const time = fieldJobTime(job, end);
    assert.equal(time.workMs, expected * minute);
    assert.equal(time.estimatedMs, expected * minute);
  }
  assert.equal(fieldJobTime({ date: '2026-11-01', time: '01:30', endTime: '03:00' }).estimatedMs, null, 'ambiguous wall times stay unknown');
  assert.equal(fieldJobTime({ date: '2026-03-08', time: '02:30', endTime: '04:00' }).estimatedMs, null, 'nonexistent wall times stay unknown');
});

test('legacy active jobs start partial coverage and completed jobs are not reconstructed', () => {
  const legacy = { ...readyJob(), status: 'in_progress', pipelineStatus: 'in_progress', startedAt: at('12:00') };
  assert.equal(fieldJobTime(legacy, at('15:00')).recorded, false);
  const { clock } = advanceFieldTime(legacy, 'paused', actor, 'pause', at('15:00'));
  legacy.fieldExecution.jobTime = clock; legacy.fieldExecution.activity = 'paused';
  const time = fieldJobTime(legacy, at('16:00'));
  assert.equal(time.partialHistory, true);
  assert.equal(time.workMs, 0);
  assert.equal(time.pausedMs, 60 * minute);
  assert.equal(fieldJobTime({ ...readyJob(), status: 'completed', startedAt: at('12:00'), completedAt: at('15:00') }, at('16:00')).recorded, false);
});

test('cancellation freezes time and a later restoration does not charge the cancelled gap', () => {
  let job = readyJob();
  for (const [activity, time] of [['dispatched', '14:00'], ['arrived', '14:15'], ['in_progress', '14:30']]) job = step(job, activity, time).job;
  job.fieldExecution.jobTime = advanceFieldTime(job, null, actor, 'cancel', at('15:30')).clock;
  job.status = job.pipelineStatus = 'cancelled'; job.cancelledAt = at('15:30');
  assert.equal(fieldJobTime(job, at('20:00')).workMs, 60 * minute);
  job.fieldExecution.jobTime = advanceFieldTime(job, null, actor, 'restore', at('20:00')).clock;
  job.status = job.pipelineStatus = 'scheduled';
  assert.equal(fieldJobTime(job, at('22:00')).runningKind, null);
  assert.equal(fieldJobTime(job, at('22:00')).totalRecordedMs, 90 * minute);
});

test('corrupt or externally mismatched clocks fail visibly without blocking the core status workflow', () => {
  let job = readyJob(); job.fieldExecution.jobTime = { version: 1, totalsMs: { work: -1 } };
  const original = structuredClone(job.fieldExecution.jobTime);
  job = step(job, 'dispatched', '14:00').job;
  assert.deepEqual(job.fieldExecution.jobTime, original);
  assert.equal(fieldJobTime(job, at('15:00')).needsReview, true);
  const initial = advanceFieldTime(readyJob(), 'in_progress', actor, 'start', at('14:00')).clock;
  const mismatch = { ...readyJob(), fieldExecution: { jobTime: initial } };
  assert.equal(fieldJobTime(mismatch, at('15:00')).runningKind, null);
  assert.equal(fieldJobTime(mismatch, at('15:00')).needsReview, true);
  assert.equal(fieldJobTime(mismatch, at('15:00')).workMs, 0);
});
