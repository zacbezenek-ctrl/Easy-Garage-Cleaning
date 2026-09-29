import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';

// The browser "Garage Guard status" dialog (employee-suite.js opsSetCustomerMembership), run in its own realm with a fixed clock.
const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
const source = suite.slice(suite.indexOf('const GUARD_PLANS='), suite.indexOf('\nwindow.opsReviewRebooking='));
const NOW = '2026-10-05T18:00:00.000Z';

function dialog(garageGuard) {
  const account = { id: 'job-root', customer: 'Synthetic Dana', garageGuard }, patches = [], asked = [];
  const FixedDate = class extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return Date.parse(NOW); } };
  const context = { Date: FixedDate, jobs: () => [account], customerAccountRecord: () => account, render() {}, showToast() {}, employeeIdentity: () => 'alexk',
    // The manager changes only the next visit and saves; every other field keeps the value the dialog offered.
    askAction: async options => { asked.push(options); return Object.fromEntries(options.fields.map(field => [field.name, field.name === 'nextVisit' ? '2026-11-02' : String(field.value)])); },
    patchJob: async (id, patch) => { patches.push([id, patch]); } };
  context.window = context;
  vm.runInNewContext(source, context);
  return { context, patches, asked };
}

test('a save that only moves the next visit keeps a member at 0 visits at 0, and marks the map as a manual edit', async () => {
  // Review finding: `|| 4` offered 4 for a member at 0 visits, so any save silently gave the visits back.
  const used = dialog({ plan: 'guard', status: 'active', visitsIncluded: 4, visitsRemaining: 0, membershipId: 'sub_member_1', source: 'stripe' });
  await used.context.opsSetCustomerMembership('job-root');
  const [[id, patch]] = used.patches;
  assert.equal(id, 'job-root');
  assert.deepEqual([patch.garageGuard.visitsIncluded, patch.garageGuard.visitsRemaining, patch.garageGuard.nextVisit, patch.garageGuard.source, patch.garageGuard.updatedBy, patch.garageGuard.updatedAt], [4, 0, '2026-11-02', 'hub_manual', 'alexk', NOW]);
  const lite = dialog({ plan: 'lite', status: 'active', visitsIncluded: 0, visitsRemaining: 0 });
  await lite.context.opsSetCustomerMembership('job-root');
  assert.deepEqual([lite.patches[0][1].garageGuard.visitsIncluded, lite.patches[0][1].garageGuard.visitsRemaining], [0, 0]);
  // A customer with no Garage Guard map yet still starts from the plan default.
  const fresh = dialog(undefined);
  await fresh.context.opsSetCustomerMembership('job-root');
  assert.deepEqual([fresh.patches[0][1].garageGuard.visitsIncluded, fresh.patches[0][1].garageGuard.visitsRemaining], [4, 4]);
});
