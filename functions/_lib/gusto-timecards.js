// Gusto API 2026-06-15 Time Tracking schemas:
// https://docs.gusto.com/app-integrations/reference/post-companies-company_uuid-time_tracking-time_sheets
// https://docs.gusto.com/app-integrations/reference/put-time_tracking-time_sheets-time_sheet_uuid
// A successful sheet write makes hours available in Gusto; it does not run payroll.
const ZONE = 'America/Denver';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const normalized = value => String(value || '').trim().toLowerCase();
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const rounded = value => Math.round(value * 1000) / 1000;
const classes = [['regular', 'Regular'], ['overtime', 'Overtime'], ['doubleOvertime', 'Double overtime']];
export function gustoTimecardError(message, status = 400) { return Object.assign(new Error(message), { status, publicMessage: message }); }
function id(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 180 || /[\u0000-\u001f]/.test(value)) throw gustoTimecardError('A valid timecard ID is required.');
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
  return Date.parse(value);
}
function localDate(value) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}
export function gustoDateRange(start, end, now = Date.now()) {
  const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!start && !end) { end = localDate(now); start = new Date(Date.parse(end) - 6 * 86400000).toISOString().slice(0, 10); }
  if (!date(start) || !date(end) || start > end || (Date.parse(end) - Date.parse(start)) / 86400000 > 30) throw gustoTimecardError('Choose a valid date range of at most 31 days.');
  return { start, end };
}
export function approvedTimecard(raw) {
  if (!record(raw) || raw.approvalStatus !== 'approved' || !raw.clockOutAt || raw.status === 'active') throw gustoTimecardError('Only approved, completed EGC timecards can sync.');
  const timecardId = id(raw.id), employee = normalized(raw.employee), start = instant(raw.clockInAt), end = instant(raw.clockOutAt);
  if (!employee || employee.length > 180 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 31 * 86400000) throw gustoTimecardError('This approved timecard has invalid shift times or employee details.');
  if (raw.breaks !== undefined && !Array.isArray(raw.breaks)) throw gustoTimecardError('This timecard has invalid breaks.');
  const breaks = (raw.breaks || []).map(item => {
    const from = instant(item?.startAt), to = instant(item?.endAt);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || from < start || to > end) throw gustoTimecardError('Review this timecard’s incomplete or invalid break before syncing.');
    return [from, to];
  }).sort((a, b) => a[0] - b[0]);
  if (breaks.some((item, index) => index && item[0] < breaks[index - 1][1])) throw gustoTimecardError('Review overlapping breaks before syncing.');
  const hours = rounded((end - start - breaks.reduce((sum, [from, to]) => sum + to - from, 0)) / 3600000);
  if (!Number.isFinite(hours) || hours <= 0) throw gustoTimecardError('This timecard must contain positive work hours.');
  return { id: timecardId, employee, employeeName: String(raw.employeeName || raw.employee).slice(0, 180), clockInAt: new Date(start).toISOString(), clockOutAt: new Date(end).toISOString(), hours,
    source: { id: timecardId, employee, start, end, breaks, approvalStatus: raw.approvalStatus, approvedAt: String(raw.approvedAt || ''), approvedBy: normalized(raw.approvedBy), status: String(raw.status || '') } };
}
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const reviewFingerprint = (ctx, card, mapping) => digest({ source: card.source, mapping: mapping ? [mapping.employeeUuid, mapping.jobUuid] : null, company: ctx.scope });
function classification(input, hours) {
  const result = {};
  for (const [key] of classes) {
    const value = input?.[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Math.abs(rounded(value) - value) > 0.0000001) throw gustoTimecardError('Enter nonnegative hours with at most three decimal places for each pay category.');
    result[key] = value;
  }
  if (Math.abs(classes.reduce((sum, [key]) => sum + result[key], 0) - hours) > 0.000001) throw gustoTimecardError('Regular, overtime, and double overtime must total the approved net hours.');
  return result;
}
function safeMapping(value) {
  return record(value) && UUID.test(value.employeeUuid) && UUID.test(value.jobUuid) ? { employeeUuid: value.employeeUuid, jobUuid: value.jobUuid, employeeName: String(value.employeeName || '').slice(0, 180), email: String(value.email || '').slice(0, 254), jobTitle: String(value.jobTitle || '').slice(0, 180) } : null;
}
function samePayload(sheet, payload, companyUuid) {
  if (!sheet || sheet.company_uuid !== companyUuid || sheet.entity_uuid !== payload.entity_uuid || sheet.entity_type !== 'Employee' || sheet.job_uuid !== payload.job_uuid || sheet.time_zone !== ZONE ||
      instant(sheet.shift_started_at) !== instant(payload.shift_started_at) || instant(sheet.shift_ended_at) !== instant(payload.shift_ended_at) ||
      sheet.metadata?.egc_timecard_id !== payload.metadata.egc_timecard_id || sheet.metadata?.egc_content_hash !== payload.metadata.egc_content_hash || !Array.isArray(sheet.entries)) return false;
  const expected = new Map(payload.entries.map(entry => [entry.pay_classification, entry.hours_worked]));
  if (sheet.entries.length !== expected.size) return false;
  const seen = new Set();
  return sheet.entries.every(entry => { const name = entry.pay_classification; if (seen.has(name) || !expected.has(name) || !Number.isFinite(Number(entry.hours_worked)) || Math.abs(Number(entry.hours_worked) - expected.get(name)) > 0.000001) return false; seen.add(name); return true; });
}
function safeMessage(error) { return error?.publicMessage || 'Gusto sync could not finish. Review the connection and retry.'; }

// Explicit dependencies keep payroll writes fully mocked in tests.
export function createGustoTimecardService({ readTimecards, readRecord, writeRecord, configuration, status, request, list, now = () => Date.now() }) {
  function context(env) {
    const config = configuration(env);
    if (!config.configured || !UUID.test(config.companyUuid || '')) throw gustoTimecardError(config.reason || 'Connect Gusto before syncing timecards.', 409);
    return { ...config, scope: `${config.environment}:${config.companyUuid}`, companyPath: `/v1/companies/${config.companyUuid}` };
  }
  const key = (ctx, kind, value = '') => `${ctx.scope}:${kind}${value ? ':' + value : ''}`;
  async function getCard(env, cardId) {
    const matches = (await readTimecards(env)).filter(card => card.id === cardId);
    if (matches.length !== 1) throw gustoTimecardError('The EGC timecard was not found uniquely.', 409);
    const card = approvedTimecard(matches[0]); card.fingerprint = await digest(card.source); return card;
  }
  async function roster(env) {
    const ctx = context(env), employees = await list(env, `${ctx.companyPath}/employees`), seen = new Set();
    return employees.map(employee => {
      if (!UUID.test(employee?.uuid || '') || seen.has(employee.uuid) || (employee.company_uuid && employee.company_uuid !== ctx.companyUuid) || !Array.isArray(employee.jobs)) throw gustoTimecardError('Gusto returned an incomplete employee roster. Retry before mapping.', 502);
      seen.add(employee.uuid); const jobs = new Set();
      return { uuid: employee.uuid, name: [employee.first_name, employee.last_name].filter(Boolean).join(' ').slice(0, 180), email: String(employee.email || '').slice(0, 254), jobs: employee.jobs.map(job => {
        if (!UUID.test(job?.uuid || '') || jobs.has(job.uuid) || (job.employee_uuid && job.employee_uuid !== employee.uuid)) throw gustoTimecardError('Gusto returned an invalid employee job. Retry before mapping.', 502);
        jobs.add(job.uuid); return { uuid: job.uuid, title: String(job.title || 'Job').slice(0, 180) };
      }) };
    });
  }
  async function currentPayload(env, ctx, cardId) {
    const card = await getCard(env, cardId), mappings = await readRecord(env, key(ctx, 'mappings')), saved = await readRecord(env, key(ctx, 'timecard', cardId));
    const mapping = safeMapping(mappings.data?.employees?.[card.employee]);
    if (!mapping) throw gustoTimecardError('Match this EGC employee to their Gusto employee and job first.', 409);
    if (saved.data?.classification?.fingerprint !== await reviewFingerprint(ctx, card, mapping)) throw gustoTimecardError('Review and save the pay categories for the current approved timecard and Gusto employee mapping before syncing.', 409);
    const split = classification(saved.data.classification, card.hours);
    const hash = await digest({ source: card.source, mapping: [mapping.employeeUuid, mapping.jobUuid], split, company: ctx.scope });
    const payload = { entity_uuid: mapping.employeeUuid, entity_type: 'Employee', job_uuid: mapping.jobUuid, time_zone: ZONE, shift_started_at: card.clockInAt, shift_ended_at: card.clockOutAt,
      metadata: { egc_timecard_id: card.id, egc_content_hash: hash }, entries: classes.filter(([name]) => split[name] > 0).map(([name, pay_classification]) => ({ hours_worked: split[name], pay_classification })) };
    return { card, mapping, saved, mappings, hash, payload };
  }
  async function preview(env, start, end) {
    const range = gustoDateRange(start, end, now()), connection = await status(env);
    if (!connection.configured || !connection.connected) return { connection, rows: [], excluded: [] };
    const ctx = context(env), mappings = await readRecord(env, key(ctx, 'mappings')), raw = await readTimecards(env), rows = [], excluded = [], seen = new Set();
    for (const item of raw) {
      if (item.approvalStatus !== 'approved' || !item.clockOutAt || item.status === 'active') continue;
      let card;
      try { card = approvedTimecard(item); } catch (error) { excluded.push({ id: String(item.id || '').slice(0, 180), message: safeMessage(error) }); continue; }
      const date = localDate(card.clockInAt);
      if (date < range.start || date > range.end) continue;
      if (seen.has(card.id)) throw gustoTimecardError('Duplicate EGC timecards need administrator review.', 409);
      seen.add(card.id);
      const saved = await readRecord(env, key(ctx, 'timecard', card.id)), mapping = safeMapping(mappings.data?.employees?.[card.employee]), issues = [];
      const fingerprint = await reviewFingerprint(ctx, card, mapping);
      let split = null;
      if (saved.data?.classification?.fingerprint === fingerprint) { try { split = classification(saved.data.classification, card.hours); } catch { /* Invalid stored categories require fresh review. */ } }
      if (!mapping) issues.push('Match this employee and job in Gusto.');
      if (!split) issues.push('Review and save regular, overtime, and double overtime hours.');
      const transferToken = split && mapping ? await digest({ source: card.source, mapping: [mapping.employeeUuid, mapping.jobUuid], split, company: ctx.scope }) : null;
      let state = saved.data?.sync, sync = { status: 'not_synced' };
      if (state) {
        if (['sending', 'uncertain'].includes(state.status)) sync = { status: 'uncertain', message: 'A previous sync needs reconciliation before another write.' };
        else if (state.status === 'synced') {
          const hash = transferToken;
          sync = { status: hash === state.hash ? 'synced' : 'changed', syncedAt: state.syncedAt, message: hash === state.hash ? 'Available in Gusto for payroll review.' : 'The approved timecard, pay categories, or employee mapping changed.' };
        } else sync = { status: 'error', message: state.message || 'The previous sync did not complete.' };
      }
      const { source, ...visible } = card; rows.push({ ...visible, classification: split, mapping, sync, issues, reviewToken: fingerprint, transferToken });
    }
    return { connection, rows: rows.sort((a, b) => a.clockInAt.localeCompare(b.clockInAt) || a.employee.localeCompare(b.employee)), excluded };
  }
  async function mapEmployee(env, input) {
    const ctx = context(env), username = normalized(input.username);
    if (input.confirmed !== true || !username || username.length > 180 || !UUID.test(input.employeeUuid || '') || !UUID.test(input.jobUuid || '')) throw gustoTimecardError('Confirm the EGC employee’s matching Gusto name, email, and job.');
    if (!(await readTimecards(env)).some(card => normalized(card.employee) === username)) throw gustoTimecardError('Choose an employee with an EGC timecard.');
    const employee = (await roster(env)).find(value => value.uuid === input.employeeUuid), job = employee?.jobs.find(value => value.uuid === input.jobUuid);
    if (!employee || !job) throw gustoTimecardError('The selected job does not belong to this Gusto employee.');
    const mapping = { employeeUuid: employee.uuid, jobUuid: job.uuid, employeeName: employee.name, email: employee.email, jobTitle: job.title };
    const saved = await readRecord(env, key(ctx, 'mappings')), employees = { ...(saved.data?.employees || {}) };
    if (Object.entries(employees).some(([name, item]) => name !== username && item.employeeUuid === mapping.employeeUuid)) throw gustoTimecardError('This Gusto employee is already mapped to another EGC account. Review the existing mapping first.', 409);
    Object.defineProperty(employees, username, { value: mapping, enumerable: true, configurable: true, writable: true });
    await writeRecord(env, key(ctx, 'mappings'), { employees }, saved);
    return { mapping };
  }
  async function classify(env, input) {
    const ctx = context(env), cardId = id(input.timecardId), card = await getCard(env, cardId), split = classification(input, card.hours), saved = await readRecord(env, key(ctx, 'timecard', cardId));
    const mappings = await readRecord(env, key(ctx, 'mappings')), mapping = safeMapping(mappings.data?.employees?.[card.employee]);
    if (!mapping) throw gustoTimecardError('Match this employee and job in Gusto before reviewing pay categories.', 409);
    const fingerprint = await reviewFingerprint(ctx, card, mapping);
    if (typeof input.reviewToken !== 'string' || input.reviewToken !== fingerprint) throw gustoTimecardError('This timecard or Gusto mapping changed since you opened the review. Refresh and review it again.', 409);
    if (saved.data?.sync?.status === 'sending' && saved.data.sync.leaseUntil > now()) throw gustoTimecardError('This timecard is currently syncing. Wait for it to finish.', 409);
    const latestCard = await getCard(env, cardId), latestMappings = await readRecord(env, key(ctx, 'mappings'));
    if (await reviewFingerprint(ctx, latestCard, safeMapping(latestMappings.data?.employees?.[latestCard.employee])) !== fingerprint) throw gustoTimecardError('The timecard or Gusto mapping changed during review. Refresh and classify it again.', 409);
    await writeRecord(env, key(ctx, 'timecard', cardId), { ...(saved.data || {}), classification: { ...split, fingerprint, reviewedAt: new Date(now()).toISOString() } }, saved);
    return { classification: split };
  }
  async function syncOne(env, ctx, cardId, reviewToken) {
    let active, saved, sent = false, rejected = false;
    const ledgerKey = key(ctx, 'timecard', cardId);
    try {
      active = await currentPayload(env, ctx, cardId); saved = active.saved;
      if (reviewToken !== active.hash) throw gustoTimecardError('This timecard, Gusto mapping, or pay categories changed since your sync review. Refresh and review it again.', 409);
      let previous = saved.data?.sync;
      if (previous?.status === 'sending' && previous.leaseUntil > now()) return { id: cardId, status: 'uncertain', message: 'This timecard is already syncing. Refresh after it finishes.' };
      // Verify membership again at send time; stored or browser mappings alone are insufficient.
      const employee = (await roster(env)).find(item => item.uuid === active.mapping.employeeUuid);
      if (!employee?.jobs.some(job => job.uuid === active.mapping.jobUuid)) throw gustoTimecardError('The mapped Gusto employee or job is no longer available.', 409);
      if (['sending', 'uncertain'].includes(previous?.status)) {
        const recoveryPayload = previous.attemptPayload || previous.payload;
        if (!recoveryPayload) throw gustoTimecardError('The previous sync needs manual review in Gusto before retrying.', 409);
        const sheets = await list(env, `${ctx.companyPath}/time_tracking/time_sheets?entity_type=Employee&entity_uuids=${encodeURIComponent(recoveryPayload.entity_uuid)}`);
        const matches = sheets.filter(sheet => sheet.metadata?.egc_timecard_id === cardId);
        const match = matches.length === 1 && matches[0];
        if (!match || !UUID.test(match.uuid || '') || !samePayload(match, recoveryPayload, ctx.companyUuid)) return { id: cardId, status: 'uncertain', message: 'The previous request could not be reconciled. Review this shift in Gusto; no duplicate was sent.' };
        saved = await writeRecord(env, ledgerKey, { ...saved.data, sync: { status: 'synced', uuid: match.uuid, hash: recoveryPayload.metadata.egc_content_hash, payload: recoveryPayload, syncedAt: new Date(now()).toISOString() } }, saved);
        previous = saved.data.sync;
      }
      const unchanged = previous?.status === 'synced' && previous.hash === active.hash;
      let remote = null;
      if (previous?.uuid) {
        if (!UUID.test(previous.uuid) || !record(previous.payload)) throw gustoTimecardError('The previous Gusto time sheet needs manual reconciliation before syncing.', 409);
        if (previous.payload.entity_uuid !== active.payload.entity_uuid || previous.payload.job_uuid !== active.payload.job_uuid) throw gustoTimecardError('This shift was sent to a different Gusto employee or job. Reconcile it manually in Gusto before changing its employee or job.', 409);
        try { remote = await request(env, `/v1/time_tracking/time_sheets/${previous.uuid}`); } catch (error) {
          if (error?.status === 404) throw gustoTimecardError('The previously synced time sheet is missing from Gusto. Reconcile it manually before retrying.', 409);
          throw error;
        }
        if (!samePayload(remote, previous.payload, ctx.companyUuid) || !remote.version) throw gustoTimecardError('This Gusto time sheet is missing or changed outside EGC. Reconcile it manually in Gusto before syncing.', 409);
        if (unchanged) return { id: cardId, status: 'synced', message: 'Verified in Gusto; no duplicate was sent.' };
        if (remote.synced_to_payroll_at) throw gustoTimecardError('This shift has already been applied to Gusto payroll. Review the correction in Gusto first.', 409);
      } else {
        // A lost ledger must never silently produce another sheet for the same EGC shift.
        const existing = await list(env, `${ctx.companyPath}/time_tracking/time_sheets?entity_type=Employee&entity_uuids=${encodeURIComponent(active.mapping.employeeUuid)}`);
        if (existing.some(sheet => sheet.metadata?.egc_timecard_id === cardId)) throw gustoTimecardError('Gusto already contains this EGC shift. Review its sync record before retrying.', 409);
      }
      // Acquire a create-only/versioned lease before making an external write.
      const sync = { ...(previous || {}), status: 'sending', leaseUntil: now() + 120000, attemptId: crypto.randomUUID(), attemptPayload: active.payload, message: '' };
      saved = await writeRecord(env, ledgerKey, { ...saved.data, sync }, saved);
      const latest = await currentPayload(env, ctx, cardId);
      if (latest.hash !== active.hash || latest.saved.data?.sync?.attemptId !== sync.attemptId) throw gustoTimecardError('The timecard or its mapping changed before syncing. Refresh and review it again.', 409);
      sent = true;
      let result;
      try {
        result = await request(env, remote ? `/v1/time_tracking/time_sheets/${previous.uuid}` : `${ctx.companyPath}/time_tracking/time_sheets`, { method: remote ? 'PUT' : 'POST', body: remote ? { ...active.payload, version: remote.version } : active.payload });
      } catch (error) {
        // The client marks possible target-write delivery explicitly. Its other errors
        // are preflight failures or explicit API rejections, and can safely retry.
        rejected = typeof error?.code === 'string' && error.code.startsWith('GUSTO_') && error.code !== 'GUSTO_REQUEST_UNCERTAIN';
        throw error;
      }
      if (!UUID.test(result?.uuid || '') || !samePayload(result, active.payload, ctx.companyUuid) || (remote && result.uuid !== previous.uuid)) throw gustoTimecardError('Gusto’s response could not be verified. Reconcile this shift before retrying.', 502);
      saved = await writeRecord(env, ledgerKey, { ...saved.data, sync: { status: 'synced', uuid: result.uuid, hash: active.hash, payload: active.payload, syncedAt: new Date(now()).toISOString() } }, saved);
      return { id: cardId, status: 'synced', message: remote ? 'Corrected time sheet available in Gusto for payroll review.' : 'Time sheet available in Gusto for payroll review.' };
    } catch (error) {
      // Persist uncertainty even when a response is lost or a final storage write fails.
      // A future retry searches remote metadata; absence alone never authorizes another POST.
      const uncertain = sent && !rejected;
      const message = uncertain ? 'The sync outcome is uncertain. Retry to reconcile; no duplicate will be created.' : safeMessage(error);
      if (saved?.data?.sync?.status === 'sending') {
        try { await writeRecord(env, ledgerKey, { ...saved.data, sync: { ...saved.data.sync, status: uncertain ? 'uncertain' : 'error', leaseUntil: 0, message } }, saved); } catch { /* A retained sending lease is itself an uncertainty marker. */ }
      }
      return { id: cardId, status: uncertain ? 'uncertain' : 'error', message };
    }
  }
  async function sync(env, input) {
    const ctx = context(env);
    if (!Array.isArray(input.timecardIds) || !input.timecardIds.length || input.timecardIds.length > 25 || new Set(input.timecardIds).size !== input.timecardIds.length) throw gustoTimecardError('Select between 1 and 25 unique timecards.');
    const ids = input.timecardIds.map(id), results = [];
    if (!record(input.reviewTokens) || ids.some(cardId => typeof input.reviewTokens[cardId] !== 'string' || !/^[a-f0-9]{64}$/.test(input.reviewTokens[cardId]))) throw gustoTimecardError('Refresh the timecards and review each selected transfer before syncing.', 409);
    for (const cardId of ids) results.push(await syncOne(env, ctx, cardId, input.reviewTokens[cardId]));
    return { results };
  }
  return { preview, roster, mapEmployee, classify, sync };
}
