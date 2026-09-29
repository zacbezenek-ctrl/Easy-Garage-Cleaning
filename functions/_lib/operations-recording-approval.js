import {firestoreFetch} from './firebase-service-account.js';
import {decodeFirestoreFields,encodeFirestoreFields} from './firestore-job.js';
import {funnelEventWrite} from './funnel-events.js';
import {eventActor,eventVia,requestKey} from './dispatch-funnel.js';
import {commitConflict,commitFailure} from './firestore-errors.js';
import {hasBusinessAccess,isHubOwner,listHubUserProfiles} from './hub-session.js';
import {approvedEmployeeProfiles,employeeAccountsConfigured} from './employee-accounts.js';
import {capabilityRoleSet} from './staff-roles.js';
import {walkthroughPerformer} from './walkthrough-visit.js';
import {assignmentKey,createJobAssignmentAccess} from './job-assignment.js';

const BASE='https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents';
const NAME='projects/egcw-1ec83/databases/(default)/documents';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(value)&&!value.startsWith('secure_')&&!value.startsWith('_egc_');
const contactId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
function fail(code,status=409){throw Object.assign(new Error(code),{status});}
async function read(env,path,fetcher){const r=await fetcher(env,BASE+'/'+path);if(r.status===404)return null;if(!r.ok)fail('recording_source_unavailable',503);const d=await r.json();return{...decodeFirestoreFields(d.fields),id:String(d.name||'').split('/').pop(),revision:d.updateTime};}
/** The role sent to Operations is derived from the current signed Hub profile. */
export function recordingActorRole(profile,env={}){
  if(!walkthroughPerformer(profile,env))return null;
  const roles=capabilityRoleSet(profile,env);
  if(roles){
    if(roles.includes('owner')&&isHubOwner(profile))return'owner';
    if(roles.includes('manager'))return'manager';
    return roles.includes('sales')?'sales':null;
  }
  if(hasBusinessAccess(profile)&&profile.role==='owner'&&isHubOwner(profile))return'owner';
  if(hasBusinessAccess(profile)&&profile.role==='manager')return'manager';
  return profile.role==='sales'?'sales':null;
}
/** Recheck the API's signed human actor against today's approved Hub accounts. */
export async function currentRecordingProfile(env,actor){
  if(actor?.kind!=='human'||!assignmentKey(actor.id))fail('recording_actor_changed',403);
  const profiles=listHubUserProfiles(env);
  if(employeeAccountsConfigured(env))profiles.push(...await approvedEmployeeProfiles(env));
  const matching=profiles.filter(profile=>assignmentKey(profile.user)===assignmentKey(actor.id));
  if(matching.length!==1||recordingActorRole(matching[0],env)!==actor.role)fail('recording_actor_changed',403);
  return matching[0];
}
export async function resolveRecordingIdentity(env,jobId,fetcher=firestoreFetch,profile=null){return (await recordingSource(env,jobId,fetcher,profile)).identity;}
async function recordingSource(env,jobId,fetcher,profile=null){
  if(!id(jobId))fail('recording_source_not_found',404);
  const job=await read(env,'jobs/'+jobId,fetcher);
  if(!job||job.id!==jobId||!['job','walkthrough'].includes(job.type)||!job.revision)fail('recording_source_not_found',404);
  if(!id(job.customerId))fail('recording_customer_link_missing');
  const visitId=job.type==='walkthrough'?job.id:job.sourceWalkthroughId;
  if(!id(visitId))fail('recording_visit_link_missing');
  const visit=visitId===job.id?job:await read(env,'jobs/'+visitId,fetcher);
  if(!visit||visit.type!=='walkthrough'||visit.customerId!==job.customerId||(visitId!==job.id&&visit.convertedJobId&&visit.convertedJobId!==job.id))fail('recording_visit_job_mismatch');
  if(profile){
    const role=recordingActorRole(profile,env);
    if(!role)fail('recording_actor_changed',403);
    if(role==='sales'){
      const assignment=createJobAssignmentAccess(env,profile);
      const startedBy=assignmentKey(visit.walkthroughVisit?.startedBy);
      if(startedBy!==assignmentKey(profile.user)&&!await assignment.assigned(visit)&&!await assignment.assigned(job))fail('recording_source_forbidden',403);
    }
  }
  const customer=await read(env,'customers/'+job.customerId,fetcher);
  if(!customer||customer.id!==job.customerId)fail('recording_customer_link_missing');
  const jobContact=contactId(job.highlevelContactId)?job.highlevelContactId:null;
  const customerContact=contactId(customer.highlevelContactId)?customer.highlevelContactId:null;
  if(jobContact&&customerContact&&jobContact!==customerContact)fail('recording_contact_link_conflict');
  return{job,identity:{portalJobId:job.id,portalVisitId:visitId,portalCustomerId:job.customerId,portalProjectId:id(job.projectId)?job.projectId:null,portalRevision:job.revision,highlevelContactId:jobContact||customerContact||null,authority:'employee_hub'}};
}
/** audit(entity,before,after) returns one create-only write (operations-command-policy.js)
 * that joins the approval's commit, so the hub_audit entry lands exactly with it. */
export async function applyRecordingApproval(env,command,actor,fetcher=firestoreFetch,{now=new Date().toISOString(),audit=null,via='bridge'}={}){
  if(!uuid(command.recordingId)||!uuid(command.requestId)||!/^[a-f0-9]{64}$/.test(command.fingerprint||'')||!id(command.portalJobId)||typeof command.expectedRevision!=='string')fail('invalid_recording_approval',400);
  if(actor.kind!=='human'||!['owner','manager'].includes(actor.role))fail('human_manager_approval_required',403);
  const path='operation_recording_approvals/'+command.recordingId;
  const replay=saved=>{if(saved.fingerprint!==command.fingerprint||saved.portalJobId!==command.portalJobId)fail('recording_approval_conflict');return{ok:true,alreadyApplied:true,recordingId:command.recordingId,appliedAt:saved.appliedAt};};
  const previous=await read(env,path,fetcher);
  if(previous)return replay(previous);
  const {job,identity}=await recordingSource(env,command.portalJobId,fetcher);
  if(identity.portalRevision!==command.expectedRevision)fail('recording_source_revision_conflict');
  if(identity.portalVisitId!==command.portalVisitId||identity.portalCustomerId!==command.portalCustomerId||identity.portalProjectId!==(command.portalProjectId||null))fail('recording_identity_changed');
  const extraction=command.extraction;
  if(!extraction||typeof extraction!=='object'||Array.isArray(extraction)||JSON.stringify(extraction).length>90000)fail('invalid_recording_scope',400);
  const appliedAt=now;
  // Staff review is not customer acceptance. Existing sold scope, signatures, prices and payment evidence stay intact.
  const reviewed={recordingId:command.recordingId,approvedBy:actor.id,approvedAt:appliedAt,scope:extraction,sourceRevision:identity.portalRevision,approvalKind:'staff_recording_review'};
  const receipt={...identity,recordingId:command.recordingId,requestId:command.requestId,fingerprint:command.fingerprint,actorId:actor.id,appliedAt,reviewed};
  const audited=audit?[audit({collection:'jobs',id:identity.portalJobId},null,{reviewedWalkthroughScope:reviewed})]:[];
  // FUN-02: scope.reviewed commits with the review and its receipt.
  let event;
  try{event=await funnelEventWrite(null,appliedAt,{type:'scope.reviewed',idempotencyKey:requestKey(command.requestId),walkthroughId:identity.portalVisitId,...(identity.portalJobId!==identity.portalVisitId?{jobId:identity.portalJobId}:{}),projectId:identity.portalProjectId||undefined,customerId:identity.portalCustomerId,highlevelContactId:/^[A-Za-z0-9_-]{1,120}$/.test(identity.highlevelContactId||'')?identity.highlevelContactId:undefined,actor:eventActor(actor),via:eventVia(via),source:{collection:'operation_recording_approvals',id:command.recordingId},eligibility:{hub:job}});}
  catch{fail('recording_event_invalid',503);}
  const r=await fetcher(env,BASE+':commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({writes:[
    {update:{name:NAME+'/jobs/'+identity.portalJobId,fields:encodeFirestoreFields({reviewedWalkthroughScope:reviewed,updatedAt:appliedAt})},updateMask:{fieldPaths:['reviewedWalkthroughScope','updatedAt']},currentDocument:{updateTime:identity.portalRevision}},
    {update:{name:NAME+'/'+path,fields:encodeFirestoreFields(receipt)},currentDocument:{exists:false}},
    {update:{name:NAME+'/funnelEvents/'+event.id,fields:encodeFirestoreFields(event.patch)},currentDocument:{exists:false}},
    ...audited.map(write=>({update:{name:NAME+'/'+write.collection+'/'+write.id,fields:encodeFirestoreFields(write.patch)},currentDocument:{exists:false}}))
  ]})});
  if(!r.ok){
    if(!commitConflict(await commitFailure(r)))fail('recording_approval_outcome_unknown',503);
    // Nothing applied, but an overlapping identical request may have committed first and made our job revision stale.
    const saved=await read(env,path,fetcher).catch(()=>fail('recording_approval_outcome_unknown',503));
    if(saved)return replay(saved);
    fail('recording_source_revision_conflict');
  }
  return{ok:true,alreadyApplied:false,recordingId:command.recordingId,appliedAt};
}
