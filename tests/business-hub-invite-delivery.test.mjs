import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBusinessHandler } from '../functions/_lib/business-hub-service.js';
import { createBusinessStore } from '../functions/_lib/business-hub-store.js';
import { accountView, inviteState, uid, digest, safeName } from '../functions/_lib/business-hub-core.js';
import { createInviteDelivery, businessMemberRecipient, inviteDeliveryEnabled, memberRecipientId, ownsBusinessAccount, salesStaff } from '../functions/_lib/business-hub-invite-delivery.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { createApprovedSendService } from '../functions/_lib/approved-send.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { MESSAGE_POLICIES } from '../functions/_lib/message-policies.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { MESSAGE_TEMPLATES } from '../functions/_lib/message-send-store.js';
import { env as messagingEnv, owner as templateOwner, crew as CREW, memoryStore, fakeGhl, uuid } from './helpers/messaging-fixture.mjs';

// Synthetic business accounts, a fake HighLevel and an injected clock only; no live provider, Firestore or real time.
const origin = 'https://easygaragecleaning.com', ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const NOW = Date.UTC(2026, 8, 22, 18), HOUR = 3600000, DAY = 24 * HOUR;
const OWNER = { user: 'zacb', displayName: 'Synthetic Owner', businessAccess: true, role: 'owner' };
const SALES = { user: 'synthetic.sales', displayName: 'Synthetic Sales', businessAccess: false, role: 'sales' };
const OTHER_SALES = { user: 'synthetic.other', displayName: 'Synthetic Other', businessAccess: false, role: 'sales' };
const LINK = /https:\/\/easygaragecleaning\.com\/business-hub#invite=([a-f0-9]{32}\.[a-f0-9]{32}\.([a-f0-9]{64}))/;

class MemoryStore {
  constructor() { this.records = new Map(); this.clock = 0; this.hooks = {}; }
  async read(c, id) { return structuredClone(this.records.get(c + '/' + id) || null); }
  async commit(changes) {
    await this.hooks.beforeCommit?.(changes);
    for (const w of changes) { const old = this.records.get(w.collection + '/' + w.id); if (w.version ? old?._version !== w.version : Boolean(old)) throw Object.assign(new Error('Conflict'), { status: 409, publicMessage: 'The record changed or could not be saved. Refresh and retry; no partial update was applied.' }); }
    for (const w of changes) { const key = w.collection + '/' + w.id, old = this.records.get(key); this.records.set(key, { ...(w.patch ? old : {}), ...structuredClone(w.data), id: w.id, _version: String(++this.clock) }); }
  }
  async list(profile) { return { accounts: this.rows('business_accounts').filter(v => profile.businessAccess || v.ownerStaff === profile.user), next: '' }; }
  async jobs() { return new Map(); }
  rows(prefix) { return [...this.records.entries()].filter(([k]) => k.startsWith(prefix + '/')).map(([, v]) => structuredClone(v)); }
}

// HighLevel fake: an upsert resolves one contact per saved email address; `contact` overrides that contact's fields.
function ghlFake({ contact = {}, ...options } = {}) {
  const ghl = fakeGhl({ ...options, contacts: {} });
  async function fetcher(url, init = {}) {
    if (new URL(url).pathname === '/contacts/upsert' && typeof ghl.state.upsertId !== 'number') {
      const address = JSON.parse(init.body).email, id = 'contact-' + createHash('sha256').update(String(address)).digest('hex').slice(0, 12);
      ghl.state.contacts[id] ||= { id, locationId: 'location-1', email: address, dnd: false, tags: [], ...contact };
      ghl.state.upsertId = id;
    }
    return ghl.fetcher(url, init);
  }
  return { ...ghl, fetcher };
}

async function approveInvite(messages) {
  const state = await readTemplate(messages, 'b2b_invite');
  await mutateTemplate(messages, templateOwner, { action: 'approve', requestId: uuid(), kind: 'b2b_invite', expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, new Date(NOW).toISOString());
}

async function setup({ flag = true, approve = true, settings = {}, ghl: ghlOptions = {}, store, waitUntil } = {}) {
  const business = store || new MemoryStore(), messages = memoryStore(), ghl = ghlFake(ghlOptions);
  let clock = NOW, staff = OWNER;
  if (approve) await approveInvite(messages);
  const env = { ...messagingEnv, ...settings, ...(flag ? { BUSINESS_HUB_INVITE_DELIVERY: 'true' } : {}) };
  const invites = createInviteDelivery({ env, store: messages, messenger: createGhlMessenger({ env, fetcher: ghl.fetcher, clock: () => new Date(clock) }) });
  const handler = createBusinessHandler({ store: business, getStaff: async () => staff, finance: () => ({}), needsReview: () => false, projectCookie: async () => 'project=; HttpOnly', clearProjectCookie: () => 'project=; Max-Age=0', now: () => clock, invites, waitUntil });
  async function call(payload, { url = '', cookie = '' } = {}) {
    const res = await handler(new Request(origin + '/api/business-hub' + url, { method: payload ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-EGC-Business': '1', Cookie: cookie }, ...(payload ? { body: JSON.stringify(payload) } : {}) }));
    return { status: res.status, data: await res.json(), cookie: res.headers.get('Set-Cookie') };
  }
  const sent = () => ghl.sends().map(c => { const match = LINK.exec(c.body.message); return { to: c.body.emailTo, code: match?.[1], token: match?.[2], body: c.body }; });
  const account = id => business.read('business_accounts', id);
  const member = async (accountId, memberId) => (await account(accountId)).members.find(m => m.id === memberId);
  async function redeem(code) { const res = await call({ action: 'redeem', invite: code }); return { status: res.status, cookie: res.cookie?.split(';')[0] }; }
  async function onboard({ deliver = 'manual', company = 'Synthetic Client Co', address = 'admin@example.invalid' } = {}) {
    const created = await call({ action: 'create_account', requestId: uid(), company, name: 'Synthetic Admin', email: address, deliver }, { url: '?staff=1' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return { accountId: created.data.accountId, memberId: created.data.memberId, created, staffUrl: '?staff=1&account=' + created.data.accountId };
  }
  async function admin(options) { const a = await onboard(options); const code = a.created.data.invite || sent().at(-1).code; const login = await redeem(code); assert.equal(login.status, 200); return { ...a, cookie: login.cookie }; }
  // Every stored record the hub and the messaging core wrote, as one searchable string.
  const dump = () => JSON.stringify([...business.records.values(), ...messages.rows.values(), ...messages.commits]);
  return { business, messages, ghl, call, sent, account, member, redeem, onboard, admin, dump, env, invites, setStaff: value => staff = value, advance: ms => clock += ms, now: () => clock };
}

test('a staff email invitation uses the approved template and a verified contact, records the messageId and never stores the link', async () => {
  const h = await setup(), requestId = uid();
  const created = await h.call({ action: 'create_account', requestId, company: 'Synthetic Email Co', name: 'Synthetic Admin', email: 'Admin@Example.invalid', deliver: 'email' }, { url: '?staff=1' });
  assert.equal(created.status, 201);
  assert.equal(created.data.invite, undefined, 'an accepted email never also returns the link');
  assert.deepEqual(created.data.delivery, { channel: 'email', status: 'submitted', reason: '', recorded: true });
  const { accountId, memberId } = created.data, [mail] = h.sent();
  assert.equal(h.sent().length, 1); assert.equal(mail.to, 'admin@example.invalid'); assert.equal(mail.body.type, 'Email');
  assert.equal(mail.body.subject, 'Your Easy Garage Cleaning business hub invitation');
  assert.match(mail.body.message, /^Hi Synthetic,\n\nYou have been invited/); assert.equal(mail.code.split('.')[0], accountId); assert.equal(mail.code.split('.')[1], memberId);
  const [upsert] = h.ghl.calls; assert.equal(upsert.path, '/contacts/upsert');
  assert.deepEqual([upsert.body.email, upsert.body.locationId, upsert.body.phone], ['admin@example.invalid', 'location-1', undefined], 'the contact is resolved from the saved member email only');
  assert.equal(h.ghl.calls[1].path, '/contacts/' + mail.body.contactId, 'the upserted contact is re-read and verified before sending');
  const saved = await h.member(accountId, memberId);
  assert.equal(saved.inviteHash, await digest(mail.token));
  assert.deepEqual({ ...saved.invite, attemptId: undefined }, { generation: 1, channel: 'email', status: 'submitted', attemptId: undefined, sentBy: 'staff:zacb', requestedAt: new Date(NOW).toISOString(), sends: [NOW], reason: '', messageId: 'message-1', completedAt: new Date(NOW).toISOString() });
  assert.match(saved.invite.attemptId, /^[a-f0-9]{32}$/);
  const [ledger] = [...h.messages.rows.entries()].filter(([key]) => key.startsWith('message_sends/')).map(([, row]) => row);
  assert.deepEqual([ledger.status, ledger.kind, ledger.approval, ledger.templateKind, ledger.targetType, ledger.actorId, ledger.messageId], ['submitted', 'b2b_invite', 'template+human_trigger', 'b2b_invite', 'account', 'zacb', 'message-1']);
  assert.equal(ledger.sendKey, `b2b_invite:${memberRecipientId(accountId, memberId, 1)}`); assert.equal(ledger.recipient, 'a•••@example.invalid');
  assert.equal(ledger.requestId, requestId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'));
  assert.match(ledger.body, /Accept your invitation here: \[secure link\]/);
  assert.equal(h.dump().includes(mail.token), false, 'the raw token is in no business, ledger, template or receipt record');
  assert.equal(JSON.stringify(h.ghl.calls.filter(c => c.path !== '/conversations/messages')).includes(mail.token), false, 'only the email itself carries the link');
  assert.deepEqual(h.business.rows('business_audit').map(r => r.action), ['member_invited', 'invite_delivery_recorded']);
  const receipt = await h.business.read('business_operations', requestId);
  assert.deepEqual([receipt.action, receipt.accountId, receipt.memberId, receipt.generation, receipt.deliver], ['create_account', accountId, memberId, 1, 'email']);
  assert.equal((await h.redeem(mail.code)).status, 200, 'the emailed link signs the named person in');
});

test('a HighLevel contact whose location or email does not match sends nothing and returns the private link instead', async () => {
  for (const contact of [{ locationId: 'location-2' }, { email: 'someone.else@example.invalid' }]) {
    const h = await setup({ ghl: { contact } }), a = await h.onboard({ deliver: 'email' });
    assert.deepEqual([a.created.data.delivery.status, a.created.data.delivery.reason], ['contact_mismatch', 'contact_identity_mismatch'], JSON.stringify(contact));
    assert.equal(h.ghl.sends().length, 0);
    assert.equal((await h.member(a.accountId, a.memberId)).invite.status, 'contact_mismatch');
    assert.match(a.created.data.invite, /^[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{64}$/);
    assert.equal((await h.redeem(a.created.data.invite)).status, 200, 'the manual fallback is the same single-use invitation');
  }
});

test('a contact with email do-not-disturb is suppressed and never emailed', async () => {
  for (const contact of [{ dnd: true }, { dndSettings: { Email: { status: 'active' } } }]) {
    const h = await setup({ ghl: { contact } }), a = await h.onboard({ deliver: 'email' });
    assert.deepEqual([a.created.data.delivery.status, a.created.data.delivery.reason], ['suppressed', 'contact_dnd_email']);
    assert.equal(h.ghl.sends().length, 0); assert.ok(a.created.data.invite);
    assert.equal((await h.member(a.accountId, a.memberId)).invite.status, 'suppressed');
  }
  const sms = await setup({ ghl: { contact: { dndSettings: { SMS: { status: 'active' } } } } });
  assert.equal((await sms.onboard({ deliver: 'email' })).created.data.delivery.status, 'submitted', 'only the email channel setting applies');
});

test('5xx, timeouts and missing message ids are uncertain; a replay of the same request reports the status and never sends again', async () => {
  for (const ghl of [{ sendStatus: 500 }, { sendThrows: true }, { sendBody: {} }]) {
    const h = await setup({ ghl }), requestId = uid();
    const input = { action: 'create_account', requestId, company: 'Synthetic Uncertain Co', name: 'Synthetic Admin', email: 'admin@example.invalid', deliver: 'email' };
    const first = await h.call(input, { url: '?staff=1' });
    assert.equal(first.status, 201); assert.equal(first.data.delivery.status, 'uncertain', JSON.stringify(ghl)); assert.ok(first.data.invite, 'the link is shown so staff can share the same invitation');
    assert.equal(h.ghl.sends().length, 1);
    const saved = await h.member(first.data.accountId, first.data.memberId);
    assert.equal(saved.invite.status, 'uncertain');
    const version = (await h.account(first.data.accountId))._version;
    for (let i = 0; i < 2; i++) {
      const retry = await h.call(input, { url: '?staff=1' });
      assert.equal(retry.status, 200); assert.equal(retry.data.duplicate, true); assert.equal(retry.data.invite, undefined);
      assert.deepEqual(retry.data.delivery, { channel: 'email', status: 'uncertain' });
    }
    assert.equal(h.ghl.sends().length, 1, 'no automatic resend'); assert.equal((await h.account(first.data.accountId))._version, version);
    assert.equal(h.business.rows('business_accounts').length, 1);
  }
  const rejected = await setup({ ghl: { sendStatus: 422 } }), a = await rejected.onboard({ deliver: 'email' });
  assert.deepEqual([a.created.data.delivery.status, rejected.ghl.sends().length], ['failed', 1]); assert.ok(a.created.data.invite);
  assert.equal((await rejected.member(a.accountId, a.memberId)).invite.status, 'failed');
});

test('invite_member replays by requestId return the saved status; a changed payload is refused; a later resend supersedes it', async () => {
  const h = await setup(), a = await h.admin(), requestId = uid();
  const input = { action: 'invite_member', requestId, name: 'Synthetic Manager', email: 'manager@example.invalid', role: 'manager', deliver: 'email' };
  const first = await h.call(input, { url: a.staffUrl });
  assert.equal(first.status, 201); assert.equal(first.data.delivery.status, 'submitted');
  const before = (await h.account(a.accountId))._version, emails = h.ghl.sends().length;
  const replay = await h.call(input, { url: a.staffUrl });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, { ok: true, duplicate: true, accountId: a.accountId, memberId: first.data.memberId, email: 'manager@example.invalid', delivery: { channel: 'email', status: 'submitted' } });
  assert.equal(h.ghl.sends().length, emails); assert.equal((await h.account(a.accountId))._version, before);
  assert.equal((await h.call({ ...input, name: 'Synthetic Changed' }, { url: a.staffUrl })).status, 409);
  assert.equal((await h.call({ ...input, deliver: 'manual' }, { url: a.staffUrl })).status, 409);
  const resendInput = { action: 'resend_invite', requestId: uid(), memberId: first.data.memberId, deliver: 'email' };
  const resend = await h.call(resendInput, { url: a.staffUrl });
  assert.equal(resend.status, 201);
  assert.equal((await h.call(input, { url: a.staffUrl })).data.delivery.status, 'superseded');
  assert.equal((await h.call(resendInput, { url: a.staffUrl })).data.delivery.status, 'submitted', 'the newest link is still current');
  assert.equal((await h.call({ action: 'revoke_member', memberId: first.data.memberId }, { url: a.staffUrl })).status, 200);
  for (const replayed of [resendInput, input]) assert.deepEqual((await h.call(replayed, { url: a.staffUrl })).data.delivery, { channel: 'email', status: 'revoked' }, 'a revoked link is never reported as delivered');
  const reinvited = await h.call({ ...input, requestId: uid(), deliver: 'manual' }, { url: a.staffUrl });
  assert.equal(reinvited.status, 201);
  assert.equal((await h.call(resendInput, { url: a.staffUrl })).data.delivery.status, 'superseded', 'a later invitation of the same person supersedes it');
  const manual = { action: 'invite_member', requestId: uid(), name: 'Synthetic Viewer', email: 'viewer@example.invalid', role: 'viewer' };
  const made = await h.call(manual, { cookie: a.cookie });
  assert.equal(made.status, 201); assert.ok(made.data.invite); assert.equal(made.data.delivery, undefined);
  const again = await h.call(manual, { cookie: a.cookie });
  assert.deepEqual([again.status, again.data.duplicate, again.data.invite, again.data.delivery], [200, true, undefined, { channel: 'manual', status: 'manual' }]);
  assert.equal(h.dump().includes(made.data.invite.split('.')[2]), false);
  assert.equal((await h.call({ action: 'invite_member', name: 'Synthetic Email', email: 'noid@example.invalid', role: 'viewer', deliver: 'email' }, { url: a.staffUrl })).status, 400, 'email needs a requestId');
});

test('with BUSINESS_HUB_INVITE_DELIVERY off, email requests get the manual link only and nothing is sent', async () => {
  assert.equal(inviteDeliveryEnabled({}), false); assert.equal(inviteDeliveryEnabled({ BUSINESS_HUB_INVITE_DELIVERY: 'TRUE' }), false); assert.equal(inviteDeliveryEnabled({ BUSINESS_HUB_INVITE_DELIVERY: 'true' }), true);
  const h = await setup({ flag: false }), a = await h.onboard({ deliver: 'email' });
  assert.match(a.created.data.invite, /^[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{64}$/);
  assert.deepEqual(a.created.data.delivery, { channel: 'manual', status: 'manual', reason: 'email_delivery_off' });
  assert.equal(h.ghl.calls.length, 0); assert.equal([...h.messages.rows.keys()].some(key => key.startsWith('message_sends/')), false);
  const saved = await h.member(a.accountId, a.memberId);
  assert.deepEqual([saved.invite.channel, saved.invite.status, saved.invite.attemptId, saved.invite.sends], ['manual', 'manual', undefined, []]);
  assert.equal((await h.call(null, { url: a.staffUrl })).data.inviteDelivery.email, false);
  assert.equal((await h.call(null, { url: '?staff=1' })).data.inviteDelivery.email, false);
  const legacy = await h.onboard({ company: 'Synthetic Legacy Co', address: 'legacy@example.invalid' });
  assert.equal(legacy.created.data.delivery, undefined); assert.ok(legacy.created.data.invite);
  assert.equal((await h.redeem(a.created.data.invite)).status, 200);
});

test('messaging switched off, dry run and unapproved wording each fall back to the link without a provider send', async () => {
  const cases = [
    [{ settings: { EGC_MESSAGING_ENABLED: 'false' } }, 'not_sent', 'messaging_disabled'],
    [{ approve: false }, 'not_sent', 'messaging_template_not_approved'],
    [{ settings: { EGC_MESSAGING_DRY_RUN: 'true' } }, 'dry_run', ''],
    [{ settings: { HIGHLEVEL_API_KEY: '' } }, 'not_configured', 'highlevel'],
  ];
  for (const [options, status, reason] of cases) {
    const h = await setup(options), a = await h.onboard({ deliver: 'email' });
    assert.deepEqual([a.created.data.delivery.status, a.created.data.delivery.reason], [status, reason], JSON.stringify(options));
    assert.equal(h.ghl.sends().length, 0); assert.ok(a.created.data.invite);
    assert.deepEqual([(await h.member(a.accountId, a.memberId)).invite.status, (await h.member(a.accountId, a.memberId)).invite.sends], [status, []], 'an attempt that sent nothing is not counted');
    assert.equal(h.dump().includes(a.created.data.invite.split('.')[2]), false);
  }
  assert.equal(MESSAGE_POLICIES.b2b_invite.maxAttempts, 1); assert.deepEqual(MESSAGE_POLICIES.b2b_invite.triggers, ['hub']);
});

test('resend rotates the token: the old link returns 401 and only the newest link works', async () => {
  const h = await setup(), a = await h.admin();
  const invited = await h.call({ action: 'invite_member', requestId: uid(), name: 'Synthetic Billing', email: 'billing@example.invalid', role: 'billing', deliver: 'email' }, { url: a.staffUrl });
  const first = h.sent().at(-1);
  const resend = await h.call({ action: 'resend_invite', requestId: uid(), memberId: invited.data.memberId, deliver: 'email' }, { url: a.staffUrl });
  assert.equal(resend.status, 201); assert.equal(resend.data.ok, true); assert.equal(resend.data.delivery.status, 'submitted');
  const second = h.sent().at(-1);
  assert.notEqual(first.token, second.token); assert.equal(h.sent().length, 2);
  const saved = await h.member(a.accountId, invited.data.memberId);
  assert.deepEqual([saved.version, saved.invite.generation, saved.invite.sends.length], [2, 2, 2]);
  assert.equal((await h.redeem(first.code)).status, 401);
  assert.equal((await h.redeem(second.code)).status, 200);
  assert.ok(h.business.rows('business_audit').some(r => r.action === 'invite_resent'));
  const viewer = await h.call({ action: 'invite_member', name: 'Synthetic Viewer', email: 'viewer@example.invalid', role: 'viewer' }, { cookie: a.cookie });
  const rotated = await h.call({ action: 'resend_invite', requestId: uid(), memberId: viewer.data.memberId }, { cookie: a.cookie });
  assert.equal(rotated.status, 201); assert.notEqual(rotated.data.invite, viewer.data.invite); assert.equal(rotated.data.delivery, undefined);
  assert.equal((await h.redeem(viewer.data.invite)).status, 401); assert.equal((await h.redeem(rotated.data.invite)).status, 200);
  h.advance(2 * DAY);
  const expired = await h.call({ action: 'invite_member', name: 'Synthetic Late', email: 'late@example.invalid', role: 'viewer' }, { url: a.staffUrl });
  h.advance(49 * HOUR); assert.equal((await h.redeem(expired.data.invite)).status, 401);
  const renewed = await h.call({ action: 'resend_invite', requestId: uid(), memberId: expired.data.memberId }, { url: a.staffUrl });
  assert.equal(renewed.status, 201); assert.equal((await h.redeem(renewed.data.invite)).status, 200);
  assert.equal((await h.call({ action: 'resend_invite', memberId: expired.data.memberId }, { url: a.staffUrl })).status, 400, 'a requestId is required');
  assert.equal((await h.call({ action: 'resend_invite', requestId: uid(), memberId: uid() }, { url: a.staffUrl })).status, 404);
});

test('invitation emails are limited to three per member per rolling day, measured with the injected clock', async () => {
  const h = await setup(), a = await h.admin();
  const invited = await h.call({ action: 'invite_member', requestId: uid(), name: 'Synthetic Pending', email: 'pending@example.invalid', role: 'viewer', deliver: 'email' }, { url: a.staffUrl });
  const resend = deliver => h.call({ action: 'resend_invite', requestId: uid(), memberId: invited.data.memberId, deliver }, { url: a.staffUrl });
  h.advance(HOUR); assert.equal((await resend('email')).status, 201);
  h.advance(HOUR); assert.equal((await resend('email')).status, 201);
  const emails = h.sent().length, before = await h.member(a.accountId, invited.data.memberId);
  h.advance(HOUR); const limited = await resend('email');
  assert.equal(limited.status, 429); assert.match(limited.data.error, /three invitations in the last 24 hours/);
  assert.equal(h.sent().length, emails); assert.deepEqual(await h.member(a.accountId, invited.data.memberId), before, 'a limited resend changes nothing');
  const manual = await resend('manual'); assert.equal(manual.status, 201, 'a private link is not an email'); assert.ok(manual.data.invite);
  assert.equal((await h.member(a.accountId, invited.data.memberId)).invite.sends.length, 3, 'the member-scoped counter carries over');
  h.advance(20.5 * HOUR); assert.equal((await resend('email')).status, 429, 'still three within the last 24 hours');
  h.advance(HOUR); const allowed = await resend('email');
  assert.equal(allowed.status, 201); assert.equal(allowed.data.delivery.status, 'submitted');
  assert.deepEqual((await h.member(a.accountId, invited.data.memberId)).invite.sends, [NOW + HOUR, NOW + 2 * HOUR, h.now()]);
});

test('attempts that emailed nothing never use up the daily limit; accepted and uncertain emails do', async () => {
  const h = await setup({ settings: { HIGHLEVEL_API_KEY: '' } }), a = await h.admin();
  const invited = await h.call({ action: 'invite_member', requestId: uid(), name: 'Synthetic Pending', email: 'pending@example.invalid', role: 'viewer', deliver: 'email' }, { url: a.staffUrl });
  assert.equal(invited.data.delivery.status, 'not_configured');
  const resend = () => h.call({ action: 'resend_invite', requestId: uid(), memberId: invited.data.memberId, deliver: 'email' }, { url: a.staffUrl });
  for (let i = 0; i < 2; i++) { h.advance(HOUR); assert.equal((await resend()).data.delivery.status, 'not_configured'); }
  h.advance(HOUR); const fourth = await resend();
  assert.equal(fourth.status, 201, 'three attempts that sent nothing do not block a fourth'); assert.equal(fourth.data.delivery.status, 'not_configured');
  assert.deepEqual((await h.member(a.accountId, invited.data.memberId)).invite.sends, []); assert.equal(h.ghl.calls.length, 0);
  // First email rejected (4xx), second uncertain (5xx), then accepted: only the last two count.
  const mixed = await setup({ ghl: { sendStatus: count => count === 1 ? 422 : count === 2 ? 503 : 200 } }), b = await mixed.admin();
  const person = await mixed.call({ action: 'invite_member', requestId: uid(), name: 'Synthetic Mixed', email: 'mixed@example.invalid', role: 'viewer', deliver: 'email' }, { url: b.staffUrl });
  const again = () => mixed.call({ action: 'resend_invite', requestId: uid(), memberId: person.data.memberId, deliver: 'email' }, { url: b.staffUrl });
  const statuses = [person.data.delivery.status];
  for (let i = 0; i < 3; i++) { mixed.advance(HOUR); statuses.push((await again()).data.delivery.status); }
  assert.deepEqual(statuses, ['failed', 'uncertain', 'submitted', 'submitted']);
  assert.deepEqual((await mixed.member(b.accountId, person.data.memberId)).invite.sends, [NOW + HOUR, NOW + 2 * HOUR, NOW + 3 * HOUR]);
  mixed.advance(HOUR); assert.equal((await again()).status, 429, 'uncertain and accepted emails still count');
});

test('revoking records who and when; revoked links fail and only an explicit invite restores access', async () => {
  const h = await setup(), a = await h.admin();
  const viewer = await h.call({ action: 'invite_member', name: 'Synthetic Viewer', email: 'viewer@example.invalid', role: 'viewer' }, { cookie: a.cookie });
  h.advance(HOUR);
  assert.equal((await h.call({ action: 'revoke_member', memberId: viewer.data.memberId }, { cookie: a.cookie })).status, 200);
  const revoked = await h.member(a.accountId, viewer.data.memberId);
  assert.deepEqual([revoked.status, revoked.revokedAt, revoked.revokedBy, revoked.inviteHash], ['revoked', new Date(NOW + HOUR).toISOString(), a.memberId, undefined]);
  assert.equal((await h.redeem(viewer.data.invite)).status, 401);
  const resend = await h.call({ action: 'resend_invite', requestId: uid(), memberId: viewer.data.memberId }, { cookie: a.cookie });
  assert.equal(resend.status, 409); assert.match(resend.data.error, /revoked/);
  const client = JSON.stringify((await h.call(null, { cookie: a.cookie })).data);
  assert.equal(client.includes('revokedBy'), false); assert.equal(client.includes('revokedAt'), false);
  const restored = await h.call({ action: 'invite_member', name: 'Synthetic Viewer', email: 'viewer@example.invalid', role: 'viewer' }, { cookie: a.cookie });
  assert.equal(restored.status, 201);
  const back = await h.member(a.accountId, viewer.data.memberId);
  assert.deepEqual([back.status, 'revokedAt' in back, 'revokedBy' in back], ['invited', false, false]);
  assert.deepEqual(back.accessHistory.filter(e => e.event === 'revoked').map(e => [e.at, e.by, e.role]), [[new Date(NOW + HOUR).toISOString(), a.memberId, 'viewer']], 'the revocation stays in the member history after the new invitation');
  assert.equal((await h.call({ action: 'revoke_member', memberId: viewer.data.memberId }, { url: a.staffUrl })).status, 200);
  assert.equal((await h.member(a.accountId, viewer.data.memberId)).revokedBy, 'staff:zacb');
  assert.equal((await h.redeem(restored.data.invite)).status, 401);
});

test('client administrators cannot renew their own access or send email; staff can', async () => {
  const h = await setup(), a = await h.admin();
  for (const action of ['resend_invite', 'reset_sign_in']) {
    const own = await h.call({ action, requestId: uid(), memberId: a.memberId, confirm: true }, { cookie: a.cookie });
    assert.equal(own.status, 409, action); assert.match(own.data.error, /your own sign-in/);
  }
  const email = { action: 'invite_member', requestId: uid(), name: 'Synthetic Guest', email: 'guest@example.invalid', role: 'viewer', deliver: 'email' };
  assert.equal((await h.call(email, { cookie: a.cookie })).status, 403);
  const viewer = await h.call({ action: 'invite_member', name: 'Synthetic Viewer', email: 'viewer@example.invalid', role: 'viewer' }, { cookie: a.cookie });
  assert.equal((await h.call({ action: 'resend_invite', requestId: uid(), memberId: viewer.data.memberId, deliver: 'email' }, { cookie: a.cookie })).status, 403);
  assert.equal((await h.call({ action: 'resend_invite', requestId: uid(), memberId: viewer.data.memberId, deliver: 'fax' }, { url: a.staffUrl })).status, 400);
  const login = await h.redeem(viewer.data.invite);
  assert.equal((await h.call({ action: 'resend_invite', requestId: uid(), memberId: a.memberId }, { cookie: login.cookie })).status, 403, 'only the team permission can renew access');
  assert.equal(h.ghl.calls.length, 0);
  const own = await h.call({ action: 'reset_sign_in', requestId: uid(), memberId: a.memberId, confirm: true, deliver: 'email' }, { url: a.staffUrl });
  assert.equal(own.status, 201, 'EGC staff can renew the administrator'); assert.equal(own.data.delivery.status, 'submitted');
});

test('last-administrator rules still hold alongside resend and reset', async () => {
  const h = await setup(), a = await h.admin();
  const second = await h.call({ action: 'invite_member', name: 'Synthetic Second', email: 'second@example.invalid', role: 'admin' }, { cookie: a.cookie });
  const b = await h.redeem(second.data.invite);
  const reset = await h.call({ action: 'reset_sign_in', requestId: uid(), memberId: second.data.memberId, confirm: true }, { cookie: a.cookie });
  assert.equal(reset.status, 201, 'another active administrator remains');
  assert.equal((await h.call(null, { cookie: b.cookie })).status, 401);
  assert.equal((await h.call({ action: 'revoke_member', memberId: a.memberId }, { cookie: a.cookie })).status, 409, 'the last active administrator cannot revoke themselves');
  assert.equal((await h.call({ action: 'invite_member', name: 'Synthetic Admin', email: 'admin@example.invalid', role: 'viewer' }, { cookie: a.cookie })).status, 409);
  const staffReset = await h.call({ action: 'reset_sign_in', requestId: uid(), memberId: a.memberId, confirm: true }, { url: a.staffUrl });
  assert.equal(staffReset.status, 201, 'only EGC staff can leave the account without an active administrator');
  assert.equal((await h.call(null, { cookie: a.cookie })).status, 401);
  assert.equal((await h.redeem(staffReset.data.invite)).status, 200);
});

test('sales staff can email invitations only for the accounts they own', async () => {
  const h = await setup(); h.setStaff(SALES);
  const owned = await h.onboard({ deliver: 'email', company: 'Synthetic Sales Co' });
  assert.equal(owned.created.data.delivery.status, 'submitted');
  const ledger = [...h.messages.rows.entries()].find(([key]) => key.startsWith('message_sends/'))[1];
  assert.deepEqual([ledger.actorId, ledger.actorRole, ledger.approval], ['synthetic.sales', 'sales', 'template+human_trigger']);
  const emails = h.sent().length;
  h.setStaff(OTHER_SALES);
  const denied = await h.call({ action: 'resend_invite', requestId: uid(), memberId: owned.memberId, deliver: 'email' }, { url: owned.staffUrl });
  assert.equal(denied.status, 403); assert.equal(h.sent().length, emails);
  const saved = await h.account(owned.accountId), memberId = owned.memberId;
  Object.assign(saved.members[0], { version: 9, status: 'invited', invite: { channel: 'email', status: 'sending', generation: 9 } });
  await h.business.commit([{ collection: 'business_accounts', id: owned.accountId, data: saved, version: saved._version }]);
  const direct = actor => h.invites.deliver({ actor, accountId: owned.accountId, memberId, generation: 9, link: 'https://easygaragecleaning.com/business-hub#invite=synthetic', read: (c, id) => h.business.read(c, id), now: h.now });
  assert.deepEqual(await direct(OTHER_SALES), { status: 'not_sent', reason: 'messaging_forbidden', messageId: '', masked: '' });
  assert.deepEqual(await direct({ user: 'synthetic.crew', role: 'crew', businessAccess: false }), { status: 'not_sent', reason: 'messaging_forbidden', messageId: '', masked: '' });
  assert.equal(h.sent().length, emails, 'the approved-send policy itself refuses a sales user on another owner’s account');
  assert.equal(await ownsBusinessAccount(SALES, { ownerStaff: 'synthetic.sales' }), true);
  assert.equal(await ownsBusinessAccount({ ...SALES, role: 'crew' }, { ownerStaff: 'synthetic.sales' }), false);
  assert.equal(await ownsBusinessAccount(SALES, { ownerStaff: '' }), false);
});

test('the approved-send core keeps account_staff closed without the ownership hook and takes b2b_invite only from the hub', async () => {
  const messages = memoryStore({ 'customers/acct-1': { name: 'Synthetic Person', email: 'person@example.invalid', ownerStaff: 'synthetic.sales' } });
  await approveInvite(messages);
  const options = { store: messages, messenger: createGhlMessenger({ env: messagingEnv, fetcher: async () => { throw new Error('no network in this test'); } }), clock: () => new Date(NOW), env: messagingEnv, links: { inviteLink: async () => 'https://easygaragecleaning.com/business-hub#invite=synthetic' } };
  const hooks = { staffGate: salesStaff, accountAccess: ownsBusinessAccount };
  const input = { kind: 'b2b_invite', accountId: 'acct-1' }, human = (actor, source = 'hub') => ({ ...actor, kind: 'human', source });
  await assert.rejects(createApprovedSendService(options).preview(human(SALES), input), error => error.code === 'messaging_forbidden');
  await assert.rejects(createApprovedSendService({ ...options, accountAccess: ownsBusinessAccount }).preview(human(SALES), input), error => error.code === 'messaging_forbidden', 'the ownership hook alone never opens the role');
  await assert.rejects(createApprovedSendService(options).preview(human(OWNER, 'mcp'), input), error => error.code === 'messaging_trigger_not_allowed');
  const preview = await createApprovedSendService({ ...options, ...hooks }).preview(human(SALES), input);
  assert.deepEqual([preview.status, preview.approval, preview.recipient.masked], ['ready', 'template+human_trigger', 'p•••@example.invalid']);
  await assert.rejects(createApprovedSendService({ ...options, ...hooks }).preview(human(OTHER_SALES), input), error => error.code === 'messaging_forbidden');
  assert.equal((await createApprovedSendService(options).preview(human(OWNER), input)).status, 'ready', 'business managers pass the business role');
});

test('crew and other non-business actors get 403 for b2b_invite before any record is read, whether the account exists or not', async () => {
  const messages = memoryStore({ 'customers/acct-1': { name: 'Synthetic Person', email: 'person@example.invalid', ownerStaff: 'synthetic.sales' } });
  await approveInvite(messages);
  const reads = [], store = { ...messages, read: async (c, id) => { reads.push(`${c}/${id}`); return messages.read(c, id); } };
  const options = { store, messenger: {}, clock: () => new Date(NOW), env: messagingEnv };
  const refused = async (service, actor, accountId) => {
    const errors = [];
    for (const call of [() => service.preview(actor, { kind: 'b2b_invite', accountId }), () => service.status(actor, { kind: 'b2b_invite', accountId })]) await call().catch(error => errors.push([error.code, error.status, error.message]));
    return errors;
  };
  for (const service of [createApprovedSendService(options), createApprovedSendService({ ...options, staffGate: salesStaff, accountAccess: ownsBusinessAccount })]) {
    for (const actor of [CREW, { ...SALES, role: 'crew_lead', kind: 'human', source: 'hub' }]) {
      const existing = await refused(service, actor, 'acct-1'), missing = await refused(service, actor, 'acct-missing');
      assert.deepEqual(existing.map(([code, status]) => [code, status]), [['messaging_forbidden', 403], ['messaging_forbidden', 403]], actor.role);
      assert.deepEqual(existing, missing, 'an existing and a missing account get the same answer');
    }
  }
  const reject = createApprovedSendService(options);
  assert.deepEqual(await refused(reject, { ...SALES, kind: 'human', source: 'hub' }, 'acct-missing'), await refused(reject, { ...SALES, kind: 'human', source: 'hub' }, 'acct-1'), 'the default /api/messages service refuses sales before reading');
  assert.deepEqual(reads.filter(key => !key.startsWith('message_templates')), [], 'no account was read for a refused role');
  const hooked = createApprovedSendService({ ...options, staffGate: salesStaff, accountAccess: ownsBusinessAccount }), other = { ...OTHER_SALES, kind: 'human', source: 'hub' };
  assert.deepEqual(await refused(hooked, other, 'acct-missing'), await refused(hooked, other, 'acct-1'), 'sales staff cannot tell another owner’s account from a missing one');
});

test('concurrent resends commit and send at most once', async () => {
  const h = await setup(), a = await h.admin();
  const invited = await h.call({ action: 'invite_member', requestId: uid(), name: 'Synthetic Pending', email: 'pending@example.invalid', role: 'viewer', deliver: 'email' }, { url: a.staffUrl });
  const emails = h.sent().length;
  for (const sameRequest of [false, true]) {
    // Every submission makes all of its reads (the account, its receipt, then the mailbox and sender email caps) before any
    // of them commits; only the version precondition separates them. The gate holds each commit until all three submissions
    // have reached theirs or ended without one, so a submission that fails early is a clear failure here, never a hang.
    // Holding only the receipt read left the cap reads to race the winner's commit behind async digests: under load a loser
    // could read the mailbox cap after the winner's committed send filled it (3 of 3) and answer 429 instead of 409.
    let open = false, ended = 0; const held = [];
    const release = () => { if (!open && held.length + ended === 3) { open = true; held.forEach(go => go()); } };
    h.business.hooks.beforeCommit = () => open ? null : new Promise(go => { held.push(go); release(); });
    const requestId = uid(), input = () => ({ action: 'resend_invite', requestId: sameRequest ? requestId : uid(), memberId: invited.data.memberId, deliver: 'email' });
    const results = await Promise.all([1, 2, 3].map(() => h.call(input(), { url: a.staffUrl }).finally(() => { ended += 1; release(); })));
    h.business.hooks.beforeCommit = null;
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409, 409], String(sameRequest));
  }
  assert.equal(h.sent().length, emails + 2, 'one email per winning resend');
  assert.equal((await h.member(a.accountId, invited.data.memberId)).version, 3);
  const caps = h.business.rows('business_operations').filter(r => r.kind === 'invite_email_quota');
  assert.deepEqual(caps.map(r => [r.scope, r.sends.length]).sort(), [['address', 3], ['sender', 3]], 'the email caps hold only committed sends: a losing resend claims none');
});

test('reset_sign_in needs confirm:true, ends the current session and issues a new link; resend refuses signed-in members', async () => {
  const h = await setup(), a = await h.admin();
  const viewer = await h.call({ action: 'invite_member', name: 'Synthetic Viewer', email: 'viewer@example.invalid', role: 'viewer' }, { cookie: a.cookie });
  const session = await h.redeem(viewer.data.invite);
  const resend = await h.call({ action: 'resend_invite', requestId: uid(), memberId: viewer.data.memberId }, { cookie: a.cookie });
  assert.equal(resend.status, 409); assert.match(resend.data.error, /Reset sign-in/);
  const before = await h.member(a.accountId, viewer.data.memberId);
  assert.equal((await h.call({ action: 'reset_sign_in', requestId: uid(), memberId: viewer.data.memberId }, { cookie: a.cookie })).status, 400);
  assert.deepEqual(await h.member(a.accountId, viewer.data.memberId), before);
  assert.equal((await h.call(null, { cookie: session.cookie })).status, 200);
  const reset = await h.call({ action: 'reset_sign_in', requestId: uid(), memberId: viewer.data.memberId, confirm: true }, { cookie: a.cookie });
  assert.equal(reset.status, 201);
  assert.equal((await h.call(null, { cookie: session.cookie })).status, 401, 'the previous session is bound to the old generation');
  assert.ok(h.business.rows('business_audit').some(r => r.action === 'sign_in_reset'));
  assert.equal((await h.call({ action: 'reset_sign_in', requestId: uid(), memberId: viewer.data.memberId, confirm: true }, { cookie: a.cookie })).status, 409, 'an invited member is resent, not reset');
  assert.equal((await h.redeem(reset.data.invite)).status, 200);
  h.advance(8 * DAY);
  const ended = await h.call({ action: 'resend_invite', requestId: uid(), memberId: viewer.data.memberId }, { url: a.staffUrl });
  assert.equal(ended.status, 201, 'a member whose sign-in ended can be resent without a reset');
});

test('invitation status reaches team viewers only and never exposes delivery internals', async () => {
  const h = await setup(), a = await h.admin();
  const pending = await h.call({ action: 'invite_member', requestId: uid(), name: 'Synthetic Pending', email: 'pending@example.invalid', role: 'billing', deliver: 'email' }, { url: a.staffUrl });
  const viewer = await h.call({ action: 'invite_member', name: 'Synthetic Viewer', email: 'viewer@example.invalid', role: 'viewer' }, { cookie: a.cookie });
  const v = await h.redeem(viewer.data.invite);
  const find = (view, name) => view.members.find(m => m.name === name);
  let admin = (await h.call(null, { cookie: a.cookie })).data;
  assert.deepEqual(find(admin, 'Synthetic Pending'), { id: pending.data.memberId, name: 'Synthetic Pending', role: 'billing', status: 'invited', email: 'pending@example.invalid', inviteStatus: 'pending', deliveryStatus: 'submitted', lastSentAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 48 * HOUR).toISOString() });
  assert.deepEqual([find(admin, 'Synthetic Admin').self, find(admin, 'Synthetic Admin').deliveryStatus, find(admin, 'Synthetic Viewer').self], [true, 'manual', undefined]);
  assert.equal(find(admin, 'Synthetic Viewer').inviteStatus, 'active'); assert.equal(find(admin, 'Synthetic Viewer').expiresAt, '');
  for (const secret of ['attemptId', 'sentBy', 'messageId', 'sends', 'message-', 'staff:', 'zacb', 'inviteHash', 'sessionExpiresAt']) assert.equal(JSON.stringify(admin).includes(secret), false, secret);
  const readOnly = JSON.stringify((await h.call(null, { cookie: v.cookie })).data);
  for (const field of ['inviteStatus', 'deliveryStatus', 'lastSentAt', 'expiresAt', '"self"']) assert.equal(readOnly.includes(field), false, field);
  const staff = (await h.call(null, { url: a.staffUrl })).data;
  assert.equal(staff.inviteDelivery.email, true); assert.equal(find(staff, 'Synthetic Admin').self, undefined); assert.equal(find(staff, 'Synthetic Pending').inviteStatus, 'pending');
  assert.equal((await h.call(null, { url: '?staff=1' })).data.inviteDelivery.email, true);
  h.advance(49 * HOUR);
  assert.equal(find((await h.call(null, { url: a.staffUrl })).data, 'Synthetic Pending').inviteStatus, 'expired');
  h.advance(6 * DAY);
  assert.equal(find((await h.call(null, { url: a.staffUrl })).data, 'Synthetic Viewer').inviteStatus, 'sign_in_ended');
  const legacy = { id: uid(), name: 'Legacy', email: 'legacy@example.invalid', role: 'viewer', status: 'invited', version: 1, inviteHash: 'hash', inviteExpiresAt: NOW + 10 * HOUR };
  const account = { id: uid(), company: 'Synthetic Legacy', status: 'active', members: [{ id: uid(), name: 'Admin', email: 'a@example.invalid', role: 'admin', status: 'active', version: 1 }, legacy] };
  const view = accountView(account, account.members[0], [], { now: NOW });
  assert.deepEqual(view.members[1], { id: legacy.id, name: 'Legacy', role: 'viewer', status: 'invited', email: 'legacy@example.invalid', inviteStatus: 'pending', deliveryStatus: 'manual', lastSentAt: new Date(NOW - 38 * HOUR).toISOString(), expiresAt: new Date(NOW + 10 * HOUR).toISOString() });
  assert.deepEqual(view.members[0].inviteStatus, 'active', 'an active member saved before sessionExpiresAt stays active');
  assert.equal(accountView(account, account.members[0], []).members[1].inviteStatus, 'pending', 'without a clock nothing is reported expired');
  assert.deepEqual(['invited', 'active', 'revoked', 'other'].map(status => inviteState({ status, inviteExpiresAt: NOW, sessionExpiresAt: NOW }, NOW)), ['expired', 'sign_in_ended', 'revoked', 'unknown']);
});

test('a revoke that lands during the send stops it before the provider call and is not overwritten', async () => {
  const h = await setup(), a = await h.admin();
  const upserts = h.ghl.calls.length;
  const revoke = async () => {
    const saved = await h.account(a.accountId), target = saved.members.find(m => m.email === 'racer@example.invalid');
    Object.assign(target, { status: 'revoked', version: target.version + 1 });
    await h.business.commit([{ collection: 'business_accounts', id: a.accountId, data: saved, version: saved._version }]);
  };
  let fired = false;
  const store = h.business, read = store.read.bind(store);
  store.read = async (c, id) => { const row = await read(c, id); if (!fired && c === 'business_accounts' && h.ghl.calls.length > upserts) { fired = true; await revoke(); return read(c, id); } return row; };
  const invited = await h.call({ action: 'invite_member', requestId: uid(), name: 'Synthetic Racer', email: 'racer@example.invalid', role: 'viewer', deliver: 'email' }, { url: a.staffUrl });
  assert.equal(invited.status, 201); assert.equal(fired, true);
  assert.deepEqual([invited.data.delivery.status, invited.data.delivery.reason, invited.data.delivery.recorded], ['not_sent', 'messaging_target_not_found', false]);
  assert.equal(h.ghl.sends().length, 0); assert.equal(h.ghl.calls.at(-1).path.startsWith('/contacts/'), true);
  const saved = await h.member(a.accountId, invited.data.memberId);
  assert.deepEqual([saved.status, saved.invite.status], ['revoked', 'sending'], 'the outcome is never written over a newer generation');
  assert.deepEqual(saved.invite.sends, [], 'the stopped send is not counted toward the daily limit');
  assert.equal(h.business.rows('business_audit').filter(r => r.action === 'invite_email_released').length, 1);
});

test('the member recipient resolver only answers for a live email claim of the exact generation', async () => {
  const store = new MemoryStore(), accountId = uid(), memberId = uid();
  const base = { id: memberId, name: 'Synthetic Person', email: 'person@example.invalid', status: 'invited', version: 3, invite: { channel: 'email', status: 'sending', generation: 3 } };
  const put = async (member, status = 'active') => { store.records.clear(); await store.commit([{ collection: 'business_accounts', id: accountId, data: { status, ownerStaff: 'synthetic.sales', members: [member] } }]); };
  const resolve = businessMemberRecipient((c, id) => store.read(c, id));
  await put(base);
  assert.deepEqual(await resolve(null, memberRecipientId(accountId, memberId, 3)), { id: memberRecipientId(accountId, memberId, 3), name: 'Synthetic Person', email: 'person@example.invalid', phone: '', highlevelContactId: '', ownerStaff: 'synthetic.sales' });
  for (const name of ['https://egc-billing.example/pay-now Smith', 'egc-billing.example Smith', 'Call 5551234 now', undefined]) {
    await put({ ...base, name });
    assert.equal((await resolve(null, memberRecipientId(accountId, memberId, 3))).name, '', `a saved name that is not a plain name never reaches the greeting or the contact: ${name}`);
  }
  assert.equal(await resolve(null, memberRecipientId(accountId, memberId, 2)), null);
  for (const change of [{ status: 'active' }, { status: 'revoked' }, { invite: { ...base.invite, status: 'submitted' } }, { invite: { ...base.invite, channel: 'manual' } }, { version: 4 }]) { await put({ ...base, ...change }); assert.equal(await resolve(null, memberRecipientId(accountId, memberId, 3)), null, JSON.stringify(change)); }
  await put(base, 'inactive'); assert.equal(await resolve(null, memberRecipientId(accountId, memberId, 3)), null);
  for (const id of ['', 'acct-1', `${accountId}_${memberId}_0`, `${accountId}_${memberId}`, `${accountId.toUpperCase()}_${memberId}_3`]) assert.equal(await resolve(null, id), null, id);
});

test('expired business sessions are purged, bounded, on redeem and logout; a purge failure never blocks either', async () => {
  const store = new MemoryStore(), calls = [];
  store.purgeExpiredSessions = async (now, limit) => {
    calls.push([now, limit]);
    const expired = [...store.records.entries()].filter(([key, row]) => key.startsWith('business_sessions/') && row.expiresAt <= now).slice(0, limit);
    for (const [key] of expired) store.records.delete(key);
    return expired.length;
  };
  const h = await setup({ store });
  for (let i = 0; i < 30; i++) await store.commit([{ collection: 'business_sessions', id: createHash('sha256').update('old' + i).digest('hex'), data: { accountId: uid(), memberId: uid(), memberVersion: 1, expiresAt: NOW - DAY + i } }]);
  const a = await h.admin();
  assert.deepEqual(calls, [[NOW, 20]]);
  assert.equal(store.rows('business_sessions').length, 11, '20 of 30 expired records removed; the new session stays');
  h.advance(HOUR);
  assert.equal((await h.call({ action: 'logout' }, { cookie: a.cookie })).status, 200);
  assert.deepEqual(calls.at(-1), [NOW + HOUR, 20]); assert.equal(store.rows('business_sessions').length, 0);
  store.purgeExpiredSessions = async () => { throw new Error('synthetic purge outage'); };
  const b = await h.admin({ company: 'Synthetic Second Co', address: 'second@example.invalid' });
  assert.equal((await h.call({ action: 'logout' }, { cookie: b.cookie })).status, 200);
  assert.equal((await h.call(null, { cookie: b.cookie })).status, 401);
});

test('the session purge never holds up sign-in or sign-out: it runs through waitUntil, or delays the response at most two seconds', async t => {
  const store = new MemoryStore(), background = [];
  let release; const hanging = new Promise(done => { release = done; });
  store.purgeExpiredSessions = async () => { await hanging; return 3; };
  const h = await setup({ store, waitUntil: task => background.push(task) });
  const a = await h.admin();
  assert.equal(background.length, 1, 'redeem answered while its purge was still running');
  assert.equal((await h.call({ action: 'logout' }, { cookie: a.cookie })).status, 200); assert.equal(background.length, 2);
  release(); assert.deepEqual(await Promise.all(background), [3, 3]);
  const failing = new MemoryStore(); failing.purgeExpiredSessions = () => { throw new Error('synthetic synchronous failure'); };
  const f = await setup({ store: failing, waitUntil: () => { throw new Error('synthetic runtime without background work'); } });
  assert.equal((await f.call({ action: 'logout' }, { cookie: (await f.admin()).cookie })).status, 200);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = new MemoryStore(); let started;
  const called = new Promise(done => { started = done; });
  slow.purgeExpiredSessions = () => { started(); return new Promise(() => {}); };
  const s = await setup({ store: slow }), created = await s.onboard();
  let settled = false; const login = s.redeem(created.created.data.invite).then(result => { settled = true; return result; });
  await called; t.mock.timers.tick(1999); await new Promise(done => setImmediate(done));
  assert.equal(settled, false, 'without waitUntil the response waits for the purge, but only briefly');
  t.mock.timers.tick(1); assert.equal((await login).status, 200);
});

test('the Firestore store purges with a bounded expiry query and version-preconditioned deletes', async () => {
  const calls = [], expired = 'a'.repeat(64), fresh = 'b'.repeat(64);
  const doc = (id, expiresAt) => ({ name: `${ROOT}/business_sessions/${id}`, updateTime: `2026-09-22T12:00:0${id === expired ? 1 : 2}.000000Z`, fields: encodeFirestoreFields({ expiresAt }) });
  let commitStatus = 200;
  const fetcher = async (env, input, init = {}) => {
    const url = new URL(String(input)), body = init.body ? JSON.parse(init.body) : null; calls.push({ url, body, signal: init.signal });
    assert.equal(url.hostname, 'firestore.googleapis.com');
    if (url.pathname.endsWith(':runQuery')) return Response.json([{ document: doc(expired, NOW - 1) }, { document: doc(fresh, NOW + 1) }, { document: { ...doc('bad', 0) } }, { readTime: 'x' }]);
    if (url.pathname.endsWith(':commit')) return Response.json({}, { status: commitStatus });
    return Response.json({}, { status: 404 });
  };
  const store = createBusinessStore({}, fetcher);
  assert.equal(await store.purgeExpiredSessions(NOW, 500), 1);
  const [query, commit] = calls;
  assert.deepEqual(query.body.structuredQuery.where.fieldFilter, { field: { fieldPath: 'expiresAt' }, op: 'LESS_THAN_OR_EQUAL', value: { integerValue: String(NOW) } });
  assert.equal(query.body.structuredQuery.limit, 25); assert.deepEqual(query.body.structuredQuery.from, [{ collectionId: 'business_sessions' }]);
  assert.deepEqual(commit.body.writes, [{ delete: `${ROOT}/business_sessions/${expired}`, currentDocument: { updateTime: '2026-09-22T12:00:01.000000Z' } }]);
  assert.ok(query.signal instanceof AbortSignal && commit.signal instanceof AbortSignal, 'both purge calls are time-bounded');
  commitStatus = 409; assert.equal(await store.purgeExpiredSessions(NOW, 5), 0);
  assert.equal(calls.at(-2).body.structuredQuery.limit, 5);
  assert.equal(await createBusinessStore({}, async () => Response.json({}, { status: 503 })).purgeExpiredSessions(NOW), 0);
  assert.equal(await store.purgeExpiredSessions(Number.NaN), 0);
});

test('invitation emails are also capped per mailbox and per EGC sender across accounts; both reset after 24 hours', async () => {
  const h = await setup(); h.setStaff(SALES);
  const create = (address, deliver = 'email') => h.call({ action: 'create_account', requestId: uid(), company: 'Synthetic Victim Co', name: 'Synthetic Admin', email: address, deliver }, { url: '?staff=1' });
  // Case and +tags fold into one mailbox: three emails through three new accounts, then a fourth account is refused whole.
  for (const address of ['victim@example.invalid', 'Victim+1@example.invalid', 'victim+2@example.invalid']) assert.equal((await create(address)).data.delivery.status, 'submitted', address);
  const accounts = h.business.rows('business_accounts').length, calls = h.ghl.calls.length;
  const fourth = await create('victim+3@example.invalid');
  assert.equal(fourth.status, 429); assert.match(fourth.data.error, /email address was already sent three invitations in the last 24 hours/);
  assert.equal(h.business.rows('business_accounts').length, accounts, 'a refused onboarding creates no account'); assert.equal(h.ghl.calls.length, calls, 'and upserts no contact');
  const manual = await create('victim+4@example.invalid', 'manual');
  assert.equal(manual.status, 201, 'a private link is never capped'); assert.ok(manual.data.invite);
  // Within one owned account the mailbox cap holds too, whatever the +tag.
  const staffUrl = '?staff=1&account=' + manual.data.accountId;
  const invite = (address, name = 'Synthetic Guest') => h.call({ action: 'invite_member', requestId: uid(), name, email: address, role: 'viewer', deliver: 'email' }, { url: staffUrl });
  for (let i = 0; i < 3; i++) assert.equal((await invite(`guest+${i}@example.invalid`)).data.delivery.status, 'submitted');
  assert.equal((await invite('guest+3@example.invalid')).status, 429);
  // Six emails so far; fourteen more distinct people reach the 20-per-day sender cap.
  for (let i = 0; i < 14; i++) assert.equal((await invite(`person.${String.fromCharCode(97 + i)}@example.invalid`)).status, 201);
  assert.equal(h.sent().length, 20);
  const sender = await invite('fresh@example.invalid');
  assert.equal(sender.status, 429); assert.match(sender.data.error, /You have emailed 20 invitations in the last 24 hours/);
  assert.equal((await create('fresh@example.invalid')).status, 429, 'the sender cap spans every account');
  assert.equal(h.sent().length, 20);
  h.setStaff(OTHER_SALES);
  assert.equal((await h.call({ action: 'create_account', requestId: uid(), company: 'Synthetic Other Co', name: 'Synthetic Admin', email: 'other@example.invalid', deliver: 'email' }, { url: '?staff=1' })).data.delivery.status, 'submitted', 'each sender has their own cap');
  h.setStaff(SALES);
  h.advance(DAY - 1); assert.equal((await invite('fresh@example.invalid')).status, 429, 'still within 24 hours');
  h.advance(1);
  assert.equal((await invite('fresh@example.invalid')).data.delivery.status, 'submitted', 'the sender cap resets after 24 hours');
  assert.equal((await create('victim+5@example.invalid')).data.delivery.status, 'submitted', 'the mailbox cap resets after 24 hours');
  const quotas = h.business.rows('business_operations').filter(r => r.kind === 'invite_email_quota');
  assert.deepEqual(quotas.map(q => q.scope).sort(), ['address', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'address', 'sender', 'sender'].sort());
  assert.equal(JSON.stringify(quotas).includes('example.invalid'), false, 'quota records hold hashed ids, never the address');
  const senderQuota = quotas.find(q => q.scope === 'sender' && q.sends.some(e => e.accountId === manual.data.accountId));
  assert.deepEqual(senderQuota.sends.map(e => e.at), [NOW + DAY, NOW + DAY], 'only the last 24 hours are kept');
});

test('attempts that emailed nothing are released from the mailbox and sender caps as well', async () => {
  const h = await setup({ settings: { HIGHLEVEL_API_KEY: '' } }); h.setStaff(SALES);
  for (let i = 0; i < 21; i++) {
    const a = await h.onboard({ deliver: 'email', company: 'Synthetic Retry Co', address: 'victim@example.invalid' });
    assert.equal(a.created.data.delivery.status, 'not_configured', String(i));
  }
  const quotas = h.business.rows('business_operations').filter(r => r.kind === 'invite_email_quota');
  assert.deepEqual(quotas.map(q => [q.scope, q.sends]).sort(), [['address', []], ['sender', []]]);
  assert.equal(h.business.rows('business_audit').filter(r => r.action === 'invite_delivery_recorded' && r.details?.released === true).length, 21);
});

test('membership audit rows name the member, role, generation and channel; revocations stay on the member and a second revoke is a no-op', async () => {
  const h = await setup(), a = await h.admin(), start = h.business.rows('business_audit').length, address = 'person@example.invalid';
  const viewer = await h.call({ action: 'invite_member', name: 'Synthetic Person', email: address, role: 'viewer' }, { cookie: a.cookie }), memberId = viewer.data.memberId;
  assert.equal((await h.call({ action: 'invite_member', name: 'Synthetic Person', email: address, role: 'admin' }, { url: a.staffUrl })).status, 201);
  h.advance(HOUR);
  assert.deepEqual((await h.call({ action: 'revoke_member', memberId }, { url: a.staffUrl })).data, { ok: true });
  const revoked = await h.member(a.accountId, memberId), audits = h.business.rows('business_audit').length;
  h.advance(HOUR);
  assert.deepEqual((await h.call({ action: 'revoke_member', memberId }, { cookie: a.cookie })).data, { ok: true, unchanged: true });
  assert.deepEqual(await h.member(a.accountId, memberId), revoked, 'a second revoke keeps the first revokedAt and revokedBy');
  assert.equal(h.business.rows('business_audit').length, audits);
  await h.call({ action: 'invite_member', requestId: uid(), name: 'Synthetic Person', email: address, role: 'manager', deliver: 'email' }, { url: a.staffUrl });
  await h.call({ action: 'resend_invite', requestId: uid(), memberId, deliver: 'email' }, { url: a.staffUrl });
  assert.equal((await h.redeem(h.sent().at(-1).code)).status, 200);
  assert.equal((await h.call({ action: 'reset_sign_in', requestId: uid(), memberId, confirm: true }, { url: a.staffUrl })).status, 201);
  const rows = h.business.rows('business_audit').slice(start).filter(r => r.details?.memberId === memberId).map(r => [r.action, r.actorId, r.details]);
  assert.deepEqual(rows, [
    ['member_invited', a.memberId, { memberId, role: 'viewer', generation: 1, channel: 'manual', created: true }],
    ['member_invited', 'staff:zacb', { memberId, role: 'admin', previousRole: 'viewer', generation: 2, channel: 'manual', previousStatus: 'invited' }],
    ['revoke_member', 'staff:zacb', { memberId, role: 'admin', generation: 3, previousStatus: 'invited' }],
    ['member_invited', 'staff:zacb', { memberId, role: 'manager', previousRole: 'admin', generation: 4, channel: 'email', previousStatus: 'revoked' }],
    ['invite_delivery_recorded', 'staff:zacb', { memberId, generation: 4, channel: 'email', status: 'submitted' }],
    ['invite_resent', 'staff:zacb', { memberId, role: 'manager', generation: 5, channel: 'email', previousStatus: 'invited' }],
    ['invite_delivery_recorded', 'staff:zacb', { memberId, generation: 5, channel: 'email', status: 'submitted' }],
    ['invitation_redeemed', memberId, { memberId, role: 'manager', generation: 5 }],
    ['sign_in_reset', 'staff:zacb', { memberId, role: 'manager', generation: 6, channel: 'manual', previousStatus: 'active' }],
  ]);
  const member = await h.member(a.accountId, memberId);
  assert.deepEqual(member.accessHistory.map(e => [e.event, e.by, e.role, e.generation]), [
    ['invited', a.memberId, 'viewer', 1], ['invited', 'staff:zacb', 'admin', 2], ['revoked', 'staff:zacb', 'admin', 3], ['invited', 'staff:zacb', 'manager', 4], ['resent', 'staff:zacb', 'manager', 5], ['reset', 'staff:zacb', 'manager', 6],
  ]);
  assert.equal(member.accessHistory[2].at, new Date(NOW + HOUR).toISOString(), 'who revoked and when survives the later invitations');
  for (let i = 0; i < 6; i++) assert.equal((await h.call({ action: 'resend_invite', requestId: uid(), memberId }, { url: a.staffUrl })).status, 201);
  const trimmed = (await h.member(a.accountId, memberId)).accessHistory;
  assert.deepEqual([trimmed.length, trimmed[0].event, trimmed.at(-1).event, trimmed.at(-1).generation], [10, 'revoked', 'resent', 12], 'the member keeps its last ten access changes');
  for (const view of [(await h.call(null, { cookie: a.cookie })).data, (await h.call(null, { url: a.staffUrl })).data]) assert.equal(JSON.stringify(view).includes('accessHistory'), false);
});

test('member names are plain names; a web address never becomes the greeting of an EGC invitation email', async () => {
  const h = await setup(), a = await h.admin();
  for (const name of ['https://egc-billing.example/pay-now Smith', 'egc-billing.example Smith', 'Visit www.x now', 'Bob 2', 'bob@example.invalid', 'a:b', '...']) {
    const refused = await h.call({ action: 'invite_member', name, email: 'guest@example.invalid', role: 'viewer' }, { cookie: a.cookie });
    assert.equal(refused.status, 400, name); assert.match(refused.data.error, /letters, spaces and simple punctuation/);
  }
  const accounts = h.business.rows('business_accounts').length;
  assert.equal((await h.call({ action: 'create_account', requestId: uid(), company: 'Synthetic Co', name: 'https://egc-billing.example/pay', email: 'x@example.invalid', deliver: 'email' }, { url: '?staff=1' })).status, 400);
  assert.equal(h.business.rows('business_accounts').length, accounts); assert.equal(h.ghl.calls.length, 0);
  for (const name of ['Mary-Jane O’Neil', "D'Arcy Smith", 'José Núñez', 'J.R. Smith, Jr.', 'Dr. Ann St. Clair']) {
    assert.equal(safeName(name), true, name);
    assert.equal((await h.call({ action: 'invite_member', name, email: `ok.${name.length}@example.invalid`, role: 'viewer' }, { cookie: a.cookie })).status, 201, name);
  }
  // A name saved before this check is never emailed: staff get a clear refusal, a private link still works, and
  // inviting the same address again with the name corrected emails the plain name.
  const saved = await h.account(a.accountId), legacyId = uid();
  saved.members.push({ id: legacyId, name: 'https://egc-billing.example/pay-now Smith', email: 'legacy@example.invalid', role: 'viewer', status: 'invited', version: 1, inviteHash: 'synthetic', inviteExpiresAt: NOW + HOUR });
  await h.business.commit([{ collection: 'business_accounts', id: a.accountId, data: saved, version: saved._version }]);
  const before = await h.member(a.accountId, legacyId);
  const resent = await h.call({ action: 'resend_invite', requestId: uid(), memberId: legacyId, deliver: 'email' }, { url: a.staffUrl });
  assert.equal(resent.status, 409); assert.match(resent.data.error, /saved name is not a plain name/);
  assert.deepEqual(await h.member(a.accountId, legacyId), before); assert.equal(h.ghl.calls.length, 0);
  assert.equal((await h.call({ action: 'resend_invite', requestId: uid(), memberId: legacyId }, { url: a.staffUrl })).status, 201, 'a private link is still available');
  const fixed = await h.call({ action: 'invite_member', requestId: uid(), name: 'Legacy Smith', email: 'legacy@example.invalid', role: 'viewer', deliver: 'email' }, { url: a.staffUrl });
  assert.deepEqual([fixed.data.memberId, fixed.data.delivery.status], [legacyId, 'submitted']);
  const [mail] = h.sent();
  assert.match(mail.body.message, /^Hi Legacy,\n\nYou have been invited/); assert.equal(JSON.stringify(h.ghl.calls).includes('egc-billing'), false);
  // Defense in depth: even with the hub check bypassed, the recipient resolver gives the core no name and it sends nothing.
  const bypass = await h.account(a.accountId), racer = bypass.members.find(m => m.id === legacyId);
  Object.assign(racer, { name: 'https://egc-billing.example/pay-now Smith', version: 9, status: 'invited', invite: { channel: 'email', status: 'sending', generation: 9 } });
  await h.business.commit([{ collection: 'business_accounts', id: a.accountId, data: bypass, version: bypass._version }]);
  const direct = await h.invites.deliver({ actor: OWNER, accountId: a.accountId, memberId: legacyId, generation: 9, link: 'https://easygaragecleaning.com/business-hub#invite=synthetic', read: (c, id) => h.business.read(c, id), now: h.now });
  assert.deepEqual([direct.status, direct.reason], ['not_sent', 'messaging_template_variable_missing']); assert.equal(h.sent().length, 1);
});

test('wording without {{inviteLink}} cannot be approved, and a version approved without it emails nothing and returns the link', async () => {
  const h = await setup({ approve: false }), at = new Date(NOW).toISOString();
  const seeded = await readTemplate(h.messages, 'b2b_invite');
  await mutateTemplate(h.messages, templateOwner, { action: 'save_draft', requestId: uuid(), kind: 'b2b_invite', expectedVersion: seeded.latestVersion, channel: 'Email', subject: 'Welcome to your business hub', body: 'Hi {{firstName}}, welcome! Call {{companyPhone}} with questions.' }, at);
  const draft = await readTemplate(h.messages, 'b2b_invite'), version = draft.versions.at(-1);
  await assert.rejects(mutateTemplate(h.messages, templateOwner, { action: 'approve', requestId: uuid(), kind: 'b2b_invite', expectedVersion: draft.latestVersion, version: version.version, hash: version.hash }, at),
    error => error.code === 'messaging_template_variable_required' && error.status === 409 && /\{\{inviteLink\}\}/.test(error.message));
  assert.equal((await readTemplate(h.messages, 'b2b_invite')).activeVersion, null);
  // Simulate wording approved before that rule existed.
  const key = `${MESSAGE_TEMPLATES}/b2b_invite`, doc = h.messages.get(key);
  h.messages.edit(key, { versions: doc.versions.map(row => row.version === version.version ? { ...row, status: 'approved', approvedBy: 'zacb', approvedAt: at } : row), activeVersion: version.version });
  assert.equal((await readTemplate(h.messages, 'b2b_invite')).activeVersion, version.version);
  const a = await h.onboard({ deliver: 'email' });
  assert.deepEqual([a.created.data.delivery.status, a.created.data.delivery.reason], ['not_sent', 'template_missing_invite_link']);
  assert.match(a.created.data.invite, /^[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{64}$/, 'staff get the private link instead');
  assert.equal(h.ghl.sends().length, 0); assert.equal([...h.messages.rows.keys()].some(k => k.startsWith('message_sends/')), false);
  assert.deepEqual((await h.member(a.accountId, a.memberId)).invite.sends, [], 'nothing counts toward the daily limit');
  assert.deepEqual(h.business.rows('business_operations').filter(r => r.kind === 'invite_email_quota').map(q => q.sends), [[], []]);
  assert.equal((await h.redeem(a.created.data.invite)).status, 200);
});

test('a new invitation sign-in clears the earlier project cookie and ends the business session it replaces', async () => {
  const h = await setup(), first = await h.admin();
  const second = await h.onboard({ company: 'Synthetic Second Co', address: 'second@example.invalid' });
  h.advance(HOUR);
  const res = await h.call({ action: 'redeem', invite: second.created.data.invite }, { cookie: first.cookie });
  assert.equal(res.status, 200);
  assert.match(res.cookie, /^__Host-egc_business=[a-f0-9]{64}; /); assert.match(res.cookie, /, project=; Max-Age=0$/, 'the customer-portal project cookie is cleared');
  const current = res.cookie.split(';')[0];
  assert.equal((await h.call(null, { cookie: current })).status, 200);
  assert.equal((await h.call(null, { cookie: first.cookie })).status, 401, 'the replaced session no longer works, even if its cookie was copied');
  const staff = (await h.call(null, { url: first.staffUrl })).data;
  assert.equal(staff.members.find(m => m.id === first.memberId).inviteStatus, 'sign_in_ended', 'the earlier member can be renewed');
  const ended = h.business.rows('business_audit').filter(r => r.action === 'signed_out');
  assert.deepEqual(ended.map(r => [r.accountId, r.details]), [[first.accountId, { memberId: first.memberId, generation: 1, via: 'new_sign_in' }]]);
  const refused = await h.call({ action: 'redeem', invite: `${second.accountId}.${second.memberId}.${'0'.repeat(64)}` }, { cookie: current });
  assert.equal(refused.status, 401); assert.equal((await h.call(null, { cookie: current })).status, 200, 'a failed sign-in leaves the current session alone');
  const third = await h.onboard({ company: 'Synthetic Third Co', address: 'third@example.invalid' });
  const plain = await h.call({ action: 'redeem', invite: third.created.data.invite });
  assert.match(plain.cookie, /, project=; Max-Age=0$/, 'every sign-in clears a leftover project cookie');
});
