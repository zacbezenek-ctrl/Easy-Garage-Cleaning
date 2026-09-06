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

async function fixture(run, { job = {}, contact = {}, sendStatus = 200, sendThrows = false, sendBody, failMetadata = false, failTags = false } = {}) {
  let stored = { ...structuredClone(approved), ...job }, version = 0, ledger = null, ledgerVersion = 0;
  const messages = [], upserts = [], allCalls = [];
  const originalFetch = globalThis.fetch;
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
        if (failMetadata && ['submitted', 'uncertain', 'failed'].includes(next.status)) return new Response('{}', { status: 503 });
        ledger = next; ledgerVersion += 1;
      }
      return ledger ? new Response(JSON.stringify({ fields: encodeFirestoreFields(ledger), updateTime: time() })) : new Response('{}', { status: 404 });
    }
    if (url.hostname === 'firestore.googleapis.com') {
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
    if (url.pathname === '/contacts/contact-1') return new Response(JSON.stringify({ contact: { id: 'contact-1', locationId: 'location-1', phone: '+19705550123', email: 'test@example.com', dnd: false, ...contact } }));
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
  try { await run({ messages, upserts, allCalls, stored: () => stored, editJob: patch => { stored = { ...stored, ...patch }; version += 1; } }); }
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

test('retry endpoint requires business access and ignores submitted recipient and URL overrides', async () => {
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

test('both staff approval and signed walkthrough handoffs automatically request an invitation', async () => {
  const route = await import('../functions/api/highlevel.js');
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  for (const payload of [{ tool: 'lifecycle', event: 'estimate-approved' }, { tool: 'game_plan' }]) await fixture(async ({ messages }) => {
    const response = await route.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://easygaragecleaning.com' }, body: JSON.stringify({ ...payload, job_id: 'job-1', client: { highlevel_contact_id: 'contact-1' } }) }), env });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).portalInvitation.status, 'submitted');
    assert.equal(messages.length, 1);
  });
});

test('crew cannot trigger quote approval delivery through the lifecycle endpoint', async () => {
  const route = await import('../functions/api/highlevel.js');
  const cookie = (await createHubSessionCookie(env, 'Crew')).split(';')[0];
  await fixture(async ({ allCalls }) => {
    const response = await route.onRequestPost({ request: new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ tool: 'lifecycle', event: 'estimate-approved', job_id: 'job-1' }) }), env });
    assert.equal(response.status, 403); assert.equal(allCalls.length, 0);
  });
});

test('downstream HighLevel workflow failure preserves the invitation and retries do not resend', async () => {
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
