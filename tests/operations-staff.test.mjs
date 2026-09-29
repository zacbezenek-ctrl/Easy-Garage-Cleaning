import test from 'node:test';
import assert from 'node:assert/strict';
import { operationsMembers, operationsStaffMembersEnabled } from '../functions/_lib/operations-staff.js';
import { inboundResponsePolicy } from '../functions/_lib/operations-rules.js';
import { signOperationsEnvelope } from '../functions/_lib/operations-envelope.js';
import { dispatchRoster } from '../functions/_lib/dispatch-storage.js';
import { hasBusinessAccess, listHubUserProfiles } from '../functions/_lib/hub-session.js';
import { writeOne } from '../functions/_lib/employee-vault.js';
import { onRequestPost as portal } from '../functions/api/operations-portal.js';
import { vaultFirestore, staffEnv, seedAccount } from './helpers/vault-fixture.mjs';

const NOW = '2026-09-22T18:00:00.000Z';
const key = 'isolated-webcrypto-test-key-01234567890123456789';
const env = staffEnv();
// The inbound policy exactly as it was before P1-08: the oracle for unchanged output.
function legacyPolicy(env,members){
  const configured=typeof env.EGC_OPERATIONS_INBOUND_OWNER_ID==='string'?env.EGC_OPERATIONS_INBOUND_OWNER_ID.trim():'';
  const active=members.filter(m=>m&&typeof m.id==='string'&&['owner','manager','sales'].includes(m.role));
  const owners=active.filter(m=>m.role==='owner');
  const owner=configured?active.find(m=>m.id===configured):owners.length===1?owners[0]:null;
  const minutes=env.EGC_OPERATIONS_INBOUND_REPLY_MINUTES===undefined?60:Number(env.EGC_OPERATIONS_INBOUND_REPLY_MINUTES);
  const validMinutes=Number.isInteger(minutes)&&minutes>=5&&minutes<=10080;
  return{authority:'employee_hub',version:1,inboundResponse:{enabled:Boolean(owner&&validMinutes),ownerId:owner?.id??null,dueMinutes:validMinutes?minutes:null,
    ownerSource:configured?'explicit_hub_configuration':owners.length===1?'sole_authoritative_owner':'unresolved',dueSource:env.EGC_OPERATIONS_INBOUND_REPLY_MINUTES===undefined?'default_60_minute_response_rule':'explicit_hub_configuration',
    blockedReason:!owner?'inbound_owner_unresolved':!validMinutes?'inbound_due_rule_invalid':null}};
}
const legacyMembers = env => listHubUserProfiles(env).filter(hasBusinessAccess).map(p => ({ id: p.user, name: p.displayName, role: p.role }));

async function command(extraEnv, body) {
  const claims = { v: 1, iss: 'portal', aud: 'egc-portal', iat: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(), actor: { id: 'operations-api', role: 'integration', kind: 'integration', workspace: 'egc' }, request: { requestId: crypto.randomUUID(), body } };
  const request = new Request('https://portal.test/api/operations-portal', { method: 'POST', body: JSON.stringify({ envelope: await signOperationsEnvelope(claims, key) }) });
  return portal({ request, env: { ...env, EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_SERVICE_AUTH: 'legacy', EGC_OPERATIONS_PORTAL_SIGNING_SECRET: key, ...extraEnv } });
}

async function seedStaff() {
  await seedAccount(env, 'Zoe.Synthetic', { sales: true });
  await seedAccount(env, 'Phone.Person', { extra: { staffRoles: ['phone'] } });
  await seedAccount(env, 'Lead.Person', { extra: { staffRoles: ['crew_lead', 'crew'] } });
  await seedAccount(env, 'Crew.Account');
  await seedAccount(env, 'Forged.Sales', { extra: { role: 'sales' } });
  await seedAccount(env, 'Pending.Sales', { status: 'pending', sales: true });
}

test('with EGC_OPERATIONS_STAFF_MEMBERS off, portal.members and portal.rules are byte-identical to today and read no employee storage', async t => {
  const fire = vaultFirestore(t); await seedStaff();
  const requests = fire.requests.length;
  for (const extra of [{}, { EGC_OPERATIONS_STAFF_MEMBERS: 'false' }, { EGC_OPERATIONS_STAFF_MEMBERS: 'TRUE' }, { EGC_OPERATIONS_INBOUND_OWNER_ID: 'TylerG' }, { EGC_OPERATIONS_INBOUND_REPLY_MINUTES: '3' }]) {
    const members = await command(extra, { command: 'portal.members' });
    assert.equal(members.status, 200);
    assert.equal(await members.text(), JSON.stringify({ ok: true, authority: 'employee_hub', members: legacyMembers(env) }), JSON.stringify(extra));
    const rules = await command(extra, { command: 'portal.rules' });
    assert.equal(await rules.text(), JSON.stringify({ ok: true, ...legacyPolicy({ ...env, ...extra }, legacyMembers(env).map(p => ({ id: p.id, role: p.role }))) }), JSON.stringify(extra));
  }
  assert.equal(fire.requests.length, requests, 'the flag-off path never reads employee accounts');
  assert.equal(operationsStaffMembersEnabled({ EGC_OPERATIONS_STAFF_MEMBERS: 'true' }), true);
});

test('with the flag on, approved sales and phone staff join as members with id = username; crew, pending and forged roles do not', async t => {
  vaultFirestore(t); await seedStaff();
  const on = { EGC_OPERATIONS_STAFF_MEMBERS: 'true' };
  const body = await (await command(on, { command: 'portal.members' })).json();
  assert.deepEqual(body.members, [...legacyMembers(env),
    { id: 'Zoe.Synthetic', name: 'Synthetic Zoe.Synthetic', role: 'sales', staffRoles: ['sales'], businessAccess: false },
    { id: 'Phone.Person', name: 'Synthetic Phone.Person', role: 'phone', staffRoles: ['phone'], businessAccess: false },
  ], 'business members keep their order and shape; sales and phone staff follow, tagged businessAccess:false (P3-04)');
  const policy = async extra => (await (await command({ ...on, ...extra }, { command: 'portal.rules' })).json()).inboundResponse;
  assert.equal((await policy({})).ownerId, 'ZacB', 'unset follow-up role keeps the sole owner');
  assert.deepEqual(await policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' }), { enabled: true, ownerId: 'Phone.Person', dueMinutes: 60, ownerSource: 'sole_followup_role_member', dueSource: 'default_60_minute_response_rule', blockedReason: null });
  assert.equal((await policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: ' Sales ' })).ownerId, 'Zoe.Synthetic');
  assert.equal((await policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone', EGC_OPERATIONS_INBOUND_OWNER_ID: 'Zoe.Synthetic' })).ownerId, 'Zoe.Synthetic', 'an explicit owner id always wins');
  assert.equal((await policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone', EGC_OPERATIONS_INBOUND_OWNER_ID: 'TylerG' })).ownerSource, 'explicit_hub_configuration');
  assert.equal((await policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'manager' })).ownerId, 'TylerG', 'AlexK is configured as crew_lead, so TylerG is the sole manager');
  const crew = await policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'crew' });
  assert.equal(crew.ownerId, null); assert.equal(crew.blockedReason, 'inbound_owner_unresolved');
});

test('ambiguous identities still fail closed in operations members and the dispatch roster', async t => {
  vaultFirestore(t);
  const on = { ...env, EGC_OPERATIONS_STAFF_MEMBERS: 'true' };
  for (const accounts of [[{ username: 'tylerg', status: 'approved', staffRoles: ['sales'] }], [{ username: 'Phone.One', status: 'approved', staffRoles: ['phone'] }, { username: 'phone.one', status: 'approved', role: 'sales', staffRoles: ['sales'] }], [{ username: ' ', status: 'approved', staffRoles: ['phone'] }]]) {
    await assert.rejects(operationsMembers(on, { accounts: async () => accounts }), error => error.status === 409 && error.message === 'portal_members_ambiguous');
  }
  await seedAccount(env, 'crew.static');
  const response = await command({ EGC_OPERATIONS_STAFF_MEMBERS: 'true' }, { command: 'portal.members' });
  assert.equal(response.status, 200, 'a crew-only duplicate is not an operations member');
  await assert.rejects(dispatchRoster(env), error => error.code === 'dispatch_roster_ambiguous');
  await seedAccount(env, 'alexk', { extra: { staffRoles: ['phone'] } });
  const ambiguous = await command({ EGC_OPERATIONS_STAFF_MEMBERS: 'true' }, { command: 'portal.members' });
  assert.equal(ambiguous.status, 409); assert.deepEqual(await ambiguous.json(), { error: 'portal_members_ambiguous' });
  await assert.rejects(dispatchRoster(env), error => error.code === 'dispatch_roster_ambiguous');
});

test('operations rules accept phone members and a configured follow-up role, leaving unset behavior unchanged', () => {
  const sets = [[], [{ id: 'owner-1', role: 'owner' }], [{ id: 'owner-1', role: 'owner' }, { id: 'owner-2', role: 'owner' }], [{ id: 'owner-1', role: 'owner' }, { id: 'sales-1', role: 'sales' }, { id: 'manager-1', role: 'manager' }, { id: 'crew-1', role: 'crew' }], [null, { id: 7, role: 'owner' }, { id: 'owner-1', role: 'owner' }]];
  const envs = [{}, { EGC_OPERATIONS_INBOUND_OWNER_ID: 'sales-1' }, { EGC_OPERATIONS_INBOUND_OWNER_ID: ' owner-1 ' }, { EGC_OPERATIONS_INBOUND_OWNER_ID: 'missing' }, { EGC_OPERATIONS_INBOUND_REPLY_MINUTES: '120' }, { EGC_OPERATIONS_INBOUND_REPLY_MINUTES: 'x' }, { EGC_OPERATIONS_FOLLOWUP_ROLE: '' }, { EGC_OPERATIONS_FOLLOWUP_ROLE: '   ' }];
  for (const members of sets) for (const config of envs) assert.equal(JSON.stringify(inboundResponsePolicy(config, members)), JSON.stringify(legacyPolicy(config, members)), JSON.stringify({ members, config }));
  const members = [{ id: 'owner-1', role: 'owner' }, { id: 'phone-1', role: 'phone' }, { id: 'sales-1', role: 'sales', staffRoles: ['sales', 'phone'] }];
  assert.equal(inboundResponsePolicy({ EGC_OPERATIONS_INBOUND_OWNER_ID: 'phone-1' }, members).inboundResponse.ownerId, 'phone-1', 'phone members are active');
  const both = inboundResponsePolicy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' }, members).inboundResponse;
  assert.equal(both.ownerId, null); assert.equal(both.ownerSource, 'unresolved', 'two phone members stay unresolved');
  assert.equal(inboundResponsePolicy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' }, members.slice(0, 2)).inboundResponse.ownerId, 'phone-1');
  assert.equal(inboundResponsePolicy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'owner' }, members).inboundResponse.ownerId, 'owner-1');
  for (const role of ['crew', 'integration', 'phone-person']) {
    const invalid = inboundResponsePolicy({ EGC_OPERATIONS_FOLLOWUP_ROLE: role }, members).inboundResponse;
    assert.deepEqual([invalid.enabled, invalid.ownerId, invalid.ownerSource, invalid.blockedReason], [false, null, 'invalid_followup_role_configuration', 'inbound_owner_unresolved']);
  }
});

test('the dispatch roster no longer forces crew: stored and invited roles apply, keys stay id/name/role by default', async t => {
  vaultFirestore(t); await seedStaff();
  const roster = await dispatchRoster(env);
  assert.ok(roster.every(person => JSON.stringify(Object.keys(person)) === '["id","name","role"]'));
  const role = Object.fromEntries(roster.map(person => [person.id, person.role]));
  assert.deepEqual(role, { zacb: 'owner', tylerg: 'manager', alexk: 'crew_lead', 'crew.static': 'crew', 'zoe.synthetic': 'sales', 'phone.person': 'phone', 'lead.person': 'crew_lead', 'crew.account': 'crew', 'forged.sales': 'crew' });
  const configured = await dispatchRoster(staffEnv({}, { 'Crew.Static': { passwordHash: 'unused', role: 'crew', displayName: 'Synthetic Static Crew', staffRoles: ['crew_lead'] } }));
  assert.equal(configured.find(person => person.id === 'crew.static').role, 'crew_lead');
});

test('with EGC_STAFF_DIRECTORY_ENABLED the roster carries staff roles, skills and weekly availability for scheduling', async t => {
  const fire = vaultFirestore(t); await seedStaff();
  await writeOne(env, 'profiles', 'phone-person', { username: 'Phone.Person', skills: [{ id: 'customer_phone', level: 'lead', verifiedBy: 'ZacB', verifiedAt: NOW }, { id: 'bad', level: 'x' }], weeklyAvailability: { tue: [{ start: '09:00', end: '17:00' }] } }, { data: null }, NOW);
  await writeOne(env, 'profiles', 'crew.account', { username: 'Crew.Account', weeklyAvailability: { mon: [{ start: '17:00', end: '09:00' }] } }, { data: null }, NOW);
  const on = { ...env, EGC_STAFF_DIRECTORY_ENABLED: 'true' };
  const roster = Object.fromEntries((await dispatchRoster(on)).map(person => [person.id, person]));
  assert.deepEqual(roster['phone.person'], { id: 'phone.person', name: 'Synthetic Phone.Person', role: 'phone', staffRoles: ['phone'], skills: [{ id: 'customer_phone', level: 'lead' }], weeklyAvailability: { mon: [], tue: [{ start: '09:00', end: '17:00' }], wed: [], thu: [], fri: [], sat: [], sun: [] } });
  assert.equal(roster['crew.account'].weeklyAvailability, null, 'malformed stored availability is omitted, not repaired');
  assert.deepEqual(roster.zacb.staffRoles, ['owner']); assert.deepEqual(roster['zoe.synthetic'].staffRoles, ['sales']); assert.deepEqual(roster['lead.person'].staffRoles, ['crew_lead', 'crew']);
  assert.equal(JSON.stringify(roster).includes('verifiedBy'), false);
  const good = [...fire.documents.values()].find(doc => doc.fields.employeeHubType?.stringValue === 'profiles');
  fire.documents.set('jobs/secure_corrupt', { ...good, name: good.name.replace(/[^/]+$/, 'secure_corrupt'), fields: { ...good.fields, vaultId: { stringValue: 'secure_corrupt' } } });
  await assert.rejects(dispatchRoster(on), error => error.code === 'dispatch_storage_unavailable' && error.status === 503);
  assert.equal((await dispatchRoster(env)).length, 9, 'the default roster does not read profiles');
});

test('configured Hub users carry their staffRoles with the flag on, so a configured phone or sales person can own follow-ups', async t => {
  vaultFirestore(t); await seedStaff();
  const configured = staffEnv({}, {
    TylerG: { passwordHash: 'unused-synthetic-manager-hash', role: 'manager', displayName: 'Synthetic Manager', staffRoles: ['manager', 'sales'] },
    'Phone.Config': { passwordHash: 'unused-synthetic-phone-hash', role: 'crew', displayName: 'Synthetic Configured Phone', staffRoles: ['phone', 'owner'] },
    'Sales.Config': { passwordHash: 'unused-synthetic-sales-hash', role: 'sales', displayName: 'Synthetic Configured Sales' },
  });
  const run = (extra, body) => command({ HUB_AUTH_USERS_JSON: configured.HUB_AUTH_USERS_JSON, ...extra }, body);
  const off = await run({}, { command: 'portal.members' });
  assert.equal(await off.text(), JSON.stringify({ ok: true, authority: 'employee_hub', members: legacyMembers(configured) }), 'flag off: byte-identical, no staffRoles and no configured staff');
  const on = { EGC_OPERATIONS_STAFF_MEMBERS: 'true' }, members = (await (await run(on, { command: 'portal.members' })).json()).members;
  assert.deepEqual(members.find(member => member.id === 'TylerG'), { id: 'TylerG', name: 'Synthetic Manager', role: 'manager', staffRoles: ['manager', 'sales'] });
  assert.deepEqual(members.find(member => member.id === 'ZacB'), { id: 'ZacB', name: 'Synthetic Owner', role: 'owner' }, 'no stored roles, nothing attached');
  assert.deepEqual(members.find(member => member.id === 'Phone.Config'), { id: 'Phone.Config', name: 'Synthetic Configured Phone', role: 'phone', staffRoles: ['phone'], businessAccess: false }, 'a stored owner role is dropped; a configured user without business access is tagged');
  assert.equal(members.some(member => ['Sales.Config', 'Crew.Static'].includes(member.id)), false, 'configured users join only through stored sales or phone roles');
  const policy = async extra => (await (await run({ ...on, ...extra }, { command: 'portal.rules' })).json()).inboundResponse;
  const sales = await policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'sales' });
  assert.deepEqual([sales.ownerId, sales.ownerSource], [null, 'unresolved'], 'TylerG and the invited sales account both hold sales');
  const phone = await policy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' });
  assert.deepEqual([phone.ownerId, phone.ownerSource], [null, 'unresolved'], 'the configured and the account phone person are two members');
  const alone = staffEnv({}, { 'Phone.Config': { passwordHash: 'unused-synthetic-phone-hash', role: 'crew', displayName: 'Synthetic Configured Phone', staffRoles: ['phone'] } });
  assert.equal(inboundResponsePolicy({ EGC_OPERATIONS_FOLLOWUP_ROLE: 'phone' }, await operationsMembers({ ...alone, EGC_OPERATIONS_STAFF_MEMBERS: 'true' }, { accounts: async () => [] })).inboundResponse.ownerId, 'Phone.Config');
  await assert.rejects(operationsMembers({ ...alone, EGC_OPERATIONS_STAFF_MEMBERS: 'true' }, { accounts: async () => [{ username: 'phone.config', status: 'approved', staffRoles: ['phone'] }] }), error => error.status === 409 && error.message === 'portal_members_ambiguous');
});

test('with the flag on, an employee-account storage failure is the bridge code portal_source_unavailable, never the storage message', async t => {
  const on = { ...env, EGC_OPERATIONS_STAFF_MEMBERS: 'true' };
  const storage = Object.assign(new Error('Employee account storage is temporarily unavailable. Try again later.'), { code: 'EMPLOYEE_ACCOUNT_STORAGE_UNAVAILABLE', status: 502 });
  for (const thrown of [storage, new TypeError('Synthetic network loss')]) {
    await assert.rejects(operationsMembers(on, { accounts: async () => { throw thrown; } }), error => error.status === 503 && error.message === 'portal_source_unavailable');
  }
  t.mock.method(globalThis, 'fetch', async input => { assert.equal(new URL(input).hostname, 'firestore.googleapis.com'); return Response.json({ error: { status: 'UNAVAILABLE' } }, { status: 503 }); });
  for (const command_ of ['portal.members', 'portal.rules']) {
    const response = await command({ EGC_OPERATIONS_STAFF_MEMBERS: 'true' }, { command: command_ });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'portal_source_unavailable' });
  }
  const off = await command({}, { command: 'portal.members' });
  assert.equal(off.status, 200, 'the flag-off path never reads employee accounts');
});
