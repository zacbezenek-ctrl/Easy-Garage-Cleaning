import {and,asc,eq,lt,lte,or} from "drizzle-orm";
import {getDb,schema} from "@egc/database";
export class UnsupportedWebhook extends Error {}
export function webhookRetry(attempt:number,now:Date) {
  return {processingStatus:attempt>=5?"failed":"pending",availableAt:new Date(now.valueOf()+Math.min(900000,15000*2**attempt))};
}
export async function processWebhookQueue(ingest:(payload:Record<string,unknown>)=>Promise<string>,db=getDb(),now=new Date()) {
  // Multiple processes cannot claim the same receipt. A crashed process's read-only
  // provider reconciliation is safe to recover after its bounded lease expires.
  const events=await db.transaction(async tx=>{
    const rows=await tx.select().from(schema.webhookEvents).where(or(
      and(eq(schema.webhookEvents.processingStatus,"pending"),lte(schema.webhookEvents.availableAt,now)),
      and(eq(schema.webhookEvents.processingStatus,"processing"),lt(schema.webhookEvents.processingStartedAt,new Date(now.valueOf()-600000)))
    )).orderBy(asc(schema.webhookEvents.receivedAt)).limit(10).for("update",{skipLocked:true});
    for(const row of rows)await tx.update(schema.webhookEvents).set({processingStatus:"processing",processingStartedAt:now,retryCount:row.retryCount+1}).where(eq(schema.webhookEvents.id,row.id));
    return rows;
  });
  const counts={processed:0,failed:0,retrying:0,leaseLost:0};
  for(const event of events) {
    // retryCount increments under the claim row lock. An expired worker must not
    // finish a newer claim, even while that newer claim is still processing.
    const owned=()=>and(eq(schema.webhookEvents.id,event.id),eq(schema.webhookEvents.processingStatus,"processing"),eq(schema.webhookEvents.retryCount,event.retryCount+1),eq(schema.webhookEvents.processingStartedAt,now));
    try {
      if(event.retryCount>=5)throw new UnsupportedWebhook("retry_limit_reached");
      const resolution=await ingest(event.payload);
      const saved=await db.update(schema.webhookEvents).set({processingStatus:"processed",processedAt:new Date(),lastError:null,resolution}).where(owned()).returning({id:schema.webhookEvents.id});
      if(saved.length)counts.processed++;else counts.leaseLost++;
    }catch(error) {
      const terminal=error instanceof UnsupportedWebhook;
      const retry=terminal?{processingStatus:"failed",availableAt:new Date()}:webhookRetry(event.retryCount+1,new Date());
      const saved=await db.update(schema.webhookEvents).set({...retry,lastError:terminal?"unsupported_or_exhausted_event":"provider_reconciliation_failed",resolution:terminal?"manual_review_required":null}).where(owned()).returning({id:schema.webhookEvents.id});
      if(!saved.length)counts.leaseLost++;else if(retry.processingStatus==="failed")counts.failed++;else counts.retrying++;
    }
  }
  return counts;
}
