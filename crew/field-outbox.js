/* Crew field outbox: the device-side queue of job, photo and time-clock
   actions. Every item keeps the request ID it was created with and replays one
   at a time, so a lost response or an offline period never saves work twice.
   The same file runs in crew/job.js and in the crew service worker. */
(function (root) {
  'use strict';
  const DB_NAME = 'egc-field-outbox', STORE = 'actions', LOCK = 'egc-field-outbox', SERVER_RETRIES = 5;
  // The retired photo draft queue; its drafts move into the outbox (adoptPhotoDrafts).
  const PHOTO_DRAFTS = 'egc-field-photo-drafts', PHOTO_TIMEOUT = 120000, PHOTO_MAX = 8 * 1024 * 1024;
  const PHOTO_DATA = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  const QUEUEABLE = ['checklist', 'material', 'note', 'status', 'photo', 'end_day'];
  const CLOCK_OPS = ['clock_in', 'break_start', 'break_end', 'clock_out', 'job_time', 'crew_time'];
  // EGC_JOB_STATUS_MOVES_TIME: the time a job status moves the crew member's own shift to. Paused, waiting and delayed keep
  // it where it is; completing moves it back to general shift time (crew/job.js asks first).
  const STATUS_TIME = { dispatched: 'travel', arrived: 'work', in_progress: 'work' };
  // A first attempt the crew member is watching is dropped (and shown) when the
  // server definitively refuses it, exactly like the former single retry card.
  const DIRECT_DISCARD_CODES = ['FIELD_START_INCOMPLETE', 'FIELD_COMPLETION_INCOMPLETE', 'FIELD_STATUS_CONFLICT', 'FIELD_JOB_CLOSED', 'FIELD_ISSUE_CHANGED', 'FIELD_COMPLETION_NOT_FINAL_DAY', 'FIELD_VISIT_ENDED', 'FIELD_VISIT_NOT_STARTED', 'FIELD_VISIT_LIMIT'];
  const STATUS_FLOW = { scheduled: ['dispatched'], confirmed: ['dispatched'], crew_assigned: ['dispatched'], dispatched: ['arrived', 'delayed'], arrived: ['in_progress', 'waiting'], in_progress: ['paused', 'waiting', 'delayed', 'in_progress'] };
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
  const copy = value => JSON.parse(JSON.stringify(value));
  const failure = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
  // A lead's crew-mate move has its own lane, so one the server refuses never holds the lead's own clock actions.
  const lane = item => `${String(item.user).trim().toLowerCase()}|${item.kind === 'clock' ? item.payload?.op === 'crew_time' ? 'crew' : 'clock' : `job:${item.jobId}`}`;
  const isPhoto = item => item?.kind === 'field' && item.payload?.action === 'photo';
  const unavailable = () => failure('This phone could not keep the action on the device. Keep this page open until it is saved.', 0, 'OUTBOX_UNAVAILABLE');
  // A full device is reported as such; it is not a reason to stop using IndexedDB.
  const full = () => failure('This phone is out of storage for saved work. Wait for saved photos to upload or discard some, then try again.', 0, 'OUTBOX_FULL');

  function idbStore(factory, { name = DB_NAME, store: storeName = STORE, key = 'requestId' } = {}) {
    function open() {
      return new Promise((resolve, reject) => {
        if (!factory) return reject(unavailable());
        let request;
        try { request = factory.open(name, 1); } catch { return reject(unavailable()); }
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: key }); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(unavailable());
        request.onblocked = () => reject(unavailable());
      });
    }
    // Each call is one transaction. The action returns the request whose result
    // resolves the call, or reports a result of its own through done().
    async function run(mode, action) {
      const db = await open();
      try {
        return await new Promise((resolve, reject) => {
          let result;
          const tx = db.transaction(storeName, mode), request = action(tx.objectStore(storeName), value => { result = value; });
          const refused = () => reject([tx.error?.name, request?.error?.name].includes('QuotaExceededError') ? full() : unavailable());
          if (request) request.onsuccess = () => { result = request.result; };
          tx.oncomplete = () => resolve(result);
          tx.onerror = refused;
          tx.onabort = refused;
        });
      } finally { db.close(); }
    }
    // Writes a row back only while it is still stored, in the same transaction,
    // so a row discarded or deleted at sign-out meanwhile (in any tab) stays gone.
    const restore = item => run('readwrite', (store, done) => { const found = store.get(item[key]); found.onsuccess = () => { done(found.result !== undefined); if (found.result !== undefined) store.put(item); }; });
    return { persistent: true, all: async () => (await run('readonly', store => store.getAll())) || [], put: item => run('readwrite', store => store.put(item)), restore, remove: id => run('readwrite', store => store.delete(id)) };
  }

  function memoryStore() {
    const rows = new Map();
    return { persistent: false, all: async () => [...rows.values()].map(copy), put: async item => { rows.set(item.requestId, copy(item)); }, restore: async item => rows.has(item.requestId) && Boolean(rows.set(item.requestId, copy(item))), remove: async id => { rows.delete(id); } };
  }

  // Falls back to page memory once when the device refuses IndexedDB, so an
  // online crew member can still work; the page warns before it is closed.
  // Removals keep trying IndexedDB so a confirmed action never replays from
  // its device copy after a reload. A full device refuses a new photo, but a
  // job or time action is still kept in page memory as it was before photos
  // were queued, while the work already saved stays in IndexedDB.
  function deviceStore(factory = root.indexedDB) {
    const primary = idbStore(factory), fallback = memoryStore(), unremoved = new Set(), spilled = new Map();
    let active = factory ? primary : fallback;
    const use = method => async (...args) => {
      try { return await active[method](...args); }
      catch (error) { if (active === fallback || error.code !== 'OUTBOX_UNAVAILABLE') throw error; active = fallback; return active[method](...args); }
    };
    async function put(item) {
      if (spilled.has(item.requestId)) { spilled.set(item.requestId, copy(item)); return; }
      try { await use('put')(item); }
      catch (error) { if (error.code !== 'OUTBOX_FULL' || isPhoto(item)) throw error; spilled.set(item.requestId, copy(item)); }
    }
    const restore = async item => spilled.has(item.requestId) ? Boolean(spilled.set(item.requestId, copy(item))) : use('restore')(item);
    const all = async () => [...(await use('all')()).filter(row => !spilled.has(row?.requestId)), ...[...spilled.values()].map(copy)];
    async function remove(id) {
      if (spilled.delete(id)) return;
      await use('remove')(id);
      if (active !== fallback || !factory) return;
      unremoved.add(id);
      for (const stale of [...unremoved]) { try { await primary.remove(stale); unremoved.delete(stale); } catch { return; } }
    }
    return { get persistent() { return active.persistent && !spilled.size; }, all, put, restore, remove };
  }

  function valid(item) {
    return item && uuid(item.requestId) && typeof item.user === 'string' && item.user.trim() && ['field', 'clock'].includes(item.kind) && item.payload && typeof item.payload === 'object' && Number.isFinite(item.seq);
  }

  function normalize(input, now) {
    const payload = input?.payload;
    if (!input || !uuid(input.requestId) || typeof input.user !== 'string' || !input.user.trim() || !['field', 'clock'].includes(input.kind) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw failure('This action could not be queued. Refresh and try again.', 0, 'OUTBOX_INVALID');
    if (input.kind === 'field' && (payload.requestId !== input.requestId || typeof payload.action !== 'string' || !input.jobId || payload.jobId !== input.jobId || !same(payload.expectedUser, input.user))) throw failure('This job action could not be queued. Refresh and try again.', 0, 'OUTBOX_INVALID');
    if (input.kind === 'field' && payload.action === 'photo' && (typeof payload.category !== 'string' || !payload.category || typeof payload.caption !== 'string' || typeof payload.dataUrl !== 'string' || payload.dataUrl.length > PHOTO_MAX || !PHOTO_DATA.test(payload.dataUrl))) throw failure('This photo could not be kept on this phone. Take or choose it again.', 0, 'OUTBOX_INVALID');
    if (input.kind === 'clock' && (!CLOCK_OPS.includes(payload.op) || typeof payload.entryId !== 'string' || !payload.entryId && payload.op !== 'crew_time' || ['job_time', 'crew_time'].includes(payload.op) && payload.jobAction?.requestId !== input.requestId)) throw failure('This time action could not be queued. Refresh and try again.', 0, 'OUTBOX_INVALID');
    return { requestId: input.requestId, kind: input.kind, user: input.user, jobId: String(input.jobId || ''), queuedAt: input.queuedAt || now().toISOString(), seq: 0, attempts: Math.max(0, Number(input.attempts) || 0), serverFailures: 0, state: 'queued', error: null, payload: copy(payload) };
  }

  function classify(error) {
    const status = Number(error?.status) || 0;
    if (!status) return 'network';
    if (status === 401 && error.code !== 'FIELD_ACCOUNT_CHANGED') return 'auth';
    if (status >= 500 || status === 408 || status === 429 || error.code === 'FIELD_ACTION_PENDING') return 'transient';
    return 'rejected';
  }

  // A refused photo is never dropped on its own: it waits, with its thumbnail, for Retry or Discard.
  const discardOnDirect = (item, error) => !isPhoto(item) && ([400, 403, 404, 415].includes(error.status) || item.kind === 'field' && DIRECT_DISCARD_CODES.includes(error.code));
  // A job-time move a status tap queued behind its status (crew/job.js, EGC_JOB_STATUS_MOVES_TIME) that the server refuses
  // as not allowed (403: this job is not one of the crew member's assigned jobs) is dropped and reported, never left in
  // the crew member's clock lane where it would hold their own clock and job-time actions until they found it.
  const dropOnRefusal = (item, error) => item.kind === 'clock' && item.payload?.op === 'job_time' && item.payload.source === 'status' && Number(error?.status) === 403;
  const detail = error => ({ message: String(error?.message || 'This action was not confirmed.').slice(0, 1000), code: String(error?.code || '').slice(0, 80), status: Number(error?.status) || 0, missing: Array.isArray(error?.missing) ? error.missing.map(item => String(item).slice(0, 500)).slice(0, 40) : [] });

  async function sendClock(item, transport) {
    const { op, entryId, deviceCapturedAt } = item.payload, device = deviceCapturedAt ? { deviceCapturedAt } : {};
    const save = data => transport.employee({ collection: 'timeEntries', id: entryId, data });
    if (op === 'clock_in') {
      // A clock-in creates a card for whoever is signed in, so it is re-checked here.
      const session = await transport.session();
      if (!same(session?.user, item.user)) throw failure('Your signed-in account changed. Sign in as the employee who recorded this time.', 401, 'FIELD_ACCOUNT_CHANGED');
      // Clock-in only: the one position taken as the shift starts (job_page_single_fix), or none when the phone found none
      // and EGC_CLOCK_IN_WITHOUT_FIX lets it clock in anyway, flagged for a manager.
      return save({ locationTracking: true, ...(item.payload.lastLocation ? { lastLocation: item.payload.lastLocation, locationStatus: 'job_page_single_fix' } : { locationStatus: 'location_unavailable_at_clock_in' }), ...device });
    }
    if (op === 'job_time') return save({ jobAction: { requestId: item.payload.jobAction.requestId, expectedSegmentId: item.payload.jobAction.expectedSegmentId, jobId: item.payload.jobAction.jobId, kind: item.payload.jobAction.kind, ...device } });
    // The lead's "move my crew-mates to work": the server finds the job's clocked-in crew-mates and moves each once.
    if (op === 'crew_time') return transport.employee({ collection: 'timeEntries', id: item.payload.jobAction.jobId, expectedUser: item.user, data: { crewJobAction: { requestId: item.payload.jobAction.requestId, jobId: item.payload.jobAction.jobId, kind: 'work', ...device } } });
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
    // Replays confirm the current job version first, like Refresh and retry. A
    // photo always does: it only adds evidence, whatever version was on screen.
    const input = direct && !isPhoto(item) ? item.payload : { ...item.payload, expectedRevision: await transport.revision(item.jobId) };
    return transport.field(input);
  }

  function create({ store = deviceStore(), now = () => new Date(), locks = root.navigator?.locks } = {}) {
    let writes = Promise.resolve(), running = Promise.resolve(), replaying = false, inflight = '', clearedBefore = -Infinity;
    // Discarded while this page's replay was running: it never sends them, even
    // when it read them just before.
    const withdrawn = new Set();
    const serial = task => { const next = writes.then(task, task); writes = next.catch(() => {}); return next; };
    const exclusive = task => locks?.request ? locks.request(LOCK, task) : task();
    const sorted = rows => rows.filter(valid).sort((a, b) => a.seq - b.seq || a.requestId.localeCompare(b.requestId));
    const items = async user => sorted(await store.all()).filter(item => same(item.user, user));
    // A row is written back after a failed send only while it is still stored,
    // so a photo discarded or deleted at sign-out meanwhile is never restored.
    const rewrite = row => store.restore ? store.restore(row) : store.all().then(rows => rows.some(item => item.requestId === row.requestId) && store.put(row).then(() => true));
    const restore = row => serial(() => rewrite(row));

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

    async function replay({ user, transport, direct = '', retry = [], onStart, onApplied }) {
      const result = { applied: [], dropped: [], stopped: null, remaining: 0 }, blocked = new Set(), retrying = new Set(retry);
      for (let guard = 0; guard < 1000; guard++) {
        let item = null;
        for (const row of await items(user)) {
          const key = lane(row);
          if (withdrawn.has(row.requestId) || isPhoto(row) && Date.parse(row.queuedAt) <= clearedBefore) continue;
          if (blocked.has(key)) continue;
          // An action that needs the crew member waits for Retry or Discard, and
          // later actions for the same job or shift wait behind it.
          if (row.state === 'error' && !retrying.has(row.requestId)) { blocked.add(key); continue; }
          item = row; break;
        }
        if (!item) break;
        // Retry gives a refused photo its full run of re-sends again.
        if (retrying.delete(item.requestId) && isPhoto(item)) item = { ...item, serverFailures: 0 };
        const isDirect = item.requestId === direct && item.attempts === 0;
        let data;
        inflight = item.requestId;
        try { if (onStart) onStart(item); data = await send(item, transport, isDirect); }
        catch (error) {
          inflight = '';
          // Another crew action can land between a photo's version check and
          // its upload; the photo is sent again at once with the new version.
          const moved = isPhoto(item) && error?.code === 'FIELD_REVISION_CONFLICT';
          const kind = moved ? 'transient' : classify(error), serverFailures = (Number(item.serverFailures) || 0) + (kind === 'transient' ? 1 : 0);
          // A server error that keeps repeating waits for Retry or Discard like
          // a refusal, so it cannot hold every later action indefinitely.
          const exhausted = kind === 'transient' && serverFailures >= SERVER_RETRIES;
          if (kind !== 'rejected' && !exhausted) {
            await restore({ ...item, attempts: item.attempts + 1, serverFailures, state: 'queued', error: null, lastError: detail(error) });
            if (moved) continue;
            result.stopped = { item, error, reason: kind }; break;
          }
          if (kind === 'rejected' && dropOnRefusal(item, error)) { await remove(item.requestId); result.dropped.push({ item, error: detail(error) }); continue; }
          if (isDirect && discardOnDirect(item, error)) { await remove(item.requestId); result.stopped = { item, error, reason: 'rejected', discarded: true }; break; }
          const refused = exhausted ? { ...detail(error), message: `The server could not confirm this after ${serverFailures} tries. ${detail(error).message}`.slice(0, 1000) } : detail(error);
          // Nothing is left to review when it was discarded or deleted at sign-out meanwhile.
          if (!(await restore({ ...item, attempts: item.attempts + 1, serverFailures, state: 'error', error: refused }))) continue;
          result.stopped = { item: { ...item, state: 'error', error: refused }, error, reason: 'rejected' }; break;
        }
        inflight = '';
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
      if (!options.user || !options.transport) return Promise.resolve({ applied: [], dropped: [], stopped: null, remaining: 0 });
      const next = running.then(() => exclusive(async () => { replaying = true; try { return await replay(options); } finally { replaying = false; inflight = ''; } }));
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

    // A retried photo also gets its full run of re-sends again.
    async function retry(requestId) {
      return serial(async () => { const row = (await store.all()).find(item => item.requestId === requestId); if (row) await rewrite({ ...row, state: 'queued', error: null, ...(isPhoto(row) ? { serverFailures: 0 } : {}) }); });
    }

    // Discarding waits for a replay that may be sending the photo (this page's
    // or the service worker's), so a photo already uploaded is never reported
    // as discarded. While this page's own replay holds the lock, a photo it is
    // not sending is taken off at once. Resolves false when it is no longer on
    // the phone.
    function withdraw(requestId) {
      const take = async () => { if (!(await store.all()).some(item => item.requestId === requestId)) return false; await store.remove(requestId); return true; };
      if (replaying && inflight !== requestId) { withdrawn.add(requestId); return serial(take); }
      const next = running.then(() => exclusive(() => serial(take)));
      running = next.catch(() => {});
      return next;
    }

    // Photos are private job evidence: those still on the phone at a sign-out
    // (queued at or before `before`) are deleted, never uploaded or shown later.
    function purgePhotos(before = Infinity) {
      clearedBefore = Math.max(clearedBefore, Math.min(before, now().getTime()));
      return serial(async () => {
        const gone = [];
        for (const row of await store.all()) if (isPhoto(row) && !(Date.parse(row.queuedAt) > before)) { await store.remove(row.requestId); gone.push(row.requestId); }
        return gone;
      });
    }

    // Drafts from the retired photo queue join the outbox under the ID they
    // were uploaded with, so one whose reply was lost is confirmed rather than
    // saved twice. Only the signed-in account's drafts move.
    async function adoptPhotoDrafts(user, factory = root.indexedDB) {
      const moved = [];
      if (!user || !factory) return moved;
      if (factory.databases) { try { if (!(await factory.databases()).some(db => db.name === PHOTO_DRAFTS)) return moved; } catch { /* Checked by opening it. */ } }
      const drafts = idbStore(factory, { name: PHOTO_DRAFTS, store: 'photos', key: 'id' }), rows = await drafts.all();
      for (const row of rows) {
        if (!row || !same(row.user, user) || !uuid(row.id) || typeof row.jobId !== 'string' || !row.jobId || !PHOTO_DATA.test(row.dataUrl || '')) continue;
        await enqueue({ requestId: row.id, kind: 'field', user, jobId: row.jobId, attempts: 1, payload: { jobId: row.jobId, requestId: row.id, expectedRevision: '', expectedUser: user, action: 'photo', category: String(row.category || 'progress'), caption: typeof row.caption === 'string' ? row.caption : '', dataUrl: row.dataUrl } });
        await drafts.remove(row.id); moved.push(row.id);
      }
      if (moved.length === rows.length && factory.deleteDatabase) { try { factory.deleteDatabase(PHOTO_DRAFTS); } catch { /* An empty store is harmless. */ } }
      return moved;
    }

    return { enqueue, items, flush, remove, retry, withdraw, purgePhotos, adoptPhotoDrafts, migrate, get persistent() { return store.persistent !== false; } };
  }

  // Overlays queued actions on the last confirmed job so the crew sees what is
  // waiting. Rejected actions are not shown as done.
  function projectJob(job, items = []) {
    if (!job) return job;
    const rows = items.filter(item => item.kind === 'field' && item.jobId === job.id);
    const view = { ...job, checklist: (job.checklist || []).map(item => ({ ...item })), materials: (job.materials || []).map(item => ({ ...item })), allowedStatuses: [...(job.allowedStatuses || [])], queued: rows, statusQueued: false };
    // Photos waiting on this phone, refused ones included so they can be reviewed.
    view.photoQueue = rows.filter(isPhoto).map(item => ({ requestId: item.requestId, category: item.payload.category, caption: item.payload.caption, dataUrl: item.payload.dataUrl, queuedAt: item.queuedAt, attempts: item.attempts, state: item.state, error: item.error || null }));
    for (const item of rows) {
      if (item.state === 'error') continue;
      const input = item.payload;
      if (input.action === 'checklist') { const check = view.checklist.find(row => row.id === input.itemId); if (check) Object.assign(check, { completed: input.completed === true, queued: true }); }
      else if (input.action === 'material') { const material = view.materials.find(row => row.id === input.materialId); if (material) Object.assign(material, { state: input.state, queued: true }); }
      else if (input.action === 'status' && view.allowedStatuses.includes(input.status)) {
        const stage = ['paused', 'waiting', 'delayed'].includes(input.status) ? view.status : input.status;
        Object.assign(view, { fieldStatus: input.status, status: stage, allowedStatuses: STATUS_FLOW[stage] || [], statusQueued: true });
      } else if (input.action === 'end_day' && view.visits) {
        // A queued end of day shows the visit day it was saved for as ended until
        // the server confirms it. After midnight that is the previous day, and
        // the job's day ends too only while today's visit has not started.
        const today = view.visits.today, days = view.visits.days || [], date = typeof input.visitDate === 'string' && input.visitDate ? input.visitDate : today;
        const ended = { date, scheduled: false, startedAt: null, ...days.find(day => day.date === date), status: 'ended', endedAt: item.queuedAt || null, endedBy: '', notes: String(input.notes || ''), queued: true };
        view.visits = { ...view.visits, canEndDay: false, days: [...days.filter(day => day.date !== date), ended].sort((a, b) => String(a.date).localeCompare(String(b.date))) };
        if (date === today || !days.some(day => day.date === today && day.status !== 'not_started')) Object.assign(view, { fieldStatus: 'day_ended', allowedStatuses: view.allowedStatuses.filter(status => status !== 'paused'), statusQueued: true });
      }
    }
    return view;
  }

  function projectShift(entry, items = []) {
    let view = entry ? { ...entry, queued: [] } : null;
    for (const item of items.filter(row => row.kind === 'clock' && row.state !== 'error' && row.payload.op !== 'crew_time')) {
      const { op, entryId, deviceCapturedAt: at, jobAction } = item.payload;
      if (op === 'clock_in' && (!view || view.id !== entryId)) {
        if (view) continue;
        view = { id: entryId, clockInAt: at, onBreak: false, breaks: [], clockInLocation: item.payload.lastLocation ? 'shared' : 'missing', currentSegmentId: `clock-in:${entryId}`, current: { id: `clock-in:${entryId}`, kind: 'general', jobId: '', jobLabel: '', startedAt: at }, summary: { recorded: true, partialHistory: false, needsReview: false, jobs: [] }, queued: [] };
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

  // The time a job action moves the crew member's shift to (EGC_JOB_STATUS_MOVES_TIME), or null when it stays: no open
  // shift, segments that need review, or already there. Completing ends only time on this job.
  function statusTime(input, shift, jobId) {
    const kind = input?.action === 'status' ? STATUS_TIME[input.status] : input?.action === 'complete' ? 'general' : '';
    if (!kind || !shift || shift.summary?.needsReview) return null;
    const current = shift.current;
    if (kind === 'general' ? !current || current.kind === 'general' || current.jobId !== jobId : current?.kind === kind && current.jobId === jobId) return null;
    return { kind, jobId: kind === 'general' ? '' : jobId, expectedSegmentId: shift.currentSegmentId || '' };
  }

  function httpTransport(fetchImpl = root.fetch && root.fetch.bind(root), { timeout = 30000, photoTimeout = PHOTO_TIMEOUT } = {}) {
    async function call(url, body, wait = timeout) {
      let response;
      try { response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), ...(root.AbortSignal?.timeout ? { signal: root.AbortSignal.timeout(wait) } : {}) }); }
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
      field: input => call('/api/field-jobs', input, input?.action === 'photo' ? photoTimeout : timeout),
      shift: () => call('/api/employee-hub?view=own-job-time'),
      employee: body => call('/api/employee-hub', body),
    };
  }

  // Background Sync replays only the actions of the account that is signed in now.
  async function replaySignedIn(outbox, transport) {
    let session;
    try { session = await transport.session(); }
    catch (error) { return { applied: [], dropped: [], remaining: 0, stopped: { error, reason: classify(error) } }; }
    return outbox.flush({ user: session.user, transport });
  }

  root.EGCFieldOutbox = { create, deviceStore, memoryStore, idbStore, httpTransport, projectJob, projectShift, statusTime, replaySignedIn, classify, isPhoto, QUEUEABLE, CLOCK_OPS, SYNC_TAG: LOCK, PHOTO_DRAFTS };
})(typeof self !== 'undefined' ? self : globalThis);
