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
export const encodeCursor=(tool:string,filters:Record<string,unknown>,offset:number)=>Buffer.from(JSON.stringify({v:1,o:offset,f:filterDigest(tool,filters)})).toString("base64url");
export function decodeCursor(cursor:string|undefined,tool:string,filters:Record<string,unknown>):number{
  if(cursor===undefined)return 0;
  let value:unknown;
  try{if(!/^[A-Za-z0-9_-]{1,512}$/.test(cursor))throw 0;value=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));}catch{throw new CursorError("invalid_cursor");}
  const {v,o,f}=(value&&typeof value==="object"?value:{}) as {v?:unknown;o?:unknown;f?:unknown};
  if(v!==1||!Number.isSafeInteger(o)||(o as number)<0||typeof f!=="string"||!/^[a-f0-9]{64}$/.test(f))throw new CursorError("invalid_cursor");
  if(f!==filterDigest(tool,filters))throw new CursorError("cursor_filter_mismatch");
  return o as number;
}
/** Callers read limit+1 rows; the extra row only proves another page exists. Coverage is mandatory so a partial read is never presented as complete. */
export function pageOf<T>(input:{rows:T[];limit:number;offset:number;tool:string;filters:Record<string,unknown>;asOf:Date;coverage:Coverage;total?:number}):Page<T>{
  const items=input.rows.slice(0,input.limit),more=input.rows.length>input.limit||(input.total!==undefined&&input.offset+items.length<input.total);
  return {items,page:{limit:input.limit,offset:input.offset,returned:items.length,nextCursor:more&&items.length?encodeCursor(input.tool,input.filters,input.offset+items.length):null,...(input.total!==undefined?{total:input.total}:{})},asOf:input.asOf.toISOString(),coverage:input.coverage};
}
