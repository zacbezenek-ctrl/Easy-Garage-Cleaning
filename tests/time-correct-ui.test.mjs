process.env.TZ = 'Asia/Tokyo';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hubPage, NOW } from './helpers/hub-dom.mjs';
import { timesheetHandlers } from '../functions/api/timesheets.js';
import { authorizeTimecard } from '../functions/_lib/employee-timecards.js';
import { visiblePay } from '../functions/_lib/pay-visibility.js';

// TIME-CORRECT on the Hub: the Time approvals board and Command center with EGC_TIMECARD_CORRECTIONS off and on, the
// Correct time / Close shift dialog against the real timecard rules, and the server totals in the payroll week card.
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const PEOPLE = ['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads'];
const settle = async () => { for (let index = 0; index < 30; index++) await new Promise(resolve => setImmediate(resolve)); };
const at = (date, time, offset = '-06:00') => `${date}T${time}:00${offset}`;
const iso = value => new Date(value).toISOString();
const card = (id, employee, clockInAt, clockOutAt, extra = {}) => ({ id, employee, employeeName: `Synthetic ${employee}`, payType: 'hourly', hourlyRate: 20, clockInAt, clockOutAt, status: clockOutAt ? 'submitted' : 'active', approvalStatus: clockOutAt ? 'approved' : 'open', breaks: [], updatedAt: `${id}-v1`, ...extra });
const clockAt = now => class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } };

// A viewer's Hub on the timesheet screen, served by the real /api/timesheets handler and the real timecard rules.
function hub({ user = 'TylerG', role = 'manager', corrections = true, timecards, now = NOW }) {
  const session = { user, role, businessAccess: true, displayName: `Synthetic ${user}` }, env = corrections ? { EGC_TIMECARD_CORRECTIONS: 'true' } : {};
  const server = { timecards: structuredClone(timecards), posts: [] };
  const handlers = timesheetHandlers({ session: async () => session, read: async () => ({ timecards: structuredClone(server.timecards), requests: [] }), now: () => new Date(now) });
  const fetcher = async (url, init = {}) => {
    if (url.startsWith('/api/timesheets')) return handlers.get({ request: new Request('https://easygaragecleaning.com' + url), env: {} });
    if (url === '/api/employee-hub' && init.method === 'POST') {
      const body = JSON.parse(init.body), index = server.timecards.findIndex(item => item.id === body.id);
      if (body.collection !== 'timeEntries') return json({ ok: true, record: body.data });
      server.posts.push(body);
      try {
        const saved = authorizeTimecard({ session, manager: true, id: body.id, incoming: body.data, existing: server.timecards[index] || null, now: new Date(now).toISOString(), env });
        server.timecards[index] = saved;
        return json({ ok: true, record: visiblePay(session, {}, 'timeEntries', saved) });
      } catch (error) { return json({ ok: false, code: error.code, error: error.message }, error.status || 400); }
    }
    if (url.startsWith('/api/employee-hub')) return json({ ok: true, collections: { ...Object.fromEntries(PEOPLE.map(name => [name, []])), timeEntries: server.timecards.map(row => visiblePay(session, {}, 'timeEntries', structuredClone(row))) }, payVisibility: role === 'owner' ? 'all' : 'own', timecardCorrections: corrections });
    if (url.startsWith('/api/highlevel?view=command')) return json({ ok: true, pipelines: [], opportunities: [] });
    if (url.startsWith('/api/highlevel?view=walkthroughs')) return json({ ok: true, events: [] });
    if (url.startsWith('/api/integration-status')) return json({ ok: true, status: {} });
    return json({ ok: false, error: 'Synthetic service unavailable' }, 503);
  };
  const page = hubPage({ user, role, fetcher, before: context => { if (now !== NOW) context.Date = clockAt(now); } });
  for (const file of ['employee-payroll-week.js', 'employee-timecard-correct.js']) vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), page.context, { filename: file });
  const dialog = () => page.document.querySelector('.egc-timecard-correct');
  const input = (name, value) => { const node = dialog().querySelector(`[name="${name}"]`); node.value = value; node.dispatchEvent({ type: 'input' }); };
  const submit = async () => { dialog().querySelector('form').dispatchEvent({ type: 'submit', preventDefault() {} }); await settle(); };
  return { page, server, dialog, input, submit };
}
async function show(screen, view, anchor = '2026-09-21') {
  screen.page.api.install();
  await settle();
  screen.page.api.S.timesheetAnchor = anchor;
  screen.page.api.go(view);
  await settle();
  return screen.page.main();
}
// The timecard buttons carry the card's ID as data (data-timecard-id); one listener on the document acts on a click.
const rowOf = (main, id) => main.querySelectorAll('.ops-time-row').find(row => row.querySelectorAll('button').some(button => button.getAttribute('data-timecard-id') === id));
const buttons = (main, id) => (rowOf(main, id)?.querySelectorAll('button') || []).map(button => button.textContent);
const buttonOf = (main, id, label) => rowOf(main, id)?.querySelectorAll('button').find(button => button.textContent === label);
// A click as a browser delivers it: it bubbles from the button to the document, where the Hub's listener is.
const tap = (page, button) => { assert.ok(button, 'the button is shown'); page.document.dispatch({ type: 'click', target: button, preventDefault() {}, stopPropagation() {} }); };

// Week of Sep 21 (the hub-dom clock is Tuesday Sep 22, 12:00 Denver): a settled shift, one waiting for approval, a shift
// open since Monday morning (29 hours: forgotten) and one opened this morning.
const WEEK = [
  card('done', 'Crew.One', at('2026-09-21', '07:00'), at('2026-09-21', '15:00')),
  card('waiting', 'Crew.One', at('2026-09-22', '06:00'), at('2026-09-22', '10:00'), { approvalStatus: 'pending' }),
  card('forgot', 'Crew.Two', at('2026-09-21', '07:00'), '', { breaks: [{ startAt: at('2026-09-21', '12:00'), endAt: at('2026-09-21', '12:30') }] }),
  card('today', 'Crew.Three', at('2026-09-22', '08:00'), ''),
];

test('with the switch off the board keeps Approve and Reject only, lists no forgotten shift, and has no client-side exports', async () => {
  const screen = hub({ timecards: WEEK, corrections: false }), main = await show(screen, 'timesheets');
  assert.deepEqual(buttons(main, 'waiting'), ['Approve', 'Reject']);
  assert.equal(main.querySelectorAll('.ops-time-row button').some(button => /Correct time|Close shift/.test(button.textContent)), false);
  assert.equal(main.querySelector('.ops-time-attention'), null);
  assert.doesNotMatch(main.textContent, /Download CSV|Download for Gusto|crew hours/);
  screen.page.context.opsCloseShift('forgot');
  assert.equal(screen.dialog(), null, 'the dialog never opens with the switch off');
  const today = await show(screen, 'today');
  assert.doesNotMatch(today.textContent, /open over 14 hours/);
});

test('with the switch on every timecard has Correct time, an open shift has Close shift, and a shift open over 14 hours needs attention on Time approvals and the Command center', async () => {
  const screen = hub({ timecards: WEEK }), main = await show(screen, 'timesheets');
  assert.deepEqual(buttons(main, 'done'), ['Correct time']);
  assert.deepEqual(buttons(main, 'waiting'), ['Approve', 'Reject', 'Correct time']);
  assert.deepEqual(buttons(main, 'forgot'), ['Close shift', 'Correct time']);
  assert.deepEqual(buttons(main, 'today'), ['Close shift', 'Correct time']);
  const attention = main.querySelector('.ops-time-attention');
  assert.match(attention.textContent, /Needs attention/);
  assert.equal(attention.querySelectorAll('li').length, 1, 'only the shift open more than 14 hours');
  assert.match(attention.textContent, /Synthetic Crew\.Two · clocked in Mon, Sep 21, 7:00 AM · open 29\.0 h/);
  assert.deepEqual([attention.querySelector('button').getAttribute('data-timecard-action'), attention.querySelector('button').getAttribute('data-timecard-id'), attention.querySelector('button').getAttribute('onclick')], ['close', 'forgot', null]);
  // Each employee reads how many timecards are in which state, never hours or pay added up on the device.
  assert.match(main.textContent, /1 approved · 1 pending/);
  assert.match(main.textContent, /1 open/);
  const today = await show(screen, 'today');
  assert.match(today.textContent, /1 shift open over 14 hours/);
  assert.match(today.textContent, /Synthetic Crew\.Two may have forgotten to clock out/);
});

test('Close shift sends the manager update with a reason and the version it saw; the shift is then pending, off the attention list, and a retry after a lost reply reuses the request ID', async () => {
  const screen = hub({ timecards: WEEK }), { page, server, dialog, input, submit } = screen;
  const board = await show(screen, 'timesheets');
  tap(page, board.querySelector('.ops-time-attention button'));
  assert.ok(dialog(), 'the dialog opens');
  assert.match(dialog().textContent, /CLOSE SHIFT/);
  assert.match(dialog().textContent, /Clocked in Mon, Sep 21, 7:00 AM and never clocked out \(29\.00 h ago\)/);
  assert.equal(dialog().querySelector('[name="reason"]').value, 'Forgot to clock out');
  assert.equal(dialog().querySelector('[name="hourlyRate"]'), null, 'a manager gets no rate field');
  // Nothing chosen yet: the dialog says what to fix and sends nothing.
  await submit();
  assert.match(dialog().querySelector('[role="alert"]').textContent, /Enter the clock-out date and time/);
  assert.equal(server.posts.length, 0);
  input('clockOut', '2026-09-21T16:00');
  assert.match(dialog().querySelector('.tc-preview').textContent, /8\.50 h paid time over a 9\.00 h shift with 0\.50 h unpaid breaks/);
  // The first save lands but its reply is lost: the dialog stays open, and the retry carries the same request ID, which
  // the server answers with the saved card instead of correcting it twice.
  const fetcher = page.context.hubFetch;
  page.context.hubFetch = async (url, init) => { page.context.hubFetch = fetcher; await fetcher(url, init); throw new TypeError('Synthetic network failure'); };
  await submit();
  assert.match(dialog().querySelector('[role="alert"]').textContent, /not confirmed\. Retry the same save/);
  assert.equal(dialog().querySelector('.tc-actions .primary').textContent, 'Retry the same save');
  await submit();
  assert.equal(dialog(), null, 'the dialog closes once the save is confirmed');
  assert.equal(server.posts.length, 2);
  assert.equal(server.posts[1].data.correction.requestId, server.posts[0].data.correction.requestId);
  assert.equal(server.timecards.find(item => item.id === 'forgot').history.filter(item => item.action === 'manager_shift_close').length, 1, 'corrected once');
  const body = server.posts[0];
  assert.deepEqual([body.collection, body.id, Object.keys(body.data).sort(), body.data.clockOutAt], ['timeEntries', 'forgot', ['clockOutAt', 'correction'], iso(at('2026-09-21', '16:00'))]);
  assert.deepEqual({ ...body.data.correction, requestId: 'uuid' }, { kind: 'close', reason: 'Forgot to clock out', expectedUpdatedAt: 'forgot-v1', requestId: 'uuid' });
  assert.match(body.data.correction.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(page.toasts.includes('Shift closed. It is waiting for approval.'));
  const saved = server.timecards.find(item => item.id === 'forgot');
  assert.deepEqual([saved.approvalStatus, saved.hours, saved.history.at(-1).reason], ['pending', 8.5, 'Forgot to clock out']);
  await settle();
  const main = page.main();
  assert.equal(main.querySelector('.ops-time-attention'), null, 'no forgotten shift left');
  assert.deepEqual(buttons(main, 'forgot'), ['Approve', 'Reject', 'Correct time']);
});

test('Correct time sends a time left as shown as the exact instant it was, even in the hour daylight saving repeats, and refuses a typed time that happens twice', async () => {
  // Fall back, Nov 1 2026: a night shift from 22:00 MDT to 01:30 MST (the second 01:30), four and a half hours.
  const later = Date.parse('2026-11-02T18:00:00.000Z'), night = card('night', 'Crew.One', '2026-11-01T04:00:00.000Z', '2026-11-01T08:30:00.000Z', { approvalStatus: 'pending' });
  const screen = hub({ timecards: [night], now: later }), { page, server, dialog, input, submit } = screen;
  await show(screen, 'timesheets', '2026-10-26');
  page.context.opsCorrectTime('night');
  assert.match(dialog().textContent, /CORRECT TIME/);
  assert.deepEqual([dialog().querySelector('[name="clockIn"]').value, dialog().querySelector('[name="clockOut"]').value], ['2026-10-31T22:00', '2026-11-01T01:30']);
  assert.match(dialog().querySelector('.tc-preview').textContent, /4\.50 h paid time over a 4\.50 h shift/);
  // A lunch the crew member forgot to record, and the reason.
  dialog().querySelectorAll('button').find(button => button.textContent === 'Add break').click();
  input('break-0-start', '2026-10-31T23:00');
  input('break-0-end', '2026-11-01T01:40');
  input('reason', 'Lunch not recorded');
  await submit();
  assert.match(dialog().querySelector('[role="alert"]').textContent, /break 1 end happens twice or not at all/);
  assert.equal(server.posts.length, 0);
  input('break-0-end', '2026-10-31T23:30');
  assert.match(dialog().querySelector('.tc-preview').textContent, /4\.00 h paid time over a 4\.50 h shift with 0\.50 h unpaid breaks/);
  await submit();
  assert.equal(dialog(), null);
  const data = server.posts[0].data;
  assert.deepEqual([data.clockInAt, data.clockOutAt, data.breaks, data.correction.kind, data.correction.reason], ['2026-11-01T04:00:00.000Z', '2026-11-01T08:30:00.000Z', [{ startAt: '2026-11-01T05:00:00.000Z', endAt: '2026-11-01T05:30:00.000Z' }], 'correct', 'Lunch not recorded']);
  assert.equal(Object.hasOwn(data, 'jobId') || Object.hasOwn(data, 'hourlyRate'), false, 'an unchanged job and rate are not sent');
  assert.equal(server.timecards[0].hours, 4);
});

test('the owner’s dialog has the rate; a change is sent and saved, while a timecard changed since it was shown is refused with a way out', async () => {
  const screen = hub({ user: 'ZacB', role: 'owner', timecards: WEEK }), { page, server, dialog, input, submit } = screen;
  await show(screen, 'timesheets');
  page.context.opsCorrectTime('done');
  assert.equal(dialog().querySelector('[name="hourlyRate"]').value, '20');
  assert.equal(dialog().querySelector('[name="hourlyRate"]').getAttribute('inputMode') ?? dialog().querySelector('[name="hourlyRate"]').inputMode, 'decimal');
  input('hourlyRate', '22.50');
  input('reason', 'Rate update');
  // Meanwhile the card changes on the server: the correction is refused and the dialog offers only Close.
  server.timecards[0] = { ...server.timecards[0], updatedAt: 'done-v2' };
  await submit();
  assert.match(dialog().querySelector('[role="alert"]').textContent, /changed since you opened it/);
  assert.deepEqual(dialog().querySelectorAll('.tc-actions button').map(button => button.textContent), ['Close']);
  dialog().querySelector('.tc-actions button').click();
  assert.equal(dialog(), null);
  await page.api.loadAll();
  await settle();
  page.context.opsCorrectTime('done');
  input('hourlyRate', '22.50');
  input('reason', 'Rate update');
  await submit();
  assert.equal(dialog(), null);
  assert.equal(server.posts.at(-1).data.hourlyRate, 22.5);
  assert.deepEqual([server.timecards[0].hourlyRate, server.timecards[0].grossEstimate, server.timecards[0].approvalStatus], [22.5, 180, 'pending']);
});

test('the payroll week card is the board’s totals: a 56-hour week at $22 pays the overtime engine’s $1,408, and pending and open time are listed, not added in', async () => {
  // Maria worked seven 8-hour days (Sep 14-20) at $22; one more evening shift waits for approval; Crew One has been
  // clocked in since Sunday evening. The old board said 56 h and $1,232 (straight time), with the open shift added in.
  const maria = [14, 15, 16, 17, 18, 19, 20].map(day => card(`maria-${day}`, 'Maria.Synthetic', at(`2026-09-${day}`, '07:00'), at(`2026-09-${day}`, '15:00'), { employeeName: 'Maria Synthetic', hourlyRate: 22 }));
  const timecards = [...maria, card('maria-late', 'Maria.Synthetic', at('2026-09-15', '16:00'), at('2026-09-15', '20:00'), { employeeName: 'Maria Synthetic', hourlyRate: 22, approvalStatus: 'pending' }), card('crew-open', 'Crew.One', at('2026-09-20', '20:00'), '', { employeeName: 'Crew One', hourlyRate: 19 })];
  for (const [user, role] of [['ZacB', 'owner'], ['TylerG', 'manager']]) {
    const screen = hub({ user, role, timecards }), main = await show(screen, 'timesheets', '2026-09-14');
    const week = main.querySelector('.egc-payroll-week'), rows = week.querySelectorAll('.pw-rows > li'), mariaRow = rows.find(row => /Maria Synthetic/.test(row.textContent)), crewRow = rows.find(row => /Crew One/.test(row.textContent));
    assert.match(mariaRow.textContent, /56\.00 paid h · 40\.00 regular · 16\.00 overtime/);
    assert.match(mariaRow.textContent, /Not in totals: 4\.00 h in 1 pending timecard/);
    assert.match(crewRow.textContent, /0\.00 paid h/);
    assert.match(crewRow.textContent, /Not in totals: 1 open shift \(40\.00 h so far\)/);
    const total = week.querySelector('.pw-total').textContent;
    assert.match(total, /56\.00 paid h · 40\.00 regular · 16\.00 overtime/);
    assert.match(total, /Not in totals: 4\.00 h in 1 pending timecard · 1 open shift \(40\.00 h so far\)/);
    assert.doesNotMatch(main.textContent, /\$1,232/, `${role}: no straight-time total anywhere`);
    if (role === 'owner') {
      assert.match(mariaRow.textContent, /\$1,408\.00/);
      assert.match(total, /\$1,408\.00/);
    } else {
      assert.match(mariaRow.textContent, /Pay hidden/);
      assert.doesNotMatch(week.textContent, /\$1,408/, 'a manager gets hours only');
    }
  }
});

// A crew device chooses its timecard's ID at clock-in. One carrying a quote must stay data on the manager's board: the
// old buttons put it inside onclick="opsCloseShift('…')", where the browser decodes &#39; back to a quote before running it.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const runInline = (page, root) => { for (const node of root.querySelectorAll('button')) { const code = node.getAttribute('onclick'); if (code) try { vm.runInContext(code, page.context); } catch {} } };

test('a crew-created timecard ID with quotes is only data: Close shift, Correct time and Approve act on that exact ID and none of it runs as script', async () => {
  const open = `x');globalThis.pwned='close';('`, waiting = `y');globalThis.pwned='approve';('`;
  const timecards = [card(open, 'Crew.Evil', at('2026-09-21', '07:00'), ''), card(waiting, 'Crew.Evil', at('2026-09-22', '06:00'), at('2026-09-22', '10:00'), { approvalStatus: 'pending' })];
  const screen = hub({ timecards }), { page, server, dialog, input, submit } = screen, main = await show(screen, 'timesheets');
  // The probe catches the old markup: an inline handler built with esc() runs the crew member's script.
  const probe = page.document.createElement('div');
  probe.innerHTML = `<button onclick="opsCloseShift('${esc(open)}')">Close shift</button>`;
  runInline(page, probe);
  assert.equal(page.context.pwned, 'close', 'the probe reproduces the old flaw');
  delete page.context.pwned;
  page.api.render(true);
  assert.deepEqual(buttons(main, open), ['Close shift', 'Correct time']);
  assert.deepEqual(buttons(main, waiting), ['Approve', 'Reject', 'Correct time']);
  assert.equal(main.querySelector('.ops-time-attention button').getAttribute('data-timecard-id'), open);
  // No timecard button has an inline handler, and running every inline handler the board has runs none of the ID.
  assert.equal([...main.querySelectorAll('.ops-time-row button'), ...main.querySelectorAll('.ops-time-attention button')].some(button => button.hasAttribute('onclick')), false);
  for (const region of [...main.querySelectorAll('.ops-timesheets'), ...main.querySelectorAll('.ops-time-attention')]) runInline(page, region);
  assert.equal(page.context.pwned, undefined);
  // Correct time and Close shift open the dialog for that exact card; the close is saved under its exact ID.
  tap(page, buttonOf(main, open, 'Correct time'));
  assert.match(dialog().textContent, /CORRECT TIME/);
  assert.match(dialog().querySelector('h2').textContent, /Synthetic Crew\.Evil · Mon, Sep 21/);
  dialog().querySelector('.tc-actions button').click();
  tap(page, main.querySelector('.ops-time-attention button'));
  input('clockOut', '2026-09-21T15:00');
  await submit();
  assert.equal(dialog(), null);
  assert.deepEqual([server.posts.at(-1).id, server.posts.at(-1).data.correction.kind], [open, 'close']);
  // Approve saves the waiting card under its exact ID.
  const board = page.main();
  tap(page, buttonOf(board, waiting, 'Approve'));
  await settle();
  assert.deepEqual([server.posts.at(-1).id, server.posts.at(-1).data.approvalStatus], [waiting, 'approved']);
  assert.equal(server.timecards.find(item => item.id === waiting).approvalStatus, 'approved');
  assert.equal(page.context.pwned, undefined, 'no click ran the crew member’s text');
});

test('an unconfirmed correction outlives the dialog and a reload: reopening that timecard offers Retry the same save with the same request ID and body, which the server answers with the saved card', async () => {
  const screen = hub({ timecards: WEEK }), { page, server, dialog, input, submit } = screen;
  let main = await show(screen, 'timesheets');
  tap(page, buttonOf(main, 'waiting', 'Correct time'));
  input('clockOut', '2026-09-22T11:00');
  input('reason', 'Left at eleven');
  // The save lands but its reply is lost; the manager closes the dialog.
  const fetcher = page.context.hubFetch;
  page.context.hubFetch = async (url, init) => { page.context.hubFetch = fetcher; await fetcher(url, init); throw new TypeError('Synthetic network failure'); };
  await submit();
  assert.match(dialog().querySelector('[role="alert"]').textContent, /not confirmed/);
  dialog().querySelector('.tc-actions button').click();
  assert.equal(dialog(), null);
  const key = 'egc.timecardCorrect.pending.v1.tylerg', stored = JSON.parse(page.session.getItem(key));
  assert.deepEqual(Object.keys(stored), ['waiting']);
  assert.equal(stored.waiting.requestId, server.posts[0].data.correction.requestId);
  // Reload: a new page for the same signed-in manager, and the board now shows the card as the save left it.
  const next = hub({ timecards: server.timecards });
  next.page.session.setItem(key, page.session.getItem(key));
  main = await show(next, 'timesheets');
  assert.notEqual(next.server.timecards.find(item => item.id === 'waiting').updatedAt, 'waiting-v1', 'the card changed with the lost save');
  tap(next.page, buttonOf(main, 'waiting', 'Correct time'));
  assert.match(next.dialog().querySelector('[role="alert"]').textContent, /Your last save here was not confirmed\. Retry the same save/);
  assert.equal(next.dialog().querySelector('.tc-actions .primary').textContent, 'Retry the same save');
  assert.deepEqual([next.dialog().querySelector('[name="clockOut"]').value, next.dialog().querySelector('[name="reason"]').value], ['2026-09-22T11:00', 'Left at eleven']);
  await next.submit();
  assert.equal(next.dialog(), null, 'confirmed, not refused as changed');
  assert.deepEqual(next.server.posts[0].data, server.posts[0].data, 'the same body and request ID');
  assert.equal(next.server.timecards.find(item => item.id === 'waiting').history.filter(item => item.action === 'manager_time_correction').length, 1, 'corrected once');
  assert.ok(next.page.toasts.includes('Timecard corrected. It is waiting for approval.'));
  assert.equal(next.page.session.getItem(key), null, 'a confirmed save is forgotten');
  // Editing a field instead makes a new save; sign-out forgets what is kept.
  next.page.session.setItem(key, page.session.getItem(key));
  tap(next.page, buttonOf(next.page.main(), 'waiting', 'Correct time'));
  next.input('reason', 'Left at eleven, per crew text');
  assert.equal(next.dialog().querySelector('.tc-actions .primary').textContent, 'Save correction');
  next.dialog().querySelector('.tc-actions button').click();
  next.page.fire('egc:signout');
  assert.equal(next.page.session.getItem(key), null);
});

test('Correct time on a shift still running says so, and with a paid rest break the preview names both the paid time and the timecard’s hours', async () => {
  const screen = hub({ timecards: WEEK }), { page, dialog, input } = screen, main = await show(screen, 'timesheets');
  tap(page, buttonOf(main, 'today', 'Correct time'));
  assert.match(dialog().querySelector('.tc-summary').textContent, /^Clocked in Tue, Sep 22, 8:00 AM and still clocked in \(4\.00 h so far\)\. Saving sets the clock-out, which ends the shift\.$/);
  assert.doesNotMatch(dialog().textContent, /never clocked out/);
  assert.match(dialog().textContent, /Sets the timecard’s job\. Job time comes from the crew’s job segments, which this does not move\./);
  input('clockOut', '2026-09-22T12:00');
  dialog().querySelectorAll('button').find(button => button.textContent === 'Add break').click();
  input('break-0-start', '2026-09-22T10:00');
  input('break-0-end', '2026-09-22T10:15');
  const paid = dialog().querySelector('.tc-break input[type="checkbox"]');
  paid.checked = true;
  paid.dispatchEvent({ type: 'change', target: paid });
  assert.equal(dialog().querySelector('.tc-preview').textContent, '4.00 h paid time over a 4.00 h shift. The timecard row shows 3.75 h: its hours leave out the 0.25 h of paid rest breaks too, which payroll pays.');
  dialog().querySelector('.tc-actions button').click();
  // A forgotten shift (over 14 hours) still reads as never clocked out.
  tap(page, buttonOf(main, 'forgot', 'Correct time'));
  assert.match(dialog().querySelector('.tc-summary').textContent, /never clocked out \(29\.00 h ago\)/);
});
