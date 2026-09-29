// In-memory Firestore REST fake for router and harness tests that need the
// production storage path (firestoreFetch) without an emulator: document GET,
// collection list scans, :runQuery (field filters joined by AND, limit) and
// :commit with exists/updateTime preconditions.
// Every other host goes to `fallback` (for example the real fetch for loopback
// test servers) or is refused.
import {decodeFirestoreFields,encodeFirestoreFields} from '../../functions/_lib/firestore-job.js';

const ROOT='projects/egcw-1ec83/databases/(default)/documents';
const plain=value=>value&&typeof value==='object'?decodeFirestoreFields({value}).value:value;
const COMPARE={EQUAL:(a,b)=>a===b,NOT_EQUAL:(a,b)=>a!==b,LESS_THAN:(a,b)=>a<b,LESS_THAN_OR_EQUAL:(a,b)=>a<=b,GREATER_THAN:(a,b)=>a>b,GREATER_THAN_OR_EQUAL:(a,b)=>a>=b};
function filters(where){
 if(!where)return [];
 if(where.compositeFilter){if(where.compositeFilter.op!=='AND')throw new Error('Only AND composite filters are faked');return where.compositeFilter.filters.flatMap(filters);}
 if(where.fieldFilter&&COMPARE[where.fieldFilter.op])return [where.fieldFilter];
 throw new Error('Unsupported query filter: '+JSON.stringify(where));
}

export function firestoreMemory({fallback=null}={}){
 const documents=new Map(),commits=[],patches=[];let revision=0;
 const stamp=()=>`2026-09-22T00:00:00.${String(++revision).padStart(9,'0')}Z`;
 const put=(path,data)=>{documents.set(path,{name:`${ROOT}/${path}`,fields:encodeFirestoreFields(data),updateTime:stamp()});return documents.get(path);};
 async function fetch(input,options={}){
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.hostname!=='firestore.googleapis.com'){
   if(fallback)return fallback(input,options);
   throw new Error('External network refused by the in-memory Firestore fake: '+url.hostname);
  }
  const marker=`/v1/${ROOT}`;
  if(!url.pathname.startsWith(marker))throw new Error('Only the production project path is faked: '+url.pathname);
  const path=decodeURIComponent(url.pathname.slice(marker.length)).replace(/^\//,''),method=(options.method||'GET').toUpperCase();
  if(path===':commit'&&method==='POST'){
   const {writes=[]}=JSON.parse(options.body);
   for(const write of writes){
    const key=write.update.name.split('/documents/')[1],existing=documents.get(key);
    if(write.currentDocument?.exists===false&&existing||write.currentDocument?.updateTime&&existing?.updateTime!==write.currentDocument.updateTime)return Response.json({error:{status:'FAILED_PRECONDITION'}},{status:409});
   }
   for(const write of writes){
    const key=write.update.name.split('/documents/')[1],patch=decodeFirestoreFields(write.update.fields||{});
    const current=write.updateMask?decodeFirestoreFields(documents.get(key)?.fields||{}):{};
    put(key,{...current,...patch});
   }
   commits.push(writes);
   return Response.json({commitTime:'2026-09-22T00:00:00Z',writeResults:writes.map(()=>({}))});
  }
  if(path.endsWith(':runQuery')&&method==='POST'){
   const {structuredQuery:query}=JSON.parse(options.body),parent=path.slice(0,-':runQuery'.length).replace(/\/$/,'');
   const prefix=`${parent?parent+'/':''}${query.from[0].collectionId}/`,conditions=filters(query.where);
   const rows=[...documents].filter(([key])=>key.startsWith(prefix)&&!key.slice(prefix.length).includes('/')).map(([,document])=>document)
    .filter(document=>{const row=decodeFirestoreFields(document.fields);return conditions.every(({field,op,value})=>COMPARE[op](row[field.fieldPath],plain(value)));})
    .slice(0,query.limit||undefined);
   return Response.json(rows.length?rows.map(document=>({document,readTime:'2026-09-22T00:00:00Z'})):[{readTime:'2026-09-22T00:00:00Z'}]);
  }
  if(method==='PATCH'){
   // Document PATCH (patchJob): top-level updateMask fields and the currentDocument
   // preconditions. A stale updateTime is Firestore's 400 FAILED_PRECONDITION.
   const key=path.split('/').filter(Boolean).join('/'),existing=documents.get(key),mask=url.searchParams.getAll('updateMask.fieldPaths');
   const updateTime=url.searchParams.get('currentDocument.updateTime'),exists=url.searchParams.get('currentDocument.exists');
   if(mask.some(field=>field.includes('.')))throw new Error('Nested update masks are not faked: '+mask.join(','));
   if(!existing&&(updateTime||exists==='true'))return Response.json({error:{status:'NOT_FOUND'}},{status:404});
   if(existing&&exists==='false')return Response.json({error:{status:'ALREADY_EXISTS'}},{status:409});
   if(updateTime&&existing.updateTime!==updateTime)return Response.json({error:{status:'FAILED_PRECONDITION'}},{status:400});
   const patch=decodeFirestoreFields(JSON.parse(options.body||'{}').fields||{}),next=mask.length?decodeFirestoreFields(existing?.fields||{}):{};
   if(mask.length)for(const field of mask){if(field in patch)next[field]=patch[field];else delete next[field];}
   else Object.assign(next,patch);
   patches.push({path:key,fields:mask});
   return Response.json(put(key,next));
  }
  if(method!=='GET')throw new Error(`The in-memory Firestore fake does not support ${method} ${path}`);
  const parts=path.split('/').filter(Boolean);
  if(parts.length%2===0){const document=documents.get(parts.join('/'));return document?Response.json(document):Response.json({error:{status:'NOT_FOUND'}},{status:404});}
  const prefix=parts.join('/')+'/';
  return Response.json({documents:[...documents].filter(([key])=>key.startsWith(prefix)&&!key.slice(prefix.length).includes('/')).map(([,document])=>document)});
 }
 return {fetch,documents,commits,patches,put,get:path=>documents.has(path)?decodeFirestoreFields(documents.get(path).fields):null};
}
