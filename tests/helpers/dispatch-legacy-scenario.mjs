// A deterministic dispatch day (DISPATCH-RULES finding 4): the outputs a Hub
// deployment sees with no owner dispatch settings saved and the staff directory
// off (no recorded skills or weekly hours). tests/snapshots/dispatch-legacy-output.json
// is this scenario run against dispatch code WITHOUT DISPATCH-RULES, so
// tests/dispatch-rules.test.mjs can compare the current code with it. It was
// first taken at 3d68c99 and regenerated when the integration branch merged in
// (DISPATCH-DURATION's suggested length on job DTOs, FUN-02/FUN-29 funnel events
// and booking fields): it is now the output of the integration tip that merge
// brought in (b96ee8e, and 4196ca5 after CREW-NOTIFY and QUOTE-DRAFT, which gives
// byte-identical output), which has none of this unit's code. Never regenerate that
// file from the current tree; that would compare the code with itself. To
// rebuild it after another merge that changes save output, use the tree the
// merge brought in (never the merged tree):
//   git archive <pre-unit commit> functions | tar -x -C /tmp/pre-unit
//   (link node_modules/@noble into /tmp/pre-unit), then
//   node tests/helpers/dispatch-legacy-scenario.mjs /tmp/pre-unit > tests/snapshots/dispatch-legacy-output.json
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCENARIO_NOW = '2026-09-22T12:00:00.000Z';
const FC = '100 Synthetic Oak Street, Fort Collins, CO 80525', LOVELAND = '200 Synthetic Elm Avenue, Loveland, CO 80537';
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
// Fixed request ids keep receipt ids and fingerprints stable.
const request = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The dispatch functions of the tree at `root` (a repository checkout). */
export async function loadDispatchModules(root) {
  const lib = file => import(pathToFileURL(join(root, 'functions', '_lib', file)).href);
  const [service, travel, openings] = await Promise.all([lib('dispatch-service.js'), lib('dispatch-travel.js'), lib('dispatch-openings.js')]);
  return { mutateDispatch: service.mutateDispatch, mutateDispatchSelfAssignment: service.mutateDispatchSelfAssignment, dispatchOverview: service.dispatchOverview, dispatchOpenings: openings.dispatchOpenings, travelEstimator: travel.travelEstimator };
}

function memoryStore() {
  const rows = new Map([
    ['customers/c1', { id: 'c1', name: 'Synthetic Customer One', phone: '970-555-0101', address: FC, revision: 'c1r' }],
    ['customers/c2', { id: 'c2', name: 'Synthetic Customer Two', phone: '970-555-0102', address: LOVELAND, revision: 'c2r' }],
    ['customers/c3', { id: 'c3', name: 'Synthetic Customer Three', phone: '970-555-0103', address: FC, revision: 'c3r' }],
    // Saved before dispatch kept endDate, assignedCrew or crewNeeded: one assignedTo display name.
    ['jobs/legacy', { id: 'legacy', type: 'job', customerId: 'c3', customer: 'Synthetic Customer Three', address: FC, jobInstructions: 'Synthetic scope', serviceType: 'Synthetic garage cleanout', status: 'scheduled', date: '2026-09-24', time: '08:00', endTime: '10:00', assignedTo: 'Synthetic Crew One', travelBufferMinutes: 0, revision: 'rev-legacy' }],
  ]);
  // The staff directory is off: the roster has no skills or weekly hours.
  const roster = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'crew1', name: 'Synthetic Crew One', role: 'crew' }, { id: 'crew2', name: 'Synthetic Crew Two', role: 'crew' }];
  let revision = 0;
  const clone = value => structuredClone(value), all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
  const store = {
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(roster),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    readMany: async (collection, ids) => ids.map(id => rows.get(`${collection}/${id}`)).filter(Boolean).map(clone),
    commit: async writes => {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        if (seen.has(key)) throw new Error('Duplicate write in one commit: ' + key);
        seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
  return { rows, store };
}

/** Runs the day with the given dispatch functions. `saves` are the mutation
 * responses in order; `documents` is every stored document afterwards (jobs,
 * day locks, receipts, projects, the dispatch guard); the reads come last. */
export async function legacyDispatchScenario({ mutateDispatch, mutateDispatchSelfAssignment, dispatchOverview, dispatchOpenings, travelEstimator }) {
  const { rows, store } = memoryStore(), now = new Date(SCENARIO_NOW);
  const travel = () => travelEstimator({ env: { EGC_DISPATCH_TRAVEL_ESTIMATES: 'offline' }, store, fetcher: () => { throw new Error('The legacy scenario never calls a provider.'); }, now: () => now });
  const saved = id => rows.get(`jobs/${id}`);
  const saves = [];
  // A save's job DTO stamps jobTime.asOf with the real clock (projectDispatchJob
  // without `now`, before and after this unit); it is the one value masked here.
  const masked = result => result.job?.jobTime?.asOf && Number.isFinite(Date.parse(result.job.jobTime.asOf)) ? { ...result, job: { ...result.job, jobTime: { ...result.job.jobTime, asOf: 'real clock' } } } : result;
  const save = async (input, options) => { const result = await mutateDispatch(store, owner, input, SCENARIO_NOW, options); saves.push(masked(result)); return result; };
  // 1. A two-person open shift (default travel buffer), and a second stop for the same employee.
  const open = await save({ action: 'schedule.create', requestId: request(1), customerId: 'c1', kind: 'job', changes: { date: '2026-09-23', time: '09:00', endTime: '11:00', assignedCrew: ['crew1'], crewNeeded: 2, shiftPickupEnabled: true, jobInstructions: 'Synthetic scope' } });
  const second = await save({ action: 'schedule.create', requestId: request(2), customerId: 'c2', kind: 'job', changes: { date: '2026-09-23', time: '13:00', endTime: '14:00', assignedCrew: ['crew1'], travelBufferMinutes: 0, jobInstructions: 'Synthetic scope' } });
  // 2. The dispatch editor's full-form save of the legacy row, changing only its notes.
  const dto = (await dispatchOverview(store, owner, { view: 'job', jobId: 'legacy' }, now)).job;
  await save({ action: 'schedule.update', requestId: request(3), jobId: 'legacy', expectedRevision: dto.revision, changes: {
    date: dto.date, time: dto.time, endDate: dto.endDate || dto.date, endTime: dto.endTime, serviceType: dto.serviceType || '', address: dto.address || '', assignedCrew: dto.assignedCrew, crewId: dto.crewId || null,
    crewLead: dto.crewLead || null, vehicleId: dto.vehicleId || null, crewNeeded: dto.crewNeeded || 1, travelBufferMinutes: dto.travelBufferMinutes ?? 20, jobInstructions: dto.jobInstructions || '', accessInstructions: dto.accessInstructions || '',
    customerInstructions: dto.customerInstructions || '', opsNotes: 'Synthetic gate code updated', requiredEquipment: dto.requiredEquipment || [], materials: dto.materials || [], arrivalWindowStart: dto.arrivalWindowStart || null, arrivalWindowEnd: dto.arrivalWindowEnd || null } });
  // 3. A move with drive estimates: Fort Collins to Loveland is about 30 minutes, the gap is 20 (a warning).
  await save({ action: 'schedule.update', requestId: request(4), jobId: second.job.id, expectedRevision: saved(second.job.id).revision, changes: { time: '11:20', endTime: '12:20' } }, { travel: travel() });
  // 4. A crew claim with drive estimates, on a shift with no neighbouring stop. (Next
  // to a short drive a claim now reports it, a documented change: dispatch-contract.js.)
  const later = await save({ action: 'schedule.create', requestId: request(5), customerId: 'c1', kind: 'job', changes: { date: '2026-09-25', time: '09:00', endTime: '11:00', assignedCrew: ['crew1'], crewNeeded: 2, shiftPickupEnabled: true, jobInstructions: 'Synthetic scope' } });
  saves.push(await mutateDispatchSelfAssignment(store, { user: 'crew2' }, { action: 'claim', jobId: later.job.id, requestId: request(6) }, SCENARIO_NOW, { travel: travel() }));
  // 5. A cancellation.
  await save({ action: 'schedule.cancel', requestId: request(7), jobId: second.job.id, expectedRevision: saved(second.job.id).revision, cancellationReason: 'Synthetic customer request' });
  const documents = Object.fromEntries([...rows.entries()].sort(([a], [b]) => a.localeCompare(b)));
  return {
    saves, documents,
    board: await dispatchOverview(store, owner, { startDate: '2026-09-23', endDate: '2026-09-26' }, now, { travel: travel() }),
    jobView: await dispatchOverview(store, owner, { view: 'job', jobId: open.job.id }, now, { travel: travel() }),
    openings: await dispatchOpenings(store, owner, { startDate: '2026-09-23', endDate: '2026-09-26', durationMinutes: '60', employeeIds: 'crew1' }, now),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node tests/helpers/dispatch-legacy-scenario.mjs <pre-unit tree>');
  process.stdout.write(JSON.stringify(await legacyDispatchScenario(await loadDispatchModules(process.argv[2])), null, 1) + '\n');
}
