/* GHL-TRACK-1: 'HighLevel tags stuck for N visits' on the Command center, with Retry (EGC_GHL_TAG_OUTBOX).
   It registers itself as a home widget (employee-hub-screens.js registerWidget) for business viewers and can also run
   standalone with EGCGhlTagsStuck.mount(host). It reads GET /api/ghl-tag-drain?view=stuck: parked entries and ones the
   tag worker is overdue on, and the worker's last check-in (drain.stale says it has stopped). Retry makes them due
   again and tells HighLevel at once (POST action retry), which only adds tags and sets appointment status. The widget
   stays hidden while the outbox is off, nothing is stuck and the worker runs, or the viewer may not manage dispatch
   (403); a failed check says so, never "zero". */
(function(){
'use strict';
const PATH='/api/ghl-tag-drain',TIMEOUT=20000;
const S={host:null,ctx:{},generation:0,busy:false};
function h(tag,attrs,...children){const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs||{})){if(value==null||value===false)continue;if(key==='class')node.className=value;else if(key==='text')node.textContent=value;else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);else node.setAttribute(key,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
const button=(label,onClick,kind='')=>h('button',{type:'button',class:('hub-btn '+kind).trim(),onclick:onClick},label);
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
function fetcher(){return typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:typeof hubFetch==='function'?hubFetch:(url,init)=>fetch(url,{...init,credentials:'same-origin'});}
async function request(method,body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);
  try{
    const response=await fetcher()(PATH+(body?'':'?view=stuck'),{method,cache:'no-store',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal});
    const data=await response.json().catch(()=>null);
    if(response.ok&&record(data)&&data.ok===true)return data;
    throw Object.assign(new Error(record(data)&&typeof data.error==='string'?data.error:'HighLevel tag status could not be checked.'),{status:response.status});
  }finally{clearTimeout(timer);}
}
function show(node){if(!S.host)return;S.host.hidden=!node;S.host.replaceChildren(...(node?[node]:[]));}
const plural=(count,word)=>count+' '+word+(count===1?'':'s');
function since(minutes){return minutes<90?plural(minutes,'minute'):minutes<2880?plural(Math.round(minutes/60),'hour'):plural(Math.round(minutes/1440),'day');}
// The tag worker (egc-worker on Railway) checks in on every run; stale means none arrived in the last 10 minutes.
function stopped(drain){
  if(!record(drain)||drain.stale!==true)return '';
  return Number.isSafeInteger(drain.minutesSince)&&drain.minutesSince>=0?'The HighLevel tag worker has not run for '+since(drain.minutesSince):'The HighLevel tag worker has not run yet';
}
function stuck(result){
  const visits=result.visits,worker=stopped(result.drain);
  const title=h('h2',{class:'gt-title'},visits?'HighLevel tags stuck for '+plural(visits,'visit'):worker);
  title.id='gt-heading-'+S.generation;
  const note=visits?h('p',{class:'gt-copy'},'HighLevel has not been told about these schedule changes or walkthrough outcomes: 8 tries failed, or the tag worker has not run them. Retry tells it now. Your HighLevel workflows decide what the customer hears.'):null;
  const workerNote=worker?h('p',{class:'gt-copy','data-gt-worker':'stopped'},(visits?worker+'. ':'')+'New bookings, moves, cancellations and walkthrough outcomes wait in the Hub until it runs, and HighLevel is not told about them. Check egc-worker on Railway (EGC_GHL_TAG_DRAIN_ENABLED=true).'+(visits?' Until then, Retry tells HighLevel up to 5 visits at a time.':'')):null;
  const status=h('p',{class:'gt-status',role:'status','aria-live':'polite'});
  const again=visits?button('Retry',()=>void retry(again,status),'primary'):null;
  return h('section',{class:'egc-ghl-tags hub-notice warning','aria-labelledby':title.id,'data-gt-visits':visits,'data-gt-stale':worker?'true':null},title,note,workerNote,result.coverage?.complete===false?h('p',{class:'gt-copy'},'More stuck entries may exist than this count shows.'):null,again?h('div',{class:'hub-actions gt-actions'},again):null,status);
}
function failure(error){
  const text=error?.status===401?'Your sign-in expired. Sign in again to check HighLevel tags.':'HighLevel tag status could not be checked right now. This is not a count of zero.';
  return h('section',{class:'egc-ghl-tags hub-notice error',role:'alert'},h('strong',{},'HighLevel tag status is unavailable'),h('p',{class:'gt-copy'},text),h('div',{class:'hub-actions gt-actions'},button('Check again',()=>void load())));
}
async function load(){
  if(!S.host)return;
  const generation=++S.generation;
  try{
    const result=await request('GET');
    if(generation!==S.generation)return;
    if(result.enabled===false)return show(null);
    if(!Number.isSafeInteger(result.visits)||result.visits<0)throw new Error('HighLevel tag status could not be verified.');
    show(result.visits||stopped(result.drain)?stuck(result):null);
  }catch(error){if(generation!==S.generation)return;show(error?.status===403?null:failure(error));}
}
async function retry(control,status){
  if(S.busy)return;S.busy=true;control.disabled=true;status.textContent='Sending the tags to HighLevel again…';
  try{
    const result=await request('POST',{action:'retry',requestId:crypto.randomUUID()});
    if(!Number.isSafeInteger(result.requeued))throw new Error('The retry could not be confirmed.');
    status.textContent=result.requeued?'HighLevel will be told again in a moment.':'Nothing was stuck any more.';
    if(typeof S.ctx.toast==='function')S.ctx.toast(status.textContent);
    S.busy=false;await load();
  }catch(error){S.busy=false;control.disabled=false;status.textContent='The retry did not go through: '+(error.message||'try again.');}
}
window.EGCGhlTagsStuck=Object.freeze({
  mount(host,ctx={}){S.host=host;S.ctx=ctx||{};S.busy=false;host.hidden=true;return load();},
  unmount(){S.generation++;S.host=null;S.ctx={};S.busy=false;},
  refresh(){return load();},
});
window.addEventListener('egc:signout',()=>{S.generation++;if(S.host)S.host.replaceChildren();S.host=null;S.ctx={};});
try{window.EGCHubScreens?.registerWidget?.({id:'ghl_tags_stuck',label:'HighLevel tags',homes:['today'],capability:'business',module:'EGCGhlTagsStuck',load:{css:'employee-ghl-tags.css',v:'20260929ghltags'}});}
catch(error){console.warn('HighLevel tag widget was not registered:',error?.message||error);}
})();
