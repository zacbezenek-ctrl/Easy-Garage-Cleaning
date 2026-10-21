import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm, { Script } from 'node:vm';
import { sendAcceptedQuotePortal } from '../functions/_lib/portal-invitation.js';
import { verifyCustomerPortalAccessToken } from '../functions/_lib/customer-portal.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';

const env = { HUB_SESSION_SECRET: 'test-portal-invitation', FIREBASE_API_KEY: 'firebase-test-invitation', HIGHLEVEL_API_KEY: 'ghl-test', HIGHLEVEL_LOCATION_ID: 'location-1', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'test', displayName: 'Zac', role: 'owner' }, Crew: { passwordHash: 'test', displayName: 'Crew', role: 'crew' } }) };
const approved = { type: 'job', customer: 'Test Customer', phone: '(970) 555-0123', email: 'test@example.com', estimate: { status: 'accepted', amount: 1000 }, highlevelContactId: 'contact-1', customerPortalInvitationRequestedAt: '2026-09-06T12:00:00Z' };

// settings: the owner's messaging_settings/automation record (absent: the defaults); settingsDown: that read fails.
async function fixture(run, { job = {}, contact = {}, sendStatus = 200, sendThrows = false, sendBody, failMetadata = false, failTags = false, onContact, onClaim, settings, settingsDown = false } = {}) {
  let stored = { ...structuredClone(approved), ...job }, version = 0, ledger = null, ledgerVersion = 0, jobReadsDown = false;
  const messages = [], upserts = [], allCalls = [];
  const originalFetch = globalThis.fetch;
  const editJob = patch => { stored = { ...stored, ...patch }; version += 1; };
  const jobReads = available => { jobReadsDown = !available; };
  const updateTime = () => `2026-09-06T12:00:00.${String(version).padStart(6, '0')}Z`;
  const document = () => JSON.stringify({ name: 'projects/egcw-1ec83/databases/(default)/documents/jobs/job-1', fields: encodeFirestoreFields(stored), updateTime: updateTime() });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    allCalls.push({ url: url.href, options });
    if (url.pathname.includes('/portal_invitations/')) {
      const time = () => `2026-09-06T13:00:00.${String(ledgerVersion).padStart(6, '0')}Z`;
      if (options.method === 'PATCH') {
        if (ledger ? url.searchParams.get('currentDocument.updateTime') !== time() : url.searchParams.get('currentDocument.exists') !== 'false') return new Response('{}', { status: 412 });
        const next = decodeFirestoreFields(JSON.parse(options.body).fields);
        if ((failMetadata === true ? ['submitted', 'uncertain', 'failed'] : failMetadata || []).includes(next.status)) return new Response('{}', { status: 503 });
        ledger = next; ledgerVersion += 1;
        if (next.status === 'sending') onClaim?.({ editJob, jobReads });
      }
      return ledger ? new Response(JSON.stringify({ fields: encodeFirestoreFields(ledger), updateTime: time() })) : new Response('{}', { status: 404 });
    }
    if (url.pathname.endsWith('/documents/messaging_settings/automation')) {
      if (settingsDown) return new Response('{}', { status: 503 });
      return settings ? new Response(JSON.stringify({ fields: encodeFirestoreFields(settings), updateTime: '2026-09-01T00:00:00.000000Z' })) : new Response('{}', { status: 404 });
    }
    if (url.hostname === 'firestore.googleapis.com') {
      if (jobReadsDown && options.method !== 'PATCH') return new Response('{}', { status: 503 });
      if (options.method === 'PATCH') {
        if (url.searchParams.get('currentDocument.updateTime') !== updateTime()) return new Response('{}', { status: 412 });
        const patch = decodeFirestoreFields(JSON.parse(options.body).fields);
        stored = { ...stored, ...patch }; version += 1;
      }
      return new Response(document());
    }
    if (url.pathname === '/contacts/upsert') {
      upserts.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ contact: { id: 'contact-1' } }));
    }
    if (url.pathname === '/contacts/contact-1') {
      onContact?.(editJob);
      return new Response(JSON.stringify({ contact: { id: 'contact-1', locationId: 'location-1', phone: '+19705550123', email: 'test@example.com', dnd: false, ...contact } }));
    }
    if (url.pathname === '/conversations/messages') {
      messages.push(JSON.parse(options.body));
      if (sendThrows) throw new Error('Connection lost after dispatch');
      return new Response(JSON.stringify(sendBody ?? { messageId: 'message-1', conversationId: 'conversation-1' }), { status: sendStatus });
    }
    if (url.pathname.endsWith('/notes')) return new Response(JSON.stringify({ note: { id: 'note-1' } }));
    if (url.pathname.endsWith('/tags') && failTags) return new Response('{}', { status: 503 });
    if (url.pathname === '/opportunities/search') return new Response(JSON.stringify({ opportunities: [] }));
    return new Response('{}');
  };
  try { await run({ messages, upserts, allCalls, stored: () => stored, ledger: () => ledger, editJob, jobReads }); }
  finally { globalThis.fetch = originalFetch; }
}

test('accepted quote sends a valid private link to the saved contact exactly once', async () => fixture(async ({ messages, stored }) => {
  const first = await sendAcceptedQuotePortal(env, 'job-1');
  assert.equal(first.status, 'submitted');
  assert.equal(messages[0].type, 'SMS');
  assert.equal(messages[0].contactId, 'contact-1');
  assert.equal(messages[0].toNumber, '+19705550123');
  const url = new URL(messages[0].message.match(/https:\/\/\S+/)[0]);
  assert.equal(url.origin, 'https://easygaragecleaning.com');
  const token = url.searchParams.get('access');
  assert.equal((await verifyCustomerPortalAccessToken(env, token)).jobId, 'job-1');
  assert.ok((await verifyCustomerPortalAccessToken(env, token)).expiresAt > Date.now() + 29 * 86400000);
  assert.equal(JSON.stringify(stored()).includes(token), false, 'bearer token must not be stored in a crew-readable job');
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'submitted');
  assert.equal(messages.length, 1);
}));

test('concurrent acceptance requests claim only one delivery', async () => fixture(async ({ messages }) => {
  await Promise.all([sendAcceptedQuotePortal(env, 'job-1'), sendAcceptedQuotePortal(env, 'job-1')]);
  assert.equal(messages.length, 1);
}));

test('email-only customers receive the portal by email', async () => fixture(async ({ messages }) => {
  const state = await sendAcceptedQuotePortal(env, 'job-1');
  assert.equal(state.channel, 'Email');
  assert.equal(messages[0].subject, 'Your Easy Garage Cleaning project portal');
  assert.equal(messages[0].emailTo, 'test@example.com');
  assert.match(messages[0].html, /https:\/\/easygaragecleaning.com\/api\/customer-portal-session/);
}, { job: { phone: '' } }));

test('unapproved, cancelled, and historical jobs do not send from automatic hooks', async () => {
  for (const job of [{ estimate: { status: 'draft' } }, { status: 'cancelled' }, { pipelineStatus: 'cancelled' }, { estimate: { status: 'accepted', amount: 0 } }, { customerPortalInvitationRequestedAt: '' }]) {
    await fixture(async ({ messages }) => {
      await sendAcceptedQuotePortal(env, 'job-1', { requireRequested: true });
      assert.equal(messages.length, 0);
    }, { job });
  }
});

// EGC_QUOTE_BUILDER_ENABLED: a signed job held for the owner's price approval (walkthrough-handoff.js
// pricesPendingApproval) gets no portal link from any sender: the handoff's request, the cron and the Hub's retry.
test('a job held for the owner\'s price approval is never invited, by any sender, and records nothing', async () => {
  const hold = { pricesPendingApproval: { status: 'pending', reason: 'draft_prices', items: [{ id: 'hd-1', name: 'Totes' }] } };
  for (const options of [{ requireRequested: true }, {}]) {
    await fixture(async ({ messages, upserts, ledger }) => {
      assert.deepEqual(await sendAcceptedQuotePortal(env, 'job-1', options), { status: 'not_approved', reason: 'prices_pending_approval' });
      assert.deepEqual([messages.length, upserts.length, ledger()], [0, 0, null]);
    }, { job: hold });
  }
  // Held while HighLevel was being checked: the send stops before any message.
  await fixture(async ({ messages }) => {
    const state = await sendAcceptedQuotePortal(env, 'job-1');
    assert.notEqual(state.status, 'submitted');
    assert.equal(messages.length, 0);
  }, { onContact: editJob => editJob(hold) });
  // Released (null): it sends as any approved quote.
  await fixture(async ({ messages }) => {
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { requireRequested: true })).status, 'submitted');
    assert.equal(messages.length, 1);
  }, { job: { pricesPendingApproval: null } });
});

test('job notifications and HighLevel DND suppress delivery without changing opt-outs', async () => {
  for (const options of [{ job: { notify: false } }, { contact: { dnd: true } }, { contact: { dndSettings: { SMS: { status: 'active' } } } }]) {
    await fixture(async ({ messages, upserts }) => {
      assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'suppressed');
      assert.equal(messages.length, 0); assert.equal(upserts.length, 0);
    }, options);
  }
});

test('incorrect linked recipient or location cannot receive a private project link', async () => {
  for (const contact of [{ phone: '+19705559999' }, { locationId: 'another-location' }]) await fixture(async ({ messages }) => {
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'contact_mismatch');
    assert.equal(messages.length, 0);
  }, { contact });
});

test('missing linked contact resolves from persisted customer details', async () => fixture(async ({ messages, upserts }) => {
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'submitted');
  assert.equal(upserts[0].phone, '+19705550123');
  assert.equal(messages[0].contactId, 'contact-1');
}, { job: { highlevelContactId: '' } }));

test('missing configuration and missing customer details never emit a broken link', async () => {
  await fixture(async ({ messages }) => {
    assert.equal((await sendAcceptedQuotePortal({ ...env, HUB_SESSION_SECRET: '' }, 'job-1')).status, 'not_configured');
    assert.equal((await sendAcceptedQuotePortal({ ...env, FIREBASE_API_KEY: '' }, 'job-1')).status, 'not_configured');
    assert.equal(messages.length, 0);
  });
  await fixture(async ({ messages }) => {
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'needs_contact');
    assert.equal(messages.length, 0);
  }, { job: { phone: '', email: '' } });
});

test('definite provider rejection is retryable while ambiguous delivery never auto-resends', async () => {
  await fixture(async ({ messages, stored }) => {
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'failed');
    await sendAcceptedQuotePortal(env, 'job-1');
    assert.equal(messages.length, 2); assert.equal(stored().customerPortalInvitation.attempts, 2);
  }, { sendStatus: 422 });
  for (const options of [{ sendStatus: 500 }, { sendThrows: true }, { sendBody: {} }, { failMetadata: true }]) await fixture(async ({ messages }) => {
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'uncertain');
    await sendAcceptedQuotePortal(env, 'job-1');
    assert.equal(messages.length, 1);
  }, options);
});

test('a new recurring job cannot inherit the prior job invitation suppression', async () => fixture(async ({ messages }) => {
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'submitted');
  assert.equal(messages.length, 1);
}, { job: { customerPortalInvitation: { jobId: 'old-job', status: 'submitted' } } }));

test('a stale scheduling edit cannot erase authoritative duplicate protection', async () => fixture(async ({ messages, editJob }) => {
  await sendAcceptedQuotePortal(env, 'job-1');
  editJob({ customerPortalInvitation: { jobId: 'job-1', status: 'failed' } });
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'submitted');
  assert.equal(messages.length, 1);
}));

test('a manual recheck respects current notifications after a prior suppression', async () => fixture(async ({ messages, editJob }) => {
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'suppressed');
  editJob({ notify: true });
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'submitted');
  assert.equal(messages.length, 1);
}, { job: { notify: false } }));

// B2B-SAFE: a company project is shared through the business hub's member
// roles, so an owner-level homeowner link is never sent for one.
const NOW = '2026-09-22T12:00:00.000Z', clock = () => new Date(NOW);
// NOW is 06:00 in Denver, inside quiet hours; route tests that expect an automatic send run at noon.
const DAY = '2026-09-22T18:00:00.000Z';
const BUSINESS = { businessAccountId: 'a1'.repeat(16), businessPropertyId: 'b2'.repeat(16) };
const highLevelCalls = calls => calls.filter(call => new URL(call.url).hostname === 'services.leadconnectorhq.com');

test('a business-linked approved job records a suppression and never calls HighLevel', async () => {
  for (const requireRequested of [true, false]) await fixture(async ({ allCalls, ledger, stored }) => {
    const state = await sendAcceptedQuotePortal(env, 'job-1', { requireRequested, now: clock });
    assert.deepEqual(state, { jobId: 'job-1', requestedAt: NOW, attemptedAt: NOW, attempts: 1, status: 'suppressed', reason: 'business_account_job' });
    assert.deepEqual(ledger(), state, 'the server-only ledger records it exactly like the other suppressions');
    assert.deepEqual(stored().customerPortalInvitation, state, 'the Hub display copy explains why nothing was sent');
    assert.deepEqual(highLevelCalls(allCalls), [], 'no contact lookup, upsert or message');
    assert.doesNotMatch(JSON.stringify(stored()), /access=/);
  }, { job: BUSINESS });
});

test('staff rechecks of a business-linked job stay suppressed and keep the original request time', async () => fixture(async ({ allCalls, ledger }) => {
  await sendAcceptedQuotePortal(env, 'job-1', { now: clock });
  const later = '2026-09-22T13:00:00.000Z';
  const again = await sendAcceptedQuotePortal(env, 'job-1', { now: () => new Date(later) });
  assert.deepEqual([again.status, again.reason, again.attempts, again.requestedAt, again.attemptedAt], ['suppressed', 'business_account_job', 2, NOW, later]);
  assert.deepEqual(ledger(), again);
  assert.deepEqual(highLevelCalls(allCalls), []);
}, { job: { ...BUSINESS, highlevelContactId: '' } }));

test('the business link wins over notification settings for the recorded reason', async () => fixture(async ({ allCalls }) => {
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { now: clock })).reason, 'business_account_job');
  assert.deepEqual(highLevelCalls(allCalls), []);
}, { job: { ...BUSINESS, notify: false } }));

test('a job linked to a business account while HighLevel is checked is suppressed before any send', async () => {
  let linked = false;
  await fixture(async ({ messages, upserts, ledger }) => {
    const state = await sendAcceptedQuotePortal(env, 'job-1', { requireRequested: true, now: clock });
    assert.equal(linked, true);
    assert.deepEqual([state.status, state.reason], ['suppressed', 'business_account_job']);
    assert.equal(ledger().status, 'suppressed', 'recorded, not left as a retryable busy state');
    assert.equal(ledger().attemptId, undefined, 'no delivery was ever claimed');
    assert.equal(messages.length, 0); assert.equal(upserts.length, 0);
  }, { onContact: editJob => { linked = true; editJob(BUSINESS); } });
});

test('a business link saved after the delivery claim releases it before HighLevel is messaged', async () => {
  let linked = false;
  await fixture(async ({ messages, ledger, stored, editJob }) => {
    const state = await sendAcceptedQuotePortal(env, 'job-1', { requireRequested: true, now: clock });
    assert.equal(linked, true);
    assert.deepEqual(state, { jobId: 'job-1', requestedAt: NOW, attemptedAt: NOW, attempts: 1, status: 'suppressed', reason: 'business_account_job' });
    assert.deepEqual(ledger(), state, 'the claim is released, not left as sending');
    assert.deepEqual(stored().customerPortalInvitation, state);
    assert.equal(messages.length, 0);
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { now: clock })).reason, 'business_account_job', 'a staff recheck stays suppressed');
    editJob({ businessAccountId: '', businessPropertyId: '' });
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { now: clock })).status, 'submitted', 'unlinking restores delivery');
    assert.equal(messages.length, 1);
  }, { onClaim: ({ editJob }) => { if (!linked) { linked = true; editJob(BUSINESS); } } });
});

test('notifications turned off after the delivery claim suppress the message', async () => {
  let changed = false;
  await fixture(async ({ messages, ledger }) => {
    const state = await sendAcceptedQuotePortal(env, 'job-1', { now: clock });
    assert.deepEqual([state.status, state.reason, ledger().status, ledger().attemptId], ['suppressed', 'job_notifications_off', 'suppressed', undefined]);
    assert.equal(messages.length, 0);
  }, { onClaim: ({ editJob }) => { if (!changed) { changed = true; editJob({ notify: false }); } } });
});

test('a job that cannot be re-read after the claim never sends and stays retryable', async () => {
  let failed = false;
  await fixture(async ({ messages, ledger, jobReads }) => {
    const state = await sendAcceptedQuotePortal(env, 'job-1', { now: clock });
    assert.deepEqual([state.status, ledger().status, ledger().attemptId], ['storage_unavailable', 'storage_unavailable', undefined]);
    assert.equal(messages.length, 0);
    jobReads(true);
    const retried = await sendAcceptedQuotePortal(env, 'job-1', { now: clock });
    assert.deepEqual([retried.status, retried.attempts], ['submitted', 2]);
    assert.equal(messages.length, 1);
  }, { onClaim: ({ jobReads }) => { if (!failed) { failed = true; jobReads(false); } } });
});

test('a release that cannot be saved keeps the claim and still never sends', async () => fixture(async ({ messages, ledger }) => {
  const state = await sendAcceptedQuotePortal(env, 'job-1', { now: clock });
  assert.deepEqual([state.status, ledger().status], ['sending', 'sending'], 'staff see the unfinished claim rather than a false result');
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { now: clock })).status, 'sending', 'an unresolved claim is never retried automatically');
  assert.equal(messages.length, 0);
}, { failMetadata: ['suppressed'], onClaim: ({ editJob }) => editJob(BUSINESS) }));

test('only a non-empty business marker suppresses homeowner delivery', async () => {
  for (const businessAccountId of [42, true, { id: 'synthetic' }, ' a1a1 ']) await fixture(async ({ allCalls }) => {
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { now: clock })).reason, 'business_account_job', JSON.stringify(businessAccountId));
    assert.deepEqual(highLevelCalls(allCalls), []);
  }, { job: { businessAccountId } });
  for (const businessAccountId of ['', '   ', null, false]) await fixture(async ({ messages }) => {
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { now: clock })).status, 'submitted', JSON.stringify(businessAccountId));
    assert.equal(messages.length, 1);
  }, { job: { businessAccountId } });
});

test('unlinking a project restores homeowner delivery exactly once on the next check', async () => fixture(async ({ messages, editJob, ledger }) => {
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { now: clock })).status, 'suppressed');
  editJob({ businessAccountId: '', businessPropertyId: '' });
  const sent = await sendAcceptedQuotePortal(env, 'job-1', { now: clock });
  assert.deepEqual([sent.status, sent.attempts, sent.reason, sent.completedAt], ['submitted', 2, undefined, NOW]);
  assert.equal(ledger().status, 'submitted');
  const token = new URL(messages[0].message.match(/https:\/\/\S+/)[0]).searchParams.get('access');
  assert.equal((await verifyCustomerPortalAccessToken(env, token, Date.parse(NOW))).jobId, 'job-1', 'the link is minted at the injected time');
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { now: clock })).status, 'submitted');
  assert.equal(messages.length, 1);
}, { job: BUSINESS }));

test('Hub retries and lifecycle hooks report the business suppression without messaging', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0], headers = { Cookie: cookie, Origin: 'https://easygaragecleaning.com' };
  const retry = await import('../functions/api/customer-portal-invitation.js'), lifecycle = await import('../functions/api/highlevel.js');
  const calls = [
    () => retry.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/customer-portal-invitation', { method: 'POST', headers, body: JSON.stringify({ job_id: 'job-1' }) }), env }),
    () => lifecycle.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers, body: JSON.stringify({ tool: 'lifecycle', event: 'estimate-approved', job_id: 'job-1', client: { highlevel_contact_id: 'contact-1' } }) }), env }),
  ];
  for (const call of calls) await fixture(async ({ messages, ledger }) => {
    const response = await call();
    assert.equal(response.status, 200);
    const { portalInvitation } = await response.json();
    assert.deepEqual([portalInvitation.status, portalInvitation.reason, portalInvitation.requestedAt, portalInvitation.attemptedAt], ['suppressed', 'business_account_job', NOW, NOW]);
    assert.equal(ledger().reason, 'business_account_job');
    assert.equal(messages.length, 0);
  }, { job: BUSINESS });
});

test('retry endpoint requires business access and ignores submitted recipient and URL overrides', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(DAY) });
  const route = await import('../functions/api/customer-portal-invitation.js');
  const staff = (await createHubSessionCookie(env, 'ZacB')).split(';')[0], crew = (await createHubSessionCookie(env, 'Crew')).split(';')[0];
  await fixture(async ({ messages }) => {
    const request = cookie => new Request('https://easygaragecleaning.com/api/customer-portal-invitation', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com' }, body: JSON.stringify({ job_id: 'job-1', contactId: 'attacker', phone: '+19705559999', url: 'https://example.com' }) });
    assert.equal((await route.onRequestPost({ request: request(''), env })).status, 401);
    assert.equal((await route.onRequestPost({ request: request(crew), env })).status, 403);
    assert.equal((await route.onRequestPost({ request: request(staff), env })).status, 200);
    assert.equal(messages.length, 1); assert.equal(messages[0].contactId, 'contact-1');
  });
});

test('both staff approval and signed walkthrough handoffs automatically request an invitation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(DAY) });
  const route = await import('../functions/api/highlevel.js');
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  for (const payload of [{ tool: 'lifecycle', event: 'estimate-approved' }, { tool: 'game_plan' }]) await fixture(async ({ messages }) => {
    const response = await route.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com' }, body: JSON.stringify({ ...payload, job_id: 'job-1', client: { highlevel_contact_id: 'contact-1' } }) }), env });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).portalInvitation.status, 'submitted');
    assert.equal(messages.length, 1);
  });
});

test('crew cannot trigger quote approval delivery through the lifecycle endpoint', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const route = await import('../functions/api/highlevel.js');
  const cookie = (await createHubSessionCookie(env, 'Crew')).split(';')[0];
  await fixture(async ({ allCalls }) => {
    const response = await route.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ tool: 'lifecycle', event: 'estimate-approved', job_id: 'job-1' }) }), env });
    assert.equal(response.status, 403); assert.equal(allCalls.length, 0);
  });
});

test('downstream HighLevel workflow failure preserves the invitation and retries do not resend', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(DAY) });
  const route = await import('../functions/api/highlevel.js');
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  await fixture(async ({ messages }) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await route.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ tool: 'lifecycle', event: 'estimate-approved', job_id: 'job-1', client: { highlevel_contact_id: 'contact-1' } }) }), env });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).portalInvitation.status, 'submitted');
    }
    assert.equal(messages.length, 1);
  }, { failTags: true });
});

// Automatic sends follow the project's existing quiet-hours rule (message-policies.js QUIET_HOURS, 08:00-20:00 Denver)
// and the owner's messaging pause, like the scheduler. A held invitation is recorded as 'deferred' (not final, no
// attempt spent) and the next automatic retry after notBefore sends it. Only a manager's own Retry click sends anyway.
const LATE = '2026-10-21T05:30:00.000Z'; // 11:30 PM Monday Oct 20 in Denver (MDT)
const MORNING = '2026-10-21T14:01:00.000Z'; // 8:01 AM Tuesday Oct 21 in Denver
const EIGHT_AM = '2026-10-21T14:00:00.000Z';
const hubRequest = (cookie, body, path = 'customer-portal-invitation') => new Request(`https://easygaragecleaning.com/api/${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com' }, body: JSON.stringify(body) });
const ledgerWrites = calls => calls.filter(call => call.options.method === 'PATCH' && call.url.includes('/portal_invitations/')).length;
const automaticCallers = {
  'the Hub page-load retry': (retry, highlevel, cookie) => retry.onRequestPost({ request: hubRequest(cookie, { job_id: 'job-1' }), env }),
  'a recorded approval (estimate-approved)': (retry, highlevel, cookie) => highlevel.onRequestPost({ request: hubRequest(cookie, { tool: 'lifecycle', event: 'estimate-approved', job_id: 'job-1', client: { highlevel_contact_id: 'contact-1' } }, 'highlevel'), env }),
  'a walkthrough handoff sync (game_plan)': (retry, highlevel, cookie) => highlevel.onRequestPost({ request: hubRequest(cookie, { tool: 'game_plan', job_id: 'job-1', client: { highlevel_contact_id: 'contact-1' } }, 'highlevel'), env }),
};

for (const [name, call] of Object.entries(automaticCallers)) {
  test(`${name} at 11:30 PM Denver records a deferred invitation and texts nobody until 8 AM`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(LATE) });
    const retry = await import('../functions/api/customer-portal-invitation.js'), highlevel = await import('../functions/api/highlevel.js');
    const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
    await fixture(async ({ messages, upserts, ledger, stored, allCalls }) => {
      const response = await call(retry, highlevel, cookie);
      assert.equal(response.status, 200);
      const { portalInvitation } = await response.json();
      const deferred = { jobId: 'job-1', requestedAt: LATE, attempts: 0, status: 'deferred', reason: 'quiet_hours', notBefore: EIGHT_AM, deferredAt: LATE };
      assert.deepEqual(portalInvitation, deferred);
      assert.deepEqual(ledger(), deferred, 'the server-only ledger holds a non-final deferral');
      assert.deepEqual(stored().customerPortalInvitation, deferred, 'the Hub display copy says it waits');
      assert.deepEqual([messages.length, upserts.length], [0, 0], 'no text, email or contact write overnight');
      // A second automatic check overnight (another page load) changes nothing and spends no attempt.
      const writes = ledgerWrites(allCalls);
      t.mock.timers.setTime(Date.parse('2026-10-21T07:45:00.000Z'));
      assert.deepEqual((await (await retry.onRequestPost({ request: hubRequest(cookie, { job_id: 'job-1' }), env })).json()).portalInvitation, deferred);
      assert.equal(ledgerWrites(allCalls), writes);
      assert.equal(messages.length, 0);
      // 8:01 AM: the next automatic retry sends exactly once.
      t.mock.timers.setTime(Date.parse(MORNING));
      const sent = (await (await retry.onRequestPost({ request: hubRequest(cookie, { job_id: 'job-1' }), env })).json()).portalInvitation;
      assert.deepEqual([sent.status, sent.attempts, sent.requestedAt, sent.attemptedAt, sent.reason, sent.notBefore], ['submitted', 1, LATE, MORNING, undefined, undefined]);
      assert.equal(messages.length, 1);
      assert.equal((await (await retry.onRequestPost({ request: hubRequest(cookie, { job_id: 'job-1' }), env })).json()).portalInvitation.status, 'submitted');
      assert.equal(messages.length, 1);
    });
  });
}

test('quiet hours end at 8:00 AM and begin at 8:00 PM Denver time', async t => {
  const retry = await import('../functions/api/customer-portal-invitation.js');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T13:59:00.000Z') });
  for (const [at, expected] of [['2026-10-21T13:59:00.000Z', 'deferred'], ['2026-10-21T14:00:00.000Z', 'submitted'], ['2026-10-22T01:59:00.000Z', 'submitted'], ['2026-10-22T02:00:00.000Z', 'deferred']]) {
    t.mock.timers.setTime(Date.parse(at));
    const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
    await fixture(async ({ messages }) => {
      const { portalInvitation } = await (await retry.onRequestPost({ request: hubRequest(cookie, { job_id: 'job-1' }), env })).json();
      assert.equal(portalInvitation.status, expected, at);
      assert.equal(messages.length, expected === 'submitted' ? 1 : 0, at);
      if (expected === 'deferred') assert.equal(portalInvitation.notBefore, at < '2026-10-21T14:00' ? EIGHT_AM : '2026-10-22T14:00:00.000Z', at);
    });
  }
});

test('a manager\'s own Retry click (manual) sends during quiet hours; the page-load retry waits', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(LATE) });
  const retry = await import('../functions/api/customer-portal-invitation.js');
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  await fixture(async ({ messages, ledger }) => {
    assert.equal((await (await retry.onRequestPost({ request: hubRequest(cookie, { job_id: 'job-1', manual: 'true' }), env })).json()).portalInvitation.status, 'deferred', 'only a JSON true counts as a click');
    const sent = (await (await retry.onRequestPost({ request: hubRequest(cookie, { job_id: 'job-1', manual: true }), env })).json()).portalInvitation;
    assert.deepEqual([sent.status, sent.attempts, ledger().status], ['submitted', 1, 'submitted']);
    assert.equal(messages.length, 1);
  });
});

test('the owner\'s messaging pause holds every automatic invitation; a manual retry still sends; unpausing releases it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(DAY) });
  const retry = await import('../functions/api/customer-portal-invitation.js'), highlevel = await import('../functions/api/highlevel.js');
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  for (const [name, call] of Object.entries(automaticCallers)) await fixture(async ({ messages, ledger }) => {
    const { portalInvitation } = await (await call(retry, highlevel, cookie)).json();
    assert.deepEqual(portalInvitation, { jobId: 'job-1', requestedAt: DAY, attempts: 0, status: 'deferred', reason: 'messaging_paused', deferredAt: DAY }, name);
    assert.deepEqual([ledger().status, messages.length], ['deferred', 0], name);
  }, { settings: { paused: true } });
  await fixture(async ({ messages }) => {
    const sent = (await (await retry.onRequestPost({ request: hubRequest(cookie, { job_id: 'job-1', manual: true }), env })).json()).portalInvitation;
    assert.deepEqual([sent.status, messages.length], ['submitted', 1], 'a manager\'s click is not an automatic message');
  }, { settings: { paused: true } });
  // The scheduler passes the settings it already read: a paused record stops the send without another read.
  await fixture(async ({ messages, allCalls }) => {
    const state = await sendAcceptedQuotePortal(env, 'job-1', { requireRequested: true, automatic: true, settings: { paused: true }, now: () => new Date(DAY) });
    assert.deepEqual([state.status, state.reason, messages.length], ['deferred', 'messaging_paused', 0]);
    assert.equal(allCalls.some(call => call.url.includes('/messaging_settings/')), false);
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { requireRequested: true, automatic: true, settings: { paused: false }, now: () => new Date(DAY) })).status, 'submitted', 'unpaused: the next run sends');
    assert.equal(messages.length, 1);
  });
});

test('the scheduler\'s portal retry is automatic: it waits for quiet hours and honours the settings the tick read', async () => {
  const { cronPortalInvite } = await import('../functions/api/messaging-cron.js');
  await fixture(async ({ messages, allCalls }) => {
    const late = await cronPortalInvite(env, () => new Date(LATE))('job-1', new Date(LATE), { paused: false });
    assert.deepEqual([late.status, late.reason, late.notBefore, messages.length], ['deferred', 'quiet_hours', EIGHT_AM, 0]);
    const paused = await cronPortalInvite(env, () => new Date(MORNING))('job-1', new Date(MORNING), { paused: true });
    assert.deepEqual([paused.status, paused.reason, messages.length], ['deferred', 'messaging_paused', 0]);
    assert.equal(allCalls.some(call => call.url.includes('/messaging_settings/')), false, 'the tick\'s settings are reused');
    const sent = await cronPortalInvite(env, () => new Date(MORNING))('job-1', new Date(MORNING), { paused: false });
    assert.deepEqual([sent.status, sent.attempts, sent.attemptedAt, messages.length], ['submitted', 1, MORNING, 1]);
  });
  await fixture(async ({ messages }) => {
    assert.equal((await cronPortalInvite(env, () => new Date(DAY))('job-1', new Date(DAY))).status, 'not_requested', 'only a requested invitation is retried');
    assert.equal(messages.length, 0);
  }, { job: { customerPortalInvitationRequestedAt: '' } });
});

test('unreadable messaging settings hold automatic invitations (fail closed)', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(DAY) });
  const retry = await import('../functions/api/customer-portal-invitation.js');
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  await fixture(async ({ messages, ledger }) => {
    const { portalInvitation } = await (await retry.onRequestPost({ request: hubRequest(cookie, { job_id: 'job-1' }), env })).json();
    assert.deepEqual([portalInvitation.status, portalInvitation.reason, ledger().status, messages.length], ['deferred', 'messaging_settings_invalid', 'deferred', 0]);
  }, { settings: { paused: 'yes' } });
  await fixture(async ({ messages, ledger }) => {
    const { portalInvitation } = await (await retry.onRequestPost({ request: hubRequest(cookie, { job_id: 'job-1' }), env })).json();
    assert.deepEqual([portalInvitation, ledger(), messages.length], [{ status: 'storage_unavailable' }, null, 0], 'an unreachable settings record sends nothing and records nothing');
  }, { settingsDown: true });
});

// message-policies.js closedJob: the stages the project treats as closed. Before, only 'cancelled' and 'superseded' stopped it.
test('a closed job (no-show, canceled, completed, invoiced, paid, closed) is never told its quote is approved', async () => {
  for (const stage of ['no_show', 'noshow', 'no-show', 'canceled', 'cancelled', 'completed', 'invoiced', 'paid', 'review_requested', 'closed', 'superseded', 'COMPLETED']) {
    for (const job of [{ status: stage }, { status: 'scheduled', pipelineStatus: stage }]) {
      for (const options of [{ requireRequested: true, automatic: true, now: () => new Date(DAY) }, { now: () => new Date(DAY) }]) await fixture(async ({ messages, upserts, ledger }) => {
        assert.deepEqual(await sendAcceptedQuotePortal(env, 'job-1', options), { status: 'not_approved', reason: 'job_closed' }, JSON.stringify(job));
        assert.deepEqual([messages.length, upserts.length, ledger()], [0, 0, null]);
      }, { job });
    }
  }
  // A job closed while HighLevel was being checked is not sent either.
  await fixture(async ({ messages }) => {
    assert.notEqual((await sendAcceptedQuotePortal(env, 'job-1', { now: () => new Date(DAY) })).status, 'submitted');
    assert.equal(messages.length, 0);
  }, { onContact: editJob => editJob({ status: 'no_show', pipelineStatus: 'no_show' }) });
  // An open job still sends.
  await fixture(async ({ messages }) => {
    assert.equal((await sendAcceptedQuotePortal(env, 'job-1', { requireRequested: true, automatic: true, now: () => new Date(DAY) })).status, 'submitted');
    assert.equal(messages.length, 1);
  }, { job: { status: 'scheduled', pipelineStatus: 'scheduled' } });
});

test('the Hub waits out a quiet-hours hold, skips closed jobs and marks only a Retry click as manual', async () => {
  const suite = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8'), line = prefix => suite.split(/\r?\n/).find(value => value.startsWith(prefix));
  const now = Date.parse(MORNING), bodies = [];
  const job = (id, extra = {}, state) => ({ id, type: 'job', customerPortalInvitationRequestedAt: LATE, estimate: { status: 'accepted', amount: 900 }, ...extra, ...(state ? { customerPortalInvitation: { jobId: id, ...state } } : {}) });
  const rows = [
    job('open-failed', {}, { status: 'failed', attempts: 1, attemptedAt: LATE }),
    job('held-over', {}, { status: 'deferred', reason: 'quiet_hours', notBefore: EIGHT_AM, attempts: 0, deferredAt: LATE }),
    job('held-later', {}, { status: 'deferred', reason: 'quiet_hours', notBefore: '2026-10-22T14:00:00.000Z', attempts: 0, deferredAt: LATE }),
    job('no-show', { status: 'no_show', pipelineStatus: 'no_show' }, { status: 'failed', attempts: 1, attemptedAt: LATE }),
    job('done', { pipelineStatus: 'completed' }),
  ];
  const context = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    Map, JSON, Number, String, Response, jobsCache: rows, isManager: () => true, render: () => {}, showToast: () => {},
    hubFetch: async (url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({ ok: true, portalInvitation: { status: 'submitted' } })); },
  });
  context.window = context;
  vm.runInContext(['function jobs(){return jobsCache}', ...['const esc=', 'const portalInvitationChecks=', 'function cachePortalInvitation(', 'function portalInvitationState(', 'function portalInvitationLabel(', 'function portalInvitationControl(', 'window.opsRetryPortalInvitation=', 'async function runPortalInvitationRetries('].map(line)].join('\n'), context);
  const [, heldOver, heldLater, noShow, done] = rows;
  assert.equal(context.portalInvitationLabel(heldLater), 'Portal invitation waits for 8 AM (quiet hours)');
  assert.match(context.portalInvitationControl(heldLater), /waits for 8 AM \(quiet hours\)<\/span><button[^>]*>Send portal now</);
  assert.equal(context.portalInvitationLabel(job('paused', {}, { status: 'deferred', reason: 'messaging_paused' })), 'Portal invitation waits · automatic messages paused');
  for (const closed of [noShow, done, job('refused', {}, { status: 'not_approved', reason: 'job_closed' })]) assert.equal(context.portalInvitationLabel(closed), 'Portal not sent · job is closed');
  assert.doesNotMatch(context.portalInvitationControl(noShow), /<button/, 'no Retry for a closed job');
  assert.doesNotMatch(context.portalInvitationControl(done), /<button/);
  assert.doesNotMatch(context.portalInvitationControl(job('refused', {}, { status: 'not_approved', reason: 'job_closed' })), /<button/, 'nor when the server says it closed before this page knew');
  assert.match(context.portalInvitationControl(job('failed', {}, { status: 'failed', attempts: 1 })), /Portal delivery failed<\/span><button[^>]*>Retry portal delivery</);
  await context.runPortalInvitationRetries();
  assert.deepEqual(bodies, [{ job_id: 'open-failed' }, { job_id: 'held-over' }], 'automatic retries carry no manual flag, wait for notBefore and skip closed jobs');
  await context.opsRetryPortalInvitation(heldLater.id);
  assert.deepEqual(bodies.at(-1), { job_id: 'held-later', manual: true });
});

test('modified employee and walkthrough scripts parse', () => {
  new Script(readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8'));
  const html = readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/src=|application\/ld\+json/.test(match[1])) new Script(match[2]);
});
