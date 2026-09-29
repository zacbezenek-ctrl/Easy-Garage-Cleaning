/**
 * Real PostgreSQL checks for FUN-15 ad spend: the replace/restatement SQL, the append-only
 * owner ledger (trigger, constraints, idempotent operations commands) and the coverage read.
 * Fixtures are synthetic recordings; every HTTP request is served by the fixture router and
 * globalThis.fetch throws. Destructive setup requires an explicitly named loopback test
 * database. Run against a migrated database with EGC_AD_SPEND_TEST=isolated (CI may use
 * EGC_OPERATIONS_TEST=isolated with egc_operations_test) after `pnpm build:packages`.
 */
import test, {after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const databaseUrl = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (![process.env.EGC_AD_SPEND_TEST, process.env.EGC_OPERATIONS_TEST].includes('isolated') ||
    !['localhost', '127.0.0.1'].includes(databaseUrl.hostname) ||
    !/^\/egc_[a-z0-9_]*test$/.test(databaseUrl.pathname) ||
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
  throw new Error('Ad spend integration checks require EGC_AD_SPEND_TEST=isolated and an explicitly named loopback test database');
}

// Guard before importing any service code or opening any database connection.
const {getDb, schema} = await import('@egc/database');
const {sql} = await import('drizzle-orm');
const {adSpendConfig, postgresAdSpendStore, syncAdSpend} = await import('../dist/index.js');
const {operationsService} = await import('../../operations/dist/index.js');
const {ENABLED_ENV, IDS, META, fixtureFetcher} = await import('./fixtures/router.mjs');

const db = getDb();
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('External HTTP disabled by isolated ad spend checks'); };
const NOW = new Date('2026-09-22T18:00:00.000Z');
const owner = {id: 'synthetic-owner', role: 'owner', kind: 'human', workspace: 'egc'};
const manager = {id: 'synthetic-manager', role: 'manager', kind: 'human', workspace: 'egc'};
const service = operationsService({workspace: 'egc', now: () => NOW});
const entry = {channel: 'yard_signs', description: 'Synthetic yard sign order', amountCents: 30000, firstDate: '2026-09-01', lastDate: '2026-09-30', receiptReference: 'INV-SYN-2001'};
const rows = async query => (await db.execute(query)).map(row => ({...row}));
const failure = async work => { try { await work(); } catch (error) { return error; } assert.fail('Expected the operation to fail'); };
const databaseMessage = error => { for (let e = error, depth = 0; e && depth < 4; depth++, e = e.cause) if (e.code && /^[0-9A-Z]{5}$/.test(e.code)) return {code: e.code, message: e.message}; return {code: null, message: String(error?.message)}; };
const sync = (options = {}) => syncAdSpend({config: adSpendConfig(ENABLED_ENV), store: postgresAdSpendStore(db), fetcher: fixtureFetcher(options).fetcher, now: () => options.now ?? NOW});

beforeEach(async () => {
  await db.execute(sql`truncate ad_spend_daily, ad_sync_days, meta_leadgen_daily, spend_entries`);
  // A prefix match, not a key range: range order depends on the database collation (CI's is en_US).
  await db.execute(sql`delete from sync_cursors where starts_with(key, 'ad_spend:')`);
  await db.execute(sql`delete from operation_requests where actor_id in ('synthetic-owner','synthetic-manager')`);
});
after(async () => { globalThis.fetch = originalFetch; await db.$client.end(); });

test('a recorded pull replaces its days atomically and re-pulls flag restatements without duplicates', async () => {
  const first = await sync();
  assert.deepEqual(first.sources.map(s => [s.source, s.ok]), [['meta_ads', true], ['google_ads', true], ['meta_leadgen', true]]);
  const counts = async () => (await rows(sql`select (select count(*) from ad_spend_daily)::int as spend, (select count(*) from ad_sync_days)::int as days, (select count(*) from meta_leadgen_daily)::int as leads`))[0];
  assert.deepEqual(await counts(), {spend: 10, days: 12, leads: 3});
  const totals = await rows(sql`select source, report_date::text as date, total_cents, lead_count, settled, breakdown_gap_cents from ad_sync_days order by source, report_date`);
  assert.deepEqual(totals.filter(r => r.source === 'meta_ads').map(r => [r.date, r.total_cents, r.settled, r.breakdown_gap_cents]),
    [['2026-09-19', 4567, false, 0], ['2026-09-20', 5000, false, 0], ['2026-09-21', 0, false, 0], ['2026-09-22', 1234, false, 0]]);
  assert.deepEqual(totals.filter(r => r.source === 'meta_leadgen').map(r => r.lead_count), [1, 1, 0, 1]);
  const [lead] = await rows(sql`select lead_ids from meta_leadgen_daily where denver_date = '2026-09-19'`);
  assert.deepEqual(lead.lead_ids, ['120211111111111101']);

  await sync();
  assert.deepEqual(await counts(), {spend: 10, days: 12, leads: 3}, 'an identical re-pull must not duplicate a row');
  assert.equal((await rows(sql`select count(*)::int as n from ad_sync_days where restated_at is not null`))[0].n, 0);

  const restated = structuredClone(META);
  restated.insightsAccount.data[1].spend = '51.00';
  restated.insightsAdSetPages[1].data[0].spend = '26.00';
  const later = new Date('2026-09-22T19:00:00.000Z');
  const second = await sync({meta: restated, now: later});
  assert.equal(second.sources[0].accounts[0].restatedDays, 1);
  const [day] = await rows(sql`select total_cents, restated_at, first_pulled_at, pulled_at from ad_sync_days where source = 'meta_ads' and report_date = '2026-09-20'`);
  assert.equal(day.total_cents, 5100);
  // Raw SQL results keep the driver's timestamp text; compare instants.
  assert.equal(new Date(day.restated_at).toISOString(), later.toISOString());
  assert.equal(new Date(day.first_pulled_at).toISOString(), NOW.toISOString());
  assert.equal(new Date(day.pulled_at).toISOString(), later.toISOString());
  const [adset] = await rows(sql`select spend_cents from ad_spend_daily where platform = 'meta_ads' and report_date = '2026-09-20' and ad_set_id = '120200000000000201'`);
  assert.equal(adset.spend_cents, 2600);
  assert.equal((await rows(sql`select count(*)::int as n from ad_spend_daily where platform = 'meta_ads'`))[0].n, 5);
});

test('a failed pull leaves the previously stored days untouched', async () => {
  await sync();
  const broken = structuredClone(META);
  broken.insightsAdSetPages[1].data[0].spend = 'NaN';
  const result = await sync({meta: broken});
  assert.deepEqual(result.sources[0].accounts[0], {accountId: IDS.metaAccount, ok: false, code: 'provider_value_invalid', pulledDays: 0, restatedDays: 0, rows: 0});
  assert.equal((await rows(sql`select count(*)::int as n from ad_spend_daily where platform = 'meta_ads'`))[0].n, 5);
  const [cursor] = await rows(sql`select cursor from sync_cursors where key = 'ad_spend:meta_ads:last_failure'`);
  assert.deepEqual(JSON.parse(cursor.cursor), {at: NOW.toISOString(), code: 'provider_value_invalid', accountId: IDS.metaAccount});
});

test('provider tables refuse negative money, unknown platforms and inconsistent lead ids', async () => {
  const base = {platform: 'meta_ads', accountId: '1', reportDate: '2026-09-20', denverDate: '2026-09-20', accountTimeZone: 'America/Denver', level: 'ad_set', campaignId: 'c', adSetId: 'a', currency: 'USD', spendCents: 1, pulledAt: NOW};
  for (const change of [{spendCents: -1}, {platform: 'tiktok'}, {level: 'campaign'}, {clicks: -2}]) {
    const error = await failure(() => db.insert(schema.adSpendDaily).values({...base, ...change}));
    assert.equal(databaseMessage(error).code, '23514', JSON.stringify(change));
  }
  const error = await failure(() => db.insert(schema.metaLeadgenDaily).values({pageId: '1', formId: '2', denverDate: '2026-09-20', leadCount: 2, leadIds: ['only-one'], pulledAt: NOW}));
  assert.equal(databaseMessage(error).code, '23514');
  // One row per day, campaign and ad set, with the campaign-level row (no ad set) unique too, on any PostgreSQL version.
  const campaign = {...base, level: 'campaign', adSetId: null};
  await db.insert(schema.adSpendDaily).values([base, campaign, {...base, adSetId: 'b'}]);
  for (const duplicate of [base, campaign]) assert.equal(databaseMessage(await failure(() => db.insert(schema.adSpendDaily).values(duplicate))).code, '23505', JSON.stringify(duplicate.adSetId));
  const [{n}] = await rows(sql`select count(*)::int as n from ad_spend_daily`);
  assert.equal(n, 3);
});

test('the ledger refuses Meta and Google spend typed in under another name, in the command schema and in the database', async () => {
  for (const channel of ['facebook_ads', 'fb_boosts', 'instagram', 'google_lsa', 'youtube_preroll']) {
    const refused = await failure(() => service.execute(owner, {command: 'spend.entry.record', entry: {...entry, channel}}, randomUUID()));
    assert.deepEqual([refused.code, refused.status], ['invalid_command', 400], channel);
    const raw = await failure(() => db.insert(schema.spendEntries).values({workspaceId: 'egc', requestId: randomUUID(), ...entry, channel, enteredBy: owner.id, attestedAt: NOW}));
    assert.equal(databaseMessage(raw).code, '23514', channel);
  }
  for (const channel of ['metal_signs', 'local_services_ads']) assert.equal((await service.execute(owner, {command: 'spend.entry.record', entry: {...entry, channel}}, randomUUID())).entry.channel, channel);
  assert.equal((await rows(sql`select count(*)::int as n from spend_entries`))[0].n, 2);
});

test('owner entries are idempotent operations commands and only the owner may write or read them', async () => {
  const requestId = randomUUID();
  const recorded = await service.execute(owner, {command: 'spend.entry.record', entry}, requestId);
  assert.equal(recorded.ok, true);
  assert.deepEqual({...recorded.entry, id: undefined}, {...entry, id: undefined, currency: 'USD', clockSource: 'attested', enteredBy: owner.id, attestedAt: NOW.toISOString(),
    status: 'active', revision: 1, supersedesId: null, closedAt: null, closedBy: null, closeReason: null});
  const replay = await service.execute(owner, {command: 'spend.entry.record', entry}, requestId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.entry.id, recorded.entry.id);
  assert.equal((await rows(sql`select count(*)::int as n from spend_entries`))[0].n, 1);
  const conflict = await failure(() => service.execute(owner, {command: 'spend.entry.record', entry: {...entry, amountCents: 30001}}, requestId));
  assert.deepEqual([conflict.code, conflict.status], ['idempotency_key_payload_conflict', 409]);
  const apiChannel = await failure(() => service.execute(owner, {command: 'spend.entry.record', entry: {...entry, channel: 'meta_ads'}}, randomUUID()));
  assert.deepEqual([apiChannel.code, apiChannel.status], ['invalid_command', 400]);
  for (const command of [{command: 'spend.entry.record', entry}, {command: 'spend.entries'}, {command: 'spend.coverage', from: '2026-09-01', to: '2026-09-23'}]) {
    const denied = await failure(() => service.execute(manager, command, randomUUID()));
    assert.deepEqual([denied.code, denied.status], ['spend_owner_required', 403]);
  }
  const list = await service.execute(owner, {command: 'spend.entries', from: '2026-09-15', to: '2026-09-16'}, randomUUID());
  assert.deepEqual([list.total, list.items.map(i => i.id), list.nextOffset], [1, [recorded.entry.id], null]);
  assert.equal((await service.execute(owner, {command: 'spend.entries', from: '2026-10-01', to: '2026-10-02'}, randomUUID())).total, 0);
});

test('corrections supersede atomically, voids need the current revision, and the database keeps the ledger append-only', async () => {
  const original = (await service.execute(owner, {command: 'spend.entry.record', entry}, randomUUID())).entry;
  const corrected = await service.execute(owner, {command: 'spend.entry.record', entry: {...entry, amountCents: 31500}, supersedes: {entryId: original.id, revision: 1}}, randomUUID());
  assert.deepEqual([corrected.entry.status, corrected.entry.supersedesId, corrected.superseded.status, corrected.superseded.revision, corrected.superseded.closedBy],
    ['active', original.id, 'superseded', 2, owner.id]);
  const again = await failure(() => service.execute(owner, {command: 'spend.entry.record', entry, supersedes: {entryId: original.id, revision: 2}}, randomUUID()));
  assert.deepEqual([again.code, again.status], ['spend_entry_closed', 409]);
  const stale = await failure(() => service.execute(owner, {command: 'spend.entry.void', entryId: corrected.entry.id, revision: 3, reason: 'Duplicate of the vendor invoice'}, randomUUID()));
  assert.deepEqual([stale.code, stale.status, stale.details.currentRevision], ['spend_entry_revision_conflict', 409, 1]);
  const voided = await service.execute(owner, {command: 'spend.entry.void', entryId: corrected.entry.id, revision: 1, reason: 'Duplicate of the vendor invoice'}, randomUUID());
  assert.deepEqual([voided.entry.status, voided.entry.revision, voided.entry.closeReason], ['voided', 2, 'Duplicate of the vendor invoice']);
  assert.equal((await service.execute(owner, {command: 'spend.entries', status: 'active'}, randomUUID())).total, 0);
  assert.equal((await service.execute(owner, {command: 'spend.entries', status: 'all'}, randomUUID())).total, 2);

  const active = (await service.execute(owner, {command: 'spend.entry.record', entry}, randomUUID())).entry;
  for (const [statement, expected] of [
    [sql`update spend_entries set amount_cents = 1 where id = ${active.id}`, 'spend_entry_immutable'],
    [sql`update spend_entries set status = 'voided', revision = 2, closed_at = now(), closed_by = 'x', amount_cents = 1 where id = ${active.id}`, 'spend_entry_immutable'],
    [sql`update spend_entries set status = 'voided', revision = 5, closed_at = now(), closed_by = 'x' where id = ${active.id}`, 'spend_entry_immutable'],
    [sql`update spend_entries set close_reason = 'edited later' where id = ${original.id}`, 'spend_entry_closed'],
    [sql`delete from spend_entries where id = ${active.id}`, 'spend_entry_append_only']]) {
    const error = databaseMessage(await failure(() => db.execute(statement)));
    assert.equal(error.code, '23514');
    assert.match(error.message, new RegExp(expected));
  }
  const [{id: usedRequestId}] = await rows(sql`select request_id::text as id from spend_entries where id = ${active.id}`);
  const duplicate = await failure(() => db.insert(schema.spendEntries).values({workspaceId: 'egc', requestId: usedRequestId, ...entry, enteredBy: owner.id, attestedAt: NOW}));
  assert.equal(databaseMessage(duplicate).code, '23505');
});

test('coverage joins provider days, owner entries and lead counts with status on every number', async () => {
  const beforeSync = await service.execute(owner, {command: 'spend.coverage', from: '2026-09-19', to: '2026-09-23'}, randomUUID());
  assert.deepEqual([beforeSync.metric.value, beforeSync.metric.status, beforeSync.metric.coverage.reasons], [null, 'unknown', ['worker_configuration_missing']]);
  await sync();
  await service.execute(owner, {command: 'spend.entry.record', entry}, randomUUID());
  const report = await service.execute(owner, {command: 'spend.coverage', from: '2026-09-19', to: '2026-10-01'}, randomUUID());
  assert.deepEqual(report.period, {from: '2026-09-19', to: '2026-09-23', requestedTo: '2026-10-01', timeZone: 'America/Denver', inProgress: true});
  assert.deepEqual(report.channels.map(c => [c.channel, c.kind, c.value, c.status]),
    [['meta_ads', 'api', 10801, 'partial'], ['google_ads', 'api', 4550, 'partial'], ['yard_signs', 'manual', 4000, 'complete']]);
  assert.deepEqual([report.metric.value, report.metric.status, report.metric.clockSources, report.metric.coverage.reasons],
    [19351, 'partial', ['attested', 'provider'], ['owner_attested', 'restatement_window']]);
  assert.deepEqual(report.days.map(d => [d.date, d.value]), [['2026-09-19', 7567], ['2026-09-20', 7550], ['2026-09-21', 2000], ['2026-09-22', 2234]]);
  assert.deepEqual([report.leadgen.value, report.leadgen.status, report.leadgen.forms.map(f => [f.formId, f.count])], [3, 'partial', [['900000000000001', 3]]]);
  assert.deepEqual(report.sources.map(s => [s.source, s.status]), [['meta_ads', 'healthy'], ['google_ads', 'healthy'], ['meta_leadgen', 'healthy']]);
  const future = await failure(() => service.execute(owner, {command: 'spend.coverage', from: '2026-10-01', to: '2026-10-05'}, randomUUID()));
  assert.deepEqual([future.code, future.status], ['spend_range_in_future', 400]);
  const wide = await failure(() => service.execute(owner, {command: 'spend.coverage', from: '2025-01-01', to: '2026-09-01'}, randomUUID()));
  assert.deepEqual([wide.code, wide.status], ['spend_range_invalid', 400]);
});
