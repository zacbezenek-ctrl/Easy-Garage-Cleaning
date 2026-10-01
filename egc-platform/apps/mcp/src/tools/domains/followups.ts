import * as z from "zod/v4";
import type {Command} from "@egc/operations";
import {callOperations} from "../../operations.js";
import {defineTool,type ToolDef} from "../define.js";
import {CursorError,pageFields,pageOf,readCursor,type Coverage,type CursorState} from "../pagination.js";

export type OperationsCall=(command:Command)=>Promise<Record<string,unknown>>;
export type FollowupDeps={call?:OperationsCall};
type Task=Record<string,unknown>&{id:string;title:string;kind:string};

const TOOL="egc.whats_overdue";
// The bridge serves at most 200 tasks a page; the scan stops after this many pages and says so instead of reading forever.
// Each later page overlaps the previous one by a row, so a full scan reads 200 + 4 x 199 distinct actions.
export const OVERDUE_BRIDGE_PAGE=200,OVERDUE_MAX_BRIDGE_PAGES=5,OVERDUE_SCAN_LIMIT=OVERDUE_BRIDGE_PAGE+(OVERDUE_MAX_BRIDGE_PAGES-1)*(OVERDUE_BRIDGE_PAGE-1);
const EVIDENCE_ITEMS=3,DRAFT_PREVIEW_CHARS=280,MINUTE=60_000;
const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const text=(value:unknown)=>typeof value==="string"?value:null;
const isTask=(value:unknown):value is Task=>isRecord(value)&&typeof value.id==="string"&&Boolean(value.id)&&typeof value.title==="string"&&typeof value.kind==="string";
const ownerOf=(task:Task)=>text(task.assignedUserId)?.trim()||null;
// Waiting work is due for review at reviewAt; everything else at dueAt (the service's queue ordering).
const attentionOf=(task:Task)=>text(["customer","provider"].includes(String(task.waitingOn))?task.reviewAt:task.dueAt);
const ms=(value:unknown)=>typeof value==="string"?Date.parse(value):Number.NaN;

/** Reads the live overdue queue page by page and stops after maxPages. Every page must match the service's paging contract
 * exactly; a malformed page is an error, never an empty list. Each later page starts one row early and must repeat the previous
 * page's last action: a different first row, or a total that moves between pages, means the queue shifted during the read (a
 * completion plus a new overdue action keeps the total but still skips a row), so the result is marked unstable. */
export async function scanOverdue(call:OperationsCall,{owner,dueBefore,maxPages=OVERDUE_MAX_BRIDGE_PAGES}:{owner?:string|undefined;dueBefore:Date;maxPages?:number}) {
  const tasks=new Map<string,Task>();let offset=0,first:number|null=null,last=0,stable=true,previous:string|undefined;
  for(let page=0;page<maxPages;page++){
    const r=await call({command:"queue",view:"overdue",dueBefore:dueBefore.toISOString(),...(owner?{owner}:{}),offset,limit:OVERDUE_BRIDGE_PAGE});
    if(typeof r.error==="string")return {error:r.error};
    const {items,nextOffset,total}=r;
    if(r.ok!==true||!Number.isSafeInteger(total)||(total as number)<0||!Array.isArray(items)||!items.every(isTask))return {error:"operations_response_invalid"};
    const n=total as number,end=offset+items.length;
    if(items.length!==Math.max(0,Math.min(OVERDUE_BRIDGE_PAGE,n-offset))||nextOffset!==(end<n?end:null))return {error:"operations_response_invalid"};
    first??=n;last=n;if(n!==first||previous!==undefined&&items[0]?.id!==previous)stable=false;
    for(const task of items)if(!tasks.has(task.id))tasks.set(task.id,task);
    if(nextOffset===null)return {tasks:[...tasks.values()],total:n,complete:true,stable,pages:page+1};
    previous=items.at(-1)?.id;offset=end-1;
  }
  return {tasks:[...tasks.values()],total:last,complete:false,stable,pages:maxPages};
}

const byCount=<K>(a:[K,number],b:[K,number])=>b[1]-a[1]||(a[0]===null?1:b[0]===null?-1:String(a[0]).localeCompare(String(b[0])));
/** Counts by owner (null = unassigned), with each owner's kinds, and by kind; largest first. */
export function groupOverdue(tasks:readonly Task[]) {
  const owners=new Map<string|null,Map<string,number>>(),kinds=new Map<string,number>();
  for(const task of tasks){
    const owner=ownerOf(task),mine=owners.get(owner)??new Map<string,number>();
    mine.set(task.kind,(mine.get(task.kind)??0)+1);owners.set(owner,mine);kinds.set(task.kind,(kinds.get(task.kind)??0)+1);
  }
  const counted=(map:Map<string,number>)=>[...map].sort(byCount).map(([kind,count])=>({kind,count}));
  return {
    byOwner:[...owners].map(([owner,mine])=>[owner,[...mine.values()].reduce((a,b)=>a+b,0),mine] as const).sort((a,b)=>byCount([a[0],a[1]],[b[0],b[1]])).map(([owner,count,mine])=>({owner,count,kinds:counted(mine)})),
    byKind:counted(kinds)
  };
}

function draftPreview(task:Task) {
  const draft=task.draftPayload;
  if(!isRecord(draft))return null;
  const body=text(draft.body)??"";
  return {channel:text(draft.channel),fromNumber:text(draft.fromNumber),recipient:text(draft.recipient),subject:text(draft.subject)??"",
    bodyPreview:body.length>DRAFT_PREVIEW_CHARS?`${body.slice(0,DRAFT_PREVIEW_CHARS)}…`:body,bodyLength:body.length,
    sendWindowStart:text(draft.sendWindowStart),sendWindowEnd:text(draft.sendWindowEnd),
    // Labels only: a link can carry access to a customer record, so the full attachment stays behind actions.review.
    attachments:(Array.isArray(draft.attachments)?draft.attachments:[]).filter(isRecord).slice(0,10).map(item=>({kind:text(item.kind),label:text(item.label)})),
    approvalStatus:text(task.approvalStatus)};
}
/** An allowlisted projection: never the raw task row. */
export function overdueItem(task:Task,asOf:Date) {
  const attentionAt=attentionOf(task),at=ms(attentionAt),evidence=(Array.isArray(task.sourceEvidence)?task.sourceEvidence:[]).filter(isRecord);
  return {taskId:task.id,title:task.title,kind:task.kind,owner:ownerOf(task),status:text(task.status),priority:text(task.priority),waitingOn:text(task.waitingOn),
    attentionAt,overdueMinutes:Number.isFinite(at)?Math.max(0,Math.floor((asOf.valueOf()-at)/MINUTE)):null,dueAt:text(task.dueAt),reviewAt:text(task.reviewAt),
    portalJobId:text(task.portalJobId),portalVisitId:text(task.portalVisitId),contactId:text(task.contactId),
    revision:Number.isSafeInteger(task.revision)?task.revision as number:null,approvalStatus:text(task.approvalStatus),
    sourceEvidence:evidence.slice(0,EVIDENCE_ITEMS).map(item=>({source:text(item.source)??"",id:text(item.id)??"",excerpt:text(item.excerpt)??""})),sourceEvidenceCount:evidence.length,
    draft:draftPreview(task)};
}

const str=z.string(),nstr=z.string().nullable(),count=z.number().int().min(0);
const itemOutput=z.object({taskId:str,title:str,kind:str,owner:nstr,status:nstr,priority:nstr,waitingOn:nstr,attentionAt:nstr,overdueMinutes:count.nullable(),dueAt:nstr,reviewAt:nstr,
  portalJobId:nstr,portalVisitId:nstr,contactId:nstr,revision:z.number().int().nullable(),approvalStatus:nstr,
  sourceEvidence:z.array(z.object({source:str,id:str,excerpt:str}).strict()),sourceEvidenceCount:count,
  draft:z.object({channel:nstr,fromNumber:nstr,recipient:nstr,subject:str,bodyPreview:str,bodyLength:count,sendWindowStart:nstr,sendWindowEnd:nstr,
    attachments:z.array(z.object({kind:nstr,label:nstr}).strict()),approvalStatus:nstr}).strict().nullable()}).strict();
const kindCounts=z.array(z.object({kind:str,count}).strict());
const output=z.object({
  items:z.array(itemOutput),
  page:z.object({limit:z.number().int(),offset:z.number().int(),returned:z.number().int(),nextCursor:nstr,total:z.number().int().optional()}).strict(),
  asOf:str,
  coverage:z.object({complete:z.boolean()}).catchall(z.unknown()),
  summary:z.object({total:count,exact:z.boolean(),byOwner:z.array(z.object({owner:nstr,count,kinds:kindCounts}).strict()),byKind:kindCounts}).strict(),
  note:str
}).strict();

const NOTE="Read-only. Nothing was sent, approved, snoozed or completed. A draft preview is the stored draft awaiting review; it goes out only after an owner or manager approves it in the Employee Hub. Use actions.review for a task's full draft and history.";
const UNAVAILABLE:Record<string,string>={
  operations_not_enabled:"The Action Center backend is not enabled on this server, so overdue follow-ups cannot be read. This is not an empty queue.",
  operations_response_invalid:"The Action Center returned a page that could not be verified. Nothing is reported as current; retry later."
};

export function followupTools(deps:FollowupDeps={}):ToolDef[] {
  const call=deps.call??(command=>callOperations(command));
  return [defineTool({name:TOOL,class:"read",output,
    description:"Answer \"what's overdue?\": registered Action Center follow-ups whose due time (or review time, when waiting on the customer or a provider) has passed, most overdue first. "
      +"Returns summary counts by owner (with each owner's kinds) and by kind, and a page of items with owner, kind, minutes overdue, up to three source evidence excerpts and a preview of any stored message draft. "
      +"Read-only: it never sends, approves, snoozes or completes anything. Counts cover registered actions, not commitments nobody recorded. "
      +`It reads at most ${OVERDUE_SCAN_LIMIT} overdue actions; beyond that coverage.complete is false and summary.total is a lower bound. `
      +"Pass page.nextCursor back as cursor with the same owner for the next page. Every page keeps the first page's asOf and counts only actions overdue at that time; a later page reports coverage.complete=false when a counted action changed after asOf. "
      +"An action completed, snoozed, rescheduled, or reassigned away from the owner filter after asOf leaves the live queue unreported, so a later page may skip a row. "
      +"When a fixed set matters, omit cursor for a fresh walk, or save a stored snapshot with egc.generate_brief (a write) and read it with egc.daily_brief.",
    input:z.object({
      owner:z.string().trim().min(1).max(200).optional().describe("Exact Hub business-user ID (see egc.operations_owners). Omit for everyone."),
      cursor:pageFields.cursor,
      limit:z.number().int().min(1).max(50).default(20).describe("Items per page.")
    }).strict(),
    async handler({cursor,limit,...filters},ctx){
      let state:CursorState;
      try{state=readCursor(cursor,TOOL,filters,ctx.now());}
      catch(error){if(error instanceof CursorError)return {error:error.code,instruction:"Omit cursor to start again, or pass the nextCursor returned for this exact tool and owner."};throw error;}
      const asOf=state.anchor??ctx.now(),scan=await scanOverdue(call,{owner:filters.owner,dueBefore:asOf});
      if("error" in scan)return {error:scan.error,instruction:UNAVAILABLE[scan.error]??"Overdue follow-ups could not be read. Nothing is reported as current; retry later."};
      // Membership is fixed at asOf: an action that fell due after the walk began waits for a fresh walk.
      const members=scan.tasks.filter(task=>ms(attentionOf(task))<asOf.valueOf());
      const changed=cursor!==undefined&&members.some(task=>ms(task.updatedAt)>asOf.valueOf()),exact=scan.complete&&scan.stable&&!changed;
      const coverage:Coverage=!scan.complete
        ?{complete:false,reason:"scan_limit_reached",scanned:scan.tasks.length,liveTotal:scan.total,instruction:"More overdue actions exist than this tool reads. Filter by owner or work the oldest first."}
        :!scan.stable?{complete:false,reason:"queue_changed_during_read",instruction:"Overdue actions changed while the queue was read, so one may be missing. Call again without cursor for a settled count."}
        :changed?{complete:false,reason:"rows_changed_after_asOf",instruction:"An overdue action changed after asOf, so a row may be missing or repeated. Omit cursor to start a fresh walk when an exact set matters."}
        :{complete:true};
      const page=pageOf({rows:members.slice(state.offset,state.offset+limit+1),limit,offset:state.offset,tool:TOOL,filters,asOf,anchor:asOf,
        coverage:{...coverage,scope:"registered_actions"},...(exact?{total:members.length}:{})});
      return {...page,items:page.items.map(task=>overdueItem(task,asOf)),summary:{total:members.length,exact,...groupOverdue(members)},note:NOTE};
    }})];
}
