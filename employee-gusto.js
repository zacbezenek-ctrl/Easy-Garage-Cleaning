/* One-way approved EGC timecards to Gusto. Payroll is reviewed and run in Gusto. */
(function(){
'use strict';
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let context=null,state={},revision=0;
const reset=()=>{revision++;context=null;state={rows:[],excluded:[],connection:null,loading:false,busy:false,error:'',notice:'',loadedAt:0};const host=document.getElementById('ops-gusto-payroll');if(host)host.innerHTML='';};
reset();
const slot=()=>document.getElementById('ops-gusto-payroll');
const hours=value=>Number(value||0).toFixed(3);
const issueText=row=>(row.issues||[]).map(issue=>typeof issue==='string'?issue:issue.message||'Review this timecard').join(' ');
const eligible=()=>state.rows.filter(row=>row.mapping&&row.classification&&row.transferToken&&!row.issues?.length&&!['synced','uncertain'].includes(row.sync?.status));
async function request(action,body){
  const response=await hubFetch(action,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),cache:'no-store'});
  const result=await response.json().catch(()=>({}));
  if(!response.ok||!result.ok)throw new Error(result.error||'Gusto could not be reached. Retry when the connection is available.');
  return result;
}
function draw(){
  const host=slot();if(!host||!context)return;
  const connection=state.connection,ready=connection?.connected===true,busy=state.busy||state.loading;
  const pending=eligible().slice(0,25);
  let content;
  if(!connection)content=`<p>${esc(state.loading?'Checking the Gusto connection…':'The Gusto connection has not been checked.')}</p>`;
  else if(!ready)content=`<p>${esc(connection.message||connection.reason||'Connect Gusto before sending approved hours.')}</p>${connection.configured?'<a class="ops-button primary" href="/api/gusto-auth">Connect Gusto</a>':'<p class="ops-note">An approved Gusto API integration must be configured before this connection can be enabled.</p>'}`;
  else content=`<p class="ops-note">Match each employee, review regular and overtime hours, then send their approved shifts. Review and run payroll in Gusto.</p><p class="ops-note">If a sent timecard is later deleted, reopened, or loses approval in EGC, correct its hours in Gusto before payroll.</p>${connection.environment==='demo'?'<p class="ops-gusto-warning"><strong>Demo connection:</strong> these transfers go to Gusto’s test environment.</p>':''}<div class="ops-gusto-actions"><button class="ops-button primary" onclick="egcGustoSync()" ${busy||!pending.length?'disabled':''}>${state.busy?'Working…':`Send ${pending.length} timecard${pending.length===1?'':'s'} to Gusto`}</button><a class="ops-button" href="https://app.gusto.com/" target="_blank" rel="noopener">Open Gusto ↗</a></div>${state.rows.length?`<div class="ops-gusto-rows">${state.rows.map(row=>{
    const status=row.sync?.status||'not_synced',classification=row.classification;
    const label={synced:'Sent to Gusto',changed:'Changes need review',uncertain:'Transfer needs checking',error:'Transfer failed',not_synced:'Not sent'}[status]||status;
    return`<article><div><strong>${esc(row.employeeName||row.employee)}</strong><small>${esc(new Date(row.clockInAt).toLocaleString('en-US',{timeZone:'America/Denver',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}))} · ${hours(row.hours)} hours</small><span class="ops-status ${status==='synced'?'good':status==='uncertain'||status==='error'?'warn':'info'}">${esc(label)}</span></div><div><small>${row.mapping?`${esc(row.mapping.employeeName||row.mapping.employeeUuid)} · ${esc(row.mapping.jobTitle||'Gusto job')}`:'Employee not matched'}</small><button class="ops-button" data-gusto-id="${esc(row.id)}" onclick="egcGustoMap(this.dataset.gustoId)" ${busy?'disabled':''}>${row.mapping?'Review match':'Match employee'}</button></div><div><small>${classification?`${hours(classification.regular)} regular · ${hours(classification.overtime)} overtime · ${hours(classification.doubleOvertime)} double overtime`:'Hours need classification'}</small><button class="ops-button" data-gusto-id="${esc(row.id)}" onclick="egcGustoClassify(this.dataset.gustoId)" ${busy?'disabled':''}>Review hours</button></div>${issueText(row)||row.sync?.message?`<p class="ops-gusto-warning">${esc(issueText(row)||row.sync.message)}</p>`:''}${status==='uncertain'?`<button class="ops-button" data-gusto-id="${esc(row.id)}" onclick="egcGustoSync([this.dataset.gustoId])" ${busy?'disabled':''}>Check transfer</button>`:''}</article>`;
  }).join('')}</div>`:'<p>No approved, completed timecards in this week.</p>'}`;
  host.innerHTML=`<section class="ops-card ops-gusto"><div class="ops-card-head"><div><span class="ops-eyebrow">EGC → GUSTO</span><h2>Send approved hours to payroll</h2></div><button class="ops-button" onclick="egcGustoRefresh()" ${busy?'disabled':''}>${state.loading?'Checking…':'Refresh Gusto'}</button></div>${state.error?`<p class="ops-gusto-warning" role="alert">${esc(state.error)}</p>`:''}${state.notice?`<p role="status">${esc(state.notice)}</p>`:''}${content}${state.excluded.length?`<details class="ops-gusto-warning"><summary>${state.excluded.length} approved timecard${state.excluded.length===1?'':'s'} need correction before syncing</summary>${state.excluded.map(item=>`<p>${esc(item.id)}: ${esc(item.message)}</p>`).join('')}</details>`:''}</section>`;
}
async function load(){
  if(!context||state.loading||state.busy)return;
  const current=++revision,captured=context;
  state.loading=true;state.error='';draw();
  try{
    const query=new URLSearchParams({view:'preview',start:captured.startDate,end:captured.endDate});
    const data=await request('/api/gusto-sync?'+query);
    if(current!==revision||captured!==context)return;
    if(!data.connection||!Array.isArray(data.rows))throw new Error('Gusto returned an incomplete review. Refresh before sending hours.');
    state.connection=data.connection;state.rows=data.rows;state.excluded=Array.isArray(data.excluded)?data.excluded:[];state.loadedAt=Date.now();
  }catch(error){if(current===revision){state.error=error.message;state.rows=[];state.excluded=[];state.connection=null;state.loadedAt=Date.now();}}
  finally{if(current===revision){state.loading=false;draw();}}
}
window.egcGustoRefresh=()=>load();
window.egcGustoMap=async id=>{
  if(!context||state.busy||!state.connection?.connected)return;
  const captured=context,row=state.rows.find(item=>item.id===id);if(!row)return;
  state.busy=true;state.error='';draw();
  try{
    const result=await request('/api/gusto-sync?view=roster');
    if(captured!==context)return;
    if(!Array.isArray(result.employees))throw new Error('The Gusto employee list could not be verified.');
    const options=result.employees.flatMap(employee=>(employee.jobs||[]).map(job=>({value:employee.uuid+':'+job.uuid,label:`${employee.name} · ${employee.email||'No email returned'} · ${job.title||'Gusto job'}`})));
    if(!options.length)throw new Error('No Gusto employee jobs are available to match. Check employee setup in Gusto.');
    const input=await captured.askAction({kicker:'MATCH EMPLOYEE',title:`Match ${row.employeeName||row.employee} to Gusto`,copy:`EGC username: ${row.employee}. Verify the employee’s name and email before saving this match.`,confirmLabel:'Save employee match',fields:[{name:'match',label:'Gusto employee and job',type:'select',value:row.mapping?`${row.mapping.employeeUuid}:${row.mapping.jobUuid}`:'',options:[{value:'',label:'Choose the matching Gusto employee'},...options]}],note:'This match controls whose timecard receives the EGC hours.'});
    if(!input||captured!==context)return;
    const [employeeUuid,jobUuid]=String(input.match).split(':');
    await request('/api/gusto-sync',{action:'map',username:row.employee,employeeUuid,jobUuid,confirmed:true});
    if(captured===context)state.notice='Employee matched. Review the hours before sending.';
  }catch(error){if(captured===context)state.error=error.message;}
  finally{if(captured===context){state.busy=false;draw();if(!state.error)await load();}}
};
window.egcGustoClassify=async id=>{
  if(!context||state.busy||!state.connection?.connected)return;
  const captured=context,row=state.rows.find(item=>item.id===id);if(!row)return;
  const input=await captured.askAction({kicker:'REVIEW APPROVED HOURS',title:`Classify ${hours(row.hours)} hours`,copy:`${row.employeeName||row.employee} · ${new Date(row.clockInAt).toLocaleDateString('en-US',{timeZone:'America/Denver'})}. Use the employee’s applicable pay rules to split these hours.`,confirmLabel:'Save reviewed hours',fields:[{name:'regular',label:'Regular hours',type:'number',min:0,step:.001,value:row.classification?.regular??''},{name:'overtime',label:'Overtime hours',type:'number',min:0,step:.001,value:row.classification?.overtime??0},{name:'doubleOvertime',label:'Double overtime hours',type:'number',min:0,step:.001,value:row.classification?.doubleOvertime??0}],note:`The three amounts must total ${hours(row.hours)} hours. EGC does not automatically classify overtime.`});
  if(!input||captured!==context)return;
  state.busy=true;state.error='';draw();
  try{await request('/api/gusto-sync',{action:'classify',timecardId:id,reviewToken:row.reviewToken,regular:Number(input.regular),overtime:Number(input.overtime),doubleOvertime:Number(input.doubleOvertime)});if(captured===context)state.notice='Hour classification saved.';}
  catch(error){if(captured===context)state.error=error.message;}
  finally{if(captured===context){state.busy=false;draw();if(!state.error)await load();}}
};
window.egcGustoSync=async requested=>{
  if(!context||state.busy||state.loading||state.error||!state.connection?.connected)return;
  const captured=context,ids=Array.isArray(requested)?requested:eligible().slice(0,25).map(row=>row.id);if(!ids.length)return;
  const reviewTokens=Object.fromEntries(ids.map(id=>[id,state.rows.find(row=>row.id===id)?.transferToken||'']));
  const approval=await captured.askAction({kicker:'EGC → GUSTO',title:`Send ${ids.length} approved timecard${ids.length===1?'':'s'} to Gusto?`,copy:'The reviewed hours will appear in Gusto Time Tracking. Previously uncertain transfers are checked before another transfer is attempted.',confirmLabel:'Send approved hours',fields:[],note:'Review and apply the hours to payroll in Gusto. This action does not run payroll.'});
  if(!approval||captured!==context||state.busy)return;
  state.busy=true;state.error='';state.notice='';draw();
  try{
    const data=await request('/api/gusto-sync',{action:'sync',timecardIds:ids,reviewTokens});
    if(captured!==context)return;
    if(!Array.isArray(data.results))throw new Error('The transfer result could not be confirmed. Refresh to check the recorded status before retrying.');
    const sent=data.results.filter(result=>['synced','unchanged'].includes(result.status)).length;
    state.notice=`${sent} of ${ids.length} timecards confirmed in Gusto.${sent<ids.length?' Review the remaining transfer statuses below.':' Review the hours in Gusto before running payroll.'}`;
    const failures=data.results.filter(result=>!['synced','unchanged'].includes(result.status));
    if(failures.length)state.error=failures.slice(0,5).map(result=>`${String(result.id||'Timecard').slice(0,180)}: ${String(result.message||'This timecard needs review before retrying.').slice(0,300)}`).join(' ') + (failures.length>5?` ${failures.length-5} more timecards need review.`:'');
  }catch(error){if(captured===context)state.error=error.message;}
  finally{if(captured===context){const transferError=state.error;state.busy=false;draw();await load();if(captured===context&&transferError){state.error=transferError;draw();}}}
};
window.EGCGusto={mount(options){
  if(!options.owner){reset();return;}
  const changed=!context||context.identity!==options.identity||context.generation!==options.generation||context.startDate!==options.startDate||context.endDate!==options.endDate;
  if(changed){reset();context=options;const result=new URLSearchParams(location.search).get('gusto');state.notice={connected:'Gusto authorization completed. Checking the saved connection.',cancelled:'Gusto authorization was cancelled. No connection was changed.','invalid-state':'The Gusto connection request expired or changed. Start Connect Gusto again.','wrong-company':'That Gusto company did not match EGC. Connect the configured company.',failed:'The Gusto connection could not be completed. Review the setup and try again.'}[result]||'';}
  else context.askAction=options.askAction;
  draw();
  if(!state.loading&&!state.busy&&(!state.loadedAt||Date.now()-state.loadedAt>30000))load();
}};
window.addEventListener('egc:signout',reset);
})();
