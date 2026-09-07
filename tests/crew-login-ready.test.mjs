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
function harness(page, { jobId = 'job-test', readError = null, missing = false, handoff = null, draft = null, owner = 'crewtest', scopedDraft = null } = {}) {
  const html = fs.readFileSync(path.join(site, 'crew', `${page}.html`), 'utf8');
  const gate = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes('async function gateLogin()'));
  const centralLoader = html.split(/\r?\n/).find(line => line.startsWith('async function loadCentralJob(){'));
  const boot = html.slice(html.indexOf('let crewWorkflowReady='), html.lastIndexOf('</script>'));
  const restoration = html.slice(html.indexOf('function saveAll(){'), html.indexOf('function key(si,ii){'));
  const inputListener = html.split(/\r?\n/).find(line => line.startsWith('document.addEventListener("input"'));
  const fieldIds = JSON.parse(html.match(/const FIELD_IDS=(\[[^;]+\]);/)[1]);
  assert.ok(gate && centralLoader && boot, `${page}: production script anchors found`);
  const session = deferred();
  const signIns = [];
  const elements = new Map(), listeners = new Map(), storage = new Map();
  if (handoff) storage.set('egc_active_job', JSON.stringify(handoff));
  if (draft) storage.set(`egc_${page}_v1:${jobId || 'manual'}`, JSON.stringify(draft));
  if (scopedDraft) storage.set(`egc_${page}_v1:${owner}:${jobId || 'manual'}`, JSON.stringify(scopedDraft));
  const state = { ready: false, reads: 0, restored: 0, rendered: [], saved: 0, effects: [], reloads: 0, readError, missing };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'gate-u' ? 'crewtest' : id === 'gate-p' ? 'test-password' : '',
      style: { display: ['crew-workflow', 'donebar'].includes(id) ? 'none' : '' }, textContent: '', disabled: false,
      classes: new Set(),
      classList: { add(value) { elements.get(id).classes.add(value); } },
      addEventListener() {}, focus() {},
    });
    return elements.get(id);
  }
  const job = { customer: 'Direct link client', address: '12 Test Street', phone: '5555550100', date: '2026-09-07', total: 400, payment: { amount: 100 } };
  const context = vm.createContext({
    document: { getElementById: element, querySelector: () => element('unlock'), addEventListener: (type, handler) => listeners.set(type, handler) },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
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
        assert.equal(id, jobId || handoff?.jobId);
        return { async get(options) {
          assert.deepEqual({ ...options }, { source: 'server' }, 'direct job access must be verified online');
          state.reads++;
          if (state.readError) throw state.readError;
          if (state.missing) return { exists: false };
          if (!state.ready) throw new Error('permission-denied: Firebase is still signed out');
          return { exists: true, id, data: () => job };
        } };
      } };
    } },
    CENTRAL_JOB_ID: jobId, REQUESTED_JOB_ID: jobId, SAVEKEY: `egc_${page}_v1`, STARTKEY: 'egc_prejob_start',
    ACTIVE: {}, FIELD_IDS: fieldIds, state: {}, clientState: {}, GUARD: '', progressIdentity: () => owner,
    restoreSharedProgress: () => {},
    normalizedInstructions: () => [],
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
  for (const prefix of ['const storageOwner=', 'const saveKey=', 'const startKey=', 'function jobKey(){']) {
    const line = html.split(/\r?\n/).find(row => row.startsWith(prefix));
    if (line) vm.runInContext(line, context, { filename: `${page}-storage-key.js` });
  }
  vm.runInContext(centralLoader, context, { filename: `${page}-central.js` });
  vm.runInContext(restoration, context, { filename: `${page}-restore.js` });
  const restore = context.restoreAll, save = context.saveAll;
  context.restoreAll = () => { state.restored++; return restore(); };
  context.saveAll = () => { state.saved++; return save(); };
  vm.runInContext(boot, context, { filename: `${page}-boot.js` });
  vm.runInContext(inputListener, context, { filename: `${page}-input.js` });
  return { state, session, signIns, context, element, listeners, storage };
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
  for (const failure of ['missing', 'permission-denied', 'unavailable']) {
    test(`${page}: ${failure} keeps a direct job blocked without showing cached details or starting effects`, async () => {
      const draft = { state: { '0_0': true }, fields: { j_name: 'Cached private client' } };
      const h = harness(page, {
        missing: failure === 'missing',
        readError: failure === 'missing' ? null : Object.assign(new Error('Provider detail'), { code: failure }),
        handoff: { jobId: 'another-job', name: 'Wrong client', startedAt: '2000-01-01' },
        draft,
      });
      h.state.ready = true; h.session.resolve('crewtest'); await flush();
      assert.equal(h.state.reads, 1);
      assert.deepEqual(h.state.rendered, []);
      assert.deepEqual(h.state.effects, []);
      assert.equal(h.state.saved, 0, 'failed reads cannot overwrite the saved draft');
      assert.equal(h.element('crew-workflow').style.display, 'none');
      assert.equal(h.element('donebar').style.display, 'none');
      assert.equal(h.element('crew-job-retry').disabled, false);
      assert.equal(h.element('j_name').value, '');
      assert.deepEqual({ ...h.context.ACTIVE }, {});
      assert.deepEqual(JSON.parse(h.storage.get(`egc_${page}_v1:job-test`)), draft);
      assert.match(h.element('crew-job-message').textContent, failure === 'missing' ? /no longer available/ : failure === 'permission-denied' ? /cannot open this job/ : /connection and retry/);
    });
  }
  test(`${page}: a failed job read can retry without a reload and preserves this job's saved checklist`, async () => {
    const h = harness(page, {
      readError: Object.assign(new Error('Offline'), { code: 'unavailable' }),
      draft: { state: { '0_0': true }, fields: { j_name: 'Old name for this job' } },
      handoff: { jobId: 'another-job', name: 'Wrong client', startedAt: '2000-01-01' },
    });
    h.state.ready = true; h.session.resolve('crewtest'); await flush();
    h.state.readError = null;
    await h.context.openCrewWorkflow();
    assert.equal(h.state.reads, 2);
    assert.deepEqual(h.state.rendered, ['Direct link client']);
    assert.equal(h.context.state['0_0'], true);
    assert.equal(h.context.ACTIVE.jobId, 'job-test');
    assert.equal(h.context.ACTIVE.startedAt, undefined, 'another job cannot supply inherited fields');
    assert.equal(h.element('crew-workflow').style.display, '');
    assert.equal(h.element('donebar').style.display, '');
    assert.equal(h.element('crew-job-access').style.display, 'none');
    assert.equal(h.state.reloads, 0);
    await h.context.openCrewWorkflow();
    assert.equal(h.state.reads, 2, 'a completed boot cannot be repeated');
  });
  test(`${page}: entering login credentials cannot overwrite an existing job draft`, async () => {
    const draft = { state: { '0_0': true }, fields: { j_name: 'Saved client' } };
    const h = harness(page, { draft });
    h.session.resolve(null); await flush();
    h.listeners.get('input')({ target: h.element('gate-u') });
    h.listeners.get('input')({ target: h.element('gate-p') });
    assert.equal(h.state.saved, 0);
    assert.deepEqual(JSON.parse(h.storage.get(`egc_${page}_v1:job-test`)), draft);
  });
  test(`${page}: standalone drafts and manual photos belong to the authenticated employee`, async () => {
    const legacy = { fields: { j_name: 'Unknown legacy owner' } };
    const own = { state: { '0_0': true }, fields: { j_name: 'My standalone client' } };
    const h = harness(page, { jobId: '', draft: legacy, scopedDraft: own, handoff: { name: 'Another employee client' } });
    const other = JSON.stringify({ fields: { j_name: 'Other employee client' } });
    h.storage.set(`egc_${page}_v1:otherperson:manual`, other);
    h.state.ready = true; h.session.resolve('crewtest'); await flush();
    assert.equal(h.state.reads, 0);
    assert.equal(h.element('j_name').value, 'My standalone client');
    assert.equal(h.context.state['0_0'], true);
    assert.equal(h.context.ACTIVE.name, undefined);
    assert.match(h.context.jobKey(), /crewtest/);
    if (page === 'prejob') assert.match(vm.runInContext('startKey()', h.context), /:crewtest:manual$/);
    h.element('j_name').value = 'Updated my client';
    h.context.saveAll();
    assert.equal(JSON.parse(h.storage.get(`egc_${page}_v1:crewtest:manual`)).fields.j_name, 'Updated my client');
    assert.equal(h.storage.get(`egc_${page}_v1:otherperson:manual`), other);
    assert.deepEqual(JSON.parse(h.storage.get(`egc_${page}_v1:manual`)), legacy);
  });
  test(`${page}: unowned standalone data is ignored without deleting it`, async () => {
    const legacy = { fields: { j_name: 'Another employee client' } };
    const h = harness(page, { jobId: '', draft: legacy, handoff: { name: 'Another employee client' } });
    h.state.ready = true; h.session.resolve('crewtest'); await flush();
    assert.equal(h.element('j_name').value, '');
    assert.deepEqual({ ...h.context.ACTIVE }, {});
    assert.deepEqual(JSON.parse(h.storage.get(`egc_${page}_v1:manual`)), legacy);
    assert.equal(h.element('crew-workflow').style.display, '');
  });
  test(`${page}: an old standalone job handoff must pass a current server read before it appears`, async () => {
    const h = harness(page, { jobId: '', handoff: { jobId: 'saved-job', name: 'Untrusted handoff name', startedAt: '2000-01-01' } });
    h.state.ready = true; h.session.resolve('crewtest'); await flush();
    assert.equal(h.state.reads, 1);
    assert.equal(h.context.ACTIVE.jobId, 'saved-job');
    assert.equal(h.context.ACTIVE.name, 'Direct link client');
    assert.equal(h.context.ACTIVE.startedAt, undefined);
    assert.ok(h.storage.has(`egc_${page}_v1:crewtest:saved-job`));
  });
  test(`${page}: a denied old handoff stays private and the employee can open their own standalone draft`, async () => {
    const handoff = { jobId: 'private-other-job', name: 'Other employee client' };
    const h = harness(page, { jobId: '', handoff, readError: Object.assign(new Error('Denied'), { code: 'permission-denied' }), scopedDraft: { fields: { j_name: 'My standalone client' } } });
    h.state.ready = true; h.session.resolve('crewtest'); await flush();
    assert.equal(h.state.reads, 1);
    assert.equal(h.state.restored, 0, 'authorization must precede any legacy draft restoration');
    assert.equal(h.element('crew-workflow').style.display, 'none');
    assert.deepEqual(h.state.effects, []);
    assert.equal(h.element('crew-job-standalone').hidden, false);
    await h.context.openCrewWorkflow(true);
    assert.equal(h.state.reads, 1);
    assert.equal(h.element('j_name').value, 'My standalone client');
    assert.equal(h.element('crew-workflow').style.display, '');
    assert.deepEqual({ ...h.context.ACTIVE }, {});
    assert.deepEqual(JSON.parse(h.storage.get('egc_active_job')), handoff);
  });
}
