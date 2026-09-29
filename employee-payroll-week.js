/* Payroll week: paid hours and gross pay per employee from /api/timesheets, and the payroll CSV download.
   Other employees' pay is owner-only by default; the server marks it payHidden and it shows as "Pay hidden", never $0. */
(function(){
'use strict';
const API='/api/timesheets',STALE=5*60000,RETRY=60000,TIMEOUT=25000;
const REASONS={week_in_progress:'the week is not over',needs_review:'some timecards need review',unattributed_records:'undated timecards need review',open_shifts:'shifts are still open',pending_timecards:'timecards are waiting for approval',adjacent_unapproved_time:'unapproved time touches this week',missing_rate:'a pay rate is missing',missing_pto_rate:'a paid time-off rate is missing',non_hourly_pay_type:'a timecard is not hourly'};
const S={host:null,root:null,key:'',startDate:'',version:'',data:null,loadedAt:0,loading:false,error:'',exporting:false,exportError:'',acknowledge:[],notice:'',generation:0,epoch:0,controller:null};
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
async function download(acknowledge){
  const data=S.data;
  if(S.exporting||!data||data.payVisibility==='own')return;
  const epoch=S.epoch;S.exporting=true;S.exportError='';S.notice='';S.acknowledge=[];render();
  try{
    const query=new URLSearchParams({view:'week',start:data.weekStart,format:'csv'});if(acknowledge?.length)query.set('acknowledge',acknowledge.join(','));
    const response=await request(API+'?'+query,{cache:'no-store'});
    if(epoch!==S.epoch)return;
    if(!response.ok){
      const body=await response.json().catch(()=>({}));
      if(epoch!==S.epoch)return;
      if(body.code==='pay_owner_only'){if(S.data)S.data={...S.data,payVisibility:'own'};return;}
      const blocking=Array.isArray(body.details?.blocking)?body.details.blocking:[],allowed=Array.isArray(body.details?.acknowledgeable)?body.details.acknowledgeable:[];
      S.exportError=body.error||'The payroll export is unavailable. Retry shortly.';
      if(response.status===409&&blocking.length&&blocking.every(reason=>allowed.includes(reason)&&Object.hasOwn(REASONS,reason)))S.acknowledge=blocking;
      return;
    }
    const blob=await response.blob();
    if(epoch!==S.epoch)return;
    const named=/filename="(egc-payroll-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv)"/.exec(response.headers.get('Content-Disposition')||'');
    save(blob,named?named[1]:`egc-payroll-${data.weekStart}-to-${data.weekEnd}.csv`);
    S.notice=`Payroll CSV for ${day(data.weekStart)} – ${day(data.weekEnd)} downloaded${acknowledge?.length?' with its pay-review flags':''}.`;
  }catch{if(epoch===S.epoch)S.exportError='The payroll export did not download. Retry shortly.';}
  finally{if(epoch===S.epoch){S.exporting=false;render();}}
}
const pay=item=>item.payHidden===true?h('span',{class:'pw-hidden',title:'Only the owner sees other employees’ pay'},'Pay hidden'):money(item.grossPay);
function summary(d){
  const reasons=d.coverage.reasons.map(reason=>REASONS[reason]||String(reason).replace(/_/g,' '));
  const detail=row=>[hours(row.totalPaidHours)+' paid h',row.overtimeHours?hours(row.overtimeHours)+' overtime':'',row.ptoHours?hours(row.ptoHours)+' time off':''].filter(Boolean).join(' · ');
  return[
    h('p',{class:'pw-muted'},`${day(d.weekStart)} – ${day(d.weekEnd)} · `+(d.coverage.complete?'Every timecard is settled.':`Not final: ${reasons.join('; ')}.`)),
    d.employees.length?h('ul',{class:'pw-rows'},d.employees.map(row=>h('li',{class:'pw-row'},h('div',{class:'pw-person'},h('b',{},row.name||row.employee),h('small',{},detail(row))),h('strong',{class:'pw-pay'},pay(row))))):h('p',{class:'pw-muted'},'No approved time in this week yet.'),
    h('div',{class:'pw-row pw-total'},h('div',{class:'pw-person'},h('b',{},'Total'),h('small',{},detail(d.totals))),h('strong',{class:'pw-pay'},pay(d.totals))),
    d.payHidden===true?h('p',{class:'pw-muted'},'Other employees’ pay is shown to the owner only. Hours, overtime and approvals are shown as usual.'):null,
  ];
}
function actions(d){
  const items=[];
  if(S.exportError)items.push(h('div',{class:'pw-notice error',role:'alert'},S.exportError));
  if(S.notice)items.push(h('div',{class:'pw-notice',role:'status'},S.notice));
  if(d.payVisibility==='own')items.push(h('p',{class:'pw-muted'},'Only the owner can download the payroll export.'));
  else items.push(h('div',{class:'pw-actions'},h('button',{type:'button',class:'pw-button primary',disabled:S.exporting,onclick:()=>void download()},S.exporting?'Preparing…':'Download payroll CSV'),
    S.acknowledge.length?h('button',{type:'button',class:'pw-button',disabled:S.exporting,onclick:()=>void download(S.acknowledge)},'Export with these flags'):null));
  return h('div',{class:'pw-feedback','aria-live':'polite'},items);
}
function render(){
  if(!S.root)return;
  const head=h('div',{class:'pw-head'},h('div',{},h('span',{class:'pw-eyebrow'},'PAYROLL WEEK'),h('h2',{},'Paid hours and gross pay')),h('button',{type:'button',class:'pw-button',disabled:S.loading||S.exporting,onclick:()=>void load()},S.loading?'Checking…':'Refresh'));
  const body=S.data?[...summary(S.data),actions(S.data)]:S.loading?[h('div',{class:'pw-skeleton','aria-hidden':'true'}),h('div',{class:'pw-skeleton short','aria-hidden':'true'}),h('p',{class:'pw-muted',role:'status'},'Loading the payroll week…')]
    :[h('div',{class:'pw-notice error',role:'alert'},S.error||'The payroll week has not loaded.'),h('div',{class:'pw-actions'},h('button',{type:'button',class:'pw-button primary',onclick:()=>void load()},'Retry'))];
  S.root.replaceChildren(head,...body.filter(Boolean));
}
function reset(){S.generation++;S.epoch++;S.controller?.abort();Object.assign(S,{key:'',startDate:'',version:'',data:null,loadedAt:0,loading:false,error:'',exporting:false,exportError:'',acknowledge:[],notice:''});}
// The suite rebuilds the timesheet screen on background refreshes: the same section moves into the rebuilt
// screen (after its timecard note). The week is reread when the suite's timecards or requests changed (an approval
// below, a clock-out), even over a load already in flight, which may predate the change; otherwise a loaded week is
// reused for five minutes and a failed load is retried after a minute. A reread never cancels a CSV download.
function mount(host,options={}){
  if(!host)return;
  const startDate=validDate(options.startDate)?options.startDate:'',key=String(options.identity||'')+'|'+startDate,version=signature(options.timecards,options.requests);
  if(key!==S.key){reset();S.key=key;S.startDate=startDate;S.version=version;}
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
