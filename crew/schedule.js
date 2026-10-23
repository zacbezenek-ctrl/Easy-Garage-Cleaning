(function () {
  'use strict';
  // CREW-SCHEDULE (WP6, owner decision D6 2026-10-17): the crew's own schedule, read only, from /api/crew-schedule.
  // An estimator's own walkthroughs show too, labelled Walkthrough, and open the game plan for that visit (D2D-BOARD).
  // Today or the next 7 days, per day: time, customer first name and city, crew and lead. A row opens the job page only
  // when the server says this viewer may open it (canOpen). A team lead, manager or owner (schedule.view: the role, or
  // business access) reads every crew and picks a crew; everyone else reads their own crews. Nothing here is stored on
  // the phone except the chosen view (range and crew) and whether this person last read every crew, in this browser.
  const API = '/api/crew-schedule', TIMEOUT = 30000, TZ = 'America/Denver', PREF = 'egc.crew-schedule.v1';
  const DATE = /^\d{4}-\d{2}-\d{2}$/, ID = /^[A-Za-z0-9_-]{1,180}$/, OFFLINE = 'You’re offline. The crew schedule loads when you reconnect.';
  const S = { range: 'today', crew: 'all', scope: '', viewsAll: '', data: null, loading: false, error: '', signedOut: false, disabled: false, seq: 0, loadedAt: '' };
  const main = document.getElementById('schedule-main');

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false).map(child => typeof child === 'string' ? document.createTextNode(child) : child));
    return node;
  }
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const dayLabel = (date, options = { weekday: 'long', month: 'short', day: 'numeric' }) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(new Date(`${date}T12:00:00Z`)); } catch { return date; } };
  const clock = time => { const m = /^(\d{2}):(\d{2})/.exec(time || ''); return m ? `${Number(m[1]) % 12 || 12}:${m[2]} ${Number(m[1]) < 12 ? 'AM' : 'PM'}` : ''; };
  const shownDates = () => { const from = today(); return { from, to: S.range === 'week' ? addDays(from, 6) : from }; };
  const offline = () => navigator.onLine === false;
  const signedUser = () => { try { return String(window.EGCHubAuth?.profile?.()?.user || '').trim().toLowerCase(); } catch { return ''; } };
  // Display hint only, so the first read asks for the right scope; the server decides. crew/hub-auth.js keeps the
  // capabilities /api/hub-auth reported (schedule.view is listed only with EGC_STAFF_ROLE_ACCESS on), and this browser
  // remembers who last read every crew here, so a team lead's later opens make one read, not two.
  function viewsAllHint() {
    try { const profile = window.EGCHubAuth?.profile?.(); return Boolean(profile && (profile.businessAccess === true || (profile.capabilities || []).includes('schedule.view') || S.viewsAll && S.viewsAll === signedUser())); } catch { return false; }
  }
  function readPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(PREF) || 'null');
      if (saved && ['today', 'week'].includes(saved.range)) S.range = saved.range;
      if (saved && typeof saved.crew === 'string' && saved.crew.length <= 200) S.crew = saved.crew;
      if (saved && typeof saved.viewsAll === 'string' && saved.viewsAll.length <= 120) S.viewsAll = saved.viewsAll;
    } catch { /* Defaults apply. */ }
  }
  function savePrefs() { try { localStorage.setItem(PREF, JSON.stringify({ range: S.range, crew: S.crew, ...(S.viewsAll ? { viewsAll: S.viewsAll } : {}) })); } catch { /* The view still works; it is not remembered. */ } }

  const rowOk = row => Boolean(row) && ID.test(row.id || '') && Array.isArray(row.days) && row.days.every(day => DATE.test(day)) && typeof row.canOpen === 'boolean' && typeof row.mine === 'boolean';
  const valid = data => Boolean(data) && data.ok === true && ['mine', 'all'].includes(data.scope) && DATE.test(data.from || '') && DATE.test(data.to || '') && Boolean(data.viewer) && typeof data.viewer.canViewAll === 'boolean'
    && Array.isArray(data.groups) && data.groups.every(group => group?.crew && ID.test(group.crew.id || '') && Array.isArray(group.jobs) && group.jobs.every(rowOk)) && Array.isArray(data.unassigned) && data.unassigned.every(rowOk);

  async function request(scope) {
    const { from, to } = shownDates(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT);
    let response;
    try { response = await fetch(`${API}?from=${from}&to=${to}&scope=${scope}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }); }
    catch { throw Object.assign(new Error('The schedule did not load. Check your connection, then try again.'), { status: 0 }); }
    finally { clearTimeout(timer); }
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.ok !== true) throw Object.assign(new Error(data?.error || 'The crew schedule is unavailable right now. Try again shortly.'), { status: response.status, code: data?.code || '' });
    if (!valid(data)) throw Object.assign(new Error('The schedule answer was incomplete. Try again.'), { status: 502 });
    return data;
  }

  async function load() {
    if (!main) return;
    const seq = ++S.seq;
    S.loading = true; S.error = ''; S.startedAt = Date.now(); render();
    if (offline()) { S.loading = false; S.error = OFFLINE; render(); return; }
    let scope = S.scope || (viewsAllHint() ? 'all' : 'mine'), data = null, error = null;
    try { data = await request(scope); }
    catch (failure) {
      // A stale hint: the server refused every crew, so read this person's own crews instead.
      if (scope === 'all' && failure.status === 403) { scope = 'mine'; try { data = await request(scope); } catch (second) { error = second; } }
      else error = failure;
    }
    if (seq !== S.seq) return;
    S.loading = false;
    if (data) {
      S.data = data; S.scope = data.viewer.canViewAll ? 'all' : 'mine'; S.signedOut = false; S.disabled = false; S.loadedAt = new Date().toISOString();
      const viewsAll = data.viewer.canViewAll ? signedUser() : '';
      if (viewsAll !== S.viewsAll) { S.viewsAll = viewsAll; savePrefs(); }
      if (data.scope !== S.scope) return load();
    } else {
      // EGC_CREW_SCHEDULE=false: the schedule is off; say so once, with nothing to retry.
      S.signedOut = error.status === 401; S.disabled = error.code === 'crew_schedule_disabled'; S.error = error.message; if (S.signedOut || S.disabled) S.data = null;
    }
    render();
  }

  // The crews this viewer can pick between, from the loaded answer.
  function choices(data) {
    const options = [['all', data.scope === 'all' ? 'All crews' : 'All my crews']];
    if (data.scope === 'all' && (data.groups.some(group => group.crew.mine) || [...data.groups.flatMap(group => group.jobs), ...data.unassigned].some(row => row.mine))) options.push(['mine', 'Mine']);
    for (const group of data.groups) options.push([group.crew.id, group.crew.name || 'Crew']);
    if (data.unassigned.length) options.push(['none', data.scope === 'all' ? 'Not on a crew' : 'My other jobs']);
    return options;
  }
  // [crew or null, row] pairs in view for the chosen crew.
  function visible(data) {
    const pairs = [...data.groups.flatMap(group => group.jobs.map(row => [group.crew, row])), ...data.unassigned.map(row => [null, row])];
    if (S.crew === 'all') return pairs;
    if (S.crew === 'mine') return pairs.filter(([crew, row]) => row.mine || crew?.mine);
    if (S.crew === 'none') return pairs.filter(([crew]) => !crew);
    return pairs.filter(([crew]) => crew?.id === S.crew);
  }

  function badge(text, kind = '') { return h('em', { class: `badge ${kind}`.trim() }, text); }
  // LIVE-STATUS: en route, on site and the crew's own marks, on today's row only. The server sends fieldStatus only for
  // work the crew marked today, so a multi-day job marked on site yesterday shows nothing until it is marked again.
  const LIVE = { dispatched: ['En route', 'live'], arrived: ['On site', 'live'], paused: ['Paused', 'warn'], waiting: ['Waiting', 'warn'], delayed: ['Delayed', 'warn'], day_ended: ['Day ended', 'done'] };
  function jobRow(crew, row, day) {
    const continuing = row.date && row.date < day, multi = row.endDate && row.date && row.endDate > row.date;
    // A multi-day job runs on from its first day: later days show when it ends, or All day in between.
    const time = continuing ? row.endDate === day && row.endTime ? `Until ${clock(row.endTime)}` : 'All day'
      : row.time ? `${clock(row.time)}${row.endTime && row.endDate === day ? `–${clock(row.endTime)}` : ''}` : 'Time TBD';
    const who = [row.customer || 'Customer', row.area].filter(Boolean).join(' · ');
    // D2D-BOARD: an estimator's own walkthrough is a Walkthrough row that opens its game plan; it has no crew.
    const visit = row.type === 'walkthrough';
    const detail = visit ? ['Walkthrough', row.serviceType].filter(Boolean).join(' · ') : [row.serviceType, crew?.name || row.crewName || (row.crewSize ? '' : 'No crew yet'), row.lead ? `Lead: ${row.lead}` : ''].filter(Boolean).join(' · ');
    const status = String(row.status || ''), live = !visit && day === today() && Object.prototype.hasOwnProperty.call(LIVE, row.fieldStatus || '') ? LIVE[row.fieldStatus] : null;
    const badges = [visit ? badge('Walkthrough', 'visit') : null, row.mine ? badge(visit ? 'Your walkthrough' : 'You’re on this job', 'you') : null, live ? badge(live[0], live[1]) : status === 'in_progress' ? badge('In progress', 'live') : null,
      ['completed', 'invoiced', 'paid', 'review_requested'].includes(status) ? badge('Done', 'done') : null,
      !visit && row.crewSize < row.crewNeeded ? badge(row.crewSize ? `Needs ${row.crewNeeded - row.crewSize} more` : 'Needs crew', 'warn') : null,
      multi ? badge(continuing ? `Continues · through ${dayLabel(row.endDate, { weekday: 'short' })}` : `Multi-day · through ${dayLabel(row.endDate, { weekday: 'short', month: 'short', day: 'numeric' })}`) : null].filter(Boolean);
    const body = [h('time', {}, time, row.arrivalWindow && !continuing ? h('small', {}, `Arrive ${row.arrivalWindow}`) : null),
      h('span', { class: 'who' }, h('strong', {}, who), h('small', {}, detail), badges.length ? h('span', { class: 'badges' }, badges) : null)];
    if (row.canOpen) return h('a', { class: 'job-row', href: visit ? `/crew/gameplan.html?walkthroughId=${encodeURIComponent(row.id)}` : `/crew/job.html?jobId=${encodeURIComponent(row.id)}`, 'data-job': row.id, ...(visit ? { 'data-type': 'walkthrough', 'aria-label': `Open the game plan for the walkthrough at ${time} with ${who}` } : {}) }, ...body, h('b', { 'aria-hidden': 'true' }, '→'));
    return h('div', { class: 'job-row locked', 'data-job': row.id }, ...body, h('small', { class: 'lock-note' }, 'Not on your assignment'));
  }

  function dayBlock(day, pairs) {
    const rows = pairs.filter(([, row]) => row.days.includes(day)).sort(([, a], [, b]) => `${a.date < day ? '00:00' : a.time || '99:99'}`.localeCompare(`${b.date < day ? '00:00' : b.time || '99:99'}`) || a.id.localeCompare(b.id));
    const crews = new Map();
    for (const pair of rows) { const key = pair[1].type === 'walkthrough' ? 'walkthroughs' : pair[0]?.id || 'none'; if (!crews.has(key)) crews.set(key, []); crews.get(key).push(pair); }
    const split = crews.size > 1;
    return h('section', { class: 'day', 'data-day': day },
      h('h2', {}, dayLabel(day), day === today() ? h('small', {}, 'Today') : null),
      !rows.length ? h('p', { class: 'empty' }, 'No crew jobs.') : split
        ? [...crews.entries()].map(([key, list]) => h('div', { class: 'crew-block' }, h('h3', {}, key === 'walkthroughs' ? 'Your walkthroughs' : list[0][0] ? `${list[0][0].name}${list[0][0].lead ? ` · Lead: ${list[0][0].lead}` : ''}` : 'Not on a crew'), h('div', { class: 'job-list' }, list.map(([crew, row]) => jobRow(crew, row, day)))))
        : h('div', { class: 'job-list' }, rows.map(([crew, row]) => jobRow(crew, row, day))));
  }

  function controls(data) {
    const range = h('div', { class: 'seg', role: 'group', 'aria-label': 'Days' }, [['today', 'Today'], ['week', 'This week']].map(([value, label]) =>
      h('button', { type: 'button', 'data-range': value, 'aria-pressed': String(S.range === value), disabled: S.loading, onclick: () => { if (S.range === value) return; S.range = value; savePrefs(); load(); } }, label)));
    const options = data ? choices(data) : [];
    if (data && !options.some(([value]) => value === S.crew)) S.crew = 'all';
    const crew = options.length > 2 || data?.scope === 'all' ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Crew' }, options.map(([value, label]) =>
      h('button', { type: 'button', 'data-crew': value, 'aria-pressed': String(S.crew === value), onclick: () => { S.crew = value; savePrefs(); render(); } }, label))) : null;
    return h('div', { class: 'controls' }, range, crew);
  }

  function render() {
    if (!main) return;
    const data = S.data, { from, to } = data || shownDates(), nodes = [];
    if (window.EGCHubAuth?.profile?.()?.capabilities?.includes('jobs.operate')) nodes.push(h('a', { class: 'btn primary', href: '/crew/job-operations' }, 'Manage jobs across crews'));
    nodes.push(h('div', { class: 'eyebrow' }, 'Crew schedule'), h('h1', {}, data?.scope === 'all' ? 'Every crew' : 'My crew’s schedule'),
      h('p', { class: 'sub' }, from === to ? dayLabel(from) : `${dayLabel(from, { weekday: 'short', month: 'short', day: 'numeric' })} – ${dayLabel(to, { weekday: 'short', month: 'short', day: 'numeric' })}`, ' · Mountain Time'));
    if (S.signedOut) {
      nodes.push(h('section', { class: 'card' }, h('h2', {}, 'Sign in first'), h('p', {}, 'Sign in to the crew app, then come back to the schedule.'), h('a', { class: 'btn primary', href: '/crew/?next=%2Fcrew%2Fschedule' }, 'Sign in')));
      main.replaceChildren(...nodes); return;
    }
    if (S.disabled) {
      nodes.push(h('section', { class: 'card', role: 'status' }, h('h2', {}, 'Schedule is off'), h('p', {}, S.error), h('a', { class: 'btn primary', href: '/crew/' }, 'Back to crew home')));
      main.replaceChildren(...nodes); return;
    }
    nodes.push(controls(data));
    if (S.error) nodes.push(h('div', { class: 'notice', role: 'alert' }, h('p', {}, S.error), h('button', { type: 'button', class: 'btn', onclick: load }, 'Try again')));
    if (S.loading && !data) nodes.push(h('p', { class: 'load-note', role: 'status' }, 'Loading the schedule…'));
    if (data) {
      const pairs = visible(data), days = [];
      for (let day = data.from; day <= data.to; day = addDays(day, 1)) days.push(day);
      if (!data.groups.length && !data.unassigned.length && data.scope === 'mine') nodes.push(h('p', { class: 'load-note' }, 'You are not on a crew yet and have no crew jobs in these days. Your manager adds you to a crew in Dispatch.'));
      nodes.push(h('div', { class: 'days' }, days.map(day => dayBlock(day, pairs))));
      nodes.push(h('p', { class: 'stamp' }, S.loading ? 'Refreshing…' : `Updated ${new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(S.loadedAt || Date.now()))}`, ' ', h('button', { type: 'button', class: 'link', disabled: S.loading, onclick: load }, 'Refresh')));
    }
    main.replaceChildren(...nodes);
  }

  let workerStarted = false;
  async function registerWorker() {
    if (workerStarted || !('serviceWorker' in navigator)) return;
    workerStarted = true;
    try {
      const config = await fetch('/crew/sw-config.json', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.ok ? response.json() : {}, () => ({}));
      if (config?.enabled === false) { for (const registration of await navigator.serviceWorker.getRegistrations()) if (new URL(registration.scope).pathname.startsWith('/crew/')) await registration.unregister(); return; }
      await navigator.serviceWorker.register('/crew/sw.js', { scope: '/crew/' });
    } catch { /* Offline reloads need the worker; online use works without it. */ }
  }

  // READ-BUDGET: back online, a schedule loaded less than ONLINE_REFRESH_MS ago for these same days only drops the
  // offline notice, so a phone whose signal comes and goes in a garage does not read the schedule again each time. One
  // that is older, for other days, still loading, failed or never loaded is read again, as before; Refresh always reads.
  const ONLINE_REFRESH_MS = 5 * 60000;
  function reconnected() {
    const age = Date.now() - Date.parse(S.loadedAt || ''), { from, to } = shownDates();
    if (S.loading || !S.data || S.error && S.error !== OFFLINE || S.data.from !== from || S.data.to !== to || !(age >= 0 && age < ONLINE_REFRESH_MS)) return load();
    S.error = ''; render();
  }

  // LIVE-STATUS: while the page is visible, it reads again every 3 minutes, so the badges keep up with the crews; a
  // hidden tab or an offline phone never reads. The age counts from when the last read started, so a slow answer does
  // not push the next read a whole interval later. Past Denver midnight the shown days no longer hold today: the next
  // tick reads the new days at once. Back from hidden, an answer that old is read again at once.
  const LIVE_REFRESH_MS = 3 * 60000;
  function liveRefresh(minAge = LIVE_REFRESH_MS / 2) {
    const { from, to } = shownDates(), age = Date.now() - (S.startedAt || 0), stale = !S.data || S.data.from !== from || S.data.to !== to;
    if (document.hidden || S.loading || offline() || S.signedOut || S.disabled || !S.data && !S.error) return;
    if (stale || age >= minAge) load();
  }

  readPrefs();
  setInterval(() => liveRefresh(), LIVE_REFRESH_MS);
  document.addEventListener('visibilitychange', () => liveRefresh(LIVE_REFRESH_MS));
  addEventListener('online', reconnected);
  addEventListener('offline', () => { if (!S.loading) { S.error = OFFLINE; render(); } });
  window.EGCCrewSchedule = { load, state: S };
  load();
  registerWorker();
})();
