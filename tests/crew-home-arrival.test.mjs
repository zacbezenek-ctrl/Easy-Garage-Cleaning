import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';
import { crewJobProjection } from '../functions/_lib/crew-job-projection.js';

// Crew home (crew/index.html): the next-job card shows the arrival window the office promised the customer, as
// /api/crew-jobs sends it (crewJobProjection). Synthetic crew and customers only; Tuesday 2026-09-22 09:00 Mountain Time.
const NOW = '2026-09-22T15:00:00.000Z';
const job = changes => crewJobProjection({ id: 'job-1', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customer: 'Synthetic <b>Customer</b>', address: '1 Fixture Way, Fort Collins, CO 80525',
  serviceType: 'Garage cleanout', date: '2026-09-22', endDate: '2026-09-22', time: '09:00', endTime: '12:00', assignedCrew: ['crew.one'], ...changes }, { viewer: 'crew.one', now: new Date(NOW) });

async function crewHome(jobs) {
  const page = readFileSync(new URL('../crew/index.html', import.meta.url), 'utf8'), nodes = new Map();
  const element = id => { if (!nodes.has(id)) nodes.set(id, { id, hidden: false, textContent: '', innerHTML: '', className: '', dataset: {}, setAttribute() {}, classList: { toggle() {} } }); return nodes.get(id); };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return Date.parse(NOW); } }
  const context = vm.createContext({ Date: FixedDate, Intl, URLSearchParams, Promise, Set, Number, String, Array, Math, JSON, encodeURIComponent, window: {}, location: { search: '' }, navigator: { onLine: true }, addEventListener() {},
    document: { getElementById: element },
    EGCHubAuth: { profile: () => ({ user: 'Crew.One', displayName: 'Synthetic Crew' }), canRunBusiness: () => false, canRunWalkthrough: () => false, canUseKnock: () => false, mountCrewNav() {},
      async fetch(path) { if (path === '/api/crew-jobs') return Response.json({ ok: true, jobs }); if (path === '/api/employee-hub') return Response.json({ ok: true, collections: { timeEntries: [] } }); throw new Error(`Unexpected ${path}`); } } });
  vm.runInContext(page.slice(page.lastIndexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>')), context);
  await context.openCrewHome();
  return element('next-work').innerHTML;
}

test('the next-job card shows the arrival window, escaped, and nothing when the job has none', async () => {
  const card = await crewHome([job({ arrivalWindow: '9:00–10:00 AM <i>' })]);
  assert.match(card, /<div><span>Arrive<\/span><strong>9:00–10:00 AM &lt;i&gt;<\/strong><\/div>/);
  assert.match(card, /<span>Time<\/span><strong>09:00–12:00<\/strong><\/div><div><span>Arrive<\/span>/, 'right after the job time');
  const none = await crewHome([job({})]);
  assert.doesNotMatch(none, /Arrive/);
  assert.match(none, /<span>Time<\/span>/);
});

test('on a split job the window shows only for the crew whose segment is the job’s first day', async () => {
  const split = viewer => crewJobProjection({ id: 'job-split', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customer: 'Synthetic Customer', address: '1 Fixture Way, Fort Collins, CO 80525',
    serviceType: 'Garage cleanout', date: '2026-09-22', endDate: '2026-09-23', time: '09:00', endTime: '15:00', arrivalWindow: '9:00–10:00 AM', assignedCrew: ['crew.one', 'crew.two'], assignmentSegments: [
      { id: 'seg-a', date: '2026-09-22', time: '09:00', endDate: '2026-09-22', endTime: '15:00', assignedCrew: ['crew.one'] },
      { id: 'seg-b', date: '2026-09-23', time: '13:00', endDate: '2026-09-23', endTime: '17:00', assignedCrew: ['crew.two'] },
    ] }, { viewer, now: new Date(NOW) });
  const first = split('crew.one'), later = split('crew.two');
  assert.deepEqual([first.date, first.arrivalWindow], ['2026-09-22', '9:00–10:00 AM']);
  assert.deepEqual([later.date, later.time, later.arrivalWindow], ['2026-09-23', '13:00', ''], 'the later segment never carries the first visit’s window');
  assert.match(await crewHome([first]), /<span>Arrive<\/span><strong>9:00–10:00 AM<\/strong>/);
  assert.doesNotMatch(await crewHome([later]), /Arrive/);
});
