// SIGNOFF (#201): managers sign off or flag completed jobs; it never gates invoicing or payments, nobody signs off a job
// they worked on (except the owner), a flag opens the crew lead's follow-up, and the list is one bounded read with no
// money. Synthetic jobs and people only; the clock is fixed.
process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { SIGNOFF_FIELDS, jobWorkers, requireSignoffManager, signoffCommand, signoffList } from '../functions/_lib/job-signoff.js';
import { jobSignoffHandlers } from '../functions/api/job-signoff.js';

const OWNER = { user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const MANAGER = { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true };
const LEAD = { user: 'AlexK', displayName: 'Synthetic Lead', role: 'crew_lead', businessAccess: true };
const CREW = { user: 'Crew.One', displayName: 'Synthetic Crew', role: 'crew' };
const NOW = '2026-10-21T18:00:00.000Z';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const job = (jobId, extra = {}) => ({ id: jobId, type: 'job', status: 'completed', pipelineStatus: 'completed', date: '2026-10-19', time: '09:00', customer: 'Synthetic Johnson Family', serviceType: 'Garage cleanout',
  assignedCrew: ['crew.one', 'crew.two'], crewLead: 'crew.one', completedAt: '2026-10-19T22:00:00.000Z', completedBy: 'crew.one',
  fieldExecution: { activity: 'completed', completion: { completedAt: '2026-10-19T22:00:00.000Z', actorId: 'crew.one', hasIssues: false, notes: 'Synthetic notes' } },
  estimate: { amount: 1500, depositPaidCents: 37500 }, phone: '9705550142', ...extra });

test('only the owner and managers sign off; crew, crew leads and signed-out visitors cannot', () => {
  assert.doesNotThrow(() => requireSignoffManager(OWNER, {}));
  assert.doesNotThrow(() => requireSignoffManager(MANAGER, {}));
  for (const [session, code] of [[null, 'job_signoff_sign_in_required'], [CREW, 'job_signoff_forbidden'], [LEAD, 'job_signoff_forbidden']]) assert.throws(() => requireSignoffManager(session, {}), { code });
});

test('signing off records who and when; a manager who worked the job cannot sign it off, the owner can', () => {
  const signed = signoffCommand(job('a'), MANAGER, { action: 'sign_off', requestId: id(1), reason: '' }, NOW);
  assert.deepEqual(signed.patch.supervisorSignoff, { status: 'signed', by: 'TylerG', byName: 'Synthetic Manager', at: NOW, reason: '', requestId: id(1) });
  assert.deepEqual(signed.patch.supervisorSignoffHistory, [signed.patch.supervisorSignoff]);
  assert.equal(signed.patch.fieldExecution, undefined, 'a sign-off leaves the field record alone');
  assert.deepEqual(Object.keys(signed.patch).sort(), ['supervisorSignoff', 'supervisorSignoffHistory'], 'nothing about money, status or invoicing changes');
  for (const worked of [job('b', { assignedCrew: ['tylerg'] }), job('c', { crewLead: 'TylerG' }), job('d', { completedBy: 'tylerg' }), job('e', { assignedCrew: [], assignmentSegments: [{ id: 's1', date: '2026-10-19', assignedCrew: ['TylerG'] }] })])
    assert.throws(() => signoffCommand(worked, MANAGER, { action: 'sign_off', requestId: id(2) }, NOW), { code: 'job_signoff_self', status: 403 }, worked.id);
  assert.equal(signoffCommand(job('f', { assignedCrew: ['zacb'] }), OWNER, { action: 'sign_off', requestId: id(3) }, NOW).patch.supervisorSignoff.by, 'ZacB');
  assert.deepEqual([...jobWorkers(job('g', { assignmentSegments: [{ id: 's', assignedCrew: ['crew.three'], crewLead: 'crew.three' }] }))].sort(), ['crew.one', 'crew.three', 'crew.two']);
});

test('a flag needs a reason and opens the crew follow-up for the lead; a flagged job is signed off later, a signed one is final', () => {
  assert.throws(() => signoffCommand(job('a'), MANAGER, { action: 'flag', requestId: id(1), reason: ' ' }, NOW), { code: 'job_signoff_reason_required' });
  const base = job('a'), flagged = signoffCommand(base, MANAGER, { action: 'flag', requestId: id(1), reason: 'Shelving left unanchored' }, NOW).patch;
  assert.deepEqual(flagged.fieldExecution.attention, { at: NOW, actorId: 'TylerG', actorName: 'Synthetic Manager', requestId: id(1), visibility: 'crew', reason: 'Supervisor flag: Shelving left unanchored', status: 'open' });
  assert.deepEqual(flagged.fieldExecution.completion, base.fieldExecution.completion, 'the rest of the field record is kept');
  const open = job('b', { fieldExecution: { ...base.fieldExecution, attention: { status: 'open', reason: 'Crew reported a dent', requestId: 'crew-1' } } });
  assert.equal(signoffCommand(open, MANAGER, { action: 'flag', requestId: id(2), reason: 'Also the shelving' }, NOW).patch.fieldExecution, undefined, 'an open follow-up is not replaced');
  const after = { ...base, ...flagged };
  assert.throws(() => signoffCommand(after, MANAGER, { action: 'flag', requestId: id(3), reason: 'Again' }, NOW), { code: 'job_signoff_already_flagged' });
  const signed = signoffCommand(after, OWNER, { action: 'sign_off', requestId: id(4) }, NOW).patch;
  assert.deepEqual(signed.supervisorSignoffHistory.map(entry => entry.status), ['flagged', 'signed'], 'the history keeps both');
  assert.throws(() => signoffCommand({ ...after, ...signed }, MANAGER, { action: 'flag', requestId: id(5), reason: 'Late' }, NOW), { code: 'job_signoff_already_signed', status: 409 });
  assert.deepEqual(signoffCommand({ ...after, ...signed }, MANAGER, { action: 'sign_off', requestId: id(4) }, NOW), { replayed: true }, 'the same request again is a replay');
  assert.throws(() => signoffCommand(job('c', { status: 'scheduled', pipelineStatus: 'scheduled' }), MANAGER, { action: 'sign_off', requestId: id(6) }, NOW), { code: 'job_signoff_not_completed' });
});

test('the list: unsigned and flagged completed jobs, oldest first, over 48 hours flagged, own jobs marked, no money or contact', () => {
  const jobs = [job('recent', { completedAt: '2026-10-21T10:00:00.000Z', fieldExecution: { completion: { completedAt: '2026-10-21T10:00:00.000Z' } } }), job('old', { completedAt: '2026-10-19T12:00:00.000Z', fieldExecution: { completion: { completedAt: '2026-10-19T12:00:00.000Z' } } }), job('fresh'),
    job('signed', { supervisorSignoff: { status: 'signed', by: 'ZacB' } }), job('flagged', { supervisorSignoff: { status: 'flagged', by: 'ZacB', byName: 'Synthetic Owner', reason: 'Recheck the floor' }, completedAt: '2026-10-18T22:00:00.000Z', fieldExecution: { completion: { completedAt: '2026-10-18T22:00:00.000Z' } } }),
    job('mine', { assignedCrew: ['tylerg'], completedAt: '2026-10-20T22:00:00.000Z', fieldExecution: { completion: { completedAt: '2026-10-20T22:00:00.000Z' } } }), job('open', { status: 'scheduled', pipelineStatus: 'scheduled' }), job('walk', { type: 'walkthrough' })];
  const list = signoffList(jobs, MANAGER, NOW), by = Object.fromEntries(list.rows.map(row => [row.jobId, row]));
  assert.deepEqual(list.rows.map(row => row.jobId), ['flagged', 'old', 'fresh', 'mine', 'recent']);
  assert.deepEqual([list.needed, list.overdue, list.flagged], [4, 1, 1]);
  assert.deepEqual([by.old.hoursSinceCompleted, by.old.overdue], [54, true], '12:00 on the 19th to 18:00 on the 21st is over 48 hours');
  assert.deepEqual([by.fresh.hoursSinceCompleted, by.fresh.overdue], [44, false], '44 hours is not yet 48');
  assert.equal(by.flagged.overdue, false, 'a flagged job is waiting on the crew, not on a manager');
  assert.deepEqual([by.flagged.signoff.status, by.flagged.signoff.reason], ['flagged', 'Recheck the floor']);
  assert.deepEqual([by.mine.ownJob, by.old.ownJob, by.old.customer], [true, false, 'Synthetic']);
  assert.doesNotMatch(JSON.stringify(list), /1500|37500|9705550142|Johnson|amount|Cents/, 'no money or contact');
  assert.deepEqual(signoffList([job('x', { assignedCrew: ['zacb'] })], OWNER, NOW).rows[0].ownJob, false, 'the owner may sign off their own job');
});

// The real handlers over the Firestore REST fake: one masked, dated read for the list; a revision-guarded commit.
function api(seed, actor = MANAGER) {
  const fs = firestoreRest(Object.fromEntries(seed.map(row => [`jobs/${row.id}`, row])));
  const handlers = jobSignoffHandlers({ session: async () => actor, dispatch: env => dispatchStorage(env, fs.fetcher), now: () => new Date(NOW) });
  const get = async () => { const response = await handlers.get({ request: new Request('https://easygaragecleaning.com/api/job-signoff'), env: {} }); return { status: response.status, body: await response.json() }; };
  const post = async (body, headers = {}) => { const response = await handlers.post({ request: new Request('https://easygaragecleaning.com/api/job-signoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://easygaragecleaning.com', ...headers }, body: JSON.stringify(body) }), env: {} }); return { status: response.status, body: await response.json() }; };
  return { fs, get, post };
}

test('GET /api/job-signoff: one masked read of the last 14 Denver days, rows without money; crew get 403', async () => {
  const { fs, get } = api([job('a'), job('old', { date: '2026-09-01' })]);
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.deepEqual(body.window, { start: '2026-10-07', end: '2026-10-21' });
  assert.deepEqual(body.rows.map(row => row.jobId), ['a'], 'a job dated outside the window is not read');
  const reads = fs.calls.filter(call => call.path === ':runQuery');
  assert.equal(reads.length, 1, 'one query');
  assert.deepEqual(reads[0].body.structuredQuery.select.fields.map(field => field.fieldPath).sort(), [...SIGNOFF_FIELDS].sort(), 'masked to the sign-off fields');
  assert.doesNotMatch(JSON.stringify(body), /1500|37500|9705550142|Johnson/);
  assert.equal((await api([job('a')], CREW).get()).status, 403);
});

test('POST /api/job-signoff signs off and flags through a revision-guarded commit, refuses self sign-off and replays safely', async () => {
  const { post, get, fs } = api([job('a'), job('b'), job('mine', { crewLead: 'TylerG' })]);
  const signed = await post({ action: 'sign_off', jobId: 'a', requestId: id(1) });
  assert.deepEqual([signed.status, signed.body.signoff.status, signed.body.replayed], [200, 'signed', false]);
  assert.deepEqual([(await post({ action: 'sign_off', jobId: 'a', requestId: id(1) })).body.replayed], [true]);
  const flag = await post({ action: 'flag', jobId: 'b', requestId: id(2), reason: 'Floor not swept' });
  assert.equal(flag.status, 200);
  const list = (await get()).body, rows = Object.fromEntries(list.rows.map(row => [row.jobId, row]));
  assert.deepEqual(Object.keys(rows).sort(), ['b', 'mine'], 'the signed job leaves the list; the flagged one stays');
  assert.deepEqual([rows.b.signoff.status, rows.b.openFollowUp], ['flagged', true], 'the flag opened the crew follow-up');
  assert.deepEqual([(await post({ action: 'sign_off', jobId: 'mine', requestId: id(3) })).status], [403]);
  assert.equal((await post({ action: 'sign_off', jobId: 'missing', requestId: id(4) })).status, 404);
  assert.equal((await post({ action: 'sign_off', jobId: 'b', requestId: id(5) }, { Origin: 'https://example.invalid' })).status, 403, 'cross-site posts are refused');
  const commits = fs.calls.filter(call => call.path === ':commit');
  assert.ok(commits.length >= 2 && commits.every(call => call.body.writes.every(write => write.currentDocument?.updateTime)), 'every write is guarded by the revision read');
  assert.ok(commits.every(call => call.body.writes.every(write => write.updateMask.fieldPaths.every(path => ['supervisorSignoff', 'supervisorSignoffHistory', 'fieldExecution'].includes(path)))), 'only the sign-off fields (and a flag\'s follow-up) are written');
});

test('a job changed since it was read is refused, not overwritten', async () => {
  const fs = firestoreRest({ 'jobs/a': job('a') });
  const store = dispatchStorage({}, fs.fetcher), stale = { ...store, read: async (collection, jobId) => ({ ...(await store.read(collection, jobId)), revision: '2026-01-01T00:00:00.000000Z' }) };
  const handlers = jobSignoffHandlers({ session: async () => MANAGER, dispatch: () => stale, now: () => new Date(NOW) });
  const response = await handlers.post({ request: new Request('https://easygaragecleaning.com/api/job-signoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sign_off', jobId: 'a', requestId: id(1) }) }), env: {} });
  assert.deepEqual([response.status, (await response.json()).code], [409, 'job_signoff_changed']);
});

test('the widget is registered for the Command center and its file shows no money', () => {
  const registry = readFileSync(new URL('../employee-hub-screens.js', import.meta.url), 'utf8'), source = readFileSync(new URL('../employee-job-signoff.js', import.meta.url), 'utf8');
  assert.match(registry, /\{id:'job_signoff',label:'Completed: needs sign-off',homes:\['today'\],capability:'business',module:'EGCJobSignoff',load:\{js:'employee-job-signoff\.js',css:'employee-job-signoff\.css',v:'20261021signoff1'\}\}/);
  assert.doesNotMatch(source, /price|amount|deposit|Cents|phone|invoice/i);
  assert.match(source, /crew\/job\.html\?jobId=/, 'Open job goes to the live job page');
});
