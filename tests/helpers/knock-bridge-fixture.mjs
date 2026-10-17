// KNOCK-BRIDGE test world: the real /api/knock-* handlers, the real dispatch storage and dispatch service, one
// in-memory Firestore REST fake for both (as production shares one Firestore project). Synthetic data only.
import { createHubSessionCookie } from '../../functions/_lib/hub-session.js';
import { dispatchStorage } from '../../functions/_lib/dispatch-storage.js';
import { knockSyncHandlers } from '../../functions/api/knock-sync.js';
import { knockJobBridgeHandlers } from '../../functions/api/knock-job-bridge.js';
import { knockCrewOpeningsHandlers } from '../../functions/api/knock-crew-openings.js';
import { knockWalkthroughSlotsHandlers } from '../../functions/api/knock-walkthrough-slots.js';
import { knockReportsHandlers } from '../../functions/api/knock-reports.js';
import { knockAdminHandlers } from '../../functions/api/knock-admin.js';
import { knockMeHandlers } from '../../functions/api/knock-me.js';
import { call, get, knockWorld, post } from './knock-fixture.mjs';

// Tuesday 2026-10-20, 11:00 am in Fort Collins (after the 9:30 start policy date). A sale today may start a job on
// Saturday 2026-10-24 or later (three business days to cancel); 2026-10-26 is a Monday.
export const NOW = Date.parse('2026-10-20T17:00:00.000Z');
export const MON = '2026-10-26', TUE = '2026-10-27', SAT = '2026-10-24';
export const CHECKLIST = { contractSigned: true, noticesHanded: true, rightToCancelTold: true };
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
export const iso = ms => new Date(ms).toISOString();
export const MIN = 60000;

let counter = 0;
export const id = () => `00000000-0000-4000-9000-${String(++counter).padStart(12, '0')}`;

export const USERS = {
  ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Zac' },
  'Rep.One': { passwordHash: 'test', role: 'sales', displayName: 'Rep One' },
  'Rep.Two': { passwordHash: 'test', role: 'crew', displayName: 'Rep Two' },
  'Crew.A1': { passwordHash: 'test', role: 'crew', displayName: 'Andy Alpha' },
  'Crew.A2': { passwordHash: 'test', role: 'crew', displayName: 'Abe Alpha' },
  'Crew.B1': { passwordHash: 'test', role: 'crew', displayName: 'Bo Beta' },
  'Crew.B2': { passwordHash: 'test', role: 'crew', displayName: 'Ben Beta' },
  'Crew.C1': { passwordHash: 'test', role: 'crew', displayName: 'Cy Gamma' },
  'Est.Alex': { passwordHash: 'test', role: 'sales', displayName: 'Alex Estimator' },
  'Est.Bea': { passwordHash: 'test', role: 'sales', displayName: 'Bea Estimator' },
};

export const crewDoc = (name, memberIds, extra = {}) => ({ recordType: 'crew', name, memberIds, leadId: memberIds[0], status: 'active', ...extra });
export const CREWS = {
  'dispatchResources/crew_one': crewDoc('Crew 1', ['crew.a1', 'crew.a2'], { priority: 1, serviceDays: WEEKDAYS, code: 'crew-1' }),
  'dispatchResources/crew_two': crewDoc('Crew 2', ['crew.b1', 'crew.b2'], { priority: 2, serviceDays: WEEKDAYS, code: 'crew-2' }),
  'dispatchResources/crew_three': crewDoc('Crew 3', ['crew.c1'], { priority: 3, serviceDays: ['sat', 'sun'], code: 'crew-3' }),
};

// An existing visit that keeps a crew (or an estimator) busy: another customer's job.
export const busy = (date, members, extra = {}) => ({ type: 'job', date, time: '09:00', endDate: date, endTime: '17:00', assignedCrew: members, assignedTo: members.join(', '),
  status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'customer_other', customer: 'Other Synthetic Customer', address: '9 Elsewhere Ct, Fort Collins, CO 80525', ...extra });

export function seed(extra = {}) {
  const houses = {};
  for (const n of [2900, 2902, 2904, 2906]) houses[`knock_houses/h-${n}-blue-leaf-dr`] = { neighborhoodId: 'english-ranch', street: 'BLUE LEAF DR', number: String(n), unit: '', lat: 40.55, lng: -105.03, updatedAt: '2026-10-01T00:00:00.000Z' };
  return {
    'knock_neighborhoods/english-ranch': { name: 'English Ranch', tier: 'Volume', status: 'open', cityKey: 'fort-collins', holdReason: '' },
    'knock_reps/rep.one': { repKey: 'rep.one', username: 'Rep.One', displayName: 'Rep One', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false, leadKey: '' },
    'knock_reps/rep.two': { repKey: 'rep.two', username: 'Rep.Two', displayName: 'Rep Two', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false, leadKey: '' },
    'knock_assignments/rep.one__english-ranch__all': { repKey: 'rep.one', neighborhoodId: 'english-ranch', street: '', active: true },
    'knock_assignments/rep.two__english-ranch__all': { repKey: 'rep.two', neighborhoodId: 'english-ranch', street: '', active: true },
    ...houses, ...CREWS, ...extra,
  };
}

export async function bridgeWorld({ bridge = true, autoCrew = true, env: more = {}, seed: extra = {}, crews = true } = {}) {
  const base = seed(extra);
  if (!crews) for (const key of Object.keys(CREWS)) delete base[key];
  const env = {
    HUB_SESSION_SECRET: 'knock-bridge-test-session-secret-0123456789abcdef', FIREBASE_API_KEY: 'firebase-test-knock', HUB_AUTH_USERS_JSON: JSON.stringify(USERS),
    // No employee-account vault: the dispatch roster is the configured Hub users above.
    EMPLOYEE_HUB_LEGACY_KEY_SOURCE: 'none',
    ...(bridge ? { EGC_KNOCK_JOB_BRIDGE: 'true' } : {}), ...(autoCrew ? { EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true' } : {}), ...more,
  };
  const world = knockWorld(base);
  let clock = NOW;
  const now = () => new Date(clock);
  let dispatchDown = false;
  const dispatch = e => {
    const store = dispatchStorage(e, world.fake.fetcher);
    return dispatchDown ? { ...store, read: async () => { throw Object.assign(new Error('Dispatch storage is unavailable.'), { code: 'dispatch_storage_unavailable', status: 503 }); } } : store;
  };
  const deps = { storage: world.storage, now, dispatch };
  const h = {
    sync: knockSyncHandlers({ storage: world.storage, now }), bridge: knockJobBridgeHandlers(deps), openings: knockCrewOpeningsHandlers(deps),
    slots: knockWalkthroughSlotsHandlers(deps), reports: knockReportsHandlers(deps), admin: knockAdminHandlers(deps), me: knockMeHandlers({ storage: world.storage, now }),
  };
  const cookie = async user => (await createHubSessionCookie(env, user)).split(';')[0];
  const cookies = { rep: await cookie('Rep.One'), two: await cookie('Rep.Two'), zac: await cookie('ZacB') };
  return {
    env, world, fake: world.fake, h, cookies, setClock: value => { clock = value; }, setDispatchDown: value => { dispatchDown = value; },
    dispatchStore: () => dispatchStorage(env, world.fake.fetcher),
    send: (events, who = cookies.rep) => call(h.sync.post, post('/api/knock-sync', { events }, who), env),
    book: (kind, recordId, who = cookies.rep) => call(h.bridge.post, post('/api/knock-job-bridge', { kind, id: recordId }, who), env),
    crewSlots: (query = '', who = cookies.rep) => call(h.openings.get, get(`/api/knock-crew-openings${query}`, who), env),
    walkSlots: (who = cookies.rep) => call(h.slots.get, get('/api/knock-walkthrough-slots', who), env),
    report: (view, who = cookies.rep) => call(h.reports.get, get(`/api/knock-reports?view=${view}`, who), env),
    admin: (body, who = cookies.zac) => call(h.admin.post, post('/api/knock-admin', body, who), env),
    me: (who = cookies.rep) => call(h.me.get, get('/api/knock-me', who), env),
    docs: prefix => [...world.fake.documents.keys()].filter(path => path.startsWith(prefix)).map(path => ({ path, ...world.fake.get(path) })),
  };
}

// A shift, a Sold door and its sale on house h-<n>-blue-leaf-dr.
export function saleBatch({ n = 2900, shiftId = id(), knockId = id(), saleId = id(), at = NOW - 5 * MIN, sale = {} } = {}) {
  return {
    shiftId, knockId, saleId,
    events: [
      { id: id(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: iso(NOW - 30 * MIN) },
      { id: knockId, type: 'knock', shiftId, houseId: `h-${n}-blue-leaf-dr`, outcome: 'sold', quotedAmount: 1600, carOutside: false, at: iso(at) },
      { id: saleId, type: 'sale', knockId, houseId: `h-${n}-blue-leaf-dr`, at: iso(at + MIN), ticket: 1600, package: 'The Works',
        customer: { name: `Pat Synthetic ${n}`, phone: `(970) 555-0${String(n).slice(-3)}`, email: `pat${n}@example.com` }, checklist: CHECKLIST,
        jobDate: MON, jobStartTime: '09:30', textConsent: false, ...sale },
    ],
  };
}
