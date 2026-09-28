import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBusinessHandler } from '../functions/_lib/business-hub-service.js';
import { createBusinessStore, LIST_FIELDS } from '../functions/_lib/business-hub-store.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { uid, digest } from '../functions/_lib/business-hub-core.js';
import { businessHubModules, combineBusinessHubModules } from '../functions/_lib/business-hub-modules.js';
const origin='https://easygaragecleaning.com', ROOT='projects/egcw-1ec83/databases/(default)/documents', DAY=86400000;
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
  const store=deps.store||new MemoryStore();let clock=Date.UTC(2026,8,23,18);let staff={user:'zacb',displayName:'Zac',businessAccess:true,role:'owner'};
  const handler=createBusinessHandler({store,getStaff:async()=>staff,finance:j=>({total:j.total||0,paid:j.paid||0,balance:(j.total||0)-(j.paid||0)}),needsReview:j=>Boolean(j.review),projectCookie:async(jobId,claims)=>`project=${jobId}:${claims.actorId}; HttpOnly; Secure`,clearProjectCookie:()=> 'project=; Max-Age=0',now:()=>clock,...deps.handler});
  async function raw(payload,{url='',cookie='',headers={},body}={}){return handler(new Request(origin+'/api/business-hub'+url,{method:payload||body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json','X-EGC-Business':'1',Cookie:cookie,...headers},...(payload||body?{body:body??JSON.stringify(payload)}:{})}));}
  async function call(payload,options){const res=await raw(payload,options);const type=res.headers.get('Content-Type')||'';return {status:res.status,data:type.includes('json')?await res.json():await res.text(),cookie:res.headers.get('Set-Cookie'),headers:res.headers};}
  async function onboard(company='Synthetic Client Co'){const created=await call({action:'create_account',company,name:'Synthetic Admin',email:'admin@example.invalid'},{url:'?staff=1'});assert.equal(created.status,201);const accepted=await call({action:'redeem',invite:created.data.invite});assert.equal(accepted.status,200);return {accountId:created.data.accountId,cookie:accepted.cookie.split(';')[0],staffUrl:'?staff=1&account='+created.data.accountId};}
  async function member(a,role,address=role+'@example.invalid'){const inv=await call({action:'invite_member',name:'Synthetic '+role,email:address,role},{cookie:a.cookie});assert.equal(inv.status,201);const login=await call({action:'redeem',invite:inv.data.invite});assert.equal(login.status,200);return {cookie:login.cookie.split(';')[0],memberId:inv.data.invite.split('.')[1],invite:inv.data.invite};}
  return {store,call,raw,onboard,member,setStaff:value=>staff=value,advance:ms=>clock+=ms};
}

test('a registered action runs only after the CSRF, origin, JSON, session and active-account checks',async()=>{
  const seen=[];const h=setup({handler:{actions:{synthetic_ping:async(ctx,input,helpers)=>{seen.push({account:ctx.account.id,member:ctx.member.id,input,helpers:Object.keys(helpers).sort()});return {status:202,data:{ok:true,echo:input.value}};}}}});
  const a=await h.onboard();const ping={action:'synthetic_ping',value:'synthetic'};
  assert.equal((await h.call(ping,{cookie:a.cookie,headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await h.call(ping,{cookie:a.cookie,headers:{Origin:''}})).status,403);
  assert.equal((await h.call(ping,{cookie:a.cookie,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await h.call(ping,{cookie:a.cookie,headers:{'X-EGC-Business':''}})).status,403);
  assert.equal((await h.call(ping,{cookie:a.cookie,headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await h.call(null,{cookie:a.cookie,body:'{"action":'})).status,400);
  assert.equal((await h.call(null,{cookie:a.cookie,body:JSON.stringify({action:'synthetic_ping',pad:'x'.repeat(21000)})})).status,413);
  assert.equal((await h.call(ping)).status,401);
  assert.equal((await h.call(ping,{cookie:'__Host-egc_business='+'a'.repeat(64)})).status,401);
  assert.equal((await h.call(ping,{url:'?staff=1'})).status,400);
  h.setStaff({user:'crew1',role:'crew',businessAccess:false});assert.equal((await h.call(ping,{url:a.staffUrl})).status,403);
  h.setStaff({user:'zacb',displayName:'Zac',businessAccess:true,role:'owner'});
  const saved=await h.store.read('business_accounts',a.accountId);saved.status='inactive';await h.store.commit([{collection:'business_accounts',id:a.accountId,data:saved,version:saved._version}]);
  assert.equal((await h.call(ping,{url:a.staffUrl})).status,403);assert.equal((await h.call(ping,{cookie:a.cookie})).status,401);
  assert.equal(seen.length,0);
  saved.status='active';await h.store.commit([{collection:'business_accounts',id:a.accountId,data:{...saved},version:(await h.store.read('business_accounts',a.accountId))._version}]);
  const ok=await h.call(ping,{cookie:a.cookie});assert.equal(ok.status,202);assert.deepEqual(ok.data,{ok:true,echo:'synthetic'});assert.equal(ok.headers.get('Cache-Control'),'no-store');
  assert.equal(seen.length,1);assert.equal(seen[0].account,a.accountId);assert.deepEqual(seen[0].helpers,['canSeeProperty','finance','needsReview','now','property','requireManager','requirePermission','response','save','scoped','snapshot','store']);
});

test('registered actions use the shared save, permission and property helpers and cannot make responses cacheable',async()=>{
  const h=setup({handler:{actions:{
    synthetic_tag:async(ctx,input,{save,requirePermission,property})=>{requirePermission(ctx,'request');property(ctx,input.propertyId).tag=String(input.tag);await save(ctx,'synthetic_tag');return {data:{ok:true},headers:{'Cache-Control':'public, max-age=600','X-Synthetic':'1'}};},
    synthetic_manager:async(ctx,input,{requireManager})=>{requireManager(ctx);return {status:200,data:{ok:true}};},
  }}});
  const a=await h.onboard(),viewer=await h.member(a,'viewer');
  const propertyId=(await h.call({action:'save_property',name:'Synthetic Unit',address:'1 Example Way'},{cookie:a.cookie})).data.propertyId;
  const res=await h.call({action:'synthetic_tag',propertyId,tag:'north'},{cookie:a.cookie});assert.equal(res.status,200);
  assert.equal(res.headers.get('Cache-Control'),'no-store');assert.equal(res.headers.get('X-Synthetic'),'1');assert.equal(res.headers.get('X-Content-Type-Options'),'nosniff');
  const account=await h.store.read('business_accounts',a.accountId);assert.equal(account.properties[0].tag,'north');
  assert.ok(h.store.rows('business_audit').some(r=>r.action==='synthetic_tag'&&r.accountId===a.accountId));
  assert.equal((await h.call({action:'synthetic_tag',propertyId,tag:'south'},{cookie:viewer.cookie})).status,403);
  assert.equal((await h.call({action:'synthetic_tag',propertyId:uid(),tag:'south'},{cookie:a.cookie})).status,400);
  assert.equal((await h.store.read('business_accounts',a.accountId)).properties[0].tag,'north');
  assert.equal((await h.call({action:'synthetic_manager'},{cookie:a.cookie})).status,403);
  assert.equal((await h.call({action:'synthetic_manager'},{url:a.staffUrl})).status,200);
});

test('unknown and prototype action names still fail with 400; built-in names cannot be replaced',async()=>{
  let calls=0;const h=setup({handler:{actions:{synthetic_ping:async()=>{calls++;return {data:{ok:true}};}}}}),a=await h.onboard();
  for(const action of ['synthetic_missing','constructor','__proto__','toString','hasOwnProperty','Synthetic_Ping'])assert.equal((await h.call({action},{cookie:a.cookie})).status,400,action);
  assert.equal(calls,0);
  const plain=setup(),b=await plain.onboard();assert.equal((await plain.call({action:'synthetic_ping'},{cookie:b.cookie})).status,400);
  const deps={store:new MemoryStore(),getStaff:async()=>null,finance:()=>({}),needsReview:()=>false,projectCookie:async()=>'',clearProjectCookie:()=>''};
  for(const name of ['save_property','redeem','open_project'])assert.throws(()=>createBusinessHandler({...deps,actions:{[name]:async()=>({})}}),/Invalid business hub action/);
  assert.throws(()=>createBusinessHandler({...deps,actions:{'bad-name':async()=>({})}}),/Invalid business hub action/);
  assert.throws(()=>createBusinessHandler({...deps,actions:{synthetic:'not a function'}}),/Invalid business hub action/);
  assert.throws(()=>createBusinessHandler({...deps,exports:{'../x':async()=>new Response('')}}),/Invalid business hub export/);
  assert.throws(()=>createBusinessHandler({...deps,decorate:[null]}),/decorators/);
});

test('the export route requires a session and an account, and is always private',async()=>{
  const seen=[];const h=setup({handler:{exports:{
    synthetic_csv:async(ctx,url,{snapshot})=>{seen.push(url.searchParams.get('export'));const view=await snapshot(ctx);return new Response('company\r\n'+view.account.company,{headers:{'Content-Type':'text/csv','Cache-Control':'public, max-age=86400'}});},
    synthetic_bad:async()=>({ok:true}),
  }}});
  assert.equal((await h.call(null,{url:'?export=synthetic_csv'})).status,401);
  assert.equal((await h.call(null,{url:'?export=unknown'})).status,401);
  assert.equal(seen.length,0);
  const a=await h.onboard();
  const res=await h.call(null,{url:'?export=synthetic_csv',cookie:a.cookie});assert.equal(res.status,200);assert.equal(res.data,'company\r\nSynthetic Client Co');
  assert.equal(res.headers.get('Cache-Control'),'no-store');assert.equal(res.headers.get('Referrer-Policy'),'no-referrer');assert.equal(res.headers.get('X-Content-Type-Options'),'nosniff');
  for(const kind of ['unknown','constructor','__proto__',''])assert.equal((await h.call(null,{url:'?export='+kind,cookie:a.cookie})).status,400,kind);
  assert.equal((await h.call(null,{url:'?staff=1&export=synthetic_csv'})).status,400);
  assert.equal((await h.call(null,{url:a.staffUrl+'&export=synthetic_csv'})).status,200);
  assert.equal((await h.call(null,{url:'?export=synthetic_bad',cookie:a.cookie})).status,503);
  assert.deepEqual(seen,['synthetic_csv','synthetic_csv']);
  const plain=setup(),b=await plain.onboard();assert.equal((await plain.call(null,{url:'?export=synthetic_csv',cookie:b.cookie})).status,400);
});

test('decorators extend the account snapshot with linked jobs, never the staff list, and fail closed',async()=>{
  const seen=[];let broken=false;
  const h=setup({handler:{decorate:[
    (view,ctx,jobs)=>{seen.push([...jobs.keys()]);if(broken)throw new Error('synthetic failure');return {...view,syntheticProgress:[...jobs.values()].map(j=>({jobId:j.id,stage:j.pipelineStatus}))};},
    async view=>({...view,syntheticSecond:view.syntheticProgress.length}),
  ]}});
  const a=await h.onboard();const propertyId=(await h.call({action:'save_property',name:'Synthetic Unit',address:'1 Example Way'},{cookie:a.cookie})).data.propertyId;
  await h.store.commit([{collection:'jobs',id:'synthetic_job',data:{type:'job',pipelineStatus:'scheduled',estimate:{status:'sent'}}}]);
  assert.equal((await h.call({action:'link_project',propertyId,jobId:'synthetic_job',sharingAuthorized:true},{url:a.staffUrl})).status,200);
  const view=(await h.call(null,{cookie:a.cookie})).data;assert.deepEqual(view.syntheticProgress,[{jobId:'synthetic_job',stage:'scheduled'}]);assert.equal(view.syntheticSecond,1);
  assert.deepEqual(seen.at(-1),['synthetic_job']);
  const list=(await h.call(null,{url:'?staff=1'})).data;assert.equal(list.syntheticProgress,undefined);assert.equal(list.accounts.length,1);
  broken=true;const failed=await h.call(null,{cookie:a.cookie});assert.equal(failed.status,503);assert.equal(failed.data.syntheticProgress,undefined);
});

test('create_account is idempotent by requestId and never replays an invitation token',async()=>{
  const h=setup(),requestId=uid(),input={action:'create_account',requestId,company:'Synthetic Retry Co',name:'Synthetic Admin',email:'Admin@Example.invalid'};
  const first=await h.call(input,{url:'?staff=1'});assert.equal(first.status,201);assert.match(first.data.invite,/^[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{64}$/);
  const retry=await h.call({...input,company:' Synthetic Retry Co ',email:'admin@example.invalid'},{url:'?staff=1'});
  assert.equal(retry.status,200);assert.deepEqual(retry.data,{ok:true,duplicate:true,accountId:first.data.accountId});
  assert.equal(h.store.rows('business_accounts').length,1);assert.equal(h.store.rows('business_operations').length,1);
  assert.equal((await h.call({action:'redeem',invite:first.data.invite})).status,200);
  assert.equal((await h.call(input,{url:'?staff=1'})).data.duplicate,true);
  assert.equal((await h.call({...input,company:'Different Co'},{url:'?staff=1'})).status,409);
  h.setStaff({user:'sales2',displayName:'Sales Two',role:'sales',businessAccess:false});
  assert.equal((await h.call(input,{url:'?staff=1'})).status,409);
  assert.equal((await h.call({...input,requestId:'not-a-request-id'},{url:'?staff=1'})).status,400);
  assert.equal(h.store.rows('business_accounts').length,1);
  const receipt=h.store.rows('business_operations')[0];assert.equal(receipt.accountId,first.data.accountId);assert.equal(JSON.stringify(receipt).includes(first.data.invite.split('.')[2]),false);
  const legacy={action:'create_account',company:'Synthetic Legacy Co',name:'Legacy Admin',email:'legacy@example.invalid'};
  assert.equal((await h.call(legacy,{url:'?staff=1'})).status,201);assert.equal((await h.call(legacy,{url:'?staff=1'})).status,201);
  assert.equal(h.store.rows('business_accounts').length,3);
});

test('a lost create_account race cannot write a second account or receipt',async()=>{
  // Both submissions observe "no receipt" before either commits; only the create-only receipt precondition separates them.
  const store=new MemoryStore(),read=store.read.bind(store),arrived=[];
  store.read=async(c,id)=>{const row=await read(c,id);if(c==='business_operations'&&arrived.length<2)await new Promise(go=>{arrived.push(go);if(arrived.length===2)arrived.forEach(f=>f());});return row;};
  const h=setup({store}),requestId=uid(),input={action:'create_account',requestId,company:'Synthetic Race Co',name:'Synthetic Admin',email:'race@example.invalid'};
  const results=await Promise.all([h.call(input,{url:'?staff=1'}),h.call(input,{url:'?staff=1'})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  assert.equal(h.store.rows('business_accounts').length,1);assert.equal(h.store.rows('business_operations').length,1);
  assert.equal((await h.call(input,{url:'?staff=1'})).data.duplicate,true);
});

test('a new property saved with a requestId is created once; edits and legacy saves keep working',async()=>{
  const h=setup(),a=await h.onboard(),requestId=uid(),input={action:'save_property',requestId,name:'Synthetic Tower',address:'9 Example Plaza',contact:'Synthetic Super 970-555-0100',access:'Front desk'};
  const first=await h.call(input,{cookie:a.cookie});assert.equal(first.status,200);assert.equal(first.data.propertyId,requestId);
  const retry=await h.call({...input,name:' Synthetic Tower '},{cookie:a.cookie});assert.deepEqual(retry.data,{ok:true,propertyId:requestId,duplicate:true});
  assert.equal((await h.store.read('business_accounts',a.accountId)).properties.length,1);
  assert.equal((await h.call({...input,address:'10 Example Plaza'},{cookie:a.cookie})).status,409);
  assert.equal((await h.call({...input,requestId:'x'.repeat(32)},{cookie:a.cookie})).status,400);
  assert.equal((await h.call({...input,propertyId:requestId,requestId:uid(),address:'11 Example Plaza'},{cookie:a.cookie})).status,200);
  const saved=await h.store.read('business_accounts',a.accountId);assert.equal(saved.properties.length,1);assert.equal(saved.properties[0].address,'11 Example Plaza');
  assert.equal((await h.call({...input,propertyId:''},{cookie:a.cookie})).status,409);
  for(let i=0;i<2;i++)assert.equal((await h.call({action:'save_property',name:'Legacy',address:'Legacy Way'},{cookie:a.cookie})).status,200);
  assert.equal((await h.store.read('business_accounts',a.accountId)).properties.length,3);
});

test('client snapshots never expose member ids, internal author ids or staff usernames',async()=>{
  const h=setup(),a=await h.onboard(),viewer=await h.member(a,'viewer'),billing=await h.member(a,'billing');
  h.setStaff({user:'synthetic.sales',role:'sales',businessAccess:false});
  const created=await h.call({action:'create_account',company:'Synthetic Sales Co',name:'Synthetic Admin',email:'sales-admin@example.invalid'},{url:'?staff=1'});
  const salesAdmin=(await h.call({action:'redeem',invite:created.data.invite})).cookie.split(';')[0],salesUrl='?staff=1&account='+created.data.accountId;
  const propertyId=(await h.call({action:'save_property',name:'Synthetic Lot',address:'2 Example Way'},{url:salesUrl})).data.propertyId;
  assert.equal((await h.call({action:'request_service',requestId:uid(),propertyId,service:'Cleanout',scope:'Synthetic scope',payer:'Synthetic Sales Co'},{url:salesUrl})).status,201);
  assert.equal((await h.call({action:'message',messageId:uid(),body:'Synthetic staff note'},{url:salesUrl})).status,201);
  const client=(await h.call(null,{cookie:salesAdmin})).data,text=JSON.stringify(client);
  assert.equal(text.includes('synthetic.sales'),false);assert.equal(text.includes('staff:'),false);
  assert.equal(client.messages[0].author,'EGC account team');assert.equal(client.messages[0].fromStaff,true);assert.equal(client.messages[0].authorId,undefined);
  assert.equal(client.requests[0].createdBy,undefined);assert.equal(client.requests[0].createdByName,'EGC account team');assert.equal(client.requests[0].referralAccountId,created.data.accountId);
  const staffView=(await h.call(null,{url:salesUrl})).data;assert.equal(staffView.messages[0].authorId,'staff:synthetic.sales');assert.equal(staffView.requests[0].createdBy,'staff:synthetic.sales');assert.ok(staffView.members[0].id);
  h.setStaff({user:'zacb',displayName:'Zac',businessAccess:true,role:'owner'});
  assert.equal((await h.call({action:'message',messageId:uid(),body:'Named staff note'},{url:a.staffUrl})).status,201);
  assert.equal((await h.call({action:'message',messageId:uid(),body:'Admin note'},{cookie:a.cookie})).status,201);
  for(const cookie of [viewer.cookie,billing.cookie]){
    const view=(await h.call(null,{cookie})).data,dump=JSON.stringify(view);
    assert.equal(view.members.some(m=>'id' in m||'email' in m),false);
    for(const id of [viewer.memberId,billing.memberId])assert.equal(dump.includes(id),false);
    assert.equal(dump.includes('zacb'),false);assert.deepEqual(view.messages.map(m=>m.author),['Zac','Synthetic Admin']);assert.equal(view.messages.some(m=>'authorId' in m),false);
  }
  const admin=(await h.call(null,{cookie:a.cookie})).data;assert.ok(admin.members.every(m=>/^[a-f0-9]{32}$/.test(m.id)&&m.email));
});

test('inviting an active member never logs them out; pending, expired and revoked access can be renewed',async()=>{
  const h=setup(),a=await h.onboard(),viewer=await h.member(a,'viewer');
  const before=(await h.store.read('business_accounts',a.accountId)).members.find(m=>m.id===viewer.memberId);
  const again=await h.call({action:'invite_member',name:'Synthetic viewer',email:'viewer@example.invalid',role:'manager'},{cookie:a.cookie});
  assert.equal(again.status,409);assert.match(again.data.error,/still signed in/);
  assert.equal((await h.call({action:'invite_member',name:'Synthetic viewer',email:'viewer@example.invalid',role:'admin'},{url:a.staffUrl})).status,409);
  const after=(await h.store.read('business_accounts',a.accountId)).members.find(m=>m.id===viewer.memberId);
  assert.equal(after.version,before.version);assert.equal(after.status,'active');assert.equal(after.role,'viewer');
  assert.equal((await h.call(null,{cookie:viewer.cookie})).status,200);
  const pending=await h.call({action:'invite_member',name:'Synthetic pending',email:'pending@example.invalid',role:'billing'},{cookie:a.cookie});
  const renewed=await h.call({action:'invite_member',name:'Synthetic pending',email:'pending@example.invalid',role:'billing'},{cookie:a.cookie});
  assert.equal(renewed.status,201);assert.equal((await h.call({action:'redeem',invite:pending.data.invite})).status,401);
  h.advance(49*3600000);assert.equal((await h.call({action:'redeem',invite:renewed.data.invite})).status,401);
  const expired=await h.call({action:'invite_member',name:'Synthetic pending',email:'pending@example.invalid',role:'billing'},{url:a.staffUrl});
  assert.equal(expired.status,201);assert.equal((await h.call({action:'redeem',invite:expired.data.invite})).status,200);
  const fresh=await h.onboard('Synthetic Revoked Co'),revoked=await h.member(fresh,'manager');
  assert.equal((await h.call({action:'revoke_member',memberId:revoked.memberId},{cookie:fresh.cookie})).status,200);
  const restored=await h.call({action:'invite_member',name:'Synthetic manager',email:'manager@example.invalid',role:'manager'},{cookie:fresh.cookie});
  assert.equal(restored.status,201);assert.equal((await h.call({action:'redeem',invite:restored.data.invite})).status,200);
});

test('an active member whose seven-day sign-in has ended is renewed in one call; one still signed in keeps their session',async()=>{
  const h=setup(),a=await h.onboard(),viewer=await h.member(a,'viewer');
  const read=async id=>(await h.store.read('business_accounts',a.accountId)).members.find(m=>m.id===id);
  const invite=(address,role,options)=>h.call({action:'invite_member',name:'Synthetic '+role,email:address,role},options);
  const start=await read(viewer.memberId);assert.equal(start.sessionExpiresAt,Date.UTC(2026,8,23,18)+7*DAY);
  const session=await h.store.read('business_sessions',await digest(viewer.cookie.split('=')[1]));assert.equal(session.expiresAt,start.sessionExpiresAt);
  h.advance(6*DAY);
  for(const options of [{cookie:a.cookie},{url:a.staffUrl}]){const blocked=await invite('viewer@example.invalid','viewer',options);assert.equal(blocked.status,409);assert.match(blocked.data.error,/still signed in/);}
  assert.deepEqual(await read(viewer.memberId),start);assert.equal((await h.call(null,{cookie:viewer.cookie})).status,200);
  const billing=await h.member(a,'billing');
  h.advance(2*DAY);
  assert.equal((await h.call(null,{cookie:viewer.cookie})).status,401);assert.equal((await h.call(null,{cookie:a.cookie})).status,401);
  const adminId=(await h.store.read('business_accounts',a.accountId)).members.find(m=>m.role==='admin').id;
  const admin=await invite('admin@example.invalid','admin',{url:a.staffUrl});assert.equal(admin.status,201);assert.equal(admin.data.invite.split('.')[1],adminId);
  const adminCookie=(await h.call({action:'redeem',invite:admin.data.invite})).cookie.split(';')[0];
  const renewed=await invite('viewer@example.invalid','viewer',{cookie:adminCookie});assert.equal(renewed.status,201);
  const pending=await read(viewer.memberId);assert.equal(pending.status,'invited');assert.equal(pending.version,start.version+1);assert.equal('sessionExpiresAt' in pending,false);
  const back=(await h.call({action:'redeem',invite:renewed.data.invite})).cookie.split(';')[0];assert.equal((await h.call(null,{cookie:back})).status,200);assert.equal((await h.call(null,{cookie:viewer.cookie})).status,401);
  assert.equal((await read(viewer.memberId)).sessionExpiresAt,Date.UTC(2026,8,23,18)+15*DAY);
  const before=await read(billing.memberId);assert.equal((await invite('billing@example.invalid','billing',{cookie:adminCookie})).status,409);
  assert.deepEqual(await read(billing.memberId),before);assert.equal((await h.call(null,{cookie:billing.cookie})).status,200);
  const self=await invite('admin@example.invalid','admin',{cookie:adminCookie});assert.equal(self.status,409);assert.match(self.data.error,/already signed in/);
  const view=JSON.stringify((await h.call(null,{cookie:adminCookie})).data)+JSON.stringify((await h.call(null,{url:a.staffUrl})).data);assert.equal(view.includes('sessionExpiresAt'),false);
});

test('a member who signs out can be renewed without revoking; legacy active members stay renewable',async()=>{
  const h=setup(),a=await h.onboard(),manager=await h.member(a,'manager');
  const read=async id=>(await h.store.read('business_accounts',a.accountId)).members.find(m=>m.id===id);
  h.advance(DAY);
  const out=await h.call({action:'logout'},{cookie:manager.cookie});assert.equal(out.status,200);assert.match(out.cookie,/Max-Age=0/);
  assert.equal((await read(manager.memberId)).sessionExpiresAt,Date.UTC(2026,8,23,18)+DAY);
  assert.ok(h.store.rows('business_audit').some(r=>r.action==='signed_out'&&r.actorId===manager.memberId));
  const audits=h.store.rows('business_audit').length;assert.equal((await h.call({action:'logout'},{cookie:manager.cookie})).status,200);assert.equal(h.store.rows('business_audit').length,audits);
  const renewed=await h.call({action:'invite_member',name:'Synthetic manager',email:'manager@example.invalid',role:'manager'},{cookie:a.cookie});assert.equal(renewed.status,201);
  assert.equal((await h.call({action:'redeem',invite:renewed.data.invite})).status,200);
  const legacy=await h.member(a,'viewer'),saved=await h.store.read('business_accounts',a.accountId);
  delete saved.members.find(m=>m.id===legacy.memberId).sessionExpiresAt;await h.store.commit([{collection:'business_accounts',id:a.accountId,data:saved,version:saved._version}]);
  const again=await h.call({action:'invite_member',name:'Synthetic viewer',email:'viewer@example.invalid',role:'viewer'},{cookie:a.cookie});assert.equal(again.status,201);
  assert.equal((await h.call(null,{cookie:legacy.cookie})).status,401);
});

test('logout still ends the session and clears cookies when the account cannot be updated',async()=>{
  const store=new MemoryStore(),h=setup({store}),a=await h.onboard(),viewer=await h.member(a,'viewer'),read=store.read.bind(store);
  store.read=async(c,id)=>{if(c==='business_accounts')throw Object.assign(new Error('synthetic outage'),{status:503});return read(c,id);};
  const out=await h.call({action:'logout'},{cookie:viewer.cookie});assert.equal(out.status,200);assert.match(out.cookie,/^__Host-egc_business=; .*Max-Age=0/);
  assert.equal((await read('business_sessions',await digest(viewer.cookie.split('=')[1]))).expiresAt,0);
  store.read=read;assert.equal((await h.call(null,{cookie:viewer.cookie})).status,401);
});

test('module responses with immutable headers keep their status and are still served no-store',async()=>{
  const h=setup({handler:{
    actions:{synthetic_redirect:async(ctx,input,{save})=>{await save(ctx,'synthetic_redirect');return Response.redirect(origin+'/business-hub?done=1',303);}},
    exports:{synthetic_redirect:async()=>Response.redirect(origin+'/synthetic.csv',302)},
  }});
  const a=await h.onboard();
  const exported=await h.raw(null,{url:'?export=synthetic_redirect',cookie:a.cookie});
  assert.equal(exported.status,302);assert.equal(exported.headers.get('Location'),origin+'/synthetic.csv');assert.equal(exported.headers.get('Cache-Control'),'no-store');assert.equal(exported.headers.get('Referrer-Policy'),'no-referrer');
  const acted=await h.raw({action:'synthetic_redirect'},{cookie:a.cookie});
  assert.equal(acted.status,303);assert.equal(acted.headers.get('Location'),origin+'/business-hub?done=1');assert.equal(acted.headers.get('Cache-Control'),'no-store');assert.equal(acted.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(h.store.rows('business_audit').filter(r=>r.action==='synthetic_redirect').length,1);
});

test('the module registry merges modules once, rejects duplicate names and feeds the production handler',async()=>{
  const deps={store:new MemoryStore(),getStaff:async()=>null,finance:()=>({}),needsReview:()=>false,projectCookie:async()=>'',clearProjectCookie:()=>''};
  assert.deepEqual(Object.keys(businessHubModules).sort(),['actions','decorate','exports']);assert.ok(Object.isFrozen(businessHubModules));
  assert.equal(typeof createBusinessHandler({...deps,...businessHubModules}),'function');
  const empty=combineBusinessHubModules([]);assert.deepEqual([empty.actions,empty.exports,empty.decorate],[{},{},[]]);
  const one={actions:{synthetic_one:async()=>({status:202,data:{one:true}})},decorate:[view=>({...view,order:['one']})]};
  const two={exporters:{synthetic_two:async()=>new Response('two')},decorate:[view=>({...view,order:[...view.order,'two']})]};
  const merged=combineBusinessHubModules([one,{},two]);
  assert.deepEqual(Object.keys(merged.actions),['synthetic_one']);assert.deepEqual(Object.keys(merged.exports),['synthetic_two']);assert.equal(merged.decorate.length,2);
  assert.throws(()=>combineBusinessHubModules([one,{actions:{synthetic_one:async()=>({})}}]),/Duplicate business hub action: synthetic_one/);
  assert.throws(()=>combineBusinessHubModules([two,{exporters:{synthetic_two:async()=>new Response('')}}]),/Duplicate business hub export: synthetic_two/);
  assert.throws(()=>createBusinessHandler({...deps,...combineBusinessHubModules([{actions:{invite_member:async()=>({})}}])}),/Invalid business hub action/);
  const h=setup({handler:merged}),a=await h.onboard();
  assert.deepEqual((await h.call({action:'synthetic_one'},{cookie:a.cookie})).data,{one:true});
  assert.equal((await h.call(null,{url:'?export=synthetic_two',cookie:a.cookie})).data,'two');
  assert.deepEqual((await h.call(null,{cookie:a.cookie})).data.order,['one','two']);
});

function firestoreFake(pages){
  const calls=[];
  const doc=(collection,id,fields)=>({name:`${ROOT}/${collection}/${id}`,updateTime:'2026-09-22T12:00:00.000000Z',fields:encodeFirestoreFields(fields)});
  const fetcher=async(env,input,init={})=>{
    const url=new URL(String(input));calls.push({url,init,body:init.body?JSON.parse(init.body):null});
    assert.equal(url.hostname,'firestore.googleapis.com');
    if(url.pathname.endsWith(':runQuery'))return Response.json(pages.query.map(([id,fields])=>({document:doc('business_accounts',id,fields)})));
    if(url.pathname.endsWith('/business_accounts'))return Response.json({documents:pages.list.map(([id,fields])=>doc('business_accounts',id,fields)),nextPageToken:''});
    return new Response('{}',{status:404});
  };
  return {calls,fetcher};
}
test('staff account lists request only the listed fields and still render counts and access',async()=>{
  const owned=uid(),other=uid(),fields=company=>({company,status:'active',ownerStaff:'synthetic.sales',updatedAt:'2026-09-22T12:00:00.000Z',properties:[{id:uid(),name:'P'}],requests:[{id:uid(),status:'submitted'},{id:uid(),status:'closed'}]});
  const fake=firestoreFake({list:[[owned,fields('Synthetic Owned')],[other,{...fields('Synthetic Other'),ownerStaff:'someone.else'}]],query:[[owned,fields('Synthetic Owned')]]});
  const store=createBusinessStore({},fake.fetcher);
  const manager=await store.list({user:'zacb',businessAccess:true});
  const listCall=fake.calls[0];assert.deepEqual(listCall.url.searchParams.getAll('mask.fieldPaths'),[...LIST_FIELDS]);assert.equal(listCall.url.searchParams.get('pageSize'),'50');
  assert.equal(manager.accounts.length,2);
  await store.list({user:'synthetic.sales',businessAccess:false});
  assert.deepEqual(fake.calls[1].body.structuredQuery.select.fields.map(f=>f.fieldPath),[...LIST_FIELDS]);
  assert.deepEqual(fake.calls[1].body.structuredQuery.where.fieldFilter.value,{stringValue:'synthetic.sales'});
  for(const field of ['messages','members','projects','acquisition','billingEmail'])assert.equal(LIST_FIELDS.includes(field),false);
  const h=setup({store:createBusinessStore({},fake.fetcher)});
  const listed=(await h.call(null,{url:'?staff=1'})).data;
  assert.deepEqual(listed.accounts.map(a=>[a.company,a.properties,a.requests]),[['Synthetic Owned',1,1],['Synthetic Other',1,1]]);
  h.setStaff({user:'synthetic.sales',role:'sales',businessAccess:false});
  assert.deepEqual((await h.call(null,{url:'?staff=1'})).data.accounts.map(a=>a.id),[owned]);
});

test('store paths reject ids outside each collection pattern before any Firestore request',async()=>{
  const fake=firestoreFake({list:[],query:[]}),store=createBusinessStore({},fake.fetcher),hex32='a'.repeat(32),hex64='b'.repeat(64);
  const valid=[['business_accounts',hex32],['business_sessions',hex64],['business_audit',hex32],['business_operations',hex32],['business_operations',hex64],['jobs','job_Synthetic-1'],['customers','customer_'+'c'.repeat(40)],['customers','ghl_Synthetic123'],['projects','project_job_Synthetic-1'],['customerIdentityState','revision']];
  for(const [collection,id] of valid)assert.equal(await store.read(collection,id),null,collection+'/'+id);
  assert.equal(fake.calls.length,valid.length);
  const invalid=[['business_accounts',hex64],['business_accounts','A'.repeat(32)],['business_sessions',hex32],['business_audit',hex64],['business_operations','c'.repeat(31)],['business_operations','g'.repeat(32)],
    ['jobs','_egc_schedule_lock_2026-09-22'],['jobs','secure_employee'],['jobs','x'.repeat(121)],['jobs','job/../../business_sessions'],['customers','secure_customer'],['customers','x'.repeat(181)],['customers','bad id'],['projects','_egc_project'],
    ['customerIdentityState','other'],['employee_accounts',hex32],['__proto__',hex32],['constructor',hex32],['jobs',42],['jobs','']];
  for(const [collection,id] of invalid){await assert.rejects(()=>store.read(collection,id),e=>e.status===400,String(collection)+'/'+id);await assert.rejects(()=>store.commit([{collection,id,data:{}}]),e=>e.status===400);}
  await assert.rejects(()=>store.jobs(['synthetic_ok','secure_hidden']),e=>e.status===400);
  assert.equal(fake.calls.length,valid.length);
});

test('business-hub.html loads extension modules deferred, same-origin and with the core cache-bust',()=>{
  const html=readFileSync(new URL('../business-hub.html',import.meta.url),'utf8');
  const scripts=[...html.matchAll(/<script\b([^>]*)><\/script>/g)].map(m=>m[1]);
  assert.ok(scripts.length>=1);assert.equal(/<script\b(?![^>]*\bsrc=)/.test(html),false);
  const src=attrs=>/\bsrc="([^"]+)"/.exec(attrs)?.[1]||'';
  const [core,...modules]=scripts;assert.match(src(core),/^\/business-hub\.js\?v=[0-9]{8}[a-z0-9]*$/);
  const version=src(core).split('?v=')[1];assert.match(html,new RegExp(`/business-hub\\.css\\?v=${version}"`));
  for(const attrs of scripts){assert.match(attrs,/\bdefer\b/);assert.doesNotMatch(attrs,/\b(async|type="module")\b/);}
  for(const attrs of modules)assert.match(src(attrs),new RegExp(`^/business-hub-[a-z0-9-]+\\.js\\?v=${version}$`));
  assert.match(html,/viewport-fit=cover/);
});
