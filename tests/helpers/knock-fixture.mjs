// Shared setup for canvassing (knock) API tests: configured Hub users, signed session cookies,
// the Firestore REST fake and request builders. Synthetic data only.
import { createHubSessionCookie } from '../../functions/_lib/hub-session.js';
import { createKnockStore } from '../../functions/_lib/knock-store.js';
import { firestoreRest } from './firestore-rest-queries.mjs';
import { DEFAULT_SETTINGS, PACKAGES } from '../../crew/knock-settings.js';

// Synthetic approval only: never use this fixture as a business compensation decision.
export function approvedKnockSettings() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  return { settings, updatedAt: '2026-10-01T12:00:00Z', updatedBy: 'test-owner',
    // Synthetic package classification only, not a production service mapping.
    compensationApproval: { contract: 'knock-collected-v3', reference: 'synthetic-test-only', reviewedBy: 'test-finance', payrollAnchorConfirmed: true,
      collectionPolicy: { earnedOn: 'customer_collection', payoutCadence: 'biweekly', calculationBase: 'eligible_collected_amount',
        attribution: 'recorded_rep', partialCollections: 'review_required', refunds: 'review_required' },
      scope: { service: 'garage_only', channel: 'door_to_door', estimatorStacking: false, garageOnlyPackages: [...PACKAGES], junkRemovalPackages: [] },
      reviewedAt: '2026-10-01T12:00:00Z', commission: structuredClone(settings.commission), payroll: structuredClone(settings.payroll) },
    planApproval: { channel: 'door_to_door', reference: 'synthetic-test-only', reviewedBy: 'test-finance', reviewedAt: '2026-10-01T12:00:00Z',
      plan: structuredClone(settings.plan), gate: structuredClone(settings.gate) } };
}

export const approvedKnockTerms = () => ({ contract: 'knock-v1', approvedAt: '2026-10-01T12:00:00Z', policy: structuredClone(DEFAULT_SETTINGS.commission) });

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
