(function (root) {
  'use strict';
  // P2-07: "Send options for review" from the walkthrough. The quote is saved
  // as an unsigned Hub draft (/api/quote-draft) and nothing reaches the customer
  // until the person previews and confirms the send. Every request is frozen in
  // sessionStorage before it is sent and a lost response retries it unchanged.
  const DAY = 86400000;
  function h(tag, props, ...children) { const node = document.createElement(tag); for (const [name, value] of Object.entries(props || {})) { if (value == null || value === false) continue; if (name === 'class') node.className = value; else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value); else if (name in node && !name.startsWith('aria-')) node[name] = value; else node.setAttribute(name, String(value)); } for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child))); return node; }
  const money = cents => Number.isSafeInteger(cents) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100) : 'Needs review';
  const dayText = date => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`)); } catch { return date; } };
  const denverDate = (ms, days = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms + days * DAY));
  const KEEP = new Set([401, 403, 408, 429]);
  // Only a definite refusal discards a frozen request: a 4xx other than sign-in,
  // permission, timeout or rate limit, or a confirmation the server refused
  // (mismatched, invalid, expired or used), which can never succeed unchanged.
  // A lost response, a 5xx and a 2xx whose body cannot be read are unknown
  // outcomes: the server may have committed, so the request is kept unchanged.
  const refused = error => /^confirm_token_/.test(error?.code || '') || error?.status >= 400 && error.status < 500 && !KEEP.has(error.status);
  const conflict = error => /_revision_conflict$/.test(error.code || '');
  // A refused save names each owner dispatch rule (or overlapping work) that
  // stopped it (details.conflicts), as the Hub's shift pickup does.
  const refusal = (data, fallback) => [data?.error || fallback, ...[...new Set((Array.isArray(data?.details?.conflicts) ? data.details.conflicts : []).filter(row => row && row.code !== 'legacy_blocked_day' && typeof row.message === 'string' && row.message.trim()).map(row => row.message.trim()))].slice(0, 3)].join(' ');
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value ?? null);
  const sameDraft = (a, b) => canonical(JSON.parse(JSON.stringify(a ?? null))) === canonical(JSON.parse(JSON.stringify(b ?? null)));
  // The customer details a /api/customer-resolve request carries. Its requestId is
  // reused only for exactly these details (the server fingerprints the body).
  const resolveCustomer = client => ({ name: client.name, phone: client.phone, email: client.email, address: client.address, highlevelContactId: client.highlevel_contact_id });
  const resolveIdentity = draft => canonical(resolveCustomer(draft?.client || {}));

  // The customer-facing quote from the walkthrough's itemized lines.
  function scopeText(lines) {
    const names = lines.filter(line => line.selected !== false && line.id !== 'adjustment').map(line => line.quantity !== 1 ? `${line.quantity} × ${line.name}` : line.name);
    const adjustment = lines.find(line => line.id === 'adjustment');
    return `Included: ${names.join('; ')}.${adjustment?.description ? ` ${adjustment.name}: ${adjustment.description}.` : ''}`.slice(0, 1600);
  }
  function draftFromWalkthrough(p, validUntil) {
    const lines = (Array.isArray(p?.quote?.line_items) ? p.quote.line_items : []).map(line => ({ ...line }));
    const crew = Number(p?.logistics?.crew_size || 0), minutes = Number(p?.quote?.estimated_duration_min || 0);
    return {
      client: { name: String(p?.client?.name || ''), phone: String(p?.client?.phone || ''), email: String(p?.client?.email || ''), address: String(p?.client?.address || ''), highlevel_contact_id: String(p?.client?.highlevel_contact_id || '') },
      title: String(p?.quote?.title || 'EGC Garage Service').slice(0, 200), scope: scopeText(lines), line_items: lines, valid_until: validUntil,
      catalog_version: String(p?.quote?.catalog_version || ''), crew_size: Number.isInteger(crew) && crew >= 1 && crew <= 20 ? crew : null, estimated_duration_min: Number.isInteger(minutes) && minutes >= 15 ? minutes : null,
    };
  }
  function missing(draft) {
    const miss = [], lines = draft.line_items;
    if (!draft.client.name.trim()) miss.push('customer name');
    if (!draft.client.address.trim()) miss.push('service address');
    if (!draft.client.phone.trim() && !draft.client.email.trim()) miss.push('a phone number or email');
    if (!lines.length || lines.reduce((sum, line) => sum + (line.selected === false ? 0 : Number(line.totalCents) || 0), 0) <= 0) miss.push('a priced quote');
    const adjustment = lines.find(line => line.id === 'adjustment');
    if (adjustment && String(adjustment.description || '').trim().length < 3) miss.push('the customer-facing reason for the changed rate');
    return miss;
  }

  // One frozen, actor-scoped request per walkthrough (a manual walkthrough by its
  // draft identity); the send request is kept per quote job. Neither a reload nor
  // a lost response creates a second quote. The quote job to revise is always the
  // one the current walkthrough saved (d.savedJobId), never an earlier request's.
  function createClient(d) {
    const saveKey = (actor, source) => `egc-quote-draft-v1:${actor}:${source || `manual:${String(d.draftId?.() || '')}`}`, sendKey = (actor, job) => `egc-quote-send-v1:${actor}:${job.id}:r${job.estimate?.revision ?? ''}`;
    function read(key) { try { return JSON.parse(d.storage.getItem(key) || 'null'); } catch { throw new Error('The saved quote request is unreadable. Review the quote in the Hub before saving again.'); } }
    const remember = (key, value) => value ? d.storage.setItem(key, JSON.stringify(value)) : d.storage.removeItem(key);
    async function request(url, body) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
      let response;
      try { response = await d.fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal } : { cache: 'no-store', signal: controller.signal }); }
      catch { throw Object.assign(new Error('The server did not answer. Your request is kept; retry it unchanged.'), { status: 0 }); }
      finally { clearTimeout(timer); }
      let data = null;
      try { data = await response.json(); } catch { data = null; }
      // A 2xx whose body is unreadable or not a success may still have committed.
      if (response.ok && data?.ok !== true) throw Object.assign(new Error('The server\'s answer could not be read. Your request is kept; retry it unchanged.'), { status: response.status, unknown: true, code: '' });
      if (!response.ok) throw Object.assign(new Error(refusal(data, 'The quote could not be verified. Retry without changing it.')), { status: response.status || 0, code: data?.code || '' });
      return data;
    }
    async function actor() { const user = await d.actor(); if (!user) throw Object.assign(new Error('Sign in to the Employee Hub before saving.'), { status: 401 }); return user; }
    // The frozen save of this walkthrough whose outcome is still unknown, if any.
    async function pendingSave() {
      const user = await d.actor(); if (!user) return null;
      const pending = read(saveKey(user, d.source()));
      return pending?.actor === user && pending.body && !pending.result ? pending : null;
    }
    // Returns {result, retrying, draft}: an unconfirmed earlier save is always
    // retried unchanged, and `draft` is what was actually saved.
    async function save(draft) {
      const user = await actor(), source = d.source(), key = saveKey(user, source);
      let pending = read(key);
      if (pending && pending.actor !== user) throw new Error('This request belongs to another signed-in employee.');
      const retrying = Boolean(pending?.body && !pending.result);
      // A resolve that may have committed is retried with its id only for the same
      // customer details; corrected details get a new id, never a 409 dead end.
      if (!retrying) { const identity = resolveIdentity(draft), reuse = pending?.resolveRequestId && pending.resolveIdentity === identity; pending = { actor: user, source, requestId: d.uuid(), resolveRequestId: reuse ? pending.resolveRequestId : d.uuid(), resolveIdentity: identity, draft, body: null, result: null }; remember(key, pending); }
      try {
        if (!pending.body) {
          const query = new URLSearchParams();
          if (source) query.set('sourceWalkthroughId', source);
          const known = d.savedJobId();
          if (known) query.set('jobId', known);
          const prepared = await request('/api/walkthrough-handoff?' + query);
          if (prepared.viewer?.id !== user) throw new Error('The signed-in account changed. Reload before saving.');
          let customerId = prepared.customerId;
          if (!customerId) customerId = (await request('/api/customer-resolve', { requestId: pending.resolveRequestId, customer: resolveCustomer(pending.draft.client) })).customer?.id;
          if (!customerId) throw new Error('The canonical customer could not be verified.');
          pending.body = { action: 'save', actorId: user, requestId: pending.requestId, customerId, sourceWalkthroughId: source || '', sourceRevision: prepared.sourceRevision || '', ...(prepared.jobId ? { jobId: prepared.jobId, expectedRevision: prepared.expectedRevision } : {}), draft: pending.draft };
          remember(key, pending);
        }
        if (await d.actor() !== user) throw new Error('The signed-in account changed. Reopen the original account to recover this request.');
        const result = await request('/api/quote-draft', pending.body);
        if (result.requestId !== pending.requestId || !result.job?.id || result.job.customerId !== pending.body.customerId) throw new Error('The saved quote did not match the request. Review it in the Hub before retrying.');
        pending.result = { job: result.job, warnings: result.warnings || [] }; remember(key, pending);
        d.accept?.(result);
        return { result, retrying, draft: pending.draft };
      } catch (error) {
        // A refused request that never saved is discarded; an unknown outcome is kept.
        // A resolve id the server already holds for other details is dropped too.
        if (refused(error)) { pending.body = null; pending.result = null; if (error.code === 'customer_resolve_idempotency_conflict') pending.resolveRequestId = pending.resolveIdentity = null; remember(key, pending); }
        throw Object.assign(error, { retrying, conflict: conflict(error) });
      }
    }
    async function preview(job) {
      await actor();
      return request('/api/quote-draft', { action: 'send_preview', jobId: job.id, expectedRevision: job.revision });
    }
    async function send(job, previewed) {
      const user = await actor(), key = sendKey(user, job);
      let pending = read(key);
      if (!pending || pending.actor !== user) { pending = { actor: user, body: { action: 'send', requestId: d.uuid(), jobId: job.id, expectedRevision: job.revision, confirmToken: previewed.confirmToken } }; remember(key, pending); }
      try {
        const result = await request('/api/quote-draft', pending.body);
        if (result.requestId !== pending.body.requestId || result.job?.id !== job.id) throw new Error('The sent quote did not match the request. Review it in the Hub.');
        remember(key, null);
        return result;
      } catch (error) { if (refused(error)) remember(key, null); throw error; }
    }
    const pendingSend = async job => { const user = await d.actor(); return user ? read(sendKey(user, job)) : null; };
    function clear() { if (typeof d.storage.key !== 'function') return; for (let index = d.storage.length - 1; index >= 0; index -= 1) { const key = d.storage.key(index) || ''; if (/^egc-quote-(draft|send)-v1:/.test(key)) d.storage.removeItem(key); } }
    return { save, pendingSave, preview, send, pendingSend, clear };
  }

  const MODES = {
    automation: recipient => `HighLevel's estimate-ready automation will notify the customer${recipient ? ` at ${recipient}` : ''}.`,
    dry_run: () => 'Customer messaging is in dry-run mode: the send is recorded, HighLevel is not triggered.',
    off: () => 'Customer messaging is off: the quote is marked sent, and you share it with the customer yourself.',
    suppressed: () => 'Customer notifications are off for this job: the quote is marked sent without a message.',
  };
  let active = null;
  function open(options) {
    if (active) return active.dialog;
    const client = options.client || createClient(options);
    const S = { step: 'review', busy: false, error: '', status: '', saved: null, preview: null, sent: null, validUntil: denverDate(options.now ? options.now() : Date.now(), 14), generation: 0 };
    const opener = document.activeElement, body = h('div', { class: 'qd-body' }), foot = h('div', { class: 'qd-foot' });
    const dialog = h('dialog', { class: 'qd-dialog' + (options.variant === 'catalog' ? ' cq-review' : ''), 'aria-labelledby': 'qd-title' }, h('div', { class: 'qd-head' }, h('p', { class: 'qd-kicker' }, options.kicker || 'Not signing today?'), h('h2', { id: 'qd-title' }, options.title || 'Send options for review')), body, foot);
    const close = () => { S.generation++; if (dialog.open) dialog.close(); dialog.remove(); active = null; window.removeEventListener('egc:signout', signout); if (opener?.focus) opener.focus(); };
    const signout = () => { client.clear(); close(); };
    const draft = () => typeof options.draft === 'function' ? options.draft(S.validUntil) : draftFromWalkthrough(options.plan(), S.validUntil);
    // An earlier save whose answer was lost is shown and retried exactly as it
    // was frozen, never the walkthrough as it reads now.
    async function detectFrozen() {
      const generation = S.generation, pending = await client.pendingSave().catch(() => null);
      if (generation !== S.generation || S.busy) return;
      S.frozen = pending ? pending.draft : null; S.retry = Boolean(pending);
      if (pending?.draft?.valid_until) S.validUntil = pending.draft.valid_until;
      render();
    }
    const totalOf = list => list.reduce((sum, line) => sum + (line.selected === false ? 0 : Number(line.totalCents) || 0), 0);
    function lines(list) {
      return h('ul', { class: 'qd-lines' }, list.map(line => h('li', { class: line.included === false || line.selected === false ? 'qd-line qd-muted' : 'qd-line' }, h('span', {}, line.name, line.customerSupplied ? ' (customer supplied)' : '', line.quantity !== 1 ? ` × ${line.quantity}` : '', line.group ? ` (${line.group.label}${line.tier ? ` · ${line.tier}` : ''})` : line.optional ? ' (optional)' : ''), h('b', {}, money(line.totalCents)))));
    }
    function render() {
      const children = [];
      if (S.step === 'review' && S.frozen) {
        const frozen = S.frozen, list = Array.isArray(frozen.line_items) ? frozen.line_items : [];
        children.push(h('p', { class: 'qd-notice', role: 'status' }, 'An earlier save of this quote was not confirmed. Retry it exactly as it was submitted; later changes to the walkthrough are not part of it.'), lines(list), h('p', { class: 'qd-total' }, 'Total ', h('b', {}, money(totalOf(list)))), h('p', { class: 'qd-mode' }, `Options valid through ${dayText(frozen.valid_until)}`));
      } else if (S.step === 'review') {
        const current = draft(), total = totalOf(current.line_items);
        children.push(h('p', {}, 'Save this quote as an unsigned draft on the Hub job. The customer is not contacted until you preview and confirm the send.'), lines(current.line_items), h('p', { class: 'qd-total' }, 'Total ', h('b', {}, money(total))),
          h('label', { class: 'qd-label', for: 'qd-valid' }, 'Options valid through'),
          h('input', { id: 'qd-valid', class: 'qd-input', type: 'date', value: S.validUntil, min: denverDate(options.now ? options.now() : Date.now()), required: true, oninput: event => { S.validUntil = event.target.value; } }));
      } else if (S.step === 'confirm') {
        const job = S.preview.job;
        children.push(h('p', { class: 'qd-summary' }, S.preview.summary), lines(job.estimate.lineItems), h('p', { class: 'qd-total' }, 'Total ', h('b', {}, money(job.estimate.amountCents)), ` · valid through ${dayText(job.estimate.validUntil)}`), Number.isSafeInteger(job.estimate.depositRequiredCents) ? h('p', {}, 'Deposit due: ', money(job.estimate.depositRequiredCents)) : null, h('p', { class: 'qd-mode' }, (MODES[S.preview.delivery.mode] || MODES.off)(S.preview.delivery.recipient?.masked || '')));
      } else children.push(h('p', { class: 'qd-done' }, S.status));
      if (S.busy) children.push(h('div', { class: 'qd-skeleton', 'aria-hidden': 'true' }, h('span'), h('span')));
      children.push(h('p', { class: 'qd-status', 'aria-live': 'polite' }, S.step === 'done' ? '' : S.status), S.error ? h('p', { class: 'qd-error', role: 'alert' }, S.error) : null);
      body.replaceChildren(...children.filter(Boolean));
      const primary = S.step === 'review' ? h('button', { type: 'button', class: 'qd-primary', disabled: S.busy, onclick: S.reprice ? refreshPrices : saveDraft }, S.busy ? 'Saving draft…' : S.reprice ? 'Review updated prices' : S.retry ? 'Retry original save' : 'Save draft')
        : S.step === 'confirm' ? h('button', { type: 'button', class: 'qd-primary', disabled: S.busy, onclick: confirmSend }, S.busy ? 'Sending…' : S.retry ? 'Retry original send' : S.preview.delivery.mode === 'automation' ? 'Send to customer' : 'Mark as sent')
          : h('button', { type: 'button', class: 'qd-primary', onclick: close }, 'Done');
      foot.replaceChildren(...(S.step === 'done' ? [primary] : [h('button', { type: 'button', class: 'qd-secondary', disabled: S.busy, onclick: close }, 'Close'), primary]));
    }
    async function refreshPrices() {
      if (S.busy) return;
      const generation = S.generation;
      S.busy = true; S.error = ''; render();
      try { const reopen = await options.reprice(); if (generation !== S.generation) return; close(); await reopen(); }
      catch (error) { if (generation === S.generation) S.error = error.message || 'The latest prices could not be loaded. Retry.'; }
      finally { if (generation === S.generation) { S.busy = false; render(); } }
    }
    async function saveDraft() {
      const generation = S.generation, current = draft(), miss = missing(current);
      if (!S.retry && miss.length) { S.error = `Add ${miss.join(', ')} first.`; render(); return; }
      if (!S.retry && !/^\d{4}-\d{2}-\d{2}$/.test(S.validUntil)) { S.error = 'Choose the date these options stay valid.'; render(); return; }
      S.busy = true; S.error = ''; S.status = ''; render();
      try {
        const { result, retrying, draft: saved } = await client.save(current);
        if (generation !== S.generation) return;
        S.saved = result.job; S.retry = false; S.frozen = null; S.status = [`Draft ${result.job.estimate.number} revision ${result.job.estimate.revision} saved.`, ...(result.warnings || []).map(warning => String(warning?.message || ''))].filter(Boolean).join(' ');
        // The retried save was the frozen one: later walkthrough edits are not in
        // it, so they must be saved (and reviewed) before anything is previewed.
        if (retrying && !sameDraft(saved, current)) { S.status = `The original save is confirmed: ${S.status} Your later changes to the walkthrough are not saved yet. Review them and save again before sending.`; return; }
        S.preview = await client.preview(result.job);
        if (generation !== S.generation) return;
        const pending = await client.pendingSend(result.job);
        S.retry = Boolean(pending); S.step = 'confirm';
      } catch (error) {
        if (generation !== S.generation) return;
        const pending = await client.pendingSave().catch(() => null);
        if (generation !== S.generation) return;
        S.retry = Boolean(pending); S.frozen = pending ? pending.draft : null; S.error = error.message || 'The quote could not be saved. Retry.';
        S.reprice = !pending && typeof options.reprice === 'function' && /^quote_draft_catalog_(version_changed|price_changed|price_unverified|item_unavailable)$/.test(error.code || '');
      } finally { if (generation === S.generation) { S.busy = false; render(); } }
    }
    async function confirmSend() {
      const generation = S.generation;
      S.busy = true; S.error = ''; render();
      try {
        const result = await client.send(S.saved, S.preview);
        if (generation !== S.generation) return;
        const status = result.delivery?.status;
        S.sent = result; S.step = 'done'; S.retry = false;
        S.status = `${result.job.estimate.number} revision ${result.job.estimate.revision} is marked sent. ${status === 'submitted' ? `The estimate-ready tag was applied in HighLevel; its workflow notifies the customer if that workflow is on.${result.delivery?.tagReset === 'unconfirmed' ? ' HighLevel did not confirm the old tag was cleared first, so a customer who already had it may not be notified again. Check Customer messages.' : ''}` : status === 'dry_run' ? 'Dry run: HighLevel was not triggered.' : ['uncertain', 'sending'].includes(status) ? 'HighLevel did not confirm the notification; it will not be resent automatically. Check Customer messages.' : status && !['messaging_disabled', 'suppressed', 'not_requested'].includes(status) ? 'The customer notification needs attention in Customer messages.' : 'Share the quote with the customer yourself.'}`;
        options.onSent?.(result);
      } catch (error) {
        if (generation !== S.generation) return;
        const pending = await client.pendingSend(S.saved).catch(() => null);
        if (generation !== S.generation) return;
        S.retry = Boolean(pending);
        if (!S.retry && S.saved) { S.error = `${error.message || 'The send was refused.'} Save and preview the quote again.`; S.step = 'review'; }
        else S.error = error.message || 'The send could not be confirmed. Retry the original send.';
      } finally { if (generation === S.generation) { S.busy = false; render(); } }
    }
    dialog.addEventListener('cancel', event => { if (S.busy) event.preventDefault(); else { event.preventDefault(); close(); } });
    window.addEventListener('egc:signout', signout);
    document.body.append(dialog);
    render();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    active = { dialog, close };
    detectFrozen();
    return dialog;
  }
  root.EGCQuoteDraft = { open, createClient, draftFromWalkthrough, scopeText, missing };
})(window);
