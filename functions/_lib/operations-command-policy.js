import {BRIDGE_COMMAND_POLICY,MCP_PRINCIPAL_PATTERN,bridgeCommandDenial,bridgeCommandPolicy} from '../../egc-platform/services/operations/src/bridge-command-policy.ts';
import {HUB_COMMAND_POLICY,hubCommandDenial,hubCommandPolicy,isHubCommandName} from '../../egc-platform/services/operations/src/hub-command-policy.ts';
import {consumeConfirmation,verifyConfirmation} from './confirm-token.js';
import {auditWrite} from './hub-audit.js';

/* SEC-04: one authorization step for every command the signed operations bridge
 * dispatches. BRIDGE_COMMAND_POLICY (the same file the API authorize() reads) covers
 * the legacy commands and HUB_COMMAND_POLICY the hub.* registry;
 * OPERATIONS_COMMAND_POLICY is their union as one read-only table. A hub.* entry
 * never takes a SEC-03 token (confirm:false); `confirmed` says the body must carry
 * the registry's own confirmed:true flag, and an integration actor marked
 * delegate:true may call it only with a delegate the Hub verifies.
 * prepareBridgeCommand() authorizes the verified actor before any storage access,
 * strips the bridge-only fields (via, onBehalfOf, confirmation) so every lib sees and
 * fingerprints the body it always did, verifies a SEC-03 confirmation where the
 * policy needs one, and returns store(inner): for writes, a wrapper whose single
 * commit also creates the SEC-02 hub_audit entry and consumes that confirmation. */
export {BRIDGE_COMMAND_POLICY};
const fail=(code,status=403)=>Object.assign(new Error(code),{code,status});
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const VIA=new Set(['mcp','portal']);
// Without a signed `via`, the verified actor names its source: only Hub sessions reach
// the bridge as humans and only the MCP mints its principals; API workers stay 'bridge'.
const actorVia=actor=>actor?.kind==='human'?'portal':actor?.kind==='integration'&&MCP_PRINCIPAL_PATTERN.test(String(actor.id))?'mcp':'bridge';
// The hub_audit account pattern: an actor that cannot be audited cannot write.
const ACCOUNT=/^[a-z0-9][a-z0-9_.@:+-]{0,119}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET=/^[A-Za-z0-9_-]{1,180}$/;
const TARGET_FIELDS=['portalVisitId','portalJobId','recordingId','jobId','portalCustomerId'];
// authorizeCommand returns the same kind/confirm/confirmed for a hub.* command.
const hubSemantics=rule=>({kind:rule.write?'write':'read',confirm:false,confirmed:rule.confirmRequired});
const hubEntry=rule=>Object.freeze({...hubSemantics(rule),
  actors:Object.freeze([...rule.roles.filter(role=>!rule.ownerOnly||role==='owner').map(role=>Object.freeze({kind:'human',role})),
    ...(rule.integrationAllowed&&!rule.write?[Object.freeze({kind:'integration',role:'integration',delegate:true})]:[])])});
export const OPERATIONS_COMMAND_POLICY=Object.freeze({...BRIDGE_COMMAND_POLICY,...Object.fromEntries(Object.keys(HUB_COMMAND_POLICY).map(name=>[name,hubEntry(HUB_COMMAND_POLICY[name])]))});

/** Destructive legacy commands (a visit cancellation) need a token once the owner turns this on. */
export const bridgeConfirmationRequired=env=>env?.EGC_OPERATIONS_BRIDGE_CONFIRM_REQUIRED==='true';

/** The record a command changes, for confirmation binding and the audit entry. */
export function bridgeTarget(command){
  for(const field of TARGET_FIELDS){const value=command?.[field];if(typeof value==='string'&&TARGET.test(value)&&!/^(_egc_|secure_)/.test(value))return value;}
  return null;
}

/** Returns the rule for this actor and command or throws {code,status}: 400 for a
 * command this endpoint does not run (`unknown`), 403 for an actor the policy refuses. */
export function authorizeCommand(actor,command,{commands=null,hub=false,unknown='bridge_command_unknown',policies=BRIDGE_COMMAND_POLICY,hubPolicies=HUB_COMMAND_POLICY}={}){
  const name=isObject(command)?command.command:undefined;
  if(typeof name!=='string')throw fail(unknown,400);
  if(hub&&isHubCommandName(name)){
    const rule=hubCommandPolicy(name,hubPolicies);
    if(!rule)throw fail('hub_command_unknown',400);
    if(!isObject(actor))throw fail('hub_actor_invalid');
    const denied=hubCommandDenial(actor,command,rule);
    if(denied)throw fail(denied);
    return Object.freeze({command:name,action:name,...hubSemantics(rule),hub:true});
  }
  if(commands&&!commands.includes(name))throw fail(unknown,400);
  const rule=bridgeCommandPolicy(command,policies);
  if(!rule)throw fail(unknown,400);
  const denied=bridgeCommandDenial(actor,rule);
  if(denied)throw fail(denied);
  return rule;
}

// SEC-03 errors carry human messages; the bridge relays codes only.
const relay=error=>{const code=String(error?.code||'');return /^(?:confirm_token|purpose_key)_[a-z_]+$/.test(code)?fail(code,error.status||403):fail('bridge_confirmation_invalid');};

function confirmationFor(actor,command,rule,now){
  const entityId=bridgeTarget(command);
  if(!entityId)throw fail('bridge_confirmation_target_missing',400);
  // The token binds the exact change; requestId only tells a retry from a reuse.
  const {requestId:_requestId,...payload}=command;
  return {actorId:String(actor.id),action:rule.action,entityId,payload,now};
}

function primaryWrite(writes,command){
  const target=bridgeTarget(command);
  return writes.find(write=>write.collection==='jobs'&&write.id===target)||writes.find(write=>write.collection==='jobs'&&typeof write.id==='string'&&!/^(_egc_|secure_)/.test(write.id))||writes[0];
}

/* walkthrough-handoff.js pattern: the lib keeps its own reads, preconditions and
 * receipt; its single commit gains the audit entry and, when confirmed, the
 * create-only confirm_tokens record, so all of them land or none do. */
function bridgeStore(env,inner,{command,confirmation},audit){
  const seen=new Map();
  return {...inner,
    async read(collection,id){const row=await inner.read(collection,id);seen.set(`${collection}/${id}`,row);return row;},
    async commit(writes){
      if(confirmation?.expired)throw fail('confirm_token_expired',410);
      if(!Array.isArray(writes)||!writes.length||writes.some(write=>!isObject(write)||typeof write.collection!=='string'||typeof write.id!=='string'))throw fail('bridge_commit_invalid',503);
      const target=primaryWrite(writes,command),patch=isObject(target.patch)?target.patch:{},prior=seen.get(`${target.collection}/${target.id}`);
      const entry=audit({collection:target.collection,id:target.id},isObject(prior)?Object.fromEntries(Object.keys(patch).map(key=>[key,prior[key]??null])):null,patch);
      if(!confirmation)return inner.commit([...writes,entry]);
      try{return await consumeConfirmation(env,inner,confirmation.token,confirmation.expected,[...writes,entry]);}
      catch(error){if(/^confirm_token_/.test(String(error?.code||'')))throw relay(error);throw error;}
    }};
}

/**
 * Authorizes and normalizes one verified bridge request. Returns {rule, command
 * (the body without via/onBehalfOf/confirmation), via, onBehalfOf, now, store(inner),
 * audit(entity, before, after)}; audit is null for reads. `via` is what the API
 * signed ('mcp' or 'portal'), else what the verified actor implies (actorVia). The confirmation is enforced for
 * confirm policies when EGC_OPERATIONS_BRIDGE_CONFIRM_REQUIRED is 'true', and is
 * always verified and consumed when one is sent. An expired token (flagged
 * confirmation.expired) still replays a committed request but never commits.
 */
export async function prepareBridgeCommand(env,actor,body,{now=new Date(),confirmRequired=bridgeConfirmationRequired(env),...options}={}){
  const rule=authorizeCommand(actor,body,options);
  const {via,onBehalfOf,...rest}=body;
  if(via!==undefined&&!VIA.has(via))throw fail('bridge_via_invalid',400);
  let behalf=null;
  if(onBehalfOf!==undefined){behalf=typeof onBehalfOf==='string'?onBehalfOf.trim().toLowerCase():'';if(!ACCOUNT.test(behalf))throw fail('bridge_on_behalf_of_invalid',400);}
  const at=now instanceof Date?now.toISOString():String(now);
  // hub.* bodies keep their own confirmed:true flag and receipts (operations-hub-commands.js).
  if(rule.hub)return {rule,command:rest,via:via||actorVia(actor),onBehalfOf:behalf,now:at,audit:null,store:inner=>inner};
  const {confirmation,...command}=rest;
  if(confirmation!==undefined&&!rule.confirm)throw fail('bridge_confirmation_unexpected',400);
  let confirmed=null;
  if(rule.confirm&&(confirmRequired||confirmation!==undefined)){
    if(typeof confirmation!=='string'||!confirmation)throw fail('bridge_confirmation_required');
    const expected=confirmationFor(actor,command,rule,at);
    let expired=false;
    // A token that is only expired still lets a retry of the SAME requestId reach the
    // lib's saved receipt; bridgeStore refuses any commit it would authorize.
    try{await verifyConfirmation(env,confirmation,expected);}
    catch(error){if(error?.code!=='confirm_token_expired'||!UUID.test(command.requestId||''))throw relay(error);expired=true;}
    confirmed={token:confirmation,expected:{...expected,...(UUID.test(command.requestId||'')?{requestId:command.requestId}:{})},...(expired?{expired}:{})};
  }
  const context={rule,command,via:via||actorVia(actor),onBehalfOf:behalf,now:at,confirmation:confirmed};
  if(rule.kind==='read')return {...context,audit:null,store:inner=>inner};
  if(!ACCOUNT.test(String(actor.id).toLowerCase()))throw fail('bridge_actor_unauditable');
  const audit=(entity,before,after)=>{
    try{return auditWrite({actor:{id:actor.id,kind:actor.kind,role:actor.role},via:context.via,onBehalfOf:behalf,action:rule.action,entity,before,after,requestId:UUID.test(command.requestId||'')?command.requestId:null,now:at});}
    catch(error){throw fail(/^hub_audit_[a-z_]+$/.test(String(error?.code||''))?error.code:'hub_audit_invalid',503);}
  };
  return {...context,audit,store:inner=>bridgeStore(env,inner,context,audit)};
}
