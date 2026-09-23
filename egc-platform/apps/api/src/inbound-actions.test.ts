import {describe,it,expect} from 'vitest';
import {InboundActionReconciler,inboundAction,inboundRequestId,outboundPromiseAction,promiseRequestId,type InboundPolicy} from './inbound-actions.js';
const policy:InboundPolicy={authority:'employee_hub',inboundResponse:{enabled:true,ownerId:'verified-owner',dueMinutes:60,ownerSource:'sole_authoritative_owner',dueSource:'default_60_minute_response_rule',blockedReason:null}};
describe('canonical inbound response actions',()=>{
it('uses exact message/customer evidence and actual inbound time, independent of booking or lead age',()=>{const message={id:'message-a',contactId:'contact-a',occurredAt:new Date('2026-09-20T10:00:00Z'),body:'Customer reply'};const task=inboundAction(message,policy);expect(task.assignedUserId).toBe('verified-owner');expect(task.dueAt).toBe('2026-09-20T11:00:00.000Z');expect(task.contactId).toBe('contact-a');expect(task.portalJobId).toBeNull();expect(task.dedupeKey).toBe('inbound_reply:message-a');expect(task.sourceEvidence[0]).toMatchObject({source:'message',id:'message-a'});expect(task.draft).toBeNull();});
it('never invents owner, due policy, source authority or external message',()=>{for(const change of [{enabled:false},{ownerId:null},{dueMinutes:null},{dueMinutes:0}])expect(()=>inboundAction({id:'x',contactId:'c',occurredAt:new Date(),body:null},{...policy,inboundResponse:{...policy.inboundResponse,...change}})).toThrow('inbound_policy_unresolved');});
it('same source has durable stable logical ID, new message has different ID',()=>{expect(inboundRequestId('a')).toBe(inboundRequestId('a'));expect(inboundRequestId('a')).not.toBe(inboundRequestId('b'));expect(inboundRequestId('a')).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);});
it('persists an outbound media promise as a source-bound delivery obligation independent of acknowledgments',()=>{
 const message={id:'promise-message',contactId:'contact-a',occurredAt:new Date('2026-09-20T10:00:00Z'),body:"I'll send you the before and after photos"};
 const task=outboundPromiseAction(message,policy,['prep-task']);
 expect(task).toMatchObject({assignedUserId:'verified-owner',dueAt:'2026-09-20T10:00:00.000Z',waitingOn:'EGC',contactId:'contact-a',dedupeKey:'outbound_media_promise:promise-message',dependencies:['prep-task']});
 expect(task.sourceEvidence).toEqual([{source:'message',id:'promise-message',excerpt:"I'll send you the before and after photos"}]);
 expect(task.completionCondition).toContain('delivery/read status');
 expect(task.completionCondition).toContain('Acknowledgments');
});
it('refuses request-for-customer-media text and keeps promise request IDs replay-stable',()=>{
 expect(()=>outboundPromiseAction({id:'request',contactId:'c',occurredAt:new Date(),body:'Could you send me photos of the garage?'},policy)).toThrow('outbound_media_promise_not_detected');
 expect(promiseRequestId('a')).toBe(promiseRequestId('a'));expect(promiseRequestId('a')).not.toBe(promiseRequestId('b'));
});

it('returns and saves an allowlisted policy failure reason without the upstream body',async()=>{
 const writes:Record<string,unknown>[]=[];
 const tx={execute:async()=>[{locked:true}],select:()=>({from:()=>({where:async()=>[]})})};
 const db={insert:()=>({values:(row:Record<string,unknown>)=>{writes.push(row);return{onConflictDoNothing:async()=>undefined,onConflictDoUpdate:async()=>undefined};}}),select:()=>({from:()=>({where:async()=>[{cursor:'2026-09-22T00:00:00Z'}]})}),transaction:async(fn:(t:typeof tx)=>unknown)=>fn(tx)};
 const reconciler=new InboundActionReconciler(db as unknown as ConstructorParameters<typeof InboundActionReconciler>[0],{} as ConstructorParameters<typeof InboundActionReconciler>[1],async()=>{throw {code:'service_key_source_unavailable',status:503,message:'private token/customer body'};},'egc',()=>new Date('2026-09-22T01:00:00Z'));
 const result=await reconciler.run();expect(result).toMatchObject({ok:false,errorCode:'inbound_reconciliation_unavailable',failed:1,lastSuccessAt:null,failure:{stage:'inbound_policy',errorCode:'service_key_source_unavailable',httpStatus:503}});
 const saved=JSON.parse(String(writes.find(r=>r.key==='operations:inbound:status:egc')?.cursor));expect(saved.failure).toEqual({stage:'inbound_policy',errorCode:'service_key_source_unavailable',httpStatus:503});expect(JSON.stringify(result)+JSON.stringify(saved)).not.toContain('private');
});
});
