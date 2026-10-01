import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  addBusinessMinutes, businessMinutesBetween, comparisonPeriod, denverDate, denverDayStart, denverWeekStart, funnelPeriod,
  holidayOn, holidaysForYear, isBusinessTime, wallClockInstant, webLeadTiming,
} from '../functions/_lib/funnel-calendar.js';
import { funnelDefinitions } from '../functions/_lib/funnel-definitions.js';

// Fixed instants only; nothing here reads the real clock.
const NOW = '2026-09-22T18:00:00.000Z'; // Tuesday 12:00 MDT

// The pre-FUN-01 web-lead leadTiming(), verbatim except that the instant is a
// parameter instead of new Date(). It is the oracle for byte-identical output.
function legacyLeadTiming(now) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver', weekday: 'short', hour: 'numeric', hour12: false,
    }).formatToParts(now);
    const wd = parts.find((p) => p.type === 'weekday').value;
    let hr = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    if (hr === 24) hr = 0;
    return (wd !== 'Sun' && hr >= 7 && hr < 19) ? 'in-hours' : 'out-of-hours';
  } catch { return 'in-hours'; }
}

test('US federal holidays fall on their actual dates, including last-Monday and nth-weekday rules', () => {
  assert.deepEqual(holidaysForYear(2026).map(item => `${item.date} ${item.id}`), [
    '2026-01-01 new_years_day', '2026-01-19 martin_luther_king_jr_day', '2026-02-16 washingtons_birthday', '2026-05-25 memorial_day',
    '2026-06-19 juneteenth', '2026-07-04 independence_day', '2026-09-07 labor_day', '2026-10-12 columbus_day',
    '2026-11-11 veterans_day', '2026-11-26 thanksgiving_day', '2026-12-25 christmas_day',
  ]);
  const y2027 = Object.fromEntries(holidaysForYear(2027).map(item => [item.id, item.date]));
  assert.equal(y2027.memorial_day, '2027-05-31'); assert.equal(y2027.thanksgiving_day, '2027-11-25'); assert.equal(y2027.martin_luther_king_jr_day, '2027-01-18');
  assert.equal(holidayOn('2026-07-04'), 'independence_day', 'observed on the actual Saturday, when EGC would otherwise work');
  assert.equal(holidayOn('2026-07-03'), null);
  assert.equal(Object.isFrozen(holidaysForYear(2026)), true);
  assert.throws(() => holidaysForYear(1969), error => error.code === 'funnel_calendar_invalid');
});

test('business hours are Mon–Sat 07:00–19:00 Denver, by the Denver wall clock at any process timezone', () => {
  assert.equal(isBusinessTime('2026-09-22T12:59:59.999Z'), false); // 06:59:59.999 MDT
  assert.equal(isBusinessTime('2026-09-22T13:00:00.000Z'), true);  // 07:00 MDT
  assert.equal(isBusinessTime('2026-09-23T00:59:59.999Z'), true);  // 18:59:59.999 MDT
  assert.equal(isBusinessTime('2026-09-23T01:00:00.000Z'), false); // 19:00 MDT
  assert.equal(isBusinessTime('2026-12-15T14:00:00.000Z'), true);  // 07:00 MST
  assert.equal(isBusinessTime('2026-12-15T13:59:00.000Z'), false);
  assert.equal(isBusinessTime('2026-09-27T18:00:00.000Z'), false, 'Sunday');
  assert.equal(isBusinessTime('2026-09-26T18:00:00.000Z'), true, 'Saturday');
  assert.equal(isBusinessTime('2026-11-26T18:00:00.000Z'), false, 'Thanksgiving');
  assert.equal(isBusinessTime('2026-11-26T18:00:00.000Z', { holidays: false }), true);
  assert.equal(isBusinessTime(new Date('2026-09-22T18:00:00.000Z')), true);
  assert.equal(isBusinessTime(Date.parse('2026-09-22T18:00:00.000Z')), true);
  assert.throws(() => isBusinessTime('2026-09-22 18:00'), error => error.code === 'funnel_calendar_invalid');
  const probe = `import('${new URL('../functions/_lib/funnel-calendar.js', import.meta.url).href}').then(c=>console.log(JSON.stringify([c.isBusinessTime('2026-09-22T12:59:59.999Z'),c.isBusinessTime('2026-09-22T13:00:00.000Z'),c.denverDate('2026-09-23T05:59:59.999Z'),c.funnelPeriod('wtd','2026-11-02T06:30:00.000Z').startAt,c.wallClockInstant('2026-03-08','02:30')])))`;
  for (const TZ of ['Asia/Tokyo', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env: { ...process.env, TZ } }).trim(), JSON.stringify([false, true, '2026-09-22', '2026-10-26T06:00:00.000Z', '2026-03-08T09:00:00.000Z']), TZ);
  }
});

test('web-lead lead_timing on the shared calendar is identical to the legacy rule at every opening and closing of 2026 and through DST and holiday weeks', () => {
  let compared = 0;
  const same = ms => { const now = new Date(ms); assert.equal(webLeadTiming(now), legacyLeadTiming(now), now.toISOString()); compared += 1; };
  // Every day: both sides of 07:00 and 19:00 under either Denver offset (UTC-6 and UTC-7), computed without the code under test.
  for (let day = Date.UTC(2026, 0, 1); day < Date.UTC(2027, 0, 1); day += 86400000) {
    for (const hour of [7, 19]) for (const offset of [6, 7]) { const edge = day + (hour + offset) * 3600000; same(edge - 1); same(edge); }
  }
  // Every quarter hour of the weeks with the DST changes, a Saturday holiday and Thanksgiving.
  for (const start of ['2026-03-02', '2026-06-29', '2026-10-26', '2026-11-23']) {
    for (let ms = Date.parse(`${start}T00:00:00.000Z`), end = ms + 8 * 86400000; ms < end; ms += 15 * 60000) same(ms);
  }
  assert.equal(compared, 365 * 8 + 4 * 8 * 96);
  const edges = ['2026-03-08T08:59:59.999Z', '2026-03-08T09:00:00.000Z', '2026-03-09T12:59:59.999Z', '2026-03-09T13:00:00.000Z', '2026-11-01T07:30:00.000Z', '2026-11-01T08:30:00.000Z',
    '2026-11-02T13:59:59.999Z', '2026-11-02T14:00:00.000Z', '2026-11-26T18:00:00.000Z', '2026-07-04T18:00:00.000Z', '2026-12-25T15:00:00.000Z', '2026-09-26T00:59:59.999Z', '2026-09-26T01:00:00.000Z'];
  for (const at of edges) assert.equal(webLeadTiming(new Date(at)), legacyLeadTiming(new Date(at)), at);
  assert.equal(webLeadTiming(new Date(NaN)), 'in-hours', 'an unusable clock still promises the quick call, as before');
  assert.equal(legacyLeadTiming(new Date(NaN)), 'in-hours');
});

// The relay fixtures from tests/operations-suite.test.mjs (booking with SMS consent, client hub help).
const FIXTURES = [
  { name: 'New Customer', phone: '9705550199', email: 'new@example.com', items: 'Garage cleanout', service_type: 'Garage Cleanout', job_size: 'Medium garage', what_to_remove: 'Boxes and furniture', photo_description: 'Full two-car garage', source: 'Website', city: 'Fort Collins', serviceZip: '80525', preferred_date: '2026-09-10', preferred_timing: 'Morning', booking_slot: 'Tomorrow AM', estimated_range: '$400–$650', flow_type: 'booking', sms_consent: 'yes', utm_source: 'facebook', utm_medium: 'paid-social', utm_campaign: 'fall-garages', page_url: 'https://easygaragecleaning.com/' },
  { name: 'Dana Customer', phone: '9705550142', email: 'dana@example.com', items: 'Please send me a fresh project link.', what_to_remove: 'Please send me a fresh project link.', service_type: 'Client hub help', source: 'Client Hub Help', flow_type: 'client_hub_help', sms_consent: 'yes', page_url: 'https://easygaragecleaning.com/customer-portal' },
];

test('the web-lead relay payload is byte-identical to the legacy output over the existing fixtures (injected clock)', async t => {
  const { onRequestPost } = await import('../functions/api/web-lead.js');
  const instants = ['2026-09-22T12:59:59.999Z', '2026-09-22T13:00:00.000Z', '2026-09-23T00:59:59.999Z', '2026-09-23T01:00:00.000Z', '2026-09-27T18:00:00.000Z', '2026-11-26T18:00:00.000Z', '2026-03-08T09:30:00.000Z', '2026-11-01T08:15:00.000Z', '2026-12-31T20:00:00.000Z'];
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(instants[0]) });
  const env = { HIGHLEVEL_API_KEY: 'synthetic-key', HIGHLEVEL_LOCATION_ID: 'location-1', HIGHLEVEL_PIPELINE_ID: 'pipe-1', HIGHLEVEL_USER_ID: 'user-1', WEBSITE_LEAD_HOOK_URL: 'https://hooks.example.test/lead' };
  const relays = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith('https://hooks.example.test/lead')) { relays.push({ url: href, body: options.body }); return new Response('{}', { status: 200 }); }
    assert.ok(href.startsWith('https://services.leadconnectorhq.com/'), href);
    if (href.endsWith('/contacts/upsert')) return Response.json({ contact: { id: 'contact-synthetic', tags: [] }, new: true });
    if (href.includes('/opportunities/pipelines?')) return Response.json({ pipelines: [{ id: 'pipe-1', stages: [{ id: 'stage-new' }] }] });
    if (href.includes('/opportunities/search?')) return Response.json({ opportunities: [], meta: { total: 0 } });
    if (href.endsWith('/opportunities/')) return Response.json({ opportunity: { id: 'opp-synthetic' } });
    return Response.json({ messageId: 'message-synthetic' });
  });
  const baseline = new Map();
  for (const at of instants) {
    t.mock.timers.setTime(Date.parse(at));
    for (const [index, fixture] of FIXTURES.entries()) {
      relays.length = 0;
      const response = await onRequestPost({ request: new Request('https://easygaragecleaning.com/api/web-lead', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(fixture) }), env });
      assert.equal(response.status, 200);
      assert.equal(relays.length, 1);
      const expected = legacyLeadTiming(new Date(at)), body = JSON.parse(relays[0].body);
      assert.equal(body.lead_timing, expected, `${at} fixture ${index}`);
      assert.equal(new URL(relays[0].url).searchParams.get('lead_timing'), expected);
      // Everything else in the relay is independent of the clock: with lead_timing normalised,
      // every instant produces the same bytes as the first one.
      const normalised = { url: relays[0].url.replace(`lead_timing=${expected}`, 'lead_timing=*'), body: relays[0].body.replace(`"lead_timing":"${expected}"`, '"lead_timing":"*"') };
      if (!baseline.has(index)) baseline.set(index, normalised);
      assert.deepEqual(normalised, baseline.get(index));
    }
  }
  assert.match(baseline.get(0).body, /^\{"name":"New Customer","phone":"9705550199",.*"lead_first_name":"New","lead_timing":"\*","lead_phone_e164":"\+19705550199"\}$/);
});

test('Denver days and Monday weeks bucket instants by the Denver wall clock across DST', () => {
  assert.equal(denverDate('2026-09-23T05:59:59.999Z'), '2026-09-22');
  assert.equal(denverDate('2026-09-23T06:00:00.000Z'), '2026-09-23');
  assert.equal(denverDate('2026-12-01T06:59:59.999Z'), '2026-11-30');
  assert.equal(denverWeekStart('2026-09-27'), '2026-09-21', 'Sunday belongs to the week that began Monday');
  assert.equal(denverWeekStart('2026-09-28'), '2026-09-28');
  assert.equal(denverDayStart('2026-03-08'), '2026-03-08T07:00:00.000Z');
  assert.equal(denverDayStart('2026-03-09'), '2026-03-09T06:00:00.000Z');
  assert.equal(denverDayStart('2026-11-02'), '2026-11-02T07:00:00.000Z');
  assert.throws(() => denverWeekStart('2026-02-30'), error => error.code === 'funnel_calendar_invalid');
});

test('wall-clock conversion resolves the spring gap forward and the fall-back repeat to the earlier instant', () => {
  assert.equal(wallClockInstant('2026-03-08', '02:30'), '2026-03-08T09:00:00.000Z', '02:30 does not exist; the first instant after the gap is 03:00 MDT');
  assert.equal(wallClockInstant('2026-03-08', '01:59:59.999'), '2026-03-08T08:59:59.999Z');
  assert.equal(wallClockInstant('2026-03-08', '03:00'), '2026-03-08T09:00:00.000Z');
  assert.equal(wallClockInstant('2026-11-01', '01:30'), '2026-11-01T07:30:00.000Z', '01:30 happens twice; the earlier (MDT) instant is used');
  assert.equal(wallClockInstant('2026-11-01', '02:00'), '2026-11-01T09:00:00.000Z');
  assert.equal(wallClockInstant('2026-07-01', '10:15:30.250'), '2026-07-01T16:15:30.250Z');
  assert.throws(() => wallClockInstant('2026-07-01', '24:00'), error => error.code === 'funnel_calendar_invalid');
});

test('business minutes skip nights, Sundays and holidays, and a start outside hours waits for the next opening', () => {
  assert.equal(businessMinutesBetween('2026-09-25T23:00:00.000Z', '2026-09-26T14:00:00.000Z'), 180, 'Fri 17:00 → Sat 08:00 MDT: 2 h Friday + 1 h Saturday');
  assert.equal(businessMinutesBetween('2026-09-26T23:00:00.000Z', '2026-09-28T14:00:00.000Z'), 180, 'Sat 17:00 → Mon 08:00, Sunday closed');
  assert.equal(businessMinutesBetween('2026-11-25T23:00:00.000Z', '2026-11-27T15:00:00.000Z'), 240, 'Wed 16:00 → Fri 08:00 MST across Thanksgiving: 3 h + 1 h');
  assert.equal(businessMinutesBetween('2026-11-25T23:00:00.000Z', '2026-11-27T15:00:00.000Z', { holidays: false }), 960);
  assert.equal(businessMinutesBetween('2026-03-02T07:00:00.000Z', '2026-03-16T06:00:00.000Z'), 2 * 6 * 12 * 60, 'two full weeks across the March DST change');
  assert.equal(businessMinutesBetween('2026-09-22T18:00:00.000Z', '2026-09-22T18:00:30.000Z'), 0.5);
  assert.equal(businessMinutesBetween(NOW, '2026-09-22T17:00:00.000Z'), 0);
  assert.equal(addBusinessMinutes('2026-09-26T00:30:00.000Z', 60), '2026-09-26T13:30:00.000Z', 'Fri 18:30 + 1h → Sat 07:30');
  assert.equal(addBusinessMinutes('2026-09-27T00:30:00.000Z', 60), '2026-09-28T13:30:00.000Z', 'Sat 18:30 + 1h → Mon 07:30');
  assert.equal(addBusinessMinutes('2026-09-27T18:00:00.000Z', 0), '2026-09-28T13:00:00.000Z', 'a Sunday finish is due from Monday opening');
  assert.equal(addBusinessMinutes('2026-11-25T23:00:00.000Z', 240), '2026-11-27T15:00:00.000Z', 'Wed 16:00 + 4 business hours → Fri 08:00 MST, skipping Thanksgiving (FUN-09 SLA)');
  assert.equal(addBusinessMinutes(NOW, 60), '2026-09-22T19:00:00.000Z');
  assert.throws(() => addBusinessMinutes(NOW, -1), error => error.code === 'funnel_calendar_invalid');
  assert.throws(() => businessMinutesBetween('2000-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), error => error.code === 'funnel_calendar_range_invalid');
});

test('pulse periods are Denver calendar ranges with an exclusive end, and in-progress periods stop at now', () => {
  const now = '2026-09-28T16:42:00.000Z'; // Monday 10:42 MDT
  const period = name => { const p = funnelPeriod(name, now); return [p.from, p.to, p.inProgress]; };
  assert.deepEqual(period('today'), ['2026-09-28', '2026-09-29', true]);
  assert.deepEqual(period('yesterday'), ['2026-09-27', '2026-09-28', false]);
  assert.deepEqual(period('wtd'), ['2026-09-28', '2026-10-05', true]);
  assert.deepEqual(period('last_week'), ['2026-09-21', '2026-09-28', false]);
  assert.deepEqual(period('mtd'), ['2026-09-01', '2026-10-01', true]);
  assert.deepEqual(period('last_month'), ['2026-08-01', '2026-09-01', false]);
  assert.deepEqual(period('qtd'), ['2026-07-01', '2026-10-01', true]);
  assert.deepEqual(period('last_quarter'), ['2026-04-01', '2026-07-01', false]);
  assert.deepEqual(period('ytd'), ['2026-01-01', '2027-01-01', true]);
  const mtd = funnelPeriod('mtd', now);
  assert.deepEqual({ startAt: mtd.startAt, endAt: mtd.endAt, elapsedThrough: mtd.elapsedThrough, asOf: mtd.asOf, timeZone: mtd.timeZone }, { startAt: '2026-09-01T06:00:00.000Z', endAt: '2026-10-01T06:00:00.000Z', elapsedThrough: now, asOf: now, timeZone: 'America/Denver' });
  assert.equal(funnelPeriod('last_month', now).elapsedThrough, '2026-09-01T06:00:00.000Z');
  const custom = funnelPeriod('custom', now, { from: '2026-09-15', to: '2026-10-15' });
  assert.deepEqual([custom.inProgress, custom.elapsedThrough], [true, now]);
  assert.equal(funnelPeriod('custom', now, { from: '2026-11-01', to: '2026-11-08' }).elapsedThrough, '2026-11-01T06:00:00.000Z', 'a future range has nothing elapsed');
  const spring = funnelPeriod('today', '2026-03-08T18:00:00.000Z'), fall = funnelPeriod('today', '2026-11-01T18:00:00.000Z');
  assert.equal(Date.parse(spring.endAt) - Date.parse(spring.startAt), 23 * 3600000);
  assert.equal(Date.parse(fall.endAt) - Date.parse(fall.startAt), 25 * 3600000);
  assert.equal(funnelPeriod('today', '2026-09-29T05:59:59.999Z').from, '2026-09-28', 'late evening Denver is still today even though UTC has rolled over');
  for (const bad of [['custom', {}], ['custom', { from: '2026-09-10', to: '2026-09-10' }], ['custom', { from: '2025-01-01', to: '2026-01-03' }], ['fortnight', {}]]) {
    assert.throws(() => funnelPeriod(bad[0], now, bad[1]), error => error.code === 'funnel_period_invalid', JSON.stringify(bad));
  }
  assert.throws(() => funnelPeriod('today', 'not a time'), error => error.code === 'funnel_calendar_invalid');
});

test('in-progress comparisons are truncated to the same elapsed day and Denver wall-clock time', () => {
  const now = '2026-09-28T16:42:00.000Z'; // Monday 10:42 MDT
  const mtd = funnelPeriod('mtd', now);
  const previous = comparisonPeriod(mtd, 'previous_period');
  assert.deepEqual([previous.from, previous.to, previous.truncated, previous.elapsedThrough], ['2026-08-01', '2026-09-01', true, '2026-08-28T16:42:00.000Z']);
  const lastYear = comparisonPeriod(mtd, 'same_period_last_year');
  assert.deepEqual([lastYear.from, lastYear.to, lastYear.elapsedThrough], ['2025-09-01', '2025-10-01', '2025-09-28T16:42:00.000Z']);
  assert.equal(comparisonPeriod(mtd, 'none'), null);
  // Today compared with yesterday across the spring change: 10:42 MDT on Mar 8 vs 10:42 MST on Mar 7.
  const afterSpring = comparisonPeriod(funnelPeriod('today', '2026-03-08T16:42:00.000Z'), 'previous_period');
  assert.deepEqual([afterSpring.from, afterSpring.elapsedThrough], ['2026-03-07', '2026-03-07T17:42:00.000Z']);
  // 02:30 on the day after the change maps into yesterday's gap: everything before 03:00 MDT counts.
  assert.equal(comparisonPeriod(funnelPeriod('today', '2026-03-09T08:30:00.000Z'), 'previous_period').elapsedThrough, '2026-03-08T09:00:00.000Z');
  // Month to date on the 31st compared with a 30-day month uses the whole prior month.
  const october = comparisonPeriod(funnelPeriod('mtd', '2026-10-31T18:00:00.000Z'), 'previous_period');
  assert.deepEqual([october.from, october.to, october.truncated, october.elapsedThrough], ['2026-09-01', '2026-10-01', false, '2026-10-01T06:00:00.000Z']);
  // Leap day compared with last year becomes Feb 28.
  const leap = comparisonPeriod(funnelPeriod('custom', '2028-03-10T18:00:00.000Z', { from: '2028-02-29', to: '2028-03-01' }), 'same_period_last_year');
  assert.deepEqual([leap.from, leap.to, leap.truncated], ['2027-02-28', '2027-03-01', false]);
  const closed = comparisonPeriod(funnelPeriod('last_week', now), 'previous_period');
  assert.deepEqual([closed.from, closed.to, closed.truncated, closed.elapsedThrough], ['2026-09-14', '2026-09-21', false, '2026-09-21T06:00:00.000Z']);
  const custom = comparisonPeriod(funnelPeriod('custom', now, { from: '2026-09-21', to: '2026-10-01' }), 'previous_period');
  assert.deepEqual([custom.from, custom.to, custom.elapsedThrough], ['2026-09-11', '2026-09-21', '2026-09-18T16:42:00.000Z']);
  const wtd = comparisonPeriod(funnelPeriod('wtd', '2026-11-04T17:00:00.000Z'), 'previous_period');
  assert.deepEqual([wtd.from, wtd.elapsedThrough], ['2026-10-26', '2026-10-28T16:00:00.000Z'], 'Wednesday 10:00 MST vs Wednesday 10:00 MDT');
  assert.throws(() => comparisonPeriod(mtd, 'last_decade'), error => error.code === 'funnel_period_invalid');
  assert.throws(() => comparisonPeriod({}, 'previous_period'), error => error.code === 'funnel_period_invalid');
});

test('same period last year keeps weekdays for day and week periods and calendar dates for the rest', () => {
  const now = '2026-09-28T16:42:00.000Z'; // Monday 10:42 MDT
  const weekday = date => new Date(`${date}T12:00:00Z`).getUTCDay();
  const lastYear = name => comparisonPeriod(funnelPeriod(name, now), 'same_period_last_year');
  const { sameLastYearAlignment, weekdayAlignedShiftDays } = funnelDefinitions().calendar.periods;
  assert.deepEqual({ ...sameLastYearAlignment, weekdayAlignedShiftDays }, { day: 'same_weekday', week: 'same_weekday', month: 'same_date', quarter: 'same_date', year: 'same_date', custom: 'same_date', weekdayAlignedShiftDays: 364 });
  // Monday is compared with Monday 2025-09-29, not the closed Sunday 2025-09-28, through the same wall-clock time.
  const today = lastYear('today');
  assert.deepEqual([today.from, today.to, today.truncated, today.elapsedThrough], ['2025-09-29', '2025-09-30', true, '2025-09-29T16:42:00.000Z']);
  assert.equal(weekday(today.from), weekday('2026-09-28'));
  const yesterday = lastYear('yesterday');
  assert.deepEqual([yesterday.from, yesterday.to, yesterday.truncated], ['2025-09-28', '2025-09-29', false]);
  assert.equal(weekday(yesterday.from), 0, 'Sunday with Sunday');
  // Week to date is a Monday–Sunday week 52 weeks back, truncated to its Monday at 10:42.
  const wtd = lastYear('wtd');
  assert.deepEqual([wtd.from, wtd.to, wtd.truncated, wtd.elapsedThrough], ['2025-09-29', '2025-10-06', true, '2025-09-29T16:42:00.000Z']);
  assert.deepEqual([weekday(wtd.from), weekday(wtd.to)], [1, 1]);
  const lastWeek = lastYear('last_week');
  assert.deepEqual([lastWeek.from, lastWeek.to, lastWeek.truncated, lastWeek.elapsedThrough], ['2025-09-22', '2025-09-29', false, '2025-09-29T06:00:00.000Z']);
  // Months, quarters, years and custom ranges stay on calendar dates.
  assert.deepEqual([lastYear('mtd').from, lastYear('mtd').to, lastYear('mtd').elapsedThrough], ['2025-09-01', '2025-10-01', '2025-09-28T16:42:00.000Z']);
  assert.deepEqual([lastYear('last_month').from, lastYear('last_month').to], ['2025-08-01', '2025-09-01']);
  assert.deepEqual([lastYear('qtd').from, lastYear('qtd').to], ['2025-07-01', '2025-10-01']);
  assert.deepEqual([lastYear('ytd').from, lastYear('ytd').to, lastYear('ytd').elapsedThrough], ['2025-01-01', '2026-01-01', '2025-09-28T16:42:00.000Z']);
  const custom = comparisonPeriod(funnelPeriod('custom', now, { from: '2026-09-28', to: '2026-09-29' }), 'same_period_last_year');
  assert.deepEqual([custom.from, custom.to], ['2025-09-28', '2025-09-29'], 'a custom range is the owner\'s own dates');
  // Across the spring change: Sunday 2026-03-08 (the change day) is compared with Sunday 2025-03-09 (last year's change day).
  const spring = comparisonPeriod(funnelPeriod('today', '2026-03-08T18:00:00.000Z'), 'same_period_last_year');
  assert.deepEqual([spring.from, spring.startAt, spring.endAt, spring.elapsedThrough], ['2025-03-09', '2025-03-09T07:00:00.000Z', '2025-03-10T06:00:00.000Z', '2025-03-09T18:00:00.000Z']);
  // Every day of 2026: the compared day is the same weekday, 52 weeks earlier.
  for (let day = Date.UTC(2026, 0, 1); day < Date.UTC(2027, 0, 1); day += 86400000) {
    const compared = comparisonPeriod(funnelPeriod('today', new Date(day + 18 * 3600000)), 'same_period_last_year');
    assert.equal(weekday(compared.from), new Date(day).getUTCDay(), compared.from);
    assert.equal(Math.round((day - Date.parse(`${compared.from}T00:00:00Z`)) / 86400000), 364);
  }
});
