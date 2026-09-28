(function () {
  'use strict';
  const KINDS = [['material', 'Materials'], ['dump_fee', 'Dump / disposal fee'], ['subcontractor', 'Subcontractor / helper'], ['fuel', 'Fuel'], ['damage_claim', 'Damage claim'], ['other', 'Other'], ['recovery_income', 'Recovery income (scrap, resale)']];
  const PAYERS = [['company_card', 'Company card'], ['crew_reimbursable', 'I paid (reimburse me)'], ['account_billed', 'Billed to a company account']];
  const GROUPS = { material: ['Materials', 'No materials', 'materials'], dump_fee: ['Dump / disposal fees', 'No dump fees', 'dump fees'], other_costs: ['Other costs (helpers, fuel, damage)', 'No other costs', 'other costs'] };
  const OPEN_NAMES = { subcontractor: 'helpers', fuel: 'fuel', damage_claim: 'damage claims', other: 'other costs' };
  const VENDORS = { subcontractor: 'Helper or company paid', damage_claim: 'Paid to (customer or claimant)', recovery_income: 'Buyer (scrap yard or reseller)' };
  const FALLBACK_MAX_CENTS = 500000, LEGACY_KINDS = ['material', 'dump_fee', 'other'];
  const blank = () => ({ kind: 'material', amount: '', vendor: '', note: '', payer: '', photos: [], split: false, shares: {} });
  const S = { host: null, jobId: '', user: '', manager: false, data: null, loading: false, error: '', hidden: false, busy: false, pending: null, volatile: false, receipt: '', receiptBusy: false, formError: '', feedback: '', feedbackError: false, draft: blank(), editing: '', editDraft: null, voiding: '', voidReason: '', generation: 0, shareJobs: null, shareLoading: false, shareError: '', shareToken: 0 };
  function h(tag, props, ...children) { const node = document.createElement(tag); for (const [name, value] of Object.entries(props || {})) { if (value == null || value === false) continue; if (name === 'class') node.className = value; else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2), value); else if (name in node && !name.startsWith('aria-') && name !== 'list') node[name] = value; else node.setAttribute(name, String(value)); } for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child))); return node; }
  const fill = (host, ...children) => host.replaceChildren(...children.flat(Infinity).filter(child => child != null && child !== false));
  const kindLabel = kind => (KINDS.find(([value]) => value === kind) || KINDS[5])[1];
  const payerLabel = payer => (PAYERS.find(([value]) => value === payer) || [null, ''])[1];
  const money = cents => Number.isSafeInteger(cents) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100) : 'Needs review';
  const stamp = value => { try { return value ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : ''; } catch { return ''; } };
  const maxCents = () => S.data?.limits?.maxAmountCents || FALLBACK_MAX_CENTS;
  const limit = (name, fallback) => Array.isArray(S.data?.limits?.[name]) ? S.data.limits[name] : fallback;
  // Only kinds, payers and splits the server advertises are offered, so an older server keeps the older form.
  const kinds = () => KINDS.filter(([kind]) => limit('kinds', LEGACY_KINDS).includes(kind));
  const payersOn = () => limit('payers', []).length > 0;
  const income = kind => limit('incomeKinds', ['recovery_income']).includes(kind);
  const shareable = kind => limit('shareableKinds', []).includes(kind) && Number.isSafeInteger(S.data?.limits?.maxShareJobs);
  const mountainDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  const shiftDate = (date, days) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
  const dayLabel = date => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`)); } catch { return date; } };
  const noteLabel = (kind, optional = 'Note (optional)') => kind === 'other' ? 'What was it for? (required)' : kind === 'damage_claim' ? 'Describe the claim (required)' : optional;
  const vendorLabel = kind => VENDORS[kind] || 'Store, landfill or vendor';
  const AUDIT_NAMES = { amountCents: 'amount', incurredOn: 'purchase date', kind: 'type', payer: 'who paid', damagePhotoIds: 'damage photos', loadTotalCents: 'load total' };
  const key = suffix => `egc-field:${S.user}:${S.jobId}:expense-${suffix}`;
  function parseCents(text) {
    const match = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(text ?? '').trim());
    if (!match) return null;
    const cents = Number(match[1].replaceAll(',', '')) * 100 + Number((match[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(cents) ? cents : null;
  }
  // The server's shared-load rule, for the preview: floor(total x weight / sum), then the leftover cents one
  // each to the largest remainders, ties to the earlier job (this job first). null when a part would be 0.
  function splitCents(totalCents, weights) {
    const sum = weights.reduce((a, b) => a + b, 0), cents = weights.map(weight => Math.floor(totalCents * weight / sum));
    const order = weights.map((weight, index) => ({ index, remainder: totalCents * weight % sum })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let left = totalCents - cents.reduce((a, b) => a + b, 0), at = 0; left > 0; left--, at++) cents[order[at].index]++;
    return cents.some(value => value < 1) ? null : cents;
  }
  const weightOf = text => /^\d{1,3}$/.test(String(text ?? '').trim()) ? Number(String(text).trim()) : null;
  const amountText = cents => Number.isSafeInteger(cents) ? (cents / 100).toFixed(2) : '';
  function store(suffix, value) { try { value == null ? sessionStorage.removeItem(key(suffix)) : sessionStorage.setItem(key(suffix), JSON.stringify(value)); return true; } catch { return false; } }
  function stored(suffix) { try { return JSON.parse(sessionStorage.getItem(key(suffix)) || 'null'); } catch { return null; } }
  function remember() { const d = S.draft; if (S.jobId && S.user) store('draft', d.amount || d.vendor || d.note || d.kind !== 'material' || d.payer || d.photos.length || d.split ? d : null); }
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
  // The viewer's other jobs on this job's days, for splitting a shared load.
  async function loadShareJobs() {
    const token = ++S.shareToken, jobId = S.jobId;
    S.shareLoading = true; S.shareError = ''; render();
    try {
      const response = await fetch(`/api/field-expenses?jobId=${encodeURIComponent(jobId)}&view=share_jobs`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'Your other jobs could not be loaded. Retry.');
      if (data.jobId !== jobId || !Array.isArray(data.jobs)) throw new Error('Your other jobs could not be verified. Retry.');
      if (token === S.shareToken) S.shareJobs = data.jobs.filter(item => item && typeof item.jobId === 'string' && item.jobId !== jobId);
    } catch (error) { if (token === S.shareToken) S.shareError = error.name === 'TimeoutError' || error instanceof TypeError ? 'Your other jobs could not be loaded. Check your connection and retry.' : error.message; }
    finally { if (token === S.shareToken) { S.shareLoading = false; render(); } }
  }
  function settle(message, isError = false) { S.feedback = message; S.feedbackError = isError; }
  function success(input, data) {
    if (input.action === 'attest') return data.alreadyApplied ? 'Already marked None. The current closeout is shown.' : `Saved: ${GROUPS[input.group]?.[1] || 'None'}.`;
    if (input.action === 'create' && data.entryStatus === 'void') return 'This cost was saved earlier, but operations has since voided it. It does not count toward the job.';
    if (data.alreadyApplied) return 'This cost was already saved. The current entries are shown.';
    return input.action === 'void' ? 'Cost voided. The audit trail keeps the original entry.' : input.action === 'edit' ? 'Correction saved to the audit trail.' : input.shares ? `Shared load saved across ${input.shares.length} jobs.` : 'Cost saved to the job.';
  }
  async function send(input) {
    if (S.busy) return;
    const jobId = S.jobId, user = S.user, stale = () => jobId !== S.jobId || user !== S.user;
    S.busy = true; S.formError = ''; settle(''); render();
    try {
      const data = await api('/api/field-expenses', input);
      if (stale()) return;
      S.data = data; S.pending = null; persistPending();
      if (input.action === 'create') { S.draft = blank(); S.receipt = ''; remember(); }
      else if (input.action !== 'attest') { S.editing = ''; S.editDraft = null; S.voiding = ''; S.voidReason = ''; }
      settle(success(input, data), input.action === 'create' && data.entryStatus === 'void');
    } catch (error) {
      if (stale()) return;
      // A receipt create that hit a revision conflict is still unconfirmed, so
      // its retry is kept; for corrections the conflict is a final answer.
      const final = [400, 403, 404, 413, 415].includes(error.status) || ['FIELD_IDEMPOTENCY_CONFLICT', 'FIELD_JOB_CLOSED', 'FIELD_EXPENSE_LIMIT', 'FIELD_EXPENSE_PENDING_LIMIT', 'FIELD_EXPENSE_VOID', 'FIELD_EXPENSE_PENDING', 'FIELD_EXPENSE_AUDIT_FULL', 'FIELD_ACCOUNT_CHANGED', 'FIELD_EXPENSE_CLOSEOUT_ENTERED', 'FIELD_EXPENSE_SHARE_INCOMPLETE'].includes(error.code) || (error.code === 'FIELD_EXPENSE_REVISION_CONFLICT' && input.action !== 'create');
      if (final) { S.pending = null; persistPending(); }
      // A voided entry exists on the server; clear the draft so it is not re-saved by accident.
      if (input.action === 'create' && error.code === 'FIELD_EXPENSE_VOID') { S.draft = blank(); S.receipt = ''; remember(); }
      else if (input.action === 'create' && final) S.formError = error.message;
      settle(error.message, true);
      if (['FIELD_EXPENSE_REVISION_CONFLICT', 'FIELD_JOB_CLOSED', 'FIELD_EXPENSE_VOID', 'FIELD_EXPENSE_CLOSEOUT_ENTERED'].includes(error.code)) { S.busy = false; await load(); }
    } finally { if (!stale()) { S.busy = false; render(); } }
  }
  // The split as the server stores it: this job first, then the chosen jobs in job-ID (code-unit) order, not tap order,
  // so the preview gives a tied leftover cent to the same job the server does.
  function splitShares(d) {
    const chosen = Object.keys(d.shares).filter(jobId => jobId !== S.jobId && (S.shareJobs || []).some(item => item.jobId === jobId)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    return [{ jobId: S.jobId, weight: weightOf(d.shares[S.jobId] ?? '1') }, ...chosen.map(jobId => ({ jobId, weight: weightOf(d.shares[jobId]) }))];
  }
  function splitProblem(d, cents) {
    if (!d.split || !shareable(d.kind)) return '';
    if (!S.shareJobs) return 'Wait for your other jobs to load, or turn off the shared load.';
    const shares = splitShares(d), most = S.data.limits.maxShareJobs, top = S.data.limits.maxShareWeight || 100;
    if (shares.length < 2) return 'Choose at least one other job to split with, or turn off the shared load.';
    if (shares.length > most) return `Split a shared load across at most ${most} jobs.`;
    if (shares.some(share => share.weight == null || share.weight < 1 || share.weight > top)) return `Give each job a share from 1 to ${top}.`;
    return splitCents(cents, shares.map(share => share.weight)) ? '' : 'This amount is too small to split across these jobs.';
  }
  function submit(event) {
    event.preventDefault();
    if (S.busy || S.pending || S.receiptBusy) return;
    const d = S.draft, cents = parseCents(d.amount), vendor = d.vendor.trim(), note = d.note.trim(), payerNeeded = payersOn() && !income(d.kind), photos = d.kind === 'damage_claim' ? d.photos.filter(id => (S.data.damagePhotos || []).some(item => item.id === id)) : [];
    const problem = cents == null || cents < 1 || cents > maxCents() ? `Enter an amount between $0.01 and ${money(maxCents())}, for example 42.50.` : vendor.length < 2 ? `Enter the ${vendorLabel(d.kind).toLowerCase()}.` : d.kind === 'other' && note.length < 3 ? 'Describe what this other cost was for.' : d.kind === 'damage_claim' && note.length < 3 ? 'Describe the damage claim.'
      : payerNeeded && !PAYERS.some(([payer]) => payer === d.payer) ? 'Choose who paid.' : d.kind === 'damage_claim' && !photos.length ? 'Choose at least one damage photo from this job.' : splitProblem(d, cents);
    if (problem) { S.formError = problem; render(); S.host?.querySelector('[aria-invalid=true]')?.focus(); return; }
    S.pending = { action: 'create', jobId: S.jobId, requestId: crypto.randomUUID(), kind: d.kind, amountCents: cents, vendor, note, ...(payerNeeded ? { payer: d.payer } : {}), ...(d.kind === 'damage_claim' ? { damagePhotoIds: photos } : {}), ...(d.split && shareable(d.kind) ? { shares: splitShares(d) } : {}), expectedUser: S.user, ...(S.receipt ? { receiptDataUrl: S.receipt } : {}) };
    persistPending(); send(S.pending);
  }
  function change(entry, action, fields) {
    if (S.busy || S.pending) return;
    S.pending = { action, jobId: S.jobId, requestId: crypto.randomUUID(), expenseId: entry.id, expectedRevision: entry.expectedRevision, expectedUser: S.user, ...fields };
    persistPending(); send(S.pending);
  }
  function attest(group) {
    if (S.busy || S.pending) return;
    S.pending = { action: 'attest', jobId: S.jobId, requestId: crypto.randomUUID(), group, expectedUser: S.user };
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
  function kindSelect(id, value, onchange, disabled, allowed = kinds()) { return h('select', { id, disabled, onchange }, allowed.map(([kind, text]) => h('option', { value: kind, selected: kind === value }, text))); }
  function payerSelect(id, value, onchange, invalid, disabled, placeholder = 'Choose who paid') { return h('select', { id, disabled, required: true, 'aria-invalid': invalid ? 'true' : null, onchange }, h('option', { value: '', selected: !value }, placeholder), PAYERS.map(([payer, text]) => h('option', { value: payer, selected: payer === value }, text))); }
  function amountInput(id, value, oninput, invalid, disabled) { return h('div', { class: 'expense-amount' }, h('span', { 'aria-hidden': 'true' }, '$'), h('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'next', placeholder: '0.00', maxLength: 12, value, required: true, disabled, 'aria-invalid': invalid ? 'true' : null, oninput })); }
  // Toggle buttons (not 24px checkboxes) keep every choice a full-size tap target.
  const toggle = (pressed, text, onclick, disabled, extra = {}) => h('button', { type: 'button', class: `expense-toggle${pressed ? ' on' : ''}`, 'aria-pressed': pressed ? 'true' : 'false', disabled, onclick, ...extra }, h('span', { class: 'expense-tick', 'aria-hidden': 'true' }, pressed ? '✓' : ''), h('span', {}, text));
  function photoPicker(selected, onchange, disabled, invalid) {
    const photos = Array.isArray(S.data.damagePhotos) ? S.data.damagePhotos : [];
    return h('fieldset', { class: 'expense-photos', 'aria-invalid': invalid ? 'true' : null }, h('legend', {}, 'Damage photos (required)'),
      photos.length ? photos.map((item, index) => toggle(selected.includes(item.id), [item.caption || `Damage photo ${index + 1}`, item.createdAt ? ` · ${stamp(item.createdAt)}` : ''].join(''), () => onchange(selected.includes(item.id) ? selected.filter(id => id !== item.id) : [...selected, item.id]), disabled))
        : [h('p', { class: 'notice' }, 'Add a damage photo under Job photos first, then refresh Job costs.'), h('button', { type: 'button', disabled, onclick: load }, 'Refresh Job costs')]);
  }
  // jobId -> formatted part of the current amount, when the amount and every share are valid.
  function sharePreview(d, cents) {
    const shares = splitShares(d), parts = cents != null && shares.every(share => share.weight >= 1) ? splitCents(cents, shares.map(share => share.weight)) : null;
    return new Map(parts ? shares.map((share, index) => [share.jobId, money(parts[index])]) : []);
  }
  function refreshPreview() {
    if (!S.draft.split || !S.host) return;
    const preview = sharePreview(S.draft, parseCents(S.draft.amount));
    S.host.querySelectorAll('[data-share-preview]').forEach(node => { node.textContent = preview.get(node.getAttribute('data-share-preview')) || '—'; });
  }
  function splitControls(d, locked, cents) {
    if (!shareable(d.kind)) return null;
    const flip = () => { d.split = !d.split; S.formError = ''; remember(); if (d.split && !S.shareJobs && !S.shareLoading) loadShareJobs(); else render(); };
    const head = toggle(d.split, 'Shared load: split this cost with my other jobs', flip, locked, { id: 'expense-split' });
    if (!d.split) return h('div', { class: 'field expense-split' }, head);
    let body;
    if (S.shareLoading && !S.shareJobs) body = h('div', { class: 'expense-skeleton', role: 'status', 'aria-label': 'Loading your other jobs' }, h('span', {}), h('span', {}));
    else if (S.shareError && !S.shareJobs) body = h('div', { class: 'notice error', role: 'alert' }, h('p', {}, S.shareError), h('button', { type: 'button', onclick: loadShareJobs }, 'Retry'));
    else if (!S.shareJobs.length) body = h('p', { class: 'notice' }, 'You have no other current jobs on this job’s days. Turn off the shared load to record it here.');
    else {
      const part = jobId => sharePreview(d, cents).get(jobId) || '—';
      const weightInput = (jobId, label) => h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxLength: 3, class: 'expense-weight', 'aria-label': `Share for ${label}`, value: d.shares[jobId] ?? '1', disabled: locked, oninput: event => { d.shares[jobId] = event.target.value; remember(); refreshPreview(); } });
      const row = (jobId, label, chosen, choose) => h('li', { class: 'expense-share-row' }, choose ? toggle(chosen, label, choose, locked) : h('strong', { class: 'expense-share-self' }, label), chosen ? h('div', { class: 'expense-share-part' }, weightInput(jobId, label), h('span', { class: 'expense-share-amount', 'data-share-preview': jobId }, part(jobId))) : null);
      body = [h('p', { class: 'muted' }, 'Give each job its share of the load (1 to 100). The amount is split in whole cents.'),
        h('ul', { class: 'expense-share-list' }, row(S.jobId, 'This job', true, null), S.shareJobs.map(item => { const chosen = Object.hasOwn(d.shares, item.jobId); return row(item.jobId, [item.customer || item.jobId, item.time ? ` · ${item.time}` : '', item.date ? ` · ${dayLabel(item.date)}` : ''].join(''), chosen, () => { if (chosen) delete d.shares[item.jobId]; else d.shares[item.jobId] = '1'; S.formError = ''; remember(); render(); }); }))];
    }
    return h('div', { class: 'field expense-split' }, head, body);
  }
  function recordForm() {
    const locked = S.busy || !!S.pending, d = S.draft, amountInvalid = /amount/i.test(S.formError), vendorInvalid = /^Enter the /.test(S.formError), noteInvalid = /other|Notes must|Describe the damage/i.test(S.formError), payerInvalid = /who paid/i.test(S.formError), photoInvalid = /damage photo/i.test(S.formError), cents = parseCents(d.amount);
    const receiptControls = S.data.receiptsAvailable ? h('div', { class: 'field expense-receipt' },
      h('span', { class: 'expense-label' }, 'Receipt photo (recommended)'),
      S.receipt ? h('div', { class: 'expense-receipt-preview' }, h('img', { src: S.receipt, alt: 'Receipt ready to upload', width: 96, height: 128 }), h('div', {}, h('p', {}, 'Receipt attached. It uploads privately when you save.'), h('button', { type: 'button', disabled: locked, onclick: () => { S.receipt = ''; render(); } }, 'Remove receipt')))
        : [h('label', { for: 'expense-receipt-camera' }, 'Take a receipt photo'), h('input', { id: 'expense-receipt-camera', type: 'file', accept: 'image/*', capture: 'environment', disabled: locked || S.receiptBusy, onchange: event => chooseReceipt(event.target) }),
          h('label', { for: 'expense-receipt-library' }, 'Or choose a saved photo'), h('input', { id: 'expense-receipt-library', type: 'file', accept: 'image/*', disabled: locked || S.receiptBusy, onchange: event => chooseReceipt(event.target) })],
      S.receiptBusy ? h('small', { role: 'status' }, 'Preparing receipt photo…') : null)
      : h('p', { class: 'notice' }, 'Receipt photos are unavailable right now. Save the amount and give the paper receipt to operations.');
    return h('form', { class: 'expense-form', novalidate: true, onsubmit: submit },
      field('expense-kind', 'Type of cost', kindSelect('expense-kind', d.kind, event => { d.kind = event.target.value; remember(); render(); S.host?.querySelector('#expense-kind')?.focus(); }, locked)),
      field('expense-amount', income(d.kind) ? 'Amount received (USD)' : 'Amount paid (USD)', amountInput('expense-amount', d.amount, event => { d.amount = event.target.value; remember(); refreshPreview(); }, amountInvalid, locked)),
      field('expense-vendor', vendorLabel(d.kind), h('input', { id: 'expense-vendor', type: 'text', autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'next', maxLength: 120, value: d.vendor, required: true, disabled: locked, 'aria-invalid': vendorInvalid ? 'true' : null, oninput: event => { d.vendor = event.target.value; remember(); } })),
      payersOn() && !income(d.kind) ? field('expense-payer', 'Who paid?', payerSelect('expense-payer', d.payer, event => { d.payer = event.target.value; remember(); }, payerInvalid, locked)) : null,
      d.kind === 'damage_claim' ? photoPicker(d.photos, next => { d.photos = next; S.formError = ''; remember(); render(); }, locked, photoInvalid) : null,
      field('expense-note', noteLabel(d.kind), h('textarea', { id: 'expense-note', rows: 2, maxLength: 1000, value: d.note, required: ['other', 'damage_claim'].includes(d.kind), disabled: locked, 'aria-invalid': noteInvalid ? 'true' : null, placeholder: 'Items bought, load size or reason', oninput: event => { d.note = event.target.value; remember(); } })),
      splitControls(d, locked, cents),
      receiptControls,
      S.formError ? h('p', { class: 'notice error', role: 'alert' }, S.formError) : null,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit', disabled: locked || S.receiptBusy }, S.busy && S.pending?.action === 'create' ? 'Saving…' : 'Save cost')));
  }
  // Managers: whether the job's field costs are known, from the server's job-costing view.
  function costsNote(costs) {
    if (!costs || !['complete', 'partial', 'unknown'].includes(costs.status)) return null;
    if (costs.status === 'unknown') { const names = (Array.isArray(costs.missing) ? costs.missing : []).map(id => GROUPS[id]?.[2]).filter(Boolean); return `Job costs stay unknown until ${names.length ? names.join(' and ') : 'the closeout items'} are confirmed. Recorded so far: ${money(costs.knownCostCents)}.`; }
    return costs.status === 'complete' ? `Job field costs are complete: ${money(costs.netCostCents)} net.` : `Job field costs so far: ${money(costs.netCostCents)} net. Some can still change (receipts pending or entries to review).`;
  }
  // Closeout: each group is recorded, marked None, or still to confirm. A recorded kind confirms only itself, so a group
  // with some kinds recorded still asks about the rest. Crew never see others' amounts here.
  function closeoutCard() {
    const c = S.data.closeout;
    if (!c || !Array.isArray(c.groups)) return null;
    const locked = S.busy || !!S.pending, manager = S.data.scope === 'job', confirmed = typeof c.confirmed === 'boolean' ? c.confirmed : c.complete, note = manager ? costsNote(S.data.costs) : null;
    const settled = group => typeof group.confirmed === 'boolean' ? group.confirmed : group.state !== 'missing', open = group => (Array.isArray(group.openKinds) ? group.openKinds : []).map(kind => OPEN_NAMES[kind]).filter(Boolean);
    const status = group => group.state === 'entered' ? `Recorded (${group.entryCount})${group.pendingCount ? ' · receipt pending' : ''}${!settled(group) && open(group).length ? ` · still to confirm: ${open(group).join(', ')}` : ''}` : group.state === 'none' ? ['None', group.attestedByYou ? 'marked by you' : manager && group.attestedBy ? `marked by ${group.attestedBy.name || group.attestedBy.id}` : '', stamp(group.attestedAt)].filter(Boolean).join(' · ') : group.required ? 'Not confirmed yet' : 'Not confirmed yet · needed for final job costs';
    return h('section', { class: `expense-closeout${confirmed ? ' complete' : ''}`, 'aria-labelledby': 'expense-closeout-title' },
      h('div', { class: 'expense-closeout-head' }, h('h3', { id: 'expense-closeout-title' }, 'Closeout'), h('span', { class: `badge ${confirmed ? 'done' : 'alert'}` }, confirmed ? 'Confirmed' : c.complete ? 'Confirm other costs' : c.required ? 'Required before completing' : 'Please confirm')),
      h('p', { class: 'muted' }, 'Record every material purchase, dump fee and other cost with who paid, or tap None for each kind there was none of. A recorded cost always replaces a None.'),
      note ? h('p', { class: 'expense-costs-note' }, note) : null,
      h('ul', { class: 'expense-closeout-list' }, c.groups.filter(group => GROUPS[group.id]).map(group => h('li', { class: `expense-closeout-row ${group.state}${settled(group) ? '' : ' open'}`, 'data-group': group.id },
        h('div', { class: 'expense-closeout-text' }, h('strong', {}, GROUPS[group.id][0]), h('small', {}, status(group))),
        !settled(group) && S.data.canRecord ? h('button', { type: 'button', class: group.required ? 'primary' : '', disabled: locked, onclick: () => attest(group.id) }, S.busy && S.pending?.group === group.id ? 'Saving…' : group.state === 'entered' ? 'None of the rest' : GROUPS[group.id][1]) : h('span', { class: `badge ${settled(group) ? 'done' : ''}` }, group.state === 'entered' ? 'Recorded' : group.state === 'none' ? 'None' : 'Open')))));
  }
  function pendingCard() {
    if (!S.pending) return null;
    const label = S.pending.action === 'create' ? `${kindLabel(S.pending.kind)} · ${money(S.pending.amountCents)}` : S.pending.action === 'attest' ? `Closeout: ${GROUPS[S.pending.group]?.[1] || 'None'}` : S.pending.action === 'void' ? 'Void a cost' : 'Cost correction';
    return h('div', { class: 'notice expense-pending' }, h('strong', {}, 'Cost awaiting confirmation'), h('p', {}, `${label} was not confirmed. Retry sends the same entry, so it cannot be saved twice.${S.volatile ? ' Keep this page open; this device could not store the retry.' : ''}`),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', disabled: S.busy, onclick: () => send(S.pending) }, S.busy ? 'Checking…' : 'Retry cost'), h('button', { type: 'button', disabled: S.busy, onclick: async () => { await load(); if (!S.error) { S.pending = null; persistPending(); settle('Current costs loaded. Retry cleared; check the list before re-entering.'); render(); } } }, 'Check list and clear retry')));
  }
  function totals() {
    const t = S.data.totals, own = S.data.scope !== 'job', shown = kinds().filter(([kind]) => ['material', 'dump_fee'].includes(kind) || t.byKind?.[kind]);
    return h('div', { class: 'expense-totals' },
      h('dl', { class: `detail-grid${own ? ' expense-own' : ''}` }, h('div', {}, h('dt', {}, own ? 'Your recorded total' : 'Job total'), h('dd', { class: 'expense-total' }, money(t.totalCents))),
        ...(own ? [] : shown.map(([kind, text]) => h('div', {}, h('dt', {}, text), h('dd', {}, income(kind) ? `−${money(t.byKind?.[kind] || 0)}` : money(t.byKind?.[kind] || 0))))),
        ...(!own && t.byPayer?.crew_reimbursable ? [h('div', {}, h('dt', {}, 'Reimburse crew'), h('dd', {}, money(t.byPayer.crew_reimbursable)))] : [])),
      t.recoveryIncomeCents ? h('small', { class: 'muted' }, `Net of ${money(t.recoveryIncomeCents)} recovery income.`) : null,
      t.pendingCount ? h('p', { class: 'notice' }, `${t.pendingCount} cost${t.pendingCount === 1 ? ' is' : 's are'} waiting for receipt verification and not included.`) : null,
      t.invalidCount ? h('p', { class: 'notice error' }, `${t.invalidCount} stored cost${t.invalidCount === 1 ? '' : 's'} could not be read and ${t.invalidCount === 1 ? 'is' : 'are'} excluded. Review before using these totals.`) : null);
  }
  function editForm(entry) {
    const e = S.editDraft, locked = S.busy || !!S.pending, today = mountainDate(new Date()), earliest = shiftDate(today, -366), shared = Boolean(entry.share), allowed = shared ? kinds().filter(([kind]) => shareable(kind)) : kinds();
    return h('form', { class: 'expense-edit', novalidate: true, onsubmit: event => {
      event.preventDefault();
      const cents = parseCents(e.amount), fields = {}, current = shared ? entry.share.totalCents : entry.amountCents;
      if (cents == null || cents < 1 || cents > maxCents()) { settle('Enter a valid corrected amount.', true); render(); return; }
      if (e.kind !== entry.kind) fields.kind = e.kind; if (cents !== current) fields.amountCents = cents; if (e.vendor.trim() !== entry.vendor) fields.vendor = e.vendor.trim(); if (e.note.trim() !== entry.note) fields.note = e.note.trim();
      if (payersOn() && !income(e.kind) && e.payer && e.payer !== (entry.payer || '')) fields.payer = e.payer;
      if (e.kind === 'damage_claim' && e.photos.slice().sort().join() !== (entry.damagePhotoIds || []).slice().sort().join()) fields.damagePhotoIds = e.photos;
      if (e.incurredOn !== (entry.incurredOn || '')) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(e.incurredOn) || e.incurredOn > today || e.incurredOn < earliest) { settle('Choose a purchase date within the last year (Mountain Time).', true); render(); return; }
        fields.incurredOn = e.incurredOn;
      }
      if (['other', 'damage_claim'].includes(e.kind) && e.note.trim().length < 3 && ('kind' in fields || 'note' in fields)) { settle(e.kind === 'other' ? 'Describe what this other cost was for.' : 'Describe the damage claim.', true); render(); return; }
      if (e.kind === 'damage_claim' && !e.photos.length) { settle('Choose at least one damage photo from this job.', true); render(); return; }
      if (!Object.keys(fields).length) { settle('Change at least one value before saving the correction.', true); render(); return; }
      if (e.reason.trim().length < 3) { settle('Give a reason for the correction.', true); render(); return; }
      change(entry, 'edit', { ...fields, reason: e.reason.trim() });
    } },
    field(`edit-kind-${entry.id}`, 'Type of cost', kindSelect(`edit-kind-${entry.id}`, e.kind, event => { e.kind = event.target.value; render(); S.host?.querySelector(`#edit-kind-${entry.id}`)?.focus(); }, locked, allowed)),
    field(`edit-amount-${entry.id}`, shared ? 'Corrected load total (USD)' : 'Corrected amount (USD)', amountInput(`edit-amount-${entry.id}`, e.amount, event => { e.amount = event.target.value; }, false, locked), shared ? 'The total is split again across the jobs by their shares.' : null),
    field(`edit-vendor-${entry.id}`, vendorLabel(e.kind), h('input', { id: `edit-vendor-${entry.id}`, type: 'text', autocomplete: 'off', maxLength: 120, value: e.vendor, disabled: locked, oninput: event => { e.vendor = event.target.value; } })),
    payersOn() && !income(e.kind) ? field(`edit-payer-${entry.id}`, 'Who paid?', payerSelect(`edit-payer-${entry.id}`, e.payer, event => { e.payer = event.target.value; }, false, locked, entry.payer ? 'Choose who paid' : 'Not recorded')) : null,
    e.kind === 'damage_claim' ? photoPicker(e.photos, next => { e.photos = next; render(); }, locked, false) : null,
    field(`edit-date-${entry.id}`, 'Purchase date (Mountain Time)', h('input', { id: `edit-date-${entry.id}`, type: 'date', min: earliest, max: today, value: e.incurredOn, disabled: locked, oninput: event => { e.incurredOn = event.target.value; } })),
    field(`edit-note-${entry.id}`, noteLabel(e.kind, 'Note'), h('textarea', { id: `edit-note-${entry.id}`, rows: 2, maxLength: 1000, value: e.note, required: ['other', 'damage_claim'].includes(e.kind), disabled: locked, oninput: event => { e.note = event.target.value; } })),
    field(`edit-reason-${entry.id}`, 'Reason for correction (kept in audit trail)', h('input', { id: `edit-reason-${entry.id}`, type: 'text', autocomplete: 'off', maxLength: 500, value: e.reason, required: true, disabled: locked, oninput: event => { e.reason = event.target.value; } })),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit', disabled: locked }, 'Save correction'), h('button', { type: 'button', disabled: S.busy, onclick: () => { S.editing = ''; S.editDraft = null; render(); } }, 'Cancel')));
  }
  function voidForm(entry) {
    const locked = S.busy || !!S.pending;
    return h('form', { class: 'expense-edit', novalidate: true, onsubmit: event => { event.preventDefault(); if (S.voidReason.trim().length < 3) { settle('Give a reason for voiding this cost.', true); render(); return; } change(entry, 'void', { reason: S.voidReason.trim() }); } },
      entry.share ? h('p', { class: 'notice' }, `This voids the whole shared load on all ${entry.share.parts.length} jobs.`) : null,
      field(`void-reason-${entry.id}`, 'Reason for voiding (kept in audit trail)', h('input', { id: `void-reason-${entry.id}`, type: 'text', autocomplete: 'off', maxLength: 500, value: S.voidReason, required: true, disabled: locked, oninput: event => { S.voidReason = event.target.value; } })),
      h('div', { class: 'actions' }, h('button', { class: 'danger', type: 'submit', disabled: locked }, 'Void cost'), h('button', { type: 'button', disabled: S.busy, onclick: () => { S.voiding = ''; S.voidReason = ''; render(); } }, 'Cancel')));
  }
  function purchased(entry) {
    let recorded = '';
    try { recorded = entry.createdAt ? mountainDate(new Date(entry.createdAt)) : ''; } catch { recorded = ''; }
    return /^\d{4}-\d{2}-\d{2}$/.test(entry.incurredOn || '') && entry.incurredOn !== recorded ? `purchased ${dayLabel(entry.incurredOn)}` : '';
  }
  function entryItem(entry) {
    const manager = S.data.scope === 'job', locked = S.busy || !!S.pending, share = entry.share && Array.isArray(entry.share.parts) ? entry.share : null;
    const badges = [entry.status === 'void' ? ['Void', 'alert'] : null, entry.state !== 'applied' ? ['Receipt not verified', 'alert'] : entry.receiptVerified ? ['Receipt saved', 'done'] : null, entry.income ? ['Money received', ''] : null, share ? ['Shared load', ''] : null, entry.edited ? ['Corrected', ''] : null, entry.needsReview ? ['Needs review', 'alert'] : null].filter(Boolean);
    const receiptLink = manager && typeof entry.receiptUrl === 'string' && entry.receiptUrl.startsWith('/api/field-expenses?') ? h('a', { class: 'button', href: entry.receiptUrl, target: '_blank', rel: 'noopener' }, 'View receipt') : null;
    const photos = Array.isArray(entry.damagePhotoIds) ? entry.damagePhotoIds.length : 0;
    return h('li', { class: `expense-item${entry.status === 'void' ? ' void' : ''}${entry.income ? ' income' : ''}`, 'data-expense': entry.id },
      h('div', { class: 'expense-row' }, h('strong', {}, kindLabel(entry.kind)), h('span', { class: 'expense-value' }, entry.income && Number.isSafeInteger(entry.amountCents) ? `−${money(entry.amountCents)}` : money(entry.amountCents))),
      h('small', { class: 'expense-meta' }, [entry.vendor, stamp(entry.createdAt), purchased(entry), entry.payer ? payerLabel(entry.payer) : !entry.income && payersOn() ? 'who paid not recorded' : '', manager ? `by ${entry.recordedBy?.name || entry.recordedBy?.id || 'crew'}` : ''].filter(Boolean).join(' · ')),
      share ? h('small', { class: 'expense-meta' }, `This job’s share of a ${money(share.totalCents)} load split across ${share.parts.length} jobs${share.primary ? '' : ` (recorded on job ${share.primaryJobId})`}.`) : null,
      photos ? h('small', { class: 'expense-meta' }, `${photos} damage photo${photos === 1 ? '' : 's'} linked`) : null,
      badges.length ? h('div', { class: 'expense-badges' }, badges.map(([text, tone]) => h('span', { class: `badge ${tone}` }, text))) : null,
      entry.note ? h('p', { class: 'text-block' }, entry.note) : null,
      manager && entry.voided ? h('small', { class: 'expense-meta' }, `Voided by ${entry.voided.by?.name || entry.voided.by?.id} · ${stamp(entry.voided.at)} · ${entry.voided.reason}`) : null,
      manager && (receiptLink || entry.canEdit || entry.canVoid) && S.editing !== entry.id && S.voiding !== entry.id ? h('div', { class: 'actions' }, receiptLink,
        entry.canEdit ? h('button', { type: 'button', disabled: locked, onclick: () => { S.voiding = ''; S.editing = entry.id; S.editDraft = { kind: entry.kind, amount: amountText(share ? share.totalCents : entry.amountCents), vendor: entry.vendor, note: entry.note, payer: entry.payer || '', photos: [...(entry.damagePhotoIds || [])], incurredOn: entry.incurredOn || '', reason: '' }; render(); } }, 'Correct') : null,
        entry.canVoid ? h('button', { type: 'button', class: 'danger', disabled: locked, onclick: () => { S.editing = ''; S.voiding = entry.id; S.voidReason = ''; render(); } }, 'Void') : null) : null,
      manager && S.editing === entry.id && S.editDraft ? editForm(entry) : null,
      manager && S.voiding === entry.id ? voidForm(entry) : null,
      manager && entry.audit?.length ? h('details', {}, h('summary', {}, `Audit trail · ${entry.audit.length}`), entry.audit.map(item => h('p', { class: 'expense-audit' }, `${item.action === 'void' ? 'Voided' : 'Corrected'} by ${item.by?.name || item.by?.id} · ${stamp(item.at)} — ${item.reason}${item.action === 'edit' ? ` (${Object.keys(item.after || {}).map(name => `${AUDIT_NAMES[name] || name}: ${['amountCents', 'loadTotalCents'].includes(name) ? `${money(item.before?.[name])} → ${money(item.after[name])}` : name === 'damagePhotoIds' ? `${(item.before?.[name] || []).length} → ${(item.after[name] || []).length}` : name === 'payer' ? `${payerLabel(item.before?.[name]) || '—'} → ${payerLabel(item.after[name]) || '—'}` : `${item.before?.[name] || '—'} → ${item.after[name] || '—'}`}`).join('; ')})` : ''}`))) : null);
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
      closeoutCard(),
      S.data.canRecord ? recordForm() : h('p', { class: 'notice' }, 'This job is closed for new costs. Ask operations to record any late receipts.'),
      h('h3', {}, own ? 'Your recorded costs' : 'All recorded costs'),
      entries.length ? totals() : null,
      entries.length ? h('ul', { class: 'expense-list' }, entries.map(entryItem)) : h('p', { class: 'empty' }, own ? 'You have not recorded any costs on this job.' : 'No field costs recorded for this job yet.'),
      own && entries.length ? h('small', { class: 'muted' }, 'Entered something wrong? Ask an operations manager to correct or void it.') : null,
      S.loading ? h('small', { role: 'status' }, 'Refreshing job costs…') : null);
  }
  function reset() { S.generation++; S.shareToken++; Object.assign(S, { data: null, loading: false, error: '', hidden: false, busy: false, pending: null, volatile: false, receipt: '', receiptBusy: false, formError: '', feedback: '', feedbackError: false, draft: blank(), editing: '', editDraft: null, voiding: '', voidReason: '', shareJobs: null, shareLoading: false, shareError: '' }); }
  function restoreDraft(draft) {
    const next = { ...blank(), ...Object.fromEntries(['kind', 'amount', 'vendor', 'note', 'payer'].filter(name => typeof draft[name] === 'string').map(name => [name, draft[name].slice(0, 1000)])) };
    if (!KINDS.some(([kind]) => kind === next.kind)) next.kind = 'material';
    if (!PAYERS.some(([payer]) => payer === next.payer)) next.payer = '';
    next.photos = Array.isArray(draft.photos) ? draft.photos.filter(id => typeof id === 'string').slice(0, 10) : [];
    next.split = draft.split === true;
    next.shares = draft.shares && typeof draft.shares === 'object' && !Array.isArray(draft.shares) ? Object.fromEntries(Object.entries(draft.shares).filter(([jobId, weight]) => /^[A-Za-z0-9_-]{1,180}$/.test(jobId) && typeof weight === 'string').slice(0, 10).map(([jobId, weight]) => [jobId, weight.slice(0, 3)])) : {};
    return next;
  }
  function mount(host, options = {}) {
    const jobId = String(options.jobId || ''), user = String(options.user || '');
    S.host = host; S.manager = options.manager === true;
    if (jobId !== S.jobId || user !== S.user) {
      reset(); S.jobId = jobId; S.user = user;
      const pending = stored('pending'), draft = stored('draft');
      if (pending && pending.jobId === jobId && pending.expectedUser === user) S.pending = pending;
      if (draft && typeof draft === 'object') S.draft = restoreDraft(draft);
      if (jobId && user) { if (S.draft.split) loadShareJobs(); return load(); }
    }
    render();
  }
  function unmount() { S.generation++; S.shareToken++; S.host?.replaceChildren(); S.host = null; }
  window.addEventListener('egc:signout', () => { try { for (let index = sessionStorage.length - 1; index >= 0; index--) { const name = sessionStorage.key(index); if (name?.startsWith('egc-field:') && name.includes(':expense-')) sessionStorage.removeItem(name); } } catch { /* Nothing further is stored. */ } reset(); S.jobId = ''; S.user = ''; render(); });
  window.addEventListener('beforeunload', event => { if (S.busy || S.receiptBusy || (S.pending && S.volatile)) { event.preventDefault(); event.returnValue = ''; } });
  window.EGCFieldExpenses = { mount, unmount, refresh: () => (S.jobId ? load() : Promise.resolve()), canLeave: () => !S.busy && !(S.pending && S.volatile), parseCents, splitCents };
})();
