import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { customerSearchKeys, customerSearchTerms, customerSearchPatch, customerSearchFields, customerMatchesSearch, SEARCH_KEYS_VERSION } from '../functions/_lib/customer-identity.js';
import { resolveCustomer } from '../functions/_lib/customer-resolution.js';
import { linkScheduledCustomer } from '../functions/_lib/operations-scheduling.js';
import { runCustomerSearchKeysBackfill, planCustomerSearchKeys } from '../scripts/backfill-customer-search-keys.mjs';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';

const NOW = '2026-09-22T12:00:00.000Z';
const seed = () => ({
  'customers/c-john': { name: 'Synthetic John Smith', phone: '(970) 555-0100', email: 'John@Example.invalid', address: '1 Synthetic Way' },
  'customers/c-parts': { firstName: 'Zoë', lastName: "O'Neil", phone: '+1 970.555.0142' },
  'customers/c-current': { name: 'Already Keyed', phone: '9705550155', ...customerSearchFields({ name: 'Already Keyed', phone: '9705550155' }) },
  'customers/c-stale': { name: 'Renamed Customer', searchKeys: ['old'], searchKeysVersion: SEARCH_KEYS_VERSION },
  'customers/egc_9705550188': { name: '', phone: '' },
});

test('search keys are phone digits then lowercased email and name word prefixes, and terms match them', () => {
  const keys = customerSearchKeys({ name: 'Synthetic John Smith', phone: '(970) 555-0100', email: 'John@Example.invalid' });
  for (const key of ['sy', 'synthetic', 'jo', 'john', 'smith', 'ex', 'example', 'invalid', '970', '9705550100', '0100', '5550100']) assert.ok(keys.includes(key), key);
  for (const key of ['s', 'j', 'mith', '555', 'John', 'john@example.invalid']) assert.ok(!keys.includes(key), key);
  assert.deepEqual(keys.slice(0, 3), ['970', '9705', '97055'], 'phone keys come first');
  assert.deepEqual(customerSearchKeys({ phone: '+1 970 555 0100' }), customerSearchKeys({ phone: '9705550100' }));
  // An extension is not part of the number: the last 4 are the line number.
  const extension = customerSearchKeys({ phone: '(720) 555-1234 x12' });
  assert.ok(extension.includes('1234') && extension.includes('5551234') && extension.includes('7205551234'));
  assert.ok(!extension.includes('3412') && !extension.includes('720555123412'));
  assert.deepEqual(customerSearchKeys({ phone: '720-555-1234 ext. 7' }), customerSearchKeys({ phone: '7205551234' }));
  assert.ok(customerSearchKeys({ firstName: 'Zoë', lastName: "O'Neil" }).includes('zoe') && customerSearchKeys({ lastName: "O'Neil" }).includes('neil'));
  assert.deepEqual(customerSearchKeys({ lastName: "O'Neil" }).includes('o'), false, 'one-letter words are checked on the saved words, not stored');
  assert.deepEqual(customerSearchKeys({}), []);
  assert.deepEqual(customerSearchTerms('  Zoë  ONEIL '), { query: ['oneil'], keys: ['zoe', 'oneil'], words: [] });
  assert.deepEqual(customerSearchTerms('john s'), { query: ['john'], keys: ['john'], words: ['s'] });
  assert.deepEqual(customerSearchTerms('(970) 555-0100'), { query: ['9705550100'], any: ['9705550100'] });
  assert.deepEqual(customerSearchTerms('1 970 555 0100'), { query: ['9705550100'], any: ['9705550100'] });
  assert.deepEqual(customerSearchTerms('+1 970 555'), { query: ['1970555', '970555'], any: ['1970555', '970555'] });
  assert.deepEqual(customerSearchTerms('1234'), { query: ['1234', '234'], any: ['1234', '234'] });
  assert.deepEqual(customerSearchTerms('JOHN@gmail.com'), { query: ['john'], keys: ['john', 'gmail', 'com'], words: [] }, "an email's local part picks the query key");
  for (const text of ['', ' ', 'j', 'j k', '12', '+1', '(1)']) assert.equal(customerSearchTerms(text), null, text);
  assert.equal(customerMatchesSearch({ name: 'Synthetic John Smith' }, customerSearchTerms('smi joh')), true);
  assert.equal(customerMatchesSearch({ name: 'Synthetic John Smith' }, customerSearchTerms('john s')), true);
  assert.equal(customerMatchesSearch({ name: 'Synthetic John Jones' }, customerSearchTerms('john s')), true, 'synthetic starts with s');
  assert.equal(customerMatchesSearch({ name: 'John Jones' }, customerSearchTerms('john s')), false);
  assert.equal(customerMatchesSearch({ name: 'Ann Lee' }, customerSearchTerms('ann l')), true);
  assert.equal(customerMatchesSearch({ phone: '+19705550100' }, customerSearchTerms('+1 970 555')), true);
  assert.equal(customerMatchesSearch({ phone: '(720) 555-1234 x12' }, customerSearchTerms('1234')), true);
  assert.equal(customerMatchesSearch({ name: 'No Email', email: 'john@example.invalid' }, customerSearchTerms('john@example')), true);
  const long = 'Abcdefghijklmnopqrstuvwxyz';
  assert.equal(customerMatchesSearch({ name: long }, customerSearchTerms(long.slice(0, 20))), true, 'a word longer than the key cap is re-checked in full');
  assert.equal(customerMatchesSearch({ name: long }, customerSearchTerms(long.slice(0, 16) + 'x')), false);
  assert.equal(customerMatchesSearch({ name: 'Synthetic John Smith', searchKeys: ['zzz'] }, customerSearchTerms('zzz')), false, 'saved keys are never evidence');
  assert.equal(customerSearchPatch({ name: 'A Name', ...customerSearchFields({ name: 'A Name' }) }, NOW), null);
  assert.deepEqual(customerSearchPatch({ name: 'A Name' }, NOW), { ...customerSearchFields({ name: 'A Name' }), searchKeysUpdatedAt: NOW });
});

test('a long business name keeps its phone and email keys and its earliest words under the key cap', () => {
  const words = ['Northern', 'Colorado', 'Garage', 'Cleaning', 'Organizing', 'Storage', 'Solutions', 'Professional', 'Residential', 'Commercial', 'Services', 'Company', 'Zebra'];
  const keys = customerSearchKeys({ name: words.join(' '), phone: '(970) 555-0100', email: 'zebra@example.invalid' });
  assert.ok(keys.length <= 200);
  for (const key of ['9705550100', '0100', 'northern', 'zebra', 'example']) assert.ok(keys.includes(key), key);
  // 20 distinct 16-letter words give 300 word keys: the phone and the first 12 words stay whole.
  const huge = customerSearchKeys({ name: Array.from({ length: 20 }, (_, index) => String.fromCharCode(97 + index).repeat(16)).join(' '), phone: '(970) 555-0100', email: 'zz@example.invalid' });
  assert.equal(huge.length, 200); assert.ok(huge.includes('9705550100') && huge.includes('0100') && huge.includes('zz') && huge.includes('invalid') && huge.includes('a'.repeat(16)) && huge.includes('k'.repeat(16)));
  assert.ok(!huge.includes('tt'), 'only the last words are cut');
});

test('backfill dry run plans every missing or stale key and makes no writes', async () => {
  const fs = firestoreRest(seed()), before = structuredClone([...fs.documents]);
  const report = await runCustomerSearchKeysBackfill(dispatchStorage({}, fs.fetcher), { now: NOW, runId: 'synthetic-run' });
  assert.equal(report.mode, 'dry_run');
  assert.deepEqual(report.customers, { scanned: 5, current: 1, needsKeys: 4, staleKeys: ['c-stale'], withoutSearchableDetails: ['egc_…0188'] }, 'keys edited out of date under the current version are listed');
  assert.deepEqual(report.writes, { planned: 4, committed: 0, changedDuringRun: [] });
  assert.equal(fs.calls.filter(call => call.path === ':commit').length, 0);
  assert.deepEqual([...fs.documents], before);
  const scan = fs.scans('customers')[0];
  assert.deepEqual(new URLSearchParams(scan.query).getAll('mask.fieldPaths'), ['name', 'firstName', 'lastName', 'phone', 'email', 'searchKeys', 'searchKeysVersion']);
  assert.ok(!JSON.stringify(report).includes('555') && !JSON.stringify(report).includes('example.invalid'), 'the report never repeats phones or emails');
});

test('backfill apply writes only the key fields with revision preconditions, then a rerun is a no-op and coverage is complete', async () => {
  const fs = firestoreRest(seed()), store = dispatchStorage({ EGC_DISPATCH_WINDOWED_READS: 'true' }, fs.fetcher);
  assert.equal((await store.customerKeyCoverage()).complete, false);
  const revisions = Object.fromEntries(['c-john', 'c-parts', 'c-stale'].map(id => [id, fs.get('customers/' + id).revision]));
  const report = await runCustomerSearchKeysBackfill(store, { apply: true, now: NOW, batchSize: 2 });
  assert.deepEqual(report.writes, { planned: 4, committed: 4, changedDuringRun: [] });
  const writes = fs.calls.filter(call => call.path === ':commit').flatMap(call => call.body.writes);
  assert.equal(writes.length, 4);
  for (const write of writes) {
    assert.deepEqual(write.updateMask.fieldPaths, ['searchKeys', 'searchKeysVersion', 'searchKeysUpdatedAt']);
    assert.ok(write.currentDocument.updateTime, 'each write is fenced on the scanned revision');
  }
  assert.equal(writes.find(write => write.update.name.endsWith('/c-john')).currentDocument.updateTime, revisions['c-john']);
  const john = fs.get('customers/c-john');
  assert.equal(john.name, 'Synthetic John Smith'); assert.equal(john.email, 'John@Example.invalid'); assert.ok(john.searchKeys.includes('john'));
  assert.deepEqual(fs.get('customers/c-stale').searchKeys, customerSearchKeys({ name: 'Renamed Customer' }));
  assert.deepEqual(await store.customerKeyCoverage(), { total: 5, keyed: 5, complete: true });
  const commits = fs.calls.filter(call => call.path === ':commit').length;
  const rerun = await runCustomerSearchKeysBackfill(store, { apply: true, now: NOW });
  assert.deepEqual(rerun.writes, { planned: 0, committed: 0, changedDuringRun: [] });
  assert.equal(fs.calls.filter(call => call.path === ':commit').length, commits);
});

test('a customer edited during apply is skipped and reported for a rerun, never overwritten', async () => {
  const fs = firestoreRest(seed());
  let edited = false;
  const fetcher = async (env, url, options = {}) => {
    if (!edited && String(url).endsWith(':commit')) { edited = true; fs.put('customers/c-parts', { firstName: 'Zoë', lastName: 'Edited', phone: '+1 970.555.0142' }); }
    return fs.fetcher(env, url, options);
  };
  const report = await runCustomerSearchKeysBackfill(dispatchStorage({}, fetcher), { apply: true, now: NOW });
  assert.deepEqual(report.writes, { planned: 4, committed: 3, changedDuringRun: ['c-parts'] });
  assert.equal(fs.get('customers/c-parts').lastName, 'Edited'); assert.equal(fs.get('customers/c-parts').searchKeys, undefined);
  const failing = await runCustomerSearchKeysBackfill({ customerRecords: async () => [{ id: 'a', revision: 'r' }], commit: async () => { throw Object.assign(new Error('x'), { code: 'dispatch_outcome_unknown' }); } }, { apply: true, now: NOW });
  assert.equal(failing.aborted.code, 'dispatch_outcome_unknown');
  await assert.rejects(runCustomerSearchKeysBackfill({ customerRecords: async () => [{ id: 'a' }] }, { now: NOW }), error => error.code === 'customer_search_keys_backfill_storage_incomplete');
  assert.deepEqual(planCustomerSearchKeys([], NOW).writes, []);
});

function memory(seed = {}) {
  const rows = new Map(Object.entries(seed).map(([key, row]) => [key, { revision: 'seed', ...row, id: key.split('/')[1] }]));
  let revision = 0;
  const list = collection => [...rows].filter(([key]) => key.startsWith(collection + '/')).map(([, row]) => structuredClone(row));
  return { rows, store: { read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null), customers: async () => list('customers'), jobs: async () => list('jobs'), resources: async () => [], roster: async () => [{ id: 'zacb', name: 'Owner', role: 'owner' }],
    commit: async writes => { for (const write of writes) if (!write.verify) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++revision}` }); return {}; } } };
}

test('Hub and provider customer creation write current search keys so the index stays complete', async () => {
  const intake = memory();
  const result = await resolveCustomer(intake.store, { user: 'zacb', role: 'owner', businessAccess: true }, { requestId: randomUUID(), customer: { name: 'Synthetic Intake Customer', phone: '(970) 555-0190', email: 'intake@example.invalid', address: '9 Synthetic Way' } }, { now: NOW });
  const saved = intake.rows.get('customers/' + result.customer.id);
  assert.equal(saved.searchKeysVersion, SEARCH_KEYS_VERSION);
  assert.equal(customerSearchPatch(saved, NOW), null);
  assert.ok(saved.searchKeys.includes('intake') && saved.searchKeys.includes('0190'));
  const provider = memory({ 'jobs/native': { type: 'walkthrough', highlevelContactId: 'contact-new', customer: 'Synthetic Provider Visit', status: 'scheduled', revision: 'v1' } });
  provider.store.customers = async id => [...provider.rows].filter(([key, row]) => key.startsWith('customers/') && row.highlevelContactId === id).map(([, row]) => structuredClone(row));
  await linkScheduledCustomer(provider.store, { id: 'verified-grant', kind: 'integration', role: 'integration', workspace: 'egc' }, { portalVisitId: 'native', expectedRevision: 'v1', providerContact: { id: 'contact-new', name: 'Synthetic Provider Name', phone: '970.555.0177', email: '' } }, NOW);
  const linked = provider.rows.get('customers/ghl_contact-new');
  assert.equal(customerSearchPatch(linked, NOW), null); assert.ok(linked.searchKeys.includes('provider') && linked.searchKeys.includes('0177'));
});
