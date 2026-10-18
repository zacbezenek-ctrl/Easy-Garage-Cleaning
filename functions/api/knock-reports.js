import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { ensureRep, isAdmin, loadSettings, requireActive } from '../_lib/knock-access.js';
import { repSales } from '../_lib/knock-sales.js';
import { refundSummary } from '../_lib/knock-handoff.js';
import { reportViews } from '../_lib/knock-reports.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { knockJobBridgeEnabled, saleJobView } from '../_lib/knock-bridge.js';
import { repWalkthroughs } from '../_lib/knock-walkthroughs.js';
import { csvResponse, errorResponse, reply, signInRequired } from '../_lib/knock-http.js';

// KNOCK-BRIDGE: a sale booked into the Hub shows the rep its booking (hubJob: day, time, crew label, message), never the
// Hub job, customer or crew ids behind it.
function repSale(sale) {
  const job = sale.handoff?.job;
  if (job?.mode !== 'hub') return sale;
  return { ...sale, handoff: { ...sale.handoff, job: { mode: 'hub', status: job.status || 'pending', at: job.at || null } }, hubJob: saleJobView(sale) };
}

/* GET /api/knock-reports?view=...: a rep's own sales, money and stats; leads also see their team's
   scoreboard and admins everyone's. Customer details only appear on the rep's own sales. */
export function knockReportsHandlers({ session = getHubSession, storage = createKnockStore, dispatch = dispatchStorage, now = () => new Date() } = {}) {
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
        const context = { store, rep, settings, admin: isAdmin(viewer), nowMs: at.getTime(), params, env, dispatch };
        if (view === 'my-sales') {
          const sales = await repSales(store, rep.repKey), bridge = knockJobBridgeEnabled(env);
          return reply(200, { ok: true, serverTime: at.toISOString(), sales: sales.map(sale => ({ ...repSale(sale), refund: refundSummary(sale, at.getTime()) })),
            // KNOCK-BRIDGE: the walkthroughs this rep set at the door, with their booking (day, time, estimator's first name).
            ...(bridge ? { walkthroughs: await repWalkthroughs(store, rep.repKey) } : {}) });
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
