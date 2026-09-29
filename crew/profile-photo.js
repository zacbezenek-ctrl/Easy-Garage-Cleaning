(function () {
  'use strict';
  // Crew photo page (P4-07). Employees upload or remove their own headshot; owners and managers also review
  // pending photos and choose each crew member's customer-facing first name and visibility. A customer sees a
  // profile only after a manager approves the photo and shows it. Nothing here sends anything to a customer.
  const PREFIX = 'egc.crew-profile.pending.v1.';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const USER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  const PHOTO_URL = /^\/api\/crew-public-profile\?photo=[a-z0-9._-]{1,64}(?:&state=pending)?&v=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const DRAFT_PHOTO = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
  const MAX_SIDE = 720, TIMEOUT = 60000;
  const S = { host: null, gen: 0, loads: 0, data: null, loading: false, failed: '', signedOut: false, busy: false, pending: null, status: '', statusError: false };

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false).map(child => typeof child === 'string' ? document.createTextNode(child) : child));
    return node;
  }
  const photoOk = photo => photo === null || Boolean(photo) && typeof photo === 'object' && UUID.test(photo.requestId || '') && PHOTO_URL.test(photo.url || '');
  const profileOk = row => Boolean(row) && USER.test(row.username || '') && typeof row.firstName === 'string' && typeof row.displayName === 'string' && typeof row.active === 'boolean' && [true, false, null].includes(row.onRoster) && typeof row.customerVisible === 'boolean' && typeof row.uploadInProgress === 'boolean' && typeof row.revision === 'string' && photoOk(row.photo) && photoOk(row.pendingPhoto);
  const valid = data => Boolean(data) && data.ok === true && Boolean(data.viewer) && USER.test(data.viewer.username || '') && typeof data.viewer.manager === 'boolean' && typeof data.customerProfilesEnabled === 'boolean' && Array.isArray(data.profiles) && data.profiles.every(profileOk) && data.profiles.some(row => row.username === data.viewer.username);
  const nameOf = row => row.displayName || row.firstName || row.username;
  const me = () => S.data?.viewer?.username || '';
  const pendingKey = () => me() ? PREFIX + me() : '';
  function readPending() {
    try { const value = JSON.parse(sessionStorage.getItem(pendingKey()) || 'null'); return value && value.body && UUID.test(value.body.requestId || '') && typeof value.label === 'string' ? value : null; } catch { return null; }
  }
  function writePending(value) {
    try { const key = pendingKey(); if (!key) return; if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* The in-page copy still allows an exact retry. */ }
  }
  function forgetPending() {
    try { for (let index = sessionStorage.length - 1; index >= 0; index--) { const key = sessionStorage.key(index) || ''; if (key.startsWith(PREFIX)) sessionStorage.removeItem(key); } } catch { /* Nothing was stored. */ }
  }
  function setStatus(text, error = false) { S.status = text; S.statusError = error; }
  // Every change reloads the profiles, and the cards stay on screen meanwhile with the older revisions. Until the
  // latest profiles are drawn nothing can be typed, ticked or sent: the reload would wipe the edit, and a save would
  // go out against a revision the change just replaced.
  const locked = () => S.busy || S.loading;

  async function call(body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT);
    let response;
    try {
      response = await fetch('/api/crew-public-profile', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    } catch { throw Object.assign(new Error('The server did not confirm this. Check your connection, then retry; the same change is never saved twice.'), { status: 0 }); }
    finally { clearTimeout(timer); }
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok !== true) throw Object.assign(new Error(data?.error || 'Crew photos are temporarily unavailable.'), { status: response.status, code: data?.code || '' });
    return data;
  }

  async function load() {
    if (!S.host) return;
    const gen = S.gen, seq = ++S.loads;
    S.loading = true; S.failed = ''; render();
    try {
      const data = await call();
      if (gen !== S.gen || seq !== S.loads) return;
      if (!valid(data)) throw Object.assign(new Error('Crew photos could not be verified. Retry.'), { status: 503 });
      S.data = data; S.signedOut = false; S.pending = S.pending || readPending();
    } catch (error) {
      if (gen !== S.gen || seq !== S.loads) return;
      S.data = null; S.signedOut = error.status === 401; S.failed = error.message;
    } finally { if (gen === S.gen && seq === S.loads) { S.loading = false; render(); } }
  }

  // Every change is saved in this tab before it is sent; a lost answer is retried with the same request ID.
  // A photo that lost a revision race stays as a draft that can be sent again against the latest profile.
  async function mutate(body, label) {
    if (locked() || !S.data) return;
    const request = { ...body, requestId: UUID.test(body.requestId || '') ? body.requestId : crypto.randomUUID() }, gen = S.gen;
    S.pending = { body: request, label }; writePending(S.pending);
    S.busy = true; setStatus(`${label}: saving…`); render();
    try {
      const result = await call(request);
      if (gen !== S.gen) return;
      if (result.requestId !== request.requestId.toLowerCase() || !profileOk(result.profile) || result.profile.username !== request.username) throw Object.assign(new Error('The server answer could not be verified.'), { status: 503 });
      S.pending = null; writePending(null);
      setStatus(result.replayed ? `${label}: already saved.` : `${label}: saved.`);
    } catch (error) {
      if (gen !== S.gen) return;
      const draft = error.code === 'crew_profile_revision_conflict' && request.action === 'upload_photo' && DRAFT_PHOTO.test(request.dataUrl || '');
      const keep = draft || !error.status || error.status >= 500 || [401, 403, 408, 429].includes(error.status);
      if (!keep) { S.pending = null; writePending(null); }
      if (draft) { S.pending = { body: request, label, conflict: true }; writePending(S.pending); }
      setStatus(draft ? `${error.message} Your photo is kept: send it again or discard it below.` : keep ? `${error.message} Use “Retry original save” below; it cannot save twice.` : error.message, true);
    } finally {
      if (gen === S.gen) { S.busy = false; await load(); }
    }
  }

  // A square, centred crop no larger than 720 px, re-encoded as JPEG (iPhone HEIC photos included).
  async function prepare(file) {
    if (!file || !/^image\//i.test(file.type || '')) throw new Error('Choose a photo (JPG, PNG, WebP or an iPhone photo).');
    if (file.size > 30 * 1024 * 1024) throw new Error('This photo is too large. Choose a smaller photo.');
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('This photo could not be read. Choose a JPG or PNG photo.')); img.src = url; });
      const side = Math.min(image.naturalWidth, image.naturalHeight), out = Math.min(MAX_SIDE, side);
      if (!side) throw new Error('This photo could not be read. Choose another photo.');
      const canvas = document.createElement('canvas'); canvas.width = out; canvas.height = out;
      canvas.getContext('2d').drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, out, out);
      const data = canvas.toDataURL('image/jpeg', 0.86);
      if (!/^data:image\/jpeg;base64,/.test(data)) throw new Error('This photo could not be prepared. Choose another photo.');
      return data;
    } finally { URL.revokeObjectURL(url); }
  }
  async function upload(input, row) {
    const file = input.files?.[0]; input.value = '';
    if (!file || locked()) return;
    setStatus('Preparing the photo…'); render();
    let dataUrl;
    try { dataUrl = await prepare(file); } catch (error) { setStatus(error.message, true); render(); return; }
    await mutate({ action: 'upload_photo', username: row.username, expectedRevision: row.revision, dataUrl }, row.username === me() ? 'Your photo' : `Photo for ${nameOf(row)}`);
  }

  function avatar(row, photo, small = false) {
    const size = small ? 64 : 88, className = `cp-avatar${small ? ' small' : ''}`;
    if (photo && PHOTO_URL.test(photo.url)) return h('img', { class: className, src: photo.url, alt: `${nameOf(row)} crew photo`, width: size, height: size, decoding: 'async' });
    return h('span', { class: className, 'aria-hidden': 'true' }, (row.firstName || nameOf(row)).trim().charAt(0).toUpperCase() || '?');
  }
  function badges(row) {
    return h('div', { class: 'cp-badges' }, row.onRoster === false ? h('span', { class: 'cp-badge off' }, 'Not on the roster') : null,
      h('span', { class: `cp-badge${row.customerVisible ? ' on' : ''}` }, row.customerVisible ? 'Shown to customers' : 'Hidden from customers'),
      h('span', { class: `cp-badge${row.photo ? ' on' : ''}` }, row.photo ? 'Photo approved' : 'No approved photo'),
      row.pendingPhoto ? h('span', { class: 'cp-badge wait' }, 'Photo waiting for approval') : null);
  }
  // Someone who left the roster can only be hidden and have their photo removed (the server refuses the rest).
  function photoButtons(row, own, departed = false) {
    const pick = (text, extra) => h('label', { class: 'cp-btn primary', 'aria-disabled': locked() ? 'true' : null }, text, h('input', { type: 'file', class: 'cp-file', accept: 'image/*', disabled: locked(), ...extra, onchange: event => upload(event.target, row) }));
    const remove = () => { if (window.confirm(own ? 'Remove your crew photo? Customers stop seeing it right away.' : `Remove ${nameOf(row)}’s crew photo? Customers stop seeing it right away.`)) mutate({ action: 'remove_photo', username: row.username, expectedRevision: row.revision }, own ? 'Remove your photo' : `Remove photo for ${nameOf(row)}`); };
    const hide = () => mutate({ action: 'set_profile', username: row.username, expectedRevision: row.revision, firstName: row.firstName, active: false }, `Hide ${nameOf(row)} from customers`);
    return h('div', { class: 'cp-actions' },
      departed ? null : [pick(own ? 'Take a selfie' : 'Take a photo', { capture: own ? 'user' : 'environment' }), pick('Choose a photo')],
      row.photo || row.pendingPhoto || row.uploadInProgress ? h('button', { type: 'button', class: 'cp-btn danger', disabled: locked(), onclick: remove }, own ? 'Remove my photo' : 'Remove photo') : null,
      departed && row.active ? h('button', { type: 'button', class: 'cp-btn danger', disabled: locked(), onclick: hide }, 'Hide from customers') : null);
  }
  function pendingPhoto(row, manager, departed = false) {
    if (!row.pendingPhoto) return null;
    const review = action => mutate({ action, username: row.username, expectedRevision: row.revision, photoRequestId: row.pendingPhoto.requestId }, `${action === 'approve_photo' ? 'Approve' : 'Reject'} photo for ${nameOf(row)}`);
    return h('div', { class: 'cp-pending' }, avatar(row, row.pendingPhoto, true),
      h('div', {}, h('strong', {}, manager ? 'New photo to review' : 'Waiting for a manager to approve this photo'), h('p', { class: 'cp-muted' }, departed ? 'This person is no longer on the roster, so this photo can only be rejected.' : manager ? 'Approve only a clear, friendly headshot of this person.' : 'Customers keep seeing the approved photo (if any) until then.'),
        manager ? h('div', { class: 'cp-actions' }, departed ? null : h('button', { type: 'button', class: 'cp-btn primary', disabled: locked(), onclick: () => review('approve_photo') }, 'Approve photo'), h('button', { type: 'button', class: 'cp-btn danger', disabled: locked(), onclick: () => review('reject_photo') }, 'Reject photo')) : null));
  }
  function profileForm(row) {
    const first = h('input', { type: 'text', id: `cp-first-${row.username}`, value: row.firstName, maxlength: 30, autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', enterkeyhint: 'done', disabled: locked() });
    const shown = h('input', { type: 'checkbox', checked: row.active, disabled: locked() });
    const save = event => { event.preventDefault(); mutate({ action: 'set_profile', username: row.username, expectedRevision: row.revision, firstName: first.value.trim(), active: shown.checked }, `Profile for ${nameOf(row)}`); };
    return h('form', { class: 'cp-form', onsubmit: save },
      h('label', { class: 'cp-field', for: first.id }, 'First name customers see (one word)', first),
      h('label', { class: 'cp-check' }, shown, 'Show to customers on jobs this person is assigned to'),
      h('button', { type: 'submit', class: 'cp-btn', disabled: locked() }, 'Save profile'));
  }
  function card(row, own, manager) {
    const departed = manager && !own && row.onRoster === false;
    return h('section', { class: 'cp-card', 'aria-label': own ? 'Your crew photo' : `${nameOf(row)} crew profile` },
      h('div', { class: 'cp-person' }, avatar(row, row.photo), h('div', {}, h('h3', {}, own ? 'Your photo' : nameOf(row)), h('small', {}, `@${row.username}${row.firstName ? ` · customers see “${row.firstName}”` : ''}`), badges(row))),
      departed ? h('p', { class: 'cp-muted' }, row.customerVisible || row.photo || row.pendingPhoto ? 'This person is no longer on the employee roster. Remove their photo and hide them from customers.' : 'This person is no longer on the employee roster. Nothing of theirs is shown to customers.') : null,
      row.uploadInProgress && !row.pendingPhoto ? h('p', { class: 'cp-muted' }, 'An upload was started and not finished. Retry it or choose the photo again.') : null,
      pendingPhoto(row, manager, departed), photoButtons(row, own, departed), manager && !departed ? profileForm(row) : null);
  }
  function pendingCard() {
    const conflict = S.pending.conflict === true && S.pending.body.action === 'upload_photo' && DRAFT_PHOTO.test(S.pending.body.dataUrl || '');
    const discard = h('button', { type: 'button', class: 'cp-btn', disabled: locked(), onclick: () => { S.pending = null; writePending(null); setStatus(''); if (conflict) load(); else render(); } }, conflict ? 'Discard draft and load latest' : 'Discard this change');
    if (!conflict) return h('section', { class: 'cp-card', role: 'alert' }, h('h2', {}, 'A change is not confirmed yet'), h('p', {}, `${S.pending.label}. It keeps its request ID, so retrying can never save it twice.`),
      h('div', { class: 'cp-actions' }, h('button', { type: 'button', class: 'cp-btn primary', disabled: locked(), onclick: () => mutate(S.pending.body, S.pending.label) }, 'Retry original save'), discard));
    // The draft goes out as a new request against the latest revision, so it can never overwrite a change unseen.
    const latest = S.data?.profiles.find(row => row.username === S.pending.body.username);
    const resend = () => { if (latest) mutate({ ...S.pending.body, requestId: crypto.randomUUID(), expectedRevision: latest.revision }, S.pending.label); };
    return h('section', { class: 'cp-card', role: 'alert', 'aria-label': 'Photo not saved yet' }, h('h2', {}, 'This photo was not saved yet'),
      h('div', { class: 'cp-pending' }, h('img', { class: 'cp-avatar small', src: S.pending.body.dataUrl, alt: 'The photo you chose', width: 64, height: 64 }),
        h('p', {}, `${S.pending.label}: the profile changed before this photo was saved (another upload, a removal or a manager’s change). Check the latest profile below, then send this photo again or discard it.`)),
      h('div', { class: 'cp-actions' }, h('button', { type: 'button', class: 'cp-btn primary', disabled: locked() || !latest, onclick: resend }, 'Send this photo again'), discard));
  }
  function render() {
    if (!S.host) return;
    const nodes = [h('h1', {}, 'Crew photo'), h('p', { class: 'cp-muted' }, 'Customers see your first name and approved photo on their project page for jobs you are assigned to. Your last name, phone number and pay are never shown.'),
      h('div', { class: `cp-status${S.statusError ? ' error' : ''}`, role: S.statusError ? 'alert' : 'status', 'aria-live': 'polite' }, S.status)];
    if (!S.data) {
      if (S.loading) nodes.push(h('div', { class: 'cp-skeleton', 'aria-busy': 'true' }, h('span', { class: 'cp-sr' }, 'Loading your crew profile…'), h('span', { class: 'wide' }), h('span', {}), h('span', {})));
      else if (S.signedOut) nodes.push(h('section', { class: 'cp-card' }, h('h2', {}, 'Sign in first'), h('p', {}, 'Sign in to the crew app, then come back to your crew photo.'), h('a', { class: 'cp-btn primary', href: '/crew/?next=%2Fcrew%2Fprofile-photo' }, 'Sign in')));
      else nodes.push(h('section', { class: 'cp-card', role: 'alert' }, h('h2', {}, 'Crew photos are unavailable'), h('p', {}, S.failed || 'Crew photos could not be loaded.'), h('button', { type: 'button', class: 'cp-btn primary', onclick: load }, 'Retry')));
      S.host.replaceChildren(...nodes); return;
    }
    const manager = S.data.viewer.manager, own = S.data.profiles.find(row => row.username === me()), others = S.data.profiles.filter(row => row.username !== me());
    if (S.pending) nodes.push(pendingCard());
    nodes.push(card(own, true, manager));
    if (manager) nodes.push(h('h2', {}, 'Crew photos'), h('p', { class: 'cp-muted' }, S.data.customerProfilesEnabled ? 'Profiles shown to customers appear on project pages for jobs that person is assigned to, with the crew lead first.' : 'Customer crew profiles are not switched on yet. Prepare names and photos now; customers see them once the owner turns the feature on.'),
      others.length ? h('div', { class: 'cp-list' }, others.map(row => card(row, false, true))) : h('p', { class: 'cp-muted' }, 'No other active employees are on the roster.'));
    S.host.replaceChildren(...nodes);
  }

  function mount(host) { unmount(); S.host = host; S.gen++; load(); }
  function unmount() { S.gen++; S.host = null; S.data = null; S.pending = null; S.busy = false; S.loading = false; setStatus(''); }
  const canLeave = () => !S.busy;
  window.addEventListener('egc:signout', () => { forgetPending(); unmount(); });
  window.addEventListener('beforeunload', event => { if (S.busy) { event.preventDefault(); event.returnValue = ''; } });
  window.EGCCrewProfile = Object.freeze({ mount, unmount, refresh: load, canLeave });
  const host = document.getElementById('profile-main');
  if (host) mount(host);
})();
