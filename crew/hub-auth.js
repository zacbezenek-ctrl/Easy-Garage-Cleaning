(function () {
  const KEYS = ['egc_u', 'egc_tok', 'egc_exp'];

  function remember(user) {
    try {
      for (const storage of [sessionStorage, localStorage]) {
        storage.setItem('egc_u', user);
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
      remember(data.user);
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
    remember(data.user);
    return data.user;
  }

  async function signOut() {
    clearLocal();
    try { await fetch('/api/hub-auth', { method: 'DELETE', credentials: 'same-origin' }); } catch {}
  }

  window.EGCHubAuth = { session, signIn, signOut, clearLocal };
})();
