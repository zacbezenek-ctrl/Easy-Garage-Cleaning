/* Owner-only, reviewed recording. The server owns identity and provider checks. */
(function(){
'use strict';
const prefix='egc.walkthrough.recording.v1.';
const rejectedWithoutSave=new Set(['dispatch_recording_changed','dispatch_recording_appointment_inactive','dispatch_recording_appointment_mismatch','dispatch_recording_calendar_mismatch','dispatch_recording_contact_mismatch','dispatch_recording_time_out_of_scope','dispatch_recording_already_imported','dispatch_job_already_exists','dispatch_employee_inactive','dispatch_revision_conflict','dispatch_conflict']);
async function send(body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
  try {
    const response=await fetch('/api/walkthrough-recording',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
    const data=await response.json();
    if(!response.ok||!data.ok)throw Object.assign(new Error(data.error||'The recording could not be verified.'),{status:response.status,code:data.code});
    return data;
  } finally {clearTimeout(timer);}
}
function open(){
  const d=window.EGCDispatch?.internals,s=d?.state();if(!d||s?.data?.viewer?.canRecordWalkthrough!==true)return;
  const owner=s.data.viewer.id,storageKey=prefix+owner;
  let pending=null;try{const raw=sessionStorage.getItem(storageKey);if(raw)pending=JSON.parse(raw);}catch{ return; }
  const m=d.modal('Record a walkthrough','Save a Hub-only visit, or import an existing appointment. This action makes no provider changes and sends no customer messages.');if(!m)return;
  const {h,btn,notice}=d;
  let selected=null,review=null,generation=0;
  const field=(name,label,type='text',value='')=>{const input=h(type==='textarea'?'textarea':'input',{name,type:type==='textarea'?undefined:type,value,maxLength:4000});m.fields.append(h('label',{},h('span',{},label),input));return input;};
  const mode=h('select',{name:'mode'},h('option',{value:'hub_only'},'Hub-only walkthrough'),h('option',{value:'import'},'Import existing appointment'));
  m.fields.append(h('label',{},h('span',{},'Recording type'),mode));
  const search=field('customerSearch','Find Hub customer'),results=h('div',{class:'dp-wide'});m.fields.append(results);
  const find=btn('Find customer',async()=>{
    const g=++generation;review=null;save.textContent='Review recording';
    try{const r=await d.api('?'+new URLSearchParams({view:'customers',q:search.value.trim()}));if(s.modal!==m||g!==generation)return;results.replaceChildren(...r.customers.map(c=>btn(c.name+' · '+(c.phone||c.address||c.id),()=>{selected=c;search.value=c.name;address.value=c.address||'';results.replaceChildren(h('p',{},'Selected: '+c.name+' · '+c.id));})));}
    catch(e){if(s.modal===m)results.replaceChildren(notice(e.message,'error'));}
  });m.fields.append(find);
  const employee=h('select',{name:'employeeId'},h('option',{value:''},'Choose an employee'),...(s.data.roster||[]).map(p=>h('option',{value:p.id},p.name)));
  m.fields.append(h('label',{},h('span',{},'Hub employee'),employee));
  const address=field('address','Walkthrough address'),date=field('date','Date (Mountain Time)','date',s.date),time=field('time','Start time','time'),end=field('endTime','End time','time');
  const appointment=field('appointmentId','Existing appointment ID'),calendar=field('calendarId','Existing calendar ID');
  const scope=field('scope','Work scope','textarea'),reason=field('reason','Why this is being recorded without provider changes','textarea');
  const evidence=h('div',{class:'dp-wide','aria-live':'polite'});m.fields.append(evidence);
  const save=h('button',{type:'submit',class:'dp-btn primary'},pending?'Verify saved recording':'Review recording');
  m.footer.append(btn('Back',m.close),save);
  function toggle(){const importing=mode.value==='import';for(const f of [date,time,end])f.parentElement.hidden=importing;for(const f of [appointment,calendar])f.parentElement.hidden=!importing;}
  toggle();mode.addEventListener('change',toggle);
  m.form.addEventListener('input',event=>{if(event.target===search){selected=null;results.replaceChildren();}if(!m.request){generation++;review=null;evidence.replaceChildren();save.textContent='Review recording';}});
  m.form.addEventListener('change',()=>{if(!m.request){generation++;review=null;evidence.replaceChildren();save.textContent='Review recording';}});
  function freeze(){for(const control of m.fields.querySelectorAll('input,select,textarea,button'))control.disabled=true;}
  if(pending){m.request=pending;for(const [name,value]of Object.entries(pending.input||{})){const control=m.fields.querySelector('[name="'+name+'"]');if(control)control.value=value;}selected={id:pending.input?.customerId,name:pending.input?.customerId};search.value=selected.name||'';toggle();freeze();evidence.append(notice('A previous save needs verification. Retry the exact saved request before recording anything else.'));}
  let busy=false;
  m.form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;busy=true;save.disabled=true;
    const g=generation;
    try{
      if(!m.request&&!review){
        if(!selected)throw new Error('Find and select the exact Hub customer first.');
        const input={mode:mode.value,customerId:selected.id,employeeId:employee.value,address:address.value,scope:scope.value,reason:reason.value,...(mode.value==='import'?{appointmentId:appointment.value.trim(),calendarId:calendar.value.trim()}:{date:date.value,time:time.value,endTime:end.value})};
        const r=await send({action:'preview',input});if(s.modal!==m||g!==generation)return;
        if(r.providerWrites!==false||!r.snapshot||typeof r.fingerprint!=='string')throw new Error('The preview was incomplete. Nothing was saved.');
        review={input,fingerprint:r.fingerprint};const p=r.snapshot,v=p.provider;
        evidence.replaceChildren(h('h3',{},'Review before saving'),h('p',{},selected.name+' · '+p.employeeName),h('p',{},p.date+' '+p.time+'–'+p.endTime+' America/Denver ('+p.durationMinutes+' minutes)'),h('p',{},p.address),h('p',{},p.scope),notice(v?'Import snapshot: '+v.calendarName+' · calendar '+v.calendarId+' · appointment '+v.appointmentId+' · status '+v.status+' · provider assigned user '+(v.assignedUserId||'not supplied')+'. Provider address: '+(v.providerAddress||'not supplied')+'. Verify this is the selected employee’s walkthrough. Hub assignment is recorded separately.':'Hub-only: no provider appointment will be created. The linked customer stays linked.'),notice('No provider writes or customer messages. Imported details are a snapshot; existing provider workflows remain outside this action.'));
        save.textContent='Confirm and save';return;
      }
      if(!m.request){
        const body={action:'save',...review,requestId:crypto.randomUUID()};
        sessionStorage.setItem(storageKey,JSON.stringify(body));m.request=body;freeze();
      }
      const r=await send(m.request);
      if(r.providerWrites!==false||r.requestId!==m.request.requestId||!r.job?.id||!r.job?.revision)throw new Error('The save response was incomplete. Retry this same request to verify it.');
      sessionStorage.removeItem(storageKey);m.request=null;s.notice='Walkthrough recorded. No provider changes or customer messages.';m.close();
    }catch(e){
      if(s.modal!==m)return;
      m.status.replaceChildren(notice(e.message,'error'));
      // Only an explicit no-save rejection permits a fresh preview/request.
      // Timeouts, authentication loss and uncertain outcomes keep the receipt.
      if(m.request&&e.status===409&&rejectedWithoutSave.has(e.code)){
        sessionStorage.removeItem(storageKey);m.request=null;review=null;
        for(const control of m.fields.querySelectorAll('input,select,textarea,button'))control.disabled=false;
        save.textContent='Review recording';m.status.append(notice('Nothing was saved by this request. Review the current details again.'));return;
      }
      if(m.request){save.textContent='Verify saved recording';m.status.append(btn('Close and verify later',()=>{m.request=null;m.close();}));}
    }finally{busy=false;save.disabled=false;}
  });
}
window.EGCWalkthroughRecording={open};
})();
