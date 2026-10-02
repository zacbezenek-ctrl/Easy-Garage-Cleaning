type ObjectValue=Record<string,unknown>;
/** Arrays are catalogued once, not repeated in multiple diagnostic lists. Explicit
 * pages retain the original rows. Totals describe the service's returned inventory,
 * while upstream truncation flags remain visible and never become full coverage. */
export function presentCustomerDiagnostics(value:{customers:unknown;meta:unknown},input:{section?:string|undefined;offset?:number|undefined;limit?:number|undefined}={}) {
  const sections:Record<string,{total:number;retrieval:{tool:string;input:{section:string;offset:number;limit:number}}}>={},arrays=new Map<string,unknown[]>();
  const summarize=(node:unknown,path:string):unknown=>{
    if(node instanceof Date)return Number.isFinite(node.valueOf())?node.toISOString():null;
    if(Array.isArray(node)){arrays.set(path,node);const section={total:node.length,retrieval:{tool:'egc.customer_state_diagnostics',input:{section:path,offset:0,limit:20}}};sections[path]=section;return {total:node.length,detailSection:path};}
    if(typeof node==='string'&&node.length>2000){arrays.set(path,[node]);sections[path]={total:1,retrieval:{tool:'egc.customer_state_diagnostics',input:{section:path,offset:0,limit:1}}};return {characterCount:node.length,detailSection:path,encoding:'original_string'};}
    if(node&&typeof node==='object')return Object.fromEntries(Object.entries(node as ObjectValue).map(([key,item])=>[key,summarize(item,path?`${path}.${key}`:key)]));
    return node;
  };
  const summary=summarize(value,'') as ObjectValue;
  if(input.section!==undefined){
    const rows=arrays.get(input.section);if(!rows)throw new Error('invalid_diagnostics_section');
    const offset=input.offset??0,limit=input.limit??20;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('invalid_diagnostics_page');
    return {presentation:'customer_diagnostics_page',section:input.section,items:rows.slice(offset,offset+limit),page:{offset,limit,total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null,scope:'service_returned_inventory'},coverage:{customers:(value.customers as ObjectValue|null)?.generatedAt??null,qualification:'Read each upstream truncated flag in the summary. Pagination is over current service-returned inventory, not a stable cross-call snapshot.'}};
  }
  return {...summary,presentation:'customer_diagnostics_summary',sections,detailRetrieval:{tool:'egc.customer_state_diagnostics',qualification:'Choose an exact section and follow page.nextOffset. Arrays are summarized, not omitted as zero. Existing upstream truncated flags remain authoritative; read-only calls do not reconcile or send.'}};
}
