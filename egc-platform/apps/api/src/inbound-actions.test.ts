import {describe,it,expect} from 'vitest';
import {InboundActionReconciler,followupAssignment,inboundAction,inboundRequestId,type InboundPolicy} from './inbound-actions.js';
const policy:InboundPolicy={authority:'employee_hub',inboundResponse:{enabled:true,ownerId:'verified-owner',dueMinutes:60,ownerSource:'sole_authoritative_owner',dueSource:'default_60_minute_response_rule',blockedReason:null}};
describe('canonical inbound response actions',()=>{
it('uses exact message/customer evidence and actual inbound time, independent of booking or lead age',()=>{const message={id:'message-a',contactId:'contact-a',occurredAt:new Date('2026-09-20T10:00:00Z'),body:'Customer reply'};const task=inboundAction(message,policy);expect(task.assignedUserId).toBe('verified-owner');expect(task.dueAt).toBe('2026-09-20T11:00:00.000Z');expect(task.contactId).toBe('contact-a');expect(task.portalJobId).toBeNull();expect(task.dedupeKey).toBe('inbound_reply:message-a');expect(task.sourceEvidence[0]).toMatchObject({source:'message',id:'message-a'});expect(task.draft).toBeNull();});
it('never invents owner, due policy, source authority or external message',()=>{for(const change of [{enabled:false},{ownerId:null},{dueMinutes:null},{dueMinutes:0}])expect(()=>inboundAction({id:'x',contactId:'c',occurredAt:new Date(),body:null},{...policy,inboundResponse:{...policy.inboundResponse,...change}})).toThrow('inbound_policy_unresolved');});
it('same source has durable stable logical ID, new message has different ID',()=>{expect(inboundRequestId('a')).toBe(inboundRequestId('a'));expect(inboundRequestId('a')).not.toBe(inboundRequestId('b'));expect(inboundRequestId('a')).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);});
it('returns and saves an allowlisted policy failure reason without the upstream body',async()=>{
 const writes:Record<string,unknown>[]=[];
 const tx={execute:async()=>[{locked:true}],select:()=>({from:()=>({where:async()=>[]})})};
 const db={insert:()=>({values:(row:Record<string,unknown>)=>{writes.push(row);return{onConflictDoNothing:async()=>undefined,onConflictDoUpdate:async()=>undefined};}}),select:()=>({from:()=>({where:async()=>[{cursor:'2026-09-22T00:00:00Z'}]})}),transaction:async(fn:(t:typeof tx)=>unknown)=>fn(tx)};
 const reconciler=new InboundActionReconciler(db as unknown as ConstructorParameters<typeof InboundActionReconciler>[0],{} as ConstructorParameters<typeof InboundActionReconciler>[1],async()=>{throw {code:'service_key_source_unavailable',status:503,message:'private token/customer body'};},'egc',()=>new Date('2026-09-22T01:00:00Z'));
 const result=await reconciler.run();expect(result).toMatchObject({ok:false,errorCode:'inbound_reconciliation_unavailable',failed:1,lastSuccessAt:null,failure:{stage:'inbound_policy',errorCode:'service_key_source_unavailable',httpStatus:503}});
 const saved=JSON.parse(String(writes.find(r=>r.key==='operations:inbound:status:egc')?.cursor));expect(saved.failure).toEqual({stage:'inbound_policy',errorCode:'service_key_source_unavailable',httpStatus:503});expect(JSON.stringify(result)+JSON.stringify(saved)).not.toContain('private');
});
});
describe('P3-04 follow-up owner and due time from the Hub policy',()=>{
const followup:InboundPolicy={...policy,followup:{enabled:true,ownerId:'Zoe.Synthetic',ownerRole:'sales',ownerSource:'settings',dueMinutes:240,dueSource:'default',sendWindow:{startHour:8,endHour:19,timeZone:'America/Denver'},blockedReason:null}};
// Shared with tests/operations-followup-policy.test.mjs: [from, due] in UTC across both 2026-27 DST changes.
const vectors=[['2026-09-22T15:00:00.000Z','2026-09-22T19:00:00.000Z'],['2026-09-22T23:30:00.000Z','2026-09-23T14:00:00.000Z'],['2026-09-22T08:00:00.000Z','2026-09-22T14:00:00.000Z'],['2026-09-22T10:00:00.000Z','2026-09-22T14:00:00.000Z'],['2026-09-22T21:00:00.000Z','2026-09-23T14:00:00.000Z'],['2026-10-31T23:00:00.000Z','2026-11-01T15:00:00.000Z'],['2027-03-13T23:00:00.000Z','2027-03-14T14:00:00.000Z'],['2026-11-01T05:00:00.000Z','2026-11-01T15:00:00.000Z']];
it('assigns the Hub owner and a due time inside the Denver send window',()=>{for(const [from,due] of vectors)expect(followupAssignment(followup,new Date(from!)),from).toEqual({assignedUserId:'Zoe.Synthetic',dueAt:due,timeZone:'America/Denver'});});
it('never invents an owner or due time from an absent, blocked or out-of-bounds policy',()=>{
 expect(()=>followupAssignment(policy,new Date('2026-09-22T15:00:00Z'))).toThrow('followup_policy_unresolved');
 for(const change of [{enabled:false},{ownerId:null},{dueMinutes:null},{dueMinutes:14},{dueMinutes:10081},{dueMinutes:30.5},{sendWindow:null},{sendWindow:{startHour:7,endHour:19,timeZone:'America/Denver' as const}},{sendWindow:{startHour:8,endHour:22,timeZone:'America/Denver' as const}},{sendWindow:{startHour:12,endHour:12,timeZone:'America/Denver' as const}}])expect(()=>followupAssignment({...followup,followup:{...followup.followup!,...change}},new Date('2026-09-22T15:00:00Z'))).toThrow('followup_policy_unresolved');
 expect(()=>followupAssignment(followup,new Date(Number.NaN))).toThrow('followup_policy_unresolved');
 expect(()=>followupAssignment({...followup,authority:'ghl' as 'employee_hub'},new Date('2026-09-22T15:00:00Z'))).toThrow('followup_policy_unresolved');
});
it('keeps the inbound reply rule independent of the follow-up policy',()=>{const task=inboundAction({id:'message-b',contactId:'contact-b',occurredAt:new Date('2026-09-20T10:00:00Z'),body:'Reply'},{...followup,followup:{...followup.followup!,enabled:false,ownerId:null,blockedReason:'followup_owner_inactive'}});expect(task.assignedUserId).toBe('verified-owner');expect(task.dueAt).toBe('2026-09-20T11:00:00.000Z');});
});
