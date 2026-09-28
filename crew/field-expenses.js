(function () {
  'use strict';
  const KINDS = [['material', 'Materials'], ['dump_fee', 'Dump / disposal fee'], ['other', 'Other']];
  const FALLBACK_MAX_CENTS = 500000;
  const blank = () => ({ kind: 'material', amount: '', vendor: '', note: '' });
  const S = { host: null, jobId: '', user: '', manager: false, data: null, loading: false, error: '', hidden: false, busy: false, pending: null, volatile: false, receipt: '', receiptBusy: false, formError: '', feedback: '', feedbackError: false, draft: blank(), editing: '', editDraft: null, voiding: '', voidReason: '', generation: 0 };
  function h(tag, props, ...children) { const node = document.createElement(tag); for (const [name, value] of Object.entries(props || {})) { if (value == null || value === false) continue; if (name === 'class') node.className = value; else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value); else if (name in node && !name.startsWith('aria-') && name !== 'list') node[name] = value; else node.setAttribute(name, String(value)); } for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child))); return node; }
  const fill = (host, ...children) => host.replaceChildren(...children.flat(Infinity).filter(child => child != null && child !== false));
  const kindLabel = kind => (KINDS.find(([value]) => value === kind) || KINDS[2])[1];
  const money = cents => Number.isSafeInteger(cents) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100) : 'Needs review';
  const stamp = value => { try { return value ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : ''; } catch { return ''; } };
  const maxCents = () => S.data?.limits?.maxAmountCents || FALLBACK_MAX_CENTS;
  const mountainDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  const shiftDate = (date, days) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
  const dayLabel = date => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`)); } catch { return date; } };
  const noteLabel = (kind, optional = 'Note (optional)') => kind === 'other' ? 'What was it for? (required)' : optional;
  const AUDIT_NAMES = { amountCents: 'amount', incurredOn: 'purchase date', kind: 'type' };
  const key = suffix => `egc-field:${S.user}:${S.jobId}:expense-${suffix}`;
  function parseCents(text) {
    const match = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(text ?? '').trim());
    if (!match) return null;
    const cents = Number(match[1].replaceAll(',', '')) * 100 + Number((match[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(cents) ? cents : null;
  }
  const amountText = cents => Number.isSafeInteger(cents) ? (cents / 100).toFixed(2) : '';
  function store(suffix, value) { try { value == null ? sessionStorage.removeItem(key(suffix)) : sessionStorage.setItem(key(suffix), JSON.stringify(value)); return true; } catch { return false; } }
  function stored(suffix) { try { return JSON.parse(sessionStorage.getItem(key(suffix)) || 'null'); } catch { return null; } }
  function remember() { if (S.jobId && S.user) store('draft', S.draft.amount || S.draft.vendor || S.draft.note || S.draft.kind !== 'material' ? S.draft : null); }
  function persistPending() { S.volatile = S.pending ? !store('pending', S.pending) : (store('pending', null), false); }
  async function api(url, input) {
    let response;
    try { response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(input?.receiptDataUrl ? 120000 : 30000) }); }
    catch { throw Object.assign(new Error('The server did not confirm this cost. Check your connection, then retry; the same entry will not be saved twice.'), { status: 0 }); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw Object.assign(new Error(data.error || 'Job costs are unavailable. Retry shortly.'), { status: response.status, code: data.code });
    if (data.jobId !== S.jobId || !Array.isArray(data.entries) || !data.totals || !Number.isSafeInteger(data.totals.totalCents)) throw Object.assign(new Error('Job costs could not be verified. Retry before relying on these totals.'), { status: 0 });
    return data;
  }
  async function load() {
    const generation = ++S.generation;
    S.loading = true; S.error = ''; render();
    try { const data = await api(`/api/field-expenses?jobId=${encodeURIComponent(S.jobId)}`); if (generation === S.generation) S.data = data; }
    catch (error) {
      if (generation !== S.generation) return;
      // A missing or disabled endpoint hides the section instead of alarming crew.
      if (error.status === 404 && (!error.code || error.code === 'FIELD_EXPENSES_DISABLED')) S.hidden = true; else S.error = error.message;
    } finally { if (generation === S.generation) { S.loading = false; render(); } }
  }
  function settle(message, isError = false) { S.feedback = message; S.feedbackError = isError; }
  async function send(input) {
    if (S.busy) return;
    const jobId = S.jobId, user = S.user, stale = () => jobId !== S.jobId || user !== S.user;
    S.busy = true; S.formError = ''; settle(''); render();
    try {
      const data = await api('/api/field-expenses', input);
      if (stale()) return;
      S.data = data; S.pending = null; persistPending();
      if (input.action === 'create') { S.draft = blank(); S.receipt = ''; remember(); }
      else { S.editing = ''; S.editDraft = null; S.voiding = ''; S.voidReason = ''; }
      const voided = input.action === 'create' && data.entryStatus === 'void';
      settle(voided ? 'This cost was saved earlier, but operations has since voided it. It does not count toward the job.' : data.alreadyApplied ? 'This cost was already saved. The current entries are shown.' : input.action === 'void' ? 'Cost voided. The audit trail keeps the original entry.' : input.action === 'edit' ? 'Correction saved to the audit trail.' : 'Cost saved to the job.', voided);
    } catch (error) {
      if (stale()) return;
      // A receipt create that hit a revision conflict is still unconfirmed, so
      // its retry is kept; for corrections the conflict is a final answer.
      const final = [400, 403, 404, 413, 415].includes(error.status) || ['FIELD_IDEMPOTENCY_CONFLICT', 'FIELD_JOB_CLOSED', 'FIELD_EXPENSE_LIMIT', 'FIELD_EXPENSE_PENDING_LIMIT', 'FIELD_EXPENSE_VOID', 'FIELD_EXPENSE_PENDING', 'FIELD_EXPENSE_AUDIT_FULL', 'FIELD_ACCOUNT_CHANGED'].includes(error.code) || (error.code === 'FIELD_EXPENSE_REVISION_CONFLICT' && input.action !== 'create');
      if (final) { S.pending = null; persistPending(); }
      // A voided entry exists on the server; clear the draft so it is not re-saved by accident.
      if (input.action === 'create' && error.code === 'FIELD_EXPENSE_VOID') { S.draft = blank(); S.receipt = ''; remember(); }
      else if (input.action === 'create' && final) S.formError = error.message;
      settle(error.message, true);
      if (['FIELD_EXPENSE_REVISION_CONFLICT', 'FIELD_JOB_CLOSED', 'FIELD_EXPENSE_VOID'].includes(error.code)) { S.busy = false; await load(); }
    } finally { if (!stale()) { S.busy = false; render(); } }
  }
  function submit(event) {
    event.preventDefault();
    if (S.busy || S.pending || S.receiptBusy) return;
    const cents = parseCents(S.draft.amount), vendor = S.draft.vendor.trim(), note = S.draft.note.trim();
    const problem = cents == null || cents < 1 || cents > maxCents() ? `Enter an amount between $0.01 and ${money(maxCents())}, for example 42.50.` : vendor.length < 2 ? 'Enter the store, landfill or vendor.' : S.draft.kind === 'other' && note.length < 3 ? 'Describe what this other cost was for.' : '';
    if (problem) { S.formError = problem; render(); S.host?.querySelector('[aria-invalid=true]')?.focus(); return; }
    S.pending = { action: 'create', jobId: S.jobId, requestId: crypto.randomUUID(), kind: S.draft.kind, amountCents: cents, vendor, note, expectedUser: S.user, ...(S.receipt ? { receiptDataUrl: S.receipt } : {}) };
    persistPending(); send(S.pending);
  }
  function change(entry, action, fields) {
    if (S.busy || S.pending) return;
    S.pending = { action, jobId: S.jobId, requestId: crypto.randomUUID(), expenseId: entry.id, expectedRevision: entry.expectedRevision, expectedUser: S.user, ...fields };
    persistPending(); send(S.pending);
  }
  async function compressReceipt(file) {
    if (!file || file.size > 40 * 1024 * 1024 || file.size === 0 || !/^image\//i.test(file.type || 'image/unknown')) throw new Error('Choose a receipt image smaller than 40 MB.');
    const url = URL.createObjectURL(file), image = new Image();
    try {
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('This phone could not open the receipt photo. Take a new photo.')); image.src = url; });
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth || 1, image.naturalHeight || 1)), canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d'); if (!context) throw new Error('Receipt conversion is unavailable. Retry with a JPG.');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > 8 * 1024 * 1024) throw new Error('This receipt photo is too large after resizing. Retake it closer.');
      return dataUrl;
    } finally { URL.revokeObjectURL(url); }
  }
  async function chooseReceipt(input) {
    const file = input.files?.[0]; input.value = '';
    if (!file || S.busy) return;
    S.receiptBusy = true; S.formError = ''; render();
    const jobId = S.jobId;
    try { const dataUrl = await compressReceipt(file); if (jobId === S.jobId) S.receipt = dataUrl; }
    catch (error) { S.formError = error.message; }
    finally { S.receiptBusy = false; render(); }
  }
  function field(id, text, control, hint) { return h('div', { class: 'field' }, h('label', { for: id }, text), control, hint ? h('small', { id: `${id}-hint` }, hint) : null); }
  function kindSelect(id, value, onchange, disabled) { return h('select', { id, disabled, onchange }, KINDS.map(([kind, text]) => h('option', { value: kind, selected: kind === value }, text))); }
  function amountInput(id, value, oninput, invalid, disabled) { return h('div', { class: 'expense-amount' }, h('span', { 'aria-hidden': 'true' }, '$'), h('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'next', placeholder: '0.00', maxLength: 12, value, required: true, disabled, 'aria-invalid': invalid ? 'true' : null, oninput })); }
  function recordForm() {
    const locked = S.busy || !!S.pending, d = S.draft, amountInvalid = /amount/i.test(S.formError), vendorInvalid = /vendor/i.test(S.formError), noteInvalid = /other|Notes must/i.test(S.formError);
    const receiptControls = S.data.receiptsAvailable ? h('div', { class: 'field expense-receipt' },
      h('span', { class: 'expense-label' }, 'Receipt photo (recommended)'),
      S.receipt ? h('div', { class: 'expense-receipt-preview' }, h('img', { src: S.receipt, alt: 'Receipt ready to upload', width: 96, height: 128 }), h('div', {}, h('p', {}, 'Receipt attached. It uploads privately when you save.'), h('button', { type: 'button', disabled: locked, onclick: () => { S.receipt = ''; render(); } }, 'Remove receipt')))
        : [h('label', { for: 'expense-receipt-camera' }, 'Take a receipt photo'), h('input', { id: 'expense-receipt-camera', type: 'file', accept: 'image/*', capture: 'environment', disabled: locked || S.receiptBusy, onchange: event => chooseReceipt(event.target) }),
          h('label', { for: 'expense-receipt-library' }, 'Or choose a saved photo'), h('input', { id: 'expense-receipt-library', type: 'file', accept: 'image/*', disabled: locked || S.receiptBusy, onchange: event => chooseReceipt(event.target) })],
      S.receiptBusy ? h('small', { role: 'status' }, 'Preparing receipt photo…') : null)
      : h('p', { class: 'notice' }, 'Receipt photos are unavailable right now. Save the amount and give the paper receipt to operations.');
    return h('form', { class: 'expense-form', novalidate: true, onsubmit: submit },
      field('expense-kind', 'Type of cost', kindSelect('expense-kind', d.kind, event => { d.kind = event.target.value; remember(); render(); S.host?.querySelector('#expense-kind')?.focus(); }, locked)),
      field('expense-amount', 'Amount paid (USD)', amountInput('expense-amount', d.amount, event => { d.amount = event.target.value; remember(); }, amountInvalid, locked)),
      field('expense-vendor', 'Store, landfill or vendor', h('input', { id: 'expense-vendor', type: 'text', autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'next', maxLength: 120, value: d.vendor, required: true, disabled: locked, 'aria-invalid': vendorInvalid ? 'true' : null, oninput: event => { d.vendor = event.target.value; remember(); } })),
      field('expense-note', noteLabel(d.kind), h('textarea', { id: 'expense-note', rows: 2, maxLength: 1000, value: d.note, required: d.kind === 'other', disabled: locked, 'aria-invalid': noteInvalid ? 'true' : null, placeholder: 'Items bought, load size or reason', oninput: event => { d.note = event.target.value; remember(); } })),
      receiptControls,
      S.formError ? h('p', { class: 'notice error', role: 'alert' }, S.formError) : null,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit', disabled: locked || S.receiptBusy }, S.busy && S.pending?.action === 'create' ? 'Saving…' : 'Save cost')));
  }
  function pendingCard() {
    if (!S.pending) return null;
    const label = S.pending.action === 'create' ? `${kindLabel(S.pending.kind)} · ${money(S.pending.amountCents)}` : S.pending.action === 'void' ? 'Void a cost' : 'Cost correction';
    return h('div', { class: 'notice expense-pending' }, h('strong', {}, 'Cost awaiting confirmation'), h('p', {}, `${label} was not confirmed. Retry sends the same entry, so it cannot be saved twice.${S.volatile ? ' Keep this page open; this device could not store the retry.' : ''}`),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', disabled: S.busy, onclick: () => send(S.pending) }, S.busy ? 'Checking…' : 'Retry cost'), h('button', { type: 'button', disabled: S.busy, onclick: async () => { await load(); if (!S.error) { S.pending = null; persistPending(); settle('Current costs loaded. Retry cleared; check the list before re-entering.'); render(); } } }, 'Check list and clear retry')));
  }
  function totals() {
    const t = S.data.totals, own = S.data.scope !== 'job';
    return h('div', { class: 'expense-totals' },
      h('dl', { class: `detail-grid${own ? ' expense-own' : ''}` }, h('div', {}, h('dt', {}, own ? 'Your recorded total' : 'Job total'), h('dd', { class: 'expense-total' }, money(t.totalCents))),
        ...(own ? [] : KINDS.map(([kind, text]) => h('div', {}, h('dt', {}, text), h('dd', {}, money(t.byKind?.[kind] || 0)))))),
      t.pendingCount ? h('p', { class: 'notice' }, `${t.pendingCount} cost${t.pendingCount === 1 ? ' is' : 's are'} waiting for receipt verification and not included.`) : null,
      t.invalidCount ? h('p', { class: 'notice error' }, `${t.invalidCount} stored cost${t.invalidCount === 1 ? '' : 's'} could not be read and ${t.invalidCount === 1 ? 'is' : 'are'} excluded. Review before using these totals.`) : null);
  }
  function editForm(entry) {
    const e = S.editDraft, locked = S.busy || !!S.pending, today = mountainDate(new Date()), earliest = shiftDate(today, -366);
    return h('form', { class: 'expense-edit', novalidate: true, onsubmit: event => {
      event.preventDefault();
      const cents = parseCents(e.amount), fields = {};
      if (cents == null || cents < 1 || cents > maxCents()) { settle('Enter a valid corrected amount.', true); render(); return; }
      if (e.kind !== entry.kind) fields.kind = e.kind; if (cents !== entry.amountCents) fields.amountCents = cents; if (e.vendor.trim() !== entry.vendor) fields.vendor = e.vendor.trim(); if (e.note.trim() !== entry.note) fields.note = e.note.trim();
      if (e.incurredOn !== (entry.incurredOn || '')) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(e.incurredOn) || e.incurredOn > today || e.incurredOn < earliest) { settle('Choose a purchase date within the last year (Mountain Time).', true); render(); return; }
        fields.incurredOn = e.incurredOn;
      }
      if (e.kind === 'other' && e.note.trim().length < 3 && ('kind' in fields || 'note' in fields)) { settle('Describe what this other cost was for.', true); render(); return; }
      if (!Object.keys(fields).length) { settle('Change at least one value before saving the correction.', true); render(); return; }
      if (e.reason.trim().length < 3) { settle('Give a reason for the correction.', true); render(); return; }
      change(entry, 'edit', { ...fields, reason: e.reason.trim() });
    } },
    field(`edit-kind-${entry.id}`, 'Type of cost', kindSelect(`edit-kind-${entry.id}`, e.kind, event => { e.kind = event.target.value; render(); S.host?.querySelector(`#edit-kind-${entry.id}`)?.focus(); }, locked)),
    field(`edit-amount-${entry.id}`, 'Corrected amount (USD)', amountInput(`edit-amount-${entry.id}`, e.amount, event => { e.amount = event.target.value; }, false, locked)),
    field(`edit-vendor-${entry.id}`, 'Store, landfill or vendor', h('input', { id: `edit-vendor-${entry.id}`, type: 'text', autocomplete: 'off', maxLength: 120, value: e.vendor, disabled: locked, oninput: event => { e.vendor = event.target.value; } })),
    field(`edit-date-${entry.id}`, 'Purchase date (Mountain Time)', h('input', { id: `edit-date-${entry.id}`, type: 'date', min: earliest, max: today, value: e.incurredOn, disabled: locked, oninput: event => { e.incurredOn = event.target.value; } })),
    field(`edit-note-${entry.id}`, noteLabel(e.kind, 'Note'), h('textarea', { id: `edit-note-${entry.id}`, rows: 2, maxLength: 1000, value: e.note, required: e.kind === 'other', disabled: locked, oninput: event => { e.note = event.target.value; } })),
    field(`edit-reason-${entry.id}`, 'Reason for correction (kept in audit trail)', h('input', { id: `edit-reason-${entry.id}`, type: 'text', autocomplete: 'off', maxLength: 500, value: e.reason, required: true, disabled: locked, oninput: event => { e.reason = event.target.value; } })),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit', disabled: locked }, 'Save correction'), h('button', { type: 'button', disabled: S.busy, onclick: () => { S.editing = ''; S.editDraft = null; render(); } }, 'Cancel')));
  }
  function voidForm(entry) {
    const locked = S.busy || !!S.pending;
    return h('form', { class: 'expense-edit', novalidate: true, onsubmit: event => { event.preventDefault(); if (S.voidReason.trim().length < 3) { settle('Give a reason for voiding this cost.', true); render(); return; } change(entry, 'void', { reason: S.voidReason.trim() }); } },
      field(`void-reason-${entry.id}`, 'Reason for voiding (kept in audit trail)', h('input', { id: `void-reason-${entry.id}`, type: 'text', autocomplete: 'off', maxLength: 500, value: S.voidReason, required: true, disabled: locked, oninput: event => { S.voidReason = event.target.value; } })),
      h('div', { class: 'actions' }, h('button', { class: 'danger', type: 'submit', disabled: locked }, 'Void cost'), h('button', { type: 'button', disabled: S.busy, onclick: () => { S.voiding = ''; S.voidReason = ''; render(); } }, 'Cancel')));
  }
  function purchased(entry) {
    let recorded = '';
    try { recorded = entry.createdAt ? mountainDate(new Date(entry.createdAt)) : ''; } catch { recorded = ''; }
    return /^\d{4}-\d{2}-\d{2}$/.test(entry.incurredOn || '') && entry.incurredOn !== recorded ? `purchased ${dayLabel(entry.incurredOn)}` : '';
  }
  function entryItem(entry) {
    const manager = S.data.scope === 'job', locked = S.busy || !!S.pending;
    const badges = [entry.status === 'void' ? ['Void', 'alert'] : null, entry.state !== 'applied' ? ['Receipt not verified', 'alert'] : entry.receiptVerified ? ['Receipt saved', 'done'] : null, entry.edited ? ['Corrected', ''] : null, entry.needsReview ? ['Needs review', 'alert'] : null].filter(Boolean);
    const receiptLink = manager && typeof entry.receiptUrl === 'string' && entry.receiptUrl.startsWith('/api/field-expenses?') ? h('a', { class: 'button', href: entry.receiptUrl, target: '_blank', rel: 'noopener' }, 'View receipt') : null;
    return h('li', { class: `expense-item${entry.status === 'void' ? ' void' : ''}`, 'data-expense': entry.id },
      h('div', { class: 'expense-row' }, h('strong', {}, kindLabel(entry.kind)), h('span', { class: 'expense-value' }, money(entry.amountCents))),
      h('small', { class: 'expense-meta' }, [entry.vendor, stamp(entry.createdAt), purchased(entry), manager ? `by ${entry.recordedBy?.name || entry.recordedBy?.id || 'crew'}` : ''].filter(Boolean).join(' · ')),
      badges.length ? h('div', { class: 'expense-badges' }, badges.map(([text, tone]) => h('span', { class: `badge ${tone}` }, text))) : null,
      entry.note ? h('p', { class: 'text-block' }, entry.note) : null,
      manager && entry.voided ? h('small', { class: 'expense-meta' }, `Voided by ${entry.voided.by?.name || entry.voided.by?.id} · ${stamp(entry.voided.at)} · ${entry.voided.reason}`) : null,
      manager && (receiptLink || entry.canEdit || entry.canVoid) && S.editing !== entry.id && S.voiding !== entry.id ? h('div', { class: 'actions' }, receiptLink,
        entry.canEdit ? h('button', { type: 'button', disabled: locked, onclick: () => { S.voiding = ''; S.editing = entry.id; S.editDraft = { kind: entry.kind, amount: amountText(entry.amountCents), vendor: entry.vendor, note: entry.note, incurredOn: entry.incurredOn || '', reason: '' }; render(); } }, 'Correct') : null,
        entry.canVoid ? h('button', { type: 'button', class: 'danger', disabled: locked, onclick: () => { S.editing = ''; S.voiding = entry.id; S.voidReason = ''; render(); } }, 'Void') : null) : null,
      manager && S.editing === entry.id && S.editDraft ? editForm(entry) : null,
      manager && S.voiding === entry.id ? voidForm(entry) : null,
      manager && entry.audit?.length ? h('details', {}, h('summary', {}, `Audit trail · ${entry.audit.length}`), entry.audit.map(item => h('p', { class: 'expense-audit' }, `${item.action === 'void' ? 'Voided' : 'Corrected'} by ${item.by?.name || item.by?.id} · ${stamp(item.at)} — ${item.reason}${item.action === 'edit' ? ` (${Object.keys(item.after || {}).map(name => `${AUDIT_NAMES[name] || name}: ${name === 'amountCents' ? `${money(item.before?.[name])} → ${money(item.after[name])}` : `${item.before?.[name] || '—'} → ${item.after[name] || '—'}`}`).join('; ')})` : ''}`))) : null);
  }
  function render() {
    const host = S.host; if (!host) return;
    host.hidden = S.hidden; if (S.hidden) { host.replaceChildren(); return; }
    const heading = h('div', { class: 'section-heading' }, h('h2', {}, 'Job costs'), h('span', { class: 'eyebrow' }, S.manager ? 'Manager view' : 'Materials & dump fees'));
    if (!S.data) {
      fill(host, heading, S.error ? h('div', { class: 'notice error', role: 'alert' }, h('p', {}, S.error), h('button', { type: 'button', onclick: load }, 'Retry')) : h('div', { class: 'expense-skeleton', role: 'status', 'aria-label': 'Loading job costs' }, h('span', {}), h('span', {}), h('span', {})));
      return;
    }
    const own = S.data.scope !== 'job', entries = S.data.entries;
    fill(host, heading,
      h('p', { class: 'muted' }, own ? 'Record materials you bought and dump or disposal fees for this job. Only you and operations managers see these amounts.' : 'Every recorded field cost for this job. Corrections and voids keep an audit trail.'),
      S.feedback ? h('p', { class: S.feedbackError ? 'notice error' : 'expense-ok', role: S.feedbackError ? 'alert' : 'status' }, S.feedback) : null,
      S.error ? h('p', { class: 'notice error', role: 'alert' }, S.error) : null,
      pendingCard(),
      S.data.canRecord ? recordForm() : h('p', { class: 'notice' }, 'This job is closed for new costs. Ask operations to record any late receipts.'),
      h('h3', {}, own ? 'Your recorded costs' : 'All recorded costs'),
      entries.length ? totals() : null,
      entries.length ? h('ul', { class: 'expense-list' }, entries.map(entryItem)) : h('p', { class: 'empty' }, own ? 'You have not recorded any costs on this job.' : 'No field costs recorded for this job yet.'),
      own && entries.length ? h('small', { class: 'muted' }, 'Entered something wrong? Ask an operations manager to correct or void it.') : null,
      S.loading ? h('small', { role: 'status' }, 'Refreshing job costs…') : null);
  }
  function reset() { S.generation++; Object.assign(S, { data: null, loading: false, error: '', hidden: false, busy: false, pending: null, volatile: false, receipt: '', receiptBusy: false, formError: '', feedback: '', feedbackError: false, draft: blank(), editing: '', editDraft: null, voiding: '', voidReason: '' }); }
  function mount(host, options = {}) {
    const jobId = String(options.jobId || ''), user = String(options.user || '');
    S.host = host; S.manager = options.manager === true;
    if (jobId !== S.jobId || user !== S.user) {
      reset(); S.jobId = jobId; S.user = user;
      const pending = stored('pending'), draft = stored('draft');
      if (pending && pending.jobId === jobId && pending.expectedUser === user) S.pending = pending;
      if (draft && typeof draft === 'object') S.draft = { ...blank(), ...Object.fromEntries(['kind', 'amount', 'vendor', 'note'].filter(name => typeof draft[name] === 'string').map(name => [name, draft[name].slice(0, 1000)])) };
      if (!KINDS.some(([kind]) => kind === S.draft.kind)) S.draft.kind = 'material';
      if (jobId && user) return load();
    }
    render();
  }
  function unmount() { S.generation++; S.host?.replaceChildren(); S.host = null; }
  window.addEventListener('egc:signout', () => { try { for (let index = sessionStorage.length - 1; index >= 0; index--) { const name = sessionStorage.key(index); if (name?.startsWith('egc-field:') && name.includes(':expense-')) sessionStorage.removeItem(name); } } catch { /* Nothing further is stored. */ } reset(); S.jobId = ''; S.user = ''; render(); });
  window.addEventListener('beforeunload', event => { if (S.busy || S.receiptBusy || (S.pending && S.volatile)) { event.preventDefault(); event.returnValue = ''; } });
  window.EGCFieldExpenses = { mount, unmount, refresh: () => (S.jobId ? load() : Promise.resolve()), canLeave: () => !S.busy && !(S.pending && S.volatile), parseCents };
})();
