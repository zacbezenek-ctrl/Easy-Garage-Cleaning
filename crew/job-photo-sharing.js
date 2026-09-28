(function () {
  'use strict';
  // Manager-only customer portal toggles on the field job's photo tiles.
  // job.js re-renders #field-main wholesale, so this module decorates each
  // render from its own server state and never edits the job record itself.
  const PREFIX = 'egc.photo-sharing.pending.v1.';
  const NAMES = { before: 'Before', after: 'After', progress: 'Progress', damage: 'Damage', walkthrough: 'Walkthrough' };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const S = { host: null, jobId: '', gen: 0, data: null, manager: false, failed: '', busy: '', pending: null, status: '', statusError: false, needsRefresh: '', observer: null, refreshTimer: 0, restoreFocus: '' };

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'className') node.className = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false).map(child => typeof child === 'string' ? document.createTextNode(child) : child));
    return node;
  }
  const name = photo => NAMES[photo.category] || 'Project';
  const valid = data => Boolean(data) && data.ok === true && data.jobId === S.jobId && typeof data.expectedRevision === 'string' && Boolean(data.expectedRevision) && typeof data.viewer === 'string' && Boolean(data.viewer) && Array.isArray(data.photos)
    && data.photos.every(photo => photo && UUID.test(photo.photoId) && typeof photo.visible === 'boolean' && typeof photo.sensitive === 'boolean' && ['hidden', 'shared', 'default'].includes(photo.state));
  const pendingKey = () => S.data?.viewer ? `${PREFIX}${S.data.viewer.toLowerCase()}.${S.jobId}` : '';
  function readPending() {
    try { const value = JSON.parse(sessionStorage.getItem(pendingKey()) || 'null'); return value && value.jobId === S.jobId && UUID.test(value.requestId || '') && UUID.test(value.photoId || '') ? value : null; } catch { return null; }
  }
  function writePending(value) {
    try { const key = pendingKey(); if (!key) return; if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* The in-page copy still allows an exact retry. */ }
  }
  function setStatus(text, error = false) { S.status = text; S.statusError = error; }
  // job.js restores its data-draft fields after a render; any other typed or
  // changed field (the checklist editor, a photo caption, a status reason) and
  // any <details> opened or closed since the render would be lost by a reload.
  function remember() { S.host?.querySelectorAll('details').forEach(details => { details.dataset.psOpen = details.open ? '1' : '0'; }); }
  function unsavedEdits() {
    const active = document.activeElement;
    if (active && S.host.contains(active) && active.matches('textarea, input:not([type=file]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])')) return true;
    for (const field of S.host.querySelectorAll('input, textarea, select')) {
      if (field.dataset.draft || field.disabled) continue;
      if (field.tagName === 'SELECT') { const initial = [...field.options].filter(option => option.defaultSelected).pop() || [...field.options].find(option => !option.disabled); if (field.value !== (initial?.value ?? '')) return true; }
      else if (['checkbox', 'radio'].includes(field.type)) { if (field.checked !== field.defaultChecked) return true; }
      else if (!['file', 'hidden', 'button', 'submit', 'reset'].includes(field.type) && field.value !== field.defaultValue) return true;
    }
    return [...S.host.querySelectorAll('details')].some(details => details.open !== (details.dataset.psOpen === '1'));
  }
  function refreshJob() { const reload = S.host?.querySelector('[data-action="reload"]'); if (!reload || reload.disabled) return false; S.needsRefresh = ''; reload.click(); return true; }

  async function call(input) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch(input ? '/api/field-photo-sharing' : `/api/field-photo-sharing?jobId=${encodeURIComponent(S.jobId)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) });
    } catch { throw Object.assign(new Error('The server did not confirm this. Check your connection, then retry; the same change is never saved twice.'), { status: 0 }); }
    finally { clearTimeout(timer); }
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok !== true) throw Object.assign(new Error(data?.error || 'Photo sharing is temporarily unavailable.'), { status: response.status, code: data?.code || '' });
    if (!valid(data)) throw Object.assign(new Error('Photo sharing could not be verified. Retry.'), { status: 503, code: 'unverified' });
    return data;
  }

  async function load() {
    if (!S.host) return;
    const gen = ++S.gen;
    try {
      const data = await call();
      if (gen !== S.gen) return;
      S.data = data; S.manager = true; S.failed = ''; S.pending = readPending();
    } catch (error) {
      if (gen !== S.gen) return;
      S.data = null;
      // Crew (403), the flag being off (404) and signed-out pages show nothing.
      S.failed = [401, 403, 404].includes(error.status) || !S.manager && error.status < 500 ? '' : error.message;
      if (!S.failed) S.manager = false;
    }
    decorate();
  }

  async function send(input) {
    if (S.busy) return;
    S.busy = input.photoId; S.pending = input; writePending(input); setStatus('Saving customer photo sharing…'); decorate();
    const gen = ++S.gen;
    try {
      const data = await call(input);
      if (gen !== S.gen || !S.host) return;
      S.data = data; S.pending = null; writePending(null);
      setStatus(data.alreadyApplied ? 'This change was already saved. The current sharing is shown.' : input.customerVisible ? 'Shared on the customer’s project page.' : 'Hidden from the customer.');
      // Bring job.js onto the new job version so its next action is not stale,
      // but never by throwing away edits the manager has not saved yet.
      if (unsavedEdits()) S.needsRefresh = 'edits';
      else { S.restoreFocus = input.photoId; if (!refreshJob()) { S.restoreFocus = ''; S.needsRefresh = 'busy'; } }
    } catch (error) {
      if (gen !== S.gen || !S.host) return;
      if (!error.status || error.status >= 500 || [401, 403, 408, 429].includes(error.status)) setStatus(`${error.message} Retry sends the same change.`, true);
      else {
        S.pending = null; writePending(null);
        setStatus(error.code === 'FIELD_REVISION_CONFLICT' ? 'This job changed on the server. The latest photo sharing is shown; review it and tap again if needed.' : error.message, true);
        S.busy = ''; await load(); return;
      }
    } finally { if (S.busy === input.photoId) S.busy = ''; }
    decorate();
  }

  function toggle(photoId) {
    const photo = S.data?.photos.find(item => item.photoId === photoId);
    if (!photo || S.busy || S.pending) return;
    const next = !photo.visible;
    if (next && photo.sensitive && !window.confirm(`Share this ${name(photo).toLowerCase()} photo with the customer? ${name(photo)} photos stay internal unless a manager shares them. The customer will see it on their project page.`)) return;
    send({ jobId: S.jobId, photoId, customerVisible: next, ...(next && photo.sensitive ? { confirm: true } : {}), requestId: crypto.randomUUID(), expectedRevision: S.data.expectedRevision, expectedUser: S.data.viewer });
  }

  function detail(photo) {
    if (S.busy === photo.photoId) return 'Saving…';
    if (photo.state === 'hidden') return photo.hiddenBy ? `Hidden by ${photo.hiddenBy}` : 'Hidden by a manager';
    if (photo.state === 'shared') return photo.sharedBy ? `Shared by ${photo.sharedBy}` : 'Shared by a manager';
    return photo.reason === 'completed' ? 'Shown after completion' : photo.reason === 'awaiting_completion' ? 'Shows when the job completes' : photo.reason === 'before_cutoff' ? 'Added before customer photos began' : 'Internal only';
  }
  function paint(button, photo) {
    const text = detail(photo), visible = photo.visible;
    button.className = `ps-toggle${visible ? ' on' : ''}`;
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', `${name(photo)} photo: ${visible ? 'the customer can see it' : 'not shown to the customer'}. ${text}. ${visible ? 'Hide it from' : 'Share it with'} the customer.`);
    button.disabled = Boolean(S.busy || S.pending);
    const state = visible ? 'Customer can see' : 'Not shown to customer';
    if (button.firstChild?.textContent !== state || button.lastChild?.textContent !== text) button.replaceChildren(h('span', { className: 'ps-state' }, state), h('small', null, text));
  }

  function panel(card, grid) {
    let box = card.querySelector('.ps-panel');
    if (!box) { box = h('div', { className: 'ps-panel', role: 'group', 'aria-label': 'Customer portal photos' }, h('p', { className: 'ps-note' }), h('p', { className: 'ps-status', role: 'status', 'aria-live': 'polite' }), h('div', { className: 'ps-actions' })); grid.before(box); }
    const [note, status, actions] = box.children;
    const copy = S.failed ? 'Customer photo sharing could not be loaded. Tiles show no sharing controls until it is verified.' : S.data.jobComplete
      ? 'Customer portal: before and after photos now show on the customer’s project page. Hide any that should stay internal. Damage, progress and walkthrough photos stay internal unless you share them.'
      : 'Customer portal: before and after photos show on the customer’s project page when the job is completed. Share one to show it now, or hide it. Damage, progress and walkthrough photos stay internal unless you share them.';
    const older = !S.failed && S.data.photos.some(photo => photo.reason === 'before_cutoff') ? ' Photos added before customer photos began stay internal unless you share them.' : '';
    if (note.textContent !== copy + older) note.textContent = copy + older;
    const stale = S.needsRefresh ? `Tap Refresh job before your next change on this page so it uses the latest job version. ${S.needsRefresh === 'edits' ? 'It was not refreshed automatically because you have unsaved edits here.' : 'It was not refreshed automatically because the job page is busy.'}` : '';
    const message = S.failed || [S.status, stale].filter(Boolean).join(' ');
    if (status.textContent !== message) status.textContent = message;
    status.classList.toggle('error', Boolean(S.failed) || S.statusError);
    const buttons = S.failed ? [h('button', { type: 'button', dataset: { psAction: 'reload' } }, 'Retry photo sharing')]
      : S.pending && !S.busy ? [h('button', { type: 'button', className: 'primary', dataset: { psAction: 'retry' } }, 'Retry sharing change'), h('button', { type: 'button', dataset: { psAction: 'discard' } }, 'Discard and load latest')]
        : S.needsRefresh && !S.busy ? [h('button', { type: 'button', dataset: { psAction: 'refresh-job' } }, 'Refresh job now')] : [];
    if (actions.children.length !== buttons.length || [...actions.children].some((button, index) => button.dataset.psAction !== buttons[index].dataset.psAction)) actions.replaceChildren(...buttons);
  }

  function decorate() {
    if (!S.host) return;
    const card = S.host.querySelector('#photos-card'), grid = card?.querySelector('.photo-grid');
    if (!grid) return;
    const tiles = [...grid.querySelectorAll('.photo-tile[data-photo]')];
    if (!S.data && !S.failed || !tiles.length) { card.querySelector('.ps-panel')?.remove(); grid.querySelectorAll('.ps-toggle').forEach(button => button.remove()); return; }
    panel(card, grid);
    let unknown = false;
    for (const tile of tiles) {
      let wrap = tile.parentElement;
      if (!wrap.classList.contains('ps-tile')) { wrap = h('div', { className: 'ps-tile' }); tile.replaceWith(wrap); wrap.append(tile); }
      const photo = S.data?.photos.find(item => item.photoId === tile.dataset.photo);
      let button = wrap.querySelector('.ps-toggle');
      if (!photo) { button?.remove(); unknown = unknown || Boolean(S.data); continue; }
      if (!button) { button = h('button', { type: 'button', dataset: { psPhoto: photo.photoId } }); wrap.append(button); }
      paint(button, photo);
    }
    // A photo uploaded since the last read: fetch the current sharing once.
    if (unknown && !S.busy) schedule();
    if (S.restoreFocus && !S.busy) {
      const target = [...grid.querySelectorAll('.ps-toggle')].find(button => button.dataset.psPhoto === S.restoreFocus);
      if (target && (!document.activeElement || document.activeElement === document.body)) { target.focus({ preventScroll: true }); S.restoreFocus = ''; }
    }
  }

  function schedule() {
    clearTimeout(S.refreshTimer);
    S.refreshTimer = setTimeout(() => { S.refreshTimer = 0; if (!S.busy) load(); }, 400);
  }

  function onClick(event) {
    const toggleButton = event.target.closest?.('.ps-toggle');
    if (toggleButton && S.host.contains(toggleButton)) { if (!toggleButton.disabled) toggle(toggleButton.dataset.psPhoto); return; }
    // Any job.js reload (its own Refresh or ours) brings it onto the latest version.
    if (event.target.closest?.('[data-action="reload"]')) { S.needsRefresh = ''; return; }
    const action = event.target.closest?.('[data-ps-action]')?.dataset.psAction;
    if (action === 'refresh-job') { if (!unsavedEdits() || window.confirm('Refresh the job now? Unsaved changes on this page, such as checklist edits, will be cleared.')) { setStatus(''); if (!refreshJob()) { setStatus('The job is busy saving. Tap Refresh job when it finishes.', true); decorate(); } } }
    else if (action === 'retry' && S.pending) send(S.pending);
    else if (action === 'discard') { S.pending = null; writePending(null); setStatus(''); load(); }
    else if (action === 'reload') load();
  }
  // job.js replaces the host's children on every render; re-read sharing so
  // the next change carries the job version that render came from.
  function onRender() { remember(); decorate(); if (S.manager && !S.busy) schedule(); }
  // An unconfirmed change stays retryable from sessionStorage, but leaving
  // mid-save would hide whether it landed.
  function onLeave(event) { if (S.busy) { event.preventDefault(); event.returnValue = ''; } }
  function onSignout() {
    try { for (let index = sessionStorage.length - 1; index >= 0; index--) { const key = sessionStorage.key(index); if (key?.startsWith(PREFIX)) sessionStorage.removeItem(key); } } catch { /* Nothing stored. */ }
    unmount();
  }

  function mount(host, jobId = new URLSearchParams(location.search).get('jobId') || '') {
    unmount();
    if (!host || !jobId) return;
    S.host = host; S.jobId = jobId;
    host.addEventListener('click', onClick);
    S.observer = new MutationObserver(onRender); S.observer.observe(host, { childList: true }); remember();
    window.addEventListener('egc:signout', onSignout); window.addEventListener('beforeunload', onLeave);
    load();
  }
  function unmount() {
    if (!S.host) return;
    S.observer?.disconnect(); clearTimeout(S.refreshTimer); S.host.removeEventListener('click', onClick); window.removeEventListener('egc:signout', onSignout); window.removeEventListener('beforeunload', onLeave);
    S.host.querySelectorAll('.ps-panel, .ps-toggle').forEach(node => node.remove());
    S.host.querySelectorAll('.ps-tile').forEach(wrap => wrap.replaceWith(...wrap.childNodes));
    Object.assign(S, { host: null, jobId: '', gen: S.gen + 1, data: null, manager: false, failed: '', busy: '', pending: null, status: '', statusError: false, needsRefresh: '', observer: null, refreshTimer: 0, restoreFocus: '' });
  }

  window.EGCJobPhotoSharing = { mount, unmount, canLeave: () => !S.busy, refresh: load };
  const main = document.getElementById('field-main');
  if (main) mount(main);
})();
