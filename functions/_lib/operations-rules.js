export function inboundResponsePolicy(env,members){
  const configured=typeof env.EGC_OPERATIONS_INBOUND_OWNER_ID==='string'?env.EGC_OPERATIONS_INBOUND_OWNER_ID.trim():'';
  const active=members.filter(m=>m&&typeof m.id==='string'&&['owner','manager','sales'].includes(m.role));
  const owners=active.filter(m=>m.role==='owner');
  const owner=configured?active.find(m=>m.id===configured):owners.length===1?owners[0]:null;
  const minutes=env.EGC_OPERATIONS_INBOUND_REPLY_MINUTES===undefined?60:Number(env.EGC_OPERATIONS_INBOUND_REPLY_MINUTES);
  const validMinutes=Number.isInteger(minutes)&&minutes>=5&&minutes<=10080;
  return{authority:'employee_hub',version:1,inboundResponse:{enabled:Boolean(owner&&validMinutes),ownerId:owner?.id??null,dueMinutes:validMinutes?minutes:null,
    ownerSource:configured?'explicit_hub_configuration':owners.length===1?'sole_authoritative_owner':'unresolved',dueSource:env.EGC_OPERATIONS_INBOUND_REPLY_MINUTES===undefined?'default_60_minute_response_rule':'explicit_hub_configuration',
    blockedReason:!owner?'inbound_owner_unresolved':!validMinutes?'inbound_due_rule_invalid':null}};
}
