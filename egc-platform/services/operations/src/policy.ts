import {createHash} from "node:crypto";
import {canonicalJson, type Json} from "@egc/lead-audit/operations-core";
import {OperationsError,type Actor,type Command} from "./contracts.js";
import {isMessageTaskKind} from "./action-kinds.js";

export function digest(value:unknown):string {
  // Date serialization is intentional at this storage boundary; the underlying JSON
  // helper rejects values that would otherwise silently disappear.
  return createHash("sha256").update(canonicalJson(value as Json)).digest("hex");
}
export const jsonRecord = (value:unknown):Record<string,unknown> => JSON.parse(JSON.stringify(value));
// Drafts parsed before action kinds v2 had no attachments key; the parser now defaults it
// to []. A missing list and an empty list mean the same draft, so both hash identically and
// a request first sent before the deploy still replays instead of conflicting.
export const withoutEmptyAttachments = <T,>(draft:T):T => {
  const attachments=draft && typeof draft==="object" ? (draft as {attachments?:unknown}).attachments : undefined;
  if (!Array.isArray(attachments) || attachments.length) return draft;
  const {attachments:_,...rest}=draft as Record<string,unknown>;return rest as T;
};
export function requestDigest(actor:Actor,command:Command):string {
  const stable=command.command==="task.create"?{...command,task:{...command.task,draft:withoutEmptyAttachments(command.task.draft)}}:
    command.command==="task.edit"&&command.changes.draft?{...command,changes:{...command.changes,draft:withoutEmptyAttachments(command.changes.draft)}}:
    command.command==="task.send"&&command.draft?{...command,draft:withoutEmptyAttachments(command.draft)}:command;
  return digest({actor:{id:actor.id,kind:actor.kind,role:actor.role,workspace:actor.workspace},command:stable});
}
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
  if (isMessageTaskKind(kind)) throw new OperationsError("message_completion_requires_provider_evidence",409);
  if (kind === "verify_deposit") throw new OperationsError("deposit_completion_requires_verified_payment",409);
}
