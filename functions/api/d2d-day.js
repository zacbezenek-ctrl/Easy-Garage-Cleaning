import { getHubSession } from '../_lib/hub-session.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { createKnockStore } from '../_lib/knock-store.js';
import { canViewD2dDay, d2dBoardEnabled, d2dDayDate, d2dDaySummary, d2dJobReader, loadD2dDay } from '../_lib/d2d-day.js';

// D2D-BOARD: GET /api/d2d-day?date=YYYY-MM-DD, the door-to-door day on the Hub schedule board (functions/_lib/d2d-day.js
// has the contract). Read only: there is no POST. Errors: 404 d2d_day_disabled (EGC_D2D_BOARD=false, before any read),
// 401 d2d_day_sign_in_required, 403 d2d_day_forbidden (no schedule.view), 400 d2d_day_date_invalid, 503
// d2d_day_storage_unavailable (the Knock day could not be read; never a partial day presented as complete).
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });

export function d2dDayHandlers({ session = getHubSession, knockStore = createKnockStore, jobReader = d2dJobReader, configured = firebaseServiceAccountConfigured, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      if (!d2dBoardEnabled(env)) return reply(404, { ok: false, code: 'd2d_day_disabled', error: 'The door-to-door board is turned off.' });
      const actor = await session(request, env);
      if (!actor) return reply(401, { ok: false, code: 'd2d_day_sign_in_required', error: 'Sign in to see the door-to-door day.' });
      if (!canViewD2dDay(actor, env)) return reply(403, { ok: false, code: 'd2d_day_forbidden', error: 'The door-to-door day needs the Team lead or Manager role. Ask the owner.' });
      const at = now();
      let date;
      try { date = d2dDayDate(new URL(request.url).searchParams, at); }
      catch (error) { return reply(error.status || 400, { ok: false, code: error.code || 'd2d_day_date_invalid', error: error.message }); }
      if (!configured(env)) return reply(503, { ok: false, code: 'd2d_day_storage_unavailable', error: 'Secure data access is not configured.' });
      try {
        const records = await loadD2dDay({ store: knockStore(env), jobs: jobReader(env), date });
        return reply(200, d2dDaySummary({ date, ...records, now: at }));
      } catch {
        return reply(503, { ok: false, code: 'd2d_day_storage_unavailable', error: 'The door-to-door day could not be loaded. Retry when connected.' });
      }
    },
  };
}

const handlers = d2dDayHandlers();
export const onRequestGet = handlers.get;
