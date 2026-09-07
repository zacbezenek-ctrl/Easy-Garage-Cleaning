import test from 'node:test';
import assert from 'node:assert/strict';
import * as accounts from '../functions/api/employee-accounts.js';
import * as auth from '../functions/api/hub-auth.js';
import * as hub from '../functions/api/employee-hub.js';
import { createHubCredentialHash, createHubSessionCookie } from '../functions/_lib/hub-session.js';

test('new punctuated username completes signup, owner approval, login, onboarding, and returning login', async t => {
  const saved=new Map();
  t.mock.method(globalThis,'fetch',async(input,init={})=>{
    const url=new URL(input);
    assert.equal(url.hostname,'firestore.googleapis.com','all external transport is isolated to fake storage');
    if(url.pathname.endsWith('documents:runQuery')){
      const query=JSON.parse(init.body).structuredQuery;
      const kind=query.where.fieldFilter.value.stringValue;
      return Response.json([...saved].filter(([,doc])=>doc.fields.recordType.stringValue===kind).map(([id,doc])=>({document:{name:'projects/egcw-1ec83/databases/(default)/documents/jobs/'+id,...doc}})));
    }
    const id=decodeURIComponent(url.pathname.split('/').pop());
    if(init.method==='PATCH'){
      if(url.searchParams.get('currentDocument.exists')==='false'&&saved.has(id))return Response.json({}, {status:412});
      saved.set(id,JSON.parse(init.body));
    }
    return saved.has(id)?Response.json({name:'projects/egcw-1ec83/databases/(default)/documents/jobs/'+id,...saved.get(id)}):Response.json({}, {status:404});
  });
  const env={HUB_SESSION_SECRET:'synthetic-lifecycle-session',EMPLOYEE_HUB_DATA_SECRET:'synthetic-lifecycle-vault',FIREBASE_API_KEY:'firebase-test-lifecycle',HUB_AUTH_USERS_JSON:JSON.stringify({ZacB:{passwordHash:await createHubCredentialHash('SyntheticOwner904!'),role:'owner'},AlexK:{passwordHash:'unused',role:'manager'}})};
  const origin='https://easygaragecleaning.com';
  const post=(path,body,cookie)=>new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const get=(path,cookie)=>new Request(origin+path,{headers:{Cookie:cookie}});
  const application={action:'register',acknowledged:true,username:'New.Crew_1',firstName:'New',lastName:'Crew',email:'new@example.invalid',phone:'9705550100',password:'SyntheticEmployee904!'};
  const register=await accounts.onRequestPost({env,request:post('/api/employee-accounts',application)});
  assert.equal(register.status,201);assert.equal((await register.json()).status,'pending');
  const duplicate=await accounts.onRequestPost({env,request:post('/api/employee-accounts',{...application,username:'new.crew_1'})});
  assert.equal(duplicate.status,409);assert.equal(saved.size,1);
  const loginRequest=password=>post('/api/hub-auth',{username:' NEW.CREW_1 ',password});
  const pending=await auth.onRequestPost({env,request:loginRequest(application.password)});
  assert.equal(pending.status,401);assert.equal((await pending.json()).code,'EMPLOYEE_ACCOUNT_PENDING');
  const wrong=await auth.onRequestPost({env,request:loginRequest('wrong-password')});
  assert.equal(wrong.status,401);assert.equal((await wrong.json()).error,'Incorrect username or password');
  const manager=(await createHubSessionCookie(env,'AlexK')).split(';')[0];
  const owner=(await createHubSessionCookie(env,'ZacB')).split(';')[0];
  const review={action:'review',username:application.username,decision:'approved'};
  assert.equal((await accounts.onRequestPost({env,request:post('/api/employee-accounts',review,manager)})).status,403);
  assert.equal((await accounts.onRequestPost({env,request:post('/api/employee-accounts',review,owner)})).status,200);
  const login=await auth.onRequestPost({env,request:loginRequest(application.password)});
  assert.equal(login.status,200);const profile=await login.json();
  assert.equal(profile.user,application.username);assert.equal(profile.businessAccess,false);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const write=async data=>hub.onRequestPost({env,request:post('/api/employee-hub',{collection:'profiles',id:'new.crew_1',data},cookie)});
  assert.equal((await write({username:application.username})).status,200);
  assert.equal((await write({preferredName:'New employee',phone:'9705550100',emergencyContactName:'Test contact',emergencyContactPhone:'9705550101',onboardingDraftAt:new Date().toISOString()})).status,200);
  assert.equal((await write({preferredName:'New employee',phone:'9705550100',emergencyContactName:'Test contact',emergencyContactPhone:'9705550101',onboardingCompletedAt:new Date().toISOString(),onboardingAcknowledgements:['timekeeping','location_policy','safety','customer_care','hub_basics']})).status,200);
  const records=await (await hub.onRequestGet({env,request:get('/api/employee-hub',cookie)})).json();
  assert.equal(records.collections.profiles.length,1);
  assert.equal(records.collections.profiles[0].username,application.username);
  assert.ok(records.collections.profiles[0].onboardingCompletedAt);
  assert.equal(records.collections.profiles[0].emergencyContactName,'Test contact');
  const logout=await auth.onRequestDelete({request:new Request(origin+'/api/hub-auth',{method:'DELETE',headers:{Origin:origin}})});
  assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
  const returning=await auth.onRequestPost({env,request:loginRequest(application.password)});
  assert.equal(returning.status,200);
  assert.equal(saved.size,2,'one account and one profile; no duplicate application or profile');
});
