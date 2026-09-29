/* Dispatch rules in the dispatch screen (P1-DS-06): a 'Rules' view registered on EGCDispatch.registerView
   listing the rule warnings /api/dispatch returned for the loaded week, and the Required skills pickers that
   employee-dispatch.js adds to its job editor and openings search through one-line hooks. The server decides
   every rule and whether it blocks a save; this module only shows what the response says. */
(function () {
'use strict';
const RULES = Object.freeze({ skill_missing:'Skills', employee_daily_capacity:'Daily limit', outside_working_hours:'Working hours', crew_size_short:'Crew size', travel_buffer_short:'Drive time' });
const BLOCKING = Object.freeze({ crewShort:'crew size', skillMissing:'skills', outsideHours:'working hours', overCapacity:'daily limits', travelShort:'drive time' });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const kit = () => window.EGCDispatch?.internals || null;
const addDays = (date, count) => new Date(Date.parse(date+'T12:00:00Z')+count*86400000).toISOString().slice(0,10);
// The skill catalog the server sent with the schedule; nothing is invented client side.
function catalog(data) {
  const skills = data?.dispatchRules?.skills;
  return Array.isArray(skills) ? skills.filter(skill => skill && typeof skill.id === 'string' && /^[a-z0-9_]{1,40}$/.test(skill.id) && typeof skill.label === 'string') : [];
}
const blocks = (data, rule) => data?.dispatchRules?.blocking?.[rule] === true;
function picker(k, data, legend, selected, help) {
  const chosen = new Set(Array.isArray(selected) ? selected.filter(id => typeof id === 'string') : []), inputs = new Map();
  const box = k.h('fieldset', { class:'dp-wide dp-assignment dp-skill-picker' }, k.h('legend', {}, legend));
  const add = (id, label) => { const input = k.h('input', { type:'checkbox', value:id, checked:chosen.has(id) }); inputs.set(id, input); box.append(k.h('label', { class:'dp-check' }, input, k.h('span', {}, label))); };
  for (const skill of catalog(data)) add(skill.id, skill.label);
  // A retired skill already on the job stays selectable so saving keeps it.
  for (const id of chosen) if (!inputs.has(id)) add(id, k.words(id)+' · retired skill');
  if (help) box.append(k.h('small', { class:'dp-muted' }, help));
  return { box, value:() => [...inputs].filter(([, input]) => input.checked).map(([id]) => id).sort() };
}

/** Job editor hook: adds the picker and returns {changes()} for the save body. `selected` (an opening's
 * skills) replaces the preselection; the job's saved skills still decide whether an empty choice is sent. */
function jobFields(model, job, data, selected) {
  const k = kit();
  const before = Array.isArray(job?.requiredSkills) ? job.requiredSkills : [], chosen = Array.isArray(selected) ? selected : before;
  if (!k || !model?.fields || !catalog(data).length && !before.length && !chosen.length) return null;
  const skills = picker(k, data, 'Required skills', chosen, 'At least one assigned employee must hold each skill at proficient or lead level.'+(blocks(data,'skillMissing') ? ' Dispatch rules block a save without it.' : ' Missing skills are a warning.'));
  model.fields.append(skills.box);
  return { changes() { const value = skills.value(); return value.length || before.length ? { requiredSkills:value } : {}; } };
}

/** Openings hook: the picker plus {skills()}. With skills and no employees the server searches every qualified employee.
 * `selected` (the job's required skills for 'Find a time') starts checked; a retired skill cannot be searched, so it is left out. */
function openingsFields(model, data, selected) {
  const k = kit(), known = new Set(catalog(data).map(skill => skill.id));
  if (!k || !model?.fields || !known.size) return null;
  const skills = picker(k, data, 'Required skills (optional)', (Array.isArray(selected) ? selected : []).filter(id => known.has(id)), 'Choose skills and leave the employees unchecked to search each qualified employee on their own.');
  model.fields.append(skills.box);
  return { skills:skills.value };
}

function policy(k, data) {
  const rules = data?.dispatchRules, on = Object.entries(BLOCKING).filter(([rule]) => blocks(data, rule)).map(([, label]) => label), limits = [];
  if (Number.isInteger(rules?.maxJobsPerEmployeePerDay)) limits.push(rules.maxJobsPerEmployeePerDay+' '+(rules.maxJobsPerEmployeePerDay === 1 ? 'job' : 'jobs'));
  if (typeof rules?.maxHoursPerEmployeePerDay === 'number') limits.push(rules.maxHoursPerEmployeePerDay+' hours');
  return k.h('div', { class:'dp-notice', role:'status' }, on.length ? 'Saves are blocked for: '+on.join(', ')+'. Other rules are warnings.' : 'Every rule is a warning; nothing here blocks a save.',
    limits.length ? ' Daily limit per employee: '+limits.join(' or ')+'.' : ' No daily limit is set.', ' The owner sets these in Dispatch rules.');
}

function render(target, jobs) {
  const k = kit(), S = k?.state();
  if (!k || !S?.data) return;
  const byId = new Map(jobs.map(job => [job.id, job])), rows = (S.data.warnings || []).filter(warning => RULES[warning.code] && byId.has(warning.jobId));
  target.append(policy(k, S.data));
  if (!rows.length) { target.append(k.h('div', { class:'dp-empty' }, k.h('h3', {}, 'No rule warnings'), k.h('p', {}, 'No job in this week breaks a dispatch rule.'))); return; }
  for (const [code, label] of Object.entries(RULES)) {
    const list = rows.filter(warning => warning.code === code);
    if (!list.length) continue;
    const section = k.h('section', { class:'dp-rules-group', 'aria-label':label }, k.h('h2', {}, label+' · '+list.length));
    const grid = k.h('div', { class:'dp-search-results' });
    for (const warning of list) {
      const job = byId.get(warning.jobId), when = DATE.test(warning.date || '') ? k.dateText(warning.date, true) : job.date ? k.dateText(job.date, true)+' '+k.clock(job.time)+' – '+k.clock(job.endTime) : 'Unscheduled';
      const actions = k.h('div', { class:'dp-card-actions' });
      if (k.active(job)) actions.append(k.btn('Edit / assign', () => k.openJob(job.sourceJob || job), 'primary', { 'aria-label':'Edit '+(job.customer || job.title || 'job') }));
      grid.append(k.h('article', { class:'dp-search-result' + (warning.blocking ? ' dp-rule-blocking' : '') },
        k.h('div', { class:'dp-job-top' }, k.h('strong', {}, job.customer || job.title || job.id), warning.blocking ? k.h('span', { class:'dp-pill dp-pill-blocking' }, 'Blocks changes') : k.pill('Warning', 'muted')),
        k.h('p', { class:'dp-muted' }, when + (warning.employeeId ? ' · '+k.person(warning.employeeId) : '')),
        k.h('p', {}, warning.message || k.words(code)), actions));
    }
    section.append(grid); target.append(section);
  }
}

window.EGCDispatchRules = Object.freeze({ jobFields, openingsFields, catalog, RULES });
const dispatch = window.EGCDispatch;
if (dispatch?.registerView) dispatch.registerView('rules', { label:'Rules', range:date => ({ startDate:date, endDate:addDays(date,7) }), step:(date, count) => addDays(date, count*7), render,
  help:'Rule warnings for these seven days. A blocking rule stops a save that changes what it checks; fix the job or ask the owner to change the rule.' });
})();
