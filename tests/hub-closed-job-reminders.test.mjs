import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';

// A cancelled (either spelling), lost, superseded or no-show job owes nothing and is no longer a live quote, so the
// Hub's automatic customer milestones (employee-suite.js runCustomerCommunicationMilestones: invoice overdue, estimate
// expiring) never queue for it, the same jobs the server's message scheduler treats as unpayable (messaging-scheduler.js
// UNPAYABLE_JOB). This only removes sends. The finance board hides 'canceled' like 'cancelled'. Synthetic customers only;
// "today" is a fixed Denver date.
const TODAY = '2026-11-03';
const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
const line = prefix => { const found = source.split(/\r?\n/).find(item => item.startsWith(prefix)); assert.ok(found, prefix); return found; };
const CLOSED = ['cancelled', 'canceled', 'lost', 'superseded', 'noshow', 'no_show', 'no-show'];
const overdue = (id, fields = {}) => ({ id, type: 'job', customer: `Synthetic ${id}`, phone: '9705550100', customerAutomationEnabled: true, notify: true, status: 'scheduled', pipelineStatus: 'scheduled',
  total: 800, estimate: { amount: 800, status: 'accepted' }, payment: { amount: 200, verified: true }, invoice: { number: `INV-${id}`, status: 'issued', amount: 800, issuedAt: '2026-10-20T18:00:00.000Z', dueDate: '2026-10-30' }, ...fields });
const expiring = (id, fields = {}) => ({ id, type: 'job', customer: `Synthetic ${id}`, email: 'synthetic@example.invalid', customerAutomationEnabled: true, notify: true, status: 'estimate', pipelineStatus: 'estimate',
  total: 1500, estimate: { amount: 1500, status: 'sent', validUntil: '2026-11-04' }, ...fields });

function milestones(jobs) {
  const synced = [];
  const context = vm.createContext({ window: {}, jobs: () => jobs, day: () => TODAY, syncCustomerCommunication: async (job, event, marker) => { synced.push([job.id, event, marker]); } });
  vm.runInContext([line('const isoDate='), line('function financeState('), line('async function runCustomerCommunicationMilestones('), line('function financeDatePlus(')].join('\n'), context);
  return { synced, run: legacy => context.runCustomerCommunicationMilestones(legacy) };
}

test('no automatic overdue or estimate reminder is queued for a cancelled, lost or no-show job', async () => {
  // The closed jobs come first, so before this fix they also took the three sends a refresh allows.
  const closed = CLOSED.flatMap(stage => [overdue(`overdue-${stage}`, { status: stage, pipelineStatus: stage }), expiring(`quote-${stage}`, { status: stage, pipelineStatus: stage })]);
  // A stage on only one of the two fields still closes the job, as the customer portal reads it.
  closed.push(overdue('overdue-status-only', { status: 'canceled', pipelineStatus: 'scheduled' }), overdue('overdue-pipeline-only', { status: 'scheduled', pipelineStatus: 'cancelled' }));
  const { synced, run } = milestones([...closed, overdue('overdue-open'), expiring('quote-open')]);
  await run(true);
  assert.deepEqual(synced, [['overdue-open', 'invoice-overdue', '2026-10-30'], ['quote-open', 'estimate-expiring', '2026-11-04']]);
});

test('open jobs keep their automatic reminders exactly as before', async () => {
  const { synced, run } = milestones([overdue('a'), overdue('b', { status: 'completed', pipelineStatus: 'invoiced' }), expiring('c'), overdue('d')]);
  await run(true);
  assert.deepEqual(synced, [['a', 'invoice-overdue', '2026-10-30'], ['b', 'invoice-overdue', '2026-10-30'], ['c', 'estimate-expiring', '2026-11-04']], 'still three per refresh, in order');
  const server = milestones([overdue('a'), expiring('c')]);
  await server.run(false);
  assert.deepEqual(server.synced, [['a', 'invoice-overdue', '2026-10-30']], 'server messaging on: the estimate reminder is the server\'s');
});

test('the finance board hides cancelled jobs in either spelling', () => {
  const jobs = [overdue('open-job'), overdue('cancelled-job', { status: 'cancelled', pipelineStatus: 'cancelled' }), overdue('canceled-job', { status: 'canceled', pipelineStatus: 'canceled' })];
  const context = vm.createContext({ window: { EGCLaborCosts: { state: () => 'hidden', record: () => null }, EGCPricingConfig: { owner: () => null } }, jobs: () => jobs, day: () => TODAY,
    jobStage: j => j.pipelineStatus || j.status || 'scheduled', crewNames: () => [], esc: String, money: value => `$${Number(value || 0).toFixed(2)}`, badge: text => `[${text}]`, empty: text => text, dateLabel: () => 'date',
    portalInvitationControl: () => '', salesExitControl: () => '', serverCapabilities: () => null, S: { integrations: {} }, isManager: () => true, isOwnerAccount: () => false });
  vm.runInContext([line('const payMoney='), line('function financeState('), line('const ownerEconomics='), line('const laborBaseline='), line('const laborState='), line('function jobEconomics('), line('function fieldPaymentReviewAccess('), line('function financeBoard(')].join('\n'), context);
  const rows = [...context.financeBoard().matchAll(/data-finance-job="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(rows, ['open-job']);
});
