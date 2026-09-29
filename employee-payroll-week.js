/* Payroll week: paid hours and gross pay per employee from /api/timesheets, and the payroll CSV download.
   Other employees' pay is owner-only by default; the server marks it payHidden and it shows as "Pay hidden", never $0.
   These are the Time approvals totals (TIME-CORRECT): regular and overtime hours and gross from the server's overtime
   rules. Pending and open time is listed beside them as "Not in totals", never added in. The owner also downloads the
   week's Gusto hours file here (GUSTO-EXPORT, format=gusto): the server builds it from the same week. */
(function(){
'use strict';
const API='/api/timesheets',STALE=5*60000,RETRY=60000,TIMEOUT=25000;
const REASONS={week_in_progress:'the week is not over',needs_review:'some timecards need review',unattributed_records:'undated timecards need review',open_shifts:'shifts are still open',pending_timecards:'timecards are waiting for approval',adjacent_unapproved_time:'unapproved time touches this week',missing_rate:'a pay rate is missing',missing_pto_rate:'a paid time-off rate is missing',non_hourly_pay_type:'a timecard is not hourly'};
// The two files the card downloads. Each is the server's file byte for byte; the name falls back to the server's pattern.
const FILES={csv:{format:'csv',label:'Payroll CSV',noun:'payroll export',button:'Download payroll CSV',name:/filename="(egc-payroll-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv)"/,fallback:d=>`egc-payroll-${d.weekStart}-to-${d.weekEnd}.csv`},
  gusto:{format:'gusto',label:'Gusto hours file',noun:'Gusto hours file',button:'Download Gusto hours',name:/filename="(egc-gusto-hours-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv)"/,fallback:d=>`egc-gusto-hours-${d.weekStart}-to-${d.weekEnd}.csv`}};
const S={host:null,root:null,key:'',startDate:'',version:'',owner:false,gustoRefused:false,data:null,loadedAt:0,loading:false,error:'',exporting:'',exportError:'',acknowledge:[],acknowledgeFor:'',notice:'',generation:0,epoch:0,controller:null};
function h(tag,props,...children){const node=document.createElement(tag);for(const [name,value]of Object.entries(props||{})){if(value==null||value===false)continue;if(name==='class')node.className=value;else if(name.startsWith('on')&&typeof value==='function')node.addEventListener(name.slice(2),value);else if(name in node&&!name.startsWith('aria-')&&name!=='role')node[name]=value;else node.setAttribute(name,String(value));}for(const child of children.flat())if(child!=null&&child!==false)node.append(child instanceof Node?child:String(child));return node;}
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const validDate=date=>typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&new Date(date+'T12:00:00Z').toISOString().slice(0,10)===date;
const day=date=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z'));
const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(value);
const hours=value=>Number(value).toFixed(2);
const request=(url,init)=>typeof hubFetch==='function'?hubFetch(url,init):fetch(url,{...init,credentials:'same-origin'});
// Pay is a number or explicitly hidden. Anything else is an unverified response, never shown as $0.
const payShape=item=>Boolean(item)&&(item.payHidden===true?item.grossPay==null:finite(item.grossPay));
function valid(data){return Boolean(data&&data.ok===true&&validDate(data.weekStart)&&validDate(data.weekEnd)&&Array.isArray(data.employees)&&data.employees.every(row=>row&&typeof row.employee==='string'&&typeof row.name==='string'&&finite(row.totalPaidHours)&&finite(row.overtimeHours)&&finite(row.ptoHours)&&payShape(row))&&data.totals&&finite(data.totals.totalPaidHours)&&payShape(data.totals)&&data.coverage&&typeof data.coverage.complete==='boolean'&&Array.isArray(data.coverage.reasons)&&[undefined,'own'].includes(data.payVisibility));}
// What the week is computed from, as the suite last read it: an approval, an edit, a clock-out or a reviewed
// request changes this and rereads the week. A shift still open (its location pings) does not.
const records=value=>Array.isArray(value)?value.filter(Boolean):[];
const signature=(timecards,requests)=>JSON.stringify([records(timecards).map(e=>[e.id,e.status,e.approvalStatus,e.clockOutAt?e.updatedAt:'']),records(requests).map(r=>[r.id,r.status,r.updatedAt])]);
async function load(){
  if(!S.root||!S.startDate)return;
  const generation=++S.generation;S.controller?.abort();const controller=S.controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);
  S.loading=true;S.error='';render();
  try{
    const response=await request(API+'?'+new URLSearchParams({view:'week',start:S.startDate}),{cache:'no-store',signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    if(generation!==S.generation)return;
    if(!response.ok||data.ok!==true)throw new Error(data.error||'The payroll week is unavailable. Retry shortly.');
    if(!valid(data))throw new Error('The payroll week came back incomplete. Retry before relying on it.');
    S.data=data;
  }catch(error){if(generation!==S.generation)return;S.data=null;S.error=error.name==='AbortError'?'The payroll week did not respond. Retry shortly.':error.message||'The payroll week is unavailable. Retry shortly.';}
  finally{clearTimeout(timer);if(generation===S.generation){S.loading=false;S.loadedAt=Date.now();render();}}
}
function save(blob,name){const url=URL.createObjectURL(blob),link=h('a',{href:url,download:name,hidden:true});document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
// The Gusto file is the owner's (the suite says so, and the server decides): a refusal hides its button.
const canDownload=(kind,data)=>kind==='csv'?data.payVisibility!=='own':kind==='gusto'&&S.owner&&!S.gustoRefused;
// The Gusto file has hours only: timecard bonuses and tips the owner can see in this week are named so they are not lost.
function extras(d){
  const parts=[finite(d.totals.bonus)&&d.totals.bonus>0?money(d.totals.bonus)+' in timecard bonuses':'',finite(d.totals.tips)&&d.totals.tips>0?money(d.totals.tips)+' in timecard tips':''].filter(Boolean);
  return parts.length?` This week also has ${parts.join(' and ')}: they are not in the Gusto file, so enter them in Gusto from the payroll CSV.`:'';
}
// Who the server left out of the Gusto file as not paid through Gusto (X-EGC-Gusto-Not-Included: URI-encoded JSON of
// {employee,name}). An unreadable header is reported as such rather than read as nobody.
function leftOut(value){
  if(!value)return'';
  let list=null;try{list=JSON.parse(decodeURIComponent(value));}catch{}
  const names=Array.isArray(list)&&list.every(item=>item&&typeof item.employee==='string'&&typeof item.name==='string')?list.map(item=>item.name||item.employee):null;
  return names?(names.length?` Left out as not paid through Gusto (the payroll CSV has their hours): ${names.join(', ')}.`:''):' Some employees were left out as not paid through Gusto; the payroll CSV has their hours.';
}
async function download(kind,acknowledge){
  const data=S.data,file=FILES[kind];
  if(S.exporting||!data||!file||!canDownload(kind,data))return;
  const epoch=S.epoch;S.exporting=kind;S.exportError='';S.notice='';S.acknowledge=[];S.acknowledgeFor='';render();
  try{
    const query=new URLSearchParams({view:'week',start:data.weekStart,format:file.format});if(acknowledge?.length)query.set('acknowledge',acknowledge.join(','));
    const response=await request(API+'?'+query,{cache:'no-store'});
    if(epoch!==S.epoch)return;
    if(!response.ok){
      const body=await response.json().catch(()=>({}));
      if(epoch!==S.epoch)return;
      if(body.code==='pay_owner_only'){if(kind==='gusto'){S.gustoRefused=true;S.exportError=body.error||'Only the owner can download the Gusto hours file.';}else if(S.data)S.data={...S.data,payVisibility:'own'};return;}
      const blocking=Array.isArray(body.details?.blocking)?body.details.blocking:[],allowed=Array.isArray(body.details?.acknowledgeable)?body.details.acknowledgeable:[];
      S.exportError=body.error||`The ${file.noun} is unavailable. Retry shortly.`;
      if(response.status===409&&blocking.length&&blocking.every(reason=>allowed.includes(reason)&&Object.hasOwn(REASONS,reason))){S.acknowledge=blocking;S.acknowledgeFor=kind;}
      return;
    }
    const blob=await response.blob();
    if(epoch!==S.epoch)return;
    const named=file.name.exec(response.headers.get('Content-Disposition')||'');
    save(blob,named?named[1]:file.fallback(data));
    S.notice=`${file.label} for ${day(data.weekStart)} – ${day(data.weekEnd)} downloaded${acknowledge?.length?' with its pay-review flags':''}.${kind==='gusto'?leftOut(response.headers.get('X-EGC-Gusto-Not-Included'))+extras(data):''}`;
  }catch{if(epoch===S.epoch)S.exportError=`The ${file.noun} did not download. Retry shortly.`;}
  finally{if(epoch===S.epoch){S.exporting='';render();}}
}
const pay=item=>item.payHidden===true?h('span',{class:'pw-hidden',title:'Only the owner sees other employees’ pay'},'Pay hidden'):money(item.grossPay);
const plural=(count,word)=>`${count} ${word}${count===1?'':'s'}`;
// Pending and open time as the server measured it (an open shift up to now); an older response without the hours gives counts only.
function unapproved(pending,pendingHours,open,openHours){
  const parts=[pending?`${finite(pendingHours)?hours(pendingHours)+' h in ':''}${plural(pending,'pending timecard')}`:'',open?`${plural(open,'open shift')}${finite(openHours)?` (${hours(openHours)} h so far)`:''}`:''].filter(Boolean);
  return parts.length?h('small',{class:'pw-excluded'},'Not in totals: '+parts.join(' · ')):null;
}
function summary(d){
  const reasons=d.coverage.reasons.map(reason=>REASONS[reason]||String(reason).replace(/_/g,' '));
  const detail=row=>[hours(row.totalPaidHours)+' paid h',finite(row.regularHours)?hours(row.regularHours)+' regular':'',row.overtimeHours?hours(row.overtimeHours)+' overtime':'',row.ptoHours?hours(row.ptoHours)+' time off':''].filter(Boolean).join(' · ');
  const excluded=d.excluded||{},excludedHours=d.excludedHours||{};
  return[
    h('p',{class:'pw-muted'},`${day(d.weekStart)} – ${day(d.weekEnd)} · `+(d.coverage.complete?'Every timecard is settled.':`Not final: ${reasons.join('; ')}.`)),
    d.employees.length?h('ul',{class:'pw-rows'},d.employees.map(row=>h('li',{class:'pw-row'},h('div',{class:'pw-person'},h('b',{},row.name||row.employee),h('small',{},detail(row)),unapproved(row.pendingExcludedTimecards,row.pendingExcludedHours,row.openShifts,row.openHours)),h('strong',{class:'pw-pay'},pay(row))))):h('p',{class:'pw-muted'},'No approved time in this week yet.'),
    h('div',{class:'pw-row pw-total'},h('div',{class:'pw-person'},h('b',{},'Total'),h('small',{},detail(d.totals)),unapproved(excluded.pending,excludedHours.pending,excluded.open,excludedHours.open)),h('strong',{class:'pw-pay'},pay(d.totals))),
    d.payHidden===true?h('p',{class:'pw-muted'},'Other employees’ pay is shown to the owner only. Hours, overtime and approvals are shown as usual.'):null,
  ];
}
function actions(d){
  const items=[],csv=canDownload('csv',d),gusto=canDownload('gusto',d);
  const button=(kind,primary)=>h('button',{type:'button',class:'pw-button'+(primary?' primary':''),disabled:Boolean(S.exporting),onclick:()=>void download(kind)},S.exporting===kind?'Preparing…':FILES[kind].button);
  if(S.exportError)items.push(h('div',{class:'pw-notice error',role:'alert'},S.exportError));
  if(S.notice)items.push(h('div',{class:'pw-notice',role:'status'},S.notice));
  if(!csv)items.push(h('p',{class:'pw-muted'},'Only the owner can download the payroll export.'));
  if(csv||gusto)items.push(h('div',{class:'pw-actions'},csv?button('csv',true):null,gusto?button('gusto',!csv):null,
    S.acknowledge.length&&canDownload(S.acknowledgeFor,d)?h('button',{type:'button',class:'pw-button',disabled:Boolean(S.exporting),onclick:()=>void download(S.acknowledgeFor,S.acknowledge)},'Export with these flags'):null));
  if(gusto)items.push(h('p',{class:'pw-muted pw-gusto-note'},'Gusto hours: one row per employee, keyed by the Gusto employee ID in the staff directory, with regular, overtime, double-time and paid time off hours. Import it in Gusto; bonuses and tips are not in it, nor anyone marked not paid through Gusto there.'));
  return h('div',{class:'pw-feedback','aria-live':'polite'},items);
}
function render(){
  if(!S.root)return;
  const head=h('div',{class:'pw-head'},h('div',{},h('span',{class:'pw-eyebrow'},'PAYROLL WEEK'),h('h2',{},'Paid hours and gross pay')),h('button',{type:'button',class:'pw-button',disabled:S.loading||S.exporting,onclick:()=>void load()},S.loading?'Checking…':'Refresh'));
  const body=S.data?[...summary(S.data),actions(S.data)]:S.loading?[h('div',{class:'pw-skeleton','aria-hidden':'true'}),h('div',{class:'pw-skeleton short','aria-hidden':'true'}),h('p',{class:'pw-muted',role:'status'},'Loading the payroll week…')]
    :[h('div',{class:'pw-notice error',role:'alert'},S.error||'The payroll week has not loaded.'),h('div',{class:'pw-actions'},h('button',{type:'button',class:'pw-button primary',onclick:()=>void load()},'Retry'))];
  S.root.replaceChildren(head,...body.filter(Boolean));
}
function reset(){S.generation++;S.epoch++;S.controller?.abort();Object.assign(S,{key:'',startDate:'',version:'',owner:false,gustoRefused:false,data:null,loadedAt:0,loading:false,error:'',exporting:'',exportError:'',acknowledge:[],acknowledgeFor:'',notice:''});}
// The suite rebuilds the timesheet screen on background refreshes: the same section moves into the rebuilt
// screen (after its timecard note). The week is reread when the suite's timecards or requests changed (an approval
// below, a clock-out), even over a load already in flight, which may predate the change; otherwise a loaded week is
// reused for five minutes and a failed load is retried after a minute. A reread never cancels a CSV download.
// options.owner (the suite's owner grant) shows the Gusto hours button; the server still refuses anyone else (403).
function mount(host,options={}){
  if(!host)return;
  const startDate=validDate(options.startDate)?options.startDate:'',key=String(options.identity||'')+'|'+startDate,version=signature(options.timecards,options.requests);
  if(key!==S.key){reset();S.key=key;S.startDate=startDate;S.version=version;}
  S.owner=options.owner===true;
  S.root=S.root||h('section',{class:'egc-payroll-week ops-card','aria-label':'Payroll week'});
  if(S.host!==host||!S.root.isConnected){S.host=host;const anchor=host.querySelector(':scope > .ops-boundary');if(anchor)anchor.after(S.root);else host.append(S.root);}
  render();
  const changed=version!==S.version;S.version=version;
  if(changed||!S.loading&&(!S.loadedAt||Date.now()-S.loadedAt>(S.data?STALE:RETRY)))void load();
}
function unmount(){S.root?.remove();S.root=null;S.host=null;}
window.addEventListener('egc:signout',()=>{reset();unmount();});
window.EGCPayrollWeek={mount,unmount,refresh:()=>load(),canLeave:()=>!S.exporting};
})();
