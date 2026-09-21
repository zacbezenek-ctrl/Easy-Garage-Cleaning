import {createHash} from "node:crypto";
import {canonicalJson, type Json} from "@egc/lead-audit/operations-core";
import {OperationsError,type Actor} from "./contracts.js";

export function digest(value:unknown):string {
  // Date serialization is intentional at this storage boundary; the underlying JSON
  // helper rejects values that would otherwise silently disappear.
  return createHash("sha256").update(canonicalJson(value as Json)).digest("hex");
}
export const jsonRecord = (value:unknown):Record<string,unknown> => JSON.parse(JSON.stringify(value));
export function assertEditable(actor:Actor,task:{status:string;assignedUserId:string|null}) {
  if (!["open","in_progress","blocked"].includes(task.status)) throw new OperationsError("task_is_closed",409);
  if (actor.role === "sales" && task.assignedUserId !== actor.id) throw new OperationsError("task_not_owned",403);
}
export function assertTiming(task:{waitingOn:string;reviewAt:Date|null;dueAt:Date|null;assignedUserId:string|null}) {
  if (!task.assignedUserId?.trim()) throw new OperationsError("owner_required",400);
  if (!task.dueAt) throw new OperationsError("due_time_required",400);
  if (["customer","provider"].includes(task.waitingOn) && !task.reviewAt) throw new OperationsError("review_time_required",400);
}
export function assertCompletion(kind:string) {
  if (kind === "followup_message") throw new OperationsError("message_completion_requires_provider_evidence",409);
  if (kind === "verify_deposit") throw new OperationsError("deposit_completion_requires_verified_payment",409);
}
