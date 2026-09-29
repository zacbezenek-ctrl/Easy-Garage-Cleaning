import * as z from "zod/v4";
import {isMessageTaskKind,MESSAGE_ATTACHMENT_KINDS,TASK_KINDS} from "./action-kinds.js";
import {HUB_COMMANDS,HUB_COMMAND_POLICY,HUB_WRITE_COMMANDS,PORTAL_PASSTHROUGH,hubCommandDenial,hubCommandPolicy,isHubCommandName,type HubCommandPolicy} from "./hub-commands.js";
import {BRIDGE_COMMAND_POLICY,bridgeCommandDenial,bridgeCommandPolicy,type BridgeCommandPolicy} from "./bridge-command-policy.js";
export * from "./hub-commands.js";
export * from "./bridge-command-policy.js";
import {SPEND_COMMANDS,SPEND_WRITE_COMMANDS,isSpendCommand,spendCommandDenial} from "./spend-commands.js";
export * from "./spend-commands.js";

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
// A Hub user on whose behalf an MCP OAuth grant acts. The actor stays an integration;
// the delegate only narrows what that grant may do. The assertion is the Hub-signed
// grant (service-auth verifyMcpGrant), so a receiver need not trust the MCP's word.
export const DELEGATE_ROLES = ["owner", "manager", "sales", "crew_lead", "crew"] as const;
export const delegateSchema = z.object({
  user: z.string().regex(/^[a-z0-9][a-z0-9_.@-]{0,119}$/),
  role: z.enum(DELEGATE_ROLES),
  assertion: z.string().min(16).max(8200)
}).strict();
export type Delegate = z.infer<typeof delegateSchema>;
export const taskKind = z.enum(TASK_KINDS);
export const priority = z.enum(["low", "medium", "high", "urgent"]);
export const waitingOn = z.enum(["none", "EGC", "customer", "provider"]);
export const evidence = z.object({
  source: z.enum(["staff", "message", "call", "recording", "portal_job", "provider"]),
  id: z.string().min(1).max(200),
  excerpt: z.string().max(2000).default("")
}).strict();
// Customer-facing links are stored in WHATWG canonical form (the parsed URL's href), so
// what a manager approves, what the guard compares and what a sender delivers are the
// same string: "HTTPS://A.com\x", "https:a.com/x" and "https://a.com/x" all become one URL.
// Invisible format characters, loopback/IP-literal and single-label hosts are refused.
const publicHost = (host:string) => {
  const name=host.replace(/\.$/,"").toLowerCase();
  return name.includes(".") && !name.endsWith(".localhost") && !/^\d{1,3}(\.\d{1,3}){3}$/.test(name) && !name.startsWith("[");
};
const canonicalUrl = (value:string) => { try { return new URL(value).href; } catch { return value; } };
const httpsUrl = z.string().min(1).max(2000).refine(value => {
  try { const url=new URL(value); return url.protocol==="https:" && publicHost(url.hostname) && !url.username && !url.password && !/[\s\u0000-\u001f\u007f]|\p{Cf}/u.test(value); } catch { return false; }
}, "Attachments require a public https URL without credentials").overwrite(canonicalUrl)
  .refine(value => value.length<=2000, "Attachment URLs must be at most 2000 characters once canonicalized");
export const messageAttachment = z.object({
  kind: z.enum(MESSAGE_ATTACHMENT_KINDS),
  url: httpsUrl,
  label: z.string().trim().min(1).max(120),
  refId: z.string().regex(/^[A-Za-z0-9:._-]{1,180}$/).nullable().default(null)
}).strict();
export type MessageAttachment = z.infer<typeof messageAttachment>;
export const messageDraft = z.object({
  channel: z.enum(["sms", "email"]),
  recipient: z.string().min(3).max(320),
  subject: z.string().max(250).default(""),
  body: z.string().min(1).max(10000),
  sendWindowStart: isoTime,
  sendWindowEnd: isoTime,
  attachments: z.array(messageAttachment).max(10).default([])
}).strict().superRefine((draft, ctx) => {
  if (Date.parse(draft.sendWindowEnd) <= Date.parse(draft.sendWindowStart))
    ctx.addIssue({code:"custom",message:"Send window must have positive duration"});
  if (draft.channel === "sms" && !/^\+[1-9]\d{6,14}$/.test(draft.recipient))
    ctx.addIssue({code:"custom",message:"SMS recipient must be an E.164 phone number"});
  if (draft.channel === "email" && !z.string().email().safeParse(draft.recipient).success)
    ctx.addIssue({code:"custom",message:"Email recipient is invalid"});
  // URLs are canonical here, so case, "\" and "//" spellings of one link are duplicates.
  if (Array.isArray(draft.attachments) && new Set(draft.attachments.map(a=>a?.url)).size !== draft.attachments.length)
    ctx.addIssue({code:"custom",message:"Each attachment URL may appear only once",path:["attachments"]});
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
  if (isMessageTaskKind(task.kind) && !task.draft)
    ctx.addIssue({code:"custom",message:"Message actions require the exact draft"});
  if (!isMessageTaskKind(task.kind) && task.draft)
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
const adoptionOperationalScope=z.object({
  sourceType:z.literal("local_job"),sourceId:entityId,sourceCreatedAt:isoTime.nullable(),sourceUpdatedAt:isoTime.nullable(),serviceType:z.string().max(500).nullable(),accessNotes:z.string().max(10000).nullable(),
  itemsKeep:z.array(z.string().max(1000)).max(100),itemsRelocate:z.array(z.string().max(1000)).max(100),itemsRemove:z.array(z.string().max(1000)).max(100),
  estimatedLaborHours:z.number().min(0).max(9999.99).nullable()
}).strict().refine(scope=>[scope.serviceType||"",scope.accessNotes||"",...scope.itemsKeep,...scope.itemsRelocate,...scope.itemsRemove].reduce((sum,text)=>sum+text.length,0)<=18000,"Operational scope exceeds the bounded source text limit");
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
    localJobId:entityId.nullable(),normalizedLocalAppointmentId:entityId.nullable(),evidenceIds:z.array(z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/)).min(1).max(30),operationalScope:adoptionOperationalScope.nullable().optional()
  }).strict().refine(proof=>!proof.operationalScope||proof.operationalScope.sourceId===proof.localJobId,"Operational scope must reference the exact local job")}).strict(),
  z.object({command:z.literal("schedule.link_customer"),portalVisitId:portalId,expectedRevision:z.string().min(1),providerContact:z.record(z.string(),z.unknown())}).strict(),
  z.object({command:z.literal("schedule.resolve"),portalVisitId:portalId}).strict(),
  z.object({command:z.literal("schedule.mutate"),requestId:entityId,mode:z.enum(["create","update","cancel"]),portalVisitId:portalId.optional(),portalCustomerId:portalId,sourceWalkthroughId:portalId.optional(),
    expectedRevision:z.string().min(1).optional(),kind:z.enum(["walkthrough","job"]).optional(),changes:z.object({date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),time:z.string().regex(/^\d{2}:\d{2}$/).optional(),endTime:z.string().regex(/^\d{2}:\d{2}$/).optional(),title:z.string().min(1).max(500).optional(),assignedTo:z.string().min(1).max(200).optional(),address:z.string().max(1000).optional()}).strict()}).strict(),
  z.object({command:z.literal("schedule.bind_provider"),operationId:entityId,portalVisitId:portalId,expectedRevision:z.string().min(1),event:z.record(z.string(),z.unknown())}).strict(),
  z.object({command:z.literal("schedule.sync_due"),limit:z.number().int().min(1).max(25).default(25)}).strict(),
  z.object({command:z.literal("schedule.sync_failed"),requestId:entityId,portalVisitId:portalId,expectedRevision:z.string().min(1).max(200),syncRequestId:z.string().regex(/^[A-Za-z0-9:._-]{1,250}$/),code:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)}).strict(),
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
  // One-tap Action Center send: a signed-in person approves the exact reviewed preview (an
  // optional edited draft becomes the next revision first) and the approved message is sent.
  z.object({command:z.literal("task.send"),...versioned,previewHash:z.string().regex(/^[a-f0-9]{64}$/),draft:messageDraft.optional(),confirm:z.literal(true)}).strict(),
  z.object({command:z.literal("brief.create"),dueBefore:isoTime,timeZone:timeZone.default("America/Denver")}).strict(),
  z.object({command:z.literal("brief.get"),briefId:entityId,...page}).strict(),
  z.object({command:z.literal("brief.latest"),...page}).strict(),
  z.object({command:z.literal("history"),contactId:entityId.optional(),portalJobId:portalId.optional(),...page}).strict().refine(c=>Boolean(c.contactId||c.portalJobId),"An exact contact or portal record is required"),
  ...Object.values(HUB_COMMANDS),
  ...Object.values(SPEND_COMMANDS)
]);
export type Command = z.infer<typeof commandSchema>;
export const WRITE_COMMANDS = new Set(["provider.note.ensure","portal.note.add","portal.job.edit","portal.project.ensure","inbound.reconcile","task.create","task.edit","task.complete","task.complete_from_message","task.cancel","task.snooze","tasks.approve","task.reject","task.send","brief.create","schedule.mutate","schedule.bind_provider","schedule.sync_provider","schedule.sync_failed","schedule.link_customer","schedule.adopt",...HUB_WRITE_COMMANDS,...SPEND_WRITE_COMMANDS]);
/** The only principal allowed to read the schedule mirror queue and record its failures. */
export const SCHEDULE_SYNC_WORKER_ID = "schedule-sync-worker";
export const requestSchema = z.object({requestId:entityId,body:commandSchema}).strict();
export const signedClaimsSchema = z.object({
  v:z.literal(CONTRACT_VERSION),iss:z.enum(["portal","mcp"]),aud:z.enum(["egc-operations","egc-portal"]),
  iat:z.number().int(),nonce:entityId,actor:actorSchema,delegate:delegateSchema.optional(),request:requestSchema
}).strict();
export type SignedClaims = z.infer<typeof signedClaimsSchema>;

export class OperationsError extends Error {
  constructor(public code:string, public status=400, public details:Record<string,unknown>={}) { super(code); }
}
export function authorize(actor:Actor, command:Command, workspace:string, hubPolicies:Readonly<Record<string,HubCommandPolicy>>=HUB_COMMAND_POLICY, bridgePolicies:Readonly<Record<string,BridgeCommandPolicy>>=BRIDGE_COMMAND_POLICY) {
  if (!actorSchema.safeParse(actor).success || (actor.role === "integration") !== (actor.kind === "integration")) throw new OperationsError("invalid_actor",403);
  if (actor.workspace !== workspace) throw new OperationsError("workspace_forbidden",403);
  if(command.command==='schedule.adopt'&&(actor.kind!=='integration'||actor.role!=='integration'||actor.id!=='booking-adoption-worker'))throw new OperationsError('schedule_adoption_internal_only',403);
  if((command.command==="schedule.sync_due"||command.command==="schedule.sync_failed")&&(actor.kind!=="integration"||actor.role!=="integration"||actor.id!==SCHEDULE_SYNC_WORKER_ID))throw new OperationsError("schedule_sync_queue_internal_only",403);
  if (!["owner","manager","sales","integration"].includes(actor.role)) throw new OperationsError("role_forbidden",403);
  const hub=hubCommandPolicy(command.command,hubPolicies);
  // Fail closed: a hub.* command without a policy entry is never authorized.
  if (isHubCommandName(command.command) && !hub) throw new OperationsError("hub_command_unknown",403);
  const spendDenied=isSpendCommand(command.command)&&spendCommandDenial(actor);
  if (spendDenied) throw new OperationsError(spendDenied,403);
  const hubDenied=hub&&hubCommandDenial(actor,command,hub);
  if (hubDenied) throw new OperationsError(hubDenied,403);
  // SEC-04: the legacy commands the Hub runs answer to the same table the Hub enforces.
  const bridge=bridgeCommandPolicy(command,bridgePolicies);
  if (!bridge && !isHubCommandName(command.command) && PORTAL_PASSTHROUGH.has(command.command)) throw new OperationsError("bridge_command_unknown",403);
  const bridgeDenied=bridge&&bridgeCommandDenial(actor,bridge);
  if (bridgeDenied) throw new OperationsError(bridgeDenied,403);
  if (["tasks.approve","task.reject"].includes(command.command) &&
      (actor.kind !== "human" || !["owner","manager"].includes(actor.role)))
    throw new OperationsError("human_manager_approval_required",403);
  // A customer send is confirmed by a signed-in person; integrations (MCP) never send here.
  if (command.command === "task.send" && actor.kind !== "human") throw new OperationsError("human_send_confirmation_required",403);
  if (actor.kind === "integration" && WRITE_COMMANDS.has(command.command) && !["provider.note.ensure","portal.note.add","portal.job.edit","portal.project.ensure","inbound.reconcile","task.create","task.edit","task.snooze","task.complete","task.complete_from_message","task.cancel","brief.create","schedule.mutate","schedule.bind_provider","schedule.sync_provider","schedule.sync_failed","schedule.link_customer","schedule.adopt"].includes(command.command))
    throw new OperationsError("integration_write_forbidden",403);
}
/** A delegated MCP grant must name its delegate in the actor id, and only an owner or manager delegate may write. */
export function authorizeDelegate(actor:Actor, command:Command, delegate:Delegate|undefined) {
  if (!delegate) return;
  if (actor.kind !== "integration" || actor.role !== "integration" || !actor.id.startsWith(`mcp:${delegate.user}:`)) throw new OperationsError("delegate_invalid",403);
  if (WRITE_COMMANDS.has(command.command) && !["owner","manager"].includes(delegate.role)) throw new OperationsError("delegate_write_forbidden",403);
}
