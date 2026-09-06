'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const password = byId('password');
  const confirmation = byId('confirmation');
  const generate = byId('generate');
  const clear = byId('clear');
  const results = byId('results');
  const sessionValue = byId('session-value');
  const usersValue = byId('users-value');
  const status = byId('status');
  let generation = 0;

  function announce(message, kind = '') {
    status.textContent = message;
    status.className = `status ${kind}`;
  }

  function base64url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function credentialHash(value) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const encoded = new TextEncoder().encode(value);
    const key = await crypto.subtle.importKey('raw', encoded, 'PBKDF2', false, ['deriveBits']);
    encoded.fill(0);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210000 },
      key,
      256
    );
    return `pbkdf2-sha256$210000$${base64url(salt)}$${base64url(new Uint8Array(bits))}`;
  }

  function clearFields() {
    password.value = '';
    confirmation.value = '';
    password.removeAttribute('aria-invalid');
    confirmation.removeAttribute('aria-invalid');
  }

  function clearOutputs() {
    sessionValue.value = '';
    usersValue.value = '';
    results.hidden = true;
  }

  generate.addEventListener('click', async () => {
    password.removeAttribute('aria-invalid');
    confirmation.removeAttribute('aria-invalid');
    if (!globalThis.crypto?.subtle) {
      announce('This browser cannot generate the values here. Open this page over HTTPS in a current browser.', 'error');
      return;
    }
    if (password.value.length < 12) {
      password.setAttribute('aria-invalid', 'true');
      announce('Enter a password with at least 12 characters.', 'error');
      password.focus();
      return;
    }
    if (password.value !== confirmation.value) {
      confirmation.setAttribute('aria-invalid', 'true');
      announce('The passwords do not match. Enter the same password in both fields.', 'error');
      confirmation.focus();
      return;
    }

    const currentGeneration = ++generation;
    generate.disabled = true;
    generate.textContent = 'Generating locally…';
    clearOutputs();
    announce('Creating your setup values in this browser…');
    try {
      const pendingHash = credentialHash(password.value);
      clearFields();
      const passwordHash = await pendingHash;
      if (generation !== currentGeneration) return;
      sessionValue.value = base64url(crypto.getRandomValues(new Uint8Array(32)));
      usersValue.value = JSON.stringify({
        ZacB: { passwordHash, displayName: 'Zac', role: 'owner' }
      }, null, 2);
      results.hidden = false;
      announce('Values generated. Your password fields are cleared. Cloudflare and Firebase still need to be configured.', 'success');
      results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch {
      if (generation !== currentGeneration) return;
      clearFields();
      clearOutputs();
      announce('The browser could not generate the values. No settings changed. Re-enter your password and try again.', 'error');
    } finally {
      if (generation === currentGeneration) {
        generate.disabled = false;
        generate.textContent = 'Generate setup values';
      }
    }
  });

  async function copyValue(field, name) {
    if (!field.value) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(field.value);
      announce(`${name} copied. Paste it into the matching Cloudflare secret.`, 'success');
    } catch {
      field.focus();
      field.select();
      field.setSelectionRange(0, field.value.length);
      announce(`${name} selected. Press Ctrl+C on Windows or Command+C on Mac to copy.`, '');
    }
  }

  byId('copy-session').addEventListener('click', () => copyValue(sessionValue, 'HUB_SESSION_SECRET'));
  byId('copy-users').addEventListener('click', () => copyValue(usersValue, 'HUB_AUTH_USERS_JSON'));

  clear.addEventListener('click', () => {
    generation += 1;
    clearFields();
    clearOutputs();
    generate.disabled = false;
    generate.textContent = 'Generate setup values';
    announce('Password fields and generated values cleared from this page.');
    password.focus();
  });

  window.addEventListener('pagehide', () => {
    generation += 1;
    clearFields();
    clearOutputs();
    generate.disabled = false;
    generate.textContent = 'Generate setup values';
    announce('');
  });
})();
