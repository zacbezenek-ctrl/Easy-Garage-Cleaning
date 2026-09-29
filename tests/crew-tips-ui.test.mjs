import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// employee-crew-tips.js on the Time approvals screen: the real module in a vm with a stubbed slot, Hub fetch and download.
const source = await fs.readFile(new URL('../employee-crew-tips.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const allocation = (changes = {}) => ({ ok: true, authority: 'employee_hub', start: '2026-09-21', end: '2026-09-28', asOf: '2026-09-28T18:00:00.000Z',
  jobs: [{ jobId: 'job-1', customer: 'Synthetic <img src=x> Garage', serviceDate: '2026-09-23', tipCents: 9000, workMinutes: 240, employees: [{ employee: 'crew.alice', name: 'Synthetic Alice', minutes: 240, tipCents: 9000 }], allocatedCents: 9000, unallocatedCents: 0, reasons: [] }],
  employees: [{ employee: 'crew.alice', name: 'Synthetic Alice', minutes: 240, tipCents: 9000, jobs: 1 }], totals: { jobs: 1, tipCents: 9000, allocatedCents: 9000, unallocatedCents: 0 },
  coverage: { complete: true, asOf: '2026-09-28T18:00:00.000Z', reasons: [] }, ...changes });
const csv = '"Employee name"\r\n"Synthetic Alice"\r\n';

function fixture() {
  const host = { innerHTML: '' }, events = new Map(), calls = [], probes = [], dialogs = [], saved = [], reviewCalls = [], session = new Map();
  // probe: the GET /api/tip-allocation?config=tips answer (tips on unless a test says otherwise); probes are kept apart from the allocation reads.
  // Held tipped charges are resolved in Review queues: any read of another Hub API (such as the removed /api/tip-reviews) is recorded in reviewCalls.
  const state = { json: allocation(), csv: [], ask: async () => ({}), probe: { status: 200, body: { ok: true, authority: 'employee_hub', tips: { enabled: true } } } }, clock = { now: Date.parse('2026-09-28T18:00:00.000Z') };
  let uuids = 0;
  // The module's clock is injected: the real wall clock is never read.
  class FixedDate extends Date { static now() { return clock.now; } }
  const window = { addEventListener: (name, handler) => events.set(name, handler) };
  const sandbox = vm.createContext({
    window, URLSearchParams, Intl, Date: FixedDate, Number, String, Array, Boolean, Math, Promise, JSON, setTimeout: () => 0, clearTimeout() {},
    AbortController: class { constructor() { this.signal = {}; } abort() {} }, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}` },
    sessionStorage: { getItem: key => session.has(key) ? session.get(key) : null, setItem: (key, value) => session.set(key, String(value)), removeItem: key => session.delete(key) },
    document: { getElementById: id => id === 'ops-crew-tips' ? host : null, createElement: () => ({ click() { saved.push({ name: this.download, href: this.href }); } }) },
    Blob: class { constructor(parts, options) { this.text = parts.join(''); this.type = options.type; } },
    URL: { createObjectURL: blob => { saved.push({ blob: blob.text, type: blob.type }); return 'blob:synthetic'; }, revokeObjectURL() {} },
    hubFetch: async (path, options = {}) => {
      const url = new URL(path, 'https://easygaragecleaning.com');
      if (url.searchParams.get('config') === 'tips') {
        probes.push({ path, options });
        if (state.probe instanceof Error) throw state.probe;
        return Response.json(state.probe.body, { status: state.probe.status });
      }
      if (url.pathname !== '/api/tip-allocation') {
        reviewCalls.push({ path, options });
        return Response.json({ ok: false, error: 'Not a tip allocation read' }, { status: 404 });
      }
      calls.push({ path, options });
      if (url.searchParams.get('format') === 'csv') {
        const next = state.csv.shift() || { status: 200, text: csv };
        return next.text !== undefined ? new Response(next.text, { status: next.status, headers: { 'Content-Type': 'text/csv; charset=utf-8' } }) : Response.json(next.body, { status: next.status });
      }
      return Response.json(state.json, { status: state.json.httpStatus || 200 });
    },
  });
  vm.runInContext(source, sandbox);
  const askAction = async spec => { dialogs.push(spec); return state.ask(spec); };
  const options = { business: true, identity: 'ZacB', generation: 1, startDate: '2026-09-21', askAction };
  const query = call => Object.fromEntries(new URL(call.path, 'https://easygaragecleaning.com').searchParams);
  return { window, host, state, calls, probes, dialogs, saved, events, query, clock, reviewCalls, session, mount: changed => window.EGCCrewTips.mount({ ...options, ...changed }) };
}

test('crew tips make no request for someone without business access or without a valid week', async () => {
  const ui = fixture();
  ui.mount({ business: false }); ui.mount({ startDate: 'not-a-date' });
  await settle(); await ui.window.egcCrewTipsDownload(); await ui.window.egcCrewTipsRefresh();
  assert.deepEqual([ui.calls.length, ui.host.innerHTML], [0, '']);
  assert.equal(ui.probes.length, 0, 'not even the config probe');
});

test('the Time approvals week shows its card tips, split by crew job minutes, with every value escaped', async () => {
  const ui = fixture();
  ui.mount(); await settle();
  assert.deepEqual(ui.calls.map(call => [ui.query(call), call.options.cache]), [[{ start: '2026-09-21', end: '2026-09-28' }, 'no-store']], 'the Monday and an exclusive end one week later');
  assert.match(ui.host.innerHTML, /Crew tips for this payroll week/);
  assert.match(ui.host.innerHTML, /Received<\/span><strong>\$90\.00/);
  assert.match(ui.host.innerHTML, /Synthetic Alice<\/strong><small>240 job minutes · 1 job<\/small><\/div><strong>\$90\.00/);
  assert.match(ui.host.innerHTML, /Synthetic &lt;img src=x&gt; Garage/); assert.doesNotMatch(ui.host.innerHTML, /<img/);
  assert.match(ui.host.innerHTML, /onclick="egcCrewTipsDownload\(\)" >Download tips CSV/, 'the download is enabled');
  // Refunds reach the split only once Stripe reports them to the Hub, and disputes never do: the manager checks Stripe first.
  assert.match(ui.host.innerHTML, /a dispute never does\. Check Stripe for refunded or disputed tipped charges before exporting tips\./);
  ui.clock.now += 29000; ui.mount(); await settle();
  assert.equal(ui.calls.length, 1, 'a re-render within 30 seconds reuses the read');
  ui.clock.now += 2000; ui.mount(); await settle();
  assert.equal(ui.calls.length, 2, 'an older read is refreshed');
  ui.events.get('egc:signout')(); assert.equal(ui.host.innerHTML, '', 'signing out clears the section');
  ui.mount({ startDate: '2026-09-28' }); await settle();
  assert.deepEqual(ui.query(ui.calls.at(-1)), { start: '2026-09-28', end: '2026-10-05' });
});

test('an empty week, an unreadable week and a week with review reasons each say so', async () => {
  const empty = fixture(); empty.state.json = allocation({ jobs: [], employees: [], totals: { jobs: 0, tipCents: 0, allocatedCents: 0, unallocatedCents: 0 } });
  empty.mount(); await settle();
  assert.match(empty.host.innerHTML, /No customer card tips were received this week/); assert.match(empty.host.innerHTML, /disabled>Download tips CSV/);
  const failed = fixture(); failed.state.json = { ok: false, code: 'tip_allocation_forbidden', error: 'Only operations managers can review crew tip payroll.', httpStatus: 403 };
  failed.mount(); await settle();
  assert.match(failed.host.innerHTML, /role="alert">Only operations managers can review crew tip payroll\./); assert.match(failed.host.innerHTML, /disabled>Download tips CSV/);
  const partial = fixture(); partial.state.json = { ok: true, jobs: [] };
  partial.mount(); await settle();
  assert.match(partial.host.innerHTML, /came back incomplete/);
  const held = fixture(); held.state.json = allocation({ totals: { jobs: 1, tipCents: 9000, allocatedCents: 0, unallocatedCents: 9000 }, employees: [], coverage: { complete: false, reasons: ['untracked_job_time', 'pending_timecards'] } });
  held.state.json.jobs[0] = { ...held.state.json.jobs[0], allocatedCents: 0, unallocatedCents: 9000, reasons: ['untracked_job_time'] };
  held.mount(); await settle();
  assert.match(held.host.innerHTML, /Before exporting tips/); assert.match(held.host.innerHTML, /not tracked to that job/); assert.match(held.host.innerHTML, /waiting for approval/);
  assert.match(held.host.innerHTML, /\$90\.00 unassigned/);
});

test('download saves the tip CSV for the same week', async () => {
  const ui = fixture(); ui.mount(); await settle();
  await ui.window.egcCrewTipsDownload();
  assert.deepEqual(ui.query(ui.calls.at(-1)), { start: '2026-09-21', end: '2026-09-28', format: 'csv' });
  assert.deepEqual(ui.saved, [{ blob: csv, type: 'text/csv;charset=utf-8' }, { name: 'egc-customer-tips-2026-09-21-to-2026-09-27.csv', href: 'blob:synthetic' }]);
  assert.match(ui.host.innerHTML, /role="status">Tip CSV downloaded\./);
});

test('tips the Hub cannot split are exported as unassigned only after the manager confirms', async () => {
  const blocked = reasons => ({ status: 409, body: { ok: false, code: 'tip_allocation_incomplete', error: 'Some tips are on jobs where crew time was not tracked to the job, so the Hub cannot split them. Export again with acknowledge=untracked_job_time to list those tips as unassigned and pay them by hand.', details: { reasons, blocking: reasons, acknowledgeable: reasons.filter(reason => ['no_job_time', 'untracked_job_time'].includes(reason)) } } });
  const ui = fixture(); ui.mount(); await settle();
  ui.state.csv.push(blocked(['no_job_time', 'untracked_job_time']));
  await ui.window.egcCrewTipsDownload();
  assert.equal(ui.dialogs.length, 1); assert.equal(ui.dialogs[0].confirmLabel, 'Export with unassigned tips'); assert.match(ui.dialogs[0].copy, /not tracked to the job/);
  assert.deepEqual(ui.query(ui.calls.at(-1)), { start: '2026-09-21', end: '2026-09-28', format: 'csv', acknowledge: 'no_job_time,untracked_job_time' });
  assert.equal(ui.saved.at(-1).name, 'egc-customer-tips-2026-09-21-to-2026-09-27.csv');
  assert.match(ui.host.innerHTML, /Pay the unassigned tips by hand/);
  // Cancelling the confirmation downloads nothing.
  const cancel = fixture(); cancel.mount(); await settle(); cancel.state.ask = async () => null; cancel.state.csv.push(blocked(['untracked_job_time']));
  await cancel.window.egcCrewTipsDownload();
  assert.deepEqual([cancel.calls.length, cancel.saved.length], [2, 0]);
  // Unfinished time can never be confirmed away.
  const pending = fixture(); pending.mount(); await settle();
  pending.state.csv.push({ status: 409, body: { ok: false, code: 'tip_allocation_incomplete', error: 'Finish, approve or fix every timecard on the tipped jobs (and review any unreadable tip) before exporting tips for payroll.', details: { blocking: ['untracked_job_time', 'pending_timecards'], acknowledgeable: ['untracked_job_time'] } } });
  await pending.window.egcCrewTipsDownload();
  assert.deepEqual([pending.dialogs.length, pending.saved.length], [0, 0]);
  assert.match(pending.host.innerHTML, /role="alert">Finish, approve or fix every timecard/);
});

test('the Time approvals screen mounts crew tips for managers and employee.html loads the module', async () => {
  const [suite, employee] = await Promise.all(['../employee-suite.js', '../employee.html'].map(path => fs.readFile(new URL(path, import.meta.url), 'utf8')));
  assert.match(suite, /\$\{isManager\(\)\?'<div id="ops-crew-tips"><\/div>':''\}/);
  assert.match(suite, /window\.EGCCrewTips\?\.mount\(\{business:isManager\(\),identity:employeeIdentity\(\),generation:S\.peopleGeneration,startDate:range\.startDate,askAction\}\)/);
  assert.ok(employee.includes('<script src="employee-crew-tips.js?v=20260929tipsr4"></script>') && employee.includes('<link rel="stylesheet" href="employee-crew-tips.css?v=20260929tipsr4">'));
  assert.ok(employee.indexOf('employee-crew-tips.js') < employee.indexOf('employee-suite.js?v='), 'the module is defined before the suite renders');
});

test('with customer tips off, Time approvals shows no tip section and never reads the allocation', async () => {
  const ui = fixture(); ui.state.probe = { status: 200, body: { ok: true, authority: 'employee_hub', tips: { enabled: false } } };
  ui.mount(); await settle();
  assert.deepEqual([ui.probes.map(call => [ui.query(call), call.options.cache]), ui.calls.length, ui.host.innerHTML], [[[{ config: 'tips' }, 'no-store']], 0, '']);
  // Re-renders, a week change, and the buttons' handlers read nothing more.
  ui.clock.now += 120000; ui.mount(); ui.mount({ startDate: '2026-09-28' }); await settle();
  await ui.window.egcCrewTipsRefresh(); await ui.window.egcCrewTipsDownload();
  assert.deepEqual([ui.probes.length, ui.calls.length, ui.saved.length, ui.host.innerHTML], [1, 0, 0, '']);
  assert.deepEqual([ui.reviewCalls.length, ui.dialogs.length], [0, 0], 'nothing else is read or asked while tips are off');
  // Another manager signing in on the same page asks again.
  ui.events.get('egc:signout')(); ui.state.probe.body.tips.enabled = true; ui.mount({ identity: 'Manager2' }); await settle();
  assert.deepEqual([ui.probes.length, ui.calls.length], [2, 1]); assert.match(ui.host.innerHTML, /Crew tips for this payroll week/);
});

test('an unanswered or failed tips probe shows nothing and is retried after 30 seconds', async () => {
  for (const probe of [new TypeError('Failed to fetch'), { status: 503, body: { ok: false, error: 'Synthetic outage' } }, { status: 200, body: { ok: true } }]) {
    const ui = fixture(); ui.state.probe = probe;
    ui.mount(); await settle();
    assert.deepEqual([ui.probes.length, ui.calls.length, ui.host.innerHTML], [1, 0, ''], String(probe.status || probe));
    ui.clock.now += 29000; ui.mount(); await settle(); assert.equal(ui.probes.length, 1, 'not hammered');
    ui.state.probe = { status: 200, body: { ok: true, tips: { enabled: true } } };
    ui.clock.now += 2000; ui.mount(); await settle();
    assert.deepEqual([ui.probes.length, ui.calls.length], [2, 1]); assert.match(ui.host.innerHTML, /Crew tips for this payroll week/);
  }
});

test('a tipped job lists the assigned crew with no job time on it, escaped', async () => {
  const ui = fixture();
  ui.state.json = allocation({ totals: { jobs: 1, tipCents: 9000, allocatedCents: 0, unallocatedCents: 9000 }, employees: [], coverage: { complete: false, reasons: ['untracked_job_time'] } });
  ui.state.json.jobs[0] = { ...ui.state.json.jobs[0], allocatedCents: 0, unallocatedCents: 9000, reasons: ['untracked_job_time'], crewWithoutJobTime: ['dan', '<b>erin</b>'] };
  ui.mount(); await settle();
  assert.match(ui.host.innerHTML, /Assigned but no job time on this job: dan, &lt;b&gt;erin&lt;\/b&gt;/);
  assert.match(ui.host.innerHTML, /someone assigned to it has no job time on it/);
});

// Every held charge, tipped or not, is resolved in Hub > Review queues (REVIEWS-UI): Time approvals neither lists nor
// resolves them, so there is one resolve path with its owner-only refund and Stripe checks.
test('held tipped charges are not listed or resolved on Time approvals: the card points to Review queues', async () => {
  const ui = fixture(); ui.mount(); await settle();
  assert.match(ui.host.innerHTML, /Tipped card charges held for review are resolved with every other held charge in Hub › Review queues\./);
  assert.doesNotMatch(ui.host.innerHTML, /Held tipped card payments|egcCrewTipsResolve|Resolve</);
  assert.equal(typeof ui.window.egcCrewTipsResolve, 'undefined');
  ui.clock.now += 60000; ui.mount(); await ui.window.egcCrewTipsRefresh(); await settle();
  assert.deepEqual([ui.reviewCalls.length, ui.dialogs.length], [0, 0], 'only the tip allocation is read');
  assert.ok(ui.calls.every(call => new URL(call.path, 'https://easygaragecleaning.com').pathname === '/api/tip-allocation'));
  // A job whose tipped charge Stripe shows refunded is explained, never split.
  const refunded = fixture();
  refunded.state.json = allocation({ totals: { jobs: 1, tipCents: 9000, allocatedCents: 0, unallocatedCents: 9000 }, employees: [], coverage: { complete: false, reasons: ['tip_refund_open', 'tip_refunded'] } });
  refunded.state.json.jobs[0] = { ...refunded.state.json.jobs[0], employees: [], allocatedCents: 0, unallocatedCents: 9000, reasons: ['tip_refund_open'] };
  refunded.mount(); await settle();
  assert.match(refunded.host.innerHTML, /the owner has not settled yet\. Settle it in Review queues/);
  assert.match(refunded.host.innerHTML, /recorded as refunded, and its job still lists the tip\. It is held unassigned/);
  assert.match(refunded.host.innerHTML, /\$90\.00 unassigned/);
});
