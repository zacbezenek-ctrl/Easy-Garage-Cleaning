/**
 * GET /api/automation-registry — read-only FUN-30 report for business users:
 * every registered automation and send path with the Hub writes that start it,
 * the monthly attestation state and the go/no-go gates for flag-gated writes.
 * It never sends a message and never changes a live automation.
 */
import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { AUTOMATION_REGISTRY, registryReport } from '../_lib/automation-registry.js';

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export function automationRegistryHandlers({ session = getHubSession, registry = AUTOMATION_REGISTRY, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const viewer = await session(request, env);
        if (!viewer) return reply(401, { ok: false, code: 'automation_registry_sign_in_required', error: 'Sign in to the Employee Hub to view automations.' });
        if (!hasBusinessAccess(viewer)) return reply(403, { ok: false, code: 'automation_registry_forbidden', error: 'Business access is required to view customer automations.' });
        if ([...new URL(request.url).searchParams.keys()].length) return reply(400, { ok: false, code: 'automation_registry_query_invalid', error: 'This report takes no query parameters.' });
        return reply(200, { ok: true, authority: 'employee_hub', ...await registryReport(registry, { now: now() }) });
      } catch {
        return reply(503, { ok: false, code: 'automation_registry_unavailable', error: 'The automation registry could not be read. Retry shortly.' });
      }
    },
  };
}

const handlers = automationRegistryHandlers();
export const onRequestGet = handlers.get;
