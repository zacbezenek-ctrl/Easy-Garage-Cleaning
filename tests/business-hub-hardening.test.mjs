import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as service from '../functions/_lib/business-hub-service.js';
import * as storeModule from '../functions/_lib/business-hub-store.js';
import * as core from '../functions/_lib/business-hub-core.js';
import * as scopeModule from '../functions/_lib/business-hub-scope.js';
import * as modulesModule from '../functions/_lib/business-hub-modules.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { firestoreMemory } from './helpers/firestore-memory.mjs';
import { scopedMembers, exportMemberScopes, scanBusinessAccounts, parseArgs, writeExport, runExport } from '../scripts/business-members-scope-export.mjs';
import { legacyExpireAt, planOperationsTtl, runOperationsTtlBackfill } from '../scripts/business-operations-ttl-backfill.mjs';
const { createBusinessHandler, isStoredAccount, copyStoredAccount } = service, { createBusinessStore, BUSINESS_COLLECTIONS } = storeModule;
const { businessHubModules } = modulesModule, { uid, RECEIPT_DAYS } = core, { scopeAccount } = scopeModule;
// B2B-HARDEN: synthetic accounts, an in-memory store and an injected clock only; no Firestore, provider or real time.
const origin='https://easygaragecleaning.com', START=Date.UTC(2026,8,23,18), HOUR=3600000, DAY=24*HOUR;
const ROOT='projects/egcw-1ec83/databases/(default)/documents';
class MemoryStore {
  constructor(){this.records=new Map();this.clock=0;this.commits=[];}
  async read(c,id){return structuredClone(this.records.get(c+'/'+id)||null);}
  async commit(changes){
    this.commits.push(changes.map(w=>w.collection+'/'+w.id));
    for(const w of changes){const old=this.records.get(w.collection+'/'+w.id);if(w.version ? old?._version!==w.version : Boolean(old))throw Object.assign(new Error('Conflict'),{status:409,publicMessage:'The record changed or could not be saved. Refresh and retry; no partial update was applied.'});}
    for(const w of changes){const key=w.collection+'/'+w.id,old=this.records.get(key);this.records.set(key,{...(w.patch?old:{}),...structuredClone(w.data),id:w.id,_version:String(++this.clock)});}
  }
  async list(profile){return {accounts:this.rows('business_accounts').filter(v=>profile.businessAccess||v.ownerStaff===profile.user),next:''};}
  async jobs(ids){return new Map((await Promise.all(ids.map(i=>this.read('jobs',i)))).filter(Boolean).map(j=>[j.id,j]));}
  rows(prefix){return [...this.records.entries()].filter(([k])=>k.startsWith(prefix+'/')).map(([,v])=>structuredClone(v));}
  remove(c,id){this.records.delete(c+'/'+id);}
}
function setup(deps={}){
  const store=deps.store||new MemoryStore(),mail=[];let clock=START,outcome='submitted';
  const invites={enabled:true,deliver:async input=>{mail.push(input);return {status:outcome,reason:'',messageId:outcome==='submitted'?'synthetic-message-'+mail.length:''};}};
  const handler=createBusinessHandler({store,getStaff:async()=>({user:'zacb',displayName:'Synthetic Owner',businessAccess:true,role:'owner'}),finance:j=>({total:j.total||0,paid:0,balance:j.total||0}),needsReview:()=>false,projectCookie:async()=>'project=; HttpOnly',clearProjectCookie:()=>'project=; Max-Age=0',now:()=>clock,invites,...businessHubModules,...deps});
  async function call(payload,{url='',cookie=''}={}){const res=await handler(new Request(origin+'/api/business-hub'+url,{method:payload?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json','X-EGC-Business':'1',Cookie:cookie},...(payload?{body:JSON.stringify(payload)}:{})}));return {status:res.status,data:await res.json(),cookie:res.headers.get('Set-Cookie')};}
  async function onboard(){const created=await call({action:'create_account',company:'Synthetic Portfolio Co',name:'Synthetic Admin',email:'admin@example.invalid'},{url:'?staff=1'});assert.equal(created.status,201);const login=await call({action:'redeem',invite:created.data.invite});assert.equal(login.status,200);return {accountId:created.data.accountId,cookie:login.cookie.split(';')[0],staffUrl:'?staff=1&account='+created.data.accountId};}
  async function member(a,role,extra={},address=role+'@example.invalid'){const inv=await call({action:'invite_member',name:'Synthetic '+role,email:address,role,...extra},{cookie:a.cookie});assert.equal(inv.status,201,JSON.stringify(inv.data));const login=await call({action:'redeem',invite:inv.data.invite});assert.equal(login.status,200);return {cookie:login.cookie.split(';')[0],memberId:inv.data.invite.split('.')[1]};}
  async function portfolio(){
    const a=await onboard(),ids=[];
    for(const name of ['Synthetic North Lot','Synthetic South Lot'])ids.push((await call({action:'save_property',name,address:name+', 1 Example Way'},{cookie:a.cookie})).data.propertyId);
    return {...a,north:ids[0],south:ids[1]};
  }
  return {store,call,onboard,member,portfolio,mail,account:a=>store.read('business_accounts',a.accountId),advance:ms=>clock+=ms,now:()=>clock,deliver:value=>outcome=value};
}
const counts=h=>[h.store.rows('business_audit').length,h.store.rows('hub_audit').length];

test('save() refuses a spread copy, a clone or a scoped view of the account, so no module can drop hidden properties',async()=>{
  const seen={};
  const actions={
    synthetic_spread:async(ctx,input,{save})=>{await save({...ctx,account:{...ctx.account,reference:'Synthetic spread'}},'synthetic_spread');return {data:{ok:true}};},
    synthetic_clone:async(ctx,input,{save})=>{const account=structuredClone(ctx.account);account.reference='Synthetic clone';await save({...ctx,account},'synthetic_clone');return {data:{ok:true}};},
    // The latent defect B2B-SCOPE's review found: spreading the member's filtered view and saving it would have
    // persisted only their properties. The Symbol marker does not survive a spread; the positive guard does not need it.
    synthetic_scoped_spread:async(ctx,input,{save,scoped})=>{const view={...scoped(ctx)};seen.visible=view.properties.length;view.reference='Synthetic scoped';await save({...ctx,account:view},'synthetic_scoped_spread');return {data:{ok:true}};},
    synthetic_scoped:async(ctx,input,{save,scoped})=>{await save({...ctx,account:scoped(ctx)},'synthetic_scoped');return {data:{ok:true}};},
    synthetic_launder:async(ctx,input,{save,scoped})=>{await save({...ctx,account:copyStoredAccount(input.view==='scoped'?scoped(ctx):{...ctx.account})},'synthetic_launder');return {data:{ok:true}};},
    synthetic_full:async(ctx,input,{save})=>{ctx.account.reference='Synthetic in place';await save(ctx,'synthetic_full');return {data:{ok:true}};},
    synthetic_copy:async(ctx,input,{save})=>{const account=copyStoredAccount(ctx.account);account.reference='Synthetic copy';await save({...ctx,account},'synthetic_copy');return {data:{ok:true}};},
  };
  const h=setup({actions:{...businessHubModules.actions,...actions}}),a=await h.portfolio(),limited=await h.member(a,'manager',{propertyIds:[a.north]});
  const before=JSON.stringify(await h.account(a)),rows=counts(h);
  for(const [action,options,extra] of [['synthetic_spread',{cookie:a.cookie}],['synthetic_spread',{url:a.staffUrl}],['synthetic_clone',{cookie:limited.cookie}],['synthetic_scoped_spread',{cookie:limited.cookie}],
    ['synthetic_scoped',{cookie:limited.cookie}],['synthetic_launder',{cookie:limited.cookie},{view:'scoped'}],['synthetic_launder',{cookie:a.cookie},{view:'spread'}]]){
    h.advance(1);const res=await h.call({action,...extra},options);
    assert.equal(res.status,503,action);assert.match(res.data.error,/could not complete that action/);
  }
  assert.equal(seen.visible,1,'the module really held the one-property view');
  assert.equal(JSON.stringify(await h.account(a)),before,'nothing was written: both properties and the reference are intact');
  assert.deepEqual(counts(h),rows,'and no audit row was added');
  assert.equal((await h.account(a)).properties.length,2);
  // The stored account itself saves, changed in place or through the explicit copy helper, for any caller.
  h.advance(1);assert.equal((await h.call({action:'synthetic_full'},{cookie:limited.cookie})).status,200);
  assert.equal((await h.account(a)).reference,'Synthetic in place');
  h.advance(1);assert.equal((await h.call({action:'synthetic_copy'},{url:a.staffUrl})).status,200);
  const saved=await h.account(a);assert.equal(saved.reference,'Synthetic copy');assert.equal(saved.properties.length,2);
  assert.deepEqual(h.store.rows('business_audit').slice(-2).map(r=>r.action),['synthetic_full','synthetic_copy']);
});

test('built-in actions still save through the guard for clients, staff, sign-in, sign-out and delivery records',async()=>{
  const h=setup(),a=await h.portfolio(),limited=await h.member(a,'manager',{propertyIds:[a.north]});
  const requestId=uid();
  assert.equal((await h.call({action:'request_service',requestId,propertyId:a.north,service:'Cleanout',scope:'Synthetic scope',payer:'Synthetic Portfolio Co'},{cookie:limited.cookie})).status,201);
  assert.equal((await h.call({action:'message',messageId:uid(),requestId,body:'Synthetic question'},{cookie:limited.cookie})).status,201);
  assert.equal((await h.call({action:'update_request',requestId,status:'reviewing'},{url:a.staffUrl})).status,200);
  assert.equal((await h.call({action:'save_account',billingEmail:'ap@example.invalid',reference:'PO-1'},{cookie:a.cookie})).status,200);
  const emailed=await h.call({action:'invite_member',requestId:uid(),name:'Synthetic Guest',email:'guest@example.invalid',role:'viewer',deliver:'email'},{url:a.staffUrl});
  assert.equal(emailed.status,201);assert.equal(emailed.data.delivery.recorded,true,'the delivery outcome was saved on a freshly read account');
  assert.equal((await h.call({action:'logout'},{cookie:limited.cookie})).status,200);
  const saved=await h.account(a);assert.equal(saved.properties.length,2);assert.equal(saved.requests[0].status,'reviewing');assert.equal(saved.reference,'PO-1');
  const actions=['request_service','message','update_request','save_account','member_invited','invite_delivery_recorded','signed_out'];
  assert.deepEqual(h.store.rows('business_audit').map(r=>r.action).filter(action=>actions.includes(action)).slice(-7),actions,'each change, the delivery record and the sign-out saved');
});

test('only the hub marks an account as savable: no module can import a marker, and copyStoredAccount copies only a stored account',async()=>{
  // The marker is private to business-hub-service.js; no business hub module exports one, so {...scoped(ctx)} can never be made savable.
  for(const ns of [service,storeModule,core,scopeModule,modulesModule])for(const name of Object.keys(ns))assert.doesNotMatch(name,/^(storedAccount|markAccount|markStored)/,name);
  assert.deepEqual(Object.keys(service).filter(name=>/stored/i.test(name)).sort(),['copyStoredAccount','isStoredAccount']);
  const id=uid(),doc={name:`${ROOT}/business_accounts/${id}`,updateTime:'2026-09-22T12:00:00.000000Z',fields:encodeFirestoreFields({company:'Synthetic Co',status:'active',properties:[{id:uid(),name:'Synthetic Lot'}],members:[]})};
  const fetcher=async(env,url)=>{const path=String(url);if(path.endsWith('/business_accounts/'+id))return Response.json(doc);if(path.includes('/business_accounts?')||path.endsWith('/business_accounts'))return Response.json({documents:[doc]});return Response.json({name:`${ROOT}/business_operations/${'a'.repeat(32)}`,updateTime:doc.updateTime,fields:{}});};
  const raw=createBusinessStore({},fetcher);
  assert.equal(isStoredAccount(await raw.read('business_accounts',id)),false,'the storage layer returns plain rows; only the hub marks what it reads');
  assert.equal(isStoredAccount((await raw.list({businessAccess:true})).accounts[0]),false,'masked list rows can never be saved');
  // An account the hub read (ctx.account) is the stored one; everything derived from it except copyStoredAccount is not.
  const seen={},h=setup({actions:{...businessHubModules.actions,synthetic_capture:async(ctx,input,{scoped})=>{seen.account=ctx.account;seen.view=scoped(ctx);return {data:{ok:true}};}}});
  const a=await h.portfolio(),limited=await h.member(a,'viewer',{propertyIds:[a.north]});
  assert.equal((await h.call({action:'synthetic_capture'},{cookie:limited.cookie})).status,200);
  const {account,view}=seen;assert.equal(isStoredAccount(account),true);assert.equal(account.properties.length,2);assert.equal(view.properties.length,1);
  for(const copy of [{...account},structuredClone(account),Object.assign({},account),JSON.parse(JSON.stringify(account)),view,{...view},scopeAccount(account,{role:'viewer',propertyIds:[a.north]})])assert.equal(isStoredAccount(copy),false);
  const copy=copyStoredAccount(account);assert.equal(isStoredAccount(copy),true);assert.notEqual(copy,account);
  copy.properties[0].name='Changed';assert.notEqual(account.properties[0].name,'Changed','the copy is deep');
  for(const bad of [view,{...view},{...account},null,undefined,'account'])assert.throws(()=>copyStoredAccount(bad),e=>e.status===503);
  assert.equal(isStoredAccount(null),false);
});

// The same module code on the in-memory store the unit tests use and on the production Firestore REST store.
const STORES=[['in-memory store',()=>{const store=new MemoryStore();return {store,keys:()=>[...store.records.keys()].sort()};}],
  ['Firestore REST store',()=>{const mem=firestoreMemory();return {store:createBusinessStore({},(env,url,init)=>mem.fetch(url,init)),keys:()=>[...mem.documents.keys()].sort()};}]];
for(const [label,make] of STORES)test(`helpers.store agrees with save() on the ${label}: a re-read account saves, and no commit writes a filtered or partial account`,async()=>{
  const actions={
    synthetic_reread:async(ctx,input,{save,store})=>{const fresh=await store.read('business_accounts',ctx.account.id);fresh.reference='Synthetic re-read';await save({...ctx,account:fresh},'synthetic_reread');return {data:{ok:true}};},
    synthetic_commit_view:async(ctx,input,{store,scoped})=>{await store.commit([{collection:'business_accounts',id:ctx.account.id,data:{...scoped(ctx)},version:ctx.account._version}]);return {data:{ok:true}};},
    synthetic_commit_patch:async(ctx,input,{store,scoped})=>{await store.commit([{collection:'business_accounts',id:ctx.account.id,data:{properties:scoped(ctx).properties},version:ctx.account._version,patch:true}]);return {data:{ok:true}};},
    synthetic_extra_view:async(ctx,input,{save,scoped})=>{await save(ctx,'synthetic_extra_view',[{collection:'business_accounts',id:input.other,data:{...scoped(ctx),id:input.other}}]);return {data:{ok:true}};},
    synthetic_commit_other_id:async(ctx,input,{store})=>{await store.commit([{collection:'business_accounts',id:input.other,data:ctx.account}]);return {data:{ok:true}};},
    synthetic_launder:async(ctx,input,{save,scoped})=>{await save({...ctx,account:copyStoredAccount({...scoped(ctx)})},'synthetic_launder');return {data:{ok:true}};},
    synthetic_receipt:async(ctx,input,{store,now})=>{await store.commit([{collection:'business_operations',id:input.other,data:{action:'synthetic_receipt',at:new Date(now()).toISOString()}}]);return {data:{ok:true}};},
  };
  const {store,keys}=make(),h=setup({store,actions:{...businessHubModules.actions,...actions}}),a=await h.portfolio(),limited=await h.member(a,'manager',{propertyIds:[a.north]});
  const before=JSON.stringify(await h.account(a)),records=keys(),other=uid();
  for(const action of ['synthetic_commit_view','synthetic_commit_patch','synthetic_extra_view','synthetic_commit_other_id','synthetic_launder']){
    h.advance(1);const res=await h.call({action,other},{cookie:limited.cookie});
    assert.equal(res.status,503,action);assert.match(res.data.error,/could not complete that action/);
  }
  assert.equal(JSON.stringify(await h.account(a)),before,'nothing was written: both properties are intact');assert.deepEqual(keys(),records,'and no record was created');
  h.advance(1);assert.equal((await h.call({action:'synthetic_reread'},{cookie:limited.cookie})).status,200);
  const saved=await h.account(a);assert.equal(saved.reference,'Synthetic re-read');assert.equal(saved.properties.length,2);
  h.advance(1);assert.equal((await h.call({action:'synthetic_receipt',other},{cookie:limited.cookie})).status,200,'other collections commit as before');
  assert.equal((await store.read('business_operations',other)).action,'synthetic_receipt');
});

// A synthetic job the hub can link: released (estimate sent), so a member can open it.
const JOB='synthetic_job_1';
const addJob=store=>store.commit([{collection:'jobs',id:JOB,data:{type:'job',total:500,estimate:{sentAt:'2026-09-01'}}}]);
for(const [label,make] of STORES)test(`the ${label} refuses a write that copies a scoped view's contents into the stored account, and nothing is written`,async()=>{
  const seen={};
  const getter=(first,later)=>{let reads=0;return ()=>reads++?later:first;};
  const actions={
    // The three second-review repros: the stored object itself, or a copyStoredAccount copy, holding a limited member's view.
    synthetic_assign:async(ctx,input,{save,scoped})=>{const view=scoped(ctx);seen.view=Object.fromEntries(['properties','requests','projects','messages'].map(list=>[list,view[list].length]));Object.assign(ctx.account,view);await save(ctx,'synthetic_assign');return {data:{ok:true}};},
    synthetic_field:async(ctx,input,{save,scoped})=>{ctx.account.properties=scoped(ctx).properties;await save(ctx,'synthetic_field');return {data:{ok:true}};},
    synthetic_copy_filter:async(ctx,input,{save,canSeeProperty})=>{const account=copyStoredAccount(ctx.account);account.properties=account.properties.filter(p=>canSeeProperty(ctx,p.id));await save({...ctx,account},'synthetic_copy_filter');return {data:{ok:true}};},
    // The same through the module's own commit.
    synthetic_commit_assign:async(ctx,input,{store,scoped})=>{Object.assign(ctx.account,scoped(ctx));await store.commit([{collection:'business_accounts',id:ctx.account.id,data:ctx.account,version:ctx.account._version}]);return {data:{ok:true}};},
    // A getter that shows the check the full account and anything later the filtered view.
    synthetic_getter:async(ctx,input,{store,scoped})=>{const data=getter(ctx.account,{...scoped(ctx)});await store.commit([{collection:'business_accounts',id:ctx.account.id,version:ctx.account._version,get data(){return data();}}]);return {data:{ok:true}};},
    synthetic_list_getter:async(ctx,input,{save,scoped})=>{const list=getter(ctx.account.properties,scoped(ctx).properties);Object.defineProperty(ctx.account,'properties',{get:list,enumerable:true,configurable:true});await save(ctx,'synthetic_list_getter');return {data:{ok:true}};},
    // Every tracked list, by removal, and an entry replaced under a new id (same length).
    synthetic_drop:async(ctx,input,{save})=>{ctx.account[input.list].splice(-1,1);await save(ctx,'synthetic_drop');return {data:{ok:true}};},
    synthetic_swap:async(ctx,input,{save})=>{ctx.account.properties[1]={...ctx.account.properties[1],id:uid()};await save(ctx,'synthetic_swap');return {data:{ok:true}};},
  };
  const {store,keys}=make(),h=setup({store,actions:{...businessHubModules.actions,...actions}}),a=await h.portfolio(),limited=await h.member(a,'manager',{propertyIds:[a.north]});
  // The limited manager cannot see the south lot's request, its message or its linked project.
  const south=uid();await addJob(store);
  assert.equal((await h.call({action:'request_service',requestId:south,propertyId:a.south,service:'Cleanout',scope:'Synthetic scope',payer:'Synthetic Portfolio Co'},{cookie:a.cookie})).status,201);
  assert.equal((await h.call({action:'message',messageId:uid(),requestId:south,body:'Synthetic south question'},{cookie:a.cookie})).status,201);
  assert.equal((await h.call({action:'link_project',jobId:JOB,propertyId:a.south,requestId:south,sharingAuthorized:true},{url:a.staffUrl})).status,200);
  const before=JSON.stringify(await h.account(a)),records=keys(),full=await h.account(a);
  assert.deepEqual(['properties','requests','projects','messages','members'].map(list=>full[list].length),[2,1,1,1,2]);
  const refused=[['synthetic_assign'],['synthetic_field'],['synthetic_copy_filter'],['synthetic_commit_assign'],['synthetic_getter'],['synthetic_list_getter'],['synthetic_swap'],
    ...['properties','requests','projects','messages','members'].map(list=>['synthetic_drop',{list}])];
  for(const [action,extra] of refused){
    h.advance(1);const res=await h.call({action,...extra},{cookie:limited.cookie});
    assert.equal(res.status,503,action+JSON.stringify(extra||''));assert.match(res.data.error,/could not complete that action/);
  }
  assert.deepEqual(seen.view,{properties:1,requests:0,projects:0,messages:0},'the module really held the limited view');
  assert.equal(JSON.stringify(await h.account(a)),before,'nothing was written: every property, request, project, message and member is intact');
  assert.deepEqual(keys(),records,'and no audit row or other record was created');
  // The limited manager's own changes still save, and the account keeps everything they cannot see.
  h.advance(1);assert.equal((await h.call({action:'request_service',requestId:uid(),propertyId:a.north,service:'Cleanout',scope:'Synthetic north scope',payer:'Synthetic Portfolio Co'},{cookie:limited.cookie})).status,201);
  const saved=await h.account(a);assert.deepEqual(['properties','requests','projects','messages','members'].map(list=>saved[list].length),[2,2,1,1,2]);
});

// Every built-in flow of the second review's list, through the real handler: none is refused by the content guard.
for(const [label,make] of STORES)test(`every built-in action still saves through the content guard on the ${label}`,async()=>{
  const {store}=make(),h=setup({store}),staff={url:'?staff=1'},ok=(res,status,what)=>{assert.equal(res.status,status,what+' '+JSON.stringify(res.data));return res.data;};
  const created=ok(await h.call({action:'create_account',requestId:uid(),company:'Synthetic Flow Co',name:'Synthetic Admin',email:'admin@example.invalid',deliver:'email'},staff),201,'create_account by email');
  assert.equal(created.delivery.recorded,true);
  ok(await h.call({action:'create_account',company:'Synthetic Manual Co',name:'Synthetic Admin Two',email:'admin2@example.invalid'},staff),201,'create_account with a private link');
  const accountId=created.accountId,staffUrl='?staff=1&account='+accountId,code=link=>new URL(link).hash.slice('#invite='.length);
  const admin=(await h.call({action:'redeem',invite:code(h.mail[0].link)})).cookie.split(';')[0];
  const north=ok(await h.call({action:'save_property',requestId:uid(),name:'Synthetic North Lot',address:'1 North Way'},{cookie:admin}),200,'save_property (client)').propertyId;
  const south=ok(await h.call({action:'save_property',name:'Synthetic South Lot',address:'1 South Way'},{url:staffUrl}),200,'save_property (staff)').propertyId;
  ok(await h.call({action:'save_property',propertyId:north,requestId:uid(),name:'Synthetic North Lot',address:'1 North Way',access:'Side gate'},{cookie:admin}),200,'save_property edit');
  ok(await h.call({action:'save_account',billingEmail:'ap@example.invalid',reference:'PO-7'},{cookie:admin}),200,'save_account');
  const manager=ok(await h.call({action:'invite_member',requestId:uid(),name:'Synthetic Manager',email:'manager@example.invalid',role:'manager',propertyIds:[north]},{cookie:admin}),201,'invite_member (link)');
  ok(await h.call({action:'redeem',invite:manager.invite}),200,'redeem');
  const viewer=ok(await h.call({action:'invite_member',requestId:uid(),name:'Synthetic Viewer',email:'viewer@example.invalid',role:'viewer',deliver:'email'},{url:staffUrl}),201,'invite_member (email)');
  assert.equal(ok(await h.call({action:'resend_invite',requestId:uid(),memberId:viewer.memberId,deliver:'email'},{url:staffUrl}),201,'resend_invite (email)').delivery.recorded,true);
  ok(await h.call({action:'resend_invite',requestId:uid(),memberId:viewer.memberId},{cookie:admin}),201,'resend_invite (link)');
  h.deliver('not_sent');
  assert.equal(ok(await h.call({action:'resend_invite',requestId:uid(),memberId:viewer.memberId,deliver:'email'},{url:staffUrl}),201,'resend_invite not sent').delivery.recorded,true,'the release saved with its freed cap records');
  h.deliver('submitted');
  const reset=ok(await h.call({action:'reset_sign_in',requestId:uid(),memberId:manager.memberId,confirm:true},{cookie:admin}),201,'reset_sign_in (link)');
  ok(await h.call({action:'redeem',invite:reset.invite}),200,'redeem after reset');
  assert.equal(ok(await h.call({action:'reset_sign_in',requestId:uid(),memberId:manager.memberId,confirm:true,deliver:'email'},{url:staffUrl}),201,'reset_sign_in (email)').delivery.recorded,true);
  const managerCookie=(await h.call({action:'redeem',invite:code(h.mail.at(-1).link)})).cookie.split(';')[0];
  const scopeId=uid();
  ok(await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds:[north,south],requestId:scopeId},{cookie:admin}),200,'set_member_properties');
  assert.equal(ok(await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds:[north,south],requestId:scopeId},{cookie:admin}),200,'replay').duplicate,true);
  assert.equal(ok(await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds:[south,north],requestId:uid()},{url:staffUrl}),200,'no-op').unchanged,true);
  ok(await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds:[north]},{url:staffUrl}),200,'narrow');
  const requestId=uid();
  ok(await h.call({action:'request_service',requestId,propertyId:north,service:'Cleanout',scope:'Synthetic scope',payer:'Synthetic Flow Co'},{cookie:managerCookie}),201,'request_service');
  ok(await h.call({action:'message',messageId:uid(),requestId,body:'Synthetic question'},{cookie:managerCookie}),201,'message on a request');
  ok(await h.call({action:'message',messageId:uid(),body:'Synthetic general note'},{url:staffUrl}),201,'general message');
  ok(await h.call({action:'update_request',requestId,status:'reviewing'},{url:staffUrl}),200,'update_request');
  await addJob(store);
  ok(await h.call({action:'link_project',jobId:JOB,propertyId:north,requestId,sharingAuthorized:true},{url:staffUrl}),200,'link_project');
  ok(await h.call({action:'open_project',jobId:JOB},{cookie:managerCookie}),200,'open_project');
  ok(await h.call({action:'unlink_project',jobId:JOB},{url:staffUrl}),200,'unlink_project');
  const revoke=uid();
  ok(await h.call({action:'revoke_member',memberId:viewer.memberId,requestId:revoke},{cookie:admin}),200,'revoke_member');
  assert.equal(ok(await h.call({action:'revoke_member',memberId:viewer.memberId,requestId:revoke},{cookie:admin}),200,'revoke replay').duplicate,true);
  const renewed=ok(await h.call({action:'invite_member',name:'Synthetic Viewer',email:'viewer@example.invalid',role:'viewer'},{cookie:admin}),201,'invite renews a revoked member');
  // A new sign-in in the same browser ends the manager's session and saves that through the guard.
  ok(await h.call({action:'redeem',invite:renewed.invite},{cookie:managerCookie}),200,'redeem ending the previous session');
  ok(await h.call({action:'logout'},{cookie:admin}),200,'logout');
  const saved=await h.account({accountId});
  assert.deepEqual(['properties','requests','projects','messages','members'].map(list=>saved[list].length),[2,1,1,2,3]);
  assert.equal(saved.projects[0].active,false,'unlinking marks the link; it is never removed');
  assert.equal(saved.members.find(m=>m.id===manager.memberId).sessionExpiresAt,h.now(),'the ended session was saved');
  assert.equal(saved.members.find(m=>m.role==='admin').sessionExpiresAt,h.now(),'the sign-out was saved');
  assert.equal(saved.reference,'PO-7');
});

test('requestId receipts carry expireAt RECEIPT_DAYS after the request; a no-op still records one and its replay is a duplicate',async()=>{
  const h=setup(),a=await h.portfolio(),viewer=await h.member(a,'viewer');
  const expected=at=>new Date(at+RECEIPT_DAYS*DAY);assert.equal(RECEIPT_DAYS,30);
  const created=uid();h.advance(HOUR);const at=h.now();
  assert.equal((await h.call({action:'create_account',requestId:created,company:'Synthetic Receipt Co',name:'Synthetic Admin',email:'receipt@example.invalid'},{url:'?staff=1'})).status,201);
  const receipt=await h.store.read('business_operations',created);
  assert.ok(receipt.expireAt instanceof Date,'a Date is written as a Firestore timestamp, which the TTL policy needs');
  assert.deepEqual([receipt.at,receipt.expireAt],[new Date(at).toISOString(),expected(at)]);
  const scope=uid(),noop=uid(),revoke=uid();
  h.advance(HOUR);const scopeAt=h.now();
  assert.equal((await h.call({action:'set_member_properties',memberId:viewer.memberId,propertyIds:[a.north],requestId:scope},{cookie:a.cookie})).status,200);
  assert.deepEqual((await h.store.read('business_operations',scope)).expireAt,expected(scopeAt));
  // A pure no-op keeps its (expiring) receipt: without it a later request with this id could apply a different change.
  h.advance(HOUR);const noopAt=h.now(),rows=counts(h),commits=h.store.commits.length;
  assert.deepEqual((await h.call({action:'set_member_properties',memberId:viewer.memberId,propertyIds:[a.north],requestId:noop},{url:a.staffUrl})).data,{ok:true,unchanged:true});
  assert.deepEqual(h.store.commits.slice(commits),[['business_operations/'+noop]],'the no-op writes only its receipt');
  assert.deepEqual((await h.store.read('business_operations',noop)).expireAt,expected(noopAt));assert.deepEqual(counts(h),rows);
  h.advance(1);assert.deepEqual((await h.call({action:'set_member_properties',memberId:viewer.memberId,propertyIds:[a.north],requestId:noop},{url:a.staffUrl})).data,{ok:true,duplicate:true});
  h.advance(1);assert.equal((await h.call({action:'set_member_properties',memberId:viewer.memberId,propertyIds:[],requestId:noop},{url:a.staffUrl})).status,409);
  assert.deepEqual((await h.account(a)).members.find(m=>m.id===viewer.memberId).propertyIds,[a.north]);
  h.advance(HOUR);const revokeAt=h.now();
  assert.equal((await h.call({action:'revoke_member',memberId:viewer.memberId,requestId:revoke},{url:a.staffUrl})).status,200);
  assert.deepEqual((await h.store.read('business_operations',revoke)).expireAt,expected(revokeAt));
  const invite=uid();h.advance(HOUR);const inviteAt=h.now();
  assert.equal((await h.call({action:'invite_member',requestId:invite,name:'Synthetic Other',email:'other@example.invalid',role:'viewer'},{cookie:a.cookie})).status,201);
  const inviteReceipt=await h.store.read('business_operations',invite);assert.deepEqual(inviteReceipt.expireAt,expected(inviteAt));assert.equal(inviteReceipt.generation,1);
  // Nothing relies on the deletion: until Firestore removes an expired receipt, it still answers its replay (staff sessions do not end).
  h.advance(RECEIPT_DAYS*DAY+HOUR);
  assert.deepEqual((await h.call({action:'set_member_properties',memberId:viewer.memberId,propertyIds:[a.north],requestId:noop},{url:a.staffUrl})).data,{ok:true,duplicate:true});
  assert.equal((await h.call({action:'revoke_member',memberId:viewer.memberId,requestId:revoke},{url:a.staffUrl})).data.duplicate,true);
  for(const row of h.store.rows('business_operations').filter(r=>!r.kind))assert.ok(row.expireAt instanceof Date&&row.expireAt.getTime()===Date.parse(row.at)+RECEIPT_DAYS*DAY,row.action);
});

test('invitation email cap records expire a rolling day after their last write and a TTL-deleted record counts as empty',async()=>{
  const h=setup(),a=await h.onboard(),quotas=()=>h.store.rows('business_operations').filter(r=>r.kind==='invite_email_quota');
  const invite=address=>h.call({action:'invite_member',requestId:uid(),name:'Synthetic Guest',email:address,role:'viewer',deliver:'email'},{url:a.staffUrl});
  h.advance(HOUR);const first=h.now();
  assert.equal((await invite('guest@example.invalid')).data.delivery.status,'submitted');
  assert.deepEqual(quotas().map(q=>[q.scope,q.expireAt]).sort(),[['address',new Date(first+DAY)],['sender',new Date(first+DAY)]]);
  assert.ok(quotas().every(q=>q.expireAt instanceof Date));
  h.advance(3*HOUR);const second=h.now();
  assert.equal((await invite('guest+two@example.invalid')).data.delivery.status,'submitted');
  for(const q of quotas()){assert.deepEqual(q.expireAt,new Date(second+DAY),q.scope);assert.ok(q.sends.every(s=>s.at+DAY<=q.expireAt.getTime()),'every counted send has left the window by expireAt');}
  // An attempt that emailed nothing is released; the rewritten record expires a day after that write.
  h.deliver('not_sent');h.advance(HOUR);const third=h.now();
  assert.equal((await invite('guest+three@example.invalid')).data.delivery.status,'not_sent');
  for(const q of quotas()){assert.deepEqual(q.sends.map(s=>s.at),[first,second],q.scope);assert.deepEqual(q.expireAt,new Date(third+DAY));}
  // Past expireAt the record counts nothing, so Firestore deleting it (the TTL policy) changes no answer.
  h.deliver('submitted');h.advance(DAY+HOUR);
  const mailbox=quotas().find(q=>q.scope==='address');h.store.remove('business_operations',mailbox.id);
  const fourth=h.now();assert.equal((await invite('guest@example.invalid')).data.delivery.status,'submitted');
  const renewed=quotas().find(q=>q.id===mailbox.id);assert.deepEqual(renewed.sends.map(s=>s.at),[fourth]);assert.deepEqual(renewed.expireAt,new Date(fourth+DAY));
  const sender=quotas().find(q=>q.scope==='sender');assert.deepEqual(sender.sends.map(s=>s.at),[fourth],'the expired sends were dropped on the next write');
  assert.equal(JSON.stringify(quotas()).includes('example.invalid'),false,'quota records still hold no address');
});

test('firestore.rules grants no browser SDK access to any business_* collection',()=>{
  const rules=readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');
  assert.deepEqual([...BUSINESS_COLLECTIONS].sort(),['business_accounts','business_audit','business_operations','business_sessions']);
  // A wildcard collection match (other than the deny-all) could expose every business_* collection.
  const top=[...rules.matchAll(/match\s+\/(\{[^}]*\})/g)].map(m=>m[1]);
  assert.deepEqual(top,['{document=**}']);
  assert.match(rules,/match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}\s*\}\s*\}\s*$/,'the deny-all is the last rule');
  for(const name of [...BUSINESS_COLLECTIONS,'invite_email_quota']){
    const block=new RegExp(`match\\s+/${name}/\\{[^}]+\\}\\s*\\{([^}]*)\\}`).exec(rules);
    if(block)assert.match(block[1].trim(),/^allow read, write: if false;$/,name);
  }
});

test('firestore.indexes.json declares the business_operations expireAt TTL policy without indexing the field',()=>{
  const spec=JSON.parse(readFileSync(new URL('../firestore.indexes.json',import.meta.url),'utf8'));
  assert.deepEqual(spec.fieldOverrides.filter(f=>f.collectionGroup==='business_operations'),[{collectionGroup:'business_operations',fieldPath:'expireAt',ttl:true,indexes:[]}]);
});

test('the read-only scope export lists limited members without secrets and never reports a partial scan',async()=>{
  const [p1,p2,p3,gone]=[uid(),uid(),uid(),uid()],member=(role,status,extra={})=>({id:uid(),name:'Synthetic '+role,email:role+'.'+status+'@example.invalid',role,status,version:2,inviteHash:'f'.repeat(64),sessionExpiresAt:START,accessHistory:[{event:'invited',by:'staff:zacb'}],invite:{attemptId:uid(),sends:[START]},...extra});
  const limited=member('manager','active',{propertyIds:[p2,gone]}),pending=member('viewer','invited',{propertyIds:[p1]}),revoked=member('billing','revoked',{propertyIds:[p1]}),malformed=member('viewer','active',{propertyIds:p1});
  const accounts=[
    {id:'a'.repeat(32),company:'Synthetic Zeta Co',status:'active',properties:[{id:p1,name:'Synthetic North Lot',access:'Gate code 0000'},{id:p2,name:'Synthetic South Lot'}],members:[member('admin','active',{propertyIds:[p1]}),member('manager','active'),member('viewer','active',{propertyIds:[]}),limited,pending,revoked,malformed]},
    {id:'b'.repeat(32),company:'Synthetic Alpha Co',status:'inactive',properties:[{id:p3,name:'Synthetic Plaza'}],members:[member('viewer','active',{propertyIds:[p3]})]},
  ];
  const rows=scopedMembers(accounts);
  // A member of an inactive company widens too: staff reactivating the company while rolled back would give them every property.
  assert.deepEqual(rows.map(r=>[r.company,r.accountStatus,r.role,r.status,r.widensOnRollback]),[['Synthetic Alpha Co','inactive','viewer','active',true],['Synthetic Zeta Co','active','billing','revoked',false],['Synthetic Zeta Co','active','manager','active',true],['Synthetic Zeta Co','active','viewer','active',true],['Synthetic Zeta Co','active','viewer','invited',true]]);
  const row=rows.find(r=>r.memberId===limited.id);
  assert.deepEqual(row,{accountId:'a'.repeat(32),company:'Synthetic Zeta Co',accountStatus:'active',memberId:limited.id,name:'Synthetic manager',email:'manager.active@example.invalid',role:'manager',status:'active',generation:2,propertyIds:[p2,gone],properties:[{id:p2,name:'Synthetic South Lot',known:true},{id:gone,name:'',known:false}],widensOnRollback:true});
  assert.deepEqual(rows.find(r=>r.memberId===malformed.id).propertyIds,[]);assert.equal(rows.find(r=>r.memberId===malformed.id).malformed,true);
  // Two Firestore pages through the injected fetcher; every call is a masked GET, and nothing secret is exported.
  const calls=[],page=(list,next)=>Response.json({documents:list.map(({id,...fields})=>({name:`${ROOT}/business_accounts/${id}`,updateTime:'2026-09-22T12:00:00.000000Z',fields:encodeFirestoreFields(fields)})),...(next?{nextPageToken:next}:{})});
  const fetcher=async(env,url,init={})=>{calls.push({url:new URL(url),method:init.method||'GET',body:init.body});return new URL(url).searchParams.get('pageToken')==='next'?page(accounts.slice(1)):page(accounts.slice(0,1),'next');};
  const report=await exportMemberScopes({},{fetcher,now:new Date(START).toISOString()});
  assert.deepEqual([report.exportedAt,report.accounts,report.limitedMembers,report.widensOnRollback],[new Date(START).toISOString(),2,5,4]);
  assert.deepEqual(report.members,rows);
  assert.ok(calls.every(c=>c.method==='GET'&&c.body===undefined&&c.url.pathname.endsWith('/documents/business_accounts')),'read-only: no commit, patch or delete');
  assert.deepEqual(calls[0].url.searchParams.getAll('mask.fieldPaths'),['company','status','properties','members']);
  const dump=JSON.stringify(report);for(const secret of ['f'.repeat(64),'accessHistory','inviteHash','sessionExpiresAt','attemptId','Gate code','staff:zacb'])assert.equal(dump.includes(secret),false,secret);
  // A failed, malformed or repeating page aborts the whole export instead of returning a shorter list.
  for(const broken of [async()=>new Response('unavailable',{status:503}),async()=>Response.json([]),async()=>Response.json({documents:[{name:'other/path',fields:{}}]}),async(env,url)=>page(accounts.slice(0,1),'loop'),async()=>{throw new Error('offline');}])
    await assert.rejects(scanBusinessAccounts({},broken),e=>e.code==='business_scope_export_failed');
  assert.deepEqual(parseArgs(['--out','scope.json']),{out:'scope.json',help:false});
  for(const argv of [['--out'],['--apply'],['--write']])assert.throws(()=>parseArgs(argv));
  const dir=await mkdtemp(join(tmpdir(),'egc-scope-export-')),file=join(dir,'scope.json');
  try{
    await writeFile(file,'stale',{mode:0o644});await writeExport(file,JSON.stringify(report));assert.equal((await stat(file)).mode&0o777,0o600);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),JSON.parse(JSON.stringify(report)));
    // The command line: with --out the people go only to the private file; the terminal gets one summary line.
    const env={FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify({type:'service_account',project_id:'egcw-1ec83',client_email:'synthetic@egcw-1ec83.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'})};
    const cli=async argv=>{const out=[],err=[];const code=await runExport(argv,{env,fetcher,now:()=>new Date(START).toISOString(),stdout:{write:v=>out.push(v)},stderr:{write:v=>err.push(v)}});return {code,out:out.join(''),err:err.join('')};};
    const saved=join(dir,'cli.json'),toFile=await cli(['--out',saved]);
    assert.equal(toFile.code,0);assert.equal(toFile.out,'','nothing is printed to stdout');
    assert.match(toFile.err,/^READ-ONLY: 2 business accounts, 5 members limited to selected properties, 4 would see every property after a rollback past B2B-SCOPE \(1 of them in inactive companies\)\. Members written only to .*cli\.json \(private\)\.\n$/);
    assert.equal((await stat(saved)).mode&0o777,0o600);assert.deepEqual(JSON.parse(await readFile(saved,'utf8')).members,JSON.parse(JSON.stringify(rows)));
    // A private write that fails prints none of the people and exits non-zero.
    const failed=await cli(['--out',join(dir,'missing','cli.json')]);
    assert.equal(failed.code,1);assert.equal(failed.out,'');assert.match(failed.err,/could not be written privately, so nothing was saved or printed/);
    for(const person of ['@example.invalid','Synthetic manager'])assert.equal((failed.out+failed.err+toFile.err).includes(person),false,person);
    // Without --out the JSON goes to stdout, as before; bad arguments and a missing service account print nothing and exit 2.
    const printed=await cli([]);assert.equal(printed.code,0);assert.deepEqual(JSON.parse(printed.out).members,JSON.parse(JSON.stringify(rows)));
    for(const argv of [['--apply'],['--out']])assert.deepEqual([(await cli(argv)).code,(await cli(argv)).out],[2,'']);
    const unconfigured=await runExport([],{env:{},fetcher,stdout:{write:()=>assert.fail('printed')},stderr:{write:()=>{}}});assert.equal(unconfigured,2);
  }
  finally{await rm(dir,{recursive:true,force:true});}
});

test('the dry-run-by-default TTL backfill gives legacy receipts and email cap records the expireAt the hub writes today',async()=>{
  const mem=firestoreMemory(),hex=n=>crypto.randomUUID().replaceAll('-','').repeat(2).slice(0,n),NOW=Date.UTC(2026,8,23,18),at=ms=>new Date(ms).toISOString();
  const ids={receipt:hex(32),old:hex(32),quota:hex(64),updatedOnly:hex(64),current:hex(32),unknown:hex(32),badTime:hex(32),moved:hex(32)};
  // Records as the hub wrote them before B2B-HARDEN (no expireAt), plus one written since and two it cannot date.
  const legacy={
    receipt:{action:'set_member_properties',actorId:'staff:zacb',fingerprint:'f'.repeat(64),accountId:hex(32),at:at(NOW-2*DAY)},
    old:{action:'create_account',actorId:'staff:zacb',fingerprint:'e'.repeat(64),accountId:hex(32),at:at(NOW-90*DAY),memberId:hex(32),generation:1,deliver:'email'},
    quota:{kind:'invite_email_quota',scope:'address',sends:[{at:NOW-5*HOUR,attemptId:hex(32)},{at:NOW-2*HOUR,attemptId:hex(32)}],updatedAt:at(NOW-3*HOUR)},
    updatedOnly:{kind:'invite_email_quota',scope:'sender',sends:[],updatedAt:at(NOW-40*HOUR)},
    current:{action:'revoke_member',actorId:'staff:zacb',fingerprint:'d'.repeat(64),accountId:hex(32),at:at(NOW),expireAt:new Date(NOW+RECEIPT_DAYS*DAY)},
    unknown:{note:'synthetic'},
    badTime:{action:'invite_member',at:'not a time'},
    moved:{action:'resend_invite',actorId:'staff:zacb',fingerprint:'c'.repeat(64),accountId:hex(32),at:at(NOW-DAY)},
  };
  for(const [key,data] of Object.entries(legacy))mem.put(`business_operations/${ids[key]}`,data);
  // Reads go to the in-memory Firestore; commits apply the masked raw fields (keeping timestamps) with real precondition answers.
  const writes=[];let revision=0;
  const fetcher=async(env,url,init={})=>{
    if(!String(url).endsWith(':commit'))return mem.fetch(url,init);
    const batch=JSON.parse(init.body).writes,key=write=>write.update.name.split('/documents/')[1];writes.push(batch);
    if(batch.some(write=>mem.documents.get(key(write))?.updateTime!==write.currentDocument.updateTime))return Response.json({error:{status:'FAILED_PRECONDITION'}},{status:400});
    for(const write of batch){const document=mem.documents.get(key(write)),fields={...document.fields};for(const path of write.updateMask.fieldPaths)fields[path]=write.update.fields[path];mem.documents.set(key(write),{...document,fields,updateTime:`2026-09-23T00:00:00.${String(++revision).padStart(9,'0')}Z`});}
    return Response.json({writeResults:batch.map(()=>({}))});
  };
  assert.deepEqual(legacyExpireAt(legacy.quota),new Date(NOW-2*HOUR+DAY),'the newest send is later than the last write');
  assert.deepEqual(legacyExpireAt(legacy.updatedOnly),new Date(NOW-40*HOUR+DAY));assert.equal(legacyExpireAt(legacy.unknown),null);assert.equal(legacyExpireAt(legacy.badTime),null);
  assert.throws(()=>planOperationsTtl(null,at(NOW)));assert.throws(()=>planOperationsTtl([],'soon'));
  const expected={receipt:NOW-2*DAY+RECEIPT_DAYS*DAY,old:NOW-90*DAY+RECEIPT_DAYS*DAY,quota:NOW-2*HOUR+DAY,updatedOnly:NOW-40*HOUR+DAY,moved:NOW-DAY+RECEIPT_DAYS*DAY};
  const dry=await runOperationsTtlBackfill({},{fetcher,now:at(NOW)});
  assert.deepEqual(writes,[],'the dry run writes nothing');
  assert.deepEqual(dry,{mode:'dry_run',generatedAt:at(NOW),operations:{scanned:8,current:1,receipts:3,quotas:2,alreadyPast:2,unrecognized:[ids.unknown,ids.badTime].sort()},writes:{planned:5,committed:0,changedDuringRun:[]}});
  // --apply: one record is rewritten by the hub between the scan and the commit; only it is skipped.
  let raced=false;
  const racing=async(env,url,init={})=>{if(!raced&&String(url).endsWith(':commit')){raced=true;mem.put(`business_operations/${ids.moved}`,{...legacy.moved,expireAt:new Date(NOW+DAY)});}return fetcher(env,url,init);};
  const applied=await runOperationsTtlBackfill({},{fetcher:racing,apply:true,now:at(NOW),batchSize:10});
  assert.deepEqual(applied.writes,{planned:5,committed:4,changedDuringRun:[ids.moved]});assert.equal(applied.aborted,undefined);
  for(const batch of writes)for(const write of batch){assert.deepEqual(write.updateMask,{fieldPaths:['expireAt']});assert.match(write.currentDocument.updateTime,/Z$/);assert.deepEqual(Object.keys(write.update.fields),['expireAt']);assert.ok(write.update.fields.expireAt.timestampValue);}
  for(const [key,ms] of Object.entries(expected)){
    const document=mem.documents.get(`business_operations/${ids[key]}`),row=decodeFirestoreFields(document.fields);
    assert.equal(Date.parse(document.fields.expireAt.timestampValue),key==='moved'?NOW+DAY:ms,key);
    const {expireAt,...rest}=row;assert.deepEqual(rest,decodeFirestoreFields(encodeFirestoreFields(key==='moved'?{...legacy.moved}:legacy[key])),'no other field changed: '+key);
  }
  for(const key of ['unknown','badTime','current'])assert.deepEqual(decodeFirestoreFields(mem.documents.get(`business_operations/${ids[key]}`).fields),decodeFirestoreFields(encodeFirestoreFields(legacy[key])),key);
  // A rerun finds nothing left; a refused commit aborts with a rerun message instead of reporting success.
  const rerun=await runOperationsTtlBackfill({},{fetcher,apply:true,now:at(NOW)});assert.deepEqual([rerun.operations.current,rerun.writes.planned],[6,0]);
  mem.put(`business_operations/${hex(32)}`,{action:'invite_member',at:at(NOW)});
  const refused=await runOperationsTtlBackfill({},{fetcher:async(env,url,init)=>String(url).endsWith(':commit')?Response.json({error:{status:'PERMISSION_DENIED'}},{status:403}):fetcher(env,url,init),apply:true,now:at(NOW)});
  assert.equal(refused.aborted.code,'business_operations_ttl_backfill_commit_failed');assert.equal(refused.writes.committed,0);
  await assert.rejects(runOperationsTtlBackfill({},{fetcher:async()=>new Response('unavailable',{status:503}),now:at(NOW)}),e=>e.code==='business_operations_ttl_backfill_scan_failed');
});
