import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function crewContext(path, job) {
  const lines = read(path).split(/\r?\n/);
  const names = ['const textList=', 'function normalizedInstructions(', 'function fallbackClientItems(', 'function clientItems('];
  const source = names.map(name => {
    const line = lines.find(value => value.startsWith(name));
    assert.ok(line, `${path}: ${name} exists`); return line;
  }).join('\n');
  const context = vm.createContext({ ACTIVE: job });
  vm.runInContext(source, context); return context;
}

for (const [page, key] of [['crew/prejob.html', 'preJob'], ['crew/postjob.html', 'postJob']]) {
  test(`${page} preserves distinct pressure-wash and deep-clean scope in the crew handoff`, () => {
    const context = crewContext(page, { scope: { finish: ['deep_clean', 'pressure_wash'], garages: '1' } });
    assert.deepEqual(Array.from(context.normalizedInstructions(context.ACTIVE).finish), ['deep_clean', 'pressure_wash']);
    assert.equal(vm.runInContext('textList(normalizedInstructions(ACTIVE).finish)', context), 'Deep clean, One-car garage pressure wash');
    const checklist = context.clientItems(), pressureWash = checklist.filter(item => item.id === 'pressure-wash');
    assert.equal(pressureWash.length, 1); assert.equal(pressureWash[0].critical, true);
    assert.equal(pressureWash[0].detail, 'One-car garage pressure wash');
  });

  test(`${page} adds the pressure-wash check to an older saved checklist exactly once`, () => {
    const original = { id: 'keep', label: 'Protect the tools', detail: 'Red toolbox', critical: true };
    const context = crewContext(page, { jobInstructions: { finish: ['pressure_wash'] }, clientChecklists: { [key]: [original] } });
    let checklist = context.clientItems();
    assert.equal(checklist.length, 2); assert.equal(checklist[0], original, 'existing customer requirements remain intact');
    context.ACTIVE.clientChecklists[key] = checklist;
    checklist = context.clientItems(); assert.equal(checklist.length, 2);
    assert.equal(checklist.filter(item => item.id === 'pressure-wash').length, 1);
  });

  test(`${page} does not treat the existing deep-clean service as pressure washing`, () => {
    const context = crewContext(page, { scope: { finish: ['deep_clean'] }, clientChecklists: { [key]: [{ id: 'finish', detail: 'Deep clean' }] } });
    assert.equal(context.clientItems().some(item => item.id === 'pressure-wash'), false);
    assert.equal(vm.runInContext('textList(normalizedInstructions(ACTIVE).finish)', context), 'Deep clean');
  });
}

test('HighLevel notes and appointment fallback descriptions distinguish pressure washing from deep cleaning', () => {
  const source = read('functions/api/highlevel.js');
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function finishSummary('), source.indexOf('function closeoutNote(')), context);
  const payload = { scope: { garages: 1, finish: ['deep_clean', 'pressure_wash'] }, quote: { total: 1400, deposit: 700 }, sent_at: '2026-09-08T00:00:00Z' };
  for (const text of [context.noteBody(payload), context.appointmentInstructions(payload)]) {
    assert.match(text, /Deep clean, One-car garage pressure wash/);
    assert.doesNotMatch(text, /pressure_wash|deep_clean/);
  }
  const brief = 'EGC INTERNAL JOB BRIEF\nFINISH SOLD: One-car garage pressure wash\nKEEP: Red toolbox';
  assert.equal(context.appointmentInstructions({ ...payload, internal_notes: brief }), brief, 'explicit signed handoff remains authoritative');
});
