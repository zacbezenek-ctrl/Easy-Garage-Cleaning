import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, storage } from './helpers/hub-dom.mjs';
import { walkthroughVisitHandlers } from '../functions/api/walkthrough-visit.js';
import { authorizeTimecard } from '../functions/_lib/employee-timecards.js';
import { funnelReasonCodes } from '../functions/_lib/funnel-definitions.js';

// FUN-06: the gameplan walkthrough recorder core (crew/gameplan-recorder.js) with a fake MediaRecorder,
// a fake microphone, in-memory device storage and an injected clock. Synthetic data only.
const source = readFileSync(new URL('../crew/gameplan-recorder.js', import.meta.url), 'utf8');
const T0 = Date.parse('2026-09-22T15:00:00.000Z');
const plain = value => JSON.parse(JSON.stringify(value));
const fail = (message, status, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
let counter = 0;
const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const settle = async (rounds = 25) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };

function load(extra = {}) {
  const context = vm.createContext({ console, Promise, JSON, Date, Math, Map, Set, WeakMap, Error, Blob, FormData, Uint8Array, queueMicrotask, encodeURIComponent, ...extra });
  context.self = context;
  vm.runInContext(source, context);
  return context.EGCWalkthroughRecorder;
}
const R = load();

// Timers and Date.now under test control; nothing reads the real clock. scope() gives one tab its own timers, which
// pause() holds (as Safari pauses a background tab) while the clock runs on; resume() lets each held timer fire once.
function fakeClock(start = T0) {
  let now = start, seq = 0;
  const timers = new Map(), paused = new Set();
  const timersOf = scope => ({
    now: () => now,
    setTimeout: (fn, ms = 0) => { timers.set(++seq, { at: now + ms, fn, scope }); return seq; },
    clearTimeout: key => { timers.delete(key); },
    setInterval: (fn, ms) => { timers.set(++seq, { at: now + ms, fn, every: ms, scope }); return seq; },
    clearInterval: key => { timers.delete(key); },
  });
  return {
    ...timersOf(null),
    scope() {
      const scope = {};
      return Object.assign(timersOf(scope), { pause: () => { paused.add(scope); }, resume: () => { paused.delete(scope); for (const timer of timers.values()) if (timer.scope === scope && timer.at < now) timer.at = now; } });
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end && !paused.has(timer.scope)).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [key, timer] = due;
        now = Math.max(now, timer.at);
        if (timer.every) timer.at += timer.every; else timers.delete(key);
        timer.fn();
        await settle(4);
      }
      now = end; await settle();
    },
  };
}
// Web Locks shared by the tabs of one iPad: a lock is held until its callback's promise settles (or drop(), a closed tab).
function fakeLocks() {
  const held = new Map();
  return {
    held,
    request(name, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (held.has(name)) return options.ifAvailable ? Promise.resolve(callback(null)) : new Promise(() => {});
      held.set(name, true);
      return Promise.resolve(callback({ name, mode: 'exclusive' })).finally(() => held.delete(name));
    },
    async query() { return { held: [...held.keys()].map(name => ({ name, mode: 'exclusive' })), pending: [] }; },
    drop(name) { held.delete(name); },
  };
}
// The Web Locks every page() of this file shares by default (as tabs of one Safari): a page's lock is held until the test
// drops it (the page is gone). A page given locks: null is an iPad whose Safari has none (before iPadOS 15.4).
const LOCKS = fakeLocks();
// BroadcastChannel between the tabs of one iPad. A suspended tab's messages wait until it resumes.
function channelHub() {
  const members = new Set(), waiting = new Map(), instances = [];
  const deliver = (target, data) => { if (waiting.has(target)) waiting.get(target).push(data); else queueMicrotask(() => target.onmessage?.({ data })); };
  class Channel {
    constructor(name) { Object.assign(this, { name, onmessage: null }); members.add(this); instances.push(this); }
    postMessage(data) { for (const other of members) if (other !== this && other.name === this.name) deliver(other, structuredClone(data)); }
    close() { members.delete(this); }
  }
  return { Channel, instances, suspend: target => { if (!waiting.has(target)) waiting.set(target, []); }, resume: target => { const queued = waiting.get(target) || []; waiting.delete(target); for (const data of queued) deliver(target, data); } };
}

// A MediaRecorder stand-in: Safari reports AAC in MP4, emits a chunk per timeslice on the injected clock
// and one last chunk when stopped. The microphone hands out live tracks the test can end.
function fakeMedia(clock, { types = ['audio/mp4'], chunkBytes = 6000 } = {}) {
  // clock: the timers of the tab that records (a paused tab's recorder delivers nothing).
  const recorders = [], streams = [];
  class FakeRecorder {
    static isTypeSupported(type) { return types.includes(type) || types.includes(type.split(';')[0]) && !type.includes('codecs'); }
    constructor(stream, options = {}) { Object.assign(this, { stream, options, mimeType: options.mimeType || 'audio/webm', state: 'inactive', requested: 0 }); recorders.push(this); }
    start(timeslice) { this.state = 'recording'; this.timeslice = timeslice; this.timer = clock.setInterval(() => this.emit(), timeslice); }
    emit(bytes = chunkBytes) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes).fill(recorders.indexOf(this) + 1)], { type: this.mimeType }) }); }
    requestData() { this.requested++; }
    stop() { if (this.state === 'inactive') throw new Error('InvalidStateError'); this.state = 'inactive'; clock.clearInterval(this.timer); queueMicrotask(() => { this.emit(100); this.onstop?.(); }); }
  }
  function track() {
    const listeners = {};
    return { readyState: 'live', muted: false, stop() { this.readyState = 'ended'; }, addEventListener: (name, fn) => { listeners[name] = fn; }, end() { this.readyState = 'ended'; listeners.ended?.(); },
      mute() { this.muted = true; listeners.mute?.(); }, unmute() { this.muted = false; listeners.unmute?.(); } };
  }
  const devices = { calls: 0, fail: null, hold: null, async getUserMedia(constraints) {
    devices.calls++; devices.constraints = constraints;
    if (devices.hold) await devices.hold;
    if (devices.fail) throw Object.assign(new Error('synthetic refusal'), { name: devices.fail });
    const audio = track(), stream = { audio, getAudioTracks: () => [audio], getTracks: () => [audio] };
    streams.push(stream); return stream;
  } };
  const wake = { requests: 0, locks: [], async request(kind) { wake.requests++; const lock = { kind, released: false, async release() { lock.released = true; }, addEventListener() {} }; wake.locks.push(lock); return lock; } };
  return { FakeRecorder, recorders, streams, devices, wake };
}

function rig({ types, chunkBytes, store = R.memoryStore(), wakeLock = true } = {}) {
  const clock = fakeClock(), media = fakeMedia(clock, { types, chunkBytes });
  const recorder = R.createRecorder({ store, media: () => media.devices, Recorder: () => media.FakeRecorder, wakeLock: () => wakeLock ? media.wake : undefined, now: clock.now, timers: clock, uuid: id });
  const heartbeat = () => clock.setInterval(() => recorder.tick(), 1000);
  return { clock, media, store, recorder, heartbeat };
}
const session = (extra = {}) => ({ id: id(), user: 'Sales.Rep', visitId: 'w1', customer: 'Synthetic Customer', createdAt: new Date(T0).toISOString(), startedAt: new Date(T0).toISOString(), consent: 'recorded', capture: 'starting', status: 'starting', parts: [], interruptions: [],
  actions: [{ id: id(), kind: 'start', intent: { recordingStatus: 'recorded', deviceAt: new Date(T0).toISOString() }, requestId: null, body: null, state: 'queued', error: null, attempts: 0, serverFailures: 0, rebases: 0 }], ...extra });
const saved = async (store, sessionId) => plain((await store.sessions()).find(row => row.id === sessionId) || null);

test('the recorder prefers AAC in MP4 on Safari, then Opus, names real file extensions and accepts .m4a Voice Memos', () => {
  const recorder = types => Object.assign(function () {}, { isTypeSupported: type => types.includes(type) });
  assert.equal(R.pickMime(recorder(['audio/mp4'])), 'audio/mp4');
  assert.equal(R.pickMime(recorder(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'])), 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(R.pickMime(recorder(['audio/webm;codecs=opus', 'audio/webm'])), 'audio/webm;codecs=opus');
  assert.equal(R.pickMime(recorder([])), '', 'the browser picks its own type');
  assert.equal(R.pickMime(function () {}), '', 'no isTypeSupported: the browser picks');
  assert.equal(R.pickMime(undefined), null, 'no MediaRecorder at all');
  assert.deepEqual([R.extensionFor('audio/mp4'), R.extensionFor('audio/webm;codecs=opus'), R.extensionFor('audio/x-m4a'), R.extensionFor('audio/ogg;codecs=opus'), R.extensionFor('video/quicktime')], ['m4a', 'webm', 'm4a', 'ogg', 'audio']);
  assert.equal(R.importType({ name: 'New Recording 12.m4a', type: 'audio/x-m4a' }), 'audio/mp4', 'Voice Memos .m4a is sent as audio/mp4');
  assert.equal(R.importType({ name: 'memo.M4A', type: '' }), 'audio/mp4');
  assert.equal(R.importType({ name: 'memo.m4a', type: 'audio/m4a' }), 'audio/mp4');
  assert.equal(R.importType({ name: 'walk.mp3', type: 'audio/mpeg' }), 'audio/mpeg');
  assert.equal(R.importType({ name: 'clip.mov', type: 'video/quicktime' }), null);
  for (const accepted of ['.m4a', 'audio/x-m4a', 'audio/mp4', 'audio/*']) assert.ok(R.ACCEPT.split(',').includes(accepted), accepted);
  assert.deepEqual(plain({ partBytes: R.LIMITS.partBytes, partMs: R.LIMITS.partMs, uploadBytes: R.LIMITS.uploadBytes, bitsPerSecond: R.LIMITS.bitsPerSecond, timesliceMs: R.LIMITS.timesliceMs }), { partBytes: 20 * 1024 * 1024, partMs: 20 * 60 * 1000, uploadBytes: 24 * 1024 * 1024, bitsPerSecond: 48000, timesliceMs: 1000 });
});

test('recording saves one chunk per second to the device at about 48 kbps, holds a wake lock, and Finish closes the part', async () => {
  const { clock, media, store, recorder } = rig(), walk = session();
  await recorder.begin(walk);
  assert.equal(media.devices.calls, 1); assert.deepEqual(plain(media.devices.constraints), { audio: true });
  const [first] = media.recorders;
  assert.deepEqual(plain(first.options), { mimeType: 'audio/mp4', audioBitsPerSecond: 48000 }); assert.equal(first.timeslice, 1000);
  await settle();
  assert.equal(media.wake.requests, 1); assert.equal(recorder.status().wake, 'on');
  await clock.advance(3000);
  const part = (await saved(store, walk.id)).parts[0];
  assert.deepEqual({ index: part.index, state: part.state, mimeType: part.mimeType, extension: part.extension, source: part.source }, { index: 1, state: 'recording', mimeType: 'audio/mp4', extension: 'm4a', source: 'recorder' });
  const chunks = await store.chunks(part.id);
  assert.deepEqual(plain(chunks.map(row => row.seq)), [1, 2, 3]); assert.ok(chunks.every(row => row.data.byteLength === 6000 && row.type === 'audio/mp4'));
  assert.equal(recorder.status().partBytes, 18000);
  await recorder.finish();
  const done = await saved(store, walk.id);
  assert.equal(done.capture, 'stopped');
  assert.deepEqual({ state: done.parts[0].state, bytes: done.parts[0].bytes, chunks: done.parts[0].chunks, reason: done.parts[0].reason, endedAt: done.parts[0].endedAt }, { state: 'closed', bytes: 18100, chunks: 4, reason: 'finish', endedAt: new Date(T0 + 3000).toISOString() });
  assert.equal((await store.chunks(part.id)).length, 4, 'the final second is saved before the part closes');
  assert.equal(media.streams[0].audio.readyState, 'ended', 'the microphone is released');
  assert.equal(media.wake.locks[0].released, true);
  assert.equal(done.actions[0].state, 'queued', 'the recorder never touches the queued Start');
});

test('parts roll over at about 20 MB and at 20 minutes: each part is its own file with its own upload request ID', async () => {
  const { clock, media, store, recorder, heartbeat } = rig({ chunkBytes: 5 * 1024 * 1024 }), walk = session();
  await recorder.begin(walk); heartbeat();
  await clock.advance(4000); // 4 x 5 MiB reaches the 20 MiB part limit
  let row = await saved(store, walk.id);
  assert.equal(media.recorders.length, 2, 'a new recorder starts the next part');
  assert.equal(media.devices.calls, 1, 'the same microphone stream continues');
  assert.deepEqual(row.parts.map(part => [part.index, part.state, part.reason]), [[1, 'closed', 'size'], [2, 'recording', null]]);
  assert.ok(row.parts[0].bytes >= 20 * 1024 * 1024 && row.parts[0].bytes < 24 * 1024 * 1024, 'the closed part stays under the 24 MB upload cap');
  assert.notEqual(row.parts[0].requestId, row.parts[1].requestId);
  // Time roll-over, with small chunks: a quiet 48 kbps walkthrough reaches 20 minutes long before 20 MB.
  const slow = rig({ chunkBytes: 6000 }), long = session();
  await slow.recorder.begin(long); slow.heartbeat();
  await slow.clock.advance(20 * 60 * 1000 - 1000);
  assert.equal(slow.media.recorders.length, 1);
  await slow.clock.advance(1000);
  row = await saved(slow.store, long.id);
  assert.deepEqual(row.parts.map(part => [part.index, part.state, part.reason]), [[1, 'closed', 'time'], [2, 'recording', null]]);
  assert.equal(row.parts[0].startedAt, new Date(T0).toISOString()); assert.equal(row.parts[1].startedAt, new Date(T0 + 20 * 60 * 1000).toISOString());
  assert.ok(row.parts[0].bytes < 8 * 1024 * 1024);
});

test('a quiet recorder is asked for its data, and a stalled one continues in a new part with a warning', async () => {
  const { clock, media, store, recorder, heartbeat } = rig(), walk = session();
  await recorder.begin(walk); heartbeat();
  clock.clearInterval(media.recorders[0].timer); // WebKit stopped delivering data
  await clock.advance(3000);
  assert.equal(media.recorders[0].requested, 1, 'nudged with requestData after three quiet seconds');
  await clock.advance(12000);
  const row = await saved(store, walk.id);
  assert.equal(media.recorders.length, 2);
  assert.equal(recorder.status().problem.code, 'stalled');
  assert.deepEqual(row.interruptions.map(item => item.kind), ['stalled']);
  assert.deepEqual(row.parts.map(part => [part.index, part.state, part.reason]), [[1, 'closed', 'interrupted'], [2, 'recording', null]]);
});

test('screen lock or backgrounding warns and records on in a new part; a blip keeps the part; a lost microphone is re-opened or waits for Resume', async () => {
  const { clock, media, store, recorder, heartbeat } = rig(), walk = session();
  await recorder.begin(walk); heartbeat();
  await clock.advance(5000);
  recorder.visibility(true); await clock.advance(60000); recorder.visibility(false); await settle();
  let row = await saved(store, walk.id);
  assert.equal(media.recorders.length, 2, 'resume starts a new part');
  assert.deepEqual(plain(recorder.status().problem), { code: 'resumed', at: T0 + 65000, away: 60000 });
  assert.deepEqual(row.interruptions.map(item => item.kind), ['hidden', 'resumed']); assert.equal(row.interruptions[1].awayMs, 60000);
  assert.equal(media.wake.requests, 2, 'the wake lock is taken again on return');
  recorder.visibility(true); await clock.advance(1000); recorder.visibility(false); await settle();
  assert.equal(media.recorders.length, 2, 'a one-second blip with a healthy recorder keeps the part');
  // The microphone track ends (a phone call, Siri): the part closes and a new stream starts the next one.
  media.streams[0].audio.end(); await settle();
  assert.equal(media.devices.calls, 2); assert.equal(media.recorders.length, 3);
  assert.equal(recorder.status().problem.code, 'track_ended');
  // It ends again and the microphone is now refused: the walkthrough waits for Resume.
  media.devices.fail = 'NotAllowedError'; media.streams[1].audio.end(); await settle();
  assert.equal(recorder.status().capture, 'interrupted'); assert.equal(recorder.status().problem.code, 'RECORDER_MIC_DENIED');
  media.devices.fail = null;
  await recorder.resume();
  assert.equal(recorder.status().capture, 'recording'); assert.equal(media.recorders.length, 4);
  row = await saved(store, walk.id);
  assert.deepEqual(row.parts.map(part => part.index), [1, 2, 3, 4]);
  assert.ok(row.parts.slice(0, 3).every(part => part.state === 'closed' && part.bytes > 0));
});

test('Finish while a lost microphone is being re-opened ends the walkthrough: no part starts afterwards', async () => {
  const { clock, media, store, recorder } = rig(), walk = session();
  await recorder.begin(walk); await clock.advance(2000);
  let grant;
  media.devices.hold = new Promise(resolve => { grant = resolve; });
  media.streams[0].audio.end(); await settle();
  assert.equal(media.devices.calls, 2, 'the new microphone request is pending');
  await recorder.finish();
  grant(); await settle();
  assert.equal(media.recorders.length, 1, 'no recorder starts after Finish');
  assert.equal(media.streams[1].audio.readyState, 'ended', 'the late microphone stream is released');
  const row = await saved(store, walk.id);
  assert.equal(row.capture, 'stopped');
  assert.deepEqual(row.parts.map(part => [part.index, part.state, part.reason]), [[1, 'closed', 'interrupted']]);
});

test('a page closed mid-recording keeps its saved audio: the next load closes that part from the stored chunks', async () => {
  const store = R.memoryStore(), first = rig({ store }), walk = session();
  await first.recorder.begin(walk);
  await first.clock.advance(2000);
  // The page is gone: a new recorder adopts the saved session.
  const second = rig({ store });
  const restored = await second.recorder.recover((await store.sessions()).find(row => row.id === walk.id));
  const row = await saved(store, walk.id);
  assert.equal(row.capture, 'interrupted'); assert.equal(second.recorder.status().problem.code, 'page_closed');
  assert.deepEqual({ state: row.parts[0].state, bytes: row.parts[0].bytes, chunks: row.parts[0].chunks, reason: row.parts[0].reason, endedAt: row.parts[0].endedAt }, { state: 'closed', bytes: 12000, chunks: 2, reason: 'page_closed', endedAt: new Date(T0 + 2000).toISOString() });
  assert.equal(restored.id, walk.id);
  await second.recorder.resume();
  assert.deepEqual((await saved(store, walk.id)).parts.map(part => [part.index, part.state]), [[1, 'closed'], [2, 'recording']]);
});

test('a refused or missing microphone is reported without saving anything; withdrawn consent deletes the audio', async () => {
  const denied = rig();
  denied.media.devices.fail = 'NotAllowedError';
  await assert.rejects(denied.recorder.begin(session()), error => error.code === 'RECORDER_MIC_DENIED' && /Allow the microphone/.test(error.message));
  assert.equal((await denied.store.sessions()).length, 0);
  const busy = rig();
  busy.media.devices.fail = 'NotReadableError';
  await assert.rejects(busy.recorder.begin(session()), error => error.code === 'RECORDER_MIC_UNAVAILABLE');
  const clock = fakeClock(), none = R.createRecorder({ store: R.memoryStore(), media: () => ({ getUserMedia: async () => ({}) }), Recorder: () => undefined, now: clock.now, timers: clock, uuid: id });
  await assert.rejects(none.begin(session()), error => error.code === 'RECORDER_UNSUPPORTED');
  const { clock: time, store, recorder } = rig(), walk = session();
  await recorder.begin(walk); await time.advance(3000);
  const partId = (await saved(store, walk.id)).parts[0].id;
  await recorder.discard();
  const row = await saved(store, walk.id);
  assert.deepEqual({ consent: row.consent, capture: row.capture, parts: row.parts }, { consent: 'declined', capture: 'none', parts: [] });
  assert.equal((await store.chunks(partId)).length, 0, 'no audio stays on the iPad');
});

// A FUN-05 stand-in: revisions, request receipts with fingerprints, and outcomes (the real handler drives the recorder in
// the 'real FUN-05' tests below, which pin this contract). Like FUN-05 with
// EGC_OFFLINE_CLOCK_ENABLED unset, the timecard refuses a Start whose device time is over two minutes older than
// the server clock (409 walkthrough_visit_time_invalid, details.deviceTime) unless it skips the timecard.
function visitServer({ now = () => T0, offlineClock = false } = {}) {
  let revision = 1;
  const visit = { id: 'w1', revision: 'r1', walkthroughVisit: null, walkthroughOutcome: null, rebookPending: false };
  const receipts = new Map(), calls = [], once = [];
  const server = {
    calls, receipts, visit, offline: false, enabled: true, stateError: null,
    posts: () => calls.filter(call => call.post).map(call => call.post),
    next(fn) { once.push(fn); },
    async state(visitId) {
      calls.push({ get: visitId });
      if (server.offline) throw fail('No connection.', 0, 'RECORDER_NETWORK');
      if (server.stateError) throw server.stateError;
      // Switched off, FUN-05 answers only that, without reading the visit.
      if (!server.enabled) return { ok: true, enabled: false };
      const record = visitId === visit.id ? visit : { id: visitId, revision: 'r1', walkthroughVisit: null, walkthroughOutcome: null, rebookPending: false };
      return { ok: true, enabled: server.enabled, visit: structuredClone(record) };
    },
    async post(body) {
      calls.push({ post: structuredClone(body) });
      const hook = once.shift();
      if (hook) { const outcome = await hook(body, server); if (outcome) return outcome; }
      if (server.offline) throw fail('No connection.', 0, 'RECORDER_NETWORK');
      return server.apply(body);
    },
    apply(body) {
      const receipt = receipts.get(body.requestId);
      if (receipt) { if (JSON.stringify(receipt) !== JSON.stringify(body)) throw fail('reused', 409, 'walkthrough_visit_idempotency_conflict'); return { ok: true, requestId: body.requestId, replayed: true, visit: structuredClone(visit) }; }
      if (body.expectedRevision !== visit.revision) throw fail('This walkthrough changed.', 409, 'walkthrough_visit_revision_conflict');
      if (body.action === 'start' && !body.skipTimecard && !offlineClock && Date.parse(body.deviceAt) < now() - 2 * 60 * 1000) throw fail('Offline clock times are not enabled for this timecard. You can also record this walkthrough without changing your timecard.', 409, 'walkthrough_visit_time_invalid', { details: { timecard: true, deviceTime: true } });
      if (body.action === 'start') visit.walkthroughVisit = { startedAt: body.deviceAt, startedBy: body.actorId.toLowerCase(), recordingStatus: body.recordingStatus };
      else visit.walkthroughOutcome = { outcome: body.outcome || 'customer_no_show', recordingStatus: body.recordingStatus ?? null, finishedAt: body.deviceAt };
      visit.revision = `r${++revision}`; receipts.set(body.requestId, structuredClone(body));
      return { ok: true, requestId: body.requestId, replayed: false, visit: structuredClone(visit) };
    },
  };
  return server;
}
function audioService() {
  const calls = [], saved = new Map();
  const service = {
    calls, saved, mode: 'ok',
    async upload(request, progress) {
      const bytes = new Uint8Array(await request.blob.arrayBuffer());
      calls.push({ requestId: request.requestId, visitId: request.visitId, filename: request.filename, type: request.blob.type, size: request.blob.size, first: bytes[0], last: bytes.at(-1) });
      progress(0.5);
      if (service.mode === 'offline') throw fail('The upload did not finish.', 0, 'RECORDER_NETWORK');
      if (service.mode === 'refused') throw fail('This visit needs an exact customer link.', 409, 'recording_customer_link_missing');
      if (service.mode === 'signature') throw fail('The recording service could not verify this upload.', 401, 'invalid_recording_signature');
      const existing = saved.get(request.requestId);
      if (!existing) saved.set(request.requestId, { size: request.blob.size, recordingId: id() });
      if (service.mode === 'lost_reply') { service.mode = 'ok'; throw fail('The upload did not finish.', 0, 'RECORDER_NETWORK'); }
      progress(1);
      return { recordingId: saved.get(request.requestId).recordingId, alreadySaved: Boolean(existing) };
    },
  };
  return service;
}
const finishAction = intent => ({ id: id(), kind: 'finish', intent, requestId: null, body: null, state: 'queued', error: null, attempts: 0, serverFailures: 0, rebases: 0 });
const finishWith = (store, sessionId, intent) => R.saveChange(store, sessionId, row => { row.actions.push(finishAction(intent)); row.status = 'finished'; });

test('lost connection: a recorded walkthrough stays on the iPad, then sends Start, Finish and its parts in order with the same request IDs', async () => {
  // With EGC_OFFLINE_CLOCK_ENABLED=true the timecard takes the offline Start time; the default refusal is covered below.
  const { clock, media, store, recorder, heartbeat } = rig({ chunkBytes: 6000 }), walk = session(), server = visitServer({ now: clock.now, offlineClock: true }), audio = audioService();
  const sync = R.createSync({ store, visit: server, upload: audio.upload, now: clock.now, uuid: id, user: () => 'sales.rep' });
  server.offline = true; audio.mode = 'offline';
  await recorder.begin(walk); heartbeat();
  await R.saveChange(store, walk.id, row => { row.status = 'active'; });
  let result = await sync.run();
  assert.equal(result.stopped.reason, 'network');
  assert.equal(server.posts().length, 0, 'nothing is sent without a confirmed visit revision');
  assert.equal((await saved(store, walk.id)).actions[0].body, null);
  await clock.advance(20 * 60 * 1000 + 5000); // a 20 minute part closes; the second keeps recording
  await recorder.finish();
  const finishedAt = new Date(clock.now()).toISOString();
  await finishWith(store, walk.id, { outcome: 'quote_to_follow', recordingStatus: 'recorded', deviceAt: finishedAt });
  result = await sync.run();
  assert.equal(result.stopped.reason, 'network'); assert.equal(audio.calls.length, 0);
  const parts = (await saved(store, walk.id)).parts;
  assert.deepEqual(parts.map(part => [part.index, part.state, part.reason]), [[1, 'closed', 'time'], [2, 'closed', 'finish']]);
  for (const part of parts) assert.ok((await store.chunks(part.id)).length > 0, 'the audio is still on the iPad');
  // The signal returns for the visit API, but the first upload is cut off mid-way.
  server.offline = false;
  result = await sync.run();
  assert.equal(result.stopped.reason, 'network');
  assert.deepEqual(server.posts().map(body => [body.action, body.expectedRevision, body.deviceAt]), [['start', 'r1', new Date(T0).toISOString()], ['finish', 'r2', finishedAt]]);
  assert.equal(server.posts()[1].recordingStatus, 'recorded'); assert.equal('typedNotes' in server.posts()[1], false);
  assert.deepEqual(audio.calls.map(call => call.requestId), [parts[0].requestId]);
  assert.equal((await saved(store, walk.id)).parts[0].attempts, 1);
  audio.mode = 'lost_reply'; // the server keeps part 1 but the reply is lost
  result = await sync.run();
  assert.equal(result.stopped.reason, 'network');
  audio.mode = 'ok';
  result = await sync.run();
  assert.equal(result.stopped, null);
  assert.deepEqual(audio.calls.map(call => call.requestId), [parts[0].requestId, parts[0].requestId, parts[0].requestId, parts[1].requestId], 'every retry of a part keeps its request ID, and parts go in order');
  assert.equal(audio.saved.size, 2, 'the service stored each part once');
  assert.deepEqual(audio.calls.map(call => call.filename), [1, 1, 1, 2].map(index => `walkthrough-w1-part-${index}.m4a`));
  assert.ok(audio.calls.every(call => call.type === 'audio/mp4' && call.visitId === 'w1'));
  assert.equal(audio.calls[0].size, parts[0].bytes); assert.equal(audio.calls[3].size, parts[1].bytes);
  assert.deepEqual([audio.calls[0].first, audio.calls[3].first], [1, 2], 'each part is its own recorder file');
  for (const part of parts) assert.equal((await store.chunks(part.id)).length, 0, 'audio leaves the iPad after the server confirmed it');
  assert.equal((await store.sessions()).length, 0, 'a fully sent walkthrough is cleared from the iPad');
  assert.equal(server.receipts.size, 2, 'Start and Finish were each saved once');
  assert.equal(media.recorders.length, 2);
});

test('a lost Start reply is resent unchanged and replays; the body is saved before it is first sent', async () => {
  const store = R.memoryStore(), server = visitServer(), clock = fakeClock(), walk = session({ status: 'active', capture: 'none', consent: 'declined' });
  await store.putSession(walk);
  let seen = null;
  server.next(async (body, s) => { seen = plain((await store.sessions())[0].actions[0].body); s.apply(body); throw fail('The reply was cut off.', 0, 'RECORDER_NETWORK'); });
  const sync = R.createSync({ store, visit: server, upload: async () => { throw new Error('no audio for a declined walkthrough'); }, now: clock.now, uuid: id, user: () => 'Sales.Rep' });
  assert.equal((await sync.run()).stopped.reason, 'network');
  assert.deepEqual(seen, server.posts()[0], 'the exact request was on the iPad before the server saw it');
  assert.equal((await sync.run()).stopped, null);
  const [first, second] = server.posts();
  assert.deepEqual(second, first); assert.equal(server.receipts.size, 1);
  assert.equal((await saved(store, walk.id)).actions[0].state, 'done');
});

test('a declined walkthrough never uploads audio and sends the typed notes with its outcome', async () => {
  const store = R.memoryStore(), server = visitServer(), audio = audioService(), clock = fakeClock();
  const walk = session({ status: 'active', capture: 'none', consent: 'declined', parts: [{ id: id(), index: 1, requestId: id(), mimeType: 'audio/mp4', extension: 'm4a', source: 'import', state: 'closed', bytes: 10 }] });
  walk.actions[0].intent.recordingStatus = 'declined';
  await store.putSession(walk);
  await store.putChunk({ id: `${walk.parts[0].id}|0000001`, partId: walk.parts[0].id, seq: 1, bytes: 10, data: new ArrayBuffer(10) });
  const notes = ['Synthetic: wants a two-car garage back', 'Synthetic: keep the workbench, donate the bikes', 'Synthetic: side gate code from the office'];
  await finishWith(store, walk.id, { outcome: 'quote_to_follow', recordingStatus: 'declined', deviceAt: new Date(T0 + 3600000).toISOString(), typedNotes: notes });
  const sync = R.createSync({ store, visit: server, upload: audio.upload, now: clock.now, uuid: id, user: () => 'sales.rep' });
  assert.equal((await sync.run()).stopped, null);
  assert.equal(audio.calls.length, 0, 'nothing is uploaded for a customer who declined');
  assert.deepEqual(server.posts().map(body => [body.action, body.recordingStatus]), [['start', 'declined'], ['finish', 'declined']]);
  assert.deepEqual(server.posts()[1].typedNotes, notes);
  assert.equal((await store.sessions()).length, 0);
});

test('a stale revision is rebuilt under a new request ID; timecard refusals wait for the rep; server errors resend the same request', async () => {
  const store = R.memoryStore(), server = visitServer(), clock = fakeClock(), walk = session({ status: 'active', capture: 'none', consent: 'declined' });
  await store.putSession(walk);
  const sync = R.createSync({ store, visit: server, upload: async () => ({ recordingId: id() }), now: clock.now, uuid: id, user: () => 'sales.rep' });
  server.visit.revision = 'r1'; server.next(() => { server.visit.revision = 'r7'; throw fail('This walkthrough changed.', 409, 'walkthrough_visit_revision_conflict'); });
  assert.equal((await sync.run()).stopped, null);
  const [stale, rebuilt] = server.posts();
  assert.notEqual(stale.requestId, rebuilt.requestId); assert.equal(stale.expectedRevision, 'r1'); assert.equal(rebuilt.expectedRevision, 'r7');
  assert.equal((await saved(store, walk.id)).actions[0].rebases, 1);
  // A clock-in refusal waits for the rep, then Start without timecard sends a new request.
  const next = session({ status: 'active', capture: 'none', consent: 'declined', visitId: 'w1' });
  server.visit.walkthroughVisit = null; await store.putSession(next);
  server.next(() => { throw fail('Clock in first.', 409, 'walkthrough_visit_clock_in_required', { details: { clockInRequired: true } }); });
  assert.equal((await sync.run()).stopped, null);
  let action = (await saved(store, next.id)).actions[0];
  assert.deepEqual({ state: action.state, code: action.error.code, kind: action.error.kind, details: action.error.details }, { state: 'error', code: 'walkthrough_visit_clock_in_required', kind: 'rejected', details: { clockInRequired: true } });
  const refused = server.posts().at(-1);
  await sync.run();
  assert.equal(server.posts().at(-1).requestId, refused.requestId, 'nothing is resent until the rep decides');
  await R.saveChange(store, next.id, row => { Object.assign(row.actions[0], { intent: { ...row.actions[0].intent, skipTimecard: true }, body: null, requestId: null, state: 'queued', error: null }); });
  assert.equal((await sync.run()).stopped, null);
  assert.equal(server.posts().at(-1).skipTimecard, true); assert.notEqual(server.posts().at(-1).requestId, refused.requestId);
  // An unknown server outcome is resent with the same request, up to the retry limit.
  const third = session({ status: 'active', capture: 'none', consent: 'declined' });
  server.visit.walkthroughVisit = null; await store.putSession(third);
  for (let i = 0; i < 5; i++) server.next(() => { throw fail('Retry the same request.', 503, 'walkthrough_visit_outcome_unknown'); });
  for (let i = 0; i < 4; i++) assert.equal((await sync.run()).stopped.reason, 'transient');
  assert.equal((await sync.run()).stopped, null);
  action = (await saved(store, third.id)).actions[0];
  assert.deepEqual({ state: action.state, kind: action.error.kind, serverFailures: action.serverFailures }, { state: 'error', kind: 'transient', serverFailures: 5 });
  assert.equal(new Set(server.posts().slice(-5).map(body => body.requestId)).size, 1, 'one request ID across the retries');
});

test('an outcome recorded elsewhere or a Start the rep already made is reconciled from the visit, not sent twice', async () => {
  const store = R.memoryStore(), server = visitServer(), clock = fakeClock();
  const sync = R.createSync({ store, visit: server, upload: async () => ({ recordingId: id() }), now: clock.now, uuid: id, user: () => 'sales.rep' });
  server.visit.walkthroughVisit = { startedAt: new Date(T0).toISOString(), startedBy: 'sales.rep' };
  const walk = session({ status: 'active', capture: 'none', consent: 'declined' });
  await store.putSession(walk);
  await sync.run();
  const start = (await saved(store, walk.id)).actions[0];
  assert.deepEqual([start.state, start.note], ['done', 'applied_elsewhere']); assert.equal(server.posts().length, 0);
  server.visit.walkthroughOutcome = { outcome: 'quote_to_follow' };
  await finishWith(store, walk.id, { outcome: 'not_interested', reasonCode: 'price', recordingStatus: 'declined', deviceAt: new Date(T0).toISOString() });
  await sync.run();
  const finish = (await saved(store, walk.id)).actions[1];
  assert.equal(finish.state, 'error'); assert.equal(finish.error.code, 'walkthrough_visit_closed'); assert.match(finish.error.message, /quote to follow/);
  assert.equal(server.posts().length, 0);
  assert.equal(R.applicable({ kind: 'start' }, { walkthroughVisit: { startedBy: 'Other.Rep' } }, 'sales.rep').code, 'walkthrough_visit_already_started');
  assert.equal(R.applicable({ kind: 'start' }, { walkthroughOutcome: { outcome: 'customer_no_show' }, rebookPending: true, walkthroughVisit: { startedBy: 'x' } }, 'sales.rep'), true, 'a rebooked visit starts again');
  assert.equal(R.applicable({ kind: 'finish' }, { walkthroughVisit: null }, 'sales.rep').code, 'walkthrough_visit_not_started');
  assert.equal(R.applicable({ kind: 'no_show' }, { walkthroughVisit: null }, 'sales.rep'), true);
});

test('a refused upload keeps the audio for Retry or Save a copy; another employee\'s walkthroughs are never sent', async () => {
  const store = R.memoryStore(), server = visitServer(), audio = audioService(), clock = fakeClock();
  const partId = id(), walk = session({ status: 'finished', capture: 'stopped', parts: [{ id: partId, index: 1, requestId: id(), mimeType: 'audio/mp4', extension: 'm4a', source: 'recorder', state: 'closed', bytes: 4 }] });
  walk.actions = [];
  await store.putSession(walk);
  await store.putChunk({ id: `${partId}|0000001`, partId, seq: 1, bytes: 4, data: new Uint8Array([1, 2, 3, 4]).buffer });
  const other = session({ user: 'Other.Rep', status: 'finished', capture: 'none', consent: 'declined' });
  await store.putSession(other);
  audio.mode = 'refused';
  const sync = R.createSync({ store, visit: server, upload: audio.upload, now: clock.now, uuid: id, user: () => 'Sales.Rep' });
  assert.equal((await sync.run()).stopped, null);
  const part = (await saved(store, walk.id)).parts[0];
  assert.deepEqual({ state: part.state, code: part.error.code }, { state: 'error', code: 'recording_customer_link_missing' });
  assert.equal((await store.chunks(partId)).length, 1, 'refused audio stays on the iPad');
  assert.ok(await saved(store, other.id), 'another employee\'s walkthrough waits for them');
  assert.equal(server.posts().length, 0);
});

test('writers never undo each other: the recorder keeps its fields, the sync writes only its own row, the page keeps its edits', async () => {
  // Updated deliberately (third review): the recorder writes only while its tab holds the walkthrough (owner), so the
  // fixture names the recorder as the holder; the assertions are unchanged.
  const store = R.memoryStore(), walk = session({ status: 'active', owner: { tab: 'recorder', at: new Date(T0).toISOString() }, parts: [{ id: 'p1', index: 1, source: 'recorder', state: 'recording', bytes: 0 }] });
  walk.actions.push({ id: 'no-show-1', kind: 'no_show', state: 'error', error: { code: 'walkthrough_visit_time_invalid' } });
  await store.putSession(walk);
  const recorderCopy = plain(walk), syncCopy = plain(walk);
  await R.saveChange(store, walk.id, row => { row.actions.push({ id: 'finish-1', kind: 'finish', state: 'queued' }); row.status = 'finished'; Object.assign(row.actions[1], { state: 'queued', error: null }); });
  syncCopy.actions[0].state = 'done'; syncCopy.actions[0].body = { requestId: 'frozen' };
  await R.saveRow(store, walk.id, 'actions', syncCopy.actions[0], { visit: { id: 'w1', revision: 'r2' } });
  recorderCopy.parts = [{ ...recorderCopy.parts[0], state: 'closed', bytes: 50 }, { id: 'p2', index: 2, source: 'recorder', state: 'recording', bytes: 0 }]; recorderCopy.capture = 'recording';
  await R.saveAs(store, 'recorder', recorderCopy);
  let row = await saved(store, walk.id);
  assert.deepEqual(row.actions.map(action => [action.kind, action.state]), [['start', 'done'], ['no_show', 'queued'], ['finish', 'queued']], 'the sync\'s stale copy of the other rows did not undo the page\'s retry');
  assert.equal(row.actions[0].body.requestId, 'frozen'); assert.equal(row.status, 'finished'); assert.equal(row.visit.revision, 'r2');
  assert.deepEqual(row.parts.map(part => [part.id, part.state]), [['p1', 'closed'], ['p2', 'recording']]);
  // A part the sync already sent stays sent when a late recorder write arrives.
  await R.saveRow(store, walk.id, 'parts', { ...row.parts[0], state: 'uploaded', recordingId: 'recording-1' });
  await R.saveAs(store, 'recorder', recorderCopy);
  row = await saved(store, walk.id);
  assert.deepEqual(row.parts.map(part => [part.id, part.state, part.recordingId || null]), [['p1', 'uploaded', 'recording-1'], ['p2', 'recording', null]]);
  await store.removeSession(walk.id);
  assert.equal(await R.saveRow(store, walk.id, 'actions', syncCopy.actions[0]), null, 'the sync never brings back a cleared walkthrough');
  assert.equal((await store.sessions()).length, 0);
});

test('device storage falls back to page memory when IndexedDB is refused, and reads merge both', async () => {
  const refused = () => Promise.reject(Object.assign(new Error('refused'), { code: 'RECORDER_STORAGE_UNAVAILABLE' }));
  const primary = { sessions: refused, putSession: refused, removeSession: refused, putChunk: refused, chunks: refused, removeChunks: refused };
  const store = R.deviceStore(primary, R.memoryStore());
  assert.equal(store.persistent, true);
  await store.putSession({ id: 's1', user: 'sales.rep' });
  await store.putChunk({ id: 'p1|0000001', partId: 'p1', seq: 1, bytes: 3, data: new ArrayBuffer(3) });
  assert.equal(store.persistent, false, 'the page warns that closing it would lose the audio');
  assert.deepEqual(plain((await store.sessions()).map(row => row.id)), ['s1']);
  assert.equal((await store.chunks('p1')).length, 1);
  const idb = R.idbStore(undefined, undefined);
  await assert.rejects(idb.sessions(), error => error.code === 'RECORDER_STORAGE_UNAVAILABLE');
});

test('the upload transport posts multipart with the part request ID and reports progress; lost, refused and expired replies differ', async () => {
  const sent = [];
  class FakeXHR {
    constructor() { this.upload = {}; sent.push(this); }
    open(method, url, async) { Object.assign(this, { method, url, async }); }
    send(form) { this.form = form; }
    reply(status, body) { this.status = status; this.responseText = body; this.onload(); }
  }
  const upload = R.xhrUpload(FakeXHR), progress = [];
  const blob = new Blob([new Uint8Array(12)], { type: 'audio/mp4' }), request = { requestId: id(), visitId: 'w1', blob, filename: 'walkthrough-w1-part-1.m4a' };
  const ok = upload(request, value => progress.push(value));
  const [xhr] = sent;
  assert.deepEqual([xhr.method, xhr.url, xhr.async, xhr.timeout], ['POST', '/api/operations-recordings', true, 600000]);
  assert.equal(xhr.form.get('requestId'), request.requestId); assert.equal(xhr.form.get('portalJobId'), 'w1');
  const file = xhr.form.get('audio');
  assert.deepEqual([file.name, file.type, file.size], ['walkthrough-w1-part-1.m4a', 'audio/mp4', 12]);
  xhr.upload.onprogress({ lengthComputable: true, loaded: 6, total: 12 });
  xhr.reply(202, JSON.stringify({ ok: true, alreadySaved: true, recording: { id: 'recording-1', status: 'uploaded' } }));
  assert.deepEqual(plain(await ok), { recordingId: 'recording-1', alreadySaved: true });
  assert.deepEqual(progress, [0.5, 1]);
  const outcome = async (status, body) => { const pending = upload(request); sent.at(-1).reply(status, body); return pending.then(() => null, error => ({ status: error.status, code: error.code, message: error.message })); };
  assert.deepEqual(await outcome(202, ''), { status: 0, code: 'RECORDER_NETWORK', message: 'The upload did not finish. The audio stays on this iPad and is sent again with the same upload ID.' });
  assert.equal((await outcome(409, JSON.stringify({ error: 'recording_customer_link_missing' }))).status, 409);
  const expired = await outcome(403, JSON.stringify({ error: 'business_session_required' }));
  assert.equal(expired.status, 401, 'an expired Hub session waits for sign-in'); assert.equal(R.classify(expired), 'auth');
  // An upstream signature refusal relayed as 401 is not the rep's sign-in: it is a refusal with its code.
  const signature = await outcome(401, JSON.stringify({ error: 'invalid_recording_signature' }));
  assert.deepEqual([signature.status, signature.code, R.classify(signature)], [401, 'invalid_recording_signature', 'rejected']); assert.match(signature.message, /not your sign-in/);
  assert.equal((await outcome(503, JSON.stringify({ error: 'recording_unavailable', retryable: true }))).status, 503);
  const dropped = upload(request); sent.at(-1).onerror();
  await assert.rejects(dropped, error => error.status === 0);
  // Updated deliberately: a 401 waits for sign-in only with a Hub sign-in code; a bare or upstream 401 is a refusal.
  assert.deepEqual(['network', 'auth', 'auth', 'auth', 'rejected', 'rejected', 'transient', 'transient', 'rejected', 'rejected'],
    [fail('', 0), fail('', 401, 'HUB_AUTH_REQUIRED'), fail('', 401, 'business_session_required'), fail('', 401, 'walkthrough_visit_sign_in_required'), fail('', 401, 'recording_signature_expired'), fail('', 401), fail('', 503), fail('', 429), fail('', 409), fail('', 503, 'walkthrough_visit_time_unavailable')].map(R.classify));
});

test('the visit transport maps an expired Hub session to sign-in, a cut-off reply to a retry and a refusal to its code', async () => {
  const reply = (status, body, broken = false) => async () => ({ ok: status < 400, status, json: async () => { if (broken) throw new SyntaxError('cut'); return body; } });
  const call = fetch => R.httpVisit(fetch).post({ action: 'start' }).then(() => null, error => ({ status: error.status, code: error.code, details: error.details ?? null }));
  assert.deepEqual(await call(async () => { throw Object.assign(new Error('Your Hub session expired.'), { code: 'HUB_AUTH_REQUIRED' }); }), { status: 401, code: 'HUB_AUTH_REQUIRED', details: null });
  assert.deepEqual(await call(async () => { throw new TypeError('Failed to fetch'); }), { status: 0, code: 'RECORDER_NETWORK', details: null });
  assert.deepEqual(await call(reply(200, null, true)), { status: 0, code: 'RECORDER_NETWORK', details: null });
  assert.deepEqual(plain(await call(reply(409, { ok: false, code: 'walkthrough_visit_outcome_required', error: 'Record the outcome first.', details: { visitId: 'w0' } }))), { status: 409, code: 'walkthrough_visit_outcome_required', details: { visitId: 'w0' } });
  const seen = [];
  await R.httpVisit(async (url, init) => { seen.push([url, init.method || 'GET', init.headers?.['Content-Type'] || null, init.credentials]); return reply(200, { ok: true, visit: { id: 'w 1' } })(); }).state('w 1');
  assert.deepEqual(seen, [['/api/walkthrough-visit?visitId=w%201', 'GET', null, 'same-origin']]);
});

test('an offline Start the timecard refuses waits for the rep, and the choice survives an upload in flight; then Start and Finish go out', async () => {
  const clock = fakeClock(T0 + 30 * 60 * 1000), store = R.memoryStore(), server = visitServer({ now: clock.now }), audio = audioService();
  const partId = id(), walk = session({ status: 'finished', capture: 'stopped', outcome: 'quote_to_follow', parts: [{ id: partId, index: 1, requestId: id(), mimeType: 'audio/mp4', extension: 'm4a', source: 'recorder', state: 'closed', bytes: 4 }] });
  walk.actions.push(finishAction({ outcome: 'quote_to_follow', recordingStatus: 'recorded', deviceAt: new Date(T0 + 25 * 60 * 1000).toISOString() }));
  await store.putSession(walk);
  await store.putChunk({ id: `${partId}|0000001`, partId, seq: 1, bytes: 4, data: new Uint8Array([1, 2, 3, 4]).buffer });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const sync = R.createSync({ store, visit: server, upload: async (request, progress) => { await held; return audio.upload(request, progress); }, now: clock.now, uuid: id, user: () => 'sales.rep' });
  const first = sync.run();
  await settle();
  let row = await saved(store, walk.id);
  assert.deepEqual({ state: row.actions[0].state, code: row.actions[0].error.code, kind: row.actions[0].error.kind, deviceTime: row.actions[0].error.details.deviceTime }, { state: 'error', code: 'walkthrough_visit_time_invalid', kind: 'rejected', deviceTime: true });
  assert.deepEqual(server.posts().map(body => body.action), ['start'], 'the Finish waits behind the refused Start');
  assert.equal(row.actions[1].state, 'queued');
  // The rep taps Start without timecard (the page's retryAction change) while part 1 is still uploading.
  await R.saveChange(store, walk.id, draft => { const item = draft.actions[0]; Object.assign(item, { intent: { ...item.intent, skipTimecard: true }, body: null, requestId: null, state: 'queued', error: null, serverFailures: 0 }); });
  release(); await first;
  row = await saved(store, walk.id);
  assert.deepEqual({ state: row.actions[0].state, skipTimecard: row.actions[0].intent.skipTimecard, part: row.parts[0].state }, { state: 'queued', skipTimecard: true, part: 'uploaded' }, 'the finished upload kept the rep\'s choice');
  assert.equal((await sync.run()).stopped, null);
  const [refused, start, finish] = server.posts();
  assert.deepEqual([start.action, start.skipTimecard, start.deviceAt, finish.action, finish.outcome], ['start', true, new Date(T0).toISOString(), 'finish', 'quote_to_follow']);
  assert.notEqual(start.requestId, refused.requestId, 'the refusal saved nothing, so the choice goes out under a new request ID');
  assert.equal(server.receipts.size, 2); assert.equal(audio.saved.size, 1);
  assert.equal((await store.sessions()).length, 0, 'the walkthrough leaves the iPad once everything is confirmed');
});

test('parts upload strictly in order: a refused part holds back the next until the rep retries it or removes it after a copy', async () => {
  const store = R.memoryStore(), audio = audioService(), clock = fakeClock();
  const parts = [1, 2].map(index => ({ id: id(), index, requestId: id(), mimeType: 'audio/mp4', extension: 'm4a', source: 'recorder', state: 'closed', bytes: 4 }));
  const walk = session({ status: 'finished', capture: 'stopped', parts });
  walk.actions = [];
  await store.putSession(walk);
  for (const part of parts) await store.putChunk({ id: `${part.id}|0000001`, partId: part.id, seq: 1, bytes: 4, data: new Uint8Array(4).fill(part.index).buffer });
  audio.mode = 'signature';
  const sync = R.createSync({ store, visit: visitServer(), upload: audio.upload, now: clock.now, uuid: id, user: () => 'sales.rep' });
  assert.equal((await sync.run()).stopped, null, 'an upstream 401 is a refusal, not a wait for sign-in');
  assert.deepEqual(audio.calls.map(call => call.filename), ['walkthrough-w1-part-1.m4a'], 'part 2 waits behind the refused part 1');
  let row = await saved(store, walk.id);
  assert.deepEqual(row.parts.map(part => [part.state, part.error?.code || null]), [['error', 'invalid_recording_signature'], ['closed', null]]);
  audio.mode = 'ok';
  await sync.run();
  assert.equal(audio.calls.length, 1, 'nothing more is sent until the rep decides');
  // The rep saved a copy of part 1 and removed it from the iPad: part 2 goes next and the walkthrough is settled.
  await R.saveChange(store, walk.id, draft => { Object.assign(draft.parts[0], { copySavedAt: new Date(T0).toISOString(), state: 'removed' }); });
  await store.removeChunks(parts[0].id);
  assert.equal((await sync.run()).stopped, null);
  assert.deepEqual(audio.calls.map(call => call.filename), ['walkthrough-w1-part-1.m4a', 'walkthrough-w1-part-2.m4a']);
  assert.equal((await store.sessions()).length, 0);
  assert.equal((await store.chunks(parts[1].id)).length, 0);
});

// The gameplan page UI on a small DOM (tests/helpers/hub-dom.mjs), with the fakes above and the injected clock.
// A second page() in the same realm is a second recorder on one page (tabStorage is the tab's sessionStorage, which a
// reload of the tab keeps; the recorder keeps nothing there). A page() in its own realm sharing a store and Web Locks is a
// second Safari tab on the same iPad: nothing in-realm is shared. locks: the Web Locks (LOCKS above by default; null for a
// Safari without them). Channel, when given, is the realm's BroadcastChannel (the recorder uses none).
// who: the signed-in employee (the Hub session); '' while the sign-in gate shows.
function page({ clock = fakeClock(), timers = clock, server = visitServer({ now: clock.now }), audio = audioService(), store = R.memoryStore(), visit = { id: 'w1', customer: 'Synthetic Customer' }, openVisit, realm, locks = LOCKS, Channel, ledger, storageManager, confirm = () => true, chunkBytes, tabStorage = storage(), localStore = storage(), who = () => 'sales.rep' } = {}) {
  const document = realm?.document || createDocument(), media = fakeMedia(timers, { chunkBytes }), events = realm?.events || {}, shown = [];
  const context = realm?.context || vm.createContext({ console, Promise, JSON, Date, Math, Map, Set, WeakMap, Error, Blob, FormData, Uint8Array, ArrayBuffer, queueMicrotask, encodeURIComponent, URL, Intl, Object, document, Node: document.Node,
    localStorage: localStore, sessionStorage: tabStorage, confirm: (...args) => confirm(...args), addEventListener: (name, fn) => { (events[name] ||= []).push(fn); }, removeEventListener() {}, ...(Channel ? { BroadcastChannel: Channel } : {}) });
  if (!realm) { context.self = context; vm.runInContext(source, context); }
  const host = document.createElement('section'), footer = document.createElement('footer');
  footer.prepend = node => footer.insertBefore(node, footer.childNodes[0] || null);
  // Every time the recorder shows itself is recorded, so a flash of a skeleton or error is caught.
  Object.defineProperty(host, 'hidden', { get: () => host.hasAttribute('hidden'), set: value => { if (!value) shown.push(host.textContent); host.toggleAttribute('hidden', Boolean(value)); } });
  document.body.append(host, footer);
  let current = visit;
  const controller = context.EGCWalkthroughRecorder.mount(host, { barHost: footer, visit: () => current, user: () => who(), visitApi: server, upload: audio.upload, store, now: clock.now, timers, uuid: id,
    media: () => media.devices, Recorder: () => media.FakeRecorder, wakeLock: () => media.wake, openVisit: openVisit && (visitId => openVisit(visitId, next => { current = next; })), locks, ledger, storageManager });
  const find = (tag, label, root) => root.querySelectorAll(tag).filter(node => node.textContent.startsWith(label));
  const flush = async () => { for (let round = 0; round < 4; round++) await clock.advance(0); };
  return { document, context, events, host, footer, controller, media, server, audio, clock, timers, store, shown, flush,
    ready: async () => { await controller.ready; await flush(); },
    show(next) { current = next; controller.check(); return flush(); },
    fire: async (name, fields = {}) => { for (const fn of events[name] || []) fn({ type: name, ...fields }); await flush(); },
    buttons: (label, root = host) => find('button', label, root),
    links: (label, root = host) => find('a', label, root),
    async tap(label, root = host) { const [node] = find('button', label, root); assert.ok(node, `no "${label}" button in: ${root.textContent}`); node.click(); await flush(); },
    text: () => host.textContent, bar: () => footer.textContent };
}

test('page: the signal returns while a send is failing for the lost connection: the online event sends at once instead of waiting for the backoff', async () => {
  const p = page();
  await p.ready();
  // The Start's send is on its way while the iPad has no signal; it fails only after the signal is back and the online event
  // has fired (the event's pass joins the one running).
  let lose;
  p.server.next(() => new Promise((resolve, reject) => { lose = () => reject(fail('No connection.', 0, 'RECORDER_NETWORK')); }));
  await p.tap('Start walkthrough'); await p.tap('Customer declined recording');
  assert.equal(p.server.posts().length, 1);
  assert.equal(typeof lose, 'function', 'the send is on its way');
  await p.fire('online');
  lose(); await p.flush();
  // Sent again at once (same request ID), with no clock time passing: no backoff.
  const posts = p.server.posts();
  assert.deepEqual(posts.map(body => body.action), ['start', 'start']);
  assert.equal(posts[1].requestId, posts[0].requestId);
  assert.equal(p.server.visit.walkthroughVisit?.recordingStatus, 'declined');
  assert.doesNotMatch(p.text() + p.bar(), /No connection/);
  // Without an online event (or any other call) meanwhile, a lost connection still waits for the backoff.
  const q = page();
  await q.ready();
  q.server.offline = true;
  await q.tap('Start walkthrough'); await q.tap('Customer declined recording');
  const tried = q.server.calls.length;
  q.server.offline = false; await q.flush();
  assert.equal(q.server.calls.length, tried, 'no pass without a call');
  await q.clock.advance(5000);
  assert.deepEqual(q.server.posts().map(body => body.action), ['start']);
  assert.equal(q.server.visit.walkthroughVisit?.recordingStatus, 'declined');
});

test('page: an offline Start the timecard refuses shows its choice on the visit card and in the bar; Start without timecard then sends Start and Finish', async () => {
  const p = page();
  await p.ready();
  p.server.offline = true;
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  assert.match(p.bar(), /Recording · 0:00 · Part 1/);
  await p.clock.advance(5 * 60 * 1000); // five minutes in a garage without signal
  assert.equal(p.server.posts().length, 0);
  p.server.offline = false;
  await p.fire('online');
  assert.deepEqual(p.server.posts().map(body => [body.action, body.deviceAt, body.skipTimecard ?? null]), [['start', new Date(T0).toISOString(), null]]);
  assert.match(p.text(), /Start needs your decision: Offline clock times are not enabled/);
  assert.equal(p.buttons('Start without timecard').length, 1, 'the choice is on the visit card');
  // Updated deliberately (second review): the bar keeps the refusal to one line, and its Decide (within thumb reach)
  // brings the card's choice into view instead of repeating it in the fixed footer.
  assert.match(p.bar(), /Start needs your decision\./);
  assert.equal(p.buttons('Start without timecard', p.footer).length, 0);
  await p.tap('Decide', p.footer);
  assert.equal(p.document.activeElement?.textContent, 'Start without timecard', 'Decide focuses the choice on the card');
  assert.equal(p.buttons('Retry', p.host.querySelector('.wt-attention')).length, 0, 'Retry would be refused again for an offline start time, so it is not offered');
  assert.match(p.text(), /Retry would be refused again: this Start was saved on the iPad while offline\. Start without timecard keeps its real start time\./);
  // The rep finishes first: the outcome waits behind the refused Start, and the card says it needs a decision.
  await p.tap('Finish', p.footer);
  assert.equal(p.buttons('Start without timecard').length, 1, 'the Finish screen keeps the choice in view');
  await p.tap('Quote to follow'); await p.tap('Save outcome');
  assert.match(p.text(), /Outcome saved on this iPad: Quote to follow\. It needs your decision before it can be sent:/);
  assert.doesNotMatch(p.text(), /sent when the signal allows/);
  assert.deepEqual(p.server.posts().map(body => body.action), ['start']);
  await p.tap('Start without timecard');
  assert.deepEqual(p.server.posts().map(body => [body.action, body.skipTimecard ?? false]), [['start', false], ['start', true], ['finish', false]]);
  assert.equal(p.server.posts()[1].deviceAt, new Date(T0).toISOString(), 'the visit keeps the real start time');
  assert.equal(p.server.posts()[2].recordingStatus, 'recorded');
  assert.match(p.text(), /Outcome recorded: Quote to follow/);
  assert.equal(p.audio.saved.size, 1); assert.equal((await p.store.sessions()).length, 0);
});

// Counts what the recorder takes from the browser: persistent storage, the tab's Web Lock and a BroadcastChannel.
function browserSpies() {
  const used = { persist: 0, locks: 0, channels: 0 };
  const storageManager = { persisted: async () => { used.persist++; return false; }, persist: async () => { used.persist++; return true; } };
  const locks = { request: () => { used.locks++; return new Promise(() => {}); }, query: async () => ({ held: [], pending: [] }) };
  class Channel { constructor() { used.channels++; } postMessage() {} close() {} }
  return { used, storageManager, locks, Channel };
}

test('page: switched off, or a visit the server cannot find, never shows the recorder (no skeleton, no load error)', async () => {
  for (const refuse of [null, fail('This walkthrough visit could not be found. Refresh your schedule.', 404, 'walkthrough_visit_not_found')]) {
    const server = visitServer(), spies = browserSpies();
    Object.assign(server, { enabled: false, stateError: refuse });
    const p = page({ server, storageManager: spies.storageManager, locks: spies.locks, Channel: spies.Channel });
    await p.ready();
    assert.ok(server.calls.some(call => call.get === 'w1'), 'the recorder asked whether it is switched on');
    assert.deepEqual(p.shown, [], `the recorder never showed itself${refuse ? ' for a 404' : ''}`);
    assert.equal(p.host.hidden, true); assert.equal(p.footer.textContent, '');
    // Behaviour-identical when switched off: no persistent-storage request (a Firefox prompt), no Web Lock or channel (both
    // keep a page out of the back/forward cache), no leave-page prompt.
    assert.deepEqual(spies.used, { persist: 0, locks: 0, channels: 0 });
    assert.equal((p.events.beforeunload || []).length, 0);
  }
});

test('page: a double tap opens a walkthrough without audio, or saves a no-show, only once; the store lock re-checks the visit', async () => {
  const p = page();
  await p.ready();
  await p.tap('Start walkthrough');
  const [declined] = p.buttons('Customer declined recording');
  declined.click(); declined.click(); // the second tap lands before IndexedDB answers
  await p.flush();
  assert.equal((await p.store.sessions()).length, 1);
  assert.deepEqual(p.server.posts().map(body => [body.action, body.recordingStatus]), [['start', 'declined']]);
  // Two recorders on one page (one realm): the store lock re-checks the visit and refuses the second walkthrough.
  const store = R.memoryStore(), server = visitServer(), left = page({ store, server }), right = page({ store, server, realm: left });
  await left.ready(); await right.ready();
  await left.tap('Start walkthrough'); await right.tap('Start walkthrough');
  left.buttons('Customer declined recording')[0].click(); right.buttons('Customer declined recording')[0].click();
  await left.flush(); await right.flush();
  assert.equal((await store.sessions()).length, 1);
  // A no-show saved twice is one no-show.
  const n = page();
  await n.ready();
  await n.tap('Customer no-show');
  const select = n.host.querySelector('select');
  select.value = 'customer_not_home'; select.dispatchEvent({ type: 'change', target: select });
  const [save] = n.buttons('Save no-show');
  save.click(); save.click();
  await n.flush();
  assert.equal((await n.store.sessions()).length, 0, 'sent and cleared');
  assert.deepEqual(n.server.posts().map(body => [body.action, body.reasonCode]), [['no_show', 'customer_not_home']]);
});

test('page: a walkthrough the server records as declined offers no audio at Finish or after its outcome', async () => {
  const server = visitServer();
  server.visit.walkthroughVisit = { startedAt: new Date(T0).toISOString(), startedBy: 'other.rep', recordingStatus: 'declined' };
  const p = page({ server });
  await p.ready();
  await p.tap('Finish walkthrough');
  const files = () => p.host.querySelectorAll('input').filter(input => input.getAttribute('type') === 'file').length;
  assert.deepEqual(p.host.querySelector('select').querySelectorAll('option').map(option => option.value), ['declined', 'failed_device'], 'Recorded is not offered');
  assert.equal(files(), 0);
  await p.tap('Not interested');
  const [reason, recording] = p.host.querySelectorAll('select');
  assert.ok(recording);
  reason.value = 'price'; reason.dispatchEvent({ type: 'change', target: reason });
  await p.tap('Save outcome');
  assert.match(p.text(), /Outcome recorded: Not interested/);
  assert.deepEqual(p.server.posts().map(body => [body.action, body.recordingStatus]), [['finish', 'declined']]);
  assert.equal(files(), 0, 'no Voice Memos upload for a declined walkthrough');
});

test('page: the bar Finish opens the walkthrough being recorded when another appointment is on screen', async () => {
  const opened = [], p = page({ openVisit: (visitId, show) => { opened.push(visitId); show({ id: visitId, customer: 'Synthetic Customer' }); return true; } });
  await p.ready();
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  await p.show({ id: 'w2', customer: 'Synthetic Neighbour' });
  assert.match(p.text(), /Finish the walkthrough for Synthetic Customer before starting this one/);
  assert.match(p.bar(), /This walkthrough is for Synthetic Customer, not the one on screen/);
  assert.equal(p.buttons('Finish', p.footer).length, 0);
  const [link] = p.links('Finish', p.footer);
  assert.equal(link.getAttribute('href'), '/crew/gameplan.html?walkthroughId=w1');
  const click = { type: 'click', prevented: false, preventDefault() { this.prevented = true; } };
  link.dispatchEvent(click); await p.flush();
  assert.deepEqual([opened, click.prevented], [['w1'], true]);
  assert.match(p.text(), /^Synthetic CustomerFinish walkthrough/, 'the Finish screen names the customer');
  assert.equal(p.controller.recorder.status().capture, 'recording', 'the recording continues until the outcome is saved');
  // Without an in-page switch the link opens that walkthrough's gameplan.
  const q = page({ openVisit: () => false });
  await q.ready();
  await q.tap('Start walkthrough'); await q.tap('Customer declined recording');
  await q.show(null); // a manual walkthrough on screen
  const other = { type: 'click', prevented: false, preventDefault() { this.prevented = true; } };
  q.links('Finish', q.footer)[0].dispatchEvent(other); await q.flush();
  assert.equal(other.prevented, false);
});

test('page: a refused part offers Save a copy, then Remove from this iPad; a sign-in wait is shown on the visit card', async () => {
  const store = R.memoryStore(), partId = id();
  const walk = session({ status: 'finished', capture: 'stopped', outcome: 'quote_to_follow', parts: [{ id: partId, index: 1, requestId: id(), mimeType: 'audio/mp4', extension: 'm4a', source: 'recorder', state: 'error', bytes: 4, error: { code: 'recording_identity_unverified', message: 'The recording service could not confirm who sent this audio. Save a copy and ask the office.', kind: 'rejected', status: 403 } }] });
  walk.actions = [];
  await store.putSession(walk);
  await store.putChunk({ id: `${partId}|0000001`, partId, seq: 1, bytes: 4, data: new Uint8Array(4).buffer });
  const p = page({ store });
  await p.ready();
  await p.tap('Unsent recordings on this iPad · 1');
  assert.match(p.text(), /could not confirm who sent this audio/);
  assert.equal(p.buttons('Remove from this iPad').length, 0, 'removal is offered only after a copy is saved');
  await p.tap('Save a copy');
  await p.tap('Remove from this iPad');
  assert.equal((await store.chunks(partId)).length, 0);
  assert.equal((await store.sessions()).length, 0, 'a removed part settles the walkthrough');
  assert.equal(p.audio.calls.length, 0, 'the refused part was never sent again');
  // An expired Hub session: the queued Start says so on the card and in the bar.
  const q = page();
  await q.ready();
  q.server.next(() => { throw fail('Your Hub session expired. Sign in again to continue.', 401, 'HUB_AUTH_REQUIRED'); });
  await q.tap('Start walkthrough'); await q.tap('Customer declined recording');
  assert.match(q.text(), /Your Hub session expired\. Sign in again to continue\. It stays on this iPad until then\./);
  assert.match(q.bar(), /Your Hub session expired/);
});

test('page: the choices for a refused part of the visit on screen show once, on its card; the open unsent list names the part and points below', async () => {
  // The outcome was sent but the visit is not read back yet, so the card shows the saved outcome with the refused part. The
  // unsent list, opened, lists the same walkthrough: before, it repeated Retry upload and Save a copy there.
  const store = R.memoryStore(), partId = id();
  const walk = session({ status: 'finished', capture: 'stopped', outcome: 'quote_to_follow', parts: [{ id: partId, index: 1, requestId: id(), mimeType: 'audio/mp4', extension: 'm4a', source: 'recorder', state: 'error', bytes: 4, error: { code: 'recording_customer_link_missing', message: 'This visit needs an exact customer link before its audio can be saved.', kind: 'rejected', status: 409 } }] });
  walk.actions = [{ ...finishAction({ outcome: 'quote_to_follow', recordingStatus: 'recorded', deviceAt: walk.startedAt }), state: 'done', requestId: id(), body: { action: 'finish' }, doneAt: walk.startedAt }];
  await store.putSession(walk);
  await store.putChunk({ id: `${partId}|0000001`, partId, seq: 1, bytes: 4, data: new Uint8Array(4).buffer });
  const p = page({ store });
  await p.ready();
  assert.match(p.text(), /Outcome saved on this iPad: Quote to follow\. It needs your decision before it can be sent:/);
  await p.tap('Unsent recordings on this iPad · 1');
  const list = p.host.querySelector('.wt-unsent-list');
  assert.match(list.textContent, /exact customer link before its audio can be saved\. Decide below\./);
  for (const label of ['Retry upload', 'Save a copy']) {
    assert.equal(p.buttons(label).length, 1, `${label}: once on the screen`);
    assert.equal(p.buttons(label, list).length, 0, `${label}: not in the list`);
  }
  await p.tap('Save a copy');
  assert.equal(p.buttons('Remove from this iPad').length, 1);
  // Another appointment on screen: the walkthrough's choices move to the strip above, and the list points there.
  await p.show({ id: 'w2', customer: 'Second Synthetic Customer' });
  assert.ok(p.host.querySelector('.wt-unsent-list'), 'the list stays open');
  assert.equal(p.buttons('Retry upload').length, 1);
  assert.ok(p.host.querySelector('.wt-decide'), p.text());
  assert.match(p.host.querySelector('.wt-unsent-list').textContent, /Decide above\./);
});

// ---- The real FUN-05 handler behind the recorder's own fetch transport (in-memory store, injected clock). ----
const SALES = { user: 'sales.rep', displayName: 'Synthetic Sales Rep', role: 'sales', businessAccess: true, source: 'employee-account' };
function fun05Fixture() {
  const rows = new Map(), calls = [];
  let n = 0;
  const put = (key, value) => rows.set(key, { ...structuredClone(value), revision: `r${++n}` });
  const walkthrough = (extra = {}) => ({ type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Fixture Lane', date: '2026-09-22', time: '09:00', endTime: '10:00', assignedCrew: ['sales.rep'], projectId: 'project_w1', ...extra });
  put('jobs/w1', walkthrough()); put('jobs/w2', walkthrough({ customer: 'Second Synthetic Customer', time: '11:00', endTime: '12:00', projectId: 'project_w2' }));
  const shiftKey = user => `jobs/secure_shift_${user.toLowerCase()}`;
  const store = {
    env: {},
    read: async (collection, docId) => { calls.push(['read', collection, docId]); const row = rows.get(`${collection}/${docId}`); return row ? structuredClone({ ...row, id: docId }) : null; },
    assigned: async (session, job) => { calls.push(['assigned']); return (job.assignedCrew || []).includes(session.user.toLowerCase()); },
    activeShift: async session => { calls.push(['activeShift']); const row = rows.get(shiftKey(session.user)); return row && row.sealed.status === 'active' && !row.sealed.clockOutAt ? { entry: structuredClone(row.sealed), documentId: shiftKey(session.user).slice(5), revision: row.revision } : null; },
    sealShift: async (documentId, data, updatedAt) => ({ sealed: structuredClone(data), updatedAt }),
    commit: async writes => {
      calls.push(['commit']);
      for (const write of writes) { const current = rows.get(`${write.collection}/${write.id}`); if (write.revision ? current?.revision !== write.revision : current) throw Object.assign(new Error('conflict'), { code: 'walkthrough_visit_revision_conflict', status: 409 }); }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...(write.revision ? rows.get(`${write.collection}/${write.id}`) : {}), ...structuredClone(write.patch), revision: `r${++n}` });
    },
  };
  const clockIn = at => put(shiftKey(SALES.user), { sealed: authorizeTimecard({ session: SALES, manager: false, id: 'shift-sales.rep', incoming: { locationTracking: true, lastLocation: { lat: 40.58, lng: -105.08 } }, hourlyRate: 22, now: at }) });
  return { rows, calls, store, clockIn };
}
function realVisitApi(clock, fixture, env = { EGC_WALKTHROUGH_VISIT_ENABLED: 'true' }) {
  const net = { offline: false, posts: [], replies: [], gets: 0 };
  const handlers = walkthroughVisitHandlers({ session: async () => SALES, storage: () => fixture.store, now: () => new Date(clock.now()) });
  const fetchImpl = async (url, init = {}) => {
    if (net.offline) throw new TypeError('Failed to fetch');
    const request = new Request(new URL(url, 'https://easygaragecleaning.com'), { method: init.method || 'GET', headers: { ...(init.headers || {}), Origin: 'https://easygaragecleaning.com' }, body: init.body });
    if (init.method === 'POST') net.posts.push(JSON.parse(init.body)); else net.gets++;
    const response = await (init.method === 'POST' ? handlers.post : handlers.get)({ request, env });
    if (init.method === 'POST') net.replies.push({ status: response.status, body: await response.clone().json() });
    return response;
  };
  return { net, api: R.httpVisit(fetchImpl) };
}

test('real FUN-05: an offline Start refused after the rep moved to the next appointment is shown there with its choice; then Start and Finish go out', async () => {
  const clock = fakeClock(T0), f = fun05Fixture();
  f.clockIn(new Date(T0 - 3600000).toISOString());
  const { net, api } = realVisitApi(clock, f);
  const p = page({ clock, server: api });
  await p.ready();
  // Clocked in, in a garage without signal: record five minutes and save "Quote to follow".
  net.offline = true;
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  await p.clock.advance(5 * 60 * 1000);
  await p.tap('Finish', p.footer); await p.tap('Quote to follow'); await p.tap('Save outcome');
  assert.match(p.text(), /Outcome saved on this iPad: Quote to follow/);
  // The rep drives to the next appointment; the signal returns there.
  await p.show({ id: 'w2', customer: 'Second Synthetic Customer' });
  await p.clock.advance(20 * 60 * 1000);
  net.offline = false;
  await p.fire('online');
  assert.deepEqual(net.replies.map(reply => [reply.status, reply.body.code || 'ok']), [[409, 'walkthrough_visit_time_invalid']]);
  assert.equal(p.audio.calls.length, 1, 'the audio uploads meanwhile');
  assert.equal(p.footer.querySelector('.wt-bar').hidden, true, 'the finished walkthrough has no recording bar');
  // On W2 the refusal is an alert above the plan, with its choice, not only inside the collapsed unsent badge.
  const alerts = p.host.querySelectorAll('[role="alert"]').map(node => node.textContent);
  assert.ok(alerts.some(text => /^The walkthrough for Synthetic Customer \(Sep 22, 9:00 AM\) needs your decision\.$/.test(text)), alerts.join(' | '));
  const strip = p.host.querySelector('.wt-decide');
  assert.match(strip.textContent, /Start needs your decision: Offline clock times are not enabled/);
  assert.equal(p.buttons('Retry', strip).length, 0, 'Retry would be refused again: only the timecard choice is offered');
  assert.equal(p.links('Open that walkthrough', strip)[0].getAttribute('href'), '/crew/gameplan.html?walkthroughId=w1');
  assert.match(p.text(), /Second Synthetic Customer/); assert.equal(p.buttons('Start walkthrough').length, 1, 'W2\'s own card stays below');
  await p.tap('Start without timecard', strip);
  assert.deepEqual(net.replies.map(reply => [reply.body.visit?.id || '', reply.status, reply.body.code || 'ok']), [['', 409, 'walkthrough_visit_time_invalid'], ['w1', 200, 'ok'], ['w1', 200, 'ok']]);
  assert.deepEqual(net.posts.slice(1).map(body => [body.action, body.skipTimecard ?? false, body.deviceAt]), [['start', true, new Date(T0).toISOString()], ['finish', false, new Date(T0 + 5 * 60 * 1000).toISOString()]]);
  const w1 = f.rows.get('jobs/w1');
  assert.deepEqual([w1.walkthroughVisit.startedAt, w1.walkthroughOutcome.outcome, w1.walkthroughOutcome.recordingStatus], [new Date(T0).toISOString(), 'quote_to_follow', 'recorded'], 'the visit keeps its real start time and its outcome');
  assert.equal(p.host.querySelector('.wt-decide'), null);
  assert.equal((await p.store.sessions()).length, 0);
  // W2 then starts as usual.
  await p.tap('Start walkthrough'); await p.tap('Customer declined recording');
  assert.deepEqual([net.replies.at(-1).status, net.replies.at(-1).body.visit.id], [200, 'w2']);
});

test('real FUN-05: with no appointment on screen the decision still shows; switched off, the GET reads no visit, lock or timecard', async () => {
  const clock = fakeClock(T0), f = fun05Fixture();
  f.clockIn(new Date(T0 - 3600000).toISOString());
  const { net, api } = realVisitApi(clock, f);
  const p = page({ clock, server: api });
  await p.ready();
  net.offline = true;
  await p.tap('Start walkthrough'); await p.tap('Customer declined recording');
  await p.clock.advance(3 * 60 * 1000);
  await p.show(null); // a manual plan with no Hub walkthrough
  net.offline = false;
  await p.fire('online');
  assert.equal(p.host.hidden, false);
  assert.match(p.host.querySelector('.wt-decide').textContent, /The walkthrough for Synthetic Customer .* needs your decision\.Start needs your decision/);
  assert.match(p.bar(), /Start needs your decision\./, 'the open walkthrough\'s bar says so in one line');
  // Switched off (EGC_WALKTHROUGH_VISIT_ENABLED unset): the gameplan asks, and FUN-05 answers without any read.
  const off = fun05Fixture(), quiet = realVisitApi(clock, off, {});
  const q = page({ clock, server: quiet.api });
  await q.ready();
  assert.equal(quiet.net.gets, 1);
  assert.deepEqual(off.calls, [], 'no visit, lock or timecard (vault) read');
  assert.deepEqual(q.shown, []); assert.equal(q.host.hidden, true);
});

// ---- Two gameplan tabs on one iPad: two realms share only the device storage (and Web Locks, and a BroadcastChannel the
// recorder never uses). ----
const iPad = () => { const clock = fakeClock(); return { clock, store: R.memoryStore(), server: visitServer({ now: clock.now }), audio: audioService(), hub: channelHub(), local: storage(), locks: fakeLocks() }; };
const tab = (d, extra = {}) => page({ clock: d.clock, timers: d.clock.scope(), store: d.store, server: d.server, audio: d.audio, Channel: d.hub.Channel, localStore: d.local, locks: d.locks, ...extra });
// What a tab shows for a walkthrough another tab of the iPad holds.
const ELSEWHERE = 'This walkthrough is open in another tab on this iPad — use that tab.';
const storedBytes = async (store, parts) => { const sizes = []; for (const part of parts) sizes.push((await store.chunks(part.id)).reduce((sum, row) => sum + row.bytes, 0)); return sizes; };

test('saveAs merges parts by id, keeps parts it does not hold, never moves consent back, never re-creates a session, and refuses another tab', async () => {
  const store = R.memoryStore(), walk = session({ status: 'active', capture: 'recording', owner: { tab: 'tab-a', at: new Date(T0).toISOString() }, parts: [{ id: 'p1', index: 1, source: 'recorder', state: 'closed', bytes: 10 }, { id: 'p2', index: 2, source: 'recorder', state: 'recording', bytes: 5 }] });
  await store.putSession(walk);
  // An older copy that holds only part 1 does not drop part 2.
  await R.saveAs(store, 'tab-a', { ...plain(walk), parts: [{ id: 'p1', index: 1, source: 'recorder', state: 'closed', bytes: 12 }] });
  let row = await saved(store, walk.id);
  assert.deepEqual(row.parts.map(part => [part.id, part.bytes]), [['p1', 12], ['p2', 5]]);
  assert.equal(await R.saveAs(store, 'tab-b', { ...plain(walk), capture: 'interrupted' }), null, 'another tab\'s copy is refused');
  await R.withdrawSession(store, walk.id, new Date(T0).toISOString());
  await R.saveAs(store, 'tab-a', { ...plain(walk), consent: 'recorded' });
  row = await saved(store, walk.id);
  assert.deepEqual([row.consent, row.capture, row.parts], ['declined', 'none', []]);
  await store.removeSession(walk.id);
  assert.equal(await R.saveAs(store, 'tab-a', plain(walk)), null);
  assert.equal((await store.sessions()).length, 0, 'a cleared session stays cleared');
});

test('two syncs (two tabs) freeze one request for an action: both send the same body, and the server saves it once', async () => {
  const store = R.memoryStore(), server = visitServer(), clock = fakeClock(), walk = session({ status: 'active', capture: 'none', consent: 'declined' });
  await store.putSession(walk);
  const sync = () => R.createSync({ store, visit: server, upload: async () => { throw new Error('no audio'); }, now: clock.now, uuid: id, user: () => 'sales.rep' });
  const [left, right] = await Promise.all([sync().run(), sync().run()]);
  assert.deepEqual([left.stopped, right.stopped], [null, null]);
  assert.equal(new Set(server.posts().map(body => body.requestId)).size, 1, 'one request ID');
  assert.equal(server.receipts.size, 1);
  assert.equal((await saved(store, walk.id)).actions[0].state, 'done');
});

test('a roll-over starts the next part before the old one stops, so no audio falls between parts', async () => {
  const { clock, media, store, recorder, heartbeat } = rig({ chunkBytes: 5 * 1024 * 1024 }), walk = session();
  await recorder.begin(walk); heartbeat();
  const [first] = media.recorders;
  let secondStartedWhileFirstRecorded = null;
  const stop = first.stop.bind(first);
  first.stop = () => { secondStartedWhileFirstRecorded = media.recorders[1]?.state === 'recording'; stop(); };
  await clock.advance(4000); // the 20 MiB part limit
  assert.equal(secondStartedWhileFirstRecorded, true, 'part 2 was recording when part 1 was asked to stop');
  const row = await saved(store, walk.id);
  assert.deepEqual(row.parts.map(part => [part.index, part.state, part.reason]), [[1, 'closed', 'size'], [2, 'recording', null]]);
  assert.ok(Date.parse(row.parts[1].startedAt) <= Date.parse(row.parts[0].endedAt), 'the parts overlap rather than leave a gap');
  assert.equal((await store.chunks(row.parts[0].id)).at(-1).bytes, 100, 'part 1 keeps its final second');
});

test('a muted microphone (a call, Siri) is noted and warned about; interruption warnings clear after a healthy minute or when dismissed', async () => {
  const { clock, media, store, recorder, heartbeat } = rig(), walk = session();
  await recorder.begin(walk); heartbeat();
  await clock.advance(5000);
  media.streams[0].audio.mute();
  assert.deepEqual(plain(recorder.status().problem), { code: 'muted', at: T0 + 5000 });
  await clock.advance(30000);
  assert.equal(recorder.status().problem.code, 'muted', 'the warning stays while the microphone is muted');
  media.streams[0].audio.unmute();
  assert.deepEqual(plain(recorder.status().problem), { code: 'unmuted', at: T0 + 35000, away: 30000 });
  let row = await saved(store, walk.id);
  assert.deepEqual(row.interruptions.map(item => [item.kind, item.mutedMs ?? null]), [['muted', null], ['unmuted', 30000]]);
  assert.equal(media.recorders.length, 1, 'the part keeps recording through the silence');
  await clock.advance(59000);
  assert.equal(recorder.status().problem.code, 'unmuted');
  await clock.advance(2000);
  assert.equal(recorder.status().problem, null, 'cleared after a healthy minute');
  // A screen lock warning, dismissed by the rep in the bar.
  const p = page();
  await p.ready();
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  p.controller.recorder.visibility(true); await p.clock.advance(5000); p.controller.recorder.visibility(false); await p.flush();
  assert.match(p.bar(), /The screen locked or Safari left the foreground/);
  await p.tap('Dismiss', p.footer);
  assert.doesNotMatch(p.bar(), /The screen locked/);
  row = (await p.store.sessions())[0];
  assert.deepEqual(row.interruptions.map(item => item.kind), ['hidden', 'resumed'], 'the interruption stays on record');
});

test('a roll-over while the microphone is muted (a call) keeps that microphone: the next part starts without asking for it again', async () => {
  const { clock, media, store, recorder, heartbeat } = rig(), walk = session();
  await recorder.begin(walk); heartbeat();
  await clock.advance(60000);
  media.streams[0].audio.mute();
  media.devices.fail = 'NotReadableError'; // during a call the microphone cannot be opened again
  await clock.advance(20 * 60 * 1000);
  assert.equal(recorder.status().capture, 'recording', 'not paused');
  assert.equal(media.devices.calls, 1, 'the microphone was not requested again');
  const row = await saved(store, walk.id);
  assert.deepEqual(row.parts.map(part => [part.index, part.state, part.reason]), [[1, 'closed', 'time'], [2, 'recording', null]]);
  assert.equal(media.recorders[1].stream, media.streams[0]);
  media.streams[0].audio.unmute();
  assert.equal(recorder.status().problem.code, 'unmuted');
});

// IndexedDB that refuses every write once `full` (as idbStore reports QuotaExceededError), and keeps what it saved.
function fullingDisk(limit) {
  const disk = R.memoryStore(), state = { full: false, writes: 0 };
  const refuse = () => Promise.reject(Object.assign(new Error('quota'), { code: 'RECORDER_STORAGE_UNAVAILABLE' }));
  return { state, disk, primary: { persistent: true, sessions: () => disk.sessions(), chunks: partId => disk.chunks(partId), removeSession: sessionId => disk.removeSession(sessionId), removeChunks: partId => disk.removeChunks(partId),
    putSession: row => state.full ? refuse() : disk.putSession(row), atomic: fn => state.full ? refuse() : disk.atomic(fn),
    putChunk: (chunk, check) => { if (++state.writes > limit) state.full = true; return state.full ? refuse() : disk.putChunk(chunk, check); } } };
}
function sharedLedger() { const rows = new Map(); return { rows, get: key => rows.get(key) ?? null, set: (key, value) => rows.set(key, structuredClone(value)), remove: key => rows.delete(key) }; }

test('out of storage: audio held only in page memory is counted, and after the page is lost the reload says how much was lost', async () => {
  const clock = fakeClock(), server = visitServer({ now: clock.now }), audio = audioService(), ledger = sharedLedger(), drive = fullingDisk(5), locks = fakeLocks();
  const A = page({ clock, server, audio, ledger, locks, store: R.deviceStore(drive.primary, R.memoryStore()) });
  await A.ready();
  await A.tap('Start walkthrough'); await A.tap('Recording OK');
  await clock.advance(20000);
  assert.match(A.bar(), /This iPad is not saving the audio reliably/);
  const partId = (await drive.disk.sessions())[0].parts[0].id;
  assert.equal((await drive.disk.chunks(partId)).length, 5, 'IndexedDB holds the first five seconds');
  assert.deepEqual(ledger.get(partId), { bytes: 15 * 6000, total: 20 * 6000, at: new Date(T0 + 20000).toISOString() });
  // Safari discards the tab (page memory and its Web Lock are gone); space is freed and the gameplan opens again.
  A.controller.unmount(); locks.drop(`egc-wt-tab:${A.controller.recorder.tab}`); drive.state.full = false; drive.state.writes = -1e9;
  const B = page({ clock, server, audio, ledger, locks, store: R.deviceStore(drive.primary, R.memoryStore()) });
  await B.ready();
  assert.match(B.bar(), /The page closed while recording\. The audio saved on this iPad is kept\. About 0:15 \(88 KB\) that only page memory held \(the iPad was out of storage\) was lost\./);
  assert.equal(ledger.rows.size, 0);
  await B.tap('Finish', B.footer); await B.tap('Quote to follow'); await B.tap('Save outcome');
  await clock.advance(2000);
  assert.deepEqual(audio.calls.map(call => call.size), [5 * 6000], 'the five saved seconds upload');
});

test('out of storage: parts close after two minutes and upload before Finish, so page memory never holds much audio', async () => {
  const clock = fakeClock(), server = visitServer({ now: clock.now }), audio = audioService(), drive = fullingDisk(3);
  const p = page({ clock, server, audio, ledger: sharedLedger(), store: R.deviceStore(drive.primary, R.memoryStore()) });
  await p.ready();
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  await clock.advance(2 * 60 * 1000 + 2000);
  assert.match(p.bar(), /Part 2/);
  assert.equal(audio.calls.length, 1, 'part 1 uploaded while the walkthrough is still recording');
  assert.equal(audio.calls[0].size, 120 * 6000 + 100, 'with the audio only page memory held');
  assert.deepEqual(server.posts().map(body => body.action), ['start']);
  const row = (await p.store.sessions())[0];
  assert.deepEqual(row.parts.map(part => [part.index, part.state]), [[1, 'uploaded'], [2, 'recording']]);
  assert.equal((await p.store.chunks(row.parts[0].id)).length, 0);
});

test('page: asks Safari to keep its storage; the load error clears when the signal returns; switched-off never offers Start', async () => {
  let persisted = 0;
  const p = page({ storageManager: { persisted: async () => false, persist: async () => { persisted++; return true; } } });
  await p.ready();
  assert.equal(persisted, 1);
  // The next appointment opens without signal: its state is unknown until the signal returns, then read without a tap.
  const server = visitServer(), q = page({ server });
  await q.ready();
  server.offline = true;
  await q.show({ id: 'w2', customer: 'Synthetic Neighbour' });
  assert.match(q.text(), /No connection right now/);
  const reads = server.calls.filter(call => call.get === 'w2').length;
  server.offline = false;
  await q.fire('online');
  assert.doesNotMatch(q.text(), /No connection right now/);
  assert.equal(server.calls.filter(call => call.get === 'w2').length, reads + 1, 'the visit state was read again');
  server.offline = true;
  await q.show({ id: 'w3', customer: 'Synthetic Third' });
  server.offline = false;
  q.document.visibilityState = 'visible';
  for (const listener of q.document.listeners.visibilitychange || []) listener({ type: 'visibilitychange' });
  await q.flush();
  assert.doesNotMatch(q.text(), /No connection right now/, 'and when the page is shown again');
  // Switched off with a walkthrough of this visit still waiting on the iPad: its state shows, Start never does.
  const off = visitServer(), store = R.memoryStore(), r = page({ server: off, store });
  await r.ready();
  off.offline = true;
  await r.tap('Start walkthrough'); await r.tap('Customer declined recording');
  await r.tap('Finish', r.footer); await r.tap('Not interested');
  const select = r.host.querySelector('select'); select.value = 'price'; select.dispatchEvent({ type: 'change', target: select });
  await r.tap('Save outcome');
  Object.assign(off, { offline: false, enabled: false });
  await r.controller.refresh(); await r.flush();
  assert.match(r.text(), /Outcome saved on this iPad: Not interested/);
  assert.equal(r.buttons('Start walkthrough').length, 0);
});

test('page: after the outcome, "Customer withdrew consent" deletes the audio still on the iPad and sends the outcome as declined', async () => {
  const p = page();
  await p.ready();
  p.server.offline = true; p.audio.mode = 'offline';
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  await p.clock.advance(10000);
  await p.tap('Finish', p.footer); await p.tap('Quote to follow'); await p.tap('Save outcome');
  let row = (await p.store.sessions())[0];
  const parts = row.parts.map(part => part.id);
  assert.ok(parts.length && (await p.store.chunks(parts[0])).length > 0);
  await p.tap('Customer withdrew consent: delete the audio');
  assert.match(p.text(), /The audio still on this iPad was deleted \(1 part\)\./);
  row = (await p.store.sessions())[0];
  assert.deepEqual([row.consent, row.parts.map(part => [part.state, part.reason]), row.actions.map(item => item.intent.recordingStatus)], ['declined', [['removed', 'withdrawn']], ['declined', 'declined']]);
  for (const partId of parts) assert.equal((await p.store.chunks(partId)).length, 0);
  p.server.offline = false; p.audio.mode = 'ok';
  await p.fire('online');
  assert.deepEqual(p.server.posts().filter(body => !p.server.offline).map(body => [body.action, body.recordingStatus]).slice(-2), [['start', 'declined'], ['finish', 'declined']]);
  assert.equal(p.audio.saved.size, 0, 'nothing was uploaded');
  assert.equal((await p.store.sessions()).length, 0);
  // Once the outcome was already sent as recorded, the rep is told to tell the office; unsent parts are still deleted.
  const q = page();
  await q.ready();
  q.audio.mode = 'offline';
  await q.tap('Start walkthrough'); await q.tap('Recording OK');
  await q.clock.advance(5000);
  await q.tap('Finish', q.footer); await q.tap('Quote to follow'); await q.tap('Save outcome');
  assert.match(q.text(), /Outcome recorded: Quote to follow/);
  await q.tap('Customer withdrew consent: delete the audio');
  assert.match(q.text(), /The outcome was already sent as recorded: tell the office the customer withdrew consent\./);
  q.audio.mode = 'ok';
  await q.fire('online');
  assert.equal(q.audio.saved.size, 0);
  assert.equal((await q.store.sessions()).length, 0);
});

test('the Finish reasons are the shared funnel definitions\' reason codes (without other_legacy), in order', () => {
  const live = kind => funnelReasonCodes(kind).filter(code => code !== 'other_legacy');
  assert.deepEqual(plain(R.OUTCOMES.map(([code]) => code)), funnelReasonCodes('walkthroughOutcome'));
  assert.deepEqual(plain(R.REASONS.not_interested.map(([code]) => code)), live('lost'));
  assert.deepEqual(plain(R.REASONS.customer_no_show.map(([code]) => code)), live('noShow'));
  assert.deepEqual(plain(R.REASONS.rescheduled.map(([code]) => code)), live('reschedule'));
});

// ---- Third review ----
// An upload the test holds, like the XHR transport: a withdrawal's abort rejects it at once (unless honorAbort is false,
// a reply that won the race). sentFirst: every byte reached the service, which stored the part; only the reply is held.
function heldUpload(service, { sentFirst = false, honorAbort = true } = {}) {
  const held = { calls: 0, aborted: 0, pending: [] };
  held.upload = (request, progress) => new Promise((resolve, reject) => {
    held.calls++;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const stopped = () => { held.aborted++; finish(reject, fail('The upload was stopped: the customer withdrew consent.', 0, 'RECORDER_UPLOAD_STOPPED')); };
    if (honorAbort && request.signal) { if (request.signal.aborted) { stopped(); return; } request.signal.onabort = stopped; }
    const stored = sentFirst ? service.upload(request, () => {}).then(value => { progress(1); return value; }) : null;
    // An aborted request never reaches the service; one already stored there still answers.
    held.pending.push(() => (stored || (settled ? null : service.upload(request, progress)))?.then(value => finish(resolve, value), error => finish(reject, error)));
  });
  held.release = () => { for (const go of held.pending.splice(0)) go(); };
  return held;
}
async function finishRecorded(p, seconds = 10) {
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  await p.clock.advance(seconds * 1000);
  await p.tap('Finish', p.footer); await p.tap('Quote to follow'); await p.tap('Save outcome');
}

test('page: withdrawing consent while a part uploads stops the upload and sends nothing again; since the iPad cannot know whether it arrived, it is named with its upload ID until the rep has told the office', async () => {
  // Updated deliberately (fifth review): an upload that a withdrawal stopped after it started sending may have reached the
  // service (a completion the transport had not handled yet), so it is no longer reported as stopped in time. The upload
  // is still stopped, nothing reaches the service, and nothing is sent again.
  const service = audioService(), held = heldUpload(service), p = page({ audio: { upload: held.upload } });
  await p.ready();
  await finishRecorded(p);
  assert.equal(held.calls, 1, 'part 1 is on its way');
  assert.deepEqual(p.server.posts().map(body => [body.action, body.recordingStatus]), [['start', 'recorded'], ['finish', 'recorded']]);
  await p.tap('Customer withdrew consent: delete the audio');
  assert.equal(held.aborted, 1, 'the upload was stopped');
  let row = (await p.store.sessions())[0];
  const part = row.parts[0];
  assert.deepEqual([row.consent, part.state, part.recordingId, part.unconfirmed, part.sendingAt], ['declined', 'uploaded_after_withdrawal', null, true, undefined]);
  const unsure = `Part 1 may have reached the recording service before the withdrawal took effect: tell the office (upload ID ${part.requestId}).`;
  assert.ok(p.text().includes(`The audio still on this iPad was deleted (1 part). ${unsure} The outcome was already sent as recorded: tell the office the customer withdrew consent.`), p.text());
  held.release(); await p.clock.advance(60000);
  assert.equal(service.saved.size, 0, 'nothing reached the recording service');
  assert.equal(held.calls, 1, 'and nothing was sent again');
  assert.equal((await p.store.sessions()).length, 1, 'kept until the rep has told the office');
  await p.tap('I told the office', p.host.querySelector('.wt-decide'));
  assert.equal((await p.store.sessions()).length, 0);
  // A withdrawal saved while the sync marks the part as on its way, before it sends anything: nothing may be on the
  // service, so nothing is named and the walkthrough leaves the iPad.
  const inner = R.memoryStore(), gate = { armed: false, hold: null, open: null };
  const store = { ...inner, persistent: true,
    chunks: async partId => { const rows = await inner.chunks(partId); if (gate.armed) { gate.armed = false; gate.hold = new Promise(resolve => { gate.open = resolve; }); } return rows; },
    atomic: async fn => { const out = await inner.atomic(fn); if (gate.hold) { const hold = gate.hold; gate.hold = null; await hold; } return out; } };
  const other = audioService(), q = page({ store, audio: other });
  await q.ready();
  gate.armed = true;
  await finishRecorded(q);
  assert.equal(typeof gate.open, 'function', 'the sync marked part 1 as on its way and waits to send it');
  row = (await inner.sessions())[0];
  assert.ok(row.parts[0].sendingAt);
  const tapped = q.tap('Customer withdrew consent: delete the audio');
  await q.flush();
  gate.open(); await tapped; await q.flush();
  await q.clock.advance(5000);
  assert.equal(other.calls.length, 0, 'nothing was sent');
  assert.ok(q.text().includes('The audio still on this iPad was deleted (1 part). The outcome was already sent as recorded: tell the office the customer withdrew consent.'), q.text());
  assert.doesNotMatch(q.text(), /reached the recording service/);
  assert.equal((await inner.sessions()).length, 0, 'nothing waits for the rep');
});

test('page: audio that reached the service before a withdrawal took effect is named, with its recording or upload ID, until the rep has told the office', async () => {
  // Every byte of part 1 was sent (only the reply is outstanding) when the customer withdraws: it may be on the service.
  const service = audioService(), held = heldUpload(service, { sentFirst: true }), p = page({ audio: { upload: held.upload } });
  await p.ready();
  await finishRecorded(p);
  await p.tap('Customer withdrew consent: delete the audio');
  assert.equal(held.aborted, 1);
  assert.equal(service.saved.size, 1, 'the service had stored it before the withdrawal');
  let row = (await p.store.sessions())[0];
  const part = row.parts[0];
  assert.deepEqual([row.consent, part.state, part.recordingId, part.unconfirmed], ['declined', 'uploaded_after_withdrawal', null, true]);
  assert.equal((await p.store.chunks(part.id)).length, 0, 'its audio left the iPad');
  const unsure = `Part 1 may have reached the recording service before the withdrawal took effect: tell the office (upload ID ${part.requestId}).`;
  assert.ok(p.text().includes(unsure), p.text());
  // The walkthrough stays on the iPad, and above every appointment, until the rep confirms telling the office.
  await p.clock.advance(10 * 60 * 1000);
  assert.equal((await p.store.sessions()).length, 1);
  await p.show({ id: 'w2', customer: 'Second Synthetic Customer' });
  const strip = p.host.querySelector('.wt-decide');
  assert.match(strip.textContent, /^The walkthrough for Synthetic Customer \(Sep 22, 9:00 AM\) has audio on the recording service although the customer withdrew consent\./);
  assert.ok(strip.textContent.includes(unsure));
  await p.tap('I told the office', strip);
  assert.equal((await p.store.sessions()).length, 0, 'then it leaves the iPad');
  assert.equal(p.host.querySelector('.wt-decide'), null);
  // The reply won the race with the withdrawal: the part is named with its recording ID.
  const other = audioService(), late = heldUpload(other, { honorAbort: false }), q = page({ audio: { upload: late.upload } });
  await q.ready();
  await finishRecorded(q);
  await q.tap('Customer withdrew consent: delete the audio');
  late.release(); await q.flush();
  row = (await q.store.sessions())[0];
  const recordingId = other.saved.get(row.parts[0].requestId).recordingId;
  assert.deepEqual([row.parts[0].state, row.parts[0].recordingId, row.parts[0].unconfirmed], ['uploaded_after_withdrawal', recordingId, false]);
  const reached = `Part 1 reached the recording service before the withdrawal took effect: tell the office (recording ID ${recordingId}).`;
  assert.ok(q.text().includes(`The audio still on this iPad was deleted (1 part). ${reached}`), q.text());
  await q.clock.advance(60000);
  assert.equal((await q.store.sessions()).length, 1, 'kept until the rep has seen it');
  await q.tap('I told the office', q.host.querySelector('.wt-decide'));
  assert.equal((await q.store.sessions()).length, 0);
  assert.equal(other.calls.length, 1, 'never sent again');
});

test('a withdrawal while the sync reads the visit before freezing the Finish (or the Start) sends it as declined', async () => {
  const gated = inner => { const gate = { next: false, open: null }; return Object.assign(gate, { api: { state: async visitId => { if (gate.next) { gate.next = false; await new Promise(resolve => { gate.open = resolve; }); } return inner.state(visitId); }, post: body => inner.post(body) } }); };
  // After the outcome: the Finish is frozen from the saved row, which the withdrawal changed during the read.
  const inner = visitServer(), gate = gated(inner), audio = audioService(), p = page({ server: gate.api, audio });
  await p.ready();
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  await p.clock.advance(10000);
  inner.offline = true; audio.mode = 'offline';
  await p.tap('Finish', p.footer); await p.tap('Quote to follow'); await p.tap('Save outcome');
  inner.offline = false; gate.next = true;
  await p.fire('online');
  assert.equal(typeof gate.open, 'function', 'the sync is reading the visit');
  await p.tap('Customer withdrew consent: delete the audio');
  assert.match(p.text(), /The audio still on this iPad was deleted \(1 part\)\./);
  assert.doesNotMatch(p.text(), /already sent as recorded/);
  gate.open(); await p.clock.advance(3000);
  assert.deepEqual(inner.posts().map(body => [body.action, body.recordingStatus]), [['start', 'recorded'], ['finish', 'declined']]);
  assert.equal(audio.saved.size, 0);
  assert.equal((await p.store.sessions()).length, 0);
  // Before the outcome: the Start being frozen while the rep withdraws on the Finish screen goes out as declined.
  const first = visitServer(), startGate = gated(first), q = page({ server: startGate.api });
  await q.ready();
  first.offline = true;
  await q.tap('Start walkthrough'); await q.tap('Recording OK');
  await q.clock.advance(60000);
  first.offline = false; startGate.next = true;
  await q.fire('online');
  assert.equal(typeof startGate.open, 'function');
  await q.tap('Finish', q.footer); await q.tap('Customer withdrew consent');
  startGate.open(); await q.clock.advance(3000);
  assert.deepEqual(first.posts().map(body => [body.action, body.recordingStatus]), [['start', 'declined']]);
});

test('with Web Locks another tab never takes a walkthrough over while Safari has paused its tab (it keeps its lock); a reload of that tab takes its own recording back at once', async () => {
  // Updated deliberately (fifth review): one tab per walkthrough, so the other tab offers no Take over here (it only says
  // that the walkthrough is open in another tab); the reload and the new tab are unchanged.
  // Updated deliberately (Web Locks required): runs with Web Locks. The paused tab keeps its lock; the reload is a page whose
  // lock went with it (the recorder keeps no list of the tab's pages in sessionStorage).
  const d = iPad(), A = tab(d, { Channel: null });
  await A.ready();
  await A.tap('Start walkthrough'); await A.tap('Recording OK');
  await d.clock.advance(10000);
  // The rep opens another gameplan tab: Safari pauses tab A (hidden, timers held) for ten minutes.
  A.controller.recorder.visibility(true); A.timers.pause();
  const B = tab(d, { Channel: null });
  await B.ready();
  await d.clock.advance(10 * 60 * 1000);
  let row = (await d.store.sessions())[0];
  assert.equal(row.owner.tab, A.controller.recorder.tab, 'the quiet tab keeps its walkthrough');
  assert.equal(B.media.devices.calls, 0);
  assert.doesNotMatch(B.bar() + B.text(), /The page closed while recording|Recording paused|Resume/);
  assert.match(B.bar(), /^Open in another tab/);
  assert.ok(B.bar().includes(ELSEWHERE) && B.text().includes(ELSEWHERE));
  for (const label of ['Take over here', 'Finish', 'Resume']) assert.equal(B.buttons(label, B.footer).length, 0, label);
  for (const label of ['Finish walkthrough', 'Customer withdrew consent', 'Start walkthrough']) assert.equal(B.buttons(label).length, 0, label);
  // The rep goes back to tab A: it records on (a new part after the gap).
  A.timers.resume(); A.controller.recorder.visibility(false);
  await d.clock.advance(6000);
  assert.equal(A.controller.recorder.status().capture, 'recording');
  row = (await d.store.sessions())[0];
  assert.equal(row.owner.tab, A.controller.recorder.tab);
  assert.deepEqual(row.parts.map(part => part.state), ['closed', 'recording']);
  // Tab A reloads: the new page (same tab, same sessionStorage) takes its recording back at once.
  const stored = await storedBytes(d.store, row.parts);
  const tabStorage = A.context.sessionStorage;
  A.controller.unmount(); d.locks.drop(lockOf(A));
  const A2 = tab(d, { Channel: null, tabStorage });
  await A2.ready();
  row = (await d.store.sessions())[0];
  assert.equal(row.owner.tab, A2.controller.recorder.tab, 'reclaimed at once');
  assert.match(A2.bar(), /^Recording paused/); assert.match(A2.bar(), /The page closed while recording\. The audio saved on this iPad is kept\./);
  assert.deepEqual(await storedBytes(d.store, row.parts), row.parts.map(part => part.bytes)); assert.ok(row.parts.every(part => part.state === 'closed'));
  assert.ok(row.parts[0].bytes === stored[0]);
  await A2.tap('Resume', A2.footer);
  assert.equal(A2.controller.recorder.status().capture, 'recording');
  // A new tab (its own sessionStorage) never takes it: it shows the walkthrough as open in another tab.
  const C = tab(d, { Channel: null });
  await C.ready(); await d.clock.advance(60000);
  assert.equal((await d.store.sessions())[0].owner.tab, A2.controller.recorder.tab);
  assert.match(C.bar(), /^Open in another tab/);
  // Tab B, still open, shows the same (it never took anything).
  assert.match(B.bar(), /^Open in another tab/);
});

test('switched on, the recorder takes its tab lock and persistent storage (and no BroadcastChannel); a warning from a lost recording never follows the rep to the next walkthrough', async () => {
  // Updated deliberately (fifth review): the recorder no longer opens a BroadcastChannel (one tab per walkthrough). A tab now
  // loses a recording only when another tab found its page gone: here its Web Lock is released while it still runs (as
  // WebKit may do for a page it keeps in its back/forward cache).
  const spies = browserSpies(), on = page({ storageManager: spies.storageManager, locks: spies.locks, Channel: spies.Channel });
  await on.ready();
  assert.deepEqual([spies.used.locks, spies.used.channels, spies.used.persist >= 1], [1, 0, true]);
  assert.equal((on.events.beforeunload || []).length, 1);
  const d = iPad(), locks = fakeLocks(), A = tab(d, { locks });
  await A.ready();
  await A.tap('Start walkthrough'); await A.tap('Recording OK');
  await d.clock.advance(30000);
  const B = tab(d, { locks });
  await B.ready();
  assert.match(B.bar(), /^Open in another tab/);
  locks.drop(`egc-wt-tab:${A.controller.recorder.tab}`);
  await d.clock.advance(6000);
  let row = (await d.store.sessions())[0];
  assert.equal(row.owner.tab, B.controller.recorder.tab, 'tab B took the walkthrough of a page it found gone');
  assert.equal(A.controller.recorder.status().capture, 'idle', 'tab A\'s next second was refused, so it stopped');
  assert.equal(A.controller.recorder.status().problem.code, 'moved');
  assert.ok(A.media.streams.every(stream => stream.audio.readyState === 'ended'));
  assert.match(A.bar(), /This tab stopped recording: another tab of this iPad holds this walkthrough now\./, 'shown on the walkthrough it is about');
  assert.ok(A.bar().includes(ELSEWHERE));
  assert.deepEqual(await storedBytes(d.store, row.parts), row.parts.map(part => part.bytes), 'no second of tab A was added after the claim');
  await B.tap('Finish', B.footer); await B.tap('Quote to follow'); await B.tap('Save outcome');
  await d.clock.advance(5000);
  await A.fire('online'); await d.clock.advance(5000);
  assert.equal((await d.store.sessions()).length, 0);
  assert.deepEqual(d.audio.calls.map(call => call.size), row.parts.map(part => part.bytes));
  // Back in tab A the rep starts the next appointment without a recording: its bar has no warning about the old one.
  await A.show({ id: 'w2', customer: 'Second Synthetic Customer' });
  await A.tap('Start walkthrough'); await A.tap('Customer declined recording');
  await d.clock.advance(2000);
  assert.match(A.bar(), /^Walkthrough \(not recorded\)/);
  assert.doesNotMatch(A.bar(), /another tab|stopped recording/);
  assert.equal(A.footer.querySelectorAll('.wt-warn').filter(node => /tab/.test(node.textContent)).length, 0);
  assert.equal(d.hub.instances.length, 0, 'no tab opened a BroadcastChannel');
});

test('out of storage: a withdrawal before the outcome names the part already uploaded, on the Finish screen, and the outcome goes out as declined', async () => {
  const clock = fakeClock(), server = visitServer({ now: clock.now }), audio = audioService(), drive = fullingDisk(3);
  const p = page({ clock, server, audio, ledger: sharedLedger(), store: R.deviceStore(drive.primary, R.memoryStore()) });
  await p.ready();
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  await clock.advance(2 * 60 * 1000 + 2000);
  assert.equal(audio.calls.length, 1, 'part 1 uploaded before Finish');
  await p.tap('Finish', p.footer);
  await p.tap('Customer withdrew consent');
  const status = p.host.querySelectorAll('[role="status"]').map(node => node.textContent);
  assert.ok(status.includes('The audio was deleted from this iPad. Part 1 was already uploaded: tell the office to delete it. Type the notes at Finish instead.'), status.join(' | '));
  assert.match(p.text(), /^Synthetic CustomerFinish walkthrough/, 'on the Finish screen');
  await p.tap('Quote to follow');
  const notes = ['Synthetic: two-car garage back', 'Synthetic: keep the workbench', 'Synthetic: side gate code from the office'];
  p.host.querySelectorAll('textarea').forEach((area, i) => { area.value = notes[i]; area.dispatchEvent({ type: 'input', target: area }); });
  await p.tap('Save outcome');
  await clock.advance(3000);
  assert.deepEqual(server.posts().map(body => [body.action, body.recordingStatus]), [['start', 'recorded'], ['finish', 'declined']]);
  assert.equal(audio.calls.length, 1, 'nothing more is uploaded');
});

test('the upload transport stops on a withdrawal: aborted before it is sent, or mid-way, and reports when every byte went out', async () => {
  const sent = [];
  class FakeXHR {
    constructor() { this.upload = {}; this.aborted = 0; sent.push(this); }
    open(method, url, async) { Object.assign(this, { method, url, async }); }
    send(form) { this.form = form; }
    abort() { this.aborted++; this.onabort?.(); }
  }
  const upload = R.xhrUpload(FakeXHR), blob = new Blob([new Uint8Array(12)], { type: 'audio/mp4' });
  const request = extra => ({ requestId: id(), visitId: 'w1', blob, filename: 'walkthrough-w1-part-1.m4a', ...extra });
  // Withdrawn before it is sent: nothing is opened.
  await assert.rejects(upload(request({ signal: { aborted: true, onabort: null } })), error => error.code === 'RECORDER_UPLOAD_STOPPED' && error.status === 0);
  assert.equal(sent.length, 0);
  // Withdrawn mid-way: the request is aborted and reported as stopped, not as a lost connection to retry.
  const signal = { aborted: false, onabort: null }, progress = [];
  const pending = upload(request({ signal }), value => progress.push(value));
  const [xhr] = sent;
  xhr.upload.onprogress({ lengthComputable: true, loaded: 12, total: 12 }); xhr.upload.onload();
  assert.deepEqual(progress, [1, 1], 'every byte was sent: the service may hold the part from here on');
  signal.aborted = true; signal.onabort();
  assert.equal(xhr.aborted, 1);
  await assert.rejects(pending, error => error.code === 'RECORDER_UPLOAD_STOPPED');
  // An abort without a withdrawal (the page is leaving) stays a lost connection, retried with the same upload ID.
  const other = upload(request());
  sent.at(-1).abort();
  await assert.rejects(other, error => error.code === 'RECORDER_NETWORK');
});

// The rep switches to tab B: Safari shows it (and its sync looks at what is on the iPad).
async function showTab(p) {
  p.document.visibilityState = 'visible';
  for (const listener of p.document.listeners.visibilitychange || []) listener({ type: 'visibilitychange' });
  await p.flush();
}

test('a part on its way (sendingAt) keeps the sync\'s fields through the recorder\'s writes and a withdrawal before Finish; a claim of a gone page\'s walkthrough counts that upload as possibly on the service', async () => {
  // Updated deliberately (fifth review): the sync's own sendingAt (one tab) replaces the cross-tab upload marks.
  const store = R.memoryStore(), at = new Date(T0).toISOString();
  const walk = session({ status: 'active', capture: 'recording', owner: { tab: 'tab-a', at }, parts: [{ id: 'p1', index: 1, source: 'recorder', state: 'closed', bytes: 10, sendingAt: at, attempts: 1 }, { id: 'p2', index: 2, source: 'recorder', state: 'closed', bytes: 5 }, { id: 'p3', index: 3, source: 'recorder', state: 'closed', bytes: 7, unconfirmed: true }] });
  await store.putSession(walk);
  // The recorder's copy does not know about the upload on its way: its write keeps the sync's fields.
  await R.saveAs(store, 'tab-a', { ...plain(walk), parts: walk.parts.map(({ sendingAt, attempts, unconfirmed, ...part }) => ({ ...part, bytes: part.bytes + 1 })) });
  let row = await saved(store, walk.id);
  assert.deepEqual(row.parts.map(part => [part.id, part.bytes, part.sendingAt || null, part.attempts || null, part.unconfirmed || null]), [['p1', 11, at, 1, null], ['p2', 6, null, null, null], ['p3', 8, null, null, true]]);
  // A claim of a page that is gone: the part it was sending may be on the service (kept for a retry, unconfirmed); a claim
  // by a third tab that still names the gone page is refused (the holder is re-checked in the same write).
  const claimed = await R.claim(store, walk.id, 'tab-a', 'tab-b', new Date(T0 + 500).toISOString());
  assert.deepEqual([claimed.owner.tab, claimed.parts[0].state, claimed.parts[0].unconfirmed, claimed.parts[0].sendingAt], ['tab-b', 'closed', true, undefined]);
  assert.equal(await R.claim(store, walk.id, 'tab-a', 'tab-c', new Date(T0 + 600).toISOString()), null);
  // A withdrawal before Finish drops the parts, except one on its way (its row stays until that upload says how it ended)
  // and one that may already be on the service (a notice with its upload ID).
  await R.saveChange(store, walk.id, draft => { draft.parts[1].sendingAt = at; });
  const { removed } = await R.withdrawSession(store, walk.id, new Date(T0 + 1000).toISOString());
  row = await saved(store, walk.id);
  assert.deepEqual(plain(removed), ['p1', 'p2', 'p3']);
  assert.deepEqual(row.parts.map(part => [part.id, part.state, part.reason, part.sendingAt || null, part.unconfirmed || null]), [['p1', 'uploaded_after_withdrawal', 'withdrawn', null, true], ['p2', 'removed', 'withdrawn', at, null], ['p3', 'uploaded_after_withdrawal', 'withdrawn', null, true]]);
  // Should that page be gone too before its upload of part 2 says how it ended, the next claim names it as well.
  const again = await R.claim(store, walk.id, 'tab-b', 'tab-c', new Date(T0 + 2000).toISOString());
  assert.deepEqual(again.parts.map(part => [part.id, part.state, part.recordingId ?? null, part.unconfirmed]), [['p1', 'uploaded_after_withdrawal', null, true], ['p2', 'uploaded_after_withdrawal', null, true], ['p3', 'uploaded_after_withdrawal', null, true]]);
});

test('a page that closes while it uploads a part leaves that part counted as possibly on the service: the tab that takes the walkthrough back names it with its upload ID if consent is withdrawn, or sends it again under the same upload ID', async () => {
  // Updated deliberately (fifth review): one tab per walkthrough. The uploading page is closed (the next tab takes the
  // walkthrough) or reloaded (the tab's next page does) instead of being paused while another tab withdraws.
  // Updated deliberately (Web Locks required): the reload variant runs with Web Locks too; its page's lock goes with it.
  for (const variant of ['web-locks-new-tab', 'web-locks-reload-same-tab']) {
    const d = iPad(), held = heldUpload(d.audio);
    const A = tab(d, { audio: { upload: held.upload } });
    await A.ready();
    await finishRecorded(A);
    assert.equal(held.calls, 1, 'tab A is uploading part 1');
    let row = (await d.store.sessions())[0];
    assert.ok(row.parts[0].sendingAt, `${variant}: saved as on its way before it was sent`);
    // Safari closes (or reloads) tab A mid-upload: how that upload ended is never known here.
    const tabStorage = A.context.sessionStorage;
    A.controller.unmount(); A.timers.pause(); d.locks.drop(`egc-wt-tab:${A.controller.recorder.tab}`);
    d.audio.mode = 'offline';
    const B = tab(d, variant === 'web-locks-reload-same-tab' ? { tabStorage } : {});
    await B.ready();
    row = (await d.store.sessions())[0];
    assert.equal(row.owner.tab, B.controller.recorder.tab, `${variant}: taken back`);
    assert.deepEqual([row.parts[0].state, row.parts[0].unconfirmed, row.parts[0].sendingAt], ['closed', true, undefined]);
    // Still offline, the customer withdraws consent: the part may be on the service, so it is named with its upload ID.
    await B.tap('Customer withdrew consent: delete the audio');
    row = (await d.store.sessions())[0];
    assert.deepEqual([row.parts[0].state, row.parts[0].recordingId, row.parts[0].unconfirmed], ['uploaded_after_withdrawal', null, true]);
    const mayHave = `Part 1 may have reached the recording service before the withdrawal took effect: tell the office (upload ID ${row.parts[0].requestId}).`;
    assert.ok(B.text().includes(mayHave), B.text());
    d.audio.mode = 'ok'; await B.fire('online'); await d.clock.advance(60 * 60 * 1000);
    assert.equal((await d.store.sessions()).length, 1, `${variant}: kept until the rep has told the office`);
    assert.ok(B.host.querySelector('.wt-decide')?.textContent.includes(mayHave), B.text());
    await B.tap('I told the office', B.host.querySelector('.wt-decide'));
    assert.equal((await d.store.sessions()).length, 0);
    assert.equal(d.audio.calls.filter(call => call.size).length, 1, `${variant}: only tab B's offline attempt was made after the close`);
  }
  // Not withdrawn: the tab that takes it back sends the part again under the same upload ID, and the service keeps it once.
  const d = iPad(), locks = fakeLocks(), held = heldUpload(d.audio, { sentFirst: true });
  const A = tab(d, { locks, audio: { upload: held.upload } });
  await A.ready();
  await finishRecorded(A);
  assert.equal(d.audio.saved.size, 1, 'every byte reached the service; only the reply was lost with the page');
  A.controller.unmount(); A.timers.pause(); locks.drop(`egc-wt-tab:${A.controller.recorder.tab}`);
  const B = tab(d, { locks });
  await B.ready(); await d.clock.advance(5000);
  assert.equal((await d.store.sessions()).length, 0, 'sent and cleared');
  assert.equal(new Set(d.audio.calls.map(call => call.requestId)).size, 1, 'the same upload ID');
  assert.equal(d.audio.saved.size, 1, 'stored once');
});

test('a withdrawal saved between an upload\'s failure and the sync\'s write of it: a part every byte of which was sent is named with its upload ID', async () => {
  const clock = fakeClock(), inner = R.memoryStore(), service = audioService();
  let armed = false, gate = null;
  // Updated deliberately (fifth review): the sync now decides how the upload ended in the one write after the failure, with
  // no read before it, so the withdrawal lands right before that write (it used to land on the read).
  const store = { ...inner, persistent: true, atomic: async fn => { if (armed) { armed = false; await R.withdrawSession(inner, (await inner.sessions())[0].id, new Date(clock.now()).toISOString()); } return inner.atomic(fn); } };
  // Every byte is sent and stored, then the connection drops before the reply.
  const upload = async (request, progress) => { await service.upload(request, () => {}); progress(1); await new Promise(resolve => { gate = resolve; }); throw fail('The upload did not finish.', 0, 'RECORDER_NETWORK'); };
  const p = page({ clock, store, audio: { upload } });
  await p.ready();
  await finishRecorded(p);
  assert.equal(service.saved.size, 1);
  armed = true; gate();
  await clock.advance(5000);
  assert.equal(armed, false, 'the withdrawal landed right before the sync\'s write');
  const row = plain((await inner.sessions())[0]);
  assert.deepEqual([row.consent, row.parts[0].state, row.parts[0].reason, row.parts[0].recordingId, row.parts[0].unconfirmed], ['declined', 'uploaded_after_withdrawal', 'withdrawn', null, true]);
  assert.equal((await inner.chunks(row.parts[0].id)).length, 0);
  const strip = p.host.querySelector('.wt-decide');
  assert.ok(strip?.textContent.includes(`Part 1 may have reached the recording service before the withdrawal took effect: tell the office (upload ID ${row.parts[0].requestId}).`), p.text());
  await clock.advance(10 * 60 * 1000);
  assert.equal((await inner.sessions()).length, 1);
  await p.tap('I told the office', p.host.querySelector('.wt-decide'));
  assert.equal((await inner.sessions()).length, 0);
  assert.equal(service.calls.length, 1, 'never sent again');
});


// ---- Fifth review: one tab per walkthrough, and a withdrawal's abort that runs before the upload's completion. ----
// A store that counts one tab's writes (the tabs of one iPad share the rows).
const counted = store => { const tally = { writes: 0 }; return { tally, store: { ...store, persistent: true, atomic: fn => { tally.writes++; return store.atomic(fn); }, putSession: row => { tally.writes++; return store.putSession(row); }, putChunk: (chunk, check) => { tally.writes++; return store.putChunk(chunk, check); } } }; };

test('two tabs: the second tab says the walkthrough is open in another tab and cannot record, upload, finish or withdraw it; once that tab is closed (Web Locks) it takes the walkthrough back with every saved second', async () => {
  const d = iPad(), locks = fakeLocks(), A = tab(d, { locks });
  await A.ready();
  await A.tap('Start walkthrough'); await A.tap('Recording OK');
  await d.clock.advance(10000);
  // The rep opens the gameplan again in a second tab (from the Hub schedule after "Open time clock").
  const { tally, store } = counted(d.store), B = tab(d, { locks, store });
  await B.ready();
  assert.match(B.bar(), /^Open in another tab · 0:10/);
  assert.ok(B.bar().includes(ELSEWHERE)); assert.ok(B.text().includes(ELSEWHERE));
  for (const label of ['Finish', 'Resume', 'Take over here', 'Decide']) assert.equal(B.buttons(label, B.footer).length + B.links(label, B.footer).length, 0, label);
  for (const label of ['Finish walkthrough', 'Customer withdrew consent', 'Start walkthrough', 'Recording OK']) assert.equal(B.buttons(label).length, 0, label);
  assert.equal(B.media.devices.calls, 0, 'tab B never opens the microphone');
  // Tab A records on for five minutes (a screen lock moves it to part 2); tab B writes nothing and sends nothing.
  A.controller.recorder.visibility(true); await d.clock.advance(5000); A.controller.recorder.visibility(false);
  await d.clock.advance(5 * 60 * 1000);
  let row = (await d.store.sessions())[0];
  assert.deepEqual([row.owner.tab, row.capture, row.parts.map(part => part.state)], [A.controller.recorder.tab, 'recording', ['closed', 'recording']]);
  assert.equal(tally.writes, 0, 'tab B changed nothing');
  assert.deepEqual(d.server.posts().map(body => body.action), ['start'], 'only tab A sent (its Start)');
  // Safari closes tab A (its Web Lock goes): within a few seconds tab B takes the walkthrough back, as after a reload.
  A.controller.unmount(); A.timers.pause(); locks.drop(`egc-wt-tab:${A.controller.recorder.tab}`);
  await d.clock.advance(6000);
  row = (await d.store.sessions())[0];
  assert.equal(row.owner.tab, B.controller.recorder.tab);
  assert.match(B.bar(), /^Recording paused/); assert.match(B.bar(), /The page closed while recording\. The audio saved on this iPad is kept\./);
  const kept = await storedBytes(d.store, row.parts);
  assert.deepEqual(kept, row.parts.map(part => part.bytes), 'every second tab A saved is kept');
  assert.ok(row.parts.every(part => part.state === 'closed'));
  await B.tap('Finish', B.footer); await B.tap('Quote to follow'); await B.tap('Save outcome');
  await d.clock.advance(3000);
  assert.deepEqual(d.server.posts().map(body => [body.action, body.recordingStatus]), [['start', 'recorded'], ['finish', 'recorded']]);
  assert.deepEqual(d.audio.calls.map(call => [call.filename, call.size]), row.parts.map((part, i) => [`walkthrough-w1-part-${part.index}.m4a`, kept[i]]));
  assert.equal((await d.store.sessions()).length, 0);
  assert.equal(d.hub.instances.length, 0, 'no BroadcastChannel');
});

test('two tabs: a walkthrough whose upload runs in a tab Safari paused stays with that tab: the other tab sends nothing of it, writes nothing and does not look again by re-sending; the walkthrough leaves once that tab ends the upload', async () => {
  const d = iPad(), locks = fakeLocks(), held = heldUpload(d.audio, { sentFirst: true });
  const A = tab(d, { locks, audio: { upload: held.upload } });
  await A.ready();
  await finishRecorded(A);
  assert.equal(held.calls, 1, 'tab A is uploading part 1');
  // The rep switches to tab B: Safari pauses tab A (it keeps its Web Lock).
  A.timers.pause();
  const { tally, store } = counted(d.store), B = tab(d, { locks, store });
  await B.ready();
  await showTab(B);
  await d.clock.advance(60 * 60 * 1000);
  assert.equal(held.calls, 1, 'tab B never sent the part');
  assert.deepEqual([d.audio.calls.length, d.server.posts().length], [1, 2], 'nothing more reached either service');
  assert.equal(tally.writes, 0, 'tab B wrote nothing in an hour');
  await B.tap('Unsent recordings on this iPad · 1');
  assert.ok(B.text().includes(ELSEWHERE), B.text());
  assert.equal(B.buttons('Send now').length + B.buttons('Customer withdrew consent').length, 0);
  // Tab A wakes and its upload lands: the walkthrough leaves the iPad, and tab B shows that within a few seconds.
  held.release(); A.timers.resume();
  await d.clock.advance(10000);
  assert.equal((await d.store.sessions()).length, 0);
  assert.equal(B.buttons('Unsent recordings on this iPad · 1').length, 0);
  assert.match(B.text(), /Outcome recorded: Quote to follow/, 'tab B read the visit again once tab A no longer held its walkthrough');
});

// XMLHttpRequest whose events wait in a queue (as WebKit's wait for a tab Safari paused) until deliver(). abort() before they
// are delivered fires abort and drops them, as the XHR spec's request error steps do. networkDone(): the request finished on
// the network, so the recording service stored the part; its load events are still queued.
function queuedXHR(service) {
  const all = [];
  class FakeXHR {
    constructor() { Object.assign(this, { upload: {}, readyState: 0, status: 0, responseText: '', queued: [], aborted: false }); all.push(this); }
    open(method, url) { Object.assign(this, { method, url, readyState: 1 }); }
    send(form) { this.form = form; this.upload.onprogress?.({ lengthComputable: true, loaded: 40, total: 100 }); }
    abort() { if (this.readyState === 4) return; this.aborted = true; this.queued = []; this.readyState = 4; this.onabort?.(); }
  }
  return {
    FakeXHR, all,
    async networkDone() {
      for (const xhr of all) {
        if (xhr.aborted || !xhr.form) continue;
        const blob = xhr.form.get('audio'), result = await service.upload({ requestId: xhr.form.get('requestId'), visitId: xhr.form.get('portalJobId'), blob, filename: blob.name }, () => {});
        xhr.queued.push(() => xhr.upload.onload?.(), () => { Object.assign(xhr, { readyState: 4, status: 201, responseText: JSON.stringify({ ok: true, recording: { id: result.recordingId, status: 'uploaded' }, alreadySaved: false }) }); xhr.onload?.(); });
      }
    },
    deliver() { for (const xhr of all) for (const run of xhr.queued.splice(0)) run(); },
  };
}

test('a withdrawal whose abort runs before the upload\'s queued completion (the real XHR transport): the part may be on the service, so it is named with its upload ID until "I told the office"', async () => {
  const service = audioService(), net = queuedXHR(service), p = page({ audio: { upload: R.xhrUpload(net.FakeXHR) } });
  await p.ready();
  await finishRecorded(p);
  assert.equal(net.all.length, 1, 'part 1 is on its way');
  // The network finishes the request and the service stores the part, but its load events wait behind the rep's tap.
  await net.networkDone();
  assert.equal(service.saved.size, 1);
  await p.tap('Customer withdrew consent: delete the audio');
  assert.equal(net.all[0].aborted, true, 'the abort ran first');
  net.deliver(); await p.flush();
  const row = (await p.store.sessions())[0], part = row.parts[0];
  assert.deepEqual([row.consent, part.state, part.recordingId, part.unconfirmed, part.reason], ['declined', 'uploaded_after_withdrawal', null, true, 'withdrawn']);
  assert.equal((await p.store.chunks(part.id)).length, 0, 'its audio left the iPad');
  const unsure = `Part 1 may have reached the recording service before the withdrawal took effect: tell the office (upload ID ${part.requestId}).`;
  assert.ok(p.text().includes(`The audio still on this iPad was deleted (1 part). ${unsure}`), p.text());
  // It stays on the iPad, above every appointment, until the rep confirms telling the office.
  await p.clock.advance(2 * 60 * 60 * 1000);
  assert.equal((await p.store.sessions()).length, 1);
  await p.show({ id: 'w2', customer: 'Second Synthetic Customer' });
  const strip = p.host.querySelector('.wt-decide');
  assert.ok(strip?.textContent.includes(unsure), p.text());
  await p.tap('I told the office', strip);
  assert.equal((await p.store.sessions()).length, 0);
  assert.deepEqual([net.all.length, service.calls.length], [1, 1], 'never sent again');
});

test('after "Customer withdrew consent" on a walkthrough already sent as recorded, no Voice Memos file is offered or accepted for that visit, also once the walkthrough left the iPad and in a new page', async () => {
  const localStore = storage(), store = R.memoryStore(), server = visitServer(), p = page({ store, server, localStore });
  await p.ready();
  p.audio.mode = 'offline';
  await finishRecorded(p, 5);
  assert.match(p.text(), /Outcome recorded: Quote to follow/);
  const files = q => q.host.querySelectorAll('input').filter(input => input.getAttribute('type') === 'file');
  const [picker] = files(p);
  assert.ok(picker, 'offered before the withdrawal');
  await p.tap('Customer withdrew consent: delete the audio');
  assert.match(p.text(), /The outcome was already sent as recorded: tell the office the customer withdrew consent\./);
  assert.equal(files(p).length, 0, 'not offered after it');
  p.audio.mode = 'ok'; await p.fire('online');
  assert.equal((await store.sessions()).length, 0, 'the withdrawn walkthrough left the iPad');
  assert.equal(p.audio.calls.filter(call => call.size).length, 1, 'only the offline attempt before the withdrawal');
  assert.equal(files(p).length, 0);
  // A file picked in the picker shown before the withdrawal is refused, and nothing is kept or uploaded.
  picker.files = [Object.assign(new Blob([new Uint8Array(64)], { type: 'audio/x-m4a' }), { name: 'New Recording 3.m4a' })];
  picker.dispatchEvent({ type: 'change', target: picker }); await p.flush();
  assert.match(p.text(), /The customer withdrew recording consent for this walkthrough, so no audio is uploaded for it\./);
  assert.equal((await store.sessions()).length, 0);
  assert.equal(p.audio.calls.length, 1);
  // The gameplan opened again (a new page on this iPad) keeps the refusal.
  const q = page({ store, server, localStore });
  await q.ready();
  assert.match(q.text(), /Outcome recorded: Quote to follow/);
  assert.equal(files(q).length, 0);
  // A rebooked visit whose customer agrees to a recording again: the earlier withdrawal no longer applies.
  Object.assign(server.visit, { rebookPending: true });
  await q.controller.refresh(); await q.flush();
  await q.tap('Start walkthrough'); await q.tap('Recording OK');
  assert.equal(localStore.getItem('egc-wt-recorder:withdrawn:w1'), null);
});

// ---- Sixth review: one withdrawal covers every walkthrough of its visit, tab identity across reloads and sign-in, and the
// holder re-checked in the page's withdrawal and outcome writes. ----
async function addFile(p, name, bytes = 64) {
  const [picker] = p.host.querySelectorAll('input').filter(input => input.getAttribute('type') === 'file');
  assert.ok(picker, `no file input in: ${p.text()}`);
  picker.files = [Object.assign(new Blob([new Uint8Array(bytes)], { type: 'audio/x-m4a' }), { name })];
  picker.dispatchEvent({ type: 'change', target: picker }); await p.flush();
}
// A Voice Memos walkthrough of w1 saved by another page (tab), with its audio on the iPad.
async function memoWalkthrough(store, { tab = null, user = 'sales.rep', name = 'New Recording 4.m4a' } = {}) {
  const at = new Date(T0).toISOString(), walk = { id: id(), user, visitId: 'w1', customer: 'Synthetic Customer', createdAt: at, startedAt: at, consent: 'recorded', capture: 'none', status: 'finished', outcome: 'quote_to_follow', finishedAt: at, ...(tab ? { owner: { tab, at } } : {}), interruptions: [], actions: [],
    parts: [{ id: id(), index: 1, requestId: id(), mimeType: 'audio/mp4', extension: 'm4a', source: 'import', name, startedAt: at, endedAt: at, bytes: 64, chunks: 1, reason: 'import', state: 'closed', recordingId: null, attempts: 0, serverFailures: 0, error: null }] };
  await store.putSession(walk);
  await store.putChunk({ id: `${walk.parts[0].id}|0000001`, partId: walk.parts[0].id, sessionId: walk.id, seq: 1, type: 'audio/mp4', bytes: 64, at, data: new Uint8Array(64).buffer });
  return walk;
}
const lockOf = p => `egc-wt-tab:${p.controller.recorder.tab}`;
async function hideTab(p) {
  p.document.visibilityState = 'hidden';
  for (const listener of p.document.listeners.visibilitychange || []) listener({ type: 'visibilitychange' });
  await p.flush();
}

test('one "Customer withdrew consent" tap withdraws every walkthrough of the visit on this iPad (a Hub recording still uploading plus a Voice Memos file, or two Voice Memos files): nothing uploads afterwards', async () => {
  // Part 1 of the Hub recording is uploading when a Voice Memos file is added on the outcome card: two walkthroughs of w1.
  const service = audioService(), held = heldUpload(service), p = page({ audio: { upload: held.upload } });
  await p.ready();
  await finishRecorded(p);
  assert.equal(held.calls, 1, 'part 1 of the Hub recording is on its way');
  await p.controller.refresh(); await p.flush();
  await addFile(p, 'New Recording 3.m4a');
  let rows = await p.store.sessions();
  assert.deepEqual(plain(rows.map(row => [row.visitId, row.status, row.consent, row.parts.map(part => part.source)])), [['w1', 'finished', 'recorded', ['recorder']], ['w1', 'finished', 'recorded', ['import']]]);
  const [hub, memo] = rows;
  await p.tap('Customer withdrew consent: delete the audio');
  assert.equal(held.aborted, 1, 'the Hub upload was stopped');
  const unsure = `Part 1 of the walkthrough started Sep 22, 9:00 AM may have reached the recording service before the withdrawal took effect: tell the office (upload ID ${hub.parts[0].requestId}).`;
  assert.ok(p.text().includes(`The audio still on this iPad was deleted (2 parts). ${unsure} The outcome was already sent as recorded: tell the office the customer withdrew consent.`), p.text());
  assert.equal((await p.store.chunks(memo.parts[0].id)).length, 0, 'the Voice Memos audio left the iPad');
  held.release(); await p.clock.advance(60000);
  held.release(); await p.fire('online'); await p.clock.advance(60000);
  assert.deepEqual([service.calls.length, held.calls], [0, 1], 'nothing reached the recording service after the tap');
  rows = await p.store.sessions();
  assert.deepEqual(plain(rows.map(row => [row.id, row.consent, row.parts.map(part => part.state)])), [[hub.id, 'declined', ['uploaded_after_withdrawal']]], 'only the part that may be on the service waits for the rep');
  // Two Voice Memos files (a long recording split under 24 MB, as the refusal asks), added offline on the outcome card.
  const q = page();
  await q.ready();
  await finishRecorded(q, 3);
  await q.controller.refresh(); await q.flush();
  assert.equal((await q.store.sessions()).length, 0, 'the Hub walkthrough was sent and left the iPad');
  q.audio.mode = 'offline';
  for (const name of ['Walkthrough part 1.m4a', 'Walkthrough part 2.m4a']) { await addFile(q, name); await q.clock.advance(1000); }
  rows = await q.store.sessions();
  assert.deepEqual(plain(rows.map(row => [row.status, row.consent, row.parts.map(part => [part.name, part.state])])), [['finished', 'recorded', [['Walkthrough part 1.m4a', 'closed']]], ['finished', 'recorded', [['Walkthrough part 2.m4a', 'closed']]]]);
  const calls = q.audio.calls.length, stored = q.audio.saved.size;
  await q.tap('Customer withdrew consent: delete the audio');
  assert.ok(q.text().includes('The audio still on this iPad was deleted (2 parts). The outcome was already sent as recorded: tell the office the customer withdrew consent.'), q.text());
  assert.equal(q.buttons('Customer withdrew consent').length, 0);
  q.audio.mode = 'ok'; await q.fire('online'); await q.clock.advance(120000);
  assert.deepEqual([q.audio.calls.length, q.audio.saved.size], [calls, stored], 'no file was sent after the tap');
  assert.equal((await q.store.sessions()).length, 0);
});

test('a withdrawal names a walkthrough of the visit that another tab holds: no tab starts an upload of it (not that tab, nor one that takes it over later), and one already on its way there that lands is named with its recording ID', async () => {
  const d = iPad(), locks = fakeLocks(), A = tab(d, { locks });
  await A.ready();
  d.audio.mode = 'offline';
  await finishRecorded(A);
  const w1 = (await d.store.sessions())[0];
  assert.deepEqual([w1.owner.tab, w1.parts.map(part => part.state)], [A.controller.recorder.tab, ['closed']]);
  // Tab B holds a Voice Memos walkthrough of the same visit; the customer withdraws consent there.
  const B = tab(d, { locks });
  await B.ready();
  const memo = await memoWalkthrough(d.store, { tab: B.controller.recorder.tab });
  await B.fire('online');
  await B.tap('Customer withdrew consent: delete the audio');
  // Updated deliberately (seventh review): that tab names a part already uploaded by itself (its sync), so the message no longer
  // sends the rep there to find out, and promises the withdrawal button only for a walkthrough with audio.
  assert.ok(B.text().includes('The audio still on this iPad was deleted (1 part). The walkthrough of this visit started Sep 22, 9:00 AM is open in another tab on this iPad: no upload of it starts from now on. If a part of it was already uploaded, that tab names it with its recording ID until you tap “I told the office” there. To delete its audio still on this iPad, tap “Customer withdrew consent” in that tab. The outcome was already sent as recorded: tell the office the customer withdrew consent.'), B.text());
  assert.equal((await d.store.chunks(memo.parts[0].id)).length, 0);
  // Tab A (which holds W1) goes online: it sends nothing of the withdrawn visit, and says why.
  const before = d.audio.calls.length;
  d.audio.mode = 'ok';
  await A.fire('online'); await d.clock.advance(60 * 60 * 1000);
  assert.equal(d.audio.calls.length, before, 'tab A started no upload of it');
  let row = (await d.store.sessions()).find(item => item.id === w1.id);
  assert.deepEqual(plain([row.consent, row.parts.map(part => [part.state, part.sendingAt ?? null])]), ['recorded', [['closed', null]]], 'never marked as on its way');
  await A.tap('Unsent recordings on this iPad · 1');
  assert.match(A.text(), /Part 1 · \d+ KBNot sent: the customer withdrew consent for this visit/);
  // Tab A closes: tab B takes W1 back, and sends nothing of it either; the rep withdraws it there.
  A.controller.unmount(); A.timers.pause(); locks.drop(lockOf(A));
  await d.clock.advance(6000);
  row = (await d.store.sessions()).find(item => item.id === w1.id);
  assert.equal(row.owner.tab, B.controller.recorder.tab);
  await B.fire('online'); await d.clock.advance(60 * 60 * 1000);
  assert.equal(d.audio.calls.length, before, 'tab B started no upload of it after taking it back');
  await B.tap('Customer withdrew consent: delete the audio');
  assert.match(B.text(), /The audio still on this iPad was deleted \(1 part\)\./);
  await d.clock.advance(5000);
  assert.equal((await d.store.sessions()).length, 0);
  assert.equal(d.audio.calls.length, before);
  // An upload already on its way in the other tab when the visit is withdrawn: it lands, and is named with its recording ID.
  const e = iPad(), elocks = fakeLocks(), held = heldUpload(e.audio, { honorAbort: false }), C = tab(e, { locks: elocks, audio: { upload: held.upload } });
  await C.ready();
  await finishRecorded(C);
  assert.equal(held.calls, 1, 'tab C is uploading part 1');
  const D = tab(e, { locks: elocks });
  await D.ready();
  e.audio.mode = 'offline';
  await memoWalkthrough(e.store, { tab: D.controller.recorder.tab });
  await D.fire('online');
  await D.tap('Customer withdrew consent: delete the audio');
  e.audio.mode = 'ok'; held.release(); await e.clock.advance(5000);
  const landed = (await e.store.sessions())[0], recordingId = e.audio.saved.get(landed.parts[0].requestId).recordingId;
  assert.deepEqual([landed.parts[0].state, landed.parts[0].recordingId, landed.parts[0].unconfirmed], ['uploaded_after_withdrawal', recordingId, false]);
  const reached = `Part 1 reached the recording service before the withdrawal took effect: tell the office (recording ID ${recordingId}).`;
  assert.ok(C.host.querySelector('.wt-attention')?.textContent.includes(reached), C.text());
  await e.clock.advance(60 * 60 * 1000);
  assert.equal((await e.store.sessions()).length, 1, 'kept until the rep has told the office');
  await C.tap('I told the office');
  await e.clock.advance(5000);
  assert.equal((await e.store.sessions()).length, 0, 'then it leaves the iPad: nothing else of it was there');
  assert.equal(held.calls, 1, 'never sent again');
});

test('after a withdrawal, a rebooked visit whose customer agrees to a recording again uploads the new recording, while a walkthrough of the visit already on this iPad (another account\'s) stays withdrawn, also once that employee signs in', async () => {
  let who = 'sales.rep';
  const localStore = storage(), store = R.memoryStore(), server = visitServer(), audio = audioService(), p = page({ store, server, audio, localStore, who: () => who });
  await p.ready();
  const other = await memoWalkthrough(store, { user: 'other.rep' });
  audio.mode = 'offline';
  await finishRecorded(p, 5);
  await p.tap('Customer withdrew consent: delete the audio');
  audio.mode = 'ok'; await p.fire('online'); await p.clock.advance(60000);
  assert.deepEqual(plain((await store.sessions()).map(row => row.id)), [other.id], 'the withdrawn walkthrough was sent (as declined) and left');
  // The visit is rebooked and the customer agrees to a recording of the new visit.
  Object.assign(server.visit, { rebookPending: true });
  await p.controller.refresh(); await p.flush();
  // FUN-05 moves the earlier occurrence aside with the rebooked Start.
  server.next(() => { Object.assign(server.visit, { rebookPending: false, walkthroughVisit: null, walkthroughOutcome: null }); });
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  assert.equal(localStore.getItem('egc-wt-recorder:withdrawn:w1'), null);
  await p.clock.advance(5000);
  await p.tap('Finish', p.footer); await p.tap('Quote to follow'); await p.tap('Save outcome');
  await p.clock.advance(5000);
  const sent = audio.calls.filter(call => call.size && call.requestId !== other.parts[0].requestId);
  assert.ok(sent.length >= 1 && audio.saved.size === 1, 'the new recording uploaded');
  // The other employee signs in on this iPad (no reload): their walkthrough of the withdrawn visit is not sent.
  who = 'other.rep';
  p.controller.check(); await p.flush(); await p.clock.advance(60 * 60 * 1000);
  assert.equal(audio.calls.filter(call => call.requestId === other.parts[0].requestId).length, 0, 'never sent');
  assert.deepEqual(plain((await store.sessions()).map(row => [row.id, row.parts[0].state, row.parts[0].sendingAt ?? null])), [[other.id, 'closed', null]]);
  await p.tap('Unsent recordings on this iPad · 1');
  assert.match(p.text(), /Not sent: the customer withdrew consent for this visit/);
});

test('signed out when the page loads: signing in on the gate (no reload) takes the tab\'s own walkthrough back at once (Web Locks)', async () => {
  // Updated deliberately (Web Locks required): the half without Web Locks is gone with the no-locks take-back; the new test
  // below covers a walkthrough saved without Web Locks after a reload while signed out.
  let who = 'sales.rep';
  const d = iPad(), locks = fakeLocks(), A = tab(d, { locks, who: () => who });
  await A.ready();
  await A.tap('Start walkthrough'); await A.tap('Recording OK');
  await d.clock.advance(10000);
  const tabStorage = A.context.sessionStorage;
  // Reloaded while the Hub session has expired: the new page shows the sign-in gate.
  await A.fire('pagehide'); A.controller.unmount(); A.timers.pause(); locks.drop(lockOf(A));
  who = '';
  const A2 = tab(d, { locks, tabStorage, who: () => who });
  await A2.ready(); await d.clock.advance(2000);
  assert.equal((await d.store.sessions())[0].owner.tab, A.controller.recorder.tab, 'signed out, nothing is taken');
  // Signed in on the gate: the gameplan renders again (no reload).
  who = 'sales.rep';
  A2.controller.check(); await A2.flush();
  assert.equal((await d.store.sessions())[0].owner.tab, A2.controller.recorder.tab, 'taken back at sign-in');
  assert.match(A2.bar(), /^Recording paused/);
  assert.equal(A2.buttons('Resume', A2.footer).length, 1);
  assert.doesNotMatch(A2.bar() + A2.text(), /open in another tab/);
});

test('with Web Locks a new tab that starts with a copy of a live tab\'s sessionStorage never takes its walkthrough, while the tab of a page Safari discarded in the background takes it back; a page that lost its lock while alive takes it again, so no new tab takes over its recording', async () => {
  // Updated deliberately (Web Locks required): the copy and the discarded page run with Web Locks, whose lock alone tells a
  // live tab from a gone one (the recorder keeps nothing in sessionStorage).
  // A new tab opened from a recording tab (window.open, Open in New Tab) with a copy of its sessionStorage.
  const d = iPad(), A = tab(d);
  await A.ready();
  await A.tap('Start walkthrough'); await A.tap('Recording OK');
  await d.clock.advance(10000);
  const C = tab(d, { tabStorage: storage(Object.fromEntries(A.context.sessionStorage.values)) });
  await C.ready(); await d.clock.advance(60000);
  assert.equal((await d.store.sessions())[0].owner.tab, A.controller.recorder.tab, 'the live tab keeps its walkthrough');
  assert.equal(A.controller.recorder.status().capture, 'recording');
  assert.match(C.bar(), /^Open in another tab/);
  // Tab A goes to the background and Safari discards it (no pagehide; its Web Lock goes with the page); reopening that tab
  // loads a new page with its storage.
  await hideTab(A); A.timers.pause(); d.locks.drop(lockOf(A));
  const A2 = tab(d, { tabStorage: A.context.sessionStorage });
  await A2.ready();
  assert.equal((await d.store.sessions())[0].owner.tab, A2.controller.recorder.tab, 'taken back by the same tab');
  assert.match(A2.bar(), /^Recording paused/);
  // Web Locks: WebKit releases tab W's lock while its page lives (back/forward cache), and shows the page again.
  const e = iPad(), locks = fakeLocks(), W = tab(e, { locks });
  await W.ready();
  await W.tap('Start walkthrough'); await W.tap('Recording OK');
  await e.clock.advance(10000);
  locks.drop(lockOf(W));
  await W.fire('pageshow', { persisted: true });
  assert.ok(locks.held.has(lockOf(W)), 'taken again when shown again');
  const X = tab(e, { locks });
  await X.ready(); await e.clock.advance(6000);
  assert.equal((await e.store.sessions())[0].owner.tab, W.controller.recorder.tab);
  assert.equal(W.controller.recorder.status().capture, 'recording');
  X.controller.unmount(); X.timers.pause(); locks.drop(lockOf(X));
  // Lost again without being shown: a new tab finds the page gone and takes the walkthrough, then closes. Tab W takes it back
  // and holds its lock again first, so the next new tab leaves its recording alone.
  locks.drop(lockOf(W));
  const Y = tab(e, { locks });
  await Y.ready(); await e.clock.advance(6000);
  assert.equal((await e.store.sessions())[0].owner.tab, Y.controller.recorder.tab);
  Y.controller.unmount(); Y.timers.pause(); locks.drop(lockOf(Y));
  await e.clock.advance(6000);
  assert.equal((await e.store.sessions())[0].owner.tab, W.controller.recorder.tab);
  assert.ok(locks.held.has(lockOf(W)), 'its lock is held again');
  await W.tap('Resume', W.footer);
  const Z = tab(e, { locks });
  await Z.ready(); await e.clock.advance(6000);
  assert.equal((await e.store.sessions())[0].owner.tab, W.controller.recorder.tab, 'the new tab did not take over');
  assert.equal(W.controller.recorder.status().capture, 'recording');
  assert.match(Z.bar(), /^Open in another tab/);
});

test('a withdrawal or an outcome tapped just after another tab took the walkthrough changes nothing of it and says so: the holder is re-checked in the write', async () => {
  // withdrawSession with a holder check refuses a walkthrough it rejects, and deletes nothing.
  const store = R.memoryStore(), at = new Date(T0).toISOString();
  const walk = session({ status: 'finished', owner: { tab: 'tab-b', at }, parts: [{ id: 'p1', index: 1, source: 'recorder', state: 'closed', bytes: 10 }] });
  await store.putSession(walk);
  await store.putChunk({ id: 'p1|0000001', partId: 'p1', sessionId: walk.id, seq: 1, bytes: 10, data: new ArrayBuffer(10) });
  assert.deepEqual(plain(await R.withdrawSession(store, walk.id, at, { holds: row => row.owner?.tab === 'tab-a' })), { session: null, removed: [], uploaded: [] });
  assert.deepEqual([(await saved(store, walk.id)).consent, (await saved(store, walk.id)).parts[0].state, (await store.chunks('p1')).length], ['recorded', 'closed', 1]);
  // In the page: another tab (Z) takes the walkthrough in the instant before the page's own write.
  const claimFirst = (inner, tabOf) => { const gate = { armed: false }; return Object.assign(gate, { store: { ...inner, persistent: true, atomic: async fn => { if (gate.armed) { gate.armed = false; await inner.atomic(rows => ({ put: rows.map(row => ({ ...row, owner: { tab: tabOf(), at } })) })); } return inner.atomic(fn); } } }); };
  // Save outcome on a walkthrough without audio: refused, the draft stays, nothing is saved.
  const d = iPad(), Z = tab(d), gate = claimFirst(d.store, () => Z.controller.recorder.tab), P = tab(d, { store: gate.store });
  await Z.ready(); await P.ready();
  await P.tap('Start walkthrough'); await P.tap('Customer declined recording');
  await d.clock.advance(3000);
  await P.tap('Finish walkthrough'); await P.tap('Quote to follow');
  P.host.querySelectorAll('textarea').forEach((area, i) => { area.value = `Synthetic note ${i + 1}`; area.dispatchEvent({ type: 'input', target: area }); });
  gate.armed = true;
  await P.tap('Save outcome');
  assert.ok(P.text().includes(ELSEWHERE), P.text());
  let row = (await d.store.sessions())[0];
  assert.deepEqual([row.owner.tab, row.status, row.actions.map(item => item.kind)], [Z.controller.recorder.tab, 'active', ['start']], 'no outcome was saved');
  assert.deepEqual(d.server.posts().map(body => body.action), ['start']);
  // Customer withdrew consent on a finished walkthrough: refused there, the other tab named, and that tab uploads nothing.
  const e = iPad(), Y = tab(e), gate2 = claimFirst(e.store, () => Y.controller.recorder.tab), Q = tab(e, { store: gate2.store });
  await Y.ready(); await Q.ready();
  e.audio.mode = 'offline';
  await finishRecorded(Q);
  const partId = (await e.store.sessions())[0].parts[0].id, calls = e.audio.calls.length;
  gate2.armed = true;
  await Q.tap('Customer withdrew consent: delete the audio');
  assert.ok(Q.text().includes(`${ELSEWHERE} The walkthrough of this visit started Sep 22, 9:00 AM is open in another tab on this iPad: no upload of it starts from now on.`), Q.text());
  row = (await e.store.sessions())[0];
  assert.deepEqual([row.owner.tab, row.consent, (await e.store.chunks(partId)).length > 0], [Y.controller.recorder.tab, 'recorded', true], 'nothing of it changed here');
  e.audio.mode = 'ok';
  await Y.fire('online'); await e.clock.advance(60 * 60 * 1000);
  assert.equal(e.audio.calls.length, calls, 'the tab that holds it starts no upload of the withdrawn visit');
  await Y.tap('Customer withdrew consent: delete the audio');
  await e.clock.advance(5000);
  assert.equal((await e.store.sessions()).length, 0);
  assert.equal(e.audio.calls.length, calls);
});

test('a part uploaded before the withdrawal stays on the iPad as a notice with its recording ID, above every appointment, until "I told the office"', async () => {
  const clock = fakeClock(), server = visitServer({ now: clock.now }), audio = audioService(), drive = fullingDisk(3);
  const p = page({ clock, server, audio, ledger: sharedLedger(), store: R.deviceStore(drive.primary, R.memoryStore()) });
  await p.ready();
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  await clock.advance(2 * 60 * 1000 + 2000);
  assert.equal(audio.calls.length, 1, 'part 1 uploaded before Finish (out of storage)');
  const [{ recordingId }] = [...audio.saved.values()];
  await p.tap('Finish', p.footer);
  await p.tap('Customer withdrew consent');
  let row = (await p.store.sessions())[0];
  assert.deepEqual(row.parts.map(part => [part.index, part.state, part.recordingId, part.uploadedBefore, part.unconfirmed]), [[1, 'uploaded_after_withdrawal', recordingId, true, false]]);
  const named = `Part 1 was uploaded before the withdrawal: tell the office (recording ID ${recordingId}).`;
  assert.ok(p.text().includes(named), p.text());
  await p.tap('Quote to follow');
  p.host.querySelectorAll('textarea').forEach((area, i) => { area.value = `Synthetic note ${i + 1}`; area.dispatchEvent({ type: 'input', target: area }); });
  await p.tap('Save outcome');
  await clock.advance(60 * 60 * 1000);
  assert.deepEqual(server.posts().map(body => [body.action, body.recordingStatus]), [['start', 'recorded'], ['finish', 'declined']]);
  // The rep moves on to the next appointment: the walkthrough stays, named above it.
  await p.show({ id: 'w2', customer: 'Second Synthetic Customer' });
  assert.equal((await p.store.sessions()).length, 1);
  const strip = p.host.querySelector('.wt-decide');
  assert.ok(strip?.textContent.includes(named), p.text());
  await p.tap('I told the office', strip);
  assert.equal((await p.store.sessions()).length, 0);
  assert.equal(audio.calls.length, 1, 'nothing more was uploaded');
});

test('with Web Locks, the tab whose page WebKit ended while on screen (no pagehide) takes its recording back when Safari reloads it, and again on the next such reload; a new tab with a copy of its sessionStorage, also once reloaded, never takes it', async () => {
  // Updated deliberately (Web Locks required): the page WebKit ended took its Web Lock with it, which alone tells the reload
  // that it is gone (no reload detection, and no list of the tab's pages in sessionStorage).
  const d = iPad(), A = tab(d);
  await A.ready();
  await A.tap('Start walkthrough'); await A.tap('Recording OK');
  await d.clock.advance(10000);
  const tabStorage = A.context.sessionStorage;
  // A new tab opened from the recording tab starts with a copy of its sessionStorage. WebKit then ends that tab's page too, on
  // screen (no pagehide), and Safari reloads it: neither page of that tab takes the live tab's walkthrough.
  const copy = storage(Object.fromEntries(tabStorage.values));
  const C = tab(d, { tabStorage: copy });
  await C.ready(); await d.clock.advance(6000);
  C.timers.pause(); d.locks.drop(lockOf(C));
  const C2 = tab(d, { tabStorage: copy });
  await C2.ready(); await d.clock.advance(60000);
  assert.equal((await d.store.sessions())[0].owner.tab, A.controller.recorder.tab, 'the live tab keeps its walkthrough');
  assert.equal(A.controller.recorder.status().capture, 'recording');
  assert.match(C2.bar(), /^Open in another tab/);
  // WebKit ends tab A's page while it is on screen (memory pressure while the rep takes photos from the plan): no
  // visibilitychange and no pagehide, but its Web Lock goes with the page. Safari reloads the tab with the same sessionStorage.
  A.timers.pause(); d.locks.drop(lockOf(A));
  let row = (await d.store.sessions())[0];
  const stored = await storedBytes(d.store, row.parts);
  const A2 = tab(d, { tabStorage });
  await A2.ready();
  row = (await d.store.sessions())[0];
  assert.equal(row.owner.tab, A2.controller.recorder.tab, 'taken back at once');
  assert.match(A2.bar(), /^Recording paused/); assert.match(A2.bar(), /The page closed while recording\. The audio saved on this iPad is kept\./);
  for (const label of ['Resume', 'Finish']) assert.equal(A2.buttons(label, A2.footer).length, 1, label);
  assert.deepEqual(row.parts.map(part => [part.state, part.bytes]), [['closed', stored[0]]], 'every saved second is kept');
  await A2.tap('Resume', A2.footer);
  assert.equal(A2.controller.recorder.status().capture, 'recording');
  await d.clock.advance(10000);
  // Ended on screen again, and reloaded again.
  A2.timers.pause(); d.locks.drop(lockOf(A2));
  const A3 = tab(d, { tabStorage });
  await A3.ready();
  row = (await d.store.sessions())[0];
  assert.equal(row.owner.tab, A3.controller.recorder.tab);
  assert.match(A3.bar(), /^Recording paused/);
  assert.match(C2.bar(), /^Open in another tab/);
  assert.equal(tabStorage.length, 0, 'the recorder keeps nothing in the tab\'s sessionStorage');
  // A3 records on and finishes: every part uploads once, with the audio from before each reload.
  await A3.tap('Resume', A3.footer); await d.clock.advance(5000);
  await A3.tap('Finish', A3.footer); await A3.tap('Quote to follow'); await A3.tap('Save outcome');
  await d.clock.advance(60000);
  assert.deepEqual(d.audio.calls.map(call => call.filename), [1, 2, 3].map(index => `walkthrough-w1-part-${index}.m4a`));
  assert.equal(d.audio.calls[0].size, stored[0]);
  assert.equal((await d.store.sessions()).length, 0);
  assert.equal(C2.media.devices.calls + C.media.devices.calls, 0, 'the other tab never asked for the microphone');
});

// ---- Web Locks required: recording in the Hub needs Safari on iPadOS 15.4 or later. ----
const UPDATE = 'Recording in the Hub needs iPadOS 15.4 or later. Update this iPad in Settings > General > Software Update, or record in Voice Memos and add the file here.';
const KEPT = `${ELSEWHERE} If that tab is closed, the walkthrough is kept on this iPad and sent once this iPad runs iPadOS 15.4 or later.`;

test('without Web Locks the Hub records nothing and takes nothing (no tab lock, persistent storage or leave prompt); the card says so, and a walkthrough recorded in Voice Memos is started, finished with its file and sent, as is a file added after the outcome', async () => {
  // Safari before iPadOS 15.4 has no navigator.locks; one with request but no query counts as none.
  for (const locks of [null, { request: () => { throw new Error('no Web Lock may be asked for'); } }]) {
    const spies = browserSpies(), tabStorage = storage(), label = locks ? 'request without query' : 'no navigator.locks';
    const p = page({ locks, storageManager: spies.storageManager, Channel: spies.Channel, tabStorage });
    await p.ready();
    assert.ok(p.text().includes(UPDATE), `${label}: ${p.text()}`);
    await p.tap('Start walkthrough');
    assert.deepEqual(p.buttons('Recording OK').map(node => node.textContent), ['Recording OK: record in Voice Memos'], `${label}: no Hub recording is offered`);
    await p.tap('Recording OK: record in Voice Memos');
    assert.equal(p.media.devices.calls, 0, `${label}: the microphone is never asked for`);
    assert.match(p.bar(), /^Walkthrough \(not recorded\)/);
    assert.match(p.text(), /without a Hub recording\. At Finish, add the Voice Memos file or type three short notes\./);
    let [row] = await p.store.sessions();
    assert.deepEqual(plain([row.consent, row.capture, row.status, row.owner]), ['failed_device', 'none', 'active', null], `${label}: no tab holds it`);
    assert.deepEqual(p.server.posts().map(body => [body.action, body.recordingStatus]), [['start', 'failed_device']]);
    // Twenty minutes in Voice Memos, then Finish with its file.
    await p.clock.advance(20 * 60 * 1000);
    await p.tap('Finish', p.footer);
    await addFile(p, 'New Recording 9.m4a', 256);
    assert.match(p.text(), /New Recording 9\.m4a added/);
    await p.tap('Quote to follow'); await p.tap('Save outcome');
    await p.clock.advance(5000);
    assert.deepEqual(p.server.posts().map(body => [body.action, body.recordingStatus]), [['start', 'failed_device'], ['finish', 'recorded']], label);
    assert.deepEqual(p.audio.calls.map(call => [call.filename, call.size, call.type]), [['walkthrough-w1-part-1.m4a', 256, 'audio/mp4']], label);
    assert.equal((await p.store.sessions()).length, 0, `${label}: sent and cleared`);
    // After the outcome another Voice Memos file is added on the card: saved in one exclusive write, held by no tab.
    await p.controller.refresh(); await p.flush();
    assert.match(p.text(), /Outcome recorded: Quote to follow/);
    assert.ok(p.text().includes(UPDATE), label);
    p.audio.mode = 'offline';
    await addFile(p, 'New Recording 10.m4a', 128);
    [row] = await p.store.sessions();
    assert.deepEqual(plain([row.status, row.owner, row.parts.map(part => [part.source, part.state, part.bytes])]), ['finished', null, [['import', 'closed', 128]]], label);
    p.audio.mode = 'ok'; await p.fire('online'); await p.clock.advance(5000);
    assert.equal(p.audio.saved.size, 2, `${label}: both files reached the recording service`);
    assert.equal((await p.store.sessions()).length, 0);
    // Nothing was taken from the browser, and nothing about the tab is kept in its sessionStorage.
    assert.deepEqual(spies.used, { persist: 0, locks: 0, channels: 0 }, label);
    assert.equal((p.events.beforeunload || []).length, 0, `${label}: no leave prompt`);
    assert.equal(tabStorage.length, 0, label);
  }
});

test('without Web Locks a walkthrough already on the iPad is never lost: one a tab holds (saved with Web Locks, or by an older build) is kept untouched with a clear message and taken back with its audio once the iPad runs iPadOS 15.4; one no tab holds is finished, withdrawn or sent from any page, also after a reload while signed out', async () => {
  // A walkthrough tab T recorded before this Safari lost Web Locks (or an older build saved): T's page is gone, but nothing
  // here can tell, so it is neither taken nor changed.
  const d = iPad(), at = new Date(T0).toISOString();
  const walk = session({ status: 'active', capture: 'recording', owner: { tab: 'tab-before', at }, parts: [{ id: 'held-1', index: 1, requestId: id(), mimeType: 'audio/mp4', extension: 'm4a', source: 'recorder', startedAt: at, endedAt: null, bytes: 18000, chunks: 3, reason: null, state: 'recording', recordingId: null, attempts: 0, serverFailures: 0, error: null }] });
  Object.assign(walk.actions[0], { state: 'done', requestId: id(), body: { action: 'start' }, doneAt: at });
  await d.store.putSession(walk);
  for (let seq = 1; seq <= 3; seq++) await d.store.putChunk({ id: `held-1|${String(seq).padStart(7, '0')}`, partId: 'held-1', sessionId: walk.id, seq, type: 'audio/mp4', bytes: 6000, at, data: new Uint8Array(6000).buffer });
  d.server.visit.walkthroughVisit = { startedAt: at, startedBy: 'sales.rep', recordingStatus: 'recorded' };
  const P = tab(d, { locks: null });
  await P.ready(); await d.clock.advance(60 * 60 * 1000);
  assert.ok(P.text().includes(KEPT) && P.bar().includes(KEPT), P.text());
  assert.ok(P.text().includes(UPDATE), P.text());
  assert.match(P.bar(), /^Open in another tab/);
  for (const name of ['Finish walkthrough', 'Customer withdrew consent', 'Start walkthrough']) assert.equal(P.buttons(name).length, 0, name);
  for (const name of ['Finish', 'Resume']) assert.equal(P.buttons(name, P.footer).length, 0, name);
  let row = await saved(d.store, walk.id);
  assert.deepEqual([row.owner.tab, row.capture, row.parts.map(part => part.state)], ['tab-before', 'recording', ['recording']], 'nothing of it was taken or changed');
  assert.deepEqual(await storedBytes(d.store, row.parts), [18000], 'its audio is kept');
  assert.deepEqual([d.audio.calls.length, d.server.posts().length], [0, 0]);
  // The iPad is updated: the next gameplan page (with Web Locks) finds tab T gone and takes the walkthrough back with every
  // saved second; it finishes and sends it.
  const Q = tab(d);
  await Q.ready();
  row = await saved(d.store, walk.id);
  assert.equal(row.owner.tab, Q.controller.recorder.tab);
  assert.match(Q.bar(), /^Recording paused/); assert.match(Q.bar(), /The page closed while recording\. The audio saved on this iPad is kept\./);
  await Q.tap('Finish', Q.footer); await Q.tap('Quote to follow'); await Q.tap('Save outcome');
  await d.clock.advance(5000);
  assert.deepEqual(d.audio.calls.map(call => call.size), [18000]);
  assert.deepEqual(d.server.posts().map(body => [body.action, body.recordingStatus]), [['finish', 'recorded']]);
  assert.equal((await d.store.sessions()).length, 0);
  // Without Web Locks, a walkthrough started for a Voice Memos recording belongs to no tab: the page closes, the next one loads
  // while the Hub session has expired, and once the rep signs in on the gate it is that page's to finish.
  let who = 'sales.rep';
  const e = iPad(), A = tab(e, { locks: null, who: () => who });
  await A.ready();
  await A.tap('Start walkthrough'); await A.tap('Recording OK: record in Voice Memos');
  await e.clock.advance(10 * 60 * 1000);
  A.controller.unmount(); A.timers.pause();
  who = '';
  const A2 = tab(e, { locks: null, who: () => who });
  await A2.ready(); await e.clock.advance(2000);
  who = 'sales.rep';
  A2.controller.check(); await A2.flush();
  assert.match(A2.bar(), /^Walkthrough \(not recorded\)/);
  assert.doesNotMatch(A2.bar() + A2.text(), /open in another tab/);
  await A2.tap('Finish', A2.footer);
  await addFile(A2, 'New Recording 11.m4a', 512);
  await A2.tap('Quote to follow'); await A2.tap('Save outcome');
  await e.clock.advance(5000);
  assert.deepEqual(e.server.posts().map(body => [body.action, body.recordingStatus]), [['start', 'failed_device'], ['finish', 'recorded']]);
  assert.deepEqual(e.audio.calls.map(call => [call.filename, call.size]), [['walkthrough-w1-part-1.m4a', 512]]);
  assert.equal((await e.store.sessions()).length, 0);
  A2.controller.unmount(); A2.timers.pause();
  // A part a page had on its way when it closed may be on the recording service: nothing can tell whether that page (or,
  // without Web Locks, another open tab) is still sending it, so a withdrawal names it with its upload ID. Withdrawn at once:
  const store = R.memoryStore(), left = await memoWalkthrough(store);
  await R.saveChange(store, left.id, draft => { draft.parts[0].sendingAt = at; });
  await R.withdrawSession(store, left.id, at);
  row = await saved(store, left.id);
  assert.deepEqual([row.consent, row.parts[0].state, row.parts[0].recordingId, row.parts[0].unconfirmed, row.parts[0].sendingAt ?? null], ['declined', 'uploaded_after_withdrawal', null, true, null]);
  assert.equal((await store.chunks(left.parts[0].id)).length, 0, 'its audio left the iPad');
  // Or after the next page tried to send it again (offline): it stays counted as possibly on the service.
  const memo = await memoWalkthrough(e.store, { name: 'New Recording 12.m4a' });
  await R.saveChange(e.store, memo.id, draft => { draft.parts[0].sendingAt = at; });
  e.audio.mode = 'offline';
  const B = tab(e, { locks: null });
  await B.ready(); await e.clock.advance(5000);
  row = await saved(e.store, memo.id);
  assert.deepEqual([row.owner ?? null, row.parts[0].state, row.parts[0].unconfirmed, row.parts[0].sendingAt ?? null], [null, 'closed', true, null], 'tried again under the same upload ID');
  await B.tap('Customer withdrew consent: delete the audio');
  const mayHave = `Part 1 (New Recording 12.m4a) may have reached the recording service before the withdrawal took effect: tell the office (upload ID ${memo.parts[0].requestId}).`;
  assert.ok(B.text().includes(`The audio still on this iPad was deleted (1 part). ${mayHave}`), B.text());
  const calls = e.audio.calls.length;
  e.audio.mode = 'ok'; await B.fire('online'); await e.clock.advance(60 * 60 * 1000);
  assert.equal(e.audio.calls.length, calls, 'nothing is sent after the withdrawal');
  assert.equal((await e.store.sessions()).length, 1, 'kept until the rep has told the office');
  await B.tap('I told the office', B.host.querySelector('.wt-decide'));
  assert.equal((await e.store.sessions()).length, 0);
});

// One visit API for several walkthrough visits (the default one knows only w1). started: visits already started elsewhere.
function visitsServer({ now, started = [] } = {}) {
  const servers = new Map();
  const of = visitId => { if (!servers.has(visitId)) { const one = visitServer({ now }); one.visit.id = visitId; if (started.includes(visitId)) one.visit.walkthroughVisit = { startedAt: new Date(T0).toISOString(), startedBy: 'other.rep', recordingStatus: 'recorded' }; servers.set(visitId, one); } return servers.get(visitId); };
  return { of, calls: [], posts: () => [...servers.values()].flatMap(one => one.posts()), state: visitId => of(visitId).state(visitId), post: body => of(body.visitId).post(body) };
}
// The Voice Memos walkthrough an earlier page could leave open beside the rep's own open recording (its import was not saved
// exclusively then): w2, started on another device, with its file on this iPad.
async function openMemo(store, tab) {
  const at = new Date(T0).toISOString(), walk = { id: id(), user: 'sales.rep', visitId: 'w2', customer: 'Second Customer', createdAt: at, startedAt: at, consent: 'recorded', capture: 'none', status: 'active', owner: { tab, at }, interruptions: [], actions: [],
    parts: [{ id: id(), index: 1, requestId: id(), mimeType: 'audio/mp4', extension: 'm4a', source: 'import', name: 'Second.m4a', startedAt: at, endedAt: at, bytes: 64, chunks: 1, reason: 'import', state: 'closed', recordingId: null, attempts: 0, serverFailures: 0, error: null }] };
  await store.putSession(walk);
  await store.putChunk({ id: `${walk.parts[0].id}|0000001`, partId: walk.parts[0].id, sessionId: walk.id, seq: 1, type: 'audio/mp4', bytes: 64, at, data: new Uint8Array(64).buffer });
  return walk;
}
async function saveOutcomeWithNotes(p) {
  await p.tap('Quote to follow');
  p.host.querySelectorAll('textarea').forEach((area, i) => { area.value = `Synthetic note ${i + 1}`; area.dispatchEvent({ type: 'input', target: area }); });
  await p.tap('Save outcome');
}

test('a Voice Memos file for a walkthrough started on another device is refused while the rep\'s own walkthrough is open (never a second open walkthrough), and is added once that outcome is saved', async () => {
  const clock = fakeClock(), server = visitsServer({ now: clock.now, started: ['w2'] }), p = page({ clock, server });
  await p.ready();
  await p.tap('Start walkthrough'); await p.tap('Recording OK');
  await clock.advance(10000);
  await p.show({ id: 'w2', customer: 'Second Customer' });
  await p.tap('Finish walkthrough');
  await addFile(p, 'Second.m4a');
  assert.match(p.text(), /Your walkthrough for Synthetic Customer is still open on this iPad: finish it first, then add this file \(or save this outcome first and add the file on its card\)\./);
  let rows = await p.store.sessions();
  assert.deepEqual(plain(rows.map(row => [row.visitId, row.status])), [['w1', 'active']], 'no second open walkthrough');
  assert.match(p.bar(), /^Recording ·/);
  // The rep saves this visit's outcome first (recorded elsewhere), then adds the file on its card: it uploads.
  await p.tap('Quote to follow'); await p.tap('Save outcome');
  await clock.advance(5000);
  assert.match(p.text(), /Outcome recorded: Quote to follow/);
  await addFile(p, 'Second.m4a');
  await clock.advance(5000);
  assert.deepEqual(p.audio.calls.map(call => [call.visitId, call.filename]), [['w2', 'walkthrough-w2-part-1.m4a']]);
  assert.equal(p.controller.recorder.status().capture, 'recording', 'the rep\'s own recording went on');
  rows = await p.store.sessions();
  assert.deepEqual(plain(rows.map(row => [row.visitId, row.status, row.parts.map(part => part.state)])), [['w1', 'active', ['recording']]]);
});

test('the Finish screen\'s "Customer withdrew consent" withdraws the walkthrough on that screen, never another open one, whichever the device storage lists first; the bar stays with the recording', async () => {
  for (const [tapOn, reversed] of [['w2', false], ['w2', true], ['w1', false], ['w1', true]]) {
    const clock = fakeClock(), server = visitsServer({ now: clock.now, started: ['w2'] }), base = R.memoryStore();
    // IndexedDB lists sessions in key order (random UUIDs): either walkthrough can come first.
    const store = reversed ? { ...base, persistent: base.persistent, sessions: async () => (await base.sessions()).reverse() } : base;
    const p = page({ clock, server, store });
    await p.ready();
    await p.tap('Start walkthrough'); await p.tap('Recording OK');
    await clock.advance(10000);
    const w1 = (await base.sessions())[0], memo = await openMemo(base, p.controller.recorder.tab);
    await p.fire('online');
    const label = `${tapOn}${reversed ? ' (listed second)' : ''}`;
    // The bar belongs to the recording, whichever walkthrough the storage lists first.
    await p.show({ id: 'w2', customer: 'Second Customer' });
    assert.match(p.bar(), /^Recording ·/, label);
    assert.match(p.bar(), /This walkthrough is for Synthetic Customer, not the one on screen\./, label);
    if (tapOn === 'w1') await p.show({ id: 'w1', customer: 'Synthetic Customer' });
    await p.tap(tapOn === 'w1' ? 'Finish' : 'Finish walkthrough', tapOn === 'w1' ? p.footer : p.host);
    assert.match(p.host.querySelector('#wt-finish-customer')?.textContent || '', tapOn === 'w1' ? /Synthetic Customer/ : /Second Customer/, label);
    await p.tap('Customer withdrew consent');
    const rows = plain(await base.sessions()), kept = tapOn === 'w1' ? memo : w1, gone = tapOn === 'w1' ? w1 : memo;
    assert.deepEqual([rows.find(row => row.id === gone.id).consent, rows.find(row => row.id === gone.id).parts], ['declined', []], label);
    assert.equal(rows.find(row => row.id === kept.id).consent, 'recorded', label);
    assert.deepEqual([...p.context.localStorage.values.keys()].filter(key => key.includes('withdrawn')), [`egc-wt-recorder:withdrawn:${tapOn}`], label);
    assert.equal((await base.chunks(gone.parts[0].id)).length, 0, `${label}: the withdrawn walkthrough's audio left the iPad`);
    assert.equal((await base.chunks(kept.parts[0].id)).length > 0, true, `${label}: the other walkthrough keeps its audio`);
    assert.equal(p.controller.recorder.status().capture, tapOn === 'w1' ? 'idle' : 'recording', label);
    assert.match(p.text(), /The audio was deleted from this iPad\./, label);
    // Both outcomes are saved and sent: only the walkthrough not withdrawn uploads, and only the withdrawn one says declined.
    for (const [visitId, customer] of [['w2', 'Second Customer'], ['w1', 'Synthetic Customer']]) {
      await p.show({ id: visitId, customer });
      if (p.buttons('Finish walkthrough').length) await p.tap('Finish walkthrough');
      else if (!p.buttons('Save outcome').length) await p.tap('Finish', p.footer);
      await saveOutcomeWithNotes(p);
    }
    await p.fire('online'); await clock.advance(120000);
    assert.deepEqual([...new Set(p.audio.calls.map(call => call.visitId))], [tapOn === 'w1' ? 'w2' : 'w1'], `${label}: uploads`);
    assert.deepEqual(server.posts().filter(body => body.action === 'finish').map(body => [body.visitId, body.recordingStatus]).sort(), [['w1', tapOn === 'w1' ? 'declined' : 'recorded'], ['w2', tapOn === 'w2' ? 'declined' : 'recorded']], label);
    assert.equal((await base.sessions()).length, 0, label);
  }
});

test('a walkthrough whose parts all uploaded and whose outcome waits still offers "Customer withdrew consent" (single tab); in another tab, its sync names each part it uploaded for a visit withdrawn elsewhere until "I told the office"', async () => {
  // One tab: every part uploaded, the outcome refused by the timecard. The card offers the withdrawal, which names the part.
  const clock = fakeClock(), server = visitServer({ now: clock.now }), p = page({ clock, server });
  server.visit.walkthroughVisit = { startedAt: new Date(T0).toISOString(), startedBy: 'sales.rep', recordingStatus: 'recorded' };
  const at = new Date(T0).toISOString(), walk = { id: id(), user: 'sales.rep', visitId: 'w1', customer: 'Synthetic Customer', createdAt: at, startedAt: at, consent: 'recorded', capture: 'stopped', status: 'finished', outcome: 'quote_to_follow', finishedAt: at, interruptions: [],
    parts: [{ id: id(), index: 1, requestId: id(), mimeType: 'audio/mp4', extension: 'm4a', source: 'recorder', startedAt: at, endedAt: at, bytes: 6000, chunks: 1, reason: 'finish', state: 'uploaded', recordingId: 'rec-synthetic-1', attempts: 1, serverFailures: 0, error: null }],
    actions: [{ id: id(), kind: 'finish', intent: { outcome: 'quote_to_follow', recordingStatus: 'recorded', deviceAt: at }, requestId: id(), body: { action: 'finish' }, state: 'error', error: { code: 'walkthrough_visit_clock_in_required', message: 'Clock in first.', status: 409, kind: 'rejected' }, attempts: 1, serverFailures: 0, rebases: 0 }] };
  await p.store.putSession(walk);
  await p.ready();
  assert.match(p.text(), /Outcome saved on this iPad: Quote to follow\. It needs your decision before it can be sent:/);
  await p.tap('Customer withdrew consent: delete the audio');
  assert.ok(p.text().includes('No audio of this walkthrough was left on this iPad. Part 1 was already uploaded: tell the office to delete it.'), p.text());
  assert.doesNotMatch(p.text(), /already sent as recorded/, 'the refused outcome saved nothing on the server');
  assert.ok(p.text().includes('Part 1 was uploaded before the withdrawal: tell the office (recording ID rec-synthetic-1).'), p.text());
  await p.tap('Save without changing my timecard');
  assert.deepEqual(server.posts().map(body => [body.action, body.recordingStatus, body.skipTimecard]), [['finish', 'declined', true]]);
  assert.equal((await p.store.sessions()).length, 1, 'kept until the rep has told the office');
  await p.tap('I told the office');
  assert.equal((await p.store.sessions()).length, 0);
  assert.equal(p.audio.calls.length, 0);
  // Two tabs: tab A holds a Voice Memos walkthrough of w1 (unsent); tab B holds another whose part was uploaded before the
  // withdrawal and whose outcome waits on the timecard. The rep withdraws the visit in tab A.
  const d = iPad(), locks = fakeLocks();
  d.server.visit.walkthroughVisit = { startedAt: at, startedBy: 'sales.rep', recordingStatus: 'recorded' };
  d.server.visit.walkthroughOutcome = { outcome: 'quote_to_follow', recordingStatus: 'recorded', finishedAt: at };
  d.audio.mode = 'offline';
  const A = tab(d, { locks }), B = tab(d, { locks });
  await A.ready(); await B.ready();
  await memoWalkthrough(d.store, { tab: A.controller.recorder.tab });
  const other = { ...plain(walk), id: id(), owner: { tab: B.controller.recorder.tab, at }, parts: [{ ...plain(walk.parts[0]), id: id(), source: 'import', name: 'Earlier.m4a', recordingId: 'rec-synthetic-2' }], actions: [{ ...plain(walk.actions[0]), id: id() }] };
  await d.store.putSession(other);
  await A.fire('online');
  await A.tap('Customer withdrew consent: delete the audio');
  const attempts = d.audio.calls.length;
  assert.ok(A.text().includes('The walkthrough of this visit started Sep 22, 9:00 AM is open in another tab on this iPad: no upload of it starts from now on. If a part of it was already uploaded, that tab names it with its recording ID until you tap “I told the office” there. To delete its audio still on this iPad, tap “Customer withdrew consent” in that tab.'), A.text());
  // Tab B runs again (the rep switches to it): its sync names the uploaded part, which keeps the walkthrough on the iPad even
  // once the outcome is dismissed, until "I told the office".
  await hideTab(A); await showTab(B); await d.clock.advance(1000);
  const named = 'Part 1 (Earlier.m4a) was uploaded before the withdrawal: tell the office (recording ID rec-synthetic-2).';
  assert.ok(B.text().includes(named), B.text());
  let row = (await d.store.sessions()).find(item => item.id === other.id);
  assert.deepEqual(plain(row.parts.map(part => [part.state, part.recordingId, part.uploadedBefore])), [['uploaded_after_withdrawal', 'rec-synthetic-2', true]]);
  assert.equal(B.buttons('Customer withdrew consent').length, 1, 'tab B offers the withdrawal, as tab A said');
  await B.tap('Dismiss');
  await d.clock.advance(60000);
  assert.ok((await d.store.sessions()).some(item => item.id === other.id), 'not gone before the rep told the office');
  await B.tap('Customer withdrew consent');
  assert.ok(B.text().includes(`No audio of this walkthrough was left on this iPad. ${named}`), B.text());
  await B.tap('I told the office');
  await d.clock.advance(5000);
  row = (await d.store.sessions()).find(item => item.id === other.id);
  assert.equal(row, undefined);
  d.audio.mode = 'ok'; await A.fire('online'); await B.fire('online'); await d.clock.advance(60000);
  assert.deepEqual([d.audio.calls.length, d.audio.saved.size], [attempts, 0], 'nothing of the withdrawn visit was sent after the tap');
});

test('without Web Locks two tabs may send the same walkthrough (no tab holds it): a part keeps its upload ID, so the service keeps it once, and a part one tab uploaded is never moved back by the other tab\'s failed attempt', async () => {
  const store = R.memoryStore(), server = visitServer(), clock = fakeClock(), service = audioService(), at = new Date(T0).toISOString();
  const walk = session({ status: 'finished', capture: 'none', owner: null, actions: [] });
  walk.parts = [1, 2].map(index => ({ id: `memo-${index}`, index, requestId: id(), mimeType: 'audio/mp4', extension: 'm4a', source: 'import', name: `Part ${index}.m4a`, startedAt: at, endedAt: at, bytes: 64, chunks: 1, reason: 'import', state: 'closed', recordingId: null, attempts: 0, serverFailures: 0, error: null }));
  await store.putSession(walk);
  for (const part of walk.parts) await store.putChunk({ id: `${part.id}|0000001`, partId: part.id, sessionId: walk.id, seq: 1, type: 'audio/mp4', bytes: 64, at, data: new Uint8Array(64).buffer });
  // Each upload waits for the test; tab Y's is refused once it goes on.
  const gates = [];
  const upload = tab => (request, progress) => new Promise((resolve, reject) => gates.push({ tab, part: request.filename.match(/part-(\d)/)[1], go: () => (tab === 'tab-y' ? reject(fail('Refused.', 409, 'recording_customer_link_missing')) : service.upload(request, progress).then(resolve, reject)) }));
  const sync = tab => R.createSync({ store, visit: server, upload: upload(tab), now: clock.now, uuid: id, user: () => 'sales.rep', tab });
  const open = (tab, part) => gates.splice(gates.findIndex(gate => gate.tab === tab && gate.part === part), 1)[0].go();
  const x = sync('tab-x').run(), y = sync('tab-y').run();
  await settle();
  assert.deepEqual(gates.map(gate => [gate.tab, gate.part]).sort(), [['tab-x', '1'], ['tab-y', '1']], 'both tabs send part 1');
  let row = await saved(store, walk.id);
  assert.equal(row.parts[0].unconfirmed, true, 'the second tab counts it as possibly on the service already');
  open('tab-x', '1'); await settle();
  row = await saved(store, walk.id);
  assert.deepEqual([row.parts[0].state, row.parts[0].unconfirmed, row.parts[0].sendingAt ?? null], ['uploaded', false, null]);
  open('tab-y', '1'); await y;
  row = await saved(store, walk.id);
  assert.deepEqual(row.parts.map(part => part.state), ['uploaded', 'closed'], 'the refusal that came after the upload changes nothing');
  open('tab-x', '2'); await x;
  assert.equal((await store.sessions()).length, 0, 'sent and cleared');
  assert.deepEqual([service.calls.length, service.saved.size], [2, 2], 'each part reached the service once');
});

test('without Web Locks two tabs that both save the outcome of one walkthrough save it once: the second tab is told it was saved there', async () => {
  const d = iPad(), X = tab(d, { locks: null });
  await X.ready();
  d.server.offline = true;
  await X.tap('Start walkthrough'); await X.tap('Recording OK: record in Voice Memos');
  const Y = tab(d, { locks: null });
  await Y.ready(); await d.clock.advance(1000);
  await X.tap('Finish', X.footer); await Y.tap('Finish', Y.footer);
  for (const [P, reason] of [[X, 'price'], [Y, 'timing']]) {
    await P.tap('Not interested');
    const select = P.host.querySelector('select'); select.value = reason; select.dispatchEvent({ type: 'change', target: select });
  }
  await X.tap('Save outcome'); await Y.tap('Save outcome');
  const row = (await d.store.sessions())[0];
  assert.deepEqual(row.actions.map(item => [item.kind, item.intent.reasonCode ?? null]), [['start', null], ['finish', 'price']], 'one outcome');
  assert.match(Y.text(), /This walkthrough’s outcome was already saved in another tab on this iPad\./);
  assert.match(Y.text(), /Outcome saved on this iPad: Not interested\./);
  d.server.offline = false; await X.fire('online'); await Y.fire('online'); await d.clock.advance(60000);
  assert.deepEqual(d.server.posts().filter(body => body.action === 'finish').map(body => body.reasonCode), ['price']);
  assert.doesNotMatch(X.text() + Y.text(), /needs your decision/);
  assert.equal((await d.store.sessions()).length, 0, 'sent and cleared');
});

test('without Web Locks a Voice Memos file added in one tab after another tab withdrew consent is refused in the write that would add it, and its audio leaves the iPad', async () => {
  // Tab X has not seen the withdrawal yet: its own list of withdrawn visits (localStorage, which Safari shares between tabs a
  // moment later) and its copy of the walkthrough are from before it.
  const d = iPad(), X = tab(d, { locks: null, localStore: storage() }), Y = tab(d, { locks: null });
  await X.ready();
  d.server.offline = true;
  await X.tap('Start walkthrough'); await X.tap('Recording OK: record in Voice Memos');
  await X.tap('Finish', X.footer);
  await addFile(X, 'New Recording 20.m4a', 64);
  await Y.controller.refresh(); await Y.fire('online'); await d.clock.advance(1000);
  await Y.tap('Finish', Y.footer);
  await Y.tap('Customer withdrew consent: delete the audio');
  let row = (await d.store.sessions())[0];
  assert.equal(row.consent, 'declined');
  await addFile(X, 'New Recording 21.m4a', 64);
  assert.match(X.text(), /The customer withdrew recording consent for this walkthrough, so no audio is uploaded for it\./);
  row = (await d.store.sessions())[0];
  assert.deepEqual(row.parts.filter(part => part.state !== 'removed').map(part => part.name), [], 'no part was added');
  let chunks = 0;
  for (const part of row.parts) chunks += (await d.store.chunks(part.id)).length;
  assert.equal(chunks, 0, 'no audio of the visit is left on the iPad');
});
