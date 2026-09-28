(function () {
  'use strict';
  const main = document.getElementById('field-main');
  const jobId = new URLSearchParams(location.search).get('jobId') || '';
  const Outbox = window.EGCFieldOutbox, outbox = Outbox.create(), transport = Outbox.httpTransport();
  const S = { user: null, job: null, historyCursor: null, busy: false, syncing: false, saving: null, offline: false, initFailed: false, outbox: [], photosAvailable: false, queue: [], uploadBusy: false, actionError: null, errorText: '', feedbackTimer: null, date: mountainDate(), filter: 'all' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const label = value => String(value || '').replaceAll('_', ' ');
  const stamp = value => { try { return value ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : ''; } catch { return ''; } };
  const dateLabel = date => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`)); } catch { return 'Date pending'; } };
  const timeLabel = time => { const m = /^(\d{2}):(\d{2})/.exec(time || ''); return m ? `${Number(m[1]) % 12 || 12}:${m[2]} ${Number(m[1]) < 12 ? 'AM' : 'PM'}` : 'Time pending'; };
  const directions = address => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
  const key = suffix => `egc-field:${S.user?.user || ''}:${jobId}:${suffix}`;
  const viewerKey = 'egc-field:viewer', signedOutKey = 'egc-field:signed-out-at', snapshotKey = user => `egc-field:${user}:${jobId}:snapshot`, shiftKey = user => `egc-field:${user}:shift-snapshot`;
  const offline = () => S.offline || !navigator.onLine;
  const waiting = () => S.outbox.some(item => item.state !== 'error');
  // The action being written to the outbox right now shows at once, so the
  // card and locked controls appear before the device store answers.
  const pending = () => S.saving && !S.outbox.some(item => item.requestId === S.saving.requestId) ? [...S.outbox, S.saving] : S.outbox;
  const jobQueued = () => S.outbox.some(item => item.kind === 'field' && item.jobId === jobId);
  function mountainDate(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
  function getDraft(suffix, fallback = '') { try { return sessionStorage.getItem(key(suffix)) || fallback; } catch { return fallback; } }
  function setDraft(suffix, value) { try { value ? sessionStorage.setItem(key(suffix), value) : sessionStorage.removeItem(key(suffix)); } catch { /* The visible draft remains editable if browser storage is unavailable. */ } }
  // The last confirmed job and shift stay only in this tab's session so an
  // offline reload can show them; the service worker never stores API data.
  function remember(name, value) { try { value == null ? sessionStorage.removeItem(name) : sessionStorage.setItem(name, JSON.stringify(value)); } catch { /* An offline reload then shows the reconnect notice. */ } }
  function recall(name) { try { return JSON.parse(sessionStorage.getItem(name) || 'null'); } catch { return null; } }
  function forgetSnapshots() { try { for (let index = sessionStorage.length - 1; index >= 0; index--) { const name = sessionStorage.key(index) || ''; if (name === viewerKey || /^egc-field:.*:(snapshot|shift-snapshot)$/.test(name)) sessionStorage.removeItem(name); } } catch { /* Nothing was stored. */ } }
  // Signing out in the Employee Hub or on a crew page records the time on the
  // device; copies this tab saved before it are never shown or used offline.
  const signedOutAt = () => { try { return Number(localStorage.getItem(signedOutKey)) || 0; } catch { return 0; } };
  const afterSignOut = saved => Number(saved?.savedAt) > signedOutAt();
  function acceptJob(job) { S.job = job; S.timeSnapshot = job.jobTime; S.timeObservedAt = performance.now(); S.timeChanged = false; S.timeError = false; if (S.user && !S.offline) remember(snapshotKey(S.user.user), { job, photosAvailable: S.photosAvailable, savedAt: Date.now() }); }
  function h(tag, attributes = {}, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) { if (value === false || value == null) continue; if (name === 'class') element.className = value; else element.setAttribute(name, value === true ? '' : String(value)); }
    element.append(...children.flat(3).filter(child => child != null && child !== false).map(child => child instanceof Node ? child : document.createTextNode(String(child))));
    return element;
  }
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
    if (!S.job || document.visibilityState !== 'visible' || S.busy || S.uploadBusy || S.syncing || offline() || jobQueued() || S.timeRefreshing) return;
    S.timeRefreshing = true;
    try { const data = await api(`/api/field-jobs?jobId=${encodeURIComponent(jobId)}&view=timer`); S.timeSnapshot = data.jobTime; S.timeObservedAt = performance.now(); S.timeChanged = data.expectedRevision !== S.job?.expectedRevision; S.timeError = false; }
    catch (error) { S.timeError = true; if ([403, 404].includes(error.status)) { S.job = null; renderError(error.message); } }
    finally { S.timeRefreshing = false; renderJobTime(); if (S.shiftEntry && !S.outbox.some(item => item.kind === 'clock')) await loadEmployeeJobTime(); }
  }
  const currentShift = () => Outbox.projectShift(S.shiftEntry, pending().filter(item => item.kind === 'clock'));
  function renderEmployeeJobTime() {
    const host = document.getElementById('employee-job-time'); if (!host || !S.job) return;
    const clock = pending().filter(item => item.kind === 'clock'), blocked = clock.some(item => item.state === 'error');
    const entry = currentShift(), current = entry?.current, thisJob = current?.jobId === jobId, recorded = entry?.summary?.jobs?.find(item => item.jobId === jobId), disabled = S.busy || S.uploadBusy || S.shiftLoading || blocked;
    host.innerHTML = `<h2>Your time on this job</h2><p>This records your own work and travel within your active employee shift. Earlier job segments keep their original job.</p>${S.shiftError ? `<p class="notice error">${esc(S.shiftError)}</p>` : ''}${clock.length ? `<div class="notice"><strong>${blocked ? 'Time action needs review' : 'Time awaiting confirmation'}</strong><p>${blocked ? 'A saved time action was not accepted. Review it at the top of this job before recording more time.' : `${clock.length} time action${clock.length === 1 ? ' is' : 's are'} saved on this phone and ${offline() ? 'will sync in order when you reconnect' : 'syncing in order'}. Each keeps its request ID, so nothing is recorded twice.`}</p></div>` : ''}${(S.shiftLoaded || clock.length) && !entry ? '<p>You are not clocked in. Clock in here or from the employee time clock before recording personal job time.</p>' : entry ? `<p><strong>${entry.onBreak ? 'On break — job minutes are excluded' : current?.kind === 'general' || !current ? 'General shift time' : `${esc(label(current.kind))}: ${esc(current.jobLabel || current.jobId)}`}</strong></p><dl class="detail-grid"><div><dt>Your recorded work here</dt><dd>${durationLabel(recorded?.workMs || 0)}</dd></div><div><dt>Your recorded travel here</dt><dd>${durationLabel(recorded?.travelMs || 0)}</dd></div></dl>${entry.summary?.partialHistory ? '<p class="notice">Earlier shift time has no verified job segments and is not assigned to this job.</p>' : ''}${entry.summary?.needsReview ? '<p class="notice error">Your job segments need manager review before more time can be assigned.</p>' : ''}${entry.deviceTime ? '<p class="muted">Some times on this shift came from this phone while offline. A manager reviews them before approval.</p>' : ''}<div class="actions">${S.job.canEdit ? [['work', thisJob && current.kind === 'work' ? 'Recording work here' : 'Start my work time here'], ['travel', thisJob && current.kind === 'travel' ? 'Recording travel here' : 'Start my travel time here']].map(([kind, text]) => `<button class="${kind === 'work' ? 'primary' : ''}" data-action="shift-time" data-kind="${kind}" ${disabled || entry.summary?.needsReview || thisJob && current.kind === kind ? 'disabled' : ''}>${text}</button>`).join('') : ''}${current?.kind !== 'general' && current ? `<button data-action="shift-time" data-kind="general" ${disabled ? 'disabled' : ''}>End my job time</button>` : ''}</div>${!S.job.canEdit && thisJob ? '<p class="notice">This job is closed. End your personal job time when your work and travel are finished.</p>' : ''}` : S.shiftError ? '' : '<p>Checking your active shift…</p>'}<div class="actions"><button data-action="refresh-shift-time" ${S.busy || S.shiftLoading || offline() ? 'disabled' : ''}>Refresh my shift</button><a class="button" href="/employee?view=my_day">Employee time clock</a></div>`;
    const controls = h('div', { class: 'actions clock-actions' });
    if (S.user?.businessAccess === true) controls.append(h('p', { class: 'muted' }, 'Managers clock in, take breaks and clock out from the employee time clock.'));
    else if (entry) controls.append(h('button', { type: 'button', 'data-action': entry.onBreak ? 'break-end' : 'break-start', disabled }, entry.onBreak ? 'End break' : 'Start break'), h('button', { type: 'button', class: 'danger', 'data-action': 'clock-out', disabled }, 'Clock out'));
    else if (S.shiftLoaded || clock.length) controls.append(h('button', { type: 'button', class: 'primary', 'data-action': 'clock-in', disabled }, 'Clock in'));
    if (controls.childElementCount) host.lastElementChild.before(controls);
  }
  async function loadEmployeeJobTime() {
    if (!S.job || S.shiftLoading || S.offline) return;
    S.shiftLoading = true; const user = S.user.user;
    try {
      const data = await api('/api/employee-hub?view=own-job-time');
      if (S.user?.user !== user) return;
      if (data.user?.toLowerCase() !== user.toLowerCase()) { S.job = null; renderLogin('Your account changed. Sign in again to open your work.'); return; }
      S.shiftEntry = data.entry; S.shiftLoaded = true; S.shiftError = ''; remember(shiftKey(user), { entry: data.entry, savedAt: Date.now() });
    } catch (error) { S.shiftError = error.message; }
    finally { S.shiftLoading = false; renderEmployeeJobTime(); }
  }
  function renderManagerLabor() {
    const host = document.getElementById('manager-job-labor'); if (!host || !S.job?.canAddManagementNote) return;
    const data = S.managerLabor, employees = data?.employees || [];
    const total = key => employees.reduce((sum, employee) => sum + Number(employee[key] || 0), 0);
    host.innerHTML = `<div class="section-heading"><h2>Employee time on this job</h2><span class="eyebrow">Manager view</span></div><p>Net employee work and travel from explicit job segments. Recorded breaks are excluded. Job elapsed work above measures the job itself.</p>${S.managerLaborError ? `<p class="notice error">${esc(S.managerLaborError)}</p>` : ''}${data ? `<dl class="detail-grid"><div><dt>Total recorded employee work</dt><dd>${durationLabel(total('workMs'))}</dd></div><div><dt>Total recorded employee travel</dt><dd>${durationLabel(total('travelMs'))}</dd></div><div><dt>Work on approved timecards</dt><dd>${durationLabel(total('approvedWorkMs'))}</dd></div><div><dt>Work awaiting approval</dt><dd>${durationLabel(total('pendingWorkMs'))}</dd></div>${total('rejectedWorkMs') ? `<div><dt>Work on rejected timecards</dt><dd>${durationLabel(total('rejectedWorkMs'))}</dd></div>` : ''}</dl>${data.legacyAssociationOnlyCount ? `<p class="notice">${esc(data.legacyAssociationOnlyCount)} linked historical shift${data.legacyAssociationOnlyCount === 1 ? ' has' : 's have'} time without explicit job segments. Those untracked minutes are excluded.</p>` : ''}${data.needsReviewCount ? `<p class="notice error">${esc(data.needsReviewCount)} timecard${data.needsReviewCount === 1 ? ' needs' : 's need'} review and ${data.needsReviewCount === 1 ? 'is' : 'are'} excluded from these totals.</p>` : ''}${employees.length ? employees.map(employee => `<article class="history-item"><h3>${esc(employee.name || employee.employee)}</h3><p>Work: <strong>${durationLabel(employee.workMs)}</strong> · Travel: <strong>${durationLabel(employee.travelMs)}</strong></p><small>Approved work: ${durationLabel(employee.approvedWorkMs)} · Awaiting approval: ${durationLabel(employee.pendingWorkMs)}${employee.rejectedWorkMs ? ` · Rejected: ${durationLabel(employee.rejectedWorkMs)}` : ''}<br>${esc(employee.entryCount)} contributing shift${employee.entryCount === 1 ? '' : 's'}</small></article>`).join('') : '<p class="empty">No employee job segments have been recorded for this job.</p>'}<small>Last confirmed ${esc(stamp(data.asOf))} Mountain Time. Approval remains in the employee timecard workflow.</small>` : S.managerLaborLoading ? '<p>Loading employee job time…</p>' : '<p>Employee totals have not been confirmed.</p>'}<div class="actions"><button data-action="refresh-manager-labor" ${S.managerLaborLoading ? 'disabled' : ''}>Refresh employee time</button><a class="button" href="/employee?view=timesheets">Open employee timecards</a></div>`;
  }
  async function loadManagerLabor() {
    if (!S.job?.canAddManagementNote || S.managerLaborLoading || S.offline) return;
    S.managerLaborLoading = true; const user = S.user.user; renderManagerLabor();
    try {
      const data = await api(`/api/employee-hub?view=job-labor&jobId=${encodeURIComponent(jobId)}`);
      if (S.user?.user !== user || !S.job?.canAddManagementNote) return;
      if (data.jobId !== jobId || !Array.isArray(data.employees)) throw new Error('Employee time could not be associated with this job.');
      S.managerLabor = data; S.managerLaborError = '';
    } catch (error) { S.managerLabor = null; S.managerLaborError = error.message; }
    finally { S.managerLaborLoading = false; renderManagerLabor(); }
  }
  function currentPosition() {
    return new Promise((resolve, reject) => { if (!navigator.geolocation) return reject(new Error('Location is unavailable.')); navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 60000, timeout: 20000 }); });
  }
  // Clock-in/out, breaks and job switches share the ordered outbox. Each keeps
  // the device time it was recorded at and one request ID for every retry.
  async function clockAction(op, kind = '') {
    if (S.busy || S.uploadBusy || !S.user || !S.job || S.user.businessAccess === true && op !== 'job_time') return;
    const entry = currentShift(), requestId = crypto.randomUUID();
    if (op === 'clock_in' ? entry : !entry) return;
    if (S.outbox.some(item => item.kind === 'clock' && item.state === 'error')) return message('Review the saved time action that was not accepted before recording more time.', true);
    if (op === 'clock_out' && !window.confirm('Clock out now? Your shift will be submitted for approval.')) return;
    let payload;
    // The time is taken once the action is confirmed (and located), not when the prompt opened.
    if (op === 'clock_in') {
      let position;
      S.busy = true; renderEmployeeJobTime();
      try { position = await currentPosition(); } catch { S.busy = false; renderJob(); return message('Clock-in needs location access. Enable location for this site, then try again.', true); }
      payload = { op, entryId: `time-${S.user.user.trim().toLowerCase()}-${Date.now().toString(36)}`, deviceCapturedAt: new Date().toISOString(), lastLocation: { lat: Number(position.coords.latitude.toFixed(6)), lng: Number(position.coords.longitude.toFixed(6)), accuracy: Math.round(position.coords.accuracy || 0) } };
    } else payload = { op, entryId: entry.id, deviceCapturedAt: new Date().toISOString(), ...(op === 'job_time' ? { jobAction: { requestId, expectedSegmentId: entry.currentSegmentId, jobId: kind === 'general' ? '' : jobId, kind } } : {}) };
    const capturedAt = payload.deviceCapturedAt, item = { requestId, kind: 'clock', user: S.user.user, jobId, payload };
    S.busy = true; S.shiftError = ''; S.saving = { ...item, queuedAt: capturedAt, attempts: 0, state: 'queued' }; renderJob();
    let queued;
    try { queued = await outbox.enqueue(item); }
    catch (error) { S.busy = false; S.saving = null; renderJob(); return message(error.message, true); }
    await refreshOutbox(); S.busy = false; S.saving = null; renderJob();
    if (offline()) { requestBackgroundSync(); return message('Saved on this phone. It syncs in order when you reconnect. If the server cannot accept the time it was saved at, you will be asked to record it again.'); }
    await syncOutbox({ direct: queued.direct ? requestId : '' });
  }
  function message(text, isError = false) {
    const feedback = document.getElementById('feedback'); clearTimeout(S.feedbackTimer); feedback.textContent = text; feedback.hidden = false; feedback.style.background = isError ? '#842b20' : '#163e2c';
    S.feedbackTimer = setTimeout(() => { feedback.hidden = true; }, isError ? 12000 : 5500);
  }
  function connection() {
    const el = document.getElementById('connection'), count = S.outbox.filter(item => item.state !== 'error').length, stuck = S.outbox.length - count;
    el.hidden = !offline() && !stuck;
    el.textContent = offline() ? !S.user ? 'You are offline.' : `You are offline. ${count ? `${count} saved action${count === 1 ? ' is' : 's are'} on this phone and will sync in order when you reconnect.` : 'Checklist, material, note, status and time-clock actions you save stay on this phone until you reconnect.'} Photos upload only when connected.` : `${stuck} saved action${stuck === 1 ? ' needs' : 's need'} your review before ${stuck === 1 ? 'it syncs' : 'they sync'}.`;
  }
  async function refreshOutbox() {
    if (!S.user) S.outbox = [];
    else try { S.outbox = await outbox.items(S.user.user); } catch { /* Stored actions are kept; the list refreshes after the next change. */ }
    connection();
  }
  async function requestBackgroundSync() {
    try { const registration = await navigator.serviceWorker?.getRegistration('/crew/'); await registration?.sync?.register(Outbox.SYNC_TAG); } catch { /* The page also syncs when it is back online. */ }
  }
  async function api(url, input) {
    let response;
    try { response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...(input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(input?.action === 'photo' ? 120000 : 30000) }); }
    catch { throw new Error('The server did not confirm this action. Check your connection, then retry; the same action will not be saved twice.'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) { const error = Object.assign(new Error(data.error || 'Job services are unavailable. Retry shortly.'), { status: response.status, code: data.code, missing: data.missing }); if (response.status === 401) { S.job = null; forgetSnapshots(); renderLogin(error.message); } throw error; }
    return data;
  }
  function acceptViewer(user) {
    if (recall(viewerKey)?.user && recall(viewerKey).user !== user.user) forgetSnapshots();
    S.user = user; S.offline = false; S.initFailed = false;
    remember(viewerKey, { user: user.user, displayName: user.displayName, businessAccess: user.businessAccess === true, savedAt: Date.now() });
  }
  async function initialize() {
    if (S.initializing) return;
    S.initializing = true; connection();
    try { acceptViewer(await api('/api/hub-auth')); await load(); }
    catch (error) {
      if (!error.status) { S.initFailed = true; if (await offlineStart()) return; }
      else { S.offline = false; S.initFailed = false; connection(); }
      if (error.status !== 401) renderError(error.message);
    } finally { S.initializing = false; registerWorker(); }
  }
  // Offline reload: the shell comes from the service worker and the job from
  // this tab's last confirmed copy. New actions queue for the same account.
  // After a sign-out nothing is shown and nothing can be queued.
  async function offlineStart() {
    const viewer = recall(viewerKey);
    if (!viewer?.user && S.user) return false;
    if (!viewer?.user || !afterSignOut(viewer)) { forgetSnapshots(); S.user = null; S.job = null; S.outbox = []; S.offline = true; renderOffline(); connection(); return true; }
    if (S.user?.user !== viewer.user) S.user = viewer;
    S.offline = true; await refreshOutbox();
    const saved = jobId ? recall(snapshotKey(viewer.user)) : null;
    if (saved?.job?.id === jobId && jobId && afterSignOut(saved)) {
      S.photosAvailable = saved.photosAvailable === true; acceptJob(saved.job); S.historyCursor = null;
      const shift = recall(shiftKey(viewer.user)), fresh = afterSignOut(shift); S.shiftOwner = viewer.user; S.shiftEntry = fresh ? shift.entry || null : null; S.shiftLoaded = fresh; S.shiftError = fresh ? '' : 'Your shift could not be checked while offline.';
      await loadPhotoQueue(); renderJob();
    } else renderOffline();
    connection(); return true;
  }
  function renderOffline() {
    const count = S.outbox.length;
    main.replaceChildren(h('section', { class: 'card offline-card' }, h('span', { class: 'eyebrow' }, 'No connection'), h('h1', {}, 'You are offline'), h('p', {}, !S.user ? 'Sign in when you reconnect to open your work.' : jobId ? 'This job was not opened in this tab before the connection dropped, so it cannot be shown until you reconnect.' : 'Your assignments load when you reconnect.'), S.user ? h('p', {}, count ? `${count} saved action${count === 1 ? ' is' : 's are'} on this phone and will sync in order when you reconnect.` : 'Nothing is waiting to sync.') : null, h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', 'data-action': 'reload' }, 'Try again'))));
  }
  let workerStarted = false;
  async function registerWorker() {
    if (workerStarted || !('serviceWorker' in navigator)) return;
    workerStarted = true;
    try {
      const config = await fetch('/crew/sw-config.json', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.ok ? response.json() : {}, () => ({}));
      if (config?.enabled === false) { for (const registration of await navigator.serviceWorker.getRegistrations()) if (new URL(registration.scope).pathname.startsWith('/crew/')) await registration.unregister(); return; }
      await navigator.serviceWorker.register('/crew/sw.js', { scope: '/crew/' });
    } catch { /* Offline reloads need the worker; online work is unaffected without it. */ }
  }
  function renderLogin(error = '') {
    main.innerHTML = `<section class="card login-card"><span class="eyebrow">Employee sign in</span><h1>Your workday starts here</h1><p>Use your existing EGC employee login.</p>${error ? `<p class="notice error" role="alert">${esc(error)}</p>` : ''}<form id="field-login"><div class="field"><label for="username">Username</label><input id="username" name="username" autocomplete="username" autocapitalize="none" required></div><div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><button class="primary" type="submit">Sign in</button></form></section>`;
  }
  function renderError(text) {
    S.errorText = text;
    main.innerHTML = `<section class="card"><h1>We could not open this work</h1><p class="notice error" role="alert">${esc(text)}</p><div class="actions"><button data-action="reload">Retry</button><a class="button" href="/crew/job.html">My assignments</a><a class="button" href="/employee?view=my_day">Employee Hub</a></div></section>`;
    const held = S.outbox.filter(item => item.kind === 'field' && item.jobId === jobId).length;
    if (held) main.querySelector('.card').append(h('p', { class: 'notice' }, `${held} saved action${held === 1 ? ' for this job was' : 's for this job were'} not saved to it and ${held === 1 ? 'is' : 'are'} still on this phone. Check with operations before discarding.`), h('div', { class: 'actions' }, h('button', { type: 'button', 'data-action': 'outbox-discard-job' }, `Discard ${held} saved action${held === 1 ? '' : 's'}`)));
  }
  async function load() {
    if (!jobId) return loadDay();
    if (S.shiftOwner !== S.user?.user) { S.shiftEntry = null; S.shiftLoaded = false; S.shiftError = ''; S.shiftOwner = S.user?.user; S.managerLabor = null; S.managerLaborError = ''; }
    try {
      const data = await api(`/api/field-jobs?jobId=${encodeURIComponent(jobId)}`);
      S.photosAvailable = data.photosAvailable; acceptJob(data.job); S.historyCursor = data.historyCursor; S.jobCosts = data.features?.jobCosts === true;
      try { await outbox.migrate(sessionStorage, S.user.user, jobId); } catch (error) { message(error.message, true); }
      await refreshOutbox(); await loadPhotoQueue(); renderJob();
      await syncOutbox(); await loadEmployeeJobTime(); await loadManagerLabor();
    } catch (error) {
      if (!error.status && await offlineStart()) return;
      if (error.status !== 401) renderError(error.message); throw error;
    }
  }
  async function refreshJob() {
    const data = await api(`/api/field-jobs?jobId=${encodeURIComponent(jobId)}`);
    S.photosAvailable = data.photosAvailable; acceptJob(data.job); S.historyCursor = data.historyCursor; S.jobCosts = data.features?.jobCosts === true; return data;
  }
  async function loadDay() {
    try {
      const data = await api(`/api/field-jobs?date=${encodeURIComponent(S.date)}&status=${encodeURIComponent(S.filter)}`);
      const next = data.jobs.find(job => !['completed', 'paid', 'invoiced', 'review_requested', 'cancelled'].includes(job.status));
      main.innerHTML = `<div class="toolbar"><div><span class="eyebrow">My assignments · Mountain Time</span><h1>${esc(dateLabel(data.date))}</h1><p>Signed in as ${esc(S.user.displayName || S.user.user)}</p></div><button data-action="reload">Refresh</button></div><div class="card"><div class="detail-grid"><div class="field"><label for="day-date">Date</label><input type="date" id="day-date" value="${esc(S.date)}"></div><div class="field"><label for="day-filter">Jobs</label><select id="day-filter">${[['all', 'All assigned'], ['active', 'Active'], ['completed', 'Completed'], ['cancelled', 'Cancelled']].map(([value, text]) => `<option value="${value}" ${value === S.filter ? 'selected' : ''}>${text}</option>`).join('')}</select></div></div><div class="actions"><button data-action="today">Today</button><button data-action="tomorrow">Tomorrow</button></div></div>${data.jobs.length ? data.jobs.map(job => `<a class="card day-job" href="/crew/job.html?jobId=${encodeURIComponent(job.id)}"><div class="section-heading"><span class="badge ${job.status === 'completed' ? 'done' : ''}">${esc(label(job.fieldStatus))}</span>${job === next ? '<span class="next">Next active job →</span>' : ''}</div><h2>${esc(job.customer || 'Customer pending')}</h2><strong>${esc(timeLabel(job.time))}–${esc(timeLabel(job.endTime))}${job.endDate !== job.date ? ` · through ${esc(dateLabel(job.endDate))}` : ''}</strong><p>${esc(job.address || 'Address missing — contact operations')}</p><p>${esc(job.serviceType)} · ${esc(job.crewMembers.map(member => member.name).join(', ') || 'Crew pending')}</p><small>${job.vehicleName ? `Vehicle: ${esc(job.vehicleName)}` : job.vehicleId ? `Vehicle: ${esc(job.vehicleId)}` : 'Vehicle not assigned'}</small></a>`).join('') : '<section class="card"><h2>No assignments for this view</h2><p>Change the date or filter, or check with operations. Only jobs assigned to your employee account appear here.</p></section>'}<p class="offline-stamp">Updated ${esc(stamp(data.generatedAt))} Mountain Time</p>`;
      await refreshOutbox();
      if (waiting() && !offline()) await syncOutbox();
    } catch (error) { if (!error.status && await offlineStart()) return; if (error.status !== 401) renderError(error.message); }
  }
  function block(title, text) { return text ? `<div class="scope-block"><h3>${esc(title)}</h3><div class="text-block">${esc(text)}</div></div>` : ''; }
  function pendingCard() { return (S.actionError ? `<section class="card notice error" role="alert"><strong>${esc(S.actionError.message)}</strong>${S.actionError.missing?.length ? `<ul>${S.actionError.missing.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}</section>` : '') + '<div id="outbox-card"></div>'; }
  const statusText = status => ({ dispatched: 'Mark en route', arrived: 'Mark arrived', in_progress: 'Start or resume work', paused: 'Pause work', waiting: 'Waiting', delayed: 'Report delay' })[status] || label(status);
  function describe(item) {
    const input = item.payload;
    if (item.kind === 'clock') return ({ clock_in: 'Clock in', break_start: 'Start break', break_end: 'End break', clock_out: 'Clock out' })[input.op] || (input.jobAction?.kind === 'general' ? 'End my job time' : `Start my ${label(input.jobAction?.kind)} time`);
    if (input.action === 'checklist') return `${input.completed ? 'Check' : 'Reopen'}: ${S.job?.checklist.find(row => row.id === input.itemId)?.label || 'checklist item'}`;
    if (input.action === 'material') return `${S.job?.materials.find(row => row.id === input.materialId)?.name || 'Material'}: ${label(input.state)}`;
    if (input.action === 'note') return `${input.issue ? 'Issue' : 'Note'}: ${input.body}`;
    if (input.action === 'status') return `Status: ${statusText(input.status)}${input.reason ? ` — ${input.reason}` : ''}`;
    return label(input.action).replace(/^./, char => char.toUpperCase());
  }
  // The ordered list of actions saved on this phone, including any the server
  // refused. Refused actions wait for Retry or Discard; nothing is dropped silently.
  function renderOutbox() {
    const host = document.getElementById('outbox-card'); if (!host) return;
    const all = pending(), rows = all.filter(item => item.kind === 'clock' || item.jobId === jobId), elsewhere = all.length - rows.length, errors = rows.filter(item => item.state === 'error'), unconfirmed = rows.some(item => item.attempts);
    host.replaceChildren();
    if (!rows.length) { if (elsewhere) host.append(h('p', { class: 'notice' }, `${elsewhere} saved action${elsewhere === 1 ? '' : 's'} for other jobs ${elsewhere === 1 ? 'is' : 'are'} on this phone and will sync in order.`)); return; }
    const heading = errors.length ? 'Saved action needs review' : S.syncing || S.saving ? 'Saving to the job…' : unconfirmed ? 'Action awaiting confirmation' : `${rows.length} action${rows.length === 1 ? '' : 's'} saved on this phone`;
    const intro = errors.length ? 'The server did not accept the action below. Review the message, then retry it with the same action ID or discard it. Later actions for this job wait behind it.' : S.syncing || S.saving ? 'Each action keeps its ID, so nothing is saved twice.' : offline() ? 'You are offline. These sync in order when you reconnect. Each keeps its action ID, so nothing is saved twice.' : 'These have not been confirmed by the server yet. They retry automatically with the same action ID, so nothing is saved twice.';
    const list = h('ul', { class: 'outbox-list' }, rows.map(item => h('li', {}, h('strong', {}, describe(item)), h('small', {}, `Saved ${stamp(item.queuedAt)}${item.state === 'error' ? ' · not accepted' : item.attempts ? ' · not confirmed yet' : ' · waiting to sync'}`), item.state === 'error' ? [h('p', { class: 'outbox-error', role: 'alert' }, item.error?.message || 'This action was not accepted.'), item.error?.missing?.length ? h('ul', {}, item.error.missing.map(text => h('li', {}, text))) : null, h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', 'data-action': 'outbox-retry', 'data-request': item.requestId, disabled: S.busy || offline() }, 'Refresh and retry'), h('button', { type: 'button', 'data-action': 'outbox-discard', 'data-request': item.requestId, disabled: S.busy }, 'Discard this action'))] : null)));
    host.append(h('section', { class: 'card pending-action', 'aria-live': 'polite' }, h('h2', {}, heading), h('p', {}, intro), list, elsewhere ? h('p', { class: 'muted' }, `${elsewhere} more for other jobs will sync too.`) : null, !errors.length && !S.syncing && !offline() ? h('div', { class: 'actions' }, h('button', { type: 'button', 'data-action': 'outbox-sync', disabled: S.busy }, 'Sync now')) : null));
  }
  function renderJob() {
    const j = Outbox.projectJob(S.job, pending()); if (!j) return;
    const completed = j.checklist.filter(item => item.completed).length;
    const required = j.checklist.filter(item => item.required && !item.completed).length;
    const lead = j.crewMembers.find(member => member.id.toLowerCase() === j.crewLead.toLowerCase());
    const disabled = S.busy || S.uploadBusy;
    main.innerHTML = `<div class="toolbar"><a class="button" href="/crew/job.html">← My day</a><button data-action="reload" ${S.busy || S.uploadBusy ? 'disabled' : ''}>Refresh job</button></div><span class="eyebrow">${esc(j.serviceType || 'Garage service')} · Job ${esc(j.id)}</span><h1>${esc(j.customer || 'Customer name pending')}</h1><div class="section-heading"><span class="badge ${j.completedAt ? 'done' : ['delayed', 'paused', 'waiting', 'cancelled'].includes(j.fieldStatus) ? 'alert' : ''}">${esc(label(j.fieldStatus))}</span>${j.statusQueued ? '<span class="badge queued">Waiting to sync</span>' : ''}<small>All times Mountain</small></div>${pendingCard()}${S.offline ? '<p class="notice">Offline: showing the last copy of this job confirmed in this tab. Other crew changes appear when you reconnect.</p>' : ''}${!j.address ? '<p class="notice">This job is missing its address. Contact operations before leaving.</p>' : ''}<section class="card"><h2>${esc(dateLabel(j.date))}</h2><p><strong>${esc(timeLabel(j.time))}–${esc(timeLabel(j.endTime))}${j.endDate !== j.date ? ` · through ${esc(dateLabel(j.endDate))}` : ''}</strong>${j.arrivalWindow ? `<br>Arrival window: ${esc(j.arrivalWindow)}` : ''}</p><p>${esc(j.address || 'Address pending')}</p><div class="actions">${j.address ? `<a class="button primary" href="${directions(j.address)}" target="_blank" rel="noopener">Navigate to job ↗</a>` : ''}${j.phone ? `<a class="button" href="tel:${esc(j.phone.replace(/[^+0-9]/g, ''))}">Call customer</a>` : ''}</div><dl class="detail-grid"><div><dt>Crew</dt><dd>${esc(j.crewMembers.map(member => member.name).join(', ') || 'Not assigned')}</dd></div><div><dt>Crew lead</dt><dd>${esc(lead?.name || j.crewLead || 'Not designated')}</dd></div><div><dt>Vehicle</dt><dd>${esc(j.vehicleName || j.vehicleId || 'Not assigned')}</dd></div><div><dt>Equipment</dt><dd>${esc(j.requiredEquipment.join(', ') || 'No equipment list recorded')}</dd></div></dl>${j.canEdit ? `<div class="actions">${j.allowedStatuses.filter(status => status !== j.fieldStatus).map(status => `<button class="${['dispatched', 'arrived', 'in_progress'].includes(status) ? 'primary' : ''}" data-action="status" data-status="${status}" ${disabled ? 'disabled' : ''}>${esc(({ dispatched: 'Mark en route', arrived: 'Mark arrived', in_progress: j.startedAt ? 'Resume work' : 'Start work', paused: 'Pause work', waiting: 'Waiting', delayed: 'Report delay' })[status] || label(status))}</button>`).join('')}</div><div id="status-reason"></div>` : ''}</section><div class="grid"><div><section class="card"><h2>Scope & instructions</h2>${block('Work to complete', j.scope) || '<p class="notice">No operational scope has been recorded. Confirm the scope with operations before starting.</p>'}${block('Customer goal', j.customerGoal)}${block('Customer instructions', j.customerInstructions)}${block('Access', [...j.access, j.accessInstructions].filter(Boolean).join('\n'))}${block('Keep and protect', j.keepItems)}${block('Remove', j.removeItems)}${block('Exclusions', j.exclusions)}${block('Hazards', j.hazards.join('\n'))}${block('Truck placement', j.truckPlacement)}</section><section class="card" id="checklist-card"><div class="section-heading"><h2>Job checklist</h2><span class="badge">${completed}/${j.checklist.length}</span></div><p>${required ? `${required} required items remaining.` : 'All required checks are complete.'} Changes save to this job for the entire crew.</p>${[['departure', 'Before departure'], ['arrival', 'At arrival'], ['work', 'Work execution'], ['finish', 'Finish & customer walkthrough']].map(([stage, name]) => `<div class="check-group"><h3>${name}</h3>${j.checklist.filter(item => item.stage === stage).map(item => `<label class="check"><input type="checkbox" data-check="${esc(item.id)}" ${item.completed ? 'checked' : ''} ${!j.canEdit || disabled ? 'disabled' : ''}><span class="check-label">${esc(item.label)}${!item.required ? ' <small>Optional</small>' : ''}${item.detail ? `<small>${esc(item.detail)}</small>` : ''}${item.queued ? '<small class="queued-tag">Saved on this phone · waiting to sync</small>' : item.completed ? `<small>Saved by ${esc(item.completedBy || 'crew')} · ${esc(stamp(item.completedAt))}</small>` : ''}</span></label>`).join('')}</div>`).join('')}${checklistEditor()}</section>${j.materials.length ? `<section class="card"><h2>Materials</h2>${j.materials.map(item => `<div class="material"><div><strong>${esc(item.name)}</strong>${item.quantity != null ? `<br><small>Quantity: ${esc(item.quantity)}</small>` : ''}${item.queued ? '<small class="queued-tag">Waiting to sync</small>' : ''}</div><select aria-label="${esc(item.name)} state" data-material="${esc(item.id)}" ${!j.canEdit || disabled ? 'disabled' : ''}>${['required', 'loaded', 'used', 'missing'].map(state => `<option value="${state}" ${state === item.state ? 'selected' : ''}>${label(state)}</option>`).join('')}</select></div>`).join('')}</section>` : ''}</div><div><section class="card" id="photos-card"><div class="section-heading"><h2>Job photos</h2><span class="badge">${j.photos.length} verified</span></div><p>Before, progress, after, and problem photos stay with this job.</p><div class="photo-grid">${S.offline ? '' : j.photos.map(photo => `<button class="photo-tile" data-action="view-photo" data-photo="${photo.id}"><img src="${esc(photo.url)}" alt="${esc(photo.caption || `${photo.category} photo`)}" loading="lazy"><span>${esc(label(photo.category))}${photo.caption ? ` · ${esc(photo.caption)}` : ''}</span></button>`).join('')}</div>${!j.photos.length ? '<p class="empty">No verified field photos yet.</p>' : ''}${j.status !== 'cancelled' ? photoForm() : ''}<div id="photo-queue">${queueMarkup()}</div></section><section class="card"><h2>Crew notes & issues</h2><p>Notes are timestamped and shared with this job’s assigned crew and managers.</p>${issueMarkup()}<form id="note-form"><div class="field"><label for="note-body">Add a note</label><textarea id="note-body" data-draft="note" maxlength="4000" required placeholder="What should the crew or dispatcher know?">${esc(getDraft('note'))}</textarea></div><label class="check"><input type="checkbox" id="note-issue" ${getDraft('noteIssue') === 'yes' ? 'checked' : ''}><span>Flag an issue needing operations follow-up</span></label>${j.canAddManagementNote ? `<label class="check"><input type="checkbox" id="note-private" ${getDraft('notePrivate') === 'yes' ? 'checked' : ''}><span>Management only</span></label>` : ''}<button class="primary" type="submit" ${disabled ? 'disabled' : ''}>Save note</button></form></section><section class="card" id="history-card"><div class="section-heading"><h2>Job history</h2><span class="eyebrow">Server records</span></div>${historyMarkup(j.history)}${S.historyCursor ? '<button data-action="history-more">Load earlier history</button>' : ''}</section></div><section class="card full" id="complete-card">${completionMarkup()}</section></div><p class="offline-stamp">Showing the last confirmed server record. Refresh to see changes made by other crew members.</p>`;
    mountJobSections();
  }
  function mountJobSections() {
    renderOutbox();
    const timeCard = document.createElement('section'); timeCard.className = 'card'; timeCard.id = 'job-time'; main.querySelector('.grid').insertAdjacentElement('beforebegin', timeCard); renderJobTime();
    const employeeTime = document.createElement('section'); employeeTime.className = 'card'; employeeTime.id = 'employee-job-time'; timeCard.insertAdjacentElement('afterend', employeeTime); renderEmployeeJobTime();
    if (S.job.canAddManagementNote) { const labor = document.createElement('section'); labor.className = 'card'; labor.id = 'manager-job-labor'; employeeTime.insertAdjacentElement('afterend', labor); renderManagerLabor(); }
    const scope = [...main.querySelectorAll('h2')].find(heading => heading.textContent === 'Scope & instructions'); if (scope) scope.closest('.card').id = 'scope-card';
    const notes = [...main.querySelectorAll('h2')].find(heading => heading.textContent === 'Crew notes & issues'); if (notes) notes.closest('.card').id = 'notes-card';
    // Job costs mount only when the server reports the feature on, so a disabled flag adds no card and no request.
    if (S.jobCosts && window.EGCFieldExpenses) { const costs = document.createElement('section'); costs.className = 'card'; costs.id = 'field-expenses-card'; document.getElementById('photos-card').insertAdjacentElement('afterend', costs); window.EGCFieldExpenses.mount(costs, { jobId, user: S.user.user, manager: S.job.canAddManagementNote === true }); }
    const nav = document.createElement('nav'); nav.className = 'job-sections'; nav.setAttribute('aria-label', 'Job sections'); nav.innerHTML = [['scope-card', 'Scope'], ['checklist-card', 'Checklist'], ['photos-card', 'Photos'], ['notes-card', 'Notes'], ['complete-card', 'Complete']].map(([id, text]) => `<a href="#${id}">${text}</a>`).join(''); main.querySelector('h1').insertAdjacentElement('afterend', nav);
    if (S.job.statusReason) { const reason = document.createElement('p'); reason.className = 'notice'; reason.textContent = `${label(S.job.fieldStatus)}: ${S.job.statusReason}`; nav.insertAdjacentElement('afterend', reason); }
    const history = document.getElementById('history-card'), entries = [...history.querySelectorAll('.history-item')];
    if (entries.length > 5) { const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = `Earlier history · ${entries.length - 5} loaded items`; details.append(summary); entries.slice(5).forEach(entry => details.append(entry)); details.open = S.historyExpanded === true; details.addEventListener('toggle', () => { S.historyExpanded = details.open; }); history.append(details); }
  }
  function checklistEditor() {
    if (!S.job.canManageChecklist) return '';
    const rows = S.job.checklist.filter(item => !item.id.startsWith('client-')).map(item => `${item.stage} | ${item.required ? 'required' : 'optional'} | ${item.label}`).join('\n');
    return `<details><summary>Manager: configure this job’s checklist</summary><p>One item per line: stage | required or optional | task. Stages: departure, arrival, work, finish. Changing a task clears its previous check. Existing customer-specific checks are preserved.</p><form id="checklist-config"><div class="field"><label for="checklist-lines">Job checklist</label><textarea id="checklist-lines" rows="10">${esc(rows)}</textarea></div><button type="submit" ${jobQueued() || S.busy ? 'disabled' : ''}>Save checklist</button></form></details>`;
  }
  function issueMarkup() {
    const issue = S.job.attention;
    if (!issue) return '';
    return `<aside class="notice" id="job-issue"><h3>${issue.status === 'resolved' ? 'Issue resolved' : 'Operations follow-up needed'}</h3><p class="text-block">${esc(issue.reason)}</p><small>Reported by ${esc(issue.reportedBy || 'crew')} · ${esc(stamp(issue.reportedAt))}${issue.visibility === 'management' ? ' · Management only' : ''}</small>${issue.status === 'resolved' ? `<p class="text-block">${esc(issue.resolution)}</p><small>Resolved by ${esc(issue.resolvedBy)} · ${esc(stamp(issue.resolvedAt))}</small>` : ''}${issue.canResolve ? `<form id="resolve-issue-form"><div class="field"><label for="issue-resolution">Resolution & follow-up</label><textarea id="issue-resolution" data-draft="resolution" minlength="10" maxlength="4000" required placeholder="Describe what was done and any customer follow-up.">${esc(getDraft('resolution'))}</textarea></div><button type="submit" ${jobQueued() || S.busy || S.uploadBusy ? 'disabled' : ''}>Resolve issue</button><p class="muted">The original report and your resolution remain in the job history.</p></form>` : ''}</aside>`;
  }
  function photoForm() {
    if (!S.photosAvailable) return '<p class="notice error">Photo storage is unavailable. Contact operations; no upload will be reported as saved.</p>';
    return `<details open><summary>Add photos</summary><div class="field"><label for="photo-category">Photo category</label><select id="photo-category">${['before', 'progress', 'after', 'damage'].map(category => `<option value="${category}">${label(category)}</option>`).join('')}</select></div><div class="field"><label for="photo-caption">Caption (optional)</label><input id="photo-caption" maxlength="500" placeholder="Area, item or issue shown"></div><div class="field"><label for="photo-camera">Take a photo</label><input id="photo-camera" type="file" accept="image/*" capture="environment"></div><div class="field"><label for="photo-library">Choose photos from library</label><input id="photo-library" type="file" accept="image/*" multiple></div><small>Photos are resized before upload. A photo counts only after the server verifies and saves it. Up to 8 photos per selection.</small></details>`;
  }
  function historyMarkup(events) { return events.length ? events.map(event => `<article class="history-item"><strong>${esc(event.summary || label(event.action))}</strong><small>${esc(event.actorName || event.actorId)} · ${esc(stamp(event.createdAt))}${event.visibility === 'management' ? ' · Management only' : ''}</small>${event.body ? `<p class="text-block">${esc(event.body)}</p>` : ''}</article>`).join('') : '<p class="empty">No field activity recorded yet.</p>'; }
  function completionMarkup() {
    const j = S.job;
    if (j.completion) return `<span class="badge done">Work completed</span><h2>Saved ${esc(stamp(j.completion.completedAt))}</h2><p>Completed by ${esc(j.completion.completedBy)}.</p><p class="text-block">${esc(j.completion.notes)}</p>${j.completion.hasIssues ? `<p class="notice">Follow-up reported at completion: ${esc(j.completion.issueNotes)}</p>` : ''}<p class="muted">Work completion does not mark an invoice paid. Payment remains in the existing payment workflow.</p>${j.completionSync ? `<div class="${j.completionSync.status === 'synced' ? 'empty' : 'notice'}"><strong>Internal completion handoff: ${esc(j.completionSync.status)}</strong><p>${esc(j.completionSync.message)}</p>${j.completionSync.canRetry ? `<button data-action="retry-completion-sync" ${jobQueued() || S.busy ? 'disabled' : ''}>Retry internal handoff</button>` : ''}</div>` : ''}<div class="actions"><a class="button primary" href="/crew/job.html">Open my next job</a></div>`;
    if (!j.canEdit) return `<h2>${esc(label(j.status))}</h2><p>This job’s execution record is closed. Existing evidence and history remain available.</p>`;
    return `<h2>Complete the job</h2><p>Check the work, save before and after photos, and record the actual services performed. Completion records your account and the server timestamp.</p>${j.completionMissing.length ? `<details open><summary>Required before completion</summary><ul class="completion-missing">${j.completionMissing.map(item => `<li>${esc(item)}</li>`).join('')}</ul></details>` : ''}<form id="completion-form"><div class="field"><label for="completion-notes">Completion notes</label><textarea id="completion-notes" data-draft="completion" minlength="10" maxlength="4000" required placeholder="Describe the services completed, customer walkthrough, and anything that changed.">${esc(getDraft('completion'))}</textarea></div><div class="field"><label for="completion-issues">Does anything need follow-up?</label><select id="completion-issues" required><option value="">Choose an answer</option><option value="no" ${getDraft('hasIssues') === 'no' ? 'selected' : ''}>No issues or damage to report</option><option value="yes" ${getDraft('hasIssues') === 'yes' ? 'selected' : ''}>Yes — issue, damage, or follow-up needed</option></select></div><div class="field"><label for="issue-notes">Issue details (required if yes)</label><textarea id="issue-notes" data-draft="issueNotes" maxlength="4000" placeholder="Describe the issue, customer impact, and next step.">${esc(getDraft('issueNotes'))}</textarea></div><button class="primary" type="submit" ${completionBlocked() ? 'disabled' : ''}>Review & complete job</button><p class="muted">All queued photos must finish uploading and saved actions must sync first. Completing needs a connection.</p><div id="completion-error" role="alert"></div></form>`;
  }
  const completionBlocked = () => S.busy || S.uploadBusy || offline() || jobQueued() || S.queue.some(photo => photo.state !== 'saved');
  // Every field action is written to the outbox before it is sent. A first
  // attempt uses the version the crew member saw; later replays refresh it.
  async function submitAction(payload) {
    if (S.busy || S.uploadBusy || !S.job || !S.user) return;
    if (offline() && !Outbox.QUEUEABLE.includes(payload.action)) return message('Reconnect to finish this. Checklist, material, note and status updates can be saved on this phone while offline.', true);
    // Controls lock at once, before the action is stored, so a second tap cannot race it.
    const input = { ...payload, jobId, requestId: crypto.randomUUID(), expectedRevision: S.job.expectedRevision, expectedUser: S.user.user };
    const item = { requestId: input.requestId, kind: 'field', user: S.user.user, jobId, payload: input };
    S.actionError = null; S.busy = true; S.saving = { ...item, queuedAt: new Date().toISOString(), attempts: 0, state: 'queued' }; renderJob();
    let queued;
    try { queued = await outbox.enqueue(item); }
    catch (error) { S.busy = false; S.saving = null; renderJob(); return message(error.message, true); }
    if (input.action === 'note' && outbox.persistent) ['note', 'noteIssue', 'notePrivate'].forEach(suffix => setDraft(suffix, ''));
    await refreshOutbox(); S.busy = false; S.saving = null;
    if (offline()) { renderJob(); requestBackgroundSync(); return message('Saved on this phone. It will sync in order when you reconnect.'); }
    await syncOutbox({ direct: queued.direct ? input.requestId : '' });
  }
  function appliedMessage(applied) {
    if (applied.length !== 1) return `${applied.length} saved actions are now confirmed.`;
    const [{ item, data, direct }] = applied;
    if (item.kind === 'clock') return ({ clock_in: 'Clocked in. Your shift has started. Shift location updates while the Employee Hub is open.', break_start: 'Break started.', break_end: 'Break ended.', clock_out: 'Clocked out. Your shift is submitted for approval.' })[item.payload.op] || 'Your job time is saved. Previous segments and your shift remain intact.';
    if (item.payload.action === 'retry_completion_sync' && S.job) return S.job.completionSync?.message || 'Internal handoff checked.';
    return data?.alreadyApplied ? 'This action was already saved. The current job is shown.' : direct ? 'Saved to the job.' : 'Your saved action is now confirmed on the job.';
  }
  async function syncOutbox({ direct = '', retry = [] } = {}) {
    if (!S.user || S.offline || S.syncing || !direct && !retry.length && !waiting()) return null;
    const user = S.user.user; let clock = false, result;
    S.syncing = true; S.busy = true; if (S.job) renderJob();
    try {
      result = await outbox.flush({ user, transport, direct, retry, onApplied(item, data) {
        if (item.kind === 'clock') { clock = true; return; }
        if (item.jobId !== jobId || S.user?.user !== user) return;
        if (data?.job) { if (typeof data.photosAvailable === 'boolean') S.photosAvailable = data.photosAvailable; acceptJob(data.job); S.historyCursor = data.historyCursor; }
        if (item.payload.action === 'note' && !outbox.persistent) ['note', 'noteIssue', 'notePrivate'].forEach(suffix => setDraft(suffix, ''));
        if (item.payload.action === 'resolve_issue') setDraft('resolution', '');
        if (item.payload.action === 'complete') ['completion', 'issueNotes', 'hasIssues'].forEach(suffix => setDraft(suffix, ''));
      } });
    } catch (error) { result = { applied: [], remaining: S.outbox.length, stopped: { error, reason: 'network' } }; }
    finally { S.syncing = false; S.busy = false; }
    if (S.user?.user !== user) return result;
    await refreshOutbox();
    const stop = result.stopped;
    if (stop?.reason === 'auth') { S.job = null; forgetSnapshots(); renderLogin(stop.error.message); return result; }
    if (stop?.reason === 'rejected' && stop.item.kind === 'field' && stop.item.jobId === jobId && [403, 404].includes(stop.error.status)) { S.job = null; renderError(stop.error.message); return result; }
    if (clock) { await loadEmployeeJobTime(); try { if (S.job) await refreshJob(); } catch { /* The job refreshes on the next action. */ } }
    if (stop?.reason === 'rejected') {
      if (stop.discarded && stop.item.kind === 'clock') S.shiftError = stop.error.message;
      else if (stop.discarded) {
        S.actionError = { message: stop.error.message, missing: stop.error.missing };
        if (stop.item.payload.action === 'note' && stop.item.jobId === jobId && !getDraft('note')) setDraft('note', stop.item.payload.body);
      }
      message(stop.error.message, true);
    } else if (stop) { requestBackgroundSync(); message(stop.item && stop.item.requestId === direct ? 'The server did not confirm this action. It is saved on this phone and will retry with the same action ID.' : 'Saved actions are waiting for the connection. They will retry automatically.', true); }
    else if (result.applied.length) message(appliedMessage(result.applied), result.applied.length === 1 && result.applied[0].item.payload.action === 'retry_completion_sync' && S.job?.completionSync?.status !== 'synced');
    if (S.workerApplied) await workerChanged();
    if (S.job) renderJob();
    return result;
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
    return S.queue.length ? `<div class="photo-queue"><h3>Photo drafts on this device</h3>${S.queue.map(photo => `<div class="queue-item"><img src="${photo.dataUrl}" alt="Photo draft"><div><strong>${esc(label(photo.category))}</strong><small>${photo.state === 'uploading' ? 'Uploading and verifying…' : photo.state === 'saved' ? 'Verified and saved' : photo.error ? esc(photo.error) : photo.persisted ? 'Saved on this device; awaiting upload' : 'Draft is only on this page; keep it open'}</small><div class="actions">${photo.state !== 'saved' ? `<button data-action="retry-photo" data-photo="${photo.id}" ${S.uploadBusy || S.busy ? 'disabled' : ''}>${photo.error ? 'Retry photo' : 'Upload photo'}</button>` : ''}<button data-action="remove-photo" data-photo="${photo.id}" ${S.uploadBusy ? 'disabled' : ''}>${photo.state === 'saved' ? 'Clear draft' : 'Discard draft'}</button></div></div></div>`).join('')}<button class="primary" data-action="upload-all" ${S.uploadBusy || S.busy ? 'disabled' : ''}>Upload all ready photos</button></div>` : '';
  }
  function renderQueue() { const host = document.getElementById('photo-queue'); if (host) host.innerHTML = queueMarkup(); const submit = document.querySelector('#completion-form button[type=submit]'); if (submit) submit.disabled = completionBlocked(); }
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
    renderQueue(); if (S.queue.length) message(offline() ? 'Photo drafts are saved on this phone. Upload them when you are connected.' : 'Photo drafts are ready. Tap Upload to save them to the job.');
  }
  async function uploadPhotos(ids) {
    if (S.uploadBusy || S.busy || !S.job) return;
    if (offline()) return message('Photos upload when you are connected. The drafts stay on this phone.', true);
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
      try { acceptViewer(await api('/api/hub-auth', { username: form.username.value, password: form.password.value })); signedIn = true; await load(); } catch (error) { if (!signedIn) renderLogin(error.message); } finally { button.disabled = false; }
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
      if (action === 'reload') { button.disabled = true; await (S.user && !S.offline && !S.initFailed ? load() : initialize()); }
      else if (action === 'shift-time') await clockAction('job_time', button.dataset.kind);
      else if (action === 'clock-in') await clockAction('clock_in');
      else if (action === 'break-start') await clockAction('break_start');
      else if (action === 'break-end') await clockAction('break_end');
      else if (action === 'clock-out') await clockAction('clock_out');
      else if (action === 'refresh-shift-time') await loadEmployeeJobTime();
      else if (action === 'refresh-manager-labor') await loadManagerLabor();
      else if (action === 'today' || action === 'tomorrow') { const date = new Date(`${mountainDate()}T12:00:00Z`); if (action === 'tomorrow') date.setUTCDate(date.getUTCDate() + 1); S.date = date.toISOString().slice(0, 10); await loadDay(); }
      else if (action === 'outbox-sync') await syncOutbox();
      else if (action === 'outbox-retry') { S.actionError = null; await syncOutbox({ retry: [button.dataset.request] }); }
      else if (action === 'outbox-discard') {
        const item = S.outbox.find(row => row.requestId === button.dataset.request);
        if (!item || item.state !== 'error' || !window.confirm(`Discard “${describe(item).slice(0, 120)}”? It was not saved to the job.`)) return;
        await outbox.remove(item.requestId);
        if (item.kind === 'field' && item.payload.action === 'note' && item.jobId === jobId && !getDraft('note')) setDraft('note', item.payload.body);
        await refreshOutbox(); renderJob(); message('Discarded. Any later saved actions sync next.');
        if (waiting() && !offline()) await syncOutbox();
      } else if (action === 'outbox-discard-job') {
        if (!window.confirm('Discard the saved actions for this job? They were not saved to it.')) return;
        for (const item of S.outbox.filter(row => row.kind === 'field' && row.jobId === jobId)) await outbox.remove(item.requestId);
        await refreshOutbox(); renderError(S.errorText);
      }
      else if (action === 'retry-completion-sync') await submitAction({ action: 'retry_completion_sync' });
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
  window.addEventListener('online', async () => { connection(); if (S.offline || S.initFailed) await initialize(); else if (S.user) { await syncOutbox(); if (S.job) renderJob(); } });
  window.addEventListener('offline', () => { connection(); if (S.job) renderJob(); });
  // A connection can return without an 'online' event (captive portals, weak
  // signal), and iOS has no Background Sync, so an offline start re-checks.
  let reconnectCheckedAt = 0;
  async function resume() {
    if (!navigator.onLine) return;
    if (!S.offline && !S.initFailed) { if (S.user && waiting()) syncOutbox(); return; }
    if (S.busy || S.initializing || Date.now() - reconnectCheckedAt < 30000) return;
    reconnectCheckedAt = Date.now();
    // A quiet probe first, so a connection that is still down never redraws the page.
    try { const response = await fetch('/api/hub-auth', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000) }); if (response.status >= 500) return; } catch { return; }
    await initialize();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resume(); });
  // Background Sync may confirm actions while this page is busy; the job is
  // refreshed once the page's own sync finishes, so its next action is current.
  async function workerChanged() {
    const applied = S.workerApplied; S.workerApplied = 0;
    await refreshOutbox();
    if (applied && S.job) { try { await refreshJob(); } catch { /* The next action refreshes the job. */ } await loadEmployeeJobTime(); }
  }
  navigator.serviceWorker?.addEventListener('message', async event => {
    if (event.data?.type !== 'egc-field-outbox-changed' || !S.user || S.offline) return;
    S.workerApplied = (S.workerApplied || 0) + (Number(event.data.applied) || 0);
    if (S.busy) return;
    await workerChanged();
    if (S.job) renderJob();
  });
  window.addEventListener('storage', event => {
    if (event.key !== signedOutKey || !S.user) return;
    forgetSnapshots(); S.user = null; S.job = null; S.outbox = []; connection(); renderLogin('You signed out. Sign in again to open your work.');
  });
  setInterval(renderJobTime, 1000); setInterval(refreshJobTime, 30000);
  setInterval(resume, 45000);
  window.addEventListener('beforeunload', event => { if (S.busy || S.uploadBusy || S.queue.some(photo => !photo.persisted && photo.state !== 'saved') || !outbox.persistent && S.outbox.length) { event.preventDefault(); event.returnValue = ''; } });
  initialize();
})();
