/* P3-04 owner setting: who owns walkthrough and call follow-ups and when they are due.
   A registered Hub screen (employee-hub-screens.js); the kit (window.EGCHubKit) loads first. */
(function(){
'use strict';
const API='/api/operations-followup-settings',SCREEN='followup_settings',TZ='America/Denver';
const S={host:null,root:null,ctx:null,data:null,draft:null,busy:false,error:null,conflict:false,notice:'',generation:0,controller:null};
const REASONS={
  followup_owner_unresolved:'No follow-up owner is set. Choose one below.',
  followup_owner_unknown:'The chosen owner is not an assignable Hub member. Choose an active person below.',
  followup_owner_inactive:'The chosen owner’s account is not active. Choose someone else below.',
  followup_owner_ineligible:'The chosen owner does not have the owner, manager, sales or phone role.',
  followup_owner_staff_disabled:'The chosen owner holds the sales or phone role, but staff owners are off. Set EGC_OPERATIONS_STAFF_MEMBERS to true in Cloudflare, or choose a business user below.',
  followup_owner_ambiguous:'More than one person matches the fallback role. Choose an owner below.',
  followup_role_invalid:'The Cloudflare fallback role must be owner, manager, sales or phone.',
  followup_due_rule_invalid:'The saved due time is out of range. Save a due time again.',
  followup_send_window_invalid:'The saved contact window is invalid. Save the window again.',
  followup_settings_invalid:'The saved settings are malformed. Save them again.',
  followup_settings_unavailable:'The saved settings could not be read.'};
const ROLE={owner:'Owner',manager:'Manager',sales:'Sales',phone:'Phone'};
// Owner reasons mean nobody owns follow-ups; the rest block a resolved owner's policy.
const heading=reason=>/^followup_(owner|role)_/.test(String(reason||''))?'Follow-ups have no owner yet':'Follow-up policy is blocked';
const kit=()=>window.EGCHubKit;
const hour=value=>value===12?'12 PM':value===24||value===0?'12 AM':value>12?(value-12)+' PM':value+' AM';
function duration(minutes){if(!Number.isInteger(minutes)||minutes<=0)return'';const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),mins=minutes%60,part=(n,word)=>n?n+' '+word+(n===1?'':'s'):'';return[part(days,'day'),part(hours,'hour'),part(mins,'minute')].filter(Boolean).join(' ');}
function when(value){const time=Date.parse(value||'');return Number.isFinite(time)?new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(time)):'';}
// Anything but the documented shape is unverified, never an empty or default state.
function valid(data){const f=data&&data.followup,l=data&&data.limits;return Boolean(data&&data.authority==='employee_hub'&&typeof data.revision==='string'&&typeof data.canEdit==='boolean'&&typeof data.policyEnabled==='boolean'&&Array.isArray(data.candidates)&&data.candidates.every(c=>c&&typeof c.id==='string'&&c.id&&typeof c.name==='string')&&f&&typeof f.enabled==='boolean'&&(f.blockedReason===null||typeof f.blockedReason==='string')&&l&&l.dueMinutes&&Number.isInteger(l.dueMinutes.min)&&Number.isInteger(l.dueMinutes.max)&&Number.isInteger(l.dueMinutes.default)&&l.sendWindow&&Number.isInteger(l.sendWindow.earliest)&&Number.isInteger(l.sendWindow.latest)&&data.coverage&&data.coverage.complete===true&&(data.settings===null||typeof data.settings==='object'));}
function fromData(data){const s=data.settings||{},w=s.sendWindow||data.followup.sendWindow||{};return{ownerId:typeof s.ownerId==='string'?s.ownerId:'',dueMinutes:String(Number.isInteger(s.dueMinutes)?s.dueMinutes:data.limits.dueMinutes.default),startHour:String(Number.isInteger(w.startHour)?w.startHour:8),endHour:String(Number.isInteger(w.endHour)?w.endHour:19),reason:''};}
const same=(a,b)=>a&&b&&a.ownerId===b.ownerId&&a.dueMinutes===b.dueMinutes&&a.startHour===b.startHour&&a.endHour===b.endHour;
const dirty=()=>Boolean(S.data&&S.draft&&(!same(S.draft,fromData(S.data))||S.draft.reason.trim()));
const pending=()=>kit().pending(SCREEN,S.ctx&&typeof S.ctx.identity==='string'&&S.ctx.identity?S.ctx.identity:undefined);
// Save and Reset need a change.
function sync(){if(!S.root)return;const locked=!S.data||!S.data.canEdit||S.busy||Boolean(pending().get()),submit=S.root.querySelector('.fu-actions button[type=submit]'),reset=S.root.querySelector('.fu-actions button[data-fu-reset]');if(submit)submit.disabled=locked||!dirty();if(reset)reset.disabled=S.busy||!dirty();}
function nameOf(id){const c=S.data&&S.data.candidates.find(x=>x.id===id);return c?c.name:id;}

function status(){
  const {h}=kit(),d=S.data,f=d.followup,items=[];
  if(!d.policyEnabled)items.push(h('div',{class:'hub-notice'},h('strong',{},'Policy is off'),h('p',{},'Saved settings apply once EGC_OPERATIONS_FOLLOWUP_POLICY_ENABLED is true in Cloudflare. Until then no follow-up is assigned from this policy.')));
  if(f.enabled)items.push(h('div',{class:'hub-notice success','data-fu-state':'enabled'},h('strong',{},nameOf(f.ownerId)+' owns follow-ups'),h('p',{},(ROLE[f.ownerRole]||f.ownerRole||'')+' · '+(f.ownerSource==='settings'?'from these Hub settings':'from the Cloudflare fallback')),h('p',{},'Due '+duration(f.dueMinutes)+' after the walkthrough or call, moved into '+hour(f.sendWindow.startHour)+'–'+hour(f.sendWindow.endHour)+' Denver time.')));
  else items.push(h('div',{class:'hub-notice warning','data-fu-state':'blocked',role:'status'},h('strong',{},heading(f.blockedReason)),h('p',{},REASONS[f.blockedReason]||'The follow-up policy is blocked. Review the settings below.')));
  if(d.staffMembers===false)items.push(h('p',{class:'fu-note'},'Sales and phone staff with employee accounts appear as owners once EGC_OPERATIONS_STAFF_MEMBERS is true.'));
  const fallback=d.fallback||{};items.push(h('p',{class:'fu-note'},'Cloudflare fallback: '+(fallback.ownerId?fallback.ownerId:fallback.role?'the only '+fallback.role+' member':'none')+'.'));
  if(d.settings&&d.settings.updatedAt)items.push(h('p',{class:'fu-note'},'Last changed by '+(d.settings.updatedBy||'the owner')+' · '+when(d.settings.updatedAt)));
  return h('section',{class:'fu-status','aria-label':'Current follow-up policy'},items);
}

function form(){
  const {h,field,button}=kit(),d=S.data,draft=S.draft,locked=!d.canEdit||S.busy||Boolean(pending().get());
  const owners=[{value:'',label:'Cloudflare fallback'},...d.candidates.map(c=>({value:c.id,label:c.name+' · '+(ROLE[c.role]||c.role)}))];
  if(draft.ownerId&&!d.candidates.some(c=>c.id===draft.ownerId))owners.push({value:draft.ownerId,label:draft.ownerId+' (not assignable)'});
  const hours=(from,to)=>Array.from({length:to-from+1},(_,i)=>({value:String(from+i),label:hour(from+i)}));
  const owner=field({label:'Follow-up owner',name:'ownerId',type:'select',value:draft.ownerId,options:owners,help:'The person who calls or texts back after every walkthrough and call.'});
  const due=field({label:'Due within (minutes)',name:'dueMinutes',type:'number',value:draft.dueMinutes,min:d.limits.dueMinutes.min,max:d.limits.dueMinutes.max,step:1,inputmode:'numeric',help:duration(Number(draft.dueMinutes))?'= '+duration(Number(draft.dueMinutes)):'Between '+d.limits.dueMinutes.min+' minutes and '+duration(d.limits.dueMinutes.max)+'.'});
  const start=field({label:'Contact from',name:'startHour',type:'select',value:draft.startHour,options:hours(d.limits.sendWindow.earliest,d.limits.sendWindow.latest-1)});
  const end=field({label:'Contact until',name:'endHour',type:'select',value:draft.endHour,options:hours(d.limits.sendWindow.earliest+1,d.limits.sendWindow.latest)});
  const reason=field({label:'Reason (optional, kept in the audit log)',name:'reason',type:'textarea',value:draft.reason,maxlength:500,rows:2});
  const root=h('form',{class:'hub-card fu-form','aria-label':'Follow-up settings',onsubmit:event=>{event.preventDefault();void save();}},
    owner,due,h('div',{class:'fu-window'},start,end),h('p',{class:'fu-note'},'Denver time. Due times that land outside this window move to its next opening. Federal quiet hours limit it to 8 AM–9 PM.'),reason,
    h('div',{class:'fu-actions'},button(S.busy?'Saving…':'Save follow-up settings',null,'primary',{type:'submit','aria-busy':S.busy?'true':null}),button('Reset',()=>{S.draft=fromData(S.data);S.error=null;render();},'',{'data-fu-reset':''})));
  for(const control of root.querySelectorAll('input,select,textarea')){control.disabled=locked;control.addEventListener('input',event=>{S.draft={...S.draft,[event.target.name]:event.target.value};if(event.target.name==='dueMinutes'){const help=due.querySelector('small');if(help)help.textContent=duration(Number(event.target.value))?'= '+duration(Number(event.target.value)):'Between '+d.limits.dueMinutes.min+' minutes and '+duration(d.limits.dueMinutes.max)+'.';}sync();});}
  if(!d.canEdit)root.prepend(h('p',{class:'fu-note'},'Only the owner can change these settings.'));
  return root;
}

function alerts(){
  const {h,button,errorText}=kit(),items=[],saved=pending().get();
  if(saved)items.push(h('div',{class:'hub-notice warning',role:'alert','data-fu-pending':''},h('strong',{},'A save is waiting to be confirmed'),h('p',{},'Retry it exactly as sent so it applies once; do not start another change.'),h('div',{class:'hub-actions'},button('Retry original save',()=>void replay(),'primary',{disabled:S.busy}),button('Discard saved request',()=>{pending().discard();S.error=null;render();},'',{disabled:S.busy}))));
  else if(S.conflict)items.push(h('div',{class:'hub-notice error',role:'alert','data-fu-conflict':''},h('strong',{},'These settings changed while you were editing'),h('p',{},'Your draft is kept on screen. Load the latest settings, then apply your change again.'),h('div',{class:'hub-actions'},button('Discard draft and load latest',()=>{S.conflict=false;S.error=null;void load(true);},'primary'))));
  else if(S.error)items.push(h('div',{class:'hub-notice error',role:'alert'},errorText(S.error,{followup_settings_owner_ineligible:'That person cannot own follow-ups. Choose an active owner, manager, sales or phone member.',followup_settings_owner_staff_disabled:'That person holds the sales or phone role, but staff owners are off. Set EGC_OPERATIONS_STAFF_MEMBERS to true in Cloudflare first.'})));
  if(S.notice)items.push(h('div',{class:'hub-notice success',role:'status'},S.notice));
  return items;
}

function render(){
  if(!S.root)return;
  const {h,button}=kit(),body=S.root.querySelector('[data-fu-body]');
  if(!S.data){body.replaceChildren(S.error?h('div',{class:'hub-notice error',role:'alert'},h('strong',{},'Follow-up settings are unavailable'),h('p',{},'Nothing here is shown as current until it loads. '+kit().errorText(S.error)),h('div',{class:'hub-actions'},button('Retry',()=>void load(),'primary'))):h('div',{class:'hub-screen-loading','aria-busy':'true'},h('p',{class:'hub-sr-only',role:'status'},'Loading follow-up settings…'),h('span',{class:'hub-skeleton'}),h('span',{class:'hub-skeleton wide'})));return;}
  const focused=document.activeElement&&S.root.contains(document.activeElement)?document.activeElement.name:'';
  body.replaceChildren(...alerts(),status(),form());
  sync();
  if(focused){const again=body.querySelector('[name="'+focused+'"]');if(again&&!again.disabled)again.focus();}
}

async function load(discard=false){
  const generation=++S.generation;S.controller?.abort();S.controller=new AbortController();
  if(discard||!S.data){S.data=null;S.draft=null;}S.error=null;S.notice='';render();
  try{
    const data=await kit().requestJSON(API,{prefix:'followup_settings',signal:S.controller.signal,validate:valid});
    if(generation!==S.generation||!S.root)return;
    const keep=S.data&&dirty()?S.draft:null;S.data=data;S.draft=keep||fromData(data);
  }catch(error){if(generation!==S.generation||!S.root||error.aborted)return;S.error=error;}
  render();
}

function applied(data){if(!valid(data))throw Object.assign(new Error('The save could not be verified. Retry the original save.'),{code:'followup_settings_unverified',status:503});S.data=data;S.draft=fromData(data);S.conflict=false;S.error=null;S.notice=data.unchanged?'Nothing changed.':'Follow-up settings saved.';S.ctx?.toast?.(S.notice);}
async function run(send){
  if(S.busy)return;S.busy=true;S.notice='';S.error=null;render();const generation=S.generation;
  try{const data=await send();if(generation===S.generation&&S.root)applied(data);}
  catch(error){if(generation!==S.generation||!S.root)return;S.error=error;S.conflict=/_revision_conflict$/.test(String(error.code||''));}
  finally{S.busy=false;render();}
}
function save(){
  const d=S.draft,due=Number(d.dueMinutes),start=Number(d.startHour),end=Number(d.endHour);
  if(!Number.isInteger(due)||due<S.data.limits.dueMinutes.min||due>S.data.limits.dueMinutes.max){S.error={message:'Choose a due time between '+S.data.limits.dueMinutes.min+' minutes and '+duration(S.data.limits.dueMinutes.max)+', in whole minutes.'};render();return;}
  if(!(start<end)){S.error={message:'The contact window must start before it ends.'};render();return;}
  const body={expectedRevision:S.data.revision,ownerId:d.ownerId||null,dueMinutes:due,sendWindow:{startHour:start,endHour:end},...(d.reason.trim()?{reason:d.reason.trim()}:{})};
  return run(()=>pending().submit(API,body,{prefix:'followup_settings'}));
}
const replay=()=>run(()=>pending().replay({prefix:'followup_settings'}));

function mount(host,ctx={}){
  if(!host)return;unmount();
  const {h}=kit();S.host=host;S.ctx=ctx;
  S.root=h('section',{class:'hub-screen egc-followups'},
    h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'Follow-ups'),h('h1',{},'Follow-up owner'),h('p',{},'Every walkthrough and call follow-up gets a named owner and a due time. Nothing here contacts a customer.'))),
    h('div',{'data-fu-body':''}));
  host.append(S.root);
  return load();
}
function unmount(){S.generation++;S.controller?.abort();S.controller=null;S.root?.remove();Object.assign(S,{host:null,root:null,ctx:null,data:null,draft:null,busy:false,error:null,conflict:false,notice:''});}
const canLeave=()=>!S.busy&&!dirty();
const refresh=()=>S.root&&!dirty()&&!S.busy?load():undefined;
window.addEventListener('egc:signout',unmount);
window.EGCFollowupSettings=Object.freeze({mount,unmount,canLeave,refresh});
})();
