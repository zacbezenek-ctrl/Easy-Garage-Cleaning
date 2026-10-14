import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet } from '../functions/api/highlevel.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { FLAG_OFF_ENV } from './helpers/ghl-track-fixture.mjs';
import { firestoreMemory } from './helpers/firestore-memory.mjs';

async function read(t, { view = 'schedule', calendars = ['cal-walk', 'cal-job'], failedCalendar = '' } = {}) {
  const calls = [];
  const memory = firestoreMemory({ fallback: async (input, options = {}) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'services.leadconnectorhq.com');
    assert.equal(options.method || 'GET', 'GET', 'calendar reads never mutate the provider');
    calls.push(url);
    if (url.pathname === '/calendars/') return Response.json({ calendars: calendars.map(id => ({ id, name: 'Synthetic customer calendar' })) });
    assert.equal(url.pathname, '/calendars/events');
    if (url.searchParams.get('calendarId') === failedCalendar) return Response.json({ message: 'Synthetic read failure' }, { status: 503 });
    return Response.json({ events: [] });
  } });
  t.mock.method(globalThis, 'fetch', (input, options) => memory.fetch(input, options));
  const cookie = (await createHubSessionCookie(FLAG_OFF_ENV, 'ZacB')).split(';')[0];
  const response = await onRequestGet({ env: FLAG_OFF_ENV, request: new Request(`https://easygaragecleaning.com/api/highlevel?view=${view}&date=2026-10-14`, { headers: { Cookie: cookie } }) });
  return { status: response.status, body: await response.json(), calls };
}

test('a missing configured job calendar is an error, never a healthy empty schedule', async t => {
  const result = await read(t, { calendars: ['cal-walk'] });
  assert.equal(result.status, 502); assert.equal(result.body.ok, false);
  assert.match(result.body.detail, /configured customer calendar is unavailable/);
  assert.equal(Object.hasOwn(result.body, 'events'), false);
  assert.equal(result.calls.some(url => url.pathname === '/calendars/events'), false);
});

test('one failed calendar event read fails the whole schedule instead of hiding missing events', async t => {
  const result = await read(t, { failedCalendar: 'cal-job' });
  assert.equal(result.status, 502); assert.equal(result.body.ok, false);
  assert.equal(Object.hasOwn(result.body, 'events'), false);
});

test('verified calendars with successful empty reads return a genuinely empty schedule', async t => {
  const result = await read(t);
  assert.equal(result.status, 200); assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.events, []); assert.equal(result.body.calendars.length, 2);
});

test('a missing configured walkthrough calendar is an error, never an empty day', async t => {
  const result = await read(t, { view: 'walkthroughs', calendars: ['cal-job'] });
  assert.equal(result.status, 502); assert.equal(result.body.ok, false);
  assert.match(result.body.detail, /configured walkthrough calendar is unavailable/);
  assert.equal(result.calls.some(url => url.pathname === '/calendars/events'), false);
});

test('a failed walkthrough event read stays unavailable', async t => {
  const result = await read(t, { view: 'walkthroughs', failedCalendar: 'cal-walk' });
  assert.equal(result.status, 502); assert.equal(result.body.ok, false);
});
