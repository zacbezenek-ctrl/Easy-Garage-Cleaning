/* Time approvals: a manager's Correct time and Close shift dialogs (EGC_TIMECARD_CORRECTIONS, TIME-CORRECT).
   The save is the Employee Hub's manager timecard update with a `correction`: the server checks the card has not changed
   since it was shown (expectedUpdatedAt), recomputes hours, returns the card to pending, clips its job segments to the
   corrected shift and keeps the change and its reason in the card's history. Times are Denver wall clock whatever the
   device's time zone; a time left as shown is sent back as the exact instant it was, so a shift across a daylight-saving
   change keeps its real length. A save that was not confirmed is retried with the same request ID and body: it is kept in
   sessionStorage for the signed-in viewer (cleared at sign-out), so closing the dialog or reloading still offers Retry the
   same save when that timecard's dialog is opened again. */
(function(){
'use strict';
const TZ='America/Denver',MAX_BREAKS=20,STALE_MS=14*3600000,PENDING_PREFIX='egc.timecardCorrect.pending.v1.',TITLES={correct:['CORRECT TIME','Correct time'],close:['CLOSE SHIFT','Close shift at…']};
const S={dialog:null,opener:null,options:null,entry:null,kind:'',draft:null,busy:false,error:'',errorKind:'',pending:null,edited:false,generation:0};
function h(tag,props,...children){const node=document.createElement(tag);for(const [name,value]of Object.entries(props||{})){if(value==null||value===false)continue;if(name==='class')node.className=value;else if(name.startsWith('on')&&typeof value==='function')node.addEventListener(name.slice(2),value);else if(name in node&&!name.startsWith('aria-')&&name!=='role')node[name]=value;else node.setAttribute(name,String(value));}for(const child of children.flat())if(child!=null&&child!==false)node.append(child instanceof Node?child:String(child));return node;}
const toast=message=>{if(typeof window.showToast==='function')window.showToast(message);};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid=()=>typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'?crypto.randomUUID():'10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(Number(c)^Math.random()*16>>Number(c)/4).toString(16));
function parts(at){return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(p=>[p.type,p.value]));}
function localValue(at){const p=parts(at);return`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
// A Denver wall time as an instant; one that happens twice or never (daylight saving) is refused rather than guessed.
function localToIso(value,label){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value||''))throw new Error(`Enter the ${label} date and time.`);
  const wall=Date.parse(value+'Z');if(!Number.isFinite(wall)||new Date(wall).toISOString().slice(0,16)!==value)throw new Error(`The ${label} is not a real date and time.`);
  const offsets=new Set([-86400000,0,86400000].map(delta=>{const p=parts(wall+delta);return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute)-(wall+delta);}));
  const matches=[...offsets].map(o=>wall-o).filter(t=>localValue(t)===value);
  if(matches.length!==1)throw new Error(`The ${label} happens twice or not at all on that date because of daylight saving. Choose another minute.`);
  return new Date(matches[0]).toISOString();
}
const shown=value=>{const at=Date.parse(value||'');return Number.isFinite(at)?{wall:localValue(at),iso:value}:null;};
// A field the manager left as shown is sent as the instant it was; an edited one is read as Denver wall time.
const instantOf=(value,origin,label)=>origin&&value===origin.wall?origin.iso:localToIso(value,label);
const when=value=>{const at=Date.parse(value||'');return Number.isFinite(at)?new Intl.DateTimeFormat('en-US',{timeZone:TZ,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(at)):'not recorded';};
const dayLabel=value=>{const at=Date.parse(value||'');return Number.isFinite(at)?new Intl.DateTimeFormat('en-US',{timeZone:TZ,weekday:'short',month:'short',day:'numeric'}).format(new Date(at)):'';};
const hours=ms=>(ms/3600000).toFixed(2);
const rateText=value=>value===undefined||value===null||value===''?'':String(value);

const breakDraft=item=>({start:shown(item.startAt)?.wall||'',end:shown(item.endAt)?.wall||'',kind:item.kind==='rest'||item.kind==='meal'?item.kind:'',origStart:shown(item.startAt),origEnd:shown(item.endAt),origKind:item.kind==='meal'?'meal':''});
function draftFor(entry,kind,options){
  const breaks=(Array.isArray(entry.breaks)?entry.breaks:[]).filter(Boolean).map(breakDraft);
  return{clockIn:shown(entry.clockInAt)?.wall||'',clockOut:shown(entry.clockOutAt)?.wall||'',origIn:shown(entry.clockInAt),origOut:shown(entry.clockOutAt),breaks,jobId:String(entry.jobId||''),
    rate:options.canSetRate?rateText(entry.hourlyRate):null,origRate:rateText(entry.hourlyRate),reason:kind==='close'?'Forgot to clock out':''};
}
// The fields as a save that was not confirmed sent them, so the dialog shows what Retry the same save sends.
function draftFromSent(entry,kind,options,data){
  const d=draftFor(entry,kind,options),at=shown(data.clockOutAt);
  d.reason=String(data.correction?.reason||'');if(at){d.clockOut=at.wall;d.origOut=at;}
  if(kind!=='correct')return d;
  const start=shown(data.clockInAt);if(start){d.clockIn=start.wall;d.origIn=start;}
  if(Array.isArray(data.breaks))d.breaks=data.breaks.filter(Boolean).map(breakDraft);
  if(Object.hasOwn(data,'jobId'))d.jobId=String(data.jobId||'');
  if(Object.hasOwn(data,'hourlyRate')&&d.rate!==null)d.rate=rateText(data.hourlyRate);
  return d;
}
// An unconfirmed save per timecard, for this viewer only: {kind, requestId, data} with data the body without its request ID.
const pendingKey=()=>{const viewer=String(S.options?.viewer||'').trim().toLowerCase();return viewer?PENDING_PREFIX+viewer:'';};
function pendingAll(key=pendingKey()){if(!key)return{};try{const value=JSON.parse(window.sessionStorage.getItem(key)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return{};}}
function pendingStore(entryId,value,key=pendingKey()){
  if(!key||!entryId)return;
  try{const all=pendingAll(key);if(value)all[entryId]=value;else delete all[entryId];const ids=Object.keys(all).slice(-20);if(ids.length)window.sessionStorage.setItem(key,JSON.stringify(Object.fromEntries(ids.map(id=>[id,all[id]]))));else window.sessionStorage.removeItem(key);}catch{}
}
function pendingFor(entry,kind){const item=pendingAll()[entry.id];return item&&item.kind===kind&&UUID.test(String(item.requestId||''))&&item.data&&typeof item.data==='object'&&item.data.correction?.kind===kind?item:null;}
// Two bodies are the same save whatever card version each was made from.
const keyOf=data=>JSON.stringify({...data,correction:{...data.correction,expectedUpdatedAt:undefined}});

// The save body (without its request ID), or an Error naming what to fix. The hours preview does not need the reason.
function body(strict=true){
  const d=S.draft,entry=S.entry,reason=d.reason.trim();
  if(S.kind==='close'){
    const clockOutAt=localToIso(d.clockOut,'clock-out');
    if(Date.parse(clockOutAt)<=Date.parse(entry.clockInAt))throw new Error('The clock-out time must be after the clock-in time.');
    if(strict&&reason.length<3)throw new Error('Give a reason. It is kept in the timecard history.');
    return{correction:{kind:'close',reason,expectedUpdatedAt:String(entry.updatedAt||'')},clockOutAt};
  }
  const clockInAt=instantOf(d.clockIn,d.origIn,'clock-in'),clockOutAt=instantOf(d.clockOut,d.origOut,'clock-out');
  if(Date.parse(clockOutAt)<=Date.parse(clockInAt))throw new Error('The clock-out time must be after the clock-in time.');
  const breaks=d.breaks.map((item,index)=>{const startAt=instantOf(item.start,item.origStart,`break ${index+1} start`),endAt=instantOf(item.end,item.origEnd,`break ${index+1} end`);if(Date.parse(endAt)<=Date.parse(startAt))throw new Error(`Break ${index+1} must end after it starts.`);return{startAt,endAt,...(item.kind?{kind:item.kind}:{})};});
  let previous=Date.parse(clockInAt);
  for(const [index,item]of breaks.entries()){if(Date.parse(item.startAt)<previous||Date.parse(item.endAt)>Date.parse(clockOutAt))throw new Error(`Break ${index+1} must be inside the shift and after the break before it.`);previous=Date.parse(item.endAt);}
  if(strict&&reason.length<3)throw new Error('Give a reason. It is kept in the timecard history.');
  const out={correction:{kind:'correct',reason,expectedUpdatedAt:String(entry.updatedAt||'')},clockInAt,clockOutAt,breaks};
  if(d.jobId!==String(entry.jobId||''))out.jobId=d.jobId;
  if(d.rate!==null&&d.rate.trim()!==d.origRate){if(!/^\d+(?:\.\d{1,2})?$/.test(d.rate.trim())||Number(d.rate)>1000)throw new Error('Enter an hourly rate such as 22 or 22.50.');out.hourlyRate=Number(d.rate.trim());}
  return out;
}
// Paid time the correction would save: the shift less its unpaid (meal) breaks; rest breaks are paid. The timecard's own
// hours (its row on Time approvals) leave out every break, so with a rest break both numbers are named.
function preview(){
  try{
    const data=body(false),start=Date.parse(data.clockInAt||S.entry.clockInAt),end=Date.parse(data.clockOutAt);
    const breaks=data.breaks||(Array.isArray(S.entry.breaks)?S.entry.breaks.map(item=>item?.endAt?item:{...item,endAt:data.clockOutAt}):[]);
    let unpaid=0,rest=0;for(const item of breaks){const ms=Math.max(0,Date.parse(item?.endAt)-Date.parse(item?.startAt))||0;if(item?.kind==='rest')rest+=ms;else unpaid+=ms;}
    return`${hours(end-start-unpaid)} h paid time over a ${hours(end-start)} h shift${unpaid?` with ${hours(unpaid)} h unpaid breaks`:''}.${rest?` The timecard row shows ${hours(end-start-unpaid-rest)} h: its hours leave out the ${hours(rest)} h of paid rest breaks too, which payroll pays.`:''}`;
  }catch{return'Enter the times to see the corrected hours.';}
}

function field(label,control,help){return h('div',{class:'tc-field'},h('label',{},label,control),help?h('small',{},help):null);}
function bind(key,props={},target=()=>S.draft){const input=h(props.tag||'input',{...props,tag:undefined,value:target()[key]??''});input.addEventListener('input',()=>{target()[key]=input.value;S.edited=true;update();});return input;}
function breakRow(item,index){
  const own=()=>S.draft.breaks[index];
  const paid=h('input',{type:'checkbox',checked:item.kind==='rest',onchange:event=>{own().kind=event.target.checked?'rest':own().origKind;S.edited=true;update();}});
  return h('fieldset',{class:'tc-break'},h('legend',{},`Break ${index+1}`),
    h('div',{class:'tc-pair'},field('Start (Denver)',bind('start',{type:'datetime-local',name:`break-${index}-start`,required:true},own)),field('End (Denver)',bind('end',{type:'datetime-local',name:`break-${index}-end`,required:true},own))),
    h('div',{class:'tc-break-foot'},h('label',{class:'tc-check'},paid,'Paid rest break'),h('button',{type:'button',class:'tc-button',disabled:S.busy,onclick:()=>{S.draft.breaks.splice(index,1);S.edited=true;render();}},'Remove break')));
}
function jobOptions(){
  const options=[{id:'',label:'No job'},...(Array.isArray(S.options.jobs)?S.options.jobs:[])],current=String(S.entry.jobId||'');
  if(current&&!options.some(option=>option.id===current))options.push({id:current,label:S.entry.jobLabel||`Job ${current}`});
  return options.map(option=>h('option',{value:option.id,selected:option.id===S.draft.jobId},option.label));
}
// An open shift past 14 hours was probably never clocked out of; a shorter one may still be running, and saving ends it.
function summary(){
  const e=S.entry,open=!e.clockOutAt,since=Date.parse(e.clockInAt||''),now=typeof S.options.now==='function'?S.options.now():Date.now(),age=Number.isFinite(since)&&now>since?now-since:NaN;
  return h('p',{class:'tc-summary'},!open?`${when(e.clockInAt)} to ${when(e.clockOutAt)} · ${String(e.approvalStatus||'pending')}.`
    :age>STALE_MS?`Clocked in ${when(e.clockInAt)} and never clocked out (${hours(age)} h ago).`
    :`Clocked in ${when(e.clockInAt)} and still clocked in${Number.isFinite(age)?` (${hours(age)} h so far)`:''}. Saving sets the clock-out, which ends the shift.`);
}
function fields(){
  const d=S.draft;
  if(S.kind==='close')return[
    field('Clock-out (Denver time)',bind('clockOut',{type:'datetime-local',name:'clockOut',required:true}),'When the shift really ended. An unfinished break ends then too.'),
    field('Reason',bind('reason',{tag:'textarea',name:'reason',rows:2,maxLength:500,required:true}),'Kept in the timecard history.')];
  return[
    h('div',{class:'tc-pair'},field('Clock-in (Denver time)',bind('clockIn',{type:'datetime-local',name:'clockIn',required:true})),field('Clock-out (Denver time)',bind('clockOut',{type:'datetime-local',name:'clockOut',required:true}))),
    h('div',{class:'tc-breaks'},...d.breaks.map(breakRow),h('button',{type:'button',class:'tc-button',disabled:S.busy||d.breaks.length>=MAX_BREAKS,onclick:()=>{d.breaks.push({start:'',end:'',kind:'',origStart:null,origEnd:null,origKind:''});render();S.dialog?.querySelector(`[name="break-${d.breaks.length-1}-start"]`)?.focus();}},d.breaks.length>=MAX_BREAKS?`Up to ${MAX_BREAKS} breaks`:'Add break')),
    field('Job',(()=>{const select=h('select',{name:'jobId'},...jobOptions());select.addEventListener('change',()=>{d.jobId=select.value;S.edited=true;update();});return select;})(),'Sets the timecard’s job. Job time comes from the crew’s job segments, which this does not move.'),
    d.rate!==null?field('Hourly rate ($)',bind('rate',{type:'text',name:'hourlyRate',inputMode:'decimal',autocomplete:'off',placeholder:'22.50'}),'Owner only. Sent only when changed.'):null,
    field('Reason',bind('reason',{tag:'textarea',name:'reason',rows:2,maxLength:500,required:true,placeholder:'Forgot to clock out; break not recorded'}),'Kept in the timecard history.')];
}
const retrying=()=>Boolean(S.pending&&S.errorKind==='unknown'&&!S.edited);
const primaryLabel=()=>retrying()?'Retry the same save':S.kind==='close'?'Close shift':'Save correction';
function update(){const node=S.dialog?.querySelector('.tc-preview');if(node)node.textContent=preview();const button=S.dialog?.querySelector('.tc-actions .primary');if(button&&!S.busy)button.textContent=primaryLabel();}
function render(){
  const dialog=S.dialog;if(!dialog)return;
  const [kicker,title]=TITLES[S.kind],e=S.entry;
  const head=h('header',{class:'tc-head'},h('div',{},h('p',{class:'tc-kicker'},kicker),h('h2',{id:'tc-title'},`${e.employeeName||e.employee||'Employee'} · ${dayLabel(e.clockInAt)}`)),h('button',{type:'button',class:'tc-close','aria-label':'Close',disabled:S.busy,onclick:()=>close()},'×'));
  const notice=S.error?h('p',{class:'tc-notice error',role:'alert',tabIndex:-1},S.error):null;
  const main=h('div',{class:'tc-body'},summary(),notice,...fields().filter(Boolean),h('p',{class:'tc-preview','aria-live':'polite'},preview()),h('p',{class:'tc-note'},'Saving returns the timecard to pending for approval. Job time is trimmed to the corrected shift.'));
  const primary=primaryLabel();
  const foot=h('footer',{class:'tc-foot'},h('p',{class:'tc-status','aria-live':'polite'},S.busy?'Saving…':''),h('div',{class:'tc-actions'},h('button',{type:'button',class:'tc-button',disabled:S.busy,onclick:()=>close()},S.errorKind==='changed'?'Close':'Cancel'),
    S.errorKind==='changed'?null:h('button',{type:'submit',class:'tc-button primary',disabled:S.busy},S.busy?'Saving…':primary)));
  const form=h('form',{class:'tc-sheet',noValidate:true,'aria-busy':S.busy?'true':'false',onsubmit:event=>{event.preventDefault();void submit();}},head,main,foot);
  if(S.busy)for(const el of form.querySelectorAll('input,select,textarea'))el.disabled=true;
  dialog.replaceChildren(form);
}
const UNCONFIRMED='The correction was not confirmed. Retry the same save: it carries the same request ID, so it is never saved twice.';
function failure(error,entryId,key){
  const status=Number(error?.status)||0,code=String(error?.code||'');
  if(!status||status>=500||[401,408,429].includes(status))return['unknown',UNCONFIRMED];
  pendingStore(entryId,null,key);
  if(code==='EMPLOYEE_TIMECARD_CHANGED'||code==='EMPLOYEE_HUB_WRITE_CONFLICT')return['changed','This timecard changed since you opened it. Close this, then correct the latest times.'];
  return['refused',error?.message||'The correction was not saved.'];
}
// Retry the same save sends the unconfirmed body unchanged; a draft edited since is a new save with a new request ID
// (the same one again if it is edited back to what was sent). It is kept for this viewer before it is sent.
async function submit(){
  if(S.busy||!S.dialog)return;
  let data;
  if(retrying())data=S.pending.data;
  else{
    try{data=body();}catch(error){S.error=error.message;S.errorKind='invalid';render();S.dialog?.querySelector('.tc-notice.error')?.focus();return;}
    const same=keyOf(data);
    if(S.pending?.key===same)data=S.pending.data;else S.pending={key:same,requestId:uuid(),data};
  }
  const entryId=S.entry.id,generation=++S.generation,options=S.options,kind=S.kind,requestId=S.pending.requestId,key=pendingKey();
  pendingStore(entryId,{kind,requestId,data},key);
  S.busy=true;S.edited=false;S.error='';S.errorKind='';render();
  try{
    const record=await options.save({...data,correction:{...data.correction,requestId}});
    pendingStore(entryId,null,key);
    if(generation!==S.generation)return;
    S.busy=false;close(true);
    toast(kind==='close'?'Shift closed. It is waiting for approval.':'Timecard corrected. It is waiting for approval.');
    if(typeof options.onSaved==='function')options.onSaved(record);
  }catch(error){
    const [errorKind,message]=failure(error,entryId,key);
    if(generation!==S.generation)return;
    if(errorKind!=='unknown')S.pending=null;
    S.busy=false;S.errorKind=errorKind;S.error=message;render();S.dialog?.querySelector('.tc-notice.error')?.focus();
  }
}
function beforeUnload(event){if(S.busy){event.preventDefault();event.returnValue='';}}
function open(options={}){
  const entry=options.entry;
  if(!entry||!entry.id||!TITLES[options.kind]||typeof options.save!=='function')return false;
  if(S.dialog){if(S.busy)return false;close(true);}
  S.opener=typeof document.activeElement?.focus==='function'?document.activeElement:null;
  Object.assign(S,{options,entry,kind:options.kind,draft:draftFor(entry,options.kind,options),busy:false,error:'',errorKind:'',pending:null,edited:false});
  const kept=pendingFor(entry,options.kind);
  if(kept)Object.assign(S,{draft:draftFromSent(entry,options.kind,options,kept.data),pending:{key:keyOf(kept.data),requestId:kept.requestId,data:kept.data},errorKind:'unknown',error:`Your last save here was not confirmed. ${UNCONFIRMED.slice(UNCONFIRMED.indexOf('Retry'))}`});
  const dialog=h('dialog',{class:'egc-timecard-correct','aria-labelledby':'tc-title',oncancel:event=>{event.preventDefault();close();},onclose:()=>{if(S.dialog===dialog)close(true);}});
  S.dialog=dialog;document.body.append(dialog);
  render();
  if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  window.addEventListener('beforeunload',beforeUnload);
  dialog.querySelector('.tc-body input,.tc-body select,.tc-body textarea')?.focus();
  return true;
}
function close(force=false){
  if(!S.dialog||(!force&&S.busy))return;
  const dialog=S.dialog;S.dialog=null;S.generation++;
  window.removeEventListener('beforeunload',beforeUnload);
  if(dialog.open)dialog.close();dialog.remove();
  Object.assign(S,{options:null,entry:null,draft:null,busy:false,error:'',errorKind:'',pending:null,edited:false});
  if(S.opener?.isConnected)S.opener.focus();S.opener=null;
}
window.addEventListener('egc:signout',()=>{close(true);try{const store=window.sessionStorage;for(let index=store.length-1;index>=0;index--){const key=store.key(index);if(key&&key.startsWith(PENDING_PREFIX))store.removeItem(key);}}catch{}});
window.EGCTimecardCorrect={open,close:()=>close(),canLeave:()=>!S.busy,isOpen:()=>Boolean(S.dialog)};
})();
