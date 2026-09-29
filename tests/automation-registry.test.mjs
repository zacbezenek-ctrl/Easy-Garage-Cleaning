import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATION_REGISTRY, attestationStatus, automationById, automationCleared, automationTemplateHash, bookingMessages, bookingSurfaces, classifyTouch, diffGhlWorkflows,
  evaluateGate, evaluateGates, fetchGhlWorkflows, gateBlockers, hubWritesFor, listenersFor, matchTemplate, messagesForSurfaces, registryHash, registryProblems, registryReport,
  resolveSurface, templateMatches,
} from '../functions/_lib/automation-registry.js';
import { automationRegistryHandlers } from '../functions/api/automation-registry.js';
import { MESSAGE_KINDS } from '../functions/_lib/message-policies.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const clone = () => structuredClone(AUTOMATION_REGISTRY);
const byId = (registry, id) => registry.automations.find(entry => entry.id === id);

// A small registry whose one gate can open: every listener is verified and
// cleared. Tests change one fact at a time to prove each blocker.
async function openable() {
  const text = 'Hi {{firstName}}, your Easy Garage Cleaning visit is booked for {{serviceDate}}.';
  const registry = {
    schemaVersion: 1, registryVersion: '2026-09-22.1', sources: { hub_code: { status: 'complete', verifiedAt: '2026-09-22', method: 'Synthetic', evidence: [] } },
    triggers: [{ id: 'tag:egc-synthetic', type: 'tag_added', label: 'Synthetic', listenersVerified: true, hubWrites: [{ file: 'functions/api/highlevel.js', via: [], when: 'synthetic', automatic: true }], notes: '' }],
    automations: [{ id: 'ghl.synthetic_confirmation', name: 'Synthetic confirmation', system: 'ghl_workflow', providerId: '00000000-0000-4000-8000-000000000001', verifiedAt: '2026-09-22',
      trigger: 'Tag egc-synthetic', listensTo: ['tag:egc-synthetic'], audience: 'customer', channel: 'SMS', contentSource: 'provider_template', classification: 'owner_automation',
      disposition: 'approved_automatic', sendsToday: 'yes', speedToLead: 'automation_touch', subject: null, templateText: text, templateHash: await automationTemplateHash(text),
      approvedBy: 'zacb', approvedAt: '2026-09-21T15:00:00.000Z', msgCoreKind: null, code: [], evidence: [], notes: '', ownerCheck: '' }],
    gates: [{ id: 'SYN.gate', unit: 'SYN', label: 'Synthetic gate', surfaces: ['tag:egc-synthetic'] }],
    tagPatterns: [], lifecycleEvents: [], codeInventory: {}, attestations: [],
  };
  registry.attestations = [{ attestedBy: 'zacb', attestedAt: '2026-09-21T16:00:00.000Z', registryHash: await registryHash(registry) }];
  return registry;
}

test('the checked-in registry satisfies every approval-rule invariant and each template hash matches its text', async () => {
  assert.deepEqual(await registryProblems(AUTOMATION_REGISTRY), []);
  for (const entry of AUTOMATION_REGISTRY.automations.filter(item => item.templateText !== null)) assert.equal(entry.templateHash, await automationTemplateHash(entry.templateText), entry.id);
  assert.ok(Object.isFrozen(AUTOMATION_REGISTRY) && Object.isFrozen(AUTOMATION_REGISTRY.automations[0]), 'the checked-in data is read-only at runtime');
  assert.match(await registryHash(AUTOMATION_REGISTRY), /^[0-9a-f]{64}$/);
});

test('the registry covers the design inventory: AI text-backs retire, live sends are grandfathered, nothing is owner-approved yet', () => {
  const entry = id => automationById(AUTOMATION_REGISTRY, id);
  for (const id of ['zapier.website_lead_ai_textback', 'zapier.facebook_lead_ai_textback', 'ghl.conversation_ai']) {
    assert.equal(entry(id).contentSource, 'ai_generated', id);
    assert.equal(entry(id).disposition, 'retire', id);
    assert.equal(automationCleared(entry(id)), false, id);
  }
  for (const event of ['estimate_ready', 'estimate_approved', 'deposit_received', 'invoice_issued', 'payment_received', 'estimate_expiring', 'invoice_overdue']) assert.equal(entry(`ghl.lifecycle.${event}`).disposition, 'retire', event);
  assert.deepEqual(AUTOMATION_REGISTRY.automations.filter(item => item.disposition === 'approved_automatic').map(item => item.id).sort(),
    ['ghl.garage_instant_text_nurture', 'ghl.junk_lead_nurture', 'ghl.missed_call_textback', 'hub.portal_invitation', 'hub.portal_invitation_email', 'stripe.payment_receipt_email']);
  assert.equal(AUTOMATION_REGISTRY.automations.some(item => item.approvedBy !== null), false, 'no owner approval is fabricated');
  assert.deepEqual(AUTOMATION_REGISTRY.attestations, [], 'no owner attestation is fabricated');
  assert.deepEqual(AUTOMATION_REGISTRY.automations.map(item => item.msgCoreKind).filter(Boolean).sort(), [...MESSAGE_KINDS].sort());
  assert.equal(entry('hub.portal_invitation').msgCoreKind, 'portal_invitation_adapter');
  for (const id of ['ghl.garage_instant_text_nurture', 'ghl.junk_lead_nurture', 'ghl.facebook_service_router', 'ghl.garage_sales_exit', 'ghl.junk_sales_exit'])
    assert.match(entry(id).providerId, /^[0-9a-f-]{36}$/, `${id} keeps its verified HighLevel workflow id`);
});

test('the invariants reject unsafe or inconsistent classifications', async () => {
  const cases = [
    [r => { byId(r, 'zapier.website_lead_ai_textback').disposition = 'approved_automatic'; byId(r, 'zapier.website_lead_ai_textback').classification = 'owner_automation'; byId(r, 'zapier.website_lead_ai_textback').sendsToday = 'yes'; }, /AI-written messages can never be approved automatically/],
    [r => { byId(r, 'hub.portal_invitation').templateText += ' '; }, /templateHash does not match templateText/],
    [r => { byId(r, 'hub.portal_invitation').approvedBy = 'tylerg'; byId(r, 'hub.portal_invitation').approvedAt = '2026-09-22T12:00:00.000Z'; }, /only the owner approves/],
    [r => { byId(r, 'ghl.missed_call_textback').approvedBy = 'zacb'; byId(r, 'ghl.missed_call_textback').approvedAt = '2026-09-22T12:00:00.000Z'; }, /an approval is of an exact automatic template/],
    [r => { byId(r, 'ghl.garage_sales_exit').audience = 'customer'; }, /disposition internal does not fit classification internal/],
    [r => { byId(r, 'hub.staff_customer_message').disposition = 'approved_automatic'; }, /does not fit classification human_approved/],
    [r => { byId(r, 'ghl.junk_lead_nurture').listensTo = ['tag:egc-not-registered']; }, /listens to unknown trigger/],
    [r => { r.automations.push({ ...structuredClone(byId(r, 'quo.staff_free_text')) }); }, /id must be unique/],
    [r => { byId(r, 'zapier.garage_guard_alert').code = []; }, /functions\/api\/stripe-webhook.js zapier_hook: no automation claims this send path/],
    [r => { byId(r, 'hub.staff_customer_message').code.push({ file: 'functions/api/new-send.js', signature: 'ghl_message_send' }); }, /is not in codeInventory/],
    [r => { byId(r, 'ghl.junk_lead_nurture').providerId = 'junk-lead-nurture'; }, /workflow id is a UUID/],
    [r => { byId(r, 'quo.prejob_arrival').templateText = null; byId(r, 'quo.prejob_arrival').templateHash = null; }, /a fixed template must register its text/],
    [r => { r.gates[0].surfaces.push('tag:egc-nowhere'); }, /unknown surface/],
    [r => { r.attestations.push({ attestedBy: 'alexk', attestedAt: '2026-09-22T12:00:00.000Z', registryHash: 'a'.repeat(64) }); }, /attestation: owner/],
    [r => { byId(r, 'ghl.booking_confirmation_workflows').ownerCheck = ''; }, /say what the owner must check/],
    [r => { r.triggers[0].hubWrites[0].automatic = 'yes'; }, /each hub write needs/],
    [r => { byId(r, 'ghl.junk_lead_nurture').verifiedAt = '2026-09-20 18:00'; }, /verifiedAt must be a date, an ISO instant or null/],
  ];
  for (const [mutate, expected] of cases) {
    const registry = clone();
    mutate(registry);
    const problems = await registryProblems(registry);
    assert.ok(problems.some(problem => expected.test(problem)), `${expected}: ${problems.join(' | ')}`);
  }
  assert.deepEqual(await registryProblems({ schemaVersion: 2 }), ['registry: schemaVersion must be 1']);
});

test('every automation lists the Hub writes that can start it', () => {
  const writes = id => hubWritesFor(AUTOMATION_REGISTRY, id);
  assert.deepEqual([...new Set(writes('ghl.booking_confirmation_workflows').map(item => item.trigger))], ['tag:egc-hub-scheduled', 'tag:egc-job-scheduled', 'tag:egc-walkthrough-scheduled']);
  assert.ok(writes('ghl.booking_confirmation_workflows').every(item => item.file === 'functions/api/highlevel.js' && item.automatic === true));
  assert.deepEqual(writes('ghl.garage_sales_exit').map(item => item.file), ['functions/_lib/sales-followup-exit.js']);
  assert.deepEqual(writes('ghl.lifecycle.payment_received').flatMap(item => item.via).sort(), ['crew/postjob.html', 'employee-suite.js']);
  assert.deepEqual(writes('ghl.garage_instant_text_nurture'), [], 'Facebook forms start the nurture, not the Hub');
  assert.ok(writes('ghl.opportunity_workflows').some(item => item.trigger === 'opportunity_status:lost' && item.file.endsWith('mcp/src/server.ts') && item.automatic === false));
  const appointment = writes('ghl.appointment_status_workflows');
  assert.ok(appointment.some(item => item.trigger === 'appointment:created' && item.file === 'functions/api/highlevel.js' && item.via.includes('employee-suite.js') && item.automatic === true), 'every booking sync writes the appointment');
  assert.ok(appointment.some(item => item.trigger === 'appointment:created' && item.file === 'egc-platform/apps/api/src/scheduling.ts'));
  assert.ok(appointment.some(item => item.trigger === 'appointment_status:changed' && /deleteCalendarEvent/.test(item.when)));
  assert.deepEqual([...new Set(writes('ghl.note_task_workflows').map(item => `${item.trigger} ${item.file}`))].sort(), ['contact:note_added egc-platform/services/operations/src/note-outbox.ts',
    'contact:note_added functions/_lib/web-lead-intake.js', 'contact:note_added functions/api/highlevel.js', 'contact:task_added functions/_lib/highlevel-checkin.js', 'contact:task_added functions/api/highlevel.js']);
  assert.deepEqual(writes('unknown.id'), []);
  assert.deepEqual(listenersFor(AUTOMATION_REGISTRY, 'call:missed').map(item => item.id), ['ghl.missed_call_textback', 'ghl.missed_call_cooldown_helper']);
  assert.equal(resolveSurface(AUTOMATION_REGISTRY, 'tag:egc-reminder-14d').id, 'tag:egc-reminder-{n}d');
  assert.equal(resolveSurface(AUTOMATION_REGISTRY, 'tag:egc-reminder-xd'), null);
});

test('booking messages give the FUN-11 dialog its texts and show exactly what is not yet registered', () => {
  assert.deepEqual(bookingSurfaces({ eventType: 'job', notify: true, reminderDays: 3 }),
    ['tag:egc-hub-scheduled', 'tag:egc-job-scheduled', 'tag:egc-reminder-3d', 'appointment:created_notify', 'appointment:created', 'opportunity:created', 'opportunity_stage:scheduled', 'contact:upsert']);
  assert.deepEqual(bookingSurfaces({ eventType: 'job', notify: true, contactLinked: true, opportunityLinked: true }),
    ['tag:egc-hub-scheduled', 'tag:egc-job-scheduled', 'tag:egc-reminder-2d', 'appointment:created_notify', 'appointment:created', 'opportunity_stage:scheduled'], 'a linked opportunity only changes stage');
  assert.deepEqual(bookingSurfaces({ eventType: 'walkthrough', notify: false, contactLinked: true, opportunityLinked: false }), ['tag:egc-hub-scheduled', 'tag:egc-walkthrough-scheduled', 'appointment:created'],
    'notify off still writes the type tag and the confirmed appointment; a walkthrough never creates an opportunity');
  assert.deepEqual(bookingSurfaces({ reminderDays: 90 }).slice(2, 3), ['tag:egc-reminder-30d']);
  const job = bookingMessages(AUTOMATION_REGISTRY, { eventType: 'job' });
  assert.equal(job.complete, false);
  assert.deepEqual(job.messages.map(item => item.automationId),
    ['ghl.booking_confirmation_workflows', 'ghl.appointment_reminder_workflows', 'ghl.calendar_notifications', 'ghl.appointment_status_workflows', 'ghl.opportunity_workflows', 'ghl.contact_change_workflows']);
  assert.ok(job.messages.every(item => item.templateText === null && item.cleared === false), 'unverified workflows never pretend to have a text');
  for (const blocker of ['listeners_unverified:tag:egc-job-scheduled', 'automation_unapproved:ghl.calendar_notifications', 'listeners_unverified:opportunity:created', 'listeners_unverified:appointment:created', 'automation_unapproved:ghl.appointment_status_workflows'])
    assert.ok(job.blockers.includes(blocker), `${blocker}: ${job.blockers.join(',')}`);
  const linked = bookingMessages(AUTOMATION_REGISTRY, { eventType: 'job', contactLinked: true, opportunityLinked: true });
  assert.equal(linked.blockers.includes('listeners_unverified:opportunity:created'), false);
  assert.ok(linked.messages.some(item => item.automationId === 'ghl.opportunity_workflows'), 'the stage change still reaches the opportunity workflows');
  const silent = bookingMessages(AUTOMATION_REGISTRY, { eventType: 'walkthrough', notify: false, contactLinked: true });
  assert.deepEqual(silent.messages.map(item => item.automationId), ['ghl.booking_confirmation_workflows', 'ghl.appointment_status_workflows'], 'a notify-off booking can still start appointment workflows');
  assert.ok(silent.blockers.includes('listeners_unverified:appointment:created') && silent.blockers.includes('automation_unapproved:ghl.appointment_status_workflows'));
  assert.ok(bookingMessages(AUTOMATION_REGISTRY, { reminderDays: 2.5 }).blockers.includes('trigger_unregistered:tag:egc-reminder-2.5d'));
  const gate = AUTOMATION_REGISTRY.gates.find(item => item.id === 'FUN-11.booking_notify_default');
  for (const input of [{ eventType: 'job' }, { eventType: 'walkthrough', notify: false }, { eventType: 'job', reminderDays: 7 }])
    for (const surface of bookingSurfaces(input)) assert.ok(gate.surfaces.some(item => resolveSurface(AUTOMATION_REGISTRY, item)?.id === resolveSurface(AUTOMATION_REGISTRY, surface).id), `the FUN-11 gate covers ${surface}`);
});

test('a gate opens only with verified listeners, owner-approved texts and a current attestation', async () => {
  for (const gate of await evaluateGates(AUTOMATION_REGISTRY, { now: NOW })) {
    assert.equal(gate.go, false, gate.id);
    assert.equal(gate.reasons[0], 'attestation_never');
  }
  const lost = await evaluateGate(AUTOMATION_REGISTRY, 'FUN-12.opportunity_lost_write', { now: NOW });
  assert.deepEqual(lost.reasons, ['attestation_never', 'listeners_unverified:opportunity_status:lost', 'automation_unapproved:ghl.opportunity_workflows']);
  assert.deepEqual(gateBlockers(AUTOMATION_REGISTRY, 'FUN-35.attribution_writes').filter(item => item.startsWith('listeners_unverified')), ['listeners_unverified:contact_field:attribution', 'listeners_unverified:tag:egc-repeat-inquiry', 'listeners_unverified:opportunity:created']);
  await assert.rejects(evaluateGate(AUTOMATION_REGISTRY, 'FUN-99.none', { now: NOW }), { code: 'automation_registry_gate_unknown', status: 404 });

  const registry = await openable();
  const open = await evaluateGate(registry, 'SYN.gate', { now: NOW });
  assert.equal(open.go, true, open.reasons.join(','));
  assert.equal(open.messages[0].templateText, registry.automations[0].templateText);
  const blocked = async (mutate, reason) => {
    const copy = structuredClone(registry);
    await mutate(copy);
    const result = await evaluateGate(copy, 'SYN.gate', { now: NOW });
    assert.equal(result.go, false);
    assert.ok(result.reasons.includes(reason), `${reason}: ${result.reasons.join(',')}`);
  };
  await blocked(copy => { copy.triggers[0].listenersVerified = false; }, 'listeners_unverified:tag:egc-synthetic');
  await blocked(copy => { copy.automations[0].approvedBy = null; copy.automations[0].approvedAt = null; }, 'automation_unapproved:ghl.synthetic_confirmation');
  await blocked(copy => { copy.automations[0].contentSource = 'ai_generated'; copy.automations[0].approvedBy = null; copy.automations[0].approvedAt = null; copy.automations[0].disposition = 'needs_owner_approval'; }, 'automation_ai_generated:ghl.synthetic_confirmation');
  await blocked(copy => { copy.automations[0].name = 'Changed after the attestation'; }, 'attestation_stale');
  await blocked(copy => { copy.automations[0].templateHash = 'f'.repeat(64); copy.attestations = []; }, 'registry_invalid');
  const late = await evaluateGate(registry, 'SYN.gate', { now: new Date('2026-10-22T07:00:00.000Z') });
  assert.deepEqual(late.reasons, ['attestation_overdue']);
});

test('the monthly attestation is due one Denver calendar month later and voids on any content change', async () => {
  const registry = await openable(), hash = await registryHash(registry);
  const at = (attestedAt, now, current = hash) => attestationStatus({ ...registry, attestations: [{ attestedBy: 'zacb', attestedAt, registryHash: hash }] }, new Date(now), current);
  assert.deepEqual(attestationStatus({ ...registry, attestations: [] }, NOW, hash), { status: 'never', attestedBy: null, attestedAt: null, dueOn: null, registryHash: hash });
  // 03:00Z on Feb 1 is still Jan 31 in Denver, so the next attestation is due Feb 28, not Mar 1.
  assert.equal(at('2026-02-01T03:00:00.000Z', '2026-02-28T23:30:00.000Z').dueOn, '2026-02-28');
  assert.equal(at('2026-02-01T03:00:00.000Z', '2026-02-28T23:30:00.000Z').status, 'current');
  assert.equal(at('2026-02-01T03:00:00.000Z', '2026-03-01T07:30:00.000Z').status, 'overdue');
  assert.equal(at('2026-12-15T18:00:00.000Z', '2027-01-15T18:00:00.000Z').dueOn, '2027-01-15');
  assert.equal(at('2027-01-31T18:00:00.000Z', '2027-02-15T12:00:00.000Z').dueOn, '2027-02-28');
  assert.equal(at('2026-09-21T16:00:00.000Z', '2026-09-22T12:00:00.000Z', 'b'.repeat(64)).status, 'stale');
  const latest = attestationStatus({ ...registry, attestations: [{ attestedBy: 'zacb', attestedAt: '2026-09-21T16:00:00.000Z', registryHash: hash }, { attestedBy: 'zacb', attestedAt: '2026-06-01T16:00:00.000Z', registryHash: 'c'.repeat(64) }] }, NOW, hash);
  assert.equal(latest.attestedAt, '2026-09-21T16:00:00.000Z');
  assert.throws(() => attestationStatus(registry, new Date('invalid'), hash), { code: 'automation_registry_clock_invalid' });
  assert.equal(await registryHash({ ...registry, attestations: [] }), hash, 'recording an attestation never changes the attested content');
});

test('a future-dated, non-owner or malformed attestation is invalid and never keeps the gate open', async () => {
  const registry = await openable(), hash = await registryHash(registry), now = new Date('2026-09-28T18:00:00.000Z');
  const good = { attestedBy: 'zacb', attestedAt: '2026-09-21T16:00:00.000Z', registryHash: hash };
  const status = (...attestations) => attestationStatus({ ...registry, attestations }, now, hash);
  assert.equal(status(good).status, 'current');
  // A year typo: 2027 instead of 2026 would otherwise stay current until 2027-10-28.
  assert.deepEqual(status(good, { ...good, attestedAt: '2027-09-28T16:00:00.000Z' }), { status: 'invalid', attestedBy: null, attestedAt: null, dueOn: null, registryHash: hash, invalid: 1 });
  assert.equal(status({ ...good, attestedAt: '2026-09-28T18:00:00.001Z' }).status, 'invalid', 'even a millisecond ahead of the clock');
  assert.equal(status({ ...good, attestedAt: '2026-09-28T18:00:00.000Z' }).status, 'current', 'an attestation at the current instant counts');
  assert.equal(status({ ...good, attestedBy: 'tylerg' }).status, 'invalid');
  assert.equal(status({ ...good, registryHash: 'not-a-hash' }).status, 'invalid');
  assert.equal(status({ ...good, attestedAt: '2026-09-21' }).status, 'invalid');
  // Instants with and without milliseconds order by time, not text.
  assert.equal(status({ ...good, attestedAt: '2026-09-21T16:00:00Z' }, { ...good, attestedAt: '2026-09-21T16:00:00.500Z', registryHash: 'd'.repeat(64) }).status, 'stale');
  const gate = await evaluateGate({ ...registry, attestations: [{ ...good, attestedAt: '2027-09-28T16:00:00.000Z' }] }, 'SYN.gate', { now });
  assert.equal(gate.go, false);
  assert.ok(gate.reasons.includes('attestation_invalid'), gate.reasons.join(','));
});

test('speed to lead: registered automations are automation touches, approved and staff sends are human, unknown stays unknown', () => {
  const touch = message => classifyTouch(AUTOMATION_REGISTRY, message);
  assert.deepEqual(touch({ direction: 'inbound', body: 'Hi' }), { actor: 'customer', entryId: null, registered: false, reason: 'inbound', speedToLead: null });
  assert.deepEqual(touch({ direction: 'outbound', workflowId: 'edae095b-6ccb-4620-b66e-e16d172251b2', source: 'workflow' }),
    { actor: 'automation', entryId: 'ghl.garage_instant_text_nurture', registered: true, reason: 'registered_workflow', speedToLead: 'automation_touch' });
  assert.equal(touch({ direction: 'outbound', workflowId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }).reason, 'unregistered_workflow');
  assert.deepEqual(touch({ direction: 'outbound', source: 'api', messageSendId: 'ms_synthetic', kind: 'followup_draft', approval: 'task_approval' }),
    { actor: 'human', entryId: 'hub.msgcore.followup_draft', registered: true, reason: 'approved_send', speedToLead: 'human_touch' });
  assert.equal(touch({ direction: 'outbound', source: 'api', messageSendId: 'ms_synthetic', kind: 'day_before_reminder', approval: 'owner_automation' }).actor, 'automation');
  const invite = touch({ direction: 'outbound', source: 'api', body: 'Hi Pat, your quote is approved. Here is your private Easy Garage Cleaning project portal for job details, messages, and payments: https://easygaragecleaning.com/api/customer-portal-session?access=synthetic' });
  assert.deepEqual([invite.actor, invite.entryId, invite.speedToLead], ['automation', 'hub.portal_invitation', null], 'the registry says a portal invitation is no lead response');
  const arrival = touch({ direction: 'outbound', body: 'Hi Pat — the Easy Garage Cleaning crew is on the way to 1 Synthetic Way. We\'ll see you shortly. Reply here if anything changed.' });
  assert.deepEqual([arrival.actor, arrival.entryId, arrival.reason, arrival.speedToLead], ['human', 'quo.prejob_arrival', 'human_template', null], 'an on-my-way text is never the first human response');
  const confirmation = touch({ direction: 'outbound', body: 'Hi Pat, it\'s Easy Garage Cleaning — confirming your garage comeback tomorrow at 9 AM. Crew of 2, we\'ll knock when we arrive. Flat rate locked at $450 like we agreed — nothing changes. Reply C to confirm. — Alex' });
  assert.deepEqual([confirmation.entryId, confirmation.speedToLead], ['quo.prejob_confirmation', null]);
  const review = touch({ direction: 'outbound', body: 'Hi Pat, it was great working with you! If you have a moment, we\'d really appreciate it if you left us a review — it goes a long way in helping us grow. As a thank-you for choosing us, we\'d love to offer you 10% off your next service. We look forward to working with you again! https://g.page/r/synthetic' });
  assert.deepEqual([review.actor, review.entryId, review.speedToLead], ['human', 'zapier.crew_review_request', null]);
  assert.equal(touch({ direction: 'outbound', messageSendId: 'ms_synthetic', kind: 'day_before_reminder', approval: 'preview_confirm' }).speedToLead, null, 'a reminder is registered as no lead response even when a person confirmed it');
  assert.deepEqual(touch({ direction: 'outbound', source: 'api', messageSendId: 'ms_synthetic', kind: 'portal_magic_link', approval: 'customer_initiated' }),
    { actor: 'automation', entryId: 'hub.msgcore.portal_magic_link', registered: true, reason: 'customer_initiated_send', speedToLead: null });
  assert.deepEqual(touch({ direction: 'outbound', messageSendId: 'ms_synthetic', kind: 'unregistered_kind', approval: 'customer_initiated' }).speedToLead, 'automation_touch', 'a customer-initiated send is never a human touch');
  assert.equal(touch({ direction: 'outbound', messageSendId: 'ms_synthetic', kind: 'followup_draft', approval: 'owner_automation' }).speedToLead, 'automation_touch', 'the approval, not the path, decides an automatic send');
  assert.deepEqual(touch({ direction: 'outbound', messageSendId: 'ms_synthetic', kind: 'followup_draft', approval: 'not_a_mode' }), { actor: 'unknown', entryId: 'hub.msgcore.followup_draft', registered: true, reason: 'approval_unknown', speedToLead: null });
  assert.deepEqual([touch({ direction: 'outbound', source: 'workflow' }).actor, touch({ direction: 'outbound', source: 'workflow' }).registered], ['automation', false]);
  assert.equal(touch({ direction: 'outbound', source: 'api', userId: 'ghl-user-1', body: 'Typed by staff' }).actor, 'human', 'a staff user id wins over source api');
  assert.equal(touch({ direction: 'outbound', source: 'api', body: 'Unregistered automatic text' }).reason, 'api_without_user');
  assert.equal(touch({ direction: 'outbound', body: 'No evidence' }).actor, 'unknown');
  assert.equal(touch({ body: 'No direction' }).reason, 'direction_unknown');
});

test('template matching is exact, needs every placeholder filled and stays linear on hostile input', () => {
  const text = 'Hi {{firstName}}, see you {{serviceDate}} at [TIME].';
  assert.equal(templateMatches(text, 'Hi Pat,   see you Friday at 9 AM.'), true, 'whitespace is normalized');
  assert.equal(templateMatches(text, 'Hi , see you Friday at 9 AM.'), false, 'an empty placeholder is not a match');
  assert.equal(templateMatches(text, 'Hi Pat, see you Friday at 9 AM!'), false);
  assert.equal(templateMatches(text, 'Hello Pat, see you Friday at 9 AM.'), false);
  assert.equal(templateMatches('No placeholders.', 'No placeholders.'), true);
  assert.equal(templateMatches('{{a}}{{b}}', 'x'), false);
  assert.equal(templateMatches('{{a}}{{b}}', 'xy'), true);
  assert.equal(templateMatches('', 'x'), false);
  const hostile = `Hi ${'a, see you '.repeat(40000)}`;
  assert.equal(templateMatches(text, hostile), false);
  assert.equal(matchTemplate(AUTOMATION_REGISTRY, '   '), null);
  const review = matchTemplate(AUTOMATION_REGISTRY, 'Hi there, it was great working with you! If you have a moment, we\'d really appreciate it if you left us a review — it goes a long way in helping us grow. As a thank-you for choosing us, we\'d love to offer you 10% off your next service. We look forward to working with you again! https://search.google.com/local/writereview?placeid=synthetic');
  assert.equal(review.id, 'zapier.crew_review_request');
});

test('a HighLevel workflow listing is diffed read-only against the registry', () => {
  const rows = [
    { id: 'edae095b-6ccb-4620-b66e-e16d172251b2', name: 'Garage instant text + nurture', status: 'published', updatedAt: '2026-09-20T05:00:00.000Z' },
    { id: '2ac2aba5-1521-4e76-82af-074c039d84a2', name: 'Junk Lead Nurture', status: 'draft', updatedAt: '2026-09-10T12:00:00.000Z' },
    { id: 'ae9f0826-8ec1-467d-8059-59c024a9de5e', name: 'Router', status: 'published', updatedAt: '2026-09-22T15:00:00.000Z' },
    { id: '11111111-2222-4333-8444-555555555555', name: 'Synthetic new workflow', status: 'published', updatedAt: '2026-09-22T15:00:00.000Z' },
  ];
  const diff = diffGhlWorkflows(AUTOMATION_REGISTRY, rows);
  assert.equal(diff.complete, false);
  assert.equal(diff.listed, 4);
  assert.deepEqual(diff.unregistered.map(row => row.id), ['11111111-2222-4333-8444-555555555555']);
  assert.deepEqual(diff.missing.map(row => row.automationId), ['ghl.garage_sales_exit', 'ghl.junk_sales_exit', 'ghl.missed_call_cooldown_helper', 'ghl.garage_acquisition_reply_cleanup', 'ghl.garage_quote_reply_cleanup']);
  // 05:00Z on Sept 20 is still Sept 19 in Denver, the day before the verification: not a later change.
  assert.deepEqual(diff.changed.map(row => row.automationId), ['ghl.facebook_service_router']);
  // A date-only verification cannot order edits within its Denver day, so a same-day edit counts as changed;
  // 03:00Z on Sept 21 is still Sept 20 (the verification day) in Denver.
  const sameDay = [{ ...rows[0], updatedAt: '2026-09-21T03:00:00.000Z' }];
  assert.deepEqual(diffGhlWorkflows(AUTOMATION_REGISTRY, sameDay).changed.map(row => row.automationId), ['ghl.garage_instant_text_nurture']);
  const exact = clone();
  byId(exact, 'ghl.garage_instant_text_nurture').verifiedAt = '2026-09-20T18:00:00.000Z';
  assert.deepEqual(diffGhlWorkflows(exact, [{ ...rows[0], updatedAt: '2026-09-20T17:59:59.000Z' }]).changed, [], 'an instant verification orders edits exactly');
  assert.deepEqual(diffGhlWorkflows(exact, [{ ...rows[0], updatedAt: '2026-09-20T18:00:01.000Z' }]).changed.map(row => row.verifiedAt), ['2026-09-20T18:00:00.000Z']);
  assert.deepEqual(diff.statusMismatch, [{ automationId: 'ghl.junk_lead_nurture', providerId: '2ac2aba5-1521-4e76-82af-074c039d84a2', status: 'draft', sendsToday: 'yes' }]);
  const all = AUTOMATION_REGISTRY.automations.filter(entry => entry.system === 'ghl_workflow' && entry.providerId).map(entry => ({ id: entry.providerId, name: entry.name, status: 'published', updatedAt: '2026-09-01T12:00:00.000Z' }));
  assert.equal(diffGhlWorkflows(AUTOMATION_REGISTRY, all).complete, true);
  assert.throws(() => diffGhlWorkflows(AUTOMATION_REGISTRY, { workflows: [] }), { code: 'automation_registry_ghl_inventory_invalid' });
  assert.throws(() => diffGhlWorkflows(AUTOMATION_REGISTRY, [{ name: 'no id' }]), { code: 'automation_registry_ghl_inventory_invalid' });
});

test('the HighLevel workflow list is a read-only GET that never echoes credentials or provider bodies', async () => {
  const calls = [], token = 'synthetic-ghl-token-000000000000000000000000';
  const fetcher = async (url, options) => { calls.push({ url: String(url), options }); return Response.json({ workflows: [{ id: 'w-1', name: 'Synthetic', status: 'published', version: 3, updatedAt: '2026-09-22T12:00:00.000Z' }] }); };
  assert.deepEqual(await fetchGhlWorkflows({ token, locationId: 'loc-synthetic', fetcher }), [{ id: 'w-1', name: 'Synthetic', status: 'published', version: 3, updatedAt: '2026-09-22T12:00:00.000Z' }]);
  assert.equal(calls[0].url, 'https://services.leadconnectorhq.com/workflows/?locationId=loc-synthetic');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].options.headers.Version, '2021-07-28');
  const rejected = await fetchGhlWorkflows({ token, locationId: 'loc', fetcher: async () => Response.json({ message: `bad ${token}` }, { status: 401 }) }).catch(error => error);
  assert.equal(rejected.code, 'automation_registry_ghl_rejected');
  assert.doesNotMatch(`${rejected.message}${JSON.stringify(rejected.details)}`, /synthetic-ghl-token|bad/);
  await assert.rejects(fetchGhlWorkflows({ token, locationId: 'loc', fetcher: async () => Response.json({ items: [] }) }), { code: 'automation_registry_ghl_inventory_invalid' });
  await assert.rejects(fetchGhlWorkflows({ token, locationId: 'loc', fetcher: async () => { throw new Error(token); } }), error => error.code === 'automation_registry_ghl_unavailable' && !error.message.includes(token));
  let called = false;
  await assert.rejects(fetchGhlWorkflows({ token: '', locationId: 'loc', fetcher: async () => { called = true; } }), { code: 'automation_registry_ghl_not_configured' });
  assert.equal(called, false);
});

test('messagesForSurfaces never lists a no-audience workflow as a customer message', () => {
  const result = messagesForSurfaces(AUTOMATION_REGISTRY, ['tag:egc-garage-sales-exit']);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.blockers, ['listeners_unverified:tag:egc-garage-sales-exit']);
  assert.deepEqual(messagesForSurfaces(AUTOMATION_REGISTRY, ['tag:egc-unknown']).blockers, ['trigger_unregistered:tag:egc-unknown']);
});

const request = (path = '/api/automation-registry') => new Request(`https://easygaragecleaning.com${path}`, { headers: { Origin: 'https://easygaragecleaning.com' } });
const manager = { user: 'tylerg', role: 'manager', businessAccess: true, displayName: 'Synthetic Manager' };

test('GET /api/automation-registry is business-only, no-store and reports the registry with injected time', async () => {
  const handlers = profile => automationRegistryHandlers({ session: async () => profile, now: () => NOW });
  const denied = await handlers(null).get({ request: request(), env: {} });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, 'automation_registry_sign_in_required');
  const crew = await handlers({ user: 'synthetic-crew', role: 'crew', businessAccess: false }).get({ request: request(), env: {} });
  assert.equal(crew.status, 403);
  assert.equal((await crew.json()).code, 'automation_registry_forbidden');
  const query = await handlers(manager).get({ request: request('/api/automation-registry?view=all'), env: {} });
  assert.equal(query.status, 400);
  const response = await handlers(manager).get({ request: request(), env: {} });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.authority, 'employee_hub');
  assert.equal(body.asOf, NOW.toISOString());
  assert.equal(body.integrity.valid, true);
  assert.equal(body.registry.hash, await registryHash(AUTOMATION_REGISTRY));
  assert.equal(body.attestation.status, 'never');
  assert.equal(body.summary.automations, AUTOMATION_REGISTRY.automations.length);
  assert.equal(body.summary.byDisposition.approved_automatic, 6);
  assert.ok(body.gates.length === 3 && body.gates.every(gate => gate.go === false));
  const booking = body.automations.find(entry => entry.id === 'ghl.booking_confirmation_workflows');
  assert.ok(booking.hubWrites.length > 0 && booking.cleared === false && !('code' in booking));
  assert.deepEqual(body.triggers.find(trigger => trigger.id === 'call:missed').listeners, ['ghl.missed_call_textback', 'ghl.missed_call_cooldown_helper']);
  const broken = await automationRegistryHandlers({ session: async () => { throw new Error('storage down'); }, now: () => NOW }).get({ request: request(), env: {} });
  assert.equal(broken.status, 503);
  assert.doesNotMatch(await broken.text(), /storage down/);
});

test('an invalid registry is reported and closes every gate', async () => {
  const registry = clone();
  byId(registry, 'hub.portal_invitation').templateHash = '0'.repeat(64);
  const report = await registryReport(registry, { now: NOW });
  assert.equal(report.integrity.valid, false);
  assert.ok(report.gates.every(gate => gate.reasons.includes('registry_invalid')));
});
