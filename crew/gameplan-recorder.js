/* FUN-06: the iPad walkthrough recorder in the gameplan. Start asks for recording consent, records the
   walkthrough in parts (about 20 MB or 20 minutes each) into IndexedDB every second, and Finish records
   the outcome through /api/walkthrough-visit (FUN-05). The audio uploads to /api/operations-recordings
   part by part, in order, keeping each part's request ID across retries; a part leaves the iPad only
   after the server confirms it. Nothing is recorded or uploaded for a customer who declined. One gameplan tab
   holds a walkthrough (session.owner) from Start until it leaves the iPad; another tab only says so. Recording in the
   Hub needs Web Locks (Safari on iPadOS 15.4 or later): without them the page records nothing and holds or takes no
   walkthrough; one it saves (a walkthrough without Hub audio, a no-show, a Voice Memos file) belongs to no tab. The core
   (storage, recorder, sync) runs without a page, so tests drive it with fakes and an injected clock. */
(function (root) {
  'use strict';
  const DB_NAME = 'egc-walkthrough-recorder', SESSIONS = 'sessions', CHUNKS = 'chunks';
  // degradedPartMs: parts are closed (and uploaded) sooner while the iPad keeps audio only in page memory. healthyMs: an
  // interruption warning clears after this long of healthy recording. uploadMs: the upload transport's timeout. abortMs: how
  // long a withdrawal waits for this tab's uploads to stop before it reports. watchMs: how often a tab looks again at a
  // walkthrough another tab holds (to take it back once that tab is gone).
  const LIMITS = Object.freeze({ partBytes: 20 * 1024 * 1024, partMs: 20 * 60 * 1000, degradedPartMs: 2 * 60 * 1000, uploadBytes: 24 * 1024 * 1024, bitsPerSecond: 48000, timesliceMs: 1000, nudgeMs: 3000, stallMs: 15000, stopMs: 5000, resumeGapMs: 2000, serverRetries: 5, healthyMs: 60000, abortMs: 3000, watchMs: 5000, uploadMs: 10 * 60 * 1000 });
  // Interruption warnings the rep can dismiss, and that clear themselves after a healthy minute.
  const PASSING_PROBLEMS = new Set(['resumed', 'track_ended', 'recorder_error', 'stalled', 'unmuted']);
  // Safari records AAC in MP4; Chrome and Firefox fall back to Opus.
  const MIME_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  // The types the recording service accepts today. An .m4a from Voice Memos (audio/x-m4a) is an MP4 container, sent as audio/mp4.
  const UPLOAD_TYPES = { 'audio/mp4': 'audio/mp4', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/aac': 'audio/aac', 'audio/x-aac': 'audio/aac', 'audio/webm': 'audio/webm', 'audio/ogg': 'audio/ogg', 'audio/mpeg': 'audio/mpeg', 'audio/mp3': 'audio/mpeg', 'audio/wav': 'audio/wav', 'audio/x-wav': 'audio/x-wav', 'audio/wave': 'audio/wav', 'audio/flac': 'audio/flac' };
  const BY_EXTENSION = { m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac' };
  const EXTENSIONS = { 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac' };
  const ACCEPT = 'audio/*,.m4a,audio/x-m4a,audio/m4a,audio/mp4,.mp3,.wav,.aac,.webm';
  // Timecard refusals need the rep's decision (clock in, or record without the timecard), never a silent retry.
  const TIMECARD_CODES = new Set(['walkthrough_visit_clock_in_required', 'walkthrough_visit_time_unavailable', 'walkthrough_visit_time_invalid']);
  const RECHECK_CODES = new Set(['walkthrough_visit_already_started', 'walkthrough_visit_closed', 'walkthrough_visit_not_started']);
  // Only the Hub's own sign-in refusals wait for the rep to sign in; any other 401 (an upstream signature refusal) is a refusal.
  const AUTH_CODES = new Set(['HUB_AUTH_REQUIRED', 'business_session_required', 'walkthrough_visit_sign_in_required']);
  // A part is settled once the service confirmed it, or once the rep removed it from the iPad after saving a copy.
  const SETTLED_PARTS = new Set(['uploaded', 'removed']);
  // A part that reached (or may have reached) the recording service although the customer withdrew consent: the walkthrough
  // stays on the iPad until the rep confirms telling the office, which deletes it there.
  const NOTICE = 'uploaded_after_withdrawal';
  const noticePending = part => part?.state === NOTICE && !part.acknowledgedAt;
  // The sync's own fields on a part row. part.sendingAt is set (in the write that re-checks the part) just before an upload of
  // it starts, and cleared in the write that saves how that upload ended: a page that is gone before then leaves it, so the
  // tab that takes the walkthrough back treats that upload as possibly on the recording service (adoptParts).
  const SYNC_FIELDS = ['sendingAt', 'unconfirmed', 'attempts', 'serverFailures', 'lastError'];
  const withSync = (next, saved) => { const row = copy(next); for (const key of SYNC_FIELDS) { if (saved && saved[key] !== undefined) row[key] = copy(saved[key]); else delete row[key]; } return row; };
  const without = (row, key) => { const next = { ...row }; delete next[key]; return next; };

  const baseType = type => String(type || '').split(';')[0].trim().toLowerCase();
  const extensionFor = type => EXTENSIONS[UPLOAD_TYPES[baseType(type)] || ''] || 'audio';
  const failure = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
  const iso = ms => new Date(ms).toISOString();
  const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
  const copy = value => JSON.parse(JSON.stringify(value));
  const chunkId = (partId, seq) => `${partId}|${String(seq).padStart(7, '0')}`;
  const detail = error => ({ message: String(error?.message || 'This was not confirmed.').slice(0, 600), code: String(error?.code || '').slice(0, 80), status: Number(error?.status) || 0, kind: classify(error), details: error?.details && typeof error.details === 'object' ? copy(error.details) : null });

  /** The first recorder type this browser supports: '' lets the browser choose, null means it cannot record. */
  function pickMime(Recorder) {
    if (typeof Recorder !== 'function') return null;
    if (typeof Recorder.isTypeSupported !== 'function') return '';
    for (const type of MIME_TYPES) { try { if (Recorder.isTypeSupported(type)) return type; } catch { /* try the next type */ } }
    return '';
  }
  /** The upload type of a chosen file, from its type or else its extension; null when it is not audio we can send. */
  function importType(file) {
    const extension = /\.([a-z0-9]{2,4})$/i.exec(String(file?.name || ''))?.[1]?.toLowerCase();
    return UPLOAD_TYPES[baseType(file?.type)] || BY_EXTENSION[extension] || null;
  }
  async function bytesOf(blob) {
    if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsArrayBuffer(blob); });
  }
  function classify(error) {
    const status = Number(error?.status) || 0;
    if (!status) return 'network';
    if (status === 401) return AUTH_CODES.has(error?.code) ? 'auth' : 'rejected';
    if (TIMECARD_CODES.has(error?.code)) return 'rejected';
    if (status >= 500 || status === 408 || status === 429) return 'transient';
    return 'rejected';
  }

  // ---- Device storage: sessions (plain records) and audio chunks (ArrayBuffers, which WebKit always stores). ----
  // Two gameplan tabs on one iPad share this storage. atomic(fn) is one read-modify-write of the sessions (one
  // IndexedDB transaction, which no other tab can interleave): fn(rows) returns {put, remove, result} and must be pure,
  // because a transaction WebKit drops is run again. putChunk(chunk, check) saves a chunk only while check(session)
  // holds in the same transaction, so a tab that lost the recording can never add audio to it.
  function memoryStore() {
    const sessions = new Map(), chunks = new Map(), prefix = partId => `${partId}|`;
    return { persistent: false,
      sessions: async () => [...sessions.values()].map(copy),
      putSession: async session => { sessions.set(session.id, copy(session)); },
      removeSession: async id => { sessions.delete(id); },
      atomic: async fn => { const out = fn([...sessions.values()].map(copy)) || {}; for (const row of out.put || []) sessions.set(row.id, copy(row)); for (const id of out.remove || []) sessions.delete(id); return out; },
      putChunk: async (chunk, check) => { if (check && !check(sessions.has(chunk.sessionId) ? copy(sessions.get(chunk.sessionId)) : null)) return 'refused'; chunks.set(chunk.id, { ...chunk }); return 'saved'; },
      chunks: async partId => [...chunks.values()].filter(row => row.id.startsWith(prefix(partId))).sort((a, b) => a.seq - b.seq),
      removeChunks: async partId => { for (const id of [...chunks.keys()]) if (id.startsWith(prefix(partId))) chunks.delete(id); },
    };
  }
  function idbStore(factory = root.indexedDB, KeyRange = root.IDBKeyRange) {
    let opening = null;
    const unavailable = () => failure('This iPad could not keep the recording on the device.', 0, 'RECORDER_STORAGE_UNAVAILABLE');
    function open() {
      if (!opening) opening = new Promise((resolve, reject) => {
        if (!factory || !KeyRange) return reject(unavailable());
        let request;
        try { request = factory.open(DB_NAME, 1); } catch { return reject(unavailable()); }
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'id' });
          if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: 'id' });
        };
        request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opening = null; }; db.onclose = () => { opening = null; }; resolve(db); };
        request.onerror = () => reject(unavailable());
        request.onblocked = () => reject(unavailable());
      }).catch(error => { opening = null; throw error; });
      return opening;
    }
    // action(tx, done, guard): done(value) sets the result, resolved when the transaction commits; guard wraps a
    // request handler so a throw aborts the transaction and is reported as itself, not as lost storage.
    async function run(names, mode, action, again = true) {
      const db = await open(), state = { error: null };
      try {
        return await new Promise((resolve, reject) => {
          let result;
          const tx = db.transaction(names, mode);
          const guard = fn => (...args) => { try { return fn(...args); } catch (error) { state.error = error; try { tx.abort(); } catch { /* already aborted */ } return undefined; } };
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(state.error || unavailable());
          tx.onabort = () => reject(state.error || unavailable());
          guard(() => action(tx, value => { result = value; }, guard))();
        });
      } catch (error) {
        if (state.error) throw state.error;
        // WebKit can drop the connection while Safari is in the background: reopen once.
        opening = null;
        try { db.close(); } catch { /* already closed */ }
        if (again) return run(names, mode, action, false);
        throw unavailable();
      }
    }
    const one = (name, mode, make) => run(name, mode, (tx, done, guard) => { const request = make(tx.objectStore(name)); request.onsuccess = guard(() => done(request.result)); });
    const range = partId => KeyRange.bound(`${partId}|`, `${partId}|￿`);
    return { persistent: true,
      sessions: async () => (await one(SESSIONS, 'readonly', store => store.getAll())) || [],
      putSession: session => one(SESSIONS, 'readwrite', store => store.put(copy(session))),
      removeSession: id => one(SESSIONS, 'readwrite', store => store.delete(id)),
      atomic: fn => run(SESSIONS, 'readwrite', (tx, done, guard) => {
        const store = tx.objectStore(SESSIONS), request = store.getAll();
        request.onsuccess = guard(() => { const out = fn(request.result || []) || {}; for (const row of out.put || []) store.put(copy(row)); for (const id of out.remove || []) store.delete(id); done(out); });
      }),
      putChunk: (chunk, check) => run([SESSIONS, CHUNKS], 'readwrite', (tx, done, guard) => {
        if (!check) { tx.objectStore(CHUNKS).put(chunk); done('saved'); return; }
        const request = tx.objectStore(SESSIONS).get(chunk.sessionId);
        request.onsuccess = guard(() => { if (!check(request.result || null)) { done('refused'); return; } tx.objectStore(CHUNKS).put(chunk); done('saved'); });
      }),
      chunks: async partId => ((await one(CHUNKS, 'readonly', store => store.getAll(range(partId)))) || []).sort((a, b) => a.seq - b.seq),
      removeChunks: partId => one(CHUNKS, 'readwrite', store => store.delete(range(partId))),
    };
  }
  // IndexedDB first. When the iPad refuses it, writes fall back to page memory (and the page warns that
  // closing it loses that audio); reads merge both, so nothing written to either is missed. putChunk answers
  // 'memory' for a chunk only page memory holds, so the recorder can count the audio a closed page would lose.
  function deviceStore(primary = idbStore(), memory = memoryStore()) {
    let degraded = false;
    const lost = error => { if (error?.code !== 'RECORDER_STORAGE_UNAVAILABLE') throw error; degraded = true; };
    const spare = async (write, fallback) => { try { return await write(); } catch (error) { lost(error); return fallback(); } };
    const list = async read => { try { return await read(); } catch (error) { lost(error); return []; } };
    const merge = (left, right) => { const rows = new Map(left.map(row => [row.id, row])); for (const row of right) rows.set(row.id, row); return [...rows.values()]; };
    return {
      get persistent() { return !degraded; },
      sessions: async () => merge(await list(primary.sessions), await memory.sessions()),
      putSession: session => spare(async () => { await primary.putSession(session); await memory.removeSession(session.id); }, () => memory.putSession(session)),
      async removeSession(id) { await memory.removeSession(id); await spare(() => primary.removeSession(id), () => {}); },
      // A session only page memory holds (its IndexedDB write was refused) is the newer copy.
      async atomic(fn) {
        const held = await memory.sessions();
        try {
          const out = await primary.atomic(rows => fn(merge(rows, held)));
          for (const id of [...(out.put || []).map(row => row.id), ...(out.remove || [])]) await memory.removeSession(id);
          return out;
        } catch (error) {
          lost(error);
          const saved = await list(primary.sessions), out = await memory.atomic(rows => fn(merge(saved, rows)));
          for (const id of out.remove || []) await spare(() => primary.removeSession(id), () => {});
          return out;
        }
      },
      async putChunk(chunk, check) {
        const held = (await memory.sessions()).find(row => row.id === chunk.sessionId) || null;
        try { return await primary.putChunk(chunk, check && (row => check(held || row))); }
        catch (error) {
          lost(error);
          if (check && !check(held || (await list(primary.sessions)).find(row => row.id === chunk.sessionId) || null)) return 'refused';
          await memory.putChunk(chunk);
          return 'memory';
        }
      },
      chunks: async partId => merge(await list(() => primary.chunks(partId)), await memory.chunks(partId)).sort((a, b) => a.seq - b.seq),
      async removeChunks(partId) { await memory.removeChunks(partId); await spare(() => primary.removeChunks(partId), () => {}); },
    };
  }

  // One session record has three writers, all in the one tab that holds it (session.owner.tab). The recorder owns capture,
  // interruptions and its own parts while it records; the sync owns the one action or part it is sending; the page adds
  // actions, moves the status and edits rows that need the rep. Every write is one atomic read-modify-write that replaces only
  // the writer's own fields or row, so no writer undoes another's, and nothing brings back a cleared session.
  const findRow = (rows, id) => rows.find(row => row.id === id) || null;
  async function edit(store, id, mutate) {
    const out = await store.atomic(rows => { const row = findRow(rows, id); if (!row) return { result: null }; const next = mutate(row); return next === null ? { result: null } : { put: [row], result: row }; });
    return out.result;
  }
  // A part the sync already sent, or that waits for the rep, is never moved back by a late recorder write.
  const RECORDER_STATES = new Set(['recording', 'closed']);
  /** The recorder's write: refused (null) unless this tab holds the walkthrough, so when the session is gone or another tab
      holds it. Parts merge by id, so parts this copy does not hold are kept, a withdrawn consent is never moved back to
      recorded, and the sync's fields on a part (an upload on its way) stay. */
  function mergeCapture(fresh, tab, next) {
    if (!tab || fresh.owner?.tab !== tab) return null;
    const declined = fresh.consent === 'declined' || next.consent === 'declined';
    const parts = new Map((fresh.parts || []).map(part => [part.id, part]));
    // After a withdrawal the recorder adds or changes no part: the withdrawing writer already removed them.
    if (!declined) for (const part of next.parts || []) {
      if (part.source !== 'recorder') continue;
      const saved = parts.get(part.id);
      if (saved && !RECORDER_STATES.has(saved.state)) continue;
      if (part.state === 'empty') parts.delete(part.id); else parts.set(part.id, withSync(part, saved));
    }
    return Object.assign(fresh, { capture: declined ? 'none' : next.capture, interruptions: next.interruptions || fresh.interruptions || [], consent: declined ? 'declined' : next.consent,
      owner: next.owner?.tab === fresh.owner.tab ? next.owner : fresh.owner, parts: [...parts.values()].sort((a, b) => a.index - b.index) }, fresh.withdrawnAt || next.withdrawnAt ? { withdrawnAt: fresh.withdrawnAt || next.withdrawnAt } : {});
  }
  function saveAs(store, tab, next) {
    return edit(store, next.id, fresh => mergeCapture(fresh, tab, next));
  }
  /** The sync's change: its one action or part row (and the visit a saved action returned), by id. Null when either is gone. */
  function saveRow(store, id, list, row, extra = {}) {
    return edit(store, id, fresh => {
      const rows = fresh[list] || [], at = rows.findIndex(item => item.id === row.id);
      if (at < 0) return null;
      rows[at] = copy(row);
      return Object.assign(fresh, { [list]: rows }, copy(extra));
    });
  }
  /** The page's own change: apply it to the saved session in one atomic write. */
  function saveChange(store, id, mutate) {
    return edit(store, id, fresh => { mutate(fresh); return fresh; });
  }
  /** Customer withdrew consent: nothing more is recorded or uploaded, and the audio of every part not yet uploaded is deleted.
      A part already uploaded stays as a notice with its recording ID (the office deletes it there) until the rep confirms
      telling the office, like a part that landed after the withdrawal. Returns {session, removed: part ids whose audio was
      deleted, uploaded: the parts already sent}; session is null when the walkthrough is gone or, with holds, when
      holds(row) refuses it in the same write (another tab holds it). The caller then stops any upload of it still on its way
      (sync.abort), which saves how it ended on the part (NOTICE when it may be on the service). */
  async function withdrawSession(store, id, at, { holds = null } = {}) {
    let removed = [], uploaded = [];
    const session = await edit(store, id, row => {
      removed = []; uploaded = [];
      if (holds && !holds(row)) return null;
      const finished = row.status === 'finished';
      row.parts = (row.parts || []).flatMap(part => {
        if (part.state === 'uploaded') { uploaded.push(copy(part)); return [{ ...without(part, 'sendingAt'), state: NOTICE, reason: 'withdrawn', uploadedBefore: true, unconfirmed: false, error: null }]; }
        if (part.state === NOTICE) return [part];
        if (part.state !== 'removed') removed.push(part.id);
        // An earlier attempt sent all of this part's audio but its reply was lost, or (a walkthrough no tab holds, saved without
        // Web Locks) a page that may be gone had it on its way: it may be on the recording service.
        if ((part.unconfirmed || part.sendingAt && !row.owner?.tab) && part.state !== 'removed') return [{ ...without(part, 'sendingAt'), state: NOTICE, recordingId: null, unconfirmed: true, reason: 'withdrawn', removedAt: at, error: null }];
        // A finished walkthrough keeps its removed rows so the rep sees what happened; an open one simply has no audio, except
        // a part whose upload is on its way: its row stays until that upload says how it ended.
        return finished || part.sendingAt ? [{ ...part, state: 'removed', reason: part.state === 'removed' ? part.reason : 'withdrawn', removedAt: part.removedAt || at }] : [];
      });
      // An action not yet frozen for sending says declined; one already sent (or saved as sent) cannot change.
      for (const action of row.actions || []) if (!action.body && action.state !== 'done' && action.intent?.recordingStatus === 'recorded') action.intent = { ...action.intent, recordingStatus: 'declined' };
      return Object.assign(row, { consent: 'declined', capture: 'none', withdrawnAt: row.withdrawnAt || at });
    });
    if (!session) return { session: null, removed: [], uploaded: [] };
    for (const partId of removed) await store.removeChunks(partId).catch(() => {});
    return { session, removed, uploaded };
  }
  /** Parts of a walkthrough taken back from a page that is gone: an upload that page had started (sendingAt) ended unseen, so its
      part may be on the recording service. Kept for a retry as unconfirmed (so a later withdrawal names it), or, when consent
      was already withdrawn, as a notice with its upload ID. */
  function adoptParts(row) {
    row.parts = (row.parts || []).map(part => {
      if (!part.sendingAt) return part;
      const rest = without(part, 'sendingAt');
      if (part.state === 'removed' && part.reason === 'withdrawn') return { ...rest, state: NOTICE, recordingId: null, unconfirmed: true, error: null };
      return ['closed', 'error'].includes(part.state) ? { ...rest, unconfirmed: true } : rest;
    });
    return row;
  }
  /** Takes a walkthrough over for `tab` in one write that succeeds only while it is still held by `from` (the holder the page
      found gone), or by no tab. Null when another tab holds it after all. */
  function claim(store, id, from, tab, at) {
    return edit(store, id, row => {
      const holder = row.owner?.tab ?? null;
      if (holder === tab) return row;
      return holder === (from ?? null) ? Object.assign(adoptParts(row), { owner: { tab, at } }) : null;
    });
  }

  // A tally, outside IndexedDB, of the audio only page memory holds (IndexedDB refused it), so a reload can say how
  // much of it was lost with the page.
  function localLedger(storage = () => root.localStorage) {
    const key = partId => `egc-wt-recorder:memory:${partId}`;
    return {
      get: partId => { try { return JSON.parse(storage()?.getItem(key(partId)) || 'null'); } catch { return null; } },
      set: (partId, value) => { try { storage()?.setItem(key(partId), JSON.stringify(value)); } catch { /* storage blocked */ } },
      remove: partId => { try { storage()?.removeItem(key(partId)); } catch { /* storage blocked */ } },
    };
  }

  // ---- The recorder: one MediaRecorder per part on one microphone stream. ----
  // The tab recording a walkthrough holds it (session.owner = {tab, at}). Should another tab ever hold it instead (it found this
  // page gone), every write and every audio chunk of this recorder is refused in the same transaction, and this recorder stops
  // at once (lost()).
  function createRecorder({ store, tab = '', persist = null, media = () => root.navigator?.mediaDevices, Recorder = () => root.MediaRecorder, wakeLock = () => root.navigator?.wakeLock, now = () => Date.now(), uuid = () => root.crypto.randomUUID(), timers = root, limits = LIMITS, onChange = () => {}, onPartClosed = () => {}, ledger = localLedger() } = {}) {
    const me = tab || uuid(), write = persist || (target => saveAs(store, me, target));
    let session = null, stream = null, active = null, lock = null, wake = 'off', hiddenAt = null, mutedAt = null, lastNudge = 0, problem = null, problemOf = null, writes = Promise.resolve();
    const emit = () => { try { onChange(status()); } catch { /* the page redraws on its next tick */ } };
    const live = () => Boolean(stream?.getAudioTracks?.().some(track => track.readyState === 'live' && !track.muted));
    // A muted track (a call, Siri) is still the microphone: it comes back by itself, and asking for it again during a call fails.
    const held = () => Boolean(stream?.getAudioTracks?.().some(track => track.readyState === 'live'));
    const recording = () => Boolean(session && session.capture === 'recording');
    const owns = row => Boolean(row) && row.owner?.tab === me;
    // Every warning belongs to the walkthrough it is about (status().problemSession), so the page never shows one walkthrough's
    // warning on the next.
    function raise(value, owner = session) { problem = value; problemOf = value ? owner?.id || null : null; }
    function note(kind, extra = {}) { session.interruptions = [...(session.interruptions || []), { kind, at: iso(now()), ...extra }].slice(-50); }
    function stopTracks() { for (const track of stream?.getTracks?.() || []) { try { track.stop(); } catch { /* already stopped */ } } stream = null; }
    /** Saves this recorder's fields; a refusal (the session is gone, or another tab holds it) stops this recorder. */
    async function save(target) {
      const saved = await write(target);
      if (saved === null && session === target && ['recording', 'interrupted', 'starting'].includes(target.capture)) lost();
      return saved;
    }
    /** Another tab holds the walkthrough now (it found this page gone), or the walkthrough was cleared: stop capturing at once
        without writing anything more. */
    function lost() {
      const run = active, gone = session;
      if (!gone) return;
      active = null; session = null;
      if (run) { run.stopping = true; run.closed = true; try { if (run.recorder.state !== 'inactive') run.recorder.stop(); } catch { /* already stopped */ } run.resolve(); }
      stopTracks(); releaseWake(); hiddenAt = null; mutedAt = null;
      raise({ code: 'moved', at: now(), customer: gone.customer || '' }, gone);
      emit();
    }
    async function openStream() {
      if (held()) return;
      stopTracks();
      const devices = media();
      if (typeof devices?.getUserMedia !== 'function' || pickMime(Recorder()) === null) throw failure('This browser cannot record audio. Update the iPad, or record in Voice Memos and add the file at Finish.', 0, 'RECORDER_UNSUPPORTED');
      try { stream = await devices.getUserMedia({ audio: true }); }
      catch (error) {
        const denied = ['NotAllowedError', 'SecurityError'].includes(error?.name);
        throw failure(denied ? 'Microphone access is blocked. Allow the microphone for this site (Settings › Safari › Microphone), then try again.' : 'The microphone could not start. Close other apps that use it, then try again.', 0, denied ? 'RECORDER_MIC_DENIED' : 'RECORDER_MIC_UNAVAILABLE');
      }
      const current = stream;
      for (const track of current.getAudioTracks?.() || []) {
        track.addEventListener?.('ended', () => { if (stream === current) interrupted('track_ended'); });
        // WebKit mutes (rather than ends) the microphone for a call, Siri or another app: the part records silence meanwhile.
        track.addEventListener?.('mute', () => { if (stream === current) muted(true); });
        track.addEventListener?.('unmute', () => { if (stream === current) muted(false); });
      }
    }
    function muted(on) {
      if (!recording()) return;
      if (on) {
        if (mutedAt !== null) return;
        mutedAt = now(); note('muted'); raise({ code: 'muted', at: mutedAt });
      } else {
        if (mutedAt === null) return;
        const away = now() - mutedAt;
        mutedAt = null; note('unmuted', { mutedMs: away }); raise({ code: 'unmuted', at: now(), away });
      }
      void save(session).catch(() => {}); emit();
    }
    function startPart() {
      const Media = Recorder(), preferred = pickMime(Media), owner = session;
      let recorder;
      try { recorder = new Media(stream, { ...(preferred ? { mimeType: preferred } : {}), audioBitsPerSecond: limits.bitsPerSecond }); }
      catch { recorder = new Media(stream); }
      const type = UPLOAD_TYPES[baseType(recorder.mimeType || preferred)] || 'audio/webm';
      const part = { id: uuid(), index: owner.parts.reduce((max, row) => Math.max(max, row.index || 0), 0) + 1, requestId: uuid(), mimeType: type, extension: extensionFor(type), source: 'recorder', startedAt: iso(now()), endedAt: null, bytes: 0, chunks: 0, reason: null, state: 'recording', recordingId: null, attempts: 0, serverFailures: 0, error: null };
      const run = { recorder, part, session: owner, seq: 0, startedMs: now(), lastChunkAt: now(), stopping: false, closed: false, reason: null };
      run.stopped = new Promise(resolve => { run.resolve = resolve; });
      recorder.ondataavailable = event => chunk(run, event.data);
      recorder.onstop = () => { void close(run); };
      recorder.onerror = () => { if (active === run && !run.stopping) interrupted('recorder_error'); };
      owner.parts.push(part); active = run;
      try { recorder.start(limits.timesliceMs); }
      catch { owner.parts.pop(); active = null; throw failure('The recording could not start. Try again, or continue without recording.', 0, 'RECORDER_MIC_UNAVAILABLE'); }
      return save(owner);
    }
    // A chunk is saved only while this tab still holds the recording and the part is still recording there.
    const holds = partId => row => owns(row) && row.consent === 'recorded' && (row.parts || []).every(part => part.id !== partId || part.state === 'recording');
    function chunk(run, blob) {
      // A chunk after the part closed (a stop that fired after the timeout) is dropped: the part may already be sent.
      if (!blob || !blob.size || run.closed) return;
      const seq = ++run.seq, part = run.part, size = blob.size, at = iso(now());
      part.bytes += size; part.chunks = seq; run.lastChunkAt = now();
      writes = writes.then(async () => {
        let saved;
        try { saved = await store.putChunk({ id: chunkId(part.id, seq), partId: part.id, sessionId: run.session.id, seq, type: part.mimeType, bytes: size, at, data: await bytesOf(blob) }, holds(part.id)); }
        catch { raise({ code: 'storage', at: now() }, run.session); emit(); return; }
        if (saved === 'refused') { if (session === run.session) lost(); return; }
        if (saved === 'memory') {
          // Only page memory holds this second: counted, so a reload can say what was lost, and parts close sooner.
          part.memoryBytes = (part.memoryBytes || 0) + size; part.degraded = true;
          ledger.set(part.id, { bytes: part.memoryBytes, total: part.bytes, at });
          if (problem?.code !== 'storage') { raise({ code: 'storage', at: now() }, run.session); emit(); }
        }
      });
      const limitMs = part.degraded ? limits.degradedPartMs : limits.partMs;
      if (active === run && !run.stopping && (part.bytes >= limits.partBytes || now() - run.startedMs >= limitMs)) void rollover(part.bytes >= limits.partBytes ? 'size' : 'time');
      emit();
    }
    async function close(run) {
      if (run.closed) return run.stopped;
      run.closed = true;
      await writes;
      const part = run.part, owner = run.session;
      part.endedAt = iso(now()); part.reason = run.reason || 'finish';
      // An empty part is marked, so the saved copy drops it too, then left out here.
      part.state = part.bytes > 0 ? 'closed' : 'empty';
      if (active === run) active = null;
      await save(owner).catch(() => {});
      owner.parts = owner.parts.filter(row => row.state !== 'empty');
      run.resolve(); emit();
      if (part.state === 'closed' && part.degraded) { try { onPartClosed(part, owner); } catch { /* the page sends it on its next pass */ } }
      return run.stopped;
    }
    function stop(run, reason) {
      if (!run) return Promise.resolve();
      if (!run.stopping) {
        run.stopping = true; run.reason = reason;
        try { if (run.recorder.state !== 'inactive') run.recorder.stop(); else void close(run); } catch { void close(run); }
        // Some WebKit builds never fire stop after an interruption: the saved chunks still close the part.
        const timer = timers.setTimeout(() => { void close(run); }, limits.stopMs);
        run.stopped.then(() => timers.clearTimeout(timer));
      }
      return run.stopped;
    }
    function pause(error) {
      if (!session) return;
      session.capture = 'interrupted';
      raise({ code: error?.code || 'RECORDER_MIC_UNAVAILABLE', message: error?.message || '', at: now() });
      stopTracks(); releaseWake();
      void save(session).catch(() => {});
    }
    async function rollover(reason) {
      const run = active;
      if (!run || run.stopping) return;
      const current = () => session === run.session && session.capture === 'recording';
      // On an open microphone the next part starts before the old one stops: a short overlap, and no audio between parts.
      if (held()) {
        try { await startPart(); await stop(run, reason); emit(); return; }
        catch { if (!current()) return; }
      }
      await stop(run, reason);
      if (!current()) return;
      try {
        await openStream();
        // Finish (or a withdrawal) during the microphone request ends the walkthrough: no new part starts.
        if (!current()) { if (!recording()) stopTracks(); return; }
        await startPart();
      } catch (error) { if (current()) pause(error); }
      emit();
    }
    function interrupted(kind) {
      if (!recording()) return;
      note(kind); raise({ code: kind, at: now() });
      void rollover('interrupted');
    }
    async function acquireWake() {
      const api = wakeLock();
      if (typeof api?.request !== 'function') { wake = 'unsupported'; emit(); return; }
      if (lock) return;
      try {
        const held = await api.request('screen');
        if (!recording()) { try { await held.release(); } catch { /* released */ } return; }
        lock = held; wake = 'on';
        held.addEventListener?.('release', () => { if (lock === held) { lock = null; wake = 'off'; emit(); } });
      } catch { lock = null; wake = 'off'; }
      emit();
    }
    function releaseWake() { const held = lock; lock = null; if (wake !== 'unsupported') wake = 'off'; try { held?.release?.(); } catch { /* released */ } }
    /** Starts recording a new walkthrough session. Call it first inside the consent tap: WebKit asks for the microphone there.
        The session is saved before the first chunk, in one write that refuses it when conflict(rows) finds another open one. */
    async function begin(next, { conflict = null } = {}) {
      if (recording()) throw failure('A walkthrough is already recording.', 0, 'RECORDER_BUSY');
      session = next; session.parts = session.parts || []; session.interruptions = session.interruptions || [];
      raise(null); hiddenAt = null; mutedAt = null;
      await openStream();
      Object.assign(next, { capture: 'recording', owner: { tab: me, at: iso(now()) } });
      const made = await store.atomic(rows => findRow(rows, next.id) || conflict?.(rows, next) ? { result: false } : { put: [next], result: true });
      if (!made.result) {
        next.capture = 'none'; stopTracks();
        if (session === next) session = null;
        throw failure('This walkthrough is already open on this iPad, perhaps in another tab.', 0, 'RECORDER_BUSY');
      }
      try { await startPart(); }
      catch (error) {
        // Nothing was recorded: the saved session is removed again, so Try again starts clean.
        next.capture = 'interrupted'; stopTracks();
        await store.atomic(rows => { const row = findRow(rows, next.id); return { remove: owns(row) && !(row.parts || []).length ? [next.id] : [] }; }).catch(() => {});
        throw error;
      }
      void acquireWake(); emit();
      return session;
    }
    async function resume() {
      if (!session || session.capture !== 'interrupted') return;
      raise(null);
      await openStream();
      session.capture = 'recording'; note('resumed');
      try { await startPart(); } catch (error) { pause(error); throw error; }
      void acquireWake(); emit();
    }
    /** Stops the recording: the last part closes once its final chunk is saved. The tab keeps holding the walkthrough (its
        outcome and audio are sent from here). */
    async function finish() {
      const current = session;
      if (!current) return null;
      if (active) await stop(active, 'finish');
      if (current.capture !== 'none') current.capture = 'stopped';
      stopTracks(); releaseWake(); hiddenAt = null; mutedAt = null;
      await save(current);
      emit();
      return current;
    }
    /** The customer withdrew consent: the audio on this iPad is deleted (every part) and nothing is uploaded. Returns what
        withdrawSession did (in the write that re-checks this tab still holds the walkthrough), or null with nothing recording. */
    async function discard() {
      const current = session;
      if (!current) return null;
      if (active) await stop(active, 'withdrawn');
      stopTracks(); releaseWake(); hiddenAt = null; mutedAt = null;
      const at = iso(now());
      const result = await withdrawSession(store, current.id, at, { holds: owns });
      Object.assign(current, { parts: [], capture: 'none', consent: 'declined', withdrawnAt: current.withdrawnAt || at });
      raise(null); emit();
      return result;
    }
    // The audio of a part that only page memory held is gone after a reload: it is counted from the tally and the saved chunks.
    function memoryLoss(part, stored) {
      const tally = ledger.get(part.id);
      if (!part.degraded && !tally) return 0;
      ledger.remove(part.id);
      const gone = Math.max(0, Math.max(part.bytes || 0, tally?.total || 0) - stored);
      if (gone) part.lostBytes = (part.lostBytes || 0) + gone;
      Object.assign(part, { degraded: false, memoryBytes: 0 });
      return gone;
    }
    /** Adopts a saved session whose page is gone (its Web Lock is gone: closed, reloaded or discarded). The claim is one write
        that succeeds only while the session is still held by `from` (the holder the page found gone); a part that was
        recording keeps its saved audio, and an upload that page had started counts as possibly on the service (adoptParts).
        Null when another tab holds it after all. */
    async function recover(saved, { from = saved?.owner?.tab ?? null, reason = 'page_closed' } = {}) {
      const claimed = await claim(store, saved.id, from, me, iso(now()));
      if (!claimed) return null;
      session = claimed; claimed.parts = claimed.parts || []; claimed.interruptions = claimed.interruptions || [];
      raise(null);
      let lostBytes = 0;
      for (const part of claimed.parts) {
        if (part.source !== 'recorder' || !(part.state === 'recording' || part.state === 'closed' && (part.degraded || ledger.get(part.id)))) continue;
        const rows = await store.chunks(part.id), stored = rows.reduce((sum, row) => sum + (row.bytes || 0), 0);
        lostBytes += memoryLoss(part, stored);
        Object.assign(part, { bytes: stored, chunks: rows.length }, part.state === 'recording' ? { endedAt: rows.at(-1)?.at || part.startedAt, reason } : {});
        part.state = part.bytes ? 'closed' : 'empty';
      }
      if (['recording', 'starting', 'stopped'].includes(claimed.capture)) { claimed.capture = 'interrupted'; note(reason); raise({ code: reason, at: now(), lostBytes }); }
      else if (lostBytes) raise({ code: 'page_closed', at: now(), lostBytes });
      await save(claimed);
      claimed.parts = claimed.parts.filter(row => row.state !== 'empty');
      emit();
      return claimed;
    }
    /** The page was hidden (screen lock, app switch) or shown again: a real gap is warned about and recording continues in a new part. */
    function visibility(hidden) {
      if (!recording()) return;
      // The browser drops the wake lock while hidden; it is taken again on return.
      if (hidden) { if (hiddenAt === null) { hiddenAt = now(); note('hidden'); releaseWake(); void save(session).catch(() => {}); } return; }
      if (hiddenAt === null) return;
      const away = now() - hiddenAt, run = active;
      hiddenAt = null;
      void acquireWake();
      if (away < limits.resumeGapMs && run && !run.stopping && live() && run.recorder.state === 'recording') { emit(); return; }
      raise({ code: 'resumed', at: now(), away });
      note('resumed', { awayMs: away });
      void rollover('interrupted');
    }
    /** The one-second tick: nudges a quiet recorder for data, rolls over at the time limit, restarts a stalled part, and clears
        an interruption warning after a healthy minute. */
    function tick() {
      const run = active, time = now();
      if (!recording() || !run || run.stopping) { emit(); return; }
      if (problem && PASSING_PROBLEMS.has(problem.code) && time - problem.at >= limits.healthyMs && live() && time - run.lastChunkAt < limits.nudgeMs) raise(null);
      const quiet = time - run.lastChunkAt;
      if (time - run.startedMs >= (run.part.degraded ? limits.degradedPartMs : limits.partMs)) { void rollover('time'); return; }
      if (hiddenAt === null && quiet >= limits.stallMs) { interrupted('stalled'); return; }
      if (quiet >= limits.nudgeMs && time - lastNudge >= limits.nudgeMs) { lastNudge = time; try { run.recorder.requestData?.(); } catch { /* not recording */ } }
      emit();
    }
    function status() {
      const run = active, parts = session?.parts || [];
      return { session, capture: session?.capture || 'idle', part: run ? { ...run.part } : null, partIndex: run?.part.index || parts.at(-1)?.index || 0, partBytes: run?.part.bytes || 0,
        totalBytes: parts.reduce((sum, part) => sum + (part.bytes || 0), 0), problem, problemSession: problem ? problemOf : null, wake, persistent: store.persistent !== false };
    }
    const flush = () => { try { active?.recorder.requestData?.(); } catch { /* not recording */ } };
    const clearProblem = () => { raise(null); emit(); };
    // After Finish or a withdrawal the recorder lets the walkthrough go, and its warnings with it (except why it stopped when
    // another tab holds it, which stays with that walkthrough: the page shows a warning only on the walkthrough it is about).
    const release = () => { if (!recording()) { session = null; if (problem?.code !== 'moved') raise(null); } };
    return { tab: me, begin, resume, finish, discard, recover, visibility, tick, status, flush, clearProblem, release };
  }

  // ---- Sync: the visit actions (start, finish, no_show) and then the audio parts, per signed-in employee. ----
  // An action's body is frozen (request ID and expected revision) and saved before it is first sent, and a lost
  // reply is retried unchanged. A refusal saved nothing, so a new request can safely replace it.
  function applicable(action, visit, user) {
    const closed = visit?.walkthroughOutcome && !visit.rebookPending, started = !visit?.rebookPending && visit?.walkthroughVisit;
    if (!visit) return failure('This walkthrough visit could not be found. Refresh your schedule.', 404, 'walkthrough_visit_not_found');
    if (action.kind === 'start') {
      if (closed) return failure('This walkthrough already has an outcome.', 409, 'walkthrough_visit_closed');
      if (started) return same(started.startedBy, user) ? 'done' : failure(`This walkthrough was already started by ${started.startedBy || 'someone else'}.`, 409, 'walkthrough_visit_already_started');
      return true;
    }
    if (closed) return failure(`An outcome was already recorded for this walkthrough (${String(visit.walkthroughOutcome.outcome || '').replaceAll('_', ' ')}).`, 409, 'walkthrough_visit_closed');
    if (action.kind === 'finish' && !started) return failure('This walkthrough was never started, so its outcome cannot be saved. Record a no-show, or ask a manager.', 409, 'walkthrough_visit_not_started');
    return true;
  }

  // tab: the page's tab. The sync then sends only the walkthroughs this tab holds (or that no tab holds): another tab's
  // walkthrough is that tab's to send, and every write re-checks that in the same write. A bare sync (no tab) sends every one.
  // withdrawnVisit(row): true when the customer withdrew consent for that walkthrough's visit on this iPad (the page keeps
  // that per visit, outside the walkthroughs). No part of such a walkthrough is ever marked as on its way (checked in that
  // write), whichever tab withdrew it and whenever this tab came to hold it, and it is never sent as recorded.
  function createSync({ store, visit, upload, now = () => Date.now(), uuid = () => root.crypto.randomUUID(), user = () => '', limits = LIMITS, onChange = () => {}, ledger = localLedger(), tab = '', withdrawnVisit = () => false } = {}) {
    let running = null, again = false;
    const owns = row => Boolean(row) && (!tab || !row.owner?.tab || row.owner.tab === tab);
    const visitWithdrawn = row => { try { return Boolean(row) && withdrawnVisit(row) === true; } catch { return false; } };
    // inflight: the part uploads on their way, by part id, so a withdrawal can stop them (abort).
    const progress = new Map(), inflight = new Map();
    const held = (id, mutate) => edit(store, id, row => owns(row) ? mutate(row) : null);
    // Each write is the one row this step changed, so a rep's Retry, Dismiss or timecard choice made meanwhile stays.
    const saveAction = (session, action, extra = {}) => held(session.id, row => {
      const rows = row.actions || [], at = rows.findIndex(item => item.id === action.id);
      if (at < 0) return null;
      rows[at] = copy(action);
      return Object.assign(row, { actions: rows }, copy(extra));
    });
    const emit = () => { try { onChange(); } catch { /* redraw later */ } };

    // Only the verdict's fields are written: the row's intent stays as saved (a withdrawal may have changed it meanwhile).
    async function settle(session, action, verdict) {
      const fields = verdict === 'done' ? { state: 'done', doneAt: iso(now()), error: null, note: 'applied_elsewhere' } : { state: 'error', error: detail(verdict) };
      Object.assign(action, fields);
      await held(session.id, row => { const saved = (row.actions || []).find(item => item.id === action.id); if (!saved) return null; Object.assign(saved, copy(fields)); return row; });
    }
    async function sendAction(session, action) {
      if (!action.body) {
        const state = await visit.state(session.visitId);
        if (state?.enabled === false && !state.visit) throw failure('Walkthrough Start and Finish are switched off right now. This walkthrough stays on this iPad and is sent once they are on again.', 503, 'walkthrough_visit_disabled');
        const verdict = applicable(action, state.visit, session.user);
        if (verdict !== true) return settle(session, action, verdict);
        const requestId = uuid(), expectedRevision = state.visit.revision;
        // Durable on the iPad before the server sees it, in one write that builds the body from the row as saved now: a
        // withdrawal made during the read above (intent declined) is what goes out, never this pass's older copy. A body
        // frozen first (another sync on this page) is sent instead; a row the rep removed or dismissed meanwhile is not sent.
        await held(session.id, row => {
          const saved = (row.actions || []).find(item => item.id === action.id);
          if (!saved) return null;
          if (saved.body || saved.state !== 'queued') { Object.assign(action, copy(saved)); return null; }
          // A walkthrough whose customer withdrew consent (here, or for its visit in any tab) is never sent as recorded, whatever
          // an older copy says.
          if ((row.consent === 'declined' || visitWithdrawn(row)) && saved.intent?.recordingStatus === 'recorded') saved.intent = { ...saved.intent, recordingStatus: 'declined' };
          Object.assign(saved, { requestId, body: { action: saved.kind, visitId: session.visitId, requestId, expectedRevision, ...saved.intent, actorId: session.user } });
          Object.assign(action, copy(saved));
          return row;
        });
        if (!action.body || action.state === 'done') return;
      }
      let data;
      try { data = await visit.post(action.body); }
      catch (error) {
        const kind = classify(error);
        action.attempts = (action.attempts || 0) + 1; action.lastError = detail(error);
        if (kind === 'network' || kind === 'auth') { await saveAction(session, action); throw error; }
        if (kind === 'transient') {
          action.serverFailures = (action.serverFailures || 0) + 1;
          if (action.serverFailures < limits.serverRetries) { await saveAction(session, action); throw error; }
          Object.assign(action, { state: 'error', error: detail(error) }); await saveAction(session, action); return;
        }
        // A refusal saved nothing: a stale revision is rebuilt from the current visit under a new request ID.
        if (error.code === 'walkthrough_visit_revision_conflict' && (action.rebases || 0) < 3) {
          Object.assign(action, { body: null, requestId: null, rebases: (action.rebases || 0) + 1 }); await saveAction(session, action);
          return sendAction(session, action);
        }
        if (RECHECK_CODES.has(error.code)) {
          const state = await visit.state(session.visitId);
          if (applicable(action, state.visit, session.user) === 'done') return settle(session, action, 'done');
        }
        Object.assign(action, { state: 'error', error: detail(error) }); await saveAction(session, action); return;
      }
      if (String(data?.requestId || '').toLowerCase() !== action.requestId.toLowerCase() || data?.visit?.id !== session.visitId) throw failure('The walkthrough save could not be verified. It stays on this iPad and is checked again.', 0, 'RECORDER_UNVERIFIED');
      Object.assign(action, { state: 'done', doneAt: iso(now()), error: null });
      session.visit = data.visit;
      await saveAction(session, action, { visit: data.visit });
    }
    // A part the customer's withdrawal reached (consent declined, the visit withdrawn on this iPad, or the part removed as
    // withdrawn) is never written back to closed, error or uploaded by an upload that was already on its way: only landed()
    // and ended() below record it.
    const withdrawn = (row, saved) => row.consent === 'declined' || visitWithdrawn(row) || saved?.state === NOTICE || saved?.state === 'removed' && saved.reason === 'withdrawn';
    const partAt = (row, partId) => { const rows = row.parts || [], at = rows.findIndex(item => item.id === partId); return { rows, at, saved: rows[at] || null }; };
    function keepNotice(row, rows, at, notice) {
      if (at < 0) rows.push(notice); else rows[at] = notice;
      row.parts = rows.sort((a, b) => a.index - b.index);
      return row;
    }
    const noticeOf = (saved, part, fields) => without({ ...(saved || copy(part)), ...fields, state: NOTICE, error: null, reason: 'withdrawn' }, 'sendingAt');
    /** Marks a part as on its way (sendingAt), in the same write that re-checks it is still this tab's to send and that
        neither its walkthrough nor its visit was withdrawn. A part already marked by an upload that never said how it ended
        (a page that is gone, or, for a walkthrough no tab holds, another tab's upload) may be on the recording service: it
        stays counted as possibly there (unconfirmed) until the service confirms it. */
    function sending(session, part, signal, at) {
      return held(session.id, row => {
        const { rows, at: index, saved } = partAt(row, part.id);
        if (signal.aborted || withdrawn(row, saved) || saved?.state !== 'closed') return null;
        rows[index] = { ...saved, sendingAt: at, ...(saved.sendingAt ? { unconfirmed: true } : {}) }; row.parts = rows;
        return row;
      });
    }
    /** Saves how an upload (or the check before one) ended without the service's confirmation, in one write that also checks
        for a withdrawal. When consent was withdrawn meanwhile (even just before this write), a part that may be on the recording
        service (mayHave) is kept as a notice with its upload ID; otherwise the withdrawn part is simply no longer on its way.
        Returns 'withdrawn', 'saved', or null (another tab holds the walkthrough, or it is gone). */
    async function ended(session, part, mayHave = false) {
      let outcome = null;
      await edit(store, session.id, row => {
        const { rows, at, saved } = partAt(row, part.id);
        outcome = null;
        if (withdrawn(row, saved)) {
          outcome = 'withdrawn';
          if (mayHave && saved?.state !== NOTICE) return keepNotice(row, rows, at, noticeOf(saved, part, { recordingId: null, unconfirmed: true }));
          if (!saved?.sendingAt) return null;
          // An open walkthrough keeps no row of a withdrawn part once nothing of it may be on its way.
          if (saved.state === 'removed' && row.status !== 'finished') rows.splice(at, 1); else rows[at] = without(saved, 'sendingAt');
          row.parts = rows;
          return row;
        }
        // A part the service already confirmed (another tab's upload of a walkthrough no tab holds) is never moved back.
        if (!owns(row) || at < 0 || saved.state === 'removed' || saved.state === 'uploaded') return null;
        outcome = 'saved';
        rows[at] = without(saved.unconfirmed && !part.unconfirmed ? { ...part, unconfirmed: true } : copy(part), 'sendingAt'); row.parts = rows;
        return row;
      });
      return outcome;
    }
    /** The service confirmed a part (in the same write it is no longer on its way). When the customer withdrew consent while it
        was on its way, it is kept as a notice with its recording ID (the office deletes it there), until the rep confirms
        telling the office. */
    function landed(session, part, fields) {
      return edit(store, session.id, row => {
        const { rows, at, saved } = partAt(row, part.id);
        if (withdrawn(row, saved)) return keepNotice(row, rows, at, noticeOf(saved, part, { ...fields, unconfirmed: false }));
        if (!owns(row) || at < 0) return null;
        rows[at] = without({ ...saved, ...fields, state: 'uploaded', unconfirmed: false, error: null }, 'sendingAt'); row.parts = rows;
        return row;
      });
    }
    async function uploadPart(session, part) {
      // Registered first, so a withdrawal from here on stops it.
      const signal = { aborted: false, onabort: null }, entry = { sessionId: session.id, signal, sent: false };
      entry.done = new Promise(resolve => { entry.finish = resolve; });
      inflight.set(part.id, entry);
      let marked = false, started = false;
      try {
        const rows = await store.chunks(part.id);
        if (signal.aborted) return;
        if (!rows.length) { Object.assign(part, { state: 'error', error: { code: 'RECORDER_AUDIO_MISSING', message: 'The audio for this part is no longer on this iPad.', status: 0, kind: 'rejected', details: null } }); await ended(session, part); return; }
        const blob = new Blob(rows.map(row => row.data), { type: part.mimeType });
        if (blob.size > limits.uploadBytes) { Object.assign(part, { state: 'error', error: { code: 'recording_size_invalid', message: 'This part is over 24 MB, which the recording service does not accept yet. Save a copy and ask the office.', status: 400, kind: 'rejected', details: null } }); await ended(session, part); return; }
        // On its way from here, saved on the part in the write that re-checks it: a withdrawal made first sends nothing, and a
        // page that is gone before this upload says how it ended leaves the part counted as possibly on the service.
        if (!await sending(session, part, signal, iso(now()))) return;
        marked = true;
        if (signal.aborted) return;
        progress.set(part.id, 0); emit();
        let result;
        try {
          started = true;
          // Progress 1 means every byte of the part was sent: from then on the service may have stored it, reply or not.
          result = await upload({ requestId: part.requestId, visitId: session.visitId, blob, filename: `walkthrough-${session.visitId}-part-${part.index}.${part.extension}`, signal }, fraction => { if (fraction >= 1) entry.sent = true; progress.set(part.id, fraction); emit(); });
        } catch (error) {
          // A transport cannot know whether a completion it has not handled yet already reached the server: an upload that a
          // withdrawal stopped after it started sending may be on the service (whatever its progress said), as may one whose
          // connection failed, or whose server failed, after every byte was sent. Decided in the write that checks for the
          // withdrawal (ended), so a withdrawal saved just before it is not missed.
          const kind = classify(error), stopped = error?.code === 'RECORDER_UPLOAD_STOPPED';
          const mayHave = stopped || entry.sent && (kind === 'network' || kind === 'transient');
          if (!stopped) {
            part.attempts = (part.attempts || 0) + 1; part.lastError = detail(error);
            if (mayHave) part.unconfirmed = true;
            if (kind === 'transient') part.serverFailures = (part.serverFailures || 0) + 1;
            if (kind === 'rejected' || kind === 'transient' && part.serverFailures >= limits.serverRetries) Object.assign(part, { state: 'error', error: detail(error) });
          }
          const outcome = await ended(session, part, mayHave);
          // A lost connection, a sign-in wait or a server error still to be retried ends this pass; the page tries again later.
          if (outcome === 'saved' && part.state !== 'error' && (stopped || ['network', 'auth', 'transient'].includes(kind))) throw error;
          return;
        }
        marked = false;
        const stored = await landed(session, part, { recordingId: result.recordingId, uploadedAt: iso(now()) });
        Object.assign(part, (stored?.parts || []).find(item => item.id === part.id) || {});
        // The audio leaves the iPad only after the server confirmed this part.
        await store.removeChunks(part.id).catch(() => {});
        ledger.remove(part.id);
      } finally {
        inflight.delete(part.id); progress.delete(part.id);
        // Marked but never sent (a withdrawal stopped it first): it is no longer on its way.
        if (marked && !started) await ended(session, part).catch(() => {});
        entry.finish(); emit();
      }
    }
    /** Stops the uploads of a walkthrough whose consent was just withdrawn; resolves once each has recorded how it ended. */
    function abort(sessionId) {
      const stopping = [...inflight.values()].filter(entry => entry.sessionId === sessionId);
      for (const entry of stopping) { if (entry.signal.aborted) continue; entry.signal.aborted = true; try { entry.signal.onabort?.(); } catch { /* already finished */ } }
      return Promise.all(stopping.map(entry => entry.done)).then(() => stopping.length);
    }
    // A finished walkthrough whose actions are saved and whose audio is uploaded (or declined, or removed after a copy) leaves
    // the iPad once no notice waits for the rep and no upload of it is on its way; the removal re-checks the saved session in
    // the same write.
    const settled = row => row.status === 'finished' && (row.actions || []).every(action => action.state === 'done') && !(row.parts || []).some(part => noticePending(part) || part.sendingAt) && (row.consent === 'declined' || (row.parts || []).every(part => SETTLED_PARTS.has(part.state) || part.state === NOTICE));
    async function tidy(id) {
      const session = findRow(await store.sessions(), id);
      if (!session || !owns(session)) return;
      for (const part of session.parts || []) if (part.state === 'uploaded' || part.state === NOTICE) await store.removeChunks(part.id).catch(() => {});
      const out = await store.atomic(rows => { const row = findRow(rows, id); return row && owns(row) && settled(row) ? { remove: [id] } : {}; });
      if (out.remove?.length) for (const part of session.parts || []) ledger.remove(part.id);
    }
    /** A walkthrough whose visit's customer withdrew consent on this iPad (in any tab) while this tab held it: each part it had
        already uploaded becomes a notice with its recording ID, in the write that re-checks this tab holds it, so the rep is
        told to tell the office and the walkthrough cannot leave the iPad before "I told the office" (whether or not the rep
        withdraws it here too). Its audio still on the iPad is never uploaded (below) and is deleted when the rep withdraws it. */
    function noticeUploaded(session) {
      return held(session.id, row => {
        if (row.consent === 'declined' || !visitWithdrawn(row) || !(row.parts || []).some(part => part.state === 'uploaded')) return null;
        row.parts = row.parts.map(part => (part.state === 'uploaded' ? { ...without(part, 'sendingAt'), state: NOTICE, reason: 'withdrawn', uploadedBefore: true, unconfirmed: false, error: null } : part));
        return row;
      });
    }
    // While the iPad holds audio only in page memory, closed parts upload as soon as Start is saved, before Finish.
    const early = session => session.status === 'active' && (session.parts || []).some(part => part.degraded) && (session.actions || []).some(action => action.kind === 'start' && action.state === 'done');
    async function cycle() {
      const me = user();
      if (!me) return { stopped: null, sent: [] };
      const sent = [];
      // Only the walkthroughs this tab holds: another tab's are sent by that tab.
      const sessions = (await store.sessions()).filter(row => same(row.user, me) && row.status !== 'starting' && owns(row)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      for (const session of sessions) {
        try {
          if (session.consent !== 'declined' && visitWithdrawn(session) && (session.parts || []).some(part => part.state === 'uploaded')) await noticeUploaded(session);
          for (const action of session.actions || []) {
            if (action.state === 'done') continue;
            if (action.state === 'error') break; // Later actions wait behind one that needs the rep.
            await sendAction(session, action);
            if (action.state !== 'done') break;
            sent.push({ sessionId: session.id, visitId: session.visitId, kind: action.kind });
          }
          // Audio uploads once the outcome is saved on the iPad, strictly in part order (upload order is the service's
          // only ordering today): a part still recording or waiting for the rep holds back the parts after it. Nothing of a
          // visit whose customer withdrew consent on this iPad is uploaded (re-checked in the write that marks a part as sent).
          if (session.consent !== 'declined' && !visitWithdrawn(session) && (session.status === 'finished' || early(session))) {
            for (const listed of [...(session.parts || [])].sort((a, b) => a.index - b.index)) {
              // Re-read before each part: a withdrawal made meanwhile stops the uploads.
              const current = findRow(await store.sessions(), session.id), part = (current?.parts || []).find(row => row.id === listed.id);
              if (!current || !owns(current) || current.consent === 'declined' || visitWithdrawn(current) || !part) break;
              if (SETTLED_PARTS.has(part.state)) continue;
              if (part.state !== 'closed') break;
              await uploadPart(current, part);
              if (part.state !== 'uploaded') break;
            }
          }
          await tidy(session.id);
        } catch (error) { emit(); return { stopped: { error, reason: classify(error) }, sent }; }
      }
      emit();
      return { stopped: null, sent };
    }
    /** One replay at a time. A call during a replay runs one more pass after it, so a change made meanwhile is not missed; also
        after a pass that lost the connection, since the call may be the signal coming back (the online event), which would
        otherwise wait for the next backoff (up to 2 minutes). */
    function run() {
      if (running) { again = true; return running; }
      running = (async () => {
        let result;
        const sent = [];
        do { again = false; result = await cycle(); sent.push(...result.sent); } while (again && (!result.stopped || result.stopped.reason === 'network'));
        return { ...result, sent };
      })().finally(() => { running = null; });
      return running;
    }
    return { run, abort, progress, get busy() { return Boolean(running); } };
  }

  // ---- Transports ----
  function httpVisit(fetchImpl = root.fetch?.bind(root), { timeout = 30000 } = {}) {
    async function call(url, body) {
      let response;
      try { response = await fetchImpl(url, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), ...(root.AbortSignal?.timeout ? { signal: root.AbortSignal.timeout(timeout) } : {}) }); }
      catch (error) {
        if (error?.code === 'HUB_AUTH_REQUIRED') throw failure(error.message, 401, 'HUB_AUTH_REQUIRED');
        throw failure('No connection. The walkthrough stays on this iPad and is sent when the signal returns.', 0, 'RECORDER_NETWORK');
      }
      let data;
      try { data = await response.json(); } catch { if (response.ok) throw failure('The reply was cut off. The walkthrough stays on this iPad and is checked again.', 0, 'RECORDER_NETWORK'); data = {}; }
      if (!response.ok || data?.ok !== true) throw Object.assign(failure(data?.error || 'The walkthrough service is unavailable. It stays on this iPad; retry shortly.', response.status || 503, data?.code || ''), { details: data?.details || null });
      return data;
    }
    return { state: visitId => call(`/api/walkthrough-visit?visitId=${encodeURIComponent(visitId)}`), post: body => call('/api/walkthrough-visit', body) };
  }
  const UPLOAD_ERRORS = { recording_customer_link_missing: 'This visit needs an exact customer link before its audio can be saved. Ask the office to repair the Hub record, then retry.', recording_visit_link_missing: 'This visit is not linked to its walkthrough. Ask the office to repair it, then retry.', recording_source_not_found: 'The recording service could not find this walkthrough visit.', recording_size_invalid: 'This part is over 24 MB, which the recording service does not accept yet.', recording_audio_type_invalid: 'The recording service does not accept this audio type yet.', recording_upload_request_conflict: 'This upload ID was already used for different audio. Save a copy and ask the office.', business_session_required: 'Sign in with a business account to send recordings.', operations_not_enabled: 'The recording service is switched off. The audio stays on this iPad.', recording_role_forbidden: 'This account cannot send recordings.',
    invalid_recording_signature: 'The recording service could not verify this upload. This is a service setup problem, not your sign-in: retry later, or save a copy and ask the office.', recording_signature_expired: 'The recording service could not verify this upload in time. Retry; if it keeps failing, save a copy and ask the office.', recording_identity_unverified: 'The recording service could not confirm who sent this audio. Save a copy and ask the office.' };
  function xhrUpload(XHR = root.XMLHttpRequest, { url = '/api/operations-recordings', timeout = LIMITS.uploadMs } = {}) {
    // signal ({aborted, onabort}, like an AbortSignal): a withdrawal of consent aborts the request. onProgress(1) once every
    // byte is sent (the upload's load event), before the reply.
    return ({ requestId, visitId, blob, filename, signal = null }, onProgress = () => {}) => new Promise((resolve, reject) => {
      const stopped = () => reject(failure('The upload was stopped: the customer withdrew consent.', 0, 'RECORDER_UPLOAD_STOPPED'));
      if (signal?.aborted) { stopped(); return; }
      const xhr = new XHR(), lost = () => (signal?.aborted ? stopped() : reject(failure('The upload did not finish. The audio stays on this iPad and is sent again with the same upload ID.', 0, 'RECORDER_NETWORK')));
      xhr.open('POST', url, true);
      xhr.timeout = timeout;
      if (xhr.upload) { xhr.upload.onprogress = event => { if (event.lengthComputable && event.total) onProgress(Math.min(1, event.loaded / event.total)); }; xhr.upload.onload = () => onProgress(1); }
      if (signal) signal.onabort = () => { try { xhr.abort(); } catch { /* already finished */ } };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText || 'null'); } catch { data = null; }
        if (xhr.status >= 200 && xhr.status < 300 && data && !data.error && typeof data.recording?.id === 'string') { onProgress(1); resolve({ recordingId: data.recording.id, alreadySaved: data.alreadySaved === true }); }
        else if (xhr.status >= 200 && xhr.status < 300) lost();
        // An expired Hub session reads as business_session_required: the audio waits for the rep to sign in again.
        else reject(failure(UPLOAD_ERRORS[data?.error] || (xhr.status >= 500 ? 'The recording service is unavailable. The audio stays on this iPad and is retried.' : 'The recording service refused this audio.'), data?.error === 'business_session_required' ? 401 : xhr.status, typeof data?.error === 'string' ? data.error.slice(0, 80) : ''));
      };
      xhr.onerror = lost; xhr.ontimeout = lost; xhr.onabort = lost;
      const form = new FormData();
      form.set('requestId', requestId); form.set('portalJobId', visitId); form.set('audio', blob, filename);
      xhr.send(form);
    });
  }

  // ---- Tabs: which gameplan tab holds a walkthrough. ----
  // Each page holds a Web Lock named for its tab while it is open (WebKit keeps it while Safari pauses a background tab and
  // releases it once the page is gone: closed, reloaded, or discarded by Safari), so another tab can tell exactly whether the
  // tab holding a walkthrough is still there. Without Web Locks (exact is false: Safari before iPadOS 15.4) a paused tab
  // cannot be told from a closed one, so the page records nothing in the Hub and holds or takes no walkthrough (mount).
  function tabPresence({ locks = root.navigator?.locks } = {}) {
    const name = tab => `egc-wt-tab:${tab}`;
    const exact = typeof locks?.query === 'function' && typeof locks?.request === 'function';
    return {
      exact,
      /** Takes (or takes again) this page's lock, kept until the page is gone. A page can lose it while it lives (WebKit's
          back/forward cache), so the page asks again when it is shown again and before it claims a walkthrough; asking
          while it still holds the lock changes nothing (ifAvailable). Resolves once the request is answered. */
      hold(tab) {
        return new Promise(resolve => {
          try {
            const asked = locks?.request?.(name(tab), { ifAvailable: true }, lock => { resolve(Boolean(lock)); return lock ? new Promise(() => {}) : null; });
            if (!asked) resolve(false); else asked.catch?.(() => resolve(false));
          } catch { resolve(false); }
        });
      },
      /** Whether the tab holding a walkthrough is still there (asked only with Web Locks). */
      async alive(owner) {
        if (!owner?.tab) return false;
        try { return ((await locks.query())?.held || []).some(lock => lock.name === name(owner.tab)); } catch { return true; }
      },
    };
  }

  // The Finish screen's outcomes and reasons. The reason codes are the shared funnel definitions' lists without other_legacy
  // (tests/walkthrough-recorder.test.mjs pins them, so a code removed there fails the build rather than FUN-05 at Finish).
  const OUTCOMES = [['sold_on_site', 'Signed on site', 'Then finish Review for the signature and deposit'], ['quote_to_follow', 'Quote to follow', 'The office sends the quote'], ['not_interested', 'Not interested', 'Choose why'], ['customer_no_show', 'No-show', 'The customer was not there'], ['rescheduled', 'Rescheduled', 'Choose why']];
  const REASONS = {
    not_interested: [['price', 'Price'], ['timing', 'Timing'], ['chose_competitor', 'Chose a competitor'], ['diy', 'Doing it themselves'], ['no_response', 'No response'], ['not_a_fit', 'Not a fit for us'], ['other', 'Other']],
    customer_no_show: [['customer_not_home', 'Customer not home'], ['no_access', 'No access'], ['unreachable', 'Could not reach the customer'], ['wrong_address', 'Wrong address'], ['other', 'Other']],
    rescheduled: [['customer_request', 'Customer asked to move it'], ['weather', 'Weather'], ['crew_unavailable', 'Rep or crew unavailable'], ['previous_job_overran', 'Previous visit ran over'], ['access_issue', 'Access problem'], ['vehicle_or_equipment', 'Vehicle or equipment'], ['other', 'Other']],
  };

  const core = { LIMITS, ACCEPT, MIME_TYPES, OUTCOMES, REASONS, pickMime, importType, extensionFor, classify, applicable, memoryStore, idbStore, deviceStore, saveAs, saveRow, saveChange, withdrawSession, claim, localLedger, tabPresence, createRecorder, createSync, httpVisit, xhrUpload };
  root.EGCWalkthroughRecorder = core;
  if (typeof document === 'undefined') return;

  // ---- Page UI (gameplan) ----
  const NOTE_LABELS = ['What the customer wants done', 'What stays, what goes, and anything to protect', 'Access, hazards and anything special'];
  // Typed notes stand in for the audio where the office follows up.
  const NOTES_REQUIRED = new Set(['sold_on_site', 'quote_to_follow']);
  const ENABLED_KEY = 'egc-wt-recorder:enabled', WITHDRAWN_KEY = 'egc-wt-recorder:withdrawn:', WITHDRAWN_WALKS_KEY = 'egc-wt-recorder:withdrawn-walkthroughs:';
  // What a tab shows for a walkthrough another gameplan tab of this iPad holds: it cannot record, upload, finish or withdraw it.
  const OTHER_TAB_TEXT = 'This walkthrough is open in another tab on this iPad — use that tab.';
  // What the card says on an iPad whose Safari has no Web Locks (before iPadOS 15.4).
  const UPDATE_TEXT = 'Recording in the Hub needs iPadOS 15.4 or later. Update this iPad in Settings > General > Software Update, or record in Voice Memos and add the file here.';
  const mb = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / 1024))} KB`;
  const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  // About how long a number of bytes plays at the recorder's bit rate.
  const playtime = bytes => clock(bytes * 8 / LIMITS.bitsPerSecond * 1000);
  const denver = value => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); } catch { return ''; } };
  const denverTime = value => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); } catch { return ''; } };
  // What the rep tells the office about a part on the recording service although consent was withdrawn.
  // With several walkthroughs of one visit in one message, a part is named by its file or by its walkthrough's start.
  const partLabel = (session, part, several = false) => `Part ${part.index}${part.source === 'import' ? ` (${part.name || 'Voice Memos file'})` : several && session ? ` of the walkthrough started ${denver(session.startedAt)}` : ''}`;
  const noticeText = (part, label = partLabel(null, part)) => part.uploadedBefore ? `${label} was uploaded before the withdrawal: tell the office (recording ID ${part.recordingId}).`
    : part.recordingId ? `${label} reached the recording service before the withdrawal took effect: tell the office (recording ID ${part.recordingId}).`
    : `${label} may have reached the recording service before the withdrawal took effect: tell the office (upload ID ${part.requestId}).`;
  const outcomeLabel = code => OUTCOMES.find(([id]) => id === code)?.[1] || String(code || '').replaceAll('_', ' ');
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (['value', 'checked', 'disabled', 'hidden', 'selected'].includes(key)) node[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  }
  const button = (label, onclick, className = 'wt-btn', extra = {}) => h('button', { type: 'button', className, onclick, ...extra }, label);

  /** Mounts the recorder: options.visit() gives the open Hub walkthrough {id, customer} or null, options.user() the signed-in employee,
      and options.openVisit(id) switches the plan to another walkthrough in the page (true when it did). */
  function mount(host, options = {}) {
    const now = options.now || (() => Date.now()), timers = options.timers || root, uuid = options.uuid || (() => root.crypto.randomUUID());
    const store = options.store || deviceStore(), visits = options.visitApi || httpVisit(options.fetch || root.fetch?.bind(root));
    const ui = { visitId: null, state: null, loading: false, loadError: null, step: 'idle', skipTimecard: false, busy: false, micError: null, pending: null, draft: null, sessions: [], active: null, message: '', open: false, backoff: 0, retryTimer: null, watchTimer: null, generation: 0, stopped: null, signature: '', finishFor: null, heldElsewhere: false, drawn: new Set(), stripped: new Set() };
    const user = () => String(options.user?.() || '').trim();
    // The employee whose walkthroughs the page last read: signing in (or as someone else) without a reload reads them again.
    ui.who = user();
    const bar = h('div', { className: 'wt-bar', hidden: true, role: 'region', 'aria-label': 'Walkthrough recording controls' });
    const presence = tabPresence({ locks: options.locks === undefined ? root.navigator?.locks : options.locks });
    // Without Web Locks this page records nothing in the Hub and never holds a walkthrough: one it saves belongs to no tab
    // (owner null), so any tab finishes, withdraws and sends it, and none needs to know whether another tab is still open. A
    // walkthrough a tab holds all the same (saved with Web Locks, or by an older build) is never taken: it is kept as it is.
    const holderAt = at => (presence.exact ? { tab: recorder.tab, at } : null);
    const ELSEWHERE_TEXT = presence.exact ? OTHER_TAB_TEXT : `${OTHER_TAB_TEXT} If that tab is closed, the walkthrough is kept on this iPad and sent once this iPad runs iPadOS 15.4 or later.`;
    // A recording this tab lost (another tab found this page gone and holds it now) is re-read at once, so this tab never shows
    // it as its own.
    const recorder = createRecorder({ store, now, uuid, timers, media: options.media, Recorder: options.Recorder, wakeLock: options.wakeLock, ledger: options.ledger, onPartClosed: () => schedule(0),
      onChange: () => { drawBar(); if (signature() === ui.signature) return; if (recorder.status().problem?.code === 'moved') { ui.signature = signature(); tickLoop(false); void reload(); } else draw(); } });
    // No tab's sync uploads anything of a visit whose customer withdrew consent on this iPad (withdrawnFor, below).
    const sync = createSync({ store, visit: visits, upload: options.upload || xhrUpload(), now, uuid, user, ledger: options.ledger, tab: recorder.tab, onChange: () => drawProgress(), withdrawnVisit: row => withdrawnFor(row) });
    const barHost = options.barHost || host;
    barHost.prepend(bar);
    host.classList.add('egc-wt');
    let heartbeat = null, resizing = null;

    const remember = enabled => { try { if (enabled) root.localStorage.setItem(ENABLED_KEY, '1'); else root.localStorage.removeItem(ENABLED_KEY); } catch { /* storage blocked */ } };
    const rememberedEnabled = () => { try { return root.localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; } };
    const mine = () => ui.sessions.filter(row => same(row.user, user()));
    const localFor = visitId => mine().find(row => row.visitId === visitId && row.status !== 'finished') || null;
    const signature = () => { const status = recorder.status(); return `${status.capture}|${status.problem?.code || ''}|${status.problem?.at || ''}`; };
    const audioIn = session => (session?.parts || []).some(part => part.bytes > 0) || (recorder.status().session?.id === session?.id && recorder.status().partBytes > 0);
    const statusOf = session => session.consent === 'declined' ? 'declined' : audioIn(session) ? 'recorded' : 'failed_device';
    // A walkthrough another tab of this iPad holds, and one this tab may change (it holds it, or no tab does).
    const elsewhere = session => Boolean(session?.owner?.tab) && session.owner.tab !== recorder.tab && recorder.status().session?.id !== session.id;
    const here = row => Boolean(row) && (!row.owner?.tab || row.owner.tab === recorder.tab);
    // Visits whose customer withdrew recording consent on this iPad. Kept outside the walkthroughs (which leave the iPad once
    // they are sent) and for any account, so no tab uploads any walkthrough of that visit afterwards (the sync's
    // withdrawnVisit), whichever tab holds it, and no Voice Memos file is accepted for it.
    const withdrawnKey = visitId => `${WITHDRAWN_KEY}${visitId}`, withdrawnWalksKey = visitId => `${WITHDRAWN_WALKS_KEY}${visitId}`;
    const rememberWithdrawn = visitId => { try { root.localStorage.setItem(withdrawnKey(visitId), JSON.stringify({ at: iso(now()), user: user() })); } catch { /* storage blocked: the server outcome still says declined when it was not yet sent */ } };
    const withdrawnHere = visitId => { try { return Boolean(visitId) && root.localStorage.getItem(withdrawnKey(visitId)) !== null; } catch { return false; } };
    const withdrawnWalks = visitId => { try { const list = JSON.parse(root.localStorage.getItem(withdrawnWalksKey(visitId)) || '[]'); return Array.isArray(list) ? list : []; } catch { return []; } };
    /** A walkthrough whose visit's customer withdrew consent on this iPad (or one on the iPad when that visit's customer agreed
        to a recording again): nothing of it is uploaded, and it is never sent as recorded. */
    const withdrawnFor = row => Boolean(row?.visitId) && (withdrawnHere(row.visitId) || withdrawnWalks(row.visitId).includes(row.id));
    /** Everyone present agreed to a recording of this (rebooked) visit again: the earlier withdrawal no longer applies to what is
        recorded from now on, but every walkthrough of the visit already on this iPad (except keepId, the new one) stays
        withdrawn. When that cannot be written, the visit stays withdrawn. */
    async function renewConsent(visitId, keepId) {
      if (!withdrawnHere(visitId)) return;
      let rows;
      try { rows = await store.sessions(); } catch { rows = ui.sessions; }
      const kept = [...new Set([...withdrawnWalks(visitId).filter(id => rows.some(row => row.id === id)), ...rows.filter(row => row.visitId === visitId && row.id !== keepId).map(row => row.id)])];
      try {
        if (kept.length) root.localStorage.setItem(withdrawnWalksKey(visitId), JSON.stringify(kept)); else root.localStorage.removeItem(withdrawnWalksKey(visitId));
        root.localStorage.removeItem(withdrawnKey(visitId));
      } catch { /* storage blocked */ }
    }
    function currentVisit() { try { return options.visit?.() || null; } catch { return null; } }

    async function reload() {
      ui.who = user();
      try { ui.sessions = await store.sessions(); } catch { ui.sessions = []; }
      if (ui.sessions.length) engage();
      // Only with Web Locks is a walkthrough taken (from a tab known to be gone, or from no tab).
      if (presence.exact && mine().some(row => !here(row) || !row.owner?.tab) && await adopt()) { try { ui.sessions = await store.sessions(); } catch { /* keep the last read */ } }
      // The open walkthrough (only one is ever created: every open one is saved exclusively). Should two be on the iPad all the
      // same, the bar belongs to the one this tab records.
      const open = mine().filter(row => row.status === 'active' || row.status === 'starting');
      ui.active = open.find(row => row.id === recorder.status().session?.id) || open[0] || null;
      watch();
      draw();
      // A walkthrough of this visit that another tab held has left it: the visit is read again, so its outcome shows here.
      const held = Boolean(ui.visitId) && mine().some(row => row.visitId === ui.visitId && elsewhere(row));
      if (ui.heldElsewhere && !held && !ui.loading) void loadState(true);
      ui.heldElsewhere = held;
    }
    // The tab lock, persistent storage and the leave-page prompt are taken only once the recorder is in use here (switched on,
    // or a walkthrough on this iPad), so a gameplan with it switched off behaves as before. Without Web Locks none is taken.
    let engaged = false;
    function engage() {
      if (engaged || !presence.exact) return;
      engaged = true;
      void presence.hold(recorder.tab);
      keepStorage();
      root.addEventListener?.('beforeunload', onUnload);
    }
    // This page's tab lock again (it may have lost it while alive, as in WebKit's back/forward cache), so that no other tab takes
    // what it holds for a closed tab. Bounded, so a lock the browser never answers holds nothing up.
    const holdTab = () => (engaged ? new Promise(resolve => { const timer = timers.setTimeout(resolve, 1000); presence.hold(recorder.tab).then(() => { timers.clearTimeout(timer); resolve(); }); }) : Promise.resolve());
    /** With Web Locks: walkthroughs of mine that another tab of this iPad holds stay with that tab while it is open: this tab says
        so and cannot record, upload, finish or withdraw them. Only a holder known to be gone is replaced: a tab whose lock is
        gone (closed, reloaded, or discarded by Safari). A walkthrough no tab holds is taken too. This page takes its own lock
        again first; the claim re-checks the holder in the same write, and an upload the gone page had started counts as possibly
        on the recording service. True when this tab took one. */
    async function adopt() {
      let taken = false, held = false;
      for (const row of mine()) {
        const holder = row.owner?.tab || null;
        if (holder === recorder.tab || recorder.status().session?.id === row.id) continue;
        if (holder && await presence.alive(row.owner)) continue;
        if (!held) { held = true; await holdTab(); }
        const open = row.status === 'active' || row.status === 'starting';
        if (open && row.consent === 'recorded' && row.capture !== 'none' && !recorder.status().session) {
          if (!await recorder.recover(row, { from: holder })) continue;
          tickLoop(true);
        } else if (!await claim(store, row.id, holder, recorder.tab, iso(now()))) continue;
        if (row.status === 'starting') await edit(store, row.id, saved => (here(saved) && saved.status === 'starting' ? Object.assign(saved, { status: 'active' }) : null));
        taken = true;
      }
      return taken;
    }
    // While another tab holds a walkthrough of mine, this tab looks again every few seconds (a local read: no request, and no
    // other tab is woken), so it takes the walkthrough back once that tab is gone and shows what that tab did meanwhile.
    function watch() {
      timers.clearTimeout(ui.watchTimer); ui.watchTimer = null;
      if (mine().some(elsewhere)) ui.watchTimer = timers.setTimeout(() => { void reload(); }, LIMITS.watchMs);
    }

    /** Applies the page's change to the saved session, re-read in the same write, only while this tab holds it (another tab's
        walkthrough is that tab's to change), so the recorder's and the sync's fields stay theirs. A change that returns null
        refuses in that write (the saved session is not what it expects): nothing is saved. */
    async function update(id, mutate) {
      const saved = await edit(store, id, row => { if (!here(row)) return null; return mutate(row) === null ? null : row; });
      await reload();
      return saved;
    }
    // Another open (or unsent) walkthrough of mine for this visit, or, when exclusive, any walkthrough I have open: checked in
    // the same write that saves the new one, so two tabs cannot both open one.
    const conflict = (exclusive = false) => (rows, session) => rows.some(row => row.id !== session.id && same(row.user, session.user) && (row.visitId === session.visitId && (row.status !== 'finished' || (row.actions || []).some(item => item.state !== 'done')) || exclusive && ['active', 'starting'].includes(row.status)));
    /** Saves a new session unless the conflict check (re-run in the same write) finds another one. */
    async function create(session, { exclusive = false } = {}) {
      await holdTab();
      const out = await store.atomic(rows => conflict(exclusive)(rows, session) ? { result: false } : { put: [session], result: true });
      await reload();
      return out.result;
    }
    const blankDraft = () => ({ outcome: '', reasonCode: '', notes: ['', '', ''], error: '', recordingStatus: startedRecord()?.recordingStatus || 'recorded' });
    function startedRecord() { const record = ui.state?.visit; return record && !record.rebookPending ? record.walkthroughVisit || null : null; }
    async function loadState(force = false) {
      const visit = currentVisit(), id = visit?.id || null, changed = id !== ui.visitId;
      if (!force && !changed) return;
      const generation = ++ui.generation;
      if (changed) {
        Object.assign(ui, { visitId: id, state: null, loadError: null, step: 'idle', draft: null, skipTimecard: false, message: '', micError: null, pending: null, heldElsewhere: false });
        // The bar's Finish switched to the recorded visit: its Finish screen opens there.
        if (ui.finishFor && ui.finishFor === id) Object.assign(ui, { step: 'finish', draft: blankDraft() });
        ui.finishFor = null;
      }
      if (!id) { draw(); return; }
      if (!ui.state) { ui.loading = true; draw(); }
      try {
        const state = await visits.state(id);
        if (generation !== ui.generation) return;
        // Switched off, FUN-05 answers {enabled: false} without reading the visit or the timecard.
        if (state?.enabled === false && !state.visit) { ui.state = { enabled: false, visit: null, openVisit: null, shift: null }; ui.loadError = null; remember(false); return; }
        if (state?.visit?.id !== id) throw failure('The walkthrough status could not be verified.', 503, 'RECORDER_UNVERIFIED');
        ui.state = state; ui.loadError = null; remember(state.enabled === true);
      } catch (error) { if (generation === ui.generation) ui.loadError = error; }
      finally {
        if (generation === ui.generation) {
          // Switched on (or, offline, last known to be on): the recorder may start here.
          if (ui.state ? ui.state.enabled === true : rememberedEnabled()) engage();
          ui.loading = false; draw();
        }
      }
    }
    function schedule(delay = 0) {
      timers.clearTimeout(ui.retryTimer);
      ui.retryTimer = timers.setTimeout(async () => {
        let result = { stopped: null, sent: [] };
        try { result = await sync.run(); } catch (error) { result = { stopped: { error, reason: classify(error) }, sent: [] }; }
        ui.stopped = result.stopped;
        await reload();
        if (result.sent.some(item => item.visitId === ui.visitId)) void loadState(true);
        if (result.stopped && ['network', 'transient'].includes(result.stopped.reason)) { ui.backoff = Math.min(ui.backoff ? ui.backoff * 2 : 5000, 120000); schedule(ui.backoff); }
        else ui.backoff = 0;
      }, delay);
    }
    function tickLoop(on) {
      if (on && !heartbeat) heartbeat = timers.setInterval(() => recorder.tick(), 1000);
      if (!on && heartbeat) { timers.clearInterval(heartbeat); heartbeat = null; }
    }

    function newSession(visit, consent) {
      const at = iso(now());
      // This tab holds the walkthrough from here until it leaves the iPad (without Web Locks, no tab does).
      return { id: uuid(), user: user(), visitId: visit.id, customer: String(visit.customer || '').slice(0, 200), createdAt: at, startedAt: at, consent, capture: consent === 'recorded' ? 'starting' : 'none', status: 'starting', owner: holderAt(at), parts: [], interruptions: [], actions: [] };
    }
    const action = (kind, intent) => ({ id: uuid(), kind, intent, requestId: null, body: null, state: 'queued', error: null, attempts: 0, serverFailures: 0, rebases: 0 });
    const startAction = (session, recordingStatus) => action('start', { recordingStatus, deviceAt: session.startedAt, ...(ui.skipTimecard ? { skipTimecard: true } : {}) });

    function beginStart() {
      if (ui.active) { ui.message = elsewhere(ui.active) ? `Your walkthrough for ${ui.active.customer || 'another visit'} is open in another tab on this iPad — use that tab.` : `Finish the walkthrough for ${ui.active.customer || 'your open visit'} first.`; draw(true); return; }
      const shift = ui.state?.shift;
      ui.step = shift && (shift.available === false || !shift.clockedIn) && !ui.skipTimecard ? 'clock' : 'consent';
      draw(true);
    }
    // The microphone request is the first thing the consent tap does: WebKit asks for it only inside a tap. Never without Web Locks.
    function consentOk() {
      const visit = currentVisit();
      if (!visit || ui.busy || ui.active || !presence.exact) return;
      const session = newSession(visit, 'recorded');
      session.actions = [startAction(session, 'recorded')];
      const starting = recorder.begin(session, { conflict: conflict(true) });
      void holdTab();
      ui.busy = true; draw(true);
      starting.then(async () => {
        ui.busy = false; ui.step = 'idle'; ui.message = '';
        // Everyone present agreed to a recording of this (rebooked) visit: an earlier withdrawal here no longer applies to it.
        await renewConsent(visit.id, session.id);
        await update(session.id, row => { row.status = 'active'; });
        tickLoop(true); schedule(0);
      }, async error => {
        recorder.release();
        if (error?.code === 'RECORDER_BUSY') { Object.assign(ui, { busy: false, step: 'idle', message: error.message }); await reload(); draw(true); return; }
        Object.assign(ui, { busy: false, micError: error, pending: session, step: 'mic' });
        draw(true);
      });
    }
    // The busy flag is set before the first wait, so a double tap cannot open the same walkthrough twice.
    async function withoutAudio(consent) {
      const visit = currentVisit();
      if (!visit || ui.busy || ui.active) return;
      ui.busy = true; draw(true);
      try {
        const session = ui.pending?.visitId === visit.id ? ui.pending : newSession(visit, consent);
        Object.assign(session, { consent, capture: 'none', status: 'active', owner: holderAt(iso(now())), parts: [], interruptions: [] });
        session.actions = [startAction(session, consent)];
        const made = await create(session, { exclusive: true });
        // The rep had tapped Recording OK before the microphone failed (or, without Web Locks, to record in Voice Memos): consent
        // for this visit was given again.
        if (made && consent === 'failed_device') await renewConsent(visit.id, session.id);
        Object.assign(ui, { pending: null, micError: null, step: 'idle', message: made ? '' : 'This walkthrough (or another one of yours) is already open on this iPad.' });
        if (made) schedule(0);
      } finally { ui.busy = false; draw(true); }
    }
    function openFinish() {
      ui.step = 'finish';
      ui.draft = ui.draft || blankDraft();
      draw(true);
      host.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
    /** Opens another walkthrough in the page when the gameplan can switch to it; false leaves a link to do it. */
    function switchTo(visitId) {
      let opened = false;
      try { opened = options.openVisit?.(visitId) === true; } catch { opened = false; }
      if (opened) check();
      return opened;
    }
    // The bar's Finish belongs to the walkthrough being recorded, which may not be the appointment on screen.
    function finishFromBar(event) {
      const active = ui.active;
      if (!active) return;
      if (currentVisit()?.id === active.visitId) { event?.preventDefault?.(); openFinish(); return; }
      ui.finishFor = active.visitId;
      // Switched in the page: its Finish screen opens there. Otherwise the link reloads the gameplan on that visit.
      if (switchTo(active.visitId)) event?.preventDefault?.(); else { ui.finishFor = null; if (!event) root.location?.assign?.(visitLink(active.visitId)); }
    }
    async function saveOutcome() {
      const draft = ui.draft, visit = currentVisit();
      if (!draft || !visit || ui.busy) return;
      const needsReason = Boolean(REASONS[draft.outcome]);
      if (!draft.outcome) { draft.error = 'Choose the outcome of this walkthrough.'; draw(true); return; }
      if (needsReason && !draft.reasonCode) { draft.error = 'Choose the reason.'; draw(true); return; }
      ui.busy = true; draft.error = ''; draw(true);
      try {
        const local = localFor(visit.id);
        // The recording stops here; its last part closes once the final second is saved.
        if (local && recorder.status().session?.id === local.id) { await recorder.finish(); tickLoop(false); recorder.release(); }
        let saved = local ? (await store.sessions()).find(row => row.id === local.id) : null;
        // Another tab holds this walkthrough: its outcome is saved there.
        if (saved && elsewhere(saved)) { draft.error = ELSEWHERE_TEXT; return; }
        const recordingStatus = saved ? statusOf(saved) : draft.recordingStatus;
        const notes = draft.notes.map(note => note.trim()).filter(Boolean);
        if (recordingStatus !== 'recorded' && NOTES_REQUIRED.has(draft.outcome) && notes.length < 3) { draft.error = 'This walkthrough has no recording: type the three short notes so the office can follow up.'; return; }
        const finish = action('finish', { outcome: draft.outcome, ...(needsReason ? { reasonCode: draft.reasonCode } : {}), recordingStatus, deviceAt: iso(now()), ...(recordingStatus !== 'recorded' && notes.length ? { typedNotes: notes.slice(0, 3) } : {}) });
        // Without Web Locks no tab holds the walkthrough, so another tab may have saved its outcome meanwhile: never a second one.
        let already = false;
        const close = row => { if (row.status === 'finished') { already = true; return null; } row.actions = [...(row.actions || []), finish]; Object.assign(row, { status: 'finished', outcome: draft.outcome, finishedAt: iso(now()) }); };
        // Refused when another tab took the walkthrough meanwhile (the write re-checks the holder): the draft stays here.
        if (saved) {
          if (!await update(saved.id, close)) {
            if (already) { Object.assign(ui, { step: 'idle', draft: null, message: 'This walkthrough’s outcome was already saved in another tab on this iPad.' }); return; }
            draft.error = ELSEWHERE_TEXT; return;
          }
        }
        else {
          const session = { ...newSession(visit, recordingStatus), capture: 'none' };
          close(session);
          if (!await create(session)) { Object.assign(ui, { step: 'idle', draft: null, message: 'This walkthrough is already saved on this iPad.' }); return; }
        }
        ui.step = 'idle'; ui.draft = null;
        // The card itself says the outcome is saved (and whether it still waits); only the next step is added.
        ui.message = draft.outcome === 'sold_on_site' ? 'Outcome saved. Now finish Review for the signature and deposit.' : '';
        schedule(0);
      } finally { ui.busy = false; draw(true); }
    }
    async function saveNoShow() {
      const draft = ui.draft, visit = currentVisit();
      if (!draft || !visit || ui.busy) return;
      if (!draft.reasonCode) { draft.error = 'Choose the reason.'; draw(true); return; }
      ui.busy = true; draw(true);
      try {
        const session = { ...newSession(visit, 'none'), capture: 'none', status: 'finished', outcome: 'customer_no_show', finishedAt: iso(now()) };
        session.actions = [action('no_show', { reasonCode: draft.reasonCode, deviceAt: iso(now()) })];
        const made = await create(session);
        Object.assign(ui, { step: 'idle', draft: null, message: made ? '' : 'This walkthrough is already saved on this iPad.' });
        if (made) schedule(0);
      } finally { ui.busy = false; draw(true); }
    }
    // A withdrawal stops the uploads of these walkthroughs on their way (only this tab sends them). Each one saves how it ended (a
    // part that may be on the recording service becomes a notice with its ID); that is awaited briefly, so the walkthroughs read
    // back say so. An upload that has not stopped by then is named as still stopping, and its notice follows once it has.
    // Returns each walkthrough as read back: null once it left the iPad (nothing waits for the rep), undefined if unreadable.
    async function stopUploads(ids) {
      if (ids.length) await new Promise(resolve => { const timer = timers.setTimeout(resolve, LIMITS.abortMs); Promise.all(ids.map(id => sync.abort(id))).then(() => { timers.clearTimeout(timer); resolve(); }, resolve); });
      const read = new Map();
      try { const rows = await store.sessions(); for (const id of ids) read.set(id, findRow(rows, id)); } catch { /* unreadable: undefined */ }
      return read;
    }
    /** The customer withdrew recording consent for this visit. The visit is remembered first, so from then on no tab's sync starts
        an upload of any walkthrough of it (withdrawnFor), whichever tab holds it now or later. Then every walkthrough of mine for
        the visit that this tab holds (or no tab does) is withdrawn: the one recording here stops, each one's audio still on the
        iPad is deleted in a write that re-checks this tab holds it, and its uploads on their way are stopped. Returns what was
        withdrawn ({session, removed, uploaded, saved}) and the walkthroughs of the visit another tab holds, which are named. */
    async function withdrawVisit(visitId) {
      rememberWithdrawn(visitId);
      const at = iso(now()), done = new Map();
      if (recorder.status().session?.visitId === visitId) {
        const result = await recorder.discard(); tickLoop(false); recorder.release();
        if (result?.session) done.set(result.session.id, result);
      }
      let rows;
      try { rows = await store.sessions(); } catch { rows = ui.sessions; }
      for (const row of rows.filter(item => item.visitId === visitId && same(item.user, user()) && !done.has(item.id) && here(item))) {
        const result = await withdrawSession(store, row.id, at, { holds: here });
        if (result.session) done.set(row.id, result);
      }
      const read = await stopUploads([...done.keys()]);
      await reload();
      const results = [...done.values()].map(result => ({ ...result, saved: read.get(result.session.id) === undefined ? result.session : read.get(result.session.id) }));
      return { results, others: mine().filter(row => row.visitId === visitId && !done.has(row.id) && elsewhere(row)) };
    }
    // Parts on the recording service although consent was withdrawn: the rep tells the office, which deletes them there.
    function uploadedText(labels) {
      if (!labels.length) return '';
      const one = labels.length === 1, plain = labels.every(label => /^Part \d+$/.test(label));
      return `${plain ? `Part${one ? '' : 's'} ${labels.map(label => label.slice(5)).join(', ')}` : labels.join(', ')} ${one ? 'was' : 'were'} already uploaded: tell the office to delete ${one ? 'it' : 'them'}.`;
    }
    const stopping = part => part.state === 'removed' && part.reason === 'withdrawn' && Boolean(part.sendingAt);
    /** What a withdrawal found on the recording service or still on its way there, over every walkthrough it withdrew. */
    function withdrawalLines(results) {
      const several = results.length > 1, named = new Set(results.flatMap(result => result.uploaded.map(part => part.id)));
      const rows = results.map(result => result.saved).filter(Boolean);
      return [uploadedText(results.flatMap(result => result.uploaded.map(part => partLabel(result.session, part, several)))),
        ...rows.flatMap(session => (session.parts || []).filter(part => noticePending(part) && !named.has(part.id)).map(part => noticeText(part, partLabel(session, part, several)))),
        ...rows.flatMap(session => (session.parts || []).filter(stopping).map(part => `${partLabel(session, part, several)} was still uploading and has not stopped yet: if it reached the recording service, it is named here with its ID so you can tell the office.`))];
    }
    // A walkthrough of the withdrawn visit that another tab holds: that tab starts no upload of it, and names each part of it
    // already uploaded (its sync turns such a part into a notice with its recording ID, kept until "I told the office"). Only a
    // walkthrough with audio parts has anything to delete there: that tab offers "Customer withdrew consent" for it (on its card,
    // or on the Finish screen of one still open).
    const othersText = others => {
      if (!others.length) return '';
      const one = others.length === 1, audio = others.filter(audioLeft), open = audio.some(row => row.status !== 'finished');
      return [`${one ? `The walkthrough of this visit started ${denver(others[0].startedAt)} is` : `${others.length} walkthroughs of this visit are`} open in another tab on this iPad: no upload of ${one ? 'it' : 'them'} starts from now on.`,
        audio.length ? `If a part of ${one ? 'it' : 'them'} was already uploaded, that tab names it with its recording ID until you tap “I told the office” there. To delete ${audio.length === 1 ? 'its' : 'their'} audio still on this iPad, tap “Customer withdrew consent” in that tab${open ? ' (on the Finish screen of a walkthrough still open)' : ''}.` : ''].filter(Boolean).join(' ');
    };
    // The customer withdrew consent before the outcome: the audio is deleted and nothing more is uploaded. Parts already sent
    // (out of storage, parts upload before Finish) are named so the office deletes them. drawn: the walkthrough whose Finish
    // screen the button is on (re-read here), never another walkthrough that happens to be open.
    async function withdraw(drawn) {
      const local = mine().find(row => row.id === drawn?.id && row.status !== 'finished') || null;
      if (!local || elsewhere(local)) { ui.message = local ? ELSEWHERE_TEXT : 'This walkthrough is no longer open on this iPad.'; draw(true); return; }
      if (!root.confirm?.('Delete the audio recorded for this walkthrough? Nothing will be uploaded.')) return;
      const { results, others } = await withdrawVisit(local.visitId);
      // Another tab took the walkthrough meanwhile: the rep withdraws it there (no tab uploads anything of the visit from now on).
      ui.message = [results.length ? 'The audio was deleted from this iPad.' : ELSEWHERE_TEXT, ...withdrawalLines(results), othersText(others), results.length ? 'Type the notes at Finish instead.' : ''].filter(Boolean).join(' ');
      draw(true);
    }
    // The visit's outcome on the server says recorded (it may have left this iPad with the walkthrough that sent it).
    const sentRecorded = visitId => { const record = ui.state?.visit; return ui.visitId === visitId && record?.id === visitId && !record.rebookPending && record.walkthroughOutcome?.recordingStatus === 'recorded'; };
    // After the outcome: the audio not yet uploaded is deleted, from every walkthrough of the visit. Parts already uploaded are
    // on the recording service: the rep tells the office, which deletes them there (docs/walkthrough-recorder-ipad-checklist.md).
    async function withdrawFinished(session) {
      const several = mine().filter(row => row.visitId === session.visitId && here(row) && withdrawable(row)).length > 1;
      if (elsewhere(session)) { ui.message = ELSEWHERE_TEXT; draw(true); return; }
      if (!root.confirm?.(`The customer withdrew consent: delete the audio of ${several ? 'this visit’s walkthroughs' : 'this walkthrough'} that is still on this iPad? It will not be uploaded.`)) return;
      const { results, others } = await withdrawVisit(session.visitId);
      const removed = results.reduce((sum, result) => sum + result.removed.length, 0);
      // An outcome frozen as recorded may be on the server, unless the server refused it (a refusal saved nothing, and its Retry
      // builds a new request, which then says declined).
      const sentAs = sentRecorded(session.visitId) || results.some(result => (result.session.actions || []).some(row => row.kind === 'finish' && row.body && row.intent?.recordingStatus === 'recorded' && !(row.state === 'error' && row.error?.kind === 'rejected')));
      ui.message = [!results.length ? ELSEWHERE_TEXT : removed ? `The audio still on this iPad was deleted (${removed} part${removed === 1 ? '' : 's'}).` : 'No audio of this walkthrough was left on this iPad.',
        ...withdrawalLines(results), othersText(others),
        sentAs ? 'The outcome was already sent as recorded: tell the office the customer withdrew consent.' : ''].filter(Boolean).join(' ');
      draw(true); schedule(0);
    }
    async function importFile(input) {
      const file = input.files?.[0], visit = currentVisit();
      input.value = '';
      if (!file || !visit) return;
      // On the Finish screen the refusal shows once, under the form (which also shows ui.message).
      const fail = message => { if (ui.step === 'finish' && ui.draft) ui.draft.error = message; else ui.message = message; draw(true); };
      const type = importType(file), outcome = ui.state?.visit?.walkthroughOutcome, local = localFor(visit.id);
      if (!type) return fail('Choose an audio file: an .m4a from Voice Memos, or .mp3, .wav, .aac or .webm.');
      if (!file.size) return fail('That audio file is empty.');
      if (file.size > LIMITS.uploadBytes) return fail(`That file is ${mb(file.size)}. Files over 24 MB are not accepted yet: trim or split it in Voice Memos and add each part, or record in the Hub.`);
      if (local && elsewhere(local)) return fail(ELSEWHERE_TEXT);
      if (local?.consent === 'declined' || !local && (outcome?.recordingStatus === 'declined' || startedRecord()?.recordingStatus === 'declined')) return fail('The customer declined recording, so no audio is uploaded for this walkthrough.');
      // Consent was withdrawn on this iPad (the walkthrough itself may have left it, with its outcome already sent as recorded).
      if (withdrawnHere(visit.id)) return fail('The customer withdrew recording consent for this walkthrough, so no audio is uploaded for it.');
      if (local && local.consent === 'recorded') return fail('This walkthrough is being recorded in the Hub. Add a Voice Memos file only when the Hub recording failed.');
      const part = { id: uuid(), index: 0, requestId: uuid(), mimeType: type, extension: EXTENSIONS[type] || 'audio', source: 'import', name: String(file.name || '').slice(0, 120), startedAt: iso(now()), endedAt: iso(now()), bytes: file.size, chunks: 1, reason: 'import', state: 'closed', recordingId: null, attempts: 0, serverFailures: 0, error: null };
      const session = local || (outcome || ui.state?.visit?.walkthroughVisit ? { ...newSession(visit, 'recorded'), capture: 'none', status: outcome ? 'finished' : 'active', outcome: outcome?.outcome || null, finishedAt: outcome ? iso(now()) : null } : null);
      if (!session) return fail('Start this walkthrough first, then add the Voice Memos file at Finish.');
      try { await store.putChunk({ id: chunkId(part.id, 1), partId: part.id, sessionId: session.id, seq: 1, type, bytes: file.size, at: iso(now()), data: await bytesOf(file) }); }
      catch { return fail('This iPad could not keep that file. Free some space and try again.'); }
      // Re-checked in the write that adds it: consent may have been withdrawn meanwhile in another tab (without Web Locks no tab
      // holds the walkthrough), and a file added then would stay on the iPad after the walkthrough leaves it.
      let withdrawnNow = false;
      const add = row => { if (row.consent === 'declined' || withdrawnFor(row)) { withdrawnNow = true; return null; } part.index = (row.parts || []).reduce((max, item) => Math.max(max, item.index || 0), 0) + 1; row.parts = [...(row.parts || []), { ...part }]; };
      if (local) { if (!await update(local.id, add)) { await store.removeChunks(part.id).catch(() => {}); return fail(withdrawnNow ? 'The customer withdrew recording consent for this walkthrough, so no audio is uploaded for it.' : 'This walkthrough is no longer open on this iPad.'); } }
      else {
        add(session);
        // A walkthrough still open (started on another device, no outcome yet) is saved exclusively, like one started here: never
        // a second open walkthrough beside the rep's own open one (its bar, Finish and withdrawal belong to one walkthrough).
        const open = session.status !== 'finished';
        if (!await create(session, { exclusive: open })) {
          await store.removeChunks(part.id).catch(() => {});
          const other = open ? mine().find(row => row.visitId !== visit.id && ['active', 'starting'].includes(row.status)) : null;
          return fail(other ? `Your walkthrough for ${other.customer || 'another visit'} is still open on this iPad${elsewhere(other) ? ' in another tab' : ''}: finish it first, then add this file (or save this outcome first and add the file on its card).` : 'This walkthrough is still being sent from this iPad. Add the file once it is sent.');
        }
      }
      ui.message = `${file.name || 'Audio file'} added (${mb(file.size)}).`;
      if (ui.draft) ui.draft.error = '';
      draw(true); schedule(0);
    }
    async function retryAction(session, row, skipTimecard = false) {
      // A refusal saved nothing, so a new request replaces it; an unknown server outcome is resent unchanged.
      await update(session.id, saved => {
        const item = (saved.actions || []).find(entry => entry.id === row.id);
        if (!item) return;
        if (skipTimecard) item.intent = { ...item.intent, skipTimecard: true };
        if (skipTimecard || item.error?.kind !== 'transient') Object.assign(item, { body: null, requestId: null });
        Object.assign(item, { state: 'queued', error: null, serverFailures: 0 });
      });
      schedule(0);
    }
    async function dismissAction(session, row) {
      await update(session.id, saved => { const item = (saved.actions || []).find(entry => entry.id === row.id); if (item) Object.assign(item, { state: 'done', note: 'dismissed', doneAt: iso(now()) }); });
      schedule(0);
    }
    async function retryPart(session, row) {
      await update(session.id, saved => { const item = (saved.parts || []).find(entry => entry.id === row.id); if (item) Object.assign(item, { state: 'closed', error: null, serverFailures: 0 }); });
      schedule(0);
    }
    async function saveCopy(session, part) {
      const rows = await store.chunks(part.id);
      if (!rows.length) return;
      const url = URL.createObjectURL(new Blob(rows.map(row => row.data), { type: part.mimeType }));
      const link = h('a', { href: url, download: `walkthrough-${session.visitId}-part-${part.index}.${part.extension}` });
      document.body.append(link); link.click(); link.remove();
      timers.setTimeout(() => URL.revokeObjectURL(url), 60000);
      await update(session.id, saved => { const item = (saved.parts || []).find(entry => entry.id === part.id); if (item) item.copySavedAt = iso(now()); });
    }
    // A refused part can leave the iPad only by the rep's choice, after a copy was saved (or when its audio is already gone).
    async function removePart(session, part) {
      if (!root.confirm?.(`Remove part ${part.index} from this iPad? It was not uploaded; keep the copy you saved for the office.`)) return;
      // Marked removed in the write that re-checks this tab holds the walkthrough; its audio is deleted only then.
      if (!await update(session.id, saved => { const item = (saved.parts || []).find(entry => entry.id === part.id); if (item) Object.assign(item, { state: 'removed', removedAt: iso(now()) }); })) { ui.message = ELSEWHERE_TEXT; draw(true); return; }
      await store.removeChunks(part.id);
      schedule(0);
    }
    // The rep told the office about a part that reached the recording service after consent was withdrawn: the walkthrough
    // can then leave the iPad.
    async function acknowledge(session, part) {
      await update(session.id, saved => { const item = (saved.parts || []).find(entry => entry.id === part.id); if (item?.state === NOTICE) item.acknowledgedAt = iso(now()); });
      schedule(0);
    }
    // "Decide" in the bar brings the choice on the card (or in the decisions strip) into view.
    function decide() {
      const target = host.querySelector('.wt-attention button') || host.querySelector('.wt-attention a');
      host.hidden = false;
      host.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      target?.focus?.();
    }

    // ---- Drawing ----
    function problemText(problem) {
      if (!problem) return '';
      const at = denverTime(problem.at);
      const lost = problem.lostBytes ? ` About ${playtime(problem.lostBytes)} (${mb(problem.lostBytes)}) that only page memory held (the iPad was out of storage) was lost.` : '';
      if (problem.code === 'resumed') return `The screen locked or Safari left the foreground (back at ${at}, away ${clock(problem.away || 0)}). Recording continues in a new part; audio from that gap may be missing.`;
      if (problem.code === 'page_closed') return `The page closed while recording. The audio saved on this iPad is kept.${lost} Resume recording or finish the walkthrough.`;
      if (problem.code === 'moved') return 'This tab stopped recording: another tab of this iPad holds this walkthrough now.';
      if (problem.code === 'muted') return `The microphone was taken at ${at} by a call, Siri or another app. Until it comes back the recording is silent.`;
      if (problem.code === 'unmuted') return `The microphone came back at ${at} after ${clock(problem.away || 0)}; the recording was silent for that time.`;
      if (['track_ended', 'recorder_error', 'stalled'].includes(problem.code)) return `The recording was interrupted at ${at}. It continues in a new part.`;
      if (problem.code === 'storage') return 'This iPad is not saving the audio reliably (it may be out of storage). Keep this page open until the upload finishes; parts are sent early.';
      return problem.message || 'The microphone stopped. Tap Resume.';
    }
    function barText(session, status) {
      const elapsed = now() - Date.parse(session.startedAt);
      if (session.consent !== 'recorded') return `Walkthrough (not recorded) · ${clock(elapsed)}`;
      if (elsewhere(session)) return `Open in another tab · ${clock(elapsed)}`;
      if (status.capture === 'recording') return `Recording · ${clock(elapsed)} · Part ${status.partIndex} · ${mb(status.totalBytes)}`;
      return status.capture === 'interrupted' ? `Recording paused · ${clock(elapsed)}` : `Walkthrough · ${clock(elapsed)}`;
    }
    const visitLink = id => `/crew/gameplan.html?walkthroughId=${encodeURIComponent(id)}`;
    const actionName = row => row.kind === 'start' ? 'Start' : row.kind === 'no_show' ? 'No-show' : `Outcome (${outcomeLabel(row.intent?.outcome)})`;
    /** One line for the bar: what the open walkthrough needs from the rep (the choice itself is on the card). */
    function barDecision(session) {
      const rows = refused(session, false);
      if (rows.length) return { key: rows.map(row => `${row.id}:${row.error?.code || ''}`).join(','), text: `${actionName(rows[0])} needs your decision.`, decide: true };
      if (ui.stopped?.reason === 'auth' && unsentWork(session)) return { key: 'auth', text: `${ui.stopped.error?.message || 'Sign in again to send this walkthrough.'} It stays on this iPad until then.`, decide: false };
      return null;
    }
    // The gameplan's content keeps clear of the fixed footer, whatever height the bar gives it.
    function fit() {
      const style = document.documentElement?.style;
      if (barHost === host || typeof style?.setProperty !== 'function') return;
      if (bar.hidden) { style.removeProperty?.('--wt-footer'); return; }
      const height = Math.ceil(barHost.getBoundingClientRect?.().height || 0);
      if (height) style.setProperty('--wt-footer', `${height}px`);
    }
    // The bar's buttons are rebuilt only when its layout changes, so the one-second clock never swallows a tap.
    function drawBar() {
      const status = recorder.status(), session = ui.active;
      bar.hidden = !session;
      document.body?.classList.toggle('wt-active', Boolean(session));
      if (!session) { bar.replaceChildren(); bar.dataset.layout = ''; fit(); return; }
      const remote = elsewhere(session), live = !remote && status.capture === 'recording', resume = !remote && status.capture === 'interrupted' && session.consent === 'recorded', here = currentVisit()?.id === session.visitId;
      // A warning shows only on the walkthrough it is about (never on the next one started in this tab).
      const problem = status.problem && status.problemSession === session.id ? status.problem : null;
      const passing = PASSING_PROBLEMS.has(problem?.code);
      const warning = problemText(problem) || (live && status.wake === 'unsupported' ? 'Keep the screen on: set Auto-Lock to Never while recording.' : '') || (!status.persistent ? 'This iPad cannot keep the audio offline. Keep this page open until it uploads.' : '');
      // Another tab holds it: that tab records, finishes and decides; this one only says so.
      const decision = remote ? null : barDecision(session);
      const layout = [live, resume, here, remote, ui.step === 'finish', warning, passing, decision?.key, decision?.text].join('|');
      if (bar.dataset.layout !== layout) {
        bar.dataset.layout = layout;
        // Finish belongs to the walkthrough being recorded: on another appointment it opens that one first.
        const finish = remote ? null : here ? (ui.step === 'finish' ? null : button('Finish', finishFromBar, 'wt-btn wt-finish')) : h('a', { className: 'wt-btn wt-finish', href: visitLink(session.visitId), onclick: finishFromBar }, 'Finish');
        const note = remote ? ELSEWHERE_TEXT : here ? null : `This walkthrough is for ${session.customer || 'another appointment'}, not the one on screen. Finish opens it.`;
        bar.replaceChildren(...[h('div', { className: 'wt-bar-in' },
          h('span', { className: live ? 'wt-dot on' : 'wt-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'wt-bar-text' }),
          resume ? button('Resume', () => { recorder.resume().then(() => tickLoop(true), error => { ui.message = error.message; draw(true); }); }, 'wt-btn wt-secondary') : null,
          finish),
        note ? h('p', { className: 'wt-bar-note' }, note) : null,
        warning ? h('div', { className: 'wt-warn-row' }, h('p', { className: 'wt-warn', role: 'alert' }, warning), passing ? button('Dismiss', () => recorder.clearProblem(), 'wt-btn wt-quiet', { 'aria-label': 'Dismiss this warning' }) : null) : null,
        decision ? h('div', { className: 'wt-bar-alert' }, h('p', { role: 'alert' }, decision.text), decision.decide ? button('Decide', decide, 'wt-btn wt-secondary') : null) : null].filter(Boolean));
      }
      const text = bar.querySelector('.wt-bar-text');
      if (text) text.textContent = barText(session, status);
      fit();
    }
    function drawProgress() {
      for (const [partId, fraction] of sync.progress) {
        const row = host.querySelector(`[data-part="${partId}"]`);
        if (!row) continue;
        const percent = Math.round(fraction * 100), meter = row.querySelector('progress'), label = row.querySelector('.wt-part-state');
        if (meter) { meter.value = percent; meter.textContent = `${percent}%`; }
        if (label) label.textContent = `Uploading ${percent}%`;
      }
    }
    const unsentWork = session => (session.actions || []).some(row => row.state !== 'done') || session.status === 'finished' && session.consent !== 'declined' && (session.parts || []).some(part => !SETTLED_PARTS.has(part.state));
    // Audio a withdrawal still acts on: a part on the iPad (it is deleted) or one already on the recording service (it is named
    // for the office), while consent was neither declined nor withdrawn for this walkthrough. withdrawable: such a walkthrough
    // after its outcome, which offers "Customer withdrew consent" on its card whether or not any audio is still unsent.
    const audioLeft = session => session.consent !== 'declined' && (session.parts || []).some(part => part.state !== 'removed');
    const withdrawable = session => session.status === 'finished' && audioLeft(session);
    const refused = (session, parts = true) => [...(session.actions || []).filter(row => row.state === 'error'), ...(parts && session.consent !== 'declined' ? (session.parts || []).filter(part => part.state === 'error') : [])];
    // Parts that reached the recording service although consent was withdrawn, until the rep confirms telling the office.
    const notices = session => (session.parts || []).filter(noticePending);
    const withdrawButton = session => withdrawable(session) && !elsewhere(session) ? button('Customer withdrew consent: delete the audio', () => withdrawFinished(session), 'wt-btn wt-quiet') : null;
    // Where the rep decides: on the strip above, on the visit's card below (the walkthrough of the visit on screen), or in the tab
    // that holds the walkthrough.
    const decideWhere = session => elsewhere(session) ? 'in the tab that holds it' : ui.drawn.has(session.id) && !ui.stripped.has(session.id) ? 'below' : 'above';
    /** What this walkthrough needs from the rep: refused actions (with the timecard choice) and parts, or the sign-in the sync waits for. */
    function attention(session, { alert = true } = {}) {
      const rows = [...refused(session), ...notices(session)], auth = ui.stopped?.reason === 'auth' && unsentWork(session);
      if (!rows.length && !auth) return null;
      ui.drawn.add(session.id);
      const controls = !elsewhere(session);
      return h('ul', { className: 'wt-list wt-attention' },
        rows.map(row => row.kind ? actionLine(session, row, { alert, controls }) : partLine(session, row, { controls })),
        auth ? h('li', { className: 'wt-error', role: alert ? 'alert' : null }, `${ui.stopped.error?.message || 'Sign in again to send this walkthrough.'} It stays on this iPad until then.`) : null);
    }
    // Every walkthrough of mine that waits for a decision and is not on the card: shown above the plan on every appointment
    // (and with no appointment on screen), not only in the collapsed unsent list.
    function decisions() {
      const rows = mine().filter(session => !ui.drawn.has(session.id) && (refused(session).length || notices(session).length));
      ui.stripped = new Set(rows.map(session => session.id));
      if (!rows.length) return null;
      const title = session => `The walkthrough for ${session.customer || 'another appointment'} (${denver(session.startedAt)}) ${refused(session).length ? 'needs your decision.' : 'has audio on the recording service although the customer withdrew consent.'}`;
      return h('section', { className: 'wt-decide', 'aria-label': 'Walkthroughs that need your decision' }, rows.map(session => h('div', { className: 'wt-panel wt-decide-panel' },
        h('p', { className: 'wt-decide-title', role: 'alert' }, title(session)),
        attention(session, { alert: false }),
        elsewhere(session) ? h('p', { className: 'wt-muted' }, ELSEWHERE_TEXT)
          : currentVisit()?.id === session.visitId ? null : h('div', { className: 'wt-row' }, h('a', { className: 'wt-btn wt-quiet', href: visitLink(session.visitId), onclick: event => { if (switchTo(session.visitId)) event.preventDefault?.(); } }, 'Open that walkthrough')))));
    }
    // controls: false lists a refusal without its buttons, which the decisions strip above (or the tab that holds the
    // walkthrough) shows.
    function actionLine(session, row, { alert = true, controls = true } = {}) {
      const name = actionName(row), actions = session.actions || [];
      if (row.state === 'done') return h('li', { className: 'wt-ok' }, `${name}: saved${row.note === 'dismissed' ? ' (dismissed)' : ''}`);
      if (row.state === 'error' && !controls) return h('li', { className: 'wt-error' }, `${name} needs your decision (${decideWhere(session)}): ${row.error?.message || 'It was not accepted.'}`);
      if (row.state === 'queued') {
        const blocked = actions.slice(0, actions.indexOf(row)).some(item => item.state === 'error');
        return h('li', {}, `${name}: saved on this iPad, ${blocked ? 'waiting for your decision above' : ui.stopped?.reason === 'auth' ? 'sign in again to send it' : 'sending when the signal allows'}`);
      }
      const error = row.error || {}, timecard = TIMECARD_CODES.has(error.code), open = error.code === 'walkthrough_visit_outcome_required' && error.details?.visitId;
      // A Start refused for its offline time would be refused again as it is: only the timecard choice can send it.
      const stale = error.code === 'walkthrough_visit_time_invalid' && error.details?.deviceTime === true;
      return h('li', { className: 'wt-error' }, h('span', { role: alert ? 'alert' : null }, `${name} needs your decision: ${error.message || 'It was not accepted.'}`),
        stale ? h('span', { className: 'wt-muted' }, `Retry would be refused again: this ${row.kind === 'start' ? 'Start' : 'action'} was saved on the iPad while offline. ${row.kind === 'start' ? 'Start without timecard keeps its real start time.' : ''}`.trim()) : null,
        h('span', { className: 'wt-row' },
          timecard ? button(row.kind === 'start' ? 'Start without timecard' : 'Save without changing my timecard', () => retryAction(session, row, true), 'wt-btn wt-secondary') : null,
          error.code === 'walkthrough_visit_clock_in_required' ? h('a', { className: 'wt-btn wt-secondary', href: '/employee?view=my_day', target: '_blank', rel: 'noopener' }, 'Open time clock') : null,
          open ? h('a', { className: 'wt-btn wt-secondary', href: visitLink(error.details.visitId) }, 'Open that walkthrough') : null,
          stale ? null : button('Retry', () => retryAction(session, row), 'wt-btn wt-secondary'),
          button('Dismiss', () => dismissAction(session, row), 'wt-btn wt-quiet', { 'aria-label': `Dismiss ${name}` })));
    }
    function partLine(session, part, { controls = true } = {}) {
      if (part.state === NOTICE) return h('li', { className: 'wt-part wt-part-notice', 'data-part': part.id },
        h('span', { className: 'wt-part-name' }, `${partLabel(null, part)} · ${mb(part.bytes || 0)}`),
        h('span', { className: 'wt-part-state' }, part.acknowledgedAt ? 'On the recording service (office told)' : 'On the recording service'),
        part.acknowledgedAt ? null : h('span', { className: 'wt-row' }, h('span', { role: controls ? 'alert' : null }, noticeText(part)),
          controls ? button('I told the office', () => acknowledge(session, part), 'wt-btn wt-secondary') : h('span', {}, `Confirm ${decideWhere(session)}.`)));
      const fraction = sync.progress.get(part.id), percent = Math.round((fraction || 0) * 100), missing = part.error?.code === 'RECORDER_AUDIO_MISSING';
      const state = part.state === 'uploaded' ? 'Uploaded' : part.state === 'removed' ? (part.reason === 'withdrawn' ? (stopping(part) ? 'Deleted from this iPad (consent withdrawn); its upload is stopping' : 'Deleted (consent withdrawn)') : 'Removed from this iPad') : fraction !== undefined ? `Uploading ${percent}%` : part.state === 'error' ? 'Needs your decision' : part.state === 'recording' ? 'Recording' : withdrawnFor(session) ? 'Not sent: the customer withdrew consent for this visit' : session.status !== 'finished' ? 'Uploads after Finish' : ui.stopped?.reason === 'auth' ? 'Sign in again to send' : 'Waiting for signal';
      const code = part.error?.code && !Object.hasOwn(UPLOAD_ERRORS, part.error.code) && !/^RECORDER_/.test(part.error.code) ? ` (${part.error.code})` : '';
      return h('li', { className: `wt-part wt-part-${part.state}`, 'data-part': part.id },
        h('span', { className: 'wt-part-name' }, `Part ${part.index}${part.source === 'import' ? ` (${part.name || 'Voice Memos file'})` : ''} · ${mb(part.bytes || 0)}`),
        h('span', { className: 'wt-part-state' }, state),
        part.lostBytes ? h('span', { className: 'wt-muted' }, `About ${playtime(part.lostBytes)} of this part was lost when the page closed (the iPad was out of storage).`) : null,
        part.state === 'closed' ? h('progress', { max: 100, value: percent, 'aria-label': `Part ${part.index} upload` }, `${percent}%`) : null,
        part.state === 'error' && !controls ? h('span', {}, `${part.error?.message || 'The upload was refused.'}${code} Decide ${decideWhere(session)}.`) : null,
        part.state === 'error' && controls ? h('span', { className: 'wt-row' }, h('span', { role: 'alert' }, `${part.error?.message || 'The upload was refused.'}${code}`),
          missing ? null : button('Retry upload', () => retryPart(session, part), 'wt-btn wt-secondary'),
          missing ? null : button(part.copySavedAt ? 'Save another copy' : 'Save a copy', () => saveCopy(session, part), 'wt-btn wt-quiet'),
          part.copySavedAt || missing ? button('Remove from this iPad', () => removePart(session, part), 'wt-btn wt-quiet', { 'aria-label': `Remove part ${part.index} from this iPad` }) : null) : null);
    }
    function sessionCard(session) {
      // Its decisions show once: on the strip above, on the visit's card below, or here (never twice on one screen).
      const remote = elsewhere(session), controls = !ui.stripped.has(session.id) && !ui.drawn.has(session.id) && !remote;
      return h('article', { className: 'wt-session' },
        h('h3', {}, `${session.customer || 'Walkthrough'} · ${denver(session.startedAt)}`),
        remote ? h('p', { className: 'wt-muted' }, ELSEWHERE_TEXT) : null,
        session.status !== 'finished' && !remote ? h('p', { className: 'wt-muted' }, 'In progress: finish this walkthrough to send its audio.') : null,
        session.consent === 'declined' ? h('p', { className: 'wt-muted' }, 'Recording declined: no audio is kept or uploaded.') : null,
        h('ul', { className: 'wt-list' }, (session.actions || []).map(row => actionLine(session, row, { controls })), (session.parts || []).filter(part => session.consent !== 'declined' || part.state === 'uploaded' || part.state === NOTICE || part.sendingAt).map(part => partLine(session, part, { controls }))),
        withdrawButton(session));
    }
    function unsent() {
      const rows = mine().filter(row => row.status === 'finished' || row.visitId !== ui.visitId), others = ui.sessions.length - mine().length;
      if (!rows.length && !others) return null;
      return h('section', { className: 'wt-unsent', 'aria-label': 'Unsent recordings' },
        rows.length ? button(`Unsent recordings on this iPad · ${rows.length}`, () => { ui.open = !ui.open; draw(true); }, 'wt-badge', { 'aria-expanded': String(ui.open) }) : null,
        rows.length && ui.open ? h('div', { className: 'wt-unsent-list' }, rows.map(sessionCard), rows.some(here) ? button('Send now', () => schedule(0), 'wt-btn wt-secondary') : null) : null,
        others ? h('p', { className: 'wt-muted' }, `${others} walkthrough${others === 1 ? '' : 's'} from another account ${others === 1 ? 'is' : 'are'} waiting on this iPad. Sign in as that employee to send ${others === 1 ? 'it' : 'them'}.`) : null);
    }
    function choiceGrid(list, selected, pick, name) {
      return h('div', { className: 'wt-choices', role: 'radiogroup', 'aria-label': name }, list.map(([id, label, sub]) => h('button', { type: 'button', className: id === selected ? 'wt-choice on' : 'wt-choice', role: 'radio', 'aria-checked': String(id === selected), onclick: () => pick(id) }, label, sub ? h('small', {}, sub) : null)));
    }
    function reasonSelect(draft, list) {
      return h('label', { className: 'wt-field' }, h('span', {}, 'Reason'), h('select', { onchange: event => { draft.reasonCode = event.target.value; draft.error = ''; } }, h('option', { value: '' }, 'Choose the reason'), list.map(([id, label]) => h('option', { value: id, selected: draft.reasonCode === id }, label))));
    }
    const fileInput = label => h('label', { className: 'wt-file' }, h('span', {}, label), h('input', { type: 'file', accept: ACCEPT, onchange: event => importFile(event.target) }));
    function finishPanel(visit) {
      const draft = ui.draft, local = localFor(visit.id), live = recorder.status().session?.id === local?.id ? recorder.status().capture : 'none';
      // A walkthrough the server records as declined never offers audio.
      const declined = !local && startedRecord()?.recordingStatus === 'declined';
      const noAudio = local ? statusOf(local) !== 'recorded' && live !== 'recording' : draft.recordingStatus !== 'recorded';
      const statuses = [['recorded', 'Recorded (another device or Voice Memos)'], ['declined', 'Customer declined recording'], ['failed_device', 'Recording failed on the device']].filter(([id]) => !declined || id !== 'recorded');
      // Consent was withdrawn for this visit on this iPad: no Voice Memos file is offered for it.
      const withdrawnVisit = withdrawnHere(visit.id);
      return h('div', { className: 'wt-panel', role: 'group', 'aria-labelledby': 'wt-finish-customer wt-finish-title' },
        h('div', { className: 'wt-head' }, h('div', {}, h('span', { className: 'wt-eyebrow', id: 'wt-finish-customer' }, visit.customer || 'This walkthrough'), h('h2', { id: 'wt-finish-title' }, 'Finish walkthrough'))),
        local ? attention(local) : null,
        ui.message ? h('p', { className: 'wt-note', role: 'status' }, ui.message) : null,
        h('p', { className: 'wt-muted' }, live === 'recording' ? 'Recording continues until you save the outcome.' : 'Choose what happened. The office follow-up is created from this.'),
        choiceGrid(OUTCOMES, draft.outcome, id => { Object.assign(draft, { outcome: id, reasonCode: '', error: '' }); draw(true); }, 'Walkthrough outcome'),
        REASONS[draft.outcome] ? reasonSelect(draft, REASONS[draft.outcome]) : null,
        local ? null : h('label', { className: 'wt-field' }, h('span', {}, 'Recording'), h('select', { onchange: event => { draft.recordingStatus = event.target.value; event.target.blur(); draw(true); } }, statuses.map(([id, label]) => h('option', { value: id, selected: draft.recordingStatus === id }, label)))),
        noAudio ? h('fieldset', { className: 'wt-notes' }, h('legend', {}, NOTES_REQUIRED.has(draft.outcome) ? 'Three short notes (no recording)' : 'Short notes (no recording)'),
          NOTE_LABELS.map((label, i) => h('label', { className: 'wt-field' }, h('span', {}, label), h('textarea', { rows: 2, maxlength: 400, value: draft.notes[i], oninput: event => { draft.notes[i] = event.target.value; } })))) : null,
        !withdrawnVisit && (local?.consent === 'failed_device' || !local && !declined && draft.recordingStatus === 'recorded') ? fileInput('Add the Voice Memos file instead (.m4a)') : null,
        // Withdraws this walkthrough (the one on this Finish screen), also one without a Hub recording that has a Voice Memos file.
        local && !elsewhere(local) && (local.consent === 'recorded' || audioLeft(local)) ? button('Customer withdrew consent: delete the audio', () => withdraw(local), 'wt-btn wt-quiet') : null,
        draft.error ? h('p', { className: 'wt-error', role: 'alert' }, draft.error) : null,
        h('div', { className: 'wt-row wt-actions' }, button('Back', () => { ui.step = 'idle'; draft.error = ''; draw(true); }, 'wt-btn wt-secondary'), button(ui.busy ? 'Saving…' : 'Save outcome', saveOutcome, 'wt-btn wt-primary', { disabled: ui.busy })));
    }
    function visitCard(visit) {
      const state = ui.state, record = state?.visit, local = localFor(visit.id), enabled = state ? state.enabled === true : rememberedEnabled();
      const kept = mine().filter(row => row.visitId === visit.id);
      // Switched off (or not yet known to be on) with nothing of this visit on the iPad: the gameplan stays exactly as it
      // was, with no skeleton or load error.
      if (!enabled && !local && !kept.some(unsentWork)) return null;
      if (ui.loading && !local) return h('div', { className: 'wt-panel wt-skeleton', 'aria-busy': 'true' }, h('span', { className: 'wt-line' }), h('span', { className: 'wt-line short' }), h('span', { className: 'wt-sr' }, 'Checking this walkthrough…'));
      if (ui.loadError && !local && !state && [403, 404].includes(ui.loadError.status)) return h('div', { className: 'wt-panel' }, h('p', { className: 'wt-muted' }, ui.loadError.message));
      // Without Web Locks the card says, under its heading, that the Hub cannot record here and a Voice Memos file can be added.
      const heading = [h('div', { className: 'wt-head' }, h('div', {}, h('span', { className: 'wt-eyebrow' }, 'Walkthrough recording'), h('h2', {}, visit.customer || 'This walkthrough')), ui.loadError ? button('Check again', () => loadState(true), 'wt-btn wt-quiet') : null),
        presence.exact || !enabled ? null : h('p', { className: 'wt-note wt-update', role: 'note' }, UPDATE_TEXT)];
      const message = ui.message ? h('p', { className: 'wt-note', role: 'status' }, ui.message) : null;
      if (local) {
        // Another tab holds it: that tab records, finishes, withdraws and sends it; this one only says so.
        if (elsewhere(local)) return h('div', { className: 'wt-panel' }, heading, h('p', { role: 'status' }, `${ELSEWHERE_TEXT} (Started ${denverTime(local.startedAt)}.)`), attention(local), message);
        if (ui.step === 'finish') return finishPanel(visit);
        const capture = recorder.status().session?.id === local.id ? recorder.status().capture : local.capture;
        const text = local.consent === 'recorded' ? (capture === 'recording' ? `Recording since ${denverTime(local.startedAt)}. Keep Safari open on this page; take photos and fill in the plan as usual.` : capture === 'interrupted' ? 'Recording paused. Resume recording, or finish the walkthrough.' : 'The recording is stopped. Finish the walkthrough to send it.')
          : local.consent === 'declined' ? `Started ${denverTime(local.startedAt)} without a recording (customer declined). You type three short notes at Finish.` : `Started ${denverTime(local.startedAt)} without a Hub recording. At Finish, add the Voice Memos file or type three short notes.`;
        return h('div', { className: 'wt-panel' }, heading, h('p', {}, text), attention(local), message, h('div', { className: 'wt-row wt-actions' }, button('Finish walkthrough', openFinish, 'wt-btn wt-primary')));
      }
      const outcome = record?.walkthroughOutcome && !record.rebookPending ? record.walkthroughOutcome : null;
      // Finished on this iPad but not confirmed yet: never offer Start again for the same visit.
      const waiting = !outcome && kept.filter(row => row.status === 'finished' && row.actions?.length).at(-1);
      if (waiting) {
        const next = elsewhere(waiting) ? ELSEWHERE_TEXT : refused(waiting).length ? 'It needs your decision before it can be sent:' : ui.stopped?.reason === 'auth' ? 'It is sent after you sign in again, then the audio uploads.' : 'It is sent when the signal allows, then the audio uploads.';
        return h('div', { className: 'wt-panel' }, heading, h('p', { role: 'status' }, `Outcome saved on this iPad: ${outcomeLabel(waiting.outcome)}. ${next}`), attention(waiting), message, withdrawButton(waiting));
      }
      // Switched off: only what is still on this iPad is shown, never Start.
      // The withdrawal button belongs to a walkthrough of this visit that this tab holds (it withdraws every one it holds).
      const pendingAudio = kept.find(row => withdrawable(row) && !elsewhere(row));
      if (!enabled) return kept.some(withdrawable) ? h('div', { className: 'wt-panel' }, heading, message, pendingAudio ? withdrawButton(pendingAudio) : null) : null;
      // No Voice Memos file for a visit whose customer declined (on the server) or withdrew consent (on this iPad), nor while
      // another tab holds this visit's walkthrough.
      const importable = outcome && outcome.recordingStatus !== 'declined' && startedRecord()?.recordingStatus !== 'declined' && outcome.outcome !== 'customer_no_show' && !withdrawnHere(visit.id) && !kept.some(elsewhere);
      if (outcome) return h('div', { className: 'wt-panel' }, heading, h('p', { className: 'wt-ok' }, `Outcome recorded: ${outcomeLabel(outcome.outcome)}${outcome.finishedAt ? ` at ${denverTime(outcome.finishedAt)}` : ''}.`), message,
        kept.some(elsewhere) ? h('p', { className: 'wt-muted' }, ELSEWHERE_TEXT) : null,
        pendingAudio ? withdrawButton(pendingAudio) : null,
        importable ? fileInput('Upload a Voice Memos file for this walkthrough (.m4a)') : null);
      if (record?.walkthroughVisit && !record.rebookPending) {
        if (ui.step === 'finish') return finishPanel(visit);
        return h('div', { className: 'wt-panel' }, heading, h('p', {}, `Started ${denverTime(record.walkthroughVisit.startedAt)} by ${record.walkthroughVisit.startedBy}. Record its outcome here.`), message, h('div', { className: 'wt-row wt-actions' }, button('Finish walkthrough', openFinish, 'wt-btn wt-primary')));
      }
      if (ui.active) return h('div', { className: 'wt-panel' }, heading, h('p', { role: 'alert' }, elsewhere(ui.active) ? `Your walkthrough for ${ui.active.customer || 'another visit'} is open in another tab on this iPad — use that tab.` : `Finish the walkthrough for ${ui.active.customer || 'your open visit'} before starting this one.`));
      const open = state?.openVisit && state.openVisit.id !== visit.id ? state.openVisit : null;
      if (open) return h('div', { className: 'wt-panel' }, heading, h('p', { role: 'alert' }, `Record the outcome of your open walkthrough for ${open.customer || 'another customer'} (started ${denverTime(open.walkthroughVisit?.startedAt)}) before starting this one.`),
        h('div', { className: 'wt-row wt-actions' }, h('a', { className: 'wt-btn wt-primary', href: visitLink(open.id) }, 'Open that walkthrough')));
      if (ui.step === 'clock') {
        const unavailable = state?.shift?.available === false;
        return h('div', { className: 'wt-panel' }, heading, h('p', { role: 'alert' }, unavailable ? 'Your timecard cannot be changed right now. You can start without it; a manager fixes the time later.' : 'You are not clocked in. Clock in first so this walkthrough time is paid and counted.'),
          h('div', { className: 'wt-row wt-actions' }, unavailable ? null : h('a', { className: 'wt-btn wt-secondary', href: '/employee?view=my_day', target: '_blank', rel: 'noopener' }, 'Open time clock'),
            unavailable ? null : button('I clocked in', async () => { await loadState(true); beginStart(); }, 'wt-btn wt-secondary'),
            button('Start without timecard', () => { ui.skipTimecard = true; ui.step = 'consent'; draw(true); }, 'wt-btn wt-primary')));
      }
      if (ui.step === 'consent') return h('div', { className: 'wt-panel', role: 'group', 'aria-labelledby': 'wt-consent' }, heading,
        h('p', { id: 'wt-consent', className: 'wt-consent' }, 'Ask everyone present: “Is it OK if I record our walkthrough so we get every detail right?”'),
        h('p', { className: 'wt-muted' }, 'Tap Recording OK only when everyone present agrees to a recording.'),
        // Without Web Locks the Hub does not record: Recording OK starts the walkthrough for a Voice Memos recording, added at Finish.
        h('div', { className: 'wt-row wt-actions' }, presence.exact ? button(ui.busy ? 'Starting…' : 'Recording OK', consentOk, 'wt-btn wt-primary', { disabled: ui.busy }) : button('Recording OK: record in Voice Memos', () => withoutAudio('failed_device'), 'wt-btn wt-primary', { disabled: ui.busy }), button('Customer declined recording', () => withoutAudio('declined'), 'wt-btn wt-secondary', { disabled: ui.busy }), button('Cancel', () => { ui.step = 'idle'; draw(true); }, 'wt-btn wt-quiet', { disabled: ui.busy })));
      if (ui.step === 'mic') return h('div', { className: 'wt-panel' }, heading, h('p', { role: 'alert' }, ui.micError?.message || 'The microphone could not start.'),
        h('div', { className: 'wt-row wt-actions' }, button('Try again', () => { Object.assign(ui, { step: 'consent', pending: null }); draw(true); }, 'wt-btn wt-primary', { disabled: ui.busy }), button('Continue without recording', () => withoutAudio('failed_device'), 'wt-btn wt-secondary', { disabled: ui.busy })));
      if (ui.step === 'noshow') return h('div', { className: 'wt-panel' }, heading, h('p', {}, 'Record a no-show only when the customer was not there. It is saved on this iPad and sent when the signal allows.'), reasonSelect(ui.draft, REASONS.customer_no_show), ui.draft.error ? h('p', { className: 'wt-error', role: 'alert' }, ui.draft.error) : null,
        h('div', { className: 'wt-row wt-actions' }, button('Back', () => { ui.step = 'idle'; draw(true); }, 'wt-btn wt-secondary', { disabled: ui.busy }), button(ui.busy ? 'Saving…' : 'Save no-show', saveNoShow, 'wt-btn wt-primary', { disabled: ui.busy })));
      return h('div', { className: 'wt-panel' }, heading,
        ui.loadError ? h('p', { className: 'wt-muted' }, 'No connection right now. You can still start: the walkthrough is saved on this iPad and sent when the signal returns.') : null, message,
        h('p', { className: 'wt-muted' }, 'Tap Start when you begin walking the garage with the customer.'),
        h('div', { className: 'wt-row wt-actions' }, button('Start walkthrough', beginStart, 'wt-btn wt-primary'), button('Customer no-show', () => { Object.assign(ui, { step: 'noshow', draft: { reasonCode: '', error: '' } }); draw(true); }, 'wt-btn wt-secondary')));
    }
    // Background redraws wait while the rep is typing in the Finish or No-show form.
    function draw(force = false) {
      ui.signature = signature();
      const focused = document.activeElement;
      if (!force && ['finish', 'noshow'].includes(ui.step) && focused && host.contains(focused) && /^(TEXTAREA|SELECT|INPUT)$/.test(focused.tagName)) { drawBar(); return; }
      ui.drawn = new Set();
      const visit = currentVisit(), card = visit ? visitCard(visit) : null, strip = decisions(), list = unsent();
      host.replaceChildren(...[strip, list, card].filter(Boolean));
      host.hidden = !card && !list && !strip;
      drawBar();
    }
    function check() {
      // Signed in on the gate (or as someone else) without a reload: that employee's walkthroughs are read again, so one whose
      // page is gone is taken back at once, and what waits is sent.
      if (user() !== ui.who) { ui.who = user(); void reload().then(() => { if (ui.visitId && !ui.loading) void loadState(true); schedule(0); }); }
      if ((currentVisit()?.id || null) !== ui.visitId) void loadState();
    }

    // Asks Safari to keep this site's storage instead of evicting it: unsent or refused audio can wait on the iPad for days.
    function keepStorage() {
      const manager = options.storageManager === undefined ? root.navigator?.storage : options.storageManager;
      try { Promise.resolve(typeof manager?.persisted === 'function' ? manager.persisted() : false).then(kept => kept || manager?.persist?.()).catch(() => {}); } catch { /* not supported */ }
    }
    const onOnline = () => { if (ui.loadError) void loadState(true); schedule(0); };
    const onVisibility = () => { const hidden = document.visibilityState === 'hidden'; recorder.visibility(hidden); if (!hidden) { if (ui.loadError) void loadState(true); schedule(0); } };
    const onPageHide = () => { recorder.flush(); };
    // Back from the back/forward cache: this page lives again. It takes its tab lock again (it may have lost it) and reads what
    // the other tabs did meanwhile.
    const onPageShow = event => { if (!event?.persisted) return; void holdTab().then(() => reload()); schedule(0); };
    const onUnload = event => { if (recorder.status().capture === 'recording' || !store.persistent && mine().length) { event.preventDefault(); event.returnValue = ''; } };
    const onSignout = () => { void recorder.finish().then(() => { tickLoop(false); recorder.release(); ui.sessions = []; ui.active = null; draw(true); }); };
    root.addEventListener?.('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    root.addEventListener?.('pagehide', onPageHide);
    root.addEventListener?.('pageshow', onPageShow);
    root.addEventListener?.('egc:signout', onSignout);
    if (barHost !== host && typeof root.ResizeObserver === 'function') { try { resizing = new root.ResizeObserver(() => fit()); resizing.observe(barHost); } catch { resizing = null; } }

    const ready = (async () => {
      try { ui.sessions = await store.sessions(); } catch { ui.sessions = []; }
      // Nothing is taken (no tab lock or persistent storage) until the recorder is known to be in use here, and never without
      // Web Locks.
      if (ui.sessions.length) engage();
      // With Web Locks, a walkthrough another open tab holds stays there; one whose page is gone (a tab that closed, reloaded or
      // was discarded by Safari) is taken back by reload() with its saved audio.
      await reload();
      await loadState(true);
      schedule(0);
    })();
    return {
      ready, check, draw, sync, recorder, store,
      refresh: () => loadState(true),
      canLeave: () => recorder.status().capture !== 'recording',
      unmount() {
        tickLoop(false); timers.clearTimeout(ui.retryTimer); timers.clearTimeout(ui.watchTimer);
        root.removeEventListener?.('online', onOnline); document.removeEventListener('visibilitychange', onVisibility);
        root.removeEventListener?.('pagehide', onPageHide); root.removeEventListener?.('pageshow', onPageShow); root.removeEventListener?.('beforeunload', onUnload); root.removeEventListener?.('egc:signout', onSignout);
        resizing?.disconnect?.();
        bar.remove(); host.replaceChildren();
      },
    };
  }
  core.mount = mount;

  // The gameplan hook: the recorder sits above the plan and its bar joins the fixed footer, near the thumb.
  if (typeof S === 'undefined' || !root.EGCHubAuth) return;
  const screen = document.getElementById('screen');
  if (!screen) return;
  const host = h('section', { id: 'wt-recorder', hidden: true, 'aria-label': 'Walkthrough recording' });
  screen.before(host);
  const controller = mount(host, {
    barHost: document.querySelector('footer.bottom') || host,
    visit: () => S.sourceWalkthroughId ? { id: S.sourceWalkthroughId, customer: S.name || '' } : null,
    // The bar's Finish switches the plan back to the recorded appointment when today's list has it.
    openVisit: id => { const index = typeof APPTS !== 'undefined' && Array.isArray(APPTS) ? APPTS.findIndex(row => row.id === id) : -1; if (index < 0 || typeof useAppointment !== 'function') return false; useAppointment(index); return true; },
    user: () => root.EGCHubAuth.profile().user,
    fetch: (...args) => root.EGCHubAuth.fetch(...args),
  });
  // The plan re-renders #screen on every step and appointment change; follow the open walkthrough from there.
  if (root.MutationObserver) new MutationObserver(() => controller.check()).observe(screen, { childList: true });
  root.EGCWalkthroughRecorder.page = controller;
})(typeof self !== 'undefined' ? self : globalThis);
