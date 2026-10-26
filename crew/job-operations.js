(() => {
  'use strict';
  const root = document.getElementById('content'), message = document.getElementById('message');
  const state = { viewer: '', board: null, job: null, pending: null, busy: false, sequence: 0 };
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'value') el.value = value ?? '';
      else el.setAttribute(key, value);
    }
    el.append(...children.flat().filter(value => value != null)); return el;
  };
  async function request(path, body) {
    if (!navigator.onLine) throw new Error('Reconnect to manage jobs. Changes are not queued offline.');
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw Object.assign(new Error(data.error || 'The request failed.'), { status: response.status, missing: data.missing });
      return data;
    } finally { clearTimeout(timeout); }
  }
  function notice(error) { message.textContent = [error.message, ...(error.missing || [])].join('\n'); }
  function button(label, action) { return h('button', { type: 'button', onclick: () => Promise.resolve().then(action).catch(notice) }, label); }
  const field = (form, name, label, value = '', type = 'text') => { const input = h(type === 'textarea' ? 'textarea' : 'input', { name, 'aria-label': label, ...(type === 'textarea' ? {} : { type }), value }); form.append(h('label', {}, label, input)); return input; };
  function select(form, name, label, rows, value, multiple = false) {
    const input = h('select', { name, 'aria-label': label, ...(multiple ? { multiple: '' } : {}) });
    if (!multiple) input.append(h('option', { value: '' }, 'None'));
    for (const row of rows) { const option = h('option', { value: row.id }, row.name || row.id); option.selected = multiple ? (value || []).includes(row.id) : row.id === value; input.append(option); }
    form.append(h('label', {}, label, input)); return input;
  }
  const values = select => [...select.selectedOptions].map(option => option.value);
  async function load() {
    const sequence = ++state.sequence;
    const data = await request('/api/job-operations?includeUnscheduled=true');
    if (sequence !== state.sequence) return;
    state.board = data; state.viewer = data.viewer.id; state.job = null; message.textContent = ''; render();
  }
  async function open(id) {
    const sequence = ++state.sequence, data = await request('/api/job-operations?view=job&jobId=' + encodeURIComponent(id));
    if (sequence !== state.sequence) return;
    state.board = { ...state.board, ...data }; state.viewer = data.viewer.id; state.job = data.job; render();
  }
  async function submit(path, body) {
    if (state.busy) return;
    // Retain the exact body and request ID after a lost response. Never silently
    // turn an uncertain save into a new operation or replay it under another user.
    state.pending = { path, body }; state.busy = true; message.textContent = 'Saving…';
    try {
      const result = await request(path, body); state.pending = null;
      message.textContent = 'Saved.'; await load(); return result;
    } catch (error) {
      notice(error);
      if (error.status && error.status < 500) state.pending = null;
      if (state.pending) { root.replaceChildren(h('p', {}, 'The save is unconfirmed. Retry the same operation before making another change.'), button('Check / retry save', () => state.pending ? submit(state.pending.path, state.pending.body) : load())); }
    } finally { state.busy = false; }
  }
  function edit(job = {}) {
    const form = h('form'), isNew = !job.id, source = state.board;
    const closed = ['cancelled', 'canceled', 'completed', 'paid', 'invoiced', 'closed', 'review_requested', 'no_show', 'noshow', 'no-show'].includes(job.status);
    form.append(h('h2', {}, isNew ? 'Create job' : 'Edit job'));
    let customer, sourceJob;
    if (isNew) {
      const search = field(form, 'customerSearch', 'Find customer by name or phone');
      const container = h('div'); form.append(button('Find customer', async () => {
        const data = await request('/api/job-operations?view=customers&q=' + encodeURIComponent(search.value));
        container.replaceChildren(); customer = select(container, 'customerId', 'Customer', data.customers, '');
        const sourceContainer = h('div'); container.append(sourceContainer);
        customer.addEventListener('change', async () => {
          sourceJob = null; sourceContainer.replaceChildren();
          try {
            const found = await request('/api/job-operations?view=search&q=' + encodeURIComponent(customer.value));
            const jobs = found.results.map(row => row.job).filter(job => job.customerId === customer.value);
            sourceContainer.replaceChildren(); sourceJob = select(sourceContainer, 'sourceJobId', 'Prior job at this property (when applicable)', jobs.map(job => ({ id: job.id, name: [job.address, job.date, job.title].filter(Boolean).join(' · ') })), '');
          } catch (error) { notice(error); }
        });
      }), container);
    } else form.append(h('p', {}, [job.customer, job.phone, job.address].filter(Boolean).join(' · ')));
    const title = field(form, 'title', 'Job title', job.title);
    const service = field(form, 'serviceType', 'Service', job.serviceType);
    const address = field(form, 'address', 'Job address', job.address);
    const scope = field(form, 'jobInstructions', 'Work instructions', job.jobInstructions, 'textarea');
    const access = field(form, 'accessInstructions', 'Access instructions', job.accessInstructions, 'textarea');
    const customerInstructions = field(form, 'customerInstructions', 'Customer instructions', job.customerInstructions, 'textarea');
    const date = field(form, 'date', 'Start date', job.date, 'date'), time = field(form, 'time', 'Start time', job.time, 'time');
    const endDate = field(form, 'endDate', 'End date', job.endDate, 'date'), endTime = field(form, 'endTime', 'End time', job.endTime, 'time');
    const crewGroup = select(form, 'crewId', 'Crew', source.crews, job.crewId);
    const crew = select(form, 'assignedCrew', 'Assigned people (select everyone working this job)', source.roster, job.assignedCrew, true);
    const lead = select(form, 'crewLead', 'Crew lead', source.roster, job.crewLead);
    const vehicle = select(form, 'vehicleId', 'Vehicle', source.vehicles, job.vehicleId);
    crewGroup.addEventListener('change', () => {
      const chosen = source.crews.find(row => row.id === crewGroup.value);
      if (!chosen) return;
      for (const option of crew.options) option.selected = chosen.memberIds.includes(option.value);
      lead.value = chosen.leadId || '';
    });
    const segmentInputs = [];
    if (job.assignmentSegments?.length) {
      form.append(h('p', {}, 'This job has separate crew visits. Edit each visit below. The overall dates and crew are calculated from them.'));
      for (const segment of job.assignmentSegments) {
        const group = h('fieldset', {}, h('legend', {}, 'Crew visit')); form.append(group);
        const item = { id: segment.id, crewId: segment.crewId };
        for (const key of ['date', 'time', 'endDate', 'endTime']) item[key] = field(group, key, ({ date: 'Start date', time: 'Start time', endDate: 'End date', endTime: 'End time' })[key], segment[key], key.toLowerCase().includes('date') ? 'date' : 'time');
        item.crew = select(group, 'assignedCrew', 'Assigned people', source.roster, segment.assignedCrew, true);
        item.lead = select(group, 'crewLead', 'Crew lead', source.roster, segment.crewLead);
        item.vehicle = select(group, 'vehicleId', 'Vehicle', source.vehicles, segment.vehicleId);
        segmentInputs.push(item);
      }
      for (const input of [date, time, endDate, endTime, crewGroup, crew, lead, vehicle]) input.disabled = true;
    }
    form.append(h('button', { type: 'submit' }, 'Save job'), button('Back to jobs', load));
    form.addEventListener('submit', event => {
      event.preventDefault(); if (state.pending || state.busy) return;
      const changes = { title: title.value, serviceType: service.value, jobInstructions: scope.value, accessInstructions: access.value, customerInstructions: customerInstructions.value };
      if (!isNew || address.value.trim()) changes.address = address.value;
      if (segmentInputs.length) changes.assignmentSegments = segmentInputs.map(item => ({ id: item.id, ...Object.fromEntries(['date', 'time', 'endDate', 'endTime'].map(key => [key, item[key].value])), assignedCrew: values(item.crew), crewLead: item.lead.value || null, crewId: item.crewId || null, vehicleId: item.vehicle.value || null }));
      else Object.assign(changes, { date: date.value, time: time.value, endDate: endDate.value || date.value, endTime: endTime.value, assignedCrew: values(crew), crewLead: lead.value || null, crewId: crewGroup.value || null, vehicleId: vehicle.value || null });
      if (!isNew) for (const key of Object.keys(changes)) {
        const before = job[key] ?? (Array.isArray(changes[key]) ? [] : typeof changes[key] === 'string' ? '' : null);
        if (JSON.stringify(before) === JSON.stringify(changes[key])) delete changes[key];
      }
      submit('/api/job-operations', { action: isNew ? 'schedule.create' : 'schedule.update', requestId: crypto.randomUUID(), expectedUser: state.viewer, changes, ...(isNew ? { kind: 'job', customerId: customer?.value, ...(sourceJob?.value ? { sourceJobId: sourceJob.value } : {}) } : { jobId: job.id, expectedRevision: job.revision }) }).catch(notice);
    }); root.replaceChildren(form);
    if (closed) {
      for (const control of form.querySelectorAll('input,select,textarea,button[type="submit"]')) control.disabled = true;
      form.append(h('p', {}, 'This job is closed. Its history is read-only.'));
    }
    if (job.id && !closed) {
      const reason = field(form, 'cancellationReason', 'Cancellation reason');
      form.append(button('Cancel job', () => { if (!reason.value.trim()) throw new Error('Add a cancellation reason.'); return submit('/api/job-operations', { action: 'schedule.cancel', requestId: crypto.randomUUID(), expectedUser: state.viewer, jobId: job.id, expectedRevision: job.revision, changes: {}, cancellationReason: reason.value }); }), button('Complete job', () => completion(job)));
    }
  }
  async function completion(job) {
    const data = await request('/api/field-jobs?jobId=' + encodeURIComponent(job.id)), form = h('form');
    form.append(h('h2', {}, 'Complete job'), h('p', {}, 'Required safety checks, photos and closeout records must already be complete.'));
    const notes = field(form, 'notes', 'Work completed', '', 'textarea'), issues = h('input', { type: 'checkbox' }); form.append(h('label', {}, 'Follow-up needed', issues));
    const issueNotes = field(form, 'issueNotes', 'Issue details', '', 'textarea');
    form.append(h('button', { type: 'submit' }, 'Complete job'), button('Back', () => edit(job)));
    form.addEventListener('submit', event => { event.preventDefault(); if (state.pending || state.busy) return; submit('/api/field-jobs', { action: 'complete', requestId: crypto.randomUUID(), expectedUser: state.viewer, jobId: job.id, expectedRevision: data.job.expectedRevision, notes: notes.value, hasIssues: issues.checked, issueNotes: issueNotes.value }).catch(notice); });
    root.replaceChildren(form);
  }
  function render() {
    if (state.job) return edit(state.job);
    const section = h('section', {}, button('Create job', () => edit()), button('Refresh', load));
    const search = field(section, 'search', 'Search job history'); section.append(button('Search', async () => { const data = await request('/api/job-operations?view=search&q=' + encodeURIComponent(search.value)); list.replaceChildren(...data.results.map(row => jobRow(row.job))); }));
    const jobRow = job => h('li', {}, button([job.customer || job.title || 'Job', job.date || 'Unscheduled', job.time || '', job.status].join(' · '), () => open(job.id)));
    const list = h('ul', {}, ...state.board.jobs.map(jobRow)); section.append(list); root.replaceChildren(section);
  }
  load().catch(notice);
})();
