import {HUB_COMMAND_POLICY,hubCommandDenial,isHubCommandName,isHubRequestId} from '../../egc-platform/services/operations/src/hub-command-policy.ts';
import {dispatchOverview} from './dispatch-service.js';
import {dispatchStorage} from './dispatch-storage.js';
import {listHubUserProfiles} from './hub-session.js';
import {operationsActorSession,operationsDelegates} from './operations-actor-session.js';

/* One registry for Hub domains reached through the signed operations bridge.
 * handler(store, actor, command, now): store is injected, actor carries the verified
 * bridge identity plus a session for existing Hub modules, command is the sanitized
 * input and now is a Date. A WRITE handler honors command.expectedRevision when
 * revisioned and performs its mutation with exactly ONE
 * store.commit(writes, {before, after}) (writes may be empty for a no-op). The runner
 * appends a create-only server-only receipt hub_command_operations/{requestId} to that
 * same atomic commit, so every write is audited, a retry with the same requestId
 * replays the saved outcome without re-running the handler, and a lost commit
 * response is recovered from the receipt. The write response IS the saved receipt. */
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
export const HUB_COMMAND_RECEIPTS='hub_command_operations';
const MAX_SNAPSHOT_CHARS=200000;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const SAFE_CODE=/^(?:hub|dispatch)_[a-z_]+$/;
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const safeId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(id)&&!/^(secure_|_egc_)/.test(id);
const staffRow=({id,name,role})=>({id,name,role});
function only(input,keys){if(Object.keys(input).some(key=>!keys.includes(key)))throw fail('hub_command_invalid');return input;}
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:isObject(value)?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const sha256=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value))))].map(byte=>byte.toString(16).padStart(2,'0')).join('');

function overviewInput(input){
  only(input,['view','startDate','endDate','includeUnscheduled','jobId']);
  const view=input.view===undefined?'schedule':input.view;
  if(view==='job'){
    if(!safeId(input.jobId)||['startDate','endDate','includeUnscheduled'].some(key=>input[key]!==undefined))throw fail('hub_command_invalid');
    return {view,jobId:input.jobId};
  }
  if(view!=='schedule'||input.jobId!==undefined)throw fail('hub_command_invalid');
  for(const key of ['startDate','endDate'])if(input[key]!==undefined&&(typeof input[key]!=='string'||!DATE.test(input[key])))throw fail('hub_command_invalid');
  if(input.includeUnscheduled!==undefined&&typeof input.includeUnscheduled!=='boolean')throw fail('hub_command_invalid');
  return {view,...Object.fromEntries(['startDate','endDate','includeUnscheduled'].filter(key=>input[key]!==undefined).map(key=>[key,input[key]]))};
}

export const HUB_COMMAND_REGISTRY=Object.freeze({
  'hub.dispatch.overview':Object.freeze({...HUB_COMMAND_POLICY['hub.dispatch.overview'],input:overviewInput,
    handler:async(store,actor,command,now)=>{const result=await dispatchOverview(store,actor.session,command,now);return {...result,roster:result.roster.map(staffRow)};}}),
  'hub.staff.roster':Object.freeze({...HUB_COMMAND_POLICY['hub.staff.roster'],input:input=>only(input,[]),
    handler:async(store,actor,command,now)=>{
      const roster=await store.roster();
      if(!Array.isArray(roster))throw fail('hub_source_unavailable',503);
      return {staff:roster.map(staffRow),coverage:{complete:true,asOf:now.toISOString()}};
    }}),
});

export const isHubCommand=command=>isHubCommandName(command?.command);

/* Snapshots are stored as JSON text so any plain before/after survives Firestore's
 * map-key and nested-array limits byte for byte. */
function auditSnapshot(snapshot){
  if(!isObject(snapshot)||!Object.hasOwn(snapshot,'before')||!(snapshot.before===null||isObject(snapshot.before))||!isObject(snapshot.after))throw fail('hub_audit_snapshot_missing',503);
  let before,after;
  try{before=JSON.stringify(snapshot.before);after=JSON.stringify(snapshot.after);}catch{throw fail('hub_audit_snapshot_missing',503);}
  if(before.length+after.length>MAX_SNAPSHOT_CHARS)throw fail('hub_audit_snapshot_too_large',503);
  return {before,after};
}
function parseSnapshot(text,allowNull){
  if(typeof text!=='string')throw fail('hub_receipt_invalid',503);
  let value;try{value=JSON.parse(text);}catch{throw fail('hub_receipt_invalid',503);}
  if(!(isObject(value)||allowNull&&value===null))throw fail('hub_receipt_invalid',503);
  return value;
}
/** The saved outcome for requestId, or null when no receipt exists. */
async function savedOutcome(store,receiptId,fingerprint,attempt){
  const receipt=await store.read(HUB_COMMAND_RECEIPTS,receiptId);
  if(receipt===null||receipt===undefined)return null;
  if(!isObject(receipt))throw fail('hub_receipt_invalid',503);
  if(receipt.fingerprint!==fingerprint)throw fail('hub_idempotency_conflict',409);
  const actor=receipt.actor;
  if(typeof receipt.requestId!=='string'||receipt.requestId.toLowerCase()!==receiptId||typeof receipt.attempt!=='string'||typeof receipt.command!=='string'||!isObject(actor)||typeof actor.id!=='string'||typeof actor.kind!=='string'||typeof receipt.user!=='string'||typeof receipt.at!=='string')throw fail('hub_receipt_invalid',503);
  const before=parseSnapshot(receipt.before,true),after=parseSnapshot(receipt.after,false),delegatedBy=typeof receipt.delegatedBy==='string'?receipt.delegatedBy:null;
  return {ok:true,authority:'employee_hub',command:receipt.command,requestId:receipt.requestId,replayed:receipt.attempt!==attempt,actedAs:{user:receipt.user,delegatedBy},before,after,
    audit:{requestId:receipt.requestId,command:receipt.command,actorId:actor.id,actorKind:actor.kind,user:receipt.user,before,after,at:receipt.at}};
}
/* walkthrough-handoff.js pattern: wrap the store so the handler's single commit also
 * creates the receipt. No revision means currentDocument.exists=false (create-only). */
function auditedStore(store,receiptId,receipt){
  let attempted=false;
  const adapter={...store,async commit(writes,snapshot){
    if(attempted)throw fail('hub_commit_repeated',503);
    if(!Array.isArray(writes)||writes.some(write=>!isObject(write)||write.collection===HUB_COMMAND_RECEIPTS))throw fail('hub_commit_invalid',503);
    const audit=auditSnapshot(snapshot);
    attempted=true;
    return store.commit([...writes,{collection:HUB_COMMAND_RECEIPTS,id:receiptId,patch:{...receipt,...audit}}]);
  }};
  return {adapter,attempted:()=>attempted};
}

async function runWrite(store,entry,bridgeActor,input,at,{command,requestId,attemptId}){
  const {session}=bridgeActor,receiptId=requestId.toLowerCase(),attempt=attemptId();
  const fingerprint=await sha256({actor:{id:bridgeActor.id,kind:bridgeActor.kind,workspace:bridgeActor.workspace??null},command});
  const saved=await savedOutcome(store,receiptId,fingerprint,null);
  if(saved)return saved;
  const audited=auditedStore(store,receiptId,{requestId,fingerprint,attempt,command:input.command,
    actor:{id:bridgeActor.id,kind:bridgeActor.kind,role:bridgeActor.role,workspace:bridgeActor.workspace??null},user:session.user,delegatedBy:session.delegatedBy??null,at:at.toISOString()});
  // Once the audited commit is durable the receipt IS the outcome: a later handler
  // error cannot undo it and a retry would replay it. Without a receipt, only a
  // definitive refusal (4xx, e.g. a revision conflict) is final; anything else may
  // still land, so the caller must retry the SAME requestId.
  const recover=async error=>{
    let recovered;
    try{recovered=await savedOutcome(store,receiptId,fingerprint,attempt);}
    catch(readError){if(readError?.code==='hub_idempotency_conflict')throw readError;throw fail('hub_outcome_unknown',503);}
    if(recovered)return recovered;
    if(error?.status>=400&&error.status<500)throw error;
    throw fail('hub_outcome_unknown',503);
  };
  try{await entry.handler(audited.adapter,bridgeActor,input,at);}
  catch(error){if(!audited.attempted())throw error;return recover(error);}
  if(!audited.attempted())throw fail('hub_audit_snapshot_missing',503);
  return recover(null);
}

export async function runHubCommand(env,actor,command,{registry=HUB_COMMAND_REGISTRY,storage=dispatchStorage,profiles=()=>listHubUserProfiles(env),delegates=()=>operationsDelegates(env),now=()=>new Date(),attemptId=()=>crypto.randomUUID()}={}){
  try{
    if(!isObject(actor))throw fail('hub_actor_invalid',403);
    if(!isObject(command))throw fail('hub_command_invalid');
    const name=command.command,entry=typeof name==='string'&&Object.hasOwn(registry,name)?registry[name]:null;
    if(!entry)throw fail('hub_command_unknown');
    const {command:_name,delegate,requestId,expectedRevision,confirmed,...fields}=command;
    if(entry.write&&!isHubRequestId(requestId))throw fail('hub_request_id_required');
    if(entry.revisioned&&(typeof expectedRevision!=='string'||!expectedRevision||expectedRevision.length>200))throw fail('hub_expected_revision_required');
    if(!entry.write&&requestId!==undefined||!entry.revisioned&&expectedRevision!==undefined||!entry.confirmRequired&&confirmed!==undefined)throw fail('hub_command_invalid');
    const denied=hubCommandDenial(actor,command,entry);
    if(denied)throw fail(denied,403);
    const session=operationsActorSession(actor,{profiles:profiles(),delegates:actor.kind==='integration'?delegates():new Map(),delegate,write:entry.write});
    if(!entry.roles.includes(session.role))throw fail('hub_role_forbidden',403);
    if(entry.ownerOnly&&session.role!=='owner')throw fail('hub_owner_required',403);
    const input={...entry.input(fields),command:name,...(entry.write?{requestId}:{}),...(entry.revisioned?{expectedRevision}:{})};
    const at=now(),bridgeActor=Object.freeze({id:actor.id,kind:actor.kind,role:actor.role,workspace:actor.workspace,session});
    if(entry.write)return await runWrite(storage(env),entry,bridgeActor,input,at,{command,requestId,attemptId});
    const result=await entry.handler(storage(env),bridgeActor,input,at);
    if(!isObject(result))throw fail('hub_result_invalid',503);
    return {...result,ok:true,authority:'employee_hub',command:name,actedAs:{user:session.user,delegatedBy:session.delegatedBy}};
  }catch(error){
    // The bridge relays only namespaced codes; Hub messages and storage internals stay here.
    if(SAFE_CODE.test(String(error?.code||''))&&(error.status>=400&&error.status<500||error.status===503))throw fail(error.code,error.status);
    throw fail('hub_source_unavailable',503);
  }
}
