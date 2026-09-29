/** In-memory revisioned store for recurring-plan, horizon and money tests: Map
 * rows, a revision counter, create-only writes without a revision, updateTime
 * preconditions with one, and no duplicate targets per commit. store.jobs()
 * returns what production's dispatchStorage scan returns: every job masked to
 * JOB_FIELDS (no money, plan or estimate fields); read() returns the whole
 * document. Synthetic data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mutateDispatch } from '../../functions/_lib/dispatch-service.js';
import { JOB_FIELDS } from '../../functions/_lib/dispatch-storage.js';
import { mutateRecurringPlan } from '../../functions/_lib/recurring-plan-service.js';

export const NOW = '2026-09-22T12:00:00.000Z';
export const manager = { user:'zacb', displayName:'Synthetic Owner', role:'owner', businessAccess:true };
export const PROFILES = [
  { user:'zacb', displayName:'Synthetic Owner', role:'owner', businessAccess:true },
  { user:'tylerg', displayName:'Synthetic Manager', role:'manager', businessAccess:true },
  { user:'alexk', displayName:'Synthetic Sales', role:'sales', businessAccess:true },
];

/** A Firestore field mask: dotted paths keep only that nested field. */
export function maskJob(row, fields = JOB_FIELDS) {
  const out = {};
  for (const path of fields) {
    const parts = path.split('.'), leaf = parts.pop();
    const parent = parts.reduce((node, part) => node && typeof node === 'object' && !Array.isArray(node) ? node[part] : undefined, row);
    if (!parent || typeof parent !== 'object' || !(leaf in parent)) continue;
    parts.reduce((node, part) => node[part] ??= {}, out)[leaf] = parent[leaf];
  }
  return { ...out, id:row.id, revision:row.revision };
}

export function recurringFixture() {
  const rows = new Map([
    ['customers/c1', { id:'c1', name:'Synthetic Customer', phone:'+1 (970) 555-0100', address:'100 Synthetic Street', revision:'c1r' }],
    ['customers/c2', { id:'c2', name:'Synthetic Neighbor', phone:'+1 (970) 555-0111', address:'200 Synthetic Street', revision:'c2r' }],
  ]);
  let revision = 0;
  const commits = [], clone = value => structuredClone(value);
  const all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
  const roster = [{ id:'zacb', name:'Synthetic Owner', role:'owner' }, { id:'crew1', name:'Synthetic Crew One', role:'crew' }, { id:'crew2', name:'Synthetic Crew Two', role:'crew' }];
  const store = {
    jobs: async () => all('jobs').map(row => maskJob(row)), resources: async () => all('dispatchResources'), customers: async () => all('customers'), recurringPlans: async () => all('recurringPlans'), roster: async () => clone(roster),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => {
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'No duplicate writes per document'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old) && !write.exists) throw Object.assign(new Error('Conflict'), { code:'dispatch_revision_conflict', status:409 });
      }
      commits.push(writes.map(write => `${write.collection}/${write.id}`));
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id:write.id, revision:`r${++revision}` });
    },
  };
  const book = async (changes = {}, extra = {}, now = NOW) => (await mutateDispatch(store, manager, { action:'schedule.create', requestId:randomUUID(), customerId:'c1', kind:'job', changes:{ date:'2026-09-23', time:'08:00', endTime:'10:00', assignedCrew:['crew1'], jobInstructions:'Reset the garage', serviceType:'Garage reset', ...changes }, ...extra }, now)).job;
  const plan = (input, now = NOW, options = { enabled:true, pricing:true }, actor = manager) => mutateRecurringPlan(store, actor, { requestId:randomUUID(), ...input }, now, options);
  const create = async (fields = {}) => { const template = await book(); return { template, result: await plan({ action:'create', plan:{ templateJobId:template.id, cadence:{ frequency:'weekly' }, horizonDays:28, ...fields } }) }; };
  const jobs = () => all('jobs').filter(row => row.type === 'job');
  const job = id => clone(rows.get('jobs/' + id));
  const saved = id => clone(rows.get('recurringPlans/' + id));
  const mutate = (input, now = NOW) => mutateDispatch(store, manager, { requestId:randomUUID(), changes:{}, ...input }, now);
  return { rows, store, roster, commits, book, plan, create, jobs, job, saved, mutate, all };
}
