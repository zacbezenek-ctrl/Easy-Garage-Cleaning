// An explicit legacy source preserves sealed records without exporting the key.
// It is never used for session signing or customer portal authentication.
export function employeeVaultSecret(env = {}) {
  if (env.EMPLOYEE_HUB_DATA_SECRET) return String(env.EMPLOYEE_HUB_DATA_SECRET);
  const source = env.EMPLOYEE_HUB_LEGACY_KEY_SOURCE;
  if (source) return source === 'HIGHLEVEL_API_KEY' ? String(env.HIGHLEVEL_API_KEY || '') : '';
  return String(env.HUB_SESSION_SECRET || '');
}

export function employeeVaultReadOnly(env = {}) {
  return Boolean(env.EMPLOYEE_HUB_LEGACY_KEY_SOURCE) && env.EMPLOYEE_HUB_LEGACY_WRITES_VERIFIED !== 'true';
}
