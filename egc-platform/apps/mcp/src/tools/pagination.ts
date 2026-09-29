import {createHash} from "node:crypto";
import * as z from "zod/v4";
export const MAX_PAGE_LIMIT=200;
export const pageFields={
  cursor:z.string().min(1).max(512).optional().describe("Opaque nextCursor from the previous page of this exact query. Omit for the first page."),
  limit:z.number().int().min(1).max(MAX_PAGE_LIMIT).default(50)
};
export type Coverage={complete:boolean}&Record<string,unknown>;
export type Page<T>={items:T[];page:{limit:number;offset:number;returned:number;nextCursor:string|null;total?:number};asOf:string;coverage:Coverage};
export class CursorError extends Error{constructor(readonly code:"invalid_cursor"|"cursor_filter_mismatch"){super(code);}}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"&&!(value instanceof Date)
  ?Object.fromEntries(Object.keys(value).sort().filter(key=>(value as Record<string,unknown>)[key]!==undefined).map(key=>[key,canonical((value as Record<string,unknown>)[key])])):value instanceof Date?value.toISOString():value;
/** Binds a cursor to one tool and its exact filters (not the page size), so it cannot be replayed against a different query. */
export const filterDigest=(tool:string,filters:Record<string,unknown>)=>createHash("sha256").update(JSON.stringify(canonical({tool,filters}))).digest("hex");
// An anchored walk may continue for a day; a small allowance covers clock skew between replicas.
export const CURSOR_MAX_AGE_MS=86_400_000,CURSOR_CLOCK_SKEW_MS=60_000;
/** A keyset position: the ordering key of the last row already returned, as exact UTC microseconds (a JS Date keeps only milliseconds), and its id. */
export type Keyset={key:string;id:string};
export type CursorState={offset:number;anchor?:Date;after?:Keyset};
const KEYSET_KEY=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,KEYSET_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const calendarKey=(key:string)=>{const ms=`${key.slice(0,23)}Z`,at=new Date(ms);return Number.isFinite(at.valueOf())&&at.toISOString()===ms;};
const validKeyset=(k:unknown):k is [string,string]=>Array.isArray(k)&&k.length===2&&typeof k[0]==="string"&&KEYSET_KEY.test(k[0])&&calendarKey(k[0])&&typeof k[1]==="string"&&KEYSET_ID.test(k[1]);
/** A position only when both parts are exactly what a keyset cursor accepts back, so a page never emits a cursor its next call would refuse. */
export const keysetOf=(key:unknown,id:unknown):Keyset|undefined=>validKeyset([key,id])?{key:key as string,id:id as string}:undefined;
export const encodeCursor=(tool:string,filters:Record<string,unknown>,offset:number,anchor?:Date)=>Buffer.from(JSON.stringify({v:1,o:offset,f:filterDigest(tool,filters),...(anchor?{a:anchor.valueOf()}:{})})).toString("base64url");
/** Version 2: continues after a keyset position instead of skipping rows, so rows added or removed ahead of it cannot shift the page. o counts the rows already returned; the anchor is required. */
export const encodeKeysetCursor=(tool:string,filters:Record<string,unknown>,position:number,anchor:Date,after:Keyset)=>Buffer.from(JSON.stringify({v:2,o:position,f:filterDigest(tool,filters),a:anchor.valueOf(),k:[after.key,after.id]})).toString("base64url");
/** Offset (or, for a keyset cursor, rows already returned) plus the anchor, the first page's asOf, which later pages reuse so relative windows and asOf stay fixed for the whole walk, and a keyset cursor's position. With now, an anchor from the future or older than CURSOR_MAX_AGE_MS is refused. */
export function readCursor(cursor:string|undefined,tool:string,filters:Record<string,unknown>,now?:Date):CursorState{
  if(cursor===undefined)return {offset:0};
  let value:unknown;
  try{if(!/^[A-Za-z0-9_-]{1,512}$/.test(cursor))throw 0;value=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));}catch{throw new CursorError("invalid_cursor");}
  const {v,o,f,a,k}=(value&&typeof value==="object"?value:{}) as {v?:unknown;o?:unknown;f?:unknown;a?:unknown;k?:unknown};
  if((v!==1&&v!==2)||!Number.isSafeInteger(o)||(o as number)<0||typeof f!=="string"||!/^[a-f0-9]{64}$/.test(f))throw new CursorError("invalid_cursor");
  if(v===2?a===undefined||!validKeyset(k):k!==undefined)throw new CursorError("invalid_cursor");
  if(a!==undefined&&(!Number.isSafeInteger(a)||(a as number)<0||(now!==undefined&&((a as number)>now.valueOf()+CURSOR_CLOCK_SKEW_MS||(a as number)<now.valueOf()-CURSOR_MAX_AGE_MS))))throw new CursorError("invalid_cursor");
  if(f!==filterDigest(tool,filters))throw new CursorError("cursor_filter_mismatch");
  const state:CursorState=a===undefined?{offset:o as number}:{offset:o as number,anchor:new Date(a as number)};
  return validKeyset(k)?{...state,after:{key:k[0],id:k[1]}}:state;
}
export function decodeCursor(cursor:string|undefined,tool:string,filters:Record<string,unknown>):number{return readCursor(cursor,tool,filters).offset;}
/** Callers read limit+1 rows; the extra row only proves another page exists. Coverage is mandatory so a partial read is never presented as complete. An anchor is carried into nextCursor.
 * With keyOf, nextCursor is a keyset cursor after the last returned row, anchored to anchor (or asOf); a row without a usable position falls back to an offset cursor. */
export function pageOf<T>(input:{rows:T[];limit:number;offset:number;tool:string;filters:Record<string,unknown>;asOf:Date;coverage:Coverage;total?:number;anchor?:Date;keyOf?:(row:T)=>Keyset|undefined}):Page<T>{
  const items=input.rows.slice(0,input.limit),more=input.rows.length>input.limit||(input.total!==undefined&&input.offset+items.length<input.total),last=items[items.length-1];
  const after=more&&last!==undefined?input.keyOf?.(last):undefined,position=input.offset+items.length;
  const nextCursor=!more||!items.length?null:after?encodeKeysetCursor(input.tool,input.filters,position,input.anchor??input.asOf,after):encodeCursor(input.tool,input.filters,position,input.anchor);
  return {items,page:{limit:input.limit,offset:input.offset,returned:items.length,nextCursor,...(input.total!==undefined?{total:input.total}:{})},asOf:input.asOf.toISOString(),coverage:input.coverage};
}
