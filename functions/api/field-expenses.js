import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { fieldCancelled, fieldFailure, fieldFingerprint, fieldId, fieldRequestId, fieldStage, fieldText } from '../_lib/field-execution.js';
import { createFieldPhotoClient, decodeFieldPhoto, fieldPhotosConfigured, verifyFieldPhotoMetadata } from '../_lib/field-execution-photos.js';
import { FIELD_EXPENSE_CLOSEOUT_GROUPS, FIELD_EXPENSE_INCOME_KINDS, FIELD_EXPENSE_KINDS, FIELD_EXPENSE_MAX_CENTS, FIELD_EXPENSE_PAYERS, FIELD_EXPENSE_SHAREABLE_KINDS, FIELD_EXPENSE_SHARE_JOBS, FIELD_EXPENSE_SHARE_WEIGHT_MAX, createFieldExpenseStore, fieldExpenseAttestation, fieldExpenseCapacity, fieldExpenseChange, fieldExpenseCloseout, fieldExpenseCloseoutRequired, fieldExpenseDamagePhotos, fieldExpenseListing, fieldExpenseRange, fieldExpenseRecord, fieldExpenseShareParts, fieldExpenseShareRows, fieldExpensesEnabled, validExpenseDate, validFieldExpenseShare } from '../_lib/field-expenses.js';

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const mutationOriginAllowed = request => {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
};
const KEYS = {
  create: ['action', 'jobId', 'requestId', 'kind', 'amountCents', 'vendor', 'note', 'payer', 'damagePhotoIds', 'shares', 'receiptDataUrl', 'expectedUser'],
  edit: ['action', 'jobId', 'requestId', 'expenseId', 'expectedRevision', 'kind', 'amountCents', 'vendor', 'note', 'incurredOn', 'payer', 'damagePhotoIds', 'reason', 'expectedUser'],
  void: ['action', 'jobId', 'requestId', 'expenseId', 'expectedRevision', 'reason', 'expectedUser'],
  attest: ['action', 'jobId', 'requestId', 'group', 'expectedUser'],
};
const GROUP_LABELS = { material: 'Materials', dump_fee: 'Dump or disposal fees', other_costs: 'Other costs' };
const MAX_BODY = 9 * 1024 * 1024, MAX_PLAIN_BODY = 16 * 1024, SHARE_DAYS = 7;

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
  if (['edit', 'void'].includes(action) && (!fieldRequestId(body.expenseId) || typeof body.expectedRevision !== 'string' || !body.expectedRevision || body.expectedRevision.length > 80)) throw fieldFailure('Choose a current cost entry and its version. Refresh and retry.');
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

  // Another job of a shared load: crew may split only with their own jobs.
  async function sharedJob(ctx, id) {
    try { return await authorizedJob(ctx, id); }
    catch (error) { if (['FIELD_JOB_NOT_FOUND', 'FIELD_JOB_NOT_ASSIGNED'].includes(error.code)) throw fieldFailure('Every job in a shared load must be a current job assigned to you. Refresh the job list and choose again.', error.status, 'FIELD_EXPENSE_SHARE_JOB_UNAVAILABLE'); throw error; }
  }

  // The other rows of a shared load, read under their own jobs. authorize
  // re-checks each job and returns its latest revision for the write fence.
  // salvage (voids only): a damaged share yields the linked rows that can
  // still be verified instead of refusing, so the row can always be voided.
  async function linkedRows(ctx, row, { authorize = false, salvage = false } = {}) {
    if (row.share == null) return [];
    const incomplete = () => fieldFailure('This shared load record is incomplete. Contact the owner before changing it.', 409, 'FIELD_EXPENSE_SHARE_INCOMPLETE');
    const loadId = row.share?.loadId, valid = validFieldExpenseShare(row.share);
    if (!valid && !salvage) throw incomplete();
    if (!fieldRequestId(loadId)) return [];
    const parts = (Array.isArray(row.share.parts) ? row.share.parts : []).filter(part => fieldId(part?.jobId) && fieldRequestId(part.expenseId) && !(part.jobId === row.jobId && part.expenseId === row.id)).slice(0, FIELD_EXPENSE_SHARE_JOBS);
    const found = await Promise.all([...new Map(parts.map(part => [`${part.jobId}/${part.expenseId}`, part])).values()].map(async part => {
      const [job, linked] = await Promise.all([authorize ? sharedJob(ctx, part.jobId) : null, ctx.store.readExpense(part.jobId, part.expenseId)]);
      if (!linked || linked.share?.loadId !== loadId || linked.fingerprint !== row.fingerprint) { if (salvage) return null; throw incomplete(); }
      return { job, row: linked };
    }));
    return found.filter(Boolean);
  }

  const damagePhotoIds = job => fieldExpenseDamagePhotos(job).map(photo => photo.id.toLowerCase());
  async function listing(ctx, env, job) {
    const [rows, attestations] = await Promise.all([ctx.store.listExpenses(job.id), ctx.store.listAttestations(job.id)]);
    return {
      ...fieldExpenseListing(job.id, rows, { manager: ctx.manager, user: ctx.session.user, attestations, closeoutRequired: fieldExpenseCloseoutRequired(env) }),
      canRecord: ctx.manager || !fieldCancelled(job), canManage: ctx.manager, receiptsAvailable: fieldPhotosConfigured(env),
      damagePhotos: fieldExpenseDamagePhotos(job).map(photo => ({ id: photo.id.toLowerCase(), caption: fieldText(photo.caption, 500), createdAt: fieldText(photo.createdAt, 40) })),
      limits: { maxAmountCents: FIELD_EXPENSE_MAX_CENTS, kinds: FIELD_EXPENSE_KINDS, incomeKinds: FIELD_EXPENSE_INCOME_KINDS, payers: FIELD_EXPENSE_PAYERS, shareableKinds: FIELD_EXPENSE_SHAREABLE_KINDS, maxShareJobs: FIELD_EXPENSE_SHARE_JOBS, maxShareWeight: FIELD_EXPENSE_SHARE_WEIGHT_MAX, closeoutGroups: FIELD_EXPENSE_CLOSEOUT_GROUPS },
      timezone: 'America/Denver',
    };
  }

  // This job's days for a shared load: its scheduled span, at most SHARE_DAYS.
  function shareWindow(job) {
    if (!validExpenseDate(job.date)) return null;
    const last = new Date(`${job.date}T12:00:00Z`); last.setUTCDate(last.getUTCDate() + SHARE_DAYS - 1);
    const cap = last.toISOString().slice(0, 10);
    return { start: job.date, end: validExpenseDate(job.endDate) && job.endDate > job.date ? (job.endDate < cap ? job.endDate : cap) : job.date };
  }
  // The listDays rule: the other job is scheduled on one of those days (an
  // overnight job ending at 00:00 on the first day does not count).
  const onShareDays = (other, days) => Boolean(days) && validExpenseDate(other.date) && other.date <= days.end && (other.endDate || other.date) >= days.start && !(other.date < days.start && other.endDate === days.start && /^00:00(?::00)?$/.test(other.endTime || ''));

  // Jobs a shared load can be split with: the viewer's other current jobs on
  // this job's scheduled days (every job on those days for managers).
  async function shareJobs(ctx, job) {
    const days = shareWindow(job), jobs = [];
    if (!days) return [];
    for (const other of await ctx.store.listDays(days.start, days.end)) {
      if (other.id === job.id || fieldCancelled(other) || !ctx.manager && !await ctx.access.assigned(other)) continue;
      jobs.push({ jobId: other.id, customer: fieldText(other.customer, 200), date: fieldText(other.date, 10), time: fieldText(other.time, 8) });
    }
    return jobs.sort((a, b) => `${a.date} ${a.time || '99:99'}`.localeCompare(`${b.date} ${b.time || '99:99'}`) || a.jobId.localeCompare(b.jobId)).slice(0, 50);
  }

  const outcome = (alreadyApplied, entry) => ({ alreadyApplied, entryStatus: entry?.status === 'void' ? 'void' : 'recorded' });
  const voided = () => fieldFailure('Operations voided this cost before its receipt was confirmed, so it does not count toward the job. Record it again only if operations asks.', 409, 'FIELD_EXPENSE_VOID');
  const closedDuringShare = () => fieldFailure('One of the jobs sharing this cost is cancelled or was a no-show. Ask operations before recording it.', 409, 'FIELD_JOB_CLOSED');

  async function record(ctx, env, job, input, fingerprint) {
    const id = input.requestId.toLowerCase();
    // The saved entry is the idempotency record. It is read before the entry is
    // checked against the job's current state (its damage photos, the jobs it
    // is shared with) or any business gate, so a replay after the job closes or
    // changes still reports the saved result.
    let pending = await ctx.store.readExpense(job.id, id);
    if (pending && pending.fingerprint !== fingerprint) throw fieldFailure('This entry ID was already used for a different cost. Refresh before retrying.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
    if (pending?.state === 'applied') return outcome(true, pending);
    if (pending?.status === 'void') throw voided();
    if (!pending && await ctx.store.readRequest(job.id, id)) throw fieldFailure('This entry ID was already used for a cost correction. Refresh before retrying.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
    if (!ctx.manager && fieldCancelled(job)) throw fieldFailure('This job is cancelled or was a no-show. Ask operations before recording costs.', 409, 'FIELD_JOB_CLOSED');
    const picture = input.receiptDataUrl ? decodeFieldPhoto(input.receiptDataUrl) : null;
    let client = null;
    if (!pending) {
      const draft = fieldExpenseRecord(job, { ...ctx.session, manager: ctx.manager }, input, fingerprint, now().toISOString());
      const parts = input.shares === undefined ? null : fieldExpenseShareParts(job.id, draft.kind, draft.amountCents, input.shares);
      // A shared load writes one row per job in one commit, so each job must be
      // open to this person and have room for its row; crew split only with
      // jobs on this job's days, the ones the share picker offers.
      const others = parts ? await Promise.all(parts.slice(1).map(part => sharedJob(ctx, part.jobId))) : [];
      const days = shareWindow(job);
      if (!ctx.manager && others.some(other => !onShareDays(other, days))) throw fieldFailure('Crew can split a shared load only with their other jobs on this job’s days. Refresh the job list and choose again.', 403, 'FIELD_EXPENSE_SHARE_JOB_UNAVAILABLE');
      if (!ctx.manager && others.some(other => fieldCancelled(other))) throw closedDuringShare();
      const rows = parts ? fieldExpenseShareRows(draft, parts, [job, ...others]) : [draft];
      for (const row of rows) fieldExpenseCapacity(await ctx.store.listExpenses(row.jobId), { manager: ctx.manager, user: ctx.session.user, receipt: Boolean(picture) && row.id === id });
      if (!picture) { await ctx.store.createMany(rows.map(row => ({ ...row, state: 'applied', receipt: null }))); return outcome(false); }
      // Receipts follow the job-photo protocol: the Drive ID is stored in a
      // pending entry before bytes are sent, so a lost response cannot duplicate
      // the file, and the amount counts only after the image is verified. The
      // receipt belongs to the recording job's row; a shared load's other rows
      // stay pending with it and are applied in the same fenced commit.
      client = await photos(env);
      const fileId = await client.allocate();
      await ctx.store.createMany(rows.map(row => ({ ...row, state: 'pending', receipt: row.id === id ? { fileId, verified: false } : null })));
      pending = await ctx.store.readExpense(job.id, id);
    }
    const fileId = pending?.receipt?.fileId;
    if (!picture || !/^[A-Za-z0-9_-]{1,200}$/.test(fileId || '')) throw fieldFailure('This receipt upload record is incomplete. Contact operations.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
    client ||= await photos(env);
    let metadata = await client.metadata(fileId);
    if (!metadata) { await client.upload(fileId, job.id, id, picture, 'receipt'); metadata = await client.metadata(fileId); }
    verifyFieldPhotoMetadata(metadata, { jobId: job.id, requestId: id, picture });
    // Recheck assignment after the upload and fence the final write against the
    // job revisions just authorized, like the job-photo flow: a reassignment or
    // cancellation landing in between aborts the commit and is re-evaluated.
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await authorizedJob(ctx, job.id), current = await ctx.store.readExpense(job.id, id);
      if (!current || current.fingerprint !== fingerprint || current.receipt?.fileId !== fileId) throw fieldFailure('This receipt record changed. Contact operations.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
      if (current.state === 'applied') return outcome(true, current);
      if (current.status === 'void') throw voided();
      if (!ctx.manager && fieldCancelled(latest)) throw fieldFailure('The job was cancelled or marked a no-show during upload. The cost has not been recorded.', 409, 'FIELD_JOB_CLOSED');
      const linked = await linkedRows(ctx, current, { authorize: true });
      if (!ctx.manager && linked.some(item => fieldCancelled(item.job))) throw closedDuringShare();
      const verifiedAt = now().toISOString(), applied = { state: 'applied', updatedAt: verifiedAt };
      try {
        await ctx.store.update(job.id, current, { ...applied, receipt: { fileId, verified: true, mime: picture.mime, bytes: picture.bytes.length, verifiedAt } }, { jobRevision: latest.__updateTime, related: linked.map(item => ({ jobId: item.row.jobId, expense: item.row, patch: applied })), fences: linked.map(item => ({ jobId: item.job.id, revision: item.job.__updateTime })) });
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
    const at = now().toISOString(), actor = { ...ctx.session, manager: true };
    // A correction or void of a shared load applies to every job's row in the
    // same commit; the parts are split again from the corrected load total. A
    // damaged share (only possible through manual data damage) refuses edits,
    // but a void still voids this row and every linked row it can verify.
    const patch = fieldExpenseChange(expense, actor, input, fingerprint, at, { damagePhotos: damagePhotoIds(job) }), related = [];
    let linked;
    try { linked = await linkedRows(ctx, expense); }
    catch (error) { if (input.action !== 'void' || error.code !== 'FIELD_EXPENSE_SHARE_INCOMPLETE') throw error; linked = await linkedRows(ctx, expense, { salvage: true }); }
    for (const { row } of linked) {
      try { related.push({ jobId: row.jobId, expense: row, patch: fieldExpenseChange(row, actor, input, fingerprint, at) }); }
      catch (error) { if (!['FIELD_EXPENSE_NO_CHANGE', 'FIELD_EXPENSE_VOID'].includes(error.code)) throw error; }
    }
    await ctx.store.update(job.id, expense, patch, { request: { id: requestId, action: input.action, expenseId, fingerprint, actorId: ctx.session.user, at, state: 'applied' }, related });
    return { alreadyApplied: false };
  }

  // "None" for one closeout group: one create-only document per kind of the
  // group that has no active entry and no "None" yet, so it confirms only the
  // kinds nobody recorded, and a second "None" (by anyone) is already applied.
  async function attest(ctx, job, input, fingerprint) {
    const requestId = input.requestId.toLowerCase(), group = FIELD_EXPENSE_CLOSEOUT_GROUPS.find(item => item.id === input.group);
    if (!group) throw fieldFailure('Choose materials, dump fees or other costs.', 400, 'FIELD_EXPENSE_CLOSEOUT_GROUP_INVALID');
    const prior = await ctx.store.readRequest(job.id, requestId);
    if (prior) { if (prior.fingerprint !== fingerprint) throw fieldFailure('This entry ID was already used for different information. Refresh before retrying.', 409, 'FIELD_IDEMPOTENCY_CONFLICT'); return { alreadyApplied: true }; }
    if (await ctx.store.readExpense(job.id, requestId)) throw fieldFailure('This entry ID was already used to record a cost. Refresh before retrying.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
    if (!ctx.manager && fieldCancelled(job)) throw fieldFailure('This job is cancelled or was a no-show. Ask operations before changing its costs.', 409, 'FIELD_JOB_CLOSED');
    const at = now().toISOString(), request = { id: requestId, action: 'attest', group: group.id, fingerprint, actorId: ctx.session.user, at, state: 'applied' };
    for (let attempt = 0; ; attempt++) {
      const [rows, attestations] = await Promise.all([ctx.store.listExpenses(job.id), ctx.store.listAttestations(job.id)]), closeout = fieldExpenseCloseout(rows, attestations);
      if (group.kinds.every(kind => closeout.kinds[kind] === 'entered')) throw fieldFailure(`${GROUP_LABELS[group.id]} are already recorded for this job, so “None” does not apply.`, 409, 'FIELD_EXPENSE_CLOSEOUT_ENTERED');
      const open = closeout.groups.find(item => item.id === group.id).openKinds;
      try { await ctx.store.attest(job.id, open.map(kind => fieldExpenseAttestation(kind, ctx.session, requestId, fingerprint, at)), request); return { alreadyApplied: !open.length }; }
      catch (error) { if (error.code !== 'FIELD_EXPENSE_CLOSEOUT_CONFLICT' || attempt === 1) throw error; }
    }
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
        if (params.view === 'share_jobs' && params.expenseId === undefined) return reply(200, { ok: true, jobId: job.id, jobs: await shareJobs(ctx, job), maxJobs: FIELD_EXPENSE_SHARE_JOBS, timezone: 'America/Denver' });
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
        const result = input.action === 'create' ? await record(ctx, env, job, input, fingerprint) : input.action === 'attest' ? await attest(ctx, job, input, fingerprint) : await change(ctx, job, input, fingerprint);
        return reply(200, { ok: true, ...result, ...await listing(ctx, env, job) });
      } catch (error) {
        // A lost commit response is recovered only from the exact saved record.
        if (ctx && input && fingerprint && ['FIELD_STORAGE_UNAVAILABLE', 'FIELD_EXPENSE_CONFLICT', 'FIELD_EXPENSE_REVISION_CONFLICT', 'FIELD_REVISION_CONFLICT', 'FIELD_EXPENSE_CLOSEOUT_CONFLICT'].includes(error.code)) {
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
