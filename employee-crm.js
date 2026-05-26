/**
 * Easy Garage Cleaning — Jobber-style CRM layer
 * Extends employee.html (Firebase Firestore + existing calendar/leads/on-call)
 *
 * FUTURE: Web3forms → Zapier → POST webhook → importLeadFromWebhook(payload)
 */
(function () {
  'use strict';

  const SESSION_MS = 30 * 60 * 1000;
  const IDB_NAME = 'egc_crm_v1';
  const IDB_STORE = 'snapshots';
  const LS_PREFS = 'egc_crm_prefs';
  const LS_BACKUP_META = 'egc_crm_last_backup';

  const PIPELINE = [
    { id: 'lead', label: 'Lead', color: '#94a3b8' },
    { id: 'quoted', label: 'Quoted', color: '#60a5fa' },
    { id: 'scheduled', label: 'Scheduled', color: '#a78bfa' },
    { id: 'in_progress', label: 'In Progress', color: '#f59e0b' },
    { id: 'completed', label: 'Completed', color: '#fcd34d' },
    { id: 'paid', label: 'Paid', color: '#22c55e' },
  ];

  // Firestore `leads` doc ID: Facebook leads use FB lead ID; website/manual may use E.164 phone or auto ID. Ghost phone-keyed docs from Zap 2A are auto-merged.
  const LEAD_STATUSES = ['new', 'quoted', 'booked', 'dead', 'no_answer_6_attempts'];
  const LEAD_STATUS_FILTER = ['new', 'quoted', 'booked', 'dead'];
  const LEGACY_STATUS_MAP = {
    contacted: 'new',
    converted: 'booked',
    scheduled: 'booked',
    lost: 'dead',
  };
  const LEAD_STATUS_LABELS = {
    new: 'New',
    quoted: 'Quoted',
    booked: 'Booked',
    dead: 'Dead',
    no_answer_6_attempts: 'No Answer (6×)',
    contacted: 'Contacted',
    converted: 'Booked',
    scheduled: 'Booked',
    lost: 'Dead',
  };
  const ZAP_AUTOMATION = [
    { id: 1, title: 'Facebook Lead Intake', desc: 'New lead → Firestore status=new, Quo welcome SMS, alert Zac/Tyler.' },
    { id: '2A', title: 'Inbound SMS', desc: 'Sets conversationActive=true and lastTouchAt.' },
    { id: '2B', title: 'Outbound SMS', desc: 'Sets conversationActive=true and lastOutboundAt.' },
    { id: 3, title: 'STOP (TCPA)', desc: 'Sets optedOutAt — never message again.' },
    { id: 4, title: 'No-Answer Cadence', desc: 'Hourly 9am–6pm MT: contactAttempts 0–5, then dead/no_answer_6_attempts.' },
    { id: 5, title: 'Quote Follow-Up', desc: 'Runs when status=quoted.' },
    { id: 6, title: 'Booking Confirmation', desc: 'Runs when status=booked.' },
    { id: 7, title: 'Review Request', desc: 'After job complete — Quo sends GBP review link.' },
    { id: 8, title: 'Daily Digest', desc: '9pm MT summary to Zac/Tyler.' },
  ];
  const LEAD_ASSIGNEES = [
    { id: 'Tyler', label: 'Tyler', aliases: ['Tyler', 'TylerG'] },
    { id: 'Zac', label: 'Zac', aliases: ['Zac', 'ZacB'] },
  ];
  const QUOTE_STATUSES = ['draft', 'sent', 'approved', 'declined'];
  const PAY_METHODS = ['cash', 'card', 'check'];
  const CREW = ['ZacB', 'TylerG', 'Both'];
  const SOURCES = ['website', 'phone', 'text', 'referral', 'other'];

  const PRICE_TIERS = [
    { label: 'Single item ($99–150)', low: 99, high: 150 },
    { label: 'Small cleanout — half garage+ ($300–400)', low: 300, high: 400 },
    { label: 'Medium garage ($400–650)', low: 400, high: 650 },
    { label: 'Large / estate ($650+)', low: 650, high: 950 },
  ];

  let prefs = loadPrefs();
  let _idleTimer = null;
  let _notifTimer = null;
  let pipelineFilter = 'all';
  let custSearchQ = '';
  let _detailJobId = null;
  let _detailCustId = null;
  let _detailLeadId = null;
  const _mergedGhosts = new Set();

  async function mergeGhostLeads() {
    if (typeof leadsCache === 'undefined' || !leadsCache.length || typeof db === 'undefined') return;
    const meaningfulFields = ['name', 'email', 'source', 'status', 'crmStatus', 'items', 'assignedTo', 'createdAt'];
    const ghosts = leadsCache.filter(l => {
      if (_mergedGhosts.has(l.id)) return false;
      if (meaningfulFields.some(f => l[f])) return false;
      return l.conversationActive !== undefined || l.lastInboundAt || l.lastTouchAt || l.lastOutboundAt;
    });
    for (const ghost of ghosts) {
      _mergedGhosts.add(ghost.id);
      const ghostDigits = String(ghost.id).replace(/\D/g, '');
      if (ghostDigits.length < 10) continue;
      const ghostLast10 = ghostDigits.slice(-10);
      const realLead = leadsCache.find(l => {
        if (l.id === ghost.id) return false;
        const ld = String(l.phone || '').replace(/\D/g, '');
        return ld.length >= 10 && ld.slice(-10) === ghostLast10;
      });
      if (!realLead) continue;
      try {
        const patch = {};
        if (ghost.conversationActive && !realLead.conversationActive) patch.conversationActive = true;
        if (ghost.lastInboundAt && (!realLead.lastInboundAt || ghost.lastInboundAt > realLead.lastInboundAt)) patch.lastInboundAt = ghost.lastInboundAt;
        if (ghost.lastTouchAt && (!realLead.lastTouchAt || ghost.lastTouchAt > realLead.lastTouchAt)) patch.lastTouchAt = ghost.lastTouchAt;
        if (ghost.lastOutboundAt && (!realLead.lastOutboundAt || ghost.lastOutboundAt > realLead.lastOutboundAt)) patch.lastOutboundAt = ghost.lastOutboundAt;
        if (Object.keys(patch).length) {
          await db.collection('leads').doc(realLead.id).set(patch, { merge: true });
        }
        await db.collection('leads').doc(ghost.id).delete();
        console.log('[ghost-merge] Merged ' + ghost.id + ' → ' + realLead.id);
      } catch (e) {
        console.warn('[ghost-merge] Failed for ' + ghost.id + ':', e);
      }
    }
  }

  let leadsFilter = {
    status: 'all',
    source: 'all',
    assignedTo: 'all',
    dateFrom: '',
    dateTo: '',
    search: '',
    optedOutOnly: false,
    conversationActive: false,
    dueFollowUp: false,
  };
  let leadsSort = 'newest';
  let leadsFiltersOpen = false;
  let _leadsLoading = true;
  let _leadsError = null;

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(LS_PREFS) || '{}');
    } catch {
      return {};
    }
  }

  function savePrefs() {
    localStorage.setItem(LS_PREFS, JSON.stringify(prefs));
  }

  /* ── Pipeline status (backward compatible) ─────────── */
  window.getPipelineStatus = function (job) {
    if (!job) return 'lead';
    if (job.pipelineStatus) return job.pipelineStatus;
    if (job.status === 'paid') return 'paid';
    if (job.status === 'completed') return 'completed';
    if (job.status === 'scheduled') return job.date ? 'scheduled' : 'quoted';
    return 'lead';
  };

  window.pipelineLabel = function (id) {
    return PIPELINE.find((p) => p.id === id)?.label || id;
  };

  function leadFlowType(lead) {
    const msg = String(lead?.message || lead?.notes || '');
    const m = msg.match(/Flow:\s*(\w+)/i);
    return m ? m[1].toLowerCase() : '';
  }

  function touchSession() {
    sessionStorage.setItem('egc_exp', String(Date.now() + SESSION_MS));
    resetIdleTimer();
  }

  function resetIdleTimer() {
    if (_idleTimer) clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => {
      if (typeof doLogout === 'function') {
        alert('Session expired for security. Please sign in again.');
        doLogout();
      }
    }, SESSION_MS);
  }

  function checkSessionExpiry() {
    const exp = parseInt(sessionStorage.getItem('egc_exp') || '0', 10);
    if (exp && Date.now() > exp && typeof doLogout === 'function') {
      doLogout();
      return false;
    }
    return true;
  }

  /* ── IndexedDB backup ──────────────────────────────── */
  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        }
      };
    });
  }

  async function saveIdbSnapshot(data) {
    const idb = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put({
        id: 'latest',
        at: new Date().toISOString(),
        data,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function loadIdbSnapshot() {
    try {
      const idb = await openIdb();
      return new Promise((resolve) => {
        const tx = idb.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get('latest');
        req.onsuccess = () => resolve(req.result?.data || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  window.exportCrmBackup = function () {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: typeof me !== 'undefined' ? me : null,
      jobs: typeof jobsCache !== 'undefined' ? jobsCache : [],
      customers: typeof custsCache !== 'undefined' ? custsCache : [],
      leads: typeof leadsCache !== 'undefined' ? leadsCache : [],
      blockedDays: typeof blockedDays !== 'undefined' ? [...blockedDays] : [],
      blockedSlots: typeof blockedSlots !== 'undefined' ? [...blockedSlots] : [],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `egc-crm-backup-${fmtDate(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    localStorage.setItem(LS_BACKUP_META, payload.exportedAt);
    if (typeof showToast === 'function') showToast('Backup downloaded');
    renderMorePanel();
  };

  window.importCrmBackup = function (file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const payload = JSON.parse(reader.result);
        if (!payload.jobs && !payload.customers) throw new Error('Invalid backup');
        if (confirm('Download a backup of current data before importing?')) exportCrmBackup();
        if (!confirm('Import will MERGE records into Firebase (never deletes existing). Continue?')) return;
        const batch = db.batch();
        let n = 0;
        (payload.customers || []).forEach((c) => {
          if (!c.id) return;
          batch.set(db.collection('customers').doc(c.id), c, { merge: true });
          n++;
        });
        (payload.jobs || []).forEach((j) => {
          if (!j.id) return;
          batch.set(db.collection('jobs').doc(j.id), j, { merge: true });
          n++;
        });
        (payload.leads || []).forEach((l) => {
          if (!l.id) return;
          batch.set(db.collection('leads').doc(l.id), l, { merge: true });
          n++;
        });
        await batch.commit();
        (payload.blockedDays || []).forEach((d) =>
          db.collection('blocked_days').doc(d).set({ blockedAt: new Date().toISOString() }, { merge: true })
        );
        (payload.blockedSlots || []).forEach((s) =>
          db.collection('blocked_slots').doc(s).set({ blockedAt: new Date().toISOString() }, { merge: true })
        );
        await saveIdbSnapshot(payload);
        if (typeof showToast === 'function') showToast(`Imported ${n} records`);
      } catch (e) {
        alert('Import failed: ' + (e.message || e));
      }
    };
    reader.readAsText(file);
  };

  async function autoBackupTick() {
    if (!checkSessionExpiry() || typeof jobsCache === 'undefined') return;
    const data = {
      jobs: jobsCache,
      customers: custsCache,
      leads: leadsCache,
      blockedDays: [...blockedDays],
      blockedSlots: [...blockedSlots],
    };
    try {
      await saveIdbSnapshot(data);
      localStorage.setItem(LS_BACKUP_META, new Date().toISOString());
    } catch (e) {
      console.warn('IDB backup', e);
    }
  }

  /* ── Stats helpers ─────────────────────────────────── */
  function weekRange() {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - now.getDay());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start, end };
  }

  function parseJobDate(job) {
    if (!job?.date) return null;
    return new Date(job.date + 'T12:00:00');
  }

  function revenueThisWeek(jobs) {
    const { start, end } = weekRange();
    return jobs
      .filter((j) => getPipelineStatus(j) === 'paid')
      .filter((j) => {
        const d = parseJobDate(j);
        return d && d >= start && d < end;
      })
      .reduce((sum, j) => sum + (Number(j.paidAmount) || Number(j.priceQuoted) || 30), 0);
  }

  function countByPipeline(jobs) {
    const c = {};
    PIPELINE.forEach((p) => (c[p.id] = 0));
    jobs.forEach((j) => {
      const ps = getPipelineStatus(j);
      if (c[ps] !== undefined) c[ps]++;
    });
    return c;
  }

  function todayStr() {
    return fmtDate(new Date());
  }

  /* ── Dashboard ─────────────────────────────────────── */
  let _prevInboxCount = null;

  window.renderDashboard = function () {
    const el = document.getElementById('dash-content');
    if (!el) return;
    const jobs = typeof loadJobs === 'function' ? loadJobs() : [];
    const leads = typeof leadsCache !== 'undefined' ? leadsCache : [];
    const today = todayStr();
    const todayJobs = jobs
      .filter((j) => j.date === today)
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const upcoming = jobs
      .filter((j) => j.date && j.date >= today && getPipelineStatus(j) !== 'paid')
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
      .slice(0, 8);
    const counts = countByPipeline(jobs);
    const rev = revenueThisWeek(jobs);
    const inbox = leads.filter((l) => {
      const st = getLeadStatus(l);
      const raw = getLeadStatusRaw(l);
      return !['booked', 'dead'].includes(st) && raw !== 'no_answer_6_attempts';
    });
    const overdueQuotes = jobs.filter(
      (j) =>
        getPipelineStatus(j) === 'quoted' &&
        j.quoteStatus === 'sent' &&
        j.quoteSentAt &&
        Date.now() - new Date(j.quoteSentAt).getTime() > 2 * 86400000
    );
    const newLeadCount = leads.filter((l) => {
      const raw = getLeadStatusRaw(l);
      return (raw === 'new' || !raw) && !l.optedOutAt;
    }).length;
    // Extract first name from camelCase username ("ZacB" → "Zac", "TylerGriffith" → "Tyler")
    const firstName = ((me || 'team').match(/^[A-Z][a-z]*/) || [me || 'team'])[0];
    const inboxBumped = _prevInboxCount !== null && inbox.length > _prevInboxCount;
    _prevInboxCount = inbox.length;

    el.innerHTML = `
      <div class="dash-greeting">
        <h2>Good ${greetingTime()}, ${esc(firstName)}</h2>
        <p class="dash-sub">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} <span class="dash-live" id="dash-live-indicator" title="Live sync with Firestore">Live</span></p>
      </div>
      <div class="quick-actions">
        <button type="button" class="qa-btn" onclick="openBooking()">+ Job</button>
        <button type="button" class="qa-btn secondary" onclick="openLeadModal()">+ Lead</button>
        <button type="button" class="qa-btn secondary" onclick="switchTab('schedule', document.querySelector('[data-tab=schedule]'))">Block Time</button>
      </div>
      ${newLeadCount > 0 ? `<div class="alert-banner alert-leads" onclick="switchTab('leads', document.querySelector('[data-tab=leads]'))" style="cursor:pointer"><span class="alert-dot"></span><strong>${newLeadCount} new lead${newLeadCount === 1 ? '' : 's'}</strong> waiting on first response <span class="alert-cta">Open inbox →</span></div>` : ''}
      <div class="stats-grid dash-stats">
        <div class="stat tappable" onclick="switchTab('jobs', document.querySelector('[data-tab=jobs]'))"><div class="v" style="color:#60a5fa">${counts.quoted || 0}</div><div class="l">Pending quotes</div></div>
        <div class="stat tappable" onclick="switchTab('schedule', document.querySelector('[data-tab=schedule]'))"><div class="v" style="color:#a78bfa">${counts.scheduled || 0}</div><div class="l">Scheduled</div></div>
        <div class="stat tappable" onclick="switchTab('jobs', document.querySelector('[data-tab=jobs]'))"><div class="v" style="color:#f59e0b">${counts.in_progress || 0}</div><div class="l">In progress</div></div>
        <div class="stat tappable" onclick="switchTab('jobs', document.querySelector('[data-tab=jobs]'))"><div class="v" style="color:#86efac">${counts.completed + counts.paid || 0}</div><div class="l">Done / paid</div></div>
        <div class="stat tappable" onclick="switchTab('leads', document.querySelector('[data-tab=leads]'))"><div class="v ${inboxBumped ? 'count-bump' : ''}" style="color:var(--accent)">${inbox.length}</div><div class="l">Leads inbox</div></div>
        <div class="stat"><div class="v" style="color:#86efac">$${rev.toLocaleString()}</div><div class="l">Revenue this week</div></div>
      </div>
      ${overdueQuotes.length ? `<div class="alert-banner"><strong>${overdueQuotes.length} quote${overdueQuotes.length === 1 ? '' : 's'}</strong> need follow-up &nbsp;<a href="#" onclick="switchTab('jobs',document.querySelector('[data-tab=jobs]'));return false">View pipeline →</a></div>` : ''}
      <div class="dash-section">
        <div class="dash-section-hd"><h3>Today's schedule</h3><span class="muted">${todayJobs.length} job${todayJobs.length === 1 ? '' : 's'}</span></div>
        <div class="dash-list">${todayJobs.length ? todayJobs.map((j) => dashJobRow(j)).join('') : '<div class="empty-inline">No jobs scheduled today.</div>'}</div>
      </div>
      <div class="dash-section">
        <div class="dash-section-hd"><h3>Upcoming</h3><span class="muted">${upcoming.length} job${upcoming.length === 1 ? '' : 's'}</span></div>
        <div class="dash-list">${upcoming.length ? upcoming.map((j) => dashJobRow(j)).join('') : '<div class="empty-inline">Nothing upcoming.</div>'}</div>
      </div>`;
  };

  function greetingTime() {
    const h = new Date().getHours();
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    return 'evening';
  }

  function dashJobRow(j) {
    const ps = getPipelineStatus(j);
    const tl = j.time ? fmtTime(j.time) : 'All day';
    const dl = j.date !== todayStr() ? j.date + ' · ' : '';
    return `<div class="dash-job" onclick="openJobDetail('${j.id}')">
      <div class="dash-job-main">
        <strong>${esc(j.customer || 'Unnamed')}</strong>
        <span class="muted">${dl}${tl} · ${esc(j.address || '')}</span>
      </div>
      <span class="bdg ${ps}">${pipelineLabel(ps)}</span>
    </div>`;
  }

  /* ── Pipeline / Jobs kanban ────────────────────────── */
  window.renderPipeline = function () {
    const board = document.getElementById('pipeline-board');
    const list = document.getElementById('jobs-list');
    if (!board) return;
    const jobs = typeof loadJobs === 'function' ? loadJobs() : [];
    let filtered = jobs;
    if (pipelineFilter !== 'all') filtered = jobs.filter((j) => getPipelineStatus(j) === pipelineFilter);
    if (list) list.style.display = 'none';
    board.style.display = 'flex';
    board.innerHTML = PIPELINE.map((col) => {
      const colJobs = filtered.filter((j) => getPipelineStatus(j) === col.id);
      return `<div class="kanban-col" data-col="${col.id}">
        <div class="kanban-col-hd" style="border-top:3px solid ${col.color}">
          <span>${col.label}</span>
          <span class="kanban-count">${colJobs.length}</span>
        </div>
        <div class="kanban-cards">${colJobs.map((j) => kanbanCard(j)).join('')}</div>
      </div>`;
    }).join('');
  };

  function kanbanCard(j) {
    const ps = getPipelineStatus(j);
    const price = j.priceQuoted || j.quote || '';
    return `<div class="kanban-card" draggable="true" data-job-id="${j.id}" onclick="openJobDetail('${j.id}')">
      <div class="kc-name">${esc(j.customer || 'Unnamed')}</div>
      <div class="kc-meta">${j.date || 'No date'}${j.time ? ' · ' + fmtTime(j.time) : ''}</div>
      <div class="kc-meta">${esc(j.serviceType || typeLabel(j.type))}</div>
      ${price ? `<div class="kc-price">${esc(String(price))}</div>` : ''}
      <div class="kc-foot"><span class="bdg who">${esc(j.assignedTo || '')}</span>${j.sameDay ? '<span class="bdg walkthrough">Same day</span>' : ''}</div>
    </div>`;
  }

  window.setPipelineFilter = function (f, btn) {
    pipelineFilter = f;
    document.querySelectorAll('.fbtn-pipe').forEach((b) => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderPipeline();
  };

  window.toggleJobsView = function (mode) {
    const board = document.getElementById('pipeline-board');
    const list = document.getElementById('jobs-list');
    const lf = document.getElementById('jobs-list-filters');
    document.querySelectorAll('.view-toggle-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === mode));
    if (mode === 'list') {
      if (board) board.style.display = 'none';
      if (lf) lf.style.display = 'flex';
      if (list) {
        list.style.display = 'block';
        if (typeof renderJobs === 'function') renderJobs();
      }
    } else {
      if (lf) lf.style.display = 'none';
      renderPipeline();
    }
  };

  function initKanbanDrag() {
    const board = document.getElementById('pipeline-board');
    if (!board || board._dragInit) return;
    board._dragInit = true;
    let draggedId = null;
    board.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.kanban-card');
      if (!card) return;
      draggedId = card.dataset.jobId;
      e.dataTransfer.effectAllowed = 'move';
    });
    board.addEventListener('dragover', (e) => {
      e.preventDefault();
      const col = e.target.closest('.kanban-col');
      if (col) col.classList.add('drag-over');
    });
    board.addEventListener('dragleave', (e) => {
      const col = e.target.closest('.kanban-col');
      if (col) col.classList.remove('drag-over');
    });
    board.addEventListener('drop', async (e) => {
      e.preventDefault();
      board.querySelectorAll('.kanban-col').forEach((c) => c.classList.remove('drag-over'));
      const col = e.target.closest('.kanban-col');
      if (!col || !draggedId) return;
      const newStatus = col.dataset.col;
      await moveJobPipeline(draggedId, newStatus);
      draggedId = null;
    });
  }

  window.moveJobPipeline = async function (jobId, pipelineStatus) {
    const patch = { pipelineStatus, updatedAt: new Date().toISOString() };
    if (pipelineStatus === 'scheduled') patch.status = 'scheduled';
    if (pipelineStatus === 'completed') patch.status = 'completed';
    if (pipelineStatus === 'paid') patch.status = 'paid';
    if (pipelineStatus === 'in_progress') patch.status = 'scheduled';
    await db.collection('jobs').doc(jobId).update(patch);
    logActivity(jobId, `Status → ${pipelineLabel(pipelineStatus)}`, me);
    if (typeof showToast === 'function') showToast('Job updated');
  };

  /* ── Activity log ──────────────────────────────────── */
  window.logActivity = async function (jobId, text, who) {
    const job = jobsCache.find((j) => j.id === jobId);
    if (!job) return;
    const log = job.activityLog || [];
    log.push({ at: new Date().toISOString(), by: who || me, text });
    await db.collection('jobs').doc(jobId).update({ activityLog: log.slice(-50) });
  };

  /* ── Job detail modal ──────────────────────────────── */
  window.openJobDetail = function (id) {
    _detailJobId = id;
    const job = jobsCache.find((j) => j.id === id);
    if (!job) return;
    const modal = document.getElementById('job-detail-modal');
    const body = document.getElementById('job-detail-body');
    if (!modal || !body) return;
    const ps = getPipelineStatus(job);
    const phone = (job.phone || '').replace(/\D/g, '');
    const log = (job.activityLog || [])
      .slice()
      .reverse()
      .map((e) => `<div class="timeline-item"><span class="tl-time">${new Date(e.at).toLocaleString()}</span> ${esc(e.text)} <span class="muted">— ${esc(e.by || '')}</span></div>`)
      .join('');
    body.innerHTML = `
      <div class="detail-hd">
        <h3>${esc(job.customer || 'Job')}</h3>
        <span class="bdg ${ps}">${pipelineLabel(ps)}</span>
      </div>
      <div class="detail-actions">
        ${phone ? `<a class="bsm edit" href="tel:${phone}">Call</a><a class="bsm edit" href="sms:${phone}">Text</a>` : ''}
        <button type="button" class="bsm edit" onclick="openBooking(null, jobsCache.find(j=>j.id==='${job.id}'))">Edit</button>
        <button type="button" class="bsm edit" onclick="openInvoice('${job.id}')">Invoice</button>
        ${ps === 'completed' && typeof ADMINS !== 'undefined' && ADMINS.includes(me) ? `<button type="button" class="bsm approve" onclick="markJobPaid('${job.id}')">Mark paid</button>` : ''}
      </div>
      <div class="detail-grid">
        <div><span class="dl">Service</span><span>${esc(job.serviceType || job.type || '—')}</span></div>
        <div><span class="dl">When</span><span>${job.date || '—'} ${job.time ? fmtTime(job.time) : ''} ${job.sameDay ? '· Same day' : ''}</span></div>
        <div><span class="dl">Address</span><span>${esc(job.address || '—')}</span></div>
        <div><span class="dl">Crew</span><span>${esc(job.assignedTo || '—')}</span></div>
        <div><span class="dl">Quote</span><span>${esc(job.quote || '')} ${job.priceQuoted ? '$' + job.priceQuoted : ''} ${job.quoteStatus ? '(' + job.quoteStatus + ')' : ''}</span></div>
        <div><span class="dl">Duration</span><span>${job.durationMin ? (job.durationMin >= 60 ? (job.durationMin/60) + ' hr' + (job.durationMin > 60 ? 's' : '') : job.durationMin + ' min') : '—'}</span></div>
        <div><span class="dl">Notes</span><span>${esc(job.notes || '—')}</span></div>
      </div>
      <div class="detail-section">
        <label class="slbl-sm">Move to</label>
        <div class="pipe-move-btns">${PIPELINE.map((p) => `<button type="button" class="pipe-move ${ps === p.id ? 'active' : ''}" onclick="moveJobPipeline('${job.id}','${p.id}');openJobDetail('${job.id}')">${p.label}</button>`).join('')}</div>
      </div>
      <div class="detail-section"><label class="slbl-sm">Activity</label><div class="timeline">${log || '<div class="muted">No activity yet.</div>'}</div></div>
      <div class="detail-section">
        <label class="slbl-sm">Add note</label>
        <textarea id="job-note-input" rows="2" placeholder="On-site update…"></textarea>
        <button type="button" class="btn-next" style="margin-top:.5rem" onclick="addJobNote('${job.id}')">Save note</button>
      </div>`;
    modal.classList.add('open');
  };

  window.closeJobDetail = function () {
    document.getElementById('job-detail-modal')?.classList.remove('open');
    _detailJobId = null;
  };

  window.addJobNote = async function (jobId) {
    const t = document.getElementById('job-note-input')?.value?.trim();
    if (!t) return;
    await logActivity(jobId, t, me);
    document.getElementById('job-note-input').value = '';
    openJobDetail(jobId);
  };

  /* ── Customers CRM ─────────────────────────────────── */
  window.filterCustomersTab = function (q) {
    custSearchQ = (q || '').toLowerCase();
    renderCustomersTabEnhanced();
  };

  window.renderCustomersTabEnhanced = function () {
    const list = document.getElementById('cust-tab-list');
    if (!list) return;
    let custs = typeof loadCustomers === 'function' ? loadCustomers() : [];
    if (custSearchQ) {
      custs = custs.filter(
        (c) =>
          (c.name || '').toLowerCase().includes(custSearchQ) ||
          (c.phone || '').includes(custSearchQ) ||
          (c.email || '').toLowerCase().includes(custSearchQ) ||
          (c.city || '').toLowerCase().includes(custSearchQ)
      );
    }
    if (!custs.length) {
      list.innerHTML = `<div class="empty"><div>No customers match.</div></div>`;
      return;
    }
    list.innerHTML = '';
    custs.forEach((c) => {
      const jobCount = jobsCache.filter((j) => j.customer === c.name).length;
      const phone = (c.phone || '').replace(/\D/g, '');
      const card = document.createElement('div');
      card.className = 'jcard cust-row';
      card.onclick = () => openCustomerDetail(c.id);
      card.innerHTML = `
        <div class="jcard-top">
          <div style="display:flex;align-items:center;gap:.85rem">
            <div class="cust-av" style="width:40px;height:40px;background:${avatarBg(c.name)};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700">${initials(c.name)}</div>
            <div>
              <div style="font-weight:600">${esc(c.name)}${c.demo ? ' <span class="bdg scheduled">DEMO</span>' : ''}</div>
              <div class="meta">${[c.city, c.phone, c.email].filter(Boolean).join(' · ')}</div>
              <div class="meta">${jobCount} job(s)</div>
            </div>
          </div>
          <div class="cust-quick" onclick="event.stopPropagation()">
            ${phone ? `<a class="bsm edit" href="tel:${phone}">Call</a><a class="bsm edit" href="sms:${phone}">Text</a>` : ''}
            <button type="button" class="bsm del" onclick="deleteCust('${c.id}')">Remove</button>
          </div>
        </div>`;
      list.appendChild(card);
    });
  };

  window.openCustomerDetail = function (id) {
    _detailCustId = id;
    const c = custsCache.find((x) => x.id === id);
    if (!c) return;
    const modal = document.getElementById('cust-detail-modal');
    const body = document.getElementById('cust-detail-body');
    if (!modal || !body) return;
    const history = jobsCache
      .filter((j) => j.customer === c.name)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const phone = (c.phone || '').replace(/\D/g, '');
    body.innerHTML = `
      <h3>${esc(c.name)}${c.demo ? ' <span class="bdg scheduled">DEMO</span>' : ''}</h3>
      <div class="detail-actions">
        ${phone ? `<a class="bsm edit" href="tel:${phone}">Call</a><a class="bsm edit" href="sms:${phone}">Text</a>` : ''}
        <button type="button" class="bsm edit" onclick="openBooking();closeCustomerDetail()">+ Job</button>
      </div>
      <div class="detail-grid">
        <div><span class="dl">Phone</span><span>${esc(c.phone || '—')}</span></div>
        <div><span class="dl">Email</span><span>${esc(c.email || '—')}</span></div>
        <div><span class="dl">Address</span><span>${esc(c.address || '—')}</span></div>
        <div><span class="dl">City</span><span>${esc(c.city || '—')}</span></div>
      </div>
      <div class="fg"><label>Notes</label><textarea id="cust-notes-edit" rows="3">${esc(c.notes || '')}</textarea></div>
      <button type="button" class="btn-next" onclick="saveCustomerNotes('${c.id}')">Save notes</button>
      <div class="detail-section"><label class="slbl-sm">Job history</label>
        ${history.length ? history.map((j) => `<div class="dash-job" onclick="openJobDetail('${j.id}');closeCustomerDetail()"><strong>${esc(j.date || '')}</strong> <span class="muted">${pipelineLabel(getPipelineStatus(j))}</span></div>`).join('') : '<div class="muted">No jobs yet.</div>'}
      </div>`;
    modal.classList.add('open');
  };

  window.closeCustomerDetail = function () {
    document.getElementById('cust-detail-modal')?.classList.remove('open');
  };

  window.saveCustomerNotes = async function (id) {
    const notes = document.getElementById('cust-notes-edit')?.value?.trim() || '';
    await db.collection('customers').doc(id).update({ notes, updatedAt: new Date().toISOString() });
    if (typeof showToast === 'function') showToast('Notes saved');
    openCustomerDetail(id);
  };

  /* ── Leads CRM (full stack) ────────────────────────── */
  function getLeadStatusRaw(lead) {
    return lead?.status || lead?.crmStatus || 'new';
  }

  function canonicalLeadStatus(leadOrStatus) {
    const raw = typeof leadOrStatus === 'string' ? leadOrStatus : getLeadStatusRaw(leadOrStatus);
    return LEGACY_STATUS_MAP[raw] || raw;
  }

  function getLeadStatus(lead) {
    return canonicalLeadStatus(lead);
  }

  function leadStatusLabel(st) {
    return LEAD_STATUS_LABELS[st] || st;
  }

  function leadStatusPillClass(st) {
    const canon = LEGACY_STATUS_MAP[st] || st;
    if (canon === 'dead' || st === 'no_answer_6_attempts') return st === 'no_answer_6_attempts' ? 'no_answer_6_attempts' : 'dead';
    return canon;
  }

  function normalizePhoneE164(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits[0] === '1') return '+' + digits;
    if (digits.length > 10) return '+' + digits;
    return null;
  }

  window.findLeadByPhone = function (phone) {
    const e164 = normalizePhoneE164(phone);
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return null;
    return (typeof leadsCache !== 'undefined' ? leadsCache : []).find((l) => {
      if (l.id === e164 || l.id === digits) return true;
      const ld = String(l.phone || '').replace(/\D/g, '');
      return ld === digits || ld === digits.slice(-10) || digits.endsWith(ld);
    }) || null;
  };

  function fmtFollowUpCountdown(iso) {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    const diff = t - Date.now();
    const abs = Math.abs(diff);
    const h = Math.floor(abs / 3600000);
    const m = Math.floor((abs % 3600000) / 60000);
    const label = h ? h + 'h ' + m + 'm' : m + 'm';
    return diff < 0 ? { text: 'Overdue ' + label, cls: 'over' } : { text: 'In ' + label, cls: 'ok' };
  }

  function zapHintForStatus(st) {
    const canon = LEGACY_STATUS_MAP[st] || st;
    if (canon === 'quoted') return 'Zap 5 (Quote Follow-Up) may send automated SMS via Quo.';
    if (canon === 'booked') return 'Zap 6 (Booking Confirmation) may send confirmation SMS.';
    if (canon === 'dead') return 'Cadence and follow-up Zaps stop for dead leads.';
    if (canon === 'new') return 'Zap 4 (No-Answer Cadence) runs while status=new and cadence not paused.';
    return 'Status changes can trigger Zapier automations — use with care.';
  }

  function cadencePaused(lead) {
    return !!(lead.conversationActive || lead.optedOutAt);
  }

  function getLeadDisplayName(lead) {
    return lead?.name || lead?.firstName || lead?.full_name || lead?.phone || lead?.email || 'Unknown';
  }

  function fmtLeadField(val, type) {
    if (val === null || val === undefined || val === '') return '—';
    if (type === 'bool') return val ? 'Yes' : 'No';
    return String(val);
  }

  function fmtTs(iso) {
    if (!iso) return { relative: '—', absolute: '—' };
    const d = new Date(iso);
    if (isNaN(d.getTime())) return { relative: String(iso), absolute: String(iso) };
    const now = Date.now();
    const diff = now - d.getTime();
    const abs = d.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    const sec = Math.floor(diff / 1000);
    let relative;
    if (sec < 60) relative = 'just now';
    else if (sec < 3600) relative = Math.floor(sec / 60) + 'm ago';
    else if (sec < 86400) relative = Math.floor(sec / 3600) + 'h ago';
    else if (sec < 604800) relative = Math.floor(sec / 86400) + 'd ago';
    else relative = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return { relative, absolute: abs };
  }

  function fmtTsHtml(iso) {
    const t = fmtTs(iso);
    if (t.relative === '—') return '<span class="lead-field-val muted-val">—</span>';
    return `<span class="lead-field-val">${esc(t.relative)}</span><span class="lead-field-sub">${esc(t.absolute)}</span>`;
  }

  function assigneeLabel(id) {
    if (!id) return '—';
    if (id === 'TylerG' || id === 'Tyler') return 'Tyler';
    if (id === 'ZacB' || id === 'Zac') return 'Zac';
    return id;
  }

  function assigneeMatches(leadAssignee, filterId) {
    if (!filterId) return !leadAssignee;
    const entry = LEAD_ASSIGNEES.find((a) => a.id === filterId);
    if (entry) return entry.aliases.includes(leadAssignee);
    return (leadAssignee || '') === filterId;
  }

  function leadIsAssignedTo(lead, assigneeId) {
    const entry = LEAD_ASSIGNEES.find((a) => a.id === assigneeId);
    if (!entry) return (lead.assignedTo || '') === assigneeId;
    return entry.aliases.includes(lead.assignedTo);
  }

  function getSlaInfo(lead) {
    const st = getLeadStatus(lead);
    if (st !== 'new' || !lead.notifiedAt) return null;
    const elapsed =
      typeof leadElapsed === 'function'
        ? leadElapsed(lead)
        : Math.floor((Date.now() - new Date(lead.notifiedAt).getTime()) / 1000);
    const remaining = 120 - elapsed;
    const responded = !!lead.respondedAt;
    let cls = 'ok';
    if (responded) cls = 'done';
    else if (remaining <= 0) cls = 'over';
    else if (remaining <= 60) cls = 'warn';
    return {
      elapsed,
      remaining,
      responded,
      cls,
      text: responded
        ? typeof fmtCountdown === 'function'
          ? 'Responded in ' + fmtCountdown(lead.responseSeconds ?? elapsed)
          : 'Responded'
        : typeof fmtCountdown === 'function'
          ? fmtCountdown(Math.max(0, remaining))
          : remaining + 's',
    };
  }

  function uniqueLeadSources(leads) {
    const set = new Set();
    leads.forEach((l) => {
      if (l.source) set.add(l.source);
    });
    return [...set].sort();
  }

  function filterAndSortLeads(leads) {
    let list = [...leads];
    const q = (leadsFilter.search || '').toLowerCase().trim();
    if (q) {
      list = list.filter((l) => {
        const hay = [l.name, l.firstName, l.phone, l.email, l.source, l.items, l.serviceZip, l.assignedTo]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }
    if (leadsFilter.status !== 'all') {
      list = list.filter((l) => {
        const raw = getLeadStatusRaw(l);
        const canon = canonicalLeadStatus(l);
        if (leadsFilter.status === 'dead') return canon === 'dead' || raw === 'no_answer_6_attempts';
        return canon === leadsFilter.status || raw === leadsFilter.status;
      });
    }
    if (leadsFilter.source !== 'all') list = list.filter((l) => (l.source || '') === leadsFilter.source);
    if (leadsFilter.assignedTo !== 'all') {
      if (leadsFilter.assignedTo === '') list = list.filter((l) => !l.assignedTo);
      else list = list.filter((l) => assigneeMatches(l.assignedTo, leadsFilter.assignedTo));
    }
    if (leadsFilter.optedOutOnly) list = list.filter((l) => !!l.optedOutAt);
    if (leadsFilter.conversationActive) list = list.filter((l) => !!l.conversationActive);
    if (leadsFilter.dueFollowUp) {
      const now = Date.now();
      list = list.filter((l) => l.nextFollowUpAt && new Date(l.nextFollowUpAt).getTime() < now);
    }
    if (leadsFilter.dateFrom) {
      list = list.filter((l) => (l.createdAt || l.timestamp || '') >= leadsFilter.dateFrom);
    }
    if (leadsFilter.dateTo) {
      const end = leadsFilter.dateTo + 'T23:59:59';
      list = list.filter((l) => (l.createdAt || l.timestamp || '') <= end);
    }
    if (leadsSort === 'followup') {
      list.sort((a, b) => {
        const af = a.nextFollowUpAt || '9999';
        const bf = b.nextFollowUpAt || '9999';
        return af.localeCompare(bf);
      });
    } else if (leadsSort === 'status') {
      list.sort((a, b) => getLeadStatus(a).localeCompare(getLeadStatus(b)));
    } else {
      list.sort((a, b) =>
        (b.createdAt || b.timestamp || '').localeCompare(a.createdAt || a.timestamp || '')
      );
    }
    return list;
  }

  window.setLeadsFilter = function (key, val) {
    if (key === 'optedOutOnly' || key === 'conversationActive' || key === 'dueFollowUp') {
      leadsFilter[key] = val === true || val === 'true';
    } else {
      leadsFilter[key] = val;
    }
    renderLeadsEnhanced();
  };

  window.setLeadsSort = function (sort, btn) {
    leadsSort = sort;
    document.querySelectorAll('.leads-sort-btn').forEach((b) => b.classList.toggle('active', b.dataset.sort === sort));
    if (btn) btn.classList.add('active');
    renderLeadsEnhanced();
  };

  window.toggleLeadsFilters = function () {
    leadsFiltersOpen = !leadsFiltersOpen;
    renderLeadsToolbar();
  };

  function firebaseConnLabel() {
    if (typeof firebaseConn === 'undefined') return 'syncing…';
    if (firebaseConn.leads === 'error') return 'sync error — check Firebase rules';
    if (firebaseConn.leads === 'connected') return 'live · ' + (typeof leadsCache !== 'undefined' ? leadsCache.length : 0) + ' leads';
    return 'connecting…';
  }

  function renderLeadsToolbar() {
    const host = document.getElementById('leads-toolbar-host');
    if (!host) return;
    const leads = typeof leadsCache !== 'undefined' ? leadsCache : [];
    const sources = uniqueLeadSources(leads);
    const filtered = filterAndSortLeads(leads);
    host.innerHTML = `
      <div class="leads-header">
        <div class="leads-header-row">
          <div>
            <h2>Leads inbox</h2>
            <div class="leads-header-sub">Web3forms → Zapier → Firebase · ${firebaseConnLabel()} · 2 min SLA on new Facebook leads</div>
          </div>
          <div style="display:flex;gap:.45rem;flex-wrap:wrap;align-items:center">
            <span class="leads-count-pill"><strong>${filtered.length}</strong> / ${leads.length}</span>
            <button type="button" class="btn-book" onclick="openLeadModal()">+ Lead</button>
          </div>
        </div>
      </div>
      <div class="leads-toolbar">
        <div class="leads-search-wrap">
          <span class="leads-search-icon" aria-hidden="true"></span>
          <input type="search" class="leads-search" placeholder="Search name, phone, email…" value="${esc(leadsFilter.search)}"
            oninput="setLeadsFilter('search', this.value)" aria-label="Search leads">
        </div>
        <button type="button" class="leads-filter-toggle ${leadsFiltersOpen ? 'open' : ''}" onclick="toggleLeadsFilters()">
          ${leadsFiltersOpen ? 'Hide filters' : 'Filters & sort'}
        </button>
        <div class="leads-filters-collapsible ${leadsFiltersOpen ? '' : 'collapsed'}">
          <div class="leads-filter-row">
            <select aria-label="Filter by status" onchange="setLeadsFilter('status', this.value)">
              <option value="all" ${leadsFilter.status === 'all' ? 'selected' : ''}>All statuses</option>
              ${LEAD_STATUS_FILTER.map((s) => `<option value="${s}" ${leadsFilter.status === s ? 'selected' : ''}>${leadStatusLabel(s)}</option>`).join('')}
            </select>
            <select aria-label="Filter by source" onchange="setLeadsFilter('source', this.value)">
              <option value="all">All sources</option>
              ${sources.map((s) => `<option value="${esc(s)}" ${leadsFilter.source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
            </select>
            <select aria-label="Filter by assignee" onchange="setLeadsFilter('assignedTo', this.value)">
              <option value="all">All assignees</option>
              ${LEAD_ASSIGNEES.map((a) => `<option value="${a.id}" ${leadsFilter.assignedTo === a.id ? 'selected' : ''}>${a.label}</option>`).join('')}
              <option value="" ${leadsFilter.assignedTo === '' ? 'selected' : ''}>Unassigned</option>
            </select>
            <input type="date" aria-label="From date" value="${esc(leadsFilter.dateFrom)}" onchange="setLeadsFilter('dateFrom', this.value)">
            <input type="date" aria-label="To date" value="${esc(leadsFilter.dateTo)}" onchange="setLeadsFilter('dateTo', this.value)">
          </div>
          <div class="leads-filter-row leads-filter-toggles">
            <label class="leads-toggle"><input type="checkbox" ${leadsFilter.optedOutOnly ? 'checked' : ''} onchange="setLeadsFilter('optedOutOnly', this.checked)"> Opted out only</label>
            <label class="leads-toggle"><input type="checkbox" ${leadsFilter.conversationActive ? 'checked' : ''} onchange="setLeadsFilter('conversationActive', this.checked)"> Conversation active</label>
            <label class="leads-toggle"><input type="checkbox" ${leadsFilter.dueFollowUp ? 'checked' : ''} onchange="setLeadsFilter('dueFollowUp', this.checked)"> Due for follow-up</label>
          </div>
          <div class="leads-sort-row">
            <span class="leads-sort-lbl">Sort</span>
            <button type="button" class="leads-sort-btn ${leadsSort === 'newest' ? 'active' : ''}" data-sort="newest" onclick="setLeadsSort('newest', this)">Newest</button>
            <button type="button" class="leads-sort-btn ${leadsSort === 'followup' ? 'active' : ''}" data-sort="followup" onclick="setLeadsSort('followup', this)">Follow-up due</button>
            <button type="button" class="leads-sort-btn ${leadsSort === 'status' ? 'active' : ''}" data-sort="status" onclick="setLeadsSort('status', this)">Status</button>
          </div>
        </div>
      </div>`;

    const bar = document.getElementById('leads-status-bar');
    if (bar) {
      const counts = {};
      LEAD_STATUS_FILTER.forEach((s) => (counts[s] = 0));
      leads.forEach((l) => {
        const canon = canonicalLeadStatus(l);
        if (counts[canon] !== undefined) counts[canon]++;
        else if (getLeadStatusRaw(l) === 'no_answer_6_attempts') counts.dead++;
      });
      bar.innerHTML = LEAD_STATUS_FILTER.filter((s) => counts[s] > 0)
        .map((s) => `<span class="leads-stat-chip"><span class="lead-pill ${s}">${leadStatusLabel(s)}</span> <em>${counts[s]}</em></span>`)
        .join('');
    }
  }

  function renderLeadRow(lead) {
    const rawSt = getLeadStatusRaw(lead);
    const pillCls = leadStatusPillClass(rawSt);
    const sla = getSlaInfo(lead);
    const created = fmtTs(lead.createdAt || lead.timestamp);
    const followUp = fmtFollowUpCountdown(lead.nextFollowUpAt);
    const attempts = Number(lead.contactAttempts) || 0;
    const rowCls = [
      lead.optedOutAt ? 'opted-out' : '',
      sla && !sla.responded && sla.cls === 'over' ? 'urgent' : '',
      sla && !sla.responded && sla.cls === 'warn' ? 'warning' : '',
      followUp && followUp.cls === 'over' ? 'urgent' : '',
      lead.prohibitedItemsFlag ? 'has-prohibited' : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `<button type="button" class="lead-row ${rowCls}" onclick="openLeadDetail('${lead.id}')" role="listitem">
      ${lead.optedOutAt ? '<div class="lead-opted-banner">OPTED OUT</div>' : ''}
      <div class="lead-row-main">
        <div class="lead-row-top">
          <div class="lead-row-name">${lead.conversationActive ? '<span class="lead-conv-dot" title="Conversation active"></span>' : ''}${esc(getLeadDisplayName(lead))}</div>
          <div class="lead-row-badges">
            <span class="lead-pill ${pillCls}">${esc(leadStatusLabel(rawSt))}</span>
            ${lead.prohibitedItemsFlag ? '<span class="lead-pill prohibited">Prohibited</span>' : ''}
            ${lead.scheduledJobAt ? '<span class="lead-pill booking">Booked ' + esc(fmtTs(lead.scheduledJobAt).relative) + '</span>' : ''}
          </div>
        </div>
        <div class="lead-row-meta">
          ${lead.phone ? `<span>${esc(lead.phone)}</span>` : ''}
          ${lead.source ? `<span>${esc(lead.source)}</span>` : ''}
          ${lead.assignedTo ? `<span>${esc(assigneeLabel(lead.assignedTo))}</span>` : ''}
          ${attempts ? `<span class="lead-attempt-pill">Attempt ${attempts}/6</span>` : ''}
          ${followUp ? `<span class="lead-followup ${followUp.cls}">${esc(followUp.text)}</span>` : ''}
          ${lead.reviewRequestedAt ? '<span>Review sent</span>' : ''}
          ${lead.notifiedAt ? '<span>Notified</span>' : ''}
          <span>${esc(created.relative)}</span>
        </div>
        ${lead.items ? `<div class="lead-row-items">${esc(String(lead.items).slice(0, 80))}${String(lead.items).length > 80 ? '…' : ''}</div>` : ''}
      </div>
      <div class="lead-row-side">
        ${
          sla
            ? `<div class="lead-sla ${sla.responded ? 'done' : sla.cls}">${esc(sla.text)}</div>`
            : ''
        }
        <span style="font-size:.65rem;color:var(--muted)">→</span>
      </div>
    </button>`;
  }

  window.renderLeadsEnhanced = function () {
    renderLeadsToolbar();
    const el = document.getElementById('leads-list');
    if (!el || typeof leadsCache === 'undefined') return;

    if (_leadsError) {
      el.innerHTML = `<div class="leads-state error"><h3>Could not load leads</h3><p>${esc(_leadsError.message || String(_leadsError))}</p><button type="button" class="btn-book" onclick="location.reload()">Retry</button></div>`;
      return;
    }

    if (_leadsLoading && !leadsCache.length) {
      const skel = Array.from({ length: 5 }, () => `
        <div class="skel-row">
          <div class="skel-line w-60"></div>
          <div class="skel-line w-40"></div>
          <div class="skel-line w-30"></div>
        </div>`).join('');
      el.innerHTML = `<div class="leads-skeleton" aria-busy="true" aria-label="Loading leads from Firebase">${skel}</div>`;
      return;
    }

    const filtered = filterAndSortLeads(leadsCache);
    if (!filtered.length) {
      el.innerHTML = `<div class="leads-state"><h3>${leadsCache.length ? 'No matches' : 'No leads yet'}</h3><p>${leadsCache.length ? 'Try adjusting filters or search.' : 'Zapier / Facebook Ads leads appear here automatically.'}</p><button type="button" class="btn-book" onclick="openLeadModal()">+ Add lead</button></div>`;
      return;
    }

    el.innerHTML = filtered.map((l) => renderLeadRow(l)).join('');
    if (_detailLeadId) openLeadDetail(_detailLeadId, true);
  };

  window.onLeadsSnapshot = function () {
    _leadsLoading = false;
    _leadsError = null;
    mergeGhostLeads();
    renderLeadsEnhanced();
    if (typeof updateLeadsBadge === 'function') updateLeadsBadge();
    if (document.getElementById('tab-leads')?.classList.contains('active') === false) {
      /* still refresh badge */
    }
  };

  window.onLeadsError = function (err) {
    _leadsLoading = false;
    _leadsError = err;
    renderLeadsEnhanced();
  };

  window.openLeadDetail = function (id, silent) {
    _detailLeadId = id;
    const lead = leadsCache.find((l) => l.id === id);
    const drawer = document.getElementById('lead-detail-drawer');
    const body = document.getElementById('lead-detail-body');
    const title = document.getElementById('lead-detail-title');
    const sub = document.getElementById('lead-detail-subtitle');
    if (!lead || !drawer || !body) return;

    if (title) title.textContent = getLeadDisplayName(lead);
    if (sub) sub.textContent = [lead.phone, lead.email, lead.source].filter(Boolean).join(' · ');

    const st = getLeadStatusRaw(lead);
    const sla = getSlaInfo(lead);
    const phone = (lead.phone || '').replace(/\D/g, '');
    const notes = (lead.notesLog || []).slice().reverse();
    const optedOut = !!lead.optedOutAt;
    const paused = cadencePaused(lead);
    const followUp = fmtFollowUpCountdown(lead.nextFollowUpAt);
    const isAdmin = typeof ADMINS !== 'undefined' && ADMINS.includes(me);

    body.innerHTML = `
      ${optedOut ? '<div class="lead-opted-banner lead-opted-banner-drawer">OPTED OUT — TCPA: do not send SMS</div>' : ''}
      ${
        sla
          ? `<div class="lead-sla-banner ${sla.responded ? 'ok' : sla.cls}"><span>${sla.responded ? 'Responded within SLA window' : sla.remaining <= 0 ? 'SLA exceeded — respond now' : '2-min SLA countdown'}</span><time>${esc(sla.text)}</time></div>`
          : ''
      }
      ${lead.prohibitedItemsFlag ? '<div class="lead-sla-banner over"><span>Prohibited items flagged</span></div>' : ''}
      <!-- ── TYLER'S PRIMARY ACTION BUTTONS ── -->
      <div class="lead-tyler-actions">
        ${st !== 'booked' ? `<button type="button" class="tyler-btn tyler-booked" onclick="tylerMarkBooked('${lead.id}')">BOOKED</button>` : '<div class="tyler-booked-badge">Booked</div>'}
        ${st !== 'dead' ? `<button type="button" class="tyler-btn tyler-lost" onclick="tylerMarkLost('${lead.id}')">LOST</button>` : '<div class="tyler-lost-badge">Lost</div>'}
        <button type="button" class="tyler-btn ${lead.conversationActive ? 'tyler-resume' : 'tyler-pause'}" onclick="tylerToggleActive('${lead.id}', ${!!lead.conversationActive})">
          ${lead.conversationActive ? 'RESUME AUTO' : 'PAUSE AUTO'}
        </button>
      </div>

      <!-- ── META SIGNAL BUTTONS ── -->
      <div class="lead-signal-actions">
        <button type="button" class="signal-btn signal-qualified" onclick="signalQualified('${lead.id}')">QUALIFIED</button>
        <button type="button" class="signal-btn signal-converted" onclick="signalConverted('${lead.id}')">CONVERTED</button>
        <button type="button" class="signal-btn signal-not-interested" onclick="signalNotInterested('${lead.id}')">NOT INTERESTED</button>
        <button type="button" class="signal-btn signal-archived" onclick="signalArchived('${lead.id}')">ARCHIVED</button>
      </div>

      <div class="lead-detail-actions">
        ${phone ? `<a class="bsm edit" href="tel:${phone}">Call</a>` : ''}
        ${phone && !optedOut ? `<a class="bsm edit" href="sms:${phone}">Text via Quo</a>` : ''}
        ${phone && optedOut ? `<span class="bsm edit tcpa-disabled" title="TCPA: lead opted out">Text (blocked)</span>` : ''}
        ${lead.email ? `<a class="bsm edit" href="mailto:${esc(lead.email)}">Email</a>` : ''}
        <button type="button" class="bsm edit" onclick="logContactAttempt('${lead.id}')">Log attempt</button>
        <button type="button" class="bsm edit" onclick="convertLeadToJob('${lead.id}')">→ Job</button>
      </div>

      <div class="lead-section lead-automation-section">
        <div class="lead-section-title">Automation status</div>
        ${paused
          ? '<p class="lead-cadence-paused">Automation paused — Tyler is working this lead.</p>'
          : '<p class="lead-cadence-active muted small">Automation active — review request fires when job is marked complete.</p>'}
        <div class="lead-automation-btns">
          ${isAdmin ? `<button type="button" class="bsm del" onclick="markLeadOptedOut('${lead.id}')" ${optedOut ? 'disabled' : ''}>Mark opted out</button>` : ''}
          <button type="button" class="bsm edit" onclick="logManualTouch('${lead.id}')">Log manual touch</button>
        </div>
        <p class="muted small" style="margin-top:.5rem">Firestore doc ID: <code>${esc(lead.id)}</code></p>
      </div>

      <div class="lead-section">
        <div class="lead-section-title">Contact</div>
        <div class="lead-field-grid">
          ${leadField('Name', lead.name)}
          ${leadField('First name', lead.firstName)}
          ${leadField('Phone', lead.phone)}
          ${leadField('Email', lead.email)}
          ${leadField('Service ZIP', lead.serviceZip)}
        </div>
      </div>

      <div class="lead-section">
        <div class="lead-section-title">Lead meta</div>
        <div class="lead-field-grid">
          <div class="lead-field">
            <span class="lead-field-lbl">Status</span>
            <div class="lead-field-row">
              <select class="lead-inline-select" id="lead-status-select-${lead.id}" onchange="setLeadStatus('${lead.id}', this.value, this)">
                ${LEAD_STATUSES.map((s) => `<option value="${s}" ${st === s ? 'selected' : ''}>${leadStatusLabel(s)}</option>`).join('')}
                ${!LEAD_STATUSES.includes(st) ? `<option value="${st}" selected>${leadStatusLabel(st)}</option>` : ''}
              </select>
            </div>
          </div>
          ${leadField('Source', lead.source)}
          ${leadField('Items', lead.items || lead.service)}
          <div class="lead-field">
            <span class="lead-field-lbl">Assigned to</span>
            <div class="lead-field-row">
              ${LEAD_ASSIGNEES.map(
                (a) =>
                  `<button type="button" class="bsm ${leadIsAssignedTo(lead, a.id) ? 'approve' : 'edit'}" onclick="assignLead('${lead.id}','${a.id}')">${a.label}</button>`
              ).join('')}
            </div>
          </div>
          ${leadField('Conversation active', lead.conversationActive, 'bool')}
          ${leadField('Contact attempts', (lead.contactAttempts ?? 0) + ' / 6')}
        </div>
      </div>

      <div class="lead-section">
        <div class="lead-section-title">Activity</div>
        <div class="lead-field-grid">
          ${leadTsField('Created', lead.createdAt || lead.timestamp)}
          ${leadTsField('Last touch', lead.lastTouchAt)}
          ${leadTsField('Last outbound', lead.lastOutboundAt)}
          ${leadTsField('Notified', lead.notifiedAt)}
          ${leadTsField('Review requested', lead.reviewRequestedAt)}
          ${lead.message ? leadField('Message', lead.message) : ''}
        </div>
      </div>

      <div class="lead-section">
        <div class="lead-section-title">Follow-up &amp; booking</div>
        <div class="lead-field-grid">
          <div class="lead-field"><span class="lead-field-lbl">Next follow-up</span>${followUp ? `<span class="lead-field-val ${followUp.cls === 'over' ? 'danger' : ''}">${esc(followUp.text)}</span>${fmtTsHtml(lead.nextFollowUpAt)}` : fmtTsHtml(lead.nextFollowUpAt)}</div>
          ${leadTsField('Scheduled job', lead.scheduledJobAt)}
          ${leadField('Loss reason', lead.lossReason)}
          ${leadTsField('Quote sent', lead.quoteSentAt)}
        </div>
      </div>

      <div class="lead-section">
        <div class="lead-section-title">Compliance</div>
        <div class="lead-field-grid">
          ${leadTsField('Consent captured', lead.consentCapturedAt)}
          ${leadTsField('Opted out', lead.optedOutAt)}
        </div>
      </div>

      <div class="lead-section">
        <div class="lead-section-title">Notes</div>
        <div class="lead-notes-list">${notes.length ? notes.map((n) => `<div class="lead-note-item"><time>${esc(fmtTs(n.at).absolute)} — ${esc(n.by || '')}</time>${esc(n.text)}</div>`).join('') : '<div class="muted" style="font-size:.8rem">No notes yet.</div>'}</div>
        <textarea id="lead-note-input" class="lead-note-input" rows="2" placeholder="Add a note…"></textarea>
        <button type="button" class="btn-next" style="margin-top:.5rem;min-height:44px" onclick="addLeadNote('${lead.id}')">Save note</button>
      </div>`;

    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  };

  function leadField(label, val, type, danger) {
    const display = fmtLeadField(val, type);
    const cls = danger ? 'lead-field-val danger' : display === '—' ? 'lead-field-val muted-val' : 'lead-field-val';
    return `<div class="lead-field"><span class="lead-field-lbl">${label}</span><span class="${cls}">${esc(display)}</span></div>`;
  }

  function leadTsField(label, iso) {
    return `<div class="lead-field"><span class="lead-field-lbl">${label}</span>${fmtTsHtml(iso)}</div>`;
  }

  window.closeLeadDetail = function () {
    _detailLeadId = null;
    const drawer = document.getElementById('lead-detail-drawer');
    if (drawer) {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
    }
    document.body.style.overflow = '';
  };

  window.setLeadStatus = async function (id, status, selectEl) {
    const lead = leadsCache.find((l) => l.id === id);
    const prev = lead ? getLeadStatusRaw(lead) : '';
    if (status !== prev) {
      const warn = zapHintForStatus(status);
      const deadStatuses = ['dead', 'no_answer_6_attempts'];
      if (deadStatuses.includes(status)) {
        const reason = prompt('Mark lead dead? Optional loss reason:', '');
        if (reason === null) {
          if (selectEl) selectEl.value = prev;
          return;
        }
        const now = new Date().toISOString();
        await db.collection('leads').doc(id).set(
          { status, crmStatus: status, lossReason: reason.trim() || '—', updatedAt: now },
          { merge: true }
        );
        if (typeof showToast === 'function') showToast('Lead marked dead');
        openLeadDetail(id, true);
        return;
      }
      if (!confirm('Change status to "' + leadStatusLabel(status) + '"?\n\n' + warn + '\n\nThis may trigger Zapier automations (Zaps 5/6/7).')) {
        if (selectEl) selectEl.value = prev;
        return;
      }
    }
    const now = new Date().toISOString();
    await db.collection('leads').doc(id).set({ status, crmStatus: status, updatedAt: now }, { merge: true });
    if (typeof showToast === 'function') showToast('Status updated');
    openLeadDetail(id, true);
  };

  window.assignLead = async function (id, assignee) {
    await db.collection('leads').doc(id).set({ assignedTo: assignee, updatedAt: new Date().toISOString() }, { merge: true });
    if (typeof showToast === 'function') showToast('Assigned to ' + assigneeLabel(assignee));
    openLeadDetail(id, true);
  };

  window.logContactAttempt = async function (id) {
    const lead = leadsCache.find((l) => l.id === id);
    if (!lead) return;
    const now = new Date().toISOString();
    const attempts = (Number(lead.contactAttempts) || 0) + 1;
    await db.collection('leads').doc(id).set(
      {
        contactAttempts: attempts,
        lastContactAt: now,
        lastTouchAt: now,
        lastOutboundAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
    if (typeof showToast === 'function') showToast('Contact attempt logged');
    openLeadDetail(id, true);
  };

  window.promptMarkLeadDead = function (id) {
    const reason = prompt('Mark lead dead? Optional loss reason:', '');
    if (reason === null) return;
    markLeadDead(id, reason.trim(), 'dead');
  };

  window.markLeadDead = async function (id, reason, status) {
    const now = new Date().toISOString();
    await db.collection('leads').doc(id).set(
      {
        status: status || 'dead',
        crmStatus: status || 'dead',
        lossReason: reason || '—',
        updatedAt: now,
      },
      { merge: true }
    );
    if (typeof showToast === 'function') showToast('Lead marked dead');
    openLeadDetail(id, true);
  };

  window.promptMarkLeadLost = window.promptMarkLeadDead;

  window.markLeadLost = async function (id, reason) {
    return markLeadDead(id, reason, 'dead');
  };

  window.markLeadOptedOut = async function (id) {
    const isAdmin = typeof ADMINS !== 'undefined' && ADMINS.includes(me);
    if (!isAdmin) {
      alert('Admin only');
      return;
    }
    if (!confirm('Mark this lead as opted out (TCPA)? They will never receive automated SMS again.')) return;
    const now = new Date().toISOString();
    await db.collection('leads').doc(id).set({ optedOutAt: now, updatedAt: now }, { merge: true });
    if (typeof showToast === 'function') showToast('Lead opted out');
    openLeadDetail(id, true);
  };

  /* ── TYLER'S 3 BIG BUTTONS ─────────────────────────── */

  window.tylerMarkBooked = async function (id) {
    if (!confirm('Mark this lead as BOOKED? This stops all follow-up automation.')) return;
    const now = new Date().toISOString();
    await db.collection('leads').doc(id).set(
      { status: 'booked', crmStatus: 'booked', conversationActive: false, updatedAt: now, bookedAt: now },
      { merge: true }
    );
    if (typeof showToast === 'function') showToast('Lead marked BOOKED');
    openLeadDetail(id, true);
  };

  window.tylerMarkLost = async function (id) {
    const reason = prompt('Why did we lose this lead? (optional)');
    if (reason === null) return; // cancelled
    const now = new Date().toISOString();
    await db.collection('leads').doc(id).set(
      { status: 'dead', crmStatus: 'dead', conversationActive: false, lossReason: reason.trim() || '—', updatedAt: now, lostAt: now },
      { merge: true }
    );
    if (typeof showToast === 'function') showToast('Lead marked LOST');
    openLeadDetail(id, true);
  };

  window.tylerToggleActive = async function (id, currentlyActive) {
    const now = new Date().toISOString();
    const newVal = !currentlyActive;
    await db.collection('leads').doc(id).set(
      { conversationActive: newVal, lastTouchAt: now, updatedAt: now },
      { merge: true }
    );
    if (typeof showToast === 'function') showToast(newVal ? 'Automation paused' : 'Automation resumed');
    openLeadDetail(id, true);
  };

  window.logManualTouch = async function (id) {
    const lead = leadsCache.find((l) => l.id === id);
    if (!lead) return;
    const bump = confirm('Also increment contactAttempts?');
    const now = new Date().toISOString();
    const patch = { lastTouchAt: now, updatedAt: now };
    if (bump) patch.contactAttempts = (Number(lead.contactAttempts) || 0) + 1;
    await db.collection('leads').doc(id).set(patch, { merge: true });
    if (typeof showToast === 'function') showToast('Manual touch logged');
    openLeadDetail(id, true);
  };

  window.addLeadNote = async function (id) {
    const text = document.getElementById('lead-note-input')?.value?.trim();
    if (!text) return;
    const lead = leadsCache.find((l) => l.id === id);
    const log = lead?.notesLog || [];
    log.push({ at: new Date().toISOString(), by: typeof me !== 'undefined' ? me : '', text });
    await db.collection('leads').doc(id).set({ notesLog: log.slice(-100), updatedAt: new Date().toISOString() }, { merge: true });
    if (typeof showToast === 'function') showToast('Note saved');
    openLeadDetail(id, true);
  };

  window.openLeadModal = function (leadId) {
    const modal = document.getElementById('lead-form-modal');
    const form = document.getElementById('lead-form');
    if (!modal || !form) return;
    const lead = leadId ? leadsCache.find((l) => l.id === leadId) : null;
    document.getElementById('lf-id').value = lead?.id || '';
    document.getElementById('lf-name').value = lead?.name || lead?.full_name || '';
    document.getElementById('lf-phone').value = lead?.phone || '';
    document.getElementById('lf-email').value = lead?.email || '';
    document.getElementById('lf-city').value = lead?.city || '';
    document.getElementById('lf-service').value = lead?.service || lead?.items || '';
    document.getElementById('lf-timing').value = lead?.timing || '';
    document.getElementById('lf-message').value = lead?.message || '';
    document.getElementById('lf-source').value = lead?.source || 'phone';
    document.getElementById('lf-status').value = lead ? getLeadStatus(lead) : 'new';
    modal.classList.add('open');
  };

  window.closeLeadModal = function () {
    document.getElementById('lead-form-modal')?.classList.remove('open');
  };

  window.saveLeadForm = async function () {
    const existingId = document.getElementById('lf-id').value;
    const phoneRaw = document.getElementById('lf-phone').value.trim();
    const e164 = normalizePhoneE164(phoneRaw);
    // Prefer E.164 phone as doc ID for new leads (matches Zapier); keep existing ID when editing.
    const id = existingId || e164 || uid();
    const data = {
      name: document.getElementById('lf-name').value.trim(),
      phone: phoneRaw,
      email: document.getElementById('lf-email').value.trim(),
      city: document.getElementById('lf-city').value.trim(),
      serviceZip: document.getElementById('lf-city').value.trim(),
      items: document.getElementById('lf-service').value.trim(),
      service: document.getElementById('lf-service').value.trim(),
      timing: document.getElementById('lf-timing').value.trim(),
      message: document.getElementById('lf-message').value.trim(),
      source: document.getElementById('lf-source').value,
      status: document.getElementById('lf-status').value,
      crmStatus: document.getElementById('lf-status').value,
      createdAt: existingId ? undefined : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!data.name && !data.phone) {
      alert('Name or phone required');
      return;
    }
    await db.collection('leads').doc(id).set(data, { merge: true });
    closeLeadModal();
    if (typeof showToast === 'function') showToast('Lead saved');
  };

  window.setLeadCrmStatus = async function (id, status) {
    await db.collection('leads').doc(id).set({ status, crmStatus: status, updatedAt: new Date().toISOString() }, { merge: true });
  };

  window.convertLeadToJob = async function (leadId) {
    const lead = leadsCache.find((l) => l.id === leadId);
    if (!lead) return;
    if (!confirm('Convert this lead to a job? Lead will be marked booked with scheduledJobAt if set.')) return;
    let cust = custsCache.find((c) => c.phone && lead.phone && c.phone === lead.phone);
    const displayName = getLeadDisplayName(lead);
    if (!cust) {
      const cid = uid();
      cust = {
        id: cid,
        name: displayName,
        phone: lead.phone || '',
        email: lead.email || '',
        address: '',
        city: lead.serviceZip || lead.city || '',
      };
      await db.collection('customers').doc(cid).set(cust);
    }
    const jobId = uid();
    const flow = leadFlowType(lead);
    const bookingNote = flow === 'booking' ? 'Online booking request — confirm slot from form.' : '';
    const srcNote = lead.source ? `Source: ${lead.source}` : '';
    const notes = [lead.message || '', bookingNote, srcNote].filter(Boolean).join('\n');
    const scheduledAt = lead.scheduledJobAt || null;
    const jobPatch = {
      id: jobId,
      customer: cust.name,
      phone: cust.phone,
      email: cust.email,
      city: lead.serviceZip || lead.city || '',
      serviceType: lead.items || lead.service || 'Garage Cleanout',
      type: 'job',
      pipelineStatus: 'scheduled',
      status: 'scheduled',
      notes,
      source: lead.source || '',
      assignedTo: lead.assignedTo || (me === 'TylerG' ? 'TylerG' : 'ZacB'),
      createdBy: me,
      createdAt: new Date().toISOString(),
      leadId,
    };
    if (scheduledAt) {
      jobPatch.date = String(scheduledAt).slice(0, 10);
    } else if (lead.scheduledJobAt) {
      jobPatch.date = lead.scheduledJobAt.slice(0, 10);
    }
    const now = new Date().toISOString();
    const leadPatch = {
      status: 'booked',
      crmStatus: 'booked',
      convertedAt: now,
      updatedAt: now,
    };
    if (!lead.scheduledJobAt && jobPatch.date) {
      leadPatch.scheduledJobAt = jobPatch.date + 'T12:00:00.000Z';
    }
    await db.collection('jobs').doc(jobId).set(jobPatch);
    await db.collection('leads').doc(leadId).set(leadPatch, { merge: true });
    closeLeadDetail();
    if (typeof showToast === 'function') showToast('Lead converted — status booked');
    openJobDetail(jobId);
  };

  window.respondLead = async function (id, method) {
    const lead = leadsCache.find((l) => l.id === id);
    if (!lead) return;
    const responseSeconds = typeof leadElapsed === 'function' ? leadElapsed(lead) : 0;
    const now = new Date().toISOString();
    const attempts = (Number(lead.contactAttempts) || 0) + 1;
    const st = getLeadStatus(lead);
    await db.collection('leads').doc(id).set(
      {
        respondedAt: now,
        respondedBy: me,
        responseMethod: method,
        responseSeconds,
        lastContactAt: now,
        lastTouchAt: now,
        lastOutboundAt: now,
        contactAttempts: attempts,
        status: st === 'new' ? 'new' : st,
        crmStatus: st === 'new' ? 'new' : st,
        updatedAt: now,
      },
      { merge: true }
    );
    if (typeof showToast === 'function') showToast('Response logged');
    if (_detailLeadId === id) openLeadDetail(id, true);
  };

  /* ── Quote modal ───────────────────────────────────── */
  window.openQuoteModal = function (jobId) {
    const job = jobsCache.find((j) => j.id === jobId);
    const modal = document.getElementById('quote-modal');
    if (!modal) return;
    document.getElementById('qm-job-id').value = jobId || '';
    document.getElementById('qm-tier').value = job?.priceTier || '';
    document.getElementById('qm-amount').value = job?.priceQuoted || '';
    document.getElementById('qm-status').value = job?.quoteStatus || 'draft';
    document.getElementById('qm-pay-after').checked = !!job?.payAfterApprove;
    modal.classList.add('open');
  };

  window.closeQuoteModal = function () {
    document.getElementById('quote-modal')?.classList.remove('open');
  };

  window.applyQuoteTier = function () {
    const tier = PRICE_TIERS[parseInt(document.getElementById('qm-tier').value, 10)];
    if (tier) document.getElementById('qm-amount').value = Math.round((tier.low + tier.high) / 2);
  };

  window.saveQuoteModal = async function () {
    const jobId = document.getElementById('qm-job-id').value;
    if (!jobId) return;
    const amount = parseFloat(document.getElementById('qm-amount').value) || 0;
    const quoteStatus = document.getElementById('qm-status').value;
    const tierIdx = document.getElementById('qm-tier').value;
    const patch = {
      priceQuoted: amount,
      quote: '$' + amount,
      quoteStatus,
      priceTier: tierIdx !== '' ? Number(tierIdx) : null,
      payAfterApprove: document.getElementById('qm-pay-after').checked,
      pipelineStatus: quoteStatus === 'approved' ? 'scheduled' : 'quoted',
      updatedAt: new Date().toISOString(),
    };
    if (quoteStatus === 'sent') patch.quoteSentAt = new Date().toISOString();
    await db.collection('jobs').doc(jobId).update(patch);
    await logActivity(jobId, `Quote ${quoteStatus} — $${amount}`, me);
    closeQuoteModal();
    if (typeof showToast === 'function') showToast('Quote saved');
    if (_detailJobId === jobId) openJobDetail(jobId);
  };

  /* ── Invoicing ─────────────────────────────────────── */
  window.markJobPaid = async function (jobId) {
    const method = prompt('Payment method: cash, card, or check', 'cash');
    if (!method || !PAY_METHODS.includes(method)) return;
    const job = jobsCache.find((j) => j.id === jobId);
    const amt = parseFloat(prompt('Amount received', String(job?.priceQuoted || 30))) || 30;
    await db.collection('jobs').doc(jobId).update({
      pipelineStatus: 'paid',
      status: 'paid',
      paymentMethod: method,
      paidAmount: amt,
      paidAt: new Date().toISOString(),
    });
    await logActivity(jobId, `Paid $${amt} via ${method}`, me);
    if (typeof showToast === 'function') showToast('Marked paid');
    openJobDetail(jobId);
  };

  window.openInvoice = function (jobId) {
    const job = jobsCache.find((j) => j.id === jobId);
    if (!job) return;
    const w = window.open('', '_blank');
    const amt = job.paidAmount || job.priceQuoted || job.quote || '—';
    w.document.write(`<!DOCTYPE html><html><head><title>Invoice — ${esc(job.customer)}</title>
      <style>body{font-family:system-ui;max-width:640px;margin:2rem auto;padding:1rem}
      h1{color:#ff5b1f}table{width:100%;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid #eee;text-align:left}
      @media print{.no-print{display:none}}</style></head><body>
      <h1>Easy Garage Cleaning</h1>
      <p>801 W Laurel St, Fort Collins, CO<br>(970) 999-1818</p>
      <h2>Invoice</h2>
      <table><tr><th>Customer</th><td>${esc(job.customer)}</td></tr>
      <tr><th>Date</th><td>${esc(job.date || '')}</td></tr>
      <tr><th>Service</th><td>${esc(job.serviceType || job.type || '')}</td></tr>
      <tr><th>Address</th><td>${esc(job.address || '')}</td></tr>
      <tr><th>Amount</th><td><strong>${esc(String(amt))}</strong></td></tr>
      <tr><th>Status</th><td>${pipelineLabel(getPipelineStatus(job))}${job.paymentMethod ? ' · ' + job.paymentMethod : ''}</td></tr></table>
      <p class="no-print"><button onclick="window.print()">Print</button></p></body></html>`);
    w.document.close();
  };

  /* ── Notifications ─────────────────────────────────── */
  function requestNotifPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') Notification.requestPermission();
  }

  function scheduleNotifCheck() {
    if (_notifTimer) clearInterval(_notifTimer);
    if (!prefs.notifications) return;
    _notifTimer = setInterval(() => {
      if (Notification.permission !== 'granted') return;
      const jobs = jobsCache.filter((j) => j.date === todayStr() && j.time && getPipelineStatus(j) === 'scheduled');
      const now = new Date();
      jobs.forEach((j) => {
        const [h, m] = j.time.split(':').map(Number);
        const diff = (h * 60 + m) - (now.getHours() * 60 + now.getMinutes());
        if (diff > 55 && diff <= 60 && !j._notified1h) {
          j._notified1h = true;
          new Notification('Upcoming job', { body: `${j.customer} at ${fmtTime(j.time)}`, tag: j.id });
        }
      });
    }, 60000);
  }

  window.toggleNotifications = function (on) {
    prefs.notifications = !!on;
    savePrefs();
    if (on) {
      requestNotifPermission();
      scheduleNotifCheck();
    }
  };

  /* ── More / settings panel ─────────────────────────── */
  window.renderMorePanel = function () {
    const el = document.getElementById('more-content');
    if (!el) return;
    const last = localStorage.getItem(LS_BACKUP_META) || 'Never';
    const isAdmin = typeof ADMINS !== 'undefined' && ADMINS.includes(me);
    el.innerHTML = `
      <div class="more-section">
        <h3>Account</h3>
        <p class="muted">Signed in as <strong>${esc(me)}</strong> · ${isAdmin ? 'Admin' : 'Crew'}</p>
        <p class="muted">Session resets after 30 min idle</p>
      </div>
      <div class="more-section">
        <h3>Notifications</h3>
        <label class="email-toggle-row"><input type="checkbox" ${prefs.notifications ? 'checked' : ''} onchange="toggleNotifications(this.checked)">
          <span>Browser reminders 1hr before jobs</span></label>
      </div>
      <div class="more-section">
        <h3>Data backup</h3>
        <p class="muted">Last local snapshot: ${last}</p>
        <div class="more-btns">
          <button type="button" class="btn-book" onclick="exportCrmBackup()">Download JSON</button>
          <label class="btn-back" style="display:inline-flex;align-items:center;cursor:pointer">Upload restore<input type="file" accept=".json" hidden onchange="importCrmBackup(this.files[0]);this.value=''"></label>
        </div>
        <p class="muted small">Offline copy in IndexedDB (${IDB_NAME})</p>
      </div>
      <div class="more-section">
        <h3>Quick links</h3>
        <div class="more-btns">
          <button type="button" class="btn-back" onclick="switchTab('leads', document.querySelector('[data-tab=leads]'))">Leads inbox</button>
          <button type="button" class="btn-back" onclick="switchTab('customers', document.querySelector('.tab[data-tab=customers]'))">Customers</button>
          <button type="button" class="btn-back" onclick="selectMode('call')">On-call quote flow</button>
        </div>
      </div>
      ${isAdmin ? `<div class="more-section"><h3>Admin</h3>
        <button type="button" class="btn-back" onclick="seedDemoData()">Seed DEMO records</button>
      </div>` : ''}
      <div class="more-section">
        <h3>Automation System</h3>
        <p class="muted small">Zapier + Quo + Firestore · <a href="/docs/zapier-automation.md" target="_blank" rel="noopener" style="color:var(--accent)">Full spec (zapier-automation.md)</a></p>
        <div class="automation-cards">
          ${ZAP_AUTOMATION.map(
            (z) => `<details class="automation-card"><summary><span class="automation-zap-id">Zap ${z.id}</span> ${esc(z.title)}</summary><p>${esc(z.desc)}</p></details>`
          ).join('')}
        </div>
      </div>
      <div class="more-section muted small">
        Website leads: Web3forms → Zapier → Firestore <code>leads</code> (phone doc ID). Fields: phone, name, email, items, serviceZip, source, status=new.
      </div>`;
  };

  window.seedDemoData = async function () {
    if (custsCache.some((c) => c.demo) && !confirm('DEMO records already exist. Add 3 more (does not delete anything)?')) return;
    if (!confirm('Add 3 DEMO customers/jobs (demo:true flag only)?')) return;
    const demos = [
      { name: 'DEMO — Pat Sample', phone: '970-555-0101', city: 'Fort Collins', address: '100 Demo St' },
      { name: 'DEMO — Sam Example', phone: '970-555-0102', city: 'Loveland', address: '200 Demo Ave' },
      { name: 'DEMO — Alex Test', phone: '970-555-0103', city: 'Windsor', address: '300 Demo Ln' },
    ];
    for (const d of demos) {
      const cid = uid();
      await db.collection('customers').doc(cid).set({ ...d, id: cid, demo: true, notes: 'Demo record for training' });
      const jid = uid();
      await db.collection('jobs').doc(jid).set({
        id: jid,
        customer: d.name,
        phone: d.phone,
        city: d.city,
        address: d.address,
        type: 'job',
        pipelineStatus: 'quoted',
        status: 'scheduled',
        priceQuoted: 299,
        demo: true,
        date: fmtDate(new Date(Date.now() + 86400000 * 3)),
        time: '10:00',
        assignedTo: 'ZacB',
        createdAt: new Date().toISOString(),
      });
    }
    if (typeof showToast === 'function') showToast('DEMO data added');
  };

  /* ── Tab routing hook ──────────────────────────────── */
  const _origSwitchTab = window.switchTab;
  window.switchTab = function (name, btn) {
    if (!checkSessionExpiry()) return;
    touchSession();
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.querySelectorAll('.tab, .bottom-nav .bn-item').forEach((b) => b.classList.remove('active'));
    const panel = document.getElementById('tab-' + name);
    if (panel) panel.classList.add('active');
    if (btn) btn.classList.add('active');
    const bn = document.querySelector(`.bottom-nav .bn-item[data-tab="${name}"]`);
    if (bn) bn.classList.add('active');

    if (name === 'home') renderDashboard();
    if (name === 'jobs') {
      if (window.innerWidth <= 768) toggleJobsView('list');
      else toggleJobsView(document.querySelector('.view-toggle-btn.active')?.dataset.view || 'board');
      initKanbanDrag();
    }
    if (name === 'schedule' && typeof renderCal === 'function') {
      renderCal();
      setTimeout(() => { if (typeof scrollToNow === 'function') scrollToNow(); }, 100);
    }
    if (name === 'leads') renderLeadsEnhanced();
    if (name === 'customers') renderCustomersTabEnhanced();
    if (name === 'payout' && typeof renderPayout === 'function') renderPayout();
    if (name === 'more') renderMorePanel();
  };

  /* ── Enhance refresh / boot ────────────────────────── */
  window.crmRefresh = function () {
    renderDashboard();
    if (document.getElementById('tab-schedule')?.classList.contains('active') && typeof renderCal === 'function') {
      renderCal();
    }
    const jobsTab = document.getElementById('tab-jobs');
    if (jobsTab?.classList.contains('active')) {
      const view = document.querySelector('.view-toggle-btn.active')?.dataset.view || 'board';
      if (view === 'board') renderPipeline();
      else if (typeof renderJobs === 'function') renderJobs();
    }
    renderCustomersTabEnhanced();
    renderLeadsEnhanced();
    autoBackupTick();
  };

  const _origRefresh = window.refresh;
  window.refresh = function () {
    if (_origRefresh) _origRefresh();
    crmRefresh();
  };

  const _origRenderCustomersTab = window.renderCustomersTab;
  window.renderCustomersTab = function () {
    renderCustomersTabEnhanced();
  };

  const _origRenderLeads = window.renderLeads;
  window.renderLeads = function () {
    if (document.getElementById('leads-list')?.closest('#tab-leads')) renderLeadsEnhanced();
    else if (_origRenderLeads) _origRenderLeads();
  };

  const _origBoot = window.bootDashboard;
  window.bootDashboard = function () {
    if (_origBoot) _origBoot();
    touchSession();
    document.getElementById('mode-screen').style.display = 'none';
    const dash = document.getElementById('dashboard');
    if (dash) dash.style.display = 'flex';
    initKanbanDrag();
    crmRefresh();
    scheduleNotifCheck();
    const homeBtn = document.querySelector('.bottom-nav .bn-item[data-tab="home"]');
    switchTab('home', homeBtn);
  };

  const _origSelectMode = window.selectMode;
  window.selectMode = function (mode) {
    if (mode === 'admin') {
      document.getElementById('mode-screen').style.display = 'none';
      if (typeof bootDashboard === 'function') bootDashboard();
      setTimeout(() => switchTab('more', document.querySelector('[data-tab="more"]')), 50);
      return;
    }
    if (_origSelectMode) _origSelectMode(mode);
  };

  const _origLogin = window.doLogin;
  window.doLogin = function () {
    if (_origLogin) _origLogin();
    touchSession();
  };

  const _origLogout = window.doLogout;
  window.doLogout = function () {
    sessionStorage.removeItem('egc_exp');
    if (_origLogout) _origLogout();
  };

  /* ── Patch job card for pipeline ───────────────────── */
  window.enhanceJobCard = function (card, job) {
    const ps = getPipelineStatus(job);
    const badges = card.querySelector('.badges');
    if (badges && !badges.querySelector('.bdg.pipeline')) {
      const sp = document.createElement('span');
      sp.className = 'bdg pipeline ' + ps;
      sp.textContent = pipelineLabel(ps);
      badges.insertBefore(sp, badges.firstChild);
    }
    const acts = card.querySelector('.jcard-actions');
    if (acts && !acts.querySelector('[data-quote]')) {
      const qb = document.createElement('button');
      qb.className = 'bsm edit';
      qb.dataset.quote = '1';
      qb.textContent = 'Quote';
      qb.onclick = () => openQuoteModal(job.id);
      acts.insertBefore(qb, acts.firstChild);
      const vb = document.createElement('button');
      vb.className = 'bsm edit';
      vb.textContent = 'Details';
      vb.onclick = () => openJobDetail(job.id);
      acts.insertBefore(vb, acts.firstChild);
    }
  };

  const _origMkJobCard = window.mkJobCard;
  if (_origMkJobCard) {
    window.mkJobCard = function (job) {
      const card = _origMkJobCard(job);
      enhanceJobCard(card, job);
      return card;
    };
  }

  /* ── Patch confirm booking ─────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    document.body.addEventListener(
      'click',
      (e) => {
        if (e.target.closest('.modal-backdrop')) {
          closeJobDetail();
          closeCustomerDetail();
          closeLeadDetail();
          closeLeadModal();
          closeQuoteModal();
        }
      },
      true
    );
    ['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, touchSession, { passive: true }));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLeadDetail();
    });
    // Sync leads UI if Firebase snapshot arrived before CRM module init
    if (typeof leadsCache !== 'undefined' && leadsCache.length) {
      _leadsLoading = false;
      renderLeadsEnhanced();
    }
  });

  /* ── META CONVERSION SIGNAL BUTTONS ───────────────── */

  window.signalQualified = async function (leadId) {
    const lead = leadsCache.find((l) => l.id === leadId);
    const phone = lead?.phone || leadId;
    const firstName = (lead?.name || '').split(' ')[0] || '';
    fetch('https://hooks.zapier.com/hooks/catch/27280948/4oqqlje/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, firstName, signal: 'qualified', leadId }),
    }).catch((err) => console.warn('Signal webhook failed:', err));
    if (typeof showToast === 'function') showToast('Sent QUALIFIED signal to Meta');
  };

  window.signalConverted = async function (leadId) {
    const lead = leadsCache.find((l) => l.id === leadId);
    const phone = lead?.phone || leadId;
    const firstName = (lead?.name || '').split(' ')[0] || '';
    fetch('https://hooks.zapier.com/hooks/catch/27280948/4oqqlje/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, firstName, signal: 'converted', leadId }),
    }).catch((err) => console.warn('Signal webhook failed:', err));
    if (typeof showToast === 'function') showToast('Sent CONVERTED signal to Meta');
  };

  window.signalNotInterested = async function (leadId) {
    const lead = leadsCache.find((l) => l.id === leadId);
    const phone = lead?.phone || leadId;
    const firstName = (lead?.name || '').split(' ')[0] || '';
    fetch('https://hooks.zapier.com/hooks/catch/27280948/4oqqlje/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, firstName, signal: 'not_interested', leadId }),
    }).catch((err) => console.warn('Signal webhook failed:', err));
    if (typeof showToast === 'function') showToast('Sent NOT INTERESTED signal to Meta');
  };

  window.signalArchived = async function (leadId) {
    const lead = leadsCache.find((l) => l.id === leadId);
    const phone = lead?.phone || leadId;
    const firstName = (lead?.name || '').split(' ')[0] || '';
    fetch('https://hooks.zapier.com/hooks/catch/27280948/4oqqlje/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, firstName, signal: 'archived', leadId }),
    }).catch((err) => console.warn('Signal webhook failed:', err));
    if (typeof showToast === 'function') showToast('Sent ARCHIVED signal to Meta');
  };

  // Backwards-compat alias — old buttons (if any are still cached) keep working
  window.signalNotQualified = window.signalNotInterested;

  window.EGC_CRM = { PIPELINE, exportCrmBackup, importCrmBackup, getPipelineStatus };
})();
