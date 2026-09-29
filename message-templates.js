/* Owner message template screen. Canonical records and approval live in
   /api/message-templates; this module never sends a customer message. */
(function () {
'use strict';
const API = '/api/message-templates';
const SMS_LIMIT = 320;
const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const SAMPLE = { firstName: 'Sam', crewLeadName: 'Casey', etaMinutes: '20', arrivalWindow: '9:00 AM–10:00 AM', serviceDate: 'Tuesday, September 22', removedDates: 'Wednesday, September 23', portalLink: 'https://easygaragecleaning.com/l/Ab3dE5gH', payLink: 'https://easygaragecleaning.com/l/Pay7kQ2z', invoiceNumber: 'INV-1001', balance: '$1,200.00', dueDate: 'October 1', companyPhone: '(970) 999-1818', inviteLink: 'https://easygaragecleaning.com/l/Inv9xW4r', loginLink: 'https://easygaragecleaning.com/l/Log3mN8p' };
const LABELS = { firstName: 'First name', crewLeadName: 'Crew lead', etaMinutes: 'ETA minutes', arrivalWindow: 'Arrival window', serviceDate: 'Service date', removedDates: 'Removed dates', portalLink: 'Portal link', payLink: 'Pay link', invoiceNumber: 'Invoice #', balance: 'Balance', dueDate: 'Due date', companyPhone: 'Company phone', inviteLink: 'Invite link', loginLink: 'Sign-in link' };
const S = { host: null, root: null, data: null, loading: false, error: null, generation: 0, selected: null, drafts: {}, busy: false, pending: null, notice: '', failure: null, dialog: null, controller: null };
const prefix = 'egc.templates.v1.';
const storageKey = (kind, viewer = S.data?.viewer?.id) => viewer ? `${prefix}${kind}.${String(viewer).toLowerCase()}` : '';

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && !key.startsWith('aria-') && !key.startsWith('data-')) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const btn = (label, onclick, kind = '', props = {}) => h('button', { type: 'button', class: `mt-btn ${kind}`.trim(), onclick, ...props }, label);
const pill = (text, kind = '') => h('span', { class: `mt-pill ${kind}`.trim() }, text);
const read = key => { try { return key ? JSON.parse(sessionStorage.getItem(key) || 'null') : null; } catch { return null; } };
const write = (key, value) => { try { if (!key) return; if (value == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Private mode keeps the in-memory draft. */ } };
const when = value => { const time = Date.parse(value || ''); return Number.isFinite(time) ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(time)) : ''; };

// Mirrors the server render rules so the owner sees problems while typing.
// The server re-validates every save and approval.
function preview(draft, allowed) {
  const errors = [];
  const render = text => String(text || '').replace(TOKEN, (match, name) => {
    if (!Object.hasOwn(SAMPLE, name)) { errors.push(`{{${name}}} is not an approved variable.`); return match; }
    if (!allowed.includes(name)) { errors.push(`{{${name}}} cannot be used in this message type.`); return match; }
    return SAMPLE[name];
  });
  const body = render(draft.body), subject = draft.channel === 'Email' ? render(draft.subject) : '';
  if (/\{\{|\}\}/.test(String(draft.body || '').replace(TOKEN, '')) || /\{\{|\}\}/.test(String(draft.subject || '').replace(TOKEN, ''))) errors.push('A variable is missing a brace. Use the {{variable}} form.');
  if (!String(draft.body || '').trim()) errors.push('Enter the message text.');
  if (draft.channel === 'Email' && !String(draft.subject || '').trim()) errors.push('Email messages need a subject.');
  const length = [...body].length;
  if (draft.channel === 'SMS' && length > SMS_LIMIT) errors.push(`This text would be ${length} characters. Texts are limited to ${SMS_LIMIT}.`);
  return { body, subject, length, errors: [...new Set(errors)] };
}

function template(kind) { return S.data?.templates.find(row => row.kind === kind) || null; }
function latest(row) { return row.versions.find(version => version.version === row.latestVersion) || row.versions.at(-1); }
function active(row) { return row.versions.find(version => version.version === row.activeVersion) || null; }
function draftFor(row) {
  if (!S.drafts[row.kind]) {
    const saved = read(storageKey(row.kind)), base = latest(row);
    S.drafts[row.kind] = saved && saved.baseVersion === row.latestVersion ? saved : { channel: base.channel, subject: base.subject || '', body: base.body, baseVersion: row.latestVersion };
  }
  return S.drafts[row.kind];
}
function dirty(row) {
  const draft = S.drafts[row.kind], base = latest(row);
  return Boolean(draft && (draft.channel !== base.channel || (draft.channel === 'Email' ? draft.subject : '') !== (base.channel === 'Email' ? base.subject : '') || draft.body.trim() !== base.body.trim()));
}
function statusPills(row) {
  const live = active(row), newest = latest(row);
  return [
    live ? pill(`Live v${live.version}`, 'ok') : pill('Not approved', 'warn'),
    newest.status === 'draft' && (!live || newest.version > live.version) ? pill(`Draft v${newest.version} awaiting owner`, 'info') : null,
    row.automationEnabled ? pill('Automatic sending on', 'auto') : null,
  ];
}

function validate(data) {
  const valid = data && Array.isArray(data.templates) && data.viewer && typeof data.viewer.id === 'string' && data.templates.every(row => row && typeof row.kind === 'string' && Array.isArray(row.versions) && row.versions.length && Number.isInteger(row.latestVersion) && Array.isArray(row.allowedVariables));
  if (!valid) throw Object.assign(new Error('Message templates could not be fully verified. Retry.'), { status: 503, code: 'messaging_response_unverified' });
  return data;
}

async function api(body) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(API, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) throw Object.assign(new Error(data.error || 'Message templates are unavailable. Retry.'), { status: response.ok ? 503 : response.status, code: data.code || '', details: data.details });
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('The server did not confirm this change within 30 seconds. Retry the original save.'), { status: 503, code: 'messaging_timeout' });
    if (!Number.isInteger(error.status)) throw Object.assign(new Error('The connection was lost before the change was confirmed. Retry the original save.'), { status: 0, code: 'messaging_network' });
    throw error;
  } finally { clearTimeout(timer); }
}
const retryable = error => error.status === 0 || error.status >= 500 || [401, 403, 408, 429].includes(error.status);

async function load() {
  const generation = ++S.generation;
  S.loading = true; S.error = null; render();
  try {
    const data = validate(await api());
    if (generation !== S.generation) return;
    S.data = data;
    S.pending = read(`${prefix}pending.${String(data.viewer.id).toLowerCase()}`);
  } catch (error) {
    if (generation !== S.generation) return;
    S.data = null; S.error = error;
  } finally {
    if (generation === S.generation) { S.loading = false; render(); }
  }
}

async function mutate(body) {
  if (S.busy) return;
  const viewer = S.data?.viewer?.id, pendingKey = `${prefix}pending.${String(viewer).toLowerCase()}`;
  S.pending = body; write(pendingKey, body);
  S.busy = true; S.failure = null; S.notice = ''; render();
  const generation = S.generation;
  try {
    const data = await api(body);
    if (generation !== S.generation || S.data?.viewer?.id !== viewer) return;
    if (data.requestId !== body.requestId || data.template?.kind !== body.kind || !Array.isArray(data.template.versions)) throw Object.assign(new Error('The change could not be verified. Retry the original save.'), { status: 503, code: 'messaging_response_unverified' });
    S.data.templates = S.data.templates.map(row => row.kind === body.kind ? { ...row, ...data.template } : row);
    S.pending = null; write(pendingKey, null);
    if (body.action === 'save_draft') { delete S.drafts[body.kind]; write(storageKey(body.kind), null); }
    const saved = template(body.kind);
    S.notice = body.action === 'save_draft' ? (data.unchanged ? 'No changes to save.' : `Draft v${saved.latestVersion} saved. The owner must approve it before it is used.`)
      : body.action === 'approve' ? `Version ${body.version} approved. It is now the live wording.`
      : body.action === 'retire' ? 'Live wording retired. Nothing can send until a version is approved.'
      : body.enabled ? 'Automatic sending turned on for approved wording.' : 'Automatic sending turned off.';
  } catch (error) {
    if (generation !== S.generation) return;
    if (!retryable(error)) { S.pending = null; write(pendingKey, null); }
    S.failure = error;
  } finally {
    if (generation === S.generation) { S.busy = false; closeDialog(); render(); }
  }
}

function saveDraft(row) {
  const draft = draftFor(row);
  mutate({ action: 'save_draft', requestId: crypto.randomUUID(), kind: row.kind, expectedVersion: row.latestVersion, channel: draft.channel, subject: draft.channel === 'Email' ? draft.subject : '', body: draft.body });
}

function closeDialog() {
  const dialog = S.dialog; S.dialog = null;
  if (dialog?.node?.open) dialog.node.close();
  dialog?.node?.remove();
  dialog?.opener?.focus?.();
}
function confirmDialog({ title, copy, text, confirmLabel, danger, onConfirm }) {
  closeDialog();
  const id = `mt-dialog-${Date.now()}`;
  const node = h('dialog', { class: 'mt-dialog', 'aria-labelledby': id, oncancel: event => { event.preventDefault(); if (!S.busy) closeDialog(); } },
    h('div', { class: 'mt-dialog-body' },
      h('h2', { id, text: title }), h('p', { text: copy }),
      text ? h('pre', { class: 'mt-exact', text }) : null),
    h('div', { class: 'mt-dialog-actions' },
      btn('Cancel', () => { if (!S.busy) closeDialog(); }, '', { disabled: S.busy }),
      btn(confirmLabel, onConfirm, danger ? 'danger' : 'primary', { disabled: S.busy })));
  S.dialog = { node, opener: document.activeElement };
  document.body.append(node);
  if (typeof node.showModal === 'function') node.showModal(); else node.setAttribute('open', '');
}

function approve(row) {
  const version = latest(row);
  confirmDialog({
    title: `Approve version ${version.version}?`,
    copy: 'This exact wording becomes the live message. People must still preview and confirm each send; automatic sending stays as you set it.',
    text: `${version.channel}${version.channel === 'Email' ? ` · ${version.subject}` : ''}\n\n${version.body}`,
    confirmLabel: 'Approve wording',
    onConfirm: () => mutate({ action: 'approve', requestId: crypto.randomUUID(), kind: row.kind, expectedVersion: row.latestVersion, version: version.version, hash: version.hash }),
  });
}
function retire(row) {
  const live = active(row);
  confirmDialog({
    title: `Retire live version ${live.version}?`, copy: 'Nothing of this type can be sent until you approve new wording.', confirmLabel: 'Retire wording', danger: true,
    onConfirm: () => mutate({ action: 'retire', requestId: crypto.randomUUID(), kind: row.kind, expectedVersion: row.latestVersion, version: live.version }),
  });
}
function automation(row) {
  const enabled = !row.automationEnabled;
  confirmDialog({
    title: enabled ? 'Turn on automatic sending?' : 'Turn off automatic sending?',
    copy: enabled ? 'Scheduled sends of this message will use the approved wording between 8 AM and 8 PM Denver time, only for customers with automatic reminders enabled.' : 'Scheduled sends of this message will stop. People can still preview and confirm individual messages.',
    confirmLabel: enabled ? 'Turn on' : 'Turn off', danger: !enabled,
    onConfirm: () => mutate({ action: 'set_automation', requestId: crypto.randomUUID(), kind: row.kind, expectedVersion: row.latestVersion, enabled }),
  });
}

function failureView() {
  const error = S.failure;
  if (!error && S.pending && !S.busy) return h('div', { class: 'mt-alert', role: 'alert' }, h('p', { text: 'A template change was not confirmed by the server. Retry it before making other changes.' }), btn('Retry original save', () => mutate(S.pending), 'primary'));
  if (!error) return null;
  const conflict = /revision_conflict/.test(error.code || '');
  return h('div', { class: 'mt-alert', role: 'alert' },
    h('p', { text: error.status === 401 ? 'Your sign-in expired. Sign in again in the Employee Hub, then retry the original save.' : error.message }),
    S.pending && retryable(error) ? btn('Retry original save', () => mutate(S.pending), 'primary') : null,
    conflict ? btn('Keep my draft and load latest', () => { S.failure = null; load(); }) : null);
}

function deliveryBanner() {
  const delivery = S.data.delivery || {};
  const text = !delivery.enabled ? 'Messaging is off. Approving wording does not send anything.' : delivery.dryRun ? 'Dry run: confirmed sends are recorded but not delivered.' : 'Live: approved messages send only after a person confirms each one, or by automation you turn on.';
  return h('p', { class: `mt-delivery ${delivery.enabled && !delivery.dryRun ? 'live' : ''}`.trim(), role: 'status' }, text);
}

function listView() {
  return h('section', { class: 'mt-list', 'aria-label': 'Message templates' },
    S.data.templates.map(row => h('button', { type: 'button', class: 'mt-card', 'data-kind': row.kind, onclick: () => { S.selected = row.kind; S.notice = ''; S.failure = null; render(); S.root?.querySelector('h2')?.focus(); } },
      h('span', { class: 'mt-card-head' }, h('strong', { text: row.label }), pill(latest(row).channel === 'Email' ? 'Email' : 'Text')),
      h('span', { class: 'mt-card-pills' }, statusPills(row)),
      h('span', { class: 'mt-card-text', text: (active(row) || latest(row)).body.slice(0, 140) }))));
}

function updatePreview(row, panel, footer) {
  const draft = draftFor(row), result = preview(draft, row.allowedVariables);
  panel.replaceChildren(...[
    h('h3', { text: 'Live preview' }),
    h('p', { class: 'mt-muted', text: 'Sample customer details. Links show a sample short link.' }),
    draft.channel === 'Email' ? h('p', { class: 'mt-preview-subject' }, h('b', { text: 'Subject: ' }), result.subject) : null,
    h('div', { class: `mt-bubble ${draft.channel === 'Email' ? 'email' : ''}`.trim(), 'data-testid': 'preview', text: result.body }),
    draft.channel === 'SMS' ? h('p', { class: `mt-count ${result.length > SMS_LIMIT ? 'over' : ''}`.trim(), 'aria-live': 'polite', text: `${result.length} / ${SMS_LIMIT} characters` }) : null,
    result.errors.length ? h('ul', { class: 'mt-errors', role: 'alert' }, result.errors.map(message => h('li', { text: message }))) : null].filter(Boolean));
  const save = footer.querySelector('[data-action="save"]'), approval = footer.querySelector('[data-action="approve"]'), hint = footer.querySelector('[data-hint]'), live = active(row);
  if (save) save.disabled = S.busy || Boolean(S.pending) || !dirty(row) || result.errors.length > 0;
  if (approval) approval.hidden = dirty(row);
  if (hint) hint.textContent = dirty(row) ? `Saving creates version ${row.latestVersion + 1} as a draft. ${live ? `Version ${live.version} stays live until the owner approves the change.` : 'Nothing sends until the owner approves it.'}` : '';
  write(storageKey(row.kind), dirty(row) ? draft : null);
}

function editorView(row) {
  const draft = draftFor(row), owner = S.data.viewer.canApprove === true, newest = latest(row), live = active(row);
  const disabled = S.busy || Boolean(S.pending);
  const panel = h('section', { class: 'mt-preview', 'aria-label': 'Preview' });
  const footer = h('div', { class: 'mt-footer' });
  const refresh = () => updatePreview(row, panel, footer);
  const body = h('textarea', { id: 'mt-body', rows: 7, value: draft.body, disabled, maxLength: 4000, oninput: event => { draft.body = event.target.value; refresh(); } });
  const subject = h('input', { id: 'mt-subject', type: 'text', value: draft.subject, disabled, maxLength: 120, autocomplete: 'off', oninput: event => { draft.subject = event.target.value; refresh(); } });
  const insert = name => {
    const token = `{{${name}}}`, start = body.selectionStart ?? body.value.length, end = body.selectionEnd ?? body.value.length;
    body.setRangeText(token, start, end, 'end'); draft.body = body.value; body.focus(); refresh();
  };
  const channel = h('select', { id: 'mt-channel', disabled, onchange: event => { draft.channel = event.target.value; render(); } },
    ['SMS', 'Email'].map(value => h('option', { value, selected: draft.channel === value }, value === 'SMS' ? 'Text message (SMS)' : 'Email')));
  footer.append(
    h('p', { class: 'mt-hint', 'data-hint': '', 'aria-live': 'polite' }),
    h('div', { class: 'mt-footer-actions' },
      btn('Save draft', () => saveDraft(row), 'primary', { 'data-action': 'save', disabled: true }),
      owner && newest.status !== 'approved' ? btn(`Approve v${newest.version}`, () => approve(row), 'approve', { 'data-action': 'approve', disabled }) : null));
  const view = h('section', { class: 'mt-editor', 'aria-labelledby': 'mt-editor-title' },
    btn('← All templates', () => { S.selected = null; S.failure = null; S.notice = ''; render(); }, 'link'),
    h('div', { class: 'mt-editor-head' }, h('h2', { id: 'mt-editor-title', tabIndex: -1, text: row.label }), h('div', { class: 'mt-card-pills' }, statusPills(row))),
    S.notice ? h('p', { class: 'mt-notice', role: 'status', text: S.notice }) : null,
    failureView(),
    h('div', { class: 'mt-columns' },
      h('div', { class: 'mt-form' },
        h('label', { class: 'mt-field', for: 'mt-channel' }, 'Channel', channel),
        draft.channel === 'Email' ? h('label', { class: 'mt-field', for: 'mt-subject' }, 'Email subject', subject) : null,
        h('label', { class: 'mt-field', for: 'mt-body' }, 'Message', body),
        h('div', { class: 'mt-chips', role: 'group', 'aria-label': 'Insert a variable' },
          row.allowedVariables.map(name => btn(`+ ${LABELS[name] || name}`, () => insert(name), 'chip', { disabled, 'aria-label': `Insert ${LABELS[name] || name}` })))),
      panel),
    footer,
    owner ? h('section', { class: 'mt-owner', 'aria-label': 'Owner controls' },
      h('h3', { text: 'Owner controls' }),
      row.automatable ? h('div', { class: 'mt-row' }, h('p', { text: row.automationEnabled ? 'Automatic sending is on.' : 'Automatic sending is off.' }), btn(row.automationEnabled ? 'Turn off automatic sending' : 'Turn on automatic sending', () => automation(row), row.automationEnabled ? 'danger' : '', { disabled: disabled || (!live && !row.automationEnabled) })) : null,
      live ? h('div', { class: 'mt-row' }, h('p', { text: `Version ${live.version} approved by ${live.approvedBy} ${when(live.approvedAt)}.` }), btn('Retire live wording', () => retire(row), 'danger', { disabled })) : h('p', { class: 'mt-muted', text: 'No approved wording yet. Approve the latest version to allow sending.' })) : null,
    h('details', { class: 'mt-history' }, h('summary', { text: `Version history (${row.versions.length})` }),
      h('ol', {}, [...row.versions].reverse().map(version => h('li', {},
        h('div', { class: 'mt-card-pills' }, h('b', { text: `v${version.version}` }), pill(version.status === 'approved' ? 'Approved' : version.status === 'retired' ? 'Retired' : 'Draft', version.status === 'approved' ? 'ok' : version.status === 'retired' ? '' : 'info')),
        h('p', { class: 'mt-muted', text: [version.createdBy === 'egc-default' ? 'EGC default wording' : `Saved by ${version.createdBy} ${when(version.createdAt)}`, version.approvedBy ? `approved by ${version.approvedBy} ${when(version.approvedAt)}` : ''].filter(Boolean).join(' · ') }),
        h('p', { class: 'mt-history-text', text: version.body }))))));
  refresh();
  return view;
}

function render() {
  if (!S.root) return;
  const children = [h('header', { class: 'mt-header' }, h('p', { class: 'mt-eyebrow', text: 'MESSAGING' }), h('h1', { text: 'Message templates' }), h('p', { class: 'mt-muted', text: 'The wording customers and crew receive. Every edit is a draft until the owner approves it.' }))];
  if (S.loading && !S.data) children.push(h('div', { class: 'mt-list', 'aria-busy': 'true', 'aria-label': 'Loading templates' }, [1, 2, 3, 4].map(() => h('div', { class: 'mt-card mt-skeleton' }, h('span'), h('span'), h('span')))));
  else if (!S.data) {
    const expired = S.error?.status === 401, forbidden = S.error?.status === 403;
    children.push(h('div', { class: 'mt-alert', role: 'alert' },
      h('p', { text: expired ? 'Your sign-in expired. Sign in to the Employee Hub, then retry.' : forbidden ? 'Only the owner or an operations manager can manage message templates.' : `Message templates are unavailable. ${S.error?.message || ''}`.trim() }),
      btn('Retry', load, 'primary'), expired ? h('a', { class: 'mt-btn', href: '/employee.html' }, 'Open Employee Hub') : null));
  } else {
    children.push(deliveryBanner());
    const row = S.selected && template(S.selected);
    if (row) children.push(editorView(row));
    else {
      if (S.notice) children.push(h('p', { class: 'mt-notice', role: 'status', text: S.notice }));
      children.push(failureView(), listView());
    }
  }
  S.root.replaceChildren(...children.filter(Boolean));
}

function beforeUnload(event) { if (!canLeave()) { event.preventDefault(); event.returnValue = ''; } }
function canLeave() { return !S.busy && !S.pending && !(S.data?.templates || []).some(row => S.drafts[row.kind] && dirty(row)); }
function mount(host) {
  if (!host) return;
  if (S.host === host && S.root?.isConnected) return refresh();
  unmount();
  S.host = host; S.root = h('div', { class: 'egc-templates' });
  host.replaceChildren(S.root);
  window.addEventListener('beforeunload', beforeUnload);
  load();
}
function unmount() {
  S.generation += 1; closeDialog();
  window.removeEventListener('beforeunload', beforeUnload);
  if (S.root) S.root.remove();
  Object.assign(S, { host: null, root: null, data: null, loading: false, error: null, selected: null, drafts: {}, busy: false, pending: null, notice: '', failure: null });
}
function refresh() { if (S.root && !S.busy) load(); }
window.addEventListener('egc:signout', () => {
  try { for (let index = sessionStorage.length - 1; index >= 0; index -= 1) { const name = sessionStorage.key(index); if (name?.startsWith(prefix)) sessionStorage.removeItem(name); } } catch { /* Nothing stored. */ }
  const host = S.host; unmount(); host?.replaceChildren();
});
window.EGCMessageTemplates = { mount, unmount, refresh, canLeave };
})();
