import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovedSendService, messagingFlags } from '../functions/_lib/approved-send.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { runDueMessages } from '../functions/_lib/messaging-scheduler.js';
import { CREW_NOTICE_HEARD, CREW_NOTIFICATIONS, CREW_NOTIFICATION_PREFS, crewHeardId, crewNotificationWrites } from '../functions/_lib/crew-notifications.js';
import { CREW_HUB_LINK, MAX_ATTEMPTS, createCrewNotificationFeed, crewContactProvider, crewNoticeProvider, crewNotificationDeps, crewNotificationStorage, noticeSendKey, noticeTransition, wellFormedNotice } from '../functions/_lib/crew-notification-delivery.js';
import { validateTemplateVersion } from '../functions/_lib/message-templates.js';
import { TEMPLATE_KINDS } from '../functions/_lib/message-template-defaults.js';
import { ledgerId } from '../functions/_lib/message-send-store.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { servicePublicKeySet, signServiceRequest } from '../egc-platform/services/operations/src/service-auth.ts';
import { verifyApiServiceEnvelope } from '../functions/_lib/operations-service-auth.js';
import { messagingCronHandlers, MESSAGING_CRON_PATH } from '../functions/api/messaging-cron.js';
import { env as messagingEnv, owner, manager, job, memoryStore, fakeGhl, clock, uuid, NOW } from './helpers/messaging-fixture.mjs';

// NOW is 12:00 on Tuesday 2026-09-22 in Denver; the work is on Thursday.
const DAY = '2026-09-24';
const ENV = Object.freeze({ ...messagingEnv, EGC_CREW_NOTIFICATIONS_ENABLED: 'true' });
const ROSTER = [{ id: 'crew1', name: 'Casey Crew', role: 'crew' }, { id: 'crew2', name: 'Riley Other', role: 'crew' }, { id: 'crew3', name: 'Morgan Nophone', role: 'crew' }, { id: 'zacb', name: 'Zac Owner', role: 'owner' }];
const ACCOUNTS = {
  crew1: { username: 'crew1', status: 'approved', displayName: 'Casey Crew', phone: '(970) 555-0155' },
  crew2: { username: 'crew2', status: 'approved', displayName: 'Riley Other', phone: '(970) 555-0166' },
  crew3: { username: 'crew3', status: 'approved', displayName: 'Morgan Nophone', phone: '' },
};
// Staff contacts the owner created and tagged in HighLevel, linked per employee by a dispatcher.
const STAFF = { 'staff-1': { id: 'staff-1', locationId: 'location-1', phone: '+19705550155', dnd: false, tags: ['egc-staff'] }, 'staff-2': { id: 'staff-2', locationId: 'location-1', phone: '+19705550166', dnd: false, tags: ['EGC-Staff'] } };
const LINKED = { crew1: 'staff-1', crew2: 'staff-2' };
// The customer's own contact, money and notes: none of it may reach a crew text.
const work = (overrides = {}) => job({ date: DAY, endDate: DAY, time: '09:00', endTime: '12:00', assignedCrew: ['crew1'], crewLead: 'crew1', customer: 'Synthetic Canary Customer',
  address: '999 Canary Lane', notes: 'canary-private-note', accessInstructions: 'canary-gate-4242', total: 8765.43, ...overrides });
const settle = () => new Promise(resolve => setImmediate(resolve));
const REMOVAL = new Set(['unassigned', 'cancelled']);

async function setup({ jobs = { 'job-1': work() }, approved = ['crew_assignment', 'crew_unassignment', 'crew_schedule_change'], optedIn = ['crew1', 'crew2', 'crew3'], linked = LINKED, ghl: ghlOptions = {}, flags = {}, rows = {}, accounts = ACCOUNTS } = {}) {
  const store = memoryStore({ ...Object.fromEntries(Object.entries(jobs).map(([id, fields]) => [`jobs/${id}`, fields])),
    ...Object.fromEntries(optedIn.map(id => [`${CREW_NOTIFICATION_PREFS}/${id}`, { employeeId: id, sms: true, smsUpdatedAt: NOW, ...(linked[id] ? { staffContactId: linked[id] } : {}) }])), ...rows });
  store.jobRecords = async () => Promise.all([...store.rows.keys()].filter(key => key.startsWith('jobs/')).map(key => store.read('jobs', key.slice(5))));
  const queries = [], batchReads = [];
  const storage = {
    async query(filters, limit = 200, collection = CREW_NOTIFICATIONS) {
      if (typeof storage.failQuery === 'function') storage.failQuery();
      queries.push({ filters, limit, collection });
      const rows = await Promise.all([...store.rows.keys()].filter(key => key.startsWith(`${collection}/`)).map(key => store.read(collection, key.slice(collection.length + 1))));
      return rows.filter(row => filters.every(([field, value]) => row[field] === value)).slice(0, limit);
    },
    readMany: async (collection, ids) => { batchReads.push({ collection, ids }); return (await Promise.all(ids.map(id => store.read(collection, id)))).filter(Boolean); },
  };
  for (const kind of approved) {
    const state = await readTemplate(store, kind);
    await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind, expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
    await mutateTemplate(store, owner, { action: 'set_automation', requestId: uuid(), kind, expectedVersion: 1, enabled: true }, NOW);
  }
  const ghl = fakeGhl({ contacts: { ...STAFF }, ...ghlOptions }), time = clock(NOW), settings = { ...ENV, ...flags }, accountReads = [];
  // hooks.fetch(real, url, options) can hold a HighLevel call while another tick runs.
  const hooks = {}, fetcher = (...args) => hooks.fetch ? hooks.fetch(ghl.fetcher, ...args) : ghl.fetcher(...args);
  const readAccount = async username => { accountReads.push(username); return accounts[username] ? { account: structuredClone(accounts[username]) } : null; };
  // One tick, built fresh like the cron builds it for each signed request.
  const deps = () => crewNotificationDeps(settings, { store, now: time(), storage, readAccount });
  const run = ({ budget, ...options } = {}) => {
    const crew = deps();
    const service = createApprovedSendService({ store, messenger: createGhlMessenger({ env: settings, fetcher, clock: time }), clock: time, env: settings, links: crew.links, crewContact: crew.crewContact, crewNotice: crew.crewNotice });
    return runDueMessages({ store, service, flags: messagingFlags(settings), links: crew.links, crewOutbox: crew.outbox, ...(budget ? { budget } : {}) }, { now: time(), ...options });
  };
  const queue = async (before, after, { jobId = 'job-1', requestId = uuid(), at = time().toISOString(), batch = '' } = {}) => {
    const writes = await crewNotificationWrites({ jobId, requestId, action: 'schedule.update', actorId: 'zacb', type: 'job', before, after, roster: ROSTER, now: at, batch });
    store.set(`jobs/${jobId}`, after);
    if (writes.length) await store.commit(writes);
    return writes.map(write => write.id);
  };
  const notice = id => store.get(`${CREW_NOTIFICATIONS}/${id}`);
  const ledgers = () => [...store.rows].filter(([key]) => key.startsWith('message_sends/')).map(([, value]) => value);
  const noticeCommits = () => store.commits.filter(writes => writes.some(write => write.collection === CREW_NOTIFICATIONS && write.revision));
  const upserts = () => ghl.calls.filter(call => call.path === '/contacts/upsert');
  return { store, storage, queries, batchReads, ghl, hooks, time, settings, run, queue, notice, ledgers, noticeCommits, accountReads, deps, upserts };
}

test('an assignment is texted once to the opted-in employee from their approved account, with no customer data', async () => {
  const f = await setup(), [id] = await f.queue(null, work());
  const summary = await f.run();
  assert.equal(summary.crewOutbox, 'configured');
  assert.deepEqual([summary.kinds.crew_assignment, summary.kinds.crew_unassignment], ['ready', 'ready']);
  assert.equal(summary.sent, 1);
  const [sent] = f.ghl.sends();
  assert.equal(sent.body.contactId, 'staff-1');
  assert.equal(sent.body.toNumber, '+19705550155');
  assert.match(sent.body.message, /^Hi Casey, you are scheduled for an Easy Garage Cleaning job on Thursday, September 24 \(arrival window 9:00 AM/);
  assert.ok(sent.body.message.includes(CREW_HUB_LINK), 'the link opens Schedule alerts in the Employee Hub');
  for (const value of ['Canary', '555-0123', '5550123', 'Canary Lane', 'canary-', '4242', '8765', '$', '1,200']) assert.ok(!sent.body.message.includes(value), `no ${value} in the crew text`);
  assert.deepEqual(f.ghl.calls.filter(call => call.path !== '/conversations/messages').map(call => call.path), ['/contacts/staff-1'], 'only the linked staff contact is looked up');
  assert.equal(f.upserts().length, 0, 'a crew send never creates or updates a HighLevel contact');
  assert.ok(f.accountReads.length && f.accountReads.every(id => id === 'crew1'), 'only the recipient\'s own account is read');
  const row = f.notice(id);
  assert.deepEqual([row.status, row.attempts, row.lastStatus, row.deliveredAt, row.nextAttemptAt], ['sent', 1, 'submitted', NOW, '']);
  const [ledger] = f.ledgers();
  assert.deepEqual([ledger.kind, ledger.audience, ledger.approval, ledger.source, ledger.status, ledger.recipient], ['crew_assignment', 'crew', 'owner_automation', 'cron', 'submitted', '(•••) •••-0155']);
  assert.ok(ledger.sendKey.endsWith(`:${id}`), 'each notice has its own send key');
  assert.equal(f.store.get('jobs/job-1').customerConversation, undefined, 'staff texts never enter the customer thread');
  assert.ok(f.store.commits.every(writes => writes.every(write => write.collection !== 'jobs')), 'a notice text never rewrites the job, so a dispatcher\'s next save keeps its revision');
  const again = await f.run();
  assert.deepEqual([again.due, again.sent, f.ghl.sends().length], [0, 0, 1], 'a sent notice is not picked up again');
});

test('a partial removal on a split-crew job is texted as a removal naming the lost day', async () => {
  const split = crewB => work({ date: '2026-09-23', endDate: DAY, time: '09:00', endTime: '12:00', assignedCrew: [...new Set(['crew1', ...crewB])], assignmentSegments: [
    { id: 'a', date: '2026-09-23', time: '09:00', endTime: '12:00', assignedCrew: ['crew1'] }, { id: 'b', date: DAY, time: '09:00', endTime: '12:00', assignedCrew: crewB }] });
  const f = await setup(), ids = await f.queue(split(['crew1']), split(['crew2']));
  const [partial] = ids.filter(id => f.notice(id).employeeId === 'crew1');
  await f.run();
  const texts = Object.fromEntries(f.ghl.sends().map(call => [call.body.contactId, call.body.message]));
  assert.match(texts['staff-1'], /^Hi Casey, you are no longer scheduled for the Easy Garage Cleaning job on Thursday, September 24\./, 'crew1 hears about the Thursday they lost, not the Wednesday they kept');
  assert.match(texts['staff-2'], /^Hi Riley, you are scheduled for an Easy Garage Cleaning job on Thursday, September 24 \(arrival window 9:00 AM/);
  assert.deepEqual([f.notice(partial).intent, f.notice(partial).status, f.notice(partial).lostSlots.map(row => row.segmentId)], ['unassigned', 'sent', ['b']]);
  // Put back on Thursday before the text went out: the removal no longer describes the job.
  const g = await setup(), [stale] = (await g.queue(split(['crew1']), split(['crew2']))).filter(id => g.notice(id).employeeId === 'crew1');
  g.store.set('jobs/job-1', split(['crew1', 'crew2']));
  const check = await crewNoticeProvider({ store: g.store })({ noticeId: stale, crewId: 'crew1', kind: 'crew_unassignment', job: { ...g.store.get('jobs/job-1'), id: 'job-1' }, now: g.time() });
  assert.deepEqual([check.valid, check.reason], [false, 'notice_superseded']);
});

test('a multi-day job made shorter texts its crew about the dropped day', async () => {
  const long = work({ date: '2026-09-23', time: '09:00', endDate: '2026-09-25', endTime: '17:00' });
  const f = await setup({ jobs: { 'job-1': long } }), [id] = await f.queue(long, work({ date: '2026-09-23', time: '09:00', endDate: DAY, endTime: '17:00' }));
  await f.run();
  assert.equal(f.ghl.sends().length, 1);
  assert.match(f.ghl.sends()[0].body.message, /^Hi Casey, you are no longer scheduled for the Easy Garage Cleaning job on Friday, September 25\./);
  assert.deepEqual([f.notice(id).intent, f.notice(id).status], ['unassigned', 'sent']);
});

// crew1 holds segment a (Wednesday 9:00) and segment b (Thursday) of one job.
const WED = '2026-09-23';
const split = (crewB, timeA = '09:00') => work({ date: WED, endDate: DAY, time: timeA, endTime: '12:00', assignedCrew: [...new Set(['crew1', ...crewB])], assignmentSegments: [
  { id: 'a', date: WED, time: timeA, endTime: '12:00', assignedCrew: ['crew1'] }, { id: 'b', date: DAY, time: '09:00', endTime: '12:00', assignedCrew: crewB }] });
const textsTo = (f, contact) => f.ghl.sends().filter(call => call.body.contactId === contact).map(call => call.body.message);
const CHANGED = /^Hi Casey, your Easy Garage Cleaning schedule changed\. Now: Wednesday, September 23 \(arrival window 10:00 AM\)\. No longer: Thursday, September 24\. Details are in the Employee Hub: /;

test('a removal and a move saved before one tick are one text naming both, in either order', async () => {
  for (const order of ['remove_then_move', 'move_then_remove']) {
    const f = await setup({ jobs: { 'job-1': split(['crew1']) } });
    const steps = order === 'remove_then_move' ? [[split(['crew1']), split(['crew2'])], [split(['crew2']), split(['crew2'], '10:00')]] : [[split(['crew1']), split(['crew1'], '10:00')], [split(['crew1'], '10:00'), split(['crew2'], '10:00')]];
    const first = (await f.queue(...steps[0], { at: '2026-09-22T17:00:00.000Z' })).find(id => f.notice(id).employeeId === 'crew1');
    const second = (await f.queue(...steps[1], { at: '2026-09-22T17:05:00.000Z' })).find(id => f.notice(id).employeeId === 'crew1');
    await f.run();
    const texts = textsTo(f, 'staff-1');
    assert.equal(texts.length, 1, order);
    assert.match(texts[0], CHANGED, `${order}: the lost Thursday and the new Wednesday time are both in the text`);
    assert.deepEqual([f.notice(first).status, f.notice(first).lastReason, f.notice(second).status], ['superseded', 'newer_notice', 'sent'], order);
    assert.equal(f.ledgers().find(row => row.audience === 'crew' && row.recipient.endsWith('0155')).kind, 'crew_schedule_change');
    await f.run();
    assert.equal(textsTo(f, 'staff-1').length, 1, `${order}: nothing is repeated`);
  }
});

test('a move plus a lost day in one save is one schedule-change text', async () => {
  const f = await setup({ jobs: { 'job-1': split(['crew1']) } });
  const [notice] = (await f.queue(split(['crew1']), split(['crew2'], '10:00'))).filter(id => f.notice(id).employeeId === 'crew1');
  assert.deepEqual([f.notice(notice).intent, f.notice(notice).messageKind], ['time_changed', 'crew_schedule_change']);
  await f.run();
  assert.deepEqual(textsTo(f, 'staff-1').map(text => CHANGED.test(text)), [true]);
  assert.match(textsTo(f, 'staff-2')[0], /^Hi Riley, you are scheduled for an Easy Garage Cleaning job on Thursday, September 24 \(arrival window 9:00 AM/);
});

test('a reschedule to another day says the new day and that the old one is off', async () => {
  const f = await setup(), [id] = await f.queue(work(), work({ date: '2026-09-25', endDate: '2026-09-25', time: '13:00', endTime: '15:00' }));
  await f.run();
  assert.match(f.ghl.sends()[0].body.message, /^Hi Casey, your Easy Garage Cleaning schedule changed\. Now: Friday, September 25 \(arrival window 1:00 PM[^)]*\)\. No longer: Thursday, September 24\./);
  assert.equal(f.notice(id).status, 'sent');
});

test('schedule-change wording that is not approved leaves every notice it covers queued', async () => {
  const f = await setup({ jobs: { 'job-1': split(['crew1']) }, approved: ['crew_assignment', 'crew_unassignment'] });
  const ids = [...await f.queue(split(['crew1']), split(['crew2']), { at: '2026-09-22T17:00:00.000Z' }), ...await f.queue(split(['crew2']), split(['crew2'], '10:00'), { at: '2026-09-22T17:05:00.000Z' })].filter(id => f.notice(id).employeeId === 'crew1');
  const summary = await f.run();
  assert.equal(summary.kinds.crew_schedule_change, 'template_not_approved');
  assert.deepEqual([textsTo(f, 'staff-1').length, ...ids.map(id => [f.notice(id).status, f.notice(id).attempts])], [0, ['pending', 0], ['pending', 0]], 'no partial text goes out in its place');
  const state = await readTemplate(f.store, 'crew_schedule_change');
  await mutateTemplate(f.store, owner, { action: 'approve', requestId: uuid(), kind: 'crew_schedule_change', expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
  await mutateTemplate(f.store, owner, { action: 'set_automation', requestId: uuid(), kind: 'crew_schedule_change', expectedVersion: 1, enabled: true }, NOW);
  await f.run();
  assert.deepEqual(textsTo(f, 'staff-1').map(text => CHANGED.test(text)), [true]);
  assert.deepEqual(ids.map(id => f.notice(id).status), ['superseded', 'sent']);
});

test('removal texts name every day and hour taken away', async () => {
  const cases = [
    ['a Wednesday to Saturday job cut to Wednesday', work({ date: WED, time: '09:00', endDate: '2026-09-26', endTime: '17:00' }), work({ date: WED, time: '09:00', endDate: WED, endTime: '17:00' }), 'Thursday, September 24, Friday, September 25 and Saturday, September 26'],
    ['two of three segments lost', ...(() => { const three = crew => work({ date: WED, endDate: '2026-09-25', time: '09:00', endTime: '12:00', assignedCrew: [...new Set(['crew1', ...crew])], assignmentSegments: [
      { id: 'a', date: WED, time: '09:00', endTime: '12:00', assignedCrew: ['crew1'] }, { id: 'b', date: DAY, time: '09:00', endTime: '12:00', assignedCrew: crew }, { id: 'c', date: '2026-09-25', time: '09:00', endTime: '12:00', assignedCrew: crew }] });
      return [three(['crew1']), three(['crew2'])]; })(), 'Thursday, September 24 and Friday, September 25'],
    ['an afternoon segment lost on a day still worked', ...(() => { const day = crew => work({ date: WED, endDate: WED, time: '08:00', endTime: '17:00', assignedCrew: [...new Set(['crew1', ...crew])], assignmentSegments: [
      { id: 'am', date: WED, time: '08:00', endTime: '12:00', assignedCrew: ['crew1'] }, { id: 'pm', date: WED, time: '13:00', endTime: '17:00', assignedCrew: crew }] });
      return [day(['crew1']), day(['crew2'])]; })(), 'Wednesday, September 23 from 1:00 PM to 5:00 PM'],
    ['a five-day job cancelled', work({ date: WED, time: '08:00', endDate: '2026-09-27', endTime: '17:00' }), work({ date: WED, time: '08:00', endDate: '2026-09-27', endTime: '17:00', status: 'cancelled', pipelineStatus: 'cancelled' }), 'Wednesday, September 23 through Sunday, September 27'],
  ];
  for (const [label, before, after, days] of cases) {
    const f = await setup({ jobs: { 'job-1': before } }), [id] = (await f.queue(before, after)).filter(row => f.notice(row).employeeId === 'crew1');
    await f.run();
    assert.deepEqual(textsTo(f, 'staff-1'), [`Hi Casey, you are no longer scheduled for the Easy Garage Cleaning job on ${days}. Your current schedule is in the Employee Hub: ${CREW_HUB_LINK}`], label);
    assert.deepEqual([REMOVAL.has(f.notice(id).intent), f.notice(id).status, f.ledgers().find(row => row.recipient.endsWith('0155')).kind], [true, 'sent', 'crew_unassignment'], label);
  }
});

test('a text that fails keeps every change it stood for, and so does one that needs a contact', async () => {
  const three = crew => work({ date: WED, endDate: '2026-09-25', time: '09:00', endTime: '12:00', assignedCrew: [...new Set(['crew1', ...crew.flat()])], assignmentSegments: [
    { id: 'a', date: WED, time: '09:00', endTime: '12:00', assignedCrew: ['crew1'] }, { id: 'b', date: DAY, time: '09:00', endTime: '12:00', assignedCrew: crew[0] }, { id: 'c', date: '2026-09-25', time: '09:00', endTime: '12:00', assignedCrew: crew[1] }] });
  const both = 'Thursday, September 24 and Friday, September 25';
  const f = await setup({ jobs: { 'job-1': three([['crew1'], ['crew1']]) }, ghl: { sendStatus: 400 } });
  const ids = [...await f.queue(three([['crew1'], ['crew1']]), three([['crew2'], ['crew1']]), { at: '2026-09-22T17:00:00.000Z' }), ...await f.queue(three([['crew2'], ['crew1']]), three([['crew2'], ['crew2']]), { at: '2026-09-22T17:05:00.000Z' })].filter(id => f.notice(id).employeeId === 'crew1');
  await f.run();
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).attempts]), [['pending', 0], ['pending', 1]], 'the older notice waits with the one that carries it');
  f.ghl.state.sendStatus = 200; f.time.set(f.notice(ids[1]).nextAttemptAt);
  await f.run();
  const texts = textsTo(f, 'staff-1');
  assert.equal(texts.length, 2);
  assert.ok(texts.every(text => text.includes(both)), 'the retried text still names both days');
  assert.deepEqual(ids.map(id => f.notice(id).status), ['superseded', 'sent']);
  // Closed without a text (no staff contact), then retried by a dispatcher: still both days.
  const g = await setup({ jobs: { 'job-1': three([['crew1'], ['crew1']]) }, linked: {} });
  const later = [...await g.queue(three([['crew1'], ['crew1']]), three([['crew2'], ['crew1']]), { at: '2026-09-22T17:00:00.000Z' }), ...await g.queue(three([['crew2'], ['crew1']]), three([['crew2'], ['crew2']]), { at: '2026-09-22T17:05:00.000Z' })].filter(id => g.notice(id).employeeId === 'crew1');
  await g.run();
  assert.deepEqual(later.map(id => g.notice(id).status), ['superseded', 'needs_contact']);
  assert.deepEqual(g.notice(later[1]).heardSlots.map(row => row.segmentId), ['a', 'b', 'c'], 'what the employee last heard is kept on the notice');
  g.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
  const feed = createCrewNotificationFeed({ store: Object.assign(g.store, { query: g.storage.query }), env: {}, now: () => g.time() });
  await feed.retry({ user: 'zacb', role: 'owner', businessAccess: true }, { action: 'retry', requestId: uuid(), ids: [later[1]] });
  await g.run();
  assert.deepEqual(textsTo(g, 'staff-1'), [`Hi Casey, you are no longer scheduled for the Easy Garage Cleaning job on ${both}. Your current schedule is in the Employee Hub: ${CREW_HUB_LINK}`]);
});

test('a dispatcher retry never repeats a text the employee already had', async () => {
  const f = await setup({ linked: {} }), manager = { user: 'zacb', role: 'owner', businessAccess: true };
  const [n1] = await f.queue(null, work(), { at: '2026-09-22T17:00:00.000Z' });
  await f.run();
  assert.equal(f.notice(n1).status, 'needs_contact');
  f.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
  const [n2] = await f.queue(work(), work({ time: '10:00' }), { at: '2026-09-22T17:10:00.000Z' });
  await f.run();
  const [n3] = await f.queue(work({ time: '10:00' }), work(), { at: '2026-09-22T17:20:00.000Z' });
  await f.run();
  assert.deepEqual([f.notice(n2).status, f.notice(n3).status, f.ghl.sends().length], ['sent', 'sent', 2]);
  const attention = async (today, limit) => (await f.storage.query([])).filter(row => typeof row.attentionUntil === 'string' && row.attentionUntil >= today).slice(0, limit);
  const feed = createCrewNotificationFeed({ store: Object.assign(f.store, { query: f.storage.query, attention }), env: {}, now: () => f.time() });
  const team = await feed.team(manager);
  assert.deepEqual(team.attention.map(row => [row.id, row.canRetry]), [[n1, true]], 'the list cannot see the texted notices, so the server decides');
  const result = await feed.retry(manager, { action: 'retry', requestId: uuid(), ids: [n1] });
  assert.deepEqual([result.retried, result.superseded], [[], [n1]]);
  assert.deepEqual([f.notice(n1).status, f.notice(n1).lastReason, f.notice(n1).attentionUntil], ['superseded', 'newer_notice', '']);
  await f.run();
  assert.equal(f.ghl.sends().length, 2, 'no third "scheduled Thursday 9:00" text');
  // Queued again another way (a stale client, or a manual edit): the send hook still refuses it.
  f.store.edit(`${CREW_NOTIFICATIONS}/${n1}`, { status: 'pending', attempts: 0, lastStatus: 'retry_requested', attentionUntil: '' });
  await f.run();
  assert.deepEqual([f.ghl.sends().length, f.notice(n1).status, f.notice(n1).lastReason], [2, 'superseded', 'newer_notice']);
});

test('a notice waits while a newer one for the same job and employee is still queued', async () => {
  const f = await setup();
  const [older] = await f.queue(null, work(), { at: '2026-09-22T17:00:00.000Z' }), [newer] = await f.queue(work(), work({ time: '10:00' }), { at: '2026-09-22T17:05:00.000Z' });
  const hook = crewNoticeProvider({ store: f.store, query: f.storage.query });
  const check = await hook({ noticeId: older, crewId: 'crew1', kind: 'crew_assignment', job: { ...f.store.get('jobs/job-1'), id: 'job-1' }, now: f.time() });
  assert.deepEqual([check.valid, check.reason], [false, 'newer_notice_pending']);
  assert.deepEqual(noticeTransition({ attempts: 1 }, { status: 'not_eligible', reason: 'newer_notice_pending' }, NOW), { attempts: 1, lastStatus: 'not_eligible', lastReason: 'newer_notice_pending', updatedAt: NOW, status: 'pending', nextAttemptAt: '2026-09-22T18:05:00.000Z' }, 'no attempt is spent');
  assert.equal(noticeTransition({ attempts: 0 }, { status: 'not_eligible', reason: 'newer_notice' }, NOW).status, 'superseded');
  const valid = await hook({ noticeId: newer, crewId: 'crew1', kind: 'crew_assignment', job: { ...f.store.get('jobs/job-1'), id: 'job-1' }, now: f.time() });
  assert.deepEqual([valid.valid, valid.kind, valid.date, valid.time], [true, 'crew_assignment', DAY, '10:00']);
});

test('a job\'s saves are ordered by the revision each was made against, not by worker clocks', async () => {
  const f = await setup({ jobs: { 'job-1': split(['crew1']) } });
  const first = await crewNotificationWrites({ jobId: 'job-1', requestId: uuid(), action: 'schedule.update', type: 'job', before: split(['crew1']), after: split(['crew2']), roster: ROSTER, now: '2026-09-22T17:05:00.000Z', baseRevision: '2026-09-22T17:00:00.5Z' });
  // The later save ran on a worker whose clock was behind.
  const second = await crewNotificationWrites({ jobId: 'job-1', requestId: uuid(), action: 'schedule.update', type: 'job', before: split(['crew2']), after: split(['crew2'], '10:00'), roster: ROSTER, now: '2026-09-22T17:04:59.000Z', baseRevision: '2026-09-22T17:05:00.123456Z' });
  f.store.set('jobs/job-1', split(['crew2'], '10:00'));
  await f.store.commit([...first, ...second]);
  const [older, newer] = [first, second].map(writes => writes.find(write => write.patch.employeeId === 'crew1').id);
  assert.deepEqual([f.notice(older).baseRevision, f.notice(newer).baseRevision], ['2026-09-22T17:00:00.5Z', '2026-09-22T17:05:00.123456Z']);
  await f.run();
  assert.deepEqual(textsTo(f, 'staff-1').map(text => CHANGED.test(text)), [true]);
  assert.deepEqual([f.notice(older).status, f.notice(newer).status], ['superseded', 'sent']);
  const created = await crewNotificationWrites({ jobId: 'job-2', requestId: uuid(), type: 'job', before: null, after: work(), roster: ROSTER, now: NOW, baseRevision: 'ignored' });
  assert.equal(created[0].patch.baseRevision, '', 'a create is the first save of its job');
});

test('jobs whose crew is stored by display name are texted like any other', async () => {
  const legacy = extra => work({ assignedCrew: undefined, assignedTo: 'Casey Crew', crewLead: null, ...extra });
  const f = await setup({ jobs: { 'job-1': legacy() } }), [moved] = await f.queue(legacy(), legacy({ time: '10:00' }), { at: '2026-09-22T17:00:00.000Z' });
  assert.equal(f.notice(moved).employeeId, 'crew1');
  await f.run();
  assert.deepEqual([f.notice(moved).status, f.ghl.sends().length], ['sent', 1]);
  assert.match(f.ghl.sends()[0].body.message, /^Hi Casey, you are scheduled for an Easy Garage Cleaning job on Thursday, September 24 \(arrival window 10:00 AM/);
  const [removed] = (await f.queue(legacy({ time: '10:00' }), legacy({ time: '10:00', assignedTo: 'Riley Other' }), { at: '2026-09-22T17:30:00.000Z' })).filter(id => f.notice(id).employeeId === 'crew1');
  await f.run();
  assert.equal(f.notice(removed).status, 'sent');
  assert.match(textsTo(f, 'staff-1').at(-1), /^Hi Casey, you are no longer scheduled for the Easy Garage Cleaning job on Thursday, September 24\./);
});

test('only the schedule-change wording may use {{removedDates}}', () => {
  const body = 'Hi {{firstName}}, no longer on {{removedDates}}.';
  assert.deepEqual(validateTemplateVersion({ channel: 'SMS', body }, TEMPLATE_KINDS.crew_schedule_change.variables).variables, ['firstName', 'removedDates']);
  for (const kind of ['crew_assignment', 'crew_unassignment', 'day_before_reminder']) assert.throws(() => validateTemplateVersion({ channel: 'SMS', body }, TEMPLATE_KINDS[kind].variables), error => error.code === 'messaging_template_variable_not_allowed', kind);
});

test('work that finished earlier today is never texted about', async () => {
  const morning = work({ date: '2026-09-22', endDate: '2026-09-22', time: '08:00', endTime: '11:00' });
  const f = await setup({ jobs: { 'job-1': morning } }), [id] = await f.queue(null, morning, { at: '2026-09-22T13:00:00.000Z' });
  await f.run();
  assert.deepEqual([f.ghl.sends().length, f.notice(id).status, f.notice(id).lastReason], [0, 'expired', 'slot_passed'], 'at noon the 8-11 AM slot is over');
});

test('a crew text needs a staff contact a dispatcher linked and the owner tagged; nothing is upserted', async () => {
  const f = await setup({ linked: {} }), [id] = await f.queue(null, work());
  await f.run();
  assert.deepEqual([f.notice(id).status, f.notice(id).lastReason, f.notice(id).attentionUntil], ['needs_contact', 'staff_contact_not_linked', DAY]);
  assert.deepEqual([f.ghl.calls.length, f.ledgers().length], [0, 0]);
  const untagged = { ...STAFF, 'staff-1': { ...STAFF['staff-1'], tags: ['customer'] } };
  const g = await setup({ ghl: { contacts: untagged } }), [other] = await g.queue(null, work());
  await g.run();
  assert.deepEqual([g.notice(other).status, g.notice(other).lastReason, g.ghl.sends().length, g.upserts().length], ['needs_contact', 'staff_tag_missing', 0, 0]);
});

test('an earlier notice whose text went out still counts: the removal after it is sent, not cancelled out', async () => {
  for (const evidence of ['ledger', 'sending']) {
    const f = await setup(), [first] = await f.queue(null, work());
    if (evidence === 'ledger') f.store.set(`message_sends/${await ledgerId(noticeSendKey({ ...f.notice(first), id: first }))}`, { kind: 'crew_assignment', status: 'submitted', attempts: 1 });
    else f.store.edit(`${CREW_NOTIFICATIONS}/${first}`, { lastStatus: 'sending' });
    f.time.advance(1000);
    const [removal] = await f.queue(work(), work({ assignedCrew: [] }));
    f.time.set(NOW);
    await f.run();
    assert.equal(f.ghl.sends().length, 1, evidence);
    assert.match(f.ghl.sends()[0].body.message, /no longer scheduled/);
    assert.deepEqual([f.notice(removal).status, f.notice(first).status, f.notice(first).lastReason], ['sent', evidence === 'ledger' ? 'sent' : 'uncertain', 'send_recorded']);
    assert.ok(f.batchReads.some(read => read.collection === 'message_sends'), 'the ledger is read in one batch');
  }
});

test('new visits from one recurring run are one text per employee, the rest listed in the Hub', async () => {
  const visit = date => work({ date, endDate: date, sourceTemplateJobId: 'template-1' }), batch = 'recurring:plan-1:run-1';
  const f = await setup({ jobs: { 'job-2': visit('2026-10-01'), 'job-1': visit(DAY), 'job-3': visit('2026-10-08') } });
  const later = (await f.queue(null, visit('2026-10-01'), { jobId: 'job-2', batch }))[0], first = (await f.queue(null, visit(DAY), { jobId: 'job-1', batch }))[0], last = (await f.queue(null, visit('2026-10-08'), { jobId: 'job-3', batch }))[0];
  await f.run();
  assert.equal(f.ghl.sends().length, 1);
  assert.match(f.ghl.sends()[0].body.message, /on Thursday, September 24, plus 2 more visits through Thursday, October 8 \(arrival window 9:00 AM/, 'the earliest visit is named, with how many more and the last date');
  assert.deepEqual([first, later, last].map(id => [f.notice(id).status, f.notice(id).lastReason]), [['sent', ''], ['batched', 'grouped_text'], ['batched', 'grouped_text']]);
  assert.deepEqual([later, last].map(id => f.notice(id).batchedInto), [first, first]);
  // A dispatcher's own repeats of a job (no recurring run) are each texted.
  const g = await setup({ jobs: { 'job-1': visit(DAY), 'job-2': visit('2026-10-01') } });
  await g.queue(null, visit(DAY), { jobId: 'job-1' }); await g.queue(null, visit('2026-10-01'), { jobId: 'job-2' });
  await g.run();
  assert.deepEqual(g.ghl.sends().map(call => /on (\w+day, \w+ \d+) \(/.exec(call.body.message)[1]).sort(), ['Thursday, October 1', 'Thursday, September 24']);
});

test('a grouped text that needs a contact is sent again with its visits after a dispatcher retry', async () => {
  const visit = date => work({ date, endDate: date, sourceTemplateJobId: 'template-1' }), batch = 'recurring:plan-1:run-1';
  const f = await setup({ jobs: { 'job-1': visit(DAY), 'job-2': visit('2026-10-01'), 'job-3': visit('2026-10-08') }, linked: {} });
  const ids = [];
  for (const [jobId, date] of [['job-1', DAY], ['job-2', '2026-10-01'], ['job-3', '2026-10-08']]) ids.push((await f.queue(null, visit(date), { jobId, batch }))[0]);
  await f.run();
  assert.deepEqual(ids.map(id => f.notice(id).status), ['needs_contact', 'batched', 'batched']);
  f.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
  const feed = createCrewNotificationFeed({ store: Object.assign(f.store, { query: f.storage.query }), env: {}, now: () => f.time() });
  const retried = await feed.retry({ user: 'zacb', role: 'owner', businessAccess: true }, { action: 'retry', requestId: uuid(), ids: [ids[0]] });
  assert.deepEqual([retried.retried, retried.superseded, retried.regrouped.sort()], [[ids[0]], [], [ids[1], ids[2]].sort()]);
  assert.deepEqual(ids.map(id => f.notice(id).status), ['pending', 'pending', 'pending'], 'the visits it stood for are queued again with it');
  await f.run();
  assert.equal(f.ghl.sends().length, 1);
  assert.match(f.ghl.sends()[0].body.message, /on Thursday, September 24, plus 2 more visits through Thursday, October 8/);
  assert.deepEqual(ids.map(id => f.notice(id).status), ['sent', 'batched', 'batched']);
});

test('an unreadable crew outbox never stops the customer reminders in the same tick', async () => {
  const customer = { 'contact-1': { id: 'contact-1', locationId: 'location-1', phone: '+19705550123', email: 'synthetic@example.invalid', dnd: false, tags: [] } };
  const tomorrow = work({ date: '2026-09-23', endDate: '2026-09-23', deposit: { amount: 300, paidAmount: 300, verified: true } });
  const f = await setup({ jobs: { 'job-1': work(), 'visit-2': tomorrow }, approved: ['crew_assignment', 'crew_unassignment', 'day_before_reminder'], ghl: { contacts: { ...STAFF, ...customer } } });
  await f.queue(null, work());
  f.storage.failQuery = () => { throw Object.assign(new Error('Synthetic runQuery outage'), { code: 'crew_notifications_storage_unavailable', status: 503 }); };
  const summary = await f.run();
  assert.equal(summary.crewOutbox, 'unavailable');
  assert.deepEqual(summary.byKind.day_before_reminder, { due: 1, sent: 1 });
  assert.deepEqual(f.ghl.sends().map(call => call.body.contactId), ['contact-1'], 'the reminder went out; the crew notice waits for the next tick');
});

test('two concurrent ticks deliver a notice exactly once', async () => {
  const f = await setup(), [id] = await f.queue(null, work());
  const [left, right] = await Promise.all([f.run(), f.run()]);
  assert.equal(f.ghl.sends().length, 1);
  assert.equal(left.sent + right.sent, 1);
  assert.equal(left.attempted + right.attempted, 2, 'both ticks raced for the same notice');
  await settle();
  assert.equal(f.notice(id).status, 'sent');
  await f.run();
  assert.equal(f.ghl.sends().length, 1);
  assert.equal(f.ledgers().length, 1);
});

test('a missing phone is needs_contact and an employee who has not opted in is skipped, without calling HighLevel', async () => {
  const f = await setup({ optedIn: ['crew3'] }), ids = await f.queue(null, work({ assignedCrew: ['crew2', 'crew3'] }));
  const byEmployee = Object.fromEntries(ids.map(id => [f.notice(id).employeeId, id]));
  await f.run();
  assert.equal(f.ghl.calls.length, 0);
  assert.deepEqual([f.notice(byEmployee.crew3).status, f.notice(byEmployee.crew3).lastReason], ['needs_contact', 'no_phone']);
  assert.deepEqual([f.notice(byEmployee.crew2).status, f.notice(byEmployee.crew2).lastReason], ['not_opted_in', 'sms_not_opted_in']);
  assert.deepEqual([f.notice(byEmployee.crew3).attentionUntil, f.notice(byEmployee.crew2).attentionUntil], [DAY, DAY], 'both stay on the dispatcher\'s list until the work has passed');
  assert.equal(f.ledgers().length, 0);
});

test('only the newest pending notice per job and employee is sent; changes that cancel out send nothing', async () => {
  const f = await setup({ jobs: { 'job-1': work(), 'job-2': work() } });
  const [first] = await f.queue(null, work());
  const moved = work({ time: '13:00', endTime: '15:00' });
  f.time.advance(1000);
  const [second] = await f.queue(work(), moved);
  const [added] = await f.queue(null, work(), { jobId: 'job-2' });
  f.time.advance(1000);
  const [removed] = await f.queue(work(), work({ assignedCrew: [] }), { jobId: 'job-2' });
  f.time.set(NOW);
  await f.run();
  assert.equal(f.ghl.sends().length, 1);
  assert.match(f.ghl.sends()[0].body.message, /on Thursday, September 24 \(arrival window 1:00 PM/);
  assert.deepEqual([f.notice(first).status, f.notice(first).lastReason, f.notice(second).status], ['superseded', 'newer_notice', 'sent']);
  assert.deepEqual([f.notice(added).status, f.notice(removed).status, f.notice(removed).lastReason], ['superseded', 'superseded', 'net_unchanged']);
});

test('a notice that no longer matches the live job is closed as stale and never sent', async () => {
  const f = await setup(), [id] = await f.queue(null, work());
  f.store.set('jobs/job-1', work({ time: '14:00', endTime: '16:00' }));
  await f.run();
  assert.equal(f.ghl.sends().length, 0);
  assert.deepEqual([f.notice(id).status, f.notice(id).lastReason], ['stale', 'notice_superseded']);
  const g = await setup(), [other] = await g.queue(null, work());
  g.store.set('jobs/job-1', work({ assignedCrew: ['crew2'] }));
  await g.run();
  assert.deepEqual([g.ghl.sends().length, g.notice(other).status, g.notice(other).lastReason], [0, 'stale', 'crew_not_assigned']);
});

test('removals and cancellations use the owner-approved crew_unassignment wording', async () => {
  const f = await setup(), both = work({ assignedCrew: ['crew1', 'crew2'] });
  f.store.set('jobs/job-1', both);
  const [removed] = await f.queue(both, work());
  await f.run();
  assert.equal(f.ghl.sends().length, 1);
  assert.equal(f.ghl.sends()[0].body.toNumber, '+19705550166');
  assert.match(f.ghl.sends()[0].body.message, /^Hi Riley, you are no longer scheduled for the Easy Garage Cleaning job on Thursday, September 24\./);
  assert.equal(f.notice(removed).status, 'sent');
  assert.equal(f.ledgers().find(row => row.kind === 'crew_unassignment').audience, 'crew');
  const [cancelled] = await f.queue(work(), work({ status: 'cancelled', pipelineStatus: 'cancelled' }));
  await f.run();
  assert.equal(f.notice(cancelled).intent, 'cancelled');
  assert.equal(f.notice(cancelled).status, 'sent');
  assert.match(f.ghl.sends()[1].body.message, /^Hi Casey, you are no longer scheduled/);
  const g = await setup({ approved: ['crew_assignment'] }), [waiting] = await g.queue(work(), work({ assignedCrew: [] }));
  const summary = await g.run();
  assert.equal(summary.kinds.crew_unassignment, 'template_not_approved');
  assert.deepEqual([g.ghl.sends().length, g.notice(waiting).status, g.notice(waiting).attempts], [0, 'pending', 0], 'unapproved wording waits; nothing is sent');
});

test('rejections back off on the injected clock until the attempts run out, and uncertain sends are never repeated', async () => {
  const f = await setup({ ghl: { sendStatus: 400 } }), [id] = await f.queue(null, work());
  await f.run();
  assert.deepEqual([f.notice(id).status, f.notice(id).attempts, f.notice(id).lastStatus, f.notice(id).nextAttemptAt], ['pending', 1, 'failed', '2026-09-22T18:05:00.000Z']);
  f.time.advance(60000);
  await f.run();
  assert.equal(f.ghl.sends().length, 1, 'not retried before its backoff');
  f.time.set('2026-09-22T18:05:00.000Z');
  await f.run();
  assert.deepEqual([f.ghl.sends().length, f.notice(id).attempts, f.notice(id).nextAttemptAt], [2, 2, '2026-09-22T18:15:00.000Z']);
  f.time.set('2026-09-22T18:15:00.000Z');
  await f.run();
  assert.deepEqual([f.ghl.sends().length, f.notice(id).status, f.notice(id).attempts], [3, 'pending', 3]);
  f.time.set(f.notice(id).nextAttemptAt);
  await f.run();
  assert.deepEqual([f.ghl.sends().length, f.notice(id).status, f.notice(id).lastStatus], [3, 'failed', 'attempts_exhausted'], 'the ledger limit ends the retries');
  const g = await setup({ ghl: { sendStatus: 503 } }), [unsure] = await g.queue(null, work());
  await g.run();
  assert.deepEqual([g.ghl.sends().length, g.notice(unsure).status], [1, 'uncertain']);
  g.time.advance(3600000);
  await g.run();
  assert.equal(g.ghl.sends().length, 1, 'an uncertain text is never resent');
});

test('dry runs and quiet hours never change a notice', async () => {
  const f = await setup({ optedIn: ['crew1'] }), ids = await f.queue(null, work({ assignedCrew: ['crew1', 'crew2'] }));
  const before = ids.map(f.notice);
  const preview = await f.run({ dryRun: true });
  assert.deepEqual(preview.results.map(row => [row.kind, row.status]), [['crew_assignment', 'would_send']]);
  assert.deepEqual([f.ghl.sends().length, f.noticeCommits().length, f.ledgers().length], [0, 0, 0]);
  assert.deepEqual(ids.map(f.notice), before, 'a dry run does not even close the not-opted-in notice');
  f.time.set('2026-09-23T04:00:00.000Z');
  const night = await f.run();
  assert.equal(night.deferred, 'quiet_hours');
  assert.deepEqual([f.ghl.sends().length, f.noticeCommits().length], [0, 0]);
});

test('acknowledged notices are not texted, past slots expire, and malformed rows are closed', async () => {
  const f = await setup({ jobs: { 'job-1': work(), 'job-2': work({ date: '2026-09-21', endDate: '2026-09-21' }) } });
  const [seen] = await f.queue(null, work());
  f.store.edit(`${CREW_NOTIFICATIONS}/${seen}`, { acknowledged: true, acknowledgedAt: NOW });
  const [past] = await f.queue(null, work({ date: '2026-09-21', endDate: '2026-09-21' }), { jobId: 'job-2', at: '2026-09-20T18:00:00.000Z' });
  f.store.set(`${CREW_NOTIFICATIONS}/crew_${'0'.repeat(40)}`, { jobId: 'job-1', employeeId: 'crew1', intent: 'assigned', messageKind: 'crew_unassignment', status: 'pending', slot: { date: DAY } });
  await f.run();
  assert.equal(f.ghl.sends().length, 0);
  assert.deepEqual([f.notice(seen).status, f.notice(past).status, f.notice(`crew_${'0'.repeat(40)}`).status], ['skipped', 'expired', 'stale']);
  assert.equal(wellFormedNotice({ ...f.notice(seen), id: seen }), true);
  assert.equal(wellFormedNotice({ ...f.notice(seen), id: seen, messageKind: 'day_before_reminder' }), false);
});

test('the flag off leaves the scheduler exactly as before', async () => {
  assert.equal(crewNotificationDeps({ ...messagingEnv }, { store: memoryStore() }), null);
  const f = await setup({ flags: { EGC_CREW_NOTIFICATIONS_ENABLED: 'false' } });
  await f.queue(null, work());
  const store = f.store, service = createApprovedSendService({ store, messenger: createGhlMessenger({ env: f.settings, fetcher: f.ghl.fetcher, clock: f.time }), clock: f.time, env: f.settings });
  const summary = await runDueMessages({ store, service, flags: messagingFlags(f.settings), crewOutbox: crewNotificationDeps(f.settings, { store })?.outbox || null }, { now: f.time() });
  assert.equal(summary.crewOutbox, 'not_configured');
  assert.equal(summary.kinds.crew_assignment, undefined);
  assert.equal(f.ghl.calls.length, 0);
});

test('notice transitions: closing outcomes, waiting without an attempt, and capped backoff', () => {
  const at = NOW, row = { attempts: 0 };
  assert.equal(noticeTransition(row, { status: 'not_attempted' }, at), null);
  assert.equal(noticeTransition(row, {}, at), null);
  for (const [status, closed] of [['submitted', 'sent'], ['already_sent', 'sent'], ['dry_run', 'dry_run'], ['uncertain', 'uncertain'], ['needs_contact', 'needs_contact'], ['suppressed', 'suppressed'], ['contact_mismatch', 'suppressed'], ['not_eligible', 'stale'], ['attempts_exhausted', 'failed']]) {
    assert.equal(noticeTransition(row, { status }, at).status, closed, status);
  }
  assert.equal(noticeTransition(row, { status: 'error', reason: 'crew_contact_unavailable' }, at).status, 'needs_contact', 'no approved account is a contact problem');
  assert.deepEqual(noticeTransition({ attempts: 2 }, { status: 'deferred', reason: 'quiet_hours' }, at), { attempts: 2, lastStatus: 'deferred', lastReason: 'quiet_hours', updatedAt: at, status: 'pending', nextAttemptAt: '2026-09-22T18:05:00.000Z' });
  const waits = [0, 1, 2, 3].map(attempts => noticeTransition({ attempts }, { status: 'error', reason: 'messaging_unavailable' }, at).nextAttemptAt);
  assert.deepEqual(waits, ['2026-09-22T18:05:00.000Z', '2026-09-22T18:10:00.000Z', '2026-09-22T18:20:00.000Z', '2026-09-22T18:40:00.000Z']);
  assert.deepEqual([noticeTransition({ attempts: MAX_ATTEMPTS - 1 }, { status: 'error' }, at).status, noticeTransition({ attempts: MAX_ATTEMPTS - 1 }, { status: 'sending' }, at).status], ['failed', 'uncertain']);
  assert.equal(noticeTransition({ attempts: 0 }, { status: 'sending' }, at).status, 'pending', 'another tick holds the claim; its own result closes the notice');
  assert.equal(noticeTransition({ attempts: 0 }, { status: 'Bad Status!' }, at), null);
});

test('crew contact comes only from an approved account and only after the employee opted in', async () => {
  const store = memoryStore({ [`${CREW_NOTIFICATION_PREFS}/crew1`]: { sms: true, staffContactId: 'staff-1' }, [`${CREW_NOTIFICATION_PREFS}/crew2`]: { sms: false, staffContactId: 'bad id!' } });
  let charged = 0;
  const accounts = { ...ACCOUNTS, crew4: { username: 'someone-else', status: 'approved', phone: '9705550177' }, crew5: { username: 'crew5', status: 'pending', phone: '9705550188' } };
  const contact = crewContactProvider({ env: { HUB_AUTH_USERS_JSON: JSON.stringify({ zacb: { passwordHash: 'synthetic', role: 'owner', displayName: 'Zac Owner' } }) }, store, charge: cost => { charged += cost; }, readAccount: async id => accounts[id] ? { account: accounts[id] } : null });
  assert.deepEqual(await contact({ crewId: 'CREW1' }), { name: 'Casey Crew', phone: '(970) 555-0155', email: '', highlevelContactId: 'staff-1' }, 'the staff contact a dispatcher linked');
  assert.deepEqual(await contact({ crewId: 'crew2' }), { name: 'Riley Other', phone: '', email: '', highlevelContactId: '' }, 'opted out: no phone, so no text; a malformed link is ignored');
  assert.equal(await contact({ crewId: 'crew4' }), null, 'an account for another username is never used');
  assert.equal(await contact({ crewId: 'crew5' }), null, 'an unapproved account is never used');
  assert.equal(await contact({ crewId: 'nobody' }), null);
  assert.deepEqual(await contact({ crewId: 'zacb' }), { name: 'Zac Owner', phone: '', email: '', highlevelContactId: '' }, 'configured Hub users have no phone on file');
  assert.equal(charged, 5, 'each encrypted account read is charged to the tick budget');
});

test('people can never send or preview a dispatch notice themselves', async () => {
  const store = memoryStore({ 'jobs/job-1': work() });
  const service = createApprovedSendService({ store, messenger: createGhlMessenger({ env: ENV, fetcher: fakeGhl().fetcher, clock: clock(NOW) }), clock: clock(NOW), env: ENV });
  await assert.rejects(service.preview(manager, { kind: 'crew_assignment', jobId: 'job-1', overrides: { crewId: 'crew1', noticeId: `crew_${'1'.repeat(40)}` } }), error => error.code === 'messaging_override_not_allowed');
  await assert.rejects(service.preview(manager, { kind: 'crew_unassignment', jobId: 'job-1', overrides: { crewId: 'crew1' } }), error => error.code === 'messaging_trigger_not_allowed');
  const automated = createApprovedSendService({ store, messenger: createGhlMessenger({ env: ENV, fetcher: fakeGhl().fetcher, clock: clock(NOW) }), clock: clock(NOW), env: ENV, crewContact: async () => ({ name: 'Casey Crew', phone: '9705550155' }) });
  await assert.rejects(automated.preview({ id: 'cron', kind: 'system', source: 'cron' }, { kind: 'crew_unassignment', jobId: 'job-1', overrides: { crewId: 'crew1' } }), error => error.code === 'messaging_not_eligible' && error.details.reason === 'notice_required', 'a removal text needs a dispatch notice');
});

test('the Firestore adapter uses equality queries and fails closed on incomplete answers', async () => {
  const calls = [];
  const doc = (id, fields, updateTime = '2026-09-22T18:00:00.000000Z') => ({ document: { name: `projects/egcw-1ec83/databases/(default)/documents/${CREW_NOTIFICATIONS}/${id}`, fields: encodeFirestoreFields(fields), updateTime } });
  let answer = [doc('crew_a', { employeeId: 'crew1', acknowledged: false }), { readTime: 'x' }];
  const fetcher = async (_env, url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); if (answer instanceof Error) throw answer; return typeof answer === 'number' ? new Response('{}', { status: answer }) : Response.json(answer); };
  const storage = crewNotificationStorage({}, fetcher);
  assert.deepEqual(await storage.query([['employeeId', 'crew1'], ['acknowledged', false]], 101), [{ employeeId: 'crew1', acknowledged: false, id: 'crew_a', revision: '2026-09-22T18:00:00.000000Z' }]);
  assert.match(calls[0].url, /documents:runQuery$/);
  assert.deepEqual(calls[0].body.structuredQuery, { from: [{ collectionId: CREW_NOTIFICATIONS }], limit: 101, where: { compositeFilter: { op: 'AND', filters: [
    { fieldFilter: { field: { fieldPath: 'employeeId' }, op: 'EQUAL', value: { stringValue: 'crew1' } } }, { fieldFilter: { field: { fieldPath: 'acknowledged' }, op: 'EQUAL', value: { booleanValue: false } } }] } } });
  await storage.query([['status', 'pending']]);
  assert.deepEqual(calls[1].body.structuredQuery.where, { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'pending' } } });
  await storage.attention('2026-09-22', 101);
  assert.deepEqual(calls[2].body.structuredQuery, { from: [{ collectionId: CREW_NOTIFICATIONS }], limit: 101, orderBy: [{ field: { fieldPath: 'attentionUntil' }, direction: 'ASCENDING' }],
    where: { fieldFilter: { field: { fieldPath: 'attentionUntil' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: '2026-09-22' } } } }, 'one range on one field: a single-field index serves it');
  for (const bad of [{ not: 'an array' }, [{ error: { code: 500 } }], [doc('crew_b', {}, '')], [{ document: { name: 'projects/x/documents/other/crew_c', updateTime: 't' } }]]) {
    answer = bad;
    await assert.rejects(storage.query([['status', 'pending']]), error => error.code === 'crew_notifications_storage_incomplete' && error.status === 503, JSON.stringify(bad));
  }
  answer = 500; await assert.rejects(storage.query([['status', 'pending']]), error => error.code === 'crew_notifications_storage_unavailable');
  answer = new Error('offline'); await assert.rejects(storage.query([['status', 'pending']]), error => error.code === 'crew_notifications_storage_unavailable');
});

test('the signed messaging cron drains notices with the flag on and leaves them alone with it off', async () => {
  const API_ROOT = 'synthetic-crew-notify-api-root-secret-0123456789', keys = servicePublicKeySet({ service: 'api', rootSecret: API_ROOT, workspace: 'egc' }), nonces = new Set();
  const nonceFetch = async (_env, url, init) => {
    const body = JSON.parse(init.body);
    if (body.structuredQuery) return Response.json([]);
    const name = body.writes[0].update.name;
    if (nonces.has(name)) return new Response('{}', { status: 409 });
    nonces.add(name); return Response.json({});
  };
  const verify = (env, token, path, options) => verifyApiServiceEnvelope(env, token, path, { ...options, resolveKey: async () => (await keys).keys[0], firestoreFetch: nonceFetch });
  const sign = () => signServiceRequest({ service: 'api', rootSecret: API_ROOT, workspace: 'egc', path: MESSAGING_CRON_PATH, actor: { id: 'messaging-cron-worker', kind: 'integration', role: 'integration', workspace: 'egc' }, request: { requestId: uuid(), body: { command: 'messaging.run' } }, now: Date.parse(NOW) });
  const f = await setup(), [id] = await f.queue(null, work());
  const handler = messagingCronHandlers({ verify, storage: () => f.store, now: f.time, links: () => ({}), portalInvite: () => null,
    messenger: env => createGhlMessenger({ env, fetcher: f.ghl.fetcher, clock: f.time }),
    crew: (env, options) => crewNotificationDeps(env, { ...options, storage: f.storage, readAccount: async username => ACCOUNTS[username] ? { account: ACCOUNTS[username] } : null }) });
  const post = async env => { const response = await handler.post({ request: new Request(`https://easygaragecleaning.com${MESSAGING_CRON_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelope: await sign() }) }), env }); return { status: response.status, body: await response.json() }; };
  const cronEnv = { ...ENV, EGC_SERVER_MESSAGING_ENABLED: 'true', EGC_MESSAGING_SUBREQUEST_BUDGET: '9500' };
  const { EGC_CREW_NOTIFICATIONS_ENABLED, ...flagOff } = cronEnv;
  const off = await post(flagOff);
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual([off.body.summary.crewOutbox, f.ghl.sends().length, f.notice(id).status], ['not_configured', 0, 'pending']);
  const on = await post(cronEnv);
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual([on.body.summary.crewOutbox, on.body.summary.byKind.crew_assignment, f.ghl.sends().length, f.notice(id).status], ['configured', { due: 1, sent: 1 }, 1, 'sent']);
  assert.ok(f.ghl.sends()[0].body.message.includes(CREW_HUB_LINK), 'the cron wires the crew link provider');
  assert.equal((await post(cronEnv)).body.summary.sent, 0, 'the next tick sends nothing more');
  assert.deepEqual([f.ghl.sends().length, f.upserts().length], [1, 0]);
});

// The dispatcher's and the employee's views over the same notices, on the injected clock.
const MANAGER = { user: 'zacb', role: 'owner', businessAccess: true }, CREW1 = { user: 'crew1', role: 'crew', businessAccess: false };
const feedOf = f => createCrewNotificationFeed({ store: Object.assign(f.store, { query: f.storage.query,
  attention: async (today, limit) => (await f.storage.query([])).filter(row => typeof row.attentionUntil === 'string' && row.attentionUntil >= today).slice(0, limit) }), env: {}, now: () => f.time() });
const crew1Of = (f, ids) => ids.find(id => f.notice(id).employeeId === 'crew1');

test('a removal that needed a contact is in the next text for that job, and Send again never repeats it', async () => {
  const f = await setup({ jobs: { 'job-1': split(['crew1']) }, linked: {} }), feed = feedOf(f);
  const removal = crew1Of(f, await f.queue(split(['crew1']), split(['crew2']), { at: '2026-09-22T17:00:00.000Z' }));
  await f.run();
  assert.deepEqual([f.notice(removal).intent, f.notice(removal).status], ['unassigned', 'needs_contact']);
  f.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
  const move = crew1Of(f, await f.queue(split(['crew2']), split(['crew2'], '10:00'), { at: '2026-09-22T17:10:00.000Z' }));
  await f.run();
  assert.deepEqual(textsTo(f, 'staff-1').map(text => CHANGED.test(text)), [true], 'the new Wednesday time and the Thursday nobody had told them about, in one text');
  assert.deepEqual([f.notice(move).status, f.notice(move).heardSlots.map(row => row.segmentId)], ['sent', ['a', 'b']]);
  // The employee's cards say what the text said; the removal it carried reads as covered.
  const own = Object.fromEntries((await feed.list(CREW1)).notices.map(row => [row.id, row]));
  assert.deepEqual([own[move].delivery, own[move].lostSlots.map(row => row.date), own[move].heardSlots.map(row => row.segmentId)], ['texted', [DAY], ['a', 'b']]);
  assert.equal(own[removal].delivery, 'covered');
  const listed = (await feed.team(MANAGER)).attention.find(row => row.id === removal);
  assert.deepEqual([listed.covered, listed.canRetry], [true, true], 'the list says a later text told them; Send again only closes it');
  const result = await feed.retry(MANAGER, { action: 'retry', requestId: uuid(), ids: [removal] });
  assert.deepEqual([result.retried, result.superseded], [[], [removal]]);
  assert.deepEqual([f.notice(removal).status, f.notice(removal).attentionUntil], ['superseded', '']);
  await f.run();
  assert.equal(textsTo(f, 'staff-1').length, 1, 'nothing they were told is repeated');
});

test('an assignment that needed a contact is still texted after later changes that cancel out', async () => {
  const f = await setup({ linked: {} }), feed = feedOf(f);
  const [assigned] = await f.queue(null, work(), { at: '2026-09-22T17:00:00.000Z' });
  await f.run();
  assert.equal(f.notice(assigned).status, 'needs_contact');
  f.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
  const other = work({ assignedCrew: ['crew2'], crewLead: 'crew2' });
  const removed = crew1Of(f, await f.queue(work(), other, { at: '2026-09-22T17:10:00.000Z' })), back = crew1Of(f, await f.queue(other, work(), { at: '2026-09-22T17:12:00.000Z' }));
  await f.run();
  assert.equal(textsTo(f, 'staff-1').length, 1);
  assert.match(textsTo(f, 'staff-1')[0], /^Hi Casey, you are scheduled for an Easy Garage Cleaning job on Thursday, September 24 \(arrival window 9:00 AM/, 'they were never told about the job, so it is not "unchanged" for them');
  assert.deepEqual([f.notice(removed).status, f.notice(back).status], ['superseded', 'sent']);
  const result = await feed.retry(MANAGER, { action: 'retry', requestId: uuid(), ids: [assigned] });
  assert.deepEqual([result.retried, result.superseded], [[], [assigned]]);
  await f.run();
  assert.equal(textsTo(f, 'staff-1').length, 1);
});

test('a removal HighLevel refused until the ledger gave up is in the next text for that job', async () => {
  const f = await setup({ jobs: { 'job-1': split(['crew1']) } });
  await f.queue(null, split(['crew1']), { at: '2026-09-22T16:00:00.000Z' });
  await f.run();
  assert.equal(textsTo(f, 'staff-1').length, 1);
  f.ghl.state.sendStatus = 400;
  const removal = crew1Of(f, await f.queue(split(['crew1']), split(['crew2']), { at: '2026-09-22T17:00:00.000Z' }));
  for (let tick = 0; tick < 8 && f.notice(removal).status === 'pending'; tick += 1) { await f.run(); if (f.notice(removal).nextAttemptAt) f.time.set(f.notice(removal).nextAttemptAt); }
  assert.deepEqual([f.notice(removal).status, f.notice(removal).lastStatus], ['failed', 'attempts_exhausted']);
  f.ghl.state.sendStatus = 200;
  await f.queue(split(['crew2']), split(['crew2'], '10:00'), { at: f.time().toISOString() });
  await f.run();
  assert.match(textsTo(f, 'staff-1').at(-1), CHANGED, 'the next text for the job still says Thursday is off');
});

test('Send again on an older unsent notice sends one text from the newest, naming every change', async () => {
  const f = await setup({ jobs: { 'job-1': split(['crew1']) }, linked: {} }), feed = feedOf(f);
  const removal = crew1Of(f, await f.queue(split(['crew1']), split(['crew2']), { at: '2026-09-22T17:00:00.000Z' }));
  await f.run();
  const move = crew1Of(f, await f.queue(split(['crew2']), split(['crew2'], '10:00'), { at: '2026-09-22T17:10:00.000Z' }));
  await f.run();
  assert.deepEqual([f.notice(removal).status, f.notice(move).status, f.notice(move).heardSlots.map(row => row.segmentId)], ['needs_contact', 'needs_contact', ['a', 'b']]);
  const listed = Object.fromEntries((await feed.team(MANAGER)).attention.map(row => [row.id, row]));
  assert.deepEqual([listed[removal].canRetry, listed[move].canRetry], [false, true]);
  assert.deepEqual([listed[move].lostSlots.map(row => row.date), listed[move].heardSlots.map(row => row.segmentId)], [[DAY], ['a', 'b']], 'the newest one shows the lost Thursday it will carry');
  f.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
  const result = await feed.retry(MANAGER, { action: 'retry', requestId: uuid(), ids: [removal] });
  assert.deepEqual([result.retried, result.superseded, result.regrouped], [[removal], [], [move]]);
  assert.deepEqual([f.notice(removal).status, f.notice(move).status], ['superseded', 'pending']);
  await f.run();
  assert.deepEqual(textsTo(f, 'staff-1').map(text => CHANGED.test(text)), [true]);
});

const visitOn = (date, { time = '09:00', crew = ['crew1'] } = {}) => work({ date, endDate: date, time, assignedCrew: crew, crewLead: crew[0], sourceTemplateJobId: 'template-1' });
const RUN = 'recurring:plan-1:run-1', VISITS = [['job-1', DAY], ['job-2', '2026-10-01'], ['job-3', '2026-10-08']];
const queueRun = async (f, crew = ['crew1']) => { const ids = []; for (const [jobId, date] of VISITS) ids.push(...await f.queue(null, visitOn(date, { crew }), { jobId, batch: RUN })); return ids; };
const runJobs = (crew = ['crew1']) => Object.fromEntries(VISITS.map(([jobId, date]) => [jobId, visitOn(date, { crew })]));

test('a grouped recurring-run text that fails once is sent again naming its visits, which close only with it', async () => {
  const f = await setup({ jobs: runJobs(), ghl: { sendStatus: count => count === 1 ? 400 : 200 } }), ids = await queueRun(f);
  await f.run();
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).attempts]), [['pending', 1], ['pending', 0], ['pending', 0]], 'the other visits wait with the text');
  f.time.set(f.notice(ids[0]).nextAttemptAt);
  await f.run();
  assert.equal(textsTo(f, 'staff-1').length, 2);
  assert.match(textsTo(f, 'staff-1').at(-1), /on Thursday, September 24, plus 2 more visits through Thursday, October 8 \(arrival window 9:00 AM/);
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).batchedInto]), [['sent', ''], ['batched', ids[0]], ['batched', ids[0]]]);
  assert.deepEqual((await feedOf(f).list(CREW1)).notices.map(row => row.delivery).sort(), ['grouped', 'grouped', 'texted']);
  await f.run();
  assert.equal(textsTo(f, 'staff-1').length, 2);
});

test('a grouped text past the tick limit or the budget keeps its visits queued and names them next tick', async () => {
  const f = await setup({ jobs: runJobs(['crew1', 'crew2']) }), ids = await queueRun(f, ['crew1', 'crew2']);
  f.store.set('messaging_settings/automation', { maxSendsPerTick: 1 });
  const first = await f.run();
  assert.deepEqual([first.limitReached, f.ghl.sends().length], [true, 1]);
  const waiting = ids.filter(id => f.notice(id).employeeId !== (f.ghl.sends()[0].body.contactId === 'staff-1' ? 'crew1' : 'crew2'));
  assert.deepEqual(waiting.map(id => [f.notice(id).status, f.notice(id).attempts]), [['pending', 0], ['pending', 0], ['pending', 0]], 'the text past the limit and its visits are untouched');
  await f.run();
  for (const contact of ['staff-1', 'staff-2']) assert.deepEqual(textsTo(f, contact).map(text => /on Thursday, September 24, plus 2 more visits through Thursday, October 8 /.test(text)), [true], contact);
  assert.deepEqual(ids.map(id => f.notice(id).status).sort(), ['batched', 'batched', 'batched', 'batched', 'sent', 'sent']);
  const g = await setup({ jobs: runJobs() }), others = await queueRun(g);
  const starved = await g.run({ budget: () => 0 });
  assert.deepEqual([starved.budgetExhausted, g.ghl.sends().length, others.map(id => g.notice(id).status)], [true, 0, ['pending', 'pending', 'pending']]);
  await g.run();
  assert.match(textsTo(g, 'staff-1')[0], /plus 2 more visits through Thursday, October 8/);
});

test('when the lead visit of a grouped text changes before it goes out, the other visits are grouped again', async () => {
  for (const change of ['retimed', 'removed']) {
    const f = await setup({ jobs: runJobs(), ghl: { sendStatus: count => count === 1 ? 400 : 200 } }), ids = await queueRun(f);
    await f.run();
    await f.queue(visitOn(DAY), change === 'retimed' ? visitOn(DAY, { time: '10:00' }) : visitOn(DAY, { crew: ['crew2'] }), { jobId: 'job-1', at: '2026-09-22T18:05:00.000Z' });
    f.time.set('2026-09-22T19:00:00.000Z');
    await f.run(); await f.run();
    const texts = textsTo(f, 'staff-1').slice(1).sort();
    const grouped = /^Hi Casey, you are scheduled for an Easy Garage Cleaning job on Thursday, October 1, plus 1 more visit through Thursday, October 8 \(/;
    if (change === 'retimed') assert.deepEqual(texts.map(text => [grouped.test(text), /on Thursday, September 24 \(arrival window 10:00 AM/.test(text)]), [[true, false], [false, true]], change);
    else assert.deepEqual(texts.map(text => grouped.test(text)), [true], change);
    assert.deepEqual([f.notice(ids[1]).status, f.notice(ids[2]).status, f.notice(ids[2]).batchedInto], ['sent', 'batched', ids[1]], change);
    assert.ok(ids.every(id => f.notice(id).batchedInto !== ids[0]), `${change}: nothing is left grouped into a text that never went out`);
  }
});

test('visits held with a grouped text that could not go out reach the dispatcher list once it leaves', async () => {
  const f = await setup({ jobs: runJobs(), linked: {} }), feed = feedOf(f), ids = await queueRun(f);
  await f.run();
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).attentionUntil]), [['needs_contact', DAY], ['batched', '2026-10-01'], ['batched', '2026-10-08']]);
  assert.deepEqual((await feed.team(MANAGER)).attention.map(row => row.id), [ids[0]], 'listed under the grouped text, which Send again regroups');
  f.time.set('2026-09-25T18:00:00.000Z');
  const later = (await feed.team(MANAGER)).attention;
  assert.deepEqual(later.map(row => [row.id, row.status, row.reason, row.canRetry]).sort(), [[ids[1], 'needs_contact', 'staff_contact_not_linked', true], [ids[2], 'needs_contact', 'staff_contact_not_linked', true]].sort());
  f.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
  const result = await feed.retry(MANAGER, { action: 'retry', requestId: uuid(), ids: [ids[1], ids[2]] });
  assert.deepEqual([result.retried, result.superseded], [[ids[1], ids[2]], []]);
  await f.run();
  assert.deepEqual(textsTo(f, 'staff-1').map(text => /on Thursday, October 1, plus 1 more visit through Thursday, October 8 /.test(text)), [true]);
});

test('a three-for-three segment swap fits one text, even for a 40-character first name', async () => {
  const days = { a: WED, b: '2026-09-25', c: '2026-09-27', d: '2026-09-28', e: '2026-09-29', g: '2026-10-02' };
  const segments = mine => work({ date: WED, endDate: '2026-10-02', time: '09:00', endTime: '12:00', assignedCrew: ['crew1', 'crew2'], crewLead: 'crew2', assignmentSegments:
    Object.entries(days).map(([id, date]) => ({ id, date, time: '09:00', endTime: '12:00', assignedCrew: mine.includes(id) ? ['crew1'] : ['crew2'] })) });
  const before = segments(['a', 'b', 'c']), after = segments(['d', 'e', 'g']), long = 'Maximilianalexanderjonathanchristopherxy';
  for (const name of ['Casey', long]) {
    const f = await setup({ jobs: { 'job-1': before }, accounts: { ...ACCOUNTS, crew1: { ...ACCOUNTS.crew1, displayName: `${name} Crew` } } });
    const id = crew1Of(f, await f.queue(before, after));
    await f.run();
    const [text] = textsTo(f, 'staff-1');
    assert.equal(f.notice(id).status, 'sent', name);
    assert.ok([...text].length <= 320, `${[...text].length} characters for ${name}`);
    assert.match(text, new RegExp(`^Hi ${name}, your Easy Garage Cleaning schedule changed\\. Now: .*Sep(?:tember)? 28.*Oct(?:ober)? 2 \\(arrival window 9:00 AM\\)\\. No longer: .*Sep(?:tember)? 23.*Sep(?:tember)? 25.*Sep(?:tember)? 27\\. Details`), name);
    assert.equal(textsTo(f, 'staff-2').length, 1, 'the crew member swapped the other way is texted too');
  }
});

test('while the roster cannot be read, a notice for a crew stored by display name waits instead of closing', async () => {
  const legacy = extra => work({ assignedCrew: undefined, assignedTo: 'Casey Crew', crewLead: null, ...extra });
  const cases = [['moved', legacy(), legacy({ time: '10:00' }), /^Hi Casey, you are scheduled for an Easy Garage Cleaning job on Thursday, September 24 \(arrival window 10:00 AM/],
    ['a day taken away', legacy({ date: WED, endDate: '2026-09-25', endTime: '17:00' }), legacy({ date: WED, endDate: DAY, endTime: '17:00' }), /^Hi Casey, you are no longer scheduled for the Easy Garage Cleaning job on Friday, September 25\./]];
  for (const [label, before, after, expected] of cases) {
    const f = await setup({ jobs: { 'job-1': before } }), [id] = await f.queue(before, after), roster = f.store.roster;
    f.store.roster = async () => { throw Object.assign(new Error('Synthetic roster outage'), { code: 'messaging_roster_unavailable', status: 503 }); };
    await f.run();
    const row = f.notice(id);
    assert.deepEqual([row.status, row.attempts, row.lastReason, row.attentionUntil, f.ghl.sends().length], ['pending', 0, 'roster_unavailable', '', 0], label);
    f.store.roster = roster; f.time.advance(5 * 60000);
    await f.run();
    assert.deepEqual([f.notice(id).status, textsTo(f, 'staff-1').length], ['sent', 1], label);
    assert.match(textsTo(f, 'staff-1')[0], expected, label);
  }
});

test('what each employee last heard is kept per job with the closes, and a lost close is repaired from its ledger', async () => {
  const f = await setup({ linked: {} }), [assigned] = await f.queue(null, work(), { at: '2026-09-22T17:00:00.000Z' }), heardId = await crewHeardId('job-1', 'crew1');
  await f.run();
  const unheard = f.store.get(`${CREW_NOTICE_HEARD}/${heardId}`);
  assert.deepEqual([f.notice(assigned).status, unheard.slots, unheard.heardRank, unheard.heardNoticeId], ['needs_contact', [], null, ''], 'closed without a text: they still know nothing about the job');
  assert.ok(f.store.commits.some(writes => writes.some(write => write.id === assigned) && writes.some(write => write.id === heardId)), 'the record is written in the same commit as the close');
  f.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
  const [moved] = await f.queue(work(), work({ time: '10:00' }), { at: '2026-09-22T17:10:00.000Z' });
  await f.run();
  const heard = f.store.get(`${CREW_NOTICE_HEARD}/${heardId}`);
  assert.deepEqual([f.notice(moved).status, heard.heardNoticeId, heard.slots.map(row => row.time)], ['sent', moved, ['10:00']]);
  assert.match(textsTo(f, 'staff-1')[0], /^Hi Casey, you are scheduled for an Easy Garage Cleaning job on Thursday, September 24 \(arrival window 10:00 AM/);
  // A text went out and the record names it, but the notice's own close was lost.
  const g = await setup(), [first] = await g.queue(null, work()), row = g.notice(first);
  g.store.set(`message_sends/${await ledgerId(noticeSendKey({ ...row, id: first }))}`, { kind: 'crew_assignment', status: 'submitted', attempts: 1 });
  g.store.set(`${CREW_NOTICE_HEARD}/${heardId}`, { jobId: 'job-1', employeeId: 'crew1', slots: row.slots, heardNoticeId: first, heardRank: { id: first, baseRevision: row.baseRevision, createdAt: row.createdAt, dispatchRequestId: row.dispatchRequestId } });
  await g.run();
  assert.deepEqual([g.notice(first).status, g.notice(first).lastStatus, g.ghl.sends().length], ['sent', 'submitted', 0]);
});

// Owner wording with extra sentences leaves less room for the dates. Every
// change is still named or counted, or the notice fails where a dispatcher
// sees it: a date is never dropped or cut short.
const EXTRA = ' Please reply to your dispatcher right away if this change does not work for you. Gate codes, parking and access notes for each job are in the Hub.';
const reword = async (f, kind, body) => {
  const state = await readTemplate(f.store, kind);
  await mutateTemplate(f.store, owner, { action: 'save_draft', requestId: uuid(), kind, expectedVersion: state.latestVersion, channel: 'SMS', body }, NOW);
  const next = await readTemplate(f.store, kind), version = next.versions.at(-1);
  await mutateTemplate(f.store, owner, { action: 'approve', requestId: uuid(), kind, expectedVersion: next.latestVersion, version: version.version, hash: version.hash }, NOW);
};
const SHORT_DAY = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? ((?:Sep|Oct)[a-z]* \d{1,2})\b/g;
// The dates a part of a text names, how many more it counts, and anything else left in it.
function accounted(part) {
  const named = [...part.matchAll(SHORT_DAY)].map(match => match[1].replace(/^(\w{3})\w* /, '$1 '));
  const counted = Number(/(\d+) more dates?$/.exec(part)?.[1] || /^(\d+) dates$/.exec(part)?.[1] || 0);
  return { named, counted, rest: part.replace(SHORT_DAY, '').replace(/\d+ more dates?$|^\d+ dates$/, '').replace(/,|\band\b|\bplus\b|\s+/g, '') };
}
const swapDays = { a: WED, b: '2026-09-25', c: '2026-09-27', d: '2026-09-28', e: '2026-09-29', g: '2026-10-02' };
const swap = mine => work({ date: WED, endDate: '2026-10-02', time: '09:00', endTime: '12:00', assignedCrew: ['crew1', 'crew2'], crewLead: 'crew2', assignmentSegments:
  Object.entries(swapDays).map(([id, date]) => ({ id, date, time: '09:00', endTime: '12:00', assignedCrew: mine.includes(id) ? ['crew1'] : ['crew2'] })) });

test('a schedule-change text with longer owner wording names or counts every day, or fails for the dispatcher', async () => {
  const wording = 'Hi {{firstName}}, your Easy Garage Cleaning schedule changed. Now: {{serviceDate}} (arrival window {{arrivalWindow}}). No longer: {{removedDates}}. Details are in the Employee Hub: {{loginLink}}';
  for (const extra of [72, 102]) {
    const f = await setup({ jobs: { 'job-1': swap(['a', 'b', 'c']) } });
    await reword(f, 'crew_schedule_change', wording + EXTRA.slice(0, extra));
    const id = crew1Of(f, await f.queue(swap(['a', 'b', 'c']), swap(['d', 'e', 'g'])));
    await f.run();
    const row = f.notice(id), texts = textsTo(f, 'staff-1');
    if (extra === 72) {
      assert.deepEqual([row.status, texts.length], ['sent', 1], `+${extra}`);
      assert.ok([...texts[0]].length <= 320);
      const [, now, gone] = /Now: (.*) \(arrival window 9:00 AM\)\. No longer: (.*?)\. Details/.exec(texts[0]);
      for (const [part, days] of [[now, ['Sep 28', 'Sep 29', 'Oct 2']], [gone, ['Sep 23', 'Sep 25', 'Sep 27']]]) {
        const { named, counted, rest } = accounted(part);
        assert.equal(rest, '', `"${part}" holds only whole dates and counts`);
        assert.ok(named.every(day => days.includes(day)) && new Set(named).size === named.length, part);
        assert.equal(named.length + counted, 3, `"${part}" names or counts all three days`);
      }
    } else {
      // The wording leaves no room for any lossless pair: nothing is sent, and
      // the notice is on the dispatcher's list at once, ready to send again,
      // until the last day its change reaches (Friday, October 2).
      assert.deepEqual([row.status, row.lastReason, row.attentionUntil, texts.length], ['failed', 'messaging_sms_too_long', '2026-10-02', 0], `+${extra}`);
      const listed = (await feedOf(f).team(MANAGER)).attention.find(other => other.id === id);
      assert.deepEqual([listed.status, listed.reason, listed.canRetry], ['failed', 'messaging_sms_too_long', true]);
      // Monday 1 PM: its first new day is over, and the rest of the change is
      // still ahead, so it stays listed and Send again texts what is left.
      f.time.set('2026-09-28T19:00:00.000Z');
      const later = (await feedOf(f).team(MANAGER)).attention.find(other => other.id === id);
      assert.deepEqual([later?.status, later?.canRetry], ['failed', true], 'still listed once its first day passed');
      assert.deepEqual((await feedOf(f).retry(MANAGER, { action: 'retry', requestId: uuid(), ids: [id] })).retried, [id]);
      await f.run();
      const [text, ...more] = textsTo(f, 'staff-1');
      assert.deepEqual([f.notice(id).status, more.length], ['sent', 0]);
      assert.match(text, /Tuesday, September 29/);
      assert.doesNotMatch(text, /September 2[3578]\b/, 'work that is over is not in the text');
    }
  }
});

test('a removal text with longer owner wording counts the days it cannot name, or fails for the dispatcher', async () => {
  const three = mine => work({ date: WED, endDate: '2026-09-27', time: '09:00', endTime: '12:00', assignedCrew: ['crew1', 'crew2'], crewLead: 'crew2', assignmentSegments:
    [['a', WED], ['b', '2026-09-25'], ['c', '2026-09-27']].map(([id, date]) => ({ id, date, time: '09:00', endTime: '12:00', assignedCrew: mine.includes(id) ? ['crew1'] : ['crew2'] })) });
  const wording = 'Hi {{firstName}}, you are no longer scheduled for the Easy Garage Cleaning job on {{serviceDate}}. Your current schedule is in the Employee Hub: {{loginLink}}';
  for (const [extra, expected] of [[100, 'Wed Sep 23, Fri Sep 25 and Sun Sep 27'], [108, 'Wed Sep 23 and 2 more dates'], [116, '3 dates'], [132, null]]) {
    const f = await setup({ jobs: { 'job-1': three(['a', 'b', 'c']) } });
    await reword(f, 'crew_unassignment', wording + (EXTRA + EXTRA).slice(0, extra));
    const id = crew1Of(f, await f.queue(three(['a', 'b', 'c']), three([])));
    await f.run();
    const texts = textsTo(f, 'staff-1');
    if (expected) {
      assert.deepEqual([f.notice(id).status, /job on (.*?)\. Your current/.exec(texts[0])?.[1]], ['sent', expected], `+${extra}`);
      assert.ok([...texts[0]].length <= 320);
    } else assert.deepEqual([f.notice(id).status, f.notice(id).lastReason, texts.length], ['failed', 'messaging_sms_too_long', 0], `+${extra}`);
  }
});

// Grouped recurring-run texts: the other visits close in the lead's own commit.
const groupedText = /on Thursday, September 24, plus 2 more visits through Thursday, October 8 /;

test('a grouped text whose close response is lost closes its visits with it and is never sent again', async () => {
  const f = await setup({ jobs: runJobs() }), ids = await queueRun(f);
  f.store.hooks.loseResponse.add(CREW_NOTICE_HEARD);
  await f.run();
  f.store.hooks.loseResponse.clear();
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).batchedInto || '']), [['sent', ''], ['batched', ids[0]], ['batched', ids[0]]]);
  const closing = f.store.commits.find(writes => writes.some(write => write.id === ids[0] && write.patch.status === 'sent'));
  assert.deepEqual(ids.slice(1).map(id => closing.some(write => write.id === id && write.patch.status === 'batched')), [true, true], 'the visits close in the same commit as the text');
  f.time.advance(10 * 60000);
  await f.run();
  assert.deepEqual(textsTo(f, 'staff-1').map(text => groupedText.test(text)), [true]);
});

test('a grouped text whose close cannot be saved is repaired from its ledger on the next tick, never texted again', async () => {
  const f = await setup({ jobs: runJobs() }), ids = await queueRun(f);
  const commit = f.store.commit.bind(f.store);
  let outage = true;
  f.store.commit = async writes => { if (outage && writes.some(write => write.patch?.status === 'batched')) throw Object.assign(new Error('Synthetic outage'), { code: 'messaging_storage_unavailable', status: 503 }); return commit(writes); };
  await f.run();
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).batchLead || '']), [['pending', ''], ['pending', ids[0]], ['pending', ids[0]]], 'the visits were stamped with the text before it went out');
  outage = false;
  f.time.advance(10 * 60000);
  await f.run();
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).lastStatus]), [['sent', 'already_sent'], ['batched', 'batched'], ['batched', 'batched']]);
  assert.deepEqual(textsTo(f, 'staff-1').map(text => groupedText.test(text)), [true]);
  const heard = await Promise.all(VISITS.map(async ([jobId]) => f.store.get(`${CREW_NOTICE_HEARD}/${await crewHeardId(jobId, 'crew1')}`)));
  assert.deepEqual(heard.map(record => [record.heardVia, record.slots.map(slot => slot.date)]), VISITS.map(([, date]) => ['text', [date]]), 'each visit\'s job records what the text told them');
});

test('another tick at any point of a grouped send never texts its visits a second time', async () => {
  for (let k = 1; k <= 8; k += 1) {
    const f = await setup({ jobs: runJobs() }), ids = await queueRun(f), commit = f.store.commit.bind(f.store);
    let count = 0, fired = false;
    f.store.commit = async writes => { const result = await commit(writes); count += 1; if (!fired && count === k) { fired = true; await f.run(); } return result; };
    await f.run();
    f.store.commit = commit;
    f.time.advance(10 * 60000);
    await f.run(); await f.run();
    assert.deepEqual(textsTo(f, 'staff-1').map(text => groupedText.test(text)), [true], `second tick after commit ${k}`);
    assert.deepEqual(ids.map(id => f.notice(id).status), ['sent', 'batched', 'batched'], `commit ${k}`);
  }
});

test('stamped visits wait while their grouped text is being sent and close with it once it went out', async () => {
  // A real claim: its ledger entry records the visits the text names.
  const sendKey = async (g, id) => `message_sends/${await ledgerId(noticeSendKey({ ...g.notice(id), id }))}`;
  const f = await setup({ jobs: runJobs() }), ids = await queueRun(f);
  await stuckClaim(f);
  const ledger = await sendKey(f, ids[0]);
  assert.deepEqual([f.store.get(ledger).status, f.store.get(ledger).noticeBatch, ids.slice(1).map(id => f.notice(id).batchLead)], ['sending', ids.slice(1), [ids[0], ids[0]]]);
  await f.run();
  assert.deepEqual([ids.slice(1).map(id => [f.notice(id).status, f.notice(id).attempts]), f.ghl.sends().length], [[['pending', 0], ['pending', 0]], 0], 'never grouped again or texted on their own while the text is in flight');
  f.store.edit(ledger, { status: 'submitted' });
  f.time.advance(10 * 60000);
  await f.run();
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).batchedInto || '']), [['sent', ''], ['batched', ids[0]], ['batched', ids[0]]]);
  assert.equal(f.ghl.sends().length, 0, 'the text that went out is the only one');
  // The text's own row closed (sent, or not confirmed) but its visits' close never landed.
  for (const status of ['sent', 'uncertain']) {
    const g = await setup({ jobs: runJobs() }), others = await queueRun(g);
    await stuckClaim(g);
    g.store.edit(await sendKey(g, others[0]), { status: status === 'sent' ? 'submitted' : 'uncertain' });
    g.store.edit(`${CREW_NOTIFICATIONS}/${others[0]}`, { status, lastStatus: status === 'sent' ? 'submitted' : 'uncertain' });
    await g.run();
    assert.deepEqual([others.slice(1).map(id => [g.notice(id).status, g.notice(id).lastStatus, g.notice(id).batchedInto]), g.ghl.sends().length],
      [[['batched', status === 'sent' ? 'batched' : 'uncertain', others[0]], ['batched', status === 'sent' ? 'batched' : 'uncertain', others[0]]], 0], status);
  }
  // An entry that records no visits names none: a stamp alone never closes a
  // visit into a text, so these are grouped again and texted.
  const h = await setup({ jobs: runJobs() }), stamped = await queueRun(h);
  for (const id of stamped.slice(1)) h.store.edit(`${CREW_NOTIFICATIONS}/${id}`, { batchLead: stamped[0] });
  h.store.set(await sendKey(h, stamped[0]), { kind: 'crew_assignment', status: 'submitted', attempts: 1 });
  h.store.edit(`${CREW_NOTIFICATIONS}/${stamped[0]}`, { status: 'sent', lastStatus: 'submitted' });
  await h.run();
  assert.deepEqual(textsTo(h, 'staff-1').map(text => /on Thursday, October 1, plus 1 more visit through Thursday, October 8 /.test(text)), [true]);
  assert.deepEqual(stamped.slice(1).map(id => [h.notice(id).status, h.notice(id).batchedInto || '']), [['sent', ''], ['batched', stamped[1]]]);
});

test('Send again on a held grouped text whose own visit changed closes it and queues its other visits', async () => {
  for (const change of ['removed', 'undone']) {
    const f = await setup({ jobs: runJobs(), linked: {} }), feed = feedOf(f), ids = await queueRun(f);
    await f.run();
    assert.deepEqual(ids.map(id => f.notice(id).status), ['needs_contact', 'batched', 'batched']);
    f.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
    if (change === 'removed') await f.queue(visitOn(DAY), visitOn(DAY, { crew: ['crew2'] }), { jobId: 'job-1', at: '2026-09-22T18:10:00.000Z' });
    else { await f.queue(visitOn(DAY), visitOn(DAY, { crew: ['crew2'] }), { jobId: 'job-1', at: '2026-09-22T18:10:00.000Z' }); await f.queue(visitOn(DAY, { crew: ['crew2'] }), visitOn(DAY), { jobId: 'job-1', at: '2026-09-22T18:12:00.000Z' }); }
    f.time.set('2026-09-22T19:00:00.000Z');
    await f.run();
    const result = await feed.retry(MANAGER, { action: 'retry', requestId: uuid(), ids: [ids[0]] });
    // Removed: nothing is left to tell about that visit. Undone: the visit was
    // put back and its own text already went out after the contact was linked.
    assert.deepEqual([result.retried, result.superseded, result.regrouped.sort()], [[], [ids[0]], [ids[1], ids[2]].sort()], change);
    await f.run();
    const texts = textsTo(f, 'staff-1'), others = /^Hi Casey, you are scheduled for an Easy Garage Cleaning job on Thursday, October 1, plus 1 more visit through Thursday, October 8 \(/;
    if (change === 'removed') assert.deepEqual(texts.map(text => others.test(text)), [true], change);
    else assert.deepEqual(texts.map(text => [/job on Thursday, September 24 \(/.test(text), others.test(text)]), [[true, false], [false, true]], change);
    assert.deepEqual((await feed.team(MANAGER)).attention.filter(row => ids.includes(row.id)).map(row => row.id), [], `${change}: nothing is left held`);
  }
});

test('the other visits of an unconfirmed grouped text read as unconfirmed and are never sent again', async () => {
  const f = await setup({ jobs: runJobs(), ghl: { sendStatus: 503 } }), feed = feedOf(f), ids = await queueRun(f);
  await f.run();
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).lastStatus]), [['uncertain', 'uncertain'], ['batched', 'uncertain'], ['batched', 'uncertain']]);
  assert.deepEqual((await feed.list(CREW1)).notices.map(row => row.delivery), ['unconfirmed', 'unconfirmed', 'unconfirmed']);
  assert.deepEqual((await feed.team(MANAGER)).attention.map(row => [row.id, row.status, row.canRetry]), [[ids[0], 'uncertain', false]], 'listed under the text itself');
  f.time.set('2026-09-25T18:00:00.000Z');
  const later = (await feed.team(MANAGER)).attention;
  assert.deepEqual(later.map(row => [row.id, row.status, row.covered, row.canRetry]).sort(), [[ids[1], 'uncertain', false, false], [ids[2], 'uncertain', false, false]].sort(), 'once the text leaves the list its visits show, unconfirmed');
  await assert.rejects(feed.retry(MANAGER, { action: 'retry', requestId: uuid(), ids: [ids[1]] }), error => error.code === 'crew_notifications_not_retryable');
  f.ghl.state.sendStatus = 200;
  await f.run();
  assert.equal(f.ghl.sends().length, 1);
});

test('a change the employee read in the Hub covers older ones as read, not as texted', async () => {
  const f = await setup({ jobs: { 'job-1': split(['crew1']) }, linked: {} }), feed = feedOf(f);
  const removal = crew1Of(f, await f.queue(split(['crew1']), split(['crew2']), { at: '2026-09-22T17:00:00.000Z' }));
  await f.run();
  assert.equal(f.notice(removal).status, 'needs_contact');
  const move = crew1Of(f, await f.queue(split(['crew2']), split(['crew2'], '10:00'), { at: '2026-09-22T17:10:00.000Z' }));
  await feed.acknowledge(CREW1, { action: 'acknowledge', requestId: uuid(), ids: [move] });
  await f.run();
  const heard = f.store.get(`${CREW_NOTICE_HEARD}/${await crewHeardId('job-1', 'crew1')}`);
  assert.deepEqual([f.notice(move).status, heard.heardNoticeId, heard.heardVia, f.ghl.sends().length], ['skipped', move, 'hub', 0]);
  assert.equal((await feed.list(CREW1)).notices.find(row => row.id === removal).delivery, 'read_in_hub');
  const listed = (await feed.team(MANAGER)).attention.find(row => row.id === removal);
  assert.deepEqual([listed.covered, listed.coveredVia], [true, 'hub']);
});

test('notices from before heard records were kept: the next text starts from what the employee was last texted', async () => {
  const f = await setup({ jobs: { 'job-1': split(['crew1']) } }), feed = feedOf(f);
  const forget = () => { for (const key of [...f.store.rows.keys()]) if (key.startsWith(`${CREW_NOTICE_HEARD}/`)) f.store.rows.delete(key); };
  await f.queue(null, split(['crew1']), { at: '2026-09-22T16:00:00.000Z' });
  await f.run();
  forget();
  f.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: '' });
  const removal = crew1Of(f, await f.queue(split(['crew1']), split(['crew2']), { at: '2026-09-22T17:00:00.000Z' }));
  await f.run();
  forget();
  assert.equal(f.notice(removal).status, 'needs_contact');
  f.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
  const before = f.queries.length;
  await f.queue(split(['crew2']), split(['crew2'], '10:00'), { at: '2026-09-22T17:10:00.000Z' });
  await f.run();
  assert.match(textsTo(f, 'staff-1').at(-1), CHANGED, 'the Thursday removal that was never texted is in the text');
  assert.ok(f.queries.slice(before).some(query => query.filters.some(([field]) => field === 'jobId')), 'the job\'s notice history was read once for the missing record');
  assert.equal((await feed.list(CREW1)).notices.find(row => row.id === removal).delivery, 'covered');
  // A record worked out from a cut-off history never vouches for older notices.
  const heardKey = `${CREW_NOTICE_HEARD}/${await crewHeardId('job-1', 'crew1')}`;
  f.store.edit(heardKey, { heardFull: false });
  assert.equal((await feed.list(CREW1)).notices.find(row => row.id === removal).delivery, 'not_texted');
  assert.equal((await feed.team(MANAGER)).attention.find(row => row.id === removal).covered, false);
});

test('a look-only tick previews a grouped text without stamping its visits', async () => {
  const f = await setup({ jobs: runJobs() }), ids = await queueRun(f), before = ids.map(f.notice), commits = f.store.commits.length;
  const preview = await f.run({ dryRun: true });
  assert.deepEqual(preview.results.map(row => [row.kind, row.status]), [['crew_assignment', 'would_send']]);
  assert.deepEqual([ids.map(f.notice), f.store.commits.length, f.ghl.sends().length], [before, commits, 0]);
  await f.run();
  assert.deepEqual(textsTo(f, 'staff-1').map(text => groupedText.test(text)), [true]);
});

// Holds the other tick's work at a chosen point: `hold()` returns the promise
// the held call awaits, `reached` resolves once it is held, `release()` lets it go.
const holdPoint = () => {
  let release, reached;
  const hit = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  return { hit, release, hold: () => { reached(); return gate; } };
};

test('a grouped text refused while an overlapping tick saw it being sent goes out again naming its visits', async () => {
  const f = await setup({ jobs: runJobs(), ghl: { sendStatus: count => count === 1 ? 422 : 200 } }), ids = await queueRun(f), query = f.storage.query;
  // Tick B starts while tick A's grouped text is at HighLevel, so B reads its
  // ledger as 'sending' and plans the text alone; B's send check runs after
  // HighLevel refused A's text.
  let point = null, tickB = null;
  f.storage.query = async (filters, ...rest) => {
    if (point && filters.some(([field]) => field === 'jobId')) { const held = point; point = null; await held.hold(); }
    return query(filters, ...rest);
  };
  const b = holdPoint();
  f.hooks.fetch = async (real, url, options) => {
    if (!tickB && new URL(url).pathname === '/conversations/messages') { point = b; tickB = f.run(); await b.hit; }
    return real(url, options);
  };
  await f.run();
  b.release(); await tickB;
  f.hooks.fetch = null; f.storage.query = query;
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).attempts]), [['pending', 1], ['pending', 0], ['pending', 0]], 'the text waits for its visits instead of going out alone');
  assert.equal(f.notice(ids[0]).lastReason, 'batch_changed');
  f.time.advance(30 * 60000);
  await f.run(); await f.run();
  assert.deepEqual(textsTo(f, 'staff-1').map(text => groupedText.test(text)), [true, true], 'refused, then sent again naming both other visits');
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).batchedInto || '']), [['sent', ''], ['batched', ids[0]], ['batched', ids[0]]]);
  assert.deepEqual(f.ledgers().find(row => row.kind === 'crew_assignment').noticeBatch, ids.slice(1), 'the send ledger records the visits its text named');
});

test('after two ticks collide on a grouped text HighLevel refused, the retry still names its visits', async () => {
  const f = await setup({ jobs: runJobs(), ghl: { sendStatus: count => count === 1 ? 422 : 200 } }), ids = await queueRun(f), commit = f.store.commit.bind(f.store);
  // Tick B finds A's claim and records 'sending' on the text's row only after
  // A recorded HighLevel's refusal. Every later tick runs on its own.
  let point = null, tickB = null;
  f.store.commit = async writes => {
    if (point && writes.some(write => write.id === ids[0] && write.patch?.lastStatus === 'sending')) { const held = point; point = null; await held.hold(); }
    return commit(writes);
  };
  const b = holdPoint();
  f.hooks.fetch = async (real, url, options) => {
    if (!tickB && new URL(url).pathname === '/conversations/messages') { point = b; tickB = f.run(); await b.hit; }
    return real(url, options);
  };
  await f.run();
  b.release(); await tickB;
  f.hooks.fetch = null; f.store.commit = commit;
  assert.deepEqual([f.notice(ids[0]).status, f.notice(ids[0]).lastStatus, f.ledgers().find(row => row.kind === 'crew_assignment').status], ['pending', 'sending', 'failed'], 'the row still says a claim was in flight; its ledger says it was refused');
  for (let tick = 0; tick < 3; tick += 1) { f.time.advance(30 * 60000); await f.run(); }
  assert.deepEqual(textsTo(f, 'staff-1').map(text => groupedText.test(text)), [true, true]);
  assert.deepEqual(ids.map(id => f.notice(id).status), ['sent', 'batched', 'batched']);
});

test('a visit stamped with a grouped text after that text was built is texted on its own, never closed into it', async () => {
  const f = await setup({ jobs: { ...runJobs(), 'job-4': visitOn('2026-10-15') } }), ids = await queueRun(f), commit = f.store.commit.bind(f.store), query = f.storage.query;
  // While tick A claims its text for three visits, the run adds a fourth and
  // tick C stamps it with the same text; C's send check runs after A's text
  // went out.
  let late = '', point = null, tickC = null;
  f.storage.query = async (filters, ...rest) => {
    if (point && filters.some(([field]) => field === 'jobId')) { const held = point; point = null; await held.hold(); }
    return query(filters, ...rest);
  };
  const c = holdPoint();
  f.store.commit = async writes => {
    if (!tickC && writes.some(write => write.collection === 'message_sends' && write.patch?.status === 'sending')) {
      [late] = await f.queue(null, visitOn('2026-10-15'), { jobId: 'job-4', batch: RUN });
      point = c; tickC = f.run(); await c.hit;
    }
    return commit(writes);
  };
  await f.run();
  assert.equal(f.notice(late).batchLead, ids[0], 'tick C stamped the new visit with the text');
  c.release(); await tickC;
  f.store.commit = commit; f.storage.query = query;
  assert.deepEqual(f.ledgers().find(row => row.kind === 'crew_assignment').noticeBatch, ids.slice(1));
  f.time.advance(10 * 60000);
  await f.run(); await f.run();
  assert.deepEqual(textsTo(f, 'staff-1').map(text => [groupedText.test(text), /on Thursday, October 15 \(/.test(text)]), [[true, false], [false, true]], 'the text named three visits; the fourth gets its own');
  assert.deepEqual([...ids, late].map(id => f.notice(id).status), ['sent', 'batched', 'batched', 'sent']);
});

// A worker that claims a grouped text and then stops for good leaves its
// ledger 'sending'; the tick itself never finishes.
async function stuckClaim(f) {
  const claimed = holdPoint();
  f.hooks.fetch = (real, url, options) => { if (new URL(url).pathname !== '/conversations/messages') return real(url, options); claimed.hold(); return new Promise(() => {}); };
  f.run();
  await claimed.hit;
  f.hooks.fetch = null;
}

test('the visits of a grouped text whose send never finished read as not confirmed once the text closes', async () => {
  const f = await setup({ jobs: runJobs() }), feed = feedOf(f), ids = await queueRun(f);
  await stuckClaim(f);
  assert.deepEqual([f.ledgers()[0].status, f.ledgers()[0].noticeBatch], ['sending', ids.slice(1)]);
  // Thursday 1 PM: the text's own visit is over, so its notice expires.
  f.time.set('2026-09-24T19:00:00.000Z');
  await f.run();
  assert.equal(f.notice(ids[0]).status, 'expired');
  await f.run();
  assert.deepEqual(ids.slice(1).map(id => [f.notice(id).status, f.notice(id).lastStatus, f.notice(id).batchedInto, f.notice(id).attentionUntil]), [['batched', 'uncertain', ids[0], '2026-10-01'], ['batched', 'uncertain', ids[0], '2026-10-08']]);
  assert.deepEqual((await feed.list(CREW1)).notices.filter(row => ids.slice(1).includes(row.id)).map(row => row.delivery), ['unconfirmed', 'unconfirmed']);
  assert.deepEqual((await feed.team(MANAGER)).attention.map(row => [row.id, row.status, row.canRetry]).sort(), [[ids[1], 'uncertain', false], [ids[2], 'uncertain', false]].sort(), 'on the dispatcher list, never sent again');
  for (let day = 0; day < 20; day += 1) { f.time.advance(24 * 3600000); await f.run(); }
  assert.deepEqual([ids.map(id => f.notice(id).status), f.ghl.sends().length], [['expired', 'batched', 'batched'], 0]);
});

test('a visit waiting on a grouped text still being sent expires once its own work is over', async () => {
  const lead = work({ date: WED, endDate: '2026-09-26', time: '09:00', endTime: '12:00', sourceTemplateJobId: 'template-1' });
  const jobs = { 'job-1': lead, 'job-2': visitOn(DAY), 'job-3': visitOn('2026-10-08') }, f = await setup({ jobs });
  const ids = [];
  for (const [jobId, job] of Object.entries(jobs)) ids.push(...await f.queue(null, job, { jobId, batch: RUN }));
  await stuckClaim(f);
  assert.deepEqual(f.ledgers()[0].noticeBatch, ids.slice(1));
  // Thursday 1 PM: Thursday's visit is over; the text's own work runs to Saturday.
  f.time.set('2026-09-24T19:00:00.000Z');
  await f.run();
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).lastStatus]), [['pending', 'sending'], ['expired', 'expired'], ['pending', '']]);
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) { f.time.advance(60 * 60000); await f.run(); }
  assert.deepEqual([f.notice(ids[0]).status, f.notice(ids[2]).status], ['uncertain', 'pending'], 'a claim that never finishes is reported as not confirmed');
  await f.run();
  assert.deepEqual([f.notice(ids[2]).status, f.notice(ids[2]).lastStatus, f.ghl.sends().length], ['batched', 'uncertain', 0]);
});

test('a visit waiting on a grouped text keeps waiting while a later day of its change is ahead', async () => {
  // Thursday 1 PM: the first day of each change below is over and the next
  // Thursday is still ahead, while the grouped text's claim never finishes.
  const lead = work({ date: WED, endDate: '2026-09-26', time: '09:00', endTime: '12:00', sourceTemplateJobId: 'template-1' });
  const segments = (first = '12:00') => [{ id: 'a', date: DAY, time: '09:00', endTime: first, assignedCrew: ['crew1'] }, { id: 'b', date: '2026-10-01', time: '09:00', endTime: '12:00', assignedCrew: ['crew1'] }];
  const twoDays = first => work({ date: DAY, endDate: '2026-10-01', time: '09:00', endTime: '12:00', sourceTemplateJobId: 'template-1', assignmentSegments: segments(first) });
  // The claim that never finishes is reported as not confirmed after its attempts, then its visits close.
  const settleLead = async (f, leadId) => { for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) { f.time.advance(60 * 60000); await f.run(); } assert.equal(f.notice(leadId).status, 'uncertain'); await f.run(); };
  // The visit the text names has both days.
  const f = await setup({ jobs: { 'job-1': lead, 'job-2': twoDays() } }), feed = feedOf(f);
  const ids = [...await f.queue(null, lead, { jobId: 'job-1', batch: RUN }), ...await f.queue(null, twoDays(), { jobId: 'job-2', batch: RUN })];
  await stuckClaim(f);
  assert.deepEqual(f.ledgers()[0].noticeBatch, [ids[1]]);
  f.time.set('2026-09-24T19:00:00.000Z');
  await f.run();
  assert.deepEqual([f.notice(ids[1]).status, f.notice(ids[1]).lastStatus], ['pending', ''], 'not expired while next Thursday is ahead');
  await settleLead(f, ids[0]);
  assert.deepEqual([f.notice(ids[1]).status, f.notice(ids[1]).lastStatus, f.notice(ids[1]).attentionUntil], ['batched', 'uncertain', '2026-10-01']);
  // Listed under the text until the text's own work is over (Saturday), then
  // on its own until its last day.
  f.time.set('2026-09-28T18:00:00.000Z');
  assert.deepEqual((await feed.team(MANAGER)).attention.map(row => [row.id, row.status, row.canRetry]), [[ids[1], 'uncertain', false]], 'listed for a dispatcher until its last day');
  assert.equal(f.ghl.sends().length, 0);
  // A dispatcher splits the visit the text names into this Thursday (now
  // ending at 11) and next Thursday: that change waits for the text too, and
  // once it closed as not confirmed the day still ahead is texted.
  const g = await setup({ jobs: { 'job-1': lead, 'job-2': visitOn(DAY) } });
  const visits = [...await g.queue(null, lead, { jobId: 'job-1', batch: RUN }), ...await g.queue(null, visitOn(DAY), { jobId: 'job-2', batch: RUN })];
  await stuckClaim(g);
  g.time.advance(60000);
  const [split] = await g.queue(visitOn(DAY), twoDays('11:00'), { jobId: 'job-2' });
  g.time.set('2026-09-24T19:00:00.000Z');
  await g.run();
  assert.deepEqual([visits[1], split].map(id => g.notice(id).status), ['pending', 'pending'], 'the split waits instead of expiring');
  await settleLead(g, visits[0]);
  assert.deepEqual([g.notice(visits[1]).status, g.notice(visits[1]).lastStatus, g.notice(split).status], ['batched', 'uncertain', 'sent']);
  assert.deepEqual(textsTo(g, 'staff-1').map(text => [/on Thursday, October 1 \(/.test(text), /September 24/.test(text)]), [[true, false]], 'only the day still ahead is texted');
});

test('a visit is never closed into a grouped text whose refusal can still be saved', async () => {
  const f = await setup({ jobs: runJobs() }), feed = feedOf(f), ids = await queueRun(f);
  // While tick A's grouped text is at HighLevel a dispatcher moves the text's
  // own visit to Friday, and two more ticks run a minute apart: each finds
  // the claim in flight for what is now an older notice. HighLevel then
  // refuses A's text.
  let held = false, during = null;
  f.hooks.fetch = async (real, url, options) => {
    if (!held && new URL(url).pathname === '/conversations/messages') {
      held = true;
      f.time.advance(60000);
      await f.queue(visitOn(DAY), visitOn('2026-09-25'), { jobId: 'job-1' });
      await f.run();
      f.time.advance(60000);
      await f.run();
      during = ids.map(id => [f.notice(id).status, f.notice(id).batchedInto || '']);
      return new Response(JSON.stringify({ message: 'Synthetic refusal' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
    }
    return real(url, options);
  };
  await f.run();
  f.hooks.fetch = null;
  assert.deepEqual(during, [['pending', ''], ['pending', ''], ['pending', '']], 'nothing closed while the outcome could still be saved');
  assert.equal(f.ledgers().find(row => row.noticeBatch?.length).status, 'failed');
  for (let tick = 0; tick < 3; tick += 1) { f.time.advance(10 * 60000); await f.run(); }
  assert.deepEqual(textsTo(f, 'staff-1').map(text => [/on Thursday, October 1, plus 1 more visit through Thursday, October 8 /.test(text), /on Friday, September 25 \(/.test(text)]).sort(), [[false, true], [true, false]], 'the refused text\'s visits and the move are each texted once');
  assert.deepEqual(ids.map(id => [f.notice(id).status, f.notice(id).batchedInto || '']), [['superseded', ''], ['sent', ''], ['batched', ids[1]]]);
  assert.deepEqual((await feed.team(MANAGER)).attention.filter(row => ids.includes(row.id)), [], 'nothing is left reading as not confirmed');
  // A claim that never finishes: once its own notice closed, the visits read
  // as not confirmed only after its outcome could no longer be saved.
  const g = await setup({ jobs: runJobs() }), visits = await queueRun(g);
  await stuckClaim(g);
  g.store.edit(`${CREW_NOTIFICATIONS}/${visits[0]}`, { status: 'uncertain', lastStatus: 'sending' });
  g.time.advance(60000);
  await g.run();
  assert.deepEqual(visits.slice(1).map(id => g.notice(id).status), ['pending', 'pending']);
  g.time.advance(5 * 60000);
  await g.run();
  assert.deepEqual(visits.slice(1).map(id => [g.notice(id).status, g.notice(id).lastStatus]), [['batched', 'uncertain'], ['batched', 'uncertain']]);
  assert.equal(g.ghl.sends().length, 0);
});

test('a change read in the Hub keeps that label after a later text, and one a text covered keeps its own', async () => {
  const f = await setup({ jobs: { 'job-1': split(['crew1']) }, linked: {} }), feed = feedOf(f);
  const removal = crew1Of(f, await f.queue(split(['crew1']), split(['crew2']), { at: '2026-09-22T17:00:00.000Z' }));
  await f.run();
  const move = crew1Of(f, await f.queue(split(['crew2']), split(['crew2'], '10:00'), { at: '2026-09-22T17:10:00.000Z' }));
  await feed.acknowledge(CREW1, { action: 'acknowledge', requestId: uuid(), ids: [move] });
  await f.run();
  f.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
  await f.queue(split(['crew2'], '10:00'), split(['crew2'], '11:00'), { at: '2026-09-22T17:20:00.000Z' });
  f.time.advance(10 * 60000);
  await f.run();
  assert.deepEqual(textsTo(f, 'staff-1').map(text => /Wednesday, September 23 \(arrival window 11:00 AM\)/.test(text) && !/Thursday/.test(text)), [true], 'the only text never named the Thursday removal');
  assert.equal((await feed.list(CREW1)).notices.find(row => row.id === removal).delivery, 'read_in_hub');
  let listed = (await feed.team(MANAGER)).attention.find(row => row.id === removal);
  assert.deepEqual([listed.covered, listed.coveredVia], [true, 'hub']);
  // The other order: a text told them about the removal, then they read a later change in the Hub.
  const g = await setup({ jobs: { 'job-1': split(['crew1']) }, linked: {} }), other = feedOf(g);
  const cut = crew1Of(g, await g.queue(split(['crew1']), split(['crew2']), { at: '2026-09-22T17:00:00.000Z' }));
  await g.run();
  g.store.edit(`${CREW_NOTIFICATION_PREFS}/crew1`, { staffContactId: 'staff-1' });
  await g.queue(split(['crew2']), split(['crew2'], '10:00'), { at: '2026-09-22T17:10:00.000Z' });
  g.time.advance(10 * 60000);
  await g.run();
  assert.match(textsTo(g, 'staff-1').at(-1), CHANGED);
  const read = crew1Of(g, await g.queue(split(['crew2'], '10:00'), split(['crew2'], '11:00'), { at: '2026-09-22T17:30:00.000Z' }));
  await other.acknowledge(CREW1, { action: 'acknowledge', requestId: uuid(), ids: [read] });
  g.time.advance(10 * 60000);
  await g.run();
  assert.deepEqual([g.notice(read).status, textsTo(g, 'staff-1').length], ['skipped', 1]);
  assert.equal((await other.list(CREW1)).notices.find(row => row.id === cut).delivery, 'covered');
  listed = (await other.team(MANAGER)).attention.find(row => row.id === cut);
  assert.deepEqual([listed.covered, listed.coveredVia], [true, 'text']);
});
