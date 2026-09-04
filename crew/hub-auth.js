(function () {
  const KEYS = ['egc_u', 'egc_tok', 'egc_exp', 'egc_name', 'egc_role', 'egc_pay_type', 'egc_hourly_rate'];
  const BUSINESS_USERS = new Set(['zacb', 'tylerg', 'alexk']);

  function remember(user, profile = {}) {
    try {
      for (const storage of [sessionStorage, localStorage]) {
        storage.setItem('egc_u', user);
        storage.setItem('egc_name', profile.displayName || user);
        storage.setItem('egc_role', profile.role || 'crew');
        storage.setItem('egc_pay_type', profile.payType || 'hourly');
        storage.setItem('egc_hourly_rate', String(Number(profile.hourlyRate || 0)));
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

  async function session() {
    try {
      const response = await fetch('/api/hub-auth', { cache: 'no-store', credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.user) {
        clearLocal();
        return null;
      }
      remember(data.user, data);
      return data.user;
    } catch {
      clearLocal();
      return null;
    }
  }

  async function signIn(username, password) {
    const response = await fetch('/api/hub-auth', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Sign-in failed');
    remember(data.user, data);
    return data.user;
  }

  async function signOut() {
    clearLocal();
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
    };
  }

  function canRunBusiness(user = profile().user) {
    return BUSINESS_USERS.has(String(user || '').trim().toLowerCase());
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
    nav.innerHTML = `<div>${links.map(([href, label]) => `<a href="${href}${href === '/employee' ? '?view=my_day' : ''}" ${path === href ? 'aria-current="page"' : ''}>${label}</a>`).join('')}<span class="crew-utility-person">${profile().displayName || 'Crew'}</span></div>`;
    host.insertAdjacentElement('afterend', nav);
  }

  window.addEventListener('DOMContentLoaded', mountCrewNav);

  window.EGCHubAuth = { session, signIn, signOut, fetch: securedFetch, clearLocal, profile, canRunBusiness, mountCrewNav };
})();
