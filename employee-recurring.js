/* Recurring plans. Canonical plans and generated visits live in /api/recurring-plans. */
(function () {
'use strict';
const TZ = 'America/Denver', recoveryPrefix = 'egc.recurring.pending.v1.';
const S = { host:null, root:null, dialog:null, data:null, loading:false, error:'', errorStatus:0, actionError:'', notice:'', noticeKind:'', stale:[], generation:0, busy:false, viewer:null, recovery:null, view:'list', template:null, plan:null, confirm:null, onChange:null };
const FREQUENCIES = [['weekly','Every week'],['biweekly','Every 2 weeks'],['every_n_weeks','Every few weeks'],['monthly','Monthly'],['quarterly','Every 3 months']];
const HORIZONS = [[28,'4 weeks ahead'],[56,'8 weeks ahead'],[84,'12 weeks ahead'],[182,'6 months ahead'],[364,'1 year ahead']];
const STATES = { scheduled:'Scheduled', conflict:'Needs a new time', template:'Original visit', existing:'Existing booking', not_generated:'Not on schedule yet', updating:'Moving to the new plan', cancelled:'Cancelled in Dispatch', missing:'Removed from Dispatch', moved:'Moved', rescheduled:'Rescheduled', completed:'Completed', off_pattern:'No longer in this plan', covered:'Booked separately' };
const KEPT = { started:'it has started', changed_in_dispatch:'it was changed in Dispatch', crew_changed_in_dispatch:'its crew was changed in Dispatch', time_passed:'the new time has passed', visit_closed:'it was cancelled or completed', slot_taken:'the customer already has another booking at the new time' };
const STOPPED = { create:'Visits stopped being added: ', apply:'Booked visits stopped following the plan: ', price:'Visit prices stopped being saved: ' };
const ORDINAL = ['','1st','2nd','3rd','4th'], DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && !key.startsWith('aria-')) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const btn = (label, onClick, kind = '', props = {}) => h('button', { type:'button', class:'rp-btn ' + kind, onclick:onClick, ...props }, label);
const pill = (text, kind = '') => h('span', { class:'rp-pill ' + kind }, text);
const notice = (text, kind = '') => h('div', { class:'rp-notice ' + kind, role:kind === 'error' ? 'alert' : 'status' }, text);
const key = () => crypto.randomUUID();
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone:TZ, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date()); }
function dateText(date, short = true) { return /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? new Intl.DateTimeFormat('en-US', { timeZone:'UTC', weekday:'short', month:'short', day:'numeric', ...(short ? {} : { year:'numeric' }) }).format(new Date(date + 'T12:00:00Z')) : 'Date needed'; }
function clock(value) { const match = /^(\d{2}):(\d{2})$/.exec(value || ''); if (!match) return 'Time needed'; const hour = Number(match[1]); return (hour % 12 || 12) + ':' + match[2] + ' ' + (hour < 12 ? 'AM' : 'PM'); }
const money = cents => new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(cents / 100);
/** '' -> null (no price); '145', '145.5' or '145.50' -> integer cents; anything else -> NaN. */
function priceCents(text) { const value = String(text || '').trim().replace(/^\$/, '').replace(/,/g, ''); if (!value) return null; const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value); if (!match) return NaN; const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')); return cents >= 1 && cents <= 100000000 ? cents : NaN; }
function dayParts(date) { const value = new Date((date || today()) + 'T12:00:00Z'), day = value.getUTCDate(); return { day, weekday:value.getUTCDay(), nth:Math.ceil(day / 7) > 4 ? -1 : Math.ceil(day / 7) }; }
const person = id => S.data?.roster?.find(row => row.id === id)?.name || id;
function stateText(row) {
  if ((row.state === 'moved' || row.state === 'rescheduled') && 'movedTo' in row) return row.movedTo ? STATES[row.state] + ' to ' + dateText(row.movedTo) : 'Unscheduled in Dispatch';
  return STATES[row.state] || row.state;
}
function attentionText(row) {
  const day = dateText(row.date);
  if (row.state === 'cancelled') return day + ' was cancelled in Dispatch, so the customer has no visit that day. Restore it there, or add ' + day + ' as a skipped date.';
  if (row.state === 'missing') return day + ' was removed from Dispatch, so the customer has no visit that day. Book it in Dispatch, or add it as a skipped date.';
  if (row.state === 'moved') return day + ' was taken off the schedule in Dispatch. Choose a new time there.';
  if (row.state === 'off_pattern') return day + ' is still on the schedule but no longer matches this plan. Cancel it in Dispatch unless the customer should keep it.';
  if (row.code === 'recurring_slot_taken') return day + ' is unscheduled in Dispatch because a cancelled or moved booking still holds that time. Restore that booking or choose a new time there.';
  return day + ' conflicted with other work and is unscheduled in Dispatch. Choose a new time there.';
}
function errorText(error) {
  if (error.status === 401) return 'Your sign-in expired. Sign in again, then retry.';
  if (error.status === 403) return 'Recurring plans require an operations manager or owner account.';
  if (/revision/.test(error.code || '')) return 'This plan changed while you were editing. Refresh to load its latest details, then apply your change again.';
  return error.message || 'The request could not be verified. Retry the same request.';
}
async function api(query = '', body = null) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  let response, data;
  try { response = await fetch('/api/recurring-plans' + query, { method:body ? 'POST' : 'GET', credentials:'same-origin', cache:'no-store', headers:body ? { 'Content-Type':'application/json' } : undefined, body:body ? JSON.stringify(body) : undefined, signal:controller.signal }); data = await response.json().catch(() => ({})); }
  catch { throw Object.assign(new Error('The server did not confirm this request. Retry the original request to verify the outcome.'), { status:503, code:'recurring_timeout' }); }
  finally { clearTimeout(timer); }
  if (!response.ok || data.ok !== true) throw Object.assign(new Error(data.error || 'Recurring plans could not be verified. Retry the original request.'), { status:response.ok ? 503 : response.status, code:data.code, details:data.details });
  const invalid = () => Object.assign(new Error('The recurring plan response was incomplete. Retry the original request to verify the outcome.'), { status:503, code:'recurring_response_unverified' });
  if (body) { if (data.requestId !== body.requestId || typeof data.plan?.id !== 'string' || typeof data.plan.revision !== 'string' || !data.plan.revision) throw invalid(); }
  else if (typeof data.enabled !== 'boolean' || !Array.isArray(data.plans) || !Array.isArray(data.roster) || !data.viewer?.id || data.coverage?.complete !== true) throw invalid();
  return data;
}
function restoreRecovery(viewer) {
  S.viewer = viewer; S.recovery = null;
  try {
    const raw = sessionStorage.getItem(recoveryPrefix + viewer); if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved?.viewerId !== viewer || !saved.request || !/^[a-f\d-]{36}$/i.test(saved.request.requestId || '')) throw new Error('invalid');
    S.recovery = saved;
  } catch { S.recovery = { invalid:true }; }
}
function preserve(request, success) {
  if (!S.viewer) throw new Error('Your manager identity has not been verified. Refresh before saving.');
  const saved = { viewerId:S.viewer, request, success, savedAt:new Date().toISOString() };
  try { sessionStorage.setItem(recoveryPrefix + S.viewer, JSON.stringify(saved)); } catch { throw new Error('This browser cannot retain a save receipt. No change was sent. Allow browser storage before saving.'); }
  S.recovery = saved;
}
function clearRecovery() { if (S.viewer) try { sessionStorage.removeItem(recoveryPrefix + S.viewer); } catch {} S.recovery = null; }
/** Sends one request, keeping it for an identical retry until its outcome is known. */
async function send(request, success) {
  preserve(request, success);
  try { const result = await api('', request); clearRecovery(); return result; }
  catch (error) {
    if (error.status >= 400 && error.status < 500 && ![401,403,408,429].includes(error.status)) clearRecovery();
    throw error;
  }
}
async function load({ quiet = false } = {}) {
  if (!S.root || S.busy) return;
  const generation = ++S.generation;
  if (!quiet) { S.loading = true; render(); }
  try {
    const data = await api();
    if (generation !== S.generation || !S.root) return;
    S.data = data; S.error = ''; restoreRecovery(data.viewer.id);
  } catch (error) { if (generation !== S.generation) return; S.error = errorText(error); S.errorStatus = error.status; }
  finally { if (generation === S.generation && S.root) { S.loading = false; render(); } }
}
function changed() { try { S.onChange?.(); } catch {} }
async function extendAll(plan, label) {
  let current = plan, created = 0, updated = 0, kept = [], conflicts = [], blocked = null, complete = false;
  for (let round = 0; round < 15; round++) {
    S.notice = label + ' Adding upcoming visits… ' + created + ' so far.'; render();
    const result = await send({ action:'extend', requestId:key(), planId:current.id, expectedRevision:current.revision, limit:4 }, 'Upcoming visits added.');
    const moved = (result.updated || []).length, settled = Array.isArray(result.kept) ? result.kept : [];
    current = result.plan; created += result.created.filter(job => job.date).length; updated += moved; kept = kept.concat(settled); conflicts = conflicts.concat(result.conflicts || []); blocked = result.blocked; complete = result.complete === true;
    // A round may only move, keep or re-price booked visits; stop once done, blocked, or a round changed nothing.
    if (complete || blocked || !(result.created.length || moved || settled.length || (result.priced || []).length || result.retryable)) break;
  }
  const held = conflicts.filter(row => row.code === 'recurring_slot_taken').length, other = conflicts.length - held, count = (n, verb) => n + ' visit' + (n === 1 ? ' ' : 's ') + verb, unfinished = !complete && !blocked;
  const waiting = unfinished ? ((current.occurrences || []).some(row => row.state === 'updating') ? 'Some booked visits are still being updated to match the plan.' : 'Some visits still need to be added or priced.') + ' Press Add upcoming visits to finish.' : '';
  const keptText = kept.length ? kept.length + ' booked visit' + (kept.length === 1 ? '' : 's') + ' kept ' + (kept.length === 1 ? 'its' : 'their') + ' current time: ' + kept.map(row => dateText(row.date) + ' (' + (KEPT[row.reason] || 'Dispatch refused the change') + ')').join(', ') + '.' : '';
  S.notice = [label, updated ? updated + ' booked visit' + (updated === 1 ? '' : 's') + ' moved to match the plan.' : '', keptText, created ? created + ' visit' + (created === 1 ? '' : 's') + ' added to the schedule.' : unfinished ? '' : 'No new visits were needed inside the scheduling window.', other ? count(other, 'conflicted with other work and ' + (other === 1 ? 'was' : 'were')) + ' saved unscheduled — choose new times in Dispatch.' : '',
    held ? count(held, (held === 1 ? 'was' : 'were')) + ' saved unscheduled because a cancelled or moved booking still holds the time — restore it or choose a new time in Dispatch.' : '', blocked ? 'Stopped: ' + blocked.message : '', waiting].filter(Boolean).join(' ');
  if (conflicts.length || kept.length || blocked || unfinished) S.noticeKind = 'warn';
}
/** Booked visits an update no longer includes stay listed until the manager cancels them. */
function showSaved(label, warnings = []) {
  S.notice = [label, ...warnings.map(row => row.message)].join(' ');
  S.stale = warnings.flatMap(row => row.code === 'generated_visits_off_pattern' && Array.isArray(row.visits) ? row.visits : row.code === 'skip_date_already_scheduled' ? [row] : []).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row?.date || ''));
  S.noticeKind = S.stale.length ? 'warn' : '';
}
async function act(run) {
  if (S.busy) return;
  S.busy = true; S.actionError = ''; S.noticeKind = ''; S.stale = []; render();
  try { await run(); }
  catch (error) { S.actionError = errorText(error); S.errorStatus = error.status; }
  finally { S.busy = false; S.confirm = null; changed(); if (S.root) { S.view = 'list'; S.plan = S.template = null; await load({ quiet:true }); render(); } }
}
function stateChange(plan, action) {
  const labels = { pause:'Plan paused.', resume:'Plan resumed.', end:'Plan ended.' };
  void act(async () => { const result = await send({ action, requestId:key(), planId:plan.id, expectedRevision:plan.revision }, labels[action]); showSaved(labels[action], result.warnings || []); });
}
function retryRecovery() {
  const saved = S.recovery; if (!saved || saved.invalid) return;
  void act(async () => {
    const result = await send(saved.request, saved.success);
    if (saved.request.action === 'create' || saved.request.applyToBooked === true && result.plan.status === 'active' || saved.request.action === 'extend' && !result.complete) await extendAll(result.plan, saved.success);
    else showSaved(saved.success, result.warnings || []);
  });
}
function planCard(plan) {
  const active = plan.status === 'active', ends = plan.count ? 'Ends after ' + plan.count + ' visits' : plan.endsOn ? 'Ends ' + dateText(plan.endsOn, false) : 'No end date';
  const card = h('article', { class:'rp-plan rp-' + plan.status, 'data-plan':plan.id },
    h('div', { class:'rp-plan-top' }, h('h3', {}, plan.customer || 'Customer'), pill(plan.status === 'active' ? 'Active' : plan.status === 'paused' ? 'Paused' : 'Ended', active ? '' : 'muted')),
    h('p', { class:'rp-cadence' }, plan.cadenceLabel + ' · ' + clock(plan.time) + ' – ' + clock(plan.endTime) + (plan.spanDays ? ' (+' + plan.spanDays + ' day)' : '')),
    plan.address ? h('p', { class:'rp-muted' }, plan.address) : null,
    Number.isInteger(plan.pricePerVisitCents) ? h('p', { class:'rp-price' }, money(plan.pricePerVisitCents) + ' per visit') : null,
    h('p', { class:'rp-muted' }, [ends, plan.skipDates.length ? plan.skipDates.length + ' skipped date' + (plan.skipDates.length === 1 ? '' : 's') : '', 'Crew: ' + (plan.assignment?.assignedCrew?.length ? plan.assignment.assignedCrew.map(person).join(', ') : 'Unassigned')].filter(Boolean).join(' · ')));
  if (plan.lastRun?.status === 'blocked' || plan.lastRun?.status === 'error') card.append(h('p', { class:'rp-warning' }, (plan.lastRun.status === 'error' && STOPPED[plan.lastRun.stage] || STOPPED.create) + (plan.lastRun.message || 'review this plan.')));
  for (const row of plan.attention || []) card.append(h('p', { class:'rp-warning' }, attentionText(row)));
  if (plan.upcoming?.length) card.append(h('ul', { class:'rp-upcoming', 'aria-label':'Next visits' }, plan.upcoming.map(row => h('li', {}, h('span', {}, dateText(row.date)), h('small', { class:'rp-state-' + row.state }, stateText(row))))));
  else if (plan.finished) card.append(h('p', { class:'rp-muted' }, 'This series has no more visits.'));
  const actions = h('div', { class:'rp-card-actions' });
  if (S.confirm === plan.id) {
    card.append(notice('End this plan? No more visits will be added. Visits already on the schedule stay there until you cancel them in Dispatch.', 'error'));
    actions.append(btn('Keep plan', () => { S.confirm = null; render(); }), btn('End plan', () => stateChange(plan, 'end'), 'danger'));
  } else if (plan.status !== 'ended') {
    if (active) actions.append(btn('Add upcoming visits', () => act(() => extendAll(plan, 'Plan checked.')), 'primary', { disabled:!S.data?.enabled || S.busy }));
    actions.append(btn('Edit', () => { S.view = 'form'; S.plan = plan; S.template = null; S.notice = S.actionError = S.noticeKind = ''; S.stale = []; render(); }, '', { disabled:!S.data?.enabled || S.busy }),
      btn(active ? 'Pause' : 'Resume', () => stateChange(plan, active ? 'pause' : 'resume'), '', { disabled:S.busy || (!active && !S.data?.enabled) }),
      btn('End', () => { S.confirm = plan.id; render(); }, 'subtle', { disabled:S.busy }));
  }
  if (actions.childElementCount) card.append(actions);
  return card;
}
function labeled(label, control, help) { control.id ||= 'rp-' + key(); return h('div', { class:'rp-field' }, h('label', { htmlFor:control.id }, label), control, help ? h('small', {}, help) : null); }
function select(options, value, props = {}) { return h('select', props, options.map(([id, text]) => h('option', { value:String(id), selected:String(id) === String(value) }, text))); }
function renderForm(body) {
  const plan = S.plan, template = S.template, data = S.data, source = plan || {};
  const assignment = plan ? plan.assignment || {} : { assignedCrew:(template.assignedCrew || []).filter(id => data.roster.some(row => row.id === id)), crewLead:template.crewLead || null, crewId:template.crewId || null, vehicleId:template.vehicleId || null };
  const cadence = source.cadence || { frequency:'weekly' };
  const form = h('form', { class:'rp-form', novalidate:true });
  form.append(h('div', { class:'rp-summary' }, h('strong', {}, plan ? plan.customer : template.customer || 'Customer'), h('span', {}, plan ? 'Editing changes visits not yet on the schedule. Visits already booked keep their date, time, crew and price unless you choose to move them below; if the new pattern leaves any out, you will be shown which ones to cancel in Dispatch.' : 'Repeats ' + (template.serviceType || 'this job') + ' with its scope, access notes and materials.')));
  const frequency = select(FREQUENCIES, cadence.frequency, { name:'frequency' });
  const weeks = h('input', { type:'number', name:'intervalWeeks', inputMode:'numeric', min:1, max:52, step:1, value:cadence.intervalWeeks || 3 });
  const start = h('input', { type:'date', name:'startDate', required:true, value:source.startDate || template?.date || today() });
  const monthlyBy = select([['day_of_month',''],['nth_weekday','']], cadence.monthlyBy || 'day_of_month', { name:'monthlyBy' });
  const time = h('input', { type:'time', name:'time', required:true, value:source.time || template?.time || '08:00' });
  const endTime = h('input', { type:'time', name:'endTime', required:true, value:source.endTime || template?.endTime || '10:00' });
  const endsMode = select([['never','No end date'],['on','On a date'],['after','After a number of visits']], source.count ? 'after' : source.endsOn ? 'on' : 'never', { name:'ends' });
  const endsOn = h('input', { type:'date', name:'endsOn', value:source.endsOn || '' });
  const count = h('input', { type:'number', name:'count', inputMode:'numeric', min:1, max:520, step:1, value:source.count || 12 });
  const horizon = select(HORIZONS.some(([days]) => days === source.horizonDays) || !source.horizonDays ? HORIZONS : [...HORIZONS, [source.horizonDays, source.horizonDays + ' days ahead']], source.horizonDays || 56, { name:'horizonDays' });
  const skips = new Set(source.skipDates || []), skipInput = h('input', { type:'date', name:'skipDate' }), skipList = h('div', { class:'rp-chips', 'aria-live':'polite' });
  const drawSkips = () => skipList.replaceChildren(...[...skips].sort().map(date => btn(dateText(date, false) + ' ×', () => { skips.delete(date); drawSkips(); }, 'chip', { 'aria-label':'Remove skipped date ' + dateText(date, false) })));
  drawSkips();
  const checks = new Map(), crew = h('fieldset', { class:'rp-wide rp-crew' }, h('legend', {}, 'Crew for each visit'));
  for (const member of data.roster) { const input = h('input', { type:'checkbox', value:member.id, checked:(assignment.assignedCrew || []).includes(member.id) }); checks.set(member.id, input); crew.append(h('label', { class:'rp-check' }, input, h('span', {}, member.name))); }
  const lead = select([['', 'No crew lead'], ...data.roster.map(row => [row.id, row.name])], assignment.crewLead || '', { name:'crewLead' });
  const reminders = h('input', { type:'checkbox', name:'notifyCustomer', checked:plan?.notifyCustomer === true });
  const savedPrice = Number.isInteger(plan?.pricePerVisitCents) ? plan.pricePerVisitCents : null, lines = plan?.lineItems?.length || 0;
  const price = h('input', { type:'text', name:'pricePerVisit', inputMode:'decimal', autocomplete:'off', placeholder:'No price', value:savedPrice === null ? '' : (savedPrice / 100).toFixed(2) });
  const booked = plan ? h('input', { type:'checkbox', name:'applyToBooked' }) : null;
  const vehicles = (data.vehicles || []).filter(row => row.status === 'available' || row.id === assignment.vehicleId);
  const truck = select([['', 'No vehicle'], ...vehicles.map(row => [row.id, row.name])], assignment.vehicleId || '', { name:'vehicleId' });
  const weeksField = labeled('Weeks between visits', weeks), monthlyField = labeled('Monthly pattern', monthlyBy), endsOnField = labeled('Last visit on or before', endsOn), countField = labeled('Number of visits', count, 'Skipped dates count toward this total.');
  const sync = () => {
    const parts = dayParts(start.value);
    monthlyBy.options[0].textContent = 'Same date each time (day ' + parts.day + ')';
    monthlyBy.options[1].textContent = 'Same weekday (' + (parts.nth === -1 ? 'last' : ORDINAL[parts.nth]) + ' ' + DAYS[parts.weekday] + ')';
    weeksField.hidden = frequency.value !== 'every_n_weeks';
    monthlyField.hidden = !['monthly','quarterly'].includes(frequency.value);
    endsOnField.hidden = endsMode.value !== 'on'; countField.hidden = endsMode.value !== 'after';
  };
  for (const control of [frequency, start, endsMode]) control.addEventListener('change', sync);
  const grid = h('div', { class:'rp-grid' },
    labeled('Repeats', frequency), weeksField, monthlyField, labeled('First visit', start), labeled('Start time', time), labeled('End time', endTime),
    labeled('Ends', endsMode), endsOnField, countField, labeled('Keep on the schedule', horizon, 'Visits are added to Dispatch this far ahead.'),
    h('div', { class:'rp-wide rp-skips' }, labeled('Skip a date', skipInput), btn('Add skipped date', () => { if (/^\d{4}-\d{2}-\d{2}$/.test(skipInput.value)) { skips.add(skipInput.value); skipInput.value = ''; drawSkips(); } }), skipList),
    crew, labeled('Crew lead', lead), labeled('Vehicle', truck),
    labeled('Price per visit (USD)', price, lines > 1 ? 'Now itemized from ' + lines + ' lines; a new amount replaces them with one line. Saved as each added visit\u2019s estimate, with no deposit; nothing is sent.' : 'Optional. Saved as each added visit\u2019s estimate, with no deposit; nothing is sent to the customer.'),
    booked ? h('label', { class:'rp-check rp-wide' }, booked, h('span', {}, 'Also move booked visits that have not started to the new time, crew and price')) : null,
    h('label', { class:'rp-check rp-wide' }, reminders, h('span', {}, 'Send the customer\u2019s usual appointment reminders for each added visit')));
  sync();
  const status = h('div', { class:'rp-form-status', 'aria-live':'polite' });
  form.append(grid, status, h('footer', { class:'rp-form-foot' }, btn('Back', () => { S.view = 'list'; S.plan = S.template = null; render(); }), h('button', { type:'submit', class:'rp-btn primary', disabled:!data.enabled }, plan ? 'Save plan changes' : 'Start recurring plan')));
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (S.busy) return;
    const members = [...checks].filter(([, input]) => input.checked).map(([id]) => id), problems = [];
    if (!start.value) problems.push('Choose the first visit date.');
    if (!time.value || !endTime.value) problems.push('Choose start and end times.');
    if (lead.value && !members.includes(lead.value)) problems.push('The crew lead must be one of the selected crew.');
    if (endsMode.value === 'on' && !endsOn.value) problems.push('Choose the last date.');
    const visits = Number(count.value);
    if (endsMode.value === 'after' && (!Number.isInteger(visits) || visits < 1 || visits > 520)) problems.push('Enter between 1 and 520 visits.');
    const interval = Number(weeks.value);
    if (frequency.value === 'every_n_weeks' && (!Number.isInteger(interval) || interval < 1 || interval > 52)) problems.push('Enter 1 to 52 weeks between visits.');
    const cents = priceCents(price.value);
    if (Number.isNaN(cents)) problems.push('Enter the price per visit like 145 or 145.50, or leave it blank.');
    if (problems.length) { status.replaceChildren(notice(problems.join(' '), 'error')); return; }
    const monthly = ['monthly','quarterly'].includes(frequency.value);
    const keepCadence = plan && cadence.frequency === frequency.value && (!monthly || cadence.monthlyBy === monthlyBy.value) && start.value === plan.startDate;
    const nextCadence = keepCadence ? cadence : { frequency:frequency.value, ...(frequency.value === 'every_n_weeks' ? { intervalWeeks:interval } : {}), ...(monthly ? { monthlyBy:monthlyBy.value } : {}) };
    const savedCrew = (data.crews || []).find(row => row.id === assignment.crewId);
    const schedule = { cadence:frequency.value === 'every_n_weeks' ? { frequency:'every_n_weeks', intervalWeeks:interval } : nextCadence, startDate:start.value, time:time.value, endTime:endTime.value,
      endsOn:endsMode.value === 'on' ? endsOn.value : null, count:endsMode.value === 'after' ? visits : null, skipDates:[...skips].sort(), horizonDays:Number(horizon.value), notifyCustomer:reminders.checked,
      assignment:{ assignedCrew:members, crewLead:lead.value || null, crewId:savedCrew && savedCrew.memberIds.length === members.length && savedCrew.memberIds.every(id => members.includes(id)) ? savedCrew.id : null, vehicleId:truck.value || null } };
    if (cents !== savedPrice) schedule.pricePerVisitCents = cents;
    const request = plan ? { action:'update', requestId:key(), planId:plan.id, expectedRevision:plan.revision, plan:schedule, ...(booked.checked ? { applyToBooked:true } : {}) } : { action:'create', requestId:key(), plan:{ templateJobId:template.id, ...schedule } };
    const controls = [...form.elements].filter(control => !control.disabled);
    S.busy = true; for (const control of controls) control.disabled = true;
    status.replaceChildren(notice('Saving and verifying…'));
    let result;
    try { result = await send(request, plan ? 'Plan updated.' : 'Recurring plan started.'); }
    catch (error) {
      S.busy = false;
      if (!S.root) return;
      // An unknown outcome is kept for an identical retry from the plan list.
      if (S.recovery) { S.view = 'list'; S.actionError = errorText(error); render(); return; }
      for (const control of controls) control.disabled = false;
      status.replaceChildren(notice(errorText(error), 'error')); return;
    }
    S.busy = false;
    const note = [plan ? 'Plan updated.' : 'Recurring plan started.', ...(result.warnings || []).map(row => row.message)].join(' ');
    // Booked visits follow the edit in the same bounded extend requests that add new visits.
    void act(async () => { if (!plan) await extendAll(result.plan, note); else if (request.applyToBooked && result.plan.status === 'active') { await extendAll(result.plan, note); S.stale = (result.warnings || []).flatMap(row => row.code === 'generated_visits_off_pattern' && Array.isArray(row.visits) ? row.visits : []); if (S.stale.length) S.noticeKind = 'warn'; } else showSaved('Plan updated.', result.warnings || []); });
  });
  body.append(form);
  setTimeout(() => frequency.focus(), 0);
}
function render() {
  if (!S.root) return;
  const head = h('header', { class:'rp-head' }, h('div', {}, h('span', { class:'rp-eyebrow' }, 'EGC OPERATIONS'), h('h2', { id:'rp-title' }, S.view === 'form' ? (S.plan ? 'Edit recurring plan' : 'Repeat this job') : 'Recurring plans'), h('p', {}, 'Mountain Time. Each visit is a normal Dispatch job with conflict checks.')),
    S.dialog ? btn('×', close, 'rp-close', { 'aria-label':'Close recurring plans', disabled:S.busy }) : null);
  const body = h('div', { class:'rp-body' });
  S.root.replaceChildren(head, body);
  if (S.loading && !S.data) { body.append(h('div', { class:'rp-skeleton', role:'status', 'aria-label':'Loading recurring plans' }, h('span'), h('span'), h('span'))); return; }
  if (S.error) body.append(notice(S.error, 'error'), S.errorStatus === 401 ? h('a', { class:'rp-btn', href:'/employee.html?view=schedule' }, 'Sign in to Employee Hub') : null);
  if (!S.data) { if (!S.loading) body.append(btn('Retry', () => load())); return; }
  if (S.actionError) body.append(notice(S.actionError, 'error'));
  if (S.busy) body.append(notice(S.notice || 'Saving and verifying…'));
  else if (S.notice) body.append(notice(S.notice, S.noticeKind));
  if (!S.busy && S.stale.length) body.append(h('div', { class:'rp-stale' }, h('strong', {}, 'Still on the schedule — cancel in Dispatch if not wanted'), h('ul', { 'aria-label':'Visits that no longer match the plan' }, S.stale.map(row => h('li', {}, dateText(row.date, false))))));
  if (S.recovery) {
    body.append(notice(S.recovery.invalid ? 'A saved recurring-plan request could not be read. Reopen this browser session before making another change.' : 'A previous recurring-plan save has not been verified. Retry its original request before making another change.', 'error'));
    if (!S.recovery.invalid) body.append(btn('Retry original save', retryRecovery, 'primary', { disabled:S.busy }));
    return;
  }
  if (!S.data.enabled) body.append(notice('Recurring plans are turned off for this Hub, so new plans cannot be started or extended. Existing plans can still be paused or ended.'));
  if (S.view === 'form' && (S.plan || S.template)) { renderForm(body); return; }
  if (!S.data.plans.length) body.append(h('div', { class:'rp-empty' }, h('h3', {}, 'No recurring plans yet'), h('p', {}, 'In Dispatch, choose Repeat on a scheduled job to start a plan from it.')));
  body.append(h('div', { class:'rp-list' }, S.data.plans.map(planCard)));
}
function close() {
  if (S.busy) return;
  const dialog = S.dialog; unmount(); dialog?.close(); dialog?.remove(); changed();
}
function mount(host, { templateJob = null, onChange = null } = {}) {
  if (!host) return;
  unmount(); S.host = host; S.onChange = onChange; S.template = templateJob; S.view = templateJob ? 'form' : 'list';
  S.root = h('section', { class:'egc-recurring', 'aria-labelledby':'rp-title' }); host.replaceChildren(S.root); render(); void load();
}
function open(options = {}) {
  if (S.dialog) close();
  if (S.dialog) return;
  const dialog = h('dialog', { class:'rp-dialog', 'aria-labelledby':'rp-title' });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  document.body.append(dialog); dialog.showModal();
  mount(dialog, options); S.dialog = dialog;
  render();
}
function unmount() { S.generation++; S.root?.remove(); S.root = null; S.host = null; S.dialog = null; S.data = null; S.viewer = null; S.recovery = null; S.error = ''; S.notice = ''; S.noticeKind = ''; S.stale = []; S.view = 'list'; S.plan = null; S.template = null; S.confirm = null; S.busy = false; S.actionError = ''; }
window.addEventListener('egc:signout', () => { try { for (let i = sessionStorage.length - 1; i >= 0; i--) { const name = sessionStorage.key(i); if (name?.startsWith(recoveryPrefix)) sessionStorage.removeItem(name); } } catch {} const dialog = S.dialog; unmount(); dialog?.remove(); });
window.addEventListener('beforeunload', event => { if (S.busy || (S.recovery && !S.recovery.invalid)) { event.preventDefault(); event.returnValue = ''; } });
window.EGCRecurring = { mount, unmount, open, refresh:load, canLeave:() => !S.busy && !(S.recovery && !S.recovery.invalid) };
})();
