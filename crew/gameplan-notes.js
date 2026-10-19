/* EGC_WALKTHROUGH_NOTES: the walkthrough notes panel in the gameplan, under the recorder card. After Finish each recorded part
   is transcribed on the website (/api/walkthrough-notes); this panel shows the transcribing progress and the transcript, has it
   written up into job notes, items needed, keep / remove, access and hazards (on its own once every part is in, or with a tap),
   and lets the estimator edit them and Confirm them for the crew. Only confirmed notes reach the crew lead and the crew
   (crew/job.js). Everything is read from the server (the audio leaves the iPad once it is uploaded), so the estimator can come
   back to it later or on another device. Without the notes switched on the panel stays hidden. */
(function (root) {
  'use strict';
  const URL_PATH = '/api/walkthrough-notes', POLL_MS = 10000, POLLS = 180, CONFIRM_KEY = 'egc-wt-notes:confirm:';
  // The editable lists, in the order the crew reads them.
  const LISTS = [['jobNotes', 'Job notes for the crew', 'One note per line, in the order the work happens.', 12, 300], ['keepItems', 'Keep', 'What stays, one per line.', 20, 200],
    ['removeItems', 'Remove / donate', 'What goes, one per line.', 20, 200], ['access', 'Access and staging', 'How the crew gets in and where to park.', 8, 300], ['hazards', 'Hazards', 'Only what was seen or mentioned.', 8, 300]];
  const ITEM_ROWS = 25;
  const lines = value => String(value || '').split('\n').map(line => line.trim()).filter(Boolean);
  const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];

  /** The notes as the form edits them: each list as text with one entry per line, the items as rows. */
  function notesToForm(notes) {
    const form = { itemsNeeded: (Array.isArray(notes?.itemsNeeded) ? notes.itemsNeeded : []).slice(0, ITEM_ROWS).map(item => ({ name: String(item?.name || ''), quantity: Number.isInteger(item?.quantity) ? String(item.quantity) : '', reason: String(item?.reason || '') })) };
    for (const [key] of LISTS) form[key] = list(notes?.[key]).join('\n');
    return form;
  }
  /** What Confirm sends: the lists split into lines, the item rows with a name (a quantity only when it is a whole number). */
  function formToNotes(form) {
    const notes = { itemsNeeded: (form?.itemsNeeded || []).map(item => ({ name: String(item.name || '').trim(), quantity: /^\d{1,3}$/.test(String(item.quantity || '').trim()) && Number(item.quantity) > 0 ? Number(item.quantity) : null, reason: String(item.reason || '').trim() })).filter(item => item.name).slice(0, ITEM_ROWS) };
    for (const [key, , , count] of LISTS) notes[key] = lines(form?.[key]).slice(0, count);
    return notes;
  }
  const hasNotes = notes => Boolean(notes) && (notes.itemsNeeded?.length || LISTS.some(([key]) => list(notes[key]).length));
  const itemText = item => `${item.quantity ? `${item.quantity} × ` : ''}${item.name}${item.reason ? ` – ${item.reason}` : ''}`;
  /** What the panel shows for one server answer: hidden, waiting for audio, transcribing, writing up, the editor or the
      confirmed notes. Pure, so tests read it directly. */
  function panelMode(view, { editing = false, manual = false } = {}) {
    if (!view || view.enabled !== true) return 'hidden';
    const outcome = view.outcome?.outcome || '', newer = view.draft && view.confirmed && view.draftedAt && Date.parse(view.draftedAt) > Date.parse(view.confirmed.confirmedAt || 0);
    if (editing || manual) return 'editor';
    if (view.confirmed && !newer) return 'confirmed';
    if (view.draft) return 'editor';
    if (view.status === 'withdrawn') return 'withdrawn';
    const done = (view.parts || []).filter(part => part.status === 'done').length;
    if ((view.parts || []).length && !view.complete) return 'transcribing';
    if (done && view.complete) return 'ready';
    if (!outcome || outcome === 'customer_no_show') return 'hidden';
    return view.outcome.recordingStatus === 'recorded' ? 'waiting' : 'none';
  }
  const core = { notesToForm, formToNotes, panelMode, hasNotes, itemText, LISTS };
  root.EGCWalkthroughNotes = core;
  if (typeof document === 'undefined') return;

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else if (['value', 'checked', 'disabled', 'hidden', 'open'].includes(key)) node[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) if (child != null && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  }
  const button = (label, onclick, className = 'wt-btn', extra = {}) => h('button', { type: 'button', className, onclick, ...extra }, label);
  const denver = value => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)); } catch { return ''; } };

  /** Mounts the panel: options.visit() gives the open Hub walkthrough's id (or null), options.fetch the Hub's signed fetch. */
  function mount(host, options = {}) {
    const timers = options.timers || root, uuid = options.uuid || (() => root.crypto.randomUUID()), call = options.fetch || root.fetch?.bind(root);
    const storage = (() => { try { return options.storage || root.localStorage || null; } catch { return null; } })();
    const ui = { visitId: null, view: null, generation: 0, busy: false, message: '', error: '', edit: null, editing: false, manual: false, dirty: false, polls: 0, timer: null, autoDrafted: new Set(), transcriptOpen: false };
    host.classList.add('egc-wt', 'wt-notes-panel');
    const currentVisit = () => { try { return options.visit?.() || null; } catch { return null; } };

    async function request(body) {
      let response;
      try { response = await call(body ? URL_PATH : `${URL_PATH}?visitId=${encodeURIComponent(ui.visitId)}`, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); }
      catch (error) { throw Object.assign(new Error(error?.code === 'HUB_AUTH_REQUIRED' ? error.message : 'No connection. Try again when the signal returns.'), { status: error?.code === 'HUB_AUTH_REQUIRED' ? 401 : 0 }); }
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) throw Object.assign(new Error(data?.error || 'Walkthrough notes are unavailable right now. Try again shortly.'), { status: response.status, code: data?.code || '' });
      return data;
    }
    // A new answer replaces the form unless the estimator has typed in it since the last one.
    function accept(view) {
      ui.view = view;
      if (!ui.dirty) {
        const newer = view.draft && view.confirmed && Date.parse(view.draftedAt || 0) > Date.parse(view.confirmed.confirmedAt || 0);
        ui.edit = notesToForm(newer ? view.draft : view.confirmed || view.draft || null);
      }
    }
    async function load(force = false) {
      const visitId = currentVisit();
      if (visitId !== ui.visitId) {
        Object.assign(ui, { visitId, view: null, message: '', error: '', edit: null, editing: false, manual: false, dirty: false, polls: 0, transcriptOpen: false });
        timers.clearTimeout(ui.timer); ui.timer = null;
      } else if (!force) return;
      const generation = ++ui.generation;
      if (!visitId) { draw(true); return; }
      try {
        const view = await request();
        if (generation !== ui.generation) return;
        accept(view);
        ui.error = '';
      } catch (error) {
        if (generation !== ui.generation) return;
        // Not a rep's or manager's visit, or notes switched off: the panel stays out of the way.
        if ([401, 403, 404].includes(error.status)) ui.view = null; else ui.error = ui.view ? error.message : '';
      }
      draw();
      poll();
      autoDraft();
    }
    // While parts are transcribing (or the audio is still uploading) the panel looks again every 10 seconds, for up to 30 minutes.
    function poll() {
      timers.clearTimeout(ui.timer); ui.timer = null;
      const mode = panelMode(ui.view, ui);
      if (!['waiting', 'transcribing'].includes(mode) || ui.polls >= POLLS) return;
      ui.polls += 1;
      ui.timer = timers.setTimeout(() => { void load(true); }, POLL_MS);
    }
    // Every part in and no notes yet: they are written up once, on their own.
    function autoDraft() {
      const view = ui.view;
      if (panelMode(view, ui) !== 'ready' || !view.canDraft || !view.outcome || view.draftsLeft < 1 || ui.autoDrafted.has(view.visitId) || ui.busy) return;
      ui.autoDrafted.add(view.visitId);
      void draft();
    }
    async function act(body, success) {
      if (ui.busy) return null;
      ui.busy = true; ui.message = ''; ui.error = ''; draw(true);
      try { const view = await request(body); ui.busy = false; success?.(view); accept(view); draw(true); return view; }
      catch (error) {
        ui.busy = false;
        // The notes changed meanwhile: read them again (keeping what was typed) and say so; the next Confirm checks against them.
        if (error.code === 'walkthrough_notes_changed') { ui.dirty = true; await load(true); ui.error = error.message; draw(true); return null; }
        ui.error = error.message; draw(true); return null;
      }
    }
    const draft = () => act({ action: 'draft', visitId: ui.visitId, requestId: uuid() }, () => { ui.dirty = false; ui.editing = false; ui.message = 'Notes written from the transcript. Check them, edit anything that is off, then confirm.'; });
    // A Confirm keeps its request ID on the iPad until it is answered, so a retry of the same notes is never applied twice.
    async function confirm() {
      const notes = formToNotes(ui.edit);
      if (!hasNotes(notes)) { ui.error = 'Add at least one note or item before confirming.'; draw(true); return; }
      const key = `${CONFIRM_KEY}${ui.visitId}`, body = { action: 'confirm', visitId: ui.visitId, expectedRevision: ui.view?.revision || '', notes };
      let saved = null;
      try { saved = JSON.parse(storage?.getItem(key) || 'null'); } catch { saved = null; }
      const requestId = saved && JSON.stringify(saved.body) === JSON.stringify(body) ? saved.requestId : uuid();
      try { storage?.setItem(key, JSON.stringify({ requestId, body })); } catch { /* storage blocked: the server's receipt still guards it */ }
      const done = await act({ ...body, requestId }, () => { ui.dirty = false; ui.editing = false; ui.manual = false; ui.message = 'Confirmed. The crew lead and crew see these notes on the job.'; });
      if (done) try { storage?.removeItem(key); } catch { /* storage blocked */ }
    }
    async function withdraw() {
      if (options.confirm && !options.confirm('Delete this walkthrough\'s transcript because the customer withdrew consent? Notes already confirmed for the crew stay.')) return;
      await act({ action: 'withdraw', visitId: ui.visitId, requestId: uuid() }, () => { ui.message = 'The transcript was deleted.'; });
    }
    const edit = () => { ui.editing = true; ui.edit = notesToForm(ui.view?.confirmed || ui.view?.draft || null); ui.dirty = false; draw(true); };
    const typeNotes = () => { ui.manual = true; ui.edit = notesToForm(null); draw(true); };
    const cancel = () => { Object.assign(ui, { editing: false, manual: false, dirty: false, error: '' }); accept(ui.view); draw(true); };
    const changed = () => { ui.dirty = true; };

    function transcriptBlock(view) {
      if (!view.transcript) return view.transcriptMissing ? h('p', { className: 'wt-muted' }, 'The transcript was deleted after 90 days.') : null;
      const details = h('details', { className: 'wtn-transcript', open: ui.transcriptOpen, ontoggle: event => { ui.transcriptOpen = event.target.open; } },
        h('summary', {}, `Transcript (${(view.parts || []).filter(part => part.status === 'done').length} part${(view.parts || []).filter(part => part.status === 'done').length === 1 ? '' : 's'})`), h('pre', {}, view.transcript));
      return details;
    }
    function listField([key, label, hint, count, max]) {
      const id = `wtn-${key}`;
      return h('label', { className: 'wt-field', for: id }, h('span', {}, label, h('small', { className: 'wtn-hint' }, ` ${hint}`)),
        h('textarea', { id, rows: key === 'jobNotes' ? 5 : 3, maxlength: count * (max + 1), value: ui.edit[key], oninput: event => { ui.edit[key] = event.target.value; changed(); } }));
    }
    function itemRows() {
      const rows = ui.edit.itemsNeeded;
      const row = (item, index) => h('div', { className: 'wtn-item', role: 'group', 'aria-label': `Item ${index + 1}` },
        h('label', { className: 'wt-field wtn-name' }, h('span', {}, 'Item'), h('input', { type: 'text', maxlength: 120, value: item.name, oninput: event => { item.name = event.target.value; changed(); } })),
        h('label', { className: 'wt-field wtn-qty' }, h('span', {}, 'Qty'), h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: 3, value: item.quantity, oninput: event => { item.quantity = event.target.value; changed(); } })),
        h('label', { className: 'wt-field wtn-reason' }, h('span', {}, 'What for'), h('input', { type: 'text', maxlength: 200, value: item.reason, oninput: event => { item.reason = event.target.value; changed(); } })),
        button('Remove', () => { rows.splice(index, 1); changed(); draw(true); }, 'wt-btn wt-quiet', { 'aria-label': `Remove item ${index + 1}` }));
      return h('fieldset', { className: 'wt-notes wtn-items' }, h('legend', {}, 'Items needed (the crew brings these)'),
        rows.length ? rows.map(row) : h('p', { className: 'wt-muted' }, 'No items yet.'),
        rows.length < ITEM_ROWS ? button('Add item', () => { rows.push({ name: '', quantity: '', reason: '' }); changed(); draw(true); }, 'wt-btn wt-secondary') : null);
    }
    function editor(view) {
      const questions = list(view.draft?.openQuestions), confirmedNewer = view.confirmed && view.draft && Date.parse(view.draftedAt || 0) > Date.parse(view.confirmed.confirmedAt || 0);
      return [
        confirmedNewer && !ui.editing ? h('p', { className: 'wt-note', role: 'status' }, 'New notes were written from the latest audio. Confirm them to update what the crew sees.') : null,
        view.draftStale ? h('div', { className: 'wt-note wt-row' }, h('span', {}, 'New audio was added after these notes were written.'), view.canDraft && view.draftsLeft > 0 ? button('Rewrite notes', draft, 'wt-btn wt-secondary', { disabled: ui.busy }) : null) : null,
        questions.length ? h('div', { className: 'wtn-questions', role: 'note' }, h('h3', {}, 'Check before confirming'), h('ul', {}, questions.map(item => h('li', {}, item)))) : null,
        listField(LISTS[0]), itemRows(), ...LISTS.slice(1).map(listField),
        view.canConfirm ? null : h('p', { className: 'wt-muted' }, 'Only the estimator who did this walkthrough confirms its notes for the crew.'),
        h('div', { className: 'wt-row wt-actions' },
          view.canConfirm ? button(ui.busy ? 'Saving…' : view.confirmed ? 'Confirm changes for the crew' : 'Confirm notes for the crew', confirm, 'wt-btn wt-primary', { disabled: ui.busy }) : null,
          ui.editing || ui.manual ? button('Cancel', cancel, 'wt-btn wt-secondary', { disabled: ui.busy }) : null,
          !view.draftStale && view.draft && view.canDraft && view.draftsLeft > 0 && !ui.manual ? button('Rewrite from the transcript', draft, 'wt-btn wt-quiet', { disabled: ui.busy }) : null)];
    }
    function confirmedBlock(view) {
      const notes = view.confirmed;
      const section = (title, items) => items.length ? h('div', { className: 'wtn-section' }, h('h3', {}, title), h('ul', {}, items.map(item => h('li', {}, item)))) : null;
      return [h('p', { className: 'wt-ok', role: 'status' }, `Sent to the crew lead and crew${notes.confirmedAt ? ` · confirmed ${denver(notes.confirmedAt)}` : ''}.`),
        section('Job notes', list(notes.jobNotes)), section('Items needed', (notes.itemsNeeded || []).map(itemText)), section('Keep', list(notes.keepItems)), section('Remove / donate', list(notes.removeItems)), section('Access and staging', list(notes.access)), section('Hazards', list(notes.hazards)),
        view.canConfirm ? h('div', { className: 'wt-row wt-actions' }, button('Edit notes', edit, 'wt-btn wt-secondary', { disabled: ui.busy })) : null];
    }
    function body(view, mode) {
      const done = (view.parts || []).filter(part => part.status === 'done').length, total = Math.max(view.expectedParts || 0, (view.parts || []).length);
      if (mode === 'waiting') return [h('p', { role: 'status' }, 'Waiting for the walkthrough audio to upload. The transcript and notes appear here.'), view.canConfirm ? button('Type the notes instead', typeNotes, 'wt-btn wt-quiet') : null];
      if (mode === 'none') return [h('p', {}, 'This walkthrough has no recording. Type the notes the crew needs, then confirm them.'), view.canConfirm ? h('div', { className: 'wt-row wt-actions' }, button('Type notes for the crew', typeNotes, 'wt-btn wt-primary')) : null];
      if (mode === 'withdrawn') return [h('p', { role: 'status' }, 'The customer withdrew recording consent: the transcript was deleted.'), view.canConfirm ? button('Type notes for the crew', typeNotes, 'wt-btn wt-secondary') : null];
      // A part that never arrives (removed from the iPad after a copy was saved) does not hold the notes back: the estimator can
      // write them up from the parts that are in, or type them.
      if (mode === 'transcribing') return [h('p', { role: 'status', className: 'wtn-progress' }, `Transcribing: ${done} of ${total} part${total === 1 ? '' : 's'} done.`), h('progress', { max: total || 1, value: done }),
        done && view.canDraft && view.draftsLeft > 0 ? button(ui.busy ? 'Writing…' : 'Write up notes now', draft, 'wt-btn wt-quiet', { disabled: ui.busy }) : null, view.canConfirm ? button('Type the notes instead', typeNotes, 'wt-btn wt-quiet', { disabled: ui.busy }) : null];
      if (mode === 'ready') return [h('p', { role: 'status' }, ui.busy ? 'Writing up the notes from the transcript…' : 'The transcript is ready.'), view.canDraft && view.draftsLeft > 0 ? h('div', { className: 'wt-row wt-actions' }, button(ui.busy ? 'Writing…' : 'Write up notes', draft, 'wt-btn wt-primary', { disabled: ui.busy })) : null,
        view.canConfirm ? button('Type the notes instead', typeNotes, 'wt-btn wt-quiet', { disabled: ui.busy }) : null];
      if (mode === 'confirmed') return confirmedBlock(view);
      return editor(view);
    }
    function draw(force = false) {
      const focused = document.activeElement;
      if (!force && focused && host.contains(focused) && /^(TEXTAREA|INPUT|SELECT)$/.test(focused.tagName)) return;
      const view = ui.view, mode = panelMode(view, ui);
      if (mode === 'hidden') { host.replaceChildren(); host.hidden = true; return; }
      const withdrawable = view.canDraft && view.status !== 'withdrawn' && (view.parts || []).length;
      host.replaceChildren(h('div', { className: 'wt-panel', role: 'region', 'aria-labelledby': 'wtn-title' },
        h('div', { className: 'wt-head' }, h('div', {}, h('span', { className: 'wt-eyebrow' }, 'Walkthrough notes'), h('h2', { id: 'wtn-title' }, mode === 'confirmed' ? 'Notes for the crew' : 'Transcript and job notes'))),
        ui.message ? h('p', { className: 'wt-note', role: 'status' }, ui.message) : null,
        ui.error ? h('p', { className: 'wt-error', role: 'alert' }, ui.error) : null,
        ...[body(view, mode)].flat(), transcriptBlock(view),
        withdrawable ? button('Customer withdrew consent: delete the transcript', withdraw, 'wt-btn wt-quiet', { disabled: ui.busy }) : null));
      host.hidden = false;
    }
    const check = () => { if ((currentVisit() || null) !== ui.visitId) void load(); };
    // The recorder's sync ran: a Finish or a part may have landed. Read again (at most every 5 seconds) only while the panel
    // waits for one, never with the notes switched off.
    let nudged = 0;
    function nudge() {
      const at = (options.now || Date.now)();
      if (!ui.visitId || ui.view?.enabled === false || !['hidden', 'waiting', 'transcribing'].includes(panelMode(ui.view, ui)) || at - nudged < 5000) return;
      nudged = at; void load(true);
    }
    const ready = load(true);
    return { ready, check, nudge, refresh: () => load(true), draw, get state() { return ui; }, unmount() { timers.clearTimeout(ui.timer); host.replaceChildren(); host.hidden = true; } };
  }
  core.mount = mount;

  // The gameplan hook: the panel sits under the recorder card and follows the open walkthrough.
  if (typeof S === 'undefined' || !root.EGCHubAuth) return;
  const screen = document.getElementById('screen');
  if (!screen) return;
  const host = h('section', { id: 'wt-notes', hidden: true, 'aria-label': 'Walkthrough notes' });
  const recorder = document.getElementById('wt-recorder');
  if (recorder) recorder.after(host); else screen.before(host);
  const controller = mount(host, { visit: () => S.sourceWalkthroughId || null, fetch: (...args) => root.EGCHubAuth.fetch(...args), confirm: message => root.confirm(message) });
  if (root.MutationObserver) new MutationObserver(() => controller.check()).observe(screen, { childList: true });
  // The recorder's sync just ran (a part may have landed), or the page came back: read the open visit again.
  root.addEventListener?.('egc:walkthrough-sync', () => controller.nudge());
  root.addEventListener?.('online', () => controller.nudge());
  root.EGCWalkthroughNotes.page = controller;
})(typeof self !== 'undefined' ? self : globalThis);
