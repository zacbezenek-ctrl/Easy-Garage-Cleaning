import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovedSendService, createConfirmToken, CONFIRM_TTL_MS, messagingFlags } from '../functions/_lib/approved-send.js';
import { createGhlMessenger } from '../functions/_lib/ghl-messenger.js';
import { mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { messagingStorage } from '../functions/_lib/message-send-store.js';
import { quietHoursDecision, reminderWindow, MESSAGE_POLICIES } from '../functions/_lib/message-policies.js';
import { TEMPLATE_KINDS } from '../functions/_lib/message-template-defaults.js';
import { crewJobProjection } from '../functions/_lib/crew-job-projection.js';
import { customerDepositState, customerMoneyState } from '../functions/_lib/customer-payments.js';
import { env, owner, manager, crew, otherCrew, automation, job, memoryStore, fakeGhl, clock, uuid, NOW } from './helpers/messaging-fixture.mjs';

const code = expected => error => { assert.equal(error.code, expected); return true; };
const PAY = 'https://easygaragecleaning.com/pay/synthetic-pay-token';
const claims = token => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
const DAY = 86400000;
const notEligible = reason => error => { assert.equal(error.code, 'messaging_not_eligible'); assert.equal(error.details.reason, reason); return true; };

async function setup({ kinds = ['on_my_way'], automated = [], jobFields = {}, ghl: ghlOptions = {}, flags = {}, links, attachments, crewContact, readAccount, at = NOW, rows = {} } = {}) {
  const store = memoryStore({ 'jobs/job-1': job(jobFields), ...rows });
  for (const kind of kinds) {
    const state = await readTemplate(store, kind);
    await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind, expectedVersion: state.latestVersion, version: 1, hash: state.versions[0].hash }, NOW);
  }
  for (const kind of automated) await mutateTemplate(store, owner, { action: 'set_automation', requestId: uuid(), kind, expectedVersion: 1, enabled: true }, NOW);
  const ghl = fakeGhl(ghlOptions), time = clock(at), settings = { ...env, ...flags };
  const service = createApprovedSendService({ store, messenger: createGhlMessenger({ env: settings, fetcher: ghl.fetcher, clock: time }), clock: time, env: settings, links, attachments, crewContact, readAccount });
  const ledgers = () => [...store.rows].filter(([key]) => key.startsWith('message_sends/')).map(([, value]) => value);
  return { store, ghl, time, service, ledgers, row: () => store.get('jobs/job-1') };
}
const onMyWay = (extra = {}) => ({ kind: 'on_my_way', jobId: 'job-1', overrides: { etaMinutes: 20 }, ...extra });
async function previewToken(f, actor, input) {
  const preview = await f.service.preview(actor, input);
  assert.equal(preview.status, 'ready', JSON.stringify(preview));
  return preview.confirmToken;
}
const sendWith = (f, actor, input, confirmToken) => f.service.send(actor, { ...input, requestId: uuid(), confirmToken });
const confirmAndSend = async (f, actor, input) => sendWith(f, actor, input, await previewToken(f, actor, input));

test('preview binds a confirm token; send delivers once, records the ledger and mirrors a display copy', async () => {
  const f = await setup();
  const preview = await f.service.preview(crew, onMyWay());
  assert.equal(preview.status, 'ready'); assert.equal(preview.approval, 'template+human_trigger');
  assert.equal(preview.body, 'Hi Synthetic, this is Casey with Easy Garage Cleaning. Our crew is on the way and should arrive in about 20 minutes. If anything has changed, just reply here. See you soon!');
  assert.deepEqual(preview.recipient, { channel: 'SMS', masked: '(•••) •••-0123' });
  assert.equal(preview.expiresAt, new Date(Date.parse(NOW) + CONFIRM_TTL_MS).toISOString());
  assert.equal(preview.template.kind, 'on_my_way'); assert.equal(preview.template.version, 1); assert.match(preview.template.hash, /^[a-f0-9]{64}$/);
  assert.equal(f.ghl.sends().length, 0, 'preview never sends'); assert.equal(f.ledgers().length, 0, 'preview never claims');
  assert.ok(f.ghl.calls.every(call => call.path !== '/contacts/upsert'), 'preview never creates contacts');
  const requestId = uuid(), sent = await f.service.send(crew, { ...onMyWay(), requestId, confirmToken: preview.confirmToken });
  assert.equal(sent.status, 'submitted'); assert.equal(sent.messageId, 'message-1'); assert.equal(sent.mirror, 'saved'); assert.equal(sent.ledgerSaved, true);
  const [call] = f.ghl.sends();
  assert.equal(call.body.message, preview.body); assert.equal(call.body.toNumber, '+19705550123'); assert.equal(call.body.contactId, 'contact-1');
  assert.match(call.headers['Idempotency-Key'], /^egc-msg-[a-f0-9]{40}-1$/);
  const [ledger] = f.ledgers();
  assert.equal(ledger.status, 'submitted'); assert.equal(ledger.attempts, 1); assert.equal(ledger.sendKey, 'on_my_way:job-1:2026-09-22');
  assert.equal(ledger.actorId, 'crew1'); assert.equal(ledger.approval, 'template+human_trigger'); assert.equal(ledger.source, 'hub'); assert.equal(ledger.requestId, requestId);
  assert.deepEqual([ledger.templateKind, ledger.templateVersion], ['on_my_way', 1]);
  assert.deepEqual([ledger.createdAt, ledger.attemptedAt, ledger.completedAt], [NOW, NOW, NOW], 'the injected clock is used throughout');
  const mirrored = f.row(), message = mirrored.customerConversation.at(-1), entry = mirrored.communicationLog.at(-1);
  assert.deepEqual([message.direction, message.authorRole, message.authorName, message.body, message.createdAt, message.delivery.status, message.delivery.channel, message.providerMessageId], ['to_customer', 'crew', 'Casey Crew', preview.body, NOW, 'sent', 'sms', 'message-1']);
  assert.deepEqual(entry, { id: entry.id, event: 'on_my_way', label: 'On my way', status: 'submitted', source: 'hub', actor: 'crew1', actorRole: 'crew', policy: 'template+human_trigger', templateKind: 'on_my_way', templateVersion: 1, channel: 'SMS', recipient: '(•••) •••-0123', attempt: 1, messageId: 'message-1', attemptedAt: NOW });
  assert.equal(mirrored.communicationLastStatus, 'submitted');
  const again = await f.service.preview(crew, onMyWay());
  assert.equal(again.status, 'already_sent'); assert.equal(again.confirmToken, undefined);
  assert.equal((await sendWith(f, crew, onMyWay(), preview.confirmToken)).status, 'already_sent');
  assert.equal(f.ghl.sends().length, 1);
  assert.equal((await f.service.status(manager, onMyWay())).status, 'submitted');
});

test('concurrent sends of the same message claim the ledger exactly once', async () => {
  const f = await setup(), token = await previewToken(f, owner, onMyWay());
  const results = await Promise.all([1, 2, 3].map(() => sendWith(f, owner, onMyWay(), token)));
  assert.equal(f.ghl.sends().length, 1);
  assert.equal(results.filter(result => result.status === 'submitted').length, 1);
  assert.ok(results.filter(result => result.status !== 'submitted').every(result => ['sending', 'already_sent'].includes(result.status) && result.alreadyRecorded));
  assert.equal(f.row().customerConversation.length, 1);
});

test('uncertain provider outcomes are recorded and never automatically resent', async () => {
  for (const ghl of [{ sendStatus: 503 }, { sendStatus: 408 }, { sendThrows: true }, { sendBody: {} }]) {
    const f = await setup({ ghl }), token = await previewToken(f, owner, onMyWay());
    assert.equal((await sendWith(f, owner, onMyWay(), token)).status, 'uncertain', JSON.stringify(ghl));
    assert.equal(f.ledgers()[0].status, 'uncertain');
    // Updated deliberately (LEGACY-SEND): the thread now keeps 'uncertain' instead of showing it as 'queued' (Sending…).
    assert.equal(f.row().customerConversation.at(-1).delivery.status, 'uncertain');
    const preview = await f.service.preview(owner, onMyWay());
    assert.equal(preview.status, 'uncertain'); assert.equal(preview.confirmToken, undefined);
    const retry = await sendWith(f, owner, onMyWay(), token);
    assert.deepEqual([retry.status, retry.alreadyRecorded], ['uncertain', true]);
    assert.equal(f.ghl.sends().length, 1);
  }
});

test('definite provider rejections can be retried by a person up to the policy limit', async () => {
  const f = await setup({ ghl: { sendStatus: 422 } });
  assert.equal(MESSAGE_POLICIES.on_my_way.maxAttempts, 3);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await confirmAndSend(f, owner, onMyWay());
    assert.deepEqual([result.status, result.attempts, result.httpStatus], ['failed', attempt, 422]);
    assert.equal(f.ledgers()[0].history.length, attempt);
  }
  assert.equal(f.row().customerConversation.at(-1).delivery.status, 'failed');
  const exhausted = await f.service.preview(owner, onMyWay());
  assert.equal(exhausted.status, 'attempts_exhausted'); assert.equal(exhausted.confirmToken, undefined);
  assert.equal(f.ghl.sends().length, 3);
  const status = await f.service.status(owner, onMyWay());
  assert.deepEqual([status.status, status.attempts, status.canRetry], ['failed', 3, false]);
  const recovered = await setup({ ghl: { sendStatus: count => count === 1 ? 422 : 200 } });
  assert.equal((await confirmAndSend(recovered, owner, onMyWay())).status, 'failed');
  const second = await confirmAndSend(recovered, owner, onMyWay());
  assert.deepEqual([second.status, second.attempts], ['submitted', 2]);
});

test('confirm tokens expire after ten minutes and reject tampering, other actors and changed content', async () => {
  const f = await setup(), token = await previewToken(f, owner, onMyWay());
  const send = (actor, confirmToken, input = onMyWay()) => sendWith(f, actor, input, confirmToken);
  const [payload, signature] = token.split('.'), bound = claims(token);
  await assert.rejects(send(owner, undefined), code('messaging_confirmation_required'));
  await assert.rejects(send(manager, token), code('messaging_confirmation_invalid'));
  const forged = Buffer.from(JSON.stringify({ ...bound, exp: Date.parse(NOW) + 86400000 })).toString('base64url');
  await assert.rejects(send(owner, `${forged}.${signature}`), code('messaging_confirmation_invalid'));
  await assert.rejects(send(owner, `${payload}.${signature.slice(0, -4)}AAAA`), code('messaging_confirmation_invalid'));
  await assert.rejects(send(owner, `${payload}.${signature}.extra`), code('messaging_confirmation_invalid'));
  const otherKey = await createConfirmToken('another-synthetic-secret-value-0000000000', { actorId: 'zacb', ledgerId: bound.k, bodyHash: bound.b, recipientHash: bound.r, expiresAt: Date.parse(NOW) + 60000 });
  await assert.rejects(send(owner, otherKey), code('messaging_confirmation_invalid'));
  await assert.rejects(send(owner, token, onMyWay({ overrides: { etaMinutes: 45 } })), code('messaging_confirmation_stale'));
  f.store.edit('jobs/job-1', { phone: '9705550199' });
  await assert.rejects(send(owner, token), code('messaging_confirmation_stale'));
  f.store.edit('jobs/job-1', { phone: '(970) 555-0123' });
  f.time.advance(CONFIRM_TTL_MS);
  await assert.rejects(send(owner, token), code('messaging_confirmation_expired'));
  assert.equal(f.ghl.sends().length, 0); assert.equal(f.ledgers().length, 0);
  f.time.advance(-1);
  assert.equal((await send(owner, token)).status, 'submitted');
  const unsigned = await setup({ flags: { HUB_SESSION_SECRET: '' } });
  await assert.rejects(unsigned.service.preview(owner, onMyWay()), code('messaging_not_configured'));
});

test('unapproved templates block previews and sends, including edited drafts of approved wording', async () => {
  const f = await setup({ kinds: [] });
  await assert.rejects(f.service.preview(owner, onMyWay()), code('messaging_template_not_approved'));
  await assert.rejects(sendWith(f, owner, onMyWay(), 'x.y'), code('messaging_template_not_approved'));
  const state = await readTemplate(f.store, 'on_my_way');
  await mutateTemplate(f.store, owner, { action: 'approve', requestId: uuid(), kind: 'on_my_way', expectedVersion: 1, version: 1, hash: state.versions[0].hash }, NOW);
  await mutateTemplate(f.store, manager, { action: 'save_draft', requestId: uuid(), kind: 'on_my_way', expectedVersion: 1, channel: 'SMS', body: 'Unapproved draft {{firstName}}' }, NOW);
  const preview = await f.service.preview(owner, onMyWay());
  assert.equal(preview.template.version, 1); assert.doesNotMatch(preview.body, /Unapproved draft/);
  await mutateTemplate(f.store, owner, { action: 'retire', requestId: uuid(), kind: 'on_my_way', expectedVersion: 2, version: 1 }, NOW);
  await assert.rejects(sendWith(f, owner, onMyWay(), preview.confirmToken), code('messaging_template_not_approved'));
  assert.equal(f.ghl.sends().length, 0);
});

test('automated kinds need owner automation, respect Denver quiet hours and the customer automation opt-in', async () => {
  const input = { kind: 'day_before_reminder', jobId: 'job-1' }, tomorrow = { date: '2026-09-23' };
  const disabled = await setup({ kinds: ['day_before_reminder'], jobFields: tomorrow });
  await assert.rejects(disabled.service.send(automation, input), code('messaging_automation_disabled'));
  const night = await setup({ kinds: ['day_before_reminder'], automated: ['day_before_reminder'], jobFields: tomorrow, at: '2026-09-23T03:30:00.000Z' });
  const deferred = await night.service.send(automation, input);
  assert.deepEqual([deferred.status, deferred.reason, deferred.notBefore], ['deferred', 'quiet_hours', '2026-09-23T14:00:00.000Z']);
  assert.equal(night.ghl.calls.length, 0); assert.equal(night.ledgers().length, 0);
  assert.deepEqual(quietHoursDecision(new Date('2026-09-22T13:59:00.000Z')), { allowed: false, notBefore: '2026-09-22T14:00:00.000Z' });
  assert.deepEqual(quietHoursDecision(new Date('2026-09-22T14:00:00.000Z')), { allowed: true });
  assert.deepEqual(quietHoursDecision(new Date('2026-09-23T01:59:00.000Z')), { allowed: true });
  assert.deepEqual(quietHoursDecision(new Date('2026-09-23T02:00:00.000Z')), { allowed: false, notBefore: '2026-09-23T14:00:00.000Z' });
  assert.deepEqual(quietHoursDecision(new Date('2026-12-01T14:30:00.000Z')), { allowed: false, notBefore: '2026-12-01T15:00:00.000Z' }, 'MST uses UTC-7');
  const day = await setup({ kinds: ['day_before_reminder'], automated: ['day_before_reminder'], jobFields: tomorrow });
  const sent = await day.service.send(automation, input);
  assert.deepEqual([sent.status, sent.approval], ['submitted', 'owner_automation']);
  assert.match(day.ghl.sends()[0].body.message, /Wednesday, September 23 with an arrival window of 9:00 AM–10:00 AM/);
  assert.equal(day.ledgers()[0].actorId, 'cron'); assert.equal(day.row().communicationLog.at(-1).source, 'cron');
  assert.equal(day.row().customerConversation.at(-1).authorName, 'Easy Garage Cleaning');
  const optedOut = await setup({ kinds: ['day_before_reminder'], automated: ['day_before_reminder'], jobFields: { ...tomorrow, customerAutomationEnabled: false } });
  assert.deepEqual(await optedOut.service.send(automation, input).then(result => [result.status, result.reason]), ['suppressed', 'customer_automation_off']);
  await assert.rejects(day.service.send(automation, onMyWay()), code('messaging_trigger_not_allowed'));
  const notTomorrow = await setup({ kinds: ['day_before_reminder'], automated: ['day_before_reminder'], jobFields: { date: '2026-09-25' } });
  await assert.rejects(notTomorrow.service.send(automation, input), error => error.code === 'messaging_not_eligible' && error.details.reason === 'not_tomorrow');
  assert.equal(optedOut.ghl.sends().length + notTomorrow.ghl.sends().length, 0);
});

test('job notifications off, contact DND and missing SMS consent suppress without calling the provider', async () => {
  const off = await setup({ jobFields: { notify: false } });
  assert.deepEqual(await off.service.preview(owner, onMyWay()).then(result => [result.status, result.reason, result.confirmToken, result.recipient.masked]), ['suppressed', 'job_notifications_off', undefined, '(•••) •••-0123']);
  const flipped = await setup(), token = await previewToken(flipped, owner, onMyWay());
  flipped.store.edit('jobs/job-1', { notify: false });
  assert.equal((await sendWith(flipped, owner, onMyWay(), token)).status, 'suppressed');
  for (const [contact, reason] of [[{ dnd: true }, 'contact_dnd_sms'], [{ dndSettings: { SMS: { status: 'active' } } }, 'contact_dnd_sms'], [{ tags: ['egc-no-sms-consent'] }, 'no_sms_consent']]) {
    const f = await setup({ ghl: { contact } });
    const preview = await f.service.preview(owner, onMyWay());
    assert.deepEqual([preview.status, preview.reason, preview.confirmToken], ['suppressed', reason, undefined]);
    const late = await setup(), lateToken = await previewToken(late, owner, onMyWay());
    Object.assign(late.ghl.state.contacts['contact-1'], contact);
    assert.deepEqual(await sendWith(late, owner, onMyWay(), lateToken).then(result => [result.status, result.reason]), ['suppressed', reason]);
    assert.equal(f.ghl.sends().length + late.ghl.sends().length, 0);
    assert.equal(late.ledgers().length, 0);
  }
  const mismatch = await setup({ ghl: { contact: { phone: '+19705559999' } } });
  assert.equal((await mismatch.service.preview(owner, onMyWay())).status, 'contact_mismatch');
  const noPhone = await setup({ jobFields: { phone: '' } });
  assert.deepEqual(await noPhone.service.preview(owner, onMyWay()).then(result => [result.status, result.reason]), ['needs_contact', 'no_phone']);
});

test('dry-run and kill switches never call the provider', async () => {
  assert.deepEqual(messagingFlags({}), { enabled: false, dryRun: true });
  assert.deepEqual(messagingFlags({ EGC_MESSAGING_ENABLED: 'TRUE', EGC_MESSAGING_DRY_RUN: 'no' }), { enabled: false, dryRun: true });
  const off = await setup({ flags: { EGC_MESSAGING_ENABLED: 'false' } }), offToken = await previewToken(off, owner, onMyWay());
  await assert.rejects(sendWith(off, owner, onMyWay(), offToken), code('messaging_disabled'));
  assert.equal(off.ghl.calls.filter(call => call.method === 'POST').length, 0);
  const dry = await setup({ flags: { EGC_MESSAGING_DRY_RUN: 'true' } }), token = await previewToken(dry, owner, onMyWay());
  const result = await sendWith(dry, owner, onMyWay(), token);
  assert.deepEqual([result.status, result.attempts, result.mirror], ['dry_run', 0, 'saved']);
  assert.equal(dry.ghl.sends().length, 0);
  assert.equal(dry.ledgers()[0].status, 'dry_run');
  assert.equal(dry.row().customerConversation, undefined, 'nothing reached the customer, so the conversation is untouched');
  assert.equal(dry.row().communicationLog.at(-1).status, 'dry_run');
  assert.equal((await sendWith(dry, owner, onMyWay(), token)).status, 'dry_run');
  // Turning dry-run off lets the same logical message be delivered once.
  const live = createApprovedSendService({ store: dry.store, messenger: createGhlMessenger({ env, fetcher: dry.ghl.fetcher, clock: dry.time }), clock: dry.time, env });
  const delivered = await live.send(owner, { ...onMyWay(), requestId: uuid(), confirmToken: token });
  assert.deepEqual([delivered.status, delivered.attempts], ['submitted', 1]);
  assert.equal(dry.ghl.sends().length, 1);
});

test('a failed display mirror or ledger write never repeats the provider send', async () => {
  const f = await setup(), token = await previewToken(f, owner, onMyWay());
  f.store.hooks.failCollections.add('jobs');
  const sent = await sendWith(f, owner, onMyWay(), token);
  assert.deepEqual([sent.status, sent.mirror], ['submitted', 'failed']);
  f.store.hooks.failCollections.delete('jobs');
  assert.equal((await sendWith(f, owner, onMyWay(), token)).status, 'already_sent');
  assert.equal(f.ghl.sends().length, 1);
  const g = await setup(), gToken = await previewToken(g, owner, onMyWay());
  g.store.hooks.beforeCommit = writes => { if (writes.some(write => write.collection === 'message_sends' && write.patch.status === 'submitted')) throw Object.assign(new Error('Synthetic outage'), { code: 'messaging_storage_unavailable' }); };
  const unsaved = await sendWith(g, owner, onMyWay(), gToken);
  assert.deepEqual([unsaved.status, unsaved.reason, unsaved.ledgerSaved], ['submitted', 'delivery_status_not_saved', false]);
  assert.equal(g.ledgers()[0].status, 'sending');
  g.store.hooks.beforeCommit = null;
  assert.equal((await sendWith(g, owner, onMyWay(), gToken)).status, 'sending');
  assert.equal(g.ghl.sends().length, 1);
  // A lost claim response is recovered by reading back our own attempt.
  const h = await setup(), hToken = await previewToken(h, owner, onMyWay());
  h.store.hooks.loseResponse.add('message_sends');
  const recovered = await sendWith(h, owner, onMyWay(), hToken);
  assert.equal(h.ghl.sends().length, 1); assert.equal(recovered.status, 'submitted');
});

test('a job change during recipient verification cancels the send before any claim', async () => {
  const f = await setup(), token = await previewToken(f, owner, onMyWay());
  const original = f.ghl.fetcher;
  f.ghl.state.contacts['contact-1'].phone = '+19705550123';
  let edited = false;
  const service = createApprovedSendService({ store: f.store, messenger: createGhlMessenger({ env, clock: f.time, fetcher: async (url, options) => {
    const response = await original(url, options);
    if (!edited && String(url).includes('/contacts/')) { edited = true; f.store.edit('jobs/job-1', { highlevelContactId: 'contact-9' }); }
    return response;
  } }), clock: f.time, env });
  await assert.rejects(service.send(owner, { ...onMyWay(), requestId: uuid(), confirmToken: token }), code('messaging_target_changed'));
  assert.equal(f.ghl.sends().length, 0); assert.equal(f.ledgers().length, 0);
});

test('roles follow the policy: assigned crew for on-my-way, managers for invoices, business staff for reviews', async () => {
  const f = await setup({ kinds: ['on_my_way', 'invoice_send', 'review_request'], links: { payLink: async () => PAY }, jobFields: { status: 'scheduled' } });
  await assert.rejects(f.service.preview(otherCrew, onMyWay()), code('messaging_forbidden'));
  await assert.rejects(f.service.preview({ ...crew, user: '' }, onMyWay()), code('messaging_sign_in_required'));
  assert.equal((await f.service.preview(crew, onMyWay())).status, 'ready');
  await assert.rejects(f.service.preview(crew, { kind: 'invoice_send', jobId: 'job-1' }), code('messaging_forbidden'));
  await assert.rejects(f.service.preview({ ...manager, businessAccess: false }, { kind: 'invoice_send', jobId: 'job-1' }), code('messaging_forbidden'));
  assert.equal((await f.service.preview(manager, { kind: 'invoice_send', jobId: 'job-1' })).status, 'ready');
  await assert.rejects(f.service.preview(manager, { kind: 'review_request', jobId: 'job-1' }), error => error.code === 'messaging_not_eligible' && error.details.reason === 'job_not_complete');
  await assert.rejects(f.service.preview(crew, { kind: 'on_my_way', jobId: 'job-1', overrides: { etaMinutes: 20, body: 'x' } }), code('messaging_override_not_allowed'));
  await assert.rejects(f.service.preview(crew, onMyWay({ overrides: { etaMinutes: 0 } })), code('messaging_override_invalid'));
  await assert.rejects(f.service.preview(crew, onMyWay({ jobId: 'secure_vault' })), code('messaging_request_invalid'));
  await assert.rejects(f.service.preview(crew, onMyWay({ jobId: 'missing-job' })), code('messaging_forbidden'), 'crew cannot tell a missing job from one they are not assigned to');
  await assert.rejects(f.service.preview(manager, onMyWay({ jobId: 'missing-job' })), code('messaging_target_not_found'));
  await assert.rejects(f.service.preview(crew, onMyWay({ extra: true })), code('messaging_request_invalid'));
  await assert.rejects(f.service.preview(owner, { kind: 'portal_invitation_adapter', jobId: 'job-1' }), code('messaging_kind_adapter_only'));
  await assert.rejects(f.service.preview(owner, { kind: 'toString', jobId: 'job-1' }), code('messaging_kind_unknown'));
  const nextDay = await setup({ jobFields: { date: '2026-09-23' } });
  await assert.rejects(nextDay.service.preview(crew, onMyWay()), error => error.code === 'messaging_not_eligible' && error.details.reason === 'not_service_day');
});

test('private links are generated at send time, delivered, and never stored in the ledger or job', async () => {
  let calls = [];
  const links = { payLink: async context => { calls.push([context.purpose, context.sendKey]); return PAY; } };
  const f = await setup({ kinds: ['payment_reminder', 'invoice_send'], links, attachments: async context => context.kind === 'invoice_send' ? [{ name: 'INV-1001.pdf', url: 'https://files.example.invalid/inv-1001.pdf' }] : [] });
  const preview = await f.service.preview(manager, { kind: 'payment_reminder', jobId: 'job-1' });
  assert.match(preview.body, /\[secure link\]/); assert.doesNotMatch(preview.body, /synthetic-pay-token/);
  assert.equal(preview.length, [...preview.body.replace('[secure link]', PAY)].length);
  const sent = await f.service.send(manager, { kind: 'payment_reminder', jobId: 'job-1', requestId: uuid(), confirmToken: preview.confirmToken });
  assert.equal(sent.status, 'submitted');
  assert.match(f.ghl.sends()[0].body.message, /synthetic-pay-token/);
  assert.match(f.ghl.sends()[0].body.message, /\$1,200\.00 due October 1/);
  assert.deepEqual(calls.map(([purpose]) => purpose), ['preview', 'send']);
  assert.equal(calls[0][1], 'payment_reminder:job-1:INV-1001:2026-09-17', 'the key is the 7-day reminder window counted from the due date');
  const stored = JSON.stringify([...f.store.rows.values()]);
  assert.doesNotMatch(stored, /synthetic-pay-token/, 'bearer links never reach Firestore');
  const email = await f.service.preview(manager, { kind: 'invoice_send', jobId: 'job-1' });
  assert.deepEqual(email.attachments, ['INV-1001.pdf']); assert.equal(email.subject, 'Your Easy Garage Cleaning invoice INV-1001');
  f.store.edit('jobs/job-1', { customer: '<b>Synthetic</b> & Co' });
  const escaped = await f.service.preview(manager, { kind: 'invoice_send', jobId: 'job-1' });
  await f.service.send(manager, { kind: 'invoice_send', jobId: 'job-1', requestId: uuid(), confirmToken: escaped.confirmToken });
  const body = f.ghl.sends()[1].body;
  assert.equal(body.type, 'Email'); assert.equal(body.emailTo, 'synthetic@example.invalid');
  assert.deepEqual(body.attachments, ['https://files.example.invalid/inv-1001.pdf']);
  assert.match(body.html, /^<p>Hi &lt;b&gt;Synthetic&lt;\/b&gt;,<\/p>/); assert.match(body.html, /<a href="https:\/\/easygaragecleaning\.com\/pay\/synthetic-pay-token">/);
  const noLink = await setup({ kinds: ['payment_reminder'] });
  await assert.rejects(noLink.service.preview(manager, { kind: 'payment_reminder', jobId: 'job-1' }), error => error.code === 'messaging_template_variable_missing' && error.details.variable === 'payLink');
  const paid = await setup({ kinds: ['payment_reminder'], links, jobFields: { payment: { amount: 1200, verified: true }, invoice: { number: 'INV-1001', amount: 1200, balance: 0, dueDate: '2026-10-01', status: 'issued' } } });
  await assert.rejects(paid.service.preview(manager, { kind: 'payment_reminder', jobId: 'job-1' }), error => error.code === 'messaging_not_eligible' && error.details.reason === 'nothing_due');
});

test('human-written follow-ups are confirmed exactly as written and deduplicated by content', async () => {
  const f = await setup({ kinds: [] }), input = { kind: 'followup_draft', jobId: 'job-1', overrides: { body: 'Hi {{firstName}}, checking in about shelving options. Call {{companyPhone}}.' } };
  await assert.rejects(f.service.preview(crew, input), code('messaging_forbidden'));
  const preview = await f.service.preview(manager, input);
  assert.deepEqual([preview.status, preview.approval, preview.template.humanAuthored], ['ready', 'task_approval', true]);
  assert.equal(preview.body, 'Hi Synthetic, checking in about shelving options. Call (970) 999-1818.');
  assert.equal((await sendWith(f, manager, input, preview.confirmToken)).status, 'submitted');
  assert.equal((await f.service.preview(manager, input)).status, 'already_sent');
  const edited = { ...input, overrides: { body: 'A different note for {{firstName}}.' } };
  assert.equal((await f.service.preview(manager, edited)).status, 'ready');
  await assert.rejects(f.service.preview(manager, { ...input, overrides: { body: 'Pay {{payLink}}' } }), code('messaging_template_variable_not_allowed'));
  await assert.rejects(f.service.preview(manager, { kind: 'followup_draft', jobId: 'job-1' }), code('messaging_template_not_approved'));
});

test('crew notifications go only to assigned crew through an injected contact resolver', async () => {
  const crewContact = async ({ crewId }) => crewId === 'crew1' ? { name: 'Casey Crew', phone: '9705550155', highlevelContactId: 'crew-contact-1' } : null;
  const contacts = { 'crew-contact-1': { id: 'crew-contact-1', locationId: 'location-1', phone: '+19705550155', tags: [] } };
  const f = await setup({ kinds: ['crew_assignment'], crewContact, ghl: { contacts }, jobFields: { date: '2026-09-24', notify: false } });
  const input = { kind: 'crew_assignment', jobId: 'job-1', overrides: { crewId: 'Crew1' } };
  const preview = await f.service.preview(manager, input);
  assert.equal(preview.status, 'ready', 'customer notification preferences do not apply to staff messages');
  assert.match(preview.body, /^Hi Casey, you are scheduled .* Thursday, September 24 \(arrival window 9:00 AM–10:00 AM\)\. .*\[secure link\]$/);
  assert.equal((await sendWith(f, manager, input, preview.confirmToken)).status, 'submitted');
  assert.equal(f.ghl.sends()[0].body.contactId, 'crew-contact-1');
  assert.match(f.ghl.sends()[0].body.message, /https:\/\/easygaragecleaning\.com\/employee\.html$/);
  assert.equal(f.row().customerConversation, undefined, 'staff messages never enter the customer thread');
  assert.equal(f.row().communicationLog.at(-1).event, 'crew_assignment');
  await assert.rejects(f.service.preview(manager, { ...input, overrides: { crewId: 'crew2' } }), error => error.code === 'messaging_not_eligible' && error.details.reason === 'crew_not_assigned');
  const unresolved = await setup({ kinds: ['crew_assignment'], jobFields: { date: '2026-09-24' } });
  await assert.rejects(unresolved.service.preview(manager, input), error => error.code === 'messaging_recipient_unavailable' && error.details.reason === 'crew_contact_unavailable');
  const noPhone = await setup({ kinds: ['crew_assignment'], jobFields: { date: '2026-09-24' }, crewContact: async () => ({ name: 'Casey Crew' }) });
  assert.deepEqual(await noPhone.service.preview(manager, input).then(result => [result.status, result.reason]), ['needs_contact', 'no_phone']);
});

test('account-targeted sign-in links use the saved account contact and an injected link provider', async () => {
  const rows = { 'customers/acct-1': { name: 'Synthetic Account', firstName: 'Avery', phone: '9705550177', email: 'account@example.invalid', highlevelContactId: 'contact-7' } };
  const contacts = { 'contact-7': { id: 'contact-7', locationId: 'location-1', phone: '+19705550177', email: 'account@example.invalid', tags: [] } };
  const f = await setup({ kinds: ['portal_magic_link'], rows, ghl: { contacts }, links: { loginLink: async () => 'https://easygaragecleaning.com/client-login#t=synthetic-login' } });
  const input = { kind: 'portal_magic_link', accountId: 'acct-1' };
  await assert.rejects(f.service.preview(manager, { ...input, jobId: 'job-1' }), code('messaging_request_invalid'));
  const preview = await f.service.preview(manager, input);
  assert.match(preview.body, /^Hi Avery, here is your private Easy Garage Cleaning sign-in link: \[secure link\]/);
  const sent = await sendWith(f, manager, input, preview.confirmToken);
  assert.deepEqual([sent.status, sent.mirror], ['submitted', 'skipped']);
  assert.equal(f.ghl.sends()[0].body.contactId, 'contact-7');
  assert.equal(f.ledgers()[0].targetType, 'account');
  const customer = { user: 'customer:acct-1', kind: 'customer', source: 'portal', customerAccountId: 'acct-1' };
  f.time.advance(600000);
  const self = await f.service.send(customer, { ...input, requestId: uuid() });
  assert.deepEqual([self.status, self.approval], ['submitted', 'customer_initiated']);
  await assert.rejects(f.service.send({ ...customer, customerAccountId: 'acct-2' }, { ...input, requestId: uuid() }), code('messaging_forbidden'));
  await assert.rejects(f.service.send({ ...customer, source: 'hub' }, { ...input, requestId: uuid() }), code('messaging_forbidden'));
});

test('the Firestore adapter maps precondition failures and lost responses to messaging errors', async () => {
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const calls = [];
  const conflict = messagingStorage({}, async (settings, url, options = {}) => { calls.push({ url: String(url), options }); return response({}, 412); });
  await assert.rejects(conflict.commit([{ collection: 'message_sends', id: 'a'.repeat(64), patch: { status: 'sending' } }]), code('messaging_revision_conflict'));
  const write = JSON.parse(calls[0].options.body).writes[0];
  assert.deepEqual(write.currentDocument, { exists: false }); assert.match(write.update.name, /\/documents\/message_sends\/a{64}$/);
  await assert.rejects(messagingStorage({}, async () => { throw new Error('network'); }).commit([{ collection: 'message_sends', id: 'b', revision: 'r1', patch: {} }]), code('messaging_outcome_unknown'));
  await assert.rejects(messagingStorage({}, async () => { throw new Error('network'); }).read('message_sends', 'b'), code('messaging_storage_unavailable'));
  await assert.rejects(messagingStorage({}, async () => response({}, 500)).commit([{ collection: 'message_sends', id: 'b', revision: 'r1', patch: {} }]), code('messaging_outcome_unknown'));
  await assert.rejects(messagingStorage({}, async () => response({}, 503)).read('message_sends', 'b'), code('messaging_storage_unavailable'));
  assert.equal(await messagingStorage({}, async () => response({}, 404)).read('message_sends', 'b'), null);
});

test('billing messages never reach the crew-visible customer thread', async () => {
  const links = { payLink: async () => PAY };
  const f = await setup({ kinds: ['on_my_way', 'invoice_send', 'payment_reminder', 'deposit_reminder'], links });
  for (const kind of ['invoice_send', 'payment_reminder', 'deposit_reminder']) {
    const sent = await confirmAndSend(f, manager, { kind, jobId: 'job-1' });
    assert.deepEqual([sent.status, sent.mirror], ['submitted', 'saved'], kind);
  }
  assert.match(f.ghl.sends().map(call => call.body.message).join(' '), /INV-1001[\s\S]*\$1,200\.00[\s\S]*\$300\.00/, 'the customer still receives the amounts');
  const row = { ...f.row(), id: 'job-1' };
  assert.deepEqual(row.communicationLog.map(entry => entry.event), ['invoice_send', 'payment_reminder', 'deposit_reminder'], 'the business-only log records every billing send');
  assert.equal(row.customerConversation, undefined);
  const crewView = JSON.stringify(crewJobProjection(row));
  for (const secret of ['INV-1001', '1,200', '$300.00', 'secure link', 'October 1']) assert.ok(!crewView.includes(secret), secret);
  await confirmAndSend(f, crew, onMyWay());
  assert.match(crewJobProjection({ ...f.row(), id: 'job-1' }).customerConversation.at(-1).body, /on the way/, 'operational messages stay visible to the crew');
  for (const policy of Object.values(MESSAGE_POLICIES).filter(policy => policy.template)) {
    const money = TEMPLATE_KINDS[policy.template].variables.some(name => ['balance', 'invoiceNumber', 'payLink'].includes(name));
    assert.equal(policy.billing, money, `${policy.kind} billing flag matches whether its wording can quote money`);
  }
});

test('void, superseded, draft, paid and unverified invoices are never sent or chased, by a person or automation', async () => {
  const links = { payLink: async () => PAY };
  const cases = [[{ status: 'void' }, 'invoice_not_payable'], [{ status: 'superseded' }, 'invoice_not_payable'], [{ status: 'draft' }, 'invoice_not_payable'], [{ status: 'paid' }, 'invoice_not_payable'],
    [{ status: 'pending_verification' }, 'invoice_not_payable'], [{ status: undefined }, 'invoice_not_payable']];
  for (const [invoice, reason] of cases) {
    const f = await setup({ kinds: ['payment_reminder', 'invoice_send'], automated: ['payment_reminder'], links, jobFields: { invoice: { ...job().invoice, ...invoice } } });
    await assert.rejects(f.service.preview(manager, { kind: 'payment_reminder', jobId: 'job-1' }), notEligible(reason), JSON.stringify(invoice));
    await assert.rejects(f.service.preview(manager, { kind: 'invoice_send', jobId: 'job-1' }), notEligible(reason));
    await assert.rejects(f.service.send(automation, { kind: 'payment_reminder', jobId: 'job-1' }), notEligible(reason));
    assert.equal(f.ghl.calls.length, 0); assert.equal(f.ledgers().length, 0);
  }
  const cancelled = await setup({ kinds: ['payment_reminder'], automated: ['payment_reminder'], links, jobFields: { status: 'cancelled', pipelineStatus: 'cancelled' } });
  await assert.rejects(cancelled.service.send(automation, { kind: 'payment_reminder', jobId: 'job-1' }), notEligible('invoice_not_payable'));
  const review = await setup({ kinds: ['payment_reminder'], links, jobFields: { payment: { amount: 200 } } });
  await assert.rejects(review.service.preview(manager, { kind: 'payment_reminder', jobId: 'job-1' }), notEligible('payment_needs_review'));
  assert.equal(cancelled.ghl.calls.length + review.ghl.calls.length, 0);
});

test('quoted amounts come from the same helpers as the portal and Stripe checkout', async () => {
  const links = { payLink: async () => PAY };
  const deposit = { estimate: { ...job().estimate, depositRequired: 400 }, deposit: { amount: 250, paidAmount: 0 } };
  const d = await setup({ kinds: ['deposit_reminder'], links, jobFields: deposit });
  assert.equal(customerDepositState(job(deposit)).due, 400);
  const preview = await d.service.preview(manager, { kind: 'deposit_reminder', jobId: 'job-1' });
  assert.match(preview.body, /your \$400\.00 deposit/); assert.doesNotMatch(preview.body, /\$250\.00/);
  const capped = await setup({ kinds: ['deposit_reminder'], links, jobFields: { estimate: { ...job().estimate, depositRequired: 5000 } } });
  assert.match((await capped.service.preview(manager, { kind: 'deposit_reminder', jobId: 'job-1' })).body, /your \$1,200\.00 deposit/, 'a deposit never exceeds the quote total');
  const half = await setup({ kinds: ['deposit_reminder'], links, jobFields: { estimate: { ...job().estimate, depositRequired: undefined }, deposit: undefined } });
  assert.match((await half.service.preview(manager, { kind: 'deposit_reminder', jobId: 'job-1' })).body, /your \$600\.00 deposit/, 'unsigned deposits default to half the quote');
  const balance = { estimate: { ...job().estimate, amount: 1200 }, payment: { amount: 200, verified: true }, invoice: { ...job().invoice, amount: 1400, balance: 999 } };
  assert.equal(customerMoneyState(job(balance)).balance, 1000);
  const b = await setup({ kinds: ['payment_reminder'], links, jobFields: balance });
  const reminder = await b.service.preview(manager, { kind: 'payment_reminder', jobId: 'job-1' });
  assert.match(reminder.body, /has \$1,000\.00 due/); assert.doesNotMatch(reminder.body, /\$999|\$1,400/);
});

test('automated reminders keep a cadence even when a daily job runs every day', async () => {
  assert.equal(reminderWindow('2026-10-01', '2026-09-22', 7), '2026-09-17');
  assert.equal(reminderWindow('2026-10-01', '2026-09-23', 7), '2026-09-17');
  assert.equal(reminderWindow('2026-10-01', '2026-09-24', 7), '2026-09-24');
  const f = await setup({ kinds: ['payment_reminder'], automated: ['payment_reminder'], links: { payLink: async () => PAY } });
  const input = { kind: 'payment_reminder', jobId: 'job-1' };
  assert.equal((await f.service.send(automation, input)).status, 'submitted');
  f.time.advance(DAY);
  const nextDay = await f.service.send(automation, input);
  assert.deepEqual([nextDay.status, nextDay.alreadyRecorded], ['already_sent', true]);
  f.time.advance(DAY);
  const edge = await f.service.send(automation, input);
  assert.deepEqual([edge.status, edge.reason, edge.notBefore], ['deferred', 'reminder_cadence', '2026-09-29T18:00:00.000Z'], 'a new window does not allow a reminder on the next day');
  assert.equal(f.ghl.sends().length, 1); assert.equal(f.ledgers().length, 1);
  assert.equal((await f.service.preview(manager, input)).status, 'ready', 'a person may still confirm one reminder in the new window');
  f.time.set('2026-09-29T18:00:00.000Z');
  const weekLater = await f.service.send(automation, input);
  assert.deepEqual([weekLater.status, weekLater.sendKey], ['submitted', 'payment_reminder:job-1:INV-1001:2026-09-24']);
  assert.equal(f.ghl.sends().length, 2);
  const deposit = await setup({ kinds: ['deposit_reminder'], automated: ['deposit_reminder'], links: { payLink: async () => PAY }, jobFields: { date: '2026-10-02' } });
  const dInput = { kind: 'deposit_reminder', jobId: 'job-1' };
  assert.equal((await deposit.service.send(automation, dInput)).status, 'submitted');
  deposit.time.advance(DAY);
  const early = await deposit.service.send(automation, dInput);
  assert.deepEqual([early.status, early.reason, early.notBefore], ['deferred', 'reminder_cadence', '2026-09-25T18:00:00.000Z'], 'windows count back from the service date');
  deposit.time.advance(2 * DAY);
  assert.equal((await deposit.service.send(automation, dInput)).status, 'submitted', 'deposit reminders repeat at most every three days');
  assert.equal(deposit.ghl.sends().length, 2);
});

test('a confirmed preview keeps its send key when a time bucket rolls over before the send', async () => {
  const rows = { 'customers/acct-1': { name: 'Synthetic Account', firstName: 'Avery', phone: '9705550177', highlevelContactId: 'contact-7' } };
  const contacts = { 'contact-7': { id: 'contact-7', locationId: 'location-1', phone: '+19705550177', tags: [] } };
  const f = await setup({ kinds: ['portal_magic_link'], rows, ghl: { contacts }, links: { loginLink: async () => 'https://easygaragecleaning.com/client-login#t=synthetic' }, at: '2026-09-22T18:09:59.000Z' });
  const input = { kind: 'portal_magic_link', accountId: 'acct-1' };
  const preview = await f.service.preview(manager, input);
  f.time.advance(2000);
  const [payload, signature] = preview.confirmToken.split('.');
  const shifted = Buffer.from(JSON.stringify({ ...claims(preview.confirmToken), iat: Date.parse('2026-09-22T18:10:00.000Z') })).toString('base64url');
  await assert.rejects(sendWith(f, manager, input, `${shifted}.${signature}`), code('messaging_confirmation_invalid'), 'the preview time is signed');
  const sent = await sendWith(f, manager, input, `${payload}.${signature}`);
  assert.deepEqual([sent.status, sent.sendKey], ['submitted', preview.sendKey]);
  assert.equal(sent.sendKey, `portal_magic_link:acct-1:${Math.floor(Date.parse('2026-09-22T18:09:59.000Z') / 600000)}`);
  assert.equal(f.ghl.sends().length, 1);
});

test('status reads the ledger without re-checking eligibility, template approval or the date', async () => {
  const links = { payLink: async () => PAY };
  const f = await setup({ kinds: ['on_my_way', 'payment_reminder'], links, rows: { 'jobs/job-2': job() } });
  await confirmAndSend(f, crew, onMyWay());
  f.store.edit('jobs/job-1', { status: 'completed', pipelineStatus: 'completed' });
  const state = await readTemplate(f.store, 'on_my_way');
  await mutateTemplate(f.store, owner, { action: 'retire', requestId: uuid(), kind: 'on_my_way', expectedVersion: state.latestVersion, version: 1 }, NOW);
  const closed = await f.service.status(manager, onMyWay());
  assert.deepEqual([closed.status, closed.actorId, closed.sendKey], ['submitted', 'crew1', 'on_my_way:job-1:2026-09-22']);
  assert.equal((await f.service.status(crew, onMyWay())).status, 'submitted', 'the assigned crew member can still check their message');
  await assert.rejects(f.service.status(otherCrew, onMyWay()), code('messaging_forbidden'));
  f.store.edit('jobs/job-1', { status: 'scheduled', pipelineStatus: 'scheduled' });
  const reminder = await confirmAndSend(f, manager, { kind: 'payment_reminder', jobId: 'job-1' });
  f.time.advance(3 * DAY);
  f.store.edit('jobs/job-1', { payment: { amount: 1200, verified: true }, invoice: { ...job().invoice, status: 'paid', balance: 0 } });
  const later = await f.service.status(manager, { kind: 'payment_reminder', jobId: 'job-1', sendKey: reminder.sendKey });
  assert.deepEqual([later.status, later.attempts, later.canRetry], ['submitted', 1, false]);
  assert.equal((await f.service.status(manager, { kind: 'payment_reminder', jobId: 'job-1' })).status, 'not_sent', 'without the key, status looks up the current window');
  assert.equal((await f.service.status(manager, { kind: 'payment_reminder', jobId: 'job-2', sendKey: reminder.sendKey })).status, 'not_sent', 'a key only reports its own record');
  assert.equal((await f.service.status(manager, { kind: 'on_my_way', jobId: 'job-1', overrides: { etaMinutes: 20 }, sendKey: reminder.sendKey })).status, 'not_sent', 'a key only reports its own kind');
  await assert.rejects(f.service.status(crew, { kind: 'payment_reminder', jobId: 'job-1', sendKey: reminder.sendKey }), code('messaging_forbidden'));
  await assert.rejects(f.service.status(manager, { kind: 'payment_reminder', jobId: 'job-1', sendKey: 42 }), code('messaging_request_invalid'));
  await assert.rejects(f.service.status(manager, { kind: 'followup_draft', jobId: 'job-1', overrides: { body: 'Hi' } }), code('messaging_request_invalid'));
});

test('crew cannot probe which records exist for message types they may not use', async () => {
  const f = await setup({ kinds: ['on_my_way', 'invoice_send', 'portal_magic_link'] });
  const answers = [];
  for (const jobId of ['job-1', 'missing-job']) {
    const errors = [];
    for (const input of [{ kind: 'invoice_send', jobId }, onMyWay({ jobId })]) await f.service.preview(otherCrew, input).catch(error => errors.push([error.code, error.status, error.message]));
    assert.deepEqual(errors.map(([code, status]) => [code, status]), [['messaging_forbidden', 403], ['messaging_forbidden', 403]], jobId);
    answers.push(errors);
  }
  assert.deepEqual(answers[0], answers[1], 'an existing job and a missing job get the same answer');
  await assert.rejects(f.service.preview(crew, { kind: 'portal_magic_link', accountId: 'missing-account' }), code('messaging_forbidden'));
  const customer = { user: 'customer:acct-1', kind: 'customer', source: 'portal', customerAccountId: 'acct-1' };
  await assert.rejects(f.service.send(customer, { kind: 'portal_magic_link', accountId: 'acct-2', requestId: uuid() }), code('messaging_forbidden'));
  await assert.rejects(f.service.preview(manager, { kind: 'invoice_send', jobId: 'missing-job' }), code('messaging_target_not_found'));
  const reads = [];
  const probe = createApprovedSendService({ store: { ...f.store, read: async (collection, id) => { reads.push(`${collection}/${id}`); return f.store.read(collection, id); } }, messenger: {}, clock: f.time, env });
  await assert.rejects(probe.preview(crew, { kind: 'invoice_send', jobId: 'job-1' }), code('messaging_forbidden'));
  assert.deepEqual(reads, [], 'the record is not read before the role check');
});

test('failed and uncertain sends raise the Hub attention flag; dry runs and staff messages leave it alone', async () => {
  for (const ghl of [{ sendStatus: 422 }, { sendStatus: 503 }]) {
    const f = await setup({ ghl });
    await confirmAndSend(f, owner, onMyWay());
    const row = f.row();
    assert.deepEqual([row.communicationLastStatus, row.communicationLastEvent, row.communicationLastAt, row.updatedAt, row.customerConversationUpdatedAt], ['needs_attention', 'on_my_way', NOW, NOW, NOW], JSON.stringify(ghl));
  }
  const retried = await setup({ ghl: { sendStatus: count => count === 1 ? 422 : 200 } });
  await confirmAndSend(retried, owner, onMyWay());
  await confirmAndSend(retried, owner, onMyWay());
  assert.equal(retried.row().communicationLastStatus, 'submitted', 'a successful retry of the same message clears its flag');
  const legacy = { communicationLastStatus: 'needs_attention', communicationLastEvent: 'estimate_ready', communicationLastAt: '2026-09-21T15:00:00.000Z' };
  const other = await setup({ jobFields: legacy });
  await confirmAndSend(other, owner, onMyWay());
  assert.deepEqual([other.row().communicationLastStatus, other.row().communicationLastEvent], ['needs_attention', 'estimate_ready'], 'a different message never hides an earlier problem');
  assert.equal(other.row().communicationLog.at(-1).status, 'submitted');
  const dry = await setup({ jobFields: legacy, flags: { EGC_MESSAGING_DRY_RUN: 'true' } });
  await confirmAndSend(dry, owner, onMyWay());
  assert.deepEqual([dry.row().communicationLastStatus, dry.row().communicationLastEvent, dry.row().communicationLastAt], ['needs_attention', 'estimate_ready', '2026-09-21T15:00:00.000Z']);
  assert.equal(dry.row().communicationLog.at(-1).status, 'dry_run');
  const crewContact = async () => ({ name: 'Casey Crew', phone: '9705550155', highlevelContactId: 'crew-contact-1' });
  const contacts = { 'crew-contact-1': { id: 'crew-contact-1', locationId: 'location-1', phone: '+19705550155', tags: [] } };
  const staff = await setup({ kinds: ['crew_assignment'], crewContact, ghl: { contacts, sendStatus: 503 }, jobFields: { date: '2026-09-24' } });
  await confirmAndSend(staff, manager, { kind: 'crew_assignment', jobId: 'job-1', overrides: { crewId: 'crew1' } });
  assert.equal(staff.row().communicationLastStatus, undefined); assert.equal(staff.row().communicationLog.at(-1).status, 'uncertain');
});

test('a caller can refuse the claim, and then nothing is claimed or sent', async () => {
  const f = await setup(), token = await previewToken(f, owner, onMyWay());
  const refusing = createApprovedSendService({ store: f.store, messenger: createGhlMessenger({ env, fetcher: f.ghl.fetcher, clock: f.time }), clock: f.time, env, reserve: () => { throw Object.assign(new Error('Budget spent'), { code: 'messaging_not_attempted', status: 503 }); } });
  await assert.rejects(refusing.send(owner, { ...onMyWay(), requestId: uuid(), confirmToken: token }), code('messaging_not_attempted'));
  assert.equal(f.ledgers().length, 0); assert.equal(f.ghl.sends().length, 0);
  assert.equal((await sendWith(f, owner, onMyWay(), token)).status, 'submitted', 'the same confirmation still works afterwards');
});
