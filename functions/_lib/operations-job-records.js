const safe=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(id)&&!/^(_egc_|secure_)/.test(id);
const fail=(code,status=409)=>Object.assign(new Error(code),{status});
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):v;
const digest=async v=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(v)))))].map(x=>x.toString(16).padStart(2,'0')).join('');
const output=r=>({id:r.id,revision:r.revision,type:r.type,customerId:r.customerId,projectId:r.projectId||null,sourceWalkthroughId:r.sourceWalkthroughId||null,status:r.pipelineStatus||r.status,notes:r.operationNotes||[],operationalScope:r.operationalScope||null,completedAt:r.completedAt||null});

/** Narrow, audited writes to the existing Hub records. Financial evidence,
 * signatures, provider linkage and scheduling are owned by their separate flows. */
export async function mutatePortalRecord(store,actor,command,now=new Date().toISOString()) {
  if(!['owner','manager','integration'].includes(actor.role))throw fail('record_write_requires_manager',403);
  if(!safe(command.portalJobId)||!/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(command.requestId||'')||!command.expectedRevision)throw fail('record_request_invalid',400);
  const receiptId=`_egc_record_op_${command.requestId.replaceAll('-','')}`,hash=await digest({actor:actor.id,command});
  const receipt=await store.read('jobs',receiptId);
  if(receipt){
    if(receipt.fingerprint!==hash)throw fail('record_idempotency_conflict');
    const live=await store.read('jobs',command.portalJobId);
    if(!live||live.customerId!==receipt.customerId||!['job','walkthrough'].includes(live.type)||live.recordType)throw fail('record_identity_changed_since_operation');
    const customer=await store.read('customers',live.customerId);
    if(!customer||customer.id!==live.customerId)throw fail('record_customer_link_missing');
    const currentStateMatches=Object.entries(receipt.patch||{}).every(([key,value])=>key==='operationNotes'
      ?Array.isArray(live.operationNotes)&&value.every(note=>live.operationNotes.some(n=>n.id===note.id&&JSON.stringify(canonical(n))===JSON.stringify(canonical(note))))
      :JSON.stringify(canonical(live[key]))===JSON.stringify(canonical(value)));
    return{ok:true,authority:'employee_hub',alreadyApplied:true,currentStateMatches,receipt,record:output(live)};
  }
  const record=await store.read('jobs',command.portalJobId);
  if(!record||!['job','walkthrough'].includes(record.type)||record.recordType)throw fail('portal_job_not_found',404);
  if(record.revision!==command.expectedRevision)throw fail('record_revision_conflict');
  const customer=safe(record.customerId)?await store.read('customers',record.customerId):null;
  if(!customer||customer.id!==record.customerId)throw fail('record_customer_link_missing');
  let patch={},writes=[],guards=[{collection:'customers',id:customer.id,revision:customer.revision,patch:{id:customer.id}}];
  if(command.command==='portal.project.ensure') {
    const rootId=record.type==='walkthrough'?record.id:record.sourceWalkthroughId||record.id;
    const root=rootId===record.id?record:await store.read('jobs',rootId);
    if(!root||root.customerId!==customer.id||rootId!==record.id&&root.type!=='walkthrough')throw fail('project_walkthrough_link_conflict');
    const projectId=root.projectId||record.projectId||`project_${rootId}`;
    if(!safe(projectId)||root.projectId&&record.projectId&&root.projectId!==record.projectId)throw fail('project_identity_conflict');
    const project=await store.read('projects',projectId);
    if(project&&(project.customerId!==customer.id||project.sourceRecordId!==rootId))throw fail('project_customer_conflict');
    if(!project)writes.push({collection:'projects',id:projectId,patch:{id:projectId,customerId:customer.id,sourceRecordId:rootId,sourceWalkthroughId:root.type==='walkthrough'?root.id:null,createdAt:now,createdBy:actor.id,authority:'employee_hub'}});
    else guards.push({collection:'projects',id:project.id,revision:project.revision,patch:{customerId:customer.id}});
    patch={projectId};
    if(root.id!==record.id&&!root.projectId)writes.push({collection:'jobs',id:root.id,revision:root.revision,patch:{projectId,updatedAt:now}});
    else if(root.id!==record.id)guards.push({collection:'jobs',id:root.id,revision:root.revision,patch:{customerId:customer.id}});
  } else if(command.command==='portal.note.add') {
    if(typeof command.body!=='string'||!command.body.trim()||command.body.length>10000)throw fail('note_body_invalid',400);
    const notes=Array.isArray(record.operationNotes)?record.operationNotes:[];
    if(notes.length>=200)throw fail('note_history_requires_archive');
    if(command.supersedes&&!notes.some(n=>n.id===command.supersedes))throw fail('note_revision_not_found');
    patch={operationNotes:[...notes,{id:command.requestId,body:command.body.trim(),actorId:actor.id,actorKind:actor.kind,createdAt:now,supersedes:command.supersedes||null,customerId:customer.id,portalJobId:record.id,projectId:record.projectId||null,source:'authorized_operational_note'}]};
  } else if(command.command==='portal.job.edit') {
    const changes=command.changes||{};
    if(!Object.keys(changes).length||Object.keys(changes).some(k=>!['operationalScope','status'].includes(k))||typeof command.reason!=='string'||command.reason.trim().length<3)throw fail('job_changes_invalid',400);
    if(changes.operationalScope!==undefined){if(typeof changes.operationalScope!=='string'||changes.operationalScope.length>20000)throw fail('operational_scope_invalid',400);patch.operationalScope={text:changes.operationalScope,updatedBy:actor.id,updatedAt:now,reason:command.reason,approvalKind:'staff_operational_instructions'};}
    if(changes.status!==undefined){
      const old=record.pipelineStatus||record.status;
      const transitions={scheduled:['dispatched','in_progress','completed'],dispatched:['in_progress','completed'],in_progress:['completed'],draft:[]};
      if(!(transitions[old]||[]).includes(changes.status))throw fail('job_transition_requires_review');
      patch={...patch,status:changes.status,pipelineStatus:changes.status};
      if(changes.status==='completed'){
        const occurred=Date.parse(command.occurredAt||'');
        if(!Number.isFinite(occurred)||occurred>Date.parse(now)+300000||occurred<Date.parse(record.createdAt||'1970-01-01')||typeof command.completionEvidence!=='string'||command.completionEvidence.trim().length<10)throw fail('completion_evidence_required',400);
        patch.completedAt=new Date(occurred).toISOString();patch.completionEvidence={kind:'authorized_staff_attestation',text:command.completionEvidence,actorId:actor.id,actorKind:actor.kind,recordedAt:now};
        if(record.type==='walkthrough')patch.walkthroughCompletedAt=patch.completedAt;
      }
    }
  } else throw fail('record_command_unsupported',400);
  const proof={recordType:'operational_record_receipt',command:command.command,requestId:command.requestId,fingerprint:hash,portalJobId:record.id,customerId:customer.id,actorId:actor.id,actorKind:actor.kind,beforeRevision:record.revision,patch,reason:command.reason||null,createdAt:now};
  writes.push({collection:'jobs',id:record.id,revision:record.revision,patch:{...patch,updatedAt:now}},{collection:'jobs',id:receiptId,patch:proof});
  // REST commit supports preconditions only on writes. These identity-field
  // no-ops fence read dependencies without changing their business content.
  writes.push(...guards.filter(g=>!writes.some(w=>w.collection===g.collection&&w.id===g.id)));
  try {await store.commit(writes);}catch(error){const recovered=await store.read('jobs',receiptId).catch(()=>null);if(recovered?.fingerprint!==hash)throw error;}
  const saved=await store.read('jobs',record.id);
  if(!saved||Object.keys(patch).some(k=>JSON.stringify(canonical(saved[k]))!==JSON.stringify(canonical(patch[k]))))throw fail('record_changed_after_commit');
  return {ok:true,authority:'employee_hub',alreadyApplied:false,receipt:proof,record:output(saved)};
}
