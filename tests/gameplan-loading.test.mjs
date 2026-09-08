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
const flush = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };

function harness({ requestedId = 'walkthrough-1', draft = null, manualDraft = null } = {}) {
  const nodes = new Map(), storage = new Map(), writes = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, innerHTML: '', textContent: '' });
    return nodes.get(id);
  };
  const state = { directReads: 0, listReads: 0, photos: 0, directError: null, listError: null, missing: false, wait: null, replaced: [] };
  const requested = { type: 'walkthrough', status: 'scheduled', customer: 'Current customer', phone: '9705550100', address: '12 Current Street', highlevelAppointmentId: 'appointment-1' };
  const rows = [{ id: 'other-walkthrough', type: 'walkthrough', status: 'scheduled', customer: 'Another appointment', time: '09:00' }];
  if (draft) storage.set(`egc_walkthrough_v3:${requestedId}`, JSON.stringify(draft));
  if (manualDraft) storage.set('egc_walkthrough_v3:manual', JSON.stringify(manualDraft));
  const context = vm.createContext({
    $: element, esc: value => String(value).replaceAll('<', '&lt;'),
    SAVE: 'egc_walkthrough_v3', FLOW: '2026-09-simple', REQUESTED_WALKTHROUGH_ID: requestedId,
    walkthroughReady: false, APPTS_LOADING: false, APPTS_ERROR: '', APPTS: [],
    index: 0, error: '', SLOT_OPTIONS: [], SLOT_ERROR: '', SLOT_LOADING: false, SLOT_SIGNATURE: '',
    sections: ['Customer', 'Photos', 'Scope', 'Finish', 'Schedule', 'Review'],
    screens: Array.from({ length: 6 }, () => () => `<div>Editable walkthrough: ${context.S.name}</div>`),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => { writes.push(key); storage.set(key, value); } },
    location: { pathname: '/crew/gameplan', search: requestedId ? `?walkthroughId=${requestedId}` : '' },
    history: { replaceState: (...args) => state.replaced.push(args[2]) },
    refreshPhotoCount: () => { state.photos++; }, mountPhotos: () => {},
    slotSignature: () => '', findNearestSlots: () => {}, initSignature: () => {}, setTimeout: () => {},
    hubDb: { collection(name) {
      assert.equal(name, 'jobs');
      return {
        doc(id) {
          assert.equal(id, requestedId);
          return { async get(options) {
            assert.deepEqual({ ...options }, { source: 'server' });
            state.directReads++;
            if (state.wait) await state.wait;
            if (state.directError) throw state.directError;
            return { exists: !state.missing, id, data: () => requested };
          } };
        },
        where(field, comparison, date) {
          assert.equal(field, 'date'); assert.equal(comparison, '=='); assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
          return { async get(options) {
            assert.deepEqual({ ...options }, { source: 'server' });
            state.listReads++;
            if (state.listError) throw state.listError;
            return { docs: rows.map(row => ({ id: row.id, data: () => row })) };
          } };
        },
      };
    } },
  });
  vm.runInContext(line('const freshState='), context);
  context.S = vm.runInContext('freshState()', context);
  for (const prefix of ['const draftKey=', 'function save(){', 'function restore(', 'function resetForWalkthrough(', 'function render(){', 'function useAppointment(', 'async function openApp()']) {
    vm.runInContext(line(prefix), context);
  }
  vm.runInContext(html.slice(html.indexOf('function walkthroughLoadPanel(){'), html.indexOf('function useAppointment(')), context);
  return { context, state, requested, rows, element, storage, writes };
}

const saved = (sourceWalkthroughId, name = 'Saved customer') => ({ flow: '2026-09-simple', index: 2, S: { sourceWalkthroughId, name, notes: 'Keep these field notes', signature: 'saved-signature', approved: true, termsVersion: '2026-09-deposit50', jobId: 'prepared-job' } });

test('requested walkthrough stays blocked while loading and a failed read preserves the complete saved draft', async () => {
  const draft = saved('walkthrough-1'), h = harness({ draft });
  let resume;
  h.state.wait = new Promise(resolve => { resume = resolve; });
  h.state.directError = Object.assign(new Error('Private provider detail'), { code: 'unavailable' });
  const pending = h.context.openApp(); await flush();
  assert.equal(h.context.walkthroughReady, false);
  assert.match(h.element('screen').innerHTML, /Opening walkthrough/);
  assert.doesNotMatch(h.element('screen').innerHTML, /Editable walkthrough|Saved customer/);
  assert.equal(h.element('next').style.display, 'none');
  assert.deepEqual(h.writes, []);
  resume(); await pending;
  assert.match(h.element('screen').innerHTML, /connection and retry/);
  assert.doesNotMatch(h.element('screen').innerHTML, /Private provider detail|Editable walkthrough/);
  assert.equal(h.state.photos, 0);
  assert.equal(h.context.APPTS_LOADING, false);
  assert.deepEqual(JSON.parse(h.storage.get('egc_walkthrough_v3:walkthrough-1')), draft);
});

test('retry opens the verified requested appointment and preserves saved notes, signature, and stage', async () => {
  const h = harness({ draft: saved('walkthrough-1') });
  h.state.directError = Object.assign(new Error('Offline'), { code: 'unavailable' });
  await h.context.openApp();
  h.state.directError = null;
  assert.equal(await h.context.loadAppointments(), true);
  assert.equal(h.state.directReads, 2);
  assert.equal(h.context.walkthroughReady, true);
  assert.equal(h.context.S.name, 'Current customer');
  assert.equal(h.context.S.highlevelAppointmentId, 'appointment-1');
  assert.equal(h.context.S.notes, 'Keep these field notes');
  assert.equal(h.context.S.signature, 'saved-signature');
  assert.equal(h.context.S.approved, true);
  assert.equal(h.context.S.jobId, 'prepared-job');
  assert.equal(h.context.index, 2);
  assert.equal(h.context.S.sourceWalkthroughId, 'walkthrough-1');
  assert.match(h.element('screen').innerHTML, /Editable walkthrough: Current customer/);
  assert.equal(h.state.photos, 1);
});

for (const condition of ['missing', 'wrong-type', 'cancelled', 'completed', 'permission-denied']) {
  test(`${condition} requested walkthrough cannot silently open another appointment or a blank editor`, async () => {
    const draft = saved('walkthrough-1'), h = harness({ draft });
    if (condition === 'missing') h.state.missing = true;
    else if (condition === 'wrong-type') h.requested.type = 'job';
    else if (condition === 'permission-denied') h.state.directError = Object.assign(new Error('Denied'), { code: condition });
    else h.requested.status = condition;
    await h.context.openApp();
    assert.equal(h.context.walkthroughReady, false);
    assert.equal(h.context.S.name, '');
    assert.deepEqual([...h.context.APPTS], []);
    assert.match(h.element('screen').innerHTML, /Retry loading/);
    assert.match(h.element('screen').innerHTML, /Open a manual walkthrough/);
    assert.doesNotMatch(h.element('screen').innerHTML, /Editable walkthrough|Another appointment/);
    assert.equal(h.state.photos, 0);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(JSON.parse(h.storage.get('egc_walkthrough_v3:walkthrough-1')), draft);
  });
}

test('a schedule query failure is visible and cannot publish a partial list or restore the requested draft', async () => {
  const h = harness({ draft: saved('walkthrough-1') });
  h.context.APPTS = [{ id: 'stale', customer: 'Stale customer' }];
  h.state.listError = new Error('Offline');
  await h.context.openApp();
  assert.equal(h.state.directReads, 1); assert.equal(h.state.listReads, 1);
  assert.equal(h.context.walkthroughReady, false);
  assert.deepEqual([...h.context.APPTS], []);
  assert.deepEqual(h.writes, []);
  assert.match(h.element('screen').innerHTML, /schedule could not load/);
});

test('a route without a requested appointment preserves manual work and reports schedule failures accurately', async () => {
  const h = harness({ requestedId: '', manualDraft: saved('', 'Manual customer') });
  h.state.listError = new Error('Offline');
  await h.context.openApp();
  assert.equal(h.context.walkthroughReady, true);
  assert.equal(h.state.directReads, 0);
  assert.equal(h.context.S.notes, 'Keep these field notes');
  assert.match(h.element('screen').innerHTML, /Editable walkthrough: Manual customer/);
  assert.match(h.element('screen').innerHTML, /schedule could not load/);
  h.context.S.notes = 'New unsaved work';
  h.state.listError = null;
  await h.context.loadAppointments();
  assert.equal(h.context.S.notes, 'New unsaved work', 'retry must not restore over current work');
  assert.equal(h.context.APPTS_ERROR, '');
});

test('explicit manual entry after a missing direct link uses the manual draft and never overwrites the requested draft', async () => {
  const draft = saved('walkthrough-1'), h = harness({ draft, manualDraft: saved('', 'Manual customer') });
  h.state.missing = true;
  await h.context.openApp();
  await h.context.openManualWalkthrough();
  assert.equal(h.context.REQUESTED_WALKTHROUGH_ID, '');
  assert.equal(h.context.S.name, 'Manual customer');
  assert.equal(h.context.walkthroughReady, true);
  assert.deepEqual(h.state.replaced, ['/crew/gameplan']);
  h.context.S.notes = 'Manual edit'; h.context.save();
  assert.deepEqual(JSON.parse(h.storage.get('egc_walkthrough_v3:walkthrough-1')), draft);
  assert.equal(JSON.parse(h.storage.get('egc_walkthrough_v3:manual')).S.notes, 'Manual edit');
});

test('login input cannot save over a requested walkthrough before it has loaded', () => {
  const draft = saved('walkthrough-1'), h = harness({ draft });
  h.context.save();
  assert.deepEqual(h.writes, []);
  assert.deepEqual(JSON.parse(h.storage.get('egc_walkthrough_v3:walkthrough-1')), draft);
});

test('a saved draft under earlier deposit terms preserves its work but requires fresh customer approval', async () => {
  const draft=saved('walkthrough-1');
  draft.S.termsVersion='2026-09-simple';
  draft.S.lockedPrice='1425';
  draft.S.priceManuallySet=true;
  const h=harness({draft});
  await h.context.openApp();
  assert.equal(h.context.S.notes,'Keep these field notes');
  assert.equal(h.context.S.lockedPrice,'1425');
  assert.equal(h.context.S.jobId,'prepared-job');
  assert.equal(h.context.S.approved,false);
  assert.equal(h.context.S.signature,'');
  assert.equal(h.context.S.termsVersion,'2026-09-deposit50');
});
