import {and,desc,eq,gte,inArray,notInArray,or,sql} from 'drizzle-orm';
import {getDb,schema} from '@egc/database';
import {GhlClient,asRecord} from '@egc/ghl';

type Note=Record<string,unknown>&{id:string;body:string};
export function validatedContactNotes(payload:Record<string,unknown>,providerContactId:string):Note[]{
 if(!Array.isArray(payload.notes)||payload.hasMore===true)throw new Error('provider_notes_incomplete');
 const seen=new Set<string>();
 return payload.notes.map(value=>{const note=asRecord(value);if(typeof note.id!=='string'||!note.id||typeof note.body!=='string'||(note.contactId!==undefined&&note.contactId!==providerContactId)||seen.has(note.id))throw new Error('provider_note_identity_invalid');seen.add(note.id);return note as Note;});
}

/** Read-only provider mirroring; never creates or changes a customer's GHL note. */
export async function reconcileProviderNotes(provider:Pick<GhlClient,'getContactNotes'>=GhlClient.fromEnv()){
 const db=getDb(),since=new Date(Date.now()-30*86400000),asOf=new Date().toISOString();
 const rows=await db.select({id:schema.contacts.id,providerId:schema.contacts.providerId}).from(schema.contacts).innerJoin(schema.leads,eq(schema.leads.contactId,schema.contacts.id)).where(or(gte(schema.leads.createdAt,since),sql`exists(select 1 from messages m where m.contact_id=${schema.contacts.id} and m.occurred_at>=${since.toISOString()}::timestamptz)`,sql`exists(select 1 from calls c where c.contact_id=${schema.contacts.id} and c.started_at>=${since.toISOString()}::timestamptz)`)).orderBy(desc(schema.leads.createdAt)).limit(501);
 let failed=0,notes=0;
 for(const contact of rows.slice(0,500)){
  const key=`customer_state:provider_notes:${contact.id}`;
  try{
   const values=validatedContactNotes(await provider.getContactNotes(contact.providerId),contact.providerId);
   await db.transaction(async tx=>{
    for(const note of values){const row={provider:'ghl',resourceType:'contact_note',providerId:note.id,displayName:'GHL contact note',raw:{...note,egcContactId:contact.id,egcContactProviderId:contact.providerId,egcNotesReadAt:asOf,egcDeleted:false},updatedAt:new Date()};await tx.insert(schema.providerMappings).values(row).onConflictDoUpdate({target:[schema.providerMappings.provider,schema.providerMappings.resourceType,schema.providerMappings.providerId],set:row});}
    // A complete provider read may retire a missing mirror, while retaining its
    // original contents for audit. An error never means an empty notes list.
    await tx.update(schema.providerMappings).set({raw:sql`jsonb_set(${schema.providerMappings.raw},'{egcDeleted}','true'::jsonb)`,updatedAt:new Date()}).where(and(eq(schema.providerMappings.provider,'ghl'),eq(schema.providerMappings.resourceType,'contact_note'),sql`${schema.providerMappings.raw}->>'egcContactId'=${contact.id}`,...(values.length?[notInArray(schema.providerMappings.providerId,values.map(n=>n.id))]:[])));
    const cursor=JSON.stringify({complete:true,count:values.length,asOf});await tx.insert(schema.syncCursors).values({key,cursor}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor,updatedAt:new Date()}});
   });notes+=values.length;
  }catch{failed++;const cursor=JSON.stringify({complete:false,asOf,error:'provider_notes_unavailable'});await db.insert(schema.syncCursors).values({key,cursor}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor,updatedAt:new Date()}});}
 }
 const result={inspected:Math.min(rows.length,500),truncated:rows.length>500,failed,notes,asOf};
 await db.insert(schema.syncCursors).values({key:'customer_state:provider_notes',cursor:JSON.stringify(result)}).onConflictDoUpdate({target:schema.syncCursors.key,set:{cursor:JSON.stringify(result),updatedAt:new Date()}});
 return result;
}
export function startProviderNotesWorker({intervalMs=15*60000,reconcile=reconcileProviderNotes,logger=console}:{intervalMs?:number;reconcile?:typeof reconcileProviderNotes;logger?:Pick<Console,'error'>}={}){
 let running=false,stopped=false;
 const tick=async()=>{if(running||stopped)return;running=true;try{await reconcile();}catch{logger.error('Provider note reconciliation failed; inspect canonical source coverage.');}finally{running=false;}};
 void tick();const timer=setInterval(()=>void tick(),intervalMs);return()=>{stopped=true;clearInterval(timer);};
}
