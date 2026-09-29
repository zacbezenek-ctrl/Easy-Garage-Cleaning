import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeTimecard, deviceClockTime, offlineClockEnabled, serverClockTime, timecardHours } from '../functions/_lib/employee-timecards.js';
import { activeJobSegment, employeeJobTime } from '../functions/_lib/employee-job-time.js';
import { createHubCredentialHash, createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { onRequestGet, onRequestPost } from '../functions/api/employee-hub.js';
import { storage } from './helpers/field-fixture.mjs';

const crew = { user: 'Crew.One', displayName: 'Crew One', role: 'crew', payType: 'hourly' };
const manager = { user: 'ZacB', displayName: 'Manager', role: 'owner' };
const NOW = '2026-09-22T18:00:00.000Z';
const at = minutes => new Date(Date.parse(NOW) + minutes * 60000).toISOString();
const point = { lat: 40.58, lng: -105.08, accuracy: 5 };
const ON = { EGC_OFFLINE_CLOCK_ENABLED: 'true' };
const clockIn = (incoming, env = ON, now = NOW) => authorizeTimecard({ session: crew, manager: false, id: 'shift', incoming: { locationTracking: true, lastLocation: point, ...incoming }, hourlyRate: 20, now, env });
const update = (existing, incoming, now, env = ON) => authorizeTimecard({ session: crew, manager: false, id: existing.id, existing, incoming, now, env });

test('the offline clock flag is off unless the owner sets exactly true', () => {
  for (const value of ['true', 'TRUE', ' true ']) assert.equal(offlineClockEnabled({ EGC_OFFLINE_CLOCK_ENABLED: value }), true);
  for (const value of [undefined, '', 'false', '1', 'yes', 'on']) assert.equal(offlineClockEnabled({ EGC_OFFLINE_CLOCK_ENABLED: value }), false);
  assert.equal(offlineClockEnabled(undefined), false);
});

// Before this unit an offline clock action failed visibly. With the flag off
// a stale phone time must still fail visibly, never be restamped to the moment
// the phone reconnected (a 4 PM clock-out landing at 7 AM the next day).
const offDevice = error => error.status === 409 && error.code === 'EMPLOYEE_TIMECARD_DEVICE_TIME' && /Offline clock times are not enabled/.test(error.message);
test('with the flag off, a fresh device time records server time and a stale one is refused, never restamped', () => {
  const started = clockIn({ deviceCapturedAt: at(-1) }, {});
  assert.equal(started.clockInAt, NOW); assert.equal(started.deviceTime, undefined); assert.equal(started.needsReview, undefined); assert.equal(started.deviceTimeEvents, undefined);
  assert.throws(() => clockIn({ deviceCapturedAt: at(-30) }, {}), offDevice);
  assert.equal(clockIn({ deviceCapturedAt: 'not-a-time' }, {}).clockInAt, NOW, 'an unreadable device time is ignored as before');
  assert.equal(clockIn({}, {}).clockInAt, NOW, 'the Employee Hub time clock sends no device time and is unchanged');
  assert.throws(() => update(started, { breaks: [{ startAt: at(10), endAt: '' }], deviceCapturedAt: at(10) }, at(40), {}), offDevice);
  const onBreak = update(started, { breaks: [{ startAt: at(39), endAt: '' }], deviceCapturedAt: at(39) }, at(40), {});
  assert.equal(onBreak.breaks[0].startAt, at(40));
  assert.throws(() => update(onBreak, { clockOutAt: at(50), status: 'submitted', deviceCapturedAt: at(50) }, at(90), {}), offDevice, 'a clock-out captured at +50 is not recorded at +90');
  const closed = update(onBreak, { clockOutAt: at(89), status: 'submitted', deviceCapturedAt: at(89) }, at(90), {});
  assert.equal(closed.clockOutAt, at(90)); assert.equal(closed.breaks[0].endAt, at(90)); assert.equal(closed.deviceTime, undefined);
  const work = authorizeTimecard({ session: crew, manager: false, id: 'shift', existing: started, incoming: { jobAction: { requestId: crypto.randomUUID(), expectedSegmentId: activeJobSegment(started).id, jobId: 'job-a', kind: 'work', deviceCapturedAt: at(19) } }, now: at(20) });
  assert.equal(activeJobSegment(work).startedAt, at(20)); assert.equal(work.deviceTime, undefined);
  assert.throws(() => authorizeTimecard({ session: crew, manager: false, id: 'shift', existing: started, incoming: { jobAction: { requestId: crypto.randomUUID(), expectedSegmentId: activeJobSegment(started).id, jobId: 'job-a', kind: 'work', deviceCapturedAt: at(5) } }, now: at(20) }), offDevice);
  assert.equal(serverClockTime(new Date(Date.parse(NOW) - 120000).toISOString(), NOW), NOW, 'two minutes of delay is still recorded');
  assert.throws(() => serverClockTime(new Date(Date.parse(NOW) - 121000).toISOString(), NOW), offDevice);
});

test('with the flag off, replays of actions that already applied stay no-ops whatever their device time', () => {
  const started = clockIn({ deviceCapturedAt: NOW }, {}), requestId = crypto.randomUUID();
  const again = update(started, { locationTracking: true, lastLocation: point, deviceCapturedAt: NOW }, at(300), {});
  assert.equal(again.clockInAt, NOW, 'an existing card answers a replayed clock-in');
  const onBreak = update(started, { breaks: [{ startAt: 'phone', endAt: '', requestId }], deviceCapturedAt: at(10) }, at(10), {});
  assert.deepEqual(update(onBreak, { breaks: [{ startAt: 'phone', endAt: '', requestId }], deviceCapturedAt: at(10) }, at(300), {}).breaks, onBreak.breaks, 'a replayed break start is not stamped again');
  const back = update(onBreak, { breaks: [{ ...onBreak.breaks[0], endAt: 'phone' }] }, at(20), {});
  const closed = update(back, { clockOutAt: 'phone', status: 'submitted', deviceCapturedAt: at(30) }, at(30), {});
  assert.strictEqual(update(closed, { clockOutAt: 'phone', status: 'submitted', deviceCapturedAt: at(30) }, at(900), {}), closed, 'a replayed clock-out keeps the submitted card');
  const action = { requestId: crypto.randomUUID(), expectedSegmentId: activeJobSegment(started).id, jobId: 'job-a', kind: 'work', deviceCapturedAt: at(5) };
  const work = authorizeTimecard({ session: crew, manager: false, id: 'shift', existing: started, incoming: { jobAction: action }, now: at(5) });
  assert.strictEqual(authorizeTimecard({ session: crew, manager: false, id: 'shift', existing: work, incoming: { jobAction: action }, now: at(600) }), work, 'a job-time receipt replays as a no-op');
});

test('a queued break keeps its request ID, so a replay after the break changed elsewhere is a no-op', () => {
  const started = clockIn({ deviceCapturedAt: NOW }, {}), startId = crypto.randomUUID(), endId = crypto.randomUUID();
  const onBreak = update(started, { breaks: [{ startAt: 'phone', endAt: '', requestId: startId.toUpperCase() }], deviceCapturedAt: at(10) }, at(10), {});
  assert.deepEqual(onBreak.breaks, [{ startAt: at(10), endAt: '', startRequestId: startId }]);
  const endedInHub = update(onBreak, { breaks: [{ startAt: at(10), endAt: at(15) }] }, at(15), {});
  assert.deepEqual(endedInHub.breaks, [{ startAt: at(10), endAt: at(15), startRequestId: startId }]);
  const replayedStart = update(endedInHub, { breaks: [...endedInHub.breaks, { startAt: 'phone', endAt: '', requestId: startId }], deviceCapturedAt: at(16) }, at(16), {});
  assert.deepEqual(replayedStart.breaks, endedInHub.breaks, 'a lost-reply break start never opens a second break');
  const second = update(endedInHub, { breaks: [...endedInHub.breaks, { startAt: at(20), endAt: '' }] }, at(20), {});
  const ended = update(second, { breaks: [endedInHub.breaks[0], { startAt: at(20), endAt: 'phone', requestId: endId }], deviceCapturedAt: at(25) }, at(25), {});
  assert.deepEqual(ended.breaks.at(-1), { startAt: at(20), endAt: at(25), endRequestId: endId });
  const third = update(ended, { breaks: [...ended.breaks, { startAt: at(30), endAt: '' }] }, at(30), {});
  const replayedEnd = update(third, { breaks: [...third.breaks.slice(0, -1), { startAt: at(30), endAt: 'phone', requestId: endId }], deviceCapturedAt: at(31) }, at(31), {});
  assert.deepEqual(replayedEnd.breaks, third.breaks, 'a lost-reply break end never ends a newer break');
  assert.equal(replayedEnd.breaks.at(-1).endAt, '');
  assert.deepEqual(update(started, { breaks: [{ startAt: 'phone', endAt: '', requestId: 'not-a-uuid' }] }, at(40), {}).breaks, [{ startAt: at(40), endAt: '' }], 'only a valid request ID is kept');
});

// CREW-TIME (CD-04): the crew app's one clock-in position was stored as 'unavailable', so the Hub warned "Location stopped
// unexpectedly". Every clock-in now records one position and says where it came from; nothing tracks after it.
test('a clock-in records its one position as a single fix from the crew app or the Hub, never as tracking or unavailable', () => {
  for (const [status, expected] of [['job_page_single_fix', 'job_page_single_fix'], ['unavailable', 'job_page_single_fix'], ['hub_single_fix', 'hub_single_fix'], [undefined, 'hub_single_fix'], ['tracking', 'hub_single_fix'], ['stopped', 'hub_single_fix']]) {
    const entry = clockIn(status === undefined ? {} : { locationStatus: status }, {});
    assert.deepEqual([entry.locationStatus, entry.locationTracking, entry.locationTrail, entry.lastLocation], [expected, false, undefined, { ...point, capturedAt: NOW }], String(status));
  }
});

test('an accepted offline clock-in keeps the phone time, stays open for the shift, and is flagged for manager review', () => {
  const entry = clockIn({ deviceCapturedAt: at(-30), clockInAt: at(-600), approvalStatus: 'approved' });
  assert.equal(entry.clockInAt, at(-30)); assert.equal(entry.createdAt, NOW); assert.equal(entry.updatedAt, NOW);
  assert.equal(entry.lastLocation.capturedAt, at(-30)); assert.equal(activeJobSegment(entry).startedAt, at(-30));
  assert.equal(entry.status, 'active'); assert.equal(entry.approvalStatus, 'open', 'the crew member can still take breaks and clock out');
  assert.equal(entry.deviceTime, true); assert.equal(entry.needsReview, true);
  assert.deepEqual(entry.deviceTimeEvents, [{ action: 'clock_in', deviceCapturedAt: at(-30), recordedAt: at(-30), receivedAt: NOW }]);
  assert.equal(entry.history.at(-1).at, NOW); assert.equal(employeeJobTime(entry, NOW).needsReview, false);
});

test('device times are accepted only within 12 hours, up to two minutes of clock skew, and never before the last event', () => {
  assert.equal(deviceClockTime(at(-720), NOW), at(-720), 'exactly 12 hours old is accepted');
  assert.throws(() => deviceClockTime(at(-721), NOW), error => error.status === 409 && error.code === 'EMPLOYEE_TIMECARD_DEVICE_TIME' && /12 hours/.test(error.message));
  assert.equal(deviceClockTime(new Date(Date.parse(NOW) + 90000).toISOString(), NOW), NOW, 'small skew ahead of the server is clamped to server time');
  assert.equal(deviceClockTime(new Date(Date.parse(NOW) + 120000).toISOString(), NOW), NOW);
  assert.throws(() => deviceClockTime(new Date(Date.parse(NOW) + 121000).toISOString(), NOW), error => error.status === 409 && /ahead of the server/.test(error.message));
  for (const value of ['', 'not-a-time', '2026-02-30T10:00:00Z', 12, null]) assert.throws(() => deviceClockTime(value, NOW), error => error.status === 400);
  const entry = clockIn({ deviceCapturedAt: at(-60) });
  assert.throws(() => deviceClockTime(at(-61), NOW, entry), error => error.status === 409 && /earlier than your last recorded time/.test(error.message));
  assert.equal(deviceClockTime(at(-60), NOW, entry), at(-60));
  assert.throws(() => clockIn({ deviceCapturedAt: at(-800) }), error => error.code === 'EMPLOYEE_TIMECARD_DEVICE_TIME');
  assert.throws(() => clockIn({ deviceCapturedAt: at(5) }), /ahead of the server/);
});

test('offline breaks and clock-out use device times, submit for approval, and replays do not stamp twice', () => {
  const started = clockIn({ deviceCapturedAt: at(-240) }, ON, at(-235));
  const onBreak = update(started, { breaks: [{ startAt: 'phone', endAt: '' }], deviceCapturedAt: at(-120) }, at(-10));
  assert.deepEqual(onBreak.breaks, [{ startAt: at(-120), endAt: '' }]); assert.equal(onBreak.updatedAt, at(-10));
  assert.deepEqual(onBreak.deviceTimeEvents.map(event => [event.action, event.recordedAt, event.receivedAt]), [['clock_in', at(-240), at(-235)], ['break', at(-120), at(-10)]]);
  const replay = update(onBreak, { breaks: [{ startAt: 'phone', endAt: '' }], deviceCapturedAt: at(-120) }, at(-5));
  assert.equal(replay.deviceTimeEvents.length, 2, 'a replayed break start is a no-op');
  assert.throws(() => update(onBreak, { breaks: [{ startAt: at(-120), endAt: at(-121) }], deviceCapturedAt: at(-121) }, at(-5)), /earlier than your last recorded time/);
  const back = update(onBreak, { breaks: [{ startAt: at(-120), endAt: 'phone' }], deviceCapturedAt: at(-90) }, at(-4));
  assert.equal(back.breaks[0].endAt, at(-90));
  const closed = update(back, { clockOutAt: 'phone', status: 'submitted', deviceCapturedAt: at(-60) }, NOW);
  assert.equal(closed.clockOutAt, at(-60)); assert.equal(closed.status, 'submitted'); assert.equal(closed.approvalStatus, 'pending');
  assert.equal(closed.hours, 2.5); assert.equal(timecardHours(closed), 2.5); assert.equal(closed.grossEstimate, 50);
  assert.equal(activeJobSegment(closed), null); assert.equal(closed.jobTracking.segments[0].endedAt, at(-60));
  assert.equal(closed.needsReview, true); assert.equal(closed.deviceTimeEvents.at(-1).action, 'clock_out');
  assert.strictEqual(update(closed, { clockOutAt: 'phone', status: 'submitted', deviceCapturedAt: at(-60) }, at(5)), closed, 'a replayed clock-out keeps the submitted card');
  const open = update(clockIn({ deviceCapturedAt: at(-30) }), { breaks: [{ startAt: 'phone', endAt: '' }], deviceCapturedAt: at(-20) }, at(-1));
  const auto = update(open, { clockOutAt: 'phone', status: 'submitted', deviceCapturedAt: at(-10) }, NOW);
  assert.equal(auto.breaks[0].endAt, at(-10), 'an open break ends at the offline clock-out time');
});

test('offline job switches start at the device time, and a receipt replay stays a no-op after later events', () => {
  const started = clockIn({ deviceCapturedAt: at(-90) }), requestId = crypto.randomUUID();
  const action = { requestId, expectedSegmentId: activeJobSegment(started).id, jobId: 'job-a', kind: 'travel', deviceCapturedAt: at(-80) };
  const switched = authorizeTimecard({ session: crew, manager: false, id: 'shift', existing: started, incoming: { jobAction: action }, now: at(-1), env: ON });
  assert.equal(activeJobSegment(switched).id, requestId); assert.equal(activeJobSegment(switched).startedAt, at(-80));
  assert.equal(switched.jobTracking.segments[0].endedAt, at(-80)); assert.equal(switched.updatedAt, at(-1));
  assert.equal(switched.deviceTimeEvents.at(-1).action, 'job_time');
  const later = update(switched, { breaks: [{ startAt: 'phone', endAt: '' }], deviceCapturedAt: at(-30) }, at(-2));
  assert.strictEqual(authorizeTimecard({ session: crew, manager: false, id: 'shift', existing: later, incoming: { jobAction: action }, now: NOW, env: ON }), later);
  assert.throws(() => authorizeTimecard({ session: crew, manager: false, id: 'shift', existing: later, incoming: { jobAction: { ...action, requestId: crypto.randomUUID(), expectedSegmentId: requestId, deviceCapturedAt: at(-40) } }, now: NOW, env: ON }), /earlier than your last recorded time/);
  assert.throws(() => authorizeTimecard({ session: { ...crew, user: 'Crew.Two' }, manager: false, id: 'shift', existing: started, incoming: { jobAction: { ...action, requestId: crypto.randomUUID() } }, now: NOW, env: ON }), error => error.status === 403);
});

test('an approval alone never marks device times reviewed; only an explicit manager review does', () => {
  const started = clockIn({ deviceCapturedAt: at(-240) });
  const closed = update(started, { clockOutAt: 'phone', status: 'submitted', deviceCapturedAt: at(-60) }, NOW);
  const approved = authorizeTimecard({ session: manager, manager: true, id: 'shift', existing: closed, incoming: { approvalStatus: 'approved' }, now: at(30), env: ON });
  assert.equal(approved.approvalStatus, 'approved'); assert.equal(approved.needsReview, true, 'routine approval does not claim the device times were reviewed');
  assert.equal(approved.deviceTimeReviewedBy, undefined); assert.equal(approved.deviceTimeReviewedAt, undefined);
  const reviewed = authorizeTimecard({ session: manager, manager: true, id: 'shift', existing: approved, incoming: { deviceTimeReviewed: true }, now: at(40), env: ON });
  assert.equal(reviewed.needsReview, false); assert.equal(reviewed.deviceTime, true); assert.equal(reviewed.approvalStatus, 'approved');
  assert.equal(reviewed.deviceTimeReviewedBy, 'ZacB'); assert.equal(reviewed.deviceTimeReviewedAt, at(40)); assert.equal(reviewed.deviceTimeEvents.length, 2);
  assert.equal(Object.hasOwn(reviewed, 'deviceTimeReviewed'), false, 'the review request is not stored as a field');
  const ordinary = authorizeTimecard({ session: manager, manager: true, id: 'shift', existing: update(clockIn({}, {}), { clockOutAt: 'x', status: 'submitted' }, at(60), {}), incoming: { approvalStatus: 'approved', deviceTimeReviewed: true }, now: at(90) });
  assert.equal(ordinary.needsReview, undefined); assert.equal(ordinary.deviceTimeReviewedBy, undefined);
});

const hash = await createHubCredentialHash('Synthetic offline clock password 927!');
const users = JSON.stringify({ 'Crew.One': { passwordHash: hash, displayName: 'Crew One', role: 'crew', hourlyRate: 20 } });
const env = flag => ({ HUB_SESSION_SECRET: 'offline-clock-session', EMPLOYEE_HUB_DATA_SECRET: 'offline-clock-vault', FIREBASE_API_KEY: 'firebase-test-offline-clock', HUB_AUTH_USERS_JSON: users, ...(flag ? { EGC_OFFLINE_CLOCK_ENABLED: flag } : {}) });
async function hub(t, flag) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  storage(t);
  const settings = env(flag), cookie = (await createHubSessionCookie(settings, 'Crew.One')).split(';')[0], url = 'https://easygaragecleaning.com/api/employee-hub';
  return {
    post: async (id, data) => onRequestPost({ env: settings, request: new Request(url, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ collection: 'timeEntries', id, data }) }) }),
    own: async () => (await onRequestGet({ env: settings, request: new Request(`${url}?view=own-job-time`, { headers: { Cookie: cookie } }) })).json(),
  };
}

test('the Employee Hub API honors device times only when EGC_OFFLINE_CLOCK_ENABLED is true', async t => {
  const off = await hub(t, '');
  const stale = await off.post('offline-off', { locationTracking: true, lastLocation: point, deviceCapturedAt: at(-20) });
  assert.equal(stale.status, 409); assert.deepEqual(await stale.json(), { ok: false, code: 'EMPLOYEE_TIMECARD_DEVICE_TIME', error: 'Offline clock times are not enabled. Record it again now or ask a manager for a time correction.' });
  const fresh = await (await off.post('offline-off', { locationTracking: true, lastLocation: point, deviceCapturedAt: at(-1) })).json();
  assert.equal(fresh.ok, true); assert.equal(fresh.record.clockInAt, NOW); assert.equal(fresh.record.deviceTime, undefined);
});

test('an offline shift replays through the Employee Hub API with review flags and an exact breaks projection', async t => {
  const on = await hub(t, 'true');
  const started = await (await on.post('offline-on', { locationTracking: true, lastLocation: point, deviceCapturedAt: at(-20) })).json();
  assert.equal(started.record.clockInAt, at(-20)); assert.equal(started.record.deviceTime, true); assert.equal(started.record.needsReview, true);
  const replayed = await (await on.post('offline-on', { locationTracking: true, lastLocation: point, deviceCapturedAt: at(-20) })).json();
  assert.equal(replayed.record.clockInAt, at(-20)); assert.equal(replayed.record.deviceTimeEvents.length, 1, 'a replayed clock-in is not stamped twice');
  const rejected = await on.post('offline-on', { breaks: [{ startAt: 'phone', endAt: '' }], deviceCapturedAt: at(-30) });
  assert.equal(rejected.status, 409); assert.equal((await rejected.json()).code, 'EMPLOYEE_TIMECARD_DEVICE_TIME');
  assert.equal((await on.post('offline-on', { breaks: [{ startAt: 'phone', endAt: '' }], deviceCapturedAt: at(-10) })).status, 200);
  const own = await on.own();
  assert.deepEqual(own.entry.breaks, [{ startAt: at(-10), endAt: '' }]); assert.equal(own.entry.onBreak, true); assert.equal(own.entry.deviceTime, true);
  assert.equal(JSON.stringify(own).includes('hourlyRate'), false);
  const closed = await (await on.post('offline-on', { clockOutAt: 'phone', status: 'submitted', deviceCapturedAt: at(-5) })).json();
  assert.equal(closed.record.clockOutAt, at(-5)); assert.equal(closed.record.approvalStatus, 'pending'); assert.equal(closed.record.breaks[0].endAt, at(-5));
  assert.equal((await on.own()).entry, null);
});
