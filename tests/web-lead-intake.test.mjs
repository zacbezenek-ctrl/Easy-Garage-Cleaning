import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { webLeadHandlers } from '../functions/api/web-lead.js';
import { WEB_LEAD_HIGHLEVEL_DEADLINE_MS, WEB_LEAD_MAX_ATTEMPTS, WEB_LEAD_RECEIPTS, WEB_LEAD_RETRY_COST, WEB_LEAD_RETRY_WINDOW_MS, WEB_LEAD_SETTLE_ROUND_MS, WEB_LEAD_TICK_LIMIT_MS, openWebLead, receiveWebLead, retryWebLeadReceipts, syncHighLevelLead, webLeadDelayedSyncTagEnabled, webLeadSafeTagsEnabled, webLeadFormSource, webLeadMeta, webLeadRetryRunner, webLeadStorage } from '../functions/_lib/web-lead-intake.js';
import { SEAL_MAX_BYTES } from '../functions/_lib/purpose-keys.js';
import { funnelEventId } from '../functions/_lib/funnel-events.js';
import { sha256Hex, canonicalJson } from '../functions/_lib/funnel-definitions.js';
import { quietHoursDecision } from '../functions/_lib/message-policies.js';

// Synthetic data only. HighLevel and the Zapier hook are faked on globalThis.fetch,
// Firestore is an in-memory revisioned store, and every clock is injected.
const NOW = '2026-09-22T18:00:00.000Z'; // 12:00 in Denver
const LEDGER = Object.freeze({
  WEB_LEAD_RECEIPTS_ENABLED: 'true', FIREBASE_API_KEY: 'firebase-test-web-lead', HUB_SESSION_SECRET: 'synthetic-web-lead-session-secret-0123456789',
  HIGHLEVEL_API_KEY: 'synthetic-key', HIGHLEVEL_LOCATION_ID: 'location-1', HIGHLEVEL_PIPELINE_ID: 'pipe-1', HIGHLEVEL_USER_ID: 'user-1', WEBSITE_LEAD_HOOK_URL: 'https://hooks.example.test/lead',
});
const LEGACY = Object.freeze(Object.fromEntries(Object.entries(LEDGER).filter(([key]) => key !== 'WEB_LEAD_RECEIPTS_ENABLED')));
// The optional egc-delayed-sync tag is opt-in; LEDGER leaves it off, as production does until the owner asks for it.
const TAGGED = Object.freeze({ ...LEDGER, WEB_LEAD_DELAYED_SYNC_TAG: 'true' });
const lead = (overrides = {}) => ({
  name: 'Synthetic Walkthrough', phone: '(970) 555-0101', email: 'walkthrough@example.invalid', items: 'Garage Cleanout — Medium garage', service_type: 'Garage Cleanout',
  what_to_remove: 'Garage Cleanout — boxes', source: 'Website', city: 'Fort Collins', serviceZip: '80525', booking_slot: 'Tomorrow AM', flow_type: 'walkthrough', sms_consent: 'yes',
  utm_source: 'facebook', utm_medium: 'paid-social', fbclid: 'synthetic-click', landing_url: 'https://easygaragecleaning.com/book?fbclid=synthetic-click', page_url: 'https://easygaragecleaning.com/book', inquiry_id: randomUUID(), ...overrides,
});

function ledgerStore(log = []) {
  const rows = new Map(), revisions = new Map(), commits = [];
  // lossReadFailures: after a lost commit response, that many following reads fail too.
  // commitFailures: that many following commits fail without applying.
  const hooks = { readFails: false, commitFails: null, loseResponse: false, lossReadFailures: 0, readFailures: 0, commitFailures: 0 };
  let counter = 0;
  const view = (key, id) => ({ ...structuredClone(rows.get(key)), id, revision: revisions.get(key) });
  return {
    rows, commits, hooks, log,
    receipt: id => rows.get(`${WEB_LEAD_RECEIPTS}/${id}`) || null,
    events: () => [...rows].filter(([key]) => key.startsWith('funnelEvents/')).map(([, row]) => row),
    async read(collection, id) {
      await new Promise(resolve => setImmediate(resolve));
      if (hooks.readFails || hooks.readFailures > 0) {
        if (hooks.readFailures > 0) hooks.readFailures -= 1;
        throw Object.assign(new Error('Synthetic outage'), { code: 'web_lead_storage_unavailable', status: 503 });
      }
      const key = `${collection}/${id}`;
      return rows.has(key) ? view(key, id) : null;
    },
    async commit(writes) {
      await new Promise(resolve => setImmediate(resolve));
      log.push(`commit:${writes.map(write => write.collection).join('+')}`);
      if (hooks.commitFails) throw hooks.commitFails;
      if (hooks.commitFailures > 0) { hooks.commitFailures -= 1; throw Object.assign(new Error('Synthetic outage'), { code: 'web_lead_storage_unavailable', status: 503 }); }
      const keys = new Set();
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`;
        assert.ok(!keys.has(key), 'a commit never writes the same document twice');
        assert.notEqual(write.collection, 'leads', 'the legacy leads collection stays closed');
        keys.add(key);
        if (write.revision ? revisions.get(key) !== write.revision : rows.has(key)) throw Object.assign(new Error('Conflict'), { code: 'web_lead_revision_conflict', status: 409 });
      }
      for (const write of writes) {
        const key = `${write.collection}/${write.id}`;
        rows.set(key, { ...(rows.get(key) || {}), ...structuredClone(write.patch) });
        revisions.set(key, `rev-${++counter}`);
      }
      commits.push(structuredClone(writes));
      if (hooks.loseResponse) {
        hooks.loseResponse = false; hooks.readFailures = hooks.lossReadFailures; hooks.lossReadFailures = 0;
        throw Object.assign(new Error('Lost'), { code: 'web_lead_outcome_unknown', status: 503 });
      }
      return {};
    },
    async dueReceipts(nowIso, limit) {
      return [...rows].filter(([key, row]) => key.startsWith(`${WEB_LEAD_RECEIPTS}/`) && typeof row.retryAt === 'string' && row.retryAt <= nowIso)
        .sort(([, a], [, b]) => a.retryAt.localeCompare(b.retryAt)).slice(0, limit).map(([key]) => view(key, key.split('/')[1]));
    },
  };
}

// Fake HighLevel + Zapier. `state.fail` makes the contact upsert answer that status (or throw with 'throw');
// `state.failAt` fails any other path that way. The first upsert that succeeds creates contact-web (new: true),
// later ones find it. `state.opportunities` holds that contact's opportunities in the pipeline (status 'open'
// unless given): the search returns those of the requested status (every one for 'all'). Creation refuses
// duplicates rather than updating a worked opportunity. `state.onCall(path)` runs
// before each HighLevel answer (tests advance an injected clock there).
function providers(t, log = []) {
  const calls = [], state = { fail: null, failAt: null, created: false, opportunities: [], tags: [], contactResult: null, searchResult: null, createResult: null, onCall: null };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url), body = options.body ? JSON.parse(options.body) : null;
    if (href.startsWith('https://hooks.example.test/lead')) { log.push('relay'); calls.push({ kind: 'relay', url: href, body }); return new Response('{}', { status: 200 }); }
    assert.ok(href.startsWith('https://services.leadconnectorhq.com/'), `no other host is contacted: ${href}`);
    const path = href.slice('https://services.leadconnectorhq.com'.length);
    log.push(`ghl:${path.split('?')[0]}`); calls.push({ kind: 'ghl', path, method: options.method || 'GET', body, headers: options.headers });
    if (state.onCall) state.onCall(path);
    if (path === '/contacts/upsert') {
      if (state.fail === 'throw') throw new TypeError('network down');
      if (state.fail) return Response.json({ message: 'synthetic provider detail' }, { status: state.fail });
      const created = !state.created; state.created = true;
      return Response.json(state.contactResult || { contact: { id: 'contact-web', tags: state.tags }, new: created });
    }
    if (state.failAt && (state.failAt === '/opportunities/' ? path === state.failAt : path.startsWith(state.failAt))) return Response.json({ message: 'synthetic provider detail' }, { status: 503 });
    if (path === '/contacts/contact-web/tags') {
      if (options.method === 'POST') state.tags = [...new Set([...state.tags, ...body.tags])];
      else if (options.method === 'DELETE') state.tags = state.tags.filter(tag => !body.tags.includes(tag));
      else if (options.method === 'PUT') state.tags = body.tags;
      return Response.json({ tags: state.tags });
    }
    if (path.startsWith('/opportunities/search?')) {
      const status = new URL(path, 'https://x').searchParams.get('status');
      const found = state.opportunities.filter(row => status === 'all' || (row.status || 'open') === status);
      return Response.json(state.searchResult || { opportunities: found, meta: { total: found.length } });
    }
    if (path.startsWith('/opportunities/pipelines?')) return Response.json({ pipelines: [{ id: 'pipe-1', stages: [{ id: 'stage-new' }] }] });
    if (path === '/opportunities/') {
      // Creation must not update an existing deal, even if one raced the search.
      if (state.opportunities.some(row => row.contactId === body.contactId)) return Response.json({ message: 'Conflict' }, { status: 409 });
      state.opportunities.push({ id: 'opp-web', contactId: body.contactId, status: body.status, pipelineStageId: body.pipelineStageId });
      return Response.json(state.createResult || { opportunity: { id: 'opp-web' } });
    }
    assert.notEqual(path, '/opportunities/upsert', 'intake never upserts an opportunity');
    return Response.json({});
  });
  return { calls, state, ghl: () => calls.filter(call => call.kind === 'ghl'), relays: () => calls.filter(call => call.kind === 'relay') };
}

function endpoint(store, { at = NOW } = {}) {
  const clock = { at }, warnings = [];
  const handler = webLeadHandlers({ storage: () => store, now: () => new Date(clock.at), warn: message => warnings.push(message) });
  const post = async (body, env = LEDGER) => {
    const response = await handler.post({ request: new Request('https://easygaragecleaning.com/api/web-lead', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
    return { status: response.status, body: await response.json() };
  };
  return { post, clock, warnings };
}

const retry = (store, now, { dryRun = false, env = LEDGER } = {}) => retryWebLeadReceipts({ store, env, sync: (value, options) => syncHighLevelLead(env, value, undefined, options) }, { now: new Date(now), dryRun });
const tagsSent = fake => fake.ghl().filter(call => call.path === '/contacts/contact-web/tags').map(call => [call.method, call.body.tags]);
const LEAD_TAGS = ['PUT', ['egc-website-lead', 'egc-sms-consent']], DELAYED = ['POST', ['egc-delayed-sync']], CLEAR = ['DELETE', ['egc-delayed-sync']];
const notes = fake => fake.ghl().filter(call => call.path === '/contacts/contact-web/notes').map(call => call.body.body);
const opportunityCreates = fake => fake.ghl().filter(call => call.path === '/opportunities/').length;
const plus = minutes => new Date(Date.parse(NOW) + minutes * 60000).toISOString();

test('a website lead is receipted with its inquiry.received event in one commit before any HighLevel call, then synced and relayed once', async t => {
  const log = [], store = ledgerStore(log), fake = providers(t, log), { post } = endpoint(store), body = lead();
  const result = await post(body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual([result.body.ok, result.body.inquiryId, result.body.receipt, result.body.highlevel.synced, result.body.relay.sent], [true, body.inquiry_id, { status: 'synced' }, true, true]);
  assert.equal(log[0], 'commit:web_lead_receipts+funnelEvents', 'the receipt and its event are the first write, in one commit');
  assert.ok(log.indexOf('ghl:/contacts/upsert') > 0 && log.indexOf('relay') > log.indexOf('ghl:/opportunities/'));
  const created = store.commits[0].find(write => write.collection === WEB_LEAD_RECEIPTS).patch;
  assert.deepEqual([created.ghlSyncStatus, created.attempts, created.receivedAt, created.retryAt, created.payloadSealed], ['syncing', 1, NOW, plus(10), true]);
  assert.ok(created.sealedPayload?.ct, 'the lead waits in a sealed payload until HighLevel has it');
  assert.doesNotMatch(JSON.stringify(created), /Synthetic Walkthrough|555-0101|walkthrough@example|Fort Collins|synthetic-click/, 'the receipt never stores the lead in the clear');
  const opened = await openWebLead(LEDGER, body.inquiry_id, created.sealedPayload);
  assert.deepEqual([opened.name, opened.phone, opened.email, opened.inquiry_id], [body.name, body.phone, body.email, body.inquiry_id]);
  await assert.rejects(openWebLead(LEDGER, randomUUID(), created.sealedPayload), { code: 'purpose_seal_invalid' }, 'the payload is bound to its own receipt');

  const receipt = store.receipt(body.inquiry_id);
  assert.deepEqual([receipt.ghlSyncStatus, receipt.attempts, receipt.contactId, receipt.opportunityId, receipt.sealedPayload, receipt.retryAt, receipt.syncedAt, receipt.relayStatus], ['synced', 1, 'contact-web', 'opp-web', null, null, NOW, 'sent']);
  assert.deepEqual([receipt.formSource, receipt.pagePath, receipt.clientInquiryId], ['book', '/book', true]);
  const attribution = { utm_source: 'facebook', utm_medium: 'paid-social', utm_campaign: '', utm_content: '', utm_term: '', gclid: '', msclkid: '', fbclid: 'synthetic-click', fbc: '', fbp: '', landing_url: body.landing_url, referrer: '' };
  assert.equal(receipt.attributionHash, sha256Hex(canonicalJson(attribution)));
  const [event] = store.events();
  assert.equal(receipt.funnelEventId, funnelEventId('inquiry.received', { field: 'inquiryId', value: body.inquiry_id }, `requestId:${body.inquiry_id}`));
  assert.deepEqual([event.type, event.inquiryId, event.data, event.source, event.occurredAt, event.clockSource, event.denverDate, event.isTest, event.actor.kind, event.via], ['inquiry.received', body.inquiry_id, { origin: 'web_form' }, { collection: WEB_LEAD_RECEIPTS, id: body.inquiry_id }, NOW, 'server', '2026-09-22', false, 'customer', 'hub']);
  assert.doesNotMatch(JSON.stringify(event), /Synthetic Walkthrough|555-0101/);

  assert.equal(fake.relays().length, 1);
  assert.equal(fake.relays()[0].body.inquiry_id, body.inquiry_id, 'the Zap receives the inquiry id to use as the CAPI event_id');
  const note = fake.ghl().find(call => call.path === '/contacts/contact-web/notes');
  assert.match(note.body.body, new RegExp(`Inquiry ID: ${body.inquiry_id}`));
  assert.equal(note.headers['Idempotency-Key'], `website-lead-details:contact-web:${body.inquiry_id}`);
  assert.deepEqual(tagsSent(fake), [LEAD_TAGS], 'a lead synced as it arrives is not marked delayed, and a new contact has no mark to clear');
  assert.doesNotMatch(note.body.body, /Delivered late/);
});

test('the same submission sent again is the same inquiry: no second sync, text or event; changed details under the same id are refused', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store), body = lead();
  const copies = await Promise.all([post(body), post(body)]);
  // Whichever copy loses the create replays the receipt: accepted while the other syncs, or synced once it has.
  assert.deepEqual(copies.map(copy => copy.body.replayed === true).sort(), [false, true], 'exactly one copy receives the lead');
  assert.ok(copies.every(copy => [200, 202].includes(copy.status) && copy.body.ok && copy.body.inquiryId === body.inquiry_id));
  const replay = await post(body);
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.receipt.status, replay.body.inquiryId], [200, true, 'synced', body.inquiry_id]);
  assert.equal(fake.ghl().filter(call => call.path === '/contacts/upsert').length, 1);
  assert.equal(fake.relays().length, 1, 'the automatic text goes out once');
  assert.equal(store.events().length, 1);
  const changed = await post({ ...body, phone: '(970) 555-0199' });
  assert.deepEqual([changed.status, changed.body.code], [409, 'web_lead_idempotency_conflict']);
  assert.equal(fake.ghl().filter(call => call.path === '/contacts/upsert').length, 1);
});

test('a failed HighLevel sync is kept, not relayed, and retried on the tick until it syncs; the retry never texts', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store), body = lead();
  fake.state.fail = 500;
  const result = await post(body);
  assert.deepEqual([result.status, result.body.ok, result.body.accepted, result.body.receipt, result.body.highlevel.retry], [202, true, true, { status: 'failed' }, 'scheduled']);
  assert.doesNotMatch(JSON.stringify(result.body), /synthetic provider detail/);
  assert.equal(fake.relays().length, 0, 'as before, a failed sync sends no text');
  let receipt = store.receipt(body.inquiry_id);
  assert.deepEqual([receipt.ghlSyncStatus, receipt.attempts, receipt.lastError, receipt.retryAt, receipt.relayStatus, Boolean(receipt.sealedPayload)], ['failed', 1, 'highlevel_unavailable', plus(5), null, true]);
  assert.equal(store.events().length, 1, 'the inquiry is counted even though the CRM does not have it yet');

  assert.deepEqual(await retry(store, plus(4)).then(summary => [summary.due, summary.attempted]), [0, 0], 'not due before the backoff');
  const dry = await retry(store, plus(5), { dryRun: true });
  assert.deepEqual([dry.due, dry.attempted, dry.notAttempted], [1, 0, 1]);
  assert.equal(store.receipt(body.inquiry_id).attempts, 1, 'a dry run changes nothing');

  fake.state.fail = null;
  const tick = await retry(store, plus(6));
  assert.deepEqual([tick.due, tick.attempted, tick.synced, tick.failed], [1, 1, 1, 0]);
  receipt = store.receipt(body.inquiry_id);
  assert.deepEqual([receipt.ghlSyncStatus, receipt.attempts, receipt.contactId, receipt.sealedPayload, receipt.retryAt, receipt.syncedAt, receipt.lastError], ['synced', 2, 'contact-web', null, null, plus(6), null]);
  assert.equal(fake.relays().length, 0, 'a retry never sends the automatic text');
  // The tag is opt-in (see the WEB_LEAD_DELAYED_SYNC_TAG tests): by default the retry tags the contact exactly as an on-time sync.
  assert.deepEqual(tagsSent(fake), [LEAD_TAGS], 'without WEB_LEAD_DELAYED_SYNC_TAG a retried sync adds no tag of its own');
  assert.deepEqual([receipt.delayedTag, receipt.opportunityId, receipt.opportunitySkipped], [null, 'opp-web', null], 'the retry created this contact, so it opens the lead\'s opportunity');
  assert.match(notes(fake)[0], /^EGC WEBSITE LEAD DETAILS\nDelivered late by the Hub retry/);
  assert.equal((await retry(store, plus(60))).due, 0, 'a synced receipt is never due again');
  assert.equal(store.events().length, 1);
});

test('retries back off, stop after the attempt limit, and never run during Denver quiet hours', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store), body = lead();
  fake.state.fail = 'throw';
  await post(body);
  const night = await retry(store, '2026-09-23T09:00:00.000Z'); // 03:00 in Denver
  assert.deepEqual([night.deferred, night.due, store.receipt(body.inquiry_id).attempts], ['quiet_hours', 0, 1]);
  let at = Date.parse('2026-09-23T15:00:00.000Z'); // 09:00 in Denver
  const gaps = [];
  for (let tick = 0; tick < 20 && store.receipt(body.inquiry_id).ghlSyncStatus === 'failed'; tick += 1) {
    const due = store.receipt(body.inquiry_id).retryAt;
    at = Math.max(at, Date.parse(due));
    // A retry that falls due overnight runs at the next 09:00 in Denver.
    if (!quietHoursDecision(new Date(at)).allowed) at = Date.parse(new Date(at).toISOString().slice(0, 10) + 'T15:00:00.000Z') + (new Date(at).getUTCHours() >= 15 ? 86400000 : 0);
    const before = store.receipt(body.inquiry_id).attempts;
    await retry(store, new Date(at).toISOString());
    const after = store.receipt(body.inquiry_id);
    assert.equal(after.attempts, before + 1);
    if (after.ghlSyncStatus === 'failed') gaps.push((Date.parse(after.retryAt) - at) / 60000);
  }
  const receipt = store.receipt(body.inquiry_id), abandonedAt = new Date(at).toISOString(), purgeAt = new Date(at + 30 * 86400000).toISOString();
  assert.deepEqual([receipt.ghlSyncStatus, receipt.abandonReason, receipt.attempts, receipt.abandonedAt, receipt.lastError], ['abandoned', 'attempts_exhausted', WEB_LEAD_MAX_ATTEMPTS, abandonedAt, 'highlevel_unavailable']);
  assert.deepEqual(gaps, [15, 45, 120, 360, 720, 1440], 'each failure waits longer');
  assert.ok(receipt.sealedPayload, 'an abandoned lead stays sealed for the owner to recover');
  assert.equal(receipt.retryAt, purgeAt, 'for 30 days');
  assert.equal(fake.relays().length, 0);
  // The retention ends on the first tick after 30 days: the payload is deleted and nothing is synced.
  const upserts = fake.ghl().length;
  const early = await retry(store, new Date(at + 30 * 86400000 - 60000).toISOString());
  assert.deepEqual([early.due, early.purged, Boolean(store.receipt(body.inquiry_id).sealedPayload)], [0, 0, true]);
  const dry = await retry(store, purgeAt, { dryRun: true });
  assert.deepEqual([dry.due, dry.purged, dry.notAttempted, Boolean(store.receipt(body.inquiry_id).sealedPayload)], [1, 0, 1, true]);
  const purged = await retry(store, purgeAt);
  assert.deepEqual([purged.due, purged.purged, purged.attempted], [1, 1, 0]);
  const kept = store.receipt(body.inquiry_id);
  assert.deepEqual([kept.ghlSyncStatus, kept.abandonReason, kept.sealedPayload, kept.retryAt, kept.payloadPurgedAt, kept.attempts], ['abandoned', 'attempts_exhausted', null, null, purgeAt, WEB_LEAD_MAX_ATTEMPTS]);
  assert.equal(fake.ghl().length, upserts, 'deleting the payload never contacts HighLevel');
  assert.equal((await retry(store, new Date(at + 60 * 86400000).toISOString())).due, 0, 'a purged receipt is never due again');
});

test('a lost worker, a lost claim race and a rejected lead are all settled safely', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store), body = lead();
  // The worker died between the receipt and the sync: the claim expires and the tick finishes it.
  fake.state.fail = 'throw';
  await post(body);
  const row = store.receipt(body.inquiry_id);
  store.rows.set(`${WEB_LEAD_RECEIPTS}/${body.inquiry_id}`, { ...row, ghlSyncStatus: 'syncing', retryAt: plus(10) });
  fake.state.fail = null;
  assert.equal((await retry(store, plus(9))).due, 0, 'an in-flight claim is left alone');
  const upserts = () => fake.ghl().filter(call => call.path === '/contacts/upsert').length, before = upserts();
  const [a, b] = await Promise.all([retry(store, plus(11)), retry(store, plus(11))]);
  assert.equal(a.synced + b.synced, 1, 'two ticks racing for one receipt sync it once');
  assert.equal(a.skipped + b.skipped, 1);
  assert.equal(upserts(), before + 1);
  assert.deepEqual([store.receipt(body.inquiry_id).ghlSyncStatus, store.receipt(body.inquiry_id).attempts], ['synced', 2]);
  // HighLevel rejects the lead outright: it is retried like any other failure, with a stored code only.
  const rejected = lead();
  fake.state.fail = 422;
  const result = await post(rejected);
  assert.equal(store.receipt(rejected.inquiry_id).lastError, 'highlevel_rejected');
  assert.equal(result.status, 202);
});

test('ads landing page leads are receipted and counted but stay out of HighLevel and the text relay until the owner opens them', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store);
  const ads = lead({ page_url: 'https://easygaragecleaning.com/ads?fbclid=synthetic-click', source: 'Ads Landing Page', serviceZip: '80525', items: 'Ads landing lead (in service area)' });
  const held = await post(ads);
  assert.deepEqual([held.status, held.body.held, held.body.receipt], [202, 'ads_relay_disabled', { status: 'held' }]);
  const receipt = store.receipt(ads.inquiry_id);
  assert.deepEqual([receipt.ghlSyncStatus, receipt.holdReason, receipt.formSource, receipt.pagePath, receipt.sealedPayload, receipt.retryAt, receipt.attempts], ['held', 'ads_relay_disabled', 'ads_landing', '/ads', null, null, 0]);
  assert.equal(store.events().length, 1, 'the inquiry still counts');
  assert.deepEqual([fake.ghl().length, fake.relays().length], [0, 0]);
  assert.equal((await retry(store, plus(60))).due, 0, 'a held lead is never retried');
  // Without the ledger the gate still holds.
  const legacy = await post(lead({ page_url: 'https://easygaragecleaning.com/ads.html' }), LEGACY);
  assert.deepEqual([legacy.status, legacy.body.held, fake.ghl().length, fake.relays().length], [202, 'ads_relay_disabled', 0, 0]);
  // Opened: the ads page behaves like every other website form.
  const open = await post(lead({ page_url: 'https://easygaragecleaning.com/ads' }), { ...LEDGER, WEB_LEAD_ADS_RELAY_ENABLED: 'true' });
  assert.deepEqual([open.status, open.body.receipt.status, fake.relays().length], [200, 'synced', 1]);
  // An ads lead accepted while the gate was open, whose first sync failed, is not synced once the gate has
  // closed: it is abandoned like any lead the Hub gives up on, and its sealed lead is kept 30 days for the owner.
  fake.state.fail = 500;
  const later = lead({ page_url: 'https://easygaragecleaning.com/ads' });
  await post(later, { ...LEDGER, WEB_LEAD_ADS_RELAY_ENABLED: 'true' });
  fake.state.fail = null;
  const upserts = fake.ghl().length;
  const tick = await retry(store, plus(6));
  const stopped = store.receipt(later.inquiry_id), purgeAt = new Date(Date.parse(plus(6)) + 30 * 86400000).toISOString();
  assert.deepEqual([tick.held, tick.abandoned, tick.attempted], [1, 0, 0], 'the closed gate is the owner\'s choice, counted apart from sync failures');
  assert.deepEqual([stopped.ghlSyncStatus, stopped.abandonReason, stopped.abandonedAt, stopped.retryAt, Boolean(stopped.sealedPayload)], ['abandoned', 'ads_relay_disabled', plus(6), purgeAt, true]);
  assert.deepEqual((await openWebLead(LEDGER, later.inquiry_id, stopped.sealedPayload)).name, later.name, 'the owner can still recover it');
  assert.equal(fake.ghl().length, upserts, 'nothing reaches HighLevel while the gate is closed');
  const reopened = await retryWebLeadReceipts({ store, env: { ...LEDGER, WEB_LEAD_ADS_RELAY_ENABLED: 'true' }, sync: (value, options) => syncHighLevelLead(LEDGER, value, undefined, options) }, { now: new Date(plus(60)) });
  assert.deepEqual([reopened.due, fake.ghl().length], [0, upserts], 'it is not retried again, even once the gate reopens');
  const purged = await retry(store, purgeAt);
  assert.deepEqual([purged.purged, store.receipt(later.inquiry_id).sealedPayload, store.receipt(later.inquiry_id).payloadPurgedAt], [1, null, purgeAt], 'and it is deleted after the same 30 days as every other abandoned lead');
});

test('client hub help is receipted without an inquiry event; synthetic routing leads are marked test', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store);
  const help = lead({ flow_type: 'client_hub_help', source: 'Client Hub Help', service_type: 'Client hub help', page_url: 'https://easygaragecleaning.com/customer-portal' });
  const result = await post(help);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual([store.receipt(help.inquiry_id).formSource, store.receipt(help.inquiry_id).funnelEventId, store.events().length], ['client_hub_help', null, 0]);
  assert.equal(fake.ghl().some(call => call.path === '/opportunities/'), false);
  const canary = lead({ source: 'EGC synthetic routing validation' });
  await post(canary);
  assert.deepEqual(store.events().map(event => [event.isTest, event.exclusion]), [[true, 'synthetic_source']]);
});

test('without an inquiry id the ledger assigns one; an unavailable ledger falls back to the direct sync and says so', async t => {
  const store = ledgerStore(), fake = providers(t), { post, warnings } = endpoint(store);
  const { inquiry_id, ...anonymous } = lead();
  const assigned = await post(anonymous);
  assert.equal(assigned.status, 200);
  assert.match(assigned.body.inquiryId, /^[0-9a-f-]{36}$/);
  assert.equal(store.receipt(assigned.body.inquiryId).clientInquiryId, false);
  store.hooks.readFails = true;
  const fallback = await post(lead());
  assert.deepEqual([fallback.status, fallback.body.receipt, fallback.body.highlevel.synced, fallback.body.relay.sent], [200, { status: 'unavailable' }, true, true]);
  assert.deepEqual(warnings, ['{"event":"web_lead_receipt_unavailable"}'], 'a lead without a receipt leaves a count-only marker and no lead data');
  store.hooks.readFails = false;
  // A lost response on the receipt commit is resolved by the re-read: one receipt, one sync.
  const lost = lead();
  store.hooks.loseResponse = true;
  const resolved = await post(lost);
  assert.deepEqual([resolved.status, store.receipt(lost.inquiry_id).ghlSyncStatus], [200, 'synced']);
  assert.equal(fake.relays().length, 3);
  assert.equal(warnings.length, 1);
});

test('a missing purpose key still receipts and counts the lead; a failed sync without a sealed payload is left for the owner', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store), body = lead();
  const { HUB_SESSION_SECRET, ...unkeyed } = LEDGER;
  fake.state.fail = 500;
  const result = await post(body, unkeyed);
  assert.deepEqual([result.status, result.body.receipt.status, result.body.highlevel.retry], [202, 'abandoned', 'unavailable']);
  const receipt = store.receipt(body.inquiry_id);
  assert.deepEqual([receipt.payloadSealed, receipt.ghlSyncStatus, receipt.abandonReason, receipt.retryAt, receipt.abandonedAt], [false, 'abandoned', 'payload_unavailable', null, NOW]);
  assert.equal(store.events().length, 1);
});

test('a lead near the 32 KB body limit, in multi-byte characters, is sealed, survives a failed sync and syncs on the retry', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store);
  // A Facebook-ad landing URL, a first name with no space (the relay copies it into lead_first_name), and the
  // removal request twice (items and what_to_remove), padded with 3- and 4-byte characters up to the body limit.
  const fbclid = `IwZXh0bgNhZW0BMABhZGlk${'Aa0_'.repeat(200)}`, url = `https://easygaragecleaning.com/book?utm_source=facebook&utm_medium=paid-social&fbclid=${fbclid}`;
  const request = `車庫の片付けと不用品回収をお願いします。🧰📦 ${'古い棚、段ボール、工具、自転車。'.repeat(200)}`;
  const body = lead({ name: '合成テスト名前'.repeat(200), items: request, what_to_remove: request, photo_description: '写真🚗'.repeat(1500), fbclid, landing_url: url, page_url: url });
  body.subject = '大'.repeat(32 * 1024 - 32 - JSON.stringify(body).length);
  const raw = JSON.stringify(body), bytes = Buffer.byteLength(raw);
  assert.ok(raw.length <= 32 * 1024 && raw.length > 32 * 1024 - 64 && bytes > 80000, `${raw.length} characters, ${bytes} UTF-8 bytes`);
  fake.state.fail = 500;
  const result = await post(body);
  assert.deepEqual([result.status, result.body.accepted, result.body.receipt, result.body.highlevel.retry], [202, true, { status: 'failed' }, 'scheduled']);
  const kept = store.receipt(body.inquiry_id);
  assert.deepEqual([kept.payloadSealed, kept.ghlSyncStatus], [true, 'failed']);
  assert.ok(kept.sealedPayload.ct.length > 25 * 4096, `a ${kept.sealedPayload.ct.length}-character ciphertext, far past the 4096-character token limit`);
  assert.equal((await openWebLead(LEDGER, body.inquiry_id, kept.sealedPayload)).what_to_remove, request);
  fake.state.fail = null;
  const tick = await retry(store, plus(6));
  assert.deepEqual([tick.attempted, tick.synced, tick.abandoned], [1, 1, 0], JSON.stringify(tick));
  const receipt = store.receipt(body.inquiry_id);
  assert.deepEqual([receipt.ghlSyncStatus, receipt.sealedPayload, receipt.contactId, receipt.opportunityId], ['synced', null, 'contact-web', 'opp-web']);
  const upsert = fake.ghl().find(call => call.path === '/contacts/upsert' && call.body.name === body.name);
  assert.equal(upsert.body.phone, body.phone, 'HighLevel receives the whole lead from the sealed copy');
  assert.match(notes(fake)[0], /Removal request: 車庫の片付け/);
});

test('client hub help: a failed sync the cron will retry is accepted as queued; one nothing can retry fails where the customer sees it', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store);
  // The reviewer's case: a 1,560-character message, sent as both items and what_to_remove, with no inquiry id.
  const message = 'My garage door opener stopped working after the crew visit and I also have questions about the invoice. '.repeat(15);
  const { inquiry_id, ...help } = lead({ name: 'Portal Customer', items: message, what_to_remove: message, service_type: 'Client hub help', source: 'Client Hub Help', subject: 'Client hub help request', flow_type: 'client_hub_help', sms_consent: 'no', request_id: 'hub-help-synthetic-1', page_url: 'https://easygaragecleaning.com/customer-portal?token=synthetic' });
  fake.state.fail = 500;
  const queued = await post(help);
  assert.deepEqual([queued.status, queued.body.ok, queued.body.accepted, queued.body.receipt, queued.body.highlevel.retry], [202, true, true, { status: 'failed' }, 'scheduled'], 'the portal can tell a queued message from one HighLevel already has');
  fake.state.fail = null;
  const tick = await retry(store, plus(6));
  assert.deepEqual([tick.synced, tick.abandoned, store.receipt(queued.body.inquiryId).ghlSyncStatus], [1, 0, 'synced']);
  const comment = fake.ghl().find(call => call.path === '/conversations/messages');
  assert.equal(comment.body.message, `Client hub help request from Portal Customer: ${message}\nPhone: ${help.phone}\nEmail: ${help.email}`.slice(0, 1200));
  assert.equal(opportunityCreates(fake), 0);
  // Without a purpose key nothing can retry it, and there is no Web3Forms copy: it fails as before, so the customer resends.
  const { HUB_SESSION_SECRET, ...unkeyed } = LEDGER;
  fake.state.fail = 500;
  const lost = await post({ ...help, request_id: 'hub-help-synthetic-2' }, unkeyed);
  assert.deepEqual(lost, { status: 502, body: { ok: false, error: 'HighLevel lead sync failed' } });
  const [abandoned] = [...store.rows].filter(([key, row]) => key.startsWith(`${WEB_LEAD_RECEIPTS}/`) && row.payloadSealed === false).map(([, row]) => row);
  assert.deepEqual([abandoned.ghlSyncStatus, abandoned.abandonReason, abandoned.retryAt], ['abandoned', 'payload_unavailable', null]);
  // With no HighLevel configured and no text relay either, it answers 503 exactly as the legacy relay does.
  const { HIGHLEVEL_API_KEY, ...nowhere } = unkeyed;
  const unconfigured = await post({ ...help, request_id: 'hub-help-synthetic-3' }, nowhere);
  const legacy = await post({ ...help, request_id: 'hub-help-synthetic-3' }, Object.fromEntries(Object.entries(nowhere).filter(([key]) => key !== 'WEB_LEAD_RECEIPTS_ENABLED')));
  assert.deepEqual(unconfigured, { status: 503, body: { ok: false, error: 'Lead destinations are not configured' } });
  assert.deepEqual(unconfigured, legacy);
});

test('client hub help that HighLevel refuses outright answers as the legacy relay did and is not retried behind the customer\'s back', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store);
  const message = 'My garage door opener stopped working after the crew visit.';
  const { inquiry_id, ...help } = lead({ name: 'Portal Customer', items: message, what_to_remove: message, service_type: 'Client hub help', source: 'Client Hub Help', subject: 'Client hub help request', flow_type: 'client_hub_help', sms_consent: 'yes', request_id: 'hub-help-synthetic-422', page_url: 'https://easygaragecleaning.com/customer-portal?token=synthetic' });
  // A 422 is not a failure a retry can fix: the cron would repeat it for ~45 hours while the portal said the message was on its way.
  fake.state.fail = 422;
  const refused = await post(help);
  assert.deepEqual(refused, { status: 502, body: { ok: false, error: 'HighLevel lead sync failed' } }, 'the portal shows the failure, so the customer resends or calls');
  assert.deepEqual(await post(help, LEGACY), refused, 'exactly the legacy answer');
  assert.equal(fake.relays().length, 0, 'a failed sync sends no text, as before');
  const [receipt] = [...store.rows].filter(([key]) => key.startsWith(`${WEB_LEAD_RECEIPTS}/`)).map(([, row]) => row);
  const purgeAt = new Date(Date.parse(NOW) + 30 * 86400000).toISOString();
  assert.deepEqual([receipt.formSource, receipt.ghlSyncStatus, receipt.abandonReason, receipt.lastError, receipt.abandonedAt, receipt.retryAt, receipt.payloadSealed], ['client_hub_help', 'abandoned', 'highlevel_rejected', 'highlevel_rejected', NOW, purgeAt, true]);
  // Nothing retries it, so a resend is never followed by a late duplicate; the sealed copy is kept for the owner for 30 days.
  fake.state.fail = null;
  const calls = fake.ghl().length;
  for (const minutes of [6, 60, 24 * 60]) assert.deepEqual(await retry(store, plus(minutes)).then(tick => [tick.due, tick.attempted]), [0, 0]);
  assert.equal(fake.ghl().length, calls, 'HighLevel is not contacted again');
  assert.equal((await openWebLead(LEDGER, receipt.inquiryId, receipt.sealedPayload)).what_to_remove, message);
  // A website lead HighLevel refuses still waits for a retry (a fixed key or stage lets it through; the Web3Forms email has it meanwhile).
  fake.state.fail = 422;
  const website = await post(lead());
  assert.deepEqual([website.status, website.body.receipt.status, website.body.highlevel.retry], [202, 'failed', 'scheduled']);
});

test('client hub help HighLevel refuses is answered 202 queued when its abandonment cannot be saved, because the cron still owns the receipt', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store);
  const message = 'Please send me a fresh project link.';
  const help = lead({ name: 'Portal Customer', items: message, what_to_remove: message, service_type: 'Client hub help', source: 'Client Hub Help', subject: 'Client hub help request', flow_type: 'client_hub_help', sms_consent: 'yes', request_id: 'hub-help-synthetic-settle', page_url: 'https://easygaragecleaning.com/customer-portal?token=synthetic' });
  // The receipt is created; then HighLevel refuses the contact (a rotated API key, say), and every settle write fails.
  fake.state.fail = 401;
  fake.state.onCall = () => { store.hooks.commitFailures = 3; };
  const queued = await post(help);
  fake.state.onCall = null;
  assert.equal(store.hooks.commitFailures, 0, 'all three settle rounds tried to write and failed');
  assert.deepEqual([queued.status, queued.body.ok, queued.body.accepted, queued.body.receipt, queued.body.highlevel.retry], [202, true, true, { status: 'failed' }, 'scheduled'], 'not the legacy 502: the customer\'s resend would be followed by the cron\'s own late sync of this message');
  let receipt = store.receipt(help.inquiry_id);
  assert.deepEqual([receipt.ghlSyncStatus, receipt.abandonReason, receipt.retryAt, receipt.attempts, Boolean(receipt.sealedPayload)], ['syncing', null, plus(10), 1, true], 'the receipt is still due once its claim expires');
  assert.equal(fake.relays().length, 0, 'a failed sync sends no text, as before');
  // The cron takes it over after the 10-minute claim; with the key restored, the message reaches the team once.
  fake.state.fail = null;
  assert.equal((await retry(store, plus(9))).due, 0);
  assert.deepEqual(await retry(store, plus(11)).then(tick => [tick.attempted, tick.synced]), [1, 1]);
  receipt = store.receipt(help.inquiry_id);
  assert.deepEqual([receipt.ghlSyncStatus, receipt.sealedPayload, receipt.attempts], ['synced', null, 2]);
  assert.equal(fake.ghl().filter(call => call.path === '/conversations/messages').length, 1);
  assert.equal(fake.relays().length, 0, 'the retry never texts');
  // The same refusal whose abandonment is saved still answers exactly as the legacy relay did.
  fake.state.fail = 401;
  const refused = await post({ ...help, inquiry_id: randomUUID(), request_id: 'hub-help-synthetic-settle-2' });
  assert.deepEqual(refused, { status: 502, body: { ok: false, error: 'HighLevel lead sync failed' } });
});

test('each HighLevel failure status: hub help refused outright fails as the legacy relay did; every other failure is queued for a retry', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store);
  const help = { name: 'Portal Customer', phone: '(970) 555-0101', items: 'help', what_to_remove: 'help', service_type: 'Client hub help', source: 'Client Hub Help', flow_type: 'client_hub_help', sms_consent: 'yes', request_id: 'hub-help-1', page_url: 'https://easygaragecleaning.com/customer-portal' };
  const web = { name: 'Jane Doe', phone: '(970) 555-0101', items: 'Garage', sms_consent: 'yes', page_url: 'https://easygaragecleaning.com/book' };
  const purgeAt = new Date(Date.parse(NOW) + 30 * 86400000).toISOString();
  // Refused: a 4xx other than 408/429. The hub help receipt is abandoned at once and its sealed copy kept 30 days.
  const refused = { status: 502, ghlSyncStatus: 'abandoned', abandonReason: 'highlevel_rejected', lastError: 'highlevel_rejected', retryAt: purgeAt };
  const queued = lastError => ({ status: 202, ghlSyncStatus: 'failed', abandonReason: null, lastError, retryAt: plus(5) });
  const [rejected, unavailable] = [queued('highlevel_rejected'), queued('highlevel_unavailable')];
  const table = [
    // status, hub help, website lead
    [400, refused, rejected],
    [401, refused, rejected],
    [403, refused, rejected],
    [404, refused, rejected],
    [408, unavailable, unavailable],
    [422, refused, rejected],
    [429, unavailable, unavailable],
    [500, unavailable, unavailable],
    [503, unavailable, unavailable],
  ];
  for (const [status, helpExpect, webExpect] of table) {
    fake.state.fail = status;
    for (const [kind, body, expect] of [['hub help', help, helpExpect], ['website lead', web, webExpect]]) {
      const inquiryId = randomUUID(), result = await post({ ...body, inquiry_id: inquiryId }), receipt = store.receipt(inquiryId);
      assert.deepEqual({ status: result.status, ghlSyncStatus: receipt.ghlSyncStatus, abandonReason: receipt.abandonReason, lastError: receipt.lastError, retryAt: receipt.retryAt }, expect, `${status} ${kind}`);
      if (expect.status === 502) assert.deepEqual(result.body, { ok: false, error: 'HighLevel lead sync failed' }, `${status} ${kind}`);
      else assert.deepEqual([result.body.accepted, result.body.receipt, result.body.highlevel.retry], [true, { status: 'failed' }, 'scheduled'], `${status} ${kind}`);
      assert.equal(Boolean(receipt.sealedPayload), true, `${status} ${kind}: the lead stays sealed for a retry or for the owner`);
      assert.equal((await post(body, LEGACY)).status, 502, `${status} ${kind}: the legacy relay fails every one`);
    }
  }
  assert.equal(fake.relays().length, 0, 'a failed sync never texts');
});

test('a copy whose create loses to a concurrent copy never syncs or texts, even when the receipt cannot be re-read; a resend replays it', async t => {
  const store = ledgerStore(), fake = providers(t), { post, warnings } = endpoint(store), body = lead();
  // The first copy of a double tap receives the lead: one sync, one text.
  const owner = await post(body);
  assert.deepEqual([owner.status, owner.body.receipt.status, fake.relays().length], [200, 'synced', 1]);
  // The second copy read before the first created the receipt, so its own create-only commit is refused by the
  // store (the receipt exists), and the re-read that would show it fails.
  const read = store.read.bind(store), outage = () => Object.assign(new Error('Synthetic outage'), { code: 'web_lead_storage_unavailable', status: 503 });
  let reads = 0;
  store.read = async (collection, id) => { reads += 1; if (reads === 1) return null; if (reads === 2) throw outage(); return read(collection, id); };
  const commits = store.commits.length, calls = fake.ghl().length;
  const copy = await post(body);
  assert.deepEqual(copy, { status: 503, body: { ok: false, code: 'web_lead_receipt_busy', error: 'This inquiry is already being received. Send it again in a moment to check on it.' } });
  assert.equal(reads, 2);
  assert.deepEqual([store.commits.length, fake.ghl().length, fake.relays().length], [commits, calls, 1], 'no direct sync and no second text');
  assert.deepEqual(warnings, [], 'the lead has its receipt, so there is no receipt-unavailable marker');
  assert.deepEqual([store.receipt(body.inquiry_id).ghlSyncStatus, store.receipt(body.inquiry_id).attempts], ['synced', 1]);
  const resend = await post(body);
  assert.deepEqual([resend.status, resend.body.replayed, resend.body.receipt.status, fake.ghl().length, fake.relays().length], [200, true, 'synced', calls, 1]);
});

test('a retry keeps to the tick: its HighLevel calls end by 75 s, a sync out of time fails whole and is retried, and a second settle round runs only while it fits', async t => {
  // The worst case the limits allow: a retry starting just inside the 30 s window, its claim at the 20 s Firestore
  // timeout, then one settle round of a read and a write at their 20 s timeouts, all inside the worker's 120 s.
  // The retries sync with WEB_LEAD_DELAYED_SYNC_TAG on, whose extra tag call makes them the longest there are.
  assert.ok(WEB_LEAD_RETRY_WINDOW_MS + 20000 < WEB_LEAD_HIGHLEVEL_DEADLINE_MS);
  assert.deepEqual([WEB_LEAD_HIGHLEVEL_DEADLINE_MS + WEB_LEAD_SETTLE_ROUND_MS, WEB_LEAD_SETTLE_ROUND_MS], [WEB_LEAD_TICK_LIMIT_MS, 2 * 20000]);
  assert.ok(WEB_LEAD_TICK_LIMIT_MS <= 120000 - 5000);
  const fake = providers(t), timeouts = [], original = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return original.call(AbortSignal, ms); });
  const failFirst = async (store, body, env = LEDGER) => { fake.state.fail = 500; await endpoint(store).post(body, env); fake.state.fail = null; };
  const pass = (store, clock, env = TAGGED, now = plus(6)) => retryWebLeadReceipts({ store, env: LEDGER, elapsed: () => clock.ms, sync: (value, options) => syncHighLevelLead(env, value, undefined, options) }, { now: new Date(now) });

  // 1. Every HighLevel call takes 10 s on the injected tick clock. The pass starts at 29 s: each call's 15 s timeout
  // is cut to what is left before 75 s, and the opportunity upsert, with nothing left, is not started.
  let store = ledgerStore(), body = lead();
  await failFirst(store, body);
  const clock = { ms: 29000 };
  fake.state.onCall = () => { clock.ms += 10000; };
  timeouts.length = 0;
  const cut = await pass(store, clock);
  assert.deepEqual([cut.attempted, cut.synced, cut.failed], [1, 0, 1]);
  assert.deepEqual(timeouts, [15000, 15000, 15000, 15000, 6000], 'upsert, delayed tag, tags and note at 15 s; the pipelines lookup gets the 6 s left');
  assert.equal(clock.ms, 79000);
  assert.equal(opportunityCreates(fake), 0);
  let receipt = store.receipt(body.inquiry_id);
  assert.deepEqual([receipt.ghlSyncStatus, receipt.lastError, receipt.createdContactId, receipt.retryAt, receipt.attempts], ['failed', 'web_lead_retry_out_of_time', 'contact-web', plus(21), 2]);
  // The next tick has time: it finishes the lead, and opens the opportunity for the contact its own attempt created.
  fake.state.onCall = null; clock.ms = 0;
  assert.equal((await pass(store, clock, TAGGED, plus(21))).synced, 1);
  receipt = store.receipt(body.inquiry_id);
  assert.deepEqual([receipt.ghlSyncStatus, receipt.opportunityId, receipt.opportunitySkipped], ['synced', 'opp-web', null]);

  // 2. Without a pipeline the note is the last call. Out of time, it is not skipped quietly: the sync fails and is
  // retried, rather than marking a lead synced whose details never reached HighLevel. The same holds when the note
  // starts in time but fails once the deadline has passed.
  const noPipeline = { ...TAGGED, HIGHLEVEL_PIPELINE_ID: '' };
  for (const [start, step, failAt] of [[29000, 16000, null], [29000, 15000, '/contacts/contact-web/notes']]) {
    Object.assign(fake.state, { created: false, opportunities: [], failAt });
    store = ledgerStore(); body = lead();
    await failFirst(store, body, noPipeline);
    const notesBefore = notes(fake).length, at = { ms: start };
    fake.state.onCall = () => { at.ms += step; };
    const tick = await pass(store, at, noPipeline);
    fake.state.onCall = null;
    assert.deepEqual([tick.synced, tick.failed], [0, 1], `step ${step}`);
    assert.deepEqual([store.receipt(body.inquiry_id).ghlSyncStatus, store.receipt(body.inquiry_id).lastError, Boolean(store.receipt(body.inquiry_id).sealedPayload)], ['failed', 'web_lead_retry_out_of_time', true]);
    assert.equal(notes(fake).length - notesBefore, failAt ? 1 : 0, failAt ? 'the note was tried in time and failed late' : 'the note was not started');
  }
  fake.state.failAt = null;

  // 3. The sync succeeds but the first settle write fails. A second round (a read and a write, 40 s at worst) starts
  // only while it ends by 115 s; otherwise the claim is left to expire and the lead is synced again (at-least-once).
  for (const [end, settled] of [[WEB_LEAD_HIGHLEVEL_DEADLINE_MS, true], [WEB_LEAD_HIGHLEVEL_DEADLINE_MS + 1, false]]) {
    Object.assign(fake.state, { created: false, opportunities: [] });
    store = ledgerStore(); body = lead();
    await failFirst(store, body);
    const at = { ms: 0 };
    const tick = await retryWebLeadReceipts({ store, env: LEDGER, elapsed: () => at.ms, sync: async (value, options) => {
      const result = await syncHighLevelLead(TAGGED, value, undefined, options);
      at.ms = end; store.hooks.commitFailures = 1;
      return result;
    } }, { now: new Date(plus(6)) });
    assert.equal(tick.synced, 1);
    assert.equal(store.receipt(body.inquiry_id).ghlSyncStatus, settled ? 'synced' : 'syncing', `settle ending at ${end + WEB_LEAD_SETTLE_ROUND_MS} ms`);
    if (!settled) {
      assert.equal((await retry(store, plus(15))).due, 0, 'the claim holds for 10 minutes');
      assert.deepEqual(await retry(store, plus(17)).then(next => [next.synced, store.receipt(body.inquiry_id).ghlSyncStatus]), [1, 'synced']);
    }
  }
});

test('a lead too large to seal is receipted without a payload rather than with one that could never be opened', async t => {
  const store = ledgerStore(), fake = providers(t), inquiryId = randomUUID();
  const flat = { ...lead({ inquiry_id: inquiryId }), photo_description: 'x'.repeat(SEAL_MAX_BYTES) };
  const input = { lead: { name: flat.name, phone: flat.phone, flat }, inquiryId, clientInquiryId: true, meta: webLeadMeta(flat, flat), held: null };
  fake.state.fail = 500;
  const result = await receiveWebLead({ store, env: LEDGER, now: NOW, sync: value => syncHighLevelLead(LEDGER, value), relay: async () => assert.fail('no relay after a failed sync') }, input);
  assert.deepEqual([result.status, result.body.receipt, result.body.highlevel.retry], [202, { status: 'abandoned' }, 'unavailable']);
  const receipt = store.receipt(inquiryId);
  assert.deepEqual([receipt.payloadSealed, receipt.sealedPayload, receipt.ghlSyncStatus, receipt.abandonReason], [false, null, 'abandoned', 'payload_unavailable']);
});

test('with WEB_LEAD_DELAYED_SYNC_TAG on, a late sync is marked with its own tag call that the next on-time sync removes, and never creates or moves an opportunity for a contact that already existed', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store);
  fake.state.created = true; fake.state.opportunities = [{ id: 'opp-worked', contactId: 'contact-web', status: 'open' }];
  // Someone may have worked this lead from the Web3Forms email while HighLevel was down.
  const late = lead();
  fake.state.fail = 500;
  await post(late, TAGGED);
  fake.state.fail = null;
  assert.equal((await retry(store, plus(6), { env: TAGGED })).synced, 1);
  let receipt = store.receipt(late.inquiry_id);
  assert.deepEqual([receipt.ghlSyncStatus, receipt.opportunityId, receipt.opportunitySkipped, receipt.delayedTag], ['synced', null, 'existing_contact', 'added']);
  assert.equal(opportunityCreates(fake), 0, 'the delayed sync leaves the pipeline alone');
  assert.equal(fake.ghl().some(call => call.path.startsWith('/opportunities/')), false);
  assert.match(notes(fake)[0], /^EGC WEBSITE LEAD DETAILS\nDelivered late by the Hub retry: the first HighLevel sync failed\. Check whether someone already followed up\.\nOpportunity: not created or changed, because this contact already existed in HighLevel\./);
  assert.deepEqual(tagsSent(fake), [DELAYED, LEAD_TAGS]);
  // The contact's next lead arrives on time: the mark is removed before the tags that start its workflows.
  const next = lead();
  const onTime = await post(next, TAGGED);
  assert.deepEqual([onTime.status, onTime.body.receipt.status, store.receipt(next.inquiry_id).delayedTag], [200, 'synced', 'cleared']);
  assert.deepEqual(tagsSent(fake).slice(2), [CLEAR, LEAD_TAGS]);
  assert.equal(opportunityCreates(fake), 0, 'the next on-time lead also preserves the worked opportunity');
  assert.equal(store.receipt(next.inquiry_id).opportunitySkipped, 'existing_contact');
  // Without the ledger (flag off, or on without Firestore) nothing marks or clears, even with the tag flag on:
  // the calls are the legacy ones.
  const handler = webLeadHandlers({ storage: () => assert.fail('storage is not used without the ledger'), now: () => new Date(NOW) });
  const tagOnly = { ...LEGACY, WEB_LEAD_DELAYED_SYNC_TAG: 'true' };
  for (const env of [LEGACY, tagOnly, { ...tagOnly, FIREBASE_API_KEY: '', WEB_LEAD_RECEIPTS_ENABLED: 'true' }]) {
    const before = tagsSent(fake).length, { inquiry_id, ...plain } = lead();
    const response = await handler.post({ request: new Request('https://easygaragecleaning.com/api/web-lead', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com' }, body: JSON.stringify(plain) }), env });
    assert.deepEqual(Object.keys(await response.json()), ['ok', 'highlevel', 'relay']);
    assert.deepEqual(tagsSent(fake).slice(before), [LEAD_TAGS]);
  }
  assert.ok(notes(fake).slice(1).every(body => !/Delivered late/.test(body) && /Opportunity: not created or changed/.test(body)));
});

test('with WEB_LEAD_DELAYED_SYNC_TAG unset, a late sync makes the same HighLevel calls as an on-time one and no tag call adds or removes egc-delayed-sync', async t => {
  // Exactly "true" turns the tag on; anything else leaves it off.
  for (const value of [undefined, '', 'false', 'TRUE', ' true', 'true ', '1', 'yes']) assert.equal(webLeadDelayedSyncTagEnabled({ ...LEDGER, WEB_LEAD_DELAYED_SYNC_TAG: value }), false, JSON.stringify(value));
  assert.equal(webLeadDelayedSyncTagEnabled(TAGGED), true);
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store);
  const since = count => fake.ghl().slice(count), route = calls => calls.map(call => `${call.method} ${call.path.split('?')[0]}`);
  // What HighLevel receives, apart from the detail note (which says the lead is late) and its idempotency key.
  const shape = calls => calls.map(({ method, path, body }) => ({ method, path, body: path.endsWith('/notes') ? null : body }));
  const NEW_CONTACT = ['POST /contacts/upsert', 'PUT /contacts/contact-web/tags', 'GET /opportunities/search', 'POST /contacts/contact-web/notes', 'GET /opportunities/pipelines', 'POST /opportunities/'];

  // A lead that reaches HighLevel as it arrives, creating the contact.
  let count = fake.ghl().length;
  assert.equal((await post(lead())).status, 200);
  const onTime = since(count);
  // The same lead while HighLevel is down: the retry reaches it late and creates the contact.
  Object.assign(fake.state, { created: false, opportunities: [], fail: 500 });
  const late = lead();
  assert.equal((await post(late)).status, 202);
  fake.state.fail = null;
  count = fake.ghl().length;
  assert.equal((await retry(store, plus(6))).synced, 1);
  const retried = since(count);
  assert.deepEqual(route(retried), NEW_CONTACT);
  assert.deepEqual(shape(retried), shape(onTime), 'the same calls in the same order with the same contact, tag and opportunity bodies, so HighLevel starts its automations as if the lead had just arrived');
  assert.match(notes(fake).at(-1), /^EGC WEBSITE LEAD DETAILS\nDelivered late by the Hub retry/, 'the detail note still tells the team it came late');
  assert.deepEqual([store.receipt(late.inquiry_id).ghlSyncStatus, store.receipt(late.inquiry_id).delayedTag, store.receipt(late.inquiry_id).opportunityId], ['synced', null, 'opp-web']);

  // An existing contact: an on-time lead removes nothing (no DELETE) and makes exactly the legacy calls.
  count = fake.ghl().length;
  const returning = lead();
  assert.equal((await post(returning)).status, 200);
  const onTimeExisting = since(count);
  assert.deepEqual(route(onTimeExisting), ['POST /contacts/upsert', 'PUT /contacts/contact-web/tags', 'POST /contacts/contact-web/notes']);
  assert.equal(store.receipt(returning.inquiry_id).delayedTag, null);
  count = fake.ghl().length;
  const { inquiry_id, ...plain } = lead();
  await post(plain, LEGACY);
  assert.deepEqual(shape(since(count)), shape(onTimeExisting), 'with the ledger on and the tag off, an on-time sync is the legacy one');
  // A late lead for that existing contact: still no tag call, and the opportunity someone may have worked is left alone.
  fake.state.fail = 500;
  const lateExisting = lead();
  await post(lateExisting);
  fake.state.fail = null;
  count = fake.ghl().length;
  assert.equal((await retry(store, plus(6))).synced, 1);
  assert.deepEqual(route(since(count)), ['POST /contacts/upsert', 'PUT /contacts/contact-web/tags', 'POST /contacts/contact-web/notes']);
  assert.deepEqual([store.receipt(lateExisting.inquiry_id).delayedTag, store.receipt(lateExisting.inquiry_id).opportunitySkipped], [null, 'existing_contact']);

  assert.deepEqual(tagsSent(fake), Array(5).fill(LEAD_TAGS), 'every tag call is the legacy source and consent PUT');
  assert.doesNotMatch(JSON.stringify(fake.ghl()), /egc-delayed-sync/, 'no call adds or removes the delayed tag');
  assert.equal(fake.relays().length, 3, 'the three on-time leads texted once each; the retries never do');
});

test('a retry after a partial first attempt opens the opportunity for the contact that attempt created only when it has none in the pipeline, open or closed', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store);
  const worked = status => [{ id: 'opp-worked', contactId: 'contact-web', status, pipelineStageId: 'stage-quoted' }];
  const cases = [
    { opportunities: [], expect: { opportunityId: 'opp-web', opportunitySkipped: null, creates: 1 } },
    { opportunities: worked('open'), expect: { opportunityId: null, opportunitySkipped: 'existing_opportunity', creates: 0 } },
    // The first attempt's opportunity creation landed although its answer was lost, and the team, working the lead
    // from the Web3Forms email, has since closed it: an upsert would reopen it at the new-lead stage.
    { opportunities: worked('lost'), expect: { opportunityId: null, opportunitySkipped: 'existing_opportunity', creates: 0 } },
    { opportunities: worked('won'), expect: { opportunityId: null, opportunitySkipped: 'existing_opportunity', creates: 0 } },
    { opportunities: worked('abandoned'), expect: { opportunityId: null, opportunitySkipped: 'existing_opportunity', creates: 0 } },
    { failAt: '/opportunities/search', expect: { opportunityId: null, opportunitySkipped: 'opportunity_check_failed', creates: 0 } },
    { opportunities: [{ id: 'opp-other', contactId: 'contact-other' }], expect: { opportunityId: null, opportunitySkipped: 'opportunity_check_failed', creates: 0 } },
  ];
  for (const [index, item] of cases.entries()) {
    // HighLevel accepts the contact (and creates it), then fails on the opportunity.
    Object.assign(fake.state, { created: false, opportunities: [], failAt: '/opportunities/' });
    const body = lead({ source: `Website ${index}` }), createsBefore = opportunityCreates(fake);
    const first = await post(body);
    assert.deepEqual([first.status, first.body.receipt.status], [202, 'failed']);
    assert.deepEqual([store.receipt(body.inquiry_id).createdContactId, store.receipt(body.inquiry_id).lastError], ['contact-web', 'highlevel_unavailable'], 'the receipt remembers the contact its own attempt created');
    Object.assign(fake.state, { opportunities: structuredClone(item.opportunities || []), failAt: item.failAt || null });
    const at = new Date(Date.parse(NOW) + (index + 1) * 3600000).toISOString(), callsBefore = fake.ghl().length;
    // No stage id is configured and, in the first case, the optional delayed tag is on: the worst case
    // WEB_LEAD_RETRY_COST assumes. The other cases sync with the tag off, as by default.
    assert.equal((await retry(store, at, { env: index === 0 ? TAGGED : LEDGER })).synced, 1);
    if (index === 0) assert.deepEqual(fake.ghl().slice(callsBefore).map(call => `${call.method} ${call.path.split('?')[0]}`), ['POST /contacts/upsert', 'POST /contacts/contact-web/tags', 'PUT /contacts/contact-web/tags', 'GET /opportunities/search', 'POST /contacts/contact-web/notes', 'GET /opportunities/pipelines', 'POST /opportunities/']);
    const receipt = store.receipt(body.inquiry_id);
    assert.deepEqual([receipt.ghlSyncStatus, receipt.opportunityId, receipt.opportunitySkipped, opportunityCreates(fake) - createsBefore - 1], ['synced', item.expect.opportunityId, item.expect.opportunitySkipped, item.expect.creates], JSON.stringify(item));
    const search = fake.ghl().filter(call => call.path.startsWith('/opportunities/search?')).at(-1);
    assert.deepEqual(Object.fromEntries(new URL(search.path, 'https://x').searchParams), { locationId: 'location-1', contactId: 'contact-web', pipelineId: 'pipe-1', status: 'all', limit: '100', page: '1' }, 'closed opportunities count too');
    if (item.expect.opportunitySkipped === 'existing_opportunity') {
      assert.deepEqual(fake.state.opportunities, item.opportunities, 'the worked opportunity keeps its status and stage');
      assert.match(notes(fake).at(-1), /\nOpportunity: not created or changed, because this contact already has one in this pipeline \(open, won, lost or abandoned\)\./);
    }
  }
});

test('a receipt commit that cannot be confirmed is settled after the direct sync, so the cron does not sync the lead again', async t => {
  const store = ledgerStore(), fake = providers(t), { post, warnings } = endpoint(store);
  // The commit lands, its response is lost, and the re-read fails too: the request falls back to the direct sync.
  const body = lead();
  Object.assign(store.hooks, { loseResponse: true, lossReadFailures: 1 });
  const result = await post(body);
  assert.deepEqual([result.status, result.body.receipt, result.body.highlevel.synced, result.body.relay.sent], [200, { status: 'synced' }, true, true]);
  const receipt = store.receipt(body.inquiry_id);
  assert.deepEqual([receipt.ghlSyncStatus, receipt.contactId, receipt.sealedPayload, receipt.retryAt, receipt.relayStatus], ['synced', 'contact-web', null, null, 'sent']);
  assert.deepEqual(warnings, [], 'the receipt was found, so no receipt-unavailable marker');
  assert.equal((await retry(store, plus(11))).due, 0);
  assert.deepEqual([fake.ghl().filter(call => call.path === '/contacts/upsert').length, fake.relays().length], [1, 1]);
  // When even that cannot be saved, delivery is at-least-once: the cron syncs the lead again, its note marked late, and
  // never texts. Five reads fail: the re-read after the commit, the check before the relay and all three settle rounds.
  const again = lead();
  Object.assign(store.hooks, { loseResponse: true, lossReadFailures: 5 });
  const unsettled = await post(again);
  assert.deepEqual([unsettled.status, unsettled.body.receipt], [200, { status: 'unavailable' }]);
  assert.deepEqual(warnings, ['{"event":"web_lead_receipt_unavailable"}']);
  assert.equal(store.receipt(again.inquiry_id).ghlSyncStatus, 'syncing');
  const tick = await retry(store, plus(11));
  assert.deepEqual([tick.synced, fake.ghl().filter(call => call.path === '/contacts/upsert').length, fake.relays().length], [1, 3, 2]);
  assert.equal(store.receipt(again.inquiry_id).opportunitySkipped, 'existing_contact', 'the second sync leaves the opportunity the first one opened alone');
});

test('a copy that falls back after an unconfirmed receipt commit re-reads the receipt before the relay, and sends no text when a concurrent copy holds it', async t => {
  const store = ledgerStore(), fake = providers(t), { post, warnings } = endpoint(store), body = lead();
  // The first copy of a double tap receives the lead: one sync, one text.
  const owner = await post(body);
  assert.deepEqual([owner.status, owner.body.receipt.status, fake.relays().length], [200, 'synced', 1]);
  const kept = structuredClone(store.receipt(body.inquiry_id));
  // The second copy read before the first created the receipt. Its own create-only commit then ends without an
  // answer (not a refusal it could trust), and the re-read that would show the receipt fails: it falls back to
  // the direct sync. Only the check after that sync, before the relay, finds the receipt under the other claim.
  const read = store.read.bind(store), outage = () => Object.assign(new Error('Synthetic outage'), { code: 'web_lead_storage_unavailable', status: 503 });
  let reads = 0, commits = 0;
  store.read = async (collection, id) => { reads += 1; if (reads === 1) return null; if (reads === 2) throw outage(); return read(collection, id); };
  store.commit = async () => { commits += 1; throw Object.assign(new Error('Lost'), { code: 'web_lead_outcome_unknown', status: 503 }); };
  const upserts = () => fake.ghl().filter(call => call.path === '/contacts/upsert').length, before = upserts();
  const copy = await post(body);
  assert.deepEqual([copy.status, copy.body.ok, copy.body.inquiryId, copy.body.receipt, copy.body.relay], [200, true, body.inquiry_id, { status: 'synced' }, { configured: true, sent: false, skipped: 'already-received' }]);
  assert.deepEqual([copy.body.highlevel.synced, upserts()], [true, before + 1], 'the direct sync ran before the check');
  assert.equal(fake.relays().length, 1, 'the customer is texted once');
  assert.deepEqual([reads, commits], [3, 1], 'one re-read after the sync; nothing settles the other copy\'s receipt');
  assert.deepEqual(warnings, [], 'the lead has its receipt, so there is no receipt-unavailable marker');
  assert.deepEqual(store.receipt(body.inquiry_id), kept, 'the receipt the other copy holds is untouched');
});

test('with the ledger off, intake still delivers a new eligible lead without touching storage', async t => {
  const fake = providers(t), handler = webLeadHandlers({ storage: () => assert.fail('storage is not used without the ledger'), now: () => new Date(NOW) });
  const send = async (body, env) => { const response = await handler.post({ request: new Request('https://easygaragecleaning.com/api/web-lead', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com' }, body: JSON.stringify(body) }), env }); return { status: response.status, body: await response.json() }; };
  const { inquiry_id, ...plain } = lead();
  const ok = await send(plain, LEGACY);
  assert.deepEqual(Object.keys(ok.body), ['ok', 'highlevel', 'relay']);
  assert.equal(fake.relays()[0].body.inquiry_id, undefined, 'the legacy relay payload is unchanged without an inquiry id');
  fake.state.fail = 500;
  assert.deepEqual(await send(plain, LEGACY), { status: 502, body: { ok: false, error: 'HighLevel lead sync failed' } });
  assert.deepEqual(await send(plain, { ...LEGACY, FIREBASE_API_KEY: '', WEB_LEAD_RECEIPTS_ENABLED: 'true' }).then(result => result.status), 502, 'the flag alone is not enough without Firestore');
  for (const bad of ['null', '[]', '"x"']) {
    const response = await handler.post({ request: new Request('https://easygaragecleaning.com/api/web-lead', { method: 'POST', body: bad }), env: LEGACY });
    assert.equal(response.status, 400, bad);
  }
});

test('the form source comes from the page path', () => {
  const source = (url, flow = '') => webLeadFormSource({ flow_type: flow }, url === null ? null : new URL(url, 'https://easygaragecleaning.com').pathname);
  assert.deepEqual(['/ads', '/ads.html', '/book', '/book.html', '/', '/index.html', '/garage-cleanouts-fort-collins-co'].map(url => source(url)), ['ads_landing', 'ads_landing', 'book', 'book', 'home', 'home', 'site_page']);
  assert.equal(source(null), 'unknown');
  assert.equal(source('/ads', 'client_hub_help'), 'client_hub_help');
});

test('the messaging cron hook runs only with the ledger on and Firestore configured', async t => {
  assert.equal(webLeadRetryRunner(LEGACY), null);
  assert.equal(webLeadRetryRunner({ ...LEDGER, FIREBASE_API_KEY: '' }), null);
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store), body = lead();
  fake.state.fail = 500;
  await post(body);
  fake.state.fail = null;
  const runner = webLeadRetryRunner(TAGGED, { storage: () => store });
  const tight = await runner({ now: new Date(plus(6)), dryRun: false, budget: () => WEB_LEAD_RETRY_COST, charge: () => {} });
  assert.equal(tight.deferred, 'subrequest_budget');
  const late = await runner({ now: new Date(plus(6)), dryRun: false, budget: () => 100, charge: () => {}, elapsed: () => 30000 });
  assert.deepEqual([late.deferred, late.due], ['time_window', 0], 'a tick already 30 s old starts no retry');
  let used = 0;
  const summary = await runner({ now: new Date(plus(6)), dryRun: false, budget: () => 13 - used, charge: cost => { used += cost; }, elapsed: () => 0 });
  assert.deepEqual([summary.synced, used, WEB_LEAD_RETRY_COST], [1, 13, 12], 'one retry is charged its worst case: the query, the claim, seven HighLevel calls and two settle rounds of a read and a write');
  assert.deepEqual(tagsSent(fake), [DELAYED, LEAD_TAGS], 'the cron sync is a delayed one (visible here through the optional tag)');
  assert.match(notes(fake).at(-1), /^EGC WEBSITE LEAD DETAILS\nDelivered late by the Hub retry/);
});

test('the retry pass starts no new retry once its tick is 30 s old, and settles the one it started', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store), first = lead(), second = lead();
  fake.state.fail = 500;
  await post(first); await post(second);
  fake.state.fail = null;
  let ms = 29000;
  const summary = await retryWebLeadReceipts({ store, env: LEDGER, sync: async value => { ms += 5000; return syncHighLevelLead(LEDGER, value); }, elapsed: () => ms }, { now: new Date(plus(6)) });
  assert.deepEqual([summary.due, summary.attempted, summary.synced, summary.notAttempted, summary.timeLimited], [2, 1, 1, 1, true]);
  assert.deepEqual([first, second].map(body => store.receipt(body.inquiry_id).ghlSyncStatus).sort(), ['failed', 'synced'], 'the second waits, untouched, for the next tick');
});

test('the receipt store queries due receipts by retryAt and maps Firestore failures to web_lead codes', async () => {
  const requests = [];
  const doc = id => ({ name: `projects/egcw-1ec83/databases/(default)/documents/web_lead_receipts/${id}`, updateTime: '2026-09-22T18:00:00.000001Z', fields: { ghlSyncStatus: { stringValue: 'failed' }, retryAt: { stringValue: NOW }, attempts: { integerValue: '2' } } });
  const id = randomUUID();
  const fetcher = async (_env, url, init = {}) => {
    requests.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith(':runQuery')) return Response.json([{ document: doc(id) }, { readTime: NOW }]);
    if (String(url).endsWith(':commit')) return Response.json({ error: { status: 'FAILED_PRECONDITION' } }, { status: 400 });
    return new Response('{}', { status: 500 });
  };
  const store = webLeadStorage({ FIREBASE_API_KEY: 'firebase-test-web-lead' }, fetcher);
  const rows = await store.dueReceipts(NOW, 3);
  assert.deepEqual(rows, [{ ghlSyncStatus: 'failed', retryAt: NOW, attempts: 2, id, revision: '2026-09-22T18:00:00.000001Z' }]);
  assert.deepEqual(requests[0].body.structuredQuery, { from: [{ collectionId: 'web_lead_receipts' }], where: { fieldFilter: { field: { fieldPath: 'retryAt' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: NOW } } }, orderBy: [{ field: { fieldPath: 'retryAt' }, direction: 'ASCENDING' }], limit: 3 });
  await assert.rejects(store.commit([{ collection: WEB_LEAD_RECEIPTS, id, revision: 'stale', patch: { attempts: 3 } }]), { code: 'web_lead_revision_conflict', status: 409 });
  await assert.rejects(store.read(WEB_LEAD_RECEIPTS, id), { code: 'web_lead_storage_unavailable' });
  const broken = webLeadStorage({ FIREBASE_API_KEY: 'firebase-test-web-lead' }, async () => Response.json({ not: 'a list' }));
  await assert.rejects(broken.dueReceipts(NOW, 3), { code: 'web_lead_storage_incomplete' });
});

test('web_lead_receipts is a server-only collection and web-lead never uses the legacy leads collection', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  assert.match(rules, /match \/web_lead_receipts\/\{documentId\} \{\s*allow read, write: if false;\s*\}/);
  for (const file of ['../functions/api/web-lead.js', '../functions/_lib/web-lead-intake.js']) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /['"`]leads['"`]|\/leads\//);
});

test('on-time and delayed intake preserve every worked opportunity field, including closed outcomes, with the ledger on or off', async t => {
  const fake = providers(t);
  for (const env of [LEDGER, LEGACY]) for (const delayed of [false, true]) for (const status of ['open', 'won', 'lost', 'abandoned']) {
    const worked = { id: 'opp-worked', contactId: 'contact-web', status, pipelineStageId: 'stage-quoted', monetaryValue: 975, assignedTo: 'rep-working', name: 'Reviewed quote', followers: ['office'] };
    Object.assign(fake.state, { created: true, opportunities: [structuredClone(worked)] });
    const count = fake.ghl().length;
    const result = await syncHighLevelLead(env, lead(), undefined, { delayed });
    assert.equal(result.opportunitySkipped, 'existing_contact');
    assert.deepEqual(fake.state.opportunities, [worked]);
    assert.equal(fake.ghl().slice(count).some(call => call.path.startsWith('/opportunities/')), false, 'existing contacts get no opportunity mutation or speculative new deal');
  }
});

test('newly-created contacts are checked for workflow-created opportunities in every status before any creation', async t => {
  const fake = providers(t);
  for (const delayed of [false, true]) for (const status of ['open', 'won', 'lost', 'abandoned']) {
    const worked = { id: 'opp-workflow', contactId: 'contact-web', status, pipelineStageId: 'stage-booked', monetaryValue: 500 };
    Object.assign(fake.state, { created: false, opportunities: [structuredClone(worked)] });
    const count = opportunityCreates(fake);
    const result = await syncHighLevelLead(LEDGER, lead(), undefined, { delayed });
    assert.equal(result.opportunitySkipped, 'existing_opportunity');
    assert.deepEqual(fake.state.opportunities, [worked]);
    assert.equal(opportunityCreates(fake), count);
  }
});

test('a workflow-created deal racing intake is never overwritten, and its rejected creation remains durably retryable', async t => {
  const store = ledgerStore(), fake = providers(t), { post } = endpoint(store), body = lead();
  const worked = { id: 'opp-raced', contactId: 'contact-web', status: 'won', pipelineStageId: 'stage-sold', monetaryValue: 1450, assignedTo: 'rep-working' };
  fake.state.onCall = path => { if (path === '/opportunities/') fake.state.opportunities = [structuredClone(worked)]; };
  const first = await post(body);
  assert.deepEqual([first.status, store.receipt(body.inquiry_id).ghlSyncStatus, store.receipt(body.inquiry_id).createdContactId], [202, 'failed', 'contact-web']);
  assert.ok(store.receipt(body.inquiry_id).sealedPayload);
  assert.deepEqual(fake.state.opportunities, [worked]);
  assert.equal(fake.relays().length, 0);
  fake.state.onCall = null;
  assert.equal((await retry(store, plus(6))).synced, 1);
  assert.equal(store.receipt(body.inquiry_id).opportunitySkipped, 'existing_opportunity');
  assert.deepEqual(fake.state.opportunities, [worked]);
  assert.equal(opportunityCreates(fake), 1, 'the retry finds the raced deal and does not create another');
  assert.equal(fake.ghl().some(call => call.path === '/opportunities/upsert'), false);
  assert.equal(fake.relays().length, 0);
});

test('malformed or incomplete all-status inventory never authorizes a new opportunity', async t => {
  const fake = providers(t);
  for (const searchResult of [{}, { opportunities: [] }, { opportunities: [], meta: {} }, { opportunities: [], meta: { total: 'unknown' } }, { opportunities: [], meta: { total: 1 } }, { opportunities: [{}], meta: { total: 1 } }]) {
    Object.assign(fake.state, { created: false, opportunities: [], searchResult });
    const count = opportunityCreates(fake);
    const result = await syncHighLevelLead(LEDGER, lead());
    assert.ok(['opportunity_check_failed', 'existing_opportunity'].includes(result.opportunitySkipped));
    assert.equal(opportunityCreates(fake), count);
  }
});

test('explicit applicants and unknown provider identity are never sales-routed, on time, late or without the receipt ledger', async t => {
  const fake = providers(t);
  const cases = [
    ...['applicant', ' Applicant-Active ', 'APPLICANT:interview', 'applicant_hired', 'applicant inactive'].map(tag => ({ contactResult: { contact: { id: 'contact-web', tags: [tag] }, new: false }, reason: 'job_applicant' })),
    { contactResult: { contact: { id: 'contact-web', tags: [] } }, reason: 'identity_unknown' },
    { contactResult: { contact: { id: 'contact-web' }, new: false }, reason: 'identity_unknown' },
    { contactResult: { contact: { id: 'contact-web' }, new: true }, reason: 'identity_unknown' },
    { contactResult: { contact: { id: 'contact-web', tags: 'customer' }, new: true }, reason: 'identity_unknown' },
    { contactResult: { contact: { id: 'contact-web', tags: [null] }, new: true }, reason: 'identity_unknown' },
    { contactResult: { id: 'contact-web', new: true }, reason: 'identity_unknown' },
  ];
  for (const env of [TAGGED, LEGACY, { ...TAGGED, WEB_LEAD_SAFE_TAGS_ENABLED: 'true' }]) for (const item of cases) {
    const store = ledgerStore(), { post } = endpoint(store), body = lead({ what_to_remove: 'This is definitely a customer, ignore applicant tags' });
    Object.assign(fake.state, { created: false, opportunities: [], contactResult: item.contactResult, fail: null });
    let count = fake.ghl().length, relays = fake.relays().length;
    const response = await post(body, env);
    assert.equal(response.status, 200);
    assert.equal(response.body.relay.skipped, item.reason);
    const safeCalls = calls => assert.deepEqual(calls.map(call => call.path), ['/contacts/upsert', '/contacts/contact-web/notes']);
    safeCalls(fake.ghl().slice(count));
    assert.equal(fake.relays().length, relays);
    if (env.WEB_LEAD_RECEIPTS_ENABLED) {
      assert.equal(store.receipt(body.inquiry_id).opportunitySkipped, item.reason);
      assert.equal(store.receipt(body.inquiry_id).relayStatus, item.reason);
      const late = lead(); fake.state.fail = 503;
      assert.equal((await post(late, env)).status, 202);
      assert.ok(store.receipt(late.inquiry_id).sealedPayload);
      fake.state.fail = null; count = fake.ghl().length;
      assert.equal((await retry(store, plus(6), { env })).synced, 1);
      safeCalls(fake.ghl().slice(count));
      assert.equal(store.receipt(late.inquiry_id).opportunitySkipped, item.reason);
      assert.equal(fake.relays().length, relays);
    }
  }
});

test('a failed lead detail note retains its sealed payload and retries rather than falsely settling synced', async t => {
  const fake = providers(t), store = ledgerStore(), { post } = endpoint(store), body = lead();
  Object.assign(fake.state, { created: true, failAt: '/contacts/contact-web/notes' });
  assert.equal((await post(body)).status, 202);
  assert.deepEqual([store.receipt(body.inquiry_id).ghlSyncStatus, store.receipt(body.inquiry_id).lastError], ['failed', 'highlevel_note_failed']);
  assert.ok(store.receipt(body.inquiry_id).sealedPayload);
  assert.equal(fake.relays().length, 0);
  fake.state.failAt = null;
  assert.equal((await retry(store, plus(6))).synced, 1);
  assert.equal(store.receipt(body.inquiry_id).sealedPayload, null);
  assert.equal(fake.relays().length, 0);
});

test('safe additive tags are exactly-true opt-in; failure retains a retry and never changes opportunities or relays', async t => {
  for (const value of [undefined, '', 'false', 'TRUE', ' true', 'true ', '1', true]) assert.equal(webLeadSafeTagsEnabled({ WEB_LEAD_SAFE_TAGS_ENABLED: value }), false);
  const env = { ...LEDGER, WEB_LEAD_SAFE_TAGS_ENABLED: 'true' }, fake = providers(t), store = ledgerStore(), { post } = endpoint(store);
  assert.equal(webLeadSafeTagsEnabled(env), true);
  fake.state.tags = ['priority', 'customer-existing'];
  const body = lead();
  fake.state.failAt = '/contacts/contact-web/tags';
  assert.equal((await post(body, env)).status, 202);
  assert.equal(store.receipt(body.inquiry_id).lastError, 'highlevel_tags_failed');
  assert.ok(store.receipt(body.inquiry_id).sealedPayload);
  assert.equal(opportunityCreates(fake), 0);
  assert.equal(fake.relays().length, 0);
  fake.state.failAt = null;
  assert.equal((await retry(store, plus(6), { env })).synced, 1);
  assert.deepEqual(tagsSent(fake), Array(2).fill(['POST', ['egc-website-lead', 'egc-sms-consent']]));
  assert.equal(fake.ghl().some(call => call.method === 'DELETE'), false, 'opt-in tag writes remove no existing tags');
  assert.deepEqual(fake.state.tags, ['priority', 'customer-existing', 'egc-website-lead', 'egc-sms-consent']);
});

test('without provider identity, an unconfigured HighLevel never falls through to the Zapier sales relay', async t => {
  const fake = providers(t), store = ledgerStore(), { post } = endpoint(store);
  for (const env of [LEGACY, LEDGER]) {
    const result = await post(lead(), { ...env, HIGHLEVEL_API_KEY: '' });
    assert.equal(result.status, env.WEB_LEAD_RECEIPTS_ENABLED ? 202 : 503);
  }
  assert.equal(fake.ghl().length, 0);
  assert.equal(fake.relays().length, 0);
});

test('an unconfirmed creation retains the sealed receipt; retry finds the existing deal without creating or reopening it', async t => {
  const fake = providers(t), store = ledgerStore(), { post } = endpoint(store), body = lead();
  fake.state.createResult = {};
  assert.equal((await post(body)).status, 202);
  assert.equal(store.receipt(body.inquiry_id).lastError, 'highlevel_opportunity_missing');
  assert.ok(store.receipt(body.inquiry_id).sealedPayload);
  const saved = structuredClone(fake.state.opportunities);
  assert.equal((await retry(store, plus(6))).synced, 1);
  assert.deepEqual(fake.state.opportunities, saved);
  assert.equal(opportunityCreates(fake), 1);
  assert.equal(fake.relays().length, 0);
});
