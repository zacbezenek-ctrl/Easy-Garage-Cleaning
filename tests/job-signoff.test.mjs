// SIGNOFF (#201): managers sign off completed jobs or mark them Needs follow-up; it never gates invoicing or payments,
// nobody signs off a job they worked on in any form (except the owner), a follow-up reaches the crew lead without money,
// paid-on-the-spot jobs stay on the list, and nothing ages out silently. Synthetic jobs and people only; fixed clock.
process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { SIGNOFF_FIELDS, completedJob, leadFollowUps, requireSignoffManager, signoffCommand, signoffList, workedByEvents, workedJob, workerMatcher } from '../functions/_lib/job-signoff.js';
import { jobSignoffHandlers } from '../functions/api/job-signoff.js';
import { fieldCommand } from '../functions/_lib/field-execution.js';
import { fieldVisitCommand } from '../functions/_lib/field-execution-visits.js';

const OWNER = { user: 'ZacB', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const MANAGER = { user: 'TylerG', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true };
const LEAD = { user: 'AlexK', displayName: 'Synthetic Lead', role: 'crew_lead', businessAccess: true };
const CREW = { user: 'crew.one', displayName: 'Crew One', role: 'crew' };
const NOW = '2026-10-21T18:00:00.000Z';
const ROSTER = [{ id: 'crew.one', name: 'Crew One' }, { id: 'crew.two', name: 'Crew Two' }, { id: 'tylerg', name: 'Synthetic Manager' }];
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const done = at => ({ completedAt: at, fieldExecution: { activity: 'completed', completion: { completedAt: at, actorId: 'crew.one', hasIssues: false, notes: 'Synthetic notes' } } });
const job = (jobId, extra = {}) => ({ id: jobId, type: 'job', status: 'completed', pipelineStatus: 'completed', date: '2026-10-19', time: '09:00', customer: 'Synthetic Johnson Family', serviceType: 'Garage cleanout',
  assignedCrew: ['crew.one', 'crew.two'], crewLead: 'crew.one', completedBy: 'crew.one', ...done('2026-10-19T22:00:00.000Z'),
  estimate: { amount: 1500, depositPaidCents: 37500 }, phone: '9705550142', ...extra });
const as = (session, identities) => workerMatcher(session, identities || [session.user]);

test('only the owner and managers sign off; crew, crew leads and signed-out visitors cannot', () => {
  assert.doesNotThrow(() => requireSignoffManager(OWNER, {}));
  assert.doesNotThrow(() => requireSignoffManager(MANAGER, {}));
  for (const [session, code] of [[null, 'job_signoff_sign_in_required'], [CREW, 'job_signoff_forbidden'], [LEAD, 'job_signoff_forbidden']]) assert.throws(() => requireSignoffManager(session, {}), { code });
});

test('done means completed, paid, invoiced, closed or review requested, with a completion time', () => {
  for (const status of ['completed', 'paid', 'invoiced', 'closed', 'review_requested']) assert.equal(completedJob(job('x', { status, pipelineStatus: status })), true, status);
  for (const extra of [{ status: 'scheduled', pipelineStatus: 'scheduled' }, { status: 'paid', pipelineStatus: 'paid', completedAt: null, fieldExecution: {} }, { type: 'walkthrough' }]) assert.equal(completedJob(job('x', extra)), false, JSON.stringify(extra));
});

test('a manager who worked the job in any recorded way cannot sign it off; the owner can', () => {
  const me = as(MANAGER, ['TylerG', 'Synthetic Manager']);
  const worked = {
    assignedTo: job('a', { assignedCrew: undefined, assignedTo: 'Crew One, TylerG' }),
    displayName: job('b', { assignedCrew: ['crew.one', 'Synthetic Manager'] }),
    object: job('c', { assignedCrew: ['crew.one', { username: 'tylerg', name: 'Someone' }] }),
    leadName: job('d', { crewLead: 'Synthetic Manager' }),
    segment: job('e', { assignmentSegments: [{ id: 's', assignedCrew: ['tylerg'] }] }),
    completedBy: job('f', { completedBy: 'TylerG' }),
    activityBy: job('g', { fieldExecution: { ...job('g').fieldExecution, activityBy: 'tylerg' } }),
    visit: job('h', { fieldExecution: { ...job('h').fieldExecution, visits: { '2026-10-19': { status: 'ended', startedBy: 'tylerg' } } } }),
    check: job('i', { fieldExecution: { ...job('i').fieldExecution, checks: { 'task-1': { actorId: 'tylerg', completed: true } } } }),
    evidence: job('j', { completionEvidence: { actorId: 'tylerg' } }),
    early: job('k', { fieldExecution: { ...job('k').fieldExecution, completion: { ...job('k').fieldExecution.completion, earlyCompletion: { approvedBy: 'tylerg' } } } }),
    alsoAssignedTo: job('l', { assignedTo: 'TylerG' }),
  };
  for (const [form, row] of Object.entries(worked)) {
    assert.equal(workedJob(row, me), true, form);
    assert.throws(() => signoffCommand(row, MANAGER, { action: 'sign_off', requestId: id(1) }, NOW, me), { code: 'job_signoff_self', status: 403 }, form);
    assert.equal(signoffList([row], MANAGER, NOW, { matcher: me }).rows[0].ownJob, true, form);
  }
  assert.equal(workedJob(job('m', { assignedCrew: ['crew.one', { username: 'crew.two', name: 'Synthetic Manager' }] }), me), false, 'an explicit other account under my name is not me');
  assert.equal(workedJob(job('n', { assignmentSegments: [{ id: 's', assignedCrew: ['Synthetic Manager'] }] }), me), false, 'segments are matched by username only');
  assert.equal(signoffCommand(job('o', { assignedCrew: ['zacb'] }), OWNER, { action: 'sign_off', requestId: id(2) }, NOW).signoff.by, 'ZacB', 'the owner may sign off their own job');
});

test('signing off records who and when and writes only the sign-off fields', () => {
  const signed = signoffCommand(job('a'), MANAGER, { action: 'sign_off', requestId: id(1), reason: '', expected: 'none' }, NOW);
  assert.deepEqual(signed.patch.supervisorSignoff, { status: 'signed', action: 'sign_off', by: 'TylerG', byName: 'Synthetic Manager', at: NOW, reason: '', requestId: id(1) });
  assert.deepEqual(Object.keys(signed.patch).sort(), ['supervisorSignoff', 'supervisorSignoffHistory'], 'nothing about money, status or invoicing changes');
  assert.equal(signed.followUp, null);
  assert.equal(signoffCommand(job('p', { status: 'paid', pipelineStatus: 'paid' }), MANAGER, { action: 'sign_off', requestId: id(2) }, NOW).signoff.status, 'signed', 'a job paid on the spot is signed off too');
});

test('Needs follow-up reaches the crew lead without money, adds to an open follow-up, keeps a resolved one, and sign-off closes it', () => {
  assert.throws(() => signoffCommand(job('a'), MANAGER, { action: 'flag', requestId: id(1), reason: ' ' }, NOW), { code: 'job_signoff_reason_required' });
  const base = job('a'), flagged = signoffCommand(base, MANAGER, { action: 'flag', requestId: id(1), reason: 'Refund the $450 overcharge and re-sweep the floor' }, NOW);
  assert.equal(flagged.followUp, 'opened');
  assert.deepEqual(flagged.patch.fieldExecution.attention, { at: NOW, actorId: 'TylerG', actorName: 'Synthetic Manager', requestId: id(1), visibility: 'crew', reason: 'Supervisor follow-up: Refund the overcharge and re-sweep the floor', status: 'open', supervisorFlag: true });
  assert.deepEqual(flagged.patch.fieldExecution.completion, base.fieldExecution.completion, 'the rest of the field record is kept');
  // An open crew follow-up gets the reason added, and the answer says so.
  const open = job('b', { fieldExecution: { ...base.fieldExecution, attention: { status: 'open', reason: 'Crew reported a dent', requestId: 'crew-1', visibility: 'crew' } } });
  const added = signoffCommand(open, MANAGER, { action: 'flag', requestId: id(2), reason: 'Also the shelving' }, NOW);
  assert.deepEqual([added.followUp, added.patch.fieldExecution.attention.reason, added.patch.fieldExecution.attention.requestId], ['added', 'Crew reported a dent\nSupervisor follow-up: Also the shelving', 'crew-1']);
  // A resolved crew issue is kept in the history, not overwritten.
  const resolved = { status: 'resolved', reason: 'Gate code wrong', resolution: 'Called the office', requestId: 'crew-2' };
  const kept = signoffCommand(job('c', { fieldExecution: { ...base.fieldExecution, attention: resolved } }), MANAGER, { action: 'flag', requestId: id(3), reason: 'Photos missing' }, NOW).patch.fieldExecution;
  assert.deepEqual([kept.attentionHistory, kept.attention.status], [[resolved], 'open']);
  // Signing off later closes the follow-up the flag opened; a crew-reported one stays open for the lead.
  const after = { ...base, ...flagged.patch };
  assert.throws(() => signoffCommand(after, MANAGER, { action: 'flag', requestId: id(4), reason: 'Again' }, NOW), { code: 'job_signoff_already_flagged' });
  assert.throws(() => signoffCommand(after, OWNER, { action: 'sign_off', requestId: id(5), expected: 'none' }, NOW), { code: 'job_signoff_changed', status: 409 }, 'a stale card cannot override the follow-up');
  const signed = signoffCommand(after, OWNER, { action: 'sign_off', requestId: id(5), expected: 'flagged' }, NOW);
  assert.deepEqual([signed.followUp, signed.patch.fieldExecution.attention.status, signed.patch.fieldExecution.attention.resolution], ['closed', 'resolved', 'Signed off by Synthetic Owner.']);
  assert.deepEqual(signed.patch.supervisorSignoffHistory.map(entry => entry.status), ['flagged', 'signed'], 'the history keeps both');
  const crewOpen = { ...open, supervisorSignoff: { status: 'flagged', action: 'flag', requestId: id(2) } };
  assert.equal(signoffCommand(crewOpen, OWNER, { action: 'sign_off', requestId: id(6) }, NOW).patch.fieldExecution, undefined, 'a crew-reported follow-up stays open');
  // A signed job is final; the same request again is a replay, a different action under it is refused.
  const final = { ...after, ...signed.patch };
  assert.throws(() => signoffCommand(final, MANAGER, { action: 'flag', requestId: id(7), reason: 'Late' }, NOW), { code: 'job_signoff_already_signed', status: 409 });
  assert.deepEqual(signoffCommand(final, MANAGER, { action: 'sign_off', requestId: id(5) }, NOW), { replayed: true });
  assert.throws(() => signoffCommand(final, MANAGER, { action: 'flag', requestId: id(5), reason: 'Different' }, NOW), { code: 'job_signoff_request_invalid', status: 409 });
});

test('the list: by completion time, follow-ups kept whatever their age, older unsigned counted, names and no money', () => {
  const at = value => done(value);
  const jobs = [job('recent', { ...at('2026-10-21T10:00:00.000Z') }), job('old', { ...at('2026-10-19T12:00:00.000Z') }), job('fresh'),
    job('lateDone', { date: '2026-09-01', ...at('2026-10-20T15:00:00.000Z') }), job('signed', { supervisorSignoff: { status: 'signed', by: 'ZacB' } }),
    job('flaggedOld', { ...at('2026-09-01T15:00:00.000Z'), supervisorSignoff: { status: 'flagged', by: 'ZacB', byName: 'Synthetic Owner', reason: 'Recheck the floor' } }),
    job('stale', { ...at('2026-09-20T15:00:00.000Z') }), job('paid', { status: 'paid', pipelineStatus: 'paid', ...at('2026-10-20T16:00:00.000Z') }), job('open', { status: 'scheduled', pipelineStatus: 'scheduled' })];
  const names = new Map(ROSTER.map(person => [person.id, person.name]));
  const list = signoffList(jobs, MANAGER, NOW, { names }), by = Object.fromEntries(list.rows.map(row => [row.jobId, row]));
  assert.deepEqual(list.rows.map(row => row.jobId), ['flaggedOld', 'old', 'fresh', 'lateDone', 'paid', 'recent'], 'a job dated long ago but completed this week is listed; paid ones stay');
  assert.deepEqual([list.needed, list.overdue, list.flagged, list.olderUnsigned], [5, 1, 1, 1]);
  assert.deepEqual([by.old.hoursSinceCompleted, by.old.overdue, by.fresh.hoursSinceCompleted, by.fresh.overdue], [54, true, 44, false]);
  assert.deepEqual([by.fresh.customer, by.fresh.lead], ['Synthetic J.', 'Crew One'], 'first name and last initial; the lead by name');
  assert.doesNotMatch(JSON.stringify(list), /1500|37500|9705550142|Johnson|amount|Cents/, 'no money or contact');
});

test('a crew lead sees the open supervisor follow-ups on jobs they lead, without money', () => {
  const flagged = job('f', { supervisorSignoff: { status: 'flagged', by: 'TylerG', byName: 'Synthetic Manager', reason: 'Refund the $45 and re-sweep', at: NOW }, fieldExecution: { ...job('f').fieldExecution, attention: { status: 'open' } } });
  const other = job('g', { crewLead: 'crew.two', supervisorSignoff: flagged.supervisorSignoff, fieldExecution: flagged.fieldExecution });
  const closed = job('h', { supervisorSignoff: flagged.supervisorSignoff, fieldExecution: { ...flagged.fieldExecution, attention: { status: 'resolved' } } });
  assert.deepEqual(leadFollowUps([flagged, other, closed], as(CREW)), [{ jobId: 'f', date: '2026-10-19', service: 'Garage cleanout', reason: 'Refund the and re-sweep', by: 'Synthetic Manager', at: NOW }]);
});

// The real handlers over the Firestore REST fake: two masked queries for the list; a revision-guarded commit.
function api(seed, actor = MANAGER) {
  const fs = firestoreRest(Object.fromEntries(seed.map(row => [`jobs/${row.id}`, row])));
  const handlers = jobSignoffHandlers({ session: async () => actor, dispatch: env => ({ ...dispatchStorage(env, fs.fetcher), roster: async () => ROSTER }), now: () => new Date(NOW) });
  const get = async (query = '') => { const response = await handlers.get({ request: new Request(`https://easygaragecleaning.com/api/job-signoff${query}`), env: {} }); return { status: response.status, body: await response.json() }; };
  const post = async (body, headers = {}) => { const response = await handlers.post({ request: new Request('https://easygaragecleaning.com/api/job-signoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://easygaragecleaning.com', ...headers }, body: JSON.stringify(body) }), env: {} }); return { status: response.status, body: await response.json() }; };
  return { fs, get, post };
}

test('GET /api/job-signoff: two masked queries (completed since, needing follow-up), rows without money; crew get 403', async () => {
  const { fs, get } = api([job('a'), job('gone', { ...done('2026-07-01T15:00:00.000Z') })]);
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.deepEqual(body.rows.map(row => row.jobId), ['a'], 'a job completed before the lookback is not read');
  const reads = fs.calls.filter(call => call.path === ':runQuery');
  assert.deepEqual(reads.map(call => call.body.structuredQuery.where.fieldFilter.field.fieldPath).sort(), ['completedAt', 'supervisorSignoff.status']);
  for (const call of reads) assert.deepEqual(call.body.structuredQuery.select.fields.map(field => field.fieldPath).sort(), [...SIGNOFF_FIELDS].sort(), 'masked to the sign-off fields');
  assert.doesNotMatch(JSON.stringify(body), /1500|37500|9705550142|Johnson/);
  assert.equal((await api([job('a')], CREW).get()).status, 403);
  assert.equal((await api([job('a')]).get('?days=7')).status, 400);
});

test('POST /api/job-signoff signs off and opens a follow-up through a revision-guarded commit; a crew lead reads theirs', async () => {
  const { post, get, fs } = api([job('a'), job('b'), job('mine', { crewLead: 'TylerG' })]);
  const signed = await post({ action: 'sign_off', jobId: 'a', requestId: id(1), expected: 'none' });
  assert.deepEqual([signed.status, signed.body.signoff.status, signed.body.replayed], [200, 'signed', false]);
  assert.equal((await post({ action: 'sign_off', jobId: 'a', requestId: id(1) })).body.replayed, true);
  const flag = await post({ action: 'flag', jobId: 'b', requestId: id(2), reason: 'Floor not swept', expected: 'none' });
  assert.deepEqual([flag.status, flag.body.followUp], [200, 'opened']);
  const rows = Object.fromEntries((await get()).body.rows.map(row => [row.jobId, row]));
  assert.deepEqual(Object.keys(rows).sort(), ['b', 'mine'], 'the signed job leaves the list; the one needing follow-up stays');
  assert.deepEqual([rows.b.signoff.status, rows.b.openFollowUp], ['flagged', true]);
  assert.equal((await post({ action: 'sign_off', jobId: 'mine', requestId: id(3) })).status, 403);
  assert.equal((await post({ action: 'sign_off', jobId: 'missing', requestId: id(4) })).status, 404);
  assert.equal((await post({ action: 'sign_off', jobId: 'b', requestId: id(5) }, { Origin: 'https://example.invalid' })).status, 403, 'cross-site posts are refused');
  const commits = fs.calls.filter(call => call.path === ':commit');
  assert.ok(commits.length >= 2 && commits.every(call => call.body.writes.every(write => write.currentDocument?.updateTime)), 'every write is guarded by the revision read');
  assert.ok(commits.every(call => call.body.writes.every(write => write.updateMask.fieldPaths.every(path => ['supervisorSignoff', 'supervisorSignoffHistory', 'fieldExecution'].includes(path)))));
  // The crew lead of job b (crew.one) sees the follow-up on My day.
  const handlers = jobSignoffHandlers({ session: async () => CREW, dispatch: env => ({ ...dispatchStorage(env, fs.fetcher), roster: async () => ROSTER }), now: () => new Date(NOW) });
  const mine = await (await handlers.get({ request: new Request('https://easygaragecleaning.com/api/job-signoff?view=mine'), env: {} })).json();
  assert.deepEqual(mine.followUps.map(row => [row.jobId, row.reason]), [['b', 'Floor not swept']]);
});

test('a job changed since it was read is refused, not overwritten', async () => {
  const fs = firestoreRest({ 'jobs/a': job('a') });
  const store = dispatchStorage({}, fs.fetcher), stale = { ...store, read: async (collection, jobId) => ({ ...(await store.read(collection, jobId)), revision: '2026-01-01T00:00:00.000000Z' }) };
  const handlers = jobSignoffHandlers({ session: async () => MANAGER, dispatch: () => stale, now: () => new Date(NOW) });
  const response = await handlers.post({ request: new Request('https://easygaragecleaning.com/api/job-signoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sign_off', jobId: 'a', requestId: id(1) }) }), env: {} });
  assert.deepEqual([response.status, (await response.json()).code], [409, 'job_signoff_changed']);
});

test('the widgets are registered (Command center for managers, My day for crew leads) and the file shows no money', () => {
  const registry = readFileSync(new URL('../employee-hub-screens.js', import.meta.url), 'utf8'), source = readFileSync(new URL('../employee-job-signoff.js', import.meta.url), 'utf8');
  assert.match(registry, /\{id:'job_signoff',label:'Completed: needs sign-off',homes:\['today'\],capability:'business',module:'EGCJobSignoff',load:\{js:'employee-job-signoff\.js',css:'employee-job-signoff\.css',v:'20261021signoff1'\}\}/);
  assert.match(registry, /\{id:'supervisor_followups',label:'Supervisor follow-ups',homes:\['my_day'\],crewVisible:true,quiet:true,module:'EGCSupervisorFollowUps',/);
  assert.doesNotMatch(source, /price|amount|deposit|Cents|phone|invoice/i);
  assert.match(source, /crew\/job\.html\?jobId=/, 'Open job goes to the live job page');
});

// The audit log (jobs/{id}/fieldEvents) decides "worked this job" too, so a manager's field work counts even when the job's
// own fields no longer show it. The events come from the real field command and the photo receipt's shape.
test('a manager who moved the job through the field and took its photos while off the crew cannot sign it off', async () => {
  const LEAD_CREW = { user: 'crew.one', displayName: 'Crew One', role: 'crew_lead' };
  let worked = job('fw', { status: 'scheduled', pipelineStatus: 'scheduled', completedAt: null, completedBy: null, fieldExecution: {} }), n = 10;
  const events = [];
  const apply = (actor, input) => { const result = fieldCommand(worked, actor, { requestId: id(++n), ...input }, NOW); worked = { ...worked, ...result.patch }; events.push(result.event); };
  for (const itemId of ['departure-address', 'departure-equipment', 'arrival-scope', 'arrival-protection']) apply(LEAD_CREW, { action: 'checklist', itemId, completed: true });
  apply(MANAGER, { action: 'status', status: 'dispatched' }); apply(MANAGER, { action: 'status', status: 'arrived' });
  // The manager's photos: the photo receipt the upload path writes, and the photo it adds to the job.
  for (const category of ['before', 'after']) {
    const photo = { id: id(++n), fileId: `synthetic-file-${n}`, category, actorId: MANAGER.user, actorName: MANAGER.displayName, createdAt: NOW, verified: true };
    worked = { ...worked, fieldExecution: { ...worked.fieldExecution, photos: [...(worked.fieldExecution.photos || []), photo] } };
    events.push({ id: photo.id, action: 'photo', actorId: MANAGER.user, actorName: MANAGER.displayName, createdAt: NOW, state: 'applied', visibility: 'crew', category, photoId: photo.id });
  }
  apply(MANAGER, { action: 'status', status: 'in_progress' });
  // The lead pauses and resumes (activityBy becomes theirs) and finishes.
  for (const status of ['paused', 'in_progress']) apply(LEAD_CREW, { action: 'status', status, reason: 'Synthetic break' });
  worked = { ...worked, status: 'completed', pipelineStatus: 'completed', ...done('2026-10-19T22:00:00.000Z'), fieldExecution: { ...worked.fieldExecution, ...done('2026-10-19T22:00:00.000Z').fieldExecution } };
  assert.equal(worked.fieldExecution.activityBy, 'crew.one');
  assert.equal(workedJob(worked, as(MANAGER)), true, 'the job\'s start and photos name the manager');
  // A business SDK user can rewrite the job's own fields (firestore.rules), not its audit log: with those names gone
  // the log still shows the field work.
  const { dispatchedBy, arrivedBy, startedBy, ...rewritten } = worked;
  worked = { ...rewritten, fieldExecution: { ...worked.fieldExecution, photos: worked.fieldExecution.photos.map(photo => ({ ...photo, actorId: 'crew.one' })) } };
  assert.equal(workedJob(worked, as(MANAGER)), false, 'the rewritten fields alone no longer show the manager');
  assert.equal(workedByEvents(events, as(MANAGER)), true);
  const seed = Object.fromEntries([[`jobs/fw`, worked], ...events.map(event => [`jobs/fw/fieldEvents/${event.id}`, event])]);
  const fs = firestoreRest(seed);
  const handlers = jobSignoffHandlers({ session: async () => MANAGER, dispatch: env => ({ ...dispatchStorage(env, fs.fetcher), roster: async () => ROSTER }), now: () => new Date(NOW) });
  const post = async body => { const response = await handlers.post({ request: new Request('https://easygaragecleaning.com/api/job-signoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://easygaragecleaning.com' }, body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
  const refused = await post({ action: 'sign_off', jobId: 'fw', requestId: id(90), expected: 'none' });
  assert.deepEqual([refused.status, refused.body.code], [403, 'job_signoff_self']);
  const read = fs.calls.find(call => call.path === 'jobs/fw:runQuery');
  assert.deepEqual(read.body.structuredQuery.select.fields.map(field => field.fieldPath), ['actorId', 'action', 'state', 'category'], 'the log is read masked, by actor');
  // Office actions on the log are supervision: a manager who only resolved an issue or shared photos still signs off.
  const office = [{ id: id(91), action: 'resolve_issue', actorId: 'TylerG', state: 'applied' }, { id: id(92), action: 'photo_visibility', actorId: 'TylerG', state: 'applied' }, { id: id(93), action: 'photo', category: 'walkthrough', actorId: 'TylerG', state: 'applied' }, { id: id(94), action: 'status', actorId: 'TylerG', state: 'pending' }];
  assert.equal(workedByEvents(office, as(MANAGER)), false);
  assert.equal(workedByEvents(events, as(OWNER)), false, 'another person\'s field work is not theirs');
});

test('a manager off the crew who ended a day of a multi-day job cannot sign it off once the visit names are rewritten', async () => {
  // The real multi-day end of day (FIELD_MULTIDAY_VISITS): it writes the visit's endedBy and activityBy and an end_day entry.
  const base = job('md', { status: 'in_progress', pipelineStatus: 'in_progress', date: '2026-10-20', endDate: '2026-10-21', completedAt: null, completedBy: null, fieldExecution: { activity: 'in_progress' } });
  const ended = fieldVisitCommand(base, MANAGER, { requestId: id(80), action: 'end_day', notes: 'Synthetic day one finished; bay two remains.' }, '2026-10-21T00:30:00.000Z');
  assert.equal(ended.event.action, 'end_day');
  // Later the crew finishes, and a browser edit rewrites the visit's names off the manager.
  const visits = Object.fromEntries(Object.entries(ended.patch.fieldExecution.visits).map(([day, visit]) => [day, { ...visit, endedBy: 'crew.one', startedBy: 'crew.one' }]));
  const worked = { ...base, ...ended.patch, status: 'completed', pipelineStatus: 'completed', ...done('2026-10-21T22:00:00.000Z'), fieldExecution: { ...ended.patch.fieldExecution, ...done('2026-10-21T22:00:00.000Z').fieldExecution, activityBy: 'crew.one', visits } };
  assert.equal(workedJob(worked, as(MANAGER)), false, 'the rewritten fields no longer show the manager');
  const fs = firestoreRest({ 'jobs/md': worked, [`jobs/md/fieldEvents/${ended.event.id}`]: ended.event });
  const handlers = jobSignoffHandlers({ session: async () => MANAGER, dispatch: env => ({ ...dispatchStorage(env, fs.fetcher), roster: async () => ROSTER }), now: () => new Date(NOW) });
  const response = await handlers.post({ request: new Request('https://easygaragecleaning.com/api/job-signoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://easygaragecleaning.com' }, body: JSON.stringify({ action: 'sign_off', jobId: 'md', requestId: id(81), expected: 'none' }) }) });
  assert.deepEqual([response.status, (await response.json()).code], [403, 'job_signoff_self']);
});

// Supervision is not field work: a manager whose only entries in a job's audit log are office actions (a note, resolving an
// issue, setting up the checklist, sharing photos with the customer, purchase marks, completion sync, the signed
// walkthrough's reference photos) still signs it off, through the real handler.
test('a manager who only supervised a job (notes, issues, checklist setup, photo sharing, purchases, sync) can sign it off', async () => {
  const office = ['note', 'resolve_issue', 'configure_checklist', 'photo_visibility', 'purchase_state', 'completion_sync'].map((action, index) => ({ id: id(60 + index), action, actorId: MANAGER.user, actorName: MANAGER.displayName, createdAt: NOW, state: 'applied', visibility: 'management' }));
  office.push({ id: id(70), action: 'photo', category: 'walkthrough', actorId: MANAGER.user, createdAt: NOW, state: 'applied', visibility: 'crew' });
  assert.equal(workedByEvents(office, as(MANAGER)), false);
  const fs = firestoreRest(Object.fromEntries([['jobs/sup', job('sup')], ...office.map(event => [`jobs/sup/fieldEvents/${event.id}`, event])]));
  const handlers = jobSignoffHandlers({ session: async () => MANAGER, dispatch: env => ({ ...dispatchStorage(env, fs.fetcher), roster: async () => ROSTER }), now: () => new Date(NOW) });
  const response = await handlers.post({ request: new Request('https://easygaragecleaning.com/api/job-signoff', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://easygaragecleaning.com' }, body: JSON.stringify({ action: 'sign_off', jobId: 'sup', requestId: id(71), expected: 'none' }) }) });
  const body = await response.json();
  assert.deepEqual([response.status, body.signoff?.status, body.signoff?.by], [200, 'signed', MANAGER.user], JSON.stringify(body));
  assert.ok(fs.calls.some(call => call.path === 'jobs/sup:runQuery'), 'the audit log was read');
});
