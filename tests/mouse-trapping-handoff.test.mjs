import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function crewContext(path, job) {
  const lines = read(path).split(/\r?\n/);
  const source = ['const textList=', 'function normalizedInstructions(', 'function fallbackClientItems(', 'function clientItems('].map(prefix => {
    const line = lines.find(value => value.startsWith(prefix));
    assert.ok(line, `${path}: ${prefix} exists`); return line;
  }).join('\n');
  const context = vm.createContext({ ACTIVE: job });
  vm.runInContext(source, context); return context;
}

for (const [page, key] of [['crew/prejob.html', 'preJob'], ['crew/postjob.html', 'postJob']]) {
  test(`${page} keeps mouse trapping distinct from pressure washing and deep cleaning`, () => {
    const finish = ['deep_clean', 'pressure_wash', 'mouse_trapping'];
    const context = crewContext(page, { scope: { finish, hazards: ['Pest waste'] } });
    assert.deepEqual(Array.from(context.normalizedInstructions(context.ACTIVE).finish), finish);
    assert.equal(vm.runInContext('textList(normalizedInstructions(ACTIVE).finish)', context), 'Deep clean, One-car garage pressure wash, Non-toxic mouse trapping');
    const items = context.clientItems(), mouse = items.filter(item => item.id === 'mouse-trapping');
    assert.equal(mouse.length, 1); assert.equal(mouse[0].critical, true);
    assert.match(mouse[0].label, /non-toxic mouse trap/i);
    assert.match(mouse[0].detail, /agreed.*placement|placement.*agreed/i);
    assert.match(mouse[0].detail, /locations.*record|record.*locations/i);
    assert.equal('finish' in mouse[0], false, 'finish dispatch keys are not persisted as checklist properties');
    assert.equal(items.filter(item => item.id === 'pressure-wash').length, 1);
  });

  test(`${page} supplements older saved checklists once while retaining the agreed mouse-trapping instructions`, () => {
    const keep = { id: 'keep', label: 'Protect the toolbox', detail: 'Red cabinet', critical: true };
    const context = crewContext(page, { jobInstructions: { finish: ['mouse_trapping'] }, clientChecklists: { [key]: [keep] } });
    const first = context.clientItems();
    assert.equal(first.length, 2); assert.equal(first[0], keep);
    const existing = { id: 'mouse-trapping', label: 'Agreed mouse trap placement', detail: 'Record agreed placement locations in the job notes.', critical: true };
    context.ACTIVE.clientChecklists[key] = [keep, existing];
    const again = context.clientItems();
    assert.equal(again.length, 2); assert.equal(again[1], existing, 'explicit saved scope remains authoritative');
  });

  test(`${page} does not infer mouse trapping from pest-waste hazard or deep clean alone`, () => {
    const context = crewContext(page, { scope: { finish: ['deep_clean'], hazards: ['Pest waste'] } });
    assert.equal(context.clientItems().some(item => item.id === 'mouse-trapping'), false);
    assert.equal(vm.runInContext('textList(normalizedInstructions(ACTIVE).hazards)', context), 'Pest waste');
  });
}

test('HighLevel preserves pest-waste hazard and renders the separately selected mouse-trapping scope', () => {
  const source = read('functions/api/highlevel.js'), context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function finishSummary('), source.indexOf('function closeoutNote(')), context);
  const payload = { scope: { garages: 1, finish: ['mouse_trapping', 'pressure_wash', 'deep_clean'], hazards: ['Pest waste'] }, quote: { total: 1850, deposit: 925 }, sent_at: '2026-09-08T00:00:00Z' };
  for (const text of [context.noteBody(payload), context.appointmentInstructions(payload)]) {
    assert.match(text, /Non-toxic mouse trapping, One-car garage pressure wash, Deep clean/);
    assert.match(text, /HAZARDS: Pest waste|Hazards: Pest waste/);
    assert.doesNotMatch(text, /mouse_trapping|pressure_wash|deep_clean/);
    assert.doesNotMatch(text, /follow-up|pesticide|guarantee|trap count/i);
  }
  const brief = 'EGC INTERNAL JOB BRIEF\nFINISH SOLD: Non-toxic mouse trapping\nAgreed trap locations: record in job notes';
  assert.equal(context.appointmentInstructions({ ...payload, internal_notes: brief }), brief);
});
