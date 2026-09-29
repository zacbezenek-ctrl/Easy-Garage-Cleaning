import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const enabled = process.env.EGC_FIREBASE_EMULATOR_TEST === '1';

// FIX-CREW-PRICE-LEAK: crew read a signed job only through the price-free /api/field-jobs and /api/crew-jobs projections;
// managers keep the priced walkthrough brief, which they read from the job document itself under firestore.rules.
test('the priced brief in jobs/{id}.internalNotes is readable by business users and never by crew SDK sessions', { skip: !enabled, timeout: 120000 }, async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '';
  assert.match(host, /^(?:127\.0\.0\.1|localhost):\d{2,5}$/, 'This test may only connect to a loopback Firestore emulator.');
  const projectId = /^demo-[a-z0-9-]+$/.test(process.env.GCLOUD_PROJECT || '') ? process.env.GCLOUD_PROJECT : 'demo-egc-field-rules';
  const require = process.env.EGC_FIREBASE_TEST_MODULES ? createRequire(resolve(process.env.EGC_FIREBASE_TEST_MODULES, 'package.json')) : createRequire(new URL('../package.json', import.meta.url));
  const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
  require('firebase/firestore').setLogLevel('silent');
  const [hostname, port] = host.split(':');
  const rules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
  const environment = await initializeTestEnvironment({ projectId, firestore: { host: hostname, port: Number(port), rules } });
  const claims = (username, role, business = false) => ({ username, role, business_access: business, assignment_version: 1, assignment_identities: [username], assignment_keys: [username] });
  const id = `crew-scope-${randomUUID().slice(0, 8)}`, priced = 'EGC INTERNAL JOB BRIEF\nHAZARDS: Pest waste (+$200)\nFINISH SOLD: Non-toxic mouse trapping (+$250)';
  try {
    await environment.withSecurityRulesDisabled(context => context.firestore().doc(`jobs/${id}`).set({ id, type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', assignedCrew: ['crew1'], crewLead: 'lead1',
      handoffVersion: 1, operationalScope: { text: 'EGC CREW JOB BRIEF\nHAZARDS: Pest waste\nFINISH SOLD: Non-toxic mouse trapping' }, internalNotes: priced }));
    for (const [name, profile] of [['owner', claims('zacb', 'owner', true)], ['partner', claims('TylerG', 'manager', true)]]) {
      const snapshot = await assertSucceeds(environment.authenticatedContext(name, profile).firestore().doc(`jobs/${id}`).get());
      assert.equal(snapshot.data().internalNotes, priced, `${name} still sees every quoted price`);
    }
    for (const [name, profile] of [['crew-one', claims('crew1', 'crew')], ['lead-one', claims('lead1', 'crew_lead')]]) {
      const db = environment.authenticatedContext(name, profile).firestore();
      await assertFails(db.doc(`jobs/${id}`).get());
      await assertFails(db.collection('jobs').where('assignedCrew', 'array-contains', profile.username).get());
    }
  } finally { await environment.cleanup(); }
});
