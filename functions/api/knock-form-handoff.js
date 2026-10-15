import { getHubSession } from '../_lib/hub-session.js';
import { createKnockStore, knockFailure } from '../_lib/knock-store.js';
import { ensureRep, requireActive, loadSettings } from '../_lib/knock-access.js';
import { errorResponse, forbiddenOrigin, readJson, reply, sameOrigin, signInRequired } from '../_lib/knock-http.js';
import { loadNativeFormConfig, nativeFormSetup } from '../_lib/knock-form-config.js';
import { nativeFormContext, createNativeFormHandoff, openNativeFormHandoff, discoverNativeFormReceipt } from '../_lib/knock-form-handoff.js';
import { nativeFormReader } from '../_lib/knock-form-provider.js';

export function knockFormHandlers({ session = getHubSession, storage = createKnockStore, now = () => new Date(), reader = nativeFormReader } = {}) {
  async function context(request, env) {
    const viewer = await session(request, env);
    if (!viewer?.user) throw signInRequired();
    const store = storage(env), at = now(), nowIso = at.toISOString();
    const rep = requireActive(await ensureRep(store, viewer, nowIso));
    const [settings, config] = await Promise.all([loadSettings(store), loadNativeFormConfig(store, env, at.getTime())]);
    return { store, rep, settings, config, nowIso };
  }
  return {
    async get({ request, env }) {
      try {
        const { store, rep, settings, config } = await context(request, env);
        const query = new URL(request.url).searchParams;
        if ([...query.keys()].some(key => key !== 'houseId') || query.getAll('houseId').length > 1) throw knockFailure('Choose one house.', 400, 'knock_form_invalid');
        return reply(200, { ok: true, ...(query.has('houseId') ? await nativeFormContext(store, rep, settings, query.get('houseId'), config) : { setup: nativeFormSetup(config) }) });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      try {
        if (!sameOrigin(request)) throw forbiddenOrigin();
        const { store, rep, settings, config, nowIso } = await context(request, env);
        const body = await readJson(request, 4096);
        let result;
        if (body.action === 'create') result = await createNativeFormHandoff(store, rep, settings, body, config, nowIso);
        else if (body.action === 'open') result = await openNativeFormHandoff(store, rep, settings, body, config, nowIso);
        else if (body.action === 'discover') result = await discoverNativeFormReceipt(store, rep, settings, body, config, nowIso, reader(config.integration).discover);
        else throw knockFailure('Unknown native form action.', 400, 'knock_form_invalid');
        return reply(200, { ok: true, ...result });
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = knockFormHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
