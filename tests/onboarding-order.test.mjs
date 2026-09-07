import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function setup() {
  const source = fs.readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8');
  const timerLine = source.split('\n').find(line => line.startsWith('let onboardingDraftTimer='));
  const queueLine = source.split('\n').find(line => line.startsWith('let onboardingDraftWrite='));
  const handlers = source.slice(source.indexOf('window.opsOnboardingDraft='), source.indexOf('window.opsSubmitRequest='));
  const requests = [], pending = [], timers = [], finalRecords = [];
  const button = { disabled: false, textContent: '' };
  const values = { preferredName: 'Old draft', phone: '9705550100', emergencyContactName: 'Emergency', emergencyContactPhone: '9705550101', timekeeping: 'on', locationPolicy: 'on', safety: 'on', customerCare: 'on', hubBasics: 'on' };
  const form = { querySelector: () => button };
  const context = {
    S: { peopleGeneration: 1 }, Date, Promise, Object, String, Number,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    peopleCollections: { profiles: 'profiles' }, employeeIdentity: () => 'TestCrew', employeeKey: x => x.toLowerCase(),
    onboardingValues: () => ({ preferredName: values.preferredName, onboardingDraftAt: new Date().toISOString() }),
    onboardingDraftKey: () => 'draft:testcrew', ownProfile: () => ({}), onboardingComplete: () => false,
    sessionStorage: { setItem() {}, removeItem() {} }, $: () => null, go() {},
    FormData: class { [Symbol.iterator]() { return Object.entries(values)[Symbol.iterator](); } },
    peopleSet: async (collection, id, data) => {
      requests.push(data);
      await new Promise((resolve, reject) => pending.push({ resolve, reject }));
      finalRecords.push(data);
      return data;
    },
  };
  context.window = context;
  vm.runInNewContext([timerLine, queueLine || '', handlers].join('\n'), context);
  return { context, requests, pending, timers, finalRecords, values, form, button, event: { preventDefault() {}, currentTarget: form } };
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
test('final onboarding submission waits for an already-running autosave, so stale details cannot win', async () => {
  const env = setup();
  env.context.opsOnboardingDraft(env.event);
  const draft = env.timers.shift()(); await flush();
  assert.equal(env.requests.length, 1);
  env.values.preferredName = 'Final submitted name';
  const completion = env.context.opsSaveOnboarding(env.event); await flush();
  assert.equal(env.requests.length, 1, 'the final write must wait for the old draft write');
  env.pending[0].resolve(); await draft; await flush();
  assert.equal(env.requests.length, 2);
  assert.equal(env.requests[1].preferredName, 'Final submitted name');
  assert.ok(env.requests[1].onboardingCompletedAt);
  env.pending[1].resolve(); await completion;
  assert.equal(env.finalRecords.at(-1).preferredName, 'Final submitted name');
});
test('an autosave failure does not prevent the employee from submitting the final form', async () => {
  const env = setup();
  env.context.opsOnboardingDraft(env.event);
  const draft = env.timers.shift()(); await flush();
  env.values.preferredName = 'Final after retry';
  const completion = env.context.opsSaveOnboarding(env.event); await flush();
  env.pending[0].reject(new Error('Transient save error')); await draft; await flush();
  assert.equal(env.requests.length, 2);
  env.pending[1].resolve(); await completion;
  assert.equal(env.finalRecords.at(-1).preferredName, 'Final after retry');
  assert.ok(env.finalRecords.at(-1).onboardingCompletedAt);
});

test('signing out while the final form waits cannot save the old details into the next account', async () => {
  const env = setup();
  env.context.opsOnboardingDraft(env.event);
  const draft = env.timers.shift()(); await flush();
  const completion = env.context.opsSaveOnboarding(env.event); await flush();
  env.context.S.peopleGeneration += 1;
  env.context.employeeIdentity = () => 'DifferentCrew';
  env.pending[0].resolve(); await draft; await completion;
  assert.equal(env.requests.length, 1, 'no queued completion may start after an account switch');
});

test('repeated submit and input while saving cannot enqueue a stale draft behind completion', async () => {
  const env = setup();
  const first = env.context.opsSaveOnboarding(env.event); await flush();
  const second = env.context.opsSaveOnboarding(env.event);
  env.context.opsOnboardingDraft(env.event);
  await second; await flush();
  assert.equal(env.requests.length, 1);
  assert.equal(env.timers.length, 0);
  env.pending[0].resolve(); await first;
  assert.equal(env.context.S.onboardingSaving, false);
});
