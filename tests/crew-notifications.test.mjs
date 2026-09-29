import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildCrewNotifications, changeKind, crewNotificationWrites, crewNoticeId, crewNotificationsEnabled, crewSlots, describeLost, describeWork, employeeSlots, jobCrewIds, lostOptions, lostSlots, scheduleChange, slotUpcoming, workOptions, CREW_NOTIFICATIONS } from '../functions/_lib/crew-notifications.js';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { extendHorizon, mutateRecurringPlan } from '../functions/_lib/recurring-plan-service.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { mutateScheduledVisit, schedulingStorage } from '../functions/_lib/operations-scheduling.js';

// NOW is 06:00 on Tuesday 2026-09-22 in Denver; D0 is yesterday.
const NOW = '2026-09-22T12:00:00.000Z', D0 = '2026-09-21', D1 = '2026-09-23', D2 = '2026-09-24', D3 = '2026-09-25', TODAY = '2026-09-22';
const ROSTER = [{ id: 'zacb', name: 'Owner', role: 'owner' }, { id: 'crew1', name: 'Crew One', role: 'crew' }, { id: 'crew2', name: 'Crew Two', role: 'crew' }, { id: 'crew3', name: 'Crew Three', role: 'crew' }, { id: 'crew4', name: 'Twin Name', role: 'crew' }, { id: 'crew5', name: 'Twin Name', role: 'crew' }];
const manager = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true };
const job = (overrides = {}) => ({ type: 'job', date: D1, time: '08:00', endDate: D1, endTime: '10:00', status: 'scheduled', pipelineStatus: 'scheduled', assignedCrew: ['crew1'], ...overrides });
const diff = (before, after, extra = {}) => buildCrewNotifications(before, after, ROSTER, NOW, { jobId: 'job-1', requestId: 'req-1', type: 'job', ...extra });
const brief = rows => rows.map(row => `${row.employeeId}:${row.intent}`);
const slot = (date, time, endTime, segmentId = '') => ({ segmentId, date, time, endDate: date, endTime });
// Customer, money and private-note canaries that must never reach a notice.
const CANARY = { customer: 'Synthetic Canary Customer', phone: '(970) 555-0199', email: 'canary@example.invalid', address: '999 Canary Lane', notes: 'canary-private-note',
  opsNotes: 'canary-ops-note', accessInstructions: 'canary-gate-code-4242', estimate: { amount: 8765.43, depositRequired: 1234.56 }, total: 8765.43, priceQuoted: 8765.43 };

test('the flag is exactly "true" and defaults off', () => {
  assert.deepEqual([undefined, '', 'TRUE', '1', 'yes', 'true'].map(value => crewNotificationsEnabled({ EGC_CREW_NOTIFICATIONS_ENABLED: value })), [false, false, false, false, false, true]);
  assert.equal(crewNotificationsEnabled(undefined), false);
  assert.equal(dispatchStorage({}).crewNotificationsEnabled, false);
  assert.equal(dispatchStorage({ EGC_CREW_NOTIFICATIONS_ENABLED: 'true' }).crewNotificationsEnabled, true);
  assert.equal(schedulingStorage({}).crewNotificationsEnabled, false);
  assert.equal(schedulingStorage({ EGC_CREW_NOTIFICATIONS_ENABLED: 'true' }).crewNotificationsEnabled, true);
});

test('assignment diff matrix: add, remove, reschedule, cancel, restore and silent edits', () => {
  const base = job();
  assert.deepEqual(brief(diff(null, base)), ['crew1:assigned'], 'a new scheduled job tells its crew');
  assert.deepEqual(brief(diff(base, job({ assignedCrew: ['crew1', 'crew2'] }))), ['crew2:assigned'], 'only the added employee hears about an added teammate');
  const removed = diff(job({ assignedCrew: ['crew1', 'crew2'] }), job({ assignedCrew: ['crew2'] }));
  assert.deepEqual(brief(removed), ['crew1:unassigned']);
  assert.deepEqual(removed[0].slot, slot(D1, '08:00', '10:00'), 'a removal names the slot they lost');
  assert.deepEqual(removed[0].slots, []);
  const moved = diff(job({ assignedCrew: ['crew1', 'crew2'] }), job({ assignedCrew: ['crew1', 'crew2'], date: D2, endDate: D2, time: '13:00', endTime: '15:00' }));
  assert.deepEqual(brief(moved), ['crew1:time_changed', 'crew2:time_changed']);
  assert.deepEqual([moved[0].slot, moved[0].previousSlots], [slot(D2, '13:00', '15:00'), [slot(D1, '08:00', '10:00')]]);
  assert.deepEqual(brief(diff(base, job({ endTime: '11:00' }))), ['crew1:time_changed'], 'a longer day is a schedule change');
  for (const edit of [{ title: 'New title' }, { jobInstructions: 'Bring totes' }, { notes: 'x' }, { crewLead: 'crew1' }, { vehicleId: 'truck1' }, { status: 'confirmed', pipelineStatus: 'confirmed' }]) {
    assert.deepEqual(diff(base, job(edit)), [], `no-op edit ${JSON.stringify(edit)} sends nothing`);
  }
  assert.deepEqual(brief(diff(base, job({ status: 'cancelled', pipelineStatus: 'cancelled' }))), ['crew1:cancelled']);
  assert.deepEqual(brief(diff(job({ status: 'cancelled', pipelineStatus: 'cancelled' }), job())), ['crew1:restored']);
  assert.deepEqual(diff(base, job({ status: 'completed', pipelineStatus: 'completed' })), [], 'finishing work is not schedule news');
  assert.deepEqual(diff(null, job({ date: '', endDate: '', time: '', endTime: '', status: 'unscheduled', pipelineStatus: 'unscheduled' })), [], 'crew on an unscheduled job hear once it is scheduled');
  assert.deepEqual(brief(diff(job({ date: '', endDate: '', time: '', endTime: '', status: 'unscheduled' }), base)), ['crew1:assigned']);
  assert.deepEqual(diff(job({ date: D0, endDate: D0 }), job({ date: D0, endDate: D0, assignedCrew: ['crew2'] })), [], 'editing past work is silent');
  assert.deepEqual(diff(null, job({ type: 'blocked' }), { type: 'blocked' }), [], 'company blocks have no crew');
  assert.deepEqual(brief(diff(null, job({ type: 'walkthrough' }), { type: 'walkthrough' })), ['crew1:assigned'], 'walkthrough crews are told too');
  assert.deepEqual(buildCrewNotifications(null, base, ROSTER, NOW, { jobId: '', requestId: 'req-1' }), []);
  assert.deepEqual(buildCrewNotifications(null, base, ROSTER, NOW, { jobId: 'job-1', requestId: '' }), []);
});

test('the dedupe key is job, dispatch request, employee and kind, and the row id is derived from it', async () => {
  const [notice] = diff(null, job());
  assert.equal(notice.dedupeKey, 'job-1:req-1:crew1:assigned');
  assert.equal(notice.messageKind, 'crew_assignment');
  assert.match(await crewNoticeId(notice.dedupeKey), /^crew_[a-f0-9]{40}$/);
  assert.equal(await crewNoticeId(notice.dedupeKey), await crewNoticeId('job-1:req-1:crew1:assigned'));
  assert.notEqual(await crewNoticeId(notice.dedupeKey), await crewNoticeId('job-1:req-2:crew1:assigned'));
  assert.equal(diff(job(), job({ assignedCrew: [] }))[0].messageKind, 'crew_unassignment');
  assert.equal(diff(job(), job({ status: 'canceled', pipelineStatus: 'canceled' }))[0].messageKind, 'crew_unassignment');
});

test('identity follows dispatch: canonical ids, unique display-name aliases only, and no guessed people', () => {
  assert.deepEqual(brief(diff(null, job({ assignedCrew: ['CREW2 '] }))), ['crew2:assigned']);
  assert.deepEqual(brief(diff(null, job({ assignedCrew: [{ username: 'crew3', name: 'Somebody Else' }] }))), ['crew3:assigned']);
  assert.deepEqual(brief(diff(null, job({ assignedCrew: undefined, assignedTo: 'Crew One, Crew Two' }))), ['crew1:assigned', 'crew2:assigned'], 'legacy display names resolve through the roster');
  assert.deepEqual(diff(null, job({ assignedCrew: ['Twin Name'] })), [], 'an ambiguous display name notifies nobody');
  assert.deepEqual(diff(null, job({ assignedCrew: [{ username: 'ghost', name: 'Crew One' }] })), [], 'an explicit unknown account is never matched by its label');
  assert.deepEqual(diff(null, job({ assignedCrew: ['former.employee'] })), []);
});

test('segments notify each segment crew about their own slot only', () => {
  const split = (segments, extra = {}) => job({ date: D1, endDate: D2, time: '08:00', endTime: '17:00', assignedCrew: [...new Set(segments.flatMap(row => row.assignedCrew))], assignmentSegments: segments, ...extra });
  const a = { id: 'a', date: D1, time: '08:00', endTime: '12:00', assignedCrew: ['crew1'] }, b = { id: 'b', date: D2, time: '13:00', endTime: '17:00', assignedCrew: ['crew2'] };
  const created = diff(null, split([a, b]));
  assert.deepEqual(brief(created), ['crew1:assigned', 'crew2:assigned']);
  assert.deepEqual(created.map(row => row.slot), [slot(D1, '08:00', '12:00', 'a'), slot(D2, '13:00', '17:00', 'b')]);
  assert.deepEqual(brief(diff(split([a, b]), split([a, { ...b, time: '14:00' }]))), ['crew2:time_changed'], 'moving one segment tells only its crew');
  assert.deepEqual(brief(diff(split([a, b]), split([{ ...a, assignedCrew: ['crew1', 'crew3'] }, b]))), ['crew3:assigned']);
  assert.deepEqual(brief(diff(split([a, b]), split([{ ...a, assignedCrew: ['crew2'] }, b]))), ['crew1:unassigned', 'crew2:time_changed'], 'crew2 now works both days');
  const both = diff(split([a, b]), split([a, { ...b, assignedCrew: ['crew2', 'crew1'] }])).find(row => row.employeeId === 'crew1');
  assert.equal(both.intent, 'time_changed');
  assert.deepEqual(both.slot, slot(D2, '13:00', '17:00', 'b'), 'the text names the new day, not the unchanged one');
  assert.deepEqual(both.slots.map(row => row.segmentId), ['a', 'b']);
  assert.deepEqual(diff(split([a, b]), split([{ ...a, id: 'renamed' }, b])), [], 'a renamed segment with the same slot is not news');
  const past = { ...a, date: D0 };
  assert.deepEqual(brief(diff(split([past, b], { date: D0 }), split([{ ...past, assignedCrew: ['crew3'] }, b], { date: D0 }))), [], 'a finished segment is silent');
  assert.deepEqual(brief(diff(split([a, b]), split([a, b], { status: 'cancelled', pipelineStatus: 'cancelled' }))), ['crew1:cancelled', 'crew2:cancelled']);
  const slots = crewSlots(split([a, b, { id: 'c', date: D2, time: '08:00', endTime: '10:00', assignedCrew: ['crew1'] }]), ROSTER);
  assert.deepEqual(slots.get('crew1').map(row => row.segmentId), ['a', 'c'], 'slots are earliest first');
});

test('a partial removal is a removal naming the lost day, never a reassurance about the kept one', () => {
  const split = (segments, extra = {}) => job({ date: D1, endDate: D2, time: '08:00', endTime: '17:00', assignedCrew: [...new Set(segments.flatMap(row => row.assignedCrew))], assignmentSegments: segments, ...extra });
  const a = { id: 'a', date: D1, time: '08:00', endTime: '12:00', assignedCrew: ['crew1'] }, b = { id: 'b', date: D2, time: '13:00', endTime: '17:00', assignedCrew: ['crew1'] };
  const [partial, handover] = diff(split([a, b]), split([a, { ...b, assignedCrew: ['crew2'] }]));
  assert.deepEqual([partial.employeeId, partial.intent, partial.messageKind], ['crew1', 'unassigned', 'crew_unassignment']);
  assert.deepEqual(partial.slot, slot(D2, '13:00', '17:00', 'b'), 'the text names Thursday, the day they lost');
  assert.deepEqual([partial.lostSlots, partial.slots], [[slot(D2, '13:00', '17:00', 'b')], [slot(D1, '08:00', '12:00', 'a')]]);
  assert.deepEqual([handover.employeeId, handover.intent], ['crew2', 'assigned']);
  // Losing one day while another moves never hides the loss: the notice is one
  // schedule-change text naming the new time and the lost day.
  const mixed = diff(split([a, b]), split([{ ...a, time: '09:00' }, { ...b, assignedCrew: ['crew2'] }])).find(row => row.employeeId === 'crew1');
  assert.deepEqual([mixed.intent, mixed.slot.time, mixed.lostSlots.map(row => row.segmentId)], ['time_changed', '09:00', ['b']]);
  assert.equal(mixed.messageKind, 'crew_schedule_change', 'the text names Thursday as well as the new Wednesday time');
  // Hours lost on a day they still work are a removal naming those hours.
  const pm = { ...b, id: 'pm', date: D1 };
  const sameDay = diff(split([a, pm], { endDate: D1 }), split([a, { ...pm, assignedCrew: ['crew2'] }], { endDate: D1 })).find(row => row.employeeId === 'crew1');
  assert.deepEqual([sameDay.intent, sameDay.messageKind, sameDay.slot, sameDay.lostSlots], ['unassigned', 'crew_unassignment', slot(D1, '13:00', '17:00', 'pm'), [slot(D1, '13:00', '17:00', 'pm')]], 'they lost Wednesday afternoon, so it is a removal, never a reassurance about the morning');
  assert.deepEqual(sameDay.slots, [slot(D1, '08:00', '12:00', 'a')]);
});

test('what changed since the last text: lost days and hours, new or moved work, and the wording for both', () => {
  const s = (date, time, endTime, id = '', endDate = date) => ({ segmentId: id, date, time, endDate, endTime });
  // A job moved to another day: the old day is lost and the new one added, so one schedule-change text.
  const moved = scheduleChange([s(D1, '08:00', '10:00')], [s(D2, '13:00', '15:00')], NOW);
  assert.deepEqual([moved.lost, moved.added, changeKind(moved)], [[s(D1, '08:00', '10:00')], [s(D2, '13:00', '15:00')], 'crew_schedule_change']);
  // A new time on the same day is only a change.
  const later = scheduleChange([s(D1, '08:00', '10:00', 'a')], [s(D1, '09:00', '11:00', 'a')], NOW);
  assert.deepEqual([later.lost, changeKind(later)], [[], 'crew_assignment']);
  // A segment moved to another day while the morning is kept: its afternoon hours on Wednesday are lost.
  const split = scheduleChange([s(D1, '08:00', '12:00', 'a'), s(D1, '13:00', '17:00', 'pm')], [s(D1, '08:00', '12:00', 'a'), s(D2, '13:00', '17:00', 'pm')], NOW);
  assert.deepEqual([split.lost, split.added, changeKind(split)], [[s(D1, '13:00', '17:00', 'pm')], [s(D2, '13:00', '17:00', 'pm')], 'crew_schedule_change']);
  // Two lost segments are two cuts; a shorter multi-day job is one cut of its dropped days.
  assert.deepEqual(lostSlots([s(D1, '09:00', '12:00', 'a'), s(D2, '09:00', '12:00', 'b'), s(D3, '09:00', '12:00', 'c')], [s(D1, '09:00', '12:00', 'a')], NOW).map(row => row.segmentId), ['b', 'c']);
  assert.deepEqual(lostSlots([s(D1, '09:00', '17:00', '', '2026-09-26')], [s(D1, '09:00', '17:00')], NOW), [s(D2, '', '17:00', '', '2026-09-26')]);
  assert.deepEqual([changeKind({ lost: [], added: [] }), changeKind({ lost: [s(D1, '', '')], added: [] })], ['', 'crew_unassignment']);
});

test('crew texts name every lost day, the hours of a lost segment, and ranges, within a length budget', () => {
  const s = (date, time, endTime, endDate = date) => ({ segmentId: '', date, time, endDate, endTime });
  assert.equal(describeLost([s(D2, '', '17:00', '2026-09-26')]), 'Thursday, September 24, Friday, September 25 and Saturday, September 26', 'a shortened job names each dropped day');
  assert.equal(describeLost([s(D2, '09:00', '12:00'), s(D3, '09:00', '12:00')]), 'Thursday, September 24 and Friday, September 25', 'two lost segments');
  assert.equal(describeLost([s(D1, '13:00', '17:00')], { working: [s(D1, '08:00', '12:00')] }), 'Wednesday, September 23 from 1:00 PM to 5:00 PM', 'hours lost on a day still worked');
  assert.equal(describeLost([s(D1, '08:00', '', '2026-09-27')]), 'Wednesday, September 23 through Sunday, September 27', 'four or more days read as a range');
  assert.equal(describeLost([s(D1, '', ''), s(D3, '', ''), s('2026-09-27', '', ''), s('2026-09-29', '', '')], { max: 60 }), 'Wed Sep 23, Fri Sep 25, Sun Sep 27 and Tue Sep 29', 'short dates when the full ones do not fit');
  assert.equal(describeLost([s(D1, '', ''), s(D3, '', ''), s('2026-09-27', '', ''), s('2026-09-29', '', '')], { max: 40 }), 'Wed Sep 23, Fri Sep 25 and 2 more dates');
  assert.equal(describeWork([s(D1, '09:00', '17:00', D3)]), 'Wednesday, September 23 through Friday, September 25');
  assert.equal(describeWork([s(D1, '09:00', '12:00'), s(D3, '13:00', '15:00')]), 'Wednesday, September 23, plus Friday, September 25');
  assert.equal(describeWork([s(D2, '09:00', '12:00')], { batch: { count: 2, lastDate: '2026-10-08' } }), 'Thursday, September 24, plus 2 more visits through Thursday, October 8');
  assert.equal(describeWork([s(D2, '09:00', '12:00')], { batch: { count: 1, lastDate: '2026-10-01' }, max: 50 }), 'Thu Sep 24, plus 1 more visit through Thu Oct 1');
  assert.equal(describeWork([s(D2, '09:00', '12:00')], { batch: { count: 1, lastDate: '2026-10-01' }, max: 30 }), 'Thu Sep 24, plus 1 more visit');
});

test('every way to word crew dates names each change or counts the rest; none drops or cuts a date', () => {
  const s = (date, time = '09:00', endTime = '12:00', endDate = date) => ({ segmentId: '', date, time, endDate, endTime });
  const view = options => options.map(option => [option.text, option.unnamed]);
  assert.deepEqual(view(lostOptions([s(D1), s(D3), s('2026-09-27')])), [
    ['Wednesday, September 23, Friday, September 25 and Sunday, September 27', 0], ['Wed Sep 23, Fri Sep 25 and Sun Sep 27', 0],
    ['Wed Sep 23, Fri Sep 25 and 1 more date', 1], ['Wed Sep 23 and 2 more dates', 2], ['3 dates', 3]]);
  assert.deepEqual(view(lostOptions([s(D1, '', '', '2026-09-27')])), [['Wednesday, September 23 through Sunday, September 27', 0], ['Wed Sep 23 through Sun Sep 27', 0], ['5 dates', 5]], 'a range counts its days');
  assert.deepEqual(view(lostOptions([s(D1, '08:00', '10:00'), s(D1, '13:00', '15:00')], { working: [s(D1, '10:00', '13:00')] })).map(([text]) => text),
    ['Wednesday, September 23 from 8:00 AM to 10:00 AM and Wednesday, September 23 from 1:00 PM to 3:00 PM', 'Wed Sep 23 8:00 AM–10:00 AM and Wed Sep 23 1:00 PM–3:00 PM'], 'hours on one day are never counted as more dates');
  assert.equal(describeLost([s(D1), s(D3), s('2026-09-27')], { max: 5 }), '3 dates', 'nothing fits: the most compact lossless form, which a hard limit then refuses');
  assert.equal(describeLost([s(D1)], { max: 5 }), 'Wed Sep 23', 'one date is never cut short');
  assert.deepEqual(view(workOptions([s('2026-09-28'), s('2026-09-29'), s('2026-10-02')])), [
    ['Monday, September 28, plus Tuesday, September 29 and Friday, October 2', 0], ['Mon Sep 28, plus Tue Sep 29 and Fri Oct 2', 0],
    ['Mon Sep 28, plus Tue Sep 29 and 1 more date', 1], ['Mon Sep 28, plus 2 more dates', 2]], 'the first slot, whose arrival window the text gives, is always named');
  assert.deepEqual(view(workOptions([s(D2)], { batch: { count: 2, lastDate: '2026-10-08' } })), [
    ['Thursday, September 24, plus 2 more visits through Thursday, October 8', 1], ['Thu Sep 24, plus 2 more visits through Thu Oct 8', 1], ['Thu Sep 24, plus 2 more visits', 2]]);
  assert.equal(describeWork([s('2026-09-28'), s('2026-09-29'), s('2026-10-02')], { max: 10 }), 'Mon Sep 28, plus 2 more dates');
  for (const options of [lostOptions([s(D1), s(D3), s('2026-09-27'), s('2026-09-29')]), workOptions([s(D1), s(D3), s('2026-09-27')])]) {
    for (const { text } of options) assert.match(text, /^(?:\d+ dates|(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? (?:Sep|Oct)[a-z]* \d{1,2})(?:(?:, | and |, plus )(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? (?:Sep|Oct)[a-z]* \d{1,2}|\d+ more dates?))*)$/, text);
  }
});

test('send-time identity: a legacy display-name crew resolves through the roster, like the dispatch diff', () => {
  const legacy = job({ assignedCrew: undefined, assignedTo: 'Crew One, Twin Name' });
  assert.deepEqual([...jobCrewIds(legacy, ROSTER)], ['crew1'], 'an ambiguous display name is nobody');
  assert.deepEqual([...jobCrewIds(legacy, null)], ['crew one', 'twin name'], 'without a roster only usernames can match');
  assert.deepEqual(employeeSlots(legacy, 'crew1', ROSTER, NOW), [slot(D1, '08:00', '10:00')]);
  assert.deepEqual(employeeSlots(job({ assignedCrew: ['crew9'] }), 'crew9', ROSTER, NOW), [slot(D1, '08:00', '10:00')], 'a username still matches while the roster lags');
  assert.deepEqual(employeeSlots(legacy, 'crew1', null, NOW), []);
});

test('a shorter multi-day job tells its crew about the dropped days; a longer one is a change', () => {
  const long = job({ date: D1, time: '08:00', endDate: D3, endTime: '17:00' });
  const [shorter] = diff(long, job({ date: D1, time: '08:00', endDate: D2, endTime: '17:00' }));
  assert.deepEqual([shorter.intent, shorter.messageKind, shorter.slot], ['unassigned', 'crew_unassignment', { segmentId: '', date: D3, time: '', endDate: D3, endTime: '17:00' }]);
  assert.deepEqual(shorter.slots, [{ segmentId: '', date: D1, time: '08:00', endDate: D2, endTime: '17:00' }]);
  assert.equal(diff(long, job({ date: D1, time: '08:00', endDate: D2, endTime: '15:00' }))[0].intent, 'unassigned', 'a new end time on a new last day is still a shorter job');
  const later = diff(long, job({ date: D2, time: '08:00', endDate: D3, endTime: '17:00' }))[0];
  assert.deepEqual([later.intent, later.slot], ['unassigned', { segmentId: '', date: D1, time: '08:00', endDate: D1, endTime: '' }], 'a later start drops the first day');
  assert.deepEqual(brief(diff(job({ date: D1, time: '08:00', endDate: D2, endTime: '17:00' }), long)), ['crew1:time_changed'], 'an extra day is a change they need to hear about');
  assert.deepEqual(lostSlots([{ segmentId: '', date: D1, time: '08:00', endDate: D3, endTime: '00:00' }], [], NOW), [{ segmentId: '', date: D1, time: '08:00', endDate: D2, endTime: '' }], 'an end at midnight releases its last day');
});

test('upcoming means the work is not over yet, by Denver wall clock, not just its date', () => {
  const afternoon = '2026-09-22T20:00:00.000Z'; // 14:00 in Denver
  const today = (overrides = {}) => job({ date: TODAY, endDate: TODAY, time: '08:00', endTime: '12:00', ...overrides });
  assert.deepEqual(buildCrewNotifications(today(), today({ assignedCrew: ['crew1', 'crew2'] }), ROSTER, afternoon, { jobId: 'job-1', requestId: 'req-1' }), [], 'correcting this morning\'s crew after the work is silent');
  assert.deepEqual(buildCrewNotifications(today(), today({ assignedCrew: [] }), ROSTER, afternoon, { jobId: 'job-1', requestId: 'req-1' }), []);
  assert.deepEqual(brief(buildCrewNotifications(today(), today({ endTime: '16:00', assignedCrew: ['crew2'] }), ROSTER, afternoon, { jobId: 'job-1', requestId: 'req-1' })), ['crew2:assigned'], 'work running until 16:00 is still ahead');
  assert.deepEqual(buildCrewNotifications(today({ endTime: '' }), today({ endTime: '', assignedCrew: ['crew2'] }), ROSTER, afternoon, { jobId: 'job-1', requestId: 'req-1' }), [], 'without an end time the start decides');
  const check = (fields, at) => slotUpcoming({ segmentId: '', date: TODAY, time: '', endDate: TODAY, endTime: '', ...fields }, at);
  assert.deepEqual([check({ time: '08:00', endTime: '12:00' }, '2026-09-22T17:59:00.000Z'), check({ time: '08:00', endTime: '12:00' }, '2026-09-22T18:00:00.000Z')], [true, false]);
  assert.deepEqual([check({}, '2026-09-23T05:59:00.000Z'), check({}, '2026-09-23T06:00:00.000Z')], [true, false], 'a slot with no times lasts until Denver midnight');
  assert.deepEqual([check({ endDate: D1, time: '08:00' }, '2026-09-23T20:00:00.000Z'), check({ endDate: D1, time: '08:00' }, '2026-09-24T06:00:00.000Z')], [true, false], 'a multi-day slot with no end time lasts through its last day');
  const ambiguous = { segmentId: '', date: '2026-11-01', time: '00:30', endDate: '2026-11-01', endTime: '01:30' };
  assert.deepEqual([slotUpcoming(ambiguous, '2026-11-01T12:00:00.000Z'), slotUpcoming(ambiguous, '2026-11-02T12:00:00.000Z')], [true, false], 'an ambiguous DST wall time falls back to the calendar day');
});

test('visits created by one recurring-plan run carry a shared batch key for one grouped text; a manual repeat does not', async () => {
  const writes = await crewNotificationWrites({ jobId: 'job-9', requestId: 'req-9', action: 'schedule.create', actorId: 'zacb', type: 'job', before: null, after: job({ sourceTemplateJobId: 'template-1' }), roster: ROSTER, now: NOW, batch: 'recurring:plan-1:run-1' });
  assert.deepEqual(writes.map(write => [write.patch.intent, write.patch.batchKey, write.patch.attentionUntil]), [['assigned', 'recurring:plan-1:run-1', '']]);
  const repeat = await crewNotificationWrites({ jobId: 'job-8', requestId: 'req-8', action: 'schedule.create', actorId: 'zacb', type: 'job', before: null, after: job({ sourceTemplateJobId: 'template-1' }), roster: ROSTER, now: NOW });
  assert.deepEqual(repeat.map(write => write.patch.batchKey), [''], 'a dispatcher repeating a job by hand is texted per visit');
  const moved = await crewNotificationWrites({ jobId: 'job-9', requestId: 'req-10', action: 'schedule.update', actorId: 'zacb', type: 'job', before: job({ sourceTemplateJobId: 'template-1' }), after: job({ sourceTemplateJobId: 'template-1', assignedCrew: ['crew1', 'crew2'] }), roster: ROSTER, now: NOW, batch: 'recurring:plan-1:run-1' });
  assert.deepEqual(moved.map(write => write.patch.batchKey), [''], 'only a create is batched');
});

test('outbox rows are create-only and carry schedule facts, never customer contact, notes or money', async () => {
  const writes = await crewNotificationWrites({ jobId: 'job-1', requestId: 'req-1', action: 'schedule.update', actorId: 'ZacB', type: 'job', before: job(CANARY), after: job({ ...CANARY, assignedCrew: ['crew2'], serviceType: 'Garage cleanout' }), roster: ROSTER, now: NOW });
  assert.deepEqual(writes.map(write => [write.collection, write.revision, write.patch.employeeId, write.patch.intent]), [[CREW_NOTIFICATIONS, undefined, 'crew1', 'unassigned'], [CREW_NOTIFICATIONS, undefined, 'crew2', 'assigned']]);
  const row = writes[1].patch;
  assert.deepEqual([row.status, row.attempts, row.acknowledged, row.dispatchRequestId, row.actorId, row.serviceType, row.createdAt], ['pending', 0, false, 'req-1', 'zacb', 'Garage cleanout', NOW]);
  const text = JSON.stringify(writes);
  for (const value of ['Canary', '555-0199', '5550199', 'canary@', 'Canary Lane', 'canary-private', 'canary-ops', '4242', '8765', '1234.56', 'estimate', 'phone', 'address']) assert.ok(!text.includes(value), `no ${value} in a crew notice`);
});

function dispatchFixture({ notifications = true, segments = false } = {}) {
  const rows = new Map([['customers/c1', { id: 'c1', name: CANARY.customer, phone: CANARY.phone, email: CANARY.email, address: CANARY.address, revision: 'c1r' }]]), commits = [];
  let revision = 0, failNext = null;
  const clone = value => structuredClone(value), all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => clone(value));
  const store = {
    crewNotificationsEnabled: notifications, segmentsEnabled: segments,
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => clone(ROSTER), recurringPlans: async () => all('recurringPlans'),
    read: async (collection, id) => clone(rows.get(`${collection}/${id}`) || null),
    commit: async writes => {
      await new Promise(resolve => setImmediate(resolve));
      const seen = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`, old = rows.get(key);
        assert.ok(!seen.has(key), 'no duplicate writes per commit'); seen.add(key);
        if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      if (failNext) { const error = failNext; failNext = null; throw error; }
      for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...clone(write.patch), id: write.id, revision: `r${++revision}` });
      commits.push(writes.map(write => `${write.collection}/${write.id}`));
    },
  };
  const create = (changes = {}) => ({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: D1, time: '08:00', endTime: '10:00', assignedCrew: ['crew1'], jobInstructions: 'Synthetic scope', ...changes } });
  const edit = (saved, changes = {}, action = 'schedule.update') => ({ action, requestId: randomUUID(), jobId: saved.id, expectedRevision: rows.get(`jobs/${saved.id}`).revision, changes });
  const notices = () => all(CREW_NOTIFICATIONS);
  return { rows, store, commits, create, edit, notices, mutate: input => mutateDispatch(store, manager, input, NOW), failNextCommit: error => { failNext = error; } };
}

test('dispatch writes nothing new while the flag is off', async () => {
  const f = dispatchFixture({ notifications: false }), saved = (await f.mutate(f.create())).job;
  await f.mutate(f.edit(saved, { assignedCrew: ['crew2'], time: '09:00', endTime: '11:00' }));
  await f.mutate(f.edit(saved, {}, 'schedule.cancel'));
  assert.equal(f.notices().length, 0);
  assert.ok(f.commits.every(keys => keys.every(key => !key.startsWith(CREW_NOTIFICATIONS))));
});

test('dispatch queues notices in the same commit as the change and its receipt', async () => {
  const f = dispatchFixture(), input = f.create(), saved = (await f.mutate(input)).job;
  const first = f.commits.at(-1);
  assert.ok(first.includes(`jobs/${saved.id}`) && first.includes(`dispatchOperations/${input.requestId}`) && first.includes('dispatchState/revision'));
  const [notice] = f.notices();
  assert.ok(first.includes(`${CREW_NOTIFICATIONS}/${notice.id}`), 'the notice is part of the dispatch commit');
  assert.deepEqual([notice.employeeId, notice.intent, notice.jobId, notice.dispatchRequestId, notice.action], ['crew1', 'assigned', saved.id, input.requestId, 'schedule.create']);
  assert.equal(notice.id, await crewNoticeId(`${saved.id}:${input.requestId}:crew1:assigned`));
  const move = f.edit(saved, { assignedCrew: ['crew1', 'crew2'], date: D2, time: '09:00', endTime: '11:00' });
  await f.mutate(move);
  assert.deepEqual(f.notices().filter(row => row.dispatchRequestId === move.requestId).map(row => `${row.employeeId}:${row.intent}`).sort(), ['crew1:time_changed', 'crew2:assigned']);
  const quiet = f.edit(saved, { title: 'Renamed', jobInstructions: 'More totes' });
  await f.mutate(quiet);
  assert.equal(f.notices().filter(row => row.dispatchRequestId === quiet.requestId).length, 0, 'a no-op for crew queues nothing');
  const cancel = f.edit(saved, {}, 'schedule.cancel');
  await f.mutate(cancel);
  assert.deepEqual(f.notices().filter(row => row.dispatchRequestId === cancel.requestId).map(row => `${row.employeeId}:${row.intent}`).sort(), ['crew1:cancelled', 'crew2:cancelled']);
  const restore = f.edit(saved, {}, 'schedule.restore');
  await f.mutate(restore);
  assert.deepEqual(f.notices().filter(row => row.dispatchRequestId === restore.requestId).map(row => row.intent), ['restored', 'restored']);
  const text = JSON.stringify(f.notices());
  for (const value of ['Canary', '555-0199', 'canary@', 'Canary Lane', 'Synthetic scope']) assert.ok(!text.includes(value), `no ${value} in crew notices`);
});

test('a failed dispatch commit leaves no notice, and replays or concurrent retries add none', async () => {
  const f = dispatchFixture(), saved = (await f.mutate(f.create())).job, before = f.notices().length;
  f.failNextCommit(Object.assign(new Error('Synthetic storage outage'), { code: 'dispatch_storage_unavailable', status: 503 }));
  const lost = f.edit(saved, { assignedCrew: ['crew1', 'crew2'] });
  await assert.rejects(f.mutate(lost), error => error.code === 'dispatch_storage_unavailable');
  assert.equal(f.notices().length, before, 'nothing is queued when the schedule change is not saved');
  await assert.rejects(f.mutate({ ...f.edit(saved, { assignedCrew: ['crew3'] }), expectedRevision: 'stale' }), error => error.code === 'dispatch_revision_conflict');
  assert.equal(f.notices().length, before);
  const retry = f.edit(saved, { assignedCrew: ['crew1', 'crew2'] });
  const results = await Promise.all(Array.from({ length: 4 }, () => f.mutate(retry)));
  assert.equal(new Set(results.map(result => result.job.id)).size, 1);
  assert.equal((await f.mutate(retry)).replayed, true);
  assert.deepEqual(f.notices().filter(row => row.dispatchRequestId === retry.requestId).map(row => `${row.employeeId}:${row.intent}`), ['crew2:assigned'], 'one notice per employee and change');
});

test('split-crew dispatch queues one notice per segment crew member, in the dispatch commit', async () => {
  const f = dispatchFixture({ segments: true });
  const input = { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { jobInstructions: 'Synthetic scope', assignmentSegments: [
    { id: 'a', date: D1, time: '08:00', endTime: '12:00', assignedCrew: ['crew1', 'crew3'] }, { id: 'b', date: D2, time: '13:00', endTime: '17:00', assignedCrew: ['crew2'] }] } };
  const saved = (await f.mutate(input)).job;
  assert.deepEqual(f.notices().map(row => [row.employeeId, row.slot.segmentId, row.slot.date]).sort(), [['crew1', 'a', D1], ['crew2', 'b', D2], ['crew3', 'a', D1]]);
  assert.ok(f.notices().every(row => f.commits.at(-1).includes(`${CREW_NOTIFICATIONS}/${row.id}`)));
  const current = f.rows.get(`jobs/${saved.id}`);
  const move = f.edit(saved, { assignmentSegments: current.assignmentSegments.map(row => row.id === 'b' ? { ...row, time: '14:00' } : row) });
  await f.mutate(move);
  assert.deepEqual(f.notices().filter(row => row.dispatchRequestId === move.requestId).map(row => [row.employeeId, row.intent, row.slot.time]), [['crew2', 'time_changed', '14:00']]);
});

test('a recurring-plan run batches the visits it creates; a dispatcher repeating a job by hand does not', async () => {
  const f = dispatchFixture(), template = (await f.mutate(f.create())).job;
  const created = await mutateRecurringPlan(f.store, manager, { requestId: randomUUID(), action: 'create', plan: { templateJobId: template.id, cadence: { frequency: 'weekly' }, horizonDays: 28 } }, NOW, { enabled: true });
  const run = await extendHorizon(f.store, manager, { now: NOW });
  const visits = run.plans[0].created.map(row => row.id), key = `recurring:${created.plan.id}:${NOW}`;
  assert.equal(visits.length, 3);
  const queued = f.notices().filter(row => visits.includes(row.jobId));
  assert.deepEqual(queued.map(row => [row.intent, row.batchKey]), visits.map(() => ['assigned', key]), 'one scheduled run shares one batch');
  assert.ok(queued.every(row => f.commits.some(keys => keys.includes(`${CREW_NOTIFICATIONS}/${row.id}`) && keys.includes(`jobs/${row.jobId}`))), 'each notice is in its visit\'s dispatch commit');
  const extend = randomUUID(), plan = f.rows.get(`recurringPlans/${created.plan.id}`);
  await mutateRecurringPlan(f.store, manager, { requestId: extend, action: 'extend', planId: plan.id, expectedRevision: plan.revision, limit: 1 }, '2026-09-29T12:00:00.000Z', { enabled: true });
  const added = f.notices().filter(row => row.batchKey && row.batchKey !== key);
  assert.deepEqual(added.map(row => row.batchKey), [`recurring:${created.plan.id}:${extend}`], 'a dispatcher\'s extend request is its own run');
  const repeat = { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', sourceTemplateJobId: template.id, changes: { date: '2026-10-28', time: '08:00', endTime: '10:00', assignedCrew: ['crew1'] } };
  const manual = (await f.mutate(repeat)).job;
  assert.deepEqual(f.notices().filter(row => row.jobId === manual.id).map(row => [row.intent, row.batchKey]), [['assigned', '']], 'a manual repeat is texted on its own');
});

test('reschedules and cancellations through the operations bridge queue notices atomically too', async () => {
  const rows = new Map([['customers/customer-a', { id: 'customer-a', name: 'Synthetic customer', highlevelContactId: 'contact-a', revision: 'customer-r1' }]]), commits = [];
  let revision = 0;
  const store = {
    crewNotificationsEnabled: true, roster: async () => structuredClone(ROSTER), resources: async () => [],
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    day: async date => [...rows.entries()].filter(([key, value]) => key.startsWith('jobs/') && value.date === date).map(([, value]) => structuredClone(value)),
    commit: async writes => {
      for (const write of writes) { const prior = rows.get(`${write.collection}/${write.id}`); if (write.revision ? prior?.revision !== write.revision : Boolean(prior)) throw Object.assign(new Error('schedule_revision_conflict'), { status: 409 }); }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++revision}` });
      commits.push(writes.map(write => `${write.collection}/${write.id}`));
    },
  };
  rows.set('jobs/visit-1', { id: 'visit-1', type: 'job', customerId: 'customer-a', highlevelContactId: 'contact-a', date: D1, endDate: D1, time: '08:00', endTime: '10:00', status: 'scheduled', pipelineStatus: 'scheduled', assignedCrew: ['crew1'], assignedTo: 'crew1', revision: 'v1' });
  const actor = { id: 'verified-grant', kind: 'integration', role: 'integration', workspace: 'egc' };
  const mutate = (mode, changes = {}) => mutateScheduledVisit(store, actor, { command: 'schedule.mutate', requestId: randomUUID(), mode, portalCustomerId: 'customer-a', portalVisitId: 'visit-1', kind: 'job', expectedRevision: rows.get('jobs/visit-1').revision, changes }, NOW);
  const notices = () => [...rows.entries()].filter(([key]) => key.startsWith(`${CREW_NOTIFICATIONS}/`)).map(([, value]) => value);
  await mutate('update', { time: '09:00', endTime: '11:00' });
  assert.deepEqual(notices().map(row => [row.employeeId, row.intent, row.slot.time, row.actorId]), [['crew1', 'time_changed', '09:00', 'verified-grant']]);
  assert.ok(commits.at(-1).includes(`${CREW_NOTIFICATIONS}/${notices()[0].id}`));
  await mutate('update', { title: 'Synthetic rename' });
  assert.equal(notices().length, 1, 'a title change is not schedule news');
  await mutate('cancel');
  assert.deepEqual(notices().map(row => row.intent).sort(), ['cancelled', 'time_changed']);
  store.crewNotificationsEnabled = false;
  rows.set('jobs/visit-1', { ...rows.get('jobs/visit-1'), status: 'scheduled', pipelineStatus: 'scheduled', revision: 'v9' });
  await mutate('update', { time: '12:00', endTime: '13:00' });
  assert.equal(notices().length, 2, 'the flag off queues nothing');
});
