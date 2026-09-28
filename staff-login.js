// Staff sign-in (/staff-login) and the safe return used by the crew sign-in (/crew/). Signing in goes through
// EGCHubAuth.signIn (crew/hub-auth.js); the page then returns only to a `next` that is in the staff-paths.js list.
import { safeStaffNext } from './staff-paths.js?v=20260928gate';

const FIREBASE = { apiKey: 'AIzaSyA8g4UAW4P4bsCrQNZhUe81CbC7BvjJbNc', authDomain: 'egcw-1ec83.firebaseapp.com', projectId: 'egcw-1ec83', storageBucket: 'egcw-1ec83.firebasestorage.app', messagingSenderId: '763340109795', appId: '1:763340109795:web:ac203b3eb71831fa4ed2d6' };
const GUARD = 'egc.staffNext.v1', GUARD_MS = 10000;

function nextTarget(search = location.search) {
  return safeStaffNext(new URLSearchParams(search).get('next') || '');
}

function remember(next) {
  try { sessionStorage.setItem(GUARD, JSON.stringify({ next, at: Date.now() })); return true; } catch { return false; }
}

function recentlyForwarded(next) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(GUARD) || 'null'), age = Date.now() - Number(saved?.at);
    return saved?.next === next && age >= 0 && age < GUARD_MS;
  } catch { return true; }
}

function forward(next) {
  remember(next);
  location.replace(next);
}

// A link followed from another site (webmail, a calendar) arrives without the SameSite=Strict session cookie, so the edge
// sends a signed-in viewer here. Continue once; never bounce between this page and a page that keeps refusing.
function resume(next) {
  if (!next || recentlyForwarded(next) || !remember(next)) return false;
  location.replace(next);
  return true;
}

// crew/index.html calls resume() when its session is already valid and go() after its own sign-in; it stays on the crew
// home when `next` is missing or unsafe.
window.EGCStaffNext = Object.freeze({
  target: nextTarget,
  go() { const next = nextTarget(); if (next) forward(next); return Boolean(next); },
  resume() { return resume(nextTarget()); },
});

async function signedIn() {
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
    const response = await fetch('/api/hub-auth', { cache: 'no-store', credentials: 'same-origin', signal });
    const data = await response.json().catch(() => ({}));
    return response.ok && data.ok === true && Boolean(data.user);
  } catch { return false; }
}

async function mount(form) {
  try { if (window.firebase && !firebase.apps.length) firebase.initializeApp(FIREBASE); } catch {}
  const requested = nextTarget(), next = requested || '/employee';
  const error = document.getElementById('login-error'), button = document.getElementById('sl-submit'), note = document.getElementById('sl-next');
  if (requested) {
    const path = document.createElement('strong');
    path.textContent = requested.split('?')[0];
    note.replaceChildren('After signing in you will return to ', path, '.');
    note.hidden = false;
  }
  const busy = (on, label) => { button.disabled = on; button.setAttribute('aria-busy', on ? 'true' : 'false'); button.textContent = label; };
  const fail = message => { error.textContent = message; error.hidden = false; };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    error.hidden = true;
    busy(true, 'Signing in…');
    try {
      if (!window.EGCHubAuth) throw new Error('The sign-in service is unavailable. Try again shortly.');
      await window.EGCHubAuth.signIn(form.elements.username.value.trim(), form.elements.password.value);
      busy(true, 'Opening…');
      forward(next);
    } catch (problem) {
      fail(problem?.message || 'Unable to sign in. Check the connection and try again.');
      busy(false, 'Sign in');
    }
  });
  busy(true, 'Checking…');
  if (await signedIn()) {
    if (resume(next)) { busy(true, 'Opening…'); return; }
    fail('Your session could not open that page. Sign in again to continue.');
  }
  busy(false, 'Sign in');
}

const form = document.getElementById('staff-login');
if (form) mount(form);
