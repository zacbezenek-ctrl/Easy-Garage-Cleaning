import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Exercise the actual gate, central-job loader and boot statements, using a
// deferred auth adapter to model the network/custom-token sign-in boundary.
const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, '..');
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(page, { jobId = 'job-test' } = {}) {
  const html = fs.readFileSync(path.join(site, 'crew', `${page}.html`), 'utf8');
  const gate = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes('async function gateLogin()'));
  const centralLoader = html.split(/\r?\n/).find(line => line.startsWith('async function loadCentralJob(){'));
  const boot = html.split(/\r?\n/).find(line => line.startsWith('(async()=>{') && line.includes('restoreAll();'));
  assert.ok(gate && centralLoader && boot, `${page}: production script anchors found`);
  const session = deferred();
  const signIns = [];
  const elements = new Map();
  const state = { ready: false, reads: 0, restored: 0, rendered: [], saved: 0, effects: [], reloads: 0 };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'gate-u' ? 'crewtest' : id === 'gate-p' ? 'test-password' : '',
      style: {}, textContent: '', disabled: false,
      classes: new Set(),
      classList: { add(value) { elements.get(id).classes.add(value); } },
      addEventListener() {}, focus() {},
    });
    return elements.get(id);
  }
  const job = { customer: 'Direct link client', address: '12 Test Street', phone: '5555550100', date: '2026-09-07', total: 400, payment: { amount: 100 } };
  const context = vm.createContext({
    document: { getElementById: element, querySelector: () => element('unlock') },
    location: { search: jobId ? '?job=' + jobId : '', reload: () => state.reloads++ },
    URLSearchParams,
    EGCHubAuth: {
      session: () => session.promise,
      signIn: async (username, password) => {
        assert.equal(username, 'crewtest');
        assert.equal(password, 'test-password');
        const attempt = deferred(); signIns.push(attempt);
        await attempt.promise;
        state.ready = true;
        return 'crewtest';
      },
      signOut: async () => {},
    },
    HUBDB: { collection(name) {
      assert.equal(name, 'jobs');
      return { doc(id) {
        assert.equal(id, jobId);
        return { async get() {
          state.reads++;
          if (!state.ready) throw new Error('permission-denied: Firebase is still signed out');
          return { exists: true, id, data: () => job };
        } };
      } };
    } },
    CENTRAL_JOB_ID: jobId,
    ACTIVE: {},
    restoreAll: () => state.restored++,
    restoreSharedProgress: () => {},
    normalizedInstructions: () => [],
    saveAll: () => state.saved++,
    render: () => state.rendered.push(context.ACTIVE.name || ''),
    mountImportantItems: async () => state.effects.push('important items'),
    renderWalkthroughPhotoFolder: async () => state.effects.push('walkthrough photos'),
    updateStripePanel: () => state.effects.push('payment panel'),
    verifyStripeReturn: async () => state.effects.push('verify payment'),
    syncStripePaymentToHighLevel: async () => state.effects.push('payment sync'),
    restoreWalkthroughPhotoFolder: async () => state.effects.push('walkthrough photos'),
    mountRef: () => state.effects.push('referral'),
  });
  vm.runInContext(gate, context, { filename: `${page}-gate.js` });
  vm.runInContext(centralLoader, context, { filename: `${page}-central.js` });
  vm.runInContext(boot, context, { filename: `${page}-boot.js` });
  return { state, session, signIns, context, element };
}

for (const page of ['prejob', 'postjob']) {
  test(`${page}: fresh direct job link loads automatically after full sign-in`, async () => {
    const h = harness(page);
    h.session.resolve(null);
    await flush();
    assert.equal(h.state.reads, 0, 'must not read Firestore before authentication');
    assert.deepEqual(h.state.effects, [], 'job side effects wait for authentication');
    const login = h.context.gateLogin();
    await flush();
    assert.equal(h.state.reads, 0, 'Hub credentials alone do not imply Firebase is ready');
    h.signIns[0].resolve();
    await login; await flush();
    assert.equal(h.state.reads, 1);
    assert.deepEqual(h.state.rendered, ['Direct link client']);
    assert.equal(h.element('j_name').value, 'Direct link client');
    assert.ok(h.element('egc-gate').classes.has('off'));
    assert.equal(h.state.reloads, 0, 'the job appears without a page reload');
    if (page === 'postjob') assert.equal(h.element('j_payment_amount').value, '300');
  });
  test(`${page}: restored session waits for Firebase and boots exactly once`, async () => {
    const h = harness(page);
    await flush();
    assert.equal(h.state.reads, 0);
    h.state.ready = true;
    h.session.resolve('crewtest');
    await flush();
    assert.equal(h.state.reads, 1);
    assert.equal(h.state.restored, 1);
    assert.deepEqual(h.state.rendered, ['Direct link client']);
    const login = h.context.gateLogin();
    await flush(); h.signIns[0].resolve();
    await login; await flush();
    assert.equal(h.state.reads, 1, 'reauthentication must not overwrite the current checklist');
    assert.equal(h.state.restored, 1);
  });
  test(`${page}: failed login keeps data blocked and a retry loads the job`, async () => {
    const h = harness(page);
    h.session.resolve(null); await flush();
    const failed = h.context.gateLogin();
    await flush(); h.signIns[0].reject(new Error('Incorrect username or password'));
    await failed; await flush();
    assert.equal(h.state.reads, 0);
    assert.ok(!h.element('egc-gate').classes.has('off'));
    assert.equal(h.element('gate-err').style.display, 'block');
    assert.equal(h.element('unlock').disabled, false);
    const retry = h.context.gateLogin();
    await flush(); h.signIns[1].resolve();
    await retry; await flush();
    assert.equal(h.state.reads, 1);
    assert.deepEqual(h.state.rendered, ['Direct link client']);
  });
  test(`${page}: standalone checklist still restores after successful sign-in`, async () => {
    const h = harness(page, { jobId: '' });
    h.state.ready = true; h.session.resolve('crewtest');
    await flush();
    assert.equal(h.state.reads, 0);
    assert.equal(h.state.restored, 1);
    assert.deepEqual(h.state.rendered, ['']);
    assert.ok(h.state.effects.length > 0);
  });
}
