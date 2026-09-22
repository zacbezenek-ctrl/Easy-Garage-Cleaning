import test from 'node:test';
import assert from 'node:assert/strict';
import {createHubSessionCookie,createHubActionState} from '../functions/_lib/hub-session.js';
import * as highlevel from '../functions/api/highlevel.js';
import * as clients from '../functions/api/jobber-clients.js';
import * as requests from '../functions/api/jobber-requests.js';
import * as hook from '../functions/api/crew-hook.js';
import * as driveAuth from '../functions/api/drive-auth.js';
import * as jobberAuth from '../functions/api/jobber-auth.js';

const origin='https://easygaragecleaning.com';
const env={HUB_SESSION_SECRET:'synthetic-integration-access',HUB_AUTH_USERS_JSON:JSON.stringify({
 ZacB:{passwordHash:'synthetic',displayName:'Manager',role:'owner'},
 'Crew.One':{passwordHash:'synthetic',displayName:'Crew One',role:'crew'}
})};
const cookie=async user=>(await createHubSessionCookie(env,user)).split(';')[0];
const request=async(path,user,body)=>new Request(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,...(user?{Cookie:await cookie(user)}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});

test('crew cannot enumerate CRM contacts, opportunities, appointments or Jobber requests',async t=>{
 let called=0;t.mock.method(globalThis,'fetch',async()=>{called++;throw new Error('No upstream request permitted');});
 for(const [api,path] of [[highlevel,'/api/highlevel?view=command'],[highlevel,'/api/highlevel?view=contacts&q=smith'],[highlevel,'/api/highlevel?view=schedule'],[highlevel,'/api/highlevel?view=walkthroughs'],[clients,'/api/jobber-clients?q=smith'],[requests,'/api/jobber-requests']]){
  assert.equal((await api.onRequestGet({request:await request(path,'Crew.One'),env})).status,403,path);
  assert.equal((await api.onRequestGet({request:await request(path,null),env})).status,401,path);
  assert.equal((await api.onRequestGet({request:await request(path,'ZacB'),env})).status,501,'Managers reach integration configuration checks');
 }
 assert.equal(called,0);
});

test('legacy CRM and webhook triggers cannot bypass assigned field completion gates or choose arbitrary contacts',async t=>{
 let called=0;t.mock.method(globalThis,'fetch',async()=>{called++;throw new Error('No upstream request permitted');});
 for(const body of [{tool:'post_job',client:{phone:'9705550199'}},{tool:'post_job',job_id:'assigned-job',highlevel_contact_id:'other-contact'}, {tool:'lifecycle',event:'job-complete',job_id:'assigned-job'},{tool:'schedule',job_id:'assigned-job'}]){
  assert.equal((await highlevel.onRequestPost({request:await request('/api/highlevel','Crew.One',body),env})).status,403);
 }
 for(const tool of ['post_job','review_request']){
  const body={tool,job_id:'assigned-job',phone:'9705550199',message:'Synthetic message'};
  assert.equal((await hook.onRequestPost({request:await request('/api/crew-hook','Crew.One',body),env:{...env,CREW_WEBHOOK_URL:'https://provider.example.invalid'}})).status,403);
 }
 assert.equal(called,0);
});

for(const [api,path,prefix,purpose] of [[driveAuth,'drive-auth','GOOGLE','drive-oauth'],[jobberAuth,'jobber-auth','JOBBER','jobber-oauth']]){
 test(`${path} setup is management-only and callback rejects crew-issued state`,async t=>{
  let called=0;t.mock.method(globalThis,'fetch',async()=>{called++;throw new Error('No upstream request permitted');});
  const configured={...env,[prefix+'_CLIENT_ID']:'synthetic-client',[prefix+'_CLIENT_SECRET']:'synthetic-secret'};
  assert.equal((await api.onRequestGet({request:await request('/api/'+path,'Crew.One'),env:configured})).status,403);
  assert.equal((await api.onRequestGet({request:await request('/api/'+path,null),env:configured})).status,401);
  const start=await api.onRequestGet({request:await request('/api/'+path,'ZacB'),env:configured});
  assert.equal(start.status,302);assert.ok(new URL(start.headers.get('Location')).searchParams.get('state'));
  const state=await createHubActionState(configured,purpose,'Crew.One');
  assert.equal((await api.onRequestGet({request:new Request(origin+'/api/'+path+'?code=test&state='+encodeURIComponent(state)),env:configured})).status,403);
  assert.equal(called,0);
 });
 test(`${path} callback does not echo provider credentials in an exchange error`,async t=>{
  const configured={...env,[prefix+'_CLIENT_ID']:'synthetic-client',[prefix+'_CLIENT_SECRET']:'synthetic-secret'},state=await createHubActionState(configured,purpose,'ZacB');
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({access_token:'PRIVATE-PROVIDER-CANARY',error:'PRIVATE-PROVIDER-CANARY'}),{status:400,headers:{'Content-Type':'application/json'}}));
  const response=await api.onRequestGet({request:new Request(origin+'/api/'+path+'?code=test&state='+encodeURIComponent(state)),env:configured});
  assert.ok(!(await response.text()).includes('PRIVATE-PROVIDER-CANARY'));
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
 });
}
