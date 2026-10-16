(function () {
  'use strict';
  // The server verifies the assigned lead and canonical completion. This card
  // only prepares a native-form handoff; it never submits the form itself.
  const CARD = 'completion-handoff-card';
  const FORM_PATH = '/widget/form/7HCRlKJs4VZx4KwNmDa6';
  const JOB_QUERY = 'egc_completion_job_id', REFERENCE_QUERY = 'egc_completion_reference';
  const STATUSES = new Set(['not_completed', 'setup_required', 'identity_required', 'ready', 'prepared', 'expired', 'completion_verified', 'released_unconfirmed', 'blocked']);
  const S = { host: null, jobId: '', gen: 0, viewer: '', data: null, intent: null, launchUrl: '', busy: '', failed: '', notice: '', copying: false, copyNotice: '', observer: null, timer: 0, controller: null };

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'className') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false).map(child => typeof child === 'string' ? document.createTextNode(child) : child));
    return node;
  }
  const text = (value, max) => typeof value === 'string' && value.length <= max;
  // Match the server's canonical normalizeEmail contract without changing it.
  const customerEmail = value => text(value, 254) && value === value.trim().replace(/^mailto:/i, '').toLowerCase() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  function valid(data, jobId) {
    return data?.ok === true && data.jobId === jobId && text(data.viewer, 180) && Boolean(data.viewer)
      && text(data.expectedRevision, 600) && Boolean(data.expectedRevision) && typeof data.eligible === 'boolean'
      && STATUSES.has(data.status) && typeof data.canLaunch === 'boolean'
      && (data.completedAt === null || text(data.completedAt, 80)) && (data.completedDate === null || text(data.completedDate, 10))
      && (!data.eligible || Boolean(data.completedAt) && Number.isFinite(Date.parse(data.completedAt)) && /^\d{4}-\d{2}-\d{2}$/.test(data.completedDate))
      && Array.isArray(data.missing) && data.missing.length <= 30 && data.missing.every(item => text(item, 500))
      && data.associationMode === 'manual_email' && (data.customerEmail === null || customerEmail(data.customerEmail))
      && text(data.message, 1500) && (!data.canLaunch || data.eligible && customerEmail(data.customerEmail) && ['ready', 'prepared'].includes(data.status));
  }
  function safeLaunch(value, jobId) {
    if (!text(value, 8192) || !value || /[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2060\ufeff]/.test(value)) return '';
    try {
      const url = new URL(value);
      const params = [...url.searchParams], allowed = new Set([JOB_QUERY, REFERENCE_QUERY, 'notrack']);
      if (params.length < 2 || params.length > 3 || params.some(([key]) => !allowed.has(key)) || new Set(params.map(([key]) => key)).size !== params.length
        || url.searchParams.get(JOB_QUERY) !== jobId || !/^w19_[A-Za-z0-9_-]{43}$/.test(url.searchParams.get(REFERENCE_QUERY) || '')
        || url.searchParams.has('notrack') && url.searchParams.get('notrack') !== 'true') return '';
      return ['https://api.leadconnectorhq.com', 'https://links.easygaragecleaning.com'].includes(url.origin)
        && url.pathname === FORM_PATH && !url.username && !url.password && !url.hash ? url.href : '';
    } catch { return ''; }
  }
  const offline = () => navigator.onLine === false;
  function cancel() { S.controller?.abort(); S.controller = null; }
  function clearCopy() { S.copying = false; S.copyNotice = ''; }
  function clearPrivate() { S.data = null; S.viewer = ''; S.intent = null; S.launchUrl = ''; S.failed = ''; S.notice = ''; clearCopy(); }

  async function call(jobId, input, controller) {
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(input ? '/api/field-completion-handoff' : `/api/field-completion-handoff?jobId=${encodeURIComponent(jobId)}`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) throw Object.assign(new Error(text(data?.error, 1500) && data.error || 'Completion confirmation is temporarily unavailable.'), { status: response.status });
      if (!valid(data, jobId)) throw Object.assign(new Error('Completion confirmation could not be verified. Check the current status.'), { status: 503 });
      return data;
    } catch (error) {
      if (typeof error.status === 'number') throw error;
      throw Object.assign(new Error('The server did not confirm this. Check your connection and confirmation status.'), { status: 0 });
    } finally { clearTimeout(timer); }
  }

  async function load(notice = '') {
    if (!S.host || offline()) return;
    const gen = ++S.gen, jobId = S.jobId;
    cancel(); const controller = S.controller = new AbortController();
    S.data = null; S.launchUrl = ''; S.busy = 'loading'; S.failed = S.failed ? 'unavailable' : ''; S.notice = notice; clearCopy(); decorate();
    try {
      const data = await call(jobId, null, controller);
      if (gen !== S.gen || !S.host || offline()) return;
      if (S.viewer && data.viewer !== S.viewer) { S.intent = null; S.notice = ''; }
      S.viewer = data.viewer; S.data = data; S.failed = '';
      if (!data.eligible) { S.intent = null; S.notice = ''; }
    } catch (error) {
      if (gen !== S.gen || !S.host) return;
      if ([401, 403, 404].includes(error.status)) clearPrivate();
      else S.failed = 'unavailable';
    } finally {
      if (gen === S.gen) { S.busy = ''; S.controller = null; decorate(); }
    }
  }

  async function prepare() {
    if (!S.host || !S.data?.eligible || !S.data.canLaunch || S.busy || S.failed || offline()) return;
    const data = S.data;
    if (!S.intent || S.intent.expectedUser !== data.viewer || S.intent.jobId !== S.jobId) S.intent = {
      action: 'prepare', jobId: S.jobId, requestId: crypto.randomUUID(), expectedRevision: data.expectedRevision, expectedUser: data.viewer,
    };
    const input = S.intent, gen = ++S.gen;
    cancel(); const controller = S.controller = new AbortController();
    S.launchUrl = ''; S.busy = 'preparing'; S.failed = ''; S.notice = 'Preparing completion confirmation.'; clearCopy(); decorate();
    try {
      const result = await call(input.jobId, input, controller);
      if (gen !== S.gen || !S.host || offline()) return;
      // A late response from another account cannot expose its handoff link.
      if (result.viewer !== input.expectedUser) { clearPrivate(); return; }
      const launchUrl = result.canLaunch ? safeLaunch(result.launchUrl, input.jobId) : '';
      if (result.canLaunch && !launchUrl) throw Object.assign(new Error('The completion form link could not be verified. Check confirmation status.'), { status: 503 });
      S.data = result; S.launchUrl = launchUrl;
      S.notice = launchUrl ? 'Continue to the form, then check confirmation status after submitting. Opening the form does not confirm submission.' : '';
    } catch (error) {
      if (gen !== S.gen || !S.host) return;
      if ([401, 403, 404].includes(error.status)) { clearPrivate(); return; }
      // An uncertain prepare is reconciled with a read. Only another explicit
      // tap can retry, using this same in-memory request ID and actor binding.
      if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) S.intent = null;
      S.busy = '';
      await load(`${error.message} Review the current status before continuing.`);
    } finally {
      if (gen === S.gen) { S.busy = ''; S.controller = null; decorate(); }
    }
  }

  async function copyEmail() {
    const data = S.data;
    if (!S.host || S.busy || S.copying || offline() || !data?.canLaunch || !customerEmail(data.customerEmail)) return;
    const gen = S.gen, host = S.host, viewer = data.viewer, email = data.customerEmail;
    const current = () => gen === S.gen && host === S.host && !offline() && S.data?.viewer === viewer && S.data?.customerEmail === email;
    S.copying = true; S.copyNotice = ''; decorate();
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      // Only this explicit button action writes to the clipboard. The email
      // never enters a form URL, saved draft, browser storage or POST body.
      await navigator.clipboard.writeText(email);
      if (current()) S.copyNotice = 'Customer email copied. Paste it into the required Customer email field on the completion form. Do not use your crew email.';
    } catch {
      if (current()) S.copyNotice = 'Copy was unavailable. Select the customer email above and copy it manually, then paste it into the required Customer email field on the completion form.';
    } finally {
      // Sign-out, another account, a refreshed job and offline transitions
      // invalidate feedback from an older clipboard request.
      if (current()) { S.copying = false; decorate(); }
    }
  }

  function decorate() {
    if (!S.host) return;
    let card = S.host.querySelector(`#${CARD}`);
    const recovery = !S.data && Boolean(S.failed);
    if ((!S.data?.eligible && !recovery) || offline()) { card?.remove(); return; }
    if (!card) { card = h('section', { id: CARD, className: 'card full', 'aria-label': 'Job completion confirmation' }); S.host.append(card); }
    if (recovery) {
      // A failed read must remain recoverable without restoring an earlier
      // customer's identity, completion details, link or upstream error text.
      card.replaceChildren(
        h('h2', null, 'Completion confirmation'),
        h('p', { className: S.busy ? 'muted' : 'notice error', role: 'status', 'aria-live': 'polite' }, S.busy ? 'Checking completion confirmation.' : 'Completion confirmation could not be checked. Check your connection, then check confirmation status.'),
        h('div', { className: 'actions' }, h('button', { type: 'button', 'data-completion-action': 'check', disabled: Boolean(S.busy) }, S.busy ? 'Checking confirmation.' : 'Check confirmation status')),
      );
      return;
    }
    const fallback = S.data.status === 'released_unconfirmed'
      ? 'HighLevel completion received; Cesar task confirmation still needs review.'
      : S.data.status === 'setup_required' ? 'Completion confirmation setup is still required.' : '';
    const message = S.data.status === 'completion_verified' ? 'HighLevel submission verified. Cesar task is not enabled. Do not resubmit this form.'
      : S.data.status === 'identity_required' ? 'Operations must verify access and the customer email before this form can open. Stop and contact operations.'
        : S.data.message || fallback;
    const button = S.launchUrl && !S.busy && !S.failed
      ? h('a', { className: 'button primary', href: S.launchUrl, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' }, 'Continue to completion form')
      : S.data.canLaunch && !S.failed ? h('button', { type: 'button', className: 'primary', 'data-completion-action': 'prepare', disabled: Boolean(S.busy) }, S.busy === 'preparing' ? 'Preparing confirmation…' : 'Open completion confirmation') : null;
    // Descendant updates do not trigger the host's direct-child observer.
    const children = [
      h('h2', null, 'Completion confirmation'),
      h('p', null, 'Actual completion date: ', h('time', { datetime: S.data.completedAt }, S.data.completedDate), ' · Mountain Time'),
      message ? h('p', { className: 'notice' }, message) : null,
      S.data.missing.length ? h('p', { className: 'notice' }, 'Operations needs to finish the form connection before it can open.') : null,
      S.data.canLaunch && !S.busy ? h('div', { className: 'field' },
        h('label', { for: 'completion-customer-email' }, 'Customer email'),
        h('input', { id: 'completion-customer-email', type: 'text', readonly: true, value: S.data.customerEmail, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'completion-email-help' }),
        h('p', { id: 'completion-email-help', className: 'muted' }, 'Paste this exact customer email into the required Customer email field on the completion form. Do not use your crew email. If it is wrong, stop and contact operations.'),
        h('div', { className: 'actions' }, h('button', { type: 'button', 'data-completion-action': 'copy-email', disabled: Boolean(S.busy || S.copying) }, S.copying ? 'Copying customer email.' : 'Copy customer email')),
        h('p', { className: 'muted', role: 'status', 'aria-live': 'polite' }, S.copyNotice)) : null,
      h('p', { className: S.failed ? 'notice error' : 'muted', role: 'status', 'aria-live': 'polite' }, S.failed || S.notice),
      h('div', { className: 'actions' }, button, h('button', { type: 'button', 'data-completion-action': 'check', disabled: Boolean(S.busy) }, S.busy === 'loading' ? 'Checking confirmation…' : 'Check confirmation status')),
    ];
    card.replaceChildren(...children.filter(Boolean));
  }

  function onClick(event) {
    const button = event.target.closest?.('[data-completion-action]');
    if (!button || !S.host?.contains(button) || button.disabled || S.busy) return;
    if (button.getAttribute('data-completion-action') === 'prepare') prepare();
    else if (button.getAttribute('data-completion-action') === 'copy-email') copyEmail();
    else load();
  }
  function onRender(records) {
    // Appending/removing our own card must never cause another fetch. job.js
    // replaces the host's children, which invalidates eligibility and links.
    const external = records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => node.id !== CARD));
    if (!external || !S.host) return;
    ++S.gen; cancel(); S.busy = ''; S.launchUrl = ''; S.data = null; S.failed = ''; S.notice = ''; clearCopy(); decorate();
    clearTimeout(S.timer); S.timer = setTimeout(() => { S.timer = 0; load(); }, 200);
  }
  function onOffline() {
    ++S.gen; cancel(); clearTimeout(S.timer); S.timer = 0; S.busy = ''; S.data = null; S.launchUrl = ''; S.failed = ''; S.notice = ''; clearCopy();
    // Keep only the in-memory intent so a lost prepare can reuse its ID after
    // the account is checked again. Sign-out clears that intent as well.
    decorate();
  }
  function onOnline() { load(); }
  function onLeave(event) { if (S.busy === 'preparing') { event.preventDefault(); event.returnValue = ''; } }
  function mount(host, jobId = new URLSearchParams(location.search).get('jobId') || '') {
    unmount();
    if (!host || !jobId) return;
    S.host = host; S.jobId = jobId;
    host.addEventListener('click', onClick);
    S.observer = new MutationObserver(onRender); S.observer.observe(host, { childList: true });
    window.addEventListener('egc:signout', unmount); window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline); window.addEventListener('beforeunload', onLeave);
    load();
  }
  function unmount() {
    ++S.gen; cancel(); clearTimeout(S.timer); S.observer?.disconnect();
    S.host?.removeEventListener('click', onClick); S.host?.querySelector(`#${CARD}`)?.remove();
    window.removeEventListener('egc:signout', unmount); window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline); window.removeEventListener('beforeunload', onLeave);
    clearPrivate(); Object.assign(S, { host: null, jobId: '', busy: '', observer: null, timer: 0 });
  }

  window.EGCJobCompletionHandoff = { mount, unmount, refresh: () => load(), canLeave: () => S.busy !== 'preparing' };
  const main = document.getElementById('field-main');
  if (main) mount(main);
})();
