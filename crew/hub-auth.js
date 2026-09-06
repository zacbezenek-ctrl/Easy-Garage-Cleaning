(function () {
  const KEYS = ['egc_u', 'egc_tok', 'egc_exp', 'egc_name', 'egc_role', 'egc_pay_type', 'egc_hourly_rate', 'egc_business_access'];
  const BUSINESS_USERS = new Set(['zacb', 'tylerg', 'alexk']);

  function remember(user, profile = {}) {
    try {
      for (const storage of [sessionStorage, localStorage]) {
        storage.setItem('egc_u', user);
        storage.setItem('egc_name', profile.displayName || user);
        storage.setItem('egc_role', profile.role || 'crew');
        storage.setItem('egc_pay_type', profile.payType || 'hourly');
        storage.setItem('egc_hourly_rate', String(Number(profile.hourlyRate || 0)));
        storage.setItem('egc_business_access', profile.businessAccess === true ? 'true' : 'false');
        storage.removeItem('egc_tok');
        storage.removeItem('egc_exp');
      }
      const person = document.querySelector('.crew-utility-person');
      if (person) person.textContent = profile.displayName || user;
      const nav = document.querySelector('.crew-utility');
      if (nav) nav.remove();
      if (document.readyState !== 'loading') mountCrewNav();
    } catch {}
  }

  function clearLocal() {
    try {
      for (const storage of [sessionStorage, localStorage]) KEYS.forEach(key => storage.removeItem(key));
    } catch {}
  }

  function showGateError(message) {
    const error = document.getElementById('gate-err') || document.getElementById('gate-error');
    if (!error) return;
    error.textContent = message;
    error.style.display = 'block';
    error.setAttribute('role', 'alert');
  }

  function responseError(data, fallback) {
    const error = new Error(data.error || fallback);
    error.code = data.code || '';
    return error;
  }

  async function ensureFirebaseSession() {
    if (!window.firebase?.auth) throw new Error('Secure employee data could not start. Reload the page and try again.');
    const response = await fetch('/api/firebase-session', { cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.token) throw responseError(data, 'Secure employee data is unavailable. Ask Zac to finish the Hub setup, then retry.');
    try { await firebase.auth().signInWithCustomToken(data.token); }
    catch { throw new Error('Your login was accepted, but secure employee data could not connect. Reload and retry; if it continues, ask Zac to check the Firebase setup.'); }
  }

  async function session() {
    try {
      const response = await fetch('/api/hub-auth', { cache: 'no-store', credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.user) {
        clearLocal();
        if (response.status !== 401) showGateError(data.error || 'The sign-in service is unavailable. Try again shortly.');
        return null;
      }
      await ensureFirebaseSession();
      remember(data.user, data);
      return data.user;
    } catch (error) {
      clearLocal();
      showGateError(error.message || 'Your session could not be checked. Check the connection and retry.');
      return null;
    }
  }

  async function signIn(username, password) {
    if (!String(username || '').trim() || !password) throw new Error('Enter your username and password.');
    const response = await fetch('/api/hub-auth', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok || !data.user) throw responseError(data, response.status === 401 ? 'Incorrect username or password' : 'The sign-in service is unavailable. Try again shortly.');
    try { await ensureFirebaseSession(); }
    catch (error) { clearLocal(); throw error; }
    remember(data.user, data);
    for (const id of ['gate-p', 'pass']) { const input = document.getElementById(id); if (input) input.value = ''; }
    return data.user;
  }

  async function signOut() {
    clearLocal();
    try { await firebase.auth().signOut(); } catch {}
    try { await fetch('/api/hub-auth', { method: 'DELETE', credentials: 'same-origin' }); } catch {}
  }

  async function securedFetch(input, init = {}) {
    const response = await fetch(input, { ...init, credentials: 'same-origin' });
    if (response.status !== 401) return response;
    clearLocal();
    const gate = document.getElementById('egc-gate') || document.getElementById('gate');
    if (gate) {
      gate.classList.remove('off');
      gate.style.display = '';
    }
    const error = document.getElementById('gate-err') || document.getElementById('gate-error');
    if (error) {
      error.textContent = 'Your work is saved. Sign in again to continue.';
      error.style.display = 'block';
    }
    const expired = new Error('Your Hub session expired. Sign in again to continue.');
    expired.code = 'HUB_AUTH_REQUIRED';
    throw expired;
  }

  function profile() {
    const get = key => sessionStorage.getItem(key) || localStorage.getItem(key) || '';
    return {
      user: get('egc_u'),
      displayName: get('egc_name') || get('egc_u'),
      role: get('egc_role') || 'crew',
      payType: get('egc_pay_type') || 'hourly',
      hourlyRate: Math.max(0, Number(get('egc_hourly_rate') || 0)),
      businessAccess: get('egc_business_access') === 'true',
    };
  }

  function canRunBusiness(user = profile().user) {
    return profile().businessAccess === true && BUSINESS_USERS.has(String(user || '').trim().toLowerCase());
  }

  function mountCrewNav() {
    if (document.querySelector('.crew-utility')) return;
    const host = document.getElementById('topbar') || document.querySelector('#app .top');
    if (!host) return;
    const path = location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/crew';
    const links = [
      ['/crew', 'Crew home'],
      ['/crew/gameplan', 'Walkthrough'],
      ['/crew/prejob', 'Pre-job'],
      ['/crew/postjob', 'Closeout'],
      ['/employee', 'My Hub'],
    ].filter(([href]) => href !== '/crew/gameplan' || canRunBusiness());
    const nav = document.createElement('nav');
    nav.className = 'crew-utility';
    nav.setAttribute('aria-label', 'Crew workflow');
    nav.innerHTML = `<div>${links.map(([href, label]) => `<a href="${href}${href === '/employee' ? '?view=my_day' : ''}" ${path === href ? 'aria-current="page"' : ''}>${label}</a>`).join('')}<span class="crew-utility-person"></span></div>`;
    nav.querySelector('.crew-utility-person').textContent = profile().displayName || 'Crew';
    host.insertAdjacentElement('afterend', nav);
  }

  window.addEventListener('DOMContentLoaded', mountCrewNav);

  window.EGCHubAuth = { session, signIn, signOut, fetch: securedFetch, clearLocal, profile, canRunBusiness, mountCrewNav, ensureFirebaseSession };
})();
