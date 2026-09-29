/* The Requests board and its time-off and shift-change dialogs. Every change
 * goes through /api/employee-pto. The frozen request body is kept per viewer
 * until the server confirms it, so a lost response is retried with the same
 * requestId instead of being duplicated. */
(function () {
'use strict';
const prefix='egc.pto.pending.v1:', actions=['request','approve','deny','cancel','end','amend'];
const S={host:null,options:null,busy:false};
function h(tag,props,...children){const node=document.createElement(tag);for(const [name,value]of Object.entries(props||{})){if(value==null||value===false)continue;if(name==='class')node.className=value;else if(name.startsWith('on')&&typeof value==='function')node.addEventListener(name.slice(2),value);else if(name in node&&!name.startsWith('aria-'))node[name]=value;else node.setAttribute(name,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
const viewer=()=>String(sessionStorage.getItem('egc_u')||localStorage.getItem('egc_u')||'').trim().toLowerCase();
const storageKey=()=>viewer()?prefix+viewer():'';
const validHours=value=>Number.isFinite(value)&&value>0&&value<=12&&Number.isInteger(value*4);
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
// Denver calendar days use UTC-noon arithmetic, never the device zone.
const addDays=(date,amount)=>new Date(Date.parse(date+'T12:00:00Z')+amount*86400000).toISOString().slice(0,10);
const kind=row=>row?.type==='time_off'?'time off':'shift change';
const state=row=>{const status=String(row?.status||'pending');return status==='canceled'?'cancelled':status;};
const dates=row=>String(row?.startDate||'Dates need review')+(row?.endDate&&row.endDate!==row.startDate?' – '+row.endDate:'');
// The last day an approval still covers: an early end releases its date onward.
const lastDay=row=>validDate(row?.endedEarlyFrom)?addDays(row.endedEarlyFrom,-1):validDate(row?.endDate)?row.endDate:String(row?.startDate||'');
// A permission or roster refusal does not change on retry, so its body is discarded.
const definitive=['pto_forbidden','pto_origin_forbidden','pto_employee_inactive'];
const retryable=error=>!error.status||error.status>=500||[401,408,429].includes(error.status)||error.status===403&&!definitive.includes(error.code);
const plural=(count,word)=>`${count} ${word}${count===1?'':'s'}`;
function span(row){const days=[],start=String(row?.startDate||''),end=String(row?.endDate||start);if(!validDate(start)||!validDate(end)||end<start)return days;for(let date=start;date<=end&&days.length<=31;date=addDays(date,1))days.push(date);return days.length>31?[]:days;}
const weekday=date=>{const value=new Date(date+'T12:00:00Z').getUTCDay();return value>0&&value<6;};
const dayLabel=date=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).formatToParts(new Date(date+'T12:00:00Z')).filter(part=>part.type!=='literal').map(part=>part.value).join(' ');
// Mirrors functions/_lib/pto-pay.js. The workflow's paid, hoursPerDay, paidDates and paidHours count on an approved
// request only when the latest approve or amend decision set them (its by/at are reviewedBy/reviewedAt); a server
// projection (it carries payModel) has applied that rule already. Other approvals pay only a manager-set
// paidHoursPerDay, on weekdays (weekends too with paidWeekends) before any early end.
function workflowTerms(row){
  if(typeof row?.paid!=='boolean')return false;
  if(Object.hasOwn(row,'payModel')||row.status!=='approved')return true;
  const last=(Array.isArray(row.decisions)?row.decisions:[]).filter(entry=>entry&&(entry.action==='approve'||entry.action==='amend')&&entry.status==='approved').at(-1);
  return typeof last?.at==='string'&&last.at!==''&&last.at===row.reviewedAt&&typeof last.by==='string'&&last.by===row.reviewedBy;
}
// The terms a row pays by, to pre-fill a dialog: {paid, hoursPerDay, dates}; dates null means the weekdays.
function termsOf(row){
  if(workflowTerms(row))return{paid:row.paid,hoursPerDay:row.hoursPerDay,dates:Array.isArray(row.paidDates)?row.paidDates:Object.hasOwn(row,'payModel')&&Array.isArray(row.paidDays)?row.paidDays.map(day=>day?.date):null};
  const hours=row?.paidHoursPerDay;
  return hours===undefined||hours===null||hours===''?{paid:false,hoursPerDay:null,dates:null}:{paid:true,hoursPerDay:hours,dates:row.paidWeekends===true?span(row):null};
}
function paidHoursOf(row){
  if(row?.type!=='time_off')return 0;
  if(workflowTerms(row))return row.paid?Number(row.paidHours)||0:0;
  const hours=row.paidHoursPerDay,cutoff=validDate(row.endedEarlyFrom)?row.endedEarlyFrom:'';
  if(typeof hours!=='number'||!(hours>0&&hours<=24))return 0;
  return span(row).filter(date=>(row.paidWeekends===true||weekday(date))&&(!cutoff||date<cutoff)).length*hours;
}
function pending(){const key=storageKey();if(!key)return null;try{const saved=JSON.parse(sessionStorage.getItem(key)||'null');return saved&&typeof saved==='object'&&typeof saved.requestId==='string'&&actions.includes(saved.action)?saved:null;}catch{return null;}}
function remember(body){const key=storageKey();if(key)try{sessionStorage.setItem(key,JSON.stringify(body));}catch{/* Storage may be disabled; the in-flight save still completes. */}}
function forget(){const key=storageKey();if(key)try{sessionStorage.removeItem(key);}catch{}}
async function post(body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
  try{
    const request=typeof hubFetch==='function'?hubFetch:fetch;
    const response=await request('/api/employee-pto',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||data.ok!==true)throw Object.assign(new Error(data.error||'The request could not be verified. Retry the original save.'),{status:response.ok?503:response.status,code:data.code,details:data.details});
    if(data.requestId!==body.requestId||!data.request||typeof data.request.id!=='string'||!data.request.id||body.id!==undefined&&data.request.id!==body.id)throw Object.assign(new Error('The saved request could not be verified. Retry the original save.'),{status:503});
    return data;
  }catch(error){if(error?.name==='AbortError')throw Object.assign(new Error('The save timed out. Retry the original save.'),{status:0});throw error;}
  finally{clearTimeout(timer);}
}
async function send(body){
  const saved=pending();
  if(saved&&saved.requestId!==body.requestId)throw Object.assign(new Error('Your last request change has not been confirmed. Retry it before sending another.'),{code:'pto_pending_unverified'});
  remember(body);
  try{const data=await post(body);forget();return data;}
  catch(error){if(!retryable(error))forget();throw error;}
}
async function run(body,deps,message){
  try{const data=await send(body);deps.toast?.(message(data));deps.saved?.(data.request);return data;}
  catch(error){deps.toast?.(error.message||'The request could not be saved.');deps.saved?.(null);return null;}
}
const approved=data=>data.warnings?.length?'Time off approved. Reassign the affected jobs before dispatch.':'Request approved';
const paidFields=(terms={})=>[{name:'paid',label:'Paid time off?',type:'select',value:terms.paid===true?'yes':'no',options:[{value:'no',label:'Unpaid'},{value:'yes',label:'Paid time off'}]},
  {name:'hoursPerDay',label:'Paid hours per day',type:'number',min:0.25,step:0.25,value:String(terms.hoursPerDay||8),required:false,help:'Used only for paid time off.'}];
function paidChoice(input,deps){
  const paid=input.paid==='yes',hours=Number(input.hoursPerDay);
  if(paid&&!validHours(hours)){deps.toast?.('Enter paid hours per day from 0.25 to 12, in quarter hours.');return null;}
  return{paid,...(paid?{hoursPerDay:hours}:{})};
}
async function submitDialog(type,deps){
  if(!['time_off','shift_change'].includes(type))return null;
  const timeOff=type==='time_off';
  const input=await deps.askAction({kicker:'EMPLOYEE REQUEST',title:timeOff?'Request time off':'Request a shift change',copy:timeOff?'A manager approves time off before it blocks your schedule. Paid time off records the hours for payroll: weekdays by default, and weekend days only if the manager approves them.':'A manager must approve this before the schedule changes.',confirmLabel:'Send request',note:'Your request and its review history stay in your Hub record.',
    fields:[{name:'startDate',label:'Start date',type:'date'},{name:'endDate',label:'End date',type:'date'},...(timeOff?paidFields():[]),{name:'reason',label:timeOff?'Reason (optional)':'Reason / details',maxlength:300,placeholder:'What do you need?',required:!timeOff}]});
  if(!input)return null;
  const paid=timeOff?paidChoice(input,deps):{};
  if(!paid)return null;
  return run({action:'request',requestId:crypto.randomUUID(),type,startDate:input.startDate,endDate:input.endDate||input.startDate,reason:input.reason||'',...paid},deps,()=>'Request sent for approval');
}
// Paid-day presets over `days`: the weekdays (the default), every day, or one by one; the one shown first matches `current`.
function presetsFor(days,current){
  const weekdays=days.filter(weekday),weekend=weekdays.length<days.length,same=list=>list.length===current.length&&list.every(date=>current.includes(date));
  const presets=[...(weekdays.length?[{value:'weekdays',label:weekend?`Weekdays only (${plural(weekdays.length,'day')})`:`Every requested day (${plural(days.length,'day')})`}]:[{value:'',label:'Choose the paid days'}]),
    ...(weekend?[{value:'all',label:`Every day, weekends included (${plural(days.length,'day')})`}]:[]),...(days.length>1?[{value:'custom',label:'Pick the paid days one by one'}]:[])];
  return{presets,weekdays,value:!current.length||same(weekdays)?presets[0].value:weekend&&same(days)?'all':days.length>1?'custom':presets[0].value};
}
// The manager chooses paid or unpaid, the hours and which of `days` are paid (weekends only when chosen), then confirms
// the exact paid days and total; the dialogs start from what the request pays now. Returns the terms to send, or null.
async function choosePay(row,days,deps,view){
  const who=row.employeeName||row.employee||'this employee',terms=termsOf(row),current=terms.paid?(terms.dates||days.filter(weekday)).filter(date=>days.includes(date)):days.filter(weekday);
  const {presets,weekdays,value}=presetsFor(days,current),choice=presets.length>1;
  const input=await deps.askAction({kicker:view.kicker,title:view.title,copy:view.copy,confirmLabel:view.confirmLabel,
    fields:[...paidFields(terms),...(choice?[{name:'paidDays',label:'Paid days',type:'select',value,options:presets,required:false,help:'Used only for paid time off. Weekend days are paid only when you choose them.'}]:[]),
      ...(view.note?[{name:'note',label:'Note (optional)',type:'textarea',maxlength:300,required:false}]:[])]});
  if(!input)return null;
  const paid=paidChoice(input,deps);
  if(!paid)return null;
  if(paid.paid&&!days.length&&view.onlyUnpaid){deps.toast?.(view.onlyUnpaid);return null;}
  // The manager confirms the exact paid days and total that go on the timesheet.
  if(paid.paid&&days.length){
    const preset=choice?input.paidDays:'weekdays';
    let paidDates=preset==='all'?days:preset==='weekdays'?weekdays:[];
    if(preset==='custom'){
      const picked=await deps.askAction({kicker:'PAID DAYS',title:`Choose the paid days for ${who}`,copy:`${dates(row)}. Weekend days are paid only when you choose them. ${view.schedule}`,confirmLabel:'Review paid hours',note:view.saving,
        fields:days.map(date=>({name:'day-'+date,label:dayLabel(date),type:'select',value:current.includes(date)?'paid':'unpaid',options:[{value:'paid',label:`Paid, ${plural(paid.hoursPerDay,'hour')}`},{value:'unpaid',label:'Not paid'}]}))});
      if(!picked)return null;
      paidDates=days.filter(date=>picked['day-'+date]==='paid');
    }
    if(!paidDates.length){deps.toast?.(view.none);return null;}
    const total=paidDates.length*paid.hoursPerDay,unpaid=days.filter(date=>!paidDates.includes(date));
    const confirm=await deps.askAction({kicker:'PAID TIME OFF',title:`${view.total(total)} for ${who}?`,copy:`${plural(paidDates.length,'paid day')} × ${plural(paid.hoursPerDay,'hour')} = ${plural(total,'hour')} for ${dates(row)}. Paid: ${paidDates.map(dayLabel).join(', ')}.${unpaid.length?` Not paid: ${unpaid.map(dayLabel).join(', ')}.`:''} ${view.summary}`,confirmLabel:view.total(total),fields:[]});
    if(!confirm)return null;
    paid.paidDates=paidDates;
  }else if(!paid.paid&&view.unpaid&&!await deps.askAction({kicker:'PAID TIME OFF',...view.unpaid,fields:[]}))return null;
  if(view.note&&input.note)paid.note=input.note;
  return paid;
}
async function reviewDialog(row,status,deps){
  if(!row||!deps.manager||!['approved','denied'].includes(status))return null;
  const who=row.employeeName||row.employee||'this employee';
  if(status==='denied'){
    const input=await deps.askAction({kicker:'REQUEST REVIEW',title:`Deny ${kind(row)} for ${who}?`,copy:`${dates(row)}. Nothing on the schedule changes.`,confirmLabel:'Deny request',danger:true,fields:[{name:'note',label:'Note to the employee (optional)',type:'textarea',maxlength:300,required:false}]});
    if(!input)return null;
    return run({action:'deny',requestId:crypto.randomUUID(),id:row.id,...(input.note?{note:input.note}:{})},deps,()=>'Request denied');
  }
  let body={action:'approve',requestId:crypto.randomUUID(),id:row.id};
  if(row.type==='time_off'){
    // Payroll pays the requested weekdays unless the manager chooses other days; weekends are never paid by default.
    const days=span(row),weekdays=days.filter(weekday),weekend=weekdays.length<days.length;
    const paid=await choosePay(row,days,deps,{kicker:'TIME-OFF APPROVAL',title:`Approve time off for ${who}?`,copy:`${dates(row)} · ${plural(days.length,'day')}${weekend?`, ${weekdays.length} on weekdays`:''}. Approval blocks this employee on the schedule.`,confirmLabel:'Approve time off',
      schedule:'Every requested day stays blocked on the schedule.',saving:'Nothing is saved until you approve the paid hours.',none:'Choose which days are paid, or approve the time off as unpaid.',total:total=>`Approve ${plural(total,'paid hour')}`,summary:'These hours go on the timesheet.'});
    if(!paid)return null;
    body={...body,...paid};
  }
  try{const data=await send(body);deps.toast?.(approved(data));deps.saved?.(data.request);return data;}
  catch(error){
    if(error.code!=='crew_availability_assignment_conflict'||error.details?.acknowledgeable!==true||!Array.isArray(error.details.conflicts)){deps.toast?.(error.message||'The request could not be saved.');deps.saved?.(null);return null;}
    const jobs=error.details.conflicts.map(item=>[item.date,item.time,item.label||item.jobId].filter(Boolean).join(' ')).join('; ');
    const confirm=await deps.askAction({kicker:'ASSIGNED WORK',title:'Approve over assigned work?',copy:`${who} is assigned during this time off: ${jobs}. Approving blocks the time off; reassign these jobs afterwards.`,confirmLabel:'Approve anyway',danger:true,fields:[]});
    if(!confirm)return null;
    return run({...body,requestId:crypto.randomUUID(),acknowledgeConflicts:true},deps,approved);
  }
}
async function cancelDialog(row,deps){
  if(!row)return null;
  const paidHours=paidHoursOf(row),removed=state(row)==='approved'&&row.type==='time_off'?` The approved time off is removed from the schedule${paidHours>0?` and its ${plural(paidHours,'paid hour')} are removed from the timesheet`:''}.`:'';
  const input=await deps.askAction({kicker:'CANCEL REQUEST',title:`Cancel this ${kind(row)} request?`,copy:`${dates(row)}.${removed}`,confirmLabel:'Cancel request',danger:true,fields:[{name:'note',label:'Note (optional)',type:'textarea',maxlength:300,required:false}]});
  if(!input)return null;
  return run({action:'cancel',requestId:crypto.randomUUID(),id:row.id,...(input.note?{note:input.note}:{})},deps,()=>'Request cancelled');
}
// Time off that has started ends early instead: taken days keep their paid hours.
async function endDialog(row,deps){
  if(!row||!deps.manager||row.type!=='time_off'||state(row)!=='approved')return null;
  const who=row.employeeName||row.employee||'this employee';
  const input=await deps.askAction({kicker:'END TIME OFF EARLY',title:`End time off early for ${who}?`,copy:`${dates(row)}. Days before the first day back stay on the record as taken time off${paidHoursOf(row)>0?' and keep their paid hours':''}. The rest is released from the schedule.`,confirmLabel:'End time off early',danger:true,
    fields:[{name:'endedEarlyFrom',label:'First day back',type:'date',min:deps.today||'',value:deps.today||''},{name:'note',label:'Note (optional)',type:'textarea',maxlength:300,required:false}]});
  if(!input)return null;
  return run({action:'end',requestId:crypto.randomUUID(),id:row.id,endedEarlyFrom:input.endedEarlyFrom,...(input.note?{note:input.note}:{})},deps,()=>'Time off ended early');
}
// A manager changes what approved time off pays at any time; the schedule does not change. Days from an early end on were released and are not paid.
async function payDialog(row,deps){
  if(!row||!deps.manager||row.type!=='time_off'||state(row)!=='approved')return null;
  const who=row.employeeName||row.employee||'this employee',cutoff=validDate(row.endedEarlyFrom)?row.endedEarlyFrom:'',days=span(row).filter(date=>!cutoff||date<cutoff),before=paidHoursOf(row);
  const exported=' If payroll for these days was already exported, correct it there too.';
  const paid=await choosePay(row,days,deps,{kicker:'CHANGE PAY',title:`Change pay for ${who}?`,copy:`${dates(row)}${cutoff?`, back ${cutoff}`:''}. Paid now: ${plural(before,'hour')}. The schedule does not change.`,confirmLabel:'Review pay',note:true,
    schedule:'The schedule does not change.',saving:'Nothing is saved until you confirm the paid hours.',none:'Choose which days are paid, or make the time off unpaid.',onlyUnpaid:'This time off has dates that need review, so it can only be made unpaid.',
    total:total=>`Save ${plural(total,'paid hour')}`,summary:`They replace the ${plural(before,'paid hour')} on the timesheet now.${exported}`,
    unpaid:{title:`Make this time off unpaid for ${who}?`,copy:`${dates(row)}. ${before>0?`Its ${plural(before,'paid hour')} are removed from the timesheet.`:'It has no paid hours now.'}${exported}`,confirmLabel:'Make unpaid'}});
  if(!paid)return null;
  return run({action:'amend',requestId:crypto.randomUUID(),id:row.id,...paid},deps,data=>`Pay saved: ${plural(Number(data.request.paidHours)||0,'paid hour')}`);
}
async function retryPending(deps){const body=pending();if(!body)return null;return run(body,deps,data=>body.action==='approve'&&state(data.request)==='approved'?approved(data):'Request confirmed');}
async function discardPending(deps){
  if(!pending())return;
  const confirm=await deps.askAction({kicker:'UNCONFIRMED REQUEST',title:'Discard the unconfirmed change?',copy:'It may already be saved. Check the request list after it refreshes before sending it again.',confirmLabel:'Discard',danger:true,fields:[]});
  if(!confirm)return;
  forget();deps.saved?.(null);
}
/** What this viewer may do with one request; the server enforces the same rules.
 * options: {manager, today (Denver YYYY-MM-DD), owned(row)} */
function actionsFor(row,options){
  const status=state(row),manager=options?.manager===true,today=String(options?.today||''),own=manager||options?.owned?.(row)===true,start=String(row?.startDate||''),list=[];
  if(!validDate(today)||!own)return list;
  if(status==='pending'){if(manager)list.push('approve','deny');list.push('cancel');}
  else if(status==='approved'&&row.type!=='time_off'){if(manager)list.push('cancel');}
  else if(status==='approved'&&validDate(start)){
    // Time off has started on its first day: from then on a manager ends it early instead of cancelling it.
    if(start>today)list.push('cancel');
    if(manager&&start<=today&&lastDay(row)>=today)list.push('end');
  }
  // What approved time off pays can be corrected at any time, as payroll allowed before the workflow.
  if(manager&&status==='approved'&&row.type==='time_off')list.push('pay');
  return list;
}
function deps(){const o=S.options||{};return{askAction:o.askAction,manager:o.manager===true,today:o.today,toast:o.toast,saved:o.saved};}
async function busy(task){if(S.busy)return;S.busy=true;draw();try{await task(deps());}finally{S.busy=false;draw();}}
const lastNote=row=>Array.isArray(row?.decisions)?String(row.decisions.at(-1)?.note||''):'';
function card(row,locked){
  const status=state(row),paidHours=paidHoursOf(row),note=lastNote(row);
  const detail=[dates(row),row.reason||'No details',paidHours>0?`Paid ${paidHours} h`:'',validDate(row.endedEarlyFrom)?`Ended early, back ${row.endedEarlyFrom}`:'',note?`Note: ${note}`:''].filter(Boolean).join(' · ');
  const labels={approve:'Approve',deny:'Deny',cancel:'Cancel',end:'End early',pay:'Edit pay'},tasks={approve:d=>reviewDialog(row,'approved',d),deny:d=>reviewDialog(row,'denied',d),cancel:d=>cancelDialog(row,d),end:d=>endDialog(row,d),pay:d=>payDialog(row,d)};
  return h('article',{'data-request-id':row.id},
    h('div',{},h('span',{},(row.type==='time_off'?'TIME OFF':row.type==='shift_change'?'SHIFT CHANGE':'REQUEST')),h('h3',{},row.employeeName||row.employee||'Employee'),h('p',{},detail)),
    h('div',{},h('span',{class:'ops-status '+(status==='approved'?'good':status==='denied'?'warn':'info')},status),actionsFor(row,S.options).map(name=>h('button',{type:'button',disabled:locked,onclick:()=>busy(tasks[name])},labels[name]))));
}
function draw(){
  const host=S.host,o=S.options;if(!host||!o)return;
  const saved=pending(),locked=S.busy||Boolean(saved);
  const rows=[...(Array.isArray(o.rows)?o.rows:[])].filter(row=>row&&typeof row==='object').sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))||String(a.id||'').localeCompare(String(b.id||'')));
  host.replaceChildren(...[
    saved&&h('div',{class:'ops-pto-pending',role:'alert'},h('p',{},'Your last request change has not been confirmed. Retry it before sending another.'),
      h('div',{},h('button',{type:'button',class:'ops-button primary',disabled:S.busy,onclick:()=>busy(retryPending)},'Retry original save'),h('button',{type:'button',class:'ops-button',disabled:S.busy,onclick:()=>busy(discardPending)},'Discard'))),
    h('div',{class:'ops-page-actions ops-request-actions'},
      h('button',{type:'button',class:'ops-button primary',disabled:locked,onclick:()=>busy(d=>submitDialog('time_off',d))},'Request time off'),
      h('button',{type:'button',class:'ops-button',onclick:()=>o.go?.('availability')},'Open time-off calendar'),
      h('button',{type:'button',class:'ops-button',disabled:locked,onclick:()=>busy(d=>submitDialog('shift_change',d))},'Request shift change')),
    rows.length?h('div',{class:'ops-request-list','aria-busy':S.busy?'true':'false'},rows.map(row=>card(row,locked)))
      :h('div',{class:'ops-empty'},h('span',{},'EGC'),h('h3',{},'No requests'),h('p',{},'Time-off and shift-change requests will appear here after they are sent.'))].filter(Boolean));
}
/** options: {rows, manager, today, owned(row), askAction, toast(message), saved(request|null), go(view)} */
function mount(host,options){if(!host){unmount();return;}S.host=host;S.options=options||{};draw();}
function unmount(){S.host=null;S.options=null;}
window.addEventListener('egc:signout',()=>{unmount();try{for(let i=sessionStorage.length-1;i>=0;i--){const name=sessionStorage.key(i);if(name?.startsWith(prefix))sessionStorage.removeItem(name);}}catch{}});
window.EGCPto={mount,unmount,actionsFor,pending,send,submitDialog,reviewDialog,cancelDialog,endDialog,payDialog,retryPending,discardPending};
})();
