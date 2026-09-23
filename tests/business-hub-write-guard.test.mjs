import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceBusinessProjectWrite } from '../functions/_lib/business-hub-write-guard.js';
const req=(method='POST',path='/api/customer-portal')=>new Request('https://easygaragecleaning.com'+path,{method});
const deps=permissions=>({readSession:async()=>({actorId:'biz_test'}),readContext:async()=>({session:{permissions}})});
test('company viewer cannot message or mutate through the project API',async()=>{
 const response=await enforceBusinessProjectWrite(req(),{},deps({view:true,decide:false,pay:false,rebook:false}));
 assert.equal(response.status,403);assert.match((await response.json()).error,/read-only/);
 assert.equal((await enforceBusinessProjectWrite(req('POST','/api/customer-portal/'),{},deps({view:true}))).status,403);
});
test('company viewer still reads; homeowner path and authorized company writes keep existing checks',async()=>{
 assert.equal(await enforceBusinessProjectWrite(req('GET'),{},{}),null);
 assert.equal(await enforceBusinessProjectWrite(req('POST','/api/other'),{},{}),null);
 assert.equal(await enforceBusinessProjectWrite(req(),{},{readSession:async()=>({jobId:'owner_job'})}),null);
 for(const permissions of [{decide:true},{pay:true},{rebook:true}]) assert.equal(await enforceBusinessProjectWrite(req(),{},deps(permissions)),null);
});
test('project writes recheck current company permissions and fail closed on revocation',async()=>{
 const response=await enforceBusinessProjectWrite(req(),{},{readSession:async()=>({actorId:'biz_test',permissions:{pay:true}}),readContext:async()=>({session:{permissions:{view:true}}})});
 assert.equal(response.status,403);
 const failure=await enforceBusinessProjectWrite(req(),{},{readSession:async()=>({actorId:'biz_test'}),readContext:async()=>{throw Object.assign(new Error('revoked'),{status:401});}});
 assert.equal(failure.status,401);
});
