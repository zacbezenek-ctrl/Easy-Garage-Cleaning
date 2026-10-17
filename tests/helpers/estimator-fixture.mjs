// Shared synthetic fixture for the estimator integration tests (tests/estimator-e2e.test.mjs and
// tests/estimator-flag-off.test.mjs): one in-memory store that serves the quote draft, the signed walkthrough handoff,
// Dispatch (crews, openings, day locks) and the purchase list. Synthetic data only; every clock and id is injected.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { walkthroughPricing, walkthroughServiceItems } from '../../functions/_lib/pricing-config.js';
import { menuItemIdentity } from '../../functions/_lib/composite-quote.js';

// 2026-10-17 is a Saturday: the walkthrough is today, the job goes on Monday 2026-10-19 (or Saturday 2026-10-24).
export const NOW = '2026-10-17T15:00:00.000Z', LATER = '2026-10-17T15:05:00.000Z', MON = '2026-10-19', TUE = '2026-10-20', SAT = '2026-10-24';
export const owner = { user: 'zacb', role: 'owner', businessAccess: true, displayName: 'Synthetic Owner' };
export const estimator = { user: 'sales.person', role: 'sales', businessAccess: false, displayName: 'Synthetic Estimator', staffRoles: ['sales'] };
export const BASE_ENV = { HUB_SESSION_SECRET: 'synthetic-estimator-e2e-session-secret-0123456789', EGC_STAFF_ROLE_PERMISSIONS: 'true' };
export const ON_ENV = { ...BASE_ENV, EGC_QUOTE_BUILDER_ENABLED: 'true', EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true', EGC_JOB_MATERIALS: 'true', EGC_GHL_SCHEDULE_MIRROR: 'true' };

export const menu = JSON.parse(readFileSync(new URL('../../functions/_data/pricing-menu.json', import.meta.url), 'utf8'));
const settings = JSON.parse(readFileSync(new URL('../../functions/_data/pricing-settings.defaults.json', import.meta.url), 'utf8'));
export const menuItem = name => menu.services.find(item => item.name === name) || menu.products.find(item => item.name === name);
export const SHELF = menu.products.find(item => item.id === 'hd-100006678');
export const TOTES = menu.products.find(item => item.id === 'hd-341048322');
/** The builder's pricing state; approvals {id: unitCents} are recorded for the current menu item (menuItemIdentity). */
export const builderState = (approvals = {}, extra = {}) => ({ menu, settings: { ...settings, ...extra }, walkthrough: walkthroughPricing(walkthroughServiceItems()),
  approvals: { items: Object.fromEntries(Object.entries(approvals).map(([id, unitCents]) => [id, { unitCents, identity: menuItemIdentity(menu.services.find(item => item.id === id) || menu.products.find(item => item.id === id)) }])), revision: Object.keys(approvals).length ? 'approvals-1' : null } });
/** The estimator's builder selection: removal, then shelving, then extra storage. */
export const selection = ({ removal = [{ id: menuItem('Two-car garage base').id, quantity: 1 }, { id: menuItem('Full truck load').id, quantity: 1 }], shelving = [{ id: SHELF.id, quantity: 2 }], storage = [{ id: TOTES.id, quantity: 2 }] } = {}) =>
  ({ menuVersion: menu.menuVersion, settingsVersion: settings.settingsVersion, steps: ['removal', 'shelving', 'storage'], removal, shelving, storage });

const crew = (id, name, memberIds, extra = {}) => ({ id, recordType: 'crew', name, memberIds, leadId: memberIds[0] || null, status: 'active', revision: `${id}r`, ...extra });
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
export const client = (n = 1) => ({ name: `Synthetic Customer ${n}`, phone: `970555010${n}`, email: `customer${n}@example.invalid`, address: `${n}00 Fixture Lane`, highlevel_contact_id: `provider${n}` });

/** rows: customers c1..c4 with walkthroughs w1..w4 (today) and projects; Crew 1/2 weekdays, Crew 3 weekends. */
export function fixture(env = ON_ENV, { crews = true } = {}) {
  const rows = new Map();
  for (const n of [1, 2, 3, 4]) {
    const c = client(n);
    rows.set(`customers/c${n}`, { id: `c${n}`, revision: `c${n}r`, name: c.name, phone: c.phone, email: c.email, address: c.address, highlevelContactId: c.highlevel_contact_id });
    rows.set(`jobs/w${n}`, { id: `w${n}`, revision: `w${n}r`, type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: `c${n}`, customer: c.name, highlevelContactId: c.highlevel_contact_id, date: '2026-10-17', time: '09:00', endTime: '10:00', projectId: `p${n}`, assignedCrew: ['sales.person'] });
    rows.set(`projects/p${n}`, { id: `p${n}`, revision: `p${n}r`, customerId: `c${n}`, sourceRecordId: `w${n}`, sourceWalkthroughId: `w${n}` });
  }
  if (crews) for (const row of [crew('crew_one', 'Crew 1', ['c1a', 'c1b'], { priority: 1, serviceDays: WEEKDAYS, code: 'crew-1' }), crew('crew_two', 'Crew 2', ['c2a', 'c2b'], { priority: 2, serviceDays: WEEKDAYS, code: 'crew-2' }),
    crew('crew_three', 'Crew 3', ['c3a', 'c3b'], { priority: 3, serviceDays: ['sat', 'sun'], code: 'crew-3' })]) rows.set(`dispatchResources/${row.id}`, row);
  let revision = 0;
  const calls = [];
  const clone = value => structuredClone(value);
  const all = prefix => [...rows.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => clone(value));
  const roster = ['zacb', 'sales.person', 'c1a', 'c1b', 'c2a', 'c2b', 'c3a', 'c3b'].map(id => ({ id, name: `Synthetic ${id}`, role: id === 'zacb' ? 'owner' : id === 'sales.person' ? 'sales' : 'crew' }));
  const store = {
    // As dispatchStorage(env) does: the HighLevel schedule mirror commits with each schedule change only while it is on.
    ghlScheduleMirror: env.EGC_GHL_SCHEDULE_MIRROR === 'true',
    jobs: async () => all('jobs/'), resources: async () => all('dispatchResources/'), customers: async () => all('customers/'), roster: async () => clone(roster),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => {
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!keys.has(key), `one write per document: ${key}`); keys.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      calls.push(clone(writes));
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
  // The office purchase list's storage (purchase-list.js purchaseListStorage): jobs dated start..end.
  const purchaseStore = { listJobs: async (start, end) => all('jobs/').filter(job => typeof job.date === 'string' && job.date >= start && job.date <= end) };
  return { rows, store, purchaseStore, calls, job: id => rows.get(`jobs/${id}`), writesTo: collection => calls.flat().filter(write => write.collection === collection) };
}

/** The signed walkthrough plan as crew/gameplan.html payload() sends it (the parts the server reads). */
export function signedPlan(n = 1, { total = 1400, date = MON, start = '09:30', end = '12:30', minutes = 180, quote = {}, logistics = {} } = {}) {
  return {
    client: client(n),
    quote: { title: 'EGC Garage Service', total, deposit: Math.round(Math.round(total * 100) / 2) / 100, job_date: date, start_time: start, end_time: end, estimated_duration_min: minutes, ...quote },
    acceptance: { accepted_at: '2026-10-17T14:55:00.000Z', accepted_by: client(n).name, signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' },
    signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 4 },
    scope: { loads: '1', garages: '2', fullness: 'Medium', keep_items: 'Blue bicycle', remove_items: 'Old cartons', finish: ['cleanout'] }, discovery: { success: 'Park two cars' },
    logistics: { crew_size: 2, assigned_to: 'Crew of 2', notes: 'Side gate', bring_list: ['Hand truck / dolly', 'Contractor bags'], ...logistics },
    internal_notes: 'Synthetic internal brief', crew_brief: 'Synthetic crew brief', client_checklists: { preJob: [{ id: 'keep-bike', label: 'Protect blue bicycle', detail: 'Move to safe area', critical: true }], postJob: [] }, notes: 'Call before arrival',
  };
}
