(function () {
  const KEYS = ['egc_u', 'egc_tok', 'egc_exp', 'egc_name', 'egc_role', 'egc_pay_type', 'egc_hourly_rate', 'egc_business_access', 'egc_owner', 'egc_capabilities', 'egc_capability_mode'];
  let authVersion = 0;
  let authQueue = Promise.resolve();
  let firebaseQueue = Promise.resolve();

  function interrupted() {
    const error = new Error('Sign-in changed. Please try again.');
    error.code = 'HUB_AUTH_INTERRUPTED';
    return error;
  }

  function serializeAuth(action) {
    const pending = authQueue.then(action);
    authQueue = pending.catch(() => {});
    return pending;
  }

  // Walkthrough price tables kept for offline walkthroughs (crew/walkthrough-pricing.js) belong
  // to the signed-in account: they leave whenever this device forgets that account (sign-out,
  // an expired or failed session check) and when a different account signs in.
  function clearPricing() {
    try { for (let i = localStorage.length - 1; i >= 0; i--) { const name = localStorage.key(i) || ''; if (name.startsWith('egc_walkthrough_pricing.')) localStorage.removeItem(name); } } catch {}
  }
  const account = value => String(value || '').trim().toLowerCase();

  function remember(user, profile = {}) {
    try {
      let previous = '';
      try { previous = localStorage.getItem('egc_u') || ''; } catch {}
      if (account(previous) !== account(user)) clearPricing();
      for (const storage of [sessionStorage, localStorage]) {
        storage.setItem('egc_u', user);
        storage.setItem('egc_name', profile.displayName || user);
        storage.setItem('egc_role', profile.role || 'crew');
        storage.setItem('egc_pay_type', profile.payType || 'hourly');
        storage.setItem('egc_hourly_rate', String(Number(profile.hourlyRate || 0)));
        storage.setItem('egc_business_access', profile.businessAccess === true ? 'true' : 'false');
        storage.setItem('egc_owner', profile.owner === true ? 'true' : 'false');
        storage.setItem('egc_capabilities', JSON.stringify(Array.isArray(profile.capabilities) ? profile.capabilities.filter(item => typeof item === 'string') : []));
        storage.setItem('egc_capability_mode', profile.capabilityMode === 'staff_roles' ? 'staff_roles' : 'legacy');
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
    clearPricing();
  }

  function showGateError(message) {
    const error = document.getElementById('gate-err') || document.getElementById('gate-error') || document.getElementById('login-error');
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

  async function ensureFirebaseSession(version = authVersion) {
    if (!window.firebase?.auth) throw new Error('Secure employee data could not start. Reload the page and try again.');
    const response = await fetch('/api/firebase-session', { cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (version !== authVersion) throw interrupted();
    if (!response.ok || !data.ok || !data.token) throw responseError(data, 'Secure employee data is unavailable. Ask Zac to finish the Hub setup, then retry.');
    const pending = firebaseQueue.then(async () => {
      if (version !== authVersion) throw interrupted();
      try { await firebase.auth().signInWithCustomToken(data.token); }
      catch { throw new Error('Your login was accepted, but secure employee data could not connect. Reload and retry; if it continues, ask Zac to check the Firebase setup.'); }
      if (version !== authVersion) throw interrupted();
    });
    firebaseQueue = pending.catch(() => {});
    await pending;
  }

  async function session() {
    const version = authVersion;
    try {
      await authQueue;
      if (version !== authVersion) return null;
      const response = await fetch('/api/hub-auth', { cache: 'no-store', credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (version !== authVersion) return null;
      if (!response.ok || !data.ok || !data.user) {
        clearLocal();
        if (response.status !== 401) showGateError(data.error || 'The sign-in service is unavailable. Try again shortly.');
        return null;
      }
      await ensureFirebaseSession(version);
      if (version !== authVersion) return null;
      remember(data.user, data);
      return data.user;
    } catch (error) {
      if (version !== authVersion) return null;
      clearLocal();
      showGateError(error.message || 'Your session could not be checked. Check the connection and retry.');
      return null;
    }
  }

  async function signIn(username, password) {
    if (!String(username || '').trim() || !password) throw new Error('Enter your username and password.');
    const version = ++authVersion;
    return serializeAuth(async () => {
    if (version !== authVersion) throw interrupted();
    const response = await fetch('/api/hub-auth', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (version !== authVersion) throw interrupted();
    if (!response.ok || !data.ok || !data.user) throw responseError(data, response.status === 401 ? 'Incorrect username or password' : 'The sign-in service is unavailable. Try again shortly.');
    try { await ensureFirebaseSession(version); }
    catch (error) { if (version === authVersion) clearLocal(); throw error; }
    if (version !== authVersion) throw interrupted();
    remember(data.user, data);
    for (const id of ['gate-p', 'pass']) { const input = document.getElementById(id); if (input) input.value = ''; }
    return data.user;
    });
  }

  // Photos from Today's work still waiting on this phone (crew/field-outbox.js),
  // counted or, with remove, deleted along with the retired draft store. Where
  // the browser lists its databases, a device without one is not given one.
  async function fieldPhotos(remove = false) {
    const scan = (name, storeName, key, match) => new Promise(resolve => {
      const open = indexedDB.open(name);
      open.onupgradeneeded = () => open.result.createObjectStore(storeName, { keyPath: key });
      open.onerror = open.onblocked = () => resolve(0);
      open.onsuccess = () => {
        const db = open.result, done = count => { db.close(); resolve(count); };
        try { const tx = db.transaction(storeName, remove ? 'readwrite' : 'readonly'), store = tx.objectStore(storeName), rows = store.getAll(); let count = 0; rows.onsuccess = () => rows.result.forEach(row => { if (match(row)) { count++; if (remove) store.delete(row[key]); } }); tx.oncomplete = () => done(count); tx.onabort = tx.onerror = () => done(0); } catch { done(0); }
      };
    });
    try {
      if (remove) indexedDB.deleteDatabase('egc-field-photo-drafts');
      const names = indexedDB.databases ? (await indexedDB.databases()).map(db => db.name) : null;
      return (!names || names.includes('egc-field-outbox') ? await scan('egc-field-outbox', 'actions', 'requestId', row => row?.payload?.action === 'photo') : 0) + (!remove && names?.includes('egc-field-photo-drafts') ? await scan('egc-field-photo-drafts', 'photos', 'id', Boolean) : 0);
    } catch { return 0; }
  }

  // A sign-out the person chooses deletes those photos, so it asks first.
  async function confirmSignOut() {
    const photos = await fieldPhotos();
    return !photos || window.confirm(`${photos} photo${photos === 1 ? ' has' : 's have'} not uploaded and will be deleted. Sign out anyway?`);
  }

  // explicit: the person chose to sign out, so photos from Today's work that
  // have not uploaded are private evidence to delete. A session that merely
  // ended keeps them for the next sign-in.
  async function signOut({ explicit = false } = {}) {
    ++authVersion;
    clearLocal();
    // Today's work keeps offline copies per tab; a sign-out retires them on this device.
    try { localStorage.setItem('egc-field:signed-out-at', String(Date.now())); } catch {}
    try { for (let i = sessionStorage.length - 1; i >= 0; i--) { const name = sessionStorage.key(i) || ''; if (name === 'egc-field:viewer' || /^egc-field:.*:(snapshot|shift-snapshot)$/.test(name)) sessionStorage.removeItem(name); } } catch {}
    if (explicit === true) { try { localStorage.setItem('egc-field:photos-cleared-at', String(Date.now())); } catch {} fieldPhotos(true); }
    return serializeAuth(async () => {
      const pending = firebaseQueue.then(async () => { try { await firebase.auth().signOut(); } catch {} });
      firebaseQueue = pending.catch(() => {});
      await pending;
      try { await fetch('/api/hub-auth', { method: 'DELETE', credentials: 'same-origin' }); } catch {}
    });
  }

  async function securedFetch(input, init = {}) {
    const version = authVersion;
    const response = await fetch(input, { ...init, credentials: 'same-origin' });
    if (response.status !== 401) return response;
    if (version !== authVersion) throw interrupted();
    ++authVersion;
    clearLocal();
    const gate = document.getElementById('egc-gate') || document.getElementById('gate') || document.getElementById('login-screen');
    if (gate) {
      gate.classList.remove('off');
      gate.style.display = '';
    }
    showGateError('Your session expired. Sign in again to continue.');
    window.dispatchEvent(new Event('egc:session-expired'));
    const expired = new Error('Your Hub session expired. Sign in again to continue.');
    expired.code = 'HUB_AUTH_REQUIRED';
    throw expired;
  }

  function capabilities(value) {
    try { const list = JSON.parse(value || '[]'); return Array.isArray(list) ? list.filter(item => typeof item === 'string') : []; } catch { return []; }
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
      owner: get('egc_owner') === 'true',
      capabilities: capabilities(get('egc_capabilities')),
    };
  }

  // Capabilities come from /api/hub-auth for display only; every API re-checks them.
  function can(capability) {
    return profile().capabilities.includes(capability);
  }

  // The server grants business access to the signed-in account; no staff names live here.
  function canRunBusiness(user = profile().user) {
    const current = profile(), signedIn = String(current.user || '').trim().toLowerCase();
    return current.businessAccess === true && Boolean(signedIn) && String(user || '').trim().toLowerCase() === signedIn;
  }

  // P2-12: the walkthrough also opens for an account the server reports can author
  // quotes (sales/walkthrough role); /api/walkthrough-handoff and /api/quote-draft re-check it.
  function canRunWalkthrough(user = profile().user) {
    const current = profile(), signedIn = String(current.user || '').trim().toLowerCase();
    if (!signedIn || String(user || '').trim().toLowerCase() !== signedIn) return false;
    return canRunBusiness(user) || current.capabilities.includes('quotes.author');
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
    ].filter(([href]) => href !== '/crew/gameplan' || canRunWalkthrough());
    const nav = document.createElement('nav');
    nav.className = 'crew-utility';
    nav.setAttribute('aria-label', 'Crew workflow');
    nav.innerHTML = `<div>${links.map(([href, label]) => `<a href="${href}${href === '/employee' ? '?view=my_day' : ''}" ${path === href ? 'aria-current="page"' : ''}>${label}</a>`).join('')}<span class="crew-utility-person"></span></div>`;
    nav.querySelector('.crew-utility-person').textContent = profile().displayName || 'Crew';
    host.insertAdjacentElement('afterend', nav);
  }

  window.addEventListener('DOMContentLoaded', mountCrewNav);

  window.EGCHubAuth = { session, signIn, signOut, confirmSignOut, fetch: securedFetch, clearLocal, profile, can, canRunBusiness, canRunWalkthrough, mountCrewNav, ensureFirebaseSession };
})();
