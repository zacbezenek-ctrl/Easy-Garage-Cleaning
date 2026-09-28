// Follow-up owner: an explicit EGC_OPERATIONS_INBOUND_OWNER_ID always wins. Otherwise
// EGC_OPERATIONS_FOLLOWUP_ROLE (owner|manager|sales|phone) selects the sole member with
// that role; unset keeps the sole authoritative owner. Ambiguity stays unresolved.
const ROLES=['owner','manager','sales','phone'];
export function inboundResponsePolicy(env,members){
  const configured=typeof env.EGC_OPERATIONS_INBOUND_OWNER_ID==='string'?env.EGC_OPERATIONS_INBOUND_OWNER_ID.trim():'';
  const followupRole=typeof env.EGC_OPERATIONS_FOLLOWUP_ROLE==='string'?env.EGC_OPERATIONS_FOLLOWUP_ROLE.trim().toLowerCase():'';
  const active=members.filter(m=>m&&typeof m.id==='string'&&ROLES.includes(m.role));
  const owners=active.filter(m=>m.role==='owner');
  const roleMembers=ROLES.includes(followupRole)?active.filter(m=>m.role===followupRole||Array.isArray(m.staffRoles)&&m.staffRoles.includes(followupRole)):[];
  const owner=configured?active.find(m=>m.id===configured):followupRole?roleMembers.length===1?roleMembers[0]:null:owners.length===1?owners[0]:null;
  const ownerSource=configured?'explicit_hub_configuration':followupRole?!ROLES.includes(followupRole)?'invalid_followup_role_configuration':roleMembers.length===1?'sole_followup_role_member':'unresolved':owners.length===1?'sole_authoritative_owner':'unresolved';
  const minutes=env.EGC_OPERATIONS_INBOUND_REPLY_MINUTES===undefined?60:Number(env.EGC_OPERATIONS_INBOUND_REPLY_MINUTES);
  const validMinutes=Number.isInteger(minutes)&&minutes>=5&&minutes<=10080;
  return{authority:'employee_hub',version:1,inboundResponse:{enabled:Boolean(owner&&validMinutes),ownerId:owner?.id??null,dueMinutes:validMinutes?minutes:null,
    ownerSource,dueSource:env.EGC_OPERATIONS_INBOUND_REPLY_MINUTES===undefined?'default_60_minute_response_rule':'explicit_hub_configuration',
    blockedReason:!owner?'inbound_owner_unresolved':!validMinutes?'inbound_due_rule_invalid':null}};
}
