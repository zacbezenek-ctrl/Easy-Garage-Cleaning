import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {resolveCustomer,verifiedHighLevelContact} from '../functions/_lib/customer-resolution.js';
import {customerResolveHandler} from '../functions/api/customer-resolve.js';

const manager={user:'zacb',role:'owner',businessAccess:true},now='2026-09-22T14:00:00Z';
const contact={name:'Synthetic Customer',phone:'(970) 555-0100',email:'synthetic@example.invalid',address:'123 Synthetic Way, Fort Collins, CO'};
function fixture(){
  const rows=new Map(),writes=[];let n=0,gated=0,gate,release;
  const store={read:async(collection,id)=>structuredClone(rows.get(collection+'/'+id)||null),customers:async()=>[...rows].filter(([key])=>key.startsWith('customers/')).map(([,row])=>structuredClone(row)),commit:async batch=>{
    if(gated){gated--;if(!gated)release();await gate;}
    for(const write of batch){const current=rows.get(write.collection+'/'+write.id);if(write.revision?write.revision!==current?.revision:Boolean(current))throw Object.assign(new Error('Changed'),{code:'dispatch_revision_conflict',status:409});}
    writes.push(structuredClone(batch));for(const write of batch)rows.set(write.collection+'/'+write.id,{...rows.get(write.collection+'/'+write.id),...structuredClone(write.patch),id:write.id,revision:'r'+(++n)});
  }};
  return{rows,writes,store,request:customer=>({requestId:randomUUID(),customer:{...contact,...customer}}),run:input=>resolveCustomer(store,manager,input,{now,verifyContact:async id=>({...contact,highlevelContactId:id})}),gate:count=>{gated=count;gate=new Promise(done=>release=done);}};
}
test('manual intake creates one attributable canonical customer with atomic identity guard and receipt',async()=>{
  const f=fixture(),input=f.request(),result=await f.run(input);assert.equal(result.created,true);assert.equal(result.customer.name,contact.name);assert.equal(result.customer.id.startsWith('customer_'),true);
  const saved=f.rows.get('customers/'+result.customer.id);assert.equal(saved.createdBy,'zacb');assert.equal(saved.source,'manager_intake');assert.equal(f.writes[0].length,3);assert.ok(f.rows.has('customerIdentityState/revision'));assert.ok(f.rows.has('customerOperations/'+input.requestId));
});
test('manual exact phone/email lookup preserves customer details and provider identity',async()=>{
  const f=fixture();f.rows.set('customers/existing',{id:'existing',revision:'r0',name:'Existing canonical name',phone:'+1 9705550100',email:'SYNTHETIC@example.invalid',address:'Canonical address',highlevelContactId:'GhlExisting',privateFinance:'never expose'});
  const result=await f.run(f.request());assert.equal(result.customer.id,'existing');assert.equal(result.customer.name,'Existing canonical name');assert.equal(result.customer.address,'Canonical address');assert.equal(result.customer.privateFinance,undefined);assert.equal(result.customer.highlevelContactId,'GhlExisting');assert.equal(f.writes[0].some(write=>write.collection==='customers'),false);
});
test('phone/email ambiguity and mismatched identities fail before writing',async()=>{
  const f=fixture();f.rows.set('customers/a',{id:'a',revision:'a',phone:contact.phone,email:'other@example.invalid'});await assert.rejects(f.run(f.request()),problem=>problem.code==='customer_resolve_contact_conflict');
  f.rows.set('customers/b',{id:'b',revision:'b',phone:'9705550199',email:contact.email});await assert.rejects(f.run(f.request()),problem=>problem.code==='customer_resolve_ambiguous_customer');assert.equal(f.writes.length,0);
});
test('verified provider identity uses deterministic ghl ID and authoritative contact values',async()=>{
  const f=fixture(),input=f.request({name:'Untrusted browser name',phone:'9705550199',highlevelContactId:'ContactOne'}),result=await f.run(input);
  assert.equal(result.customer.id,'ghl_ContactOne');assert.equal(result.customer.name,contact.name);assert.equal(result.customer.phone,contact.phone);assert.equal(f.rows.get('customers/'+result.customer.id).source,'verified_provider_contact');
});
test('provider match takes precedence, rejects duplicate provider mappings, and never overwrites another mapping',async()=>{
  const f=fixture();f.rows.set('customers/existing',{id:'existing',revision:'r0',...contact,highlevelContactId:'ContactOne'});let result=await f.run(f.request({highlevelContactId:'ContactOne'}));assert.equal(result.customer.id,'existing');
  f.rows.set('customers/duplicate',{id:'duplicate',revision:'r1',highlevelContactId:'ContactOne'});await assert.rejects(f.run(f.request({highlevelContactId:'ContactOne'})),problem=>problem.code==='customer_resolve_ambiguous_provider');
  f.rows.delete('customers/duplicate');await assert.rejects(f.run(f.request({highlevelContactId:'ContactTwo'})),problem=>problem.code==='customer_resolve_provider_link_conflict');assert.equal(f.rows.get('customers/existing').highlevelContactId,'ContactOne');
});
test('a verified provider links one matching local customer without rewriting name/address',async()=>{
  const f=fixture();f.rows.set('customers/local',{id:'local',revision:'old',...contact,name:'Existing name',address:'Existing address'});const result=await f.run(f.request({highlevelContactId:'ContactOne'}));assert.equal(result.linked,true);assert.equal(result.customer.id,'local');assert.equal(result.customer.name,'Existing name');assert.equal(result.customer.address,'Existing address');assert.equal(result.customer.highlevelContactId,'ContactOne');assert.equal(f.rows.get('customers/local').providerLinkedBy,'zacb');
});
test('concurrent manual intake cannot create duplicate identities with different contact formatting',async()=>{
  const f=fixture();f.gate(2);const results=await Promise.allSettled([f.run(f.request()),f.run(f.request({phone:'+1 9705550100',email:''}))]);assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal((await f.store.customers()).length,1);
  const retry=await f.run(f.request({phone:'+1 9705550100',email:''}));assert.equal(retry.created,false);assert.equal((await f.store.customers()).length,1);
});
test('lost response and concurrent same UUID replay one immutable receipt',async()=>{
  const f=fixture(),input=f.request();f.gate(2);const results=await Promise.all([f.run(input),f.run(input)]);assert.equal(results[0].customer.id,results[1].customer.id);assert.equal(f.writes.length,1);
  const second=fixture(),commit=second.store.commit;second.store.commit=async writes=>{await commit(writes);throw new Error('Lost reply');};const saved=await second.run(second.request());assert.equal(saved.replayed,true);assert.equal(second.writes.length,1);
});
test('changed payload, missing saved record and replaced provider link cannot replay as success',async()=>{
  const f=fixture(),input=f.request({highlevelContactId:'ContactOne'}),saved=await f.run(input);await assert.rejects(f.run({...input,customer:{...input.customer,name:'Changed'}}),problem=>problem.code==='customer_resolve_idempotency_conflict');
  f.rows.get('customers/'+saved.customer.id).highlevelContactId='DifferentContact';await assert.rejects(f.run(input),problem=>problem.code==='customer_resolve_changed_since_operation');
});
test('invalid requests and unauthorized employee roles cannot create customers',async()=>{
  const f=fixture();for(const actor of [null,{user:'crew',role:'crew'},{user:'manager',role:'manager',businessAccess:false}])await assert.rejects(resolveCustomer(f.store,actor,f.request()),problem=>[401,403].includes(problem.status));
  for(const customer of [{name:''},{phone:'123'},{email:'broken'},{phone:'',email:''},{highlevelContactId:'../wrong'},{price:1000}])await assert.rejects(f.run(f.request(customer)),problem=>problem.status===400);assert.equal(f.writes.length,0);
});
test('provider verifier uses server credentials and exact connected location without leaking response details',async()=>{
  const env={GHL_API_KEY:'synthetic-secret',GHL_LOCATION_ID:'location-one'},calls=[];
  const result=await verifiedHighLevelContact(env,'ContactOne',async(url,options)=>{calls.push({url,options});return Response.json({contact:{id:'ContactOne',locationId:'location-one',firstName:'Synthetic',lastName:'Customer',phone:contact.phone,email:contact.email,address1:'123 Synthetic Way',city:'Fort Collins',state:'CO'}});});assert.equal(result.highlevelContactId,'ContactOne');assert.equal(calls[0].options.headers.Authorization,'Bearer synthetic-secret');assert.equal(calls[0].url,'https://services.leadconnectorhq.com/contacts/ContactOne');
  for(const response of [Response.json({contact:{id:'ContactOne',locationId:'other'}}),Response.json({contact:{id:'Wrong',locationId:'location-one'}}),Response.json({error:'synthetic-secret'},{status:500})])await assert.rejects(verifiedHighLevelContact(env,'ContactOne',async()=>response),problem=>!problem.message.includes('synthetic-secret'));
  await assert.rejects(verifiedHighLevelContact({},'ContactOne'),problem=>problem.status===503);
});
test('HTTP route enforces signed manager, exact origin, bounded JSON and no-store',async()=>{
  const f=fixture();let actor=manager;const handler=customerResolveHandler({session:async()=>actor,storage:()=>f.store});const request=(body,headers={})=>new Request('https://easygaragecleaning.com/api/customer-resolve',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  let response=await handler({request:request(f.request()),env:{}});assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  response=await handler({request:request(f.request(),{Origin:'https://other.invalid'}),env:{}});assert.equal(response.status,403);
  actor=null;response=await handler({request:request(f.request()),env:{}});assert.equal(response.status,401);actor=manager;
  response=await handler({request:request({huge:'x'.repeat(9000)}),env:{}});assert.equal(response.status,413);
});
