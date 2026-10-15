// Online-only native forms. The offline sales/door outbox never submits a provider form.
import { h, mount, fullScreen, banner, kv, loadingState, confirmSheet, uuid } from './knock-ui.js';
import { houseLabel } from './knock-doors.js';

const ENDPOINT = '/api/knock-form-handoff';
const CHANNEL_LABEL = { direct_sale: 'Quote / direct sale', walkthrough_request: 'Request a walkthrough' };
const HOSTS = ['api.leadconnectorhq.com', 'links.easygaragecleaning.com'];

export function nativeLaunchUrl(launch, reference) {
  try {
    const url = new URL(launch.url), entries = [...url.searchParams];
    return /^kf_[0-9a-f]{32}$/.test(reference) && /^[A-Za-z0-9_-]{8,120}$/.test(launch.formId) &&
      url.protocol === 'https:' && HOSTS.includes(url.hostname) && !url.port && !url.username && !url.password && !url.hash &&
      url.pathname === `/widget/form/${launch.formId}` && entries.length === 1 && entries[0][0] === launch.referenceQueryKey && entries[0][1] === reference
      ? url.href : null;
  } catch { return null; }
}

export function createNativeFormSession({ api, online, pending, houseId }) {
  const connected = () => {
    if (!online()) throw new Error('Offline: records saved on this phone have not been sent to GHL. Reconnect, sync, then retry.');
  };
  const ready = () => {
    connected();
    if (pending()) throw new Error('Sync this house’s saved records to the Hub before opening GHL. They have not been sent to GHL.');
  };
  return {
    async load() { connected(); return api(`${ENDPOINT}?houseId=${encodeURIComponent(houseId)}`); },
    async begin(channel, source) {
      ready();
      const result = await api(ENDPOINT, { method: 'POST', body: { action: 'create', houseId, channel, source } });
      ready();
      return api(ENDPOINT, { method: 'POST', body: { action: 'open', reference: result.handoff.reference } });
    },
    async open(reference) { ready(); return api(ENDPOINT, { method: 'POST', body: { action: 'open', reference } }); },
    async discover(reference) { ready(); return api(ENDPOINT, { method: 'POST', body: { action: 'discover', reference } }); },
  };
}

// A load, redirect, provider message or timer never invokes receipt verification.
export function nativeFrame(launch, reference, { document: doc = document, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const url = nativeLaunchUrl(launch, reference);
  if (!url) throw new Error('The GHL form URL could not be verified. Nothing was opened.');
  const wrapper = doc.createElement('div'), status = doc.createElement('p'), frame = doc.createElement('iframe');
  status.setAttribute('role', 'status');
  status.textContent = 'Loading GHL. Submission has not been verified.';
  frame.setAttribute('title', 'Easy Garage Cleaning native intake form');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('style', 'width:100%;min-height:640px;border:0;background:white');
  const timer = setTimer(() => { status.textContent = 'If GHL is blank, retry opening it. If you already submitted, check its receipt before submitting again.'; }, 15000);
  frame.addEventListener('load', () => {
    clearTimer(timer);
    status.textContent = 'GHL opened. This does not confirm submission. Check the GHL receipt after sending.';
  });
  frame.addEventListener('error', () => { clearTimer(timer); status.textContent = 'GHL could not load. Your Hub record is saved; submission has not been verified.'; });
  frame.src = url;
  wrapper.append(status, frame);
  return { element: wrapper, dispose: () => { clearTimer(timer); frame.removeAttribute('src'); } };
}

function statusPanel(handoff) {
  const s = handoff.states;
  return h('section', { class: 'card' },
    h('strong', {}, CHANNEL_LABEL[handoff.channel]),
    handoff.revoked ? h('p', {}, 'Released by a manager. This old reference cannot be used again.') : null,
    kv('Hub saved', s.hubSaved ? 'Yes' : 'No'),
    kv('GHL submission verified', s.submissionVerified ? 'Yes' : 'Not yet'),
    kv('GHL contact linked', s.contactLinked ? 'Yes, to this receipt' : 'Not yet'),
    kv('Job / walkthrough linked by form', 'No'),
    kv('Customer collection', 'Check the collection ledger'),
    kv('Commission eligibility / payable', 'Separate review; no award from this form'));
}

async function openPanel(app, house) {
  const session = createNativeFormSession({ api: app.api, online: () => app.S.online && navigator.onLine,
    pending: () => [...app.S.pending, ...app.S.problems].some(row => row.houseId === house.id), houseId: house.id });
  let embedded;
  await fullScreen('GHL intake', houseLabel(house), () => {
    const box = h('div', { class: 'screen' }, loadingState(2));
    const error = err => mount(box, banner('warn', 'alert', err.message), h('button', { class: 'btn btn--secondary', onclick: load }, 'Retry'));
    async function show(result) {
      embedded?.dispose();
      const handoff = result.handoff;
      const feedback = h('p', { role: 'status' }, result.discovery === 'not_visible_yet' ? 'No matching submission is visible yet. If you submitted, wait and check again before resubmitting.' : '');
      const check = h('button', { type: 'button', class: 'btn btn--secondary', onclick: async () => {
        check.disabled = true;
        try { await show(await session.discover(handoff.reference)); }
        catch (err) { feedback.textContent = err.message; check.disabled = false; }
      } }, 'Check submission');
      embedded = result.launch && !handoff.states.submissionVerified ? nativeFrame(result.launch, handoff.reference) : null;
      mount(box, statusPanel(handoff), embedded?.element,
        handoff.states.submissionVerified || handoff.revoked ? null : h('section', { class: 'card' },
          h('p', {}, 'Check for this request in GHL after submitting. A form submission does not book a job or award commission.'),
          check, feedback,
          h('button', { type: 'button', class: 'btn btn--quiet', onclick: async () => { try { await show(await session.open(handoff.reference)); } catch (err) { feedback.textContent = err.message; } } }, 'Reopen same form reference')),
        h('button', { type: 'button', class: 'btn btn--quiet', onclick: load }, 'Back to saved requests'));
    }
    async function load() {
      embedded?.dispose(); embedded = null;
      try {
        const data = await session.load();
        const select = h('select', { class: 'input', 'aria-label': 'Saved quote or sale' }, data.sources.map((source, i) =>
          h('option', { value: String(i) }, `${source.kind === 'sale' ? 'Saved sale' : 'Saved look / quote'} ${source.id.slice(-8)}`)));
        const feedback = h('p', { role: 'status' });
        const start = channel => async () => {
          try { await show(await session.begin(channel, data.sources[Number(select.value)])); }
          catch (err) { feedback.textContent = err.message; }
        };
        mount(box,
          data.setup.enabled ? banner('info', 'info', 'Online GHL intake', 'A saved Look can request a walkthrough without logging Sold. A submitted form alone does not create a job or earn commission.')
            : banner('warn', 'alert', 'GHL setup required', data.setup.message),
          app.S.pending.some(row => row.houseId === house.id) ? banner('warn', 'wifiOff', 'Saved on this phone', 'Sync to the Hub first. These records have not been sent to GHL.') : null,
          data.sources.length ? select : h('p', {}, 'Save and sync a Look or a sale for this house first.'),
          h('button', { class: 'btn btn--primary', disabled: !data.setup.enabled || !data.sources.length, onclick: start('direct_sale') }, CHANNEL_LABEL.direct_sale),
          h('button', { class: 'btn btn--secondary', disabled: !data.setup.enabled || !data.sources.length, onclick: start('walkthrough_request') }, CHANNEL_LABEL.walkthrough_request), feedback,
          data.handoffs.map(handoff => h('section', { class: 'card' }, statusPanel(handoff),
            h('button', { class: 'btn btn--quiet', onclick: () => show({ handoff }) }, 'View saved request'))));
      } catch (err) { error(err); }
    }
    load();
    return box;
  });
  embedded?.dispose();
}

export function install(app) { app.nativeFormForHouse = house => openPanel(app, house); }

export async function nativeRecoveryAdmin(app) {
  const box = h('div', { class: 'screen' }), feedback = h('p', { role: 'status' });
  const house = h('input', { class: 'input', 'aria-label': 'House record ID', placeholder: 'House record ID' });
  const detail = h('div');
  async function inspect(houseId) {
    try {
      const data = await app.api(`/api/knock-form-recovery?houseId=${encodeURIComponent(houseId)}`);
      const reason = h('textarea', { class: 'input', 'aria-label': 'Reason for releasing abandoned requests', maxLength: 500 });
      const requestId = uuid();
      const release = h('button', { class: 'btn btn--danger', disabled: !data.recoverable, onclick: async () => {
        if (reason.value.trim().length < 10) { feedback.textContent = 'Enter a reason of at least 10 characters.'; return; }
        if (!await confirmSheet('Release abandoned requests?', 'Every current form reference for this house will stop working. No sale, job, payment or commission will change. A rep must explicitly create a new request.', 'Release requests', 'danger')) return;
        release.disabled = true;
        try {
          await app.api('/api/knock-form-recovery', { method: 'POST', body: { action: 'release', houseId, requestId,
            expectedGeneration: data.generation, expectedSnapshot: data.snapshot, reason: reason.value.trim(), confirmation: 'release_abandoned_forms' } });
          feedback.textContent = 'Released and recorded in the audit history. Old references cannot be reused.';
          await inspect(houseId);
        } catch (error) { feedback.textContent = error.message; release.disabled = false; }
      } }, 'Release abandoned requests');
      mount(detail, h('section', { class: 'card' }, h('strong', {}, houseId),
        kv('Current rep', data.claim?.repKey || 'None'), kv('Channel', CHANNEL_LABEL[data.claim?.channel] || 'None'),
        data.recoverable ? h('p', {}, 'Only unverified requests can be released. Confirm abandonment with the rep first.') : h('p', {}, `Review required: ${data.blockers.join(', ')}`),
        data.references.map(r => h('p', {}, r.reference)), reason, release));
    } catch (error) { feedback.textContent = error.message; }
  }
  const data = await app.api('/api/knock-form-recovery');
  mount(box, h('p', {}, 'Recent requests. Release only after confirming they were abandoned; verified submissions and sales require separate review.'),
    data.limited ? h('p', {}, 'Showing the most recent 25 requests. Enter a house record ID for older requests.') : null,
    data.rows.map(row => h('button', { class: 'btn btn--secondary', onclick: () => inspect(row.houseId) }, `${row.houseId} · ${row.claim?.repKey || 'released'}`)),
    house, h('button', { class: 'btn btn--secondary', onclick: () => inspect(house.value.trim()) }, 'Find house'), detail, feedback);
  return { body: box };
}
