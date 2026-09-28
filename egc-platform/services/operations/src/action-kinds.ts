/** Action kinds v2. Message kinds carry an exact reviewed draft and complete only from
 * verified provider delivery; internal kinds never carry a draft. The database guard
 * (migration 0013_action_kinds_v2 and sql/revision-guards.sql) enforces the same lists.
 */
export const MESSAGE_TASK_KINDS = ["followup_message","send_before_afters","send_insurance_certificate","send_quote","send_product_options","answer_question","deposit_reminder"] as const;
export const INTERNAL_TASK_KINDS = ["manual","callback","prepare_quote","review_notes","verify_deposit","job_readiness","schedule_job"] as const;
// Existing order first so stored rows, UI labels and schemas stay stable; v2 kinds are appended.
export const TASK_KINDS = ["manual","callback","prepare_quote","followup_message","review_notes","verify_deposit","job_readiness","send_before_afters","send_insurance_certificate","send_quote","send_product_options","schedule_job","answer_question","deposit_reminder"] as const;
// Contract decisions (P3-01), for later producers and senders:
// - The canonical attachment kinds are the ones below. The unit's prose names
//   before_after, quote_link and pay_link mean before_after_gallery, portal_quote and
//   payment_link. No input aliases are accepted: they would advertise two names per kind
//   in the MCP schema and the inferred type, and every stored row must use one name.
// - A task's "sourceQuote" is sourceEvidence[].excerpt (exact source text, at most 2000
//   characters) and its "due" is dueAt. There is no separate sourceQuote field.
// - A sender must put exactly the approved canonical URLs, in order, in the provider
//   payload's attachments string array; the guard and complete_from_message compare it.
export const MESSAGE_ATTACHMENT_KINDS = ["portal_quote","before_after_gallery","insurance_certificate","product_options","payment_link","url"] as const;
export type TaskKind = typeof TASK_KINDS[number];
export type MessageTaskKind = typeof MESSAGE_TASK_KINDS[number];
export type InternalTaskKind = typeof INTERNAL_TASK_KINDS[number];
const messageKinds:ReadonlySet<string> = new Set(MESSAGE_TASK_KINDS);
export const isMessageTaskKind = (kind:unknown):kind is MessageTaskKind => typeof kind==="string" && messageKinds.has(kind);
