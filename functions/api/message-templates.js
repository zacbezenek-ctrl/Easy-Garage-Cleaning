import { getHubSession } from '../_lib/hub-session.js';
import { messagingStorage } from '../_lib/message-send-store.js';
import { isMessagingOwner, listTemplates, mutateTemplate, requireTemplateEditor, templateView } from '../_lib/message-template-store.js';
import { TEMPLATE_VARIABLES, LINK_VARIABLES, SMS_LIMIT } from '../_lib/message-templates.js';
import { messagingFlags } from '../_lib/approved-send.js';
import { MESSAGE_POLICIES } from '../_lib/message-policies.js';

const MAX_BYTES = 64000;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  if (!source) return true; // SameSite=Strict signed cookie remains required.
  try { return new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

function errorResponse(error) {
  if (/^messaging_[a-z_]+$/.test(error?.code || '')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  return reply(503, { ok: false, code: 'messaging_unavailable', error: 'Message templates could not be verified. Keep your draft and retry the same request.' });
}

const automationKinds = kind => Object.values(MESSAGE_POLICIES).filter(policy => policy.template === kind && policy.approvals.includes('owner_automation')).map(policy => policy.kind);

// Dependency injection permits permission and revision tests without
// production cookies, credentials or Firestore.
export function messageTemplateHandlers({ session = getHubSession, storage = messagingStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const viewer = await session(request, env);
        requireTemplateEditor(viewer);
        const templates = (await listTemplates(storage(env))).map(state => ({ ...templateView(state), automatable: automationKinds(state.kind).length > 0 }));
        return reply(200, { ok: true, templates, variables: TEMPLATE_VARIABLES, linkVariables: LINK_VARIABLES, smsLimit: SMS_LIMIT, delivery: messagingFlags(env), viewer: { id: viewer.user, role: viewer.role, canApprove: isMessagingOwner(viewer) } });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return reply(403, { ok: false, code: 'messaging_origin_forbidden', error: 'Open the Employee Hub to change message templates.' });
      try {
        const viewer = await session(request, env);
        requireTemplateEditor(viewer);
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { ok: false, code: 'messaging_json_required', error: 'Template changes must be JSON.' });
        if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return reply(413, { ok: false, code: 'messaging_request_too_large', error: 'The template request is too large.' });
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return reply(413, { ok: false, code: 'messaging_request_too_large', error: 'The template request is too large.' });
        let input; try { input = JSON.parse(raw); } catch { return reply(400, { ok: false, code: 'messaging_json_invalid', error: 'The template request was incomplete. Refresh and try again.' }); }
        return reply(200, await mutateTemplate(storage(env), viewer, input, now().toISOString()));
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = messageTemplateHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
