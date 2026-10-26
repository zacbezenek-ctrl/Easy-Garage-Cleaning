/* Office queue. Request conversion stays in the authenticated company workspace. */
(() => {
'use strict';
const S = { host: null, ctx: null, data: null, error: '', loading: false, generation: 0, cursor: '' };
const kit = () => window.EGCHubKit;
const h = (...args) => kit().h(...args);
function render() {
  if (!S.host) return;
  const rows = S.data?.requests || [];
  S.host.replaceChildren(h('section', { class: 'hub-screen egc-business-requests' },
    h('header', { class: 'hub-head' }, h('div', {}, h('h1', {}, 'Business service requests'), h('p', {}, 'Saved company requests awaiting office review. Creating a job does not price or book it.')),
      kit().button('Refresh', () => { S.cursor = ''; return load(); }, '', { disabled: S.loading })),
    S.error ? h('p', { role: 'alert' }, S.error) : null,
    S.loading ? h('p', { role: 'status' }, 'Loading requests…') : null,
    ...rows.map(row => h('article', { class: 'hub-card' }, h('h2', {}, row.company + ' — ' + row.service),
      h('p', {}, row.propertyName), h('p', {}, row.scope), h('p', {}, 'Preferred date: ' + (row.preferredDate || 'Flexible') + ' (not confirmed)'),
      h('p', {}, row.status), h('a', { href: '/business-hub?staff=1&account=' + encodeURIComponent(row.accountId), class: 'hub-btn' }, 'Open company requests'))),
    !S.loading && !rows.length && !S.error ? h('p', {}, 'No open requests on this page.') : null,
    S.data?.limited ? h('p', {}, 'Only the first page of assigned accounts is available. Ask a business manager to review the complete queue.') : null,
    S.data?.next ? kit().button('Next accounts', () => { S.cursor = S.data.next; return load(); }, '', { disabled: S.loading }) : null));
}
async function load() {
  const generation = ++S.generation; S.loading = true; S.error = ''; render();
  try {
    const data = await kit().requestJSON('/api/business-requests' + (S.cursor ? '?cursor=' + encodeURIComponent(S.cursor) : ''), {
      prefix: 'business_requests', fetcher: S.ctx?.hubFetch, validate: value => Array.isArray(value?.requests) && typeof value.next === 'string',
    });
    if (generation === S.generation) S.data = data;
  } catch (error) { if (generation === S.generation) { S.data = null; S.error = kit().errorText(error); } }
  finally { if (generation === S.generation) { S.loading = false; render(); } }
}
window.EGCBusinessRequests = {
  mount(host, ctx) { S.host = host; S.ctx = ctx || {}; S.data = null; S.cursor = ''; return load(); },
  unmount() { S.generation++; S.host?.replaceChildren(); S.host = null; S.ctx = null; S.data = null; },
  canLeave: () => true, refresh: load,
};
const H = { host: null, ctx: null, generation: 0, controller: null };
async function home() {
  if (!H.host) return;
  const generation = ++H.generation; H.controller?.abort(); H.controller = new AbortController();
  H.host.hidden = false; H.host.replaceChildren(h('p', { role: 'status' }, 'Checking business requests.'));
  try {
    const data = await kit().requestJSON('/api/business-requests', { prefix: 'business_requests', timeout: 15000,
      signal: H.controller.signal, fetcher: H.ctx?.hubFetch, validate: value => Array.isArray(value?.requests) && typeof value.next === 'string' });
    if (generation !== H.generation || !H.host) return;
    const complete = !data.next && data.limited !== true;
    H.host.replaceChildren(h('section', { class: 'hub-card' }, h('h3', {}, 'Business service requests'),
      h('p', {}, `${data.requests.length}${complete ? '' : '+'} awaiting review`),
      complete ? null : h('p', {}, 'More accounts may have requests. Open the queue to continue.'),
      kit().button('Review business requests', () => H.ctx.go?.('business_requests'))));
  } catch (error) {
    if (generation !== H.generation || !H.host) return;
    if (error.status === 401 || error.status === 403) { H.host.replaceChildren(); H.host.hidden = true; return; }
    H.host.replaceChildren(h('section', { class: 'hub-card' }, h('h3', {}, 'Business service requests'),
      h('p', { role: 'alert' }, 'Request count unavailable. This does not mean the queue is empty.'), kit().button('Retry', home)));
  }
}
function clearHome() { ++H.generation; H.controller?.abort(); H.host?.replaceChildren(); H.host = null; H.ctx = null; }
window.EGCBusinessRequestsHome = { mount(host, ctx) { clearHome(); H.host = host; H.ctx = ctx; return home(); }, unmount: clearHome, refresh: home };
window.addEventListener('egc:signout', clearHome);
})();
