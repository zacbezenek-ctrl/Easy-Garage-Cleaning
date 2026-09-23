/* Keep company read-only users read-only when crossing into the legacy project API. */
export async function enforceBusinessProjectWrite(request, env, dependencies = {}) {
  if (request.method !== 'POST' || !/^\/api\/customer-portal\/?$/.test(new URL(request.url).pathname)) return null;
  try {
    const readSession = dependencies.readSession || (await import('./customer-portal.js')).getCustomerPortalSession;
    const session = await readSession(request, env);
    if (!String(session?.actorId || '').startsWith('biz_')) return null;
    const readContext = dependencies.readContext || (await import('./customer-portal-access.js')).readCustomerPortalContext;
    const current = await readContext(env, session);
    const permissions = current.session.permissions || {};
    if (permissions.decide || permissions.pay || permissions.rebook) return null;
    return denied(403, 'Your business role is read-only. You can view this project but cannot submit changes or messages.');
  } catch (error) {
    return denied(error.status || 503, 'Business project permissions could not be verified. Refresh or contact EGC.');
  }
}
function denied(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
}
