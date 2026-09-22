import { READ_SCOPE, WRITE_SCOPE } from "./oauth.js";
import { RECORDING_WRITE_TOOLS } from "./recording-tools.js";
import { META_CONVERSION_WRITE_TOOLS } from "./meta-conversion-tools.js";
import { CUSTOMER_STATE_WRITE_TOOLS } from './customer-state-tools.js';

export const WRITE_TOOLS = new Set<string>([
  "actions.complete_from_message",
  ...RECORDING_WRITE_TOOLS,
  ...META_CONVERSION_WRITE_TOOLS,
  ...CUSTOMER_STATE_WRITE_TOOLS,
  "jobs.create",
  "jobs.update",
  "jobs.add_note",
  "walkthroughs.create_draft",
  "walkthroughs.update_draft",
  "walkthroughs.approve",
  "contacts.create",
  "contacts.update",
  "contacts.add_tags",
  "contacts.remove_tags",
  "opportunities.create",
  "opportunities.update",
  "appointments.create",
  "appointments.update",
  "appointments.cancel",
  "appointments.reconcile",
  "egc.schedule_visit",
  "appointments.delete",
  "conversations.send_message",
  "send_sms",
  "communications.reconcile",
  "egc.add_job_note",
  "egc.update_job_operations",
  "egc.link_project",
  "egc.ensure_booking",
  "egc.send_followup",
  "tasks.create",
  "tasks.update",
  "tasks.complete"
]);

export function requiredToolScope(toolName: string) {
  return WRITE_TOOLS.has(toolName) ? WRITE_SCOPE : READ_SCOPE;
}
