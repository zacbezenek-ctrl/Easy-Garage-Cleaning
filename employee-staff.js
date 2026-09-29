/* Staff directory (TEAM-UI): roles, skills, effective-dated pay, weekly availability and (owner only, GUSTO-EXPORT) the Gusto
   employee ID that keys the payroll week's Gusto hours file, with the not-paid-through-Gusto mark, over /api/staff-directory.
   The owner also sees former staff (no Hub access; a stored profile or a rejected account), for those two Gusto fields only.
   The Team page mounts it into #ops-staff-directory and the Hub screen registry mounts it as the 'staff' screen.
   The server decides every permission; the buttons shown here follow the capabilities it returns. */
(function(){
'use strict';
if(window.EGCStaff)return;
const API='/api/staff-directory',PENDING='egc.hub.pending.v1.staff.',TIMEOUT=30000,TZ='America/Denver';
const ROLES=['owner','manager','crew_lead','crew','sales','phone'],EDITABLE_ROLES=ROLES.slice(1),DAYS=['mon','tue','wed','thu','fri','sat','sun'],LEVELS=['trainee','proficient','lead'],PAY_TYPES=['hourly','salary'];
const ROLE_LABEL={owner:'Owner',manager:'Manager',crew_lead:'Crew lead',crew:'Crew',sales:'Sales · walkthroughs',phone:'Phone · calls and follow-ups'};
const DAY_LABEL={mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday',sun:'Sunday'};
const LEVEL_LABEL={trainee:'Trainee',proficient:'Proficient',lead:'Lead'};
const ACTION={roles:'set_roles',skills:'set_skills',pay:'set_pay',availability:'set_availability',gusto:'set_gusto_id'},EDIT_LABEL={roles:'Roles',skills:'Skills',pay:'Pay',availability:'Weekly availability',gusto:'Gusto employee ID'};
const BUTTON_LABEL={roles:'Edit roles',skills:'Edit skills',pay:'Change pay',availability:'Edit availability',gusto:'Set Gusto ID'};
const SAVE_LABEL={roles:'Save roles',skills:'Save skills',pay:'Save pay change',availability:'Save availability',gusto:'Save Gusto ID'};
const GUSTO_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The editor's label mid-sentence: lower case, except the Gusto employee ID keeps its name.
const editText=kind=>kind==='gusto'?EDIT_LABEL.gusto:EDIT_LABEL[kind].toLowerCase();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/,CODE=/^[a-z][a-z0-9_]{1,80}$/;
// 403s this API documents as permanent (no access, the reserved owner role, a cross-site request): retrying cannot succeed.
const PERMANENT_403=/^staff_directory_(?:forbidden|owner_role_reserved|origin_forbidden)$/;
const S={host:null,root:null,ctx:null,viewer:'',embedded:true,formerOpen:false,data:null,loadedAt:NaN,loading:false,error:null,generation:0,loadSeq:0,controller:null,busy:false,pending:null,notice:null,edit:null,draft:null,dirty:false,focus:''};

// The Team page mounts this module before the Hub kit (employee-ui-kit.js) exists: the registry loads the kit only when a
// registered screen opens. So h(), request() and the pending store are local versions of EGCHubKit's h, requestJSON and
// pending. They differ on purpose only in retryable() (permanent 403s are dropped) and errorText() (it knows whether a draft is open).
function h(tag,props,...children){
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(props||{})){
    if(value==null||value===false)continue;
    if(key==='class')node.className=value;
    else if(key==='text')node.textContent=value;
    else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);
    else if(key==='value'&&/^(INPUT|TEXTAREA)$/.test(node.tagName)){node.defaultValue=String(value);node.value=String(value);}
    else if(key==='checked'){node.defaultChecked=true;node.checked=true;}
    else if(key==='selected'){node.setAttribute('selected','');node.selected=true;}
    else if(key in node&&!key.startsWith('aria-')&&key!=='role'&&typeof value!=='object')node[key]=value;
    else node.setAttribute(key,String(value));
  }
  for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(typeof child==='object'?child:document.createTextNode(String(child)));
  return node;
}
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const key=value=>String(value??'').trim().toLowerCase();
const same=(a,b)=>key(a)!==''&&key(a)===key(b);
const failure=(code,message,status,extra={})=>Object.assign(new Error(message),{code,status,...extra});
const retryable=error=>{const status=Number(error?.status||0),code=String(error?.code||'');return error?.retryable===true||/_outcome_unknown$/.test(code)||[0,401,408,429].includes(status)||status===403&&!PERMANENT_403.test(code)||status>=500;};
function uuid(){if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=b[6]&15|64;b[8]=b[8]&63|128;const x=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return x.slice(0,8)+'-'+x.slice(8,12)+'-'+x.slice(12,16)+'-'+x.slice(16,20)+'-'+x.slice(20);}

// Dates are Denver calendar dates from the server ('today'); the device calendar clock is never consulted.
function validDate(date){if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return false;const [y,m,d]=date.split('-').map(Number);return new Date(Date.UTC(y,m-1,d,12)).toISOString().slice(0,10)===date;}
const addDays=(date,count)=>new Date(Date.parse(date+'T12:00:00Z')+count*86400000).toISOString().slice(0,10);
const monotonic=()=>typeof performance!=='undefined'&&typeof performance.now==='function'?performance.now():NaN;
const denverDate=time=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(time)).map(part=>[part.type,part.value]));return`${p.year}-${p.month}-${p.day}`;};
// Today in Denver: the server's asOf plus the monotonic time since that answer, so a tab left open past midnight moves on.
function today(){const at=Date.parse(S.data.coverage.asOf)+(monotonic()-S.loadedAt),day=Number.isFinite(at)?denverDate(at):'';return validDate(day)&&day>S.data.today?day:S.data.today;}
const dateLabel=date=>validDate(date)?new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'}).format(new Date(date+'T12:00:00Z')):'';
const when=value=>{const time=Date.parse(String(value||''));return Number.isFinite(time)?new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(time)):'';};
const clock=value=>{if(value==='24:00')return'midnight';const m=/^(\d\d):(\d\d)$/.exec(String(value||''));if(!m)return'';const hour=Number(m[1]);return`${hour%12||12}:${m[2]} ${hour<12?'AM':'PM'}`;};
const dollars=value=>typeof value==='number'&&Number.isFinite(value)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2}).format(value):'—';
const minutes=value=>value==='24:00'?1440:Number(value.slice(0,2))*60+Number(value.slice(3));
const roleText=roles=>Array.isArray(roles)&&roles.length?roles.map(role=>ROLE_LABEL[role]||role).join(', '):'none';

// Anything but the documented shape is unverified: the screen says unavailable instead of drawing a partial roster.
const validWindow=w=>record(w)&&TIME.test(String(w.start))&&(TIME.test(String(w.end))||w.end==='24:00');
const validWeek=week=>record(week)&&Object.keys(week).every(day=>DAYS.includes(day)&&Array.isArray(week[day])&&week[day].every(validWindow));
const validRate=e=>record(e)&&validDate(e.effectiveFrom)&&typeof e.hourlyRate==='number'&&Number.isFinite(e.hourlyRate)&&typeof e.payType==='string'&&typeof e.overtimeMultiplier==='number';
const validPay=pay=>record(pay)&&record(pay.current)&&(pay.current.hourlyRate===null||typeof pay.current.hourlyRate==='number')&&typeof pay.current.source==='string'&&Array.isArray(pay.schedule)&&pay.schedule.every(validRate)&&Array.isArray(pay.upcoming)&&pay.upcoming.every(validRate)&&typeof pay.needsReview==='boolean';
function validPerson(p){
  return record(p)&&typeof p.username==='string'&&p.username.trim()!==''&&typeof p.displayName==='string'&&['configured','employee_account'].includes(p.source)&&
    Array.isArray(p.staffRoles)&&p.staffRoles.every(role=>ROLES.includes(role))&&Array.isArray(p.skills)&&p.skills.every(s=>record(s)&&typeof s.id==='string'&&LEVELS.includes(s.level))&&
    (p.weeklyAvailability===null||validWeek(p.weeklyAvailability))&&(p.pay===undefined||validPay(p.pay))&&(p.gustoEmployeeId===undefined||p.gustoEmployeeId===null||typeof p.gustoEmployeeId==='string')&&
    (p.gustoExcluded===undefined||typeof p.gustoExcluded==='boolean')&&Array.isArray(p.history)&&typeof p.revision==='string';
}
// Former staff (owner only): their Gusto fields, history and revision, nothing else.
function validFormer(p){
  return record(p)&&p.source==='former'&&typeof p.username==='string'&&p.username.trim()!==''&&typeof p.displayName==='string'&&(p.gustoEmployeeId===null||typeof p.gustoEmployeeId==='string')&&
    typeof p.gustoExcluded==='boolean'&&Array.isArray(p.history)&&typeof p.revision==='string';
}
function validDirectory(d){
  return record(d)&&d.ok===true&&validDate(d.today)&&record(d.viewer)&&typeof d.viewer.user==='string'&&Array.isArray(d.viewer.capabilities)&&d.viewer.capabilities.every(c=>typeof c==='string')&&
    record(d.catalog)&&Array.isArray(d.catalog.skills)&&d.catalog.skills.every(s=>record(s)&&typeof s.id==='string'&&typeof s.label==='string')&&Array.isArray(d.people)&&d.people.every(validPerson)&&
    (d.formerStaff===undefined||Array.isArray(d.formerStaff)&&d.formerStaff.every(validFormer))&&record(d.coverage)&&d.coverage.complete===true;
}

async function request(body,signal){
  const fetcher=typeof S.ctx?.hubFetch==='function'?S.ctx.hubFetch:(url,init)=>fetch(url,{...init,credentials:'same-origin'});
  const controller=new AbortController(),relay=()=>controller.abort();let timedOut=false,response,data=null;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},TIMEOUT);
  signal?.addEventListener?.('abort',relay,{once:true});
  try{
    response=await fetcher(API,{method:body?'POST':'GET',cache:'no-store',credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal});
    data=await response.json().catch(()=>null);
  }catch(error){
    if(signal?.aborted&&!timedOut)throw failure('staff_directory_aborted','The request was cancelled.',0,{aborted:true});
    if(timedOut)throw failure('staff_directory_timeout','The Hub did not answer in time. Your change was kept; retry it before making another change.',503,{retryable:true});
    if(error?.code==='HUB_AUTH_REQUIRED')throw failure('staff_directory_sign_in_required','Sign in again, then retry the saved change.',401,{retryable:true});
    throw failure('staff_directory_network','The Hub could not be reached. Your change was kept; retry it when the connection returns.',503,{retryable:true});
  }finally{clearTimeout(timer);signal?.removeEventListener?.('abort',relay);}
  if(timedOut)throw failure('staff_directory_timeout','The Hub did not answer in time. Your change was kept; retry it before making another change.',503,{retryable:true});
  const status=Number(response?.status)||503;
  if(!record(data))throw failure('staff_directory_unverified','The staff directory response could not be verified. Retry before making changes.',response?.ok?503:status);
  if(!response.ok||data.ok!==true){
    const code=typeof data.code==='string'&&CODE.test(data.code)?data.code:'staff_directory_unavailable';
    throw failure(code,typeof data.error==='string'&&data.error.trim()?data.error.slice(0,300):'The staff directory could not complete this request.',response.ok?503:status,record(data.details)?{details:data.details}:{});
  }
  return data;
}

// One saved change per viewer, kept in sessionStorage before it is sent so a lost answer is retried with the same requestId.
const pendingKey=()=>PENDING+encodeURIComponent(S.viewer||'anonymous');
function readPending(){
  try{const row=JSON.parse(sessionStorage.getItem(pendingKey())||'null');return record(row)&&row.path===API&&row.method==='POST'&&UUID.test(String(row.requestId||''))&&record(row.body)&&row.body.requestId===row.requestId&&typeof row.body.username==='string'&&Object.hasOwn(EDIT_LABEL,row.kind)?row:null;}catch{return null;}
}
function writePending(row){S.pending=row;try{sessionStorage.setItem(pendingKey(),JSON.stringify(row));}catch{}}
function clearPending(){S.pending=null;try{sessionStorage.removeItem(pendingKey());}catch{}}
function clearAllPending(){try{for(let i=sessionStorage.length-1;i>=0;i--){const name=sessionStorage.key(i);if(String(name||'').startsWith(PENDING))sessionStorage.removeItem(name);}}catch{}}

const manager=()=>Array.isArray(S.ctx?.capabilities)&&S.ctx.capabilities.includes('business');
const has=capability=>Boolean(S.data?.viewer?.capabilities?.includes(capability));
const managesStaff=()=>has('time.approve')||has('dispatch.write');
function allowed(kind,person){
  if(person.profileNeedsReview)return false;
  if(person.source==='former')return kind==='gusto'&&has('pay.manage');
  if(kind==='roles')return has('accounts.approve')&&person.source==='employee_account';
  if(kind==='pay')return has('pay.manage')&&person.source==='employee_account'&&person.pay?.current?.source!=='pay_rates_need_review';
  if(kind==='skills')return managesStaff();
  // The server sends gustoEmployeeId (a string or null) to the owner only.
  if(kind==='gusto')return has('pay.manage')&&person.gustoEmployeeId!==undefined;
  return managesStaff()||same(person.username,S.data?.viewer?.user);
}
const personFor=username=>S.data?.people.find(person=>same(person.username,username))||S.data?.formerStaff?.find(person=>same(person.username,username))||null;

// An open editor keeps the revision it was opened at, so a save built on an older record is refused (409) instead of
// overwriting it. Only 'Reload record, keep my draft' (rebase) moves a typed draft onto the latest revision.
async function load({rebase=false}={}){
  if(!S.root||!manager())return;
  const generation=S.generation,seq=++S.loadSeq;
  S.controller?.abort();const controller=S.controller=new AbortController();
  S.loading=true;S.error=null;render();
  try{
    const data=await request(null,controller.signal);
    if(generation!==S.generation||seq!==S.loadSeq)return;
    if(!validDirectory(data))throw failure('staff_directory_unverified','The staff directory response was incomplete, so nothing is shown as current. Retry before making changes.',503);
    if(!same(data.viewer.user,S.viewer))throw failure('staff_directory_account_changed','The Hub is now signed in as a different account than this tab. Sign in again here; nothing is shown or saved until the accounts match.',401);
    S.data=data;S.loadedAt=monotonic();
    const open=S.edit&&personFor(S.edit.username);
    if(S.edit&&!open){S.edit=null;S.draft=null;S.dirty=false;}
    else if(open&&open.revision!==S.edit.revision){
      if(rebase)S.edit.revision=open.revision;
      else if(!S.dirty){S.edit.revision=open.revision;S.draft=draftFor(S.edit.kind,open);}
      else if(!S.busy&&!(S.pending&&S.pending.requestId===S.edit.requestId))S.notice={kind:'error',text:errorText({code:'staff_directory_revision_conflict'},true),conflict:true};
    }
  }catch(error){
    if(generation!==S.generation||seq!==S.loadSeq||error.aborted)return;
    S.data=null;S.error=error;
  }finally{if(generation===S.generation&&seq===S.loadSeq){S.loading=false;S.controller=null;render();}}
}

function draftFor(kind,person){
  if(kind==='roles')return{staffRoles:person.staffRoles.filter(role=>role!=='owner'),reason:''};
  if(kind==='skills')return{levels:Object.fromEntries(person.skills.filter(skill=>!skill.retired).map(skill=>[skill.id,skill.level])),reason:''};
  if(kind==='pay'){const current=person.pay?.current||{};return{effectiveFrom:today(),hourlyRate:'',payType:PAY_TYPES.includes(current.payType)?current.payType:'hourly',overtimeMultiplier:String(typeof current.overtimeMultiplier==='number'?current.overtimeMultiplier:1.5),reason:''};}
  if(kind==='gusto')return{gustoEmployeeId:person.gustoEmployeeId||'',gustoExcluded:person.gustoExcluded===true,reason:''};
  return{week:Object.fromEntries(DAYS.map(day=>[day,(person.weeklyAvailability?.[day]||[]).map(w=>({start:w.start,end:w.end==='24:00'?'00:00':w.end}))])),reason:''};
}
const openerLabel=(kind,person)=>BUTTON_LABEL[kind]+' for '+(person.displayName||person.username);
function openEditor(kind,person){
  if(S.busy)return;
  if(S.dirty&&S.edit&&!(S.edit.kind===kind&&same(S.edit.username,person.username))){S.notice={kind:'error',text:'Save or cancel the open '+editText(S.edit.kind)+' change first.'};render();return;}
  S.edit={kind,username:person.username,revision:person.revision,opener:openerLabel(kind,person),requestId:''};S.draft=draftFor(kind,person);S.dirty=false;S.notice=null;render();
  S.root?.querySelector('.st-editor input,.st-editor select')?.focus?.();
}
// Closing hands focus back to the button that opened the editor.
function closeEditor(){S.focus=S.edit?.opener||'';S.edit=null;S.draft=null;S.dirty=false;render();}
const touch=()=>{S.dirty=true;if(S.draft)S.draft.error='';};

// Client checks mirror the server so a mistake is caught before a request id is spent; the server re-validates everything.
function amount(text,max,pattern){const value=String(text??'').trim().replace(/^\$/,'');if(!pattern.test(value))return null;const cents=Math.round(Number(value)*100);return cents<=max*100?cents/100:null;}
function payload(kind){
  const d=S.draft;
  if(kind==='roles'){const staffRoles=EDITABLE_ROLES.filter(role=>d.staffRoles.includes(role));return staffRoles.length?{fields:{staffRoles}}:{error:'Choose at least one role.'};}
  if(kind==='skills')return{fields:{skills:S.data.catalog.skills.filter(skill=>LEVELS.includes(d.levels[skill.id])).map(skill=>({id:skill.id,level:d.levels[skill.id]}))}};
  if(kind==='pay'){
    const day=today();
    if(!validDate(d.effectiveFrom)||d.effectiveFrom<day||d.effectiveFrom>addDays(day,366))return{error:'Choose an effective date from '+dateLabel(day)+' through '+dateLabel(addDays(day,366))+' (Denver).'};
    const hourlyRate=amount(d.hourlyRate,500,/^\d{1,3}(?:\.\d{1,2})?$/);
    if(hourlyRate===null)return{error:'Enter an hourly rate from $0 to $500, to the cent.'};
    const overtimeMultiplier=amount(d.overtimeMultiplier,3,/^\d(?:\.\d{1,2})?$/);
    if(overtimeMultiplier===null||overtimeMultiplier<1)return{error:'Enter an overtime multiplier from 1 to 3.'};
    if(!PAY_TYPES.includes(d.payType))return{error:'Choose hourly or salary pay.'};
    return{fields:{effectiveFrom:d.effectiveFrom,hourlyRate,payType:d.payType,overtimeMultiplier}};
  }
  if(kind==='gusto'){const value=String(d.gustoEmployeeId||'').trim();return value&&!GUSTO_ID.test(value)?{error:'Enter the Gusto employee ID as Gusto shows it: letters, digits, dots, dashes or underscores, at most 64 characters.'}:{fields:{gustoEmployeeId:value,gustoExcluded:d.gustoExcluded===true}};}
  const weeklyAvailability={};
  for(const day of DAYS){
    const windows=d.week[day].map(w=>({start:w.start,end:w.end==='00:00'&&w.start!=='00:00'?'24:00':w.end}));
    if(windows.length>4)return{error:DAY_LABEL[day]+' can have at most four windows.'};
    if(windows.some(w=>!TIME.test(w.start)||!(TIME.test(w.end)||w.end==='24:00')||minutes(w.end)<=minutes(w.start)))return{error:'Each '+DAY_LABEL[day]+' window needs a start before its end.'};
    windows.sort((a,b)=>a.start.localeCompare(b.start));
    if(windows.some((w,i)=>i&&minutes(w.start)<minutes(windows[i-1].end)))return{error:DAY_LABEL[day]+' windows cannot overlap.'};
    weeklyAvailability[day]=windows;
  }
  return{fields:{weeklyAvailability}};
}

async function save(kind,person){
  if(S.busy||!S.draft||!S.edit||S.edit.kind!==kind||!same(S.edit.username,person.username))return;
  if(S.pending){S.notice={kind:'error',text:'Retry or discard the unconfirmed change before saving another.'};render();return;}
  const built=payload(kind);
  if(built.error){S.draft.error=built.error;render();return;}
  const reason=String(S.draft.reason||'').trim().slice(0,500);
  // expectedUser: the server refuses the change (and this tab keeps it) if the shared session cookie now belongs to someone else.
  const body={action:ACTION[kind],requestId:uuid(),username:person.username,expectedRevision:S.edit.revision,...(S.viewer?{expectedUser:S.viewer}:{}),...built.fields,...(reason?{reason}:{})};
  S.edit.requestId=body.requestId;
  writePending({path:API,method:'POST',requestId:body.requestId,body,kind,label:EDIT_LABEL[kind]+' for '+(person.displayName||person.username)});
  await send(S.pending);
}
const accountChanged=()=>S.error?.code==='staff_directory_account_changed';
async function send(row){
  if(S.busy||!row||!manager()||accountChanged())return;
  const generation=S.generation;
  S.busy=true;S.notice=null;render();
  try{
    const data=await request(row.body);
    if(generation!==S.generation)return;
    const former=record(data.person)&&data.person.source==='former';
    if(!(former?validFormer(data.person):validPerson(data.person))||!same(data.person.username,row.body.username))throw failure('staff_directory_unverified','The saved record could not be verified. Retry the original save to confirm it.',503,{retryable:true});
    clearPending();
    const swap=list=>list.map(person=>same(person.username,data.person.username)?data.person:person);
    if(S.data){if(former)S.data.formerStaff=swap(S.data.formerStaff||[]);else S.data.people=swap(S.data.people);}
    if(S.edit&&S.edit.kind===row.kind&&same(S.edit.username,row.body.username)){S.focus=S.edit.opener;S.edit=null;S.draft=null;S.dirty=false;}
    const text=data.unchanged?'Nothing changed: '+row.label+' already matched.':(data.replayed?'Confirmed: ':'Saved: ')+row.label+(data.sessionsRevoked?'. They were signed out so the new roles apply at their next sign-in.':'.');
    S.notice={kind:'success',text};
    if(typeof S.ctx?.toast==='function')S.ctx.toast(text);
  }catch(error){
    if(generation!==S.generation)return;
    const keep=retryable(error),code=String(error.code||''),conflict=/_revision_conflict$/.test(code);
    if(!keep)clearPending();
    // The conflict actions belong to the editor that built this request; a retry with no such editor (after a page reload) offers a reload.
    const draft=Boolean(S.edit&&S.edit.requestId===row.requestId);
    S.notice={kind:'error',text:errorText(error,draft),conflict:conflict&&draft,reload:/_(idempotency_conflict|changed_since_operation|not_found|profile_ambiguous)$/.test(code)||conflict&&!draft};
  }finally{if(generation===S.generation){S.busy=false;render();}}
}
function errorText(error,draft=false){
  const code=String(error?.code||''),status=Number(error?.status||0);
  if(/_revision_conflict$/.test(code))return draft?'This staff record changed since you opened it. Your draft is kept: reload the record and review it before saving again.'
    :'This staff record changed before the saved change was confirmed, so it was not saved. Reload the staff directory and make the change again if it is still needed.';
  if(/_account_changed$/.test(code))return error.message||'The Hub is signed in as a different account. Sign in as the account that made this change to retry it, or discard it.';
  if(/_idempotency_conflict$|_changed_since_operation$/.test(code))return(error.message||'This change already has a different saved result.')+' Reload before making another change.';
  if(status===401)return'Your sign-in expired. Sign in again, then retry the saved change.';
  if(status===403)return error.message||'Your account cannot make this change.';
  return error?.message||'The staff directory is unavailable. Retry the original save.';
}

// ── rendering ──
const button=(label,onclick,kind='',props={})=>h('button',{type:'button',class:('st-btn '+kind).trim(),onclick,...props,disabled:S.busy||Boolean(props.disabled)},label);
function head(){
  const title=S.embedded?h('h2',{class:'st-title'},'Roles, skills, pay and availability'):h('h1',{class:'st-title'},'Staff directory');
  return h('header',{class:'st-head'},h('div',{},h('span',{class:'st-eyebrow'},'STAFF DIRECTORY'),title,
    h('p',{},'Roles, skills and weekly availability for everyone on the team, with pay history by effective date. Every change is saved to the encrypted Hub profile with an audit entry. Times are Denver time.')),
    manager()?h('div',{class:'st-actions'},button(S.loading?'Checking…':'Refresh',()=>void load(),'',{disabled:S.loading||S.busy,'aria-label':'Refresh the staff directory'})):null);
}
function pendingBanner(){
  if(!S.pending||!manager())return null;
  const changed=accountChanged();
  return h('div',{class:'st-notice warning',role:'status','aria-live':'polite'},h('strong',{},'Unconfirmed change: '+S.pending.label),
    h('p',{},changed?'This change was kept for '+S.viewer+'. Sign in as that account in this tab to retry it, or discard it.':'This change was kept exactly as sent. Retry it to confirm whether it saved; do not make it again.'),
    h('div',{class:'st-actions'},changed?null:button(S.busy?'Retrying…':'Retry original save',()=>void send(S.pending),'primary',{'aria-busy':S.busy?'true':null}),button('Discard saved change',()=>{clearPending();S.notice=null;render();},'quiet')));
}
function noticeBlock(){
  const n=S.notice;if(!n)return null;
  const actions=[];
  if(n.conflict)actions.push(button('Reload record, keep my draft',()=>{S.notice=null;void load({rebase:true});}),button('Discard draft and load latest',()=>{S.focus=S.edit?.opener||'';S.edit=null;S.draft=null;S.dirty=false;S.notice=null;void load();},'quiet'));
  else if(n.reload)actions.push(button('Reload staff directory',()=>{S.notice=null;void load();}));
  return h('div',{class:'st-notice '+(n.kind==='success'?'success':'error'),role:n.kind==='success'?'status':'alert','aria-live':n.kind==='success'?'polite':null},h('p',{},n.text),actions.length?h('div',{class:'st-actions'},actions):null);
}
function unavailable(){
  const error=S.error,off=error?.code==='staff_directory_not_enabled',denied=Number(error?.status)===403,changed=accountChanged();
  const title=off?'The staff directory is turned off':denied?'Staff directory access is limited':changed?'Signed in as another account':'Staff directory unavailable';
  const copy=off?'The owner turns it on with EGC_STAFF_DIRECTORY_ENABLED once the vault migration has been reviewed. Roles, skills, pay and availability stay as they are until then.'
    :denied||changed?(error.message||'Your account cannot open the staff directory.'):(error?.message||'The staff directory could not be loaded.')+' Nothing here is shown as current until it loads.';
  return h('div',{class:'st-notice '+(off?'warning':'error'),role:'alert'},h('strong',{},title),h('p',{},copy),h('div',{class:'st-actions'},button('Retry',()=>void load(),'primary',{disabled:S.loading})));
}
function skeleton(){return h('div',{class:'st-loading','aria-busy':'true'},h('p',{class:'st-sr-only',role:'status'},'Loading the staff directory…'),h('span',{class:'st-skeleton'}),h('span',{class:'st-skeleton'}),h('span',{class:'st-skeleton wide'}));}

function chips(items,empty){return items.length?h('ul',{class:'st-chips'},items):h('p',{class:'st-muted'},empty);}
function rolesSection(person){
  return h('section',{class:'st-section','aria-label':'Roles'},h('h4',{},'Roles'),
    chips(person.staffRoles.map(role=>h('li',{class:'st-chip role-'+role},ROLE_LABEL[role]||role)),'No role recorded'),
    person.staffRolesSource==='default'?h('p',{class:'st-muted'},'From the account role; no staff roles have been saved yet.'):person.source==='configured'?h('p',{class:'st-muted'},'Set in the Hub user configuration.'):null);
}
function skillsSection(person){
  const labels=new Map((S.data.catalog.skills||[]).map(skill=>[skill.id,skill.label]));
  return h('section',{class:'st-section','aria-label':'Skills'},h('h4',{},'Skills'),
    chips(person.skills.map(skill=>h('li',{class:'st-chip skill level-'+skill.level+(skill.retired?' retired':'')},(labels.get(skill.id)||skill.id)+' · '+LEVEL_LABEL[skill.level]+(skill.retired?' (retired)':''))),'No skills recorded yet'));
}
function paySection(person){
  const pay=person.pay;if(!pay)return null;
  const current=pay.current,today=S.data.today;
  const source=current.source==='pay_rates'?'Effective '+dateLabel(current.effectiveFrom):current.source==='legacy_profile_edit'?'Set on the profile form after the dated schedule':'From the profile rate; no dated pay history yet';
  const rows=[...pay.schedule].reverse().map(entry=>{
    const state=entry.effectiveFrom>today?'Scheduled':current.source==='pay_rates'&&entry.effectiveFrom===current.effectiveFrom?'Current':'Earlier';
    return h('li',{class:'st-pay-row '+state.toLowerCase()},h('span',{class:'st-pay-date'},entry.effectiveFrom==='2000-01-01'?'Before the dated schedule':dateLabel(entry.effectiveFrom)),
      h('strong',{},dollars(entry.hourlyRate)+'/hr'),h('span',{class:'st-muted'},entry.payType+' · overtime ×'+entry.overtimeMultiplier),h('span',{class:'st-tag'},state));
  });
  return h('section',{class:'st-section st-pay','aria-label':'Pay'},h('h4',{},'Pay'),
    h('p',{class:'st-pay-current'},h('strong',{},current.hourlyRate===null?'No rate recorded':dollars(current.hourlyRate)+'/hr'),' ',h('span',{class:'st-muted'},(current.payType||'hourly')+' · '+source)),
    pay.needsReview?h('p',{class:'st-flag',role:'note'},current.source==='pay_rates_need_review'?'The saved pay schedule needs owner review before it can change.':'The profile form changed this rate outside the dated schedule. Review it and save a dated change.'):null,
    rows.length?h('ol',{class:'st-pay-history','aria-label':'Pay history by effective date'},rows):null);
}
function gustoSection(person){
  if(person.gustoEmployeeId===undefined)return null;
  const id=person.gustoEmployeeId?h('strong',{class:'st-gusto-id'},person.gustoEmployeeId):null;
  return h('section',{class:'st-section','aria-label':'Gusto employee ID'},h('h4',{},'Gusto employee ID'),
    person.gustoExcluded?h('p',{class:'st-gusto-excluded'},id,id?' · ':'',h('span',{},'Not paid through Gusto: left out of the Gusto hours file, which lists them after the download.'))
      :id?h('p',{},id,' ',h('span',{class:'st-muted'},'Keys this employee’s row in the Gusto hours file.'))
      :h('p',{class:'st-flag',role:'note'},'Not set. The payroll week’s Gusto hours file names this employee and stops until it is added, or until they are marked not paid through Gusto.'));
}
function availabilitySection(person){
  const week=person.weeklyAvailability;
  const body=week?h('dl',{class:'st-week'},DAYS.flatMap(day=>[h('dt',{},DAY_LABEL[day].slice(0,3)),h('dd',{},(week[day]||[]).length?week[day].map(w=>clock(w.start)+'–'+clock(w.end)).join(', '):'Not available')])):h('p',{class:'st-muted'},'Weekly availability has not been set.');
  return h('section',{class:'st-section','aria-label':'Weekly availability'},h('h4',{},'Weekly availability'),person.weeklyAvailabilityNeedsReview?h('p',{class:'st-flag',role:'note'},'The saved week could not be read; saving a new week replaces it.'):null,body);
}
function historyLine(entry){
  const before=record(entry.changes?.before)?entry.changes.before:{},after=record(entry.changes?.after)?entry.changes.after:{};
  let what='Record updated';
  if(entry.action==='set_roles')what='Roles: '+roleText(before.staffRoles)+' → '+roleText(after.staffRoles);
  else if(entry.action==='set_skills')what='Skills updated ('+(Array.isArray(after.skills)?after.skills.length:0)+' recorded)';
  else if(entry.action==='set_pay')what=record(after.entry)?'Pay from '+dateLabel(after.entry.effectiveFrom)+': '+dollars(after.entry.hourlyRate)+'/hr':'Pay schedule changed';
  else if(entry.action==='set_availability')what='Weekly availability updated';
  else if(entry.action==='set_gusto_id')what=[before.gustoEmployeeId!==after.gustoEmployeeId?(after.gustoEmployeeId?'Gusto employee ID set':'Gusto employee ID removed'):'',
    typeof after.gustoExcluded==='boolean'&&after.gustoExcluded!==(before.gustoExcluded===true)?(after.gustoExcluded?'Marked not paid through Gusto':'Marked paid through Gusto'):''].filter(Boolean).join('; ')||'Gusto employee ID saved';
  else if(/^migration:/.test(String(entry.action||'')))what='Record migrated ('+String(entry.action).slice(10)+')';
  const meta=[typeof entry.actor==='string'?entry.actor:'',when(entry.at),typeof entry.reason==='string'?entry.reason:''].filter(Boolean).join(' · ');
  return h('li',{},h('span',{},what),meta?h('small',{},meta):null);
}
function historySection(person){
  const rows=person.history.filter(record);
  if(!rows.length)return null;
  return h('details',{class:'st-history'},h('summary',{},'Change history ('+rows.length+')'),h('ol',{},[...rows].reverse().map(historyLine)));
}

function field(label,control,help){return h('label',{class:'st-field'},h('span',{},label),control,help?h('small',{},help):null);}
function editorFor(person){
  const kind=S.edit.kind,d=S.draft,name=person.displayName||person.username,body=[];
  if(kind==='roles'){
    body.push(h('fieldset',{class:'st-choices'},h('legend',{},'Roles for '+name),EDITABLE_ROLES.map(role=>h('label',{class:'st-check'},
      h('input',{type:'checkbox',name:'staffRoles',value:role,checked:d.staffRoles.includes(role),onchange:event=>{touch();d.staffRoles=event.target.checked?[...new Set([...d.staffRoles,role])]:d.staffRoles.filter(item=>item!==role);}}),h('span',{},ROLE_LABEL[role])))),
      person.staffRoles.includes('owner')?h('p',{class:'st-muted'},'The owner role stays with the configured owner account.'):null,
      h('p',{class:'st-muted'},'Saving signs '+name+' out of the Hub so the new roles apply at their next sign-in.'));
  }else if(kind==='skills'){
    const retired=person.skills.filter(skill=>skill.retired);
    body.push(h('div',{class:'st-skill-grid'},S.data.catalog.skills.map(skill=>field(skill.label,h('select',{name:'skill_'+skill.id,onchange:event=>{touch();if(LEVELS.includes(event.target.value))d.levels[skill.id]=event.target.value;else delete d.levels[skill.id];}},
      h('option',{value:'',selected:!d.levels[skill.id]},'Not recorded'),LEVELS.map(level=>h('option',{value:level,selected:d.levels[skill.id]===level},LEVEL_LABEL[level])))))),
      retired.length?h('p',{class:'st-muted'},'Retired skills ('+retired.map(skill=>skill.id).join(', ')+') are removed when you save.'):null);
  }else if(kind==='pay'){
    const day=today(),current=person.pay?.current;
    body.push(h('div',{class:'st-form-grid'},
      field('Effective date (Denver)',h('input',{type:'date',name:'effectiveFrom',required:true,min:day,max:addDays(day,366),value:d.effectiveFrom,oninput:event=>{touch();d.effectiveFrom=event.target.value;}}),'Today in Denver is '+dateLabel(day)+'. Timecards clocked in before this date keep the rate saved at clock-in.'),
      field('Hourly rate ($)',h('input',{type:'number',name:'hourlyRate',required:true,min:'0',max:'500',step:'0.01',inputmode:'decimal',autocomplete:'off',placeholder:current&&current.hourlyRate!==null?String(current.hourlyRate):'0.00',value:d.hourlyRate,oninput:event=>{touch();d.hourlyRate=event.target.value;}})),
      field('Pay type',h('select',{name:'payType',onchange:event=>{touch();d.payType=event.target.value;}},PAY_TYPES.map(type=>h('option',{value:type,selected:d.payType===type},type==='hourly'?'Hourly':'Salary')))),
      field('Overtime multiplier',h('input',{type:'number',name:'overtimeMultiplier',required:true,min:'1',max:'3',step:'0.01',inputmode:'decimal',autocomplete:'off',value:d.overtimeMultiplier,oninput:event=>{touch();d.overtimeMultiplier=event.target.value;}}))));
  }else if(kind==='gusto'){
    body.push(field('Gusto employee ID',h('input',{type:'text',name:'gustoEmployeeId',maxLength:64,inputmode:'text',autocomplete:'off',autocapitalize:'off',value:d.gustoEmployeeId,oninput:event=>{touch();d.gustoEmployeeId=event.target.value;}}),
      'Copy it from '+name+'’s profile in Gusto. The Gusto hours file is keyed by it. Leave it blank to remove it. Only the owner sees it.'),
      h('label',{class:'st-check'},h('input',{type:'checkbox',name:'gustoExcluded',checked:d.gustoExcluded===true,onchange:event=>{touch();d.gustoExcluded=event.target.checked;}}),
        h('span',{},'Not paid through Gusto (the owner, a 1099 worker)')),
      h('p',{class:'st-muted'},'Their approved hours are left out of the Gusto hours file and named after the download; the payroll CSV still has them.'));
  }else{
    body.push(h('p',{class:'st-muted'},'Denver time. Use 12:00 AM as the end time for “until midnight”.'),h('div',{class:'st-days'},DAYS.map(day=>{
      const windows=d.week[day];
      return h('fieldset',{class:'st-day'},h('legend',{},DAY_LABEL[day]),windows.length?windows.map((w,index)=>h('div',{class:'st-window'},
        field('From',h('input',{type:'time',name:day+'_start_'+index,required:true,value:w.start,oninput:event=>{touch();w.start=event.target.value;}})),
        field('To',h('input',{type:'time',name:day+'_end_'+index,required:true,value:w.end,oninput:event=>{touch();w.end=event.target.value;}})),
        button('Remove',()=>{touch();windows.splice(index,1);render();},'quiet st-remove',{'aria-label':'Remove '+DAY_LABEL[day]+' window '+(index+1)}))):h('p',{class:'st-muted'},'Not available'),
        button('Add hours',()=>{touch();windows.push(windows.length?{start:'',end:''}:{start:'08:00',end:'17:00'});render();},'',{disabled:windows.length>=4,'aria-label':'Add hours on '+DAY_LABEL[day]}));
    })));
  }
  body.push(field('Reason (optional, kept in the audit trail)',h('textarea',{name:'reason',rows:2,maxLength:500,value:d.reason,oninput:event=>{touch();d.reason=event.target.value;}})));
  return h('form',{class:'st-editor','aria-label':EDIT_LABEL[kind]+' for '+name,novalidate:true,onsubmit:event=>{event.preventDefault();void save(kind,person);}},
    h('h4',{},'Edit '+editText(kind)),body,d.error?h('p',{class:'st-error',role:'alert'},d.error):null,
    h('footer',{class:'st-editor-foot'},button('Cancel',closeEditor,'quiet'),h('button',{type:'submit',class:'st-btn primary',disabled:S.busy||Boolean(S.pending),'aria-busy':S.busy?'true':null},S.busy?'Saving…':SAVE_LABEL[kind])));
}
function personCard(person){
  const name=person.displayName||person.username,editing=S.edit&&same(S.edit.username,person.username);
  const actions=['roles','skills','pay','availability','gusto'].filter(kind=>allowed(kind,person)).map(kind=>button(BUTTON_LABEL[kind],()=>openEditor(kind,person),editing&&S.edit.kind===kind?'active':'',{'aria-label':openerLabel(kind,person),'aria-expanded':editing&&S.edit.kind===kind?'true':'false'}));
  return h('article',{class:'st-person','data-username':person.username},
    h('header',{class:'st-person-head'},h('span',{class:'st-avatar','aria-hidden':'true'},(name.trim()[0]||'?').toUpperCase()),
      h('div',{},h('h3',{},name),h('p',{},'@'+person.username+' · '+(person.source==='configured'?'Hub configuration':'Employee account'))),h('span',{class:'st-tag role-'+person.primaryRole},ROLE_LABEL[person.primaryRole]||person.primaryRole)),
    person.profileNeedsReview?h('p',{class:'st-flag',role:'note'},'This profile is saved under an unrecognized id. The owner must review it before the directory can change it.'):null,
    rolesSection(person),skillsSection(person),paySection(person),gustoSection(person),availabilitySection(person),
    actions.length?h('div',{class:'st-actions st-person-actions'},actions):null,
    editing?editorFor(person):null,historySection(person));
}
// Former staff: a stored profile or a rejected account, no Hub access. The owner sets only their Gusto fields here, for
// weeks they still have approved hours in.
function formerCard(person){
  const name=person.displayName||person.username,editing=S.edit&&same(S.edit.username,person.username);
  const actions=allowed('gusto',person)?[button(BUTTON_LABEL.gusto,()=>openEditor('gusto',person),editing?'active':'',{'aria-label':openerLabel('gusto',person),'aria-expanded':editing?'true':'false'})]:[];
  return h('article',{class:'st-person st-former-person','data-username':person.username},
    h('header',{class:'st-person-head'},h('span',{class:'st-avatar','aria-hidden':'true'},(name.trim()[0]||'?').toUpperCase()),
      h('div',{},h('h3',{},name),h('p',{},'@'+person.username+' · '+(person.accountStatus==='rejected'?'Account not approved':'No Hub access'))),h('span',{class:'st-tag'},'Former staff')),
    person.profileNeedsReview?h('p',{class:'st-flag',role:'note'},'This profile is saved under an unrecognized id. The owner must review it before the directory can change it.'):null,
    gustoSection(person),actions.length?h('div',{class:'st-actions st-person-actions'},actions):null,editing?editorFor(person):null,historySection(person));
}
function formerSection(list){
  if(!list?.length)return null;
  const open=S.formerOpen||Boolean(S.edit&&list.some(person=>same(person.username,S.edit.username)));
  return h('details',{class:'st-former',open,ontoggle:event=>{S.formerOpen=event.target.open;}},h('summary',{},'Former staff ('+list.length+') · Gusto IDs only'),
    h('p',{class:'st-muted'},'People who no longer sign in to the Hub: a saved staff profile, or an employee account that is not approved. Set a Gusto employee ID or the not-paid-through-Gusto mark for a week they still have approved hours in. This gives them no Hub access.'),
    h('div',{class:'st-list'},list.map(formerCard)));
}
function render(){
  if(!S.root)return;
  // Every render rebuilds the section, so a focused labelled button (or the opener after a close) is focused again.
  const active=document.activeElement,label=S.focus||(active&&active!==S.root&&S.root.contains(active)&&active.getAttribute?.('aria-label'))||'';
  S.focus='';
  S.root.className='egc-staff'+(S.embedded?' embedded':' screen');
  const body=[];
  if(!manager())body.push(h('div',{class:'st-notice'},h('strong',{},'Managers only'),h('p',{},'The staff directory is available to the owner and managers.')));
  else if(S.data){
    const people=S.data.people;
    const checked=when(S.data.coverage.asOf);
    body.push(h('p',{class:'st-summary',role:'status'},[people.length+(people.length===1?' person':' people'),checked?'checked '+checked:'',S.loading?'refreshing…':''].filter(Boolean).join(' · ')));
    body.push(people.length?h('div',{class:'st-list'},people.map(personCard)):h('div',{class:'st-notice'},h('strong',{},'No active staff yet'),h('p',{},'Approved employee accounts and configured Hub users appear here.')));
    body.push(formerSection(S.data.formerStaff));
  }else if(S.error&&!S.loading)body.push(unavailable());
  else body.push(skeleton());
  S.root.replaceChildren(...[head(),pendingBanner(),noticeBlock(),...body].filter(Boolean));
  if(label)[...S.root.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===label&&!node.hasAttribute('disabled'))?.focus?.();
}

function reset(){
  S.generation++;S.loadSeq++;S.controller?.abort();S.root?.remove();
  Object.assign(S,{host:null,root:null,ctx:null,viewer:'',formerOpen:false,data:null,loadedAt:NaN,loading:false,error:null,controller:null,busy:false,pending:null,notice:null,edit:null,draft:null,dirty:false,focus:''});
}
function mount(host,ctx={}){
  if(!host)return;
  const viewer=key(ctx.identity),embedded=ctx.screen!=='staff';
  if(S.root&&viewer!==S.viewer)reset();
  S.ctx=ctx;S.viewer=viewer;
  const fresh=!S.root,moved=embedded!==S.embedded;
  S.embedded=embedded;
  if(!fresh&&S.host===host&&S.root.isConnected)return;
  if(fresh)S.root=h('section',{class:'egc-staff','aria-label':'Staff directory'});
  S.host=host;host.replaceChildren(S.root);
  if(!fresh){if(moved)render();return;}
  S.pending=readPending();
  render();
  if(manager())void load();
}
// Leaving keeps an open draft (and the revision it was opened at) in memory for this viewer; sign-out clears it. A GET in flight is dropped.
function unmount(){S.loadSeq++;S.controller?.abort();S.controller=null;S.loading=false;S.root?.remove();S.root=null;S.host=null;S.data=null;S.loadedAt=NaN;S.error=null;S.notice=null;S.focus='';}
window.addEventListener('egc:signout',()=>{reset();clearAllPending();});
window.addEventListener('beforeunload',event=>{if(S.busy||S.dirty&&S.root){event.preventDefault();event.returnValue='';}});
window.EGCStaff={mount,unmount,refresh:()=>load(),canLeave:()=>!S.busy&&!S.dirty};
})();
