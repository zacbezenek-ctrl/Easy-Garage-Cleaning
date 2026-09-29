/* Owner dispatch rules screen (P1-DS-06), registered in employee-hub-screens.js with the owner capability. It
   reads and saves /api/dispatch-settings: every save carries a requestId and the revision it was edited from, and
   an unconfirmed save is kept in this tab and retried unchanged (EGCHubKit.pending). The server applies the rules;
   this screen only edits which ones warn and which block a save, the daily limits and the scheduling defaults. */
(function () {
'use strict';
const SCREEN = 'dispatch_rules', PATH = '/api/dispatch-settings';
const KEYS = ['defaultTravelBufferMinutes','defaultArrivalWindowMinutes','workdayStart','workdayEnd','blockCrewShort','blockSkillMissing','blockTravelShort','blockOverCapacity','blockOutsideHours','maxJobsPerEmployeePerDay','maxHoursPerEmployeePerDay'];
const RULES = [
  ['blockCrewShort', 'Crew size', 'A scheduled job has fewer employees than its required crew size. Jobs offered as open shifts never block, and neither does a signed walkthrough saved with no crew or by a sales account (Dispatch staffs it); otherwise keep a job unscheduled until its crew is set.'],
  ['blockSkillMissing', 'Required skills', 'No assigned employee holds one of the job\'s required skills at proficient or lead level.'],
  ['blockOutsideHours', 'Working hours', 'Work falls outside an employee\'s recorded weekly hours. Employees without recorded hours are not checked.'],
  ['blockOverCapacity', 'Daily limits', 'An employee would pass the daily job or hour limit set below.'],
  ['blockTravelShort', 'Drive time', 'The gap between two stops is shorter than the estimated drive between them.'],
];
const HHMM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const S = { host:null, root:null, ctx:null, generation:0, data:null, loading:false, error:null, busy:false, dirty:false, message:null, controls:null };
const kit = () => window.EGCHubKit;
const viewer = () => String(S.ctx?.identity || '').trim().toLowerCase() || undefined;
const store = () => kit().pending(SCREEN, viewer());
const unload = event => { if (S.dirty || S.busy) { event.preventDefault(); event.returnValue = ''; } };

function valid(data) {
  const values = data?.settings?.values, env = data?.environment;
  return data?.ok === true && values && typeof values === 'object' && KEYS.every(key => Object.hasOwn(values, key)) && (data.settings.revision === null || typeof data.settings.revision === 'string') &&
    Array.isArray(data.settings.invalidFields) && env && typeof env === 'object' && typeof env.arrival?.enabled === 'boolean';
}

async function load() {
  if (!S.root) return;
  const generation = ++S.generation;
  S.loading = true; S.error = null; render();
  try {
    const data = await kit().requestJSON(PATH, { prefix:'dispatch', validate:valid });
    if (generation !== S.generation || !S.root) return;
    S.data = data; S.dirty = false;
  } catch (error) {
    if (generation !== S.generation || !S.root) return;
    S.error = error;
  } finally {
    if (generation === S.generation && S.root) { S.loading = false; render(); }
  }
}

function note(kind, text, ...actions) {
  const { h } = kit();
  return h('div', { class:'hub-notice '+kind, role:kind === 'error' ? 'alert' : 'status' }, text, actions.length ? h('div', { class:'hub-actions' }, actions) : null);
}

function numberText(value) { return value === null || value === undefined ? '' : String(value); }
function read() {
  const c = S.controls, values = S.data.settings.values, out = {}, problems = [];
  for (const [key] of RULES) out[key] = c[key].checked;
  const whole = (key, min, max, label, required = false) => {
    const text = c[key].value.trim();
    if (!text) { if (required) problems.push(label+' is required.'); return null; }
    const value = Number(text);
    if (!Number.isInteger(value) || value < min || value > max) problems.push(`${label} must be a whole number from ${min} to ${max}.`);
    return value;
  };
  out.maxJobsPerEmployeePerDay = whole('maxJobsPerEmployeePerDay', 1, 20, 'Jobs per employee per day');
  const hoursText = c.maxHoursPerEmployeePerDay.value.trim(), hours = hoursText ? Number(hoursText) : null;
  if (hoursText && (!Number.isFinite(hours) || hours < 1 || hours > 24 || !Number.isInteger(hours * 4))) problems.push('Hours per employee per day must be 1 to 24 in quarter hours.');
  out.maxHoursPerEmployeePerDay = hours;
  out.defaultTravelBufferMinutes = whole('defaultTravelBufferMinutes', 0, 180, 'The default travel buffer', true);
  out.defaultArrivalWindowMinutes = whole('defaultArrivalWindowMinutes', 15, 480, 'The arrival window length');
  out.workdayStart = c.workdayStart.value;
  out.workdayEnd = c.midnight.checked ? '24:00' : c.workdayEnd.value;
  if (!HHMM.test(out.workdayStart) || out.workdayEnd !== '24:00' && !HHMM.test(out.workdayEnd)) problems.push('Choose the workday start and end times.');
  else if (out.workdayEnd !== '24:00' && out.workdayEnd <= out.workdayStart) problems.push('The workday must end after it starts. Choose "Ends at midnight" for a workday that runs to 12:00 AM.');
  const changes = Object.fromEntries(KEYS.filter(key => out[key] !== values[key]).map(key => [key, out[key]]));
  return { changes, problems, reason:c.reason.value.trim() };
}

function show(message) { S.message = message; const slot = S.root?.querySelector('[data-dr-status]'); if (slot) slot.replaceChildren(...(message ? [message] : [])); }
function setBusy(busy) {
  S.busy = busy;
  for (const control of S.root?.querySelectorAll('input,select,textarea,button') || []) if (!control.matches('[data-dr-keep]')) control.disabled = busy;
  S.root?.querySelector('[data-dr-save]')?.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (!busy) syncControls();
}
function syncControls() {
  const c = S.controls; if (!c) return;
  const { changes } = read(), pending = store().get();
  // An unconfirmed save freezes the draft: it can only be retried unchanged or discarded.
  for (const control of S.root.querySelectorAll('.dr-form input,.dr-form textarea')) control.disabled = S.busy || Boolean(pending) || control === c.workdayEnd && c.midnight.checked;
  S.dirty = Object.keys(changes).length > 0 || Boolean(c.reason.value.trim());
  c.save.disabled = S.busy || Boolean(pending) || !Object.keys(changes).length;
  c.discard.disabled = S.busy || !S.dirty;
}

async function send(retry) {
  if (S.busy) return;
  const { h, errorText, button } = kit(), pending = store(), generation = S.generation;
  let body = null;
  if (!retry) {
    const { changes, problems, reason } = read();
    if (problems.length) { show(note('error', problems.join(' '))); return; }
    if (!Object.keys(changes).length) { show(note('', 'Nothing has changed.')); return; }
    body = { action:'settings.update', requestId:kit().requestId(), expectedRevision:S.data.settings.revision, changes, ...(reason ? { reason } : {}) };
  }
  const expected = retry ? pending.get()?.requestId : body.requestId;
  setBusy(true); show(note('', retry ? 'Retrying the original save…' : 'Saving and verifying…'));
  try {
    const validate = data => valid(data) && data.requestId === expected;
    const data = retry ? await pending.replay({ prefix:'dispatch', validate }) : await pending.submit(PATH, body, { prefix:'dispatch', validate });
    if (generation !== S.generation || !S.root) return;
    S.data = data; S.dirty = false; S.busy = false; render();
    show(note('success', data.replayed ? 'That save had already been applied. The dispatch rules below are current.' : 'Dispatch rules saved. New checks use them right away.'));
  } catch (error) {
    if (generation !== S.generation || !S.root) return;
    setBusy(false);
    const kept = pending.get(), actions = [];
    if (kept) actions.push(button('Retry original save', () => send(true), 'primary'), button('Discard saved request', () => { pending.discard(); syncControls(); show(note('', 'The unconfirmed save was discarded. Its outcome is unknown, so reload before changing the rules again.', button('Reload', () => void load()))); }, 'quiet'));
    if (/revision_conflict$/.test(error.code || '')) actions.push(button('Discard draft and load latest', () => { S.dirty = false; void load(); }));
    show(note('error', errorText(error, { dispatch_settings_invalid:error.message }) + (kept ? ' This request is saved in this tab; retry it unchanged so it is never applied twice.' : ''), ...actions));
    syncControls();
  }
}

function field(spec) { const node = kit().field(spec); return { node, input:node.querySelector('input,select,textarea') }; }

function form(data) {
  const { h, button } = kit(), values = data.settings.values, env = data.environment, c = {};
  const rules = h('section', { class:'hub-card dr-card', 'aria-labelledby':'dr-rules-title' }, h('h2', { id:'dr-rules-title' }, 'When a rule is broken'),
    h('p', { class:'dr-lead' }, 'Every rule is a warning on the schedule. Turn on a block to stop Hub dispatch saves and crew shift pickups that break it; signed walkthrough handoffs and recurring visits are checked too, and a refused save names the rule. A block only stops a change to what that rule checks, so unrelated edits still save. Schedule changes sent through the operations platform or MCP tools are not checked yet.'));
  for (const [key, label, help] of RULES) {
    let extra = '';
    if (key === 'blockTravelShort') extra = env.travelEstimates === 'off' ? ' Drive-time estimates are off, so this has no effect until they are turned on.' : env.envBlockTravelShort ? ' The Hub environment already blocks short drives.' : '';
    if (['blockSkillMissing','blockOutsideHours'].includes(key) && !env.staffDirectory) extra = ' Skills and weekly hours come from the staff directory, which is not turned on yet.';
    const item = field({ type:'checkbox', name:key, label:'Block saves: '+label, value:values[key], help:help+extra });
    c[key] = item.input; rules.append(item.node);
  }
  const limits = h('section', { class:'hub-card dr-card', 'aria-labelledby':'dr-limits-title' }, h('h2', { id:'dr-limits-title' }, 'Daily limits'), h('p', { class:'dr-lead' }, 'Per employee and Mountain Time day, counting every scheduled job. Leave empty for no limit.'));
  const jobs = field({ type:'number', name:'maxJobsPerEmployeePerDay', label:'Jobs per employee per day', value:numberText(values.maxJobsPerEmployeePerDay), min:1, max:20, step:1, placeholder:'No limit', inputmode:'numeric' });
  const hours = field({ type:'number', name:'maxHoursPerEmployeePerDay', label:'Scheduled hours per employee per day', value:numberText(values.maxHoursPerEmployeePerDay), min:1, max:24, step:0.25, placeholder:'No limit', help:'Quarter hours, such as 9.5.' });
  c.maxJobsPerEmployeePerDay = jobs.input; c.maxHoursPerEmployeePerDay = hours.input;
  limits.append(h('div', { class:'dr-pair' }, jobs.node, hours.node));
  const defaults = h('section', { class:'hub-card dr-card', 'aria-labelledby':'dr-defaults-title' }, h('h2', { id:'dr-defaults-title' }, 'Scheduling defaults'));
  const buffer = field({ type:'number', name:'defaultTravelBufferMinutes', label:'Travel buffer for new jobs (minutes)', value:numberText(values.defaultTravelBufferMinutes), min:0, max:180, step:5, required:true, inputmode:'numeric' });
  const arrival = field({ type:'number', name:'defaultArrivalWindowMinutes', label:'Customer arrival window length (minutes)', value:numberText(values.defaultArrivalWindowMinutes), min:15, max:480, step:15, inputmode:'numeric', placeholder:`Hub default (${env.envArrivalMinutes} minutes)`,
    help:env.arrival.enabled ? 'Blank arrival windows get a window this long from the start time when a job is saved.' : 'Derived arrival windows are turned off for customers, so this length is used only once they are turned on.' });
  const start = field({ type:'time', name:'workdayStart', label:'Workday starts', value:values.workdayStart, required:true });
  const end = field({ type:'time', name:'workdayEnd', label:'Workday ends', value:values.workdayEnd === '24:00' ? '' : values.workdayEnd });
  const midnight = field({ type:'checkbox', name:'workdayEndsMidnight', label:'Ends at midnight', value:values.workdayEnd === '24:00' });
  Object.assign(c, { defaultTravelBufferMinutes:buffer.input, defaultArrivalWindowMinutes:arrival.input, workdayStart:start.input, workdayEnd:end.input, midnight:midnight.input });
  defaults.append(h('div', { class:'dr-pair' }, buffer.node, arrival.node), h('p', { class:'dr-lead' }, 'The workday is the default window when searching for openings.'), h('div', { class:'dr-pair' }, start.node, end.node), midnight.node);
  const why = field({ type:'textarea', name:'reason', label:'Reason for this change (optional)', maxlength:500, rows:2, help:'Saved with the change history.' });
  c.reason = why.input;
  c.discard = button('Discard changes', () => { S.dirty = false; render(); show(null); }, 'quiet');
  c.save = h('button', { type:'submit', class:'hub-btn primary', 'data-dr-save':'' }, 'Save dispatch rules');
  const root = h('form', { class:'dr-form', novalidate:true, onsubmit:event => { event.preventDefault(); void send(false); }, oninput:syncControls, onchange:syncControls },
    rules, limits, defaults, h('section', { class:'hub-card dr-card' }, why.node), h('div', { class:'dr-actions' }, c.discard, c.save));
  S.controls = c;
  return root;
}

function render(keepMessage = false) {
  if (!S.root) return;
  const { h, button } = kit(), data = S.data;
  const updated = data?.settings?.updatedAt ? 'Last saved '+new Intl.DateTimeFormat('en-US', { timeZone:'America/Denver', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }).format(new Date(data.settings.updatedAt))+(data.settings.updatedBy ? ' by '+data.settings.updatedBy : '')+'.' : 'Using the standard rules: nothing has been saved yet.';
  const head = h('header', { class:'hub-head' }, h('div', {}, h('span', { class:'hub-eyebrow' }, 'Dispatch'), h('h1', {}, 'Dispatch rules'), h('p', {}, 'Choose which scheduling rules only warn and which block a save, plus daily limits and scheduling defaults. '+(data ? updated : ''))),
    h('div', { class:'hub-actions' }, button('Reload', () => { if (S.dirty) show(note('warning', 'Save or discard your changes before reloading.')); else void load(); }, '', { disabled:S.loading || S.busy })));
  const status = h('div', { 'data-dr-status':'', 'aria-live':'polite' }, ...(keepMessage && S.message ? [S.message] : []));
  if (!keepMessage) S.message = null;
  const body = [];
  const saved = store().get();
  if (saved) body.push(note('warning', 'A save of the dispatch rules from this tab was not confirmed. Retry it unchanged before making another change.', button('Retry original save', () => send(true), 'primary'), button('Discard saved request', () => { store().discard(); render(); }, 'quiet')));
  if (S.loading && !data) body.push(h('div', { class:'hub-screen-loading', 'aria-busy':'true' }, h('p', { class:'hub-sr-only', role:'status' }, 'Loading dispatch rules…'), h('span', { class:'hub-skeleton' }), h('span', { class:'hub-skeleton' }), h('span', { class:'hub-skeleton wide' })));
  else if (S.error && !data) body.push(note('error', kit().errorText(S.error, { dispatch_settings_forbidden:'Only the owner can view or change dispatch rules.' })+' Nothing is shown until the rules can be verified.', button('Retry', () => void load(), 'primary')));
  else if (data) {
    if (S.error) body.push(note('error', 'The latest rules could not be reloaded; the rules below are from the last successful load.', button('Retry', () => void load())));
    if (data.settings.invalidFields.length) body.push(note('warning', 'Some saved settings could not be read and are using their standard value until saved again: '+data.settings.invalidFields.join(', ')+'.'));
    body.push(form(data));
  }
  S.root.replaceChildren(head, status, ...body);
  if (S.controls && data) syncControls();
}

function mount(host, ctx = {}) {
  if (!host || !kit()) return;
  if (S.host === host && S.root?.isConnected) return;
  unmount();
  S.host = host; S.ctx = ctx; S.root = kit().h('section', { class:'hub-screen egc-dispatch-rules' });
  host.replaceChildren(S.root);
  window.addEventListener('beforeunload', unload);
  render(); void load();
}
function unmount() {
  S.generation++;
  window.removeEventListener('beforeunload', unload);
  S.root?.remove();
  Object.assign(S, { host:null, root:null, ctx:null, data:null, loading:false, error:null, busy:false, dirty:false, message:null, controls:null });
}
window.addEventListener('egc:signout', unmount);
window.EGCDispatchSettings = Object.freeze({ mount, unmount, canLeave:() => !S.dirty && !S.busy, refresh:() => S.dirty || S.busy ? undefined : load() });
})();
