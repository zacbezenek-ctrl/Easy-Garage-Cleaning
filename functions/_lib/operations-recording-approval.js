import {firestoreFetch} from './firebase-service-account.js';
import {decodeFirestoreFields,encodeFirestoreFields} from './firestore-job.js';

const BASE='https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents';
const NAME='projects/egcw-1ec83/databases/(default)/documents';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(value)&&!value.startsWith('secure_')&&!value.startsWith('_egc_');
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
function fail(code,status=409){throw Object.assign(new Error(code),{status});}
async function read(env,path,fetcher){const r=await fetcher(env,BASE+'/'+path);if(r.status===404)return null;if(!r.ok)fail('recording_source_unavailable',503);const d=await r.json();return{...decodeFirestoreFields(d.fields),id:String(d.name||'').split('/').pop(),revision:d.updateTime};}
export async function resolveRecordingIdentity(env,jobId,fetcher=firestoreFetch){
  if(!id(jobId))fail('recording_source_not_found',404);
  const job=await read(env,'jobs/'+jobId,fetcher);
  if(!job||job.id!==jobId||!['job','walkthrough'].includes(job.type)||!job.revision)fail('recording_source_not_found',404);
  if(!id(job.customerId))fail('recording_customer_link_missing');
  const customer=await read(env,'customers/'+job.customerId,fetcher);
  if(!customer||customer.id!==job.customerId)fail('recording_customer_link_missing');
  const visitId=job.type==='walkthrough'?job.id:job.sourceWalkthroughId;
  if(!id(visitId))fail('recording_visit_link_missing');
  if(visitId!==job.id){const visit=await read(env,'jobs/'+visitId,fetcher);if(!visit||visit.type!=='walkthrough'||visit.customerId!==job.customerId||(visit.convertedJobId&&visit.convertedJobId!==job.id))fail('recording_visit_job_mismatch');}
  return{portalJobId:job.id,portalVisitId:visitId,portalCustomerId:job.customerId,portalProjectId:id(job.projectId)?job.projectId:null,portalRevision:job.revision,highlevelContactId:job.highlevelContactId||customer.highlevelContactId||null,authority:'employee_hub'};
}
export async function applyRecordingApproval(env,command,actor,fetcher=firestoreFetch){
  if(!uuid(command.recordingId)||!uuid(command.requestId)||!/^[a-f0-9]{64}$/.test(command.fingerprint||'')||!id(command.portalJobId)||typeof command.expectedRevision!=='string')fail('invalid_recording_approval',400);
  if(actor.kind!=='human'||!['owner','manager'].includes(actor.role))fail('human_manager_approval_required',403);
  const path='operation_recording_approvals/'+command.recordingId;
  const previous=await read(env,path,fetcher);
  if(previous){if(previous.fingerprint!==command.fingerprint||previous.portalJobId!==command.portalJobId)fail('recording_approval_conflict');return{ok:true,alreadyApplied:true,recordingId:command.recordingId,appliedAt:previous.appliedAt};}
  const identity=await resolveRecordingIdentity(env,command.portalJobId,fetcher);
  if(identity.portalRevision!==command.expectedRevision)fail('recording_source_revision_conflict');
  if(identity.portalVisitId!==command.portalVisitId||identity.portalCustomerId!==command.portalCustomerId||identity.portalProjectId!==(command.portalProjectId||null))fail('recording_identity_changed');
  const extraction=command.extraction;
  if(!extraction||typeof extraction!=='object'||Array.isArray(extraction)||JSON.stringify(extraction).length>90000)fail('invalid_recording_scope',400);
  const appliedAt=new Date().toISOString();
  // Staff review is not customer acceptance. Existing sold scope, signatures, prices and payment evidence stay intact.
  const reviewed={recordingId:command.recordingId,approvedBy:actor.id,approvedAt:appliedAt,scope:extraction,sourceRevision:identity.portalRevision,approvalKind:'staff_recording_review'};
  const receipt={...identity,recordingId:command.recordingId,requestId:command.requestId,fingerprint:command.fingerprint,actorId:actor.id,appliedAt,reviewed};
  const r=await fetcher(env,BASE+':commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({writes:[
    {update:{name:NAME+'/jobs/'+identity.portalJobId,fields:encodeFirestoreFields({reviewedWalkthroughScope:reviewed,updatedAt:appliedAt})},updateMask:{fieldPaths:['reviewedWalkthroughScope','updatedAt']},currentDocument:{updateTime:identity.portalRevision}},
    {update:{name:NAME+'/'+path,fields:encodeFirestoreFields(receipt)},currentDocument:{exists:false}}
  ]})});
  if(!r.ok){if([409,412].includes(r.status))fail('recording_source_revision_conflict');fail('recording_approval_outcome_unknown',503);}
  return{ok:true,alreadyApplied:false,recordingId:command.recordingId,appliedAt};
}
