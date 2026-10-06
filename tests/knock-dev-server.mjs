// Local preview of the canvassing page with synthetic data and an in-memory Firestore fake.
// Nothing here reaches production: Firestore calls are answered in memory.
//   node tests/knock-dev-server.mjs [--port 8787] [--now 2026-10-06T17:00:00Z] [--houses houses.json]
// Users (password "Synthetic knock preview!"): ZacB (owner/admin), Rep.One (active, permit, English Ranch),
// Rep.Two (pending), Lead.One (active lead).
import { readFileSync } from 'node:fs';
import { createHubServer, hubUsers } from './helpers/emulator-harness.mjs';
import { firestoreRest } from './helpers/firestore-rest-queries.mjs';
import { seedNeighborhoodDocs } from '../functions/_lib/knock-seed.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) => arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, []));
export const PASSWORD = 'Synthetic knock preview!';

export function syntheticHouses(neighborhoodId = 'english-ranch', { base = [40.5555, -105.0365], streets = ['BLUE LEAF DR', 'CANYON WREN CT', 'MEADOWLARK LN'], perSide = 8 } = {}) {
  const houses = {};
  streets.forEach((street, s) => {
    for (let i = 0; i < perSide * 2; i += 1) {
      const k = Math.floor(i / 2), side = i % 2;
      const number = 2900 + k * 2 + side;
      const id = `h-${number}-${street.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      houses[`knock_houses/${id}`] = {
        neighborhoodId, street, number: String(number), unit: '', hasUnit: false,
        lat: base[0] + s * 0.0016 + (side ? 0.00018 : -0.00018),
        lng: base[1] + k * 0.00045,
        updatedAt: '2026-10-01T00:00:00.000Z', importedAt: '2026-10-01T00:00:00.000Z',
      };
    }
  });
  return houses;
}

export function previewSeed({ houses = null } = {}) {
  const nowIso = '2026-10-01T00:00:00.000Z';
  const seed = {};
  for (const doc of seedNeighborhoodDocs(nowIso)) seed[`knock_neighborhoods/${doc.id}`] = doc;
  Object.assign(seed, houses || syntheticHouses());
  seed['knock_reps/zacb'] = { repKey: 'zacb', username: 'ZacB', displayName: 'Zac', role: 'admin', status: 'active', permitListed: true, premiumCleared: true, leadKey: '', trainingMinutes: 0, createdAt: nowIso };
  seed['knock_reps/rep.one'] = { repKey: 'rep.one', username: 'Rep.One', displayName: 'Rep One', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false, leadKey: 'lead.one', trainingMinutes: 120, createdAt: nowIso, approvedAt: nowIso };
  seed['knock_reps/rep.two'] = { repKey: 'rep.two', username: 'Rep.Two', displayName: 'Rep Two', role: 'knocker', status: 'pending', permitListed: false, premiumCleared: false, leadKey: '', trainingMinutes: 0, createdAt: nowIso };
  seed['knock_reps/lead.one'] = { repKey: 'lead.one', username: 'Lead.One', displayName: 'Lead One', role: 'lead', status: 'active', permitListed: true, premiumCleared: true, leadKey: '', trainingMinutes: 300, createdAt: nowIso };
  seed['knock_assignments/rep.one__english-ranch__all'] = { repKey: 'rep.one', neighborhoodId: 'english-ranch', street: '', active: true, assignedAt: nowIso, assignedBy: 'ZacB', endedAt: null };
  seed['knock_assignments/lead.one__english-ranch__all'] = { repKey: 'lead.one', neighborhoodId: 'english-ranch', street: '', active: true, assignedAt: nowIso, assignedBy: 'ZacB', endedAt: null };
  seed['knock_assignments/zacb__english-ranch__all'] = { repKey: 'zacb', neighborhoodId: 'english-ranch', street: '', active: true, assignedAt: nowIso, assignedBy: 'ZacB', endedAt: null };
  return seed;
}

// Answer production Firestore URLs from the in-memory fake; everything else goes to the network.
export function installFirestoreFake(fake) {
  const upstream = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'firestore.googleapis.com') return fake.fetcher({}, url.href, init);
    return upstream(input, init);
  };
  return () => { globalThis.fetch = upstream; };
}

export async function startPreview({ now = null, houses = null, port = 0 } = {}) {
  const fake = firestoreRest(previewSeed({ houses }));
  const restore = installFirestoreFake(fake);
  const env = {
    HUB_SESSION_SECRET: 'synthetic-knock-preview-session-secret-0123456789',
    FIREBASE_API_KEY: 'firebase-test-knock-preview',
    HUB_AUTH_USERS_JSON: JSON.stringify(await hubUsers([['ZacB', 'Zac', 'owner'], ['Rep.One', 'Rep One', 'sales'], ['Rep.Two', 'Rep Two', 'sales'], ['Lead.One', 'Lead One', 'sales']], PASSWORD)),
  };
  const hub = await createHubServer({ env, now, password: PASSWORD });
  return { ...hub, fake, close: async () => { await hub.close(); restore(); } };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}` || process.argv[1]?.endsWith('knock-dev-server.mjs')) {
  const houses = args.houses ? JSON.parse(readFileSync(args.houses, 'utf8')) : null;
  const preview = await startPreview({ now: args.now || null, houses });
  console.log(`Knock preview: ${preview.base}/crew/knock.html`);
  console.log(`Sign in as Rep.One, ZacB, Rep.Two or Lead.One with password: ${PASSWORD}`);
}
