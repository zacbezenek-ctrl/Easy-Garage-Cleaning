import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { consumeW19Handoff, w19Enabled } from '../_lib/w19-completion-handoff.js';
import { w19Error, w19ReadBody, w19Reply } from '../_lib/w19-http.js';

/** Native Form Submitted workflow action. The opaque reference is a bounded
 * capability issued only after authenticated lead intent. Public fields are
 * lookup hints; the server reads the exact provider receipt before claiming.
 * No CORS, public GET, provider write or customer message is provided here.
 */
export function w19CompletionGateHandlers({ storage = dispatchStorage, configured = firebaseServiceAccountConfigured, now = () => new Date(), submission, opportunity, lead } = {}) {
  async function post({ request, env }) {
    try {
      if (!w19Enabled(env)) return w19Reply(404, { ok: false, proceed: false, code: 'W19_DISABLED', error: 'Completion confirmation is not enabled.' });
      if (!configured(env)) return w19Reply(503, { ok: false, proceed: false, code: 'W19_STORAGE_UNAVAILABLE', error: 'Secure completion storage is unavailable.' });
      const input = await w19ReadBody(request, ['reference', 'contactId', 'submissionId']);
      return w19Reply(200, await consumeW19Handoff(env, storage(env), input, now().toISOString(), { submission, opportunity, lead, clock: () => now().toISOString() }));
    } catch (error) { return w19Error(error); }
  }
  return { post };
}
const handlers = w19CompletionGateHandlers();
export const onRequestPost = handlers.post;
