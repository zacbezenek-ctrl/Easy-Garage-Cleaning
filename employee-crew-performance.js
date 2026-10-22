/* Crew performance (CREW-PERF): one row per person for the last 30 or 90 days, from GET /api/crew-performance
   (functions/_lib/crew-performance.js): hours on jobs, jobs worked and led, on-time arrivals, the crew's actual hours
   against the billed Labor line on jobs they worked, and issues flagged on jobs they led. Hours and counts only; no pay
   or money. Registered in employee-hub-screens.js (business accounts) and runs standalone with the UI kit. */
(function(){
'use strict';
const PATH='/api/crew-performance',PREFIX='crew_performance';
const S={host:null,ctx:null,data:null,error:null,loading:false,range:'last30',generation:0};
const kit=()=>window.EGCHubKit;
const h=(...args)=>kit().h(...args);
const fetcher=()=>S.ctx&&typeof S.ctx.hubFetch==='function'?S.ctx.hubFetch:undefined;
const num=value=>typeof value==='number'&&Number.isFinite(value);
const hours=value=>num(value)?value.toFixed(1):'—';
const validRow=r=>Boolean(r&&typeof r.employee==='string'&&typeof r.name==='string'&&['hours','pendingHours','jobsWorked','jobsLed','onTime','arrivalsCounted','comparedJobs','issueJobs','followUps'].every(key=>num(r[key]))&&(r.onTimePercent===null||num(r.onTimePercent))&&(r.hoursVsBilledPercent===null||num(r.hoursVsBilledPercent)));
const valid=data=>Boolean(data&&data.ok===true&&data.window&&Array.isArray(data.last30)&&Array.isArray(data.last90)&&data.last30.every(validRow)&&data.last90.every(validRow));
async function load(){
  const generation=++S.generation;S.loading=true;S.error=null;render();
  try{const data=await kit().requestJSON(PATH,{prefix:PREFIX,validate:valid,fetcher:fetcher()});if(generation===S.generation)S.data=data;}
  catch(error){if(generation===S.generation)S.error=error;}
  finally{if(generation===S.generation){S.loading=false;render();}}
}
function onTime(r){return r.arrivalsCounted?`${r.onTime} of ${r.arrivalsCounted} (${Math.round(r.onTimePercent)}%)`:'—';}
function vsBilled(r){
  if(r.hoursVsBilledPercent===null)return '—';
  const p=r.hoursVsBilledPercent,label=Math.abs(p)<0.05?'On billed hours':p>0?`${p.toFixed(1)}% over billed`:`${Math.abs(p).toFixed(1)}% under billed`;
  return `${label} · ${r.comparedJobs} job${r.comparedJobs===1?'':'s'}`;
}
function personRow(r){
  const cell=(label,cls,...children)=>h('td',{'data-label':label,class:cls},h('span',{class:'cp-cell'},...children));
  const over=r.hoursVsBilledPercent!==null&&r.hoursVsBilledPercent>=15,late=r.onTimePercent!==null&&r.onTimePercent<80;
  return h('tr',{'data-person':r.employee},
    h('th',{scope:'row','data-label':'Person'},h('span',{class:'cp-cell'},r.name)),
    cell('Hours on jobs','num',hours(r.hours),r.pendingHours>0?h('small',{},`+${hours(r.pendingHours)} pending`):null),
    cell('Jobs worked','num',String(r.jobsWorked)),
    cell('Jobs led','num',String(r.jobsLed)),
    cell('On-time arrivals','num'+(late?' cp-flag':''),onTime(r)),
    cell('Crew hours vs billed','num'+(over?' cp-flag':''),vsBilled(r)),
    cell('Issues','num',r.issueJobs||r.followUps?[r.issueJobs?`${r.issueJobs} closed with issues`:'',r.followUps?`${r.followUps} open follow-up${r.followUps===1?'':'s'}`:''].filter(Boolean).join(' · '):'None'));
}
function table(rows){
  if(!rows.length)return h('div',{class:'hub-card'},h('p',{},'No job time was logged in this period.'));
  return h('section',{class:'hub-card cp-people','aria-label':'Crew'},
    h('div',{class:'hub-table-scroll cp-table-scroll'},h('table',{class:'cp-table'},
      h('thead',{},h('tr',{},['Person','Hours on jobs','Jobs worked','Jobs led','On-time arrivals','Crew hours vs billed','Issues'].map(text=>h('th',{scope:'col'},text)))),
      h('tbody',{},rows.map(personRow)))));
}
function notes(){
  return h('section',{class:'hub-card cp-notes','aria-label':'How these are counted'},h('h2',{},'How these are counted'),
    h('ul',{},
      h('li',{},'Hours and jobs come from job time on timecards. Pending hours are not approved yet.'),
      h('li',{},'On time means the person\'s first work clock-in on the job was by the end of the customer\'s arrival window, or within 15 minutes of the start time when there is no window. On a split job, each person is judged by their own segment that day. A job is not counted when the person started another job earlier that day, or on a later day of a multi-day job without its own segment.'),
      h('li',{},'Crew hours vs billed compares everyone\'s actual hours on completed jobs this person worked against the Labor line sold. It is a crew figure, not one person\'s speed.'),
      h('li',{},'Issues count completed jobs this person led that closed with issues, and their other jobs with an open crew follow-up. A job counts once.'),
      h('li',{},'Not tracked yet, so not shown: callbacks or redo visits, and customer reviews that name a crew member.')));
}
function render(){
  if(!S.host)return;
  const head=h('header',{class:'hub-head'},h('div',{},h('span',{class:'hub-eyebrow'},'TEAM'),h('h1',{},'Crew performance'),h('p',{},'Hours, jobs, on-time arrivals and hours against what was sold, per person.')),
    h('div',{class:'hub-actions'},kit().button(S.loading?'Loading…':'Refresh',load,'',{disabled:S.loading})));
  let body;
  if(S.error&&!S.data)body=[h('div',{class:'hub-notice error',role:'alert'},'Crew performance is unavailable. '+kit().errorText(S.error)),kit().button('Retry',load,'primary')];
  else if(!S.data)body=[h('p',{class:'hub-screen-loading'},'Loading crew performance…')];
  else{
    const d=S.data,notices=[];
    if(S.error)notices.push(h('div',{class:'hub-notice error',role:'alert'},'Refresh failed, so this is the last loaded data. '+kit().errorText(S.error)));
    if(d.sources?.timecards==='unavailable')notices.push(h('div',{class:'hub-notice warning'},'Timecards could not be read, so hours and arrivals are missing. Jobs led still show. Refresh to try again.'));
    else if(Array.isArray(d.laborCoverage?.reasons)&&d.laborCoverage.reasons.some(reason=>['open_shifts','pending_timecards','needs_review'].includes(reason)))notices.push(h('div',{class:'hub-notice warning'},'Some timecards are still open, pending or need review, so recent hours may change.'));
    const tabs=h('div',{class:'cp-tabs',role:'group','aria-label':'Period'},[['last30','Last 30 days'],['last90','Last 90 days']].map(([id,label])=>kit().button(label,()=>{S.range=id;render();},S.range===id?'primary':'',{'aria-pressed':S.range===id?'true':'false'})));
    body=[...notices,tabs,table(d[S.range]),notes()];
  }
  const root=h('section',{class:'hub-screen egc-crew-performance'},head,...body);
  S.host.querySelector('.egc-crew-performance')?.remove();
  S.host.append(root);
}
function mount(host,ctx){S.host=host;S.ctx=ctx||{};S.data=null;S.error=null;S.range='last30';return load();}
function unmount(){S.generation++;S.host?.querySelector('.egc-crew-performance')?.remove();S.host=null;S.ctx=null;}
window.EGCCrewPerformance={mount,unmount,refresh:load};
})();
