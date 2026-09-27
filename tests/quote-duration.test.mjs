import test from 'node:test';
import assert from 'node:assert/strict';
import { DURATION_DEFAULTS, jobDurationSuggestion, suggestedDurationMinutes } from '../functions/_lib/quote-duration.js';

const line = (extra = {}) => ({ id: 'reset', kind: 'service', name: 'Synthetic garage reset', unitCents: 100000, ...extra });
const floors = { id: 'floors', label: 'Floors', selection: 'single' };
const code = expected => error => { assert.equal(error.code, expected); assert.equal(error.status, 400); return true; };

test('only selected lines count, per-unit minutes multiply by quantity and durationMinutes wins over labor minutes', () => {
  const items = [
    line({ durationMinutes: 240, split: { laborCents: 100000, laborMinutes: 999 } }),
    line({ id: 'shelf', kind: 'product', quantity: 3, unitCents: 45000, split: { productCents: 30000, laborCents: 15000, laborMinutes: 20 } }),
    line({ id: 'rush', kind: 'fee', unitCents: 5000, optional: true, durationMinutes: 600 }),
    line({ id: 'totes', kind: 'product', unitCents: 2150, quantity: 10, optional: true, selected: true, durationMinutes: 3 }),
    line({ id: 'epoxy', unitCents: 90000, group: floors, durationMinutes: 480 }),
    line({ id: 'sweep', unitCents: 20000, group: floors, selected: true, durationMinutes: 30 }),
    line({ id: 'off', kind: 'discount', unitCents: 1000, durationMinutes: 500 }),
    line({ id: 'tip', kind: 'tip', unitCents: 1000, durationMinutes: 500 }),
  ];
  const result = suggestedDurationMinutes(items);
  assert.equal(result.source, 'line_items');
  assert.equal(result.breakdown.personMinutes, 240 + 60 + 30 + 30);
  assert.deepEqual(result.breakdown.items.map(item => [item.id, item.minutesPerUnit, item.minutes, item.from]), [['reset', 240, 240, 'durationMinutes'], ['shelf', 20, 60, 'split.laborMinutes'], ['totes', 3, 30, 'durationMinutes'], ['sweep', 30, 30, 'durationMinutes']]);
  assert.equal(result.minutes, 360);
  assert.equal(result.breakdown.coverage, 'complete');
  assert.equal(suggestedDurationMinutes([line({ quantity: 1.5, durationMinutes: 7 })]).breakdown.personMinutes, 11, 'fractional quantities round minutes up');
});

test('duration scales with crew size and rounds up to fifteen minutes', () => {
  const items = [line({ durationMinutes: 480 })];
  assert.deepEqual([1, 2, 3, 4, 5].map(crewSize => suggestedDurationMinutes(items, { crewSize }).minutes), [480, 240, 165, 120, 105]);
  const three = suggestedDurationMinutes(items, { crewSize: 3 });
  assert.equal(three.crewSize, 3); assert.equal(three.breakdown.crewMinutes, 160); assert.equal(three.breakdown.roundedMinutes, 165);
  const setup = suggestedDurationMinutes(items, { crewSize: 4, setupMinutes: 25 });
  assert.equal(setup.breakdown.rawMinutes, 145, 'setup is added once and is not divided by the crew');
  assert.equal(setup.minutes, 150);
  assert.equal(suggestedDurationMinutes(items, { crewSize: 4, baseMinutes: 30 }).minutes, 150, 'baseMinutes is accepted as the setup allowance');
  assert.equal(suggestedDurationMinutes(items, { crewSize: 2, settings: { roundToMinutes: 30 } }).minutes, 240);
  assert.equal(suggestedDurationMinutes([line({ durationMinutes: 61 })], { settings: { roundToMinutes: 30 } }).minutes, 90);
  assert.equal(suggestedDurationMinutes(items, { job: { crewNeeded: 2 } }).crewSize, 2, 'the job crew is used when no crew size is given');
  assert.equal(suggestedDurationMinutes(items, { job: { crewNeeded: 'two', crewSize: 0, logistics: { crew_size: 3 } } }).crewSize, 3);
  assert.equal(suggestedDurationMinutes(items, { crewSize: 1, job: { crewNeeded: 4 } }).minutes, 480, 'an explicit crew size wins');
});

test('the suggestion clamps to the configured minimum and maximum', () => {
  const short = suggestedDurationMinutes([line({ durationMinutes: 5 })]);
  assert.equal(short.minutes, 15); assert.equal(short.breakdown.clamped, null);
  const floor = suggestedDurationMinutes([line({ durationMinutes: 5 })], { settings: { minMinutes: 60 } });
  assert.equal(floor.minutes, 60); assert.equal(floor.breakdown.clamped, 'min');
  const long = suggestedDurationMinutes([line({ durationMinutes: 1440, quantity: 3 })]);
  assert.equal(long.minutes, 1440); assert.equal(long.breakdown.clamped, 'max'); assert.equal(long.breakdown.roundedMinutes, 4320);
  assert.equal(suggestedDurationMinutes([line({ durationMinutes: 600 })], { settings: { maxMinutes: 540 } }).minutes, 540);
  assert.deepEqual(DURATION_DEFAULTS, { crewSize: 1, setupMinutes: 0, roundToMinutes: 15, minMinutes: 15, maxMinutes: 1440, defaultMinutes: 120 });
});

test('the documented fallback chain is estimatedDurationMin, then the schedule span, then the default', () => {
  const legacy = [{ name: 'Garage transformation', description: 'Synthetic scope', quantity: 1, amount: 1425 }];
  const estimated = suggestedDurationMinutes(legacy, { crewSize: 4, job: { estimatedDurationMin: 180, date: '2026-09-24', time: '09:00', endTime: '17:00' } });
  assert.deepEqual([estimated.source, estimated.minutes, estimated.breakdown.unestimated, estimated.breakdown.coverage], ['estimated_duration', 180, ['line-1'], 'fallback']);
  const span = suggestedDurationMinutes(legacy, { job: { estimatedDurationMin: 5, date: '2026-09-24', time: '09:00', endTime: '12:20' } });
  assert.deepEqual([span.source, span.breakdown.rawMinutes, span.minutes], ['schedule_span', 200, 210]);
  const dst = suggestedDurationMinutes([], { job: { date: '2026-11-01', time: '00:30', endTime: '03:30' } });
  assert.deepEqual([dst.source, dst.minutes], ['schedule_span', 240], 'the Denver fall-back hour is counted as elapsed time');
  const ambiguous = suggestedDurationMinutes([], { job: { date: '2026-11-01', time: '01:30', endTime: '03:00' } });
  assert.equal(ambiguous.source, 'default', 'a repeated DST wall time is not trusted');
  assert.deepEqual([suggestedDurationMinutes(undefined).source, suggestedDurationMinutes(undefined).minutes], ['default', 120]);
  assert.equal(suggestedDurationMinutes([], { settings: { defaultMinutes: 90 } }).minutes, 90);
  const partial = suggestedDurationMinutes([line({ durationMinutes: 60 }), line({ id: 'haul', kind: 'disposal', unitCents: 17500 })], { job: { estimatedDurationMin: 300 } });
  assert.deepEqual([partial.source, partial.minutes, partial.breakdown.coverage, partial.breakdown.unestimated], ['line_items', 60, 'partial', ['haul']]);
  const zero = suggestedDurationMinutes([line({ durationMinutes: 0 })], { job: { estimatedDurationMin: 150 } });
  assert.equal(zero.source, 'estimated_duration', 'zero minutes of estimated work falls back rather than scheduling nothing');
});

test('jobDurationSuggestion reads a saved job, including walkthrough handoffs with no line minutes', () => {
  const handoff = { id: 'synthetic-handoff', crewNeeded: 3, estimatedDurationMin: 180, date: '2026-09-24', time: '09:00', endTime: '12:00', estimate: { amount: 1400, status: 'accepted' } };
  assert.deepEqual([jobDurationSuggestion(handoff).source, jobDurationSuggestion(handoff).minutes, jobDurationSuggestion(handoff).crewSize], ['estimated_duration', 180, 3]);
  const quoted = { ...handoff, estimate: { lineItems: [line({ durationMinutes: 300 }), line({ id: 'shelf', kind: 'product', quantity: 2, unitCents: 45000, split: { productCents: 30000, laborCents: 15000, laborMinutes: 45 } })] } };
  const result = jobDurationSuggestion(quoted, { setupMinutes: 20 });
  assert.deepEqual([result.source, result.breakdown.personMinutes, result.breakdown.crewMinutes, result.minutes], ['line_items', 390, 130, 150]);
  assert.equal(jobDurationSuggestion(null).source, 'default');
});

test('invalid crew sizes, setup allowances and settings are rejected with quote_ codes', () => {
  for (const crewSize of [0, 21, 2.5, '2', null]) assert.throws(() => suggestedDurationMinutes([], { crewSize }), code('quote_invalid_crew_size'));
  for (const setupMinutes of [-5, 481, 10.5, '10']) assert.throws(() => suggestedDurationMinutes([], { setupMinutes }), code('quote_invalid_setup_minutes'));
  for (const settings of [[], 'x', { roundToMinutes: 0 }, { minMinutes: 600, maxMinutes: 300 }, { maxMinutes: 5000 }, { unknown: 1 }, { defaultMinutes: 1.5 }]) assert.throws(() => suggestedDurationMinutes([], { settings }), code('quote_invalid_duration_settings'));
  assert.doesNotThrow(() => suggestedDurationMinutes([null, { name: 'Broken', amount: 'abc', durationMinutes: 'soon' }]), 'damaged legacy lines are read leniently');
});

test('lines whose grouping or flags are malformed never add minutes', () => {
  const group = { id: 'floors', label: 'Floors', selection: 'single', sort: 1 };
  const items = [line({ durationMinutes: 90 }), line({ id: 'coat', unitCents: 30000, group, tier: 'good', durationMinutes: 60 }), line({ id: 'epoxy', unitCents: 50000, group, tier: 'better', selected: true, durationMinutes: 240 }), line({ id: 'rush', kind: 'fee', unitCents: 5000, optional: 'true', selected: false, durationMinutes: 600 })];
  const result = suggestedDurationMinutes(items);
  assert.deepEqual([result.source, result.minutes, result.breakdown.personMinutes], ['line_items', 90, 90], 'the probe gave 390 minutes by counting the malformed options');
  assert.deepEqual(result.breakdown.items.map(item => item.id), ['reset']);
  assert.equal(suggestedDurationMinutes(items.map(item => item.id === 'rush' ? item : { ...item, group: item.group && floors })).minutes, 330, 'control: the chosen option counts once the group is valid');
});
