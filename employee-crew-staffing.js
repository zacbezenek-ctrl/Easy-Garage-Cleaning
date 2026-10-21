/* Crew staffing (owner and managers who run dispatch): crew problems, the next 14 days' unstaffed jobs and "Staff waiting
   jobs". GET /api/crew-staffing (functions/api/crew-staffing.js) computes everything; this file only shows it and, on
   confirm, staffs each waiting job with the existing POST /api/dispatch schedule.update autoCrew:true, one job at a time,
   so every dispatch rule is checked again for each job. A job no crew can take is left exactly as it was.
   Two places use it:
     - EGCCrewStaffing.panel({save, onApplied}) inside Dispatch > Crews & vehicles (employee-dispatch.js);
     - the Command center home widget (employee-hub-screens.js HOME_WIDGETS, module EGCCrewStaffing): one line,
       "2 crew problems · 3 unstaffed jobs → Fix", or nothing for anyone the server refuses.
   No money is shown anywhere here. Names come from the server and are always rendered as text. */
(function(){
'use strict';
const PATH='/api/crew-staffing',TIMEOUT=20000;
const PROBLEM_LABEL={crew_no_members:'No members',crew_no_lead:'No lead',crew_member_inactive:'Inactive member',availability_clash:'Hours clash',no_staffable_crew:'No crew can work',uncovered_day:'Day not covered'};
function h(tag,attrs,...children){const node=document.createElement(tag);for(const [key,value] of Object.entries(attrs||{})){if(value==null||value===false)continue;if(key==='class')node.className=value;else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);else if(key in node&&!key.startsWith('aria-')&&!key.startsWith('data-')&&typeof value!=='object')node[key]=value;else node.setAttribute(key,String(value));}for(const child of children.flat(Infinity))if(child!=null&&child!==false)node.append(child instanceof Node?child:document.createTextNode(String(child)));return node;}
const button=(label,onClick,kind='',attrs={})=>h('button',{type:'button',class:('hub-btn cs-btn '+kind).trim(),onclick:onClick,...attrs},label);
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const day=date=>{try{return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z'));}catch{return date;}};
const clock=time=>{const m=/^(\d{2}):(\d{2})$/.exec(time||'');if(!m)return'';const hour=Number(m[1]);return((hour+11)%12+1)+':'+m[2]+(hour<12?' am':' pm');};
const plural=(count,word)=>count+' '+word+(count===1?'':'s');
const uuid=()=>crypto.randomUUID();
const validReport=d=>record(d)&&d.ok===true&&Array.isArray(d.health)&&Array.isArray(d.unstaffed)&&Array.isArray(d.preview)&&record(d.counts)&&Number.isSafeInteger(d.counts.problems)&&Number.isSafeInteger(d.counts.unstaffed)
  &&d.health.every(p=>record(p)&&typeof p.code==='string'&&typeof p.message==='string')&&d.unstaffed.every(j=>record(j)&&typeof j.jobId==='string'&&typeof j.date==='string');
async function getReport(fetcher,signal){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  try{
    const response=await (fetcher||((url,init)=>fetch(url,{credentials:'same-origin',...init})))(PATH,{cache:'no-store',credentials:'same-origin',signal:controller.signal});
    const data=await response.json().catch(()=>null);
    if(!response.ok||!validReport(data))throw Object.assign(new Error(record(data)&&typeof data.error==='string'?data.error:'Crew staffing could not be verified. Retry.'),{status:response.ok?503:response.status});
    return data;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
function problemList(health){
  if(!health.length)return h('p',{class:'cs-ok','data-cs-healthy':''},'No crew problems: every active crew has members, a lead and active employees, and a crew covers every day in the next 14.');
  return h('ul',{class:'cs-problems'},health.map(p=>h('li',{class:'cs-problem','data-cs-problem':p.code},h('strong',{},(p.crewName?p.crewName+' · ':'')+(PROBLEM_LABEL[p.code]||'Check')),h('span',{},p.message))));
}
function jobLine(row,result){
  const when=[day(row.date),clock(row.time)?clock(row.time)+(clock(row.endTime)?'–'+clock(row.endTime):''):''].filter(Boolean).join(' · ');
  const need=row.status==='short'?row.assigned+' of '+row.needed+' people':'No crew';
  return h('li',{class:'cs-job '+(row.status==='short'?'short':'none'),'data-cs-job':row.jobId},
    h('span',{class:'cs-when'},when),h('span',{class:'cs-who'},row.customer||row.title||'Unnamed job'),result?.ok?null:h('span',{class:'cs-need'},need),
    result?h('span',{class:'cs-result '+(result.ok?'ok':'bad'),'data-cs-result':result.ok?'assigned':'failed'},result.text):null);
}

/* The Dispatch panel. save(body) is employee-dispatch.js api('',body): it posts to /api/dispatch and verifies the reply.
   setup (optional) is {label, run}: the crew set-up step Dispatch offers next to crew problems (Create Crew 1/2/3 while
   the standard crews are missing, else a jump to the crew list), so an empty roster always says what to tap next. */
const CREW_CODES=new Set(['no_staffable_crew','crew_no_members','crew_no_lead','crew_member_inactive','availability_clash','uncovered_day']);
const SHOWN=5;
function panel({save,onApplied,fetcher,setup}={}){
  const P={data:null,error:'',loading:true,stage:'idle',results:new Map(),requests:new Map(),busy:false,all:false};
  const root=h('section',{class:'cs-panel dp-wide','aria-labelledby':'cs-panel-title','data-cs-panel':''});
  const draw=()=>{
    const head=h('div',{class:'cs-head'},h('h3',{id:'cs-panel-title'},'Crew staffing'),h('span',{class:'cs-sub'},'Next 14 days'));
    if(P.loading){root.replaceChildren(head,h('p',{class:'cs-muted',role:'status'},'Checking crews and unstaffed jobs…'));return;}
    if(!P.data){root.replaceChildren(head,h('p',{class:'cs-error',role:'alert'},P.error||'Crew staffing is unavailable.'),button('Retry',load));return;}
    const d=P.data,waiting=d.unstaffed,staffable=d.preview.filter(row=>row.crewId),blocked=d.preview.filter(row=>!row.crewId);
    const noCrew=d.health.some(p=>p.code==='no_staffable_crew'),crewProblems=d.health.some(p=>CREW_CODES.has(p.code));
    // The set-up step sits right under the heading, above the problems it fixes, so it is in reach on a phone.
    const body=[head,h('h4',{},d.health.length?plural(d.health.length,'crew problem'):'Crews'),
      crewProblems&&setup?h('div',{class:'cs-actions'},button(setup.label,()=>setup.run(),noCrew?'primary':'',{'data-cs-setup':''})):null,problemList(d.health)];
    // The one action, before the long list: what it would do, or exactly why it cannot run.
    if(!d.autoAssign)body.push(h('p',{class:'cs-muted','data-cs-auto-off':''},'Automatic crew assignment is off. Assign crews by hand.'));
    else if(waiting.length&&save&&(noCrew||!staffable.length)&&P.stage==='idle')body.push(h('p',{class:'cs-muted','data-cs-cannot':''},noCrew?'No job can be staffed automatically until a crew has active members. Set up the crews first.'
      :d.counts.canAutoStaff?'No waiting job can be staffed automatically: '+[...new Set(blocked.map(row=>row.message))].join('; ')+'.':'None of these jobs can be staffed automatically: each one has started, already has people on it, or is split into parts. Assign them by hand.'));
    else if(staffable.length&&save||P.stage!=='idle'){
      if(P.stage==='idle')body.push(h('div',{class:'cs-actions'},button('Staff waiting jobs',()=>{P.stage='preview';draw();},'primary',{'data-cs-staff':''})));
      else if(P.stage==='preview')body.push(h('div',{class:'cs-preview',role:'region','aria-label':'Staffing preview','data-cs-preview':''},
        h('p',{},h('strong',{},d.previewSummary||'No job can be staffed')),
        h('p',{class:'cs-muted'},'Each job is saved on its own and every dispatch rule is checked again, so the result can differ from this preview. Jobs no crew can take stay as they are. Each crew assignment adds the usual HighLevel contact note, as any crew change in Dispatch does.'),
        h('div',{class:'cs-actions'},button(P.busy?'Staffing…':'Staff '+plural(staffable.length,'job'),apply,'primary',{disabled:P.busy||!staffable.length,'data-cs-apply':''}),button('Cancel',()=>{P.stage='idle';draw();},'',{disabled:P.busy}))));
      else{
        const done=[...P.results.values()],ok=done.filter(r=>r.ok).length,failed=done.filter(r=>!r.ok);
        body.push(h('div',{class:'cs-preview','data-cs-done':''},h('p',{role:'status'},h('strong',{},'Staffed '+ok+' of '+done.length+'.'),failed.length?' '+plural(failed.length,'job')+' could not be staffed; see each one below.':''),
          blocked.length?h('p',{class:'cs-muted'},plural(blocked.length,'job')+(blocked.length===1?' was':' were')+' not tried: '+[...new Set(blocked.map(row=>row.message))].join('; ')+'.'):null,
          h('div',{class:'cs-actions'},failed.some(r=>r.retry)?button('Retry the unconfirmed',apply,'',{disabled:P.busy}):null,button('Close and refresh',()=>onApplied?.(),'primary',{'data-cs-close':''}))));
      }
    }
    // Jobs with a result first after a run, then the rest; the first few unless the full list is asked for.
    const ordered=P.results.size?[...waiting.filter(row=>P.results.has(row.jobId)),...waiting.filter(row=>!P.results.has(row.jobId))]:waiting,shown=P.all?ordered:ordered.slice(0,Math.max(SHOWN,P.results.size));
    body.push(h('h4',{},waiting.length?plural(waiting.length,'unstaffed job')+', oldest first':'Unstaffed jobs'),
      waiting.length?h('ul',{class:'cs-jobs'},shown.map(row=>jobLine(row,P.results.get(row.jobId)))):h('p',{class:'cs-ok','data-cs-staffed':''},'Every dated job in the next 14 days has its crew.'),
      ordered.length>shown.length?button('Show all '+ordered.length,()=>{P.all=true;draw();},'',{'data-cs-all':''}):null);
    root.replaceChildren(...body.filter(Boolean));
  };
  async function load(){P.loading=true;P.error='';draw();try{P.data=await getReport(fetcher);P.results.clear();P.requests.clear();P.stage='idle';}catch(error){P.data=null;P.error=error.message;}finally{P.loading=false;draw();}}
  async function apply(){
    if(P.busy||!P.data)return;P.busy=true;draw();
    const rows=P.data.preview.filter(row=>row.crewId),byId=new Map(P.data.unstaffed.map(row=>[row.jobId,row]));
    for(const row of rows){
      const prior=P.results.get(row.jobId);if(prior&&(prior.ok||!prior.retry))continue;
      const job=byId.get(row.jobId);if(!job)continue;
      // One request id per job for this batch: retrying an unconfirmed save replays it, never staffs twice.
      if(!P.requests.has(row.jobId))P.requests.set(row.jobId,uuid());
      try{const result=await save({action:'schedule.update',requestId:P.requests.get(row.jobId),jobId:row.jobId,expectedRevision:job.revision,changes:{},autoCrew:true});
        const crew=result?.autoCrew;P.results.set(row.jobId,crew?.status==='assigned'?{ok:true,text:(crew.crewName||'A crew')+' assigned'}:{ok:false,text:'Not staffed: the job changed. Refresh and check it.'});}
      catch(error){const unconfirmed=!error?.status||error.status>=500;P.results.set(row.jobId,{ok:false,retry:unconfirmed,text:unconfirmed?'Not confirmed: retry to check it (it is never staffed twice).':error.message||'Not staffed.'});}
      draw();
    }
    P.busy=false;P.stage='done';draw();
  }
  void load();
  return root;
}

/* The Command center line. */
const W={host:null,ctx:{},controller:null,generation:0};
function line(d){
  const problems=d.counts.problems,unstaffed=d.counts.unstaffed;
  if(!problems&&!unstaffed)return h('div',{class:'cs-line ok','data-cs-line':'ok'},h('strong',{},'Crews are set'),h('span',{},'No crew problems and no unstaffed jobs in the next 14 days.'));
  const parts=[problems?plural(problems,'crew problem'):'',unstaffed?plural(unstaffed,'unstaffed job')+' in the next 14 days':''].filter(Boolean).join(' · ');
  return h('div',{class:'cs-line warn','data-cs-line':'warn'},h('strong',{},'Crew staffing'),h('span',{'data-cs-summary':''},parts),button('Fix',fix,'primary',{'aria-label':'Fix crew staffing: open Crews & vehicles in Dispatch','data-cs-fix':''}));
}
function fix(){const go=typeof W.ctx.go==='function'?W.ctx.go:window.opsGo;if(typeof go==='function')go('schedule');window.EGCDispatch?.openCrews?.();}
async function refresh(){
  if(!W.host)return;const generation=++W.generation;W.controller?.abort();const controller=W.controller=new AbortController();
  try{const d=await getReport(typeof W.ctx.hubFetch==='function'?W.ctx.hubFetch:undefined,controller.signal);if(generation!==W.generation||!W.host)return;W.host.replaceChildren(line(d));}
  catch(error){if(generation!==W.generation||!W.host||error?.name==='AbortError')return;
    // Anyone the server refuses (crew, sales, a manager without dispatch) sees nothing here.
    if([401,403].includes(error.status)){W.host.replaceChildren();W.host.hidden=true;return;}
    W.host.replaceChildren(h('div',{class:'cs-line warn',role:'status','data-cs-line':'error'},h('strong',{},'Crew staffing'),h('span',{},'Could not be checked right now. This is not a clean bill of health.'),button('Retry',()=>void refresh())));}
}
function mount(host,ctx={}){W.host=host;W.ctx=ctx||{};host.hidden=false;host.replaceChildren(h('div',{class:'cs-line','aria-busy':'true'},h('span',{class:'cs-muted'},'Checking crew staffing…')));return refresh();}
function unmount(){W.generation++;W.controller?.abort();W.host?.replaceChildren();W.host=null;}
window.EGCCrewStaffing=Object.freeze({panel,mount,unmount,refresh});
})();
