import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { W19_REVIEW_IDS as ids, reviewW19WorkflowContract as review } from '../functions/_lib/w19-workflow-contract.js';

// Synthetic picker evidence is deliberately not a native token or live proof.
const candidate = () => ({ workflowId: ids.workflowId, formId: ids.formId, published: false,
  webhook: { method: 'POST', path: '/api/w19-completion-gate', contentType: 'application/json', saveResponse: true,
    body: { reference: { source: 'native_reference_picker', fieldId: ids.reference, evidenceId: 'synthetic-picker-evidence' },
      contactId: { source: 'current_workflow_contact_picker', evidenceId: 'synthetic-contact-evidence' } } },
  verifiedBranch: { operator: 'AND', checks: [ { path: 'ok', operator: 'equals', value: true },
    { path: 'completion.verified', operator: 'equals', value: true }, { path: 'completion.proceed', operator: 'equals', value: true } ] },
  verifiedActions: ['remove_contact_from_current_workflow'], fallbackActions: [], schemaProbeSeparate: true,
  association: { mode: 'manual_email', fieldId: 'email', required: true, stickyContact: false, autoresponder: false, emailNotification: false },
  ordinaryCrewNativeLaunch: false });

test('verified form identity matches existing native constants; contract remains review-only', () => {
  const source = readFileSync(new URL('../functions/_lib/w19-native-form.js', import.meta.url), 'utf8');
  for (const [name, value] of Object.entries(ids)) if (name !== 'workflowId') assert.ok(source.includes(value), name);
  assert.deepEqual(review(candidate()), { status: 'draft_contract_ready_for_review', activationAllowed: false,
    submissionAllowed: false, paymentOrCommissionAuthority: false, blockers: [] });
});
test('observed schema-only webhook and unmapped legacy actions are blocked', () => {
  const observed = candidate(); observed.webhook.body = { schemaOnly: true };
  observed.verifiedActions.push('update_completion_date', 'update_work_notes', 'balance_condition', 'invoice_task');
  const result = review(observed);
  assert.ok(result.blockers.includes('live_body_requires_only_reference_and_contact'));
  assert.ok(result.blockers.includes('unverified_or_financial_action_present'));
  assert.equal(result.activationAllowed, false);
});
test('unknown or hardcoded picker tokens, foreign contact and extra customer fields cannot pass', () => {
  for (const mutate of [o => o.webhook.body.reference = '{{invented.token}}', o => o.webhook.body.reference.fieldId = ids.jobId,
    o => o.webhook.body.contactId = 'hardcoded-contact', o => o.webhook.body.reference.evidenceId = '',
    o => o.webhook.body.email = 'customer@example.invalid', o => o.webhook.body.submissionId = 'guessed-id']) {
    const observed = candidate(); mutate(observed); assert.equal(review(observed).status, 'blocked');
  }
});
test('truthy strings, top-level proceed, OR and duplicate-only conditions cannot grant completion authority', () => {
  for (const mutate of [o => o.verifiedBranch.operator = 'OR', o => o.verifiedBranch.checks[0].value = 'true',
    o => o.verifiedBranch.checks[2].path = 'proceed', o => o.verifiedBranch.checks.pop()]) {
    const observed = candidate(); mutate(observed); assert.ok(review(observed).blockers.includes('completion_branch_must_use_three_typed_booleans'));
  }
});
test('publishing, crew email access, contact association changes and fallback actions remain blocked', () => {
  for (const mutate of [o => o.published = true, o => o.ordinaryCrewNativeLaunch = true,
    o => o.association.required = false, o => o.association.stickyContact = true,
    o => o.association.autoresponder = true, o => o.fallbackActions.push('retry_submit'),
    o => o.verifiedActions.push('mark_paid'), o => o.verifiedActions.push('settle_commission')]) {
    const observed = candidate(); mutate(observed); assert.equal(review(observed).status, 'blocked');
  }
});
test('contract has no provider or storage imports and accepts no execution permission', () => {
  const source = readFileSync(new URL('../functions/_lib/w19-workflow-contract.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s|\bfetch\s*\(|\.commit\s*\(/m);
  assert.equal(review(null).activationAllowed, false); assert.equal(review({}).submissionAllowed, false);
});

