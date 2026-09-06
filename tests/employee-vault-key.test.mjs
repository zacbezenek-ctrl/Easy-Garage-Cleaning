import test from 'node:test';
import assert from 'node:assert/strict';
import { employeeVaultSecret, employeeVaultReadOnly } from '../functions/_lib/employee-vault-key.js';

test('legacy vault source is explicit, byte-preserving and independent of a new session key', () => {
  const env = { HIGHLEVEL_API_KEY: ' original bound value\n', HUB_SESSION_SECRET: 'new-signing-secret' };
  assert.equal(employeeVaultSecret({ HIGHLEVEL_API_KEY: env.HIGHLEVEL_API_KEY }), '');
  assert.equal(employeeVaultSecret(env), env.HUB_SESSION_SECRET);
  const legacy = { ...env, EMPLOYEE_HUB_LEGACY_KEY_SOURCE: 'HIGHLEVEL_API_KEY' };
  assert.equal(employeeVaultSecret(legacy), env.HIGHLEVEL_API_KEY);
  assert.equal(employeeVaultReadOnly(legacy), true);
  assert.equal(employeeVaultReadOnly({ ...legacy, EMPLOYEE_HUB_LEGACY_WRITES_VERIFIED: 'true' }), false);
  assert.equal(employeeVaultSecret({ ...legacy, HIGHLEVEL_API_KEY: '' }), '');
  assert.equal(employeeVaultSecret({ ...legacy, EMPLOYEE_HUB_LEGACY_KEY_SOURCE: 'misspelled' }), '');
  assert.equal(employeeVaultSecret({ ...legacy, EMPLOYEE_HUB_DATA_SECRET: 'dedicated value' }), 'dedicated value');
});
