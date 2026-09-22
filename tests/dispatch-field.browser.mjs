// Actual browser -> HTTP handlers -> Firestore emulator acceptance.
// Only Drive storage is synthetic; no customer or provider network access.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hashHubCredential} from '../functions/_lib/hub-session.js';
import {storage as driveFixture} from './helpers/field-fixture.mjs';
import * as auth from '../functions/api/hub-auth.js';
import * as dispatch from '../functions/api/dispatch.js';
import * as openings from '../functions/api/dispatch-openings.js';
import * as field from '../functions/api/field-jobs.js';
import * as availability from '../functions/api/crew-availability.js';

const emulator=process.env.FIRESTORE_EMULATOR_HOST;
assert.match(emulator||'',/^(127\.0\.0\.1|localhost):\d{2,5}$/,'A loopback emulator is required.');
const projectId='demo-egc-dispatch-day',root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(resolve(process.env.EGC_FIREBASE_TEST_MODULES||root,'package.json'));
const {initializeTestEnvironment}=require('@firebase/rules-unit-testing');
const [host,port]=emulator.split(':');
const environment=await initializeTestEnvironment({projectId,firestore:{host,port:Number(port),rules:await readFile(resolve(root,'firestore.rules'),'utf8')}});
await environment.clearFirestore();
const day=field.fieldToday(),tomorrow=new Date(Date.parse(day+'T12:00Z')+86400000).toISOString().slice(0,10);
await environment.withSecurityRulesDisabled(async context=>{
 const db=context.firestore();
 await db.doc('customers/day-customer').set({name:'Synthetic Day Customer',phone:'9705550100',address:'123 Synthetic Way, Fort Collins, CO'});
 await db.doc('dispatchResources/day-crew').set({recordType:'crew',name:'Day Crew',status:'active',memberIds:['crew.one','lead.one'],leadId:'lead.one'});
 await db.doc('dispatchResources/day-truck').set({recordType:'vehicle',name:'Day Truck',status:'available',notes:'Check straps'});
});
const password='Synthetic emulator browser only!';
const users=Object.fromEntries(await Promise.all([['ZacB','Manager','owner'],['Crew.One','Crew One','crew'],['Lead.One','Lead One','crew_lead'],['Other.Crew','Other Crew','crew']].map(async([user,displayName,role])=>[user,{passwordHash:await hashHubCredential(user,password),displayName,role}])));
const env={HUB_SESSION_SECRET:'synthetic-dispatch-field-browser',FIREBASE_API_KEY:'firebase-test-dispatch-browser',HUB_AUTH_USERS_JSON:JSON.stringify(users),GOOGLE_CLIENT_ID:'synthetic',GOOGLE_CLIENT_SECRET:'synthetic',GOOGLE_REFRESH_TOKEN:'synthetic'};
const originalFetch=globalThis.fetch;
driveFixture({mock:{method(object,key,implementation){object[key]=implementation;}}});
const syntheticDriveFetch=globalThis.fetch;
globalThis.fetch=async(input,options={})=>{
 const url=new URL(input);
 if(url.hostname==='firestore.googleapis.com'){
  const target=`http://${emulator}${url.pathname.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')}${url.search}`;
  return originalFetch(target,{...options,...(options.body?{body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...options.headers,Authorization:'Bearer owner'}});
 }
 if(['www.googleapis.com','oauth2.googleapis.com'].includes(url.hostname))return syntheticDriveFetch(input,options);
 if(['localhost','127.0.0.1'].includes(url.hostname))return originalFetch(input,options);
 throw new Error('External network refused by isolated acceptance test: '+url.hostname);
};
const routes={'/api/hub-auth':auth,'/api/dispatch':dispatch,'/api/dispatch-openings':openings,'/api/field-jobs':field,'/api/crew-availability':availability};
const background=[],serverErrors=[],apiErrors=[];
const server=createServer(async(incoming,outgoing)=>{
 try{
  const url=new URL(incoming.url,base);
  if(url.pathname.startsWith('/api/')){
   const chunks=[];for await(const part of incoming)chunks.push(part);const bytes=Buffer.concat(chunks);
   const request=new Request(url,{method:incoming.method,headers:incoming.headers,...(bytes.length?{body:bytes}:{})});
   const route=routes[url.pathname],handler=route?.['onRequest'+incoming.method[0]+incoming.method.slice(1).toLowerCase()];
   if(!handler){outgoing.writeHead(404);outgoing.end();return;}
   const response=await handler({request,env,waitUntil:promise=>background.push(promise)}),body=Buffer.from(await response.arrayBuffer());
   if(response.status>=400)apiErrors.push({path:url.pathname,status:response.status,body:body.toString().slice(0,1500)});
   outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(body);return;
  }
  const filename=resolve(root,'.'+url.pathname);
  if(!filename.startsWith(root.endsWith(sep)?root:root+sep)){outgoing.writeHead(404);outgoing.end();return;}
  const body=await readFile(filename);outgoing.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'application/javascript','.css':'text/css'})[extname(filename)]||'application/octet-stream'});outgoing.end(body);
 }catch(error){serverErrors.push(error.stack);outgoing.writeHead(500);outgoing.end('Synthetic test server failure');}
});
let base='';await new Promise(resolve=>server.listen(0,'localhost',resolve));base='http://localhost:'+server.address().port;
const {chromium}=await import(pathToFileURL(process.env.FIELD_PLAYWRIGHT_MODULE).href);
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
const manager=await browser.newContext({viewport:{width:1360,height:950},timezoneId:'Asia/Tokyo'});
const crew=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,timezoneId:'America/Los_Angeles'});
const managerPage=await manager.newPage(),crewPage=await crew.newPage(),pageErrors=[];
for(const page of[managerPage,crewPage]){page.setDefaultTimeout(12000);page.on('pageerror',error=>pageErrors.push(error.message));page.on('dialog',dialog=>dialog.accept());}
const login=async(page,user)=>{
 await page.goto(base+'/crew/job.html');await page.getByLabel('Username',{exact:true}).fill(user);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByText('Signed in as ',{exact:false}).waitFor();
};
const settle=async()=>{await crewPage.waitForFunction(()=>!document.querySelector('.pending-action'));await crewPage.waitForTimeout(80);};
const readJob=async id=>{let data;await environment.withSecurityRulesDisabled(async context=>{data=(await context.firestore().doc('jobs/'+id).get()).data();});return data;};
const createJob=async(service,start,end)=>{
 await managerPage.getByRole('button',{name:'Create job',exact:true}).first().click();
 await managerPage.locator('input[name=customerSearch]').fill('Synthetic');
 await managerPage.getByRole('button',{name:'Synthetic Day Customer · 9705550100',exact:true}).click();
 await managerPage.getByLabel('Service',{exact:true}).fill(service);await managerPage.getByLabel('Start time',{exact:true}).fill(start);await managerPage.getByLabel('End time',{exact:true}).fill(end);
 await managerPage.getByRole('combobox',{name:'Saved crew',exact:true}).selectOption('day-crew');await managerPage.getByRole('combobox',{name:'Vehicle / truck',exact:true}).selectOption('day-truck');
 await managerPage.getByLabel('Required crew size',{exact:true}).fill('2');await managerPage.getByLabel('Scope of work',{exact:true}).fill('Install shelving and preserve the heirloom cabinet.');
 await managerPage.getByLabel('Required equipment — one per line',{exact:true}).fill('Dolly\nBroom');await managerPage.getByLabel('Materials — one per line',{exact:true}).fill('Wall rack');
 await managerPage.getByRole('dialog').getByRole('button',{name:'Create job',exact:true}).click();
};
try{
 await login(managerPage,'ZacB');await managerPage.goto(base+'/dispatch.html');await managerPage.getByRole('heading',{name:'Dispatch',exact:true}).waitFor();
 await managerPage.waitForFunction(()=>document.querySelector('.dp-header-actions .primary')?.disabled===false);
 await createJob('Morning garage service','08:00','10:00');await managerPage.getByRole('dialog').waitFor({state:'detached'});
 const firstCard=managerPage.locator('.dp-job').filter({hasText:'Morning garage service'});await firstCard.waitFor();
 const id=new URL(await firstCard.getByRole('link',{name:'Open job',exact:true}).getAttribute('href'),base).searchParams.get('jobId');
 assert.equal((await readJob(id)).operationalScope.text,'Install shelving and preserve the heirloom cabinet.');
 await createJob('Second garage service','09:00','11:00');await managerPage.getByRole('alert').filter({hasText:'conflict'}).waitFor();
 await managerPage.getByLabel('Start time',{exact:true}).fill('12:00');await managerPage.getByLabel('End time',{exact:true}).fill('14:00');
 await managerPage.getByRole('dialog').getByRole('button',{name:'Create job',exact:true}).click();await managerPage.getByRole('dialog').waitFor({state:'detached'});
 const nextCard=managerPage.locator('.dp-job').filter({hasText:'Second garage service'});
 const nextId=new URL(await nextCard.getByRole('link',{name:'Open job',exact:true}).getAttribute('href'),base).searchParams.get('jobId');
 await managerPage.getByRole('button',{name:'Find opening',exact:true}).click();
 await managerPage.getByLabel('Search from',{exact:true}).fill(tomorrow);await managerPage.getByLabel('Search through',{exact:true}).fill(tomorrow);
 await managerPage.getByRole('combobox',{name:'Saved crew to check',exact:true}).selectOption('day-crew');await managerPage.getByRole('combobox',{name:'Vehicle to check',exact:true}).selectOption('day-truck');
 await managerPage.getByRole('button',{name:'Check openings',exact:true}).click();await managerPage.getByRole('button',{name:'Use this opening',exact:true}).first().click();
 assert.equal(await managerPage.getByLabel('Start date',{exact:true}).inputValue(),tomorrow);assert.equal(await managerPage.getByLabel('Start time',{exact:true}).inputValue(),'08:00');assert.equal(await managerPage.getByRole('combobox',{name:'Crew lead',exact:true}).inputValue(),'lead.one');
 await managerPage.getByRole('button',{name:'Back',exact:true}).click();await managerPage.getByRole('dialog').waitFor({state:'detached'});
 await login(crewPage,'Crew.One');assert.equal(await crewPage.locator('.day-job').count(),2);
 await crewPage.goto(base+'/crew/job.html?jobId='+id);await crewPage.getByRole('heading',{name:'Synthetic Day Customer',exact:true}).waitFor();
 await crewPage.getByText('Install shelving and preserve the heirloom cabinet.',{exact:true}).waitFor();await crewPage.getByText('Day Truck',{exact:true}).waitFor();
 assert.match(await crewPage.getByRole('link',{name:'Navigate to job ↗'}).getAttribute('href'),/123%20Synthetic/);
 await crewPage.getByRole('button',{name:'Mark en route',exact:true}).click();await settle();await crewPage.getByRole('button',{name:'Mark arrived',exact:true}).click();await settle();
 await crewPage.getByRole('button',{name:'Start work',exact:true}).click();await crewPage.getByRole('alert').filter({hasText:'Complete arrival preparation'}).waitFor();
 const checks=crewPage.locator('input[data-check]');for(let index=0;index<await checks.count();index++){await checks.nth(index).check();await settle();}
 await crewPage.getByLabel('Wall rack state',{exact:true}).selectOption('loaded');await settle();
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN5sAAAAASUVORK5CYII=','base64');
 await crewPage.getByLabel('Choose photos from library').setInputFiles({name:'before.png',mimeType:'image/png',buffer:png});await crewPage.getByRole('button',{name:'Upload photo',exact:true}).click();await crewPage.getByText('1 verified',{exact:true}).waitFor();
 await crewPage.getByRole('button',{name:'Start work',exact:true}).click();await settle();
 await crewPage.getByLabel('Add a note',{exact:true}).fill('Cabinet protected; customer approved the rack placement.');await crewPage.getByRole('button',{name:'Save note',exact:true}).click();await settle();
 await crewPage.getByLabel('Photo category').selectOption('after');await crewPage.getByLabel('Choose photos from library').setInputFiles({name:'after.png',mimeType:'image/png',buffer:png});await crewPage.getByRole('button',{name:'Upload photo',exact:true}).click();await crewPage.getByText('2 verified',{exact:true}).waitFor();
 await crewPage.getByLabel('Completion notes',{exact:true}).fill('Garage cleared, rack installed, cabinet protected; customer walkthrough completed.');await crewPage.getByLabel('Does anything need follow-up?').selectOption('no');
 await crewPage.getByRole('button',{name:'Review & complete job',exact:true}).click();await settle();await crewPage.getByText('Completed by Crew One.',{exact:true}).waitFor();
 await crewPage.reload();await crewPage.getByText('Completed by Crew One.',{exact:true}).waitFor();
 const completed=await readJob(id);assert.equal(completed.status,'completed');assert.equal(completed.fieldExecution.photos.length,2);assert.equal(completed.fieldExecution.completion.actorId,'Crew.One');assert.equal(completed.payment,undefined);
 assert.equal((await readJob(nextId)).status,'scheduled');
 await managerPage.getByRole('button',{name:'Refresh',exact:true}).click();await managerPage.getByLabel('Filter by status').selectOption('completed');await managerPage.locator('.dp-job').filter({hasText:'Morning garage service'}).waitFor();
 await managerPage.getByLabel('Filter by status').selectOption('active');await nextCard.getByRole('button',{name:'Edit / assign'}).click();
 await managerPage.getByLabel('Start date',{exact:true}).fill(tomorrow);await managerPage.getByLabel('End date',{exact:true}).fill(tomorrow);
 await managerPage.getByRole('dialog').getByRole('button',{name:'Save changes',exact:true}).click();await managerPage.getByRole('dialog').waitFor({state:'detached'});
 await crewPage.goto(base+'/crew/job.html');await crewPage.getByRole('button',{name:'Tomorrow',exact:true}).click();await crewPage.locator('.day-job').filter({hasText:'Second garage service'}).waitFor();
 await managerPage.getByRole('button',{name:'Tomorrow',exact:true}).click();await nextCard.getByRole('button',{name:'Cancel',exact:true}).click();await managerPage.getByRole('dialog').getByRole('button',{name:'Cancel job',exact:true}).click();await managerPage.getByRole('dialog').waitFor({state:'detached'});
 await crewPage.getByRole('button',{name:'Refresh',exact:true}).click();await crewPage.locator('.day-job .badge').filter({hasText:'Cancelled'}).waitFor();
 assert.equal((await readJob(nextId)).status,'cancelled');
 await managerPage.getByLabel('Filter by status').selectOption('cancelled');await nextCard.getByRole('button',{name:'Restore',exact:true}).click();await managerPage.getByRole('dialog').getByRole('button',{name:'Restore job',exact:true}).click();await managerPage.getByRole('dialog').waitFor({state:'detached'});
 await crewPage.getByRole('button',{name:'Refresh',exact:true}).click();await crewPage.locator('.day-job .badge').filter({hasText:'Scheduled'}).waitFor();
 assert.equal((await readJob(nextId)).status,'scheduled');
 const denied=await crew.request.get(base+'/api/dispatch?startDate='+day+'&endDate='+tomorrow);assert.equal(denied.status(),403);
 assert.equal(await crewPage.locator('body').evaluate(body=>body.scrollWidth<=innerWidth),true);
 const out=resolve(root,'test-results');await mkdir(out,{recursive:true});await crewPage.screenshot({path:resolve(out,'actual-field-day-mobile.png'),fullPage:true});
 assert.deepEqual(pageErrors,[]);assert.deepEqual(serverErrors,[]);
 console.log('PASS: actual manager login/create/assign/vehicle/conflict/openings -> crew login/route/status/checklist/materials/photos/notes/completion -> manager visibility/reschedule/cancel/restore, persisted by Firestore emulator.');
}catch(error){console.error('Acceptance failure context:',JSON.stringify({apiErrors,pageErrors,serverErrors}));await managerPage.screenshot({path:resolve(root,'test-results/actual-day-manager-failure.png'),fullPage:true});await crewPage.screenshot({path:resolve(root,'test-results/actual-day-crew-failure.png'),fullPage:true});throw error;}
finally{await Promise.allSettled(background);await browser.close();await new Promise(resolve=>server.close(resolve));globalThis.fetch=originalFetch;await environment.cleanup();}
