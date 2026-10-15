import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { jobStartProblem } from '../functions/_lib/job-start-policy.js';
import { scheduleInterval } from '../functions/_lib/dispatch-time.js';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { mutateScheduledVisit } from '../functions/_lib/operations-scheduling.js';

const slot = (time = '09:29', date = '2026-10-16') => ({ id: 'job-1', type: 'job', date, time, endTime: '12:00' });
test('new 9:29 job starts are rejected and 9:30 accepted across Denver DST', () => {
  for (const [date, hour] of [['2026-10-16', '15'], ['2026-11-01', '16'], ['2027-03-14', '15']]) {
    assert.match(jobStartProblem(null, slot('09:29', date)), /9:30 AM/);
    assert.equal(jobStartProblem(null, slot('09:30', date)), null);
    assert.equal(scheduleInterval(slot('09:30', date)).startAt, `${date}T${hour}:30:00.000Z`);
  }
});
test('unchanged early/historical work, walkthroughs and blocks survive; new split work windows obey minimum', () => {
  const old = slot(); assert.equal(jobStartProblem(old, { ...old, assignedCrew: ['new'], endTime: '13:00' }), null);
  assert.match(jobStartProblem(old, { ...old, date: '2026-10-17' }), /9:30/);
  assert.match(jobStartProblem(old, old, { restore: true }), /9:30/);
  assert.equal(jobStartProblem(null, slot('08:00', '2026-10-14')), null);
  for (const type of ['walkthrough', 'blocked']) assert.equal(jobStartProblem(null, { ...old, type }), null);
  const split = { ...slot('10:00'), assignmentSegments: [{ ...slot('10:00'), id: 'first' }, { ...slot('09:29', '2026-10-17'), id: 'second' }] };
  assert.match(jobStartProblem(null, split), /9:30/);
  assert.equal(jobStartProblem(split, { ...split, notes: 'crew change' }), null);
});
test('browser booking policy agrees with server and rejects before any save', async () => {
  const window = { addEventListener() {} }, sessionStorage = { getItem: () => '', removeItem() {} };
  vm.runInNewContext(fs.readFileSync(new URL('../employee-booking.js', import.meta.url), 'utf8'), { window, sessionStorage, document: {}, Map, Set, URLSearchParams });
  for (const type of ['job', 'walkthrough', 'blocked', 'cleanout']) for (const date of ['2026-10-14', '2026-10-16', '2027-03-14']) for (const time of ['08:00', '09:29', '09:30', '12:00']) {
    const next = { ...slot(time, date), type };
    assert.equal(window.EGCBooking.jobStartProblem(null, next), jobStartProblem(null, next));
  }
  await assert.rejects(window.EGCBooking.save(slot()), /9:30 AM/);
});

function memory() {
  const rows = new Map([['customers/c1', { id: 'c1', name: 'Synthetic', revision: 'c1' }]]); let revision = 0;
  const all = prefix => [...rows].filter(([key]) => key.startsWith(prefix + '/')).map(([, row]) => structuredClone(row));
  const store = { read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null), jobs: async () => all('jobs'), day: async () => all('jobs'), customers: async () => all('customers'), resources: async () => [], roster: async () => [], async commit(writes) { for (const w of writes) { const old = rows.get(`${w.collection}/${w.id}`); if (w.revision ? old?.revision !== w.revision : old) throw Object.assign(Error('conflict'), { status: 409 }); } for (const w of writes) if (!w.verify) rows.set(`${w.collection}/${w.id}`, { ...rows.get(`${w.collection}/${w.id}`), ...structuredClone(w.patch), id: w.id, revision: `r${++revision}` }); } };
  return { store, rows };
}
test('dispatch and signed scheduling boundary both reject before any writes, while walkthroughs stay bookable', async () => {
  const owner = { user: 'zacb', id: 'zacb', kind: 'human', role: 'owner', businessAccess: true };
  for (const bridge of [false, true]) {
    const f = memory();
    const save = (type, time) => bridge ? mutateScheduledVisit(f.store, owner, { mode: 'create', requestId: crypto.randomUUID(), portalCustomerId: 'c1', kind: type, changes: { date: '2026-10-16', time, endTime: '12:00' } }, '2026-10-15T18:00:00.000Z') : mutateDispatch(f.store, owner, { action: 'schedule.create', requestId: crypto.randomUUID(), customerId: 'c1', kind: type, changes: { date: '2026-10-16', time, endTime: '12:00', assignedCrew: [] } }, '2026-10-15T18:00:00.000Z');
    await assert.rejects(save('job', '09:29'), /9:30 AM/); assert.equal(f.rows.size, 1);
    const result = await save('job', '09:30'); assert.equal(result.ok, true);
    const g = memory(); // avoid overlap between the accepted job and the separate walkthrough check
    const input = { mode: 'create', requestId: crypto.randomUUID(), portalCustomerId: 'c1', kind: 'walkthrough', changes: { date: '2026-10-16', time: '08:00', endTime: '09:00' } };
    assert.equal((await mutateScheduledVisit(g.store, owner, input, '2026-10-15T18:00:00.000Z')).ok, true);
  }
});
