import { getHubSession } from '../_lib/hub-session.js';
import { can } from '../_lib/staff-roles.js';
import { canonicalJson } from '../_lib/staff-directory.js';
import { VAULT_MIGRATIONS, runVaultMigration, vaultMigrationStorage } from '../_lib/employee-vault-migrate.js';

// Owner-only. dryRun defaults to true: a dry run reads and reports and writes nothing.
// An applied run records a receipt keyed by requestId; retrying the same request
// returns the saved report, and a different body under that id is refused.
const LIMIT = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const failure = (status, code, error) => reply(status, { ok: false, code: 'employee_vault_migration_' + code, error });
function errorResponse(error) {
  if (error?.code?.startsWith('employee_vault_migration_')) return reply(error.status || 503, { ok: false, code: error.code, error: error.message, ...(error.details ? { details: error.details } : {}) });
  if (/^EMPLOYEE_(HUB|ACCOUNT)_/.test(error?.code || '')) return failure(503, 'unreadable', 'An employee record could not be read safely. Nothing was migrated.');
  return failure(503, 'unavailable', 'The migration could not be verified. Retry the same request; applied records are skipped.');
}
function sameOrigin(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const source = request.headers.get('Origin') || request.headers.get('Referer');
  try { return !source || new URL(source).origin === new URL(request.url).origin; } catch { return false; }
}

export function vaultMigrationHandlers({ session = getHubSession, storage = vaultMigrationStorage, now = () => new Date() } = {}) {
  async function owner(request, env) {
    const actor = await session(request, env);
    if (!actor?.user) return { response: failure(401, 'sign_in_required', 'Sign in as the owner to run employee vault migrations.') };
    if (!can(actor, 'settings.manage', env)) return { response: failure(403, 'forbidden', 'Only the owner can run employee vault migrations.') };
    return { actor };
  }
  return {
    async get({ request, env }) {
      try {
        const { actor, response } = await owner(request, env);
        return response || reply(200, { ok: true, user: actor.user, migrations: Object.values(VAULT_MIGRATIONS).map(({ id, family, description }) => ({ id, family, description })) });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      if (!sameOrigin(request)) return failure(403, 'origin_forbidden', 'Run employee vault migrations from the Employee Hub.');
      try {
        const { actor, response } = await owner(request, env);
        if (response) return response;
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return failure(415, 'json_required', 'Migration requests must use JSON.');
        if (Number(request.headers.get('Content-Length')) > LIMIT) return failure(413, 'request_too_large', 'The migration request is too large.');
        const raw = await request.text();
        if (new TextEncoder().encode(raw).byteLength > LIMIT) return failure(413, 'request_too_large', 'The migration request is too large.');
        let body; try { body = JSON.parse(raw); } catch { return failure(400, 'json_invalid', 'The migration request was incomplete.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['requestId', 'migrationId', 'dryRun'].includes(key))) return failure(400, 'invalid_request', 'Send only requestId, migrationId and dryRun.');
        if (typeof body.requestId !== 'string' || !UUID.test(body.requestId)) return failure(400, 'invalid_request', 'The migration needs a request id.');
        if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return failure(400, 'invalid_request', 'dryRun must be true or false.');
        const migration = Object.hasOwn(VAULT_MIGRATIONS, body.migrationId) ? VAULT_MIGRATIONS[body.migrationId] : null;
        if (!migration) return failure(400, 'unknown', 'Choose a registered employee vault migration.');
        const store = storage(env);
        if (!store.configured()) return failure(503, 'not_configured', 'Employee Hub storage is not configured.');
        if (store.readOnly()) return failure(503, 'read_only', 'Employee setup is being verified. Existing records are preserved and cannot be migrated yet.');
        const dryRun = body.dryRun !== false, at = now().toISOString(), actorId = String(actor.user);
        if (dryRun) return reply(200, { ok: true, report: await runVaultMigration({ store, migration, dryRun: true, now: at, actor: actorId }) });
        const id = body.requestId.toLowerCase(), fingerprint = await store.fingerprint(canonicalJson({ actor: actorId.toLowerCase(), input: body }));
        const existing = await store.readReceipt(id);
        let revision;
        if (existing) {
          if (existing.fingerprint !== fingerprint) return failure(409, 'idempotency_conflict', 'This request id was already used for a different migration request.');
          if (existing.status === 'completed') return reply(200, { ok: true, replayed: true, report: existing.report });
          if (existing.status !== 'failed') return failure(409, 'in_progress', 'This migration request has not finished. Start a new request; records already migrated are skipped.');
          revision = await store.saveReceipt(id, existing.revision, { status: 'running', retriedAt: at });
        } else revision = await store.saveReceipt(id, '', { kind: 'employee_vault_migration_receipt_v1', migrationId: migration.id, actor: actorId, fingerprint, status: 'running', createdAt: at });
        let report;
        try { report = await runVaultMigration({ store, migration, dryRun: false, now: at, actor: actorId, requestId: id }); }
        catch (error) {
          await store.saveReceipt(id, revision, { status: 'failed', errorCode: String(error?.code || 'unknown').slice(0, 80), completedAt: now().toISOString() }).catch(() => null);
          throw error;
        }
        let receiptRecorded = true;
        try { await store.saveReceipt(id, revision, { status: 'completed', report, completedAt: now().toISOString() }); } catch { receiptRecorded = false; }
        return reply(200, { ok: true, report, receiptRecorded });
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = vaultMigrationHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
