import {createHash} from "node:crypto";
import {and,desc,eq,gte,inArray,isNull,or,sql} from "drizzle-orm";
import {getDb,schema} from "@egc/database";
import {recomputeLeadState} from "@egc/lead-audit";
import {communicationBodyEvidence} from "./communication-body-evidence.js";
/** Shared customer-message execution: one durable claim per logical request, provider
 * read-back before success, and no automatic resend of an unknown outcome. MCP sends and
 * Action Center sends use exactly this module; apps/mcp re-exports it unchanged.
 */
type Db=ReturnType<typeof getDb>;
export type CommunicationProvider={sendMessage:(payload:any)=>Promise<Record<string,unknown>>;getMessage:(id:string)=>Promise<Record<string,unknown>>;getEmailMessage?:(id:string)=>Promise<Record<string,unknown>>};
// now: every persisted and compared instant (default: the process clock, as before).
// source: the audit row source label (default "mcp", as before).
export type CommunicationOptions={now?:()=>Date;source?:string;beforeClaim?:(tx:Parameters<Parameters<Db["transaction"]>[0]>[0])=>Promise<unknown>};
type Provider=CommunicationProvider;
const text=(v:unknown)=>typeof v==="string"?v:null;
const record=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** The stored/sent payload and its hash. Attachments are exact URL strings in order and are
 * part of the hash; a payload without attachments keeps the key absent so its hash is the
 * same one computed before attachments existed (in-flight requests still replay).
 */
export function normalizedCommunicationPayload(raw:Record<string,unknown>) {
  const attachments=raw.attachments;
  if(attachments!==undefined&&attachments!==null&&(!Array.isArray(attachments)||attachments.some(url=>typeof url!=="string"||!url)))throw new Error("message_attachments_invalid");
  const payload={type:raw.type,contactId:raw.contactId,message:raw.message,subject:raw.subject??null,emailFrom:raw.emailFrom??null,emailTo:raw.emailTo??null,fromNumber:raw.fromNumber??null,toNumber:raw.toNumber??null,...(Array.isArray(attachments)&&attachments.length?{attachments:[...attachments] as string[]}:{})};
  return {payload,hash:createHash("sha256").update(JSON.stringify(payload)).digest("hex")};
}
async function readProviderMessage(provider:Provider,id:string,payload:Record<string,unknown>):Promise<Record<string,unknown>>{
  const response=await provider.getMessage(id),message=record(response.message??response);
  if(payload.type==="SMS"){
    if(message.fromNumber!=null&&message.from!=null&&message.fromNumber!==message.from)throw new Error("sms_sender_evidence_conflict");
    return {...message,fromNumber:message.fromNumber??message.from,toNumber:message.toNumber??message.to};
  }
  if(message.emailTo!==undefined)return message;
  const meta=record(record(message.meta).email),ids=meta.messageIds??record(meta.email).messageIds;
  if(!provider.getEmailMessage||!Array.isArray(ids)||ids.length!==1||typeof ids[0]!=="string")return message;
  const result=await provider.getEmailMessage(ids[0]),email=record(result.email??result);
  if(email.id!==ids[0]||email.threadId!==id||email.contactId!==message.contactId||email.conversationId!==message.conversationId||email.direction!==message.direction||email.body!==message.body||!Array.isArray(email.to)||email.to.length!==1)throw new Error("email_evidence_mismatch");
  return {...message,subject:email.subject,emailTo:email.to[0],emailFrom:email.from,status:email.status,dateAdded:email.dateAdded};
}
function channelMatches(message:Record<string,unknown>,expected:unknown) {
  const channel=String(message.messageType??message.type??"").toLowerCase();
  return expected==="SMS"?["sms","type_sms","2"].includes(channel):["email","type_email","3"].includes(channel);
}
function messageMatches(message:Record<string,unknown>,payload:Record<string,unknown>,id:string,createdAt:Date){
  const body=communicationBodyEvidence(payload.message,message.body,payload.type);
  if(!channelMatches(message,payload.type)||message.id!==id||message.contactId!==payload.contactId||!body||message.direction!=="outbound")return false;
  // Broader body proof is allowed only with an explicit exact recipient and the
  // same bounded occurrence evidence required when recovering a missing ID.
  if(body.version===2){const at=Date.parse(String(message.dateAdded??""));if(typeof payload.toNumber!=="string"||!payload.toNumber||message.toNumber!==payload.toNumber||!Number.isFinite(at)||at<createdAt.valueOf()-1000||at>createdAt.valueOf()+120000)return false;}
  // Explicit recipient/sender/subject constraints cannot be certified solely by
  // matching the contact and body. Missing provider evidence stays pending.
  return ["subject","emailFrom","emailTo","fromNumber","toNumber"].every(key=>payload[key]===null||payload[key]===undefined||message[key]===payload[key]);
}
const failedStatuses=new Set(["failed","undelivered","cancelled","canceled","bounced","rejected"]);
const acceptedStatuses=new Set(["queued","pending","scheduled","sent","delivered","read","opened","clicked"]);
async function pendingReceipt(db:Db,id:string,error:string,clock:()=>Date){
  await db.update(schema.communicationExecutions).set({status:"unknown",lastError:error,updatedAt:clock()}).where(and(eq(schema.communicationExecutions.id,id),inArray(schema.communicationExecutions.status,["in_flight","unknown"])));
  const [latest]=await db.select().from(schema.communicationExecutions).where(eq(schema.communicationExecutions.id,id)).limit(1);
  return latest&&["accepted","failed"].includes(latest.status)?{ok:latest.status==="accepted",...latest.response,executionId:id,duplicatePrevented:true,verificationFresh:false}:null;
}
export async function executeCommunication(input:{requestId:string;actorId:string;contactId:string;payload:Record<string,unknown>;duplicateWindowMinutes?:number},provider:Provider,db:Db=getDb(),options:CommunicationOptions={}) {
  const clock=options.now??(()=>new Date()),source=options.source??"mcp";
  const {payload,hash}=normalizedCommunicationPayload(input.payload);
  const claim=await db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`message:${input.contactId}`},0))`);
    const [prior]=await tx.select().from(schema.communicationExecutions).where(and(eq(schema.communicationExecutions.actorId,input.actorId),eq(schema.communicationExecutions.requestId,input.requestId))).limit(1);
    if(prior){if(prior.payloadHash!==hash||prior.contactId!==input.contactId)throw new Error("message_request_conflict");return {row:prior,created:false};}
    const [duplicate]=await tx.select().from(schema.communicationExecutions).where(and(eq(schema.communicationExecutions.contactId,input.contactId),eq(schema.communicationExecutions.payloadHash,hash),or(inArray(schema.communicationExecutions.status,["in_flight","unknown"]),gte(schema.communicationExecutions.createdAt,new Date(clock().valueOf()-(input.duplicateWindowMinutes??10)*60000))))).orderBy(desc(schema.communicationExecutions.createdAt)).limit(1);
    if(duplicate)return {row:duplicate,created:false};
    // Lock/recheck the approved task in this same transaction as the execution claim.
    // A task edit that wins this lock prevents a stale sender/body from being sent.
    await options.beforeClaim?.(tx);
    // An injected clock also stamps the claim, so approval/claim ordering never mixes clocks.
    const [row]=await tx.insert(schema.communicationExecutions).values({requestId:input.requestId,actorId:input.actorId,contactId:input.contactId,channel:String(payload.type),payloadHash:hash,payload,...(options.now?{createdAt:clock(),updatedAt:clock()}:{})}).returning();
    if(!row)throw new Error("message_claim_failed");
    await tx.insert(schema.auditLogs).values({actor:input.actorId,action:"communication.authorized",entity:"communication_execution",entityId:row.id,newValue:{contactId:input.contactId,channel:payload.type,payloadHash:hash},source});
    return {row,created:true};
  });
  let messageId=claim.row.providerMessageId;
  if(claim.created) {
    try {
      const response=await provider.sendMessage(Object.fromEntries(Object.entries(payload).filter(([,v])=>v!==null)));
      messageId=text(response.messageId)??text(record(response.message).id);
      if(!messageId)throw new Error("message_ack_missing_id");
      // Record the provider ID before read-back. A crash after this write recovers by
      // that exact ID; a crash before it remains explicitly unknown, never resends.
      const [bound]=await db.update(schema.communicationExecutions).set({providerMessageId:messageId,updatedAt:clock()}).where(and(eq(schema.communicationExecutions.id,claim.row.id),or(isNull(schema.communicationExecutions.providerMessageId),eq(schema.communicationExecutions.providerMessageId,messageId)))).returning({id:schema.communicationExecutions.id});
      if(!bound)throw new Error("message_provider_id_conflict");
    }catch {
      const verified=await pendingReceipt(db,claim.row.id,"provider_write_outcome_unknown",clock);if(verified)return verified;
      return {ok:false,error:"message_outcome_unknown",executionId:claim.row.id,retryMode:"reconcile_only",requestId:input.requestId};
    }
  }
  if(!messageId)return {ok:false,error:"message_outcome_unknown",executionId:claim.row.id,retryMode:"reconcile_only",requestId:input.requestId};
  const readStartedAt=clock();
  try {
    const message=await readProviderMessage(provider,messageId,payload);
    const status=text(message.status)?.toLowerCase()??"unknown";
    if(!messageMatches(message,payload,messageId,claim.row.createdAt)||!failedStatuses.has(status)&&!acceptedStatuses.has(status))throw new Error("message_readback_mismatch");
    const failed=failedStatuses.has(status);
    const occurred=Date.parse(String(message.dateAdded??""));
    const receipt={messageId,conversationId:text(message.conversationId),status,delivered:["delivered","read","opened","clicked"].includes(status),verifiedAt:clock().toISOString(),matchEvidence:{...communicationBodyEvidence(payload.message,message.body,payload.type)!,channel:payload.type==="SMS"?"sms":"email",recipient:text(payload.type==="SMS"?message.toNumber:message.emailTo),...(payload.type==="SMS"?{fromNumber:text(message.fromNumber)}:{}),subject:text(message.subject)??"",occurredAt:Number.isFinite(occurred)?new Date(occurred).toISOString():null,payloadHash:hash}};
    const effective=await db.transaction(async tx=>{
      const [latest]=await tx.select().from(schema.communicationExecutions).where(eq(schema.communicationExecutions.id,claim.row.id)).for("update");
      if(!latest||latest.providerMessageId!==messageId)throw new Error("message_provider_id_conflict");
      if(latest.response&&latest.verifiedAt&&(latest.verifiedAt>readStartedAt||latest.response.delivered===true&&!receipt.delivered))return {ok:latest.status==="accepted",...latest.response,executionId:latest.id,duplicatePrevented:true,verificationFresh:false};
      await tx.update(schema.communicationExecutions).set({status:failed?"failed":"accepted",response:receipt,lastError:failed?"provider_delivery_failed":null,verifiedAt:clock(),updatedAt:clock()}).where(eq(schema.communicationExecutions.id,claim.row.id));
      await tx.insert(schema.auditLogs).values({actor:input.actorId,action:"communication.provider_verified",entity:"communication_execution",entityId:claim.row.id,newValue:receipt,source});
      return null;
    });
    if(effective)return effective;
    return {ok:!failed,...receipt,executionId:claim.row.id,duplicatePrevented:!claim.created,providerMessage:message};
  }catch {
    const verified=await pendingReceipt(db,claim.row.id,"provider_readback_unavailable",clock);if(verified)return verified;
    return {ok:false,error:"message_verification_pending",executionId:claim.row.id,messageId,retryMode:"reconcile_only",requestId:input.requestId};
  }
}

export async function reconcileCommunication(executionId:string,providerMessageId:string|undefined,actorId:string,provider:Provider,db:Db=getDb(),options:CommunicationOptions={}) {
  const [row]=await db.select().from(schema.communicationExecutions).where(eq(schema.communicationExecutions.id,executionId)).limit(1);
  if(!row)return {ok:false,error:"communication_execution_not_found"};
  if(providerMessageId && row.providerMessageId && providerMessageId!==row.providerMessageId)return {ok:false,error:"provider_message_id_conflict"};
  if(providerMessageId&&!row.providerMessageId) {
    let message:Record<string,unknown>;
    try {message=await readProviderMessage(provider,providerMessageId,row.payload);}catch{return {ok:false,error:"provider_readback_unavailable"};}
    const at=Date.parse(String(message.dateAdded??""));
    if(!messageMatches(message,row.payload,providerMessageId,row.createdAt)||!Number.isFinite(at)||at<row.createdAt.valueOf()-1000||at>row.createdAt.valueOf()+120000)return {ok:false,error:"message_reconciliation_evidence_mismatch"};
    await db.transaction(async tx=>{
      const [locked]=await tx.select().from(schema.communicationExecutions).where(eq(schema.communicationExecutions.id,row.id)).for("update");
      if(!locked||locked.providerMessageId&&locked.providerMessageId!==providerMessageId)throw new Error("message_reconciliation_conflict");
      await tx.update(schema.communicationExecutions).set({providerMessageId,updatedAt:(options.now??(()=>new Date()))()}).where(eq(schema.communicationExecutions.id,row.id));
      await tx.insert(schema.auditLogs).values({actor:actorId,action:"communication.reconciled_by_provider_id",entity:"communication_execution",entityId:row.id,newValue:{providerMessageId},source:options.source??"mcp"});
    });
  }
  return executeCommunication({requestId:row.requestId,actorId:row.actorId,contactId:row.contactId,payload:row.payload},provider,db,options);
}

export type RecipientProvider={getContact:(id:string)=>Promise<Record<string,unknown>>};
/** Live recipient preflight shared by every customer send: the saved contact, the lead's
 * do-not-contact flag, the provider contact's DND (global and per channel) and, when the
 * caller names a destination, an exact match with the provider's phone or email. `connect`
 * is only called once the saved contact exists, exactly as the MCP send always did.
 */
export async function preflightRecipient<P extends RecipientProvider>(input:{contactId:string;channel:"SMS"|"Email";toNumber?:string|undefined;emailTo?:string|undefined},connect:()=>P,db:Db=getDb()) {
  const [contact]=await db.select().from(schema.contacts).where(eq(schema.contacts.id,input.contactId)).limit(1);
  if(!contact)return {ok:false as const,error:"contact_not_found"};
  const [lead]=await db.select({dnd:schema.leads.doNotContact}).from(schema.leads).where(eq(schema.leads.contactId,input.contactId)).limit(1);
  const provider=connect();
  let live:Record<string,unknown>;
  try{const response=await provider.getContact(contact.providerId);live=record(response.contact??response);}catch{return {ok:false as const,error:"contact_preflight_unavailable"};}
  const restriction=record(record(live.dndSettings)[input.channel]);
  if(lead?.dnd||live.dnd===true||restriction.status==="active")return {ok:false as const,error:"contact_do_not_contact"};
  const phone=text(live.phone)||undefined,email=text(live.email)||undefined;
  if(input.channel==="SMS" && (!phone || (input.toNumber && input.toNumber.replace(/\D/g,"")!==phone.replace(/\D/g,""))))return {ok:false as const,error:"verified_contact_phone_required"};
  if(input.channel==="Email" && (!email || (input.emailTo && input.emailTo.toLowerCase()!==email.toLowerCase())))return {ok:false as const,error:"verified_contact_email_required"};
  return {ok:true as const,contact,live,provider,phone,email};
}

/** Mirror one provider-verified outbound message into the local conversation history. */
export async function persistOutboundMessage(input: {
  contactId: string;
  contactProviderId: string;
  locationId: string;
  channel: "SMS" | "Email";
  body: string;
  providerMessageId: string;
  conversationProviderId: string;
  providerPayload: Record<string, unknown>;
  occurredAt?: Date;
},db:Db=getDb(),now:()=>Date=()=>new Date()) {
  const occurredAt = input.occurredAt ?? now();

  const [conversation] = await db.insert(schema.conversations).values({
    providerId: input.conversationProviderId,
    contactId: input.contactId,
    raw: {
      id: input.conversationProviderId,
      contactId: input.contactProviderId,
      locationId: input.locationId
    }
  }).onConflictDoUpdate({
    target: schema.conversations.providerId,
    set: {
      contactId: input.contactId,
      raw: {
        id: input.conversationProviderId,
        contactId: input.contactProviderId,
        locationId: input.locationId
      },
      updatedAt: now()
    }
  }).returning();

  await db.insert(schema.messages).values({
    providerId: input.providerMessageId,
    conversationId: conversation?.id ?? null,
    contactId: input.contactId,
    type: input.channel === "SMS" ? "TYPE_SMS" : "TYPE_EMAIL",
    direction: "outbound",
    actorType: "automation",
    body: input.body,
    occurredAt,
    raw: input.providerPayload
  }).onConflictDoUpdate({
    target: schema.messages.providerId,
    set: {
      conversationId: conversation?.id ?? null,
      contactId: input.contactId,
      type: input.channel === "SMS" ? "TYPE_SMS" : "TYPE_EMAIL",
      direction: "outbound",
      actorType: "automation",
      body: input.body,
      occurredAt,
      raw: input.providerPayload,
      updatedAt: now()
    }
  });

  await recomputeLeadState(input.contactId);
}
