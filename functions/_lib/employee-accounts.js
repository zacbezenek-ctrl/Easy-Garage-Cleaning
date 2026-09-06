import { firestoreFetch, firebaseServiceAccountConfigured } from './firebase-service-account.js';
import { employeeVaultSecret, employeeVaultReadOnly } from './employee-vault-key.js';

const PROJECT_ID = 'egcw-1ec83';
const RECORD_TYPE = 'employee_account_v1';
const encoder = new TextEncoder();
const RESERVED_USERNAMES = new Set(['zacb', 'tylerg', 'alexk']);

function accountError(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status });
}

function unreadableAccount() {
  return accountError('EMPLOYEE_ACCOUNT_DATA_UNREADABLE', 'Employee accounts could not be unlocked. Ask the owner to restore the existing employee data key; do not register replacement accounts.');
}

function storageError() {
  return accountError('EMPLOYEE_ACCOUNT_STORAGE_UNAVAILABLE', 'Employee account storage is temporarily unavailable. Try again later.', 502);
}

const text = (value, limit = 200) => String(value || '').trim().slice(0, limit);

export function normalizeEmployeeUsername(value) {
  return text(value, 32).toLowerCase();
}

export function isReservedEmployeeUsername(value) {
  return RESERVED_USERNAMES.has(normalizeEmployeeUsername(value));
}

function accountSecret(env = {}) {
  return employeeVaultSecret(env);
}

export function employeeAccountsConfigured(env = {}) {
  return Boolean(accountSecret(env) && firebaseServiceAccountConfigured(env));
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
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/jobs/${encodeURIComponent(id)}`;
  const response = await firestoreFetch(env, url);
  if (response.status === 404) return null;
  if (!response.ok) throw storageError();
  const stored = parseDocument(await response.json());
  if (!stored.payload || !stored.iv) throw unreadableAccount();
  try {
    const account = await open(env, id, stored.iv, stored.payload);
    if (!account || normalizeEmployeeUsername(account.username) !== normalizeEmployeeUsername(username)) throw unreadableAccount();
    return account;
  } catch { throw unreadableAccount(); }
}

async function writeAccount(env, account, createOnly = false) {
  if (employeeVaultReadOnly(env)) throw accountError('EMPLOYEE_ACCOUNT_RECOVERY_READ_ONLY', 'Employee setup is being verified. Existing accounts are preserved and cannot be changed yet.');
  const id = await documentId(env, account.username);
  const encrypted = await seal(env, id, account);
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/jobs/${encodeURIComponent(id)}`);
  if (createOnly) url.searchParams.set('currentDocument.exists', 'false');
  const response = await firestoreFetch(env, url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(firestoreDocument(id, account, encrypted)),
  });
  if (response.status === 409 || response.status === 412) throw new Error('That username is already registered');
  if (!response.ok) throw storageError();
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
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Enter your employee account details');
  const firstName = text(input.firstName, 60);
  const lastName = text(input.lastName, 60);
  const username = String(input.username || '').trim();
  const email = text(input.email, 160).toLowerCase();
  const phone = text(input.phone, 40);
  const password = String(input.password || '');
  if (!firstName || !lastName) throw new Error('Enter your first and last name');
  if (!/^[A-Za-z][A-Za-z0-9._-]{3,31}$/.test(username)) throw new Error('Username must be 4–32 characters and start with a letter');
  if (isReservedEmployeeUsername(username)) throw new Error('That username is already registered');
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
  // IDs change with the vault key. Check the existing vault before creating a
  // new ID so a missing key cannot silently register replacement accounts.
  const accounts = await listEmployeeApplications(env);
  if (accounts.some(account => normalizeEmployeeUsername(account.username) === fields.usernameKey)) throw new Error('That username is already registered');
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
  if (typeof password !== 'string' || isReservedEmployeeUsername(username)) return null;
  if (!employeeAccountsConfigured(env)) throw accountError('EMPLOYEE_ACCOUNTS_NOT_CONFIGURED', 'Employee sign-in is not configured. Ask the owner to complete secure account setup.');
  const account = await readAccount(env, username);
  if (!account) {
    // A wrong key changes account IDs as well as encryption. Distinguish that
    // service failure from an incorrect password without exposing account data.
    await listEmployeeApplications(env);
    return null;
  }
  if (!account.passwordSalt || !account.passwordHash) throw unreadableAccount();
  const supplied = await passwordDigest(password, account.passwordSalt);
  if (!safeEqual(supplied, account.passwordHash)) return null;
  if (account.status === 'pending') throw accountError('EMPLOYEE_ACCOUNT_PENDING', 'Your account is waiting for Zac to approve it. You do not need to register again.', 401);
  if (account.status === 'rejected') throw accountError('EMPLOYEE_ACCOUNT_REJECTED', 'Your account request was not approved. Contact Zac before registering again.', 401);
  if (account.status !== 'approved') return null;
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
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
  const response = await firestoreFetch(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'jobs' }],
      where: { fieldFilter: { field: { fieldPath: 'recordType' }, op: 'EQUAL', value: stringField(RECORD_TYPE) } },
    } }),
  });
  if (!response.ok) throw storageError();
  const rows = await response.json().catch(() => { throw storageError(); });
  if (!Array.isArray(rows)) throw storageError();
  const accounts = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.error) throw storageError();
    if (row.document === undefined) {
      // Firestore represents an empty query with a readTime-only row.
      if (typeof row.readTime !== 'string' || !row.readTime) throw storageError();
      continue;
    }
    if (!row.document || typeof row.document !== 'object' || Array.isArray(row.document)) throw storageError();
    const stored = parseDocument(row.document);
    if (!stored.payload || !stored.iv) throw unreadableAccount();
    try {
      const account = await open(env, stored.id, stored.iv, stored.payload);
      if (!account?.username || await documentId(env, account.username) !== stored.id) throw unreadableAccount();
      accounts.push(publicAccount(account));
    } catch { throw unreadableAccount(); }
  }
  return accounts.sort((left, right) => String(right.appliedAt).localeCompare(String(left.appliedAt)));
}

export async function reviewEmployeeApplication(env, username, decision, reviewer) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('Choose approve or reject');
  if (isReservedEmployeeUsername(username)) throw new Error('Business accounts are managed through secure staff configuration');
  const account = await readAccount(env, username);
  if (!account) throw new Error('Employee application not found');
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
