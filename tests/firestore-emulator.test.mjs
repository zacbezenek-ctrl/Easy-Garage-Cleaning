import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const enabled = process.env.EGC_FIREBASE_EMULATOR_TEST === '1';

test('actual Firestore rules isolate canonical operations from crew SDK access', {skip:!enabled,timeout:90000},async t=>{
  const host = process.env.FIRESTORE_EMULATOR_HOST || '';
  assert.match(host,/^(?:127\.0\.0\.1|localhost):\d{2,5}$/,'This test may only connect to a loopback Firestore emulator.');
  const projectId='demo-egc-field-rules';
  const require = process.env.EGC_FIREBASE_TEST_MODULES ? createRequire(resolve(process.env.EGC_FIREBASE_TEST_MODULES,'package.json')) : createRequire(new URL('../package.json',import.meta.url));
  const {initializeTestEnvironment,assertFails,assertSucceeds}=require('@firebase/rules-unit-testing');
  require('firebase/firestore').setLogLevel('silent');
  const [hostname,port]=host.split(':');
  const rules=await readFile(new URL('../firestore.rules',import.meta.url),'utf8');
  const environment=await initializeTestEnvironment({projectId,firestore:{host:hostname,port:Number(port),rules}});
  const claims=(username,role='crew',business=false)=>({username,role,business_access:business,assignment_version:1,assignment_identities:[username],assignment_keys:[username.toLowerCase()]});
  const crew=environment.authenticatedContext('crew-one',claims('crew1')).firestore();
  const otherCrew=environment.authenticatedContext('crew-two',claims('crew2')).firestore();
  const lead=environment.authenticatedContext('lead-one',claims('lead1','crew_lead')).firestore();
  const manager=environment.authenticatedContext('manager',claims('zacb','owner',true)).firestore();
  const publicDb=environment.unauthenticatedContext().firestore();
  try {
    await environment.withSecurityRulesDisabled(async context=>{
      const db=context.firestore();
      const entries={
        'jobs/assigned':{id:'assigned',type:'job',customerId:'customer',assignedCrew:['crew1'],status:'scheduled',pipelineStatus:'scheduled',payment:{amount:500},opsNotes:'Private manager note'},
        'jobs/open':{id:'open',type:'job',assignedCrew:[],openShift:true,shiftPickupEnabled:true,crewNeeded:2,status:'scheduled'},
        'jobs/crew1-off':{id:'crew1-off',type:'availability',recordType:'crew_availability',employee:'crew1',date:'2099-09-08',time:'',endTime:'',allDay:true,reason:'Personal',status:'active',createdAt:'now',updatedAt:'now'},
        'jobs/crew2-off':{id:'crew2-off',type:'availability',recordType:'crew_availability',employee:'crew2',date:'2099-09-08',allDay:true,status:'active'},
        'jobs/_egc_schedule_lock_2099-09-08':{recordType:'schedule_lock',date:'2099-09-08',entries:[]},
        'jobs/secure_account_test':{recordType:'employee_account_v1',sealedPayload:'ciphertext'},
        'customers/customer':{name:'Private Customer',phone:'9705550100'},
        'customers/customer-two':{name:'Second Customer',phone:'9705550101',address:'2 Test Street'},
        'dispatchResources/truck':{recordType:'vehicle',name:'Test truck',status:'available'},
        'dispatchState/revision':{lastRequestId:'server'},
        'dispatchOperations/receipt':{actorId:'zacb',action:'schedule.update'},
      };
      for (const [path,value] of Object.entries(entries)) await db.doc(path).set(value);
    });
    await t.test('unsigned requests cannot read or mutate any operational record',async()=>{
      for(const path of ['jobs/assigned','jobs/open','customers/customer','dispatchResources/truck']){await assertFails(publicDb.doc(path).get());await assertFails(publicDb.doc(path).set({status:'completed'}));}
    });
    await t.test('assigned crew and leads cannot read financial/private canonical job documents directly',async()=>{
      for(const db of [crew,otherCrew,lead]) for(const path of ['jobs/assigned','jobs/open','jobs/secure_account_test','jobs/_egc_schedule_lock_2099-09-08','customers/customer']) await assertFails(db.doc(path).get());
      await assertFails(crew.collection('jobs').get());
    });
    await t.test('crew cannot bypass status, assignment, completion or financial API validation with SDK writes',async()=>{
      for(const patch of [{status:'completed',pipelineStatus:'completed'},{assignedCrew:['crew2']},{date:'2099-09-09'},{fieldExecution:{checks:{done:true}}},{payment:{verified:true,amount:500}}]) await assertFails(crew.doc('jobs/assigned').update(patch));
      await assertFails(crew.doc('jobs/open').update({assignedCrew:['crew1']}));
      await assertFails(crew.doc('customers/customer').update({name:'Changed'}));
      await assertFails(crew.doc('jobs/assigned').delete());
    });
    await t.test('dispatch resources, receipts, and revision locks remain server-only even for business SDK sessions',async()=>{
      for(const db of [crew,manager]) for(const path of ['dispatchResources/truck','dispatchState/revision','dispatchOperations/receipt']){await assertFails(db.doc(path).get());await assertFails(db.doc(path).update({status:'changed'}));await assertFails(db.doc(path).delete());}
    });
    await t.test('manager administrative schedule and customer access remains functional',async()=>{
      await assertSucceeds(manager.doc('jobs/assigned').get());
      await assertSucceeds(manager.doc('customers/customer').get());
      await assertSucceeds(manager.doc('jobs/assigned').update({title:'Reviewed by manager'}));
    });
    await t.test('legacy availability reads stay private while all crew writes require the atomic server API',async()=>{
      await assertSucceeds(crew.doc('jobs/crew1-off').get());
      await assertFails(crew.doc('jobs/crew2-off').get());
      await assertFails(otherCrew.doc('jobs/crew1-off').get());
      await assertFails(crew.doc('jobs/crew1-off').update({reason:'Updated own reason',updatedAt:'later'}));
      await assertFails(crew.doc('jobs/crew1-off').delete());
      await assertFails(crew.doc('jobs/new-off').set({id:'new-off',type:'availability',recordType:'crew_availability',employee:'crew1',date:'2099-09-09',time:'',endTime:'',allDay:true,reason:'Personal',status:'active',createdAt:'now',updatedAt:'now'}));
      await assertFails(crew.doc('jobs/crew1-off').update({employee:'crew2'}));
      await assertFails(crew.doc('jobs/crew1-off').update({type:'job',assignedCrew:['crew1']}));
      await assertFails(crew.doc('jobs/crew1-off').update({payment:{amount:500}}));
    });
    await t.test('actual Firestore REST commits protect dispatch, self-assignment and availability workflows',async()=>{
      const {dispatchStorage}=await import('../functions/_lib/dispatch-storage.js');
      const {mutateDispatch,mutateDispatchSelfAssignment}=await import('../functions/_lib/dispatch-service.js');
      const {crewAvailabilityHandlers}=await import('../functions/api/crew-availability.js');
      const serverEnv={HUB_AUTH_USERS_JSON:JSON.stringify({zacb:{passwordHash:'synthetic',displayName:'Owner',role:'owner'},crew1:{passwordHash:'synthetic',displayName:'Crew One',role:'crew'},crew2:{passwordHash:'synthetic',displayName:'Crew Two',role:'crew'}})};
      const actor={user:'zacb',role:'owner',businessAccess:true};
      const store=dispatchStorage(serverEnv,async(_env,url,options={})=>{
        const target=new URL(url);target.protocol='http:';target.host=host;target.pathname=target.pathname.replace('/projects/egcw-1ec83/','/projects/'+projectId+'/');
        assert.equal(target.hostname,hostname);
        return fetch(target,{...options,...(options.body ? {body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...options.headers,Authorization:'Bearer owner'}});
      });
      const create=(customerId,changes={})=>({action:'schedule.create',requestId:crypto.randomUUID(),customerId,kind:'job',changes:{date:'2099-09-10',time:'08:00',endTime:'10:00',assignedCrew:['crew1'],jobInstructions:'Synthetic emulator work only',...changes}});
      const input=create('customer');
      const copies=await Promise.all([mutateDispatch(store,actor,input),mutateDispatch(store,actor,input)]);
      assert.equal(copies[0].job.id,copies[1].job.id);
      assert.equal((await mutateDispatch(store,actor,input)).replayed,true);
      assert.equal((await store.jobs()).filter(job=>job.id===copies[0].job.id).length,1);
      assert.match(copies[0].job.revision,/^\d{4}-\d{2}-\d{2}T/);
      const job=copies[0].job;
      const changed=await mutateDispatch(store,actor,{action:'schedule.update',requestId:crypto.randomUUID(),jobId:job.id,expectedRevision:job.revision,changes:{date:'2099-09-11'}});
      assert.notEqual(changed.job.revision,job.revision);
      await assert.rejects(mutateDispatch(store,actor,{action:'schedule.update',requestId:crypto.randomUUID(),jobId:job.id,expectedRevision:job.revision,changes:{time:'12:00',endTime:'14:00'}}),error=>error.code==='dispatch_revision_conflict');
      const claims=await Promise.allSettled([mutateDispatch(store,actor,create('customer',{date:'2099-09-12',assignedCrew:['crew2']})),mutateDispatch(store,actor,create('customer-two',{date:'2099-09-12',assignedCrew:['crew2'],time:'09:00',endTime:'11:00'}))]);
      assert.equal(claims.filter(result=>result.status==='fulfilled').length,1);
      const rejected=claims.find(result=>result.status==='rejected');
      assert.ok(['dispatch_conflict','dispatch_revision_conflict'].includes(rejected.reason.code),rejected.reason.code+': '+rejected.reason.message);
      const open=await mutateDispatch(store,actor,create('customer',{date:'2099-09-13',assignedCrew:[],crewNeeded:2}));
      await store.commit([{collection:'jobs',id:open.job.id,revision:open.job.revision,patch:{openShift:true,shiftPickupEnabled:true}}]);
      const pickup={action:'claim',jobId:open.job.id,requestId:crypto.randomUUID()};
      const picked=await mutateDispatchSelfAssignment(store,{user:'crew1'},pickup);
      assert.deepEqual(picked.job.assignedCrew,['crew1']);assert.equal((await mutateDispatchSelfAssignment(store,{user:'crew1'},pickup)).replayed,true);
      const released=await mutateDispatchSelfAssignment(store,{user:'crew1'},{action:'release',jobId:open.job.id,requestId:crypto.randomUUID()});
      assert.deepEqual(released.job.assignedCrew,[]);assert.equal(released.job.openShift,true);
      const handlers=crewAvailabilityHandlers({session:async()=>({user:'crew1',role:'crew'}),storage:()=>store});
      const availabilityRequest=body=>({env:{},request:new Request('https://easygaragecleaning.com/api/crew-availability',{method:'POST',headers:{Origin:'https://easygaragecleaning.com','Content-Type':'application/json'},body:JSON.stringify(body)})});
      const unavailable=await handlers.post(availabilityRequest({action:'create',requestId:crypto.randomUUID(),changes:{date:'2099-09-14',allDay:true,reason:'Synthetic time off'}}));
      assert.equal(unavailable.status,200);const block=await unavailable.json();assert.equal(block.record.employee,'crew1');
      const {dispatchOpenings}=await import('../functions/_lib/dispatch-openings.js');
      const capacityQuery={startDate:'2099-09-14',endDate:'2099-09-15',employeeIds:'crew1',durationMinutes:'60',travelBufferMinutes:'0'};
      assert.deepEqual((await dispatchOpenings(store,actor,capacityQuery)).candidates,[]);
      await assert.rejects(mutateDispatch(store,actor,create('customer',{date:'2099-09-14'})),error=>error.code==='dispatch_conflict');
      const cancelled=await handlers.post(availabilityRequest({action:'cancel',requestId:crypto.randomUUID(),id:block.record.id,expectedRevision:block.record.revision}));
      assert.equal(cancelled.status,200);assert.equal((await cancelled.json()).record.status,'cancelled');
      assert.equal((await dispatchOpenings(store,actor,capacityQuery)).candidates[0].time,'08:00');
      assert.equal((await mutateDispatch(store,actor,create('customer',{date:'2099-09-14'}))).ok,true);
      const capacity=await dispatchOpenings(store,actor,capacityQuery);assert.equal(capacity.candidates[0].time,'10:20');assert.ok(capacity.coverage.revision);
    });
  } finally {await environment.cleanup();}
});
