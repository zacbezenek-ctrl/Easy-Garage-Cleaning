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

  const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'converted', 'lost'];
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
        if (!confirm('Import will merge records into Firestore. Continue?')) return;
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
    const inbox = leads.filter((l) => !l.respondedAt && (l.crmStatus || 'new') !== 'converted' && (l.crmStatus || 'new') !== 'lost');
    const overdueQuotes = jobs.filter(
      (j) =>
        getPipelineStatus(j) === 'quoted' &&
        j.quoteStatus === 'sent' &&
        j.quoteSentAt &&
        Date.now() - new Date(j.quoteSentAt).getTime() > 2 * 86400000
    );

    el.innerHTML = `
      <div class="dash-greeting">
        <h2>Good ${greetingTime()}, ${esc(me || 'team')}</h2>
        <p class="dash-sub">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      </div>
      <div class="quick-actions">
        <button type="button" class="qa-btn" onclick="openBooking()">+ Job</button>
        <button type="button" class="qa-btn secondary" onclick="openLeadModal()">+ Lead</button>
        <button type="button" class="qa-btn secondary" onclick="switchTab('schedule', document.querySelector('[data-tab=schedule]'))">Block Time</button>
      </div>
      <div class="stats-grid dash-stats">
        <div class="stat"><div class="v" style="color:#60a5fa">${counts.quoted || 0}</div><div class="l">Pending quotes</div></div>
        <div class="stat"><div class="v" style="color:#a78bfa">${counts.scheduled || 0}</div><div class="l">Scheduled</div></div>
        <div class="stat"><div class="v" style="color:#f59e0b">${counts.in_progress || 0}</div><div class="l">In progress</div></div>
        <div class="stat"><div class="v" style="color:#86efac">${counts.completed + counts.paid || 0}</div><div class="l">Done / paid</div></div>
        <div class="stat"><div class="v" style="color:var(--accent)">${inbox.length}</div><div class="l">Leads inbox</div></div>
        <div class="stat"><div class="v" style="color:#86efac">$${rev.toLocaleString()}</div><div class="l">Revenue this week</div></div>
      </div>
      ${overdueQuotes.length ? `<div class="alert-banner">⚠ ${overdueQuotes.length} quote(s) need follow-up — <a href="#" onclick="switchTab('jobs',document.querySelector('[data-tab=jobs]'));return false">View pipeline</a></div>` : ''}
      <div class="dash-section">
        <div class="dash-section-hd"><h3>Today's schedule</h3><span class="muted">${todayJobs.length} job(s)</span></div>
        <div class="dash-list">${todayJobs.length ? todayJobs.map((j) => dashJobRow(j)).join('') : '<div class="empty-inline">No jobs scheduled today.</div>'}</div>
      </div>
      <div class="dash-section">
        <div class="dash-section-hd"><h3>Upcoming</h3></div>
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
      <div class="kc-meta">${esc(j.serviceType || (j.type === 'walkthrough' ? 'Walk-through' : 'Cleanout'))}</div>
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
        ${phone ? `<a class="bsm edit" href="tel:${phone}">📞 Call</a><a class="bsm edit" href="sms:${phone}">💬 Text</a>` : ''}
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
        <div><span class="dl">Duration</span><span>${job.durationMin ? job.durationMin + ' min est.' : '—'}</span></div>
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
      list.innerHTML = `<div class="empty"><div class="ico">👥</div><div>No customers match.</div></div>`;
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
            ${phone ? `<a class="bsm edit" href="tel:${phone}">📞</a><a class="bsm edit" href="sms:${phone}">💬</a>` : ''}
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
        ${phone ? `<a class="bsm edit" href="tel:${phone}">📞 Call</a><a class="bsm edit" href="sms:${phone}">💬 Text</a>` : ''}
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

  /* ── Leads CRM ─────────────────────────────────────── */
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
    document.getElementById('lf-status').value = lead?.crmStatus || 'new';
    modal.classList.add('open');
  };

  window.closeLeadModal = function () {
    document.getElementById('lead-form-modal')?.classList.remove('open');
  };

  window.saveLeadForm = async function () {
    const id = document.getElementById('lf-id').value || uid();
    const data = {
      name: document.getElementById('lf-name').value.trim(),
      phone: document.getElementById('lf-phone').value.trim(),
      email: document.getElementById('lf-email').value.trim(),
      city: document.getElementById('lf-city').value.trim(),
      service: document.getElementById('lf-service').value.trim(),
      timing: document.getElementById('lf-timing').value.trim(),
      message: document.getElementById('lf-message').value.trim(),
      source: document.getElementById('lf-source').value,
      crmStatus: document.getElementById('lf-status').value,
      createdAt: document.getElementById('lf-id').value ? undefined : new Date().toISOString(),
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
    await db.collection('leads').doc(id).update({ crmStatus: status, updatedAt: new Date().toISOString() });
  };

  window.convertLeadToJob = async function (leadId) {
    const lead = leadsCache.find((l) => l.id === leadId);
    if (!lead) return;
    let cust = custsCache.find((c) => c.phone && lead.phone && c.phone === lead.phone);
    if (!cust) {
      const cid = uid();
      cust = {
        id: cid,
        name: lead.name || lead.phone || 'Lead',
        phone: lead.phone || '',
        email: lead.email || '',
        address: '',
        city: lead.city || '',
      };
      await db.collection('customers').doc(cid).set(cust);
    }
    const jobId = uid();
    const flow = leadFlowType(lead);
    const bookingNote = flow === 'booking' ? 'Online booking request — confirm slot from form.' : '';
    const notes = [lead.message || '', bookingNote].filter(Boolean).join('\n');
    await db.collection('jobs').doc(jobId).set({
      id: jobId,
      customer: cust.name,
      phone: cust.phone,
      email: cust.email,
      city: lead.city,
      serviceType: lead.service || 'Garage Cleanout',
      type: 'job',
      pipelineStatus: 'lead',
      status: 'scheduled',
      notes,
      assignedTo: me === 'TylerG' ? 'TylerG' : 'ZacB',
      createdBy: me,
      createdAt: new Date().toISOString(),
      leadId,
    });
    await db.collection('leads').doc(leadId).update({ crmStatus: 'converted', convertedAt: new Date().toISOString() });
    if (typeof showToast === 'function') showToast('Lead converted to job');
    openJobDetail(jobId);
  };

  window.renderLeadsEnhanced = function () {
    const el = document.getElementById('leads-list');
    if (!el || typeof leadsCache === 'undefined') return;
    if (!leadsCache.length) {
      el.innerHTML = `<div class="empty"><div class="ico">📥</div><div>No leads — add manually or via Zapier/Web3forms.</div><button type="button" class="btn-book" style="margin-top:1rem" onclick="openLeadModal()">+ Add lead</button></div>`;
      return;
    }
    el.innerHTML =
      `<div style="margin-bottom:1rem;display:flex;gap:.5rem;flex-wrap:wrap">
        <button type="button" class="btn-book" onclick="openLeadModal()">+ Add lead</button>
      </div>` +
      leadsCache
        .map((lead) => {
          const elapsed = typeof leadElapsed === 'function' ? leadElapsed(lead) : 0;
          const responded = !!lead.respondedAt;
          const remaining = 120 - elapsed;
          const crmSt = lead.crmStatus || 'new';
          let timerClass = 'green',
            timerText = '';
          if (responded) {
            timerClass = 'done';
            timerText = '✓';
          } else {
            if (remaining <= 0) timerClass = 'red';
            else if (remaining <= 60) timerClass = 'yellow';
            timerText = typeof fmtCountdown === 'function' ? fmtCountdown(Math.max(0, remaining)) : '';
          }
          const createdStr = lead.createdAt
            ? new Date(lead.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
            : '';
          const flow = leadFlowType(lead);
          const flowBadge = flow === 'booking' ? ' · <span class="bdg quoted">📅 booking</span>' : flow === 'call_text' ? ' · <span class="bdg">call/text</span>' : '';
          return `<div class="lead-card ${responded ? 'done' : ''}">
            <div class="lead-main">
              <div class="lead-source">${esc(lead.source || 'website')} · <span class="bdg ${crmSt}">${crmSt}</span>${flowBadge}</div>
              <div class="lead-name">${esc(lead.name || lead.full_name || lead.phone || 'Unknown')}</div>
              <div class="lead-meta">${lead.phone ? '📞 ' + esc(lead.phone) : ''} ${lead.city ? '· ' + esc(lead.city) : ''} ${lead.service ? '· ' + esc(lead.service) : ''} · ${createdStr}</div>
              ${lead.message ? `<div class="lead-msg">${esc(lead.message)}</div>` : ''}
              <div class="lead-actions">
                <select onchange="setLeadCrmStatus('${lead.id}', this.value)" style="background:var(--navy);color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:.4rem;padding:.35rem">
                  ${LEAD_STATUSES.map((s) => `<option value="${s}" ${crmSt === s ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
                <button type="button" class="lead-btn" onclick="openLeadModal('${lead.id}')">Edit</button>
                <button type="button" class="lead-btn" onclick="convertLeadToJob('${lead.id}')">→ Job</button>
                ${!responded ? `<button type="button" class="lead-btn" onclick="respondLead('${lead.id}','called')">📞</button>` : ''}
              </div>
            </div>
            <div class="lead-timer ${timerClass}">${timerText}</div>
          </div>`;
        })
        .join('');
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
          <button type="button" class="btn-back" onclick="selectMode('call')">On-call quote flow</button>
        </div>
      </div>
      ${isAdmin ? `<div class="more-section"><h3>Admin</h3>
        <button type="button" class="btn-back" onclick="seedDemoData()">Seed DEMO records</button>
      </div>` : ''}
      <div class="more-section muted small">
        <!-- FUTURE: Web3forms webhook → leads collection
        POST /api/ingest-lead { name, phone, city, service, ... } -->
        Zapier → Firestore <code>leads</code> · Web3forms fields: Name, Phone, City, Service type, Photos, Preferred timing
      </div>`;
  };

  window.seedDemoData = async function () {
    if (!confirm('Add 3 DEMO customers/jobs?')) return;
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
      toggleJobsView(document.querySelector('.view-toggle-btn.active')?.dataset.view || 'board');
      initKanbanDrag();
    }
    if (name === 'schedule' && typeof renderCal === 'function') renderCal();
    if (name === 'leads') renderLeadsEnhanced();
    if (name === 'customers') renderCustomersTabEnhanced();
    if (name === 'payout' && typeof renderPayout === 'function') renderPayout();
    if (name === 'more') renderMorePanel();
  };

  /* ── Enhance refresh / boot ────────────────────────── */
  window.crmRefresh = function () {
    renderDashboard();
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
          closeLeadModal();
          closeQuoteModal();
        }
      },
      true
    );
    ['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, touchSession, { passive: true }));
  });

  window.EGC_CRM = { PIPELINE, exportCrmBackup, importCrmBackup, getPipelineStatus };
})();
