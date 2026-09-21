import {randomUUID} from "node:crypto";
import {and,asc,eq,lt,lte,or,sql} from "drizzle-orm";
import {getDb,schema} from "@egc/database";
type Provider={getContactNotes:(id:string)=>Promise<Record<string,unknown>>;createContactNote:(id:string,body:string,title:string)=>Promise<Record<string,unknown>>};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const string=(v:unknown)=>typeof v==="string"&&v?v:null;

/** A recorded write intent is never re-sent. Recovery only reads for the durable
 * operation marker. Old uncertain writes without a marker require manual review. */
export async function processNoteOutbox(provider:Provider,db=getDb(),now=new Date(),eventId?:string) {
  const events=await db.transaction(async tx=>{
    const rows=await tx.select().from(schema.outboxEvents).where(and(eventId?eq(schema.outboxEvents.id,eventId):undefined,or(
      and(or(eq(schema.outboxEvents.processingStatus,"pending"),eq(schema.outboxEvents.processingStatus,"reconciling")),lte(schema.outboxEvents.availableAt,now)),
      and(eq(schema.outboxEvents.processingStatus,"processing"),lt(schema.outboxEvents.updatedAt,new Date(now.valueOf()-300000)))
    ))).orderBy(asc(schema.outboxEvents.availableAt)).limit(eventId?1:10).for("update",{skipLocked:true});
    const claimed=[];
    for(const row of rows){const claimToken=randomUUID(),payload:Record<string,unknown>={...row.payload,_egcClaimToken:claimToken};await tx.update(schema.outboxEvents).set({processingStatus:"processing",payload,updatedAt:now}).where(eq(schema.outboxEvents.id,row.id));claimed.push({...row,payload,claimToken});}
    return claimed;
  });
  const counts={processed:0,reconciling:0,failed:0,retrying:0,leaseLost:0};
  for(const event of events) {
    let payload=event.payload,writeAttempted=payload._egcWriteAttempted===true;
    const owned=()=>and(eq(schema.outboxEvents.id,event.id),eq(schema.outboxEvents.processingStatus,"processing"),sql`${schema.outboxEvents.payload}->>'_egcClaimToken'=${event.claimToken}`);
    // A slow worker may finish after its five-minute lease was reclaimed. Every
    // state change (especially durable intent before HTTP) must fence that worker.
    const savePayload=async()=>Boolean((await db.update(schema.outboxEvents).set({payload,updatedAt:new Date()}).where(owned()).returning({id:schema.outboxEvents.id})).length);
    const finish=async(status:string,error:string|null,noteId?:string)=>{
      const finished=await db.transaction(async tx=>{
        const saved=await tx.update(schema.outboxEvents).set({processingStatus:status,payload:noteId?{...payload,_egcVerifiedNoteId:noteId}:payload,processedAt:status==="processed"?new Date():null,lastError:error,retryCount:event.retryCount+1,availableAt:new Date(Date.now()+Math.min(900000,15000*2**Math.min(event.retryCount+1,6))),updatedAt:new Date()}).where(owned()).returning({id:schema.outboxEvents.id});
        if(!saved.length)return false;
        if(status==="processed")await tx.insert(schema.auditLogs).values({actor:"worker",action:"ghl.contact_note.verified",entity:"outbox",entityId:event.id,newValue:{noteId,sourceEntityId:event.entityId},source:"sync"});
        return true;
      });
      if(!finished){counts.leaseLost++;return;}
      if(status==="processed")counts.processed++;else if(status==="failed")counts.failed++;else if(status==="reconciling")counts.reconciling++;else counts.retrying++;
    };
    const id=string(payload.ghlContactId),body=string(payload.noteBody),title=string(payload.title)??"EGC Operations Note";
    if(!["ghl.walkthrough_note.sync","ghl.contact_note.sync"].includes(event.type)||!id||!body){await finish("failed","invalid_outbox_contract");continue;}
    // Previous worker versions blindly retried these writes. No marker means
    // absence from search cannot prove the previous write did not commit.
    if(payload._egcExecutionVersion!==1&&(event.processingStatus!=="pending"||event.retryCount>0)) {await finish("failed","legacy_write_requires_manual_reconciliation");continue;}
    payload={...payload,_egcExecutionVersion:1};
    if(!await savePayload()){counts.leaseLost++;continue;}
    const marker=`[EGC operation ${event.id}]`,expectedBody=`${body}\n\n${marker}`;
    const inspect=async()=>{
      const response=await provider.getContactNotes(id);
      if(!Array.isArray(response.notes))throw new Error("malformed_note_list");
      const matches=response.notes.map(object).filter(note=>string(note.body)?.includes(marker));
      if(matches.length>1||matches.some(note=>note.body!==expectedBody||!string(note.id)))return {conflict:true,id:null};
      return {conflict:false,id:matches.length===1?string(matches[0]?.id):null};
    };
    try {
      let evidence=await inspect();
      if(evidence.conflict){await finish("failed","provider_note_evidence_conflict");continue;}
      if(evidence.id){await finish("processed",null,evidence.id);continue;}
      if(!writeAttempted) {
        // Commit intent before crossing the provider boundary. A crash from this
        // point is deliberately reconciled, even if it happened before HTTP.
        writeAttempted=true;payload={...payload,_egcWriteAttempted:true,_egcWriteStartedAt:new Date().toISOString()};
        if(!await savePayload()){counts.leaseLost++;continue;}
        try {await provider.createContactNote(id,expectedBody,title);}catch {/* always read after an uncertain outcome */}
        evidence=await inspect();
        if(evidence.conflict){await finish("failed","provider_note_evidence_conflict");continue;}
        if(evidence.id){await finish("processed",null,evidence.id);continue;}
      }
      await finish(event.retryCount>=7?"failed":"reconciling","provider_write_outcome_unknown");
    }catch {
      await finish(event.retryCount>=7?"failed":writeAttempted?"reconciling":"pending",writeAttempted?"provider_write_outcome_unknown":"provider_read_unavailable");
    }
  }
  return counts;
}
