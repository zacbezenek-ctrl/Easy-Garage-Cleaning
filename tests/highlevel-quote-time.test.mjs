import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { onRequestPost } from '../functions/api/highlevel.js';

// A Game Plan sync whose quote carries a job date and wall-clock times but no instant (quote.start_at/end_at) books the
// HighLevel job appointment at that Denver time: MST (UTC-7) from November to mid-March, MDT (UTC-6) otherwise.
// Synthetic contact and calendar ids; HighLevel is a fetch stub, nothing leaves the process.
const env = {
  HIGHLEVEL_API_KEY: 'test-ghl', HIGHLEVEL_LOCATION_ID: 'location-1', HIGHLEVEL_JOB_CALENDAR_ID: 'service-calendar',
  HUB_SESSION_SECRET: 'test-quote-time', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { displayName: 'Zac', role: 'owner', passwordHash: 'test' } }),
};
const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];

async function sync(quote) {
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input), method = init.method || 'GET';
    calls.push({ path: url.pathname, method, body: init.body ? JSON.parse(init.body) : null });
    if (url.pathname === '/calendars/events') return Response.json({ events: [] });
    if (url.pathname === '/calendars/events/appointments') return Response.json({ id: 'appointment-1' });
    if (url.pathname.endsWith('/notes')) return Response.json({ note: { id: 'note-1' } });
    return Response.json({});
  };
  try {
    const request = new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Cookie: cookie },
      body: JSON.stringify({ tool: 'game_plan', client: { name: 'Test Customer', highlevel_contact_id: 'contact-1' }, quote: { total: 900, title: 'EGC Garage Service', ...quote } }) });
    const response = await onRequestPost({ env, request });
    const booked = calls.find(call => call.path === '/calendars/events/appointments' && call.method === 'POST')?.body;
    return { status: response.status, body: await response.json(), calls, booked: booked ? [booked.startTime, booked.endTime].map(at => new Date(at).toISOString()) : null };
  } finally { globalThis.fetch = original; }
}

test('a Game Plan job time without an instant books Denver time, standard in winter and daylight in summer', async () => {
  const winter = await sync({ job_date: '2026-12-10', start_time: '10:00', end_time: '12:00' });
  assert.equal(winter.status, 200);
  assert.deepEqual(winter.booked, ['2026-12-10T17:00:00.000Z', '2026-12-10T19:00:00.000Z'], '10 am MST is 17:00 UTC, not 16:00');
  const firstWinterDay = await sync({ job_date: '2026-11-02', start_time: '08:00', end_time: '09:30' });
  assert.deepEqual(firstWinterDay.booked, ['2026-11-02T15:00:00.000Z', '2026-11-02T16:30:00.000Z']);
  const summer = await sync({ job_date: '2026-09-10', start_time: '10:00', end_time: '12:00' });
  assert.deepEqual(summer.booked, ['2026-09-10T16:00:00.000Z', '2026-09-10T18:00:00.000Z'], 'summer keeps MDT');
  // A quote that carries its own instants is booked at exactly those.
  const exact = await sync({ job_date: '2026-12-10', start_time: '10:00', end_time: '12:00', start_at: '2026-12-10T17:30:00.000Z', end_at: '2026-12-10T19:30:00.000Z' });
  assert.deepEqual(exact.booked, ['2026-12-10T17:30:00.000Z', '2026-12-10T19:30:00.000Z']);
});

test('a Game Plan job time Denver skips or repeats is refused before anything is written to HighLevel', async () => {
  // 2:30 am on 2027-03-14 does not exist (clocks jump 2:00 to 3:00); 1:30 am on 2026-11-01 happens twice.
  for (const quote of [{ job_date: '2027-03-14', start_time: '02:30', end_time: '04:00' }, { job_date: '2026-11-01', start_time: '00:30', end_time: '01:30' }, { job_date: '2026-12-10', start_time: '9:00', end_time: '12:00' }]) {
    const refused = await sync(quote);
    assert.equal(refused.status, 400, `${quote.job_date} ${quote.start_time}-${quote.end_time}`);
    assert.equal(refused.body.code, 'invalid_schedule');
    assert.deepEqual(refused.calls, [], 'no contact, note, tag or appointment write');
  }
});
