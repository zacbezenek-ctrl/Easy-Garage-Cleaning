import * as z from "zod/v4";
import {and,asc,desc,eq,exists,gt,gte,ilike,inArray,lt,lte,or,sql,type SQL} from "drizzle-orm";
import type {AnyPgColumn,PgTable} from "drizzle-orm/pg-core";
import {getDb,schema} from "@egc/database";
import {getCustomerTimeline,OPERATIONAL_STATES} from "@egc/customer-state";
import {defineTool,type ToolDef} from "../define.js";
import {CursorError,MAX_PAGE_LIMIT,pageFields,pageOf,readCursor,type CursorState} from "../pagination.js";

type Db=ReturnType<typeof getDb>;
export type CrmReadDeps={db?:()=>Db;timeline?:typeof getCustomerTimeline};

export const taskPrioritySchema=z.enum(["low","medium","high","urgent"]);
export const taskStatusSchema=z.enum(["open","in_progress","blocked","completed","cancelled"]);
const uuid=z.string().uuid(),isoDateTime=z.string().datetime({offset:true}),DAY_MS=86_400_000;
const UNRECONCILED={coverage:{complete:false,error:"customer_not_reconciled"}};
const PAGED=" Returns {items,page,asOf,coverage}. Filters run in the database before paging; pass page.nextCursor back as cursor with the same filters until it is null. Every page of one walk keeps the first page's asOf, and relative windows are measured from it. Pages follow a live ordering: a later page reports coverage.complete=false when a matching row was created or updated after asOf, because a row may then be missing or repeated.";
const CHANGED={complete:false,reason:"rows_changed_after_asOf",instruction:"Rows matching this query were created or updated after asOf, so offset pages may have shifted and a row can be missing or repeated. Omit cursor to start a fresh walk when an exact set matters."};
// Callers may still ask for their original maximum; a page never exceeds MAX_PAGE_LIMIT and the remainder is reached through nextCursor, never dropped.
const paged=(fallback:number,legacyMax:number)=>({cursor:pageFields.cursor,
  limit:z.number().int().min(1).max(legacyMax).default(fallback).describe(legacyMax>MAX_PAGE_LIMIT?`Page size. Values above ${MAX_PAGE_LIMIT} are accepted and served ${MAX_PAGE_LIMIT} per page; follow page.nextCursor for the rest.`:"Page size.")});
const pageOutput=z.object({
  items:z.array(z.record(z.string(),z.unknown())),
  page:z.object({limit:z.number().int(),offset:z.number().int(),returned:z.number().int(),nextCursor:z.string().nullable(),total:z.number().int().optional()}).strict(),
  asOf:z.string(),
  coverage:z.object({complete:z.boolean()}).catchall(z.unknown())
}).strict();
const LEAD_STATE_ALIASES:Record<string,string[]>={NEVER_CONTACTED:["NEW_LEAD"],OUTREACH_ATTEMPTED_NO_REPLY:["OUTREACH_ATTEMPTED"],CUSTOMER_RESPONDED:["TWO_WAY_CONTACT"],ACTIVE_CONVERSATION:["TWO_WAY_CONTACT","QUALIFIED","PRICE_EXPECTATION_ACCEPTED","VIDEO_QUOTE_PENDING_CUSTOMER","VIDEO_QUOTE_RECEIVED","VIDEO_QUOTE_IN_PROGRESS","QUOTE_DELIVERED","FOLLOW_UP_PENDING","CUSTOMER_DECIDING"],BOOKED:["WALKTHROUGH_VERBALLY_BOOKED","WALKTHROUGH_BOOKED","WALKTHROUGH_COMPLETED","JOB_VERBALLY_ACCEPTED","JOB_SOLD","JOB_SCHEDULED","JOB_COMPLETED","CASH_COLLECTED"]};

export async function canonicalReadContexts(contactIds:string[],db:Db=getDb()):Promise<Map<string,Record<string,unknown>>> {
  if(!contactIds.length)return new Map<string,Record<string,unknown>>();
  const rows=await db.select().from(schema.customerStateSnapshots).where(inArray(schema.customerStateSnapshots.contactId,[...new Set(contactIds)]));
  return new Map(rows.map(row=>[row.contactId,{...row.snapshot,coverage:row.coverage,lastReconciledAt:row.lastReconciledAt}]));
}
export async function withCanonicalContexts<T extends {contactId:string}>(rows:T[],db:Db=getDb()) {
  const canonical=await canonicalReadContexts(rows.map(row=>row.contactId),db);
  return rows.map(row=>({...row,operational:canonical.get(row.contactId)??UNRECONCILED}));
}

type PageInput={cursor?:string|undefined;limit:number};
/** where builds the query's filters from the walk's anchor; changed defaults to a matching row written after it. */
type Scan={table:PgTable&{updatedAt:AnyPgColumn};where:(anchor:Date)=>SQL|undefined;changed?:(anchor:Date)=>SQL|undefined};
/** Offset cursors bind to the tool and its exact filters and carry the first page's time, so windows and asOf stay fixed for the whole walk.
 * The page size is capped and the extra row read proves another page exists. After reading a later page, a probe looks for matching rows
 * written after the anchor, which could have shifted the offset, and reports that instead of a silent gap. */
async function paginate<T,U=T>(d:Db,tool:string,input:PageInput,filters:Record<string,unknown>,now:Date,scan:Scan,read:(where:SQL|undefined,limit:number,offset:number)=>Promise<T[]>,present?:(rows:T[])=>Promise<U[]>) {
  let state:CursorState;
  try{state=readCursor(input.cursor,tool,filters,now);}
  catch(error){if(error instanceof CursorError)return {error:error.code,instruction:"Omit cursor to start again, or pass the nextCursor returned for this exact tool and filters."};throw error;}
  const anchor=state.anchor??now,where=scan.where(anchor),limit=Math.min(input.limit,MAX_PAGE_LIMIT),rows=await read(where,limit+1,state.offset);
  const changed=input.cursor!==undefined&&(await d.select({one:sql`1`}).from(scan.table).where(and(where,(scan.changed??(at=>gt(scan.table.updatedAt,at)))(anchor))).limit(1)).length>0;
  const page=pageOf({rows,limit,offset:state.offset,tool,filters,asOf:anchor,anchor,coverage:changed?CHANGED:{complete:true}});
  return present?{...page,items:await present(page.items)}:page;
}

export function crmReadTools(deps:CrmReadDeps={}):ToolDef[] {
  const db=deps.db??getDb,timeline=deps.timeline??getCustomerTimeline;
  const since=(now:Date,days:number)=>new Date(now.valueOf()-days*DAY_MS);
  return [
    defineTool({name:"contacts.search",class:"read",output:pageOutput,
      description:"Search EGC contacts by name, phone, or email with canonical evidence-backed operational state. Provider fields are preserved separately from operational truth."+PAGED,
      input:z.object({query:z.string().trim().max(200).default(""),...paged(50,200)}).strict(),
      async handler({cursor,limit,...filters},ctx){
        const {query}=filters,c=schema.contacts,d=db();
        return paginate(d,"contacts.search",{cursor,limit},filters,ctx.now(),{table:c,where:()=>query?or(ilike(c.name,`%${query}%`),ilike(c.phone,`%${query}%`),ilike(c.email,`%${query}%`)):undefined},
          (where,n,o)=>d.select().from(c).where(where).orderBy(desc(c.updatedAt),desc(c.id)).limit(n).offset(o),
        async rows=>{const canonical=await canonicalReadContexts(rows.map(row=>row.id),d);return rows.map(row=>({...row,operational:canonical.get(row.id)??UNRECONCILED}));});
      }}),
    defineTool({name:"contacts.get",class:"read",description:"Get one normalized EGC contact by internal contact ID.",
      input:z.object({contactId:uuid}).strict(),
      async handler({contactId}){
        const [row]=await db().select().from(schema.contacts).where(eq(schema.contacts.id,contactId)).limit(1);
        return row?{...row,canonical:await timeline({contactId,refresh:true})}:{error:"contact_not_found"};
      }}),
    defineTool({name:"leads.search",class:"read",output:pageOutput,
      description:"Search recent leads, optionally filtered by canonical lead state."+PAGED,
      input:z.object({state:z.enum([...OPERATIONAL_STATES,"NEVER_CONTACTED","OUTREACH_ATTEMPTED_NO_REPLY","CUSTOMER_RESPONDED","ACTIVE_CONVERSATION","BOOKED"]).optional(),
        days:z.number().int().min(1).max(365).default(30),...paged(100,500)}).strict(),
      async handler({cursor,limit,...filters},ctx){
        const {state,days}=filters,d=db(),l=schema.leads,s=schema.customerStateSnapshots;
        // The canonical snapshot state wins over the provider lead state, matching the enrichment below; filtering in SQL avoids a recent-row truncation.
        const effectiveState=sql`coalesce((select ${s.snapshot}->>'state' from ${s} where ${s.contactId}=${l.contactId}),${l.currentState}::text)`;
        return paginate(d,"leads.search",{cursor,limit},filters,ctx.now(),{table:l,where:anchor=>and(gte(l.createdAt,since(anchor,days)),state?inArray(effectiveState,[state,...(LEAD_STATE_ALIASES[state]??[])]):undefined),
          // A snapshot change can move a lead into the state filter without touching the lead row.
          changed:anchor=>state?or(gt(l.updatedAt,anchor),exists(d.select({one:sql`1`}).from(s).where(and(eq(s.contactId,l.contactId),gt(s.updatedAt,anchor))))):gt(l.updatedAt,anchor)},
          (where,n,o)=>d.select({lead:l,contact:schema.contacts}).from(l).innerJoin(schema.contacts,eq(l.contactId,schema.contacts.id)).where(where).orderBy(desc(l.createdAt),desc(l.id)).limit(n).offset(o),
        async rows=>{const canonical=await canonicalReadContexts(rows.map(row=>row.contact.id),d);
          return rows.map(row=>{const operational=canonical.get(row.contact.id);return {...row,lead:{...row.lead,providerState:row.lead.currentState,currentState:operational?.state??row.lead.currentState},operational:operational??UNRECONCILED};});});
      }}),
    defineTool({name:"leads.get",class:"read",description:"Get one lead with its contact by internal lead ID.",
      input:z.object({leadId:uuid}).strict(),
      async handler({leadId}){
        const [row]=await db().select({lead:schema.leads,contact:schema.contacts}).from(schema.leads).innerJoin(schema.contacts,eq(schema.leads.contactId,schema.contacts.id)).where(eq(schema.leads.id,leadId)).limit(1);
        if(!row)return {error:"lead_not_found"};
        const canonical=await timeline({contactId:row.contact.id,refresh:true});
        return {...row,lead:{...row.lead,providerState:row.lead.currentState,currentState:canonical.customer?.state??row.lead.currentState},canonical};
      }}),
    defineTool({name:"conversations.search",class:"read",output:pageOutput,description:"Return conversations for a contact."+PAGED,
      input:z.object({contactId:uuid,...paged(50,200)}).strict(),
      async handler({cursor,limit,...filters},ctx){
        const c=schema.conversations,d=db();
        return paginate(d,"conversations.search",{cursor,limit},filters,ctx.now(),{table:c,where:()=>eq(c.contactId,filters.contactId)},(where,n,o)=>d.select().from(c).where(where).orderBy(desc(c.updatedAt),desc(c.id)).limit(n).offset(o));
      }}),
    defineTool({name:"conversations.get",class:"read",
      description:"Get one conversation and its normalized messages, newest first. messages is a page {items,page,asOf,coverage}: messageLimit sets its size (values above 200 are served 200 per page) and page.nextCursor, passed back as cursor, reads older messages until it is null. A later page reports coverage.complete=false when a message was added or updated after asOf.",
      input:z.object({conversationId:uuid,messageLimit:z.number().int().min(1).max(500).default(100),cursor:pageFields.cursor}).strict(),
      async handler({conversationId,messageLimit,cursor},ctx){
        const d=db(),m=schema.messages;
        const [conversation]=await d.select().from(schema.conversations).where(eq(schema.conversations.id,conversationId)).limit(1);
        if(!conversation)return {error:"conversation_not_found"};
        const messages=await paginate(d,"conversations.get",{cursor,limit:messageLimit},{conversationId},ctx.now(),{table:m,where:()=>eq(m.conversationId,conversationId)},(where,n,o)=>d.select().from(m).where(where).orderBy(desc(m.occurredAt),desc(m.id)).limit(n).offset(o));
        return "error" in messages?messages:{conversation,messages};
      }}),
    defineTool({name:"calls.search",class:"read",output:pageOutput,description:"Search recent normalized calls, optionally for one contact."+PAGED,
      input:z.object({contactId:uuid.optional(),days:z.number().int().min(1).max(365).default(30),...paged(100,500)}).strict(),
      async handler({cursor,limit,...filters},ctx){
        const {contactId,days}=filters,c=schema.calls,d=db();
        return paginate(d,"calls.search",{cursor,limit},filters,ctx.now(),{table:c,where:anchor=>and(contactId?eq(c.contactId,contactId):undefined,gte(c.startedAt,since(anchor,days)))},
          (where,n,o)=>d.select({call:c,customerName:schema.contacts.name,phone:schema.contacts.phone}).from(c).innerJoin(schema.contacts,eq(c.contactId,schema.contacts.id)).where(where).orderBy(desc(c.startedAt),desc(c.id)).limit(n).offset(o));
      }}),
    defineTool({name:"calls.get",class:"read",description:"Get one call and its persisted transcript.",
      input:z.object({callId:uuid}).strict(),
      async handler({callId}){
        const d=db(),[call]=await d.select().from(schema.calls).where(eq(schema.calls.id,callId)).limit(1);
        if(!call)return {error:"call_not_found"};
        const [transcript]=await d.select().from(schema.callTranscripts).where(eq(schema.callTranscripts.callId,callId)).limit(1);
        return {call,transcript:transcript??null};
      }}),
    defineTool({name:"opportunities.search",class:"read",output:pageOutput,description:"Search normalized GHL opportunities by contact or status."+PAGED,
      input:z.object({contactId:uuid.optional(),status:z.string().max(50).optional(),...paged(100,500)}).strict(),
      async handler({cursor,limit,...filters},ctx){
        const {contactId,status}=filters,o=schema.opportunities,d=db();
        return paginate(d,"opportunities.search",{cursor,limit},filters,ctx.now(),{table:o,where:()=>and(contactId?eq(o.contactId,contactId):undefined,status?eq(o.status,status):undefined)},
          (where,n,offset)=>d.select().from(o).where(where).orderBy(desc(o.updatedAt),desc(o.id)).limit(n).offset(offset),
        rows=>withCanonicalContexts(rows,d));
      }}),
    defineTool({name:"opportunities.get",class:"read",description:"Get one normalized opportunity by internal ID.",
      input:z.object({opportunityId:uuid}).strict(),
      async handler({opportunityId}){
        const [row]=await db().select().from(schema.opportunities).where(eq(schema.opportunities.id,opportunityId)).limit(1);
        return row?{...row,canonical:await timeline({contactId:row.contactId,refresh:true})}:{error:"opportunity_not_found"};
      }}),
    defineTool({name:"appointments.search",class:"read",output:pageOutput,description:"Search appointments in a relative time window, optionally for one contact, earliest start first."+PAGED,
      input:z.object({contactId:uuid.optional(),daysPast:z.number().int().min(0).max(365).default(30),daysFuture:z.number().int().min(0).max(730).default(90),...paged(200,500)}).strict(),
      async handler({cursor,limit,...filters},ctx){
        const {contactId,daysPast,daysFuture}=filters,a=schema.appointments,d=db();
        // The window is fixed at the walk's anchor; measured from each call's clock, appointments that start between calls would shift the offset.
        return paginate(d,"appointments.search",{cursor,limit},filters,ctx.now(),{table:a,where:anchor=>and(gte(a.appointmentStartAt,since(anchor,daysPast)),lt(a.appointmentStartAt,new Date(anchor.valueOf()+daysFuture*DAY_MS)),contactId?eq(a.contactId,contactId):undefined)},
          (where,n,o)=>d.select().from(a).where(where).orderBy(asc(a.appointmentStartAt),asc(a.id)).limit(n).offset(o),
        rows=>withCanonicalContexts(rows,d));
      }}),
    defineTool({name:"jobs.search",class:"read",output:pageOutput,description:"Search EGC jobs by contact or status."+PAGED,
      input:z.object({contactId:uuid.optional(),status:z.string().max(80).optional(),...paged(100,500)}).strict(),
      async handler({cursor,limit,...filters},ctx){
        const {contactId,status}=filters,j=schema.jobs,d=db();
        return paginate(d,"jobs.search",{cursor,limit},filters,ctx.now(),{table:j,where:()=>and(contactId?eq(j.contactId,contactId):undefined,status?eq(j.status,status):undefined)},
          (where,n,o)=>d.select().from(j).where(where).orderBy(desc(j.updatedAt),desc(j.id)).limit(n).offset(o),
        rows=>withCanonicalContexts(rows,d));
      }}),
    defineTool({name:"jobs.get",class:"read",description:"Get one raw normalized EGC job by internal ID.",
      input:z.object({jobId:uuid}).strict(),
      async handler({jobId}){
        const [row]=await db().select().from(schema.jobs).where(eq(schema.jobs.id,jobId)).limit(1);
        return row?{...row,canonical:await timeline({contactId:row.contactId,refresh:true})}:{error:"job_not_found"};
      }}),
    defineTool({name:"tasks.search",class:"read",output:pageOutput,description:"Search EGC operational tasks/todos by status, priority, assignment, linked entity, or due date."+PAGED,
      input:z.object({status:taskStatusSchema.optional(),priority:taskPrioritySchema.optional(),assignedUserId:z.string().max(200).optional(),contactId:uuid.optional(),jobId:uuid.optional(),opportunityId:uuid.optional(),
        dueBefore:isoDateTime.optional(),dueAfter:isoDateTime.optional(),...paged(100,200)}).strict(),
      async handler({cursor,limit,...filters},ctx){
        const {status,priority,assignedUserId,contactId,jobId,opportunityId,dueBefore,dueAfter}=filters,t=schema.tasks,d=db();
        // Filters run in SQL so a match older than any recent-row window is still found.
        const conditions:SQL[]=[
          ...(status?[eq(t.status,status)]:[]),...(priority?[eq(t.priority,priority)]:[]),...(assignedUserId?[eq(t.assignedUserId,assignedUserId)]:[]),
          ...(contactId?[eq(t.contactId,contactId)]:[]),...(jobId?[eq(t.jobId,jobId)]:[]),...(opportunityId?[eq(t.opportunityId,opportunityId)]:[]),
          ...(dueBefore?[lte(t.dueAt,new Date(dueBefore))]:[]),...(dueAfter?[gte(t.dueAt,new Date(dueAfter))]:[])];
        return paginate(d,"tasks.search",{cursor,limit},filters,ctx.now(),{table:t,where:()=>conditions.length?and(...conditions):undefined},(where,n,o)=>d.select().from(t).where(where).orderBy(desc(t.updatedAt),desc(t.id)).limit(n).offset(o));
      }}),
    defineTool({name:"walkthroughs.search",class:"read",output:pageOutput,description:"Search voice walkthroughs by contact or workflow status, newest first."+PAGED,
      input:z.object({contactId:uuid.optional(),status:z.string().max(80).optional(),...paged(100,500)}).strict(),
      async handler({cursor,limit,...filters},ctx){
        const {contactId,status}=filters,w=schema.walkthroughs,d=db();
        return paginate(d,"walkthroughs.search",{cursor,limit},filters,ctx.now(),{table:w,where:()=>and(contactId?eq(w.contactId,contactId):undefined,status?eq(w.status,status):undefined)},
          (where,n,o)=>d.select().from(w).where(where).orderBy(desc(w.createdAt),desc(w.id)).limit(n).offset(o));
      }}),
    defineTool({name:"walkthroughs.get",class:"read",description:"Get one voice walkthrough, including reviewed extraction.",
      input:z.object({walkthroughId:uuid}).strict(),
      async handler({walkthroughId}){
        const [row]=await db().select().from(schema.walkthroughs).where(eq(schema.walkthroughs.id,walkthroughId)).limit(1);
        return row??{error:"walkthrough_not_found"};
      }})
  ];
}
