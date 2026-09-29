import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AUTOMATION_REGISTRY, automationById, registryHash, templateMatches } from '../functions/_lib/automation-registry.js';
import { DOC, REPO_ROOT, inventoryDrift, main, missingReferences, renderRegistryMarkdown, scanRepository, scanSendPaths } from '../scripts/automation-inventory.mjs';
import { renderScript } from '../functions/api/quo-send.js';
import { sendAcceptedQuotePortal } from '../functions/_lib/portal-invitation.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const scan = scanRepository(REPO_ROOT);
const template = id => automationById(AUTOMATION_REGISTRY, id).templateText;

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'egc-automation-inventory-'));
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  return root;
}

test('every send path, tag write, lifecycle event and approved-send kind in the code is registered', () => {
  assert.deepEqual(inventoryDrift(AUTOMATION_REGISTRY, scan), [], 'classify the new path in functions/_lib/automation-registry-data.js, then run node scripts/automation-inventory.mjs --write');
  assert.deepEqual(scan.inventory, AUTOMATION_REGISTRY.codeInventory);
  assert.deepEqual(missingReferences(AUTOMATION_REGISTRY), [], 'every file the registry cites exists');
});

test('the generated owner document matches the registry', async () => {
  assert.equal(readFileSync(join(REPO_ROOT, DOC), 'utf8'), renderRegistryMarkdown(AUTOMATION_REGISTRY, await registryHash(AUTOMATION_REGISTRY)), 'run node scripts/automation-inventory.mjs --write');
});

test('the scanner finds a new send path anywhere in the Hub, crew pages or platform, and skips tests and the registry itself', () => {
  const root = tree({
    'functions/api/new-send.js': "const tags=['egc-new-thing',`egc-${kind}-done`];await fetch(API+'/conversations/messages',{method:'POST'});await fetch(API+`/contacts/${id}/tags`,{method:'POST'});const hook=env.NEW_LEAD_WEBHOOK_URL;",
    'crew/new.html': "<script>post({tool:'lifecycle',event:'new-event'});post({tool:'lifecycle',event:'quiet-event',suppress_automation:true});fetch('/api/quo-send',{method:'POST'})</script>",
    'egc-platform/apps/new/src/send.ts': 'await client.sendMessage({ type: "SMS" });',
    'page.html': "<script>fetch('/api/web-lead',{method:'POST'})</script>",
    'functions/_lib/sender.js': 'export async function deliverHighLevelMessage(env) {}\nawait deliverHighLevelMessage(env, job, {});',
    'functions/api/new-send.test.js': "fetch('/conversations/messages')",
    'tests/fixture.mjs': "fetch('/conversations/messages')",
    'functions/_lib/automation-registry-data.js': "const note='/conversations/messages';",
    'egc-platform/apps/new/dist/send.js': 'client.sendMessage({});',
  });
  try {
    const found = scanRepository(root);
    assert.deepEqual(found.inventory, {
      'crew/new.html': { hub_lifecycle_trigger: 2, hub_send_endpoint_call: 1 },
      'egc-platform/apps/new/src/send.ts': { ghl_client_write: 1 },
      'functions/_lib/sender.js': { hub_send_helper_call: 1 },
      'functions/api/new-send.js': { ghl_message_send: 1, ghl_tag_write: 1, zapier_hook: 1 },
      'page.html': { hub_send_endpoint_call: 1 },
    });
    assert.deepEqual(found.tags, { 'functions/api/new-send.js': ['egc-new-thing', 'egc-{*}-done'] });
    assert.deepEqual(found.lifecycle, { 'new-event': { files: ['crew/new.html'], suppressed: false }, 'quiet-event': { files: ['crew/new.html'], suppressed: true } });
    const drift = inventoryDrift(AUTOMATION_REGISTRY, found);
    for (const line of ['unregistered send path: functions/api/new-send.js ghl_message_send x1', 'unregistered send path: egc-platform/apps/new/src/send.ts ghl_client_write x1',
      'unregistered tag write: functions/api/new-send.js writes egc-new-thing', 'unregistered tag pattern: functions/api/new-send.js writes egc-{*}-done', 'unregistered lifecycle event: new-event',
      'stale registry entry: functions/api/quo-send.js quo_send', 'stale lifecycle event: estimate-ready'])
      assert.ok(drift.some(item => item.startsWith(line)), `${line}\n${drift.join('\n')}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('contact, note, task and calendar writes, platform client writes and Hub endpoint calls with a query are all send paths', () => {
  const root = tree({
    'functions/api/attribution.js': "await ghl(c, `/contacts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ customFields: [{ key: 'utm_source', field_value: source }] }) });\n"
      + "await ghl(c, `/contacts/${encodeURIComponent(id)}/notes`, { method: 'POST' });\nawait ghl(c, `/contacts/${id}/tasks`, { method: 'POST' });\nawait ghl(c, `/contacts/${id}/notes/${noteId}`, { method: 'PUT' });\n"
      + "await ghl(c, '/contacts/', { method: 'POST' });\nawait ghl(c, `/contacts/${id}/workflow/${workflowId}`, { method: 'POST' });\nawait ghl(c, `/contacts/?${params}`);",
    'egc-platform/services/new/src/sync.ts': 'await provider.createContact(input);\nawait provider.createContactNote(id, body, title);\nawait ghlClient().deleteCalendarEvent(eventId);',
    'egc-platform/packages/new/src/client.ts': 'return this.request(`/calendars/events/${eventId}`, { method: "DELETE" });\ncreateContact(input) { return input; }',
    'crew/new.html': "<script>post('/api/highlevel?tool=schedule',{method:'POST'});fetch(`/api/messages?${q}`,{method:'POST'});fetch('/api/highlevel?view=contacts')</script>",
  });
  try {
    const found = scanSendPaths(root);
    assert.deepEqual(found, {
      'crew/new.html': { hub_send_endpoint_call: 3 },
      'egc-platform/packages/new/src/client.ts': { ghl_appointment_write: 1 },
      'egc-platform/services/new/src/sync.ts': { ghl_client_write: 3 },
      'functions/api/attribution.js': { ghl_contact_write: 3, ghl_note_task_write: 3 },
    }, 'a contact search (/contacts/?...) and a method definition are not send paths');
    const drift = inventoryDrift(AUTOMATION_REGISTRY, { inventory: found, tags: {}, lifecycle: {} });
    for (const line of ['unregistered send path: functions/api/attribution.js ghl_contact_write x3', 'unregistered send path: functions/api/attribution.js ghl_note_task_write x3',
      'unregistered send path: egc-platform/services/new/src/sync.ts ghl_client_write x3', 'unregistered send path: egc-platform/packages/new/src/client.ts ghl_appointment_write x1', 'unregistered send path: crew/new.html hub_send_endpoint_call x3'])
      assert.ok(drift.some(item => item.startsWith(line)), `${line}\n${drift.join('\n')}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('one added, removed or changed send path in the real tree fails with exactly one precise line', () => {
  const variant = mutate => { const copy = structuredClone(scan); mutate(copy); return inventoryDrift(AUTOMATION_REGISTRY, copy); };
  assert.deepEqual(variant(copy => { copy.inventory['functions/api/quo-send.js'].quo_send = 5; }),
    ['changed send path: functions/api/quo-send.js quo_send found 5, registered 4. Review the new or removed call and update the registry.']);
  assert.deepEqual(variant(copy => { copy.inventory['functions/api/crew-rebook.js'] = { ghl_message_send: 1 }; }),
    ['unregistered send path: functions/api/crew-rebook.js ghl_message_send x1. Classify it in functions/_lib/automation-registry-data.js (codeInventory plus an automation\'s code list).']);
  assert.deepEqual(variant(copy => { delete copy.inventory['functions/api/stripe-webhook.js']; }), ['stale registry entry: functions/api/stripe-webhook.js zapier_hook is no longer in the code.']);
  // GHL-TRACK-1 moved the contact upsert into functions/_lib/highlevel-tags.js, so the booking sync keeps one contact path (the read by id).
  assert.deepEqual(variant(copy => { copy.inventory['functions/api/highlevel.js'].ghl_contact_write += 1; }),
    ['changed send path: functions/api/highlevel.js ghl_contact_write found 2, registered 1. Review the new or removed call and update the registry.'], 'a new contact update by id in the booking sync is caught');
  assert.deepEqual(variant(copy => { copy.inventory['functions/api/highlevel.js'].ghl_tag_helper_call += 1; }),
    ['changed send path: functions/api/highlevel.js ghl_tag_helper_call found 6, registered 5. Review the new or removed call and update the registry.'], 'a new call to the shared tag writer is caught');
  assert.deepEqual(variant(copy => { copy.tags['functions/_lib/ghl-tag-outbox.js'].push('egc-visit-lost'); }), ['unregistered tag write: functions/_lib/ghl-tag-outbox.js writes egc-visit-lost. Add trigger tag:egc-visit-lost with this Hub write.']);
  // SALES-BOOKING added a read of the lead's notes (GET view=lead), registered as a read in hub.highlevel_reads, so four are registered.
  assert.deepEqual(variant(copy => { copy.inventory['functions/api/highlevel.js'].ghl_note_task_write += 1; }),
    ['changed send path: functions/api/highlevel.js ghl_note_task_write found 5, registered 4. Review the new or removed call and update the registry.']);
  // FUN-13 moved the website lead HighLevel writes from functions/api/web-lead.js to functions/_lib/web-lead-intake.js.
  assert.deepEqual(variant(copy => { copy.tags['functions/_lib/web-lead-intake.js'].push('egc-lead-hot'); }), ['unregistered tag write: functions/_lib/web-lead-intake.js writes egc-lead-hot. Add trigger tag:egc-lead-hot with this Hub write.']);
  assert.deepEqual(variant(copy => { copy.tags['functions/api/highlevel.js'] = copy.tags['functions/api/highlevel.js'].filter(tag => tag !== 'egc-review-ready'); }), ['stale hub write: functions/api/highlevel.js no longer writes egc-review-ready.']);
  assert.deepEqual(variant(copy => { copy.lifecycle['crew-on-the-way'].suppressed = false; }), ['lifecycle event crew-on-the-way: tagWritten must be true.', 'lifecycle event crew-on-the-way: missing trigger tag:egc-crew-on-the-way.']);
  assert.deepEqual(variant(copy => { copy.lifecycle['review-requested'].files.push('crew/job.js'); }), ['lifecycle event review-requested: callers are employee-suite.js, crew/job.js, registered employee-suite.js.']);
  const registry = structuredClone(AUTOMATION_REGISTRY);
  registry.automations.find(entry => entry.msgCoreKind === 'b2b_invite').msgCoreKind = null;
  assert.deepEqual(inventoryDrift(registry, scan), ['unregistered approved-send kind: b2b_invite (functions/_lib/message-policies.js).']);
});

test('the registered Quo scripts are the texts /api/quo-send actually renders', () => {
  // LEGACY-SEND fills [TIME] and [N] from the saved job (and refuses a send it cannot fill), so the job carries both.
  const job = { customer: 'Synthetic Pat Doe', address: '1 Synthetic Way, Fort Collins', total: 450, time: '09:00', crewNeeded: 2 };
  const arrival = renderScript(job, { template: 'arrival' }), confirmation = renderScript(job, { template: 'confirmation' });
  assert.deepEqual(confirmation.missing, []);
  assert.match(arrival.message, /Synthetic — the Easy Garage Cleaning crew is on the way to 1 Synthetic Way/);
  assert.equal(templateMatches(template('quo.prejob_arrival'), arrival.message), true);
  assert.equal(templateMatches(template('quo.prejob_confirmation'), confirmation.message), true);
  assert.equal(templateMatches(template('quo.prejob_arrival'), confirmation.message), false);
});

// Pins the registered customer text to the crew page, whose inline script cannot
// be imported: a wording change must update the registry and its hash.
test('the registered crew review text is the one crew/postjob.html sends', () => {
  const page = readFileSync(join(REPO_ROOT, 'crew/postjob.html'), 'utf8');
  const fixed = template('zapier.crew_review_request').replace(/^Hi \{\{firstName\}\}, /, '').replace(/ \{\{reviewLink\}\}$/, '');
  assert.ok(page.includes(fixed), 'the review text in crew/postjob.html changed; update zapier.crew_review_request');
  assert.match(page, /message:`Hi \$\{name\?name\.split\(" "\)\[0\]:"there"\}, it was great working with you!/);
});

async function inviteFixture(job, run) {
  const env = { HUB_SESSION_SECRET: 'synthetic-automation-registry-secret-000000000000', FIREBASE_API_KEY: 'firebase-test-automation-registry', HIGHLEVEL_API_KEY: 'ghl-test', HIGHLEVEL_LOCATION_ID: 'location-1' };
  let stored = { type: 'job', estimate: { status: 'accepted', amount: 1000 }, highlevelContactId: 'contact-1', ...job }, version = 0, ledger = null, ledgerVersion = 0;
  const messages = [], original = globalThis.fetch;
  const updateTime = () => `2026-09-22T12:00:00.${String(version).padStart(6, '0')}Z`, ledgerTime = () => `2026-09-22T13:00:00.${String(ledgerVersion).padStart(6, '0')}Z`;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname.includes('/portal_invitations/')) {
      if (options.method === 'PATCH') {
        if (ledger ? url.searchParams.get('currentDocument.updateTime') !== ledgerTime() : url.searchParams.get('currentDocument.exists') !== 'false') return new Response('{}', { status: 412 });
        ledger = decodeFirestoreFields(JSON.parse(options.body).fields); ledgerVersion += 1;
      }
      return ledger ? Response.json({ fields: encodeFirestoreFields(ledger), updateTime: ledgerTime() }) : new Response('{}', { status: 404 });
    }
    if (url.hostname === 'firestore.googleapis.com') {
      if (options.method === 'PATCH') {
        if (url.searchParams.get('currentDocument.updateTime') !== updateTime()) return new Response('{}', { status: 412 });
        stored = { ...stored, ...decodeFirestoreFields(JSON.parse(options.body).fields) }; version += 1;
      }
      return Response.json({ name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-1', fields: encodeFirestoreFields(stored), updateTime: updateTime() });
    }
    if (url.hostname !== 'services.leadconnectorhq.com') throw new Error(`unexpected host ${url.hostname}`);
    if (url.pathname === '/contacts/contact-1') return Response.json({ contact: { id: 'contact-1', locationId: 'location-1', phone: '+19705550123', email: 'synthetic@example.invalid', dnd: false } });
    if (url.pathname === '/conversations/messages') { messages.push(JSON.parse(options.body)); return Response.json({ messageId: 'message-1', conversationId: 'conversation-1' }); }
    throw new Error(`unexpected HighLevel path ${url.pathname}`);
  };
  try { await run(env, messages); } finally { globalThis.fetch = original; }
}

test('the registered portal invitation texts are the ones the Hub sends, with and without a saved name', async () => {
  const clock = () => NOW;
  await inviteFixture({ customer: 'Synthetic Pat', phone: '(970) 555-0123', email: 'synthetic@example.invalid' }, async (env, messages) => {
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { now: clock })).status, 'submitted');
    assert.equal(messages[0].type, 'SMS');
    assert.equal(templateMatches(template('hub.portal_invitation'), messages[0].message), true, messages[0].message);
  });
  await inviteFixture({ customer: '', phone: '(970) 555-0123' }, async (env, messages) => {
    await sendAcceptedQuotePortal(env, 'job-1', { now: clock });
    assert.match(messages[0].message, /^Your quote is approved\./);
    assert.equal(templateMatches(template('hub.portal_invitation'), messages[0].message), true);
  });
  await inviteFixture({ customer: 'Synthetic Pat', phone: '', email: 'synthetic@example.invalid' }, async (env, messages) => {
    await sendAcceptedQuotePortal(env, 'job-1', { now: clock });
    const entry = automationById(AUTOMATION_REGISTRY, 'hub.portal_invitation_email');
    assert.equal(messages[0].type, 'Email');
    assert.equal(messages[0].subject, entry.subject);
    assert.equal(templateMatches(entry.templateText, messages[0].html), true, messages[0].html);
  });
});

test('the inventory command checks the registry, never prints a credential and diffs HighLevel read-only', async () => {
  const lines = [], log = line => lines.push(line);
  assert.equal(await main(['--check'], { log }), 0, lines.join('\n'));
  assert.match(lines[0], /^registry 2026-09-29\.1: \d+ automations, \d+ triggers, \d+ files with send paths$/);
  const token = 'synthetic-ghl-token-111111111111111111111111';
  const known = AUTOMATION_REGISTRY.automations.filter(entry => entry.system === 'ghl_workflow' && entry.providerId).map(entry => ({ id: entry.providerId, name: entry.name, status: 'published', updatedAt: '2026-09-01T12:00:00.000Z' }));
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url: String(url), method: options.method }); return Response.json({ workflows: [...known, { id: '11111111-2222-4333-8444-555555555555', name: 'Synthetic unregistered', status: 'published' }] }); };
  lines.length = 0;
  assert.equal(await main(['--ghl'], { log, fetcher, env: { GHL_API_KEY: token, GHL_LOCATION_ID: 'loc-synthetic' } }), 1);
  assert.deepEqual(calls, [{ url: 'https://services.leadconnectorhq.com/workflows/?locationId=loc-synthetic', method: 'GET' }]);
  assert.ok(lines.includes('  ✗ unregistered workflow 11111111-2222-4333-8444-555555555555 "Synthetic unregistered" (published)'), lines.join('\n'));
  assert.doesNotMatch(lines.join('\n'), /synthetic-ghl-token/);
  lines.length = 0;
  assert.equal(await main(['--ghl'], { log, env: {}, fetcher: async () => { throw new Error('must not be called'); } }), 1);
  assert.ok(lines.some(line => line.includes('automation_registry_ghl_not_configured')));
  lines.length = 0;
  assert.equal(await main(['--scan'], { log }), 0);
  assert.deepEqual(JSON.parse(lines[0]).inventory, scan.inventory);
  const drifted = structuredClone(AUTOMATION_REGISTRY);
  drifted.codeInventory['functions/api/quo-send.js'].quo_send = 3;
  lines.length = 0;
  assert.equal(await main([], { log, registry: drifted }), 1);
  assert.ok(lines.some(line => line.includes('changed send path: functions/api/quo-send.js quo_send found 4, registered 3')));
});

test('--write renders the owner document into the given tree', async () => {
  const root = tree({ 'docs/.keep': '' });
  try {
    const lines = [];
    await main(['--write'], { root, log: line => lines.push(line) });
    assert.equal(readFileSync(join(root, DOC), 'utf8'), renderRegistryMarkdown(AUTOMATION_REGISTRY, await registryHash(AUTOMATION_REGISTRY)));
    assert.ok(lines.includes(`wrote ${DOC}`));
    assert.deepEqual(scanSendPaths(root), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});
