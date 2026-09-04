const PROJECT_ID = 'egcw-1ec83';
const DEFAULT_FIREBASE_API_KEY = 'AIzaSyA8g4UAW4P4bsCrQNZhUe81CbC7BvjJbNc';
const RECORD_TYPE = 'employee_account_v1';
const encoder = new TextEncoder();

const text = (value, limit = 200) => String(value || '').trim().slice(0, limit);

export function normalizeEmployeeUsername(value) {
  return text(value, 32).toLowerCase();
}

function accountSecret(env = {}) {
  return String(env.EMPLOYEE_HUB_DATA_SECRET || env.HUB_SESSION_SECRET || env.HIGHLEVEL_API_KEY || env.GHL_API_KEY || '');
}

function firebaseKey(env = {}) {
  return String(env.FIREBASE_API_KEY || DEFAULT_FIREBASE_API_KEY);
}

export function employeeAccountsConfigured(env = {}) {
  return Boolean(accountSecret(env) && firebaseKey(env));
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const source = String(value || '');
  const padded = source.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((source.length + 3) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

async function encryptionKey(env) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${accountSecret(env)}:employee-accounts:data`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function documentId(env, username) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(accountSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`employee-account:${normalizeEmployeeUsername(username)}`));
  return `secure_account_${base64Url(new Uint8Array(signature))}`;
}

async function seal(env, id, account) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(id) },
    await encryptionKey(env),
    encoder.encode(JSON.stringify(account)),
  );
  return { iv: base64Url(iv), payload: base64Url(new Uint8Array(encrypted)) };
}

async function open(env, id, iv, payload) {
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: encoder.encode(id) },
    await encryptionKey(env),
    fromBase64Url(payload),
  );
  return JSON.parse(new TextDecoder().decode(clear));
}

const stringField = value => ({ stringValue: String(value ?? '') });
const valueOf = field => field && 'stringValue' in field ? field.stringValue : '';

function firestoreDocument(id, account, encrypted) {
  return { fields: {
    recordType: stringField(RECORD_TYPE),
    accountStatus: stringField(account.status),
    sealedPayload: stringField(encrypted.payload),
    sealedIv: stringField(encrypted.iv),
    schemaVersion: { integerValue: '1' },
    updatedAt: stringField(account.updatedAt),
    vaultId: stringField(id),
  } };
}

function parseDocument(document) {
  const fields = document?.fields || {};
  return {
    id: String(document?.name || '').split('/').pop(),
    payload: valueOf(fields.sealedPayload),
    iv: valueOf(fields.sealedIv),
  };
}

async function readAccount(env, username) {
  const id = await documentId(env, username);
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/jobs/${encodeURIComponent(id)}?key=${encodeURIComponent(firebaseKey(env))}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Employee account storage read failed (${response.status})`);
  const stored = parseDocument(await response.json());
  if (!stored.payload || !stored.iv) return null;
  try { return await open(env, id, stored.iv, stored.payload); }
  catch { return null; }
}

async function writeAccount(env, account, createOnly = false) {
  const id = await documentId(env, account.username);
  const encrypted = await seal(env, id, account);
  const precondition = createOnly ? '&currentDocument.exists=false' : '';
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/jobs/${encodeURIComponent(id)}?key=${encodeURIComponent(firebaseKey(env))}${precondition}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(firestoreDocument(id, account, encrypted)),
  });
  if (response.status === 409 || response.status === 412) throw new Error('That username is already registered');
  if (!response.ok) throw new Error(`Employee account storage write failed (${response.status})`);
  return account;
}

async function passwordDigest(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64Url(salt), iterations: 100000 },
    material,
    256,
  );
  return base64Url(new Uint8Array(bits));
}

function publicAccount(account) {
  if (!account) return null;
  const { passwordHash, passwordSalt, ...safe } = account;
  return safe;
}

function validateApplication(input) {
  const firstName = text(input.firstName, 60);
  const lastName = text(input.lastName, 60);
  const username = text(input.username, 32);
  const email = text(input.email, 160).toLowerCase();
  const phone = text(input.phone, 40);
  const password = String(input.password || '');
  if (!firstName || !lastName) throw new Error('Enter your first and last name');
  if (!/^[A-Za-z][A-Za-z0-9._-]{3,31}$/.test(username)) throw new Error('Username must be 4–32 characters and start with a letter');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address');
  if (phone.replace(/\D/g, '').length < 10) throw new Error('Enter a valid mobile number');
  if (password.length < 10 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    throw new Error('Password must be at least 10 characters with uppercase, lowercase, and a number');
  }
  return { firstName, lastName, displayName: `${firstName} ${lastName}`, username, usernameKey: normalizeEmployeeUsername(username), email, phone, password };
}

export async function createEmployeeApplication(env, input) {
  if (!employeeAccountsConfigured(env)) throw new Error('Employee account signup is not configured');
  const fields = validateApplication(input);
  if (await readAccount(env, fields.username)) throw new Error('That username is already registered');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const now = new Date().toISOString();
  const account = {
    username: fields.username,
    usernameKey: fields.usernameKey,
    displayName: fields.displayName,
    firstName: fields.firstName,
    lastName: fields.lastName,
    email: fields.email,
    phone: fields.phone,
    passwordSalt: base64Url(salt),
    passwordHash: await passwordDigest(fields.password, base64Url(salt)),
    status: 'pending',
    role: 'crew',
    payType: 'hourly',
    hourlyRate: 0,
    businessAccess: false,
    appliedAt: now,
    updatedAt: now,
    reviewedAt: '',
    reviewedBy: '',
  };
  await writeAccount(env, account, true);
  return publicAccount(account);
}

export async function authenticateEmployeeAccount(env, username, password) {
  if (!employeeAccountsConfigured(env) || typeof password !== 'string') return null;
  const account = await readAccount(env, username);
  if (!account || account.status !== 'approved' || !account.passwordSalt || !account.passwordHash) return null;
  const supplied = await passwordDigest(password, account.passwordSalt);
  if (!safeEqual(supplied, account.passwordHash)) return null;
  return {
    user: account.username,
    displayName: account.displayName || account.username,
    role: 'crew',
    payType: account.payType || 'hourly',
    hourlyRate: Math.max(0, Number(account.hourlyRate || 0)),
    businessAccess: false,
    source: 'employee-account',
  };
}

export async function listEmployeeApplications(env) {
  if (!employeeAccountsConfigured(env)) throw new Error('Employee account signup is not configured');
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery?key=${encodeURIComponent(firebaseKey(env))}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'jobs' }],
      where: { fieldFilter: { field: { fieldPath: 'recordType' }, op: 'EQUAL', value: stringField(RECORD_TYPE) } },
      limit: 250,
    } }),
  });
  if (!response.ok) throw new Error(`Employee account storage query failed (${response.status})`);
  const accounts = [];
  for (const row of await response.json()) {
    if (!row.document) continue;
    const stored = parseDocument(row.document);
    if (!stored.payload || !stored.iv) continue;
    try { accounts.push(publicAccount(await open(env, stored.id, stored.iv, stored.payload))); }
    catch { /* Ignore incomplete or tampered records. */ }
  }
  return accounts.sort((left, right) => String(right.appliedAt).localeCompare(String(left.appliedAt)));
}

export async function reviewEmployeeApplication(env, username, decision, reviewer) {
  const account = await readAccount(env, username);
  if (!account) throw new Error('Employee application not found');
  if (!['approved', 'rejected'].includes(decision)) throw new Error('Choose approve or reject');
  const now = new Date().toISOString();
  const updated = {
    ...account,
    status: decision,
    role: 'crew',
    businessAccess: false,
    reviewedAt: now,
    reviewedBy: text(reviewer, 60),
    updatedAt: now,
  };
  await writeAccount(env, updated);
  return publicAccount(updated);
}
