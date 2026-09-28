export type ToolResult={content:Array<{type:"text";text:string}>;structuredContent:{result:unknown};isError?:true};
const CODE=/^[a-z][a-z0-9_]{0,99}$/;
// Keys that may carry credentials, provider exception text or customer message content.
const SENSITIVE=/token|secret|password|authori[sz]|cookie|envelope|signature|^(?:stack|cause|message|body|raw|headers?|request|response)$/i;
export const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
function safeValue(value:unknown,depth:number):unknown{
  if(value===null||typeof value==="boolean")return value;
  if(typeof value==="number")return Number.isFinite(value)?value:undefined;
  if(typeof value==="string")return value.length<=500?value:`${value.slice(0,500)}…`;
  if(Array.isArray(value))return depth>2?undefined:value.slice(0,50).map(item=>safeValue(item,depth+1)).filter(item=>item!==undefined);
  return isRecord(value)&&depth<=2?safeDetails(value,depth+1):undefined;
}
export function safeDetails(details:Record<string,unknown>,depth=0):Record<string,unknown>{
  const out:Record<string,unknown>={};
  for(const [key,value] of Object.entries(details)){if(key==="error"||SENSITIVE.test(key))continue;const safe=safeValue(value,depth);if(safe!==undefined)out[key]=safe;}
  return out;
}
export function result(value:unknown):ToolResult{return {content:[{type:"text",text:JSON.stringify(value,null,2)}],structuredContent:{result:value}};}
/** Error payloads are data, never thrown text: only a snake_case code and bounded, non-sensitive details leave the server. */
export function error(code:string,details:Record<string,unknown>={}):ToolResult{
  const value={...safeDetails(details),error:CODE.test(code)?code:"tool_operation_failed"};
  return {isError:true,content:[{type:"text",text:JSON.stringify(value,null,2)}],structuredContent:{result:value}};
}
/** A handler value becomes an error result when it reports `{error}`, otherwise a normal result. */
export const settle=(value:unknown):ToolResult=>isRecord(value)&&typeof value.error==="string"?error(value.error,value):result(value);
export async function guarded(operation:()=>Promise<unknown>|unknown,code="tool_operation_failed"):Promise<ToolResult>{
  // Provider exceptions may contain authorization headers or customer data. Never return or log them.
  try{return settle(await operation());}catch{return error(code);}
}
