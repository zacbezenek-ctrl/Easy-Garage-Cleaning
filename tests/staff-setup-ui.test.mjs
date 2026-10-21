import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDocument, FixedDate, storage } from './helpers/hub-dom.mjs';
import { STAFF_CAPABILITIES } from '../functions/_lib/staff-roles.js';
import { SKILL_CATALOG, SKILL_CATALOG_VERSION, SKILL_LEVELS } from '../functions/_lib/staff-skills.js';
import { WEEK_DAYS } from '../functions/_lib/staff-directory.js';

// employee-staff.js: the owner's one-tap Finish staff setup, which runs the two staff migrations
// (docs/employee-vault-migrations.md) instead of the browser console. Synthetic data only.
const source = readFileSync(new URL('../employee-staff.js', import.meta.url), 'utf8');
const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
const SETUP = ['staff-profile-pay-roles-v1', 'employee-account-staff-roles-v1'];
const person = username => ({ username, displayName: `Synthetic ${username}`, source: 'employee_account', accountStatus: 'approved', staffRoles: ['crew'], staffRolesSource: 'account', primaryRole: 'crew',
  skills: [], weeklyAvailability: null, weeklyAvailabilityNeedsReview: false, history: [], revision: `rev-${username}`, profileNeedsReview: false });
const directory = (needed, capabilities = [...STAFF_CAPABILITIES]) => ({ ok: true, authority: 'employee_hub', timeZone: 'America/Denver', today: '2026-09-22', viewer: { user: 'ZacB', capabilities },
  catalog: { version: SKILL_CATALOG_VERSION, skills: SKILL_CATALOG, levels: SKILL_LEVELS, roles: ['owner', 'manager', 'crew'], days: WEEK_DAYS }, people: [person('Crew.One')],
  ...(needed === undefined ? {} : { setup: { needed } }), coverage: { complete: true, asOf: '2026-09-22T18:00:00.000Z' } });

function ui(pages, { migrate = body => ({ ok: true, report: { migrationId: body.migrationId, dryRun: false, migrated: 1, conflicts: 0, failed: 0 } }), session = storage() } = {}) {
  const document = createDocument(), migrations = [], reads = [];
  const context = vm.createContext({ console, Intl, Promise, Set, Map, Error, JSON, Object, Array, Math, Number, String, Symbol, AbortController, crypto, Date: FixedDate, document,
    sessionStorage: session, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, fetch: async () => { throw new Error('the injected Hub fetch is always used'); } });
  context.window = context;
  vm.runInContext(source, context, { filename: 'employee-staff.js' });
  const host = document.createElement('div');
  document.body.append(host);
  const hubFetch = async (url, init = {}) => {
    if (url === '/api/employee-vault-migrate') {
      const body = JSON.parse(init.body); migrations.push(body);
      const answer = await migrate(body);
      if (answer instanceof Error) throw answer;
      return { ok: answer.ok !== false, status: answer.ok === false ? 503 : 200, json: async () => answer };
    }
    reads.push(url);
    return { ok: true, status: 200, json: async () => structuredClone(pages[Math.min(reads.length - 1, pages.length - 1)]) };
  };
  context.EGCStaff.mount(host, { identity: 'ZacB', capabilities: ['crew', 'business', 'owner'], hubFetch, toast() {} });
  const finish = () => host.querySelectorAll('button').find(node => node.textContent === 'Finish staff setup');
  return { host, migrations, reads, finish, session };
}

test('the owner sees Finish staff setup only while setup has work, and one tap applies both migrations in order', async () => {
  const page = ui([directory(true), directory(false)]);
  await settle();
  assert.match(page.host.textContent, /One-time setup saves each person’s current role and pay rate/);
  assert.equal(page.migrations.length, 0, 'opening the directory runs nothing');
  page.finish().click();
  await settle();
  assert.deepEqual(page.migrations.map(body => [body.migrationId, body.dryRun]), SETUP.map(id => [id, false]));
  assert.ok(page.migrations.every(body => /^[0-9a-f-]{36}$/.test(body.requestId)) && page.migrations[0].requestId !== page.migrations[1].requestId);
  assert.match(page.host.textContent, /Staff setup is finished/);
  assert.equal(page.finish(), undefined, 'the banner is gone once the directory says setup is done');
  assert.equal(page.reads.length, 2, 'the directory reloads after setup');
});

test('no banner when setup is done, for a manager, or for an older answer without the flag', async () => {
  for (const data of [directory(false), directory(true, ['dispatch.write', 'time.approve']), directory(undefined)]) {
    const page = ui([data]);
    await settle();
    assert.equal(page.finish(), undefined, JSON.stringify(data.setup ?? null));
    assert.doesNotMatch(page.host.textContent, /Finish staff setup/);
  }
});

test('a lost answer keeps the same request id for the retry, and a conflict asks for one more tap', async () => {
  let lose = true;
  const session = storage();
  const page = ui([directory(true)], { session, migrate: body => { if (lose && body.migrationId === SETUP[1]) { lose = false; return new TypeError('Failed to fetch'); } return { ok: true, report: { migrated: 1, conflicts: 0, failed: 0 } }; } });
  await settle();
  page.finish().click();
  await settle();
  assert.match(page.host.textContent, /The Hub could not be reached\. Tap Finish staff setup again; nothing is done twice\./);
  const lostId = page.migrations[1].requestId;
  page.finish().click();
  await settle();
  assert.equal(page.migrations.at(-1).requestId, lostId, 'the unconfirmed run is retried under its own request id');
  assert.match(page.host.textContent, /Staff setup is finished/);

  const busy = ui([directory(true)], { migrate: body => ({ ok: true, report: { migrated: 0, conflicts: body.migrationId === SETUP[0] ? 1 : 0, failed: 0 } }) });
  await settle();
  busy.finish().click();
  await settle();
  assert.match(busy.host.textContent, /A few records changed while setup ran\. Tap Finish staff setup again to finish them\./);
  assert.ok(busy.finish(), 'the button stays for the next tap');
});
