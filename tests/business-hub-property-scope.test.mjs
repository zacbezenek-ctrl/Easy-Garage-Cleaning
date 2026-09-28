import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessHandler } from '../functions/_lib/business-hub-service.js';
import { readBusinessProjectViewer, createBusinessStore } from '../functions/_lib/business-hub-store.js';
import { businessHubModules } from '../functions/_lib/business-hub-modules.js';
import { uid } from '../functions/_lib/business-hub-core.js';
import { memberPropertyIds, canSeeProperty, scopeAccount, requestedPropertyIds } from '../functions/_lib/business-hub-scope.js';
import { readCustomerPortalContext } from '../functions/_lib/customer-portal-access.js';
const origin='https://easygaragecleaning.com', START=Date.UTC(2026,8,23,18);
// Firestore commit semantics: every precondition is checked before any write applies.
class MemoryStore {
  constructor(){this.records=new Map();this.clock=0;this.commits=[];}
  async read(c,id){return structuredClone(this.records.get(c+'/'+id)||null);}
  async commit(changes){
    this.commits.push(changes.map(w=>w.collection+'/'+w.id));
    for(const w of changes){const old=this.records.get(w.collection+'/'+w.id);if(w.version ? old?._version!==w.version : Boolean(old))throw Object.assign(new Error('Conflict'),{status:409,publicMessage:'The record changed or could not be saved. Refresh and retry; no partial update was applied.'});}
    for(const w of changes){const key=w.collection+'/'+w.id,old=this.records.get(key);this.records.set(key,{...(w.patch?old:{}),...structuredClone(w.data),id:w.id,_version:String(++this.clock)});}
  }
  async list(profile){return {accounts:[...this.records.entries()].filter(([k,v])=>k.startsWith('business_accounts/')&&(profile.businessAccess||v.ownerStaff===profile.user)).map(([,v])=>structuredClone(v)),next:''};}
  async jobs(ids){return new Map((await Promise.all(ids.map(i=>this.read('jobs',i)))).filter(Boolean).map(j=>[j.id,j]));}
  rows(prefix){return [...this.records.entries()].filter(([k])=>k.startsWith(prefix+'/')).map(([,v])=>v);}
}
function setup(deps={}){
  const store=new MemoryStore();let clock=START;let staff={user:'zacb',displayName:'Synthetic Owner',businessAccess:true,role:'owner'};
  const handler=createBusinessHandler({store,getStaff:async()=>staff,finance:j=>({total:j.total||0,paid:j.paid||0,balance:(j.total||0)-(j.paid||0)}),needsReview:()=>false,projectCookie:async(jobId,claims)=>`project=${jobId}:${claims.actorId}; HttpOnly; Secure`,clearProjectCookie:()=>'project=; Max-Age=0',now:()=>clock,...businessHubModules,...deps});
  async function call(payload,{url='',cookie='',headers={}}={}){const res=await handler(new Request(origin+'/api/business-hub'+url,{method:payload?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json','X-EGC-Business':'1',Cookie:cookie,...headers},...(payload?{body:JSON.stringify(payload)}:{})}));const type=res.headers.get('Content-Type')||'';return {status:res.status,data:type.includes('json')?await res.json():await res.text(),cookie:res.headers.get('Set-Cookie')};}
  async function onboard(company='Synthetic Portfolio Co'){const created=await call({action:'create_account',company,name:'Synthetic Admin',email:'admin@example.invalid'},{url:'?staff=1'});assert.equal(created.status,201);const accepted=await call({action:'redeem',invite:created.data.invite});assert.equal(accepted.status,200);return {accountId:created.data.accountId,cookie:accepted.cookie.split(';')[0],staffUrl:'?staff=1&account='+created.data.accountId};}
  async function member(a,role,extra={},address=role+'@example.invalid'){const inv=await call({action:'invite_member',name:'Synthetic '+role,email:address,role,...extra},{cookie:a.cookie});assert.equal(inv.status,201,JSON.stringify(inv.data));const login=await call({action:'redeem',invite:inv.data.invite});assert.equal(login.status,200);return {cookie:login.cookie.split(';')[0],memberId:inv.data.invite.split('.')[1]};}
  const account=async a=>store.read('business_accounts',a.accountId);
  return {store,call,onboard,member,account,setStaff:value=>staff=value,advance:ms=>clock+=ms};
}
// Two properties, each with a request, a request message and a released, invoiced project; plus one general message.
async function portfolio(h,tag=''){
  const a=await h.onboard(),ids={};
  for(const [key,name] of [['north','Synthetic North Lot'],['south','Synthetic South Lot']]){
    const propertyId=(await h.call({action:'save_property',name,address:name+', 1 Example Way'},{cookie:a.cookie})).data.propertyId,requestId=uid(),jobId='synthetic_'+key+tag;
    assert.equal((await h.call({action:'request_service',requestId,propertyId,service:'Cleanout',scope:'Synthetic '+key+' scope',payer:'Synthetic Portfolio Co'},{cookie:a.cookie})).status,201);
    assert.equal((await h.call({action:'message',messageId:uid(),requestId,body:'Synthetic '+key+' question'},{cookie:a.cookie})).status,201);
    await h.store.commit([{collection:'jobs',id:jobId,data:{type:'job',total:key==='north'?1000:2500,paid:0,estimate:{amount:1000,status:'sent',sentAt:'2026-09-22T12:00:00.000Z'},invoice:{number:'INV-'+key,status:'sent'}}}]);
    assert.equal((await h.call({action:'link_project',propertyId,jobId,requestId,sharingAuthorized:true},{url:a.staffUrl})).status,200);
    ids[key]={propertyId,requestId,jobId};
  }
  assert.equal((await h.call({action:'message',messageId:uid(),body:'Synthetic general note'},{cookie:a.cookie})).status,201);
  return {...a,...ids};
}
const snapshotOf=async(h,cookie,url='')=>(await h.call(null,{cookie,url})).data;
const actorOf=cookie=>/biz_[a-f0-9_]+/.exec(cookie)[0];

test('a restricted manager sees only their property, its requests, projects, balances and request messages',async()=>{
  const h=setup(),a=await portfolio(h),manager=await h.member(a,'manager',{propertyIds:[a.north.propertyId]});
  const view=await snapshotOf(h,manager.cookie),dump=JSON.stringify(view);
  assert.deepEqual(view.properties.map(p=>p.id),[a.north.propertyId]);
  assert.deepEqual(view.requests.map(r=>r.id),[a.north.requestId]);
  assert.deepEqual(view.projects.map(p=>[p.jobId,p.balance]),[['synthetic_north',1000]]);
  assert.deepEqual(view.messages.map(m=>m.body),['Synthetic north question','Synthetic general note']);
  assert.equal(view.coverage.linked,1);assert.deepEqual(view.viewer.propertyIds,[a.north.propertyId]);
  for(const hidden of [a.south.propertyId,a.south.requestId,'synthetic_south','Synthetic South Lot','Synthetic south question'])assert.equal(dump.includes(hidden),false,hidden);
  assert.equal(view.members.some(m=>'propertyIds' in m),false);
  const admin=await snapshotOf(h,a.cookie);assert.equal(admin.properties.length,2);assert.equal(admin.projects.length,2);assert.equal(admin.messages.length,3);assert.equal(admin.viewer.propertyIds,undefined);
  assert.deepEqual(admin.members.find(m=>m.id===manager.memberId).propertyIds,[a.north.propertyId]);assert.equal(admin.members.find(m=>m.role==='admin').propertyIds,undefined);
});

test('direct ids for another property are refused with 403 and nothing is saved',async()=>{
  const h=setup(),a=await portfolio(h),manager=await h.member(a,'manager',{propertyIds:[a.north.propertyId]});
  const before=JSON.stringify(await h.account(a)),south=a.south;
  assert.equal((await h.call({action:'request_service',requestId:uid(),propertyId:south.propertyId,service:'Cleanout',scope:'Synthetic',payer:'Synthetic'},{cookie:manager.cookie})).status,403);
  assert.equal((await h.call({action:'message',messageId:uid(),requestId:south.requestId,body:'Synthetic cross-property'},{cookie:manager.cookie})).status,403);
  const open=await h.call({action:'open_project',jobId:south.jobId},{cookie:manager.cookie});assert.equal(open.status,403);assert.equal(open.cookie,null);
  assert.equal((await h.call({action:'save_property',propertyId:south.propertyId,name:'Renamed',address:'Elsewhere'},{cookie:manager.cookie})).status,403);
  assert.equal(JSON.stringify(await h.account(a)),before);
  assert.equal((await h.call({action:'request_service',requestId:uid(),propertyId:a.north.propertyId,service:'Cleanout',scope:'Synthetic north again',payer:'Synthetic'},{cookie:manager.cookie})).status,201);
  assert.equal((await h.call({action:'message',messageId:uid(),requestId:a.north.requestId,body:'Synthetic allowed'},{cookie:manager.cookie})).status,201);
  assert.equal((await h.call({action:'message',messageId:uid(),body:'Synthetic general'},{cookie:manager.cookie})).status,201);
  assert.equal((await h.call({action:'save_property',propertyId:a.north.propertyId,name:'Synthetic North Lot',address:'Updated north address'},{cookie:manager.cookie})).status,200);
  const opened=await h.call({action:'open_project',jobId:a.north.jobId},{cookie:manager.cookie});assert.equal(opened.status,200);assert.match(opened.cookie,/^project=synthetic_north:biz_/);
});

test('a restricted member cannot add a property; all-property members and staff still can',async()=>{
  const h=setup(),a=await portfolio(h),manager=await h.member(a,'manager',{propertyIds:[a.north.propertyId]}),open=await h.member(a,'manager',{},'open@example.invalid');
  const added=await h.call({action:'save_property',requestId:uid(),name:'Synthetic New Lot',address:'3 Example Way'},{cookie:manager.cookie});
  assert.equal(added.status,403);assert.match(added.data.error,/every property/);assert.equal((await h.account(a)).properties.length,2);
  assert.equal((await h.call({action:'save_property',requestId:uid(),name:'Synthetic Open Lot',address:'4 Example Way'},{cookie:open.cookie})).status,200);
  assert.equal((await h.call({action:'save_property',requestId:uid(),name:'Synthetic Staff Lot',address:'5 Example Way'},{url:a.staffUrl})).status,200);
  assert.equal((await h.account(a)).properties.length,4);
  assert.deepEqual((await snapshotOf(h,manager.cookie)).properties.map(p=>p.id),[a.north.propertyId]);
});

test('delegated customer-portal access is denied on the next request after narrowing, without a sign-out or version bump',async()=>{
  const h=setup(),a=await portfolio(h),manager=await h.member(a,'manager');
  const opened=await h.call({action:'open_project',jobId:a.north.jobId},{cookie:manager.cookie});assert.equal(opened.status,200);
  const actorId=actorOf(opened.cookie),job=await h.store.read('jobs',a.north.jobId),businessRead=(env,actor,target)=>readBusinessProjectViewer(env,actor,target,{store:h.store});
  const session={jobId:a.north.jobId,actorId,permissions:{view:true,decide:true,pay:false,rebook:true}};
  const context=await readCustomerPortalContext({},session,{read:async()=>job,businessRead});assert.equal(context.session.permissions.decide,true);
  const version=(await h.account(a)).members.find(m=>m.id===manager.memberId).version;
  const narrowed=await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds:[a.south.propertyId],requestId:uid()},{cookie:a.cookie});assert.equal(narrowed.status,200);
  await assert.rejects(()=>businessRead({},actorId,job),e=>e.status===403);
  await assert.rejects(()=>readCustomerPortalContext({},session,{read:async()=>job,businessRead}),e=>e.status===403&&e.code==='CUSTOMER_PORTAL_BUSINESS_ACCESS');
  assert.equal((await h.account(a)).members.find(m=>m.id===manager.memberId).version,version);
  assert.equal((await h.call(null,{cookie:manager.cookie})).status,200);
  const south=await h.store.read('jobs',a.south.jobId);assert.equal((await businessRead({},actorId,south)).permissions.decide,true);
  assert.equal((await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds:null},{cookie:a.cookie})).status,200);
  assert.equal((await businessRead({},actorId,job)).name,'Synthetic manager');
});

test('administrators cannot be restricted and the last administrator keeps every property',async()=>{
  const h=setup(),a=await portfolio(h),adminId=(await h.account(a)).members.find(m=>m.role==='admin').id;
  const invited=await h.call({action:'invite_member',name:'Synthetic Admin Two',email:'admin2@example.invalid',role:'admin',propertyIds:[a.north.propertyId]},{cookie:a.cookie});
  assert.equal(invited.status,400);assert.equal((await h.account(a)).members.length,1);
  for(const options of [{cookie:a.cookie},{url:a.staffUrl}])assert.equal((await h.call({action:'set_member_properties',memberId:adminId,propertyIds:[a.north.propertyId]},options)).status,409);
  assert.deepEqual((await h.call({action:'set_member_properties',memberId:adminId,propertyIds:[]},{cookie:a.cookie})).data,{ok:true,unchanged:true});
  // A malformed record cannot narrow an administrator either.
  const saved=await h.account(a);saved.members[0].propertyIds=[a.south.propertyId];await h.store.commit([{collection:'business_accounts',id:a.accountId,data:saved,version:saved._version}]);
  assert.equal((await snapshotOf(h,a.cookie)).properties.length,2);assert.equal(memberPropertyIds(saved.members[0]),null);
  const limited=await h.member(a,'viewer',{propertyIds:[a.north.propertyId]});
  h.advance(8*86400000);
  const promoted=await h.call({action:'invite_member',name:'Synthetic viewer',email:'viewer@example.invalid',role:'admin'},{url:a.staffUrl});assert.equal(promoted.status,201);
  const member=(await h.account(a)).members.find(m=>m.id===limited.memberId);assert.equal(member.role,'admin');assert.equal('propertyIds' in member,false);
});

test('legacy members without propertyIds see everything; empty or null lists mean every property; malformed values fail closed',async()=>{
  const h=setup(),a=await portfolio(h),manager=await h.member(a,'manager');
  assert.equal('propertyIds' in (await h.account(a)).members.find(m=>m.id===manager.memberId),false);
  for(const value of [undefined,null,[]]){
    const saved=await h.account(a),target=saved.members.find(m=>m.id===manager.memberId);if(value===undefined)delete target.propertyIds;else target.propertyIds=value;
    await h.store.commit([{collection:'business_accounts',id:a.accountId,data:saved,version:saved._version}]);
    const view=await snapshotOf(h,manager.cookie);assert.equal(view.properties.length,2,String(value));assert.equal(view.projects.length,2);assert.equal(view.viewer.propertyIds,undefined);
    assert.equal((await h.call({action:'open_project',jobId:a.south.jobId},{cookie:manager.cookie})).status,200);
  }
  const saved=await h.account(a);saved.members.find(m=>m.id===manager.memberId).propertyIds=a.north.propertyId;
  await h.store.commit([{collection:'business_accounts',id:a.accountId,data:saved,version:saved._version}]);
  const view=await snapshotOf(h,manager.cookie);assert.deepEqual([view.properties.length,view.requests.length,view.projects.length],[0,0,0]);
  assert.equal((await h.call({action:'open_project',jobId:a.north.jobId},{cookie:manager.cookie})).status,403);
  assert.equal(canSeeProperty({role:'viewer',propertyIds:['__proto__']},'__proto__'),false);
});

test('prototype keys, foreign property ids and malformed lists are rejected with 400',async()=>{
  const h=setup(),a=await portfolio(h),b=await portfolio(h,'_b'),manager=await h.member(a,'manager');
  const before=JSON.stringify(await h.account(a));
  for(const propertyIds of [['__proto__'],['constructor'],[uid()],[b.north.propertyId],[a.north.propertyId,b.south.propertyId],'all',a.north.propertyId,{0:a.north.propertyId},[a.north.propertyId.toUpperCase()],Array(101).fill(a.north.propertyId)])
    assert.equal((await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds},{cookie:a.cookie})).status,400,JSON.stringify(propertyIds).slice(0,60));
  assert.equal((await h.call({action:'set_member_properties',memberId:manager.memberId},{cookie:a.cookie})).status,400);
  for(const memberId of ['__proto__','constructor',42])assert.equal((await h.call({action:'set_member_properties',memberId,propertyIds:[]},{cookie:a.cookie})).status,400);
  assert.equal((await h.call({action:'set_member_properties',memberId:uid(),propertyIds:[]},{cookie:a.cookie})).status,404);
  assert.equal((await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds:[],requestId:'not-an-id'},{cookie:a.cookie})).status,400);
  assert.equal((await h.call({action:'invite_member',name:'Synthetic',email:'foreign@example.invalid',role:'viewer',propertyIds:[b.north.propertyId]},{cookie:a.cookie})).status,400);
  for(const propertyId of ['__proto__','constructor',b.north.propertyId])assert.equal((await h.call({action:'request_service',requestId:uid(),propertyId,service:'Cleanout',scope:'Synthetic',payer:'Synthetic'},{cookie:a.cookie})).status,400);
  assert.equal(JSON.stringify(await h.account(a)),before);
  const account=await h.account(a);
  assert.deepEqual(requestedPropertyIds(account,[a.south.propertyId,a.north.propertyId,a.south.propertyId]),[a.north.propertyId,a.south.propertyId]);
  assert.equal(requestedPropertyIds(account,undefined),undefined);assert.equal(requestedPropertyIds(account,[]),null);
});

test('only team permission changes property access; staff are unaffected by scope',async()=>{
  const h=setup(),a=await portfolio(h),target=await h.member(a,'viewer',{},'target@example.invalid');
  for(const role of ['manager','billing','viewer']){const m=await h.member(a,role);assert.equal((await h.call({action:'set_member_properties',memberId:target.memberId,propertyIds:[a.north.propertyId]},{cookie:m.cookie})).status,403,role);}
  assert.equal((await h.call({action:'set_member_properties',memberId:target.memberId,propertyIds:[a.north.propertyId]},{url:a.staffUrl})).status,200);
  const staffView=await snapshotOf(h,'',a.staffUrl);assert.equal(staffView.properties.length,2);assert.equal(staffView.projects.length,2);assert.equal(staffView.messages.length,3);
  assert.deepEqual(staffView.members.find(m=>m.id===target.memberId).propertyIds,[a.north.propertyId]);
  h.setStaff({user:'synthetic.sales',role:'sales',businessAccess:false});
  assert.equal((await h.call({action:'set_member_properties',memberId:target.memberId,propertyIds:[]},{url:a.staffUrl})).status,403);
  const revoked=await h.member(a,'viewer',{},'gone@example.invalid');assert.equal((await h.call({action:'revoke_member',memberId:revoked.memberId},{cookie:a.cookie})).status,200);
  assert.equal((await h.call({action:'set_member_properties',memberId:revoked.memberId,propertyIds:[a.north.propertyId]},{cookie:a.cookie})).status,409);
});

test('the CSV/ledger export hook, decorators and helpers receive only in-scope rows and cannot save a filtered account',async()=>{
  const seen={};
  const exporters={synthetic_ledger:async(ctx,url,{snapshot,save})=>{const view=await snapshot(ctx);seen.export={links:ctx.account.projects.map(p=>p.jobId),properties:ctx.account.properties.length};
    seen.saveError=await save(ctx,'synthetic_export').then(()=>null,e=>e.status);
    return new Response(['job,balance',...view.projects.map(p=>`${p.jobId},${p.balance}`)].join('\r\n'),{headers:{'Content-Type':'text/csv'}});}};
  const decorate=[(view,ctx,jobs)=>{seen.decorate=[...jobs.keys()];seen.decorateLinks=ctx.account.projects.map(p=>p.jobId);return view;}];
  const actions={synthetic_scope:async(ctx,input,{canSeeProperty:can,scoped,property})=>({data:{north:can(ctx,input.north),south:can(ctx,input.south),visible:scoped(ctx).projects.map(p=>p.jobId),picked:await Promise.resolve().then(()=>property(ctx,input.south).id).catch(e=>e.status)}})};
  const h=setup({exports:exporters,decorate,actions:{...businessHubModules.actions,...actions}}),a=await portfolio(h),manager=await h.member(a,'billing',{propertyIds:[a.north.propertyId]});
  const csv=await h.call(null,{url:'?export=synthetic_ledger',cookie:manager.cookie});
  assert.equal(csv.status,200);assert.equal(csv.data,'job,balance\r\nsynthetic_north,1000');
  assert.deepEqual(seen.export,{links:['synthetic_north'],properties:1});assert.equal(seen.saveError,503);
  assert.deepEqual(seen.decorate,['synthetic_north']);assert.deepEqual(seen.decorateLinks,['synthetic_north']);
  assert.equal((await h.store.rows('business_audit')).some(r=>r.action==='synthetic_export'),false);
  assert.equal((await h.call(null,{url:'?export=synthetic_ledger',cookie:a.cookie})).data,'job,balance\r\nsynthetic_north,1000\r\nsynthetic_south,2500');
  assert.equal(seen.saveError,null);
  const probe={action:'synthetic_scope',north:a.north.propertyId,south:a.south.propertyId};
  assert.deepEqual((await h.call(probe,{cookie:manager.cookie})).data,{north:true,south:false,visible:['synthetic_north'],picked:403});
  assert.deepEqual((await h.call(probe,{url:a.staffUrl})).data,{north:true,south:true,visible:['synthetic_north','synthetic_south'],picked:a.south.propertyId});
});

test('member and scope changes are audited in the same commit with request ids and before/after summaries',async()=>{
  const h=setup(),a=await portfolio(h),manager=await h.member(a,'manager',{propertyIds:[a.north.propertyId]},'pm@example.invalid');
  const invited=h.store.rows('business_audit').filter(r=>r.action==='member_invited').at(-1);
  assert.equal(invited.before,null);assert.deepEqual(invited.after.properties,[a.north.propertyId]);assert.equal(invited.after.email,'pm@example.invalid');
  const hubInvite=h.store.rows('hub_audit').filter(r=>r.action==='business.member_invited').at(-1);
  assert.equal(hubInvite.via,'b2b');assert.equal(hubInvite.actor.kind,'business');assert.equal(hubInvite.actor.role,'admin');assert.match(hubInvite.actor.id,new RegExp(`^biz_${a.accountId}_[a-f0-9]{32}_1$`));
  assert.equal(hubInvite.entityKey,'business_accounts/'+a.accountId);assert.equal(hubInvite.at,new Date(START).toISOString());
  const requestId=crypto.randomUUID().replaceAll('-',''),commits=h.store.commits.length;
  const changed=await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds:[a.north.propertyId,a.south.propertyId],requestId},{cookie:a.cookie});
  assert.equal(changed.status,200);assert.deepEqual(changed.data,{ok:true,propertyIds:[a.north.propertyId,a.south.propertyId]});
  const commit=h.store.commits.at(-1);assert.equal(h.store.commits.length,commits+1);
  assert.deepEqual(commit.map(k=>k.split('/')[0]),['business_accounts','business_audit','business_operations','hub_audit']);
  const receipt=await h.store.read('business_operations',requestId);
  assert.deepEqual([receipt.action,receipt.accountId,receipt.at],['set_member_properties',a.accountId,new Date(START).toISOString()]);assert.match(receipt.fingerprint,/^[a-f0-9]{64}$/);
  const row=h.store.rows('business_audit').find(r=>r.action==='member_properties_changed');
  assert.equal(row.requestId,requestId);assert.equal(row.actorId,(await h.account(a)).members.find(m=>m.role==='admin').id);
  assert.deepEqual([row.before.properties,row.after.properties],[[a.north.propertyId],[a.north.propertyId,a.south.propertyId]]);
  const entry=await h.store.read('hub_audit',commit[3].split('/')[1]);
  assert.equal(entry.action,'business.member_properties');assert.equal(entry.requestId,[requestId.slice(0,8),requestId.slice(8,12),requestId.slice(12,16),requestId.slice(16,20),requestId.slice(20)].join('-'));
  assert.deepEqual(JSON.parse(entry.before).properties,[a.north.propertyId]);assert.deepEqual(JSON.parse(entry.after).properties,[a.north.propertyId,a.south.propertyId]);
  assert.deepEqual(entry.changedKeys,['properties']);
  for(const text of [JSON.stringify(h.store.rows('business_audit')),JSON.stringify(h.store.rows('hub_audit'))])assert.equal(/inviteHash|sessionExpiresAt|[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{64}/.test(text),false);
  // On a moving clock (as in production), a retry of the same change is a duplicate that writes nothing, and the same
  // request id recording a different change is refused whole.
  const audits=h.store.rows('hub_audit').length,rows=h.store.rows('business_audit').length;h.advance(1);
  assert.deepEqual((await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds:[a.south.propertyId,a.north.propertyId],requestId},{cookie:a.cookie})).data,{ok:true,duplicate:true});
  assert.equal(h.store.rows('hub_audit').length,audits);assert.equal(h.store.rows('business_audit').length,rows);h.advance(1);
  const reused=await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds:[a.south.propertyId],requestId},{cookie:a.cookie});
  assert.equal(reused.status,409);assert.deepEqual((await h.account(a)).members.find(m=>m.id===manager.memberId).propertyIds,[a.north.propertyId,a.south.propertyId]);
  assert.equal(h.store.rows('hub_audit').length,audits);assert.equal(h.store.rows('business_audit').length,rows);
  // Staff revocation is audited as a human staff actor.
  assert.equal((await h.call({action:'revoke_member',memberId:manager.memberId,requestId:uid()},{url:a.staffUrl})).status,200);
  const revoked=h.store.rows('hub_audit').find(r=>r.action==='business.member_revoked');
  assert.deepEqual(revoked.actor,{id:'zacb',kind:'human',role:'owner'});assert.equal(JSON.parse(revoked.after).status,'revoked');assert.deepEqual(revoked.changedKeys,['status','version']);
  const edit=h.store.rows('business_audit').filter(r=>r.action==='save_property').at(-1);assert.deepEqual(Object.keys(edit.after).sort(),['address','id','name']);
});

test('a late retry of a scope change is a duplicate on a moving clock and never re-widens access someone else narrowed',async()=>{
  const h=setup(),a=await portfolio(h),b=await portfolio(h,'_b'),manager=await h.member(a,'manager',{propertyIds:[a.north.propertyId]}),other=await h.member(b,'viewer');
  const read=async()=>(await h.account(a)).members.find(m=>m.id===manager.memberId),R=uid();
  const widen={action:'set_member_properties',memberId:manager.memberId,propertyIds:[a.north.propertyId,a.south.propertyId],requestId:R};
  h.advance(60000);assert.equal((await h.call(widen,{cookie:a.cookie})).status,200);
  const T=uid();h.advance(1);assert.equal((await h.call({action:'set_member_properties',memberId:manager.memberId,propertyIds:[a.north.propertyId],requestId:T},{url:a.staffUrl})).status,200);
  const audits=h.store.rows('hub_audit').length,rows=h.store.rows('business_audit').length,saved=JSON.stringify(await h.account(a));
  h.advance(1);const retry=await h.call(widen,{cookie:a.cookie});
  assert.equal(retry.status,200);assert.deepEqual(retry.data,{ok:true,duplicate:true});assert.deepEqual((await read()).propertyIds,[a.north.propertyId]);
  assert.equal(h.store.rows('hub_audit').filter(r=>r.requestId?.replaceAll('-','')===R).length,1);
  // The same id for another change, actor, action or account is refused and applies nothing.
  const reuse=[[{...widen,propertyIds:[a.south.propertyId]},{cookie:a.cookie}],[widen,{url:a.staffUrl}],[{action:'revoke_member',memberId:manager.memberId,requestId:R},{cookie:a.cookie}],
    [{action:'invite_member',name:'Synthetic manager',email:'manager@example.invalid',role:'manager',requestId:R},{cookie:a.cookie}]];
  // ...including the same staff actor using its id on another company account.
  const bScope={action:'set_member_properties',memberId:other.memberId,propertyIds:[b.north.propertyId]};
  reuse.push([{...bScope,requestId:R},{cookie:b.cookie}],[{...bScope,requestId:T},{url:b.staffUrl}]);
  for(const [payload,options] of reuse){h.advance(1);assert.equal((await h.call(payload,options)).status,409,payload.action);}
  assert.equal(JSON.stringify(await h.account(a)),saved);assert.equal(h.store.rows('hub_audit').length,audits);assert.equal(h.store.rows('business_audit').length,rows);
  assert.equal((await read()).status,'active');assert.equal('propertyIds' in (await h.account(b)).members.find(m=>m.id===other.memberId),false);
  // A request id that changed nothing still records its receipt, so it cannot apply a different change later.
  const S=uid(),same={action:'set_member_properties',memberId:manager.memberId,propertyIds:[a.north.propertyId],requestId:S};
  h.advance(1);assert.deepEqual((await h.call(same,{cookie:a.cookie})).data,{ok:true,unchanged:true});assert.equal(h.store.rows('hub_audit').length,audits);
  h.advance(1);assert.equal((await h.call({...same,propertyIds:[]},{cookie:a.cookie})).status,409);assert.deepEqual((await read()).propertyIds,[a.north.propertyId]);
  h.advance(1);assert.deepEqual((await h.call(same,{cookie:a.cookie})).data,{ok:true,duplicate:true});
  // A create_account request id cannot be reused for a member change.
  const C=uid(),created=await h.call({action:'create_account',requestId:C,company:'Synthetic Receipt Co',name:'Synthetic Admin',email:'receipt@example.invalid'},{url:'?staff=1'});assert.equal(created.status,201);
  h.advance(1);assert.equal((await h.call({...widen,requestId:C},{url:a.staffUrl})).status,409);assert.deepEqual((await read()).propertyIds,[a.north.propertyId]);
});

test('invite and revoke request ids are receipted: replays never reissue a link or revoke a renewed member',async()=>{
  const h=setup(),a=await portfolio(h),R=uid(),invite={action:'invite_member',name:'Synthetic Lead',email:'lead@example.invalid',role:'viewer',propertyIds:[a.south.propertyId],requestId:R};
  const first=await h.call(invite,{cookie:a.cookie});assert.equal(first.status,201);
  const memberId=first.data.invite.split('.')[1],read=async()=>(await h.account(a)).members.find(m=>m.id===memberId),version=(await read()).version,audits=h.store.rows('hub_audit').length;
  h.advance(1);const again=await h.call({...invite,email:'Lead@Example.invalid'},{cookie:a.cookie});
  assert.equal(again.status,200);assert.deepEqual(again.data,{ok:true,duplicate:true,email:'lead@example.invalid'});
  assert.equal((await read()).version,version);assert.equal(h.store.rows('hub_audit').length,audits);
  const login=await h.call({action:'redeem',invite:first.data.invite});assert.equal(login.status,200);
  // Signed in now: the replay is still a duplicate rather than the "still signed in" refusal, and a changed payload is 409.
  h.advance(1);assert.equal((await h.call(invite,{cookie:a.cookie})).data.duplicate,true);
  for(const change of [{role:'manager'},{propertyIds:[]},{propertyIds:undefined},{name:'Synthetic Other'}]){h.advance(1);assert.equal((await h.call({...invite,...change},{cookie:a.cookie})).status,409,JSON.stringify(change));}
  assert.equal((await read()).version,version);assert.equal((await read()).status,'active');
  const V=uid(),revoke={action:'revoke_member',memberId,requestId:V};
  h.advance(1);assert.equal((await h.call(revoke,{cookie:a.cookie})).status,200);assert.equal((await h.store.read('business_operations',V)).action,'revoke_member');
  h.advance(1);const renewed=await h.call({action:'invite_member',name:'Synthetic Lead',email:'lead@example.invalid',role:'viewer',requestId:uid()},{cookie:a.cookie});assert.equal(renewed.status,201);
  const revokedAudits=h.store.rows('hub_audit').length;
  h.advance(1);assert.deepEqual((await h.call(revoke,{cookie:a.cookie})).data,{ok:true,duplicate:true});
  assert.equal((await read()).status,'invited');assert.equal(h.store.rows('hub_audit').length,revokedAudits);
  const cookie=(await h.call({action:'redeem',invite:renewed.data.invite})).cookie.split(';')[0];
  assert.deepEqual((await snapshotOf(h,cookie)).properties.map(p=>p.id),[a.south.propertyId]);
  const other=await h.member(a,'billing');h.advance(1);assert.equal((await h.call({action:'revoke_member',memberId:other.memberId,requestId:V},{cookie:a.cookie})).status,409);
  assert.equal((await h.account(a)).members.find(m=>m.id===other.memberId).status,'active');
  // Without a request id nothing changes: a second revoke is applied and audited as before.
  h.advance(1);assert.equal((await h.call({action:'revoke_member',memberId:other.memberId},{cookie:a.cookie})).status,200);
});

test('a request whose project staff re-link to another property no longer names that job for a member limited to the old one',async()=>{
  const h=setup(),a=await portfolio(h),north=await h.member(a,'manager',{propertyIds:[a.north.propertyId]}),south=await h.member(a,'viewer',{propertyIds:[a.south.propertyId]});
  assert.equal((await snapshotOf(h,north.cookie)).requests[0].jobId,'synthetic_north');
  assert.equal((await h.call({action:'link_project',propertyId:a.south.propertyId,jobId:'synthetic_north',sharingAuthorized:true},{url:a.staffUrl})).status,200);
  const view=await snapshotOf(h,north.cookie);
  assert.deepEqual(view.requests.map(r=>[r.id,'jobId' in r]),[[a.north.requestId,false]]);assert.deepEqual(view.projects,[]);assert.equal(view.coverage.linked,0);
  assert.equal(JSON.stringify(view).includes('synthetic_north'),false);
  assert.equal((await h.call({action:'open_project',jobId:'synthetic_north'},{cookie:north.cookie})).status,403);
  assert.deepEqual((await snapshotOf(h,south.cookie)).projects.map(p=>p.jobId).sort(),['synthetic_north','synthetic_south']);
  // The saved request is unchanged; staff and all-property views still show it.
  assert.equal((await h.account(a)).requests.find(r=>r.id===a.north.requestId).jobId,'synthetic_north');
  assert.equal((await snapshotOf(h,a.cookie)).requests.find(r=>r.id===a.north.requestId).jobId,'synthetic_north');
  const [p,r1,r2,j1,j2]=[uid(),uid(),uid(),'synthetic_kept','synthetic_unlinked'];
  const scoped=scopeAccount({properties:[{id:p}],requests:[{id:r1,propertyId:p,jobId:j1},{id:r2,propertyId:p,jobId:j2}],projects:[{jobId:j1,propertyId:p},{jobId:j2,propertyId:p,active:false}],messages:[]},{role:'viewer',propertyIds:[p]});
  assert.deepEqual(scoped.requests,[{id:r1,propertyId:p,jobId:j1},{id:r2,propertyId:p}]);
});

test('renewing a member keeps their saved scope unless the invitation sets it; widening applies immediately',async()=>{
  const h=setup(),a=await portfolio(h),viewer=await h.member(a,'viewer',{propertyIds:[a.north.propertyId]});
  h.advance(8*86400000);
  const admin=await h.call({action:'invite_member',name:'Synthetic Admin',email:'admin@example.invalid',role:'admin'},{url:a.staffUrl});const adminCookie=(await h.call({action:'redeem',invite:admin.data.invite})).cookie.split(';')[0];
  const renewed=await h.call({action:'invite_member',name:'Synthetic viewer',email:'viewer@example.invalid',role:'billing'},{cookie:adminCookie});assert.equal(renewed.status,201);
  const read=async()=>(await h.account(a)).members.find(m=>m.id===viewer.memberId);
  assert.deepEqual((await read()).propertyIds,[a.north.propertyId]);assert.equal((await read()).role,'billing');
  const cookie=(await h.call({action:'redeem',invite:renewed.data.invite})).cookie.split(';')[0];
  assert.equal((await snapshotOf(h,cookie)).projects.length,1);
  assert.equal((await h.call({action:'set_member_properties',memberId:viewer.memberId,propertyIds:[]},{cookie:adminCookie})).status,200);
  assert.equal('propertyIds' in await read(),false);assert.equal((await snapshotOf(h,cookie)).projects.length,2);
  const account=await h.account(a),scoped=scopeAccount(account,{role:'billing',propertyIds:[a.south.propertyId]});
  assert.deepEqual(scoped.projects.map(p=>p.jobId),['synthetic_south']);assert.equal(account.projects.length,2);
});

test('the business store maps Firestore precondition failures to a 409 conflict and other failures to 503',async()=>{
  const sent=[];let status=400;
  const fetcher=async(env,url,init)=>{sent.push(JSON.parse(init.body).writes.map(w=>w.currentDocument));return Response.json({error:{status:status===500?'INTERNAL':'FAILED_PRECONDITION'}},{status});};
  const store=createBusinessStore({},fetcher),write=[{collection:'business_accounts',id:uid(),data:{company:'Synthetic'},version:'2026-09-22T12:00:00.000000Z'}];
  for(const code of [400,409,412]){status=code;await assert.rejects(()=>store.commit(write),e=>e.status===409&&/no partial update/.test(e.publicMessage),String(code));}
  status=500;await assert.rejects(()=>store.commit(write),e=>e.status===503);
  assert.deepEqual(sent[0],[{updateTime:'2026-09-22T12:00:00.000000Z'}]);
});
