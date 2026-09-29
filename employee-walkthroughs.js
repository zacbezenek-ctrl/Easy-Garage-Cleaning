/* Hub Walkthroughs (WT-OUTCOME). Every walkthrough the office must act on, from the dispatch board (/api/dispatch):
   the rep, the Mountain 12-hour time and arrival window, a tel: link, and where it stands (walkthrough-state.js on the
   server). Overdue visits with no outcome ask for one, a no-show is rebooked by moving the same visit, and past rows
   drop off after two weeks. Book, Reschedule, Rebook and Cancel open the dispatch dialogs (EGCDispatch.openFor), so
   the same save, retry and conflict rules apply. Each card shows its HighLevel appointment sync; inside the Hub its
   Retry is the suite's own (opsRetrySync), which re-sends the saved Hub visit when someone taps it. Nothing here
   messages a customer on its own. */
(function(){
'use strict';
const TZ='America/Denver',PAST_DAYS=14,AHEAD_DAYS=60;
const S={host:null,root:null,data:null,error:'',status:0,loading:false,generation:0,controller:null,notice:'',warn:'',busy:false,retrying:''};
// Why EGCDispatch.openFor did not open its dialog.
const REFUSED={busy:'Another scheduling form is open or still saving. Finish it, then retry.',recovery_invalid:'A saved dispatch request in this browser could not be read, so scheduling is paused here. Reopen this browser session before making another dispatch change.',unavailable:'The scheduling form could not open. Retry.'};
// The visit's HighLevel appointment sync (dispatch DTO syncStatus), as the Hub's schedule shows it.
const SYNC={synced:['HighLevel synced','ok'],syncing:['Syncing to HighLevel',''],pending:['HighLevel sync pending','warn'],error:['HighLevel sync failed','warn']};
function h(tag,props,...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(props||{})){
    if(value==null||value===false)continue;
    if(key==='class')node.className=value;else if(key==='text')node.textContent=value;
    else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);
    else node.setAttribute(key,String(value));
  }
  for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
const btn=(label,onClick,kind='',props={})=>h('button',{type:'button',class:('hub-btn '+kind).trim(),onclick:onClick,...props},label);
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const addDays=(date,count)=>new Date(Date.parse(date+'T12:00:00Z')+count*86400000).toISOString().slice(0,10);
const dateText=date=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z'));
function clock(value){const match=/^(\d{2}):(\d{2})$/.exec(value||'');if(!match)return '';const hour=Number(match[1]);return (hour%12||12)+':'+match[2]+' '+(hour<12?'AM':'PM');}
const state=job=>job.walkthroughState||(['cancelled','canceled'].includes(job.status)?'cancelled':'open');
const rep=job=>{const ids=Array.isArray(job.assignedCrew)?job.assignedCrew:[];return ids.map(id=>S.data?.roster?.find(person=>person.id===id)?.name||id).join(', ');};
// Overdue: the visit's end (or its whole day) has passed and nobody recorded an outcome.
function overdue(job){
  if(state(job)!=='open'||!job.date)return false;
  const end=Date.parse(job.endAt||'');
  return Number.isFinite(end)?end<Date.now():job.date<today();
}
function arrival(job){
  if(clock(job.arrivalWindowStart)&&clock(job.arrivalWindowEnd))return clock(job.arrivalWindowStart)+' – '+clock(job.arrivalWindowEnd);
  return typeof job.arrivalWindow==='string'?job.arrivalWindow:'';
}
function notice(text,kind=''){return h('div',{class:'wt-notice '+kind,role:kind==='error'?'alert':'status'},text);}
async function load({quiet=false}={}){
  if(!S.root)return;
  const generation=++S.generation;S.controller?.abort();S.controller=new AbortController();
  if(!quiet){S.loading=true;render();}
  try{
    const start=addDays(today(),-PAST_DAYS),params=new URLSearchParams({startDate:start,endDate:addDays(today(),AHEAD_DAYS+1),includeUnscheduled:'true'});
    const response=await fetch('/api/dispatch?'+params,{credentials:'same-origin',cache:'no-store',signal:S.controller.signal}),data=await response.json().catch(()=>({}));
    if(generation!==S.generation||!S.root)return;
    if(!response.ok||data.ok!==true)throw Object.assign(new Error(data.error||'Walkthroughs could not be verified. Retry.'),{status:response.ok?503:response.status});
    if(!data.viewer?.id||!Array.isArray(data.jobs)||!Array.isArray(data.roster)||typeof data.coverage?.complete!=='boolean'||data.jobs.some(job=>!job||typeof job.id!=='string'))throw Object.assign(new Error('The walkthrough list was incomplete. Retry before calling anyone.'),{status:503});
    S.data=data;S.error='';S.status=0;
  }catch(error){if(error.name==='AbortError'||generation!==S.generation||!S.root)return;S.error=error.message||'Walkthroughs could not be loaded.';S.status=error.status||503;}
  finally{if(generation===S.generation&&S.root){S.loading=false;render();}}
}
// Book, Reschedule, Rebook and Cancel reuse the dispatch dialogs; the list reloads when the dialog closes.
async function open(job,action,kind){
  if(S.busy)return;
  if(!window.EGCDispatch?.openFor){S.warn='Scheduling is not loaded on this page. Open Dispatch to change this walkthrough.';render();return;}
  S.busy=true;S.warn='';render();
  try{
    const result=await window.EGCDispatch.openFor(job,action,{kind,onClose:({saved})=>{S.busy=false;if(saved)S.notice=saved;if(S.root){render();void load({quiet:true});}}});
    if(!result?.opened){S.busy=false;S.warn=REFUSED[result?.reason]||REFUSED.unavailable;render();}
  }catch(error){S.busy=false;S.warn=(error.status===401?'Your sign-in expired. Sign in again, then retry.':error.message)||REFUSED.unavailable;render();}
}
// Inside the Hub, the suite's retry re-sends the saved visit to HighLevel (the same as Team schedule's Retry syncs).
async function retrySync(job){
  if(S.retrying||typeof window.opsRetrySync!=='function')return;
  S.retrying=job.id;render();
  try{await window.opsRetrySync(job.id);}catch{S.warn='The HighLevel retry did not go through. The visit is still saved in the Hub; retry again.';}
  finally{S.retrying='';if(S.root){render();void load({quiet:true});}}
}
function syncLine(job){
  const [text,kind]=SYNC[job.syncStatus]||[];if(!text)return null;
  // A booker (viewer.booker: schedule.book without dispatch.write, SALES-BOOKING) sees the sync but never its Retry.
  const retry=['pending','error'].includes(job.syncStatus)&&typeof window.opsRetrySync==='function'&&S.data?.viewer?.booker!==true;
  return h('div',{class:'wt-sync','data-sync':job.syncStatus},h('span',{class:'wt-sync-state '+kind},text),
    retry?btn(S.retrying===job.id?'Retrying…':'Retry',()=>retrySync(job),'',{disabled:Boolean(S.retrying),'aria-label':'Retry the HighLevel sync for '+(job.customer||'this walkthrough')}):null);
}
function card(job,group){
  const current=state(job),late=group==='attention'&&overdue(job),phone=String(job.phone||'').replace(/[^+0-9]/g,''),arrives=arrival(job),who=rep(job);
  const walkthrough='/crew/gameplan.html?walkthroughId='+encodeURIComponent(job.id);
  const badge=late?'Overdue: record outcome':job.walkthroughBadge||'';
  const primary=current==='sold'&&job.convertedJobId?h('a',{class:'hub-btn primary',href:'/crew/job.html?jobId='+encodeURIComponent(job.convertedJobId)},'Open job')
    :current==='open'?h('a',{class:'hub-btn primary',href:walkthrough},late?'Record outcome':'Start walkthrough')
    :h('a',{class:'hub-btn',href:walkthrough},'Open walkthrough');
  const actions=h('div',{class:'wt-card-actions'},primary,phone?h('a',{class:'hub-btn',href:'tel:'+phone,'aria-label':'Call '+(job.customer||'the customer')},'Call customer'):null);
  const rebook=['no_show','rescheduled'].includes(current);
  if(current==='open'||rebook)actions.append(btn(rebook?'Rebook':job.date?'Reschedule':'Schedule',()=>open(job,rebook?'rebook':'edit'),rebook?'dark':'',{disabled:S.busy,'aria-label':(rebook?'Rebook ':'Reschedule ')+(job.customer||'this walkthrough')}),
    btn('Cancel',()=>open(job,'schedule.cancel'),'danger',{disabled:S.busy,'aria-label':'Cancel the walkthrough for '+(job.customer||'this customer')}));
  return h('article',{class:'wt-card','data-walkthrough':job.id,'data-state':late?'overdue':current},
    h('div',{class:'wt-when'},h('strong',{},job.date?dateText(job.date):'Needs a time'),job.date?h('span',{class:'wt-time'},clock(job.time)&&clock(job.endTime)?clock(job.time)+' – '+clock(job.endTime):clock(job.time)||'Time needed'):null,
      arrives?h('small',{},'Arrival '+arrives):null),
    h('div',{class:'wt-body'},h('h3',{},job.customer||'Walkthrough'),h('p',{class:'wt-rep'},who?'Rep: '+who:'Rep not assigned'),
      job.address?h('a',{class:'wt-address',href:'https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(job.address),target:'_blank',rel:'noopener'},job.address):h('p',{class:'wt-missing'},'Address needed'),
      badge?h('p',{class:'wt-badge','data-badge':late?'overdue':current},badge):null,syncLine(job)),
    actions);
}
function section(title,rows,group,empty){
  return h('section',{class:'wt-group','data-group':group,'aria-label':title},h('h2',{},title+' · '+rows.length),rows.length?h('div',{class:'wt-list'},rows.map(job=>card(job,group))):h('p',{class:'wt-empty'},empty));
}
function render(){
  if(!S.root)return;
  const head=h('header',{class:'hub-head wt-head'},h('div',{},h('span',{class:'hub-eyebrow'},'SELL THE DIAGNOSIS'),h('h1',{},'Walkthroughs'),h('p',{},'Every walkthrough the office acts on: who is going, when, and what happened. Mountain Time.')),
    h('div',{class:'hub-actions wt-actions'},btn('Book walkthrough',()=>open(null,'create','walkthrough'),'primary',{disabled:S.busy||!S.data}),h('a',{class:'hub-btn',href:'/crew/gameplan.html'},'Start manual walkthrough')));
  const body=h('div',{class:'wt-body-wrap','aria-busy':S.loading?'true':'false'});
  S.root.replaceChildren(head,body);
  if(!S.data&&!S.error){body.append(h('p',{class:'hub-sr-only',role:'status'},'Loading walkthroughs…'),...[0,1,2].map(()=>h('div',{class:'wt-skeleton'})));return;}
  if(S.error){body.append(notice(S.error,'error'),S.status===401?h('a',{class:'hub-btn',href:'/employee.html?view=walkthroughs'},'Sign in again'):btn('Retry',()=>load()));if(!S.data)return;}
  if(S.warn)body.append(notice(S.warn,'error'));
  if(S.notice)body.append(notice(S.notice));
  if(S.data.coverage?.complete===false)body.append(notice('Some records could not be loaded. This list is incomplete; check Dispatch before calling customers.','error'));
  const date=today(),walks=S.data.jobs.filter(job=>job.type==='walkthrough'&&state(job)!=='cancelled');
  const order=(a,b)=>String(a.date||'9999').localeCompare(String(b.date||'9999'))||String(a.time||'').localeCompare(String(b.time||''))||String(a.customer||'').localeCompare(String(b.customer||''));
  const attention=walks.filter(job=>overdue(job)||['no_show','rescheduled'].includes(state(job))).sort(order);
  const upcoming=walks.filter(job=>state(job)==='open'&&job.date&&!overdue(job)).sort(order);
  const unscheduled=walks.filter(job=>state(job)==='open'&&!job.date);
  const outcomes=walks.filter(job=>job.walkthroughClosed===true&&(!job.date||job.date>=addDays(date,-PAST_DAYS))).sort((a,b)=>order(b,a));
  body.append(section('Needs an outcome or a rebook',attention,'attention','Nothing overdue. Every past walkthrough has an outcome.'),
    section('Upcoming',upcoming,'upcoming','No walkthroughs booked. Book one when a customer calls.'),
    ...(unscheduled.length?[section('Needs a time',unscheduled,'unscheduled','')]:[]),
    section('Recent outcomes',outcomes,'outcomes','No outcomes in the last two weeks.'),
    h('p',{class:'wt-foot'},'Mountain Time. '+(S.data.coverage?.asOf?'Updated '+new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'numeric',minute:'2-digit'}).format(new Date(S.data.coverage.asOf))+'. ':'')+'Past walkthroughs leave this list after two weeks; Search all jobs in Dispatch finds older ones.'));
}
function mount(host){
  if(!host)return;if(S.host===host&&S.root?.isConnected)return;
  unmount();S.host=host;S.root=h('section',{class:'hub-screen egc-walkthroughs'});host.replaceChildren(S.root);render();void load();
}
function unmount(){S.controller?.abort();S.generation++;S.root?.remove();S.root=null;S.host=null;S.data=null;S.error='';S.notice='';S.warn='';S.busy=false;S.retrying='';S.loading=false;}
window.addEventListener('egc:signout',unmount);
window.EGCWalkthroughs={mount,unmount,refresh:()=>load({quiet:true}),canLeave:()=>!window.EGCDispatch||window.EGCDispatch.canLeave()};
})();
