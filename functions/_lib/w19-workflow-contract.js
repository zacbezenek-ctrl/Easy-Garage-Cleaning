// A local review/lint contract, NOT the HighLevel workflow API schema. Nothing
// imports this into a route, submits a form, changes permissions or sends data.
export const W19_REVIEW_IDS = Object.freeze({
  workflowId: '1fbd6b3e-d5fb-422f-ba33-ae437c3e92f7', formId: '7HCRlKJs4VZx4KwNmDa6',
  jobId: 'pKArVLKFAIEzNPMPJ7EL', completedAt: 'vKgUZFHSywW7IVYaAzUv',
  workNotes: 'KM4Wdv2Ds6YruppSRcol', unfinishedWork: 'kFSdQ8SxNnjZsK15lffJ',
  customerConcerns: '5DfNkQVbwwPusGxwv6WI', leadDisplay: 'Zg99AdjT6VclE9qcVedI',
  reference: 'WypOwqgzXpVP0we0Jf35', customerEmail: 'email',
});
const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Inputs are manually recorded observations with evidence references. Passing
 * this lint permits review only; it cannot attest deployment or native behavior.
 * No invented HighLevel merge token, auth token, field ID or slot is supplied.
 */
export function reviewW19WorkflowContract(observed) {
  const blockers = [], require = (ok, code) => { if (!ok) blockers.push(code); };
  require(plain(observed), 'observation_missing');
  const o = plain(observed) ? observed : {};
  require(o.workflowId === W19_REVIEW_IDS.workflowId && o.formId === W19_REVIEW_IDS.formId, 'wrong_workflow_or_form');
  require(o.published === false, 'must_remain_draft');
  const hook = o.webhook;
  require(hook?.method === 'POST' && hook.path === '/api/w19-completion-gate', 'wrong_completion_endpoint');
  require(hook?.contentType === 'application/json' && hook.saveResponse === true, 'response_schema_unavailable');
  require(plain(hook?.body) && exact(Object.keys(hook.body).sort(), ['contactId', 'reference']), 'live_body_requires_only_reference_and_contact');
  require(hook?.body?.reference?.source === 'native_reference_picker' && hook.body.reference.fieldId === W19_REVIEW_IDS.reference &&
    typeof hook.body.reference.evidenceId === 'string' && hook.body.reference.evidenceId.trim().length > 0, 'reference_picker_unverified');
  require(hook?.body?.contactId?.source === 'current_workflow_contact_picker' && typeof hook.body.contactId.evidenceId === 'string' &&
    hook.body.contactId.evidenceId.trim().length > 0, 'contact_picker_unverified');
  // Strict AND of typed booleans. Top-level proceed intentionally stays false.
  require(exact(o.verifiedBranch, { operator: 'AND', checks: [
    { path: 'ok', operator: 'equals', value: true },
    { path: 'completion.verified', operator: 'equals', value: true },
    { path: 'completion.proceed', operator: 'equals', value: true },
  ] }), 'completion_branch_must_use_three_typed_booleans');
  require(exact(o.verifiedActions, ['remove_contact_from_current_workflow']), 'unverified_or_financial_action_present');
  require(exact(o.fallbackActions, []), 'fallback_must_have_no_side_effects');
  require(o.schemaProbeSeparate === true, 'schema_probe_must_not_be_live_body');
  const association = o.association;
  require(association?.mode === 'manual_email' && association.fieldId === 'email' && association.required === true &&
    association.stickyContact === false && association.autoresponder === false && association.emailNotification === false,
  'native_customer_association_not_verified');
  require(o.ordinaryCrewNativeLaunch === false, 'crew_email_permission_must_not_expand');
  return Object.freeze({ status: blockers.length ? 'blocked' : 'draft_contract_ready_for_review',
    activationAllowed: false, submissionAllowed: false, paymentOrCommissionAuthority: false,
    blockers: Object.freeze(blockers) });
}

