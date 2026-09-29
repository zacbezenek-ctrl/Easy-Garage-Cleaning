// GET /api/hub-offline: whether the Employee Hub may install (employee.webmanifest + hub-sw.js) and keep its time-clock
// and chat posts on the device until they are confirmed (employee-offline-queue.js). Exactly "true" turns it on; any other
// value keeps today's Hub, and a Hub page that reads false removes the worker and file cache an earlier setting installed.
// The answer is a feature switch only (no account data), so the page can read it before sign-in completes.
export const hubOfflineEnabled = env => env?.HUB_OFFLINE_ENABLED === 'true';

export function onRequestGet({ env }) {
  return Response.json({ ok: true, enabled: hubOfflineEnabled(env) }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
