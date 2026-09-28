/* EGC Hub UI kit for registered screens: DOM helpers, strict JSON requests,
   per-viewer pending-request recovery, Denver dates, CSV export and cents. */
(function(){
'use strict';
const TZ='America/Denver',PENDING='egc.hub.pending.v1.',SCREEN=/^[a-z][a-z0-9_]{1,47}$/,CODE=/^[A-Za-z][A-Za-z0-9_]{1,80}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failure=(code,message,status,extra={})=>Object.assign(new Error(message),{code,status,...extra});
let fieldSeq=0;
// URLs are parsed the way the browser will parse them (tabs, newlines and leading control characters are
// stripped first), so only the resolved scheme decides: http(s), mailto, tel, or a same-origin relative URL.
const URL_KEYS=new Set(['href','src','action','formaction','poster','cite','background','xlink:href']),SAFE_SCHEMES=new Set(['http:','https:','mailto:','tel:']);
const MARKUP_KEYS=new Set(['innerhtml','outerhtml','srcdoc']);
function safeUrl(value){
  const text=String(value),base=typeof location!=='undefined'&&location?.href||'https://localhost/';
  let url;try{url=new URL(text,base);}catch{return null;}
  return SAFE_SCHEMES.has(url.protocol)?text:null;
}
function h(tag,props,...children){
  const node=document.createElement(tag);
  for(const[key,value]of Object.entries(props||{})){
    if(value==null||value===false)continue;
    const lower=key.toLowerCase();
    if(MARKUP_KEYS.has(lower)||lower.startsWith('on')&&typeof value!=='function')continue;
    if(URL_KEYS.has(lower)){const url=safeUrl(value);if(url!=null)node.setAttribute(lower==='xlink:href'?key:lower,url);continue;}
    if(key==='class')node.className=value;
    else if(key==='text')node.textContent=value;
    else if(lower.startsWith('on')&&typeof value==='function')node.addEventListener(lower.slice(2),value);
    else if(key in node&&!key.startsWith('aria-')&&typeof value!=='object')node[key]=value;
    else node.setAttribute(key,String(value));
  }
  for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
const button=(label,onClick,kind='',props={})=>h('button',{type:'button',class:('hub-btn '+kind).trim(),onclick:onClick,...props},label);
const inputMode=(type,step)=>({tel:'tel',email:'email',url:'url',search:'search'})[type]||(type==='number'?(/\./.test(String(step??''))?'decimal':'numeric'):undefined);
function field(spec={}){
  const {label='',name,type='text',value='',required=false,help='',options=[],inputmode,autocomplete,placeholder,min,max,step,maxlength,rows}=spec,id='hub-field-'+(++fieldSeq);
  let control;
  if(type==='select')control=h('select',{id,name,required},options.map(option=>h('option',{value:String(option.value),selected:String(option.value)===String(value??'')},option.label)));
  else if(type==='textarea')control=h('textarea',{id,name,required,placeholder,maxlength,rows,autocomplete},String(value??''));
  else if(type==='checkbox')control=h('input',{id,name,type,checked:Boolean(value),required});
  else control=h('input',{id,name,type,value:String(value??''),required,placeholder,min,max,step,maxlength,inputmode:inputmode||inputMode(type,step),autocomplete});
  const hint=help?h('small',{id:id+'-help'},help):null;
  if(hint)control.setAttribute('aria-describedby',hint.id);
  return type==='checkbox'?h('label',{class:'hub-field hub-check',htmlFor:id},control,h('span',{},label),hint):h('label',{class:'hub-field',htmlFor:id},h('span',{},label),control,hint);
}
function retryable(error){
  const status=Number(error?.status||0);
  return error?.retryable===true||/_outcome_unknown$/.test(String(error?.code||''))||[0,401,403,408,429].includes(status)||status>=500;
}
async function requestJSON(path,opts={}){
  const {method='GET',body,timeout=30000,prefix='hub',validate,headers={},signal}=opts;
  if(!/^\/api\/[A-Za-z0-9_\-/]+(?:\?[^#\s]*)?$/.test(String(path||'')))throw failure(prefix+'_invalid_request','This Hub request is not allowed.',400);
  const fetcher=opts.fetcher||(typeof hubFetch==='function'?hubFetch:(url,init)=>fetch(url,{...init,credentials:'same-origin'}));
  const controller=new AbortController(),relay=()=>controller.abort();let timedOut=false,response,data=null;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
  signal?.addEventListener?.('abort',relay,{once:true});
  try{
    response=await fetcher(path,{method,cache:'no-store',credentials:'same-origin',headers:body===undefined?{...headers}:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
    data=await response.json().catch(()=>null);
  }catch(error){
    if(timedOut)throw failure(prefix+'_timeout','The Hub did not answer in time. Your request was kept; retry it before making another change.',503,{retryable:true});
    if(signal?.aborted)throw failure(prefix+'_aborted','The request was cancelled.',0,{aborted:true});
    if(error?.code==='HUB_AUTH_REQUIRED')throw failure(prefix+'_sign_in_required','Sign in again to continue.',401,{retryable:true});
    throw failure(prefix+'_unavailable','The Hub could not be reached. Your request was kept; retry it when the connection returns.',503,{retryable:true});
  }finally{clearTimeout(timer);signal?.removeEventListener?.('abort',relay);}
  if(timedOut)throw failure(prefix+'_timeout','The Hub did not answer in time. Your request was kept; retry it before making another change.',503,{retryable:true});
  const status=Number(response?.status)||503;
  if(!data||typeof data!=='object'||Array.isArray(data))throw failure(prefix+'_unverified','The Hub response could not be verified. Retry before making changes.',response?.ok?503:status);
  if(!response.ok||data.ok!==true){
    const code=typeof data.code==='string'&&CODE.test(data.code)?data.code:typeof data.error==='string'&&CODE.test(data.error)&&!data.error.includes(' ')?data.error:prefix+(response.ok?'_unverified':'_failed');
    const message=typeof data.error==='string'&&data.error.includes(' ')?data.error.slice(0,300):typeof data.message==='string'&&data.message?data.message.slice(0,300):'The Hub could not complete this request.';
    throw failure(code,message,response.ok?503:status,data.details&&typeof data.details==='object'?{details:data.details}:{});
  }
  if(validate&&validate(data)!==true)throw failure(prefix+'_unverified','The Hub response was incomplete. Nothing is shown as current until it can be verified.',503);
  return data;
}
function viewer(){try{return String(sessionStorage.getItem('egc_u')||'').trim().toLowerCase();}catch{return'';}}
function pending(screen,viewerId=viewer(),{now=()=>new Date()}={}){
  if(!SCREEN.test(String(screen||'')))throw failure('hub_pending_invalid','A pending request needs a screen id.',400);
  const key=PENDING+screen+'.'+encodeURIComponent(String(viewerId||'').trim().toLowerCase()||'anonymous');
  const read=()=>{try{const row=JSON.parse(sessionStorage.getItem(key)||'null');return row&&typeof row==='object'&&typeof row.path==='string'&&typeof row.method==='string'&&UUID.test(String(row.requestId||''))&&row.body&&typeof row.body==='object'&&row.body.requestId===row.requestId?row:null;}catch{return null;}};
  const clear=()=>{try{sessionStorage.removeItem(key);}catch{}};
  async function send(record,opts){
    try{const data=await requestJSON(record.path,{...opts,method:record.method,body:record.body});clear();return data;}
    catch(error){if(!retryable(error))clear();throw Object.assign(error,{pending:read()});}
  }
  return {key,get:read,discard:clear,
    submit(path,body={},opts={}){
      const saved=read();
      if(saved)return Promise.reject(failure('hub_pending_exists','Retry or discard the saved request before starting another.',409,{pending:saved}));
      const requestId=UUID.test(String(body.requestId||''))?body.requestId:crypto.randomUUID(),stamp=now();
      const record={path,method:String(opts.method||'POST').toUpperCase(),requestId,body:{...body,requestId},savedAt:typeof stamp?.toISOString==='function'?stamp.toISOString():String(stamp)};
      try{sessionStorage.setItem(key,JSON.stringify(record));}catch{}
      return send(record,opts);
    },
    replay(opts={}){const record=read();return record?send(record,opts):Promise.reject(failure('hub_pending_missing','There is no saved request to retry.',404));}};
}
function errorText(error,map={}){
  const code=String(error?.code||''),status=Number(error?.status||0);
  if(code&&Object.hasOwn(map,code))return map[code];
  if(/_timeout$/.test(code))return 'The Hub did not answer in time. Your request was kept; retry the original request before making another change.';
  if(/_revision_conflict$/.test(code))return 'This record changed while you were editing. Your draft is kept; load the latest record before applying it again.';
  if(/_idempotency_conflict$/.test(code))return 'The original request already has a different saved result. Refresh before making another change.';
  if(/_outcome_unknown$/.test(code))return 'The result could not be confirmed. Retry the original request; do not create another.';
  if(status===401)return 'Your sign-in expired. Sign in again, then retry the saved request.';
  if(status===403)return 'Your account does not have access to this action.';
  if(status===413)return 'This request is too large. Shorten it and try again.';
  return error?.message||'The Hub is unavailable. Retry the original request.';
}
const parts=at=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(part=>[part.type,part.value]));
// Built from components with Date.UTC so '2026-13-01' or '2026-02-30' is false in every engine instead of throwing or rolling over.
function validDate(date){
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;
  const [y,m,d]=date.split('-').map(Number);
  if(m<1||m>12||d<1||d>31)return false;
  const stamp=Date.UTC(y,m-1,d,12);
  return Number.isFinite(stamp)&&new Date(stamp).toISOString().slice(0,10)===date;
}
function today(now=new Date()){const p=parts(now);return`${p.year}-${p.month}-${p.day}`;}
const addDays=(date,count)=>validDate(date)&&Number.isInteger(count)?new Date(Date.parse(date+'T12:00:00Z')+count*86400000).toISOString().slice(0,10):null;
function localToIso(date,time){
  if(!validDate(date)||!/^\d{2}:\d{2}$/.test(String(time||'')))return null;
  const [y,m,d]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number),wall=Date.UTC(y,m-1,d,hour,minute);
  if(new Date(wall).toISOString().slice(0,16)!==`${date}T${time}`)return null;
  const offsets=new Set([-86400000,0,86400000].map(delta=>{const p=parts(wall+delta);return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute)-(wall+delta);}));
  const matches=[...offsets].map(offset=>wall-offset).filter(ts=>{const p=parts(ts);return`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`===`${date}T${time}`;});
  return matches.length===1?new Date(matches[0]).toISOString():null;
}
const csvCell=value=>{let text=String(value??'');if(/^[=+\-@\t\r]/.test(text))text="'"+text;return`"${text.replaceAll('"','""')}"`;};
const csvText=rows=>rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
function downloadCsv(name,rows){
  const blob=new Blob([csvText(rows)],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=String(name||'egc-export').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,120).replace(/(?<!\.csv)$/i,'.csv');link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function cents(value){
  if(typeof value==='number'){if(!Number.isFinite(value))return null;const scaled=Math.round(value*100);return Math.abs(scaled-value*100)<1e-6&&Math.abs(scaled)<=100000000000?scaled:null;}
  const text=String(value??'').trim().replace(/^\$/,'').replace(/,(?=\d{3}(?:\D|$))/g,'');
  const match=/^(-)?(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if(!match)return null;
  const amount=Number(match[2])*100+Number((match[3]||'').padEnd(2,'0'));
  return match[1]?-amount:amount;
}
const money=(amount,currency='USD')=>Number.isSafeInteger(amount)?new Intl.NumberFormat('en-US',{style:'currency',currency}).format(amount/100):'—';
window.addEventListener('egc:signout',()=>{try{for(let i=sessionStorage.length-1;i>=0;i--){const name=sessionStorage.key(i);if(name?.startsWith(PENDING))sessionStorage.removeItem(name);}}catch{}});
window.EGCHubKit=Object.freeze({h,button,field,requestJSON,retryable,pending,errorText,today,addDays,validDate,localToIso,csvCell,csvText,downloadCsv,cents,money,requestId:()=>crypto.randomUUID()});
})();
