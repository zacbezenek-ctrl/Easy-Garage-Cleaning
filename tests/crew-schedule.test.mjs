import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { CREW_SCHEDULE_FIELDS, CREW_SCHEDULE_HISTORY_DAYS, CREW_SCHEDULE_LOOKBACK_DAYS, CREW_SCHEDULE_MAX_DAYS, areaOf, crewSchedule, firstName, scheduleWindow } from '../functions/_lib/crew-schedule.js';
import { crewScheduleHandlers, leadNames } from '../functions/api/crew-schedule.js';

// CREW-SCHEDULE (WP6, owner decision D6 2026-10-17): GET /api/crew-schedule. Synthetic people and customers only; the
// clock is fixed at Friday 2026-10-16 09:00 Mountain Time.
const NOW = new Date('2026-10-16T15:00:00.000Z');
const ORIGIN = 'https://easygaragecleaning.com';
const ACCESS = { EGC_STAFF_ROLE_ACCESS: 'true' }, PERMISSIONS = { EGC_STAFF_ROLE_PERMISSIONS: 'true' };
const ENV = { FIREBASE_API_KEY: 'firebase-test-crew-schedule' };
// Every role-flag combination: seeing every crew must never depend on EGC_STAFF_ROLE_ACCESS (or EGC_STAFF_ROLE_PERMISSIONS).
const FLAG_SETS = [{}, PERMISSIONS, ACCESS, { EGC_STAFF_ROLE_ACCESS: 'false', EGC_STAFF_ROLE_PERMISSIONS: 'true' }];
const person = (user, extra = {}) => ({ user, displayName: `Synthetic ${user}`, role: 'crew', businessAccess: false, source: 'employee-account', ...extra });
const SESSIONS = {
  ana: person('ana.lead'), ben: person('ben.crew'), cara: person('cara.crew'), dee: person('dee.solo'),
  eli: person('eli.team', { staffRoles: ['team_lead'] }), crewLead: person('fay.lead', { staffRoles: ['crew_lead'] }),
  sales: person('gus.sales', { role: 'sales', staffRoles: ['sales'] }), phone: person('hal.phone', { staffRoles: ['phone'] }),
  tyler: { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true },
};
const CREWS = [
  { id: 'crew_two', recordType: 'crew', name: 'Crew 2', code: 'crew-2', priority: 2, serviceDays: ['mon', 'tue', 'wed', 'thu', 'fri'], memberIds: ['cara.crew'], leadId: 'cara.crew', status: 'active' },
  { id: 'crew_one', recordType: 'crew', name: 'Crew 1', code: 'crew-1', priority: 1, serviceDays: ['fri', 'mon'], memberIds: ['ana.lead', 'ben.crew'], leadId: 'ana.lead', status: 'active' },
  { id: 'crew_weekend', recordType: 'crew', name: 'Crew 3', memberIds: ['eli.team'], leadId: null, status: 'active' },
  { id: 'crew_old', recordType: 'crew', name: 'Retired crew', memberIds: ['ben.crew'], leadId: 'ben.crew', status: 'inactive' },
];
// The money, phone, notes and street fields are on the stored rows on purpose: none may reach a schedule.
const MONEY = { total: 1250, quoteAmount: 1250, priceQuoted: 1250, amount: 1250, estimate: { amount: 1250, depositRequired: 625, lineItems: [{ name: 'Synthetic line', price: 1250 }] }, phone: '9705550142', notes: 'Synthetic office note: gate code 4242', jobInstructions: 'Synthetic instructions' };
const job = (id, changes = {}) => ({ id, revision: `${id}-r1`, type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', customer: 'Synthetic Customer Person', address: '100 Fixture Lane, Fort Collins, CO 80525', serviceType: 'Garage cleanout',
  date: '2026-10-16', endDate: '2026-10-16', time: '09:30', endTime: '13:00', assignedCrew: [], crewNeeded: 2, ...MONEY, ...changes });
const JOBS = [
  job('job_crew1_ana', { crewId: 'crew_one', assignedCrew: ['ana.lead'], crewLead: 'ana.lead', customer: 'Alma Synthetic' }),
  job('job_crew2', { crewId: 'crew_two', assignedCrew: ['cara.crew'], crewLead: 'cara.crew', customer: 'Bea Synthetic', time: '13:30', endTime: '16:00', address: '7 Sample Ct, Loveland, CO 80537' }),
  job('job_unassigned', { customer: 'Cy Synthetic', crewNeeded: 3, time: '10:00', endTime: '12:00', address: '9 Example Rd, Windsor, CO 80550' }),
  job('job_dee_solo', { assignedCrew: ['dee.solo'], customer: 'Dot Synthetic', time: '11:00', endTime: '12:00' }),
  job('job_multiday', { crewId: 'crew_one', assignedCrew: ['ben.crew'], customer: 'Eve Synthetic', date: '2026-10-14', endDate: '2026-10-17', time: '09:30', endTime: '15:00' }),
  job('job_next_week', { crewId: 'crew_one', assignedCrew: ['ana.lead', 'ben.crew'], crewLead: 'ana.lead', customer: 'Flo Synthetic', date: '2026-10-21', endDate: '2026-10-21' }),
  job('job_cancelled', { crewId: 'crew_one', assignedCrew: ['ana.lead'], status: 'cancelled', pipelineStatus: 'cancelled', customer: 'Gil Synthetic' }),
  job('walk_1', { type: 'walkthrough', assignedCrew: ['ana.lead'], customer: 'Hal Synthetic' }),
  job('block_1', { type: 'blocked', crewId: 'crew_one', assignedCrew: ['ana.lead'], customer: '' }),
  job('_egc_schedule_lock_2026-10-16', { recordType: 'schedule_lock', crewId: 'crew_one', assignedCrew: ['ana.lead'] }),
  job('vault_row', { recordType: 'employee_hub_v2', crewId: 'crew_one', assignedCrew: ['ana.lead'] }),
  job('job_old_crew', { crewId: 'crew_old', assignedCrew: ['cara.crew'], customer: 'Ivy Synthetic' }),
  job('job_split', { customer: 'Jo Synthetic', assignedCrew: ['cara.crew', 'ana.lead'], assignmentSegments: [
    { id: 'seg-a', date: '2026-10-16', time: '09:30', endDate: '2026-10-16', endTime: '12:00', assignedCrew: ['cara.crew'], crewLead: 'cara.crew', crewId: 'crew_two' },
    { id: 'seg-b', date: '2026-10-19', time: '09:30', endDate: '2026-10-19', endTime: '12:00', assignedCrew: ['ana.lead'], crewLead: 'ana.lead', crewId: 'crew_one' },
  ] }),
];

function harness({ jobs = JOBS, crews = CREWS, fail = false } = {}) {
  const calls = [], lookups = [];
  const storage = () => ({
    async crewResources() { calls.push(['crews']); if (fail) throw new Error('synthetic outage'); return structuredClone(crews); },
    async datedJobs(start, end, fields) { calls.push(['jobs', start, end, fields]); if (fail) throw new Error('synthetic outage'); return structuredClone(jobs).filter(row => row.date >= start && row.date <= end); },
  });
  const handlers = crewScheduleHandlers({ session: async request => SESSIONS[request.headers.get('X-Synthetic-Session')] || null, storage, names: async (env, ids) => { lookups.push([...ids].sort()); return Object.fromEntries([...ids].map(id => [id, `Name of ${id}`])); }, now: () => NOW });
  const get = async (who, query = '', env = ENV) => {
    const response = await handlers.get({ request: new Request(`${ORIGIN}/api/crew-schedule${query}`, { headers: who ? { 'X-Synthetic-Session': who } : {} }), env });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { get, calls, lookups };
}
const rows = body => [...body.groups.flatMap(group => group.jobs), ...body.unassigned];
const ids = result => rows(result.body || result).map(row => row.segmentId ? `${row.id}~${row.segmentId}` : row.id).sort();

test('a crewmate sees every job booked for their crew, and only their own assignments open', async () => {
  const { get, calls } = harness();
  const ben = await get('ben', '?from=2026-10-16&to=2026-10-22');
  assert.equal(ben.status, 200, JSON.stringify(ben.body));
  assert.equal(ben.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual([ben.body.scope, ben.body.from, ben.body.to, ben.body.timeZone, ben.body.viewer], ['mine', '2026-10-16', '2026-10-22', 'America/Denver', { user: 'ben.crew', canViewAll: false }]);
  assert.deepEqual(ids(ben), ['job_crew1_ana', 'job_multiday', 'job_next_week', 'job_split~seg-b'], 'Crew 1 work, his or a crewmate’s; never another crew’s or an inactive crew’s');
  assert.deepEqual(ben.body.groups.map(group => [group.crew.id, group.crew.name, group.crew.mine]), [['crew_one', 'Crew 1', true]]);
  const crewmate = ben.body.groups[0].jobs.find(row => row.id === 'job_crew1_ana');
  assert.deepEqual([crewmate.mine, crewmate.canOpen, crewmate.customer, crewmate.area, crewmate.lead, crewmate.crewName], [false, false, 'Alma', 'Fort Collins', 'Name of ana.lead', 'Crew 1']);
  const own = ben.body.groups[0].jobs.find(row => row.id === 'job_multiday');
  assert.deepEqual([own.mine, own.canOpen, own.date, own.days], [true, true, '2026-10-14', ['2026-10-16', '2026-10-17']], 'a multi-day job started before the window shows on its remaining days');
  // The window is bounded: start dates from 32 days back (a job spans at most 31 days) to the last day, with a field mask.
  assert.deepEqual(calls.find(call => call[0] === 'jobs').slice(1, 3), ['2026-09-14', '2026-10-22']);
  assert.deepEqual(calls.find(call => call[0] === 'jobs')[3], [...CREW_SCHEDULE_FIELDS]);
  const ana = await get('ana', '?from=2026-10-16&to=2026-10-16');
  assert.deepEqual(ids(ana), ['job_crew1_ana', 'job_multiday', 'walk_1'], 'her own walkthrough is on her schedule (D2D-BOARD)');
  assert.deepEqual(rows(ana.body).map(row => [row.id, row.mine, row.canOpen]), [['job_crew1_ana', true, true], ['job_multiday', false, false], ['walk_1', true, true]]);
});

test('an estimator\'s own walkthroughs are on their schedule as Walkthrough rows; nobody else\'s ever shows', async () => {
  const visit = (id, who, changes = {}) => job(id, { type: 'walkthrough', assignedCrew: [who], crewLead: who, serviceType: '', time: '10:00', endTime: '11:00', ...changes });
  const jobs = [...JOBS, visit('walk_gus', 'gus.sales', { customer: 'Kai Synthetic', crewId: 'crew_one' }), visit('walk_gus_cancelled', 'gus.sales', { status: 'cancelled', pipelineStatus: 'cancelled' }), visit('walk_dee', 'dee.solo', { time: '14:00', endTime: '15:00' })];
  const { get } = harness({ jobs });
  const gus = await get('sales', '?from=2026-10-16&to=2026-10-16');
  assert.equal(gus.status, 200, JSON.stringify(gus.body));
  assert.deepEqual(gus.body.groups, [], 'a walkthrough is never filed under a crew, even with a crew id on it');
  assert.deepEqual(gus.body.unassigned.map(row => [row.id, row.type, row.mine, row.canOpen, row.customer, row.area, row.crewId, row.time, row.endTime]),
    [['walk_gus', 'walkthrough', true, true, 'Kai', 'Fort Collins', '', '10:00', '11:00']], 'only his own, never a cancelled visit');
  for (const who of ['ben', 'cara', 'eli', 'tyler']) {
    const other = await get(who, `?from=2026-10-16&to=2026-10-16${['eli', 'tyler'].includes(who) ? '&scope=all' : ''}`);
    assert.ok(!/walk_gus|walk_dee|walk_1/.test(JSON.stringify(other.body)), `${who}: another person's walkthrough stays hidden`);
  }
  const { get: deeGet, lookups } = harness({ jobs });
  const dee = await deeGet('dee', '?from=2026-10-16&to=2026-10-16');
  assert.deepEqual(dee.body.unassigned.map(row => [row.id, row.type, row.lead]), [['job_dee_solo', 'job', ''], ['walk_dee', 'walkthrough', '']]);
  assert.deepEqual(lookups, [], 'a walkthrough names no lead, so it costs no name lookup');
});

test('someone not on the crew never sees its jobs; their own work on no crew shows on its own', async () => {
  const { get } = harness();
  const cara = await get('cara', '?from=2026-10-16&to=2026-10-22');
  assert.deepEqual(ids(cara), ['job_crew2', 'job_old_crew', 'job_split~seg-a'], 'Crew 2 work plus her own assignment on an inactive crew; nothing of Crew 1');
  assert.ok(!JSON.stringify(cara.body).includes('Alma') && !JSON.stringify(cara.body).includes('Eve'));
  const dee = await get('dee', '?from=2026-10-16&to=2026-10-16');
  assert.deepEqual(dee.body.groups, [], 'not on any crew');
  assert.deepEqual(dee.body.unassigned.map(row => [row.id, row.mine, row.canOpen, row.crewName]), [['job_dee_solo', true, true, '']]);
  const nobody = await get('crewLead', '?from=2026-10-16&to=2026-10-22');
  assert.equal(nobody.status, 200);
  assert.deepEqual([nobody.body.groups, nobody.body.unassigned], [[], []], 'a crew lead on no crew sees nothing');
});

test('scope=all: a team lead reads every crew by priority plus the work on no crew, with no role flag; crew get 403', async () => {
  const { get } = harness(), env = { ...ENV };
  const eli = await get('eli', '?from=2026-10-16&to=2026-10-22&scope=all', env);
  assert.equal(eli.status, 200, JSON.stringify(eli.body));
  assert.deepEqual([eli.body.scope, eli.body.viewer.canViewAll], ['all', true]);
  assert.deepEqual(eli.body.groups.map(group => [group.crew.id, group.crew.mine]), [['crew_one', false], ['crew_two', false], ['crew_weekend', true], ['crew_old', false]], 'priority 1, 2, then unprioritized; an inactive crew only with work on it');
  assert.deepEqual(eli.body.groups[0].crew, { id: 'crew_one', name: 'Crew 1', code: 'crew-1', lead: 'Name of ana.lead', mine: false, serviceDays: ['mon', 'fri'] }, 'no member list ever leaves');
  assert.deepEqual(eli.body.groups.find(group => group.crew.id === 'crew_weekend').jobs, [], 'an empty active crew still shows');
  assert.deepEqual(eli.body.unassigned.map(row => [row.id, row.time]), [['job_unassigned', '10:00'], ['job_dee_solo', '11:00']], 'by day, then time');
  assert.deepEqual(eli.body.unassigned.map(row => [row.crewSize, row.crewNeeded, row.canOpen]), [[0, 3, false], [1, 2, false]], 'a team lead reads the schedule; the job page still checks the assignment');
  assert.deepEqual(ids(eli), ['job_crew1_ana', 'job_crew2', 'job_dee_solo', 'job_multiday', 'job_next_week', 'job_old_crew', 'job_split~seg-a', 'job_split~seg-b', 'job_unassigned']);
  // The team lead's view never depends on a role flag, so it never needs EGC_STAFF_ROLE_ACCESS, which would also open
  // every customer's contact details to Sales and Phone. Sales, Phone, crew leads and crew are refused under every flag.
  for (const flags of FLAG_SETS) {
    const at = JSON.stringify(flags), flagged = { ...ENV, ...flags };
    const lead = await get('eli', '?from=2026-10-16&to=2026-10-22&scope=all', flagged);
    assert.deepEqual([lead.status, lead.body.viewer?.canViewAll, ids(lead)], [200, true, ids(eli)], `team lead ${at}`);
    assert.equal((await get('tyler', '?scope=all', flagged)).status, 200, `the manager (business access) ${at}`);
    for (const who of ['ben', 'cara', 'crewLead', 'dee', 'sales', 'phone']) {
      const refused = await get(who, '?scope=all', flagged);
      assert.deepEqual([refused.status, refused.body.code], [403, 'crew_schedule_forbidden'], `${who} ${at}`);
      assert.equal((await get(who, '?from=2026-10-16&to=2026-10-16', flagged)).body.viewer.canViewAll, false, `${who} ${at}`);
    }
  }
  const mine = await get('eli', '?from=2026-10-16&to=2026-10-16', env);
  assert.deepEqual([mine.body.scope, mine.body.viewer.canViewAll, mine.body.groups.map(group => group.crew.id)], ['mine', true, ['crew_weekend']]);
  const manager = await get('tyler', '?from=2026-10-16&to=2026-10-16&scope=all');
  assert.equal(rows(manager.body).every(row => row.canOpen), true, 'managers open any job, as /api/field-jobs allows them');
});

test('no money, phone, street, notes or roster ever leaves; cancelled work, walkthroughs, blocks and private rows never show', async () => {
  const { get } = harness(), env = { ...ENV, ...ACCESS };
  const keys = ['area', 'arrivalWindow', 'canOpen', 'crewId', 'crewName', 'crewNeeded', 'crewSize', 'customer', 'date', 'days', 'endDate', 'endTime', 'id', 'lead', 'mine', 'serviceType', 'status', 'time', 'type'];
  for (const [who, query] of [['eli', '?from=2026-10-14&to=2026-10-27&scope=all'], ['ben', '?from=2026-10-14&to=2026-10-27'], ['tyler', '?from=2026-10-14&to=2026-10-27&scope=all']]) {
    const { status, body } = await get(who, query, env), text = JSON.stringify(body);
    assert.equal(status, 200, who);
    for (const row of rows(body)) assert.deepEqual(Object.keys(row).filter(key => key !== 'segmentId').sort(), keys, `${who} ${row.id}`);
    for (const { crew } of body.groups) assert.ok(Object.keys(crew).every(key => ['id', 'name', 'code', 'lead', 'mine', 'serviceDays'].includes(key)), `${who}: a crew carries its name and lead, never its members`);
    for (const secret of ['1250', '625', '9705550142', 'gate code', 'Synthetic instructions', '100 Fixture Lane', 'Fixture', 'Synthetic Customer Person', 'Person', 'memberIds', 'price', 'deposit', 'estimate', 'quote', 'total'])
      assert.ok(!text.includes(secret), `${who}: ${secret} must not leave`);
    assert.ok(!/job_cancelled|walk_1|block_1|_egc_|vault_row/.test(text), `${who}: hidden rows stay hidden`);
  }
});

test('a split job opens for anyone on any of its segments, as the job page does; `mine` stays the row’s own segment', async () => {
  const access = who => ({ assigned: async row => (row.assignedCrew || []).includes(who), exactly: id => id === who });
  const all = await crewSchedule({ session: SESSIONS.ana, env: {}, from: '2026-10-16', to: '2026-10-19', scope: 'all', now: NOW, crews: CREWS, jobs: JOBS, access: access('ana.lead'), names: {} });
  const split = rows(all).filter(row => row.id === 'job_split').map(row => [row.segmentId, row.mine, row.canOpen]).sort();
  assert.deepEqual(split, [['seg-a', false, true], ['seg-b', true, true]], 'Cara’s day of the job is not Ana’s, but the job page opens for Ana');
  const ben = await crewSchedule({ session: SESSIONS.ben, env: {}, from: '2026-10-16', to: '2026-10-19', scope: 'mine', now: NOW, crews: CREWS, jobs: JOBS, access: access('ben.crew'), names: {} });
  assert.deepEqual(rows(ben).filter(row => row.id === 'job_split').map(row => [row.segmentId, row.mine, row.canOpen]), [['seg-b', false, false]], 'a crewmate on neither segment sees Crew 1’s day, locked');
});

test('lead names are looked up only for the leads an answer shows, and not at all when it shows none', async () => {
  const { get, lookups } = harness();
  // Dee's window holds only her own job on no crew with no lead; the lookback (32 days) and other crews' leads never
  // trigger the encrypted employee-accounts read.
  const dee = await get('dee', '?from=2026-10-16&to=2026-10-16');
  assert.equal(dee.status, 200);
  assert.deepEqual(lookups, [], 'no lead shown, no lookup');
  const ben = await get('ben', '?from=2026-10-16&to=2026-10-16');
  assert.deepEqual(rows(ben.body).map(row => row.lead), ['Name of ana.lead', 'Name of ana.lead']);
  assert.deepEqual(lookups, [['ana.lead']], 'Crew 1’s lead only: never Crew 2’s, the inactive crew’s or a lookback row’s');
  const cara = await get('cara', '?from=2026-10-16&to=2026-10-16');
  assert.equal(cara.status, 200);
  assert.deepEqual(lookups.at(-1), ['ben.crew', 'cara.crew'], 'Crew 2’s lead, and the retired crew’s because her own job there shows; never Crew 1’s');
  assert.deepEqual(await leadNames({}, new Set()), {}, 'an empty set reads nothing');
});

test('EGC_CREW_SCHEDULE=false turns the schedule off before any read; anything else leaves it on', async () => {
  const { get, calls, lookups } = harness();
  for (const who of ['ben', 'eli', null]) {
    const off = await get(who, '?scope=all', { ...ENV, EGC_CREW_SCHEDULE: 'false' });
    assert.deepEqual([off.status, off.body.code, off.headers.get('Cache-Control')], [404, 'crew_schedule_disabled', 'private, no-store'], String(who));
  }
  assert.deepEqual([calls, lookups], [[], []], 'no storage or name read while off');
  for (const value of ['true', 'FALSE', ' false', '0', '']) assert.equal((await get('ben', '', { ...ENV, EGC_CREW_SCHEDULE: value })).status, 200, JSON.stringify(value));
});

test('window, scope and session are validated; storage trouble is a 503, never a partial schedule', async () => {
  const { get } = harness();
  assert.deepEqual((await get(null)).body.code, 'crew_schedule_sign_in_required');
  assert.equal((await get(null)).status, 401);
  // At most CREW_SCHEDULE_HISTORY_DAYS (14) back: 2026-10-02 is the earliest start on 2026-10-16, for every viewer.
  for (const query of ['?from=2026-10-16&to=2026-10-30', '?from=2026-10-16&to=2026-10-15', '?from=2026-02-30', '?from=tomorrow', '?to=2027-01-01', '?from=2026-10-01&to=2026-10-02', '?from=2025-10-16&to=2025-10-20']) {
    const { status, body } = await get('ben', query);
    assert.deepEqual([status, body.code], [400, 'crew_schedule_range_invalid'], query);
  }
  assert.deepEqual((await get('eli', '?from=2026-09-01&to=2026-09-02&scope=all')).body.code, 'crew_schedule_range_invalid', 'a team lead pages no further back');
  assert.equal(CREW_SCHEDULE_HISTORY_DAYS, 14);
  assert.equal((await get('ben', '?from=2026-10-02&to=2026-10-02')).status, 200, 'two weeks back is the limit');
  assert.deepEqual((await get('ben', '?scope=everyone')).body.code, 'crew_schedule_scope_invalid');
  const fourteen = await get('ben', '?from=2026-10-16&to=2026-10-29');
  assert.equal(fourteen.status, 200, `${CREW_SCHEDULE_MAX_DAYS} days is the most one request reads`);
  const defaults = await get('ben');
  assert.deepEqual([defaults.body.from, defaults.body.to, defaults.body.scope], ['2026-10-16', '2026-10-22', 'mine'], 'default: today (Denver) and the next 6 days');
  assert.deepEqual(scheduleWindow(new URLSearchParams(''), new Date('2026-10-17T05:30:00.000Z')).from, '2026-10-16', 'the day is Denver’s, not UTC’s');
  const down = harness({ fail: true });
  const outage = await down.get('ben');
  assert.deepEqual([outage.status, outage.body.code, outage.body.groups], [503, 'crew_schedule_storage_unavailable', undefined]);
  const unconfigured = await get('ben', '', {});
  assert.deepEqual([unconfigured.status, unconfigured.body.code], [503, 'crew_schedule_storage_unavailable']);
});

test('first names and cities: only what a crew already sees on a job card', () => {
  assert.equal(firstName('  Alma   Q. Synthetic '), 'Alma');
  assert.equal(firstName('<img src=x onerror=alert(1)> Synthetic'), 'img', 'markup never survives');
  assert.equal(firstName(''), '');
  for (const [address, city] of [['100 Fixture Lane, Fort Collins, CO 80525', 'Fort Collins'], ['7 Sample Ct, Loveland CO 80537', 'Loveland'], ['9 Example Rd, Windsor, Colorado 80550, USA', 'Windsor'], ['100 Fixture Lane', ''], ['', ''], ['1 A St, 80525', ''], ['5 B Ave, Wellington, CO', 'Wellington']])
    assert.equal(areaOf(address), city, address);
});

test('crew records without a usable name or id, and segments, are handled without leaking other crews', async () => {
  const body = await crewSchedule({ session: SESSIONS.cara, env: {}, from: '2026-10-16', to: '2026-10-19', scope: 'mine', now: NOW,
    crews: [...CREWS, { id: 'bad id!', recordType: 'crew', name: 'Broken', memberIds: ['cara.crew'] }, { id: 'crew_blank', recordType: 'crew', name: ' ', memberIds: ['cara.crew'] }],
    jobs: JOBS, access: { assigned: async row => (row.assignedCrew || []).includes('cara.crew'), exactly: id => id === 'cara.crew' }, names: {} });
  assert.deepEqual(body.groups.map(group => group.crew.id), ['crew_two', 'crew_old']);
  assert.deepEqual(body.groups[0].jobs.map(row => [row.id, row.segmentId || '', row.lead]), [['job_split', 'seg-a', 'cara.crew'], ['job_crew2', '', 'cara.crew']], 'a split job shows only her segment; an unresolved lead shows the username');
});

test('storage: the crew records are one equality query and the dated jobs one bounded, masked, paginated range that fails closed', async () => {
  const posted = [];
  const doc = (collection, row) => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${collection}/${row.id}`, updateTime: '2026-10-16T00:00:00Z', fields: encodeFirestoreFields(Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'))) });
  let pages = [], crewDocs = [];
  const fetcher = async (env, url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    posted.push([String(url).split(':').at(-1), body]);
    const query = body.structuredQuery;
    if (query.from[0].collectionId === 'dispatchResources') return Response.json([...crewDocs.map(document => ({ document })), { readTime: '2026-10-16T00:00:00Z' }]);
    const page = pages.shift() || [];
    return Response.json(page.length ? page.map(row => ({ document: doc('jobs', row) })) : [{ readTime: '2026-10-16T00:00:00Z' }]);
  };
  const store = dispatchStorage({}, fetcher);
  crewDocs = [doc('dispatchResources', CREWS[0])];
  const crews = await store.crewResources();
  assert.deepEqual(crews.map(row => [row.id, row.name, row.priority]), [['crew_two', 'Crew 2', 2]]);
  const crewQuery = posted[0][1].structuredQuery;
  assert.deepEqual(crewQuery.where, { fieldFilter: { field: { fieldPath: 'recordType' }, op: 'EQUAL', value: { stringValue: 'crew' } } });
  assert.deepEqual(crewQuery.select.fields.map(field => field.fieldPath).sort(), ['code', 'leadId', 'memberIds', 'name', 'priority', 'recordType', 'serviceDays', 'status']);

  const full = Array.from({ length: 500 }, (_, index) => ({ id: `job_${String(index).padStart(3, '0')}`, type: 'job', date: '2026-10-16' }));
  pages = [full, [{ id: 'job_last', type: 'job', date: '2026-10-17' }]];
  posted.length = 0;
  const rows = await store.datedJobs('2026-09-14', '2026-10-22', ['type', 'date']);
  assert.equal(rows.length, 501);
  const [first, second] = posted.map(([, body]) => body.structuredQuery);
  assert.deepEqual(first.where.compositeFilter.filters.map(filter => [filter.fieldFilter.field.fieldPath, filter.fieldFilter.op, filter.fieldFilter.value.stringValue]), [['date', 'GREATER_THAN_OR_EQUAL', '2026-09-14'], ['date', 'LESS_THAN_OR_EQUAL', '2026-10-22']]);
  assert.deepEqual(first.select.fields.map(field => field.fieldPath), ['type', 'date']);
  assert.deepEqual(first.orderBy.map(order => order.field.fieldPath), ['date', '__name__']);
  assert.equal(first.limit, 500);
  assert.deepEqual([second.startAt.before, second.startAt.values[0].stringValue, second.startAt.values[1].referenceValue.endsWith('/jobs/job_499')], [false, '2026-10-16', true], 'the next page starts after the last row');

  pages = [[{ id: 'job_far', type: 'job', date: '2026-11-30' }]];
  await assert.rejects(store.datedJobs('2026-09-14', '2026-10-22', ['type', 'date']), { code: 'dispatch_storage_incomplete' }, 'a row outside the range fails closed');
  await assert.rejects(store.datedJobs('2026-10-22', '2026-09-14', ['date']), { code: 'dispatch_range_invalid' });
  await assert.rejects(store.datedJobs('2026-09-14', '2026-10-22', ['type']), { code: 'dispatch_storage_mask_required' }, 'the mask must include date');
  await assert.rejects(store.datedJobs('2026-09-14', '2026-10-22', []), { code: 'dispatch_storage_mask_required' });
});

test('lead names: configured users cost no read; employee accounts are read only when a lead is not one of them', async () => {
  const env = { HUB_AUTH_USERS_JSON: JSON.stringify({ 'Ana.Lead': { passwordHash: 'synthetic', role: 'crew', displayName: 'Synthetic Ana' } }) };
  assert.deepEqual(await leadNames(env, new Set(['ana.lead'])), { 'ana.lead': 'Synthetic Ana' });
  assert.deepEqual(await leadNames(env, new Set(['ana.lead', 'nobody.here'])), { 'ana.lead': 'Synthetic Ana' }, 'employee accounts are not configured, so the username stands in');
  assert.equal(CREW_SCHEDULE_LOOKBACK_DAYS, 32);
});
