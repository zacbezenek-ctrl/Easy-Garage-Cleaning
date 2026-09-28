import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { sendAcceptedQuotePortal } from '../functions/_lib/portal-invitation.js';
import { verifyCustomerPortalAccessToken } from '../functions/_lib/customer-portal.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';

const env = { HUB_SESSION_SECRET: 'test-portal-invitation', FIREBASE_API_KEY: 'firebase-test-invitation', HIGHLEVEL_API_KEY: 'ghl-test', HIGHLEVEL_LOCATION_ID: 'location-1', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'test', displayName: 'Zac', role: 'owner' }, Crew: { passwordHash: 'test', displayName: 'Crew', role: 'crew' } }) };
const approved = { type: 'job', customer: 'Test Customer', phone: '(970) 555-0123', email: 'test@example.com', estimate: { status: 'accepted', amount: 1000 }, highlevelContactId: 'contact-1', customerPortalInvitationRequestedAt: '2026-09-06T12:00:00Z' };

async function fixture(run, { job = {}, contact = {}, sendStatus = 200, sendThrows = false, sendBody, failMetadata = false, failTags = false, onContact, onClaim } = {}) {
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
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
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
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
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
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
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

test('modified employee and walkthrough scripts parse', () => {
  new Script(readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8'));
  const html = readFileSync(new URL('../crew/gameplan.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/src=|application\/ld\+json/.test(match[1])) new Script(match[2]);
});
