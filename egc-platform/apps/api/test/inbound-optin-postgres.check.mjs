/** GHL-ALIGN: HighLevel owns follow-ups. Through the real /operations/rpc route, a real reconciler and real canonical
 * actions, an unanswered customer text becomes a platform task only when EGC_OPERATIONS_INBOUND_TASKS_ENABLED is exactly
 * "true". Fixed clock; isolated loopback DB only. */
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import Fastify from 'fastify';
import {getDb,schema} from '@egc/database';
import {OperationsService,signRequest} from '@egc/operations';
import {InboundActionReconciler} from '../dist/inbound-actions.js';
import {registerOperationsRoutes} from '../dist/operations.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
if(process.env.EGC_OPERATIONS_TEST!=='isolated'||!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/egc_operations_test'||!['postgres:','postgresql:'].includes(url.protocol))throw new Error('Only isolated loopback egc_operations_test is allowed');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('External HTTP forbidden in inbound opt-in checks');};
const NOW=new Date('2026-09-22T18:00:00.000Z'),key='isolated-api-signing-key-only-01234567890123456789';
const db=getDb(),owner={id:'actual-hub-owner',role:'owner',kind:'human',workspace:'egc'};
const policy={authority:'employee_hub',inboundResponse:{enabled:true,ownerId:owner.id,dueMinutes:60,ownerSource:'sole_authoritative_owner',dueSource:'default_60_minute_response_rule',blockedReason:null}};
const rows=()=>db.select().from(schema.tasks);
const cursor=async key=>(await db.select().from(schema.syncCursors).where(eq(schema.syncCursors.key,key)))[0];
let contact,apps=[];
beforeEach(async()=>{
  for(const a of apps.splice(0))await a.close();
  await db.execute(sql`truncate operation_events,operation_approvals,operation_requests,operation_briefs,tasks,contacts,sync_cursors cascade`);
  [contact]=await db.insert(schema.contacts).values({providerId:'synthetic-'+randomUUID(),name:'Synthetic customer'}).returning();
  await db.insert(schema.messages).values({providerId:'synthetic-'+randomUUID(),contactId:contact.id,type:'SMS',direction:'inbound',actorType:'customer',body:'Synthetic unanswered customer text',occurredAt:new Date(NOW.getTime()-60000)});
});
after(async()=>{for(const a of apps.splice(0))await a.close();globalThis.fetch=originalFetch;await db.$client.end({timeout:5});});
async function boot(flag){
  const service=new OperationsService(db,{workspace:'egc',now:()=>NOW,resolveOwner:async id=>id===owner.id});
  const inbound=new InboundActionReconciler(db,service,async()=>policy,'egc',()=>NOW),a=Fastify();apps.push(a);
  await registerOperationsRoutes(a,{service,inbound,env:{EGC_OPERATIONS_ENABLED:'true',EGC_OPERATIONS_PORTAL_SIGNING_SECRET:key,...(flag===undefined?{}:{EGC_OPERATIONS_INBOUND_TASKS_ENABLED:flag})}});
  await a.ready();return a;
}
const reconcile=async a=>(await a.inject({method:'POST',url:'/operations/rpc',payload:{envelope:signRequest({v:1,iss:'portal',aud:'egc-operations',iat:Math.floor(Date.now()/1000),nonce:randomUUID(),actor:owner,request:{requestId:randomUUID(),body:{command:'inbound.reconcile',lookbackDays:1,limit:50}}},key)}})).json();

test('an unanswered text opens no platform task, and nothing runs in the background, unless the flag is exactly "true"',async()=>{
  for(const flag of [undefined,'','false','TRUE','True','1','yes',' true','true ']){
    const a=await boot(flag);
    assert.deepEqual(await reconcile(a),{ok:false,disabled:true,error:'inbound_tasks_disabled',message:'disabled: follow-ups live in HighLevel',created:0,instruction:'Nothing was created. Unanswered customer texts stay in HighLevel conversations; follow up there.'},String(flag));
    assert.equal((await rows()).length,0,String(flag));
    assert.equal(await cursor('operations:inbound:activation:egc'),undefined,'the reconciler never ran');assert.equal(await cursor('operations:inbound:status:egc'),undefined);
  }
});
test('the owner opt-in keeps the current reconciler: one owned review task for the unanswered text',async()=>{
  const a=await boot('true');
  for(let i=0;i<50&&!await cursor('operations:inbound:status:egc');i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(await cursor('operations:inbound:status:egc'),'the startup tick ran');
  const result=await reconcile(a);assert.equal(result.ok,true);assert.equal(result.created,1);
  const [task]=await rows();assert.equal(task.assignedUserId,owner.id);assert.equal(task.kind,'review_notes');assert.equal(task.dueAt.toISOString(),'2026-09-22T18:59:00.000Z');
  assert.equal((await reconcile(a)).created,0);assert.equal((await rows()).length,1);
});
