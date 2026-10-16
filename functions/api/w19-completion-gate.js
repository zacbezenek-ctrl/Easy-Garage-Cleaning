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
      const input = await w19ReadBody(request, ['reference', 'contactId', 'submissionId', 'schemaOnly']);
      if (Object.hasOwn(input, 'schemaOnly')) {
        if (input.schemaOnly !== true || Object.keys(input).length !== 1) return w19Reply(400, { ok: false, proceed: false, code: 'W19_SCHEMA_INVALID', error: 'Schema discovery cannot contain a completion reference or contact.' });
        // Harmless native Custom Webhook schema discovery. It is available
        // before activation and cannot release a task or touch any job.
        return w19Reply(200, { ok: true, proceed: false, schemaOnly: true, status: 'schema_only',
          completion: { verified: false, proceed: false, status: 'schema_only' }, taskStatus: 'not_enabled', financial: { status: 'schema_only' },
          taskMarker: 'schema_only_no_task', jobId: 'schema_only_no_job', contactId: 'schema_only_no_contact', opportunityId: 'schema_only_no_opportunity',
          completedAt: '2000-01-01T19:00:00.000Z', completedDate: '2000-01-01', completionActorId: 'schema_only_no_actor', confirmingLeadId: 'schema_only_no_lead',
          verifiedWorkNotes: 'Schema only. No job, submission, payment or task is confirmed.', hasIssues: false, verifiedIssueNotes: '',
          opportunity: { status: 'schema_only', canUpdate: false, id: 'schema_only_no_opportunity' },
          balance: { approvedTotalCents: 0, confirmedAppliedCents: 0, balanceDueCents: 0, currency: 'USD' } });
      }
      if (!w19Enabled(env)) return w19Reply(404, { ok: false, proceed: false, code: 'W19_DISABLED', error: 'Completion confirmation is not enabled.' });
      if (!configured(env)) return w19Reply(503, { ok: false, proceed: false, code: 'W19_STORAGE_UNAVAILABLE', error: 'Secure completion storage is unavailable.' });
      return w19Reply(200, await consumeW19Handoff(env, storage(env), input, now().toISOString(), { submission, opportunity, lead, clock: () => now().toISOString() }));
    } catch (error) { return w19Error(error); }
  }
  return { post };
}
const handlers = w19CompletionGateHandlers();
export const onRequestPost = handlers.post;
