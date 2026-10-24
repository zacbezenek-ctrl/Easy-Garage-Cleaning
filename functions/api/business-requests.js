import { createBusinessStore } from '../_lib/business-hub-store.js';
import { staffAllowed, staffCanAccess } from '../_lib/business-hub-core.js';
import { getHubSession } from '../_lib/hub-session.js';

const response = (status, data) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export function businessRequestsHandler({ session = getHubSession, store = createBusinessStore } = {}) {
  return async ({ request, env }) => {
    try {
      const profile = await session(request, env);
      if (!profile) return response(401, { error: 'Sign in to view business requests.' });
      if (!staffAllowed(profile)) return response(403, { error: 'Business account access is required.' });
      const cursor = new URL(request.url).searchParams.get('cursor') || '';
      if (cursor.length > 4096) return response(400, { error: 'Refresh the request queue.' });
      const page = await store(env).list(profile, cursor), rows = [];
      for (const account of page.accounts) {
        if (account.status !== 'active' || !staffCanAccess(profile, account)) continue;
        for (const item of account.requests || []) {
          if (item.jobId || !['submitted', 'reviewing', 'awaiting_customer'].includes(item.status)) continue;
          const property = (account.properties || []).find(p => p.id === item.propertyId);
          if (!property) continue;
          rows.push({ accountId: account.id, company: account.company, requestId: item.id, propertyId: property.id, propertyName: property.name,
            service: item.service, scope: item.scope, preferredDate: item.preferredDate || '', status: item.status, createdAt: item.createdAt || '' });
        }
      }
      rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.requestId.localeCompare(b.requestId));
      return response(200, { ok: true, requests: rows, next: page.next || '', limited: Boolean(page.limited), canConvert: profile.businessAccess === true });
    } catch { return response(503, { error: 'Business requests could not be loaded. Refresh before taking action.' }); }
  };
}
export const onRequestGet = businessRequestsHandler();
