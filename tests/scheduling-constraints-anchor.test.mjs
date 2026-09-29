import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FUNNEL_FEED_SETTLE_MS, walkthroughOutcomesFeed, walkthroughOutcomesInput } from '../functions/_lib/funnel-feed.js';
import { recordWalkthroughVisit } from '../functions/_lib/walkthrough-visit.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { resolveSchedulingConstraints, schedulingAnchorFromOutcome, walkthroughSchedulingConstraints } from '../egc-platform/packages/ai/src/scheduling-constraints.ts';

// FUN-08 across the bridge: relative dates in a walkthrough's extraction are resolved against
// walkthroughVisit.startedAt exactly as the FUN-37 hub.walkthrough.outcomes feed reports it.
// The visits, events and outcomes come from the real FUN-05 recorder, FUN-02 handoff and FUN-37
// feed over an in-memory Firestore; every clock is injected.
const FIRESTORE_TIME = '2026-11-03T00:00:00.000001Z';
const rep = { user: 'Sales.Rep', displayName: 'Synthetic Sales Rep', role: 'sales', businessAccess: false, source: 'employee-account' };
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const ROSTER = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'sales.rep', name: 'Synthetic Sales Rep', role: 'sales' }];
const conflict = () => Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
const byPosition = order => (a, b) => a[order] < b[order] ? -1 : a[order] > b[order] ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function ledger(seed) {
  const rows = new Map(); let n = 0;
  for (const [key, value] of Object.entries(seed)) rows.set(key, { revision: `${key}-r0`, ...structuredClone(value), id: key.split('/')[1] });
  const list = prefix => [...rows].filter(([key]) => key.startsWith(`${prefix}/`)).map(([, value]) => structuredClone(value));
  return {
    rows, env: {},
    jobs: async () => list('jobs'), resources: async () => list('dispatchResources'), roster: async () => structuredClone(ROSTER),
    customers: async provider => provider === undefined ? list('customers') : list('customers').filter(row => row.highlevelContactId === provider),
    day: async date => list('jobs').filter(row => row.date === date), snapshot: async () => list('jobs').filter(row => !row.recordType), identityCandidates: async () => [],
    assigned: async (session, job) => (job.assignedCrew || []).includes(session.user.toLowerCase()),
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    async commit(writes) {
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw conflict(); }
      for (const write of writes) if (!write.verify) { const key = `${write.collection}/${write.id}`; rows.set(key, { ...(write.revision ? rows.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); }
    },
    async funnelEventsPage(query) {
      const found = list('funnelEvents').filter(row => (!query.types || query.types.includes(row.type)) && (!query.through || row[query.order] <= query.through)).sort(byPosition(query.order))
        .filter(row => !query.after || row[query.order] > query.after.at || row[query.order] === query.after.at && row.id > query.after.id);
      return { rows: found.slice(0, query.limit), readTime: query.readTime || FIRESTORE_TIME };
    },
    async funnelRecords(collection, ids, fields, readTime = null) {
      return { rows: ids.map(id => rows.get(`${collection}/${id}`)).filter(Boolean).map(row => ({ id: row.id, ...Object.fromEntries(fields.filter(field => row[field] !== undefined).map(field => [field, structuredClone(row[field])])) })), readTime: readTime || FIRESTORE_TIME };
    },
  };
}
const walkthrough = (date, time) => ({ type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Fixture Lane', date, time, endTime: `${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}:00`, assignedCrew: ['sales.rep'], highlevelContactId: 'contactA' });
const plan = (acceptedAt, jobDate) => ({ client: { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'contactA' }, quote: { title: 'Garage reset', total: 1400, deposit: 700, job_date: jobDate, start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 }, acceptance: { accepted_at: acceptedAt, accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 3 }, scope: { keep_items: 'Blue bicycle', finish: ['shelving'], finish_details: { shelf_type: 'metal', shelf_qty: 2 } }, discovery: { success: 'Park a vehicle' }, logistics: { crew_size: 2, assigned_to: 'Crew of 2', notes: 'Use side gate' }, internal_notes: 'Keep blue bicycle.', notes: 'Call before arrival', client_checklists: { preJob: [], postJob: [] } });
const said = mention => ({ mention, sourceQuote: `Customer: ${mention}` });
// What a v2 extraction holds after evidence validation (the model's words, no dates); occurredAt is the upload.
const extraction = { occurredAt: '2026-11-02T20:00:00.000Z', schedulingConstraints: { preferredWeekdays: null, timeOfDay: null, notBeforeMention: said('tomorrow'), notAfterMention: said('by the end of the month'),
  unavailableMentions: [said('this weekend')], crewSizeMention: null, durationHoursMention: null, urgency: null } };

test('the anchor is the Start the outcome feed reports, on its Denver day: a Start after 23:00 and one on the fall-back day', async () => {
  const store = ledger({ 'customers/c1': { name: 'Synthetic Customer', phone: '9705550100', highlevelContactId: 'contactA' },
    'jobs/w1': walkthrough('2026-10-05', '17:00'), 'jobs/w2': walkthrough('2026-11-01', '20:00'), 'jobs/w3': walkthrough('2026-10-07', '09:00') });
  const act = (id, action, extra, now) => recordWalkthroughVisit(store, rep, { action, visitId: id, requestId: randomUUID(), expectedRevision: store.rows.get(`jobs/${id}`).revision, ...extra }, now);
  // w1: Monday 5 October, started 23:30 MDT (already Tuesday in UTC). w2: Sunday 1 November, the day clocks fall back, started 23:30 MST.
  const late = await act('w1', 'start', { skipTimecard: true, recordingStatus: 'recorded' }, '2026-10-06T05:30:00.000Z');
  await act('w1', 'finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }, '2026-10-06T06:15:00.000Z');
  const fallBack = await act('w2', 'start', { skipTimecard: true, recordingStatus: 'recorded' }, '2026-11-02T06:30:00.000Z');
  await act('w2', 'finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }, '2026-11-02T06:50:00.000Z');
  // w3: signed on site without a Start (a standalone Voice Memos upload has no startedAt): its scheduled date, flagged.
  await saveWalkthroughHandoff(store, owner, { requestId: randomUUID(), customerId: 'c1', sourceWalkthroughId: 'w3', sourceRevision: store.rows.get('jobs/w3').revision, plan: plan('2026-10-07T16:55:00.000Z', '2026-10-21') }, '2026-10-07T17:00:00.000Z');

  const feed = await walkthroughOutcomesFeed(store, walkthroughOutcomesInput({}), new Date(Date.parse('2026-11-02T06:50:00.000Z') + FUNNEL_FEED_SETTLE_MS));
  const byVisit = Object.fromEntries(feed.outcomes.map(item => [item.visitId, item]));
  assert.deepEqual(Object.keys(byVisit).sort(), ['w1', 'w2', 'w3']);
  assert.deepEqual([byVisit.w1.startedAt, byVisit.w2.startedAt, byVisit.w3.startedAt, byVisit.w3.outcome], [late.visit.walkthroughVisit.startedAt, fallBack.visit.walkthroughVisit.startedAt, null, 'sold_on_site']);

  const anchors = Object.fromEntries(Object.entries(byVisit).map(([id, item]) => [id, schedulingAnchorFromOutcome(item)]));
  assert.deepEqual(anchors.w1, { source: 'walkthrough_started', startedAt: '2026-10-06T05:30:00.000Z', date: '2026-10-05', timeZone: 'America/Denver', flagged: false, reason: null });
  assert.deepEqual([anchors.w2.source, anchors.w2.date], ['walkthrough_started', '2026-11-01']);
  assert.deepEqual(anchors.w3, { source: 'scheduled_date', startedAt: null, date: '2026-10-07', timeZone: 'America/Denver', flagged: true, reason: 'walkthrough_not_started' });

  const resolved = Object.fromEntries(Object.entries(byVisit).map(([id, item]) => [id, walkthroughSchedulingConstraints(extraction, item)]));
  const view = result => [result.notBefore.date, result.notAfter.resolution, result.notAfter.date, result.unavailable[0].from, result.unavailable[0].to, result.flags];
  // Monday 5 October: tomorrow is Tuesday the 6th; the month ends on the 31st; this weekend is 10-11 October.
  assert.deepEqual(view(resolved.w1), ['2026-10-06', 'resolved', '2026-10-31', '2026-10-10', '2026-10-11', []]);
  // Sunday 1 November: tomorrow is Monday the 2nd (not the 3rd); the month is November; "this weekend" said on a Sunday
  // is today or the coming one, so both stay for a person to pick.
  assert.deepEqual(view(resolved.w2), ['2026-11-02', 'resolved', '2026-11-30', null, null, ['mention_ambiguous']]);
  assert.deepEqual(resolved.w2.unavailable[0].candidates, [{ from: '2026-11-01', to: '2026-11-01' }, { from: '2026-11-07', to: '2026-11-08' }]);
  // Wednesday 7 October (scheduled date): flagged, never counted from the handoff or the upload.
  assert.deepEqual(view(resolved.w3), ['2026-10-08', 'resolved', '2026-10-31', '2026-10-10', '2026-10-11', ['anchor_scheduled_date']]);
  // The upload on 2 November anchors nothing: counted from it, "tomorrow" would be 3 November for every visit.
  assert.ok(Object.values(resolved).every(result => result.notBefore.date !== '2026-11-03'));
});

test('an outcome the feed can only deliver from its event (visit record gone) has no anchor: relative words stay unresolved', async () => {
  const store = ledger({ 'customers/c1': { name: 'Synthetic Customer', highlevelContactId: 'contactA' }, 'jobs/w1': walkthrough('2026-10-05', '17:00') });
  const act = (action, extra, now) => recordWalkthroughVisit(store, rep, { action, visitId: 'w1', requestId: randomUUID(), expectedRevision: store.rows.get('jobs/w1').revision, ...extra }, now);
  await act('start', { skipTimecard: true, recordingStatus: 'recorded' }, '2026-10-05T23:02:00.000Z');
  await act('finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }, '2026-10-05T23:40:00.000Z');
  store.rows.delete('jobs/w1');
  const [item] = (await walkthroughOutcomesFeed(store, walkthroughOutcomesInput({}), new Date(Date.parse('2026-10-05T23:40:00.000Z') + FUNNEL_FEED_SETTLE_MS))).outcomes;
  assert.deepEqual([item.detail, item.startedAt, item.occurrence], ['event_only', null, null]);
  const result = resolveSchedulingConstraints(extraction.schedulingConstraints, schedulingAnchorFromOutcome(item));
  assert.deepEqual([result.anchor.source, result.notBefore.resolution, result.notBefore.reason, result.flags], ['none', 'unresolved', 'anchor_unknown', ['anchor_unknown', 'mention_unresolved']]);
});
