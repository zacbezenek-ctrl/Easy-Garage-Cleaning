import { getHubSession } from '../_lib/hub-session.js';
import { requireAdmin } from '../_lib/knock-access.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { errorResponse, forbiddenOrigin, readJson, reply, sameOrigin } from '../_lib/knock-http.js';
import { nativeRecoveryContext, nativeRecoveryQueue, recoverNativeFormClaim } from '../_lib/knock-form-recovery.js';

export function knockRecoveryHandlers({ session = getHubSession, storage = createKnockStore, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      try {
        const admin = requireAdmin(await session(request, env)), params = new URL(request.url).searchParams;
        if ([...params.keys()].some(k => k !== 'houseId') || params.getAll('houseId').length > 1) throw knockFailure('Choose one house.', 400, 'knock_form_invalid');
        return reply(200, { ok: true, ...await (params.has('houseId') ? nativeRecoveryContext(storage(env), admin, params.get('houseId')) : nativeRecoveryQueue(storage(env), admin)) });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      try {
        if (!sameOrigin(request)) throw forbiddenOrigin();
        const admin = requireAdmin(await session(request, env)), body = await readJson(request, 4096);
        if (body.action !== 'release') throw knockFailure('Unknown recovery action.', 400, 'knock_form_invalid');
        return reply(200, { ok: true, ...await recoverNativeFormClaim(storage(env), admin, body, now().toISOString()) });
      } catch (error) { return errorResponse(error); }
    },
  };
}
const handlers = knockRecoveryHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
