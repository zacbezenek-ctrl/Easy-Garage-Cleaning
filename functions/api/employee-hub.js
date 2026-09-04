import { getHubSession, hasBusinessAccess, listHubUserProfiles } from '../_lib/hub-session.js';

const PROJECT_ID = 'egcw-1ec83';
const DEFAULT_FIREBASE_API_KEY = 'AIzaSyA8g4UAW4P4bsCrQNZhUe81CbC7BvjJbNc';
const RECORD_TYPE = 'employee_hub_v2';
const COLLECTIONS = new Set(['profiles', 'timeEntries', 'announcements', 'requests', 'incidents', 'equipment', 'training', 'teamMessages', 'jobMessages', 'messageReads']);
const TRAINING_VERSION = '2026-09-employee-os-v1';
const TRAINING_CHECKS = new Map([['welcome', { answer: 1 }], ['safety', { answer: 2, supervisor: true }], ['property', { answer: 1 }], ['truck', { answer: 1, supervisor: true }], ['proof', { answer: 1 }], ['closeout', { answer: 0 }]]);
const HOST = /(^|\.)easygaragecleaning\.com$|\.pages\.dev$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;
const encoder = new TextEncoder();

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function allowed(request) {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(value).length + 3) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function vaultSecret(env) {
  return String(env.EMPLOYEE_HUB_DATA_SECRET || env.HUB_SESSION_SECRET || env.HIGHLEVEL_API_KEY || env.GHL_API_KEY || '');
}

async function encryptionKey(env) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${vaultSecret(env)}:employee-hub-v2:data`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function opaqueId(env, collection, id) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(vaultSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `secure_${base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${collection}:${id}`))))}`;
}

async function seal(env, documentId, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(documentId) },
    await encryptionKey(env),
    encoder.encode(JSON.stringify(payload)),
  );
  return { iv: base64Url(iv), payload: base64Url(new Uint8Array(encrypted)) };
}

async function open(env, documentId, iv, payload) {
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: encoder.encode(documentId) },
    await encryptionKey(env),
    fromBase64Url(payload),
  );
  return JSON.parse(new TextDecoder().decode(clear));
}

const stringField = value => ({ stringValue: String(value ?? '') });

function firestoreDoc(collection, documentId, encrypted, updatedAt) {
  return { fields: {
    recordType: stringField(RECORD_TYPE),
    employeeHubType: stringField(collection),
    sealedPayload: stringField(encrypted.payload),
    sealedIv: stringField(encrypted.iv),
    schemaVersion: { integerValue: '2' },
    updatedAt: stringField(updatedAt),
    vaultId: stringField(documentId),
  } };
}

function valueOf(field) {
  if (!field) return undefined;
  if ('stringValue' in field) return field.stringValue;
  if ('integerValue' in field) return Number(field.integerValue);
  return undefined;
}

function decodeValue(field) {
  if (!field) return undefined;
  if ('stringValue' in field) return field.stringValue;
  if ('integerValue' in field) return Number(field.integerValue);
  if ('doubleValue' in field) return Number(field.doubleValue);
  if ('booleanValue' in field) return Boolean(field.booleanValue);
  if ('timestampValue' in field) return field.timestampValue;
  if ('nullValue' in field) return null;
  if ('arrayValue' in field) return (field.arrayValue?.values || []).map(decodeValue);
  if ('mapValue' in field) return Object.fromEntries(Object.entries(field.mapValue?.fields || {}).map(([key, value]) => [key, decodeValue(value)]));
  return undefined;
}

async function readJob(env, id) {
  const safeId = String(id || '').trim();
  if (!safeId || safeId.length > 180) return null;
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/jobs/${encodeURIComponent(safeId)}?key=${encodeURIComponent(firebaseKey(env))}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Job access check failed (${response.status})`);
  const document = await response.json();
  return Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)]));
}

function parseFirestoreDocument(document) {
  const fields = document?.fields || {};
  return {
    documentId: String(document?.name || '').split('/').pop(),
    collection: valueOf(fields.employeeHubType),
    payload: valueOf(fields.sealedPayload),
    iv: valueOf(fields.sealedIv),
  };
}

function firebaseKey(env) {
  return String(env.FIREBASE_API_KEY || DEFAULT_FIREBASE_API_KEY);
}

async function readOne(env, collection, id) {
  const documentId = await opaqueId(env, collection, id);
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/jobs/${encodeURIComponent(documentId)}?key=${encodeURIComponent(firebaseKey(env))}`;
  const response = await fetch(url);
  if (response.status === 404) return { documentId, data: null };
  if (!response.ok) throw new Error(`Employee Hub storage read failed (${response.status})`);
  const stored = parseFirestoreDocument(await response.json());
  if (stored.collection !== collection || !stored.payload || !stored.iv) return { documentId, data: null };
  try { return { documentId, data: await open(env, documentId, stored.iv, stored.payload) }; }
  catch { return { documentId, data: null }; }
}

async function readAll(env) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery?key=${encodeURIComponent(firebaseKey(env))}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'jobs' }],
      where: { fieldFilter: { field: { fieldPath: 'recordType' }, op: 'EQUAL', value: stringField(RECORD_TYPE) } },
      limit: 500,
    } }),
  });
  if (!response.ok) throw new Error(`Employee Hub storage query failed (${response.status})`);
  const rows = await response.json();
  const decoded = [];
  for (const row of rows) {
    if (!row.document) continue;
    const stored = parseFirestoreDocument(row.document);
    if (!COLLECTIONS.has(stored.collection) || !stored.payload || !stored.iv) continue;
    try { decoded.push({ collection: stored.collection, data: await open(env, stored.documentId, stored.iv, stored.payload) }); }
    catch { /* Ignore deleted or tampered public envelopes. */ }
  }
  return decoded;
}

async function writeOne(env, collection, id, data) {
  const documentId = await opaqueId(env, collection, id);
  const updatedAt = new Date().toISOString();
  const encrypted = await seal(env, documentId, { ...data, id, updatedAt: data.updatedAt || updatedAt });
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/jobs/${encodeURIComponent(documentId)}?key=${encodeURIComponent(firebaseKey(env))}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(firestoreDoc(collection, documentId, encrypted, updatedAt)),
  });
  if (!response.ok) throw new Error(`Employee Hub storage write failed (${response.status})`);
  return { ...data, id, updatedAt: data.updatedAt || updatedAt };
}

const manager = session => hasBusinessAccess(session);
const same = (left, right) => String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
const personKey = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'employee';

function assignedNames(job) {
  const explicit = Array.isArray(job?.assignedCrew) ? job.assignedCrew : [];
  const parsed = String(job?.assignedTo || '').split(/\s*(?:,|\+|&|\band\b)\s*/i).filter(Boolean);
  return [...new Set([...explicit, ...parsed].map(value => typeof value === 'string' ? value : value?.name || value?.id || '').filter(Boolean))];
}

function samePerson(left, right) {
  const clean = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const a = clean(left), b = clean(right);
  return Boolean(a && b && (a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)))));
}

function jobMember(session, job) {
  if (manager(session)) return true;
  return assignedNames(job).some(name => samePerson(name, session.user) || samePerson(name, session.displayName));
}

function visibleTo(session, collection, data) {
  if (manager(session) || ['announcements', 'teamMessages'].includes(collection)) return true;
  if (collection === 'jobMessages') return false;
  if (collection === 'messageReads') return same(data?.employee, session.user);
  const field = collection === 'profiles' ? 'username' : ['incidents', 'equipment'].includes(collection) ? 'reportedBy' : 'employee';
  return same(data?.[field], session.user);
}

function configuredProfiles(env) {
  return listHubUserProfiles(env).map(profile => ({
    id: personKey(profile.user),
    username: profile.user,
    displayName: profile.displayName,
    role: profile.role,
    payType: profile.payType,
    hourlyRate: profile.hourlyRate,
    status: 'active',
  }));
}

async function employeeRate(env, session) {
  const profile = await readOne(env, 'profiles', personKey(session.user));
  const rate = Number(profile.data?.hourlyRate);
  return Number.isFinite(rate) && rate >= 0 ? rate : Math.max(0, Number(session.hourlyRate || 0));
}

async function authorizeMutation(env, session, collection, id, incoming, existing) {
  const now = new Date().toISOString();
  if (manager(session) && !(collection === 'training' && incoming.moduleId)) return { ...(existing || {}), ...incoming, id };

  if (collection === 'profiles') {
    if (id !== personKey(session.user)) throw new Error('You can only update your own employee profile');
    const text = (value, limit) => String(value || '').trim().slice(0, limit);
    const requiredAcknowledgements = ['timekeeping', 'location_policy', 'safety', 'customer_care', 'hub_basics'];
    if (incoming.onboardingCompletedAt && !requiredAcknowledgements.every(value => incoming.onboardingAcknowledgements?.includes(value))) throw new Error('All onboarding acknowledgements are required');
    const onboarding = incoming.onboardingCompletedAt ? {
      preferredName: text(incoming.preferredName, 80),
      phone: text(incoming.phone, 40),
      emergencyContactName: text(incoming.emergencyContactName, 100),
      emergencyContactPhone: text(incoming.emergencyContactPhone, 40),
      onboardingVersion: '2026-09-location-v2',
      onboardingAcknowledgements: requiredAcknowledgements,
      onboardingDraftAcknowledgements: [],
      onboardingDraftAt: '',
      onboardingCompletedAt: text(incoming.onboardingCompletedAt, 40),
    } : incoming.onboardingDraftAt ? {
      preferredName: text(incoming.preferredName, 80),
      phone: text(incoming.phone, 40),
      emergencyContactName: text(incoming.emergencyContactName, 100),
      emergencyContactPhone: text(incoming.emergencyContactPhone, 40),
      onboardingDraftAcknowledgements: Array.isArray(incoming.onboardingDraftAcknowledgements)
        ? incoming.onboardingDraftAcknowledgements.filter(value => ['timekeeping', 'locationPolicy', 'safety', 'customerCare', 'hubBasics'].includes(value))
        : [],
      onboardingDraftAt: text(incoming.onboardingDraftAt, 40),
    } : incoming.locationVerifiedAt ? {
      locationVerifiedAt: text(incoming.locationVerifiedAt, 40),
      locationVerificationAccuracy: Math.max(0, Math.min(10000, Number(incoming.locationVerificationAccuracy || 0))),
    } : {};
    return {
      ...(existing || {}), ...onboarding, id, username: session.user, displayName: session.displayName,
      role: session.role, payType: session.payType, hourlyRate: await employeeRate(env, session),
      status: 'active', lastSeenAt: now,
    };
  }

  if (collection === 'announcements') {
    if (!existing) throw new Error('Announcement not found');
    return { ...existing, readBy: [...new Set([...(existing.readBy || []), session.user])], updatedAt: now };
  }

  if (existing && !visibleTo(session, collection, existing)) throw new Error('This record belongs to another employee');

  if (collection === 'timeEntries') {
    if (!existing) {
      const lat = Number(incoming.lastLocation?.lat), lng = Number(incoming.lastLocation?.lng);
      if (incoming.locationTracking !== true || !Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('Shift location is required to clock in');
      return {
      ...incoming, id, employee: session.user, employeeName: session.displayName, role: session.role,
      payType: session.payType, hourlyRate: await employeeRate(env, session), clockInAt: now,
      approvalStatus: 'open', approvedBy: '', approvedAt: '',
      };
    }
    const safe = { ...existing, ...incoming, id, employee: existing.employee, employeeName: existing.employeeName,
      role: existing.role, payType: existing.payType, hourlyRate: existing.hourlyRate,
      approvalStatus: existing.approvalStatus, approvedBy: existing.approvedBy || '', approvedAt: existing.approvedAt || '' };
    if (incoming.clockOutAt && incoming.status === 'submitted') safe.approvalStatus = 'pending';
    if (Array.isArray(safe.locationTrail)) safe.locationTrail = safe.locationTrail.slice(-120);
    return safe;
  }

  if (collection === 'requests') {
    if (existing) throw new Error('Only a manager can change a submitted request');
    return { ...incoming, id, employee: session.user, status: 'pending', reviewedBy: '', reviewedAt: '' };
  }

  if (collection === 'training') {
    const moduleId = String(incoming.moduleId || '');
    const module = TRAINING_CHECKS.get(moduleId);
    if (!module || Number(incoming.answer) !== module.answer) throw new Error('The training knowledge check was not passed');
    const current = existing?.version === TRAINING_VERSION ? existing : {};
    const completed = Array.isArray(current.completed) ? current.completed : [];
    const pending = Array.isArray(current.pendingSignoffs) ? current.pendingSignoffs : [];
    const passed = [...new Set([...(Array.isArray(current.passedModules) ? current.passedModules : completed), moduleId])];
    const nextCompleted = module.supervisor ? completed : [...new Set([...completed, moduleId])];
    const nextPending = module.supervisor ? [...new Set([...pending, moduleId])] : pending.filter(value => value !== moduleId);
    return { ...current, id, employee: session.user, version: TRAINING_VERSION, passedModules: passed,
      pendingSignoffs: nextPending, completed: nextCompleted, completedCount: nextCompleted.length,
      totalCount: TRAINING_CHECKS.size, lastKnowledgeCheckAt: now, updatedAt: now,
      ...(nextCompleted.length === TRAINING_CHECKS.size ? { completedAt: now } : {}) };
  }

  if (collection === 'teamMessages') {
    if (existing) throw new Error('Only a manager can change an existing team message');
    const body = String(incoming.body || '').trim().slice(0, 1200);
    if (!body) throw new Error('Message text is required');
    return { id, body, sender: session.user, senderName: session.displayName, createdAt: now, updatedAt: now, status: 'active' };
  }

  if (collection === 'jobMessages') {
    if (existing) throw new Error('Only a manager can change an existing job message');
    const jobId = String(incoming.jobId || '').trim();
    const job = await readJob(env, jobId);
    if (!job || !jobMember(session, job)) throw new Error('This job room is limited to assigned crew');
    const body = String(incoming.body || '').trim().slice(0, 1200);
    if (!body) throw new Error('Message text is required');
    return { id, jobId, body, sender: session.user, senderName: session.displayName, createdAt: now, updatedAt: now, status: 'active' };
  }

  if (collection === 'messageReads') {
    const channel = String(incoming.channel || '').trim().slice(0, 180);
    if (!channel) throw new Error('Message channel is required');
    return { ...(existing || {}), id, employee: session.user, channel, lastReadAt: now, updatedAt: now };
  }

  if (['incidents', 'equipment'].includes(collection)) {
    if (existing) throw new Error('Only a manager can change a submitted safety record');
    return { ...incoming, id, reportedBy: session.user, status: 'open', resolvedBy: '', resolvedAt: '' };
  }

  throw new Error('Unsupported employee record');
}

export async function onRequestGet({ request, env }) {
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in required' });
  if (!vaultSecret(env) || !firebaseKey(env)) return reply(503, { ok: false, error: 'Employee Hub storage is not configured' });
  try {
    const rows = await readAll(env);
    const collections = Object.fromEntries([...COLLECTIONS].map(name => [name, []]));
    const jobAccess = new Map();
    for (const row of rows) {
      if (row.collection !== 'jobMessages') {
        if (visibleTo(session, row.collection, row.data)) collections[row.collection].push(row.data);
        continue;
      }
      const jobId = String(row.data?.jobId || '');
      if (!jobAccess.has(jobId)) jobAccess.set(jobId, await readJob(env, jobId).then(job => jobMember(session, job)).catch(() => false));
      if (jobAccess.get(jobId)) collections.jobMessages.push(row.data);
    }
    const profiles = configuredProfiles(env).filter(profile => visibleTo(session, 'profiles', profile));
    const storedProfiles = new Map(collections.profiles.map(profile => [String(profile.username || '').toLowerCase(), profile]));
    const configuredKeys = new Set(profiles.map(profile => String(profile.username || '').toLowerCase()));
    collections.profiles = [
      ...profiles.map(profile => ({ ...profile, ...(storedProfiles.get(String(profile.username).toLowerCase()) || {}) })),
      ...[...storedProfiles.values()].filter(profile => !configuredKeys.has(String(profile.username || '').toLowerCase())),
    ];
    return reply(200, { ok: true, collections });
  } catch (error) {
    return reply(502, { ok: false, error: String(error.message || 'Employee Hub storage failed') });
  }
}

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in required' });
  if (!vaultSecret(env) || !firebaseKey(env)) return reply(503, { ok: false, error: 'Employee Hub storage is not configured' });
  const body = await request.json().catch(() => ({}));
  const collection = String(body.collection || '');
  const id = String(body.id || '').trim();
  if (!COLLECTIONS.has(collection) || !id || id.length > 180) return reply(400, { ok: false, error: 'Invalid employee record' });
  let incoming;
  try {
    const serialized = JSON.stringify(body.data || {});
    if (serialized.length > 120000) return reply(413, { ok: false, error: 'Employee record is too large' });
    incoming = JSON.parse(serialized);
  } catch { return reply(400, { ok: false, error: 'Invalid employee record data' }); }
  try {
    const current = await readOne(env, collection, id);
    const data = await authorizeMutation(env, session, collection, id, incoming, current.data);
    return reply(200, { ok: true, record: await writeOne(env, collection, id, data) });
  } catch (error) {
    const message = String(error.message || 'Employee record could not be saved');
    const forbidden = /only|belongs|limited|own/i.test(message);
    const invalid = /required|not passed|invalid/i.test(message);
    return reply(forbidden ? 403 : invalid ? 400 : 502, { ok: false, error: message });
  }
}

export async function onRequestOptions({ request }) {
  if (!allowed(request)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
  } });
}
