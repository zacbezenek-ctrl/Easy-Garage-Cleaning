import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovedSendService, messagingFlags } from '../functions/_lib/approved-send.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { dueMessages, portalRetries, runDueMessages, stageDue, SCHEDULED_KINDS, SCHEDULER_JOB_FIELDS, CRON_ACTOR, CRON_ACTOR_ID } from '../functions/_lib/messaging-scheduler.js';
import { messagePolicy } from '../functions/_lib/message-policies.js';
import { moneyStateCents } from '../functions/_lib/money-core.js';
import { DEFAULT_MESSAGING_SETTINGS, normalizeMessagingSettings, serverMessagingEnabled } from '../functions/_lib/messaging-settings.js';
import { portalLinkProviders } from '../functions/_lib/message-links.js';
import { verifyCustomerPortalAccessToken } from '../functions/_lib/customer-portal.js';
import { env, owner, job, memoryStore, fakeGhl, clock, uuid, NOW } from './helpers/messaging-fixture.mjs';

// NOW is Tuesday 2026-09-22 12:00 in Denver (MDT); "tomorrow" is 2026-09-23.
const SETTINGS = normalizeMessagingSettings(null);
const ALL = ['day_before_reminder', 'deposit_reminder', 'estimate_expiring'];
const LINKS = Object.freeze({ payLink: async () => 'https://easygaragecleaning.com/pay/synthetic', portalLink: async () => 'https://easygaragecleaning.com/portal/synthetic' });
const code = expected => error => { assert.equal(error.code, expected); return true; };
// A job with nothing due at NOW: a December visit, a December invoice and an
// accepted estimate. Tests override only the fields that make one kind due.
const quiet = (overrides = {}) => job({ date: '2026-12-01', invoice: { number: 'INV-2001', amount: 1200, dueDate: '2026-12-31', status: 'issued' }, ...overrides });
const tomorrow = (overrides = {}) => quiet({ date: '2026-09-23', time: '09:00', deposit: { amount: 300, paidAmount: 300, verified: true }, ...overrides });
// A finished job whose issued invoice is past due. HighLevel's egc-invoice-overdue workflow chases it; the tick never does.
const unpaid = (dueDate, overrides = {}) => quiet({ status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-10T20:00:00.000Z', invoice: { number: 'INV-3001', amount: 1200, dueDate, status: 'issued' }, ...overrides });
// An accepted job on Friday 2026-09-25 with its $300 deposit unpaid: the 3-day deposit reminder is due at NOW.
const deposit = (overrides = {}) => quiet({ date: '2026-09-25', ...overrides });
const card = (amount, sessionId, verifiedAt) => ({ sessionId, amount, purpose: 'deposit', verifiedAt });
const kinds = rows => rows.map(row => `${row.kind}:${row.jobId}:${row.anchor}:${row.step}`);
const select = (jobs, at = NOW, settings = SETTINGS, only) => dueMessages(Object.entries(jobs).map(([id, fields]) => ({ ...fields, id })), { now: new Date(at), settings, ...(only ? { kinds: new Set(only) } : {}) });

// Projects a document to Firestore mask paths, as dispatchStorage.jobRecords
// does, so the scheduler cannot depend on a field it did not ask for.
function masked(row, fields) {
  const out = { id: row.id, revision: row.revision };
  for (const path of fields) {
    const [head, ...rest] = path.split('.');
    if (!(head in row)) continue;
    if (!rest.length) { out[head] = row[head]; continue; }
    let source = row[head], target = out[head] ||= {};
    for (const [index, key] of rest.entries()) {
      if (source === null || typeof source !== 'object' || !(key in source)) break;
      if (index === rest.length - 1) target[key] = source[key];
      else { target = target[key] ||= {}; source = source[key]; }
    }
  }
  return out;
}

function schedulerStore(rows) {
  const store = memoryStore(rows), scans = [];
  store.jobRecords = async fields => {
    scans.push([...fields]);
    const ids = [...store.rows.keys()].filter(key => key.startsWith('jobs/')).map(key => key.slice(5));
    return Promise.all(ids.map(async id => masked(await store.read('jobs', id), fields)));
  };
  store.scans = scans;
  return store;
}

async function setup({ jobs = {}, approved = ALL, automated = approved, at = NOW, flags = {}, ghl: ghlOptions = {}, rows = {}, links = LINKS, portal } = {}) {
  const store = schedulerStore({ ...Object.fromEntries(Object.entries(jobs).map(([id, fields]) => [`jobs/${id}`, fields])), ...rows });
  for (const kind of approved) {
    const state = await readTemplate(store, kind);
    await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind, expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
  }
  for (const kind of automated) await mutateTemplate(store, owner, { action: 'set_automation', requestId: uuid(), kind, expectedVersion: 1, enabled: true }, NOW);
  const ghl = fakeGhl(ghlOptions), time = clock(at), settings = { ...env, ...flags };
  const service = createApprovedSendService({ store, messenger: createGhlMessenger({ env: settings, fetcher: ghl.fetcher, clock: time }), clock: time, env: settings, links });
  const invites = [];
  const portalInvite = portal === undefined ? null : async (jobId, when) => { invites.push({ jobId, at: when.toISOString() }); return typeof portal === 'function' ? portal(jobId) : { status: 'submitted' }; };
  const run = (options = {}, extra = {}) => runDueMessages({ store, service, flags: messagingFlags(settings), links, portalInvite, ...extra }, { now: time(), ...options });
  const ledgers = () => [...store.rows].filter(([key]) => key.startsWith('message_sends/')).map(([, value]) => value);
  return { store, ghl, time, service, run, ledgers, invites, row: id => store.get(`jobs/${id}`) };
}

test('settings default to the owner cadence and fail closed on anything they cannot interpret', () => {
  assert.deepEqual(SETTINGS, { ...DEFAULT_MESSAGING_SETTINGS, source: 'default', depositReminderDaysBefore: [3], dayBeforeWindow: { start: '09:00', end: '19:00' } });
  assert.equal(SETTINGS.maxSendsPerTick, 25);
  const saved = normalizeMessagingSettings({ depositReminderDaysBefore: [3, 6], maxSendsPerTick: 5, revision: 'rev-9', unrelated: 'ignored' });
  assert.deepEqual([saved.source, saved.depositReminderDaysBefore, saved.maxSendsPerTick, saved.revision, saved.unrelated], ['saved', [3, 6], 5, 'rev-9', undefined]);
  // Overdue invoices are HighLevel's, so an old saved payment cadence is ignored rather than failing the tick.
  const legacy = normalizeMessagingSettings({ paymentReminderDays: 'weekly' });
  assert.deepEqual([legacy.source, 'paymentReminderDays' in legacy, 'paymentReminderDays' in DEFAULT_MESSAGING_SETTINGS], ['saved', false, false]);
  for (const bad of [{ depositReminderDaysBefore: [3, 2] }, { depositReminderDaysBefore: [1, 2] }, { depositReminderDaysBefore: [] }, { depositReminderDaysBefore: [0] }, { maxSendsPerTick: 26 }, { maxSendsPerTick: 2.5 },
    { dayBeforeWindow: { start: '07:00', end: '19:00' } }, { dayBeforeWindow: { start: '12:00', end: '11:00' } }, { dayBeforeWindow: { start: '9:00', end: '19:00' } }, { paused: 'yes' }, { estimateExpiringDaysBefore: 30 }]) {
    assert.throws(() => normalizeMessagingSettings(bad), code('messaging_settings_invalid'), JSON.stringify(bad));
  }
  assert.throws(() => normalizeMessagingSettings('corrupt'), code('messaging_settings_invalid'));
  assert.deepEqual([serverMessagingEnabled({}), serverMessagingEnabled({ EGC_SERVER_MESSAGING_ENABLED: 'TRUE' }), serverMessagingEnabled({ EGC_SERVER_MESSAGING_ENABLED: 'true' })], [false, false, true]);
});
test('reminder stages map each offset to one cadence window, including catch-up days', () => {
  const due = '2026-09-21', at = day => stageDue(due, day, [1, 7, 14], 7);
  assert.deepEqual(['2026-09-21', '2026-09-22', '2026-09-24', '2026-09-27', '2026-09-28', '2026-10-04', '2026-10-05', '2026-10-11', '2026-10-12'].map(at), [null, 1, 1, 1, 7, 7, 14, 14, null]);
  assert.deepEqual(['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03'].map(day => stageDue('2026-10-03', day, [-3], 3)), [-3, -3, -3, null]);
});

test('selection is exhaustive over the fixture kinds and honors notify, automation and contact gates', () => {
  const selected = select({
    'day-1': tomorrow(), 'day-today': tomorrow({ date: '2026-09-22' }), 'day-later': tomorrow({ date: '2026-09-24' }), 'day-cancelled': tomorrow({ status: 'cancelled', pipelineStatus: 'cancelled' }),
    'pay-1': unpaid('2026-09-21'), 'pay-due-today': unpaid('2026-09-22'), 'pay-catch-up': unpaid('2026-09-19'), 'pay-7': unpaid('2026-09-15'), 'pay-old': unpaid('2026-08-31'),
    'pay-paid': unpaid('2026-09-21', { payment: { amount: 1200, verified: true, method: 'card' } }), 'pay-review': unpaid('2026-09-21', { payment: { amount: 600 } }),
    'pay-void': unpaid('2026-09-21', { invoice: { number: 'INV-3002', amount: 1200, dueDate: '2026-09-21', status: 'void' } }), 'pay-draft': unpaid('2026-09-21', { invoice: { number: 'INV-3003', amount: 1200, dueDate: '2026-09-21' } }),
    'deposit-3': quiet({ date: '2026-09-25' }), 'deposit-2': quiet({ date: '2026-09-24', time: '' }), 'deposit-5': quiet({ date: '2026-09-27' }),
    'deposit-paid': quiet({ date: '2026-09-25', deposit: { amount: 300, paidAmount: 300, verified: true } }), 'deposit-unaccepted': quiet({ date: '2026-09-25', estimate: { number: 'EST-9', status: 'sent', amount: 1200, validUntil: '2026-12-31' } }),
    'estimate-tomorrow': quiet({ estimate: { number: 'EST-1', status: 'sent', amount: 900, validUntil: '2026-09-23' } }), 'estimate-today': quiet({ estimate: { number: 'EST-2', status: 'sent', amount: 900, validUntil: '2026-09-22' } }),
    'estimate-later': quiet({ estimate: { number: 'EST-3', status: 'sent', amount: 900, validUntil: '2026-09-25' } }), 'estimate-accepted': quiet({ estimate: { number: 'EST-4', status: 'accepted', amount: 900, validUntil: '2026-09-23' } }),
    'estimate-draft': quiet({ estimate: { number: 'EST-5', status: 'draft', amount: 900, validUntil: '2026-09-23' } }), 'estimate-expired': quiet({ estimate: { number: 'EST-6', status: 'sent', amount: 900, validUntil: '2026-09-21' } }),
    'gate-notify': tomorrow({ notify: false }), 'gate-automation': tomorrow({ customerAutomationEnabled: false }), 'gate-contact': tomorrow({ phone: '', email: '' }),
    'history-notify': quiet({ notify: false }), _egc_schedule_lock_2026_09_23: tomorrow(), 'secure_vault': tomorrow(), 'walkthrough': tomorrow({ type: 'walkthrough' }), 'recorded': tomorrow({ recordType: 'crew_availability' }),
  });
  // Overdue, partly paid and unverified invoices (pay-*) select nothing and are not suppressions: HighLevel's
  // egc-invoice-overdue workflow chases them, never the tick.
  assert.deepEqual(kinds(selected.due), [
    'day_before_reminder:day-1:2026-09-23:-1',
    'deposit_reminder:deposit-2:2026-09-24:-3', 'deposit_reminder:deposit-3:2026-09-25:-3',
    'estimate_expiring:estimate-today:2026-09-22:-1', 'estimate_expiring:estimate-tomorrow:2026-09-23:-1',
  ]);
  assert.deepEqual(selected.skipped, { job_notifications_off: 1, customer_automation_off: 1, no_contact: 1 });
  assert.equal(selected.today, '2026-09-22');
  assert.deepEqual([SCHEDULED_KINDS, messagePolicy('payment_reminder'), messagePolicy('invoice_send')], [['day_before_reminder', 'deposit_reminder', 'estimate_expiring'], null, null]);
  const only = select({ 'day-1': tomorrow(), 'deposit-3': deposit(), 'pay-1': unpaid('2026-09-21') }, NOW, SETTINGS, ['deposit_reminder']);
  assert.deepEqual(kinds(only.due), ['deposit_reminder:deposit-3:2026-09-25:-3'], 'kinds without an approved automatic template are never selected');
  assert.deepEqual(kinds(select({ 'pay-1': unpaid('2026-09-21') }, NOW, SETTINGS, ['payment_reminder']).due), [], 'an old automation switch for payment reminders selects nothing');
  const custom = select({ 'deposit-5': quiet({ date: '2026-09-27' }), 'estimate-3': quiet({ estimate: { number: 'EST-7', status: 'sent', amount: 900, validUntil: '2026-09-25' } }) }, NOW, normalizeMessagingSettings({ depositReminderDaysBefore: [5], estimateExpiringDaysBefore: 3 }));
  assert.deepEqual(kinds(custom.due), ['deposit_reminder:deposit-5:2026-09-27:-5', 'estimate_expiring:estimate-3:2026-09-25:-3']);
});

test('a reminder the legacy page-load trigger already sent is not repeated when the server takes over', async () => {
  const legacy = (id, event, marker, status, attemptedAt, source = 'automatic') => ({ id: `communication:${id}:${event}:${marker}`, event, label: 'Legacy', status, source, attemptedAt, trigger: `egc-${event}` });
  const expiring = (overrides = {}) => quiet({ estimate: { number: 'EST-1', status: 'sent', amount: 900, validUntil: '2026-09-23' }, ...overrides });
  const f = await setup({ jobs: {
    // The browser triggered the estimate-expiring reminder and marked it.
    'est-1': expiring({ automationMilestones: { 'estimate-expiring': '2026-09-23' } }),
    'est-logged': expiring({ communicationLog: [legacy('est-logged', 'estimate-expiring', '2026-09-23', 'triggered', '2026-09-22T15:00:00.000Z')] }),
    // A marker for an earlier expiry date, and a legacy trigger that never reached HighLevel.
    'est-reissued': expiring({ automationMilestones: { 'estimate-expiring': '2026-08-15' } }),
    'est-legacy-failed': expiring({ communicationLog: [legacy('est-legacy-failed', 'estimate-expiring', '2026-09-23', 'needs_attention', '2026-09-22T15:00:00.000Z')] }),
    // The page's overdue trigger and its marker are HighLevel's business: the tick neither sends nor marks.
    'pay-1': unpaid('2026-09-21', { automationMilestones: { 'invoice-overdue': '2026-09-21' }, communicationLog: [legacy('pay-1', 'invoice-overdue', '2026-09-21', 'triggered', '2026-09-22T15:00:00.000Z')] }),
    'pay-unmarked': unpaid('2026-09-21'),
  }, approved: ['estimate_expiring'] });
  const first = await f.run();
  assert.deepEqual([first.results.map(row => `${row.jobId}:${row.status}`), first.skipped], [['est-legacy-failed:submitted', 'est-reissued:submitted'], { legacy_sent: 2 }]);
  assert.deepEqual([f.row('est-1').automationMilestones, f.row('est-reissued').automationMilestones], [{ 'estimate-expiring': '2026-09-23' }, { 'estimate-expiring': '2026-09-23' }]);
  assert.deepEqual([f.row('pay-1').automationMilestones, f.row('pay-unmarked').automationMilestones, f.row('pay-unmarked').communicationLog], [{ 'invoice-overdue': '2026-09-21' }, undefined, undefined]);
  f.time.advance(15 * 60000);
  const again = await f.run();
  assert.deepEqual([again.sent, again.skipped], [0, { legacy_sent: 2 }]);
  assert.equal(f.ghl.sends().length, 2, 'the legacy reminders were never repeated and no overdue reminder was sent');
});
test('overdue, partly paid and change-billed invoices are never chased by the tick: HighLevel owns them', async () => {
  // Paid in full before a $300 change order (money-core owes $300, the checkout balance is $0), partly paid, and overdue.
  const jobs = { 'pay-change': unpaid('2026-09-21', { payment: { amount: 1200, verified: true, method: 'card' }, approvedChangeTotal: 300 }), 'pay-partial': unpaid('2026-09-15', { payment: { amount: 400, verified: true, method: 'card' } }), 'pay-1': unpaid('2026-09-21') };
  const selected = select(jobs);
  assert.deepEqual([kinds(selected.due), selected.skipped], [[], {}]);
  const f = await setup({ jobs, rows: { 'message_templates/payment_reminder': { kind: 'payment_reminder', liveVersion: 1, automation: true } } });
  for (const at of [NOW, '2026-09-29T18:00:00.000Z', '2026-10-06T18:00:00.000Z']) {
    f.time.set(at);
    const summary = await f.run();
    assert.deepEqual([summary.scanned, summary.due, summary.sent, summary.skipped, 'payment_reminder' in summary.kinds], [3, 0, 0, {}, false], at);
  }
  assert.deepEqual([f.ghl.calls.length, f.ledgers().length], [0, 0]);
  assert.ok(Object.keys(jobs).every(id => f.row(id).automationMilestones === undefined && f.row(id).communicationLog === undefined), 'the tick never marks the page\'s invoice-overdue trigger');
});
test('Denver tomorrow is DST-safe on both clock changes and ambiguous start times are never reminded', () => {
  const jobs = { 'mar-8': tomorrow({ date: '2026-03-08', time: '09:00' }), 'mar-9': tomorrow({ date: '2026-03-09', time: '09:00' }), 'mar-8-gap': tomorrow({ date: '2026-03-08', time: '02:30' }),
    'nov-1-overlap': tomorrow({ date: '2026-11-01', time: '01:30' }), 'nov-2': tomorrow({ date: '2026-11-02', time: '09:00' }), 'nov-3': tomorrow({ date: '2026-11-03', time: '09:00' }) };
  // 23:30 MST on Saturday March 7: adding 24 hours of elapsed time would land on March 9.
  const spring = select(jobs, '2026-03-08T06:30:00.000Z');
  assert.deepEqual([spring.today, kinds(spring.due)], ['2026-03-07', ['day_before_reminder:mar-8:2026-03-08:-1']]);
  assert.deepEqual(spring.skipped, { no_valid_start_time: 1 });
  assert.deepEqual(kinds(select(jobs, '2026-03-08T07:30:00.000Z').due), ['day_before_reminder:mar-9:2026-03-09:-1'], '00:30 MST on March 8 already counts March 9 as tomorrow');
  // 23:30 MST on Sunday November 1 is already November 2 in UTC.
  const fall = select(jobs, '2026-11-02T06:30:00.000Z');
  assert.deepEqual([fall.today, kinds(fall.due)], ['2026-11-01', ['day_before_reminder:nov-2:2026-11-02:-1']]);
  const before = select(jobs, '2026-10-31T18:00:00.000Z');
  assert.deepEqual([kinds(before.due), before.skipped], [[], { no_valid_start_time: 1 }], 'a 01:30 start on the fall-back day is ambiguous');
});

test('a tick sends due reminders once through approved templates and leaves an auditable ledger', async () => {
  const f = await setup({ jobs: { 'day-1': tomorrow(), 'dep-1': deposit(), 'pay-1': unpaid('2026-09-21'), 'estimate-1': quiet({ estimate: { number: 'EST-1', status: 'sent', amount: 900, validUntil: '2026-09-23' } }) } });
  const summary = await f.run({ requestId: '5b0c8f6e-4a1d-4c55-9a0e-1f2b3c4d5e6f' });
  assert.deepEqual([summary.scanned, summary.due, summary.attempted, summary.sent, summary.limitReached, summary.dryRun], [4, 3, 3, 3, false, false]);
  assert.deepEqual(summary.kinds, { day_before_reminder: 'ready', deposit_reminder: 'ready', estimate_expiring: 'ready', portal_invitation: 'not_configured' });
  assert.deepEqual(summary.results.map(row => [row.kind, row.jobId, row.status]), [['day_before_reminder', 'day-1', 'submitted'], ['deposit_reminder', 'dep-1', 'submitted'], ['estimate_expiring', 'estimate-1', 'submitted']]);
  assert.deepEqual(f.store.scans, [[...SCHEDULER_JOB_FIELDS]], 'one masked jobs scan per tick');
  const messages = f.ghl.sends().map(call => call.body.message);
  assert.match(messages[0], /^Hi Synthetic, a friendly reminder from Easy Garage Cleaning: we will see you Wednesday, September 23 with an arrival window of 9:00 AM–10:00 AM\./);
  assert.match(messages[1], /To hold your Friday, September 25 appointment, your \$300\.00 deposit can be paid securely here: https:\/\/easygaragecleaning\.com\/pay\/synthetic /);
  assert.match(messages[2], /good through September 23\. Review it anytime: https:\/\/easygaragecleaning\.com\/portal\/synthetic /);
  const ledgers = f.ledgers();
  assert.ok(ledgers.every(row => row.approval === 'owner_automation' && row.actorId === CRON_ACTOR_ID && row.source === 'cron' && row.templateVersion === 1 && row.requestId === '5b0c8f6e-4a1d-4c55-9a0e-1f2b3c4d5e6f'));
  assert.ok(ledgers.every(row => !row.body.includes('https://')), 'links never reach the ledger');
  assert.equal(f.row('dep-1').customerConversation, undefined, 'billing reminders stay out of the crew-readable thread');
  assert.equal(f.row('day-1').communicationLog.at(-1).status, 'submitted');
  // The legacy page-load trigger's markers are set too, so switching server
  // messaging back off never repeats these reminders from a browser.
  assert.deepEqual([f.row('estimate-1').automationMilestones, f.row('day-1').automationMilestones, f.row('dep-1').automationMilestones], [{ 'estimate-expiring': '2026-09-23' }, undefined, undefined]);
  assert.deepEqual([f.row('pay-1').automationMilestones, f.row('pay-1').communicationLog], [undefined, undefined], 'an overdue invoice is HighLevel\'s: never sent, never marked');
  f.time.advance(15 * 60000);
  const again = await f.run();
  assert.deepEqual([again.sent, again.attempted, again.counts], [0, 0, { already_sent: 3 }]);
  assert.equal(f.ghl.sends().length, 3);
  assert.deepEqual(CRON_ACTOR, { id: 'messaging-cron-worker', kind: 'system', source: 'cron' });
});

test('two ticks at the same instant send each message once', async () => {
  const f = await setup({ jobs: { 'day-1': tomorrow(), 'day-2': tomorrow({ time: '13:00' }), 'dep-1': deposit() } });
  const [left, right] = await Promise.all([f.run({ requestId: uuid() }), f.run({ requestId: uuid() })]);
  assert.equal(f.ghl.sends().length, 3);
  assert.equal(left.sent + right.sent, 3);
  assert.equal(f.ledgers().length, 3);
  assert.ok(f.ledgers().every(row => row.status === 'submitted' && row.attempts === 1));
  assert.ok([...left.results, ...right.results].every(row => ['submitted', 'sending', 'already_sent'].includes(row.status)));
});

test('quiet hours defer everything without scanning, and day-before reminders wait for their window', async () => {
  const night = await setup({ jobs: { 'day-1': tomorrow(), 'dep-1': deposit() }, at: '2026-09-23T03:30:00.000Z', portal: {} });
  const deferred = await night.run();
  assert.deepEqual([deferred.deferred, deferred.notBefore, deferred.scanned, deferred.attempted], ['quiet_hours', '2026-09-23T14:00:00.000Z', 0, 0]);
  assert.deepEqual([night.store.scans.length, night.ghl.calls.length, night.invites.length, night.ledgers().length], [0, 0, 0, 0]);
  const early = await setup({ jobs: { 'day-1': tomorrow(), 'dep-1': deposit() }, at: '2026-09-22T14:30:00.000Z' });
  const morning = await early.run();
  assert.deepEqual(morning.results.map(row => [row.kind, row.status, row.reason]), [['day_before_reminder', 'deferred', 'send_window'], ['deposit_reminder', 'submitted', undefined]]);
  early.time.set('2026-09-22T15:00:00.000Z');
  assert.deepEqual((await early.run()).results.map(row => [row.kind, row.status]), [['day_before_reminder', 'submitted'], ['deposit_reminder', 'already_sent']]);
  const late = await setup({ jobs: { 'day-1': tomorrow() }, at: '2026-09-23T01:30:00.000Z' });
  assert.deepEqual((await late.run()).results.map(row => [row.status, row.reason]), [['deferred', 'send_window']]);
  assert.equal(early.ghl.sends().length + late.ghl.sends().length, 2);
});

test('deposit reminders follow the cadence and stop the moment the deposit is paid', async () => {
  // Stages 6 and 3 days before a Monday 2026-09-28 visit, in the 3-day deposit_reminder windows.
  const f = await setup({ jobs: { 'dep-1': quiet({ date: '2026-09-28' }), 'dep-partial': quiet({ date: '2026-09-28' }) }, approved: ['deposit_reminder'], rows: { 'messaging_settings/automation': { depositReminderDaysBefore: [3, 6] } } });
  assert.deepEqual((await f.run()).results.map(row => [row.jobId, row.step, row.status]), [['dep-1', -6, 'submitted'], ['dep-partial', -6, 'submitted']]);
  f.store.edit('jobs/dep-1', { payment: { amount: 300, verified: true, method: 'card', stripeSessions: [card(300, 'cs_test_synthetic_paid', '2026-09-23T16:00:00.000Z')] } });
  f.store.edit('jobs/dep-partial', { payment: { amount: 100, verified: true, method: 'card', stripeSessions: [card(100, 'cs_test_synthetic_part', '2026-09-23T16:00:00.000Z')] } });
  f.time.set('2026-09-25T17:00:00.000Z');
  const early = await f.run();
  assert.deepEqual([early.sent, early.due, early.results.map(row => [row.jobId, row.status, row.reason])], [0, 1, [['dep-partial', 'deferred', 'reminder_cadence']]], 'the paid deposit is no longer due and the next stage waits a full cadence after the last reminder');
  f.time.set('2026-09-25T18:00:00.000Z');
  const next = await f.run();
  assert.deepEqual([next.sent, next.results.map(row => [row.jobId, row.step, row.status])], [1, [['dep-partial', -3, 'submitted']]]);
  assert.match(f.ghl.sends().at(-1).body.message, /your \$200\.00 deposit can be paid/);
  assert.equal(f.ghl.sends().filter(call => call.body.message.includes('$300.00')).length, 2, 'the paid deposit got only its first reminder');
  f.store.edit('jobs/dep-partial', { payment: { amount: 300, verified: true, method: 'card', stripeSessions: [card(100, 'cs_test_synthetic_part', '2026-09-23T16:00:00.000Z'), card(200, 'cs_test_synthetic_rest', '2026-09-26T16:00:00.000Z')] } });
  f.time.set('2026-09-26T18:00:00.000Z');
  const later = await f.run();
  assert.deepEqual([later.due, later.sent, later.skipped], [0, 0, {}]);
  assert.equal(f.ghl.sends().length, 3);
});
test('a deposit money-core still counts but the checkout would refuse is reported as money_mismatch instead of chased every tick', async () => {
  // $300 paid by card before the Friday visit, $100 of it a tip: money-core applies $200 and still counts $100 of the
  // $300 deposit as due, while the checkout (customerDepositState) counts the whole $300 and sees nothing due.
  const tip = { sessionId: 'cs_test_synthetic_tip', amount: 100, purpose: 'tip', verifiedAt: '2026-09-21T16:00:00.000Z' };
  const tipped = deposit({ payment: { amount: 300, verified: true, method: 'card', stripeSessions: [card(200, 'cs_test_synthetic_dep', '2026-09-21T16:00:00.000Z'), tip] } });
  const money = moneyStateCents({ id: 'dep-tipped', ...tipped });
  assert.deepEqual([money.purpose, money.tipCents, money.appliedCents, money.depositDueCents], ['deposit', 10000, 20000, 10000], 'money-core: the deposit is still due');
  assert.equal(messagePolicy('deposit_reminder').eligible({ job: { id: 'dep-tipped', ...tipped }, today: '2026-09-22', automated: true }).reason, 'nothing_due', 'the checkout sees nothing due');
  const jobs = { 'dep-tipped': tipped, 'dep-1': deposit() }, selected = select(jobs);
  assert.deepEqual([kinds(selected.due), selected.skipped], [['deposit_reminder:dep-1:2026-09-25:-3'], { money_mismatch: 1 }]);
  const f = await setup({ jobs, approved: ['deposit_reminder'] });
  const first = await f.run();
  assert.deepEqual([first.scanned, first.due, first.sent, first.skipped, first.results.map(row => [row.jobId, row.status])], [2, 1, 1, { money_mismatch: 1 }, [['dep-1', 'submitted']]]);
  f.time.set('2026-09-23T18:00:00.000Z');
  const next = await f.run();
  assert.deepEqual([next.sent, next.skipped], [0, { money_mismatch: 1 }], 'reported again, never selected and refused at send');
  assert.deepEqual([f.ledgers().length, f.row('dep-tipped').communicationLog], [1, undefined], 'one ledger row, for dep-1; nothing claimed or logged for the mismatched job');
  assert.equal(f.ghl.sends().length, 1);
});

test('each tick is bounded to 25 sends and the next tick picks up the rest', async () => {
  const jobs = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`day-${String(index + 1).padStart(2, '0')}`, tomorrow()]));
  const f = await setup({ jobs, approved: ['day_before_reminder'] });
  const first = await f.run();
  assert.deepEqual([first.due, first.sent, first.limitReached, first.counts], [30, 25, true, { submitted: 25, not_attempted: 5 }]);
  assert.ok(first.results.slice(25).every(row => row.reason === 'tick_limit'));
  assert.equal(f.ghl.sends().length, 25);
  f.time.advance(15 * 60000);
  const second = await f.run();
  assert.deepEqual([second.sent, second.limitReached, second.counts], [5, false, { already_sent: 25, submitted: 5 }]);
  assert.equal(f.ghl.sends().length, 30);
  const capped = await setup({ jobs: { 'day-1': tomorrow(), 'day-2': tomorrow(), 'day-3': tomorrow() }, approved: ['day_before_reminder'], rows: { 'messaging_settings/automation': { maxSendsPerTick: 2 } } });
  assert.deepEqual(await capped.run().then(summary => [summary.limit, summary.sent, summary.settings.source]), [2, 2, 'saved']);
  const budget = await setup({ jobs: { 'day-1': tomorrow(), 'day-2': tomorrow() }, approved: ['day_before_reminder'] });
  let left = 30;
  const metered = { ...budget.service, send: (...args) => { left -= 10; return budget.service.send(...args); } };
  const starved = await budget.run({}, { service: metered, budget: () => left, charge: cost => { left -= cost; } });
  assert.deepEqual([starved.attempted, starved.budgetExhausted, starved.results.map(row => row.status)], [1, true, ['submitted', 'not_attempted']]);
});

test('dry runs preview what would send without contacting customers or claiming the ledger', async () => {
  const f = await setup({ jobs: { 'day-1': tomorrow(), 'dep-1': deposit(), 'invite-1': quiet({ customerPortalInvitationRequestedAt: '2026-09-22T10:00:00.000Z' }) }, flags: { EGC_MESSAGING_ENABLED: 'false' }, portal: {} });
  const summary = await f.run({ dryRun: true });
  assert.deepEqual([summary.dryRun, summary.sent, summary.counts], [true, 3, { would_send: 2, would_retry: 1 }]);
  assert.equal(f.ghl.calls.filter(call => call.method === 'POST').length, 0, 'no contact upsert and no message');
  assert.deepEqual([f.ledgers().length, f.invites.length, f.row('day-1').communicationLog, f.row('dep-1').communicationLog, f.row('dep-1').automationMilestones], [0, 0, undefined, undefined, undefined]);
  const live = await f.run();
  assert.deepEqual([live.kinds.day_before_reminder, live.counts], ['messaging_disabled', { submitted: 1 }], 'with delivery off only the existing automatic portal retry runs');
  assert.deepEqual(f.invites.map(row => row.jobId), ['invite-1']);
  assert.equal(f.ghl.sends().length, 0);
});

test('turned-off automation, retired wording, paused settings and customer opt-outs never send', async () => {
  const off = await setup({ jobs: { 'day-1': tomorrow() }, approved: ['day_before_reminder'], automated: [] });
  const offSummary = await off.run();
  assert.deepEqual([offSummary.kinds.day_before_reminder, offSummary.kinds.deposit_reminder, offSummary.due, offSummary.scanned], ['automation_off', 'template_not_approved', 0, 0]);
  const optOut = await setup({ jobs: { 'notify-off': tomorrow({ notify: false }), 'automation-off': tomorrow({ customerAutomationEnabled: false }) }, approved: ['day_before_reminder'] });
  const skipped = await optOut.run();
  assert.deepEqual([skipped.due, skipped.skipped], [0, { job_notifications_off: 1, customer_automation_off: 1 }]);
  // A job changed after the scan is re-read by the send path before it claims.
  const raced = await setup({ jobs: { 'day-1': tomorrow() }, approved: ['day_before_reminder'] });
  const scan = raced.store.jobRecords;
  raced.store.jobRecords = async fields => { const rows = await scan(fields); raced.store.edit('jobs/day-1', { notify: false }); return rows; };
  assert.deepEqual((await raced.run()).results.map(row => [row.status, row.reason]), [['suppressed', 'job_notifications_off']]);
  const noLink = await setup({ jobs: { 'dep-1': deposit() }, approved: ['deposit_reminder'], links: {} });
  assert.equal((await noLink.run()).kinds.deposit_reminder, 'link_provider_missing');
  const paused = await setup({ jobs: { 'day-1': tomorrow() }, rows: { 'messaging_settings/automation': { paused: true } } });
  assert.deepEqual(await paused.run().then(summary => [summary.paused, summary.scanned]), [true, 0]);
  const broken = await setup({ jobs: { 'day-1': tomorrow() }, rows: { 'messaging_settings/automation': { depositReminderDaysBefore: 'weekly' } } });
  await assert.rejects(broken.run(), code('messaging_settings_invalid'));
  assert.equal(off.ghl.sends().length + optOut.ghl.sends().length + raced.ghl.sends().length + noLink.ghl.sends().length + paused.ghl.sends().length + broken.ghl.sends().length, 0);
});

test('portal-invitation retries keep the legacy rule and move from the browser to the tick', async () => {
  const requested = '2026-09-22T10:00:00.000Z', state = (status, attempts = 1, attemptedAt = '2026-09-22T17:00:00.000Z') => ({ jobId: '', status, attempts, attemptedAt });
  const jobs = {
    'invite-new': quiet({ customerPortalInvitationRequestedAt: requested }),
    'invite-failed': quiet({ customerPortalInvitationRequestedAt: requested, customerPortalInvitation: { ...state('failed'), jobId: 'invite-failed' } }),
    'invite-recent': quiet({ customerPortalInvitationRequestedAt: requested, customerPortalInvitation: { ...state('failed', 1, '2026-09-22T17:55:00.000Z'), jobId: 'invite-recent' } }),
    'invite-sent': quiet({ customerPortalInvitationRequestedAt: requested, customerPortalInvitation: { ...state('submitted'), jobId: 'invite-sent' } }),
    'invite-uncertain': quiet({ customerPortalInvitationRequestedAt: requested, customerPortalInvitation: { ...state('uncertain'), jobId: 'invite-uncertain' } }),
    'invite-exhausted': quiet({ customerPortalInvitationRequestedAt: requested, customerPortalInvitation: { ...state('failed', 5), jobId: 'invite-exhausted' } }),
    'invite-other-job': quiet({ customerPortalInvitationRequestedAt: requested, customerPortalInvitation: { ...state('submitted'), jobId: 'someone-else' } }),
    'invite-unaccepted': quiet({ customerPortalInvitationRequestedAt: requested, estimate: { number: 'EST-8', status: 'sent', amount: 900, validUntil: '2026-12-31' } }),
    'invite-muted': quiet({ customerPortalInvitationRequestedAt: requested, notify: false }),
    'not-requested': quiet(),
  };
  assert.deepEqual(portalRetries(Object.entries(jobs).map(([id, fields]) => ({ ...fields, id })), { now: new Date(NOW) }).map(row => row.jobId), ['invite-failed', 'invite-new', 'invite-other-job']);
  const f = await setup({ jobs, approved: [], portal: jobId => jobId === 'invite-new' ? { status: 'submitted' } : jobId === 'invite-failed' ? { status: 'uncertain' } : { status: 'busy' } });
  const summary = await f.run();
  assert.deepEqual(f.invites, [{ jobId: 'invite-failed', at: NOW }, { jobId: 'invite-new', at: NOW }, { jobId: 'invite-other-job', at: NOW }]);
  assert.deepEqual([summary.sent, summary.counts, summary.kinds.portal_invitation], [2, { uncertain: 1, submitted: 1, busy: 1 }, 'ready']);
});

test('reminders quote the dispatch arrival window the customer was promised', async () => {
  const f = await setup({ jobs: { explicit: tomorrow({ time: '09:30', arrivalWindowStart: '09:00', arrivalWindowEnd: '11:00' }), stale: tomorrow({ time: '13:00', arrivalWindowStart: '09:00', arrivalWindowEnd: '11:00' }) }, approved: ['day_before_reminder'] });
  await f.run();
  const [explicit, stale] = f.ghl.sends().map(call => call.body.message);
  assert.match(explicit, /arrival window of 9:00 AM – 11:00 AM\./);
  assert.match(stale, /arrival window of 1:00 PM–2:00 PM\./, 'a saved window that no longer contains the start is never quoted');
  const defaults = await setup({ jobs: { derived: tomorrow({ time: '10:00' }) }, approved: ['day_before_reminder'], flags: { EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED: 'true', EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_MINUTES: '120' } });
  await defaults.run();
  assert.match(defaults.ghl.sends()[0].body.message, /arrival window of 10:00 AM – 12:00 PM\./);
});

test('portal links for reminders are signed under the verified account root and never minted for crew', async () => {
  const store = memoryStore({ 'jobs/root-1': job({ customerPortalLinkVersion: 3 }), 'jobs/visit-2': job({ customerAccountOwnerJobId: 'root-1', customerId: 'customer-1' }) });
  store.edit('jobs/root-1', { customerId: 'customer-1' });
  const read = id => store.read('jobs', id), providers = portalLinkProviders({ env, read, now: () => Date.parse(NOW) });
  assert.deepEqual(Object.keys(providers).sort(), ['payLink', 'portalLink']);
  const visit = await read('visit-2'), url = new URL(await providers.payLink({ audience: 'customer', job: visit, purpose: 'send' }));
  assert.equal(url.origin + url.pathname, 'https://easygaragecleaning.com/api/customer-portal-session');
  const claims = await verifyCustomerPortalAccessToken(env, url.searchParams.get('access'), Date.parse(NOW));
  assert.deepEqual([claims.jobId, claims.linkVersion, claims.linkRoot, claims.expiresAt], ['visit-2', 3, 'root-1', Date.parse(NOW) + 30 * 86400000]);
  assert.equal(await providers.portalLink({ audience: 'crew', job: visit, purpose: 'send' }), undefined);
  assert.deepEqual(portalLinkProviders({ env: {}, read }), {}, 'no portal secret means no link provider');
});
