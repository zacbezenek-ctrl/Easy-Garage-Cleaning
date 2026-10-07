import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { ensureRep, isAdmin, loadSettings, requireActive } from '../_lib/knock-access.js';
import { repSales } from '../_lib/knock-sales.js';
import { refundSummary } from '../_lib/knock-handoff.js';
import { reportViews } from '../_lib/knock-reports.js';
import { csvResponse, errorResponse, reply, signInRequired } from '../_lib/knock-http.js';

/* GET /api/knock-reports?view=...: a rep's own sales, money and stats; leads also see their team's
   scoreboard and admins everyone's. Customer details only appear on the rep's own sales. */
export function knockReportsHandlers({ session = getHubSession, storage = createKnockStore, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const viewer = await session(request, env);
        if (!viewer?.user) throw signInRequired();
        const store = storage(env);
        const at = now();
        const [rep, settings] = await Promise.all([ensureRep(store, viewer, at.toISOString()), loadSettings(store)]);
        requireActive(rep);
        const params = new URL(request.url).searchParams;
        const view = params.get('view') || '';
        const context = { store, rep, settings, admin: isAdmin(viewer), nowMs: at.getTime(), params };
        if (view === 'my-sales') {
          const sales = await repSales(store, rep.repKey);
          return reply(200, { ok: true, serverTime: at.toISOString(), sales: sales.map(sale => ({ ...sale, refund: refundSummary(sale, at.getTime()) })) });
        }
        const handler = reportViews[view];
        if (!handler) throw knockFailure('Unknown report.', 404, 'knock_unknown_view');
        const result = await handler(context);
        if (result?.csv) return csvResponse(result.filename, result.csv);
        return reply(200, { ok: true, serverTime: at.toISOString(), ...result });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = knockReportsHandlers();
export const onRequestGet = handlers.get;
