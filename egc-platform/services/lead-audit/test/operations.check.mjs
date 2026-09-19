import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDueWorkSnapshot, pageDueWork, resolveVisitJob, canonicalJson,
  approvalFingerprint, evaluateDispatchPreconditions, collectTaskPages
} from '../dist/operations-tests/operations-core.js';

const NOW = '2026-09-18T08:00:00-06:00';
const END = '2026-09-19T00:00:00-06:00';
const task = (changes = {}) => ({
  id: 'task-1', title: 'Return requested callback', status: 'open',
  dueAt: '2026-09-18T10:00:00-06:00', assignedUserId: 'user-1', priority: 'medium',
  contactId: 'contact-1', jobId: 'job-1', revision: 1, ...changes
});
const snapshot = (tasks, changes = {}) => buildDueWorkSnapshot({
  id: 'brief-1', generatedAt: NOW, dueBefore: END, timeZone: 'America/Denver', tasks,
  requiredSources: ['tasks'], coverage: [{source: 'tasks', status: 'fresh', complete: true, asOf: NOW}], ...changes
});
const ref = (kind, id, system = 'employee_hub') => ({system, kind, id});
const visit = {visit: ref('visit', 'visit-a'), customer: ref('customer', 'customer-a'), project: ref('project', 'project-a')};
const link = {...visit, job: ref('job', 'job-a')};
const subject = (changes = {}) => ({
  actionId: 'task-1', revision: 1, recipient: '+15555550100', channel: 'sms',
  payload: {message: 'Synthetic test only', priceCents: 72500}, quoteRevision: 'quote-v1',
  jobRevision: 'job-v1', conversationWatermark: 'reply-v1', policyRevision: 'policy-v1',
  sendWindowStart: '2026-09-18T07:00:00-06:00', sendWindowEnd: END, ...changes
});
async function dispatch(changes = {}) {
  const fingerprint = await approvalFingerprint(subject());
  return evaluateDispatchPreconditions({
    now: NOW, actionId: 'task-1', revision: 1, fingerprint,
    approval: {actionId: 'task-1', revision: 1, fingerprint, status: 'approved',
      authenticatedActorId: 'authenticated-test-user', expiresAt: END},
    taskStatus: 'open', executionStatus: 'not_started', authorizationGranted: true,
    contactAllowed: true, sourcesFresh: true, dependenciesSatisfied: true,
    sendWindowStart: '2026-09-18T07:00:00-06:00', sendWindowEnd: END, ...changes
  });
}

test('60-day-old lead callback is selected by task due time', () => {
  const t = task({createdAt: '2026-07-20T00:00:00Z', leadCreatedAt: '2026-07-20T00:00:00Z'});
  assert.equal(snapshot([t]).items[0].id, t.id);
});
test('booked project with unanswered customer question remains actionable', () => {
  assert.equal(snapshot([task({leadState: 'BOOKED', lastInteractionDirection: 'customer'})]).counts.totalDue, 1);
});
test('overdue work sorts ahead of today and future cutoff is exclusive', () => {
  const s = snapshot([task({id:'future',dueAt:END}),task({id:'today'}),task({id:'overdue',dueAt:'2026-09-17T18:00:00-06:00'})]);
  assert.deepEqual(s.items.map(t=>t.id), ['overdue','today']);
  assert.equal(s.counts.overdue, 1);
});
test('closed task states are excluded, blocked tasks remain visible', () => {
  const s = snapshot(['completed','cancelled','superseded','blocked'].map(status=>task({id:status,status})));
  assert.deepEqual(s.items.map(t=>t.id), ['blocked']);
});
test('waiting customer uses review time, suppresses earlier generic chase', () => {
  assert.equal(snapshot([task({waitingOn:'customer',dueAt:'2026-09-01T00:00:00Z',reviewAt:'2026-09-22T10:00:00-06:00'})]).counts.totalDue, 0);
  assert.equal(snapshot([task({waitingOn:'customer',reviewAt:NOW})]).items[0].reason, 'review');
});
test('owner, due time, revision and waiting-review gaps remain explicit', () => {
  const s = snapshot([task({id:'a',dueAt:null,assignedUserId:null,revision:null}),task({id:'b',waitingOn:'customer'})]);
  assert.deepEqual(s.issues.map(i=>i.code).sort(), ['due_time_missing','owner_missing','revision_missing','review_time_missing'].sort());
  assert.equal(s.counts.totalDue, null);
});
test('legacy tasks keep their real ID but do not receive invented approval revisions', () => {
  const s = snapshot([task({revision:undefined})]);
  assert.equal(s.items[0].id,'task-1'); assert.equal(s.items[0].revision,null);
  assert.equal(s.issues[0].code,'revision_missing');
});
test('duplicate canonical task IDs fail rather than silently merge', () => {
  assert.throws(()=>snapshot([task(),task({revision:2})]),/duplicate canonical task ID/);
});
test('invalid task timestamps and statuses are review exceptions, not zero work', () => {
  const s = snapshot([task({id:'a',dueAt:'2026-09-31T10:00:00Z'}),task({id:'b',status:'BOOKED'})]);
  assert.equal(s.counts.totalDue,null);
  assert.deepEqual(s.issues.map(i=>i.code),['invalid_task_time','unknown_task_status']);
});
test('snapshot inputs require explicit offsets and valid timezone', () => {
  assert.throws(()=>snapshot([], {generatedAt:'2026-09-18T08:00:00'}),/offset/);
  assert.throws(()=>snapshot([], {timeZone:'Not/AZone'}));
  assert.throws(()=>snapshot([], {dueBefore:NOW}),/after/);
});
test('date objects from database are normalized without mutating them', () => {
  const d = new Date(NOW); const s = snapshot([task({dueAt:d})]);
  d.setUTCFullYear(2020); assert.equal(s.items[0].dueAt,'2026-09-18T14:00:00.000Z');
});
test('explicit DST-day cutoff is respected without adding 24 hours', () => {
  const s = snapshot([task({id:'included',dueAt:'2026-11-01T23:30:00-07:00'}),task({id:'excluded',dueAt:'2026-11-02T00:00:00-07:00'})],
    {generatedAt:'2026-11-01T00:00:00-06:00',dueBefore:'2026-11-02T00:00:00-07:00',coverage:[{source:'tasks',status:'fresh',complete:true,asOf:'2026-11-01T00:00:00-06:00'}]});
  assert.deepEqual(s.items.map(t=>t.id),['included']);
});
test('unknown/stale/missing coverage never fabricates a zero total', () => {
  for (const status of ['unknown','stale','unavailable']) {
    const s=snapshot([],{coverage:[{source:'tasks',status,complete:true,asOf:NOW}]});
    assert.equal(s.counts.observedDue,0); assert.equal(s.counts.totalDue,null); assert.ok(s.issues.length);
  }
  assert.equal(snapshot([],{coverage:[]}).counts.totalDue,null);
  assert.equal(snapshot([],{requiredSources:[]}).counts.totalDue,null);
});
test('missing source timestamp and partial coverage cannot count as fresh', () => {
  for (const c of [{asOf:null,complete:true},{asOf:END,complete:true},{asOf:NOW,complete:false}])
    assert.equal(snapshot([],{coverage:[{source:'tasks',status:'fresh',...c}]}).counts.totalDue,null);
});
test('paginated queue counts describe the entire immutable snapshot', () => {
  const tasks=Array.from({length:205},(_,i)=>task({id:`t-${String(i).padStart(3,'0')}`}));
  const s=snapshot(tasks); const first=pageDueWork(s,0,100); const last=pageDueWork(s,200,100);
  assert.equal(first.counts.totalDue,205); assert.equal(first.nextOffset,100);
  assert.equal(last.items.length,5); assert.equal(last.nextOffset,null);
  tasks[0].title='changed'; assert.notEqual(s.items[0].title,'changed');
  assert.throws(()=>{s.items[0].title='mutated';},TypeError);
  assert.throws(()=>pageDueWork(s,-1,100)); assert.throws(()=>pageDueWork(s,0,501));
});
test('exact source-qualified visit link wins, never latest job for customer', () => {
  const other={...link,visit:ref('visit','visit-b'),job:ref('job','job-b')};
  assert.deepEqual(resolveVisitJob(visit,[other,link]).job,link.job);
  assert.equal(resolveVisitJob(visit,[other]).exception,'job_link_missing');
});
test('two projects and conflicting explicit links remain distinct', () => {
  assert.equal(resolveVisitJob(visit,[link,{...link,job:ref('job','job-b')}]).exception,'job_link_ambiguous');
  assert.equal(resolveVisitJob(visit,[{...link,project:ref('project','project-b')}]).exception,'job_link_context_conflict');
  assert.equal(resolveVisitJob(visit,[{...link,customer:ref('customer','customer-b')}]).exception,'job_link_context_conflict');
});
test('same opaque ID in GHL and portal is not the same visit', () => {
  assert.equal(resolveVisitJob(visit,[{...link,visit:ref('visit','visit-a','ghl')}]).exception,'job_link_missing');
});
test('replayed identical mapping is not a second job', () => {
  assert.deepEqual(resolveVisitJob(visit,[link,link]).job,link.job);
});
test('canonical payload has stable ordering and rejects lossy JSON inputs', () => {
  assert.equal(canonicalJson({b:2,a:1}),canonicalJson({a:1,b:2}));
  for (const v of [NaN,Infinity,undefined,{a:undefined},new Date(),[,,]]) assert.throws(()=>canonicalJson(v));
});
test('message, price, recipient, channel, scope, reply and policy changes alter approval fingerprint', async () => {
  const first=await approvalFingerprint(subject());
  for (const change of [
    {payload:{message:'changed',priceCents:72500}}, {payload:{message:'Synthetic test only',priceCents:80000}},
    {recipient:'+15555550101'}, {channel:'email'}, {quoteRevision:'quote-v2'}, {jobRevision:'job-v2'},
    {conversationWatermark:'reply-v2'}, {policyRevision:'policy-v2'}, {revision:2}, {actionId:'task-2'},
    {sendWindowStart:NOW}, {sendWindowEnd:'2026-09-18T23:00:00-06:00'}
  ]) assert.notEqual(await approvalFingerprint(subject(change)),first);
});
test('fingerprint ordering is stable; incomplete subjects are rejected', async () => {
  assert.equal(await approvalFingerprint(subject()),await approvalFingerprint(subject({payload:{priceCents:72500,message:'Synthetic test only'}})));
  await assert.rejects(approvalFingerprint(subject({revision:0})));
  await assert.rejects(approvalFingerprint(subject({conversationWatermark:''})));
});
test('valid preflight only permits an atomic claim, never a send or task completion', async () => {
  assert.deepEqual(await dispatch(),{readyForAtomicClaim:true,reasons:[]});
});
test('note approval is not message approval; exact stored approval required', async () => {
  assert.ok((await dispatch({approval:null})).reasons.includes('exact_approval_required'));
});
test('edited or replied-to context invalidates prior exact authorization', async () => {
  const fingerprint=await approvalFingerprint(subject({conversationWatermark:'reply-v2'}));
  assert.ok((await dispatch({fingerprint})).reasons.includes('approval_invalidated'));
  assert.ok((await dispatch({revision:2})).reasons.includes('approval_invalidated'));
});
test('expired, rejected, unauthenticated, and other-action approvals fail', async () => {
  const f=await approvalFingerprint(subject());
  const a={actionId:'task-1',revision:1,fingerprint:f,status:'approved',authenticatedActorId:'verified-user',expiresAt:END};
  for(const c of [{expiresAt:NOW},{expiresAt:'bad'},{status:'rejected'},{authenticatedActorId:''},{actionId:'task-2'}])
    assert.equal((await dispatch({approval:{...a,...c}})).readyForAtomicClaim,false);
});
test('replayed/in-flight/accepted/unknown/failed execution cannot blindly resend', async () => {
  for(const executionStatus of ['in_flight','provider_accepted','succeeded','unknown','failed'])
    assert.equal((await dispatch({executionStatus})).readyForAtomicClaim,false);
});
test('auth, contact restrictions, stale sources, dependencies and task state are fail closed', async () => {
  for(const c of [{authorizationGranted:false},{contactAllowed:false},{contactAllowed:null},{sourcesFresh:false},
    {dependenciesSatisfied:false},{taskStatus:'blocked'},{taskStatus:'cancelled'},{taskStatus:'completed'}])
    assert.equal((await dispatch(c)).readyForAtomicClaim,false);
});
test('send-window bounds are enforced and invalid timestamps are denied', async () => {
  assert.equal((await dispatch({sendWindowEnd:NOW})).readyForAtomicClaim,false);
  assert.equal((await dispatch({sendWindowStart:END})).readyForAtomicClaim,false);
  assert.equal((await dispatch({now:'bad'})).readyForAtomicClaim,false);
});

test('source pagination collects every page and never silently truncates', async () => {
  const all=Array.from({length:501},(_,i)=>task({id:`t-${String(i).padStart(4,'0')}`}));
  const pages=[];
  const result=await collectTaskPages(async(after,size)=>{pages.push(after); return all.filter(t=>after===null||t.id>after).slice(0,size);});
  assert.equal(result.length,501); assert.equal(pages.length,3);
});
test('source errors and stalled cursors propagate rather than return empty work', async () => {
  await assert.rejects(collectTaskPages(async()=>{throw new Error('provider down');}),/provider down/);
  await assert.rejects(collectTaskPages(async()=>[task()],1),/did not advance/);
});
test('malformed source-qualified identities never resolve a job', () => {
  assert.equal(resolveVisitJob({...visit,visit:ref('visit','')},[link]).exception,'visit_context_invalid');
  assert.equal(resolveVisitJob(visit,[{...link,job:ref('customer','job-a')}]).exception,'job_link_invalid');
});
