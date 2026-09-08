import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
const line = prefix => {
  const found = html.split(/\r?\n/).find(row => row.startsWith(prefix));
  assert.ok(found, prefix);
  return found;
};
function harness(overrides = {}) {
  const context = vm.createContext({
    save() {}, render() {}, invalidateAcceptance() { context.invalidated = true; },
    validateStep: () => [], PHOTO_COUNT: 3, uid: () => 'synthetic-job', normPhone: value => value,
    buildInternalNotes: () => '', buildClientChecklists: () => ({ preJob: [], postJob: [] }),
  });
  vm.runInContext(line('const freshState='), context);
  context.S = vm.runInContext('freshState()', context);
  Object.assign(context.S, { garageSize: '1', fill: 'medium', loads: '1', jobDate: '2026-10-01', startTime: '08:00', endTime: '13:00' }, overrides);
  for (const prefix of ['function recommend(', 'function depositSummary(', 'function estimatedJobMinutes(', 'function pick(', 'function readyToSend(', 'function buildJobInstructions(', 'function payload(']) {
    vm.runInContext(line(prefix), context);
  }
  return context;
}

test('truckload rates keep smaller jobs and charge $1,000 for a full load', () => {
  for (const [loads, expected] of [['0.5', 500], ['1', 1000], ['1.5', 1500], ['2', 2000]]) {
    assert.equal(harness({ loads }).recommend(), expected);
  }
  assert.equal(harness({ loads: '', fill: 'light' }).recommend(), 450, 'the average-ticket goal is not a minimum');
  assert.equal(harness({ garageSize: '2', fill: 'packed' }).recommend(), 1100, 'documented work can exceed the hauling baseline');
});

test('a selected one-car pressure wash adds $400 and produces a $700 upfront deposit on one load', () => {
  const h = harness({ finish: ['cleanout', 'pressure_wash'] });
  assert.equal(h.recommend(), 1400);
  assert.equal(h.depositSummary(), '50% deposit due upfront: $700.00. Remaining $700.00 due on completion.');
  const plan = h.payload();
  assert.equal(plan.quote.total, 1400);
  assert.equal(plan.quote.deposit, 700);
  assert.equal(plan.scope.finish_details.pressure_wash.garage_size, '1');
  assert.equal(plan.scope.finish_details.pressure_wash.amount, 400);
  assert.equal(h.buildJobInstructions({}).pressureWash.included, true);
});

test('pressure washing is distinct from deep clean and unselected work is not charged', () => {
  assert.equal(harness().recommend(), 1000);
  assert.equal(harness({ finish: ['cleanout', 'deep_clean'] }).recommend(), 1125);
  assert.equal(harness({ finish: ['cleanout', 'deep_clean', 'pressure_wash'] }).recommend(), 1525);
});

test('documented extras can support the average-ticket target without a forced minimum', () => {
  const twoCar = harness({ garageSize: '2', loads: '1.5', finish: ['cleanout', 'deep_clean', 'shelving', 'totes'], shelfQty: 1, toteQty: 4 });
  assert.equal(twoCar.recommend(), 2300);
  assert.equal(twoCar.payload().quote.deposit, 1150);
  const oneCar = harness({ finish: ['cleanout', 'pressure_wash', 'shelving'], shelfQty: 2 });
  assert.equal(oneCar.recommend(), 2400);
  assert.equal(oneCar.payload().quote.deposit, 1200);
});

test('the one-car pressure wash cannot be silently sold at that rate for a larger garage', () => {
  const h = harness({ garageSize: '2' });
  h.pick('finish', 'pressure_wash', true);
  assert.equal(h.S.finish.includes('pressure_wash'), false);
  h.S.finish.push('pressure_wash');
  assert.ok(h.readyToSend().includes('a confirmed pressure-wash quote for this garage size'));
  h.S.garageSize = '1';
  h.pick('garageSize', '2');
  assert.equal(h.S.finish.includes('pressure_wash'), false);
  assert.equal(h.invalidated, true);
});

test('pressure-wash scheduling includes the additional work estimate', () => {
  const base = harness().estimatedJobMinutes();
  const washed = harness({ finish: ['cleanout', 'pressure_wash'] }).estimatedJobMinutes();
  assert.equal(washed - base, 60);
});

test('pest waste adds $200 once while other hazards retain their existing pricing', () => {
  assert.equal(harness({ hazards: ['Mold / moisture', 'Sharp material'] }).recommend(), 1000);
  assert.equal(harness({ hazards: ['Pest waste', 'Mold / moisture'] }).recommend(), 1200);
  assert.equal(harness({ hazards: ['Pest waste', 'Pest waste'] }).recommend(), 1200);
});

test('the small-job minimum cannot absorb part of the selected fixed pest charges', () => {
  const small = { fill: 'light', loads: '0.25' };
  assert.equal(harness(small).recommend(), 450);
  assert.equal(harness({ ...small, hazards: ['Pest waste'] }).recommend(), 650);
  assert.equal(harness({ ...small, finish: ['cleanout', 'mouse_trapping'] }).recommend(), 700);
  assert.equal(harness({ ...small, hazards: ['Pest waste'], finish: ['cleanout', 'mouse_trapping'] }).recommend(), 900);
});

test('non-toxic mouse trapping is a separate $250 selection for every garage size', () => {
  for (const garageSize of ['1', '2', '3', 'other']) {
    const baseline = harness({ garageSize }).recommend();
    const trapping = harness({ garageSize, finish: ['cleanout', 'mouse_trapping'] });
    assert.equal(trapping.recommend(), baseline + 250);
    assert.equal(trapping.S.hazards.includes('Pest waste'), false);
  }
});

test('pest waste and non-toxic trapping combine with pressure washing and retain a 50% deposit', () => {
  const h = harness({ hazards: ['Pest waste'], finish: ['cleanout', 'pressure_wash', 'mouse_trapping'] });
  const plan = h.payload();
  assert.equal(plan.quote.total, 1850);
  assert.equal(plan.quote.deposit, 925);
  assert.equal(plan.scope.hazard_details.pest_waste.amount, 200);
  assert.equal(plan.scope.finish_details.mouse_trapping.amount, 250);
  assert.equal(plan.scope.finish_details.mouse_trapping.non_toxic, true);
  assert.equal(h.buildJobInstructions({}).pestWaste.included, true);
  assert.equal(h.buildJobInstructions({}).mouseTrapping.nonToxic, true);
});

test('removing a charged selection removes its fee and invalidates the old acceptance', () => {
  const h = harness();
  h.pick('hazards', 'Pest waste', true);
  assert.equal(h.recommend(), 1200);
  h.pick('hazards', 'No visible hazards', true);
  assert.equal(h.recommend(), 1000);
  assert.equal(h.payload().scope.hazard_details.pest_waste, null);
  h.pick('finish', 'mouse_trapping', true);
  assert.equal(h.recommend(), 1250);
  h.pick('finish', 'mouse_trapping', true);
  assert.equal(h.recommend(), 1000);
  assert.equal(h.payload().scope.finish_details.mouse_trapping, null);
  assert.equal(h.invalidated, true);
});

test('new trapping scope is readable in the brief and gets one pre-job and one completion check', () => {
  const h = harness({ hazards: ['Pest waste'], finish: ['cleanout', 'mouse_trapping'] });
  for (const prefix of ['function durationText(', 'function buildInternalNotes(', 'function buildClientChecklists(']) vm.runInContext(line(prefix), h);
  const instructions = h.buildJobInstructions({}), brief = h.buildInternalNotes(instructions), checks = h.buildClientChecklists(instructions);
  assert.match(brief, /Pest waste \(\+\$200\)/);
  assert.match(brief, /Non-toxic mouse trapping \(\+\$250\)/);
  for (const key of ['preJob', 'postJob']) {
    assert.equal(checks[key].filter(item => item.id === 'mouse-trapping').length, 1);
    assert.equal(checks[key].find(item => item.id === 'mouse-trapping').critical, true);
  }
});
