/* Tomorrow's readiness on the Hub home (READINESS): every customer job on the next Denver day with what still stops the
   crew from rolling out ready, so the team lead fixes it the evening before instead of in the driveway. Read-only: it reads
   the Dispatch board for that one day (GET /api/dispatch, the same answer and warnings Dispatch shows) and changes nothing.
   Mounted by the home-widget registry (employee-hub-screens.js HOME_WIDGETS) or standalone with
   EGCReadiness.mount(host, ctx). A failed load says unavailable, never "all ready". readinessReport() is the pure rule
   set (tests/readiness.test.mjs). Money and customer contact details are never shown. */
(function(){
'use strict';
const TZ='America/Denver',TIMEOUT=20000;
// Server warnings (functions/_lib/dispatch-service.js jobWarnings) that block a ready rollout, and those to check.
const BLOCKING={unassigned:'No crew assigned',sold_needs_crew:'Sold: needs crew',crew_size_short:'Fewer crew than needed',employee_unavailable:'Someone assigned is off or unavailable',
  schedule_overlap:'Crew or truck double-booked',inactive_assignment:'Someone assigned is no longer on the team',vehicle_unavailable:'Assigned truck is out of service',
  missing_address:'No job address',invalid_schedule:'Date or time needs review',segments_invalid:'Crew split could not be read',unverifiable_assignment:'Another booking for this crew has bad times'};
const CHECK={missing_crew_lead:'No crew lead chosen',missing_scope:'No work scope for the crew',travel_buffer_short:'Tight drive between jobs',needs_follow_up:'Open crew follow-up',segment_unassigned:'A crew split has nobody on it'};
const DONE=new Set(['completed','cancelled','canceled','no_show','archived']);
const S={host:null,root:null,ctx:{},generation:0,controller:null};
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const denverDate=at=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
const addDays=(date,days)=>{const at=new Date(date+'T12:00:00Z');at.setUTCDate(at.getUTCDate()+days);return at.toISOString().slice(0,10);};
const firstName=value=>String(value||'').trim().split(/\s+/)[0]||'Customer';

/** The next Denver day's customer jobs, each with blocking problems and things to check. board is a GET /api/dispatch answer. */
function readinessReport(board,date){
  if(!record(board)||!Array.isArray(board.jobs)||!Array.isArray(board.warnings)||!Array.isArray(board.roster)||!Array.isArray(board.vehicles))throw Object.assign(new Error('readiness_unverified'),{code:'readiness_unverified'});
  const people=new Map(board.roster.filter(record).map(person=>[String(person.id),String(person.name||person.id)]));
  const trucks=new Map(board.vehicles.filter(record).map(truck=>[String(truck.id),String(truck.name||truck.id)]));
  const jobs=board.jobs.filter(job=>record(job)&&job.type!=='walkthrough'&&job.type!=='blocked'&&job.type!=='availability'&&!DONE.has(String(job.status||'').toLowerCase())&&job.date&&job.date<=date&&(job.endDate||job.date)>=date);
  const rows=jobs.map(job=>{
    const blocking=[],check=[],seen=new Set();
    for(const warning of board.warnings){
      if(!record(warning)||warning.jobId!==job.id||seen.has(warning.code))continue;
      seen.add(warning.code);
      if(BLOCKING[warning.code])blocking.push(BLOCKING[warning.code]);else if(CHECK[warning.code])check.push(CHECK[warning.code]);
    }
    const segments=Array.isArray(job.assignmentSegments)?job.assignmentSegments.filter(record):[];
    const crew=segments.length?[...new Set(segments.flatMap(row=>Array.isArray(row.assignedCrew)?row.assignedCrew:[]))]:Array.isArray(job.assignedCrew)?job.assignedCrew:[];
    const truckIds=segments.length?segments.map(row=>row.vehicleId).filter(Boolean):job.vehicleId?[job.vehicleId]:[];
    const lead=job.crewLead||segments.find(row=>row.crewLead)?.crewLead||(crew.length===1?crew[0]:null);
    // Readiness-only checks the Dispatch board does not warn about: a job going out with no truck, a crew of two or more
    // with no lead on the job record, and no gate or access notes for the crew.
    if(crew.length&&!truckIds.length)check.push('No truck assigned');
    if(crew.length>1&&!lead&&!seen.has('missing_crew_lead'))check.push('No crew lead chosen');
    if(!String(job.accessInstructions||'').trim())check.push('No access or gate notes');
    const needed=Number(job.crewNeeded)||1;
    return {id:String(job.id),time:String(job.time||''),customer:firstName(job.customer),service:String(job.serviceType||job.title||'Job'),crew:crew.map(id=>people.get(String(id))||String(id)),needed,
      lead:lead?people.get(String(lead))||String(lead):'',trucks:truckIds.map(id=>trucks.get(String(id))||'Unknown truck'),blocking,check,state:blocking.length?'blocked':check.length?'check':'ready'};
  }).sort((a,b)=>a.time.localeCompare(b.time)||a.id.localeCompare(b.id));
  return {date,jobs:rows,ready:rows.filter(row=>row.state==='ready').length,blocked:rows.filter(row=>row.state==='blocked').length,check:rows.filter(row=>row.state==='check').length};
}

function h(tag,attrs,...children){const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs||{})){if(value==null||value===false)continue;if(key==='class')node.className=value;else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);else node.setAttribute(key,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
const button=(label,onClick,kind='')=>h('button',{type:'button',class:('hub-btn '+kind).trim(),onclick:onClick},label);
const now=()=>{const value=typeof S.ctx.now==='function'?S.ctx.now():new Date();return value instanceof Date&&Number.isFinite(value.valueOf())?value:new Date();};
function fetcher(){return typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:typeof hubFetch==='function'?hubFetch:(url,init)=>fetch(url,{...init,credentials:'same-origin'});}
function dayLabel(date){try{return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z'));}catch{return date;}}
function clock(time){const m=/^(\d{2}):(\d{2})/.exec(time||'');if(!m)return 'No time';const hour=Number(m[1]);return `${hour%12||12}:${m[2]} ${hour<12?'AM':'PM'}`;}
function frame(scope,...body){
  const id='rd-title-'+S.generation;
  return h('section',{class:'egc-readiness','aria-labelledby':id},h('header',{class:'rd-head'},h('span',{class:'rd-eyebrow'},'TOMORROW'),h('h2',{id},'Crew readiness'),scope?h('p',{class:'rd-scope'},scope):null),...body);
}
function show(node){if(!S.host)return;S.root?.remove();S.root=node;S.host.replaceChildren(node);}
function openDispatch(){const go=typeof S.ctx.go==='function'?S.ctx.go:window.opsGo;if(typeof go==='function')go('dispatch');else location.assign('/employee?view=dispatch');}
function jobRow(row){
  const crew=row.crew.length?`${row.crew.length} of ${row.needed} crew`:`0 of ${row.needed} crew`;
  return h('li',{class:'rd-job rd-'+row.state,'data-rd-job':row.id},
    h('div',{class:'rd-job-head'},h('strong',{},clock(row.time)+' · '+row.customer),h('span',{class:'rd-badge'},row.state==='ready'?'Ready':row.state==='blocked'?'Not ready':'Check')),
    h('p',{class:'rd-meta'},[row.service,crew,row.lead?'Lead: '+row.lead:'',row.trucks.length?'Truck: '+row.trucks.join(', '):''].filter(Boolean).join(' · ')),
    row.blocking.length||row.check.length?h('ul',{class:'rd-issues'},row.blocking.map(text=>h('li',{class:'rd-block'},text)),row.check.map(text=>h('li',{class:'rd-check'},text))):null);
}
function view(report){
  const summary=report.jobs.length?`${report.ready} ready · ${report.blocked} not ready · ${report.check} to check`:'';
  const body=report.jobs.length?[h('p',{class:'rd-count'},summary),h('ol',{class:'rd-list'},report.jobs.map(jobRow))]:[h('p',{class:'rd-empty'},'No customer jobs are scheduled for '+dayLabel(report.date)+'.')];
  return frame(dayLabel(report.date),...body,h('div',{class:'rd-actions'},button('Open Dispatch',openDispatch,'primary'),button('Refresh',()=>void load())));
}
function failure(error){
  const text=error?.status===401?'Your sign-in expired. Sign in again to check tomorrow.':error?.status===403?'This login cannot read the Dispatch board.':'Tomorrow could not be checked right now. This does not mean every job is ready.';
  return frame('',h('div',{class:'hub-notice error rd-state',role:'alert'},h('strong',{},'Readiness is unavailable'),h('p',{},text),h('div',{class:'rd-actions'},button('Retry',()=>void load()))));
}
async function load(){
  if(!S.host)return;
  const generation=++S.generation;S.controller?.abort();const controller=S.controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);
  show(frame('',h('p',{class:'rd-loading',role:'status'},'Checking tomorrow’s jobs…')));
  const date=addDays(denverDate(now()),1);
  try{
    const response=await fetcher()(`/api/dispatch?startDate=${date}&endDate=${addDays(date,1)}`,{cache:'no-store',credentials:'same-origin',signal:controller.signal});
    const data=await response.json().catch(()=>null);
    if(!response.ok||!record(data)||data.ok!==true)throw Object.assign(new Error('readiness_unavailable'),{status:response.status});
    const report=readinessReport(data,date);
    if(generation===S.generation)show(view(report));
  }catch(error){if(generation===S.generation)show(failure(error));}
  finally{clearTimeout(timer);}
}
function mount(host,ctx={}){if(!host)return;if(S.host===host&&S.root?.isConnected)return;unmount();S.host=host;S.ctx=record(ctx)?ctx:{};return load();}
function unmount(){S.generation++;S.controller?.abort();S.controller=null;S.root?.remove();S.root=null;S.host=null;S.ctx={};}
function refresh(){return S.host?load():undefined;}
window.addEventListener('egc:signout',()=>unmount());
window.EGCReadiness={mount,unmount,refresh,readinessReport};
})();
