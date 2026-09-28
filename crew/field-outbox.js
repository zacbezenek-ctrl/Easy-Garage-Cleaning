/* Crew field outbox: the device-side queue of job and time-clock actions.
   Every item keeps the request ID it was created with and replays one at a
   time, so a lost response or an offline period never saves work twice. The
   same file runs in crew/job.js and in the crew service worker. */
(function (root) {
  'use strict';
  const DB_NAME = 'egc-field-outbox', STORE = 'actions', LOCK = 'egc-field-outbox', SERVER_RETRIES = 5;
  const QUEUEABLE = ['checklist', 'material', 'note', 'status'];
  const CLOCK_OPS = ['clock_in', 'break_start', 'break_end', 'clock_out', 'job_time'];
  // A first attempt the crew member is watching is dropped (and shown) when the
  // server definitively refuses it, exactly like the former single retry card.
  const DIRECT_DISCARD_CODES = ['FIELD_START_INCOMPLETE', 'FIELD_COMPLETION_INCOMPLETE', 'FIELD_STATUS_CONFLICT', 'FIELD_JOB_CLOSED', 'FIELD_ISSUE_CHANGED'];
  const STATUS_FLOW = { scheduled: ['dispatched'], confirmed: ['dispatched'], crew_assigned: ['dispatched'], dispatched: ['arrived', 'delayed'], arrived: ['in_progress', 'waiting'], in_progress: ['paused', 'waiting', 'delayed', 'in_progress'] };
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
  const copy = value => JSON.parse(JSON.stringify(value));
  const failure = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
  const lane = item => `${String(item.user).trim().toLowerCase()}|${item.kind === 'clock' ? 'clock' : `job:${item.jobId}`}`;
  const unavailable = () => failure('This phone could not keep the action on the device. Keep this page open until it is saved.', 0, 'OUTBOX_UNAVAILABLE');

  function idbStore(factory) {
    function open() {
      return new Promise((resolve, reject) => {
        if (!factory) return reject(unavailable());
        let request;
        try { request = factory.open(DB_NAME, 1); } catch { return reject(unavailable()); }
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'requestId' }); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(unavailable());
        request.onblocked = () => reject(unavailable());
      });
    }
    async function run(mode, action) {
      const db = await open();
      try {
        return await new Promise((resolve, reject) => {
          let result;
          const tx = db.transaction(STORE, mode), request = action(tx.objectStore(STORE));
          request.onsuccess = () => { result = request.result; };
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(unavailable());
          tx.onabort = () => reject(unavailable());
        });
      } finally { db.close(); }
    }
    return { persistent: true, all: async () => (await run('readonly', store => store.getAll())) || [], put: item => run('readwrite', store => store.put(item)), remove: id => run('readwrite', store => store.delete(id)) };
  }

  function memoryStore() {
    const rows = new Map();
    return { persistent: false, all: async () => [...rows.values()].map(copy), put: async item => { rows.set(item.requestId, copy(item)); }, remove: async id => { rows.delete(id); } };
  }

  // Falls back to page memory once when the device refuses IndexedDB, so an
  // online crew member can still work; the page warns before it is closed.
  // Removals keep trying IndexedDB so a confirmed action never replays from
  // its device copy after a reload.
  function deviceStore(factory = root.indexedDB) {
    const primary = idbStore(factory), fallback = memoryStore(), unremoved = new Set();
    let active = factory ? primary : fallback;
    const use = method => async (...args) => {
      try { return await active[method](...args); }
      catch (error) { if (active === fallback || error.code !== 'OUTBOX_UNAVAILABLE') throw error; active = fallback; return active[method](...args); }
    };
    async function remove(id) {
      await use('remove')(id);
      if (active !== fallback || !factory) return;
      unremoved.add(id);
      for (const stale of [...unremoved]) { try { await primary.remove(stale); unremoved.delete(stale); } catch { return; } }
    }
    return { get persistent() { return active.persistent; }, all: use('all'), put: use('put'), remove };
  }

  function valid(item) {
    return item && uuid(item.requestId) && typeof item.user === 'string' && item.user.trim() && ['field', 'clock'].includes(item.kind) && item.payload && typeof item.payload === 'object' && Number.isFinite(item.seq);
  }

  function normalize(input, now) {
    const payload = input?.payload;
    if (!input || !uuid(input.requestId) || typeof input.user !== 'string' || !input.user.trim() || !['field', 'clock'].includes(input.kind) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('This action could not be queued. Refresh and try again.', 0, 'OUTBOX_INVALID');
    if (input.kind === 'field' && (payload.requestId !== input.requestId || typeof payload.action !== 'string' || !input.jobId || payload.jobId !== input.jobId || !same(payload.expectedUser, input.user))) throw failure('This job action could not be queued. Refresh and try again.', 0, 'OUTBOX_INVALID');
    if (input.kind === 'clock' && (!CLOCK_OPS.includes(payload.op) || typeof payload.entryId !== 'string' || !payload.entryId || payload.op === 'job_time' && payload.jobAction?.requestId !== input.requestId)) throw failure('This time action could not be queued. Refresh and try again.', 0, 'OUTBOX_INVALID');
    return { requestId: input.requestId, kind: input.kind, user: input.user, jobId: String(input.jobId || ''), queuedAt: input.queuedAt || now().toISOString(), seq: 0, attempts: Math.max(0, Number(input.attempts) || 0), serverFailures: 0, state: 'queued', error: null, payload: copy(payload) };
  }

  function classify(error) {
    const status = Number(error?.status) || 0;
    if (!status) return 'network';
    if (status === 401 && error.code !== 'FIELD_ACCOUNT_CHANGED') return 'auth';
    if (status >= 500 || status === 408 || status === 429 || error.code === 'FIELD_ACTION_PENDING') return 'transient';
    return 'rejected';
  }

  const discardOnDirect = (item, error) => [400, 403, 404, 415].includes(error.status) || item.kind === 'field' && DIRECT_DISCARD_CODES.includes(error.code);
  const detail = error => ({ message: String(error?.message || 'This action was not confirmed.').slice(0, 1000), code: String(error?.code || '').slice(0, 80), status: Number(error?.status) || 0, missing: Array.isArray(error?.missing) ? error.missing.map(item => String(item).slice(0, 500)).slice(0, 40) : [] });

  async function sendClock(item, transport) {
    const { op, entryId, deviceCapturedAt } = item.payload, device = deviceCapturedAt ? { deviceCapturedAt } : {};
    const save = data => transport.employee({ collection: 'timeEntries', id: entryId, data });
    if (op === 'clock_in') {
      // A clock-in creates a card for whoever is signed in, so it is re-checked here.
      const session = await transport.session();
      if (!same(session?.user, item.user)) throw failure('Your signed-in account changed. Sign in as the employee who recorded this time.', 401, 'FIELD_ACCOUNT_CHANGED');
      // Today's work records one location; the Employee Hub resumes sharing it when opened.
      return save({ locationTracking: true, lastLocation: item.payload.lastLocation, locationStatus: 'unavailable', ...device });
    }
    if (op === 'job_time') return save({ jobAction: { requestId: item.payload.jobAction.requestId, expectedSegmentId: item.payload.jobAction.expectedSegmentId, jobId: item.payload.jobAction.jobId, kind: item.payload.jobAction.kind, ...device } });
    const own = await transport.shift(), entry = own?.entry || null;
    if (!same(own?.user, item.user)) throw failure('Your signed-in account changed. Sign in as the employee who recorded this time.', 401, 'FIELD_ACCOUNT_CHANGED');
    // Break end and clock-out are already satisfied when the shift is closed.
    if (!entry && op !== 'break_start') return { ok: true, alreadyApplied: true };
    if (!entry || entry.id !== entryId) throw failure('Your active shift changed since this was saved. Refresh your shift, then record it again or discard it.', 409, 'OUTBOX_SHIFT_CHANGED');
    const breaks = Array.isArray(entry.breaks) ? entry.breaks : [], request = item.requestId.toLowerCase();
    // The server keeps each break's request ID, so a break changed elsewhere
    // after a lost reply is never started or ended a second time.
    if (breaks.some(row => row?.startRequestId === request || row?.endRequestId === request)) return { ok: true, alreadyApplied: true };
    if (op === 'break_start') return entry.onBreak ? { ok: true, alreadyApplied: true } : save({ breaks: [...breaks, { startAt: deviceCapturedAt || new Date().toISOString(), endAt: '', requestId: item.requestId }], ...device });
    if (op === 'break_end') return entry.onBreak ? save({ breaks: breaks.map((row, index) => index === breaks.length - 1 && !row?.endAt ? { ...row, endAt: deviceCapturedAt || new Date().toISOString(), requestId: item.requestId } : row), ...device }) : { ok: true, alreadyApplied: true };
    return save({ clockOutAt: deviceCapturedAt || new Date().toISOString(), status: 'submitted', ...device });
  }

  async function send(item, transport, direct) {
    if (item.kind === 'clock') return sendClock(item, transport);
    // Replays confirm the current job version first, like Refresh and retry.
    const input = direct ? item.payload : { ...item.payload, expectedRevision: await transport.revision(item.jobId) };
    return transport.field(input);
  }

  function create({ store = deviceStore(), now = () => new Date(), locks = root.navigator?.locks } = {}) {
    let writes = Promise.resolve(), running = Promise.resolve();
    const serial = task => { const next = writes.then(task, task); writes = next.catch(() => {}); return next; };
    const exclusive = task => locks?.request ? locks.request(LOCK, task) : task();
    const sorted = rows => rows.filter(valid).sort((a, b) => a.seq - b.seq || a.requestId.localeCompare(b.requestId));
    const items = async user => sorted(await store.all()).filter(item => same(item.user, user));

    function enqueue(input) {
      return serial(async () => {
        const item = normalize(input, now), rows = sorted(await store.all()), existing = rows.find(row => row.requestId === item.requestId);
        if (existing) return { item: existing, direct: false };
        item.seq = rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
        await store.put(item);
        return { item, direct: !rows.some(row => lane(row) === lane(item)) };
      });
    }
    const remove = requestId => serial(() => store.remove(requestId));

    async function replay({ user, transport, direct = '', retry = [], onApplied }) {
      const result = { applied: [], stopped: null, remaining: 0 }, blocked = new Set(), retrying = new Set(retry);
      for (let guard = 0; guard < 1000; guard++) {
        let item = null;
        for (const row of await items(user)) {
          const key = lane(row);
          if (blocked.has(key)) continue;
          // An action that needs the crew member waits for Retry or Discard, and
          // later actions for the same job or shift wait behind it.
          if (row.state === 'error' && !retrying.has(row.requestId)) { blocked.add(key); continue; }
          item = row; break;
        }
        if (!item) break;
        retrying.delete(item.requestId);
        const isDirect = item.requestId === direct && item.attempts === 0;
        let data;
        try { data = await send(item, transport, isDirect); }
        catch (error) {
          const kind = classify(error), serverFailures = (Number(item.serverFailures) || 0) + (kind === 'transient' ? 1 : 0);
          // A server error that keeps repeating waits for Retry or Discard like
          // a refusal, so it cannot hold every later action indefinitely.
          const exhausted = kind === 'transient' && serverFailures >= SERVER_RETRIES;
          if (kind !== 'rejected' && !exhausted) {
            await serial(() => store.put({ ...item, attempts: item.attempts + 1, serverFailures, state: 'queued', error: null, lastError: detail(error) }));
            result.stopped = { item, error, reason: kind }; break;
          }
          if (isDirect && discardOnDirect(item, error)) { await remove(item.requestId); result.stopped = { item, error, reason: 'rejected', discarded: true }; break; }
          const refused = exhausted ? { ...detail(error), message: `The server could not confirm this after ${serverFailures} tries. ${detail(error).message}`.slice(0, 1000) } : detail(error);
          await serial(() => store.put({ ...item, attempts: item.attempts + 1, serverFailures, state: 'error', error: refused }));
          result.stopped = { item: { ...item, state: 'error', error: refused }, error, reason: 'rejected' }; break;
        }
        await remove(item.requestId);
        result.applied.push({ item, data, direct: isDirect });
        if (onApplied) await onApplied(item, data, isDirect);
      }
      result.remaining = (await items(user)).length;
      return result;
    }

    // Flushes are serialized on this page and, through Web Locks, with the
    // service worker's Background Sync so two replays never overlap.
    function flush(options = {}) {
      if (!options.user || !options.transport) return Promise.resolve({ applied: [], stopped: null, remaining: 0 });
      const next = running.then(() => exclusive(() => replay(options)));
      running = next.catch(() => {});
      return next;
    }

    async function migrate(storage, user, jobId) {
      const moved = [];
      const take = suffix => {
        const name = `egc-field:${user}:${jobId}:${suffix}`;
        try { const raw = storage.getItem(name); return raw ? [name, JSON.parse(raw)] : [name, null]; } catch { return [name, null]; }
      };
      const drop = name => { try { storage.removeItem(name); } catch { /* A stale draft is ignored on the next load. */ } };
      if (!user || !jobId || !storage) return moved;
      const [pendingName, pending] = take('pending');
      if (pending && uuid(pending.requestId) && pending.jobId === jobId && typeof pending.action === 'string') {
        await enqueue({ requestId: pending.requestId, kind: 'field', user, jobId, attempts: 1, payload: { ...pending, expectedUser: pending.expectedUser || user } });
        moved.push(pending.requestId);
      }
      drop(pendingName);
      const [shiftName, shift] = take('shiftAction'), action = shift?.data?.jobAction;
      if (shift?.collection === 'timeEntries' && typeof shift.id === 'string' && shift.id && action && uuid(action.requestId)) {
        await enqueue({ requestId: action.requestId, kind: 'clock', user, jobId, attempts: 1, payload: { op: 'job_time', entryId: shift.id, deviceCapturedAt: '', jobAction: { requestId: action.requestId, expectedSegmentId: action.expectedSegmentId, jobId: action.jobId, kind: action.kind } } });
        moved.push(action.requestId);
      }
      drop(shiftName);
      return moved;
    }

    async function retry(requestId) {
      return serial(async () => { const row = (await store.all()).find(item => item.requestId === requestId); if (row) await store.put({ ...row, state: 'queued', error: null }); });
    }

    return { enqueue, items, flush, remove, retry, migrate, get persistent() { return store.persistent !== false; } };
  }

  // Overlays queued actions on the last confirmed job so the crew sees what is
  // waiting. Rejected actions are not shown as done.
  function projectJob(job, items = []) {
    if (!job) return job;
    const rows = items.filter(item => item.kind === 'field' && item.jobId === job.id);
    const view = { ...job, checklist: (job.checklist || []).map(item => ({ ...item })), materials: (job.materials || []).map(item => ({ ...item })), allowedStatuses: [...(job.allowedStatuses || [])], queued: rows, statusQueued: false };
    for (const item of rows) {
      if (item.state === 'error') continue;
      const input = item.payload;
      if (input.action === 'checklist') { const check = view.checklist.find(row => row.id === input.itemId); if (check) Object.assign(check, { completed: input.completed === true, queued: true }); }
      else if (input.action === 'material') { const material = view.materials.find(row => row.id === input.materialId); if (material) Object.assign(material, { state: input.state, queued: true }); }
      else if (input.action === 'status' && view.allowedStatuses.includes(input.status)) {
        const stage = ['paused', 'waiting', 'delayed'].includes(input.status) ? view.status : input.status;
        Object.assign(view, { fieldStatus: input.status, status: stage, allowedStatuses: STATUS_FLOW[stage] || [], statusQueued: true });
      }
    }
    return view;
  }

  function projectShift(entry, items = []) {
    let view = entry ? { ...entry, queued: [] } : null;
    for (const item of items.filter(row => row.kind === 'clock' && row.state !== 'error')) {
      const { op, entryId, deviceCapturedAt: at, jobAction } = item.payload;
      if (op === 'clock_in' && (!view || view.id !== entryId)) {
        if (view) continue;
        view = { id: entryId, clockInAt: at, onBreak: false, breaks: [], currentSegmentId: `clock-in:${entryId}`, current: { id: `clock-in:${entryId}`, kind: 'general', jobId: '', jobLabel: '', startedAt: at }, summary: { recorded: true, partialHistory: false, needsReview: false, jobs: [] }, queued: [] };
      }
      if (!view || view.id !== entryId) continue;
      if (op === 'clock_out') { view = null; continue; }
      if (op === 'job_time') view = { ...view, currentSegmentId: jobAction.requestId, current: { id: jobAction.requestId, kind: jobAction.kind, jobId: jobAction.jobId, jobLabel: '', startedAt: at } };
      else if (op === 'break_start') view = { ...view, onBreak: true };
      else if (op === 'break_end') view = { ...view, onBreak: false };
      view.queued = [...view.queued, item];
    }
    return view;
  }

  function httpTransport(fetchImpl = root.fetch && root.fetch.bind(root), { timeout = 30000 } = {}) {
    async function call(url, body) {
      let response;
      try { response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), ...(root.AbortSignal?.timeout ? { signal: root.AbortSignal.timeout(timeout) } : {}) }); }
      catch { throw failure('The server did not confirm this action. It stays on this device with its action ID, so it will not be saved twice.', 0, 'OUTBOX_NETWORK'); }
      let data;
      // A reply cut off mid-body leaves the outcome unknown, so the action stays queued.
      try { data = await response.json(); } catch { if (response.ok) throw failure('The server reply was cut off. The action stays on this device with its action ID and will be checked again.', 0, 'OUTBOX_NETWORK'); data = {}; }
      if (!response.ok || !data?.ok) throw Object.assign(failure(data.error || 'Job services are unavailable. Your action stays on this device; retry shortly.', response.status || 503, data.code || ''), { missing: data.missing });
      return data;
    }
    return {
      session: () => call('/api/hub-auth'),
      async revision(jobId) {
        const data = await call(`/api/field-jobs?jobId=${encodeURIComponent(jobId)}&view=timer`);
        if (typeof data.expectedRevision !== 'string' || !data.expectedRevision) throw failure('The current job version could not be confirmed. Retry shortly.', 503, 'FIELD_SERVICE_UNAVAILABLE');
        return data.expectedRevision;
      },
      field: input => call('/api/field-jobs', input),
      shift: () => call('/api/employee-hub?view=own-job-time'),
      employee: body => call('/api/employee-hub', body),
    };
  }

  // Background Sync replays only the actions of the account that is signed in now.
  async function replaySignedIn(outbox, transport) {
    let session;
    try { session = await transport.session(); }
    catch (error) { return { applied: [], remaining: 0, stopped: { error, reason: classify(error) } }; }
    return outbox.flush({ user: session.user, transport });
  }

  root.EGCFieldOutbox = { create, deviceStore, memoryStore, idbStore, httpTransport, projectJob, projectShift, replaySignedIn, classify, QUEUEABLE, CLOCK_OPS, SYNC_TAG: LOCK };
})(typeof self !== 'undefined' ? self : globalThis);
