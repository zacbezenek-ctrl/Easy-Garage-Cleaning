// Shared setup for canvassing (knock) API tests: configured Hub users, signed session cookies,
// the Firestore REST fake and request builders. Synthetic data only.
import { createHubSessionCookie } from '../../functions/_lib/hub-session.js';
import { createKnockStore } from '../../functions/_lib/knock-store.js';
import { firestoreRest } from './firestore-rest-queries.mjs';

export const ORIGIN = 'https://easygaragecleaning.com';

export const knockEnv = (extra = {}) => ({
  HUB_SESSION_SECRET: 'knock-test-session-secret-0123456789abcdef0123',
  FIREBASE_API_KEY: 'firebase-test-knock',
  HUB_AUTH_USERS_JSON: JSON.stringify({
    ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Zac' },
    'Rep.One': { passwordHash: 'test', role: 'sales', displayName: 'Rep One' },
    'Rep.Two': { passwordHash: 'test', role: 'sales', displayName: 'Rep Two' },
    'Lead.One': { passwordHash: 'test', role: 'sales', displayName: 'Lead One' },
  }),
  ...extra,
});

export async function cookieFor(env, user) {
  return (await createHubSessionCookie(env, user)).split(';')[0];
}

export function knockWorld(seed = {}) {
  const fake = firestoreRest(seed);
  return { fake, storage: env => createKnockStore(env, fake.fetcher) };
}

export function get(path, cookie) {
  return new Request(ORIGIN + path, { headers: cookie ? { Cookie: cookie } : {} });
}

export function post(path, body, cookie, { origin = ORIGIN } = {}) {
  return new Request(ORIGIN + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

export async function call(handler, request, env) {
  const response = await handler({ request, env });
  return { status: response.status, body: await response.json() };
}

let counter = 0;
export const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
