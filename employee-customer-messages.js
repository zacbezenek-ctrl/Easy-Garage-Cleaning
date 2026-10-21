/* PORTAL-INBOX: client portal messages waiting for the office (/api/customer-messages). Two Hub mounts share one
   list and one 30-second poll: the Customer messages screen (EGCCustomerMessages, business users) and the home widget
   (EGCCustomerMessagesHome, on the Command center and My day, also for Sales or Phone staff who may contact
   customers). Both show only for a signed-in viewer whose server capabilities include customer.send; the server
   checks it again. While the viewer is eligible the open count also shows as a badge on the Customer messages nav
   item. A failed load says unavailable, never zero. Nothing here messages the customer. */
(function(){
'use strict';
if(window.EGCCustomerMessages)return;// The registry may load this file again for the screen; one copy runs.
const POLL=30000,TIMEOUT=20000,TZ='America/Denver',HOME_LIMIT=5,NAV='customer_messages';
const TASK={created:'HighLevel task created',pending:'HighLevel task queued · retrying',parked:'HighLevel task not created · check HighLevel',failed:'HighLevel refused the task · check HighLevel',needs_contact:'No HighLevel contact · reply from the Hub',not_configured:'HighLevel tasks not set up',not_needed:''};
const S={data:null,error:null,at:0,request:null,timer:0,generation:0,busy:new Set(),views:new Set()};
function h(tag,attrs,...children){const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs||{})){if(value==null||value===false)continue;if(key==='class')node.className=value;else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);else node.setAttribute(key,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
const plural=(count,one,many)=>count+' '+(count===1?one:many);
function capabilities(){for(const store of [sessionStorage,localStorage]){try{const raw=store.getItem('egc_capabilities');if(raw!=null){const list=JSON.parse(raw);return Array.isArray(list)?list:[];}}catch{}}return [];}
const eligible=()=>capabilities().includes('customer.send');
function fetcher(ctx){return typeof ctx?.hubFetch==='function'?ctx.hubFetch:typeof window.hubFetch==='function'?window.hubFetch:(url,init)=>fetch(url,{...init,credentials:'same-origin'});}
let lastCtx=null;
async function call(method,body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);
  try{
    const response=await fetcher(lastCtx)('/api/customer-messages',{method,cache:'no-store',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal});
    const data=await response.json().catch(()=>null);
    if(response.ok&&data&&data.ok===true)return data;
    throw Object.assign(new Error(typeof data?.error==='string'?data.error:'Customer messages could not be checked right now.'),{status:response.status,code:String(data?.code||'')});
  }catch(error){if(error?.name==='AbortError')throw Object.assign(new Error('Customer messages did not answer in time.'),{code:'timeout'});throw error;}
  finally{clearTimeout(timer);}
}
const validList=data=>Array.isArray(data?.messages)&&data.messages.every(row=>row&&typeof row.id==='string'&&typeof row.body==='string');
function load(){
  if(S.request)return S.request;
  if(!eligible()){S.data=null;S.error=null;paint();return Promise.resolve();}
  const generation=S.generation;
  S.request=(async()=>{
    try{const data=await call('GET');if(generation!==S.generation)return;if(!validList(data))throw new Error('The customer message list could not be verified.');S.data=data;S.error=null;}
    catch(error){if(generation!==S.generation)return;S.error=error;}
    S.at=Date.now();paint();
  })().finally(()=>{if(generation===S.generation)S.request=null;});
  return S.request;
}
function schedule(){
  clearInterval(S.timer);S.timer=0;
  if(!eligible())return;
  S.timer=setInterval(()=>{if(document.visibilityState!=='hidden')void load();},POLL);
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&S.timer&&Date.now()-S.at>POLL)void load();});
const count=()=>Array.isArray(S.data?.messages)?S.data.messages.length:0;
const countText=()=>count()+(S.data?.complete===false?'+':'');
// The nav item is drawn by employee-suite.js and may be redrawn; the badge is re-applied on every paint.
function badge(){
  for(const button of document.querySelectorAll('[data-ops-tab="'+NAV+'"]')){
    let mark=button.querySelector('.cm-nav-badge');
    if(!count()){mark?.remove();continue;}
    if(!mark){mark=h('span',{class:'cm-nav-badge'});button.append(mark);}
    mark.textContent=countText();mark.setAttribute('aria-label',plural(count(),'customer conversation','customer conversations')+' waiting');
  }
}
function paint(){badge();for(const view of S.views)try{view.render();}catch(error){console.error('Customer messages failed to render',error);}}
function when(value){const date=new Date(value);if(!Number.isFinite(date.valueOf()))return '';const minutes=Math.floor((Date.now()-date.valueOf())/60000);const clock=new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(date);return minutes<1?'Just now · '+clock:minutes<60?minutes+' min ago · '+clock:clock;}
function jobHref(row){const id=encodeURIComponent(row.jobId||'');return row.jobType==='walkthrough'?'/crew/gameplan.html?walkthroughId='+id:'/crew/job.html?jobId='+id;}
async function markHandled(row,ctx,button){
  if(S.busy.has(row.id))return;
  S.busy.add(row.id);button.disabled=true;button.textContent='Saving…';
  try{
    // The count shown is sent, so a message that arrived since this row was drawn is never marked handled unseen.
    await call('POST',{action:'mark_handled',id:row.id,seenCount:Number(row.messageCount)||1});
    if(S.data)S.data={...S.data,messages:S.data.messages.filter(item=>item.id!==row.id)};
    try{ctx?.toast?.('Marked handled');}catch{}
  }catch(error){
    try{ctx?.toast?.(error.message||'That message could not be marked handled. Retry.',true);}catch{}
    // A new message joined the entry: the row stays and the list reloads so it can be read first.
    if(error?.code==='customer_messages_changed'){S.busy.delete(row.id);S.at=0;void load();}
  }finally{S.busy.delete(row.id);paint();}
}
function item(row,ctx){
  // One entry per job: later portal messages join it until it is marked handled (PORTAL-INBOX).
  const many=Number(row.messageCount)>1,recent=Array.isArray(row.messages)?row.messages:[],last=row.lastMessageAt||row.createdAt;
  const who=row.authorName&&row.authorName!==row.customerName?row.authorName+' for '+row.customerName:row.customerName||row.authorName||'Customer';
  const about=[row.jobType==='walkthrough'?'Walkthrough':row.serviceType||'Job',row.jobDate].filter(Boolean).join(' · ');
  const handled=h('button',{type:'button',class:'hub-btn primary','data-cm-handled':row.id},'Mark handled');
  handled.addEventListener('click',()=>void markHandled(row,ctx,handled));
  const reply=row.jobType==='job'&&typeof window.opsOpenJobRoom==='function'?h('button',{type:'button',class:'hub-btn',onclick:()=>window.opsOpenJobRoom(row.jobId)},'Reply in job thread'):null;
  const task=TASK[row.highLevelTask]||'';
  return h('li',{class:'cm-item','data-cm-message':row.id},
    h('div',{class:'cm-item-head'},h('strong',{class:'cm-who'},who,many?h('span',{class:'cm-many'},plural(row.messageCount,'message','messages')):null),h('time',{class:'cm-when',datetime:last||''},when(last))),
    ...(many&&recent.length>1?recent.map(message=>h('p',{class:'cm-body'},h('span',{class:'cm-from'},message.authorName+': '),message.body)):[h('p',{class:'cm-body'},row.body)]),
    many&&row.messageCount>recent.length?h('p',{class:'cm-note'},'Showing the latest '+recent.length+'. Open the job thread for the rest.'):null,
    h('p',{class:'cm-meta'},about,task?h('span',{class:'cm-task cm-task-'+row.highLevelTask},task):null),
    h('div',{class:'cm-actions'},h('a',{class:'hub-btn',href:jobHref(row)},'Open job'),reply,handled));
}
function body(ctx,limit){
  if(!S.data&&!S.error)return [h('div',{class:'cm-loading','aria-busy':'true'},h('p',{class:'hub-sr-only',role:'status'},'Checking customer messages…'),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton'}))];
  if(S.error&&!S.data)return [h('div',{class:'hub-notice error cm-state',role:'alert'},h('strong',{},'Customer messages are unavailable'),h('p',{},(S.error.status===401?'Your sign-in expired. Sign in again to see customer messages.':S.error.message||'Customer messages could not be checked right now.')+' This is not a count of zero.'),h('button',{type:'button',class:'hub-btn',onclick:()=>void load()},'Retry'))];
  const rows=S.data.messages,out=[];
  if(S.error)out.push(h('p',{class:'hub-notice warning cm-stale',role:'status'},'The latest check failed; this list may be out of date.'));
  if(!rows.length){out.push(h('p',{class:'cm-empty'},'No customer messages are waiting.'),h('p',{class:'cm-note'},'New client portal messages appear here within a minute.'));return out;}
  out.push(h('ol',{class:'cm-list'},rows.slice(0,limit).map(row=>item(row,ctx))));
  if(rows.length>limit)out.push(h('p',{class:'cm-note'},'Showing the '+limit+' newest of '+countText()+'.'));
  else if(S.data.complete===false)out.push(h('p',{class:'cm-note'},'More messages are waiting than this list shows. Mark these handled to see the rest.'));
  return out;
}
function frame(id,title,ctx,limit,extra){
  const total=S.data?count():null;
  return h('section',{class:'egc-customer-messages','aria-labelledby':id},
    h('header',{class:'cm-head'},h('div',{},h('span',{class:'cm-eyebrow'},'CLIENT PORTAL'),h('h2',{id},title,total?h('span',{class:'cm-count','data-cm-count':''},countText()):null),h('p',{class:'cm-scope'},'Messages customers sent from their portal, one entry per job. Each stays here until someone marks it handled.'))),
    ...body(ctx,limit),extra?.()||null);
}
function view(kind){
  const state={host:null,ctx:null};
  const self={render(){
    if(!state.host)return;
    if(!eligible()){state.host.replaceChildren();return;}
    const home=kind==='home';
    const more=home&&count()>HOME_LIMIT&&state.ctx?.capabilities&&[...state.ctx.capabilities].includes('customer_contact')?()=>h('div',{class:'cm-actions'},h('button',{type:'button',class:'hub-btn',onclick:()=>state.ctx?.go?.(NAV)},'Open all customer messages')):null;
    state.host.replaceChildren(frame('cm-title-'+kind,home?'Customer messages':'Customer messages waiting',state.ctx,home?HOME_LIMIT:Infinity,more));
  }};
  return {
    mount(host,ctx={}){if(!host)return;state.host=host;state.ctx=ctx;lastCtx=ctx;S.views.add(self);self.render();if(!eligible())return;if(!S.timer)schedule();if(!S.data||Date.now()-S.at>POLL)return load();},
    unmount(){S.views.delete(self);state.host?.replaceChildren();state.host=null;state.ctx=null;},
    refresh(){S.at=0;return load();},
    canLeave(){return true;},
  };
}
window.addEventListener('egc:signout',()=>{S.generation++;S.request=null;S.data=null;S.error=null;S.at=0;clearInterval(S.timer);S.timer=0;lastCtx=null;paint();});
window.EGCCustomerMessages=Object.freeze(view('screen'));
window.EGCCustomerMessagesHome=Object.freeze(view('home'));
})();
