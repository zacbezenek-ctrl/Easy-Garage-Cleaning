import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { fieldFailure, fieldFingerprint, fieldId, fieldRequestId, fieldStage } from '../_lib/field-execution.js';
import { createFieldPhotoClient, decodeFieldPhoto, fieldPhotosConfigured, verifyFieldPhotoMetadata } from '../_lib/field-execution-photos.js';
import { FIELD_EXPENSE_KINDS, FIELD_EXPENSE_MAX_CENTS, createFieldExpenseStore, fieldExpenseCapacity, fieldExpenseChange, fieldExpenseListing, fieldExpenseRange, fieldExpenseRecord, fieldExpensesEnabled } from '../_lib/field-expenses.js';

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const mutationOriginAllowed = request => {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
};
const KEYS = {
  create: ['action', 'jobId', 'requestId', 'kind', 'amountCents', 'vendor', 'note', 'receiptDataUrl', 'expectedUser'],
  edit: ['action', 'jobId', 'requestId', 'expenseId', 'expectedRevision', 'kind', 'amountCents', 'vendor', 'note', 'incurredOn', 'reason', 'expectedUser'],
  void: ['action', 'jobId', 'requestId', 'expenseId', 'expectedRevision', 'reason', 'expectedUser'],
};
const MAX_BODY = 9 * 1024 * 1024, MAX_PLAIN_BODY = 16 * 1024;

function errorResponse(error) {
  return reply(error.status || 503, { ok: false, code: error.code || 'FIELD_SERVICE_UNAVAILABLE', error: error.code ? error.message : 'Job-cost services are temporarily unavailable. Your entry has not been confirmed; retry the same entry to check its result.' });
}

async function readInput(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw fieldFailure('Cost entries must use JSON.', 415);
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) throw fieldFailure('This receipt photo is too large. Retake it or choose a smaller image.', 413);
  if (!request.body) throw fieldFailure('The cost entry is empty.');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BODY) { await reader.cancel(); throw fieldFailure('This receipt photo is too large. Retake it or choose a smaller image.', 413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw fieldFailure('The cost entry could not be read.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fieldFailure('Choose a supported cost action.');
  const action = body.action ?? 'create', allowed = typeof action === 'string' && Object.hasOwn(KEYS, action) ? KEYS[action] : null;
  if (!allowed) throw fieldFailure('Choose a supported cost action.');
  if (Object.keys(body).some(key => !allowed.includes(key))) throw fieldFailure('The cost entry contains unsupported information. Refresh and retry.');
  if (!(action === 'create' && typeof body.receiptDataUrl === 'string') && size > MAX_PLAIN_BODY) throw fieldFailure('This cost entry is too large.', 413);
  if (!fieldId(body.jobId) || !fieldRequestId(body.requestId)) throw fieldFailure('A job and unique entry ID are required. Refresh and retry.');
  if (action !== 'create' && (!fieldRequestId(body.expenseId) || typeof body.expectedRevision !== 'string' || !body.expectedRevision || body.expectedRevision.length > 80)) throw fieldFailure('Choose a current cost entry and its version. Refresh and retry.');
  if (body.receiptDataUrl !== undefined && typeof body.receiptDataUrl !== 'string') throw fieldFailure('Choose a JPG, PNG or WebP receipt photo.');
  return { ...body, action };
}

function readParams(url) {
  const params = new URL(url).searchParams, seen = new Set(), out = {};
  for (const [key, value] of params) {
    if (!['jobId', 'expenseId', 'view', 'start', 'end'].includes(key) || seen.has(key)) throw fieldFailure('This job-cost request is not supported.');
    seen.add(key); out[key] = value;
  }
  return out;
}

export function fieldExpenseHandlers({ session = getHubSession, storage = createFieldExpenseStore, photos = createFieldPhotoClient, now = () => new Date() } = {}) {
  async function context(request, env) {
    if (!fieldExpensesEnabled(env)) throw fieldFailure('Job-cost capture is not enabled.', 404, 'FIELD_EXPENSES_DISABLED');
    const user = await session(request, env);
    if (!user) throw fieldFailure('Sign in to the Employee Hub to record job costs.', 401, 'FIELD_AUTH_REQUIRED');
    if (!firebaseServiceAccountConfigured(env)) throw fieldFailure('Secure job storage is not connected. Contact operations.', 503, 'FIELD_STORAGE_UNAVAILABLE');
    return { session: user, manager: hasBusinessAccess(user), access: createJobAssignmentAccess(env, user), store: storage(env) };
  }

  async function authorizedJob(ctx, id) {
    if (!fieldId(id)) throw fieldFailure('Choose a valid job.');
    const job = await ctx.store.readJob(id);
    if (!job || !['job', 'cleanout', 'reorg'].includes(job.type) || job.recordType) throw fieldFailure('This job is unavailable. Open Today for your current assignments.', 404, 'FIELD_JOB_NOT_FOUND');
    if (!ctx.manager && !await ctx.access.assigned(job)) throw fieldFailure('This job is not currently assigned to your account. Open Today for your assignments.', 403, 'FIELD_JOB_NOT_ASSIGNED');
    return job;
  }

  async function listing(ctx, env, job) {
    const rows = await ctx.store.listExpenses(job.id);
    return { ...fieldExpenseListing(job.id, rows, { manager: ctx.manager, user: ctx.session.user }), canRecord: ctx.manager || fieldStage(job) !== 'cancelled', canManage: ctx.manager, receiptsAvailable: fieldPhotosConfigured(env), limits: { maxAmountCents: FIELD_EXPENSE_MAX_CENTS, kinds: FIELD_EXPENSE_KINDS }, timezone: 'America/Denver' };
  }

  const outcome = (alreadyApplied, entry) => ({ alreadyApplied, entryStatus: entry?.status === 'void' ? 'void' : 'recorded' });
  const voided = () => fieldFailure('Operations voided this cost before its receipt was confirmed, so it does not count toward the job. Record it again only if operations asks.', 409, 'FIELD_EXPENSE_VOID');

  async function record(ctx, env, job, input, fingerprint) {
    const id = input.requestId.toLowerCase(), actor = { ...ctx.session, manager: ctx.manager };
    const draft = fieldExpenseRecord(job, actor, input, fingerprint, now().toISOString());
    const picture = input.receiptDataUrl ? decodeFieldPhoto(input.receiptDataUrl) : null;
    // The saved entry is the idempotency record. It is checked before any
    // business gate so a replay after the job closes still reports the result.
    let pending = await ctx.store.readExpense(job.id, id);
    if (pending && pending.fingerprint !== fingerprint) throw fieldFailure('This entry ID was already used for a different cost. Refresh before retrying.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
    if (pending?.state === 'applied') return outcome(true, pending);
    if (pending?.status === 'void') throw voided();
    if (!pending && await ctx.store.readRequest(job.id, id)) throw fieldFailure('This entry ID was already used for a cost correction. Refresh before retrying.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
    if (!ctx.manager && fieldStage(job) === 'cancelled') throw fieldFailure('This job is cancelled. Ask operations before recording costs.', 409, 'FIELD_JOB_CLOSED');
    if (!pending) fieldExpenseCapacity(await ctx.store.listExpenses(job.id), { manager: ctx.manager, user: ctx.session.user, receipt: Boolean(picture) });
    if (!picture) { await ctx.store.create(job.id, { ...draft, state: 'applied', receipt: null }); return outcome(false); }
    // Receipts follow the job-photo protocol: the Drive ID is stored in a
    // pending entry before bytes are sent, so a lost response cannot duplicate
    // the file, and the amount counts only after the image is verified.
    const client = await photos(env);
    if (!pending) {
      await ctx.store.create(job.id, { ...draft, state: 'pending', receipt: { fileId: await client.allocate(), verified: false } });
      pending = await ctx.store.readExpense(job.id, id);
    }
    const fileId = pending?.receipt?.fileId;
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(fileId || '')) throw fieldFailure('This receipt upload record is incomplete. Contact operations.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
    let metadata = await client.metadata(fileId);
    if (!metadata) { await client.upload(fileId, job.id, id, picture, 'receipt'); metadata = await client.metadata(fileId); }
    verifyFieldPhotoMetadata(metadata, { jobId: job.id, requestId: id, picture });
    // Recheck assignment after the upload and fence the final write against the
    // job revision just authorized, like the job-photo flow: a reassignment or
    // cancellation landing in between aborts the commit and is re-evaluated.
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await authorizedJob(ctx, job.id), current = await ctx.store.readExpense(job.id, id);
      if (!current || current.fingerprint !== fingerprint || current.receipt?.fileId !== fileId) throw fieldFailure('This receipt record changed. Contact operations.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
      if (current.state === 'applied') return outcome(true, current);
      if (current.status === 'void') throw voided();
      if (!ctx.manager && fieldStage(latest) === 'cancelled') throw fieldFailure('The job was cancelled during upload. The cost has not been recorded.', 409, 'FIELD_JOB_CLOSED');
      const verifiedAt = now().toISOString();
      try {
        await ctx.store.update(job.id, current, { state: 'applied', receipt: { fileId, verified: true, mime: picture.mime, bytes: picture.bytes.length, verifiedAt }, updatedAt: verifiedAt }, { jobRevision: latest.__updateTime });
        return outcome(false);
      } catch (error) { if (!['FIELD_REVISION_CONFLICT', 'FIELD_EXPENSE_REVISION_CONFLICT'].includes(error.code) || attempt === 2) throw error; }
    }
  }

  async function change(ctx, job, input, fingerprint) {
    if (!ctx.manager) throw fieldFailure('Only operations managers can correct or void recorded field costs.', 403, 'FIELD_EXPENSE_MANAGER_REQUIRED');
    const requestId = input.requestId.toLowerCase(), expenseId = input.expenseId.toLowerCase();
    // Corrections are idempotent by requestId across every cost on the job: the
    // receipt is written with exists:false in the same commit as the change.
    const prior = await ctx.store.readRequest(job.id, requestId);
    if (prior) { if (prior.fingerprint !== fingerprint) throw fieldFailure('This correction ID was already used for different information. Refresh before retrying.', 409, 'FIELD_IDEMPOTENCY_CONFLICT'); return { alreadyApplied: true }; }
    if (await ctx.store.readExpense(job.id, requestId)) throw fieldFailure('This correction ID was already used to record a cost. Refresh before retrying.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
    const expense = await ctx.store.readExpense(job.id, expenseId);
    if (!expense) throw fieldFailure('This cost entry is not part of the job.', 404, 'FIELD_EXPENSE_NOT_FOUND');
    if (expense.__updateTime !== input.expectedRevision) throw fieldFailure('This cost changed. Refresh to review the latest entry before correcting it.', 409, 'FIELD_EXPENSE_REVISION_CONFLICT');
    const at = now().toISOString();
    await ctx.store.update(job.id, expense, fieldExpenseChange(expense, { ...ctx.session, manager: true }, input, fingerprint, at), { request: { id: requestId, action: input.action, expenseId, fingerprint, actorId: ctx.session.user, at, state: 'applied' } });
    return { alreadyApplied: false };
  }

  async function recovered(ctx, input, fingerprint) {
    if (input.action === 'create') {
      const expense = await ctx.store.readExpense(input.jobId, input.requestId.toLowerCase());
      return expense?.state === 'applied' && expense.fingerprint === fingerprint ? outcome(true, expense) : null;
    }
    const request = await ctx.store.readRequest(input.jobId, input.requestId.toLowerCase());
    return request?.fingerprint === fingerprint ? { alreadyApplied: true } : null;
  }

  return {
    async get({ request, env }) {
      try {
        const ctx = await context(request, env), params = readParams(request.url);
        if (params.start !== undefined || params.end !== undefined) {
          if (params.jobId !== undefined || params.expenseId !== undefined || params.view !== undefined) throw fieldFailure('Request job costs by job or by date range, not both.');
          if (!ctx.manager) throw fieldFailure('Only operations managers can review job costs across jobs.', 403, 'FIELD_EXPENSE_MANAGER_REQUIRED');
          return reply(200, { ok: true, ...await fieldExpenseRange(env, { start: params.start, end: params.end }, { store: ctx.store }), generatedAt: now().toISOString() });
        }
        const job = await authorizedJob(ctx, params.jobId);
        if (params.view === 'receipt') {
          // Receipts are management records; crew see only that one was verified.
          if (!ctx.manager) throw fieldFailure('Receipt images are available to operations managers.', 403, 'FIELD_EXPENSE_RECEIPT_FORBIDDEN');
          if (!fieldRequestId(params.expenseId)) throw fieldFailure('Choose a valid cost entry.');
          const expense = await ctx.store.readExpense(job.id, params.expenseId.toLowerCase());
          if (!expense?.receipt?.verified || !/^[A-Za-z0-9_-]{1,200}$/.test(expense.receipt.fileId || '')) throw fieldFailure('This receipt is not part of the current job record.', 404, 'FIELD_EXPENSE_RECEIPT_NOT_FOUND');
          return await (await photos(env)).image(expense.receipt.fileId);
        }
        if (params.view !== undefined || params.expenseId !== undefined) throw fieldFailure('This job-cost request is not supported.');
        return reply(200, { ok: true, ...await listing(ctx, env, job) });
      } catch (error) { return errorResponse(error); }
    },
    async post({ request, env }) {
      let ctx, input, fingerprint;
      try {
        if (!mutationOriginAllowed(request)) throw fieldFailure('Job costs must be recorded from the Employee Hub.', 403, 'FIELD_ORIGIN_FORBIDDEN');
        ctx = await context(request, env); input = await readInput(request);
        if (input.expectedUser !== undefined && (typeof input.expectedUser !== 'string' || input.expectedUser.toLowerCase() !== ctx.session.user.toLowerCase())) throw fieldFailure('Your signed-in account changed. Sign in again before retrying this cost.', 401, 'FIELD_ACCOUNT_CHANGED');
        const job = await authorizedJob(ctx, input.jobId);
        fingerprint = await fieldFingerprint(ctx.session.user, { ...input, requestId: input.requestId.toLowerCase(), ...(input.expenseId ? { expenseId: input.expenseId.toLowerCase() } : {}) });
        const result = input.action === 'create' ? await record(ctx, env, job, input, fingerprint) : await change(ctx, job, input, fingerprint);
        return reply(200, { ok: true, ...result, ...await listing(ctx, env, job) });
      } catch (error) {
        // A lost commit response is recovered only from the exact saved record.
        if (ctx && input && fingerprint && ['FIELD_STORAGE_UNAVAILABLE', 'FIELD_EXPENSE_CONFLICT', 'FIELD_EXPENSE_REVISION_CONFLICT', 'FIELD_REVISION_CONFLICT'].includes(error.code)) {
          try { const result = await recovered(ctx, input, fingerprint); if (result) return reply(200, { ok: true, ...result, ...await listing(ctx, env, await authorizedJob(ctx, input.jobId)) }); } catch { /* The original actionable error remains. */ }
        }
        return errorResponse(error);
      }
    },
  };
}

const handlers = fieldExpenseHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
