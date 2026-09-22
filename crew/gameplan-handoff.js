(function (root) {
  'use strict';
  const select = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key]]));
  function signedPlan(p) {
    return { ...select(p, ['discovery','scope','logistics','internal_notes','client_checklists','signature','acceptance','terms_version','terms_accepted','photos','notes']),
      client: select(p.client, ['name','phone','email','address','highlevel_contact_id']),
      quote: select(p.quote, ['title','total','deposit','job_date','start_time','end_time','estimated_duration_min']) };
  }
  // This controller owns one frozen, actor-scoped request through lost responses.
  // Neither a reload nor a CRM outage creates a second dispatch request.
  function createClient(d) {
    let active = null;
    const key = (actor, source) => `egc-signed-handoff-v1:${actor}:${source || 'manual'}`;
    function read(k) { try { return JSON.parse(d.storage.getItem(k) || 'null'); } catch { throw new Error('The saved handoff request is unreadable. Review the existing job in Dispatch before saving again.'); } }
    const identity = p => JSON.stringify({...p,client:{...p.client,highlevel_contact_id:undefined}});
    function remember(k, pending) { d.storage.setItem(k, JSON.stringify(pending)); }
    async function request(url, body) {
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
      let r;try{r = await d.fetch(url, body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal} : {cache:'no-store',signal:controller.signal});}finally{clearTimeout(timer);}
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok !== true) throw Object.assign(new Error(data.error || 'The saved request could not be verified. Retry without changing it.'), {status:r.status,code:data.code});
      return data;
    }
    async function perform(recoverOriginal = false) {
      const actor = await d.actor(); if (!actor) throw new Error('Sign in to the Employee Hub before saving.');
      const source = d.source(), k = key(actor, source), currentPlan = signedPlan(d.plan());
      let pending = read(k);
      if (pending && pending.actor !== actor) throw new Error('This request belongs to another signed-in employee.');
      if (pending && !recoverOriginal && identity(pending.plan) !== identity(currentPlan)) {
        if (!pending.body) { d.storage.removeItem(k); pending = null; }
        else throw Object.assign(new Error('An earlier signed version has an unresolved or saved handoff. Recover that original save before submitting changes.'),{code:'handoff_original_request_required'});
      }
      if (!pending) {
        pending = {actor,source,requestId:d.uuid(),resolveRequestId:d.uuid(),plan:currentPlan,photoDraftJobId:d.photoDraftId(),body:null,result:null};
        remember(k,pending); // Durable in the browser before any server mutation.
      }
      if (!pending.body) {
        const query = new URLSearchParams(); if (source) query.set('sourceWalkthroughId',source);
        if (d.savedJobId()) query.set('jobId',d.savedJobId());
        const prepared = await request('/api/walkthrough-handoff?' + query);
        if (prepared.viewer?.id !== actor) throw new Error('The signed-in account changed. Reload before saving.');
        let customerId = prepared.customerId;
        if (!customerId) {
          const c=pending.plan.client;
          const resolved=await request('/api/customer-resolve',{requestId:pending.resolveRequestId,customer:{name:c.name,phone:c.phone,email:c.email,address:c.address,highlevelContactId:c.highlevel_contact_id || ''}});
          customerId=resolved.customer?.id;
        }
        if (!customerId) throw new Error('The canonical customer could not be verified.');
        pending.body={actorId:actor,requestId:pending.requestId,customerId,sourceWalkthroughId:source,sourceRevision:prepared.sourceRevision || '',jobId:prepared.jobId || '',expectedRevision:prepared.expectedRevision || '',plan:pending.plan};
        remember(k,pending);
      }
      if (await d.actor() !== actor) throw new Error('The signed-in account changed. Reopen the original account to recover this request.');
      // Re-read even a prior success: cancellation, changed evidence, and identity
      // changes must not be hidden by a success cached on this phone.
      const result=await request('/api/walkthrough-handoff',pending.body);
      if (result.requestId !== pending.requestId || !result.job?.id || result.job.customerId !== pending.body.customerId) throw new Error('The saved job identity did not match the request. Review Dispatch before retrying.');
      pending.result=result;remember(k,pending);
      d.accept(result,pending);
      return {result,pending,key:k};
    }
    function save(recoverOriginal=false) {
      if(active)return active;
      active=perform(recoverOriginal).finally(()=>{active=null;}); return active;
    }
    async function sync(saved) {
      if (await d.actor() !== saved.pending.actor) throw new Error('The signed-in account changed. Sign in again before synchronizing.');
      return request('/api/highlevel',{tool:'game_plan',job_id:saved.result.job.id,handoff_request_id:saved.pending.requestId});
    }
    function release(saved) {
      const current=read(saved.key);
      if(current?.requestId===saved.pending.requestId)d.storage.removeItem(saved.key);
    }
    return {save,sync,release};
  }
  root.EGCWalkthroughHandoffClient=createClient;
  if (typeof S === 'undefined') return;
  const actor=async()=>{const user=await EGCHubAuth.session();return typeof user==='string'?user:user?.user || '';};
  const client=createClient({storage:sessionStorage,fetch:(...args)=>EGCHubAuth.fetch(...args),actor,uuid:()=>crypto.randomUUID(),plan:()=>payload(),source:()=>S.sourceWalkthroughId || '',savedJobId:()=>S.handoffJobId || '',photoDraftId:()=>S.photoDraftJobId || S.jobId,
    accept:(result,pending)=>{
      S.photoDraftJobId=pending.photoDraftJobId || S.photoDraftJobId || S.jobId;
      S.jobId=result.job.id; S.handoffJobId=result.job.id; S.customerId=result.job.customerId;
      S.handoffRequestId=pending.requestId;
      S.highlevelContactId=result.job.highlevelContactId || S.highlevelContactId;
      S.highlevelJobAppointmentId=result.job.highlevelAppointmentId || S.highlevelJobAppointmentId;
      S.highlevelOpportunityId=result.job.highlevelOpportunityId || S.highlevelOpportunityId;save();
    }});
  let sending=false;
  async function send(button,recoverOriginal=false) {
    if(sending)return;
    const status=$('send-status'),missing=readyToSend();
    if(!recoverOriginal&&missing.length){status.textContent='Add '+missing.join(', ')+'.';return;}
    sending=true;button.disabled=true;button.textContent=recoverOriginal?'Recovering original save…':'Saving signed job…';
    let saved;
    try {
      saved=await client.save(recoverOriginal);
      button.textContent='Job saved. Syncing photos…';
      let photos={status:'device_only'};
      try{photos=await syncWalkthroughPhotos();}catch{photos={status:'error'};}
      button.textContent='Job saved. Syncing HighLevel…';
      const synced=await client.sync(saved);
      S.highlevelContactId=synced.contactId || S.highlevelContactId;
      S.highlevelJobAppointmentId=synced.appointmentId || S.highlevelJobAppointmentId;
      S.highlevelOpportunityId=synced.pipeline?.opportunityId || S.highlevelOpportunityId;
      if(!recoverOriginal)writeActive();save();
      const portal=synced.portalInvitation;
      const portalText=portal?.status==='submitted'?(portal.channel==='Email'?'Portal email queued in HighLevel. ':'Portal text queued in HighLevel. '):portal?.status==='suppressed'?'Portal delivery is paused. ':'Portal delivery needs attention in Estimates & payments. ';
      const scheduleText=synced.handoffSync?.status==='synced'?'Job and CRM schedule verified. ':'Job saved; CRM reconciliation still needs attention. ';
      const photoText=photos.status==='synced'?'Walkthrough photos uploaded. ':photos.status==='needs_setup'?'Drive needs setup; photos remain on this device. ':'Photos remain on this device; upload needs attention. ';
      const staffing=saved.result.warnings.some(x=>['unassigned','crew_size_short','missing_crew_lead'].includes(x.code))?'Assign the required crew in Dispatch before work. ':'';
      status.textContent=portalText+scheduleText+photoText+staffing+(recoverOriginal?'The original signed version was recovered; review any later form edits separately.':'');
      button.disabled=false;button.textContent=photos.status==='synced'&&synced.handoffSync?.status==='synced'?'Saved — verify again':'Retry remaining synchronization';
      // Keep the same immutable request for photo/CRM retries. A signed revision
      // is a separate explicit action only after the original save is confirmed.
      const revise=document.createElement('button');revise.type='button';revise.textContent='Start a signed revision';
      revise.onclick=()=>{client.release(saved);invalidateAcceptance();save();render();};status.appendChild(revise);
    } catch(error) {
      button.disabled=false;button.textContent=saved?'Retry synchronization':'Retry original save';
      status.textContent=(saved?'The signed Hub job is saved. ':'')+(error.message || 'The request could not be verified. Keep this form and retry.');
      if(error.code==='handoff_original_request_required'){
        const recover=document.createElement('button');recover.type='button';recover.textContent='Recover original signed save';recover.onclick=()=>send(button,true);status.appendChild(recover);
      }
    } finally {sending=false;}
  }
  async function openings(force=false) {
    const signature=slotSignature(); if(SLOT_LOADING||!force&&SLOT_SIGNATURE===signature)return;
    SLOT_SIGNATURE=signature;SLOT_LOADING=true;SLOT_ERROR='';SLOT_OPTIONS=[];render();
    try {
      const r=await EGCHubAuth.fetch('/api/walkthrough-handoff',{cache:'no-store'}),data=await r.json();
      if(!r.ok||!data.ok)throw new Error(data.error || 'The crew roster is unavailable.');
      const names=String(S.assignedTo || '').split(/[,/;+&]/).map(x=>x.trim()).filter(Boolean);
      const key=x=>String(x).trim().toLowerCase();
      const ids=names.map(name=>{const exact=data.roster.filter(p=>p.id===key(name));const found=exact.length?exact:data.roster.filter(p=>key(p.name)===key(name));return found.length===1?found[0].id:null;});
      if(!ids.length||ids.some(x=>!x)||ids.length<Number(S.crewSize))throw new Error('Choose the actual employees for the required crew to verify openings. Unassigned work can still be saved and staffed in Dispatch.');
      const q=new URLSearchParams({employeeIds:ids.join(','),durationMinutes:String(estimatedJobMinutes()),travelBufferMinutes:'20'});
      const response=await EGCHubAuth.fetch('/api/dispatch-openings?'+q,{cache:'no-store'}),body=await response.json();
      if(!response.ok||!body.ok)throw new Error(body.error || 'Capacity could not be verified.');
      SLOT_OPTIONS=(body.candidates || []).slice(0,3).map(row=>({date:row.date,start:row.time || row.startTime,end:row.endTime,label:row.date}));
      if(!SLOT_OPTIONS.length)SLOT_ERROR='No conflict-free opening fits this crew in the next seven days. Review Dispatch or choose another crew.';
    }catch(error){SLOT_ERROR=error.message || 'Capacity could not be verified.';}
    finally{SLOT_LOADING=false;render();}
  }
  async function photoState(id,patch) {
    const db=await dbOpen();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('p','readwrite'),store=tx.objectStore('p'),read=store.get(id);let next;
      read.onsuccess=()=>{if(!read.result){tx.abort();return;}next={...read.result,...patch};store.put(next);};
      tx.oncomplete=()=>resolve(next);tx.onerror=()=>reject(tx.error || new Error('Photo retry information could not be saved.'));
      tx.onabort=()=>reject(tx.error || new Error('Photo is no longer on this device.'));
    });
  }
  async function photos() {
    const originals=await photoList(),user=await actor();
    if(!user||!S.handoffJobId||S.handoffJobId!==S.jobId)throw new Error('Save the canonical job before uploading its reference photos.');
    const get=async()=>{const r=await EGCHubAuth.fetch('/api/field-jobs?jobId='+encodeURIComponent(S.jobId),{cache:'no-store'}),j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error || 'The job photo record could not be read.');return j;};
    let current=await get(); if(!current.photosAvailable)return{status:'needs_setup'};
    for(let photo of originals) {
      if(photo.fieldPhotoRequestId&&current.job.photos.some(p=>p.id===photo.fieldPhotoRequestId&&p.category==='walkthrough')){await photoState(photo.id,{uploaded:true,uploadedToJobId:S.jobId});continue;}
      if(photo.uploadedToJobId&&photo.uploadedToJobId!==S.jobId)throw new Error('This photo belongs to a different saved job. Review the photo queue.');
      if(!photo.fieldPhotoRequestId)photo=await photoState(photo.id,{fieldPhotoRequestId:crypto.randomUUID(),fieldPhotoRevision:current.job.expectedRevision,fieldPhotoActor:user,uploadedToJobId:S.jobId,uploaded:false});
      if(photo.fieldPhotoActor!==user)throw new Error('Reopen the original employee account to recover its photo upload.');
      const body={action:'photo',jobId:S.jobId,requestId:photo.fieldPhotoRequestId,expectedRevision:photo.fieldPhotoRevision,expectedUser:user,category:'walkthrough',caption:'Walkthrough reference — confirm conditions on arrival.',dataUrl:photo.dataUrl};
      let r=await EGCHubAuth.fetch('/api/field-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),data=await r.json().catch(()=>({}));
      if(r.status===409&&data.code==='FIELD_REVISION_CONFLICT') {
        current=await get();
        if(current.job.photos.some(p=>p.id===body.requestId&&p.category==='walkthrough')){await photoState(photo.id,{uploaded:true});continue;}
        // Retain the same upload identity. If an earlier request did commit,
        // its fingerprint guard prevents a second file or overwritten evidence.
        photo=await photoState(photo.id,{fieldPhotoRevision:current.job.expectedRevision});body.expectedRevision=photo.fieldPhotoRevision;
        r=await EGCHubAuth.fetch('/api/field-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});data=await r.json().catch(()=>({}));
      }
      if(!r.ok||!data.ok||!data.job?.photos.some(p=>p.id===body.requestId&&p.category==='walkthrough'))throw new Error(data.error || 'The photo upload has not been verified. Keep it on this device and retry.');
      current=data;await photoState(photo.id,{uploaded:true,uploadedToJobId:S.jobId});
    }
    return{status:originals.length?'synced':'none',verified:originals.length};
  }
  root.EGCWalkthroughHandoff={save:()=>client.save(),send,openings,photos};
})(window);
