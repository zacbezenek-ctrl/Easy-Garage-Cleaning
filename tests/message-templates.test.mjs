import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, validateTemplateVersion, templateHash, templateRoom, templateVariables, SMS_LIMIT, LINK_PLACEHOLDER, TEMPLATE_VARIABLES } from '../functions/_lib/message-templates.js';
import { TEMPLATE_KINDS, TEMPLATE_KIND_IDS } from '../functions/_lib/message-template-defaults.js';
import { activeTemplate, isMessagingOwner, listTemplates, mutateTemplate, readTemplate } from '../functions/_lib/message-template-store.js';
import { messageTemplateHandlers } from '../functions/api/message-templates.js';
import { memoryStore, owner, manager, crew, uuid, NOW } from './helpers/messaging-fixture.mjs';

const sample = { firstName: 'Sam', crewLeadName: 'Casey', etaMinutes: '20', arrivalWindow: '9:00 AM–10:00 AM', serviceDate: 'Tuesday, September 22', removedDates: 'Wednesday, September 23', portalLink: 'https://easygaragecleaning.com/customer-portal?p=synthetic', payLink: 'https://easygaragecleaning.com/pay/synthetic', invoiceNumber: 'INV-1001', balance: '$1,200.00', dueDate: 'October 1', companyPhone: '(970) 999-1818', inviteLink: 'https://easygaragecleaning.com/business-hub#invite=synthetic', loginLink: 'https://easygaragecleaning.com/client-login#t=synthetic' };
const sms = body => ({ channel: 'SMS', subject: '', body });
const code = expected => error => { assert.equal(error.code, expected); return true; };
const seedHash = async kind => (await readTemplate(memoryStore(), kind)).versions[0].hash;

test('rendering uses only whitelisted variables and fails closed on unknown, malformed or missing values', () => {
  assert.throws(() => renderTemplate(sms('Hi {{firstName}} {{password}}'), sample), code('messaging_template_variable_unknown'));
  assert.throws(() => renderTemplate(sms('Hi {{firstName}'), sample), code('messaging_template_syntax_invalid'));
  assert.throws(() => renderTemplate(sms('Hi {{ constructor }}'), sample), code('messaging_template_variable_unknown'));
  assert.throws(() => renderTemplate(sms('Hi {{firstName}}'), {}), code('messaging_template_variable_missing'));
  assert.throws(() => renderTemplate(sms('Hi {{firstName}}'), { firstName: '   ' }), code('messaging_template_variable_missing'));
  assert.throws(() => renderTemplate(sms('Pay {{payLink}}'), { payLink: 'javascript:alert(1)' }), code('messaging_template_link_invalid'));
  assert.throws(() => renderTemplate(sms('Pay {{payLink}}'), { payLink: 'http://insecure.example.invalid' }), code('messaging_template_link_invalid'));
  assert.deepEqual(templateVariables('{{firstName}} {{ firstName }} {{balance}}'), ['firstName', 'balance']);
});

test('rendering is deterministic and replaces private links in the display copy', () => {
  const template = sms('Hi {{firstName}}, pay here: {{payLink}}');
  const first = renderTemplate(template, sample), second = renderTemplate(structuredClone(template), { ...sample });
  assert.deepEqual(first, second);
  assert.equal(first.body, `Hi Sam, pay here: ${sample.payLink}`);
  assert.equal(first.display.body, `Hi Sam, pay here: ${LINK_PLACEHOLDER}`);
  assert.deepEqual(first.variables, ['firstName', 'payLink']);
  assert.equal(renderTemplate(sms('Hi {{firstName}}'), { firstName: 'Sam\n\u0007Evil\tName' }).body, 'Hi Sam Evil Name');
});

test('SMS is capped at 320 characters after rendering', () => {
  assert.equal(SMS_LIMIT, 320);
  assert.equal(renderTemplate(sms('x'.repeat(320)), {}).body.length, 320);
  assert.throws(() => renderTemplate(sms('x'.repeat(321)), {}), error => error.code === 'messaging_sms_too_long' && error.details.length === 321);
  assert.throws(() => renderTemplate(sms('x'.repeat(300) + '{{payLink}}'), { payLink: 'https://easygaragecleaning.com/' + 'p'.repeat(40) }), code('messaging_sms_too_long'));
});

test('the room an SMS leaves for open variables is what rendering them would take up to the limit', () => {
  const template = sms('Hi {{firstName}}, now: {{serviceDate}}. No longer: {{removedDates}} or {{serviceDate}}. {{loginLink}}');
  const { room, counts } = templateRoom(template, sample, ['serviceDate', 'removedDates']);
  assert.deepEqual(counts, { serviceDate: 2, removedDates: 1 });
  const rendered = [...renderTemplate(template, sample).body].length;
  assert.equal(SMS_LIMIT - room + 2 * sample.serviceDate.length + sample.removedDates.length, rendered, 'fixed text, first name and link are counted once each');
  assert.throws(() => templateRoom(template, { ...sample, firstName: '' }, ['serviceDate', 'removedDates']), code('messaging_template_variable_missing'));
});

test('email HTML escapes every value and template character and links only verified https URLs', () => {
  const rendered = renderTemplate({ channel: 'Email', subject: 'Invoice {{invoiceNumber}} for {{firstName}}', body: 'Hi {{firstName}} <3 & thanks\nline two\n\nPay: {{payLink}}' }, { ...sample, firstName: '<img src=x onerror=alert(1)>"Sam"', invoiceNumber: 'INV-<1>' });
  assert.equal(rendered.html, '<p>Hi &lt;img src=x onerror=alert(1)&gt;&quot;Sam&quot; &lt;3 &amp; thanks<br>line two</p><p>Pay: <a href="https://easygaragecleaning.com/pay/synthetic">https://easygaragecleaning.com/pay/synthetic</a></p>');
  assert.equal(rendered.subject, 'Invoice INV-<1> for <img src=x onerror=alert(1)>"Sam"');
  assert.doesNotMatch(rendered.html, /<img|<script/);
});

test('validation limits variables per message kind and requires one-line email subjects', () => {
  assert.throws(() => validateTemplateVersion(sms('Hi {{firstName}} {{payLink}}'), TEMPLATE_KINDS.on_my_way.variables), code('messaging_template_variable_not_allowed'));
  assert.throws(() => validateTemplateVersion({ channel: 'Email', subject: '', body: 'Hi' }), code('messaging_template_subject_invalid'));
  assert.throws(() => validateTemplateVersion({ channel: 'Email', subject: 'Pay {{payLink}}', body: 'Hi' }), code('messaging_template_subject_invalid'));
  assert.throws(() => validateTemplateVersion({ channel: 'SMS', subject: 'Subject', body: 'Hi' }), code('messaging_template_subject_invalid'));
  assert.throws(() => validateTemplateVersion({ channel: 'Fax', body: 'Hi' }), code('messaging_template_channel_invalid'));
  assert.throws(() => validateTemplateVersion(sms('   ')), code('messaging_template_body_required'));
  assert.deepEqual(validateTemplateVersion(sms('  Hi {{firstName}}\r\n')), { channel: 'SMS', subject: '', body: 'Hi {{firstName}}', variables: ['firstName'] });
});

test('every default seed is valid, renders within limits and starts unapproved', async () => {
  assert.deepEqual([...TEMPLATE_KIND_IDS].sort(), ['b2b_invite', 'crew_assignment', 'crew_schedule_change', 'crew_unassignment', 'day_before_reminder', 'deposit_reminder', 'estimate_expiring', 'followup', 'invoice_send', 'on_my_way', 'payment_reminder', 'portal_magic_link', 'review_request'].sort());
  const store = memoryStore();
  for (const state of await listTemplates(store)) {
    const seed = state.versions[0], base = TEMPLATE_KINDS[state.kind];
    assert.equal(state.seeded, true); assert.equal(state.activeVersion, null); assert.equal(seed.status, 'draft'); assert.equal(seed.approvedBy, '');
    assert.ok(seed.variables.every(name => base.variables.includes(name) && TEMPLATE_VARIABLES.includes(name)), state.kind);
    const rendered = renderTemplate(seed, sample);
    if (seed.channel === 'SMS') assert.ok([...rendered.body].length <= SMS_LIMIT, `${state.kind} is ${rendered.body.length} characters`);
    assert.equal(await activeTemplate(store, state.kind), null, `${state.kind} seed must not be sendable`);
  }
  assert.equal(store.commits.length, 0, 'reading seeds never writes');
});

test('only the owner can approve; managers can draft; crew is forbidden', async () => {
  const store = memoryStore(), hash = await seedHash('on_my_way');
  await assert.rejects(mutateTemplate(store, manager, { action: 'approve', requestId: uuid(), kind: 'on_my_way', expectedVersion: 1, version: 1, hash }, NOW), code('messaging_template_owner_required'));
  await assert.rejects(mutateTemplate(store, { ...manager, businessAccess: false }, { action: 'save_draft', requestId: uuid(), kind: 'on_my_way', expectedVersion: 1, ...sms('Hi {{firstName}}') }, NOW), code('messaging_template_forbidden'));
  for (const action of [{ action: 'save_draft', ...sms('Hi {{firstName}}') }, { action: 'approve', version: 1, hash }]) {
    await assert.rejects(mutateTemplate(store, crew, { requestId: uuid(), kind: 'on_my_way', expectedVersion: 1, ...action }, NOW), code('messaging_template_forbidden'));
  }
  await assert.rejects(mutateTemplate(store, null, { action: 'approve', requestId: uuid(), kind: 'on_my_way', expectedVersion: 1, version: 1, hash }, NOW), code('messaging_sign_in_required'));
  const drafted = await mutateTemplate(store, manager, { action: 'save_draft', requestId: uuid(), kind: 'on_my_way', expectedVersion: 1, ...sms('Hi {{firstName}}, {{crewLeadName}} is on the way.') }, NOW);
  assert.equal(drafted.template.latestVersion, 2); assert.equal(drafted.template.versions[1].status, 'draft'); assert.equal(drafted.template.versions[1].createdBy, 'tylerg'); assert.equal(drafted.template.versions[1].createdAt, NOW);
  assert.equal(await activeTemplate(store, 'on_my_way'), null);
  await assert.rejects(mutateTemplate(store, manager, { action: 'set_automation', requestId: uuid(), kind: 'on_my_way', expectedVersion: 2, enabled: true }, NOW), code('messaging_template_owner_required'));
  // Roles are configurable per user; only zacb with the owner role and business access is the owner.
  for (const [impostor, expected] of [[{ ...manager, role: 'owner' }, 'messaging_template_owner_required'], [{ ...owner, user: 'alexk' }, 'messaging_template_owner_required'], [{ ...owner, businessAccess: false }, 'messaging_template_forbidden']]) {
    for (const action of [{ action: 'approve', version: 2, hash: drafted.template.versions[1].hash }, { action: 'set_automation', enabled: true }, { action: 'retire', version: 2 }]) {
      await assert.rejects(mutateTemplate(store, impostor, { requestId: uuid(), kind: 'on_my_way', expectedVersion: 2, ...action }, NOW), code(expected), `${impostor.user}/${impostor.role}/${action.action}`);
    }
  }
  assert.equal(isMessagingOwner(owner), true); assert.equal(isMessagingOwner({ ...manager, role: 'owner' }), false);
  const approved = await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind: 'on_my_way', expectedVersion: 2, version: 2, hash: drafted.template.versions[1].hash }, NOW);
  assert.equal(approved.template.activeVersion, 2); assert.equal(approved.template.versions[1].approvedBy, 'zacb'); assert.equal(approved.template.versions[1].approvedAt, NOW);
  const active = await activeTemplate(store, 'on_my_way');
  assert.equal(active.version, 2); assert.equal(active.body, 'Hi {{firstName}}, {{crewLeadName}} is on the way.');
});

test('editing creates a new unapproved version with a new hash; approval never carries over', async () => {
  const store = memoryStore(), hash = await seedHash('payment_reminder');
  await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind: 'payment_reminder', expectedVersion: 1, version: 1, hash }, NOW);
  const edited = await mutateTemplate(store, manager, { action: 'save_draft', requestId: uuid(), kind: 'payment_reminder', expectedVersion: 1, ...sms('Hi {{firstName}}, {{balance}} is due {{dueDate}}: {{payLink}}') }, NOW);
  const [v1, v2] = edited.template.versions;
  assert.notEqual(v2.hash, v1.hash);
  assert.deepEqual([v1.status, v2.status, v2.approvedBy, edited.template.activeVersion], ['approved', 'draft', '', 1]);
  assert.equal((await activeTemplate(store, 'payment_reminder')).version, 1, 'live wording stays the approved text until the owner approves the edit');
  await assert.rejects(mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind: 'payment_reminder', expectedVersion: 2, version: 2, hash: v1.hash }), code('messaging_template_revision_conflict'));
  const same = await mutateTemplate(store, manager, { action: 'save_draft', requestId: uuid(), kind: 'payment_reminder', expectedVersion: 2, ...sms('Hi {{firstName}}, {{balance}} is due {{dueDate}}: {{payLink}}') }, NOW);
  assert.equal(same.unchanged, true); assert.equal(same.template.latestVersion, 2);
  const promoted = await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind: 'payment_reminder', expectedVersion: 2, version: 2, hash: v2.hash }, NOW);
  assert.deepEqual(promoted.template.versions.map(row => row.status), ['retired', 'approved']);
  // Tampering with stored text without a matching hash makes the template unusable.
  const key = 'message_templates/payment_reminder', doc = store.get(key);
  doc.versions[1].body = 'Changed outside the approval flow {{payLink}}';
  store.set(key, doc);
  assert.equal(await activeTemplate(store, 'payment_reminder'), null);
});

test('stale expected versions, concurrent saves and reused request IDs return conflicts', async () => {
  const store = memoryStore();
  const draft = body => ({ action: 'save_draft', requestId: uuid(), kind: 'followup', expectedVersion: 1, ...sms(body) });
  await mutateTemplate(store, manager, draft('First edit {{firstName}}'), NOW);
  await assert.rejects(mutateTemplate(store, manager, draft('Stale edit {{firstName}}'), NOW), error => error.code === 'messaging_template_revision_conflict' && error.status === 409 && error.details.latestVersion === 2);
  const racing = memoryStore(), results = await Promise.allSettled([mutateTemplate(racing, manager, draft('Race A {{firstName}}'), NOW), mutateTemplate(racing, owner, draft('Race B {{firstName}}'), NOW)]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'messaging_template_revision_conflict');
  const input = draft('Replay {{firstName}}'); input.expectedVersion = 2;
  const first = await mutateTemplate(store, manager, input, NOW), replay = await mutateTemplate(store, manager, input, NOW);
  assert.equal(replay.replayed, true); assert.equal(replay.template.latestVersion, first.template.latestVersion);
  await assert.rejects(mutateTemplate(store, manager, { ...input, body: 'Different body' }, NOW), code('messaging_idempotency_conflict'));
  await assert.rejects(mutateTemplate(store, manager, { ...draft('x'), extra: true }, NOW), code('messaging_request_invalid'));
  await assert.rejects(mutateTemplate(store, manager, { ...draft('x'), kind: '__proto__' }, NOW), code('messaging_template_unknown'));
});

test('automation needs owner approval and retiring the live version turns automation off', async () => {
  const store = memoryStore(), hash = await seedHash('day_before_reminder');
  const toggle = (expectedVersion, enabled) => mutateTemplate(store, owner, { action: 'set_automation', requestId: uuid(), kind: 'day_before_reminder', expectedVersion, enabled }, NOW);
  await assert.rejects(toggle(1, true), code('messaging_template_not_approved'));
  await mutateTemplate(store, owner, { action: 'approve', requestId: uuid(), kind: 'day_before_reminder', expectedVersion: 1, version: 1, hash }, NOW);
  assert.equal((await toggle(1, true)).template.automationEnabled, true);
  assert.equal((await activeTemplate(store, 'day_before_reminder')).automationEnabled, true);
  const retired = await mutateTemplate(store, owner, { action: 'retire', requestId: uuid(), kind: 'day_before_reminder', expectedVersion: 1, version: 1 }, NOW);
  assert.deepEqual([retired.template.activeVersion, retired.template.automationEnabled], [null, false]);
  assert.equal(await activeTemplate(store, 'day_before_reminder'), null);
});

test('template API is same-origin, manager-readable and owner-approved', async () => {
  const store = memoryStore(), sessions = { owner, manager, crew };
  let who = 'manager';
  const handlers = messageTemplateHandlers({ session: async () => sessions[who], storage: () => store, now: () => new Date(NOW) });
  const post = (body, headers = {}) => handlers.post({ request: new Request('https://easygaragecleaning.com/api/message-templates', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), env: {} });
  const list = await (await handlers.get({ request: new Request('https://easygaragecleaning.com/api/message-templates'), env: {} })).json();
  assert.equal(list.ok, true); assert.equal(list.templates.length, 13); assert.deepEqual(list.viewer, { id: 'tylerg', role: 'manager', canApprove: false });
  sessions.tylerOwner = { ...manager, role: 'owner' }; who = 'tylerOwner';
  assert.deepEqual((await (await handlers.get({ request: new Request('https://easygaragecleaning.com/api/message-templates'), env: {} })).json()).viewer, { id: 'tylerg', role: 'owner', canApprove: false });
  who = 'manager';
  assert.deepEqual(list.delivery, { enabled: false, dryRun: true });
  assert.equal(list.templates.find(row => row.kind === 'day_before_reminder').automatable, true);
  assert.equal(list.templates.find(row => row.kind === 'on_my_way').automatable, false);
  assert.equal(JSON.stringify(list).includes('revision'), false);
  const hash = list.templates.find(row => row.kind === 'review_request').versions[0].hash;
  assert.equal((await post({ action: 'approve', requestId: uuid(), kind: 'review_request', expectedVersion: 1, version: 1, hash })).status, 403);
  assert.equal((await post({ action: 'approve', requestId: uuid(), kind: 'review_request', expectedVersion: 1, version: 1, hash }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ action: 'approve', requestId: uuid(), kind: 'review_request', expectedVersion: 1, version: 1, hash }, { Origin: 'https://evil.example.invalid' })).status, 403);
  assert.equal((await post({}, { 'Content-Type': 'text/plain' })).status, 415);
  who = 'owner';
  const approved = await post({ action: 'approve', requestId: uuid(), kind: 'review_request', expectedVersion: 1, version: 1, hash });
  assert.equal(approved.status, 200); assert.equal((await approved.json()).template.activeVersion, 1);
  const bad = await post({ action: 'save_draft', requestId: uuid(), kind: 'review_request', expectedVersion: 1, ...sms('Hi {{secret}}') });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).code, 'messaging_template_variable_unknown');
  who = 'crew';
  assert.equal((await handlers.get({ request: new Request('https://easygaragecleaning.com/api/message-templates'), env: {} })).status, 403);
  who = 'none';
  assert.equal((await handlers.get({ request: new Request('https://easygaragecleaning.com/api/message-templates'), env: {} })).status, 401);
  const broken = messageTemplateHandlers({ session: async () => owner, storage: () => ({ read: async () => { throw new Error('secret provider detail'); } }) });
  const failure = await broken.get({ request: new Request('https://easygaragecleaning.com/api/message-templates'), env: {} });
  assert.equal(failure.status, 503); assert.doesNotMatch(await failure.text(), /secret provider detail/);
});

test('message records are server-only and the template screen is a private, non-indexed page', async () => {
  const { readFileSync } = await import('node:fs');
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const rules = read('firestore.rules');
  for (const collection of ['message_sends', 'message_templates', 'message_operations']) {
    assert.match(rules, new RegExp(`match /${collection}/\\{documentId\\} \\{\\s*allow read, write: if false;\\s*\\}`), collection);
  }
  assert.match(read('_headers'), /\/message-templates\*\n  X-Robots-Tag: noindex\n  Cache-Control: no-store\n  X-Frame-Options: DENY/);
  const page = read('message-templates.html');
  assert.match(page, /<meta name="robots" content="noindex,nofollow">/);
  assert.doesNotMatch(page, /analytics-loader|googletagmanager|fb-capture/);
  assert.doesNotMatch(read('message-templates.js'), /innerHTML|insertAdjacentHTML|outerHTML/);
});
