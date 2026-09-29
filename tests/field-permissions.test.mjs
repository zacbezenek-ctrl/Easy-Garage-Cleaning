import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie, getHubUserProfile, hasBusinessAccess } from '../functions/_lib/hub-session.js';
import { createJobAssignmentAccess } from '../functions/_lib/job-assignment.js';
import { fieldCapabilities, fieldJobLead, fieldLeadOnlyComplete } from '../functions/_lib/field-permissions.js';
import { fieldChecklist, fieldCommand, fieldJobProjection } from '../functions/_lib/field-execution.js';
import { storage } from './helpers/field-fixture.mjs';
import * as route from '../functions/api/field-jobs.js';
import { createApprovedSendService } from '../functions/_lib/approved-send.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import * as messaging from './helpers/messaging-fixture.mjs';

const NOW = '2026-09-22T18:00:00.000Z';
const users = (extra = {}) => JSON.stringify({
  ZacB: { passwordHash: 'synthetic', role: 'owner', displayName: 'Synthetic Owner' },
  'Lead.One': { passwordHash: 'synthetic', role: 'crew', displayName: 'Synthetic Lead' },
  'Crew.Two': { passwordHash: 'synthetic', role: 'crew', displayName: 'Synthetic Crew' },
  'Role.Lead': { passwordHash: 'synthetic', role: 'crew_lead', displayName: 'Synthetic Role Lead' },
  ...extra,
});
// No vault secret: the roster is the configured Hub users only, so the alias check reads no storage.
const unitEnv = (extra = {}) => ({ HUB_AUTH_USERS_JSON: users(), ...extra });
const who = (env, user) => ({ ...getHubUserProfile(env, user) });
const job = (changes = {}) => ({ id: 'job-1', type: 'job', status: 'in_progress', pipelineStatus: 'in_progress', assignedCrew: ['lead.one', 'crew.two'], crewLead: 'lead.one', ...changes });
async function capabilities(env, user, target, session = who(env, user)) {
  return fieldCapabilities({ session, manager: hasBusinessAccess(session), job: target, env, access: createJobAssignmentAccess(env, session) });
}

test('with FIELD_LEAD_ONLY_COMPLETE off every assigned member keeps today’s completion rights', async () => {
  const env = unitEnv({ FIELD_CUSTOMER_PHOTOS_ENABLED: 'true' });
  assert.equal(fieldLeadOnlyComplete(env), false);
  for (const flag of ['', 'false', 'TRUE', '1']) assert.equal(fieldLeadOnlyComplete({ FIELD_LEAD_ONLY_COMPLETE: flag }), false, flag);
  assert.deepEqual(await capabilities(env, 'Lead.One', job()), { lead: true, complete: true, sendOnMyWay: true, sharePhotos: false, configureChecklist: false });
  assert.deepEqual(await capabilities(env, 'Crew.Two', job()), { lead: false, complete: true, sendOnMyWay: true, sharePhotos: false, configureChecklist: false });
  assert.deepEqual(await capabilities(env, 'ZacB', job()), { lead: false, complete: true, sendOnMyWay: true, sharePhotos: true, configureChecklist: true });
  assert.equal((await capabilities(unitEnv(), 'ZacB', job())).sharePhotos, false, 'photo sharing follows FIELD_CUSTOMER_PHOTOS_ENABLED like /api/field-photo-sharing');
  assert.deepEqual(await capabilities(env, 'Role.Lead', job()), { lead: false, complete: false, sendOnMyWay: false, sharePhotos: false, configureChecklist: false }, 'someone not on the job gets nothing');
});

test('with the flag on only the named crew lead (exact username) or a manager may complete', async () => {
  const env = unitEnv({ FIELD_LEAD_ONLY_COMPLETE: 'true' });
  const lead = await capabilities(env, 'Lead.One', job({ crewLead: ' LEAD.ONE ' }));
  assert.equal(lead.lead, true, 'usernames match case-insensitively'); assert.equal(lead.complete, true); assert.equal(lead.sendOnMyWay, true);
  const member = await capabilities(env, 'Crew.Two', job());
  assert.equal(member.lead, false); assert.equal(member.complete, false); assert.equal(member.sendOnMyWay, false);
  assert.equal((await capabilities(env, 'ZacB', job())).complete, true, 'owners and managers always can');
  assert.equal((await capabilities(env, 'Lead.One', job({ crewLead: 'lead.one.2' }))).complete, false, 'punctuation and suffixes are identity');
  assert.equal((await capabilities(env, 'Lead.One', job({ crewLead: { username: 'crew.two', name: 'Synthetic Lead' } }))).lead, false, 'an explicit lead id wins over its label');
});

test('sendOnMyWay advertises exactly the on-my-way rule approved-send enforces', async () => {
  const sales = { user: 'alexk', role: 'sales', businessAccess: true, displayName: 'Synthetic Sales' };
  for (const flag of ['', 'true']) {
    const env = unitEnv({ FIELD_LEAD_ONLY_COMPLETE: flag });
    const off = await capabilities(env, null, job(), sales), on = await capabilities(env, null, job({ assignedCrew: ['lead.one', 'alexk'] }), sales);
    assert.equal(off.complete, true, 'business access keeps the field manager tools');
    assert.equal(off.sendOnMyWay, false, 'sales staff are not dispatchers: only an assignment lets them send on-my-way');
    assert.equal(on.sendOnMyWay, flag !== 'true', 'an assigned sales person who is not the lead follows the crew rule');
  }
});

async function onMyWayService(flag, jobFields) {
  const store = messaging.memoryStore({ 'jobs/job-1': messaging.job({ status: 'dispatched', pipelineStatus: 'dispatched', assignedCrew: ['crew1', 'crew2'], crewLead: 'crew1', ...jobFields }) });
  const state = await readTemplate(store, 'on_my_way');
  await mutateTemplate(store, messaging.owner, { action: 'approve', requestId: crypto.randomUUID(), kind: 'on_my_way', expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, messaging.NOW);
  const env = { ...messaging.env, ...(flag ? { FIELD_LEAD_ONLY_COMPLETE: flag } : {}) }, ghl = messaging.fakeGhl(), clock = messaging.clock();
  return { ghl, service: createApprovedSendService({ store, messenger: createGhlMessenger({ env, fetcher: ghl.fetcher, clock }), clock, env }) };
}
const onMyWay = { kind: 'on_my_way', jobId: 'job-1', overrides: { etaMinutes: 20 } };

test('with the flag on the server lets only the crew lead or a manager send on-my-way; the status stays readable', async () => {
  const { service, ghl } = await onMyWayService('true');
  await assert.rejects(service.preview(messaging.otherCrew, onMyWay), error => error.code === 'messaging_forbidden' && error.status === 403 && /crew lead/.test(error.message));
  const token = (await service.preview(messaging.crew, onMyWay)).confirmToken;
  await assert.rejects(service.send(messaging.otherCrew, { ...onMyWay, requestId: crypto.randomUUID(), confirmToken: token }), error => error.code === 'messaging_forbidden');
  assert.equal(ghl.sends().length, 0, 'a refused send never reaches HighLevel');
  assert.equal((await service.preview(messaging.manager, onMyWay)).status, 'ready', 'managers always can');
  assert.equal((await service.status(messaging.otherCrew, onMyWay)).status, 'not_sent', 'the rest of the crew can still see whether it went out');
  assert.equal((await service.send(messaging.crew, { ...onMyWay, requestId: crypto.randomUUID(), confirmToken: token })).status, 'submitted', 'the lead sends');
  assert.equal(ghl.sends().length, 1);
  const unnamed = await onMyWayService('true', { crewLead: '' });
  await assert.rejects(unnamed.service.preview(messaging.crew, onMyWay), error => error.code === 'messaging_forbidden', 'a two-person job without a named lead has no crew sender, as for completion');
});

test('with the flag off every assigned crew member still sends on-my-way, exactly as before', async () => {
  const { service } = await onMyWayService('');
  assert.equal((await service.preview(messaging.otherCrew, onMyWay)).status, 'ready');
  assert.equal((await service.preview(messaging.crew, onMyWay)).status, 'ready');
});

test('a legacy display-name lead counts only while that name is unique on the roster', async () => {
  const env = unitEnv({ FIELD_LEAD_ONLY_COMPLETE: 'true' }), legacy = job({ assignedCrew: undefined, assignedTo: 'Synthetic Lead + Synthetic Crew', crewLead: 'Synthetic Lead' });
  assert.equal((await capabilities(env, 'Lead.One', legacy)).complete, true);
  assert.equal((await capabilities(env, 'Crew.Two', legacy)).complete, false);
  const twins = { HUB_AUTH_USERS_JSON: users({ 'Lead.Twin': { passwordHash: 'synthetic', role: 'crew', displayName: 'Synthetic Lead' } }), FIELD_LEAD_ONLY_COMPLETE: 'true' };
  assert.equal(await fieldJobLead({ session: who(twins, 'Lead.One'), job: legacy, access: createJobAssignmentAccess(twins, who(twins, 'Lead.One')) }), false, 'an ambiguous display name proves nothing');
  assert.equal((await capabilities(twins, 'Lead.One', legacy)).complete, false);
});

test('a job without a named lead is led by its only crew member or by an assigned crew_lead', async () => {
  const env = unitEnv({ FIELD_LEAD_ONLY_COMPLETE: 'true' });
  assert.equal((await capabilities(env, 'Crew.Two', job({ assignedCrew: ['crew.two'], crewLead: null }))).complete, true, 'a solo job needs no named lead');
  const pair = job({ assignedCrew: ['lead.one', 'crew.two'], crewLead: '' });
  assert.equal((await capabilities(env, 'Lead.One', pair)).complete, false);
  assert.equal((await capabilities(env, 'Crew.Two', pair)).complete, false, 'dispatch already warns: choose a crew lead');
  assert.equal((await capabilities(env, 'Role.Lead', job({ assignedCrew: ['role.lead', 'crew.two'], crewLead: null }))).lead, true, 'the P1-08 crew_lead role leads an unnamed job');
  const stored = { user: 'field.person', displayName: 'Synthetic Field', role: 'crew', staffRoles: ['crew_lead'], businessAccess: false };
  assert.equal((await capabilities(env, null, job({ assignedCrew: ['field.person', 'crew.two'], crewLead: null }), stored)).complete, true, 'stored staff roles count');
  assert.equal((await capabilities(env, null, job({ assignedCrew: ['field.person', 'crew.two'], crewLead: 'crew.two' }), stored)).complete, false, 'a named lead outranks the role');
  const forged = { ...stored, staffRoles: ['owner', 'crew_lead'] };
  assert.equal((await capabilities(env, null, job({ assignedCrew: ['field.person'] }), forged)).configureChecklist, false, 'stored roles never grant manager tools');
});

function readyJob(changes = {}) {
  const base = { id: 'job-1', type: 'job', customer: 'Synthetic Customer', address: '100 Synthetic Street', date: '2026-09-22', time: '08:00', endTime: '12:00', status: 'in_progress', pipelineStatus: 'in_progress', startedAt: '2026-09-22T15:00:00.000Z', assignedCrew: ['Lead.One', 'Crew.Two'], crewLead: 'Lead.One', ...changes };
  base.fieldExecution = { checks: Object.fromEntries(fieldChecklist(base).map(item => [item.id, { completed: true, actorId: 'lead.one' }])), photos: ['before', 'after'].map(category => ({ id: crypto.randomUUID(), fileId: `synthetic-file-${category}`, category, verified: true })) };
  return base;
}
const completion = { action: 'complete', notes: 'The agreed garage services and walkthrough are complete.', hasIssues: false };

test('fieldCommand refuses a completion the capabilities do not allow and leaves every other caller unchanged', () => {
  const target = readyJob(), actor = { user: 'Crew.Two', displayName: 'Synthetic Crew', manager: false };
  assert.throws(() => fieldCommand(target, { ...actor, capabilities: { complete: false } }, { ...completion, requestId: crypto.randomUUID() }, NOW), error => error.status === 403 && error.code === 'FIELD_LEAD_REQUIRED');
  assert.equal(fieldCommand(target, { ...actor, capabilities: { complete: true } }, { ...completion, requestId: crypto.randomUUID() }, NOW).patch.status, 'completed');
  assert.equal(fieldCommand(target, actor, { ...completion, requestId: crypto.randomUUID() }, NOW).patch.status, 'completed', 'callers without capabilities keep the old rule');
  assert.doesNotThrow(() => fieldCommand(target, { ...actor, capabilities: { complete: false } }, { action: 'note', body: 'Swept the driveway.', requestId: crypto.randomUUID() }, NOW), 'only completion is gated');
  assert.deepEqual(fieldJobProjection(target, [], { capabilities: { lead: true, complete: true } }).capabilities, { lead: true, complete: true });
  assert.equal(fieldJobProjection(target).capabilities, null);
});

const httpEnv = flag => ({ HUB_SESSION_SECRET: 'field-permissions-session-secret', FIREBASE_API_KEY: 'firebase-test-field-permissions', HUB_AUTH_USERS_JSON: users(), ...(flag ? { FIELD_LEAD_ONLY_COMPLETE: flag } : {}) });
async function http(env, user, data, search = '') {
  const cookie = (await createHubSessionCookie(env, user)).split(';')[0];
  const response = await route[data ? 'onRequestPost' : 'onRequestGet']({ env, request: new Request(`https://easygaragecleaning.com/api/field-jobs${search}`, { method: data ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, ...(data ? { body: JSON.stringify(data) } : {}) }) });
  return { status: response.status, body: await response.json() };
}

test('over HTTP with the flag on a crew member gets 403 FIELD_LEAD_REQUIRED, the lead completes, and the job page sees the capabilities', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const store = storage(t), env = httpEnv('true'); store.put('jobs/job-1', readyJob());
  const detail = await http(env, 'Crew.Two', null, '?jobId=job-1');
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.job.capabilities, { lead: false, complete: false, sendOnMyWay: false, sharePhotos: false, configureChecklist: false });
  const list = await http(env, 'Lead.One', null, '?date=2026-09-22');
  assert.deepEqual(list.body.jobs.map(row => row.capabilities.complete), [true]);
  const requestId = crypto.randomUUID(), before = store.revision('job-1');
  const refused = await http(env, 'Crew.Two', { ...completion, jobId: 'job-1', requestId, expectedRevision: before });
  assert.equal(refused.status, 403); assert.equal(refused.body.code, 'FIELD_LEAD_REQUIRED');
  assert.equal(store.revision('job-1'), before, 'nothing was written'); assert.equal(store.get('jobs/job-1').status, 'in_progress');
  assert.equal(store.documents.has(`jobs/job-1/fieldEvents/${requestId}`), false, 'no receipt for a refused completion');
  const note = await http(env, 'Crew.Two', { action: 'note', body: 'Loaded the truck for the dump run.', jobId: 'job-1', requestId: crypto.randomUUID(), expectedRevision: before });
  assert.equal(note.status, 200, 'other field work stays open to every assigned member');
  const done = await http(env, 'Lead.One', { ...completion, jobId: 'job-1', requestId: crypto.randomUUID(), expectedRevision: store.revision('job-1') });
  assert.equal(done.status, 200, JSON.stringify(done.body)); assert.equal(store.get('jobs/job-1').status, 'completed'); assert.equal(store.get('jobs/job-1').completedBy, 'Lead.One');
});

test('over HTTP with the flag off any assigned crew member still completes, exactly as before', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const store = storage(t), env = httpEnv(''); store.put('jobs/job-1', readyJob());
  const detail = await http(env, 'Crew.Two', null, '?jobId=job-1');
  assert.equal(detail.body.job.capabilities.complete, true);
  const done = await http(env, 'Crew.Two', { ...completion, jobId: 'job-1', requestId: crypto.randomUUID(), expectedRevision: store.revision('job-1') });
  assert.equal(done.status, 200, JSON.stringify(done.body)); assert.equal(store.get('jobs/job-1').completedBy, 'Crew.Two');
  const manager = await http(env, 'ZacB', null, '?jobId=job-1');
  assert.equal(manager.body.job.capabilities.configureChecklist, true);
});
