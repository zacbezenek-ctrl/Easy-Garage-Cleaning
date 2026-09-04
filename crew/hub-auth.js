(function () {
  const KEYS = ['egc_u', 'egc_tok', 'egc_exp', 'egc_name', 'egc_role', 'egc_pay_type', 'egc_hourly_rate'];

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

  window.EGCHubAuth = { session, signIn, signOut, fetch: securedFetch, clearLocal };
})();
