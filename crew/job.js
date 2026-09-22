(function () {
  'use strict';
  const main = document.getElementById('field-main');
  const jobId = new URLSearchParams(location.search).get('jobId') || '';
  const S = { user: null, job: null, historyCursor: null, pending: null, busy: false, photosAvailable: false, queue: [], uploadBusy: false, actionError: null, feedbackTimer: null, date: mountainDate(), filter: 'all' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const label = value => String(value || '').replaceAll('_', ' ');
  const stamp = value => { try { return value ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : ''; } catch { return ''; } };
  const dateLabel = date => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`)); } catch { return 'Date pending'; } };
  const timeLabel = time => { const m = /^(\d{2}):(\d{2})/.exec(time || ''); return m ? `${Number(m[1]) % 12 || 12}:${m[2]} ${Number(m[1]) < 12 ? 'AM' : 'PM'}` : 'Time pending'; };
  const directions = address => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
  const key = suffix => `egc-field:${S.user?.user || ''}:${jobId}:${suffix}`;
  function mountainDate(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
  function getDraft(suffix, fallback = '') { try { return sessionStorage.getItem(key(suffix)) || fallback; } catch { return fallback; } }
  function setDraft(suffix, value) { try { value ? sessionStorage.setItem(key(suffix), value) : sessionStorage.removeItem(key(suffix)); } catch { /* The visible draft remains editable if browser storage is unavailable. */ } }
  function acceptJob(job) { S.job = job; S.timeSnapshot = job.jobTime; S.timeObservedAt = performance.now(); S.timeChanged = false; S.timeError = false; }
  const durationLabel = milliseconds => {
    if (milliseconds == null || !Number.isFinite(milliseconds)) return 'Not recorded';
    const seconds = Math.max(0, Math.floor(milliseconds / 1000)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
    return hours ? `${hours} hr ${minutes} min` : minutes ? `${minutes} min` : `${seconds} sec`;
  };
  function renderJobTime() {
    const host = document.getElementById('job-time'), snapshot = S.timeSnapshot || S.job?.jobTime;
    if (!host || !snapshot) return;
    const elapsed = Math.max(0, performance.now() - (S.timeObservedAt ?? performance.now())), stale = elapsed >= 60000 || S.timeError;
    const totals = { ...snapshot };
    if (snapshot.recorded && snapshot.runningKind) totals[`${snapshot.runningKind}Ms`] += Math.min(elapsed, 60000);
    host.innerHTML = `<div class="section-heading"><h2>Job elapsed work</h2><span class="badge">${snapshot.runningKind ? `${esc(label(snapshot.runningKind))} ${stale ? 'last confirmed' : 'running'}` : snapshot.recorded ? 'Stopped' : 'Not started'}</span></div><p class="muted">This is time for the job. Employee shift and payroll hours remain in the time clock.</p><dl class="detail-grid"><div><dt>Recorded active work</dt><dd data-time="work">${snapshot.recorded ? durationLabel(totals.workMs) : 'Not recorded'}</dd></div><div><dt>Scheduled duration</dt><dd>${durationLabel(snapshot.estimatedMs)}</dd></div>${snapshot.recorded ? [['paused', 'Paused'], ['waiting', 'Waiting'], ['delayed', 'Delayed'], ['travel', 'Travel'], ['arrival', 'Arrival preparation']].map(([kind, name]) => `<div><dt>${name}</dt><dd data-time="${kind}">${durationLabel(totals[`${kind}Ms`])}</dd></div>`).join('') : ''}</dl>${snapshot.recorded && snapshot.estimatedMs != null ? `<p>${totals.workMs > snapshot.estimatedMs ? `${durationLabel(totals.workMs - snapshot.estimatedMs)} active work over the scheduled duration.` : `${durationLabel(snapshot.estimatedMs - totals.workMs)} between recorded active work and the scheduled duration.`}</p>` : ''}${snapshot.partialHistory ? '<p class="notice">Timing began after this job already had activity. Earlier work is not included.</p>' : ''}${snapshot.needsReview ? '<p class="notice">The timer needs manager review because a status, duration, or stored record is inconsistent.</p>' : ''}${!snapshot.recorded ? `<p>${esc(snapshot.message || 'Start the field workflow to record job time.')}</p>` : ''}${S.timeChanged ? '<p class="notice">Job details changed. Refresh the job before the next action.</p>' : ''}<small>${stale ? 'Timer could not be confirmed recently. Refresh when connected.' : `Live estimate from the last confirmed status · ${esc(stamp(snapshot.asOf))}`}</small><p><a href="/employee?view=my_day">Open employee time clock</a></p>`;
  }
  async function refreshJobTime() {
    if (!S.job || document.visibilityState !== 'visible' || S.busy || S.uploadBusy || S.pending || S.timeRefreshing) return;
    S.timeRefreshing = true;
    try { const data = await api(`/api/field-jobs?jobId=${encodeURIComponent(jobId)}&view=timer`); S.timeSnapshot = data.jobTime; S.timeObservedAt = performance.now(); S.timeChanged = data.expectedRevision !== S.job?.expectedRevision; S.timeError = false; }
    catch (error) { S.timeError = true; if ([403, 404].includes(error.status)) { S.job = null; renderError(error.message); } }
    finally { S.timeRefreshing = false; renderJobTime(); if (S.shiftEntry && !S.shiftPending) await loadEmployeeJobTime(); }
  }
  function renderEmployeeJobTime() {
    const host = document.getElementById('employee-job-time'); if (!host || !S.job) return;
    const entry = S.shiftEntry, current = entry?.current, thisJob = current?.jobId === jobId, recorded = entry?.summary.jobs.find(item => item.jobId === jobId), disabled = S.busy || S.uploadBusy || S.pending || S.shiftPending || S.shiftLoading;
    host.innerHTML = `<h2>Your time on this job</h2><p>This records your own work and travel within your active employee shift. Earlier job segments keep their original job.</p>${S.shiftError ? `<p class="notice error">${esc(S.shiftError)}</p>` : ''}${S.shiftPending ? '<div class="notice"><strong>Job time awaiting confirmation</strong><p>The switch may already be saved. Retry checks the same request ID.</p><div class="actions"><button data-action="retry-shift-time">Retry job time</button><button data-action="clear-shift-time">Check shift and clear retry</button></div></div>' : ''}${S.shiftLoaded && !entry ? '<p>You are not clocked in. Open the employee time clock before recording personal job time.</p>' : entry ? `<p><strong>${entry.onBreak ? 'On break — job minutes are excluded' : current?.kind === 'general' || !current ? 'General shift time' : `${esc(label(current.kind))}: ${esc(current.jobLabel || current.jobId)}`}</strong></p><dl class="detail-grid"><div><dt>Your recorded work here</dt><dd>${durationLabel(recorded?.workMs || 0)}</dd></div><div><dt>Your recorded travel here</dt><dd>${durationLabel(recorded?.travelMs || 0)}</dd></div></dl>${entry.summary.partialHistory ? '<p class="notice">Earlier shift time has no verified job segments and is not assigned to this job.</p>' : ''}${entry.summary.needsReview ? '<p class="notice error">Your job segments need manager review before more time can be assigned.</p>' : ''}<div class="actions">${S.job.canEdit ? [['work', thisJob && current.kind === 'work' ? 'Recording work here' : 'Start my work time here'], ['travel', thisJob && current.kind === 'travel' ? 'Recording travel here' : 'Start my travel time here']].map(([kind, text]) => `<button class="${kind === 'work' ? 'primary' : ''}" data-action="shift-time" data-kind="${kind}" ${disabled || entry.summary.needsReview || thisJob && current.kind === kind ? 'disabled' : ''}>${text}</button>`).join('') : ''}${current?.kind !== 'general' && current ? `<button data-action="shift-time" data-kind="general" ${disabled ? 'disabled' : ''}>End my job time</button>` : ''}</div>${!S.job.canEdit && thisJob ? '<p class="notice">This job is closed. End your personal job time when your work and travel are finished.</p>' : ''}` : '<p>Checking your active shift…</p>'}<div class="actions"><button data-action="refresh-shift-time" ${S.busy || S.shiftLoading ? 'disabled' : ''}>Refresh my shift</button><a class="button" href="/employee?view=my_day">Employee time clock</a></div>`;
  }
  async function loadEmployeeJobTime() {
    if (!S.job || S.shiftLoading) return;
    S.shiftLoading = true; const user = S.user.user;
    try {
      const data = await api('/api/employee-hub?view=own-job-time');
      if (S.user?.user !== user) return;
      if (data.user?.toLowerCase() !== user.toLowerCase()) { S.job = null; renderLogin('Your account changed. Sign in again to open your work.'); return; }
      S.shiftEntry = data.entry; S.shiftLoaded = true; S.shiftError = '';
    } catch (error) { S.shiftError = error.message; }
    finally { S.shiftLoading = false; renderEmployeeJobTime(); }
  }
  async function submitEmployeeJobTime(kind, retry = false) {
    if (S.busy || S.uploadBusy || S.pending || !retry && (S.shiftPending || !S.shiftEntry)) return;
    const payload = retry ? S.shiftPending : { collection: 'timeEntries', id: S.shiftEntry.id, data: { jobAction: { requestId: crypto.randomUUID(), expectedSegmentId: S.shiftEntry.currentSegmentId, jobId: kind === 'general' ? '' : jobId, kind } } };
    if (!payload) return;
    S.shiftPending = payload; setDraft('shiftAction', JSON.stringify(payload)); S.busy = true; S.shiftError = ''; renderJob();
    try {
      await api('/api/employee-hub', payload);
      S.shiftPending = null; setDraft('shiftAction', '');
      await loadEmployeeJobTime(); await refreshJob(); message('Your job time is saved. Previous segments and your shift remain intact.');
    } catch (error) {
      S.shiftError = error.message;
      if ([400, 403, 404].includes(error.status)) { S.shiftPending = null; setDraft('shiftAction', ''); }
      message(error.message, true);
    } finally { S.busy = false; if (S.job) renderJob(); }
  }
  function message(text, isError = false) {
    const feedback = document.getElementById('feedback'); clearTimeout(S.feedbackTimer); feedback.textContent = text; feedback.hidden = false; feedback.style.background = isError ? '#842b20' : '#163e2c';
    S.feedbackTimer = setTimeout(() => { feedback.hidden = true; }, isError ? 12000 : 5500);
  }
  function connection() { const el = document.getElementById('connection'); el.hidden = navigator.onLine; el.textContent = 'You are offline. Changes are not confirmed until the server saves them. Saved photo drafts can be retried when connected.'; }
  async function api(url, input) {
    let response;
    try { response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(input?.action === 'photo' ? 120000 : 30000) }); }
    catch { throw new Error('The server did not confirm this action. Check your connection, then retry; the same action will not be saved twice.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) { const error = Object.assign(new Error(data.error || 'Job services are unavailable. Retry shortly.'), { status: response.status, code: data.code, missing: data.missing }); if (response.status === 401) { S.job = null; renderLogin(error.message); } throw error; }
    return data;
  }
  async function initialize() {
    connection();
    try { S.user = await api('/api/hub-auth'); await load(); }
    catch (error) { if (error.status !== 401) renderError(error.message); }
  }
  function renderLogin(error = '') {
    main.innerHTML = `<section class="card login-card"><span class="eyebrow">Employee sign in</span><h1>Your workday starts here</h1><p>Use your existing EGC employee login.</p>${error ? `<p class="notice error" role="alert">${esc(error)}</p>` : ''}<form id="field-login"><div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" autocapitalize="none" required></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><button class="primary" type="submit">Sign in</button></form></section>`;
  }
  function renderError(text) { main.innerHTML = `<section class="card"><h1>We could not open this work</h1><p class="notice error" role="alert">${esc(text)}</p><div class="actions"><button data-action="reload">Retry</button><a class="button" href="/crew/job.html">My assignments</a><a class="button" href="/employee?view=my_day">Employee Hub</a></div></section>`; }
  async function load() {
    if (!jobId) return loadDay();
    if (S.shiftOwner !== S.user?.user) { S.shiftEntry = null; S.shiftLoaded = false; S.shiftError = ''; S.shiftOwner = S.user?.user; }
    try { S.shiftPending = JSON.parse(getDraft('shiftAction', 'null')); } catch { S.shiftPending = null; }
    try {
      const data = await api(`/api/field-jobs?jobId=${encodeURIComponent(jobId)}`);
      acceptJob(data.job); S.historyCursor = data.historyCursor; S.photosAvailable = data.photosAvailable;
      try { S.pending = JSON.parse(getDraft('pending', 'null')); } catch { S.pending = null; }
      await loadPhotoQueue(); renderJob(); await loadEmployeeJobTime();
    } catch (error) { if (error.status !== 401) renderError(error.message); throw error; }
  }
  async function refreshJob() {
    const data = await api(`/api/field-jobs?jobId=${encodeURIComponent(jobId)}`);
    acceptJob(data.job); S.historyCursor = data.historyCursor; S.photosAvailable = data.photosAvailable; return data;
  }
  async function loadDay() {
    try {
      const data = await api(`/api/field-jobs?date=${encodeURIComponent(S.date)}&status=${encodeURIComponent(S.filter)}`);
      const next = data.jobs.find(job => !['completed', 'paid', 'invoiced', 'review_requested', 'cancelled'].includes(job.status));
      main.innerHTML = `<div class="toolbar"><div><span class="eyebrow">My assignments · Mountain Time</span><h1>${esc(dateLabel(data.date))}</h1><p>Signed in as ${esc(S.user.displayName || S.user.user)}</p></div><button data-action="reload">Refresh</button></div><div class="card"><div class="detail-grid"><div class="field"><label for="day-date">Date</label><input type="date" id="day-date" value="${esc(S.date)}"></div><div class="field"><label for="day-filter">Jobs</label><select id="day-filter">${[['all', 'All assigned'], ['active', 'Active'], ['completed', 'Completed'], ['cancelled', 'Cancelled']].map(([value, text]) => `<option value="${value}" ${value === S.filter ? 'selected' : ''}>${text}</option>`).join('')}</select></div></div><div class="actions"><button data-action="today">Today</button><button data-action="tomorrow">Tomorrow</button></div></div>${data.jobs.length ? data.jobs.map(job => `<a class="card day-job" href="/crew/job.html?jobId=${encodeURIComponent(job.id)}"><div class="section-heading"><span class="badge ${job.status === 'completed' ? 'done' : ''}">${esc(label(job.fieldStatus))}</span>${job === next ? '<span class="next">Next active job →</span>' : ''}</div><h2>${esc(job.customer || 'Customer pending')}</h2><strong>${esc(timeLabel(job.time))}–${esc(timeLabel(job.endTime))}${job.endDate !== job.date ? ` · through ${esc(dateLabel(job.endDate))}` : ''}</strong><p>${esc(job.address || 'Address missing — contact operations')}</p><p>${esc(job.serviceType)} · ${esc(job.crewMembers.map(member => member.name).join(', ') || 'Crew pending')}</p><small>${job.vehicleName ? `Vehicle: ${esc(job.vehicleName)}` : job.vehicleId ? `Vehicle: ${esc(job.vehicleId)}` : 'Vehicle not assigned'}</small></a>`).join('') : '<section class="card"><h2>No assignments for this view</h2><p>Change the date or filter, or check with operations. Only jobs assigned to your employee account appear here.</p></section>'}<p class="offline-stamp">Updated ${esc(stamp(data.generatedAt))} Mountain Time</p>`;
    } catch (error) { if (error.status !== 401) renderError(error.message); }
  }
  function block(title, text) { return text ? `<div class="scope-block"><h3>${esc(title)}</h3><div class="text-block">${esc(text)}</div></div>` : ''; }
  function pendingCard() { const error = S.actionError ? `<section class="card notice error" role="alert"><strong>${esc(S.actionError.message)}</strong>${S.actionError.missing?.length ? `<ul>${S.actionError.missing.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}</section>` : ''; return error + (S.pending ? `<section class="card pending-action"><h2>Action awaiting confirmation</h2><p>${esc(label(S.pending.action))} was not confirmed. Retry checks the same action ID so it cannot be duplicated.</p><div class="actions"><button class="primary" data-action="retry-pending" ${S.busy ? 'disabled' : ''}>Refresh and retry</button><button data-action="discard-pending" ${S.busy ? 'disabled' : ''}>Check server and clear retry</button></div></section>` : ''); }
  function renderJob() {
    const j = S.job; if (!j) return;
    const completed = j.checklist.filter(item => item.completed).length;
    const required = j.checklist.filter(item => item.required && !item.completed).length;
    const lead = j.crewMembers.find(member => member.id.toLowerCase() === j.crewLead.toLowerCase());
    const disabled = S.busy || S.uploadBusy || !!S.pending;
    main.innerHTML = `<div class="toolbar"><a class="button" href="/crew/job.html">← My day</a><button data-action="reload" ${S.busy || S.uploadBusy ? 'disabled' : ''}>Refresh job</button></div><span class="eyebrow">${esc(j.serviceType || 'Garage service')} · Job ${esc(j.id)}</span><h1>${esc(j.customer || 'Customer name pending')}</h1><div class="section-heading"><span class="badge ${j.completedAt ? 'done' : ['delayed', 'paused', 'waiting', 'cancelled'].includes(j.fieldStatus) ? 'alert' : ''}">${esc(label(j.fieldStatus))}</span><small>All times Mountain</small></div>${pendingCard()}${!j.address ? '<p class="notice">This job is missing its address. Contact operations before leaving.</p>' : ''}<section class="card"><h2>${esc(dateLabel(j.date))}</h2><p><strong>${esc(timeLabel(j.time))}–${esc(timeLabel(j.endTime))}${j.endDate !== j.date ? ` · through ${esc(dateLabel(j.endDate))}` : ''}</strong>${j.arrivalWindow ? `<br>Arrival window: ${esc(j.arrivalWindow)}` : ''}</p><p>${esc(j.address || 'Address pending')}</p><div class="actions">${j.address ? `<a class="button primary" href="${directions(j.address)}" target="_blank" rel="noopener">Navigate to job ↗</a>` : ''}${j.phone ? `<a class="button" href="tel:${esc(j.phone.replace(/[^+0-9]/g, ''))}">Call customer</a>` : ''}</div><dl class="detail-grid"><div><dt>Crew</dt><dd>${esc(j.crewMembers.map(member => member.name).join(', ') || 'Not assigned')}</dd></div><div><dt>Crew lead</dt><dd>${esc(lead?.name || j.crewLead || 'Not designated')}</dd></div><div><dt>Vehicle</dt><dd>${esc(j.vehicleName || j.vehicleId || 'Not assigned')}</dd></div><div><dt>Equipment</dt><dd>${esc(j.requiredEquipment.join(', ') || 'No equipment list recorded')}</dd></div></dl>${j.canEdit ? `<div class="actions">${j.allowedStatuses.filter(status => status !== j.fieldStatus).map(status => `<button class="${['dispatched', 'arrived', 'in_progress'].includes(status) ? 'primary' : ''}" data-action="status" data-status="${status}" ${disabled ? 'disabled' : ''}>${esc(({ dispatched: 'Mark en route', arrived: 'Mark arrived', in_progress: j.startedAt ? 'Resume work' : 'Start work', paused: 'Pause work', waiting: 'Waiting', delayed: 'Report delay' })[status] || label(status))}</button>`).join('')}</div><div id="status-reason"></div>` : ''}</section><div class="grid"><div><section class="card"><h2>Scope & instructions</h2>${block('Work to complete', j.scope) || '<p class="notice">No operational scope has been recorded. Confirm the scope with operations before starting.</p>'}${block('Customer goal', j.customerGoal)}${block('Customer instructions', j.customerInstructions)}${block('Access', [...j.access, j.accessInstructions].filter(Boolean).join('\n'))}${block('Keep and protect', j.keepItems)}${block('Remove', j.removeItems)}${block('Exclusions', j.exclusions)}${block('Hazards', j.hazards.join('\n'))}${block('Truck placement', j.truckPlacement)}</section><section class="card" id="checklist-card"><div class="section-heading"><h2>Job checklist</h2><span class="badge">${completed}/${j.checklist.length}</span></div><p>${required ? `${required} required items remaining.` : 'All required checks are complete.'} Changes save to this job for the entire crew.</p>${[['departure', 'Before departure'], ['arrival', 'At arrival'], ['work', 'Work execution'], ['finish', 'Finish & customer walkthrough']].map(([stage, name]) => `<div class="check-group"><h3>${name}</h3>${j.checklist.filter(item => item.stage === stage).map(item => `<label class="check"><input type="checkbox" data-check="${esc(item.id)}" ${item.completed ? 'checked' : ''} ${!j.canEdit || disabled ? 'disabled' : ''}><span class="check-label">${esc(item.label)}${!item.required ? ' <small>Optional</small>' : ''}${item.detail ? `<small>${esc(item.detail)}</small>` : ''}${item.completed ? `<small>Saved by ${esc(item.completedBy || 'crew')} · ${esc(stamp(item.completedAt))}</small>` : ''}</span></label>`).join('')}</div>`).join('')}${checklistEditor()}</section>${j.materials.length ? `<section class="card"><h2>Materials</h2>${j.materials.map(item => `<div class="material"><div><strong>${esc(item.name)}</strong>${item.quantity != null ? `<br><small>Quantity: ${esc(item.quantity)}</small>` : ''}</div><select aria-label="${esc(item.name)} state" data-material="${esc(item.id)}" ${!j.canEdit || disabled ? 'disabled' : ''}>${['required', 'loaded', 'used', 'missing'].map(state => `<option value="${state}" ${state === item.state ? 'selected' : ''}>${label(state)}</option>`).join('')}</select></div>`).join('')}</section>` : ''}</div><div><section class="card" id="photos-card"><div class="section-heading"><h2>Job photos</h2><span class="badge">${j.photos.length} verified</span></div><p>Before, progress, after, and problem photos stay with this job.</p><div class="photo-grid">${j.photos.map(photo => `<button class="photo-tile" data-action="view-photo" data-photo="${photo.id}"><img src="${esc(photo.url)}" alt="${esc(photo.caption || `${photo.category} photo`)}" loading="lazy"><span>${esc(label(photo.category))}${photo.caption ? ` · ${esc(photo.caption)}` : ''}</span></button>`).join('')}</div>${!j.photos.length ? '<p class="empty">No verified field photos yet.</p>' : ''}${j.status !== 'cancelled' ? photoForm() : ''}<div id="photo-queue">${queueMarkup()}</div></section><section class="card"><h2>Crew notes & issues</h2><p>Notes are timestamped and shared with this job’s assigned crew and managers.</p>${issueMarkup()}<form id="note-form"><div class="field"><label for="note-body">Add a note</label><textarea id="note-body" data-draft="note" maxlength="4000" required placeholder="What should the crew or dispatcher know?">${esc(getDraft('note'))}</textarea></div><label class="check"><input type="checkbox" id="note-issue" ${getDraft('noteIssue') === 'yes' ? 'checked' : ''}><span>Flag an issue needing operations follow-up</span></label>${j.canAddManagementNote ? `<label class="check"><input type="checkbox" id="note-private" ${getDraft('notePrivate') === 'yes' ? 'checked' : ''}><span>Management only</span></label>` : ''}<button class="primary" type="submit" ${disabled ? 'disabled' : ''}>Save note</button></form></section><section class="card" id="history-card"><div class="section-heading"><h2>Job history</h2><span class="eyebrow">Server records</span></div>${historyMarkup(j.history)}${S.historyCursor ? '<button data-action="history-more">Load earlier history</button>' : ''}</section></div><section class="card full" id="complete-card">${completionMarkup()}</section></div><p class="offline-stamp">Showing the last confirmed server record. Refresh to see changes made by other crew members.</p>`;
    mountJobSections();
  }
  function mountJobSections() {
    const timeCard = document.createElement('section'); timeCard.className = 'card'; timeCard.id = 'job-time'; main.querySelector('.grid').insertAdjacentElement('beforebegin', timeCard); renderJobTime();
    const employeeTime = document.createElement('section'); employeeTime.className = 'card'; employeeTime.id = 'employee-job-time'; timeCard.insertAdjacentElement('afterend', employeeTime); renderEmployeeJobTime();
    const scope = [...main.querySelectorAll('h2')].find(heading => heading.textContent === 'Scope & instructions'); if (scope) scope.closest('.card').id = 'scope-card';
    const notes = [...main.querySelectorAll('h2')].find(heading => heading.textContent === 'Crew notes & issues'); if (notes) notes.closest('.card').id = 'notes-card';
    const nav = document.createElement('nav'); nav.className = 'job-sections'; nav.setAttribute('aria-label', 'Job sections'); nav.innerHTML = [['scope-card', 'Scope'], ['checklist-card', 'Checklist'], ['photos-card', 'Photos'], ['notes-card', 'Notes'], ['complete-card', 'Complete']].map(([id, text]) => `<a href="#${id}">${text}</a>`).join(''); main.querySelector('h1').insertAdjacentElement('afterend', nav);
    if (S.job.statusReason) { const reason = document.createElement('p'); reason.className = 'notice'; reason.textContent = `${label(S.job.fieldStatus)}: ${S.job.statusReason}`; nav.insertAdjacentElement('afterend', reason); }
    const history = document.getElementById('history-card'), entries = [...history.querySelectorAll('.history-item')];
    if (entries.length > 5) { const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = `Earlier history · ${entries.length - 5} loaded items`; details.append(summary); entries.slice(5).forEach(entry => details.append(entry)); details.open = S.historyExpanded === true; details.addEventListener('toggle', () => { S.historyExpanded = details.open; }); history.append(details); }
  }
  function checklistEditor() {
    if (!S.job.canManageChecklist) return '';
    const rows = S.job.checklist.filter(item => !item.id.startsWith('client-')).map(item => `${item.stage} | ${item.required ? 'required' : 'optional'} | ${item.label}`).join('\n');
    return `<details><summary>Manager: configure this job’s checklist</summary><p>One item per line: stage | required or optional | task. Stages: departure, arrival, work, finish. Changing a task clears its previous check. Existing customer-specific checks are preserved.</p><form id="checklist-config"><div class="field"><label for="checklist-lines">Job checklist</label><textarea id="checklist-lines" rows="10">${esc(rows)}</textarea></div><button type="submit" ${S.pending || S.busy ? 'disabled' : ''}>Save checklist</button></form></details>`;
  }
  function issueMarkup() {
    const issue = S.job.attention;
    if (!issue) return '';
    return `<aside class="notice" id="job-issue"><h3>${issue.status === 'resolved' ? 'Issue resolved' : 'Operations follow-up needed'}</h3><p class="text-block">${esc(issue.reason)}</p><small>Reported by ${esc(issue.reportedBy || 'crew')} · ${esc(stamp(issue.reportedAt))}${issue.visibility === 'management' ? ' · Management only' : ''}</small>${issue.status === 'resolved' ? `<p class="text-block">${esc(issue.resolution)}</p><small>Resolved by ${esc(issue.resolvedBy)} · ${esc(stamp(issue.resolvedAt))}</small>` : ''}${issue.canResolve ? `<form id="resolve-issue-form"><div class="field"><label for="issue-resolution">Resolution & follow-up</label><textarea id="issue-resolution" data-draft="resolution" minlength="10" maxlength="4000" required placeholder="Describe what was done and any customer follow-up.">${esc(getDraft('resolution'))}</textarea></div><button type="submit" ${S.pending || S.busy || S.uploadBusy ? 'disabled' : ''}>Resolve issue</button><p class="muted">The original report and your resolution remain in the job history.</p></form>` : ''}</aside>`;
  }
  function photoForm() {
    if (!S.photosAvailable) return '<p class="notice error">Photo storage is unavailable. Contact operations; no upload will be reported as saved.</p>';
    return `<details open><summary>Add photos</summary><div class="field"><label for="photo-category">Photo category</label><select id="photo-category">${['before', 'progress', 'after', 'damage'].map(category => `<option value="${category}">${label(category)}</option>`).join('')}</select></div><div class="field"><label for="photo-caption">Caption (optional)</label><input id="photo-caption" maxlength="500" placeholder="Area, item or issue shown"></div><div class="field"><label for="photo-camera">Take a photo</label><input id="photo-camera" type="file" accept="image/*" capture="environment"></div><div class="field"><label for="photo-library">Choose photos from library</label><input id="photo-library" type="file" accept="image/*" multiple></div><small>Photos are resized before upload. A photo counts only after the server verifies and saves it. Up to 8 photos per selection.</small></details>`;
  }
  function historyMarkup(events) { return events.length ? events.map(event => `<article class="history-item"><strong>${esc(event.summary || label(event.action))}</strong><small>${esc(event.actorName || event.actorId)} · ${esc(stamp(event.createdAt))}${event.visibility === 'management' ? ' · Management only' : ''}</small>${event.body ? `<p class="text-block">${esc(event.body)}</p>` : ''}</article>`).join('') : '<p class="empty">No field activity recorded yet.</p>'; }
  function completionMarkup() {
    const j = S.job;
    if (j.completion) return `<span class="badge done">Work completed</span><h2>Saved ${esc(stamp(j.completion.completedAt))}</h2><p>Completed by ${esc(j.completion.completedBy)}.</p><p class="text-block">${esc(j.completion.notes)}</p>${j.completion.hasIssues ? `<p class="notice">Follow-up reported at completion: ${esc(j.completion.issueNotes)}</p>` : ''}<p class="muted">Work completion does not mark an invoice paid. Payment remains in the existing payment workflow.</p>${j.completionSync ? `<div class="${j.completionSync.status === 'synced' ? 'empty' : 'notice'}"><strong>Internal completion handoff: ${esc(j.completionSync.status)}</strong><p>${esc(j.completionSync.message)}</p>${j.completionSync.canRetry ? `<button data-action="retry-completion-sync" ${S.pending || S.busy ? 'disabled' : ''}>Retry internal handoff</button>` : ''}</div>` : ''}<div class="actions"><a class="button primary" href="/crew/job.html">Open my next job</a></div>`;
    if (!j.canEdit) return `<h2>${esc(label(j.status))}</h2><p>This job’s execution record is closed. Existing evidence and history remain available.</p>`;
    return `<h2>Complete the job</h2><p>Check the work, save before and after photos, and record the actual services performed. Completion records your account and the server timestamp.</p>${j.completionMissing.length ? `<details open><summary>Required before completion</summary><ul class="completion-missing">${j.completionMissing.map(item => `<li>${esc(item)}</li>`).join('')}</ul></details>` : ''}<form id="completion-form"><div class="field"><label for="completion-notes">Completion notes</label><textarea id="completion-notes" data-draft="completion" minlength="10" maxlength="4000" required placeholder="Describe the services completed, customer walkthrough, and anything that changed.">${esc(getDraft('completion'))}</textarea></div><div class="field"><label for="completion-issues">Does anything need follow-up?</label><select id="completion-issues" required><option value="">Choose an answer</option><option value="no" ${getDraft('hasIssues') === 'no' ? 'selected' : ''}>No issues or damage to report</option><option value="yes" ${getDraft('hasIssues') === 'yes' ? 'selected' : ''}>Yes — issue, damage, or follow-up needed</option></select></div><div class="field"><label for="issue-notes">Issue details (required if yes)</label><textarea id="issue-notes" data-draft="issueNotes" maxlength="4000" placeholder="Describe the issue, customer impact, and next step.">${esc(getDraft('issueNotes'))}</textarea></div><button class="primary" type="submit" ${S.pending || S.busy || S.uploadBusy || S.queue.some(photo => photo.state !== 'saved') ? 'disabled' : ''}>Review & complete job</button><p class="muted">All queued photos must finish uploading first.</p><div id="completion-error" role="alert"></div></form>`;
  }
  async function submitAction(payload, fromRetry = false) {
    if (S.busy || S.uploadBusy || (!fromRetry && S.pending)) return;
    S.busy = true; S.actionError = null;
    const input = fromRetry ? { ...S.pending, expectedRevision: S.job.expectedRevision } : { ...payload, jobId, requestId: crypto.randomUUID(), expectedRevision: S.job.expectedRevision, expectedUser: S.user.user };
    S.pending = input; setDraft('pending', JSON.stringify(input)); renderJob();
    try {
      const data = await api('/api/field-jobs', input); S.pending = null; setDraft('pending', ''); acceptJob(data.job); S.historyCursor = data.historyCursor;
      if (input.action === 'note') ['note', 'noteIssue', 'notePrivate'].forEach(suffix => setDraft(suffix, ''));
      if (input.action === 'resolve_issue') setDraft('resolution', '');
      if (input.action === 'complete') ['completion', 'issueNotes', 'hasIssues'].forEach(suffix => setDraft(suffix, ''));
      if (input.action === 'retry_completion_sync') message(S.job.completionSync?.message || 'Internal handoff checked.', S.job.completionSync?.status !== 'synced');
      else message(data.alreadyApplied ? 'This action was already saved. The current job is shown.' : 'Saved to the job.');
    } catch (error) {
      if ([400, 403, 404, 415].includes(error.status) || ['FIELD_START_INCOMPLETE', 'FIELD_COMPLETION_INCOMPLETE', 'FIELD_STATUS_CONFLICT', 'FIELD_JOB_CLOSED', 'FIELD_ISSUE_CHANGED'].includes(error.code)) { S.pending = null; setDraft('pending', ''); }
      if (error.status === 403 || error.status === 404) { S.job = null; renderError(error.message); }
      S.actionError = { message: error.message, missing: error.missing };
      message(error.message, true);
    } finally { S.busy = false; if (S.job) renderJob(); }
  }
  function photoDb() {
    return new Promise((resolve, reject) => { if (!window.indexedDB) return reject(new Error('This browser cannot keep photo drafts after refresh. Keep this page open until upload succeeds.')); const request = indexedDB.open('egc-field-photo-drafts', 1); request.onupgradeneeded = () => request.result.createObjectStore('photos', { keyPath: 'id' }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Photo drafts could not be saved on this device. Keep the page open and retry.')); });
  }
  async function photoStore(method, value) {
    const db = await photoDb();
    try { return await new Promise((resolve, reject) => { const tx = db.transaction('photos', method === 'getAll' ? 'readonly' : 'readwrite'), store = tx.objectStore('photos'); let result; const req = value === undefined ? store[method]() : store[method](value); req.onsuccess = () => { result = req.result; }; tx.oncomplete = () => resolve(result); tx.onerror = () => reject(new Error('The photo draft could not be saved on this device.')); tx.onabort = tx.onerror; }); } finally { db.close(); }
  }
  async function loadPhotoQueue() { try { S.queue = (await photoStore('getAll')).filter(photo => photo.user === S.user.user && photo.jobId === jobId).map(photo => ({ ...photo, state: 'ready', error: photo.error || '' })); } catch (error) { S.queue = S.queue.filter(photo => photo.user === S.user.user && photo.jobId === jobId); if (S.queue.length) message(error.message, true); } }
  function queueMarkup() {
    return S.queue.length ? `<div class="photo-queue"><h3>Photo drafts on this device</h3>${S.queue.map(photo => `<div class="queue-item"><img src="${photo.dataUrl}" alt="Photo draft"><div><strong>${esc(label(photo.category))}</strong><small>${photo.state === 'uploading' ? 'Uploading and verifying…' : photo.state === 'saved' ? 'Verified and saved' : photo.error ? esc(photo.error) : photo.persisted ? 'Saved on this device; awaiting upload' : 'Draft is only on this page; keep it open'}</small><div class="actions">${photo.state !== 'saved' ? `<button data-action="retry-photo" data-photo="${photo.id}" ${S.uploadBusy || S.busy || S.pending ? 'disabled' : ''}>${photo.error ? 'Retry photo' : 'Upload photo'}</button>` : ''}<button data-action="remove-photo" data-photo="${photo.id}" ${S.uploadBusy ? 'disabled' : ''}>${photo.state === 'saved' ? 'Clear draft' : 'Discard draft'}</button></div></div></div>`).join('')}<button class="primary" data-action="upload-all" ${S.uploadBusy || S.busy || S.pending ? 'disabled' : ''}>Upload all ready photos</button></div>` : '';
  }
  function renderQueue() { const host = document.getElementById('photo-queue'); if (host) host.innerHTML = queueMarkup(); const submit = document.querySelector('#completion-form button[type=submit]'); if (submit) submit.disabled = S.uploadBusy || S.busy || !!S.pending || S.queue.some(photo => photo.state !== 'saved'); }
  async function compressPhoto(file) {
    if (!file || file.size > 40 * 1024 * 1024 || file.size === 0 || !/^image\//i.test(file.type || 'image/unknown')) throw new Error('Choose an image smaller than 40 MB.');
    const url = URL.createObjectURL(file), image = new Image();
    try {
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('This phone could not open the photo. Choose a JPG or take a new photo.')); image.src = url; });
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('This image has no readable dimensions.');
      const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight)), canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Photo conversion is unavailable. Retry with a JPG.');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', .82); if (!dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > 8 * 1024 * 1024) throw new Error('This photo is too large after resizing. Choose a smaller image.'); return dataUrl;
    } finally { URL.revokeObjectURL(url); }
  }
  async function selectPhotos(files) {
    if (!S.job || !S.photosAvailable) return;
    const selectedBy = S.user.user;
    const category = document.getElementById('photo-category').value, caption = document.getElementById('photo-caption').value;
    const selected = Array.from(files); if (selected.length > 8) { message('Choose up to 8 photos at a time.', true); return; }
    if (S.queue.length + selected.length > 20) { message('Upload or discard the current drafts before adding more (20 drafts per job).', true); return; }
    message('Preparing photo drafts…');
    for (const file of selected) {
      try {
        const photo = { id: crypto.randomUUID(), user: selectedBy, jobId, category, caption, dataUrl: await compressPhoto(file), state: 'ready', persisted: true };
        try { await photoStore('put', photo); } catch (error) { photo.persisted = false; photo.error = error.message; }
        if (S.user?.user !== selectedBy || !S.job) continue;
        S.queue.push(photo); renderQueue();
      } catch (error) { message(`${file.name || 'Photo'}: ${error.message}`, true); }
    }
    renderQueue(); if (S.queue.length) message('Photo drafts are ready. Tap Upload to save them to the job.');
  }
  async function uploadPhotos(ids) {
    if (S.uploadBusy || S.busy || S.pending || !S.job) return;
    S.uploadBusy = true; renderQueue();
    try {
      for (const id of ids) {
        const photo = S.queue.find(photo => photo.id === id); if (!photo || photo.state === 'saved') continue;
        photo.state = 'uploading'; photo.error = ''; renderQueue();
        try {
          await refreshJob();
          const data = await api('/api/field-jobs', { jobId, requestId: photo.id, expectedRevision: S.job.expectedRevision, expectedUser: photo.user, action: 'photo', category: photo.category, caption: photo.caption, dataUrl: photo.dataUrl });
          acceptJob(data.job); S.historyCursor = data.historyCursor; photo.state = 'saved';
          try { await photoStore('delete', photo.id); } catch { /* Server verification is authoritative; reusing this ID remains safe. */ }
          message('Photo verified and saved to the job.');
        } catch (error) {
          photo.state = 'ready'; photo.error = error.message;
          try { await photoStore('put', { ...photo, persisted: true }); photo.persisted = true; } catch { photo.persisted = false; }
          message(error.message, true); if ([401, 403, 404].includes(error.status)) { if (error.status !== 401) { S.job = null; renderError(error.message); } break; }
        }
        renderQueue();
      }
    } finally { S.uploadBusy = false; if (S.job) renderJob(); }
  }
  main.addEventListener('input', event => { const suffix = event.target.dataset.draft; if (suffix) setDraft(suffix, event.target.value); });
  main.addEventListener('change', async event => {
    const target = event.target;
    if (target.dataset.check) { const completed = target.checked; target.checked = !completed; await submitAction({ action: 'checklist', itemId: target.dataset.check, completed }); }
    else if (target.dataset.material) await submitAction({ action: 'material', materialId: target.dataset.material, state: target.value });
    else if (target.id === 'photo-camera' || target.id === 'photo-library') { const files = Array.from(target.files); target.value = ''; await selectPhotos(files); }
    else if (target.id === 'note-issue') setDraft('noteIssue', target.checked ? 'yes' : '');
    else if (target.id === 'note-private') setDraft('notePrivate', target.checked ? 'yes' : '');
    else if (target.id === 'completion-issues') setDraft('hasIssues', target.value);
    else if (target.id === 'day-date') { S.date = target.value; await loadDay(); }
    else if (target.id === 'day-filter') { S.filter = target.value; await loadDay(); }
  });
  main.addEventListener('submit', async event => {
    event.preventDefault(); const form = event.target;
    if (form.id === 'field-login') {
      const button = form.querySelector('button'); button.disabled = true; let signedIn = false;
      try { S.user = await api('/api/hub-auth', { username: form.username.value, password: form.password.value }); signedIn = true; await load(); } catch (error) { if (!signedIn) renderLogin(error.message); } finally { button.disabled = false; }
    } else if (form.id === 'note-form') {
      if (getDraft('notePrivate') === 'yes' && !S.job.canAddManagementNote) return message('This private draft requires manager access. It has not been shared with the crew.', true);
      await submitAction({ action: 'note', body: document.getElementById('note-body').value, issue: document.getElementById('note-issue').checked, visibility: document.getElementById('note-private')?.checked ? 'management' : 'crew' });
    }
    else if (form.id === 'resolve-issue-form') await submitAction({ action: 'resolve_issue', issueId: S.job.attention.id, resolution: document.getElementById('issue-resolution').value });
    else if (form.id === 'completion-form') {
      const notes = document.getElementById('completion-notes').value, hasIssues = document.getElementById('completion-issues').value === 'yes', issueNotes = document.getElementById('issue-notes').value;
      if (hasIssues && issueNotes.trim().length < 10) return message('Describe the issue and follow-up needed before completing the job.', true);
      if (!window.confirm('Complete this job? The job will close with your saved checklist, verified photos and completion notes.')) return;
      await submitAction({ action: 'complete', notes, hasIssues, issueNotes });
    } else if (form.id === 'status-form') await submitAction({ action: 'status', status: form.dataset.status, reason: form.elements.reason.value });
    else if (form.id === 'checklist-config') {
      const previous = S.job.checklist.filter(item => !item.id.startsWith('client-'));
      const items = document.getElementById('checklist-lines').value.split('\n').filter(line => line.trim()).map((line, index) => { const [stage, requirement, ...text] = line.split('|').map(part => part.trim()); return { id: previous[index]?.id || `custom-${crypto.randomUUID()}`, stage, required: requirement === 'required', label: text.join(' | '), detail: previous[index]?.detail || '' }; });
      await submitAction({ action: 'configure_checklist', items });
    }
  });
  main.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
    const action = button.dataset.action;
    try {
      if (action === 'reload') { button.disabled = true; await (S.user ? load() : initialize()); }
      else if (action === 'shift-time') await submitEmployeeJobTime(button.dataset.kind);
      else if (action === 'retry-shift-time') await submitEmployeeJobTime('', true);
      else if (action === 'refresh-shift-time') await loadEmployeeJobTime();
      else if (action === 'clear-shift-time') { await loadEmployeeJobTime(); if (!S.shiftError) { S.shiftPending = null; setDraft('shiftAction', ''); renderEmployeeJobTime(); } }
      else if (action === 'today' || action === 'tomorrow') { const date = new Date(`${mountainDate()}T12:00:00Z`); if (action === 'tomorrow') date.setUTCDate(date.getUTCDate() + 1); S.date = date.toISOString().slice(0, 10); await loadDay(); }
      else if (action === 'retry-pending') { await refreshJob(); await submitAction(S.pending, true); }
      else if (action === 'retry-completion-sync') await submitAction({ action: 'retry_completion_sync' });
      else if (action === 'discard-pending') { await refreshJob(); S.pending = null; setDraft('pending', ''); renderJob(); message('Current server record loaded. Retry cleared; saved history is shown below.'); }
      else if (action === 'status') {
        const status = button.dataset.status;
        if (['paused', 'waiting', 'delayed'].includes(status)) { document.getElementById('status-reason').innerHTML = `<form id="status-form" data-status="${status}"><div class="field"><label for="reason">Reason for ${esc(status)}</label><input id="reason" name="reason" minlength="3" maxlength="1000" required></div><button type="submit">Save ${esc(status)}</button></form>`; document.getElementById('reason').focus(); }
        else await submitAction({ action: 'status', status });
      } else if (action === 'view-photo') {
        const photo = S.job.photos.find(photo => photo.id === button.dataset.photo); if (!photo) return;
        const viewer = document.getElementById('photo-viewer'); viewer.querySelector('img').src = photo.url; viewer.querySelector('img').alt = photo.caption || `${photo.category} photo`; viewer.querySelector('p').textContent = `${label(photo.category)} · ${photo.caption || ''} · ${photo.actorName || 'Crew'} · ${stamp(photo.createdAt)}`; viewer.showModal();
      } else if (action === 'history-more') {
        button.disabled = true; const data = await api(`/api/field-jobs?jobId=${encodeURIComponent(jobId)}&historyCursor=${encodeURIComponent(S.historyCursor)}`); const old = S.job.history; acceptJob(data.job); S.job.history = [...new Map([...old, ...data.job.history].map(event => [event.id, event])).values()]; S.historyCursor = data.historyCursor; renderJob();
      } else if (action === 'retry-photo') await uploadPhotos([button.dataset.photo]);
      else if (action === 'upload-all') await uploadPhotos(S.queue.map(photo => photo.id));
      else if (action === 'remove-photo') { const id = button.dataset.photo; try { await photoStore('delete', id); } catch (error) { message(error.message, true); return; } S.queue = S.queue.filter(photo => photo.id !== id); renderQueue(); }
    } catch (error) { message(error.message, true); } finally { if (button.isConnected) button.disabled = false; }
  });
  document.getElementById('photo-viewer').querySelector('.viewer-close').addEventListener('click', () => document.getElementById('photo-viewer').close());
  window.addEventListener('online', connection); window.addEventListener('offline', connection);
  setInterval(renderJobTime, 1000); setInterval(refreshJobTime, 30000);
  window.addEventListener('beforeunload', event => { if (S.busy || S.uploadBusy || S.queue.some(photo => !photo.persisted && photo.state !== 'saved')) { event.preventDefault(); event.returnValue = ''; } });
  initialize();
})();
