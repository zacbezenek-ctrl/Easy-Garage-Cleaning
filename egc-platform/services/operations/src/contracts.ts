import * as z from "zod/v4";

export const CONTRACT_VERSION = 1;
export const isoTime = z.string().datetime({ offset: true });
export const entityId = z.string().uuid();
export const portalId = z.string().min(1).max(180).regex(/^[A-Za-z0-9_-]+$/);
export const timeZone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", {timeZone:value}).format(); return true; } catch { return false; }
}, "Use an IANA timezone");
export const actorSchema = z.object({
  id: z.string().min(1).max(200),
  role: z.enum(["owner", "manager", "sales", "crew_lead", "crew", "integration"]),
  workspace: z.string().min(1).max(100),
  kind: z.enum(["human", "integration"])
}).strict();
export type Actor = z.infer<typeof actorSchema>;
export const taskKind = z.enum(["manual", "callback", "prepare_quote", "followup_message", "review_notes", "verify_deposit", "job_readiness"]);
export const priority = z.enum(["low", "medium", "high", "urgent"]);
export const waitingOn = z.enum(["none", "EGC", "customer", "provider"]);
export const evidence = z.object({
  source: z.enum(["staff", "message", "call", "recording", "portal_job", "provider"]),
  id: z.string().min(1).max(200),
  excerpt: z.string().max(2000).default("")
}).strict();
export const messageDraft = z.object({
  channel: z.enum(["sms", "email"]),
  recipient: z.string().min(3).max(320),
  subject: z.string().max(250).default(""),
  body: z.string().min(1).max(10000),
  sendWindowStart: isoTime,
  sendWindowEnd: isoTime
}).strict().superRefine((draft, ctx) => {
  if (Date.parse(draft.sendWindowEnd) <= Date.parse(draft.sendWindowStart))
    ctx.addIssue({code:"custom",message:"Send window must have positive duration"});
  if (draft.channel === "sms" && !/^\+[1-9]\d{6,14}$/.test(draft.recipient))
    ctx.addIssue({code:"custom",message:"SMS recipient must be an E.164 phone number"});
  if (draft.channel === "email" && !z.string().email().safeParse(draft.recipient).success)
    ctx.addIssue({code:"custom",message:"Email recipient is invalid"});
});
export type MessageDraft = z.infer<typeof messageDraft>;
const createFields = {
  title: z.string().trim().min(1).max(500),
  description: z.string().max(5000).default(""),
  kind: taskKind.default("manual"),
  priority: priority.default("medium"),
  assignedUserId: z.string().trim().min(1).max(200),
  dueAt: isoTime,
  timeZone: timeZone.default("America/Denver"),
  waitingOn: waitingOn.default("none"),
  reviewAt: isoTime.nullable().default(null),
  portalJobId: portalId.nullable().default(null),
  portalVisitId: portalId.nullable().default(null),
  contactId: entityId.nullable().default(null),
  jobId: entityId.nullable().default(null),
  completionCondition: z.string().trim().min(1).max(1000),
  sourceEvidence: z.array(evidence).max(30).default([]),
  dependencies: z.array(entityId).max(30).default([]),
  draft: messageDraft.nullable().default(null),
  dedupeKey: z.string().min(1).max(250).optional()
};
export const createTaskSchema = z.object(createFields).strict().superRefine((task, ctx) => {
  if (["customer", "provider"].includes(task.waitingOn) && !task.reviewAt)
    ctx.addIssue({code:"custom",message:"Waiting work requires a review time"});
  if (task.portalVisitId && !task.portalJobId)
    ctx.addIssue({code:"custom",message:"A visit link requires an exact portal record"});
  if (task.kind === "followup_message" && !task.draft)
    ctx.addIssue({code:"custom",message:"Message actions require the exact draft"});
  if (task.kind !== "followup_message" && task.draft)
    ctx.addIssue({code:"custom",message:"Only message actions contain a message draft"});
});
export const patchTaskSchema = z.object({
  title: createFields.title.optional(), description: z.string().max(5000).optional(),
  priority: priority.optional(), assignedUserId: createFields.assignedUserId.optional(),
  dueAt: isoTime.optional(), waitingOn: waitingOn.optional(), reviewAt: isoTime.nullable().optional(),
  status: z.enum(["open", "in_progress", "blocked"]).optional(),
  completionCondition: createFields.completionCondition.optional(),
  draft: messageDraft.nullable().optional()
}).strict().refine(value => Object.keys(value).length > 0, "At least one change is required");
const versioned = { taskId: entityId, revision: z.number().int().positive() };
const page = { offset: z.number().int().min(0).max(1000000).default(0), limit:z.number().int().min(1).max(200).default(50) };
export const commandSchema = z.discriminatedUnion("command", [
  z.object({command:z.literal("intelligence.report"),since:isoTime,until:isoTime,cohortSince:isoTime.optional(),cohortUntil:isoTime.optional()}).strict(),
  z.object({command:z.literal("intelligence.diagnostics")}).strict(),
  z.object({command:z.literal("intelligence.customer"),contactId:entityId}).strict(),
  z.object({command:z.literal("provider.note.ensure"),requestId:z.string().min(1).max(250),portalJobId:portalId,providerContactId:z.string().min(1).max(200),scope:z.string().regex(/^[a-z0-9_-]{1,100}$/),title:z.string().min(1).max(250),body:z.string().min(1).max(20000)}).strict(),
  z.object({command:z.literal("task.complete_from_message"),...versioned,executionId:entityId}).strict(),
  z.object({command:z.literal("portal.note.add"),requestId:entityId,portalJobId:portalId,expectedRevision:z.string().min(1),body:z.string().trim().min(1).max(10000),supersedes:entityId.optional()}).strict(),
  z.object({command:z.literal("portal.project.ensure"),requestId:entityId,portalJobId:portalId,expectedRevision:z.string().min(1)}).strict(),
  z.object({command:z.literal("portal.job.edit"),requestId:entityId,portalJobId:portalId,expectedRevision:z.string().min(1),changes:z.object({operationalScope:z.string().max(20000).optional(),status:z.enum(["dispatched","in_progress","completed"]).optional()}).strict(),reason:z.string().trim().min(3).max(2000),occurredAt:isoTime.optional(),completionEvidence:z.string().min(10).max(5000).optional()}).strict(),
  z.object({command:z.literal("schedule.sync_provider"),portalVisitId:portalId,requestId:z.string().min(1).max(250),runAutomations:z.boolean().default(false),contactProviderId:z.string().min(1).max(200).optional()}).strict(),
  z.object({command:z.literal("schedule.adopt"),requestId:entityId,proof:z.object({
    source:z.enum(["ghl_appointment","local_job"]),sourceId:portalId,sourceRevision:z.string().min(1).max(200),contactProviderId:portalId,
    providerContact:z.object({id:portalId,locationId:portalId.optional(),name:z.string().max(500).optional(),firstName:z.string().max(250).optional(),lastName:z.string().max(250).optional(),phone:z.string().max(100).optional(),email:z.string().max(320).optional(),address1:z.string().max(1000).optional()}).strict(),
    kind:z.enum(["walkthrough","job"]),startAt:isoTime,endAt:isoTime,address:z.string().trim().min(1).max(1000),title:z.string().trim().min(1).max(500),
    originalBookingAt:isoTime.nullable(),sourceCreatedAt:isoTime.nullable(),verifiedAt:isoTime,
    providerAppointmentId:portalId.nullable(),providerCalendarId:portalId.nullable(),providerStatus:z.enum(["confirmed","new"]).nullable(),
    localJobId:entityId.nullable(),normalizedLocalAppointmentId:entityId.nullable(),evidenceIds:z.array(z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/)).min(1).max(30)
  }).strict()}).strict(),
  z.object({command:z.literal("schedule.link_customer"),portalVisitId:portalId,expectedRevision:z.string().min(1),providerContact:z.record(z.string(),z.unknown())}).strict(),
  z.object({command:z.literal("schedule.resolve"),portalVisitId:portalId}).strict(),
  z.object({command:z.literal("schedule.mutate"),requestId:entityId,mode:z.enum(["create","update","cancel"]),portalVisitId:portalId.optional(),portalCustomerId:portalId,sourceWalkthroughId:portalId.optional(),
    expectedRevision:z.string().min(1).optional(),kind:z.enum(["walkthrough","job"]).optional(),changes:z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),time:z.string().regex(/^\d{2}:\d{2}$/).optional(),endTime:z.string().regex(/^\d{2}:\d{2}$/).optional(),title:z.string().min(1).max(500).optional(),assignedTo:z.string().min(1).max(200).optional(),address:z.string().max(1000).optional()}).strict()}).strict(),
  z.object({command:z.literal("schedule.bind_provider"),operationId:entityId,portalVisitId:portalId,expectedRevision:z.string().min(1),event:z.record(z.string(),z.unknown())}).strict(),
  z.object({command:z.literal("status")}).strict(),
  z.object({command:z.literal("calendar"),startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),endDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),timeZone:timeZone.default("America/Denver"),...page}).strict(),
  z.object({command:z.literal("portal.job"),jobId:portalId}).strict(),
  z.object({command:z.literal("portal.evidence"),contactProviderIds:z.array(portalId).min(1).max(500)}).strict(),
  z.object({command:z.literal("portal.revenue"),from:isoTime,to:isoTime}).strict(),
  z.object({command:z.literal("portal.rules")}).strict(),
  z.object({command:z.literal("inbound.reconcile"),lookbackDays:z.number().int().min(1).max(90).optional(),limit:z.number().int().min(1).max(200).default(50)}).strict(),
  z.object({command:z.literal("portal.members")}).strict(),
  z.object({command:z.literal("queue"), view:z.enum(["all", "due", "overdue", "approvals", "blocked", "waiting", "ownerless"]).default("due"),
    dueBefore:isoTime, owner:z.string().max(200).optional(), ...page}).strict(),
  z.object({command:z.literal("task.get"),taskId:entityId}).strict(),
  z.object({command:z.literal("task.create"),task:createTaskSchema}).strict(),
  z.object({command:z.literal("task.edit"),...versioned,changes:patchTaskSchema}).strict(),
  z.object({command:z.literal("task.complete"),...versioned,outcome:z.string().trim().min(3).max(5000)}).strict(),
  z.object({command:z.literal("task.cancel"),...versioned,reason:z.string().trim().min(3).max(2000)}).strict(),
  z.object({command:z.literal("task.snooze"),...versioned,until:isoTime,reason:z.string().trim().min(3).max(1000)}).strict(),
  z.object({command:z.literal("tasks.approve"),items:z.array(z.object({...versioned,previewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(30),expiresAt:isoTime}).strict(),
  z.object({command:z.literal("task.reject"),...versioned,reason:z.string().trim().min(3).max(2000)}).strict(),
  z.object({command:z.literal("brief.create"),dueBefore:isoTime,timeZone:timeZone.default("America/Denver")}).strict(),
  z.object({command:z.literal("brief.get"),briefId:entityId,...page}).strict(),
  z.object({command:z.literal("brief.latest"),...page}).strict(),
  z.object({command:z.literal("history"),contactId:entityId.optional(),portalJobId:portalId.optional(),...page}).strict().refine(c=>Boolean(c.contactId||c.portalJobId),"An exact contact or portal record is required")
]);
export type Command = z.infer<typeof commandSchema>;
export const WRITE_COMMANDS = new Set(["provider.note.ensure","portal.note.add","portal.job.edit","portal.project.ensure","inbound.reconcile","task.create","task.edit","task.complete","task.complete_from_message","task.cancel","task.snooze","tasks.approve","task.reject","brief.create","schedule.mutate","schedule.bind_provider","schedule.sync_provider","schedule.link_customer","schedule.adopt"]);
export const requestSchema = z.object({requestId:entityId,body:commandSchema}).strict();
export const signedClaimsSchema = z.object({
  v:z.literal(CONTRACT_VERSION),iss:z.enum(["portal","mcp"]),aud:z.enum(["egc-operations","egc-portal"]),
  iat:z.number().int(),nonce:entityId,actor:actorSchema,request:requestSchema
}).strict();
export type SignedClaims = z.infer<typeof signedClaimsSchema>;

export class OperationsError extends Error {
  constructor(public code:string, public status=400, public details:Record<string,unknown>={}) { super(code); }
}
export function authorize(actor:Actor, command:Command, workspace:string) {
  if (!actorSchema.safeParse(actor).success || (actor.role === "integration") !== (actor.kind === "integration")) throw new OperationsError("invalid_actor",403);
  if (actor.workspace !== workspace) throw new OperationsError("workspace_forbidden",403);
  if(command.command==='schedule.adopt'&&(actor.kind!=='integration'||actor.role!=='integration'||actor.id!=='booking-adoption-worker'))throw new OperationsError('schedule_adoption_internal_only',403);
  if (!["owner","manager","sales","integration"].includes(actor.role)) throw new OperationsError("role_forbidden",403);
  if (["tasks.approve","task.reject"].includes(command.command) &&
      (actor.kind !== "human" || !["owner","manager"].includes(actor.role)))
    throw new OperationsError("human_manager_approval_required",403);
  if (actor.kind === "integration" && WRITE_COMMANDS.has(command.command) && !["provider.note.ensure","portal.note.add","portal.job.edit","portal.project.ensure","inbound.reconcile","task.create","task.edit","task.snooze","task.complete","task.complete_from_message","task.cancel","brief.create","schedule.mutate","schedule.bind_provider","schedule.sync_provider","schedule.link_customer","schedule.adopt"].includes(command.command))
    throw new OperationsError("integration_write_forbidden",403);
}
