/* Read-only Team Lead My day card. API authorization is authoritative; the
   client role check only avoids requesting this card for ordinary crew. */
(() => {
'use strict';
const state = { host: null, ctx: null, generation: 0, controller: null };
const kit = () => window.EGCHubKit;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function valid(data) {
  return data?.ok === true && Array.isArray(data.last30) && data.last30.every(row => typeof row.name === 'string' &&
    ['hours','jobsLed','jobsWorked','followUps'].every(key => number(row[key]))) && typeof data.asOf === 'string';
}
async function refresh() {
  if (!state.host) return;
  const current = ++state.generation, host = state.host;
  state.controller?.abort(); state.controller = new AbortController();
  const h = kit().h;
  host.hidden = false;
  host.replaceChildren(h('section', { class: 'hub-card', 'aria-label': 'Team performance' }, h('h2', {}, 'Team performance'), h('p', { role: 'status' }, 'Loading hours and job counts.')));
  try {
    const data = await kit().requestJSON('/api/crew-performance', { prefix: 'crew_performance', timeout: 15000,
      signal: state.controller.signal, fetcher: state.ctx.hubFetch, validate: valid });
    if (current !== state.generation || state.host !== host) return;
    const rows = data.last30.map(row => h('li', {}, h('strong', {}, row.name),
      `: ${row.hours.toFixed(1)} hours on jobs; ${row.jobsWorked} jobs worked; ${row.jobsLed} led; ${row.followUps} open follow-ups.`));
    host.replaceChildren(h('section', { class: 'hub-card', 'aria-label': 'Team performance' }, h('h2', {}, 'Team performance'),
      h('p', {}, 'Last 30 days. Hours and counts only.'), data.sources?.timecards === 'unavailable' ? h('p', { role: 'status' }, 'Timecards are unavailable; hours are incomplete.') : null,
      rows.length ? h('ul', {}, rows) : h('p', {}, 'No job activity recorded in this period.'),
      h('p', { class: 'small' }, `As of ${data.asOf}`), kit().button('Refresh', refresh)));
  } catch (error) {
    if (current !== state.generation || state.host !== host) return;
    if (error.status === 401 || error.status === 403) { host.replaceChildren(); host.hidden = true; return; }
    host.replaceChildren(h('section', { class: 'hub-card' }, h('h2', {}, 'Team performance'),
      h('p', { role: 'alert' }, 'Performance could not be loaded. No current totals are shown.'), kit().button('Retry', refresh)));
  }
}
function unmount() { state.generation++; state.controller?.abort(); state.controller = null; state.host?.replaceChildren(); state.host = null; state.ctx = null; }
function mount(host, ctx = {}) {
  unmount(); state.host = host; state.ctx = ctx;
  if (ctx.role !== 'team_lead') { host.replaceChildren(); host.hidden = true; return; }
  return refresh();
}
window.addEventListener('egc:signout', unmount);
window.EGCTeamLeadSummary = { mount, unmount, refresh };
})();
