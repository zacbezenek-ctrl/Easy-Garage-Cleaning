/* Overdue follow-ups on the Hub home: the Action Center overdue queue (registered actions only), mounted by the
   home-widget registry (employee-hub-screens.js HOME_WIDGETS) or standalone with EGCFollowupsHome.mount(host).
   Read-only: it never sends, approves or completes anything. A failed load says unavailable, never zero. */
(function(){
'use strict';
const TZ='America/Denver',LIMIT=5,TIMEOUT=20000,CODE=/^[a-z][a-z0-9_]{1,80}$/;
const S={host:null,root:null,ctx:{},generation:0,controller:null};
const failures={
  operations_bridge_not_configured:'The Hub-to-backend connection needs configuration, so overdue follow-ups were not loaded.',
  business_session_required:'Sign in with a business account to see overdue follow-ups.',
  operations_timeout:'The Action Center did not answer in time, so nothing is shown as current.',
  operations_unverified:'The overdue list could not be verified, so nothing is shown as current.'
};
const UNAVAILABLE='Overdue follow-ups could not be checked right now. This is not a count of zero.';
function h(tag,attrs,...children){const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs||{})){if(value==null||value===false)continue;if(key==='class')node.className=value;else if(key==='text')node.textContent=value;else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);else if(key in node&&!key.startsWith('aria-')&&typeof value!=='object')node[key]=value;else node.setAttribute(key,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
const button=(label,onClick,kind='')=>h('button',{type:'button',class:('hub-btn '+kind).trim(),onclick:onClick},label);
const now=()=>{const value=typeof S.ctx.now==='function'?S.ctx.now():new Date();return value instanceof Date&&Number.isFinite(value.valueOf())?value:new Date();};
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const attention=task=>['customer','provider'].includes(task.waitingOn)?task.reviewAt:task.dueAt;
function clockTime(value){const date=new Date(value);return Number.isFinite(date.valueOf())?new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'numeric',minute:'2-digit'}).format(date):'';}
function late(task,at){
  const since=at.valueOf()-Date.parse(attention(task)||'');
  if(!Number.isFinite(since))return 'Overdue · time needs review';
  const minutes=Math.max(1,Math.floor(since/60000)),hours=Math.floor(minutes/60),days=Math.floor(hours/24);
  return 'Overdue by '+(minutes<60?minutes+' min':hours<48?hours+' h':days+' days');
}
function kindLabel(kind){const label=window.EGCActionCenter?.drafts?.labels?.[kind];if(typeof label==='string')return label;const text=String(kind||'action').replaceAll('_',' ');return text.charAt(0).toUpperCase()+text.slice(1);}
function fetcher(){return typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:typeof hubFetch==='function'?hubFetch:(url,init)=>fetch(url,{...init,credentials:'same-origin'});}
// /api/operations answers {ok:true,...} or {error:code}; anything else is unverified, never an empty list.
const timeout=()=>Object.assign(new Error('operations_timeout'),{code:'operations_timeout'});
async function request(controller,method,body){
  let timedOut=false,response,data=null;const timer=setTimeout(()=>{timedOut=true;controller.abort();},TIMEOUT);
  try{
    response=await fetcher()('/api/operations',{method,cache:'no-store',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal});
    // The timer can fire after the headers arrive while the body is still stalled; that is a timeout, not an unverified body.
    try{data=await response.json();}catch{if(timedOut)throw timeout();data=null;}
  }catch(error){throw timedOut?timeout():error;}
  finally{clearTimeout(timer);}
  if(response?.ok&&record(data)&&data.ok===true&&!data.error)return data;
  const code=record(data)&&typeof data.error==='string'&&CODE.test(data.error)?data.error:response?.ok?'operations_unverified':'operations_unavailable';
  throw Object.assign(new Error(code),{code,status:Number(response?.status)||0});
}
const validIdentity=r=>typeof r.enabled==='boolean'&&record(r.actor)&&typeof r.actor.id==='string'&&Boolean(r.actor.id)&&Array.isArray(r.owners);
const validTask=t=>record(t)&&typeof t.id==='string'&&Boolean(t.id)&&typeof t.title==='string'&&typeof t.kind==='string';
const validQueue=r=>Array.isArray(r.items)&&r.items.length<=LIMIT&&r.items.every(validTask)&&Number.isSafeInteger(r.total)&&r.total>=r.items.length&&(r.total===r.items.length||r.items.length===LIMIT);
function frame(scope,...body){
  const id='fh-title-'+S.generation;
  return h('section',{class:'egc-followups-home','aria-labelledby':id},
    h('header',{class:'fh-head'},h('div',{class:'fh-heading'},h('span',{class:'fh-eyebrow'},'FOLLOW-UPS'),h('h2',{id},'Overdue follow-ups'),scope?h('p',{class:'fh-scope'},scope):null)),...body);
}
function show(node){if(!S.host)return;S.root?.remove();S.root=node;S.host.replaceChildren(node);}
function loading(){return frame('',h('div',{class:'fh-loading','aria-busy':'true'},h('p',{class:'hub-sr-only',role:'status'},'Checking overdue follow-ups…'),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton fh-short'})));}
function failure(error){
  const code=String(error?.code||''),text=failures[code]||(error?.status===401||code==='HUB_AUTH_REQUIRED'?'Your sign-in expired. Sign in again to see overdue follow-ups.':UNAVAILABLE);
  return frame('',h('div',{class:'hub-notice error fh-state',role:'alert'},h('strong',{},'Overdue follow-ups are unavailable'),h('p',{},text),h('div',{class:'fh-actions'},button('Retry',()=>void load()))));
}
function disabled(){return frame('',h('div',{class:'hub-notice warning fh-state',role:'status'},h('strong',{},'Follow-up tracking is not enabled'),h('p',{},'The Action Center backend is switched off, so overdue follow-ups cannot be checked. This is not an empty list.')));}
function openQueue(){window.EGCActionCenter?.show?.('overdue');const go=typeof S.ctx.go==='function'?S.ctx.go:window.opsGo;if(typeof go==='function')go('action_center');else location.assign('/employee?view=action_center');}
function list(result,who,team,at){
  const names=new Map(who.owners.filter(record).map(owner=>[String(owner.id),String(owner.name||owner.id)])),total=result.total;
  const owner=id=>id?names.get(String(id))||String(id):'Unassigned';
  const count=h('p',{class:'fh-count'},h('b',{'data-fh-count':''},String(total)),' ',h('span',{},total===1?'overdue action':'overdue actions'));
  const body=[count];
  if(total){
    const items=h('ol',{class:'fh-list'});
    for(const task of result.items)items.append(h('li',{class:'fh-item','data-fh-task':task.id},h('strong',{class:'fh-title'},task.title),h('span',{class:'fh-meta'},owner(task.assignedUserId)+' · '+kindLabel(task.kind)),h('span',{class:'fh-late'},late(task,at))));
    body.push(items);
    if(total>result.items.length)body.push(h('p',{class:'fh-more'},'Showing the '+result.items.length+' most overdue of '+total+'.'));
  }else body.push(h('p',{class:'fh-empty'},team?'No registered action is overdue.':'None of your registered actions is overdue.'),h('p',{class:'fh-note'},'Commitments nobody recorded as an action are not counted.'));
  const updated=clockTime(result.asOf)||clockTime(at);
  body.push(h('div',{class:'fh-actions'},button('Open follow-ups',openQueue,'primary')),updated?h('p',{class:'fh-note'},'Updated '+updated+' · Denver time'):null);
  return frame(team?'Everyone on the team · registered actions':'Assigned to you · registered actions',...body);
}
async function load(){
  if(!S.host)return;
  const generation=++S.generation;S.controller?.abort();const controller=S.controller=new AbortController();
  show(loading());
  try{
    const who=await request(controller,'GET');
    if(generation!==S.generation)return;
    if(!validIdentity(who))throw Object.assign(new Error('operations_unverified'),{code:'operations_unverified'});
    if(!who.enabled){show(disabled());return;}
    // Managers see the whole team on the Command center; My day, and everyone else, sees only their own actions.
    const team=S.ctx.home!=='my_day'&&['owner','manager'].includes(who.actor.role),at=now();
    const body={command:'queue',view:'overdue',dueBefore:at.toISOString(),offset:0,limit:LIMIT,...(team?{}:{owner:who.actor.id})};
    const result=await request(controller,'POST',{requestId:crypto.randomUUID(),body});
    if(generation!==S.generation)return;
    if(!validQueue(result))throw Object.assign(new Error('operations_unverified'),{code:'operations_unverified'});
    show(list(result,who,team,at));
  }catch(error){
    if(generation!==S.generation||controller.signal.aborted&&error?.code!=='operations_timeout')return;
    // The Hub can report enabled while the backend behind it is switched off; that is the truthful off state, not an outage to retry.
    show(error?.code==='operations_not_enabled'?disabled():failure(error));
  }
}
function mount(host,ctx={}){
  if(!host)return;
  if(S.host===host&&S.root?.isConnected)return;
  unmount();
  S.host=host;S.ctx=record(ctx)?ctx:{};
  return load();
}
function unmount(){S.generation++;S.controller?.abort();S.controller=null;S.root?.remove();S.root=null;S.host=null;S.ctx={};}
function refresh(){return S.host?load():undefined;}
window.addEventListener('egc:signout',()=>unmount());
window.EGCFollowupsHome={mount,unmount,refresh};
})();
