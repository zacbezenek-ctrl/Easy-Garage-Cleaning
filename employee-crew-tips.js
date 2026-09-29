/* Customer card tips for the Time approvals week (TIPS). Each tipped job's card tips are split by the crew's recorded
   job work minutes (GET /api/tip-allocation, which does all the math), and the tip CSV for the same payroll week sits
   beside the timesheet exports: the timesheet and Gusto files never include card tips. Read-only; managers only.
   Shown only while customer tips are on: a cheap probe (GET /api/tip-allocation?config=tips, which reads no job or
   timecard) decides first, so with CUSTOMER_TIPS_ENABLED unset Time approvals looks as before and scans no job or
   timecard: its only addition is that one probe per signed-in manager (retried after 30 seconds if it fails).
   Tipped card charges held for a person (paid after the job closed, refunded in Stripe, or over the balance) are not
   listed or resolved here: Hub > Review queues is the one place for every held charge, tipped or not. A refund is known
   only once Stripe reports it (charge.refunded) or a return reads it, and disputes are never read, so the card tells the
   manager to check Stripe before exporting. */
(function(){
'use strict';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const SLOT='ops-crew-tips',DATE=/^\d{4}-\d{2}-\d{2}$/;
const REASONS={
  tips_unknown:'A tip on a job could not be read. Review that job’s payment record before exporting.',
  no_job_time:'A tipped job has no recorded crew work time. Its tips can be exported as unassigned and paid by hand.',
  untracked_job_time:'Crew time on a tipped job was not tracked to that job (no Start job time, no job tracking, or someone assigned to it has no job time on it), so its tips are held unassigned for you to pay by hand.',
  needs_review:'A timecard on a tipped job needs review.',
  open_shifts:'A shift on a tipped job is still open.',
  pending_timecards:'A timecard on a tipped job is waiting for approval.',
  tip_refund_open:'Stripe shows a refund on a tipped card charge that the owner has not settled yet. Settle it in Review queues and correct the job’s tip before exporting.',
  tip_refunded:'A tipped card charge was recorded as refunded, and its job still lists the tip. It is held unassigned: pay it by hand only if it is still owed.',
};
let context=null,state={},revision=0;
// Whether tips are on, per signed-in manager: null until the probe answers; a failed probe is retried after 30 seconds.
const unknownConfig=identity=>({identity,enabled:null,checkedAt:0,pending:false});
let config=unknownConfig(null);
const slot=()=>document.getElementById(SLOT);
const shown=()=>config.enabled===true;
const usd=cents=>Number.isSafeInteger(cents)?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100):'—';
const addDays=(date,count)=>new Date(Date.parse(date+'T12:00:00Z')+count*86400000).toISOString().slice(0,10);
const reset=()=>{revision++;context=null;state={data:null,loading:false,busy:false,error:'',notice:'',loadedAt:0};const host=slot();if(host)host.innerHTML='';};
reset();
// Payroll weeks run Monday to Sunday; the tip read takes the Monday and an exclusive end one week later.
const query=(captured,extra={})=>new URLSearchParams({start:captured.startDate,end:addDays(captured.startDate,7),...extra}).toString();
const valid=data=>Boolean(data&&Array.isArray(data.jobs)&&Array.isArray(data.employees)&&data.totals&&Number.isSafeInteger(data.totals.tipCents)&&data.coverage&&Array.isArray(data.coverage.reasons));
function draw(){
  const host=slot();if(!host||!context)return;
  if(!shown()){host.innerHTML='';return;}
  const data=state.data,busy=state.loading||state.busy;
  let content;
  if(!data)content=`<p>${esc(state.loading?'Checking customer card tips…':'Customer card tips have not been checked for this week.')}</p>`;
  else if(!data.jobs.length)content='<p>No customer card tips were received this week.</p>';
  else{
    const totals=data.totals,reasons=data.coverage.reasons;
    content=`<div class="ops-crew-tips-totals"><div><span>Received</span><strong>${esc(usd(totals.tipCents))}</strong></div><div><span>Split to crew</span><strong>${esc(usd(totals.allocatedCents))}</strong></div><div><span>Unassigned</span><strong>${esc(usd(totals.unallocatedCents))}</strong></div></div>`
      +(reasons.length?`<div class="ops-crew-tips-warning" role="status"><strong>Before exporting tips</strong><ul>${reasons.map(reason=>`<li>${esc(REASONS[reason]||reason)}</li>`).join('')}</ul></div>`:'')
      +(data.employees.length?`<div class="ops-crew-tips-rows">${data.employees.map(person=>`<article><div><strong>${esc(person.name||person.employee)}</strong><small>${esc(person.minutes)} job minutes · ${esc(person.jobs)} job${person.jobs===1?'':'s'}</small></div><strong>${esc(usd(person.tipCents))}</strong></article>`).join('')}</div>`:'')
      +`<details class="ops-crew-tips-jobs"><summary>${data.jobs.length} tipped job${data.jobs.length===1?'':'s'}</summary>${data.jobs.map(job=>{const missing=Array.isArray(job.crewWithoutJobTime)?job.crewWithoutJobTime.filter(name=>typeof name==='string'&&name):[];return`<article><div><strong>${esc(job.customer||job.jobId)}</strong><small>${esc(job.serviceDate||'No service date')} · ${esc(job.workMinutes)} crew job minutes</small></div><div><strong>${esc(usd(job.tipCents))}</strong><small>${job.unallocatedCents?`${esc(usd(job.unallocatedCents))} unassigned`:'Split to crew'}</small></div>${job.reasons.length?`<p>${job.reasons.map(reason=>esc(REASONS[reason]||reason)).join(' ')}</p>`:''}${missing.length?`<p>Assigned but no job time on this job: ${esc(missing.join(', '))}</p>`:''}</article>`}).join('')}</details>`;
  }
  host.innerHTML=`<section class="ops-card ops-crew-tips"><div class="ops-card-head"><div><span class="ops-eyebrow">CUSTOMER CARD TIPS</span><h2>Crew tips for this payroll week</h2></div><div class="ops-crew-tips-actions"><button class="ops-button" onclick="egcCrewTipsRefresh()" ${busy?'disabled':''}>${state.loading?'Checking…':'Refresh tips'}</button><button class="ops-button primary" onclick="egcCrewTipsDownload()" ${busy||!data?.jobs?.length?'disabled':''}>${state.busy?'Preparing…':'Download tips CSV'}</button></div></div><p class="ops-note">Tips customers added to card payments received this week (Denver time), split by each crew member’s recorded job work minutes. The timesheet and Gusto files do not include them: pay them with this week’s payroll from this file.</p>${state.error?`<p class="ops-crew-tips-warning" role="alert">${esc(state.error)}</p>`:''}${state.notice?`<p role="status">${esc(state.notice)}</p>`:''}${content}<p class="ops-note">Tipped card charges held for review are resolved with every other held charge in Hub › Review queues. A refund reaches this list when Stripe reports it to the Hub (the charge.refunded webhook) or a payment page sees it; a dispute never does. Check Stripe for refunded or disputed tipped charges before exporting tips.</p></section>`;
}
async function probe(){
  if(!context||config.pending)return;
  const current=config;current.pending=true;
  try{
    const response=await hubFetch('/api/tip-allocation?config=tips',{cache:'no-store'}),data=await response.json().catch(()=>({}));
    if(response.ok&&data.ok===true&&typeof data.tips?.enabled==='boolean')current.enabled=data.tips.enabled;
  }catch(error){/* Unknown: nothing is shown, and the probe is retried on a later render. */}
  finally{current.pending=false;current.checkedAt=Date.now();}
  // The week may have changed while the probe ran; the section loads whichever week is shown now.
  if(current!==config||!context||!shown())return;
  draw();load();
}
async function load(){
  if(!context||!shown()||state.loading||state.busy)return;
  const current=++revision,captured=context;
  state.loading=true;state.error='';draw();
  try{
    const response=await hubFetch('/api/tip-allocation?'+query(captured),{cache:'no-store'}),data=await response.json().catch(()=>({}));
    if(current!==revision||captured!==context)return;
    if(!response.ok||data.ok!==true)throw new Error(data.error||'Customer card tips could not be read. Refresh to try again.');
    if(!valid(data))throw new Error('Customer card tips came back incomplete. Refresh before exporting them.');
    state.data=data;state.loadedAt=Date.now();
  }catch(error){if(current===revision&&captured===context){state.error=error.message;state.data=null;state.loadedAt=Date.now();}}
  finally{if(current===revision&&captured===context){state.loading=false;draw();}}
}
function save(text,name){
  const blob=new Blob([text],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
window.egcCrewTipsRefresh=()=>load();
// Like payroll, the file downloads only when every share is final. When the only gaps are tips the Hub cannot split
// (no or untracked job time), the manager may confirm exporting those tips as unassigned, to be paid by hand.
window.egcCrewTipsDownload=async()=>{
  if(!context||!shown()||state.busy||state.loading)return;
  const captured=context;state.busy=true;state.error='';state.notice='';draw();
  try{
    let acknowledge='';
    for(let attempt=0;attempt<2;attempt++){
      const response=await hubFetch('/api/tip-allocation?'+query(captured,{format:'csv',...(acknowledge?{acknowledge}:{})}),{cache:'no-store'});
      if(captured!==context)return;
      if(response.ok&&/^text\/csv/i.test(response.headers.get('Content-Type')||'')){
        save(await response.text(),`egc-customer-tips-${captured.startDate}-to-${addDays(captured.startDate,6)}.csv`);
        state.notice=acknowledge?'Tip CSV downloaded. Pay the unassigned tips by hand.':'Tip CSV downloaded.';
        return;
      }
      const body=await response.json().catch(()=>({})),details=body.details||{};
      const blocking=Array.isArray(details.blocking)?details.blocking:[],acknowledgeable=Array.isArray(details.acknowledgeable)?details.acknowledgeable:[];
      if(!acknowledge&&response.status===409&&body.code==='tip_allocation_incomplete'&&blocking.length&&blocking.every(reason=>acknowledgeable.includes(reason))){
        const approval=await captured.askAction({kicker:'CUSTOMER CARD TIPS',title:'Export with unassigned tips?',copy:String(body.error||'Some tips cannot be split from recorded job time.').slice(0,400),confirmLabel:'Export with unassigned tips',fields:[],note:'Those tips are listed as “Unassigned - pay by hand”. No share of them is paid automatically.'});
        if(!approval||captured!==context)return;
        acknowledge=blocking.join(',');continue;
      }
      throw new Error(body.error||'The tip CSV could not be downloaded. Refresh and try again.');
    }
  }catch(error){if(captured===context)state.error=error.message||'The tip CSV could not be downloaded. Refresh and try again.';}
  finally{if(captured===context){state.busy=false;draw();}}
};
window.EGCCrewTips={mount(options){
  if(!options||options.business!==true||!DATE.test(String(options.startDate||''))){reset();return;}
  if(config.identity!==options.identity)config=unknownConfig(options.identity);
  const changed=!context||context.identity!==options.identity||context.generation!==options.generation||context.startDate!==options.startDate;
  if(changed){reset();context=options;}else context.askAction=options.askAction;
  draw();
  if(!shown()){if(config.enabled===null&&!config.pending&&(!config.checkedAt||Date.now()-config.checkedAt>30000))probe();return;}
  if(!state.loading&&!state.busy&&(!state.loadedAt||Date.now()-state.loadedAt>30000))load();
}};
window.addEventListener('egc:signout',()=>{reset();config=unknownConfig(null);});
})();
