import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';

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
  const partner=environment.authenticatedContext('partner',claims('TylerG','manager',true)).firestore();
  const publicDb=environment.unauthenticatedContext().firestore();
  const serverOwned=['jobs/secure_account_test','jobs/_egc_record_op_x','jobs/_egc_schedule_op_x','jobs/_egc_schedule_provider_x','jobs/_egc_adoption_request_x','jobs/_egc_adoption_source_x'];
  // recordTypes the service account writes into jobs (vaults and receipts); see serverOwnedJobData.
  const serverTypes=['employee_hub_v2','employee_account_v1','schedule_operation','schedule_provider_receipt','schedule_adoption','operational_record_receipt'];
  const compat=require('firebase/compat/app');const {FieldValue,Timestamp}=(compat.default||compat).firestore;
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
        'jobs/_egc_record_op_x':{recordType:'operation_receipt',actorId:'server',fingerprint:'synthetic'},
        'jobs/_egc_schedule_op_x':{recordType:'schedule_operation_receipt',actorId:'server',fingerprint:'synthetic'},
        'jobs/_egc_schedule_provider_x':{recordType:'schedule_provider_receipt',status:'submitted'},
        'jobs/_egc_adoption_request_x':{recordType:'adoption_receipt',fingerprint:'synthetic'},
        'jobs/_egc_adoption_source_x':{recordType:'adoption_source',jobId:'assigned'},
        'jobs/removable':{id:'removable',type:'job',status:'unscheduled'},
        'jobs/stray-vault':{recordType:'employee_hub_v2',employeeHubType:'profiles',sealedPayload:'ciphertext'},
        'jobs/stray-lock':{recordType:'schedule_lock',date:'2099-09-08',entries:[]},
        'audit_log/existing':{action:'login',detail:'Logged in',by:'zacb',at:'2099-09-01T12:00:00.000Z'},
        'customers/customer':{name:'Private Customer',phone:'9705550100'},
        'customers/customer-two':{name:'Second Customer',phone:'9705550101',address:'2 Test Street'},
        'dispatchResources/truck':{recordType:'vehicle',name:'Test truck',status:'available'},
        'dispatchState/revision':{lastRequestId:'server'},
        'dispatchOperations/receipt':{actorId:'zacb',action:'schedule.update'},
        'customerPortalOperations/receipt':{actorId:'zacb',accountJobId:'assigned',linkVersion:1,removedCollaboratorCount:0},
        'portal_settings/documents':{insuranceCertificate:{driveFileId:'synthetic-drive-file-0001',expiresOn:'2099-01-01',uploadedAt:'2026-09-22T12:00:00.000Z',uploadedBy:'zacb'}},
        'memberships/sub_synthetic':{plan:'guard',status:'active',customerEmail:'member@example.invalid'},
        'stripe_events/evt_synthetic':{type:'invoice.paid',subscriptionId:'sub_synthetic'},
        'membership_reviews/sub_synthetic':{status:'open',reason:'ambiguous_customer'},
        'payment_reviews/cs_test_synthetic':{status:'open',reason:'payment_exceeds_balance',jobId:'assigned',amountCents:50000},
        'moneyOperations/receipt':{actorId:'zacb',action:'payment.record_offline',jobId:'assigned',fingerprint:'synthetic'},
        'moneyInvoiceNumbers/n_INV-ASSIGN':{number:'INV-ASSIGN',jobId:'assigned'},
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
    await t.test('retired legacy quote-link records are closed to every SDK session',async()=>{
      await environment.withSecurityRulesDisabled(context=>context.firestore().doc('quotes/legacy').set({customerName:'Synthetic Customer',amount:'$600',status:'pending'}));
      for(const db of [publicDb,crew,lead,manager]){await assertFails(db.doc('quotes/legacy').get());await assertFails(db.collection('quotes').get());await assertFails(db.doc('quotes/new').set({customerName:'Synthetic Customer',status:'pending'}));await assertFails(db.doc('quotes/legacy').update({status:'signed'}));await assertFails(db.doc('quotes/legacy').delete());}
    });
    await t.test('customer portal revocation receipts remain server-only even for business SDK sessions',async()=>{
      for(const db of [publicDb,crew,manager]){const path='customerPortalOperations/receipt';await assertFails(db.doc(path).get());await assertFails(db.doc(path).set({linkVersion:0}));await assertFails(db.doc(path).delete());}
    });
    await t.test('portal document settings (insurance certificate pointer) remain server-only even for business SDK sessions',async()=>{
      for(const db of [publicDb,crew,lead,manager]){const path='portal_settings/documents';await assertFails(db.doc(path).get());await assertFails(db.collection('portal_settings').get());await assertFails(db.doc(path).set({insuranceCertificate:{driveFileId:'attacker-file-0001',expiresOn:'2099-12-31'}}));await assertFails(db.doc(path).update({'insuranceCertificate.expiresOn':'2099-12-31'}));await assertFails(db.doc(path).delete());await assertFails(db.doc('portal_settings/new').set({insuranceCertificate:null}));}
    });
    await t.test('approved-send ledgers, message templates and messaging receipts remain server-only even for business SDK sessions',async()=>{
      await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc('message_sends/send').set({kind:'payment_reminder',status:'submitted',targetId:'assigned'});await db.doc('message_templates/payment_reminder').set({kind:'payment_reminder',liveVersion:1});await db.doc('message_operations/receipt').set({actorId:'zacb',action:'template.approve'});});
      for(const db of [publicDb,crew,lead,manager]) for(const path of ['message_sends/send','message_templates/payment_reminder','message_operations/receipt']){await assertFails(db.doc(path).get());await assertFails(db.doc(path).set({status:'changed'}));await assertFails(db.doc(path).update({status:'changed'}));await assertFails(db.doc(path).delete());}
      for(const db of [crew,manager]) for(const name of ['message_sends','message_templates','message_operations']) await assertFails(db.collection(name).get());
    });
    await t.test('Garage Guard memberships, Stripe event receipts and reviews are webhook-only',async()=>{
      for(const db of [publicDb,crew,manager]) for(const path of ['memberships/sub_synthetic','stripe_events/evt_synthetic','membership_reviews/sub_synthetic','payment_reviews/cs_test_synthetic']){await assertFails(db.doc(path).get());await assertFails(db.doc(path).update({status:'changed'}));await assertFails(db.doc(path).delete());}
      await assertFails(manager.doc('memberships/sub_new').set({plan:'black',status:'active'}));
      await assertFails(manager.collection('memberships').get());
      await assertFails(manager.collection('payment_reviews').get());
      await assertFails(crew.doc('payment_reviews/cs_test_forged').set({status:'resolved',jobId:'assigned'}));
    });
    await t.test('hub bridge command receipts (audit and idempotency) remain server-only even for business SDK sessions',async()=>{
      for(const db of [publicDb,crew,manager]){const ref=db.doc('hub_command_operations/receipt');await assertFails(ref.get());await assertFails(ref.set({fingerprint:'forged',before:'null',after:'{}'}));await assertFails(ref.delete());}
    });
    await t.test('money API receipts and invoice-number reservations are server-only even for business SDK sessions',async()=>{
      for(const db of [publicDb,crew,lead,manager]) for(const path of ['moneyOperations/receipt','moneyInvoiceNumbers/n_INV-ASSIGN']){await assertFails(db.doc(path).get());await assertFails(db.doc(path).set({jobId:'open'}));await assertFails(db.doc(path).update({jobId:'open'}));await assertFails(db.doc(path).delete());}
      for(const db of [crew,manager]) for(const name of ['moneyOperations','moneyInvoiceNumbers']) await assertFails(db.collection(name).get());
      await assertFails(manager.doc('moneyInvoiceNumbers/n_INV-NEW').set({number:'INV-NEW',jobId:'assigned'}));
    });
    await t.test('manager administrative schedule and customer access remains functional',async()=>{
      await assertSucceeds(manager.doc('jobs/assigned').get());
      await assertSucceeds(manager.doc('customers/customer').get());
      await assertSucceeds(manager.doc('jobs/assigned').update({title:'Reviewed by manager'}));
    });
    await t.test('server-owned receipts and encrypted records in jobs stay immutable for business SDK sessions',async()=>{
      for(const db of [manager,partner]) for(const path of serverOwned){
        await assertFails(db.doc(path).update({status:'changed'}));
        await assertFails(db.doc(path).set({recordType:'forged'}));
        await assertFails(db.doc(path).delete());
      }
      for(const path of ['jobs/secure_new','jobs/_egc_record_op_new','jobs/_egc_schedule_op_new','jobs/_egc_schedule_provider_new','jobs/_egc_adoption_request_new','jobs/_egc_adoption_source_new','jobs/_egc_future_receipt']) await assertFails(manager.doc(path).set({recordType:'forged'}));
      await assertFails(manager.batch().update(manager.doc('jobs/assigned'),{title:'Batched'}).delete(manager.doc('jobs/_egc_record_op_x')).commit());
      await assertFails(manager.runTransaction(async tx=>{const receipt=manager.doc('jobs/_egc_schedule_op_x');await tx.get(receipt);tx.update(receipt,{status:'changed'});}));
      for(const db of [crew,lead]) for(const path of serverOwned){await assertFails(db.doc(path).update({status:'changed'}));await assertFails(db.doc(path).delete());}
      await environment.withSecurityRulesDisabled(async context=>{
        for(const path of serverOwned) assert.notEqual((await context.firestore().doc(path).get()).data().recordType,'forged',path);
        assert.notEqual((await context.firestore().doc('jobs/assigned').get()).data().title,'Batched','A denied receipt write must reject the whole batch.');
      });
    });
    await t.test('manager job, collection-wide read and schedule-lock workflows remain writable',async()=>{
      await assertSucceeds(manager.collection('jobs').get());
      for(const path of serverOwned) await assertSucceeds(manager.doc(path).get());
      await assertSucceeds(manager.doc('jobs/assigned').update({notes:'Manager note still saves'}));
      await assertSucceeds(manager.doc('jobs/manager-created').set({id:'manager-created',type:'job',status:'unscheduled'}));
      await assertSucceeds(manager.doc('jobs/removable').delete());
      await assertSucceeds(manager.doc('jobs/_egc_schedule_lock_2099-09-08').update({entries:[],updatedAt:'2099-09-01T12:00:00.000Z'}));
      await assertSucceeds(manager.doc('jobs/_egc_schedule_lock_2099-09-20').set({recordType:'schedule_lock',date:'2099-09-20',entries:[]}));
      await assertSucceeds(manager.runTransaction(async tx=>{const lock=manager.doc('jobs/_egc_schedule_lock_2099-09-20');await tx.get(lock);tx.set(lock,{recordType:'schedule_lock',date:'2099-09-20',entries:[],updatedAt:'2099-09-01T12:00:00.000Z'});tx.update(manager.doc('jobs/manager-created'),{date:'2099-09-20'});}));
      await assertSucceeds(manager.doc('jobs/_egc_schedule_lock_2099-09-20').delete());
      await assertSucceeds(manager.doc('jobs/manager-created').delete());
      await assertFails(crew.doc('jobs/_egc_schedule_lock_2099-09-08').update({entries:[]}));
    });
    await t.test('business SDK writes cannot plant, adopt or remove server-owned recordTypes under ordinary job ids',async()=>{
      for(const db of [manager,partner]) for(const recordType of serverTypes){
        await assertFails(db.doc('jobs/forged-'+recordType).set({recordType,employeeHubType:'profiles',sealedPayload:'forged'}));
        await assertFails(db.collection('jobs').add({recordType,sealedPayload:'forged'}));
        await assertFails(db.doc('jobs/assigned').update({recordType}));
        await assertFails(db.doc('jobs/assigned').set({recordType},{merge:true}));
        await assertFails(db.doc('jobs/_egc_schedule_lock_2099-09-08').update({recordType}));
      }
      await assertFails(manager.doc('jobs/fake-lock').set({recordType:'schedule_lock',date:'2099-09-08',entries:[]}));
      await assertFails(manager.doc('jobs/assigned').update({recordType:'schedule_lock'}));
      // Rows that already carry a server-owned type stay untouchable from the SDK, including relabel and delete.
      for(const path of ['jobs/stray-vault','jobs/stray-lock']){
        await assertSucceeds(manager.doc(path).get());
        await assertFails(manager.doc(path).update({sealedPayload:'changed'}));
        await assertFails(manager.doc(path).update({recordType:'crew_availability'}));
        await assertFails(manager.doc(path).set({type:'job',status:'unscheduled'}));
        await assertFails(manager.doc(path).delete());
      }
      await assertFails(manager.batch().update(manager.doc('jobs/assigned'),{title:'Batched forged vault'}).set(manager.doc('jobs/forged-batch'),{recordType:'employee_hub_v2'}).commit());
      await environment.withSecurityRulesDisabled(async context=>{
        const db=context.firestore();
        for(const recordType of serverTypes) assert.equal((await db.doc('jobs/forged-'+recordType).get()).exists,false,recordType);
        assert.equal((await db.collection('jobs').where('recordType','==','employee_hub_v2').get()).docs.map(doc=>doc.id).join(),'stray-vault');
        assert.equal((await db.doc('jobs/stray-vault').get()).data().sealedPayload,'ciphertext');
        assert.equal((await db.doc('jobs/assigned').get()).data().recordType,undefined);
        assert.notEqual((await db.doc('jobs/assigned').get()).data().title,'Batched forged vault');
      });
      // Manager PTO approval (employee-suite opsReviewRequest) still writes crew_availability rows with merge.
      const pto={id:'availability-crew1-2099-09-21-pto',type:'availability',recordType:'crew_availability',employee:'crew1',date:'2099-09-21',time:'00:00',endTime:'23:59',reason:'Approved time off',requestId:'synthetic-request',status:'active',createdAt:'2099-09-01T12:00:00.000Z',updatedAt:'2099-09-01T12:00:00.000Z'};
      await assertSucceeds(manager.doc('jobs/'+pto.id).set(pto,{merge:true}));
      await assertSucceeds(manager.doc('jobs/'+pto.id).set({...pto,updatedAt:'2099-09-02T12:00:00.000Z'},{merge:true}));
      await assertSucceeds(manager.doc('jobs/assigned').set({notes:'Merged manager note'},{merge:true}));
      await assertSucceeds(manager.doc('jobs/'+pto.id).delete());
    });
    await t.test('the audit trail is append-only and attributed to the signed-in manager',async()=>{
      const entry=(by,extra={})=>({action:'login',detail:'Logged in',by,at:'2099-09-01T12:00:00.000Z',serverAt:FieldValue.serverTimestamp(),...extra});
      for(const [db,username] of [[crew,'crew1'],[otherCrew,'crew2'],[lead,'lead1']]){
        await assertFails(db.collection('audit_log').add(entry(username)));
        await assertFails(db.collection('audit_log').add(entry('zacb')));
        await assertFails(db.doc('audit_log/existing').get());
      }
      await assertFails(publicDb.collection('audit_log').add(entry('zacb')));
      await assertFails(manager.collection('audit_log').add(entry('tylerg')));
      await assertFails(manager.collection('audit_log').add(entry('TylerG')));
      await assertFails(manager.collection('audit_log').add({action:'login',detail:'Logged in',at:'2099-09-01T12:00:00.000Z'}));
      await assertFails(manager.collection('audit_log').add(entry('zacb',{role:'owner'})));
      await assertFails(manager.collection('audit_log').add(entry('zacb',{action:{forged:true}})));
      await assertSucceeds(manager.collection('audit_log').add(entry('zacb')));
      await assertSucceeds(manager.collection('audit_log').add({action:'mark_dead',by:'zacb',at:'2099-09-01T12:05:00.000Z',serverAt:FieldValue.serverTimestamp()}));
      await assertSucceeds(partner.collection('audit_log').add(entry('TylerG',{action:'mark_quoted',detail:'Lead: Synthetic Lead · Quote: 450'})));
      // The server clock is mandatory: legacy client-only shapes and client-chosen serverAt values are refused.
      await assertFails(manager.collection('audit_log').add({action:'login',detail:'Logged in',by:'zacb',at:'2099-09-01T12:00:00.000Z'}));
      await assertFails(manager.collection('audit_log').add(entry('zacb',{serverAt:Timestamp.fromDate(new Date('2099-09-01T12:00:00.000Z'))})));
      await assertFails(manager.collection('audit_log').add(entry('zacb',{serverAt:'2099-09-01T12:00:00.000Z'})));
      await assertFails(manager.collection('audit_log').add(entry('zacb',{serverAt:null})));
      // 'at' must be present and ISO-8601 UTC shaped.
      const {at,...withoutAt}=entry('zacb');assert.ok(at);
      await assertFails(manager.collection('audit_log').add(withoutAt));
      for(const bad of ['yesterday','2099-09-01','2099-09-01 12:00:00Z','2099-09-01T12:00:00+00:00','2099-09-01T12:00:00.000Z<b>','','x2099-09-01T12:00:00.000Z',4102488000000,null]) await assertFails(manager.collection('audit_log').add(entry('zacb',{at:bad})));
      await assertSucceeds(manager.collection('audit_log').add(entry('zacb',{at:'2099-09-01T12:00:00Z'})));
      // action and detail are bounded strings: 200 / 2000 UTF-16 code units, which is what Rules string.size()
      // counts (a 2-unit emoji counts twice). employee.html addAuditLog clips to the same bounds.
      await assertSucceeds(manager.collection('audit_log').add(entry('zacb',{action:'a'.repeat(200),detail:'d'.repeat(2000)})));
      await assertSucceeds(manager.collection('audit_log').add(entry('zacb',{action:'\u{1F697}'.repeat(100),detail:'\u{1F697}'.repeat(1000)})));
      for(const extra of [{action:''},{action:'a'.repeat(201)},{action:'\u{1F697}'.repeat(101)},{detail:'d'.repeat(2001)},{detail:'\u{1F697}'.repeat(1001)},{detail:42},{detail:null},{action:null}]) await assertFails(manager.collection('audit_log').add(entry('zacb',extra)));
      // The real employee.html writer (clipping + serverTimestamp) satisfies these rules, even for oversized input.
      const html=await readFile(new URL('../employee.html',import.meta.url),'utf8');
      const slice=(start,end)=>{const from=html.indexOf(start),to=html.indexOf(end,from);assert.ok(from>=0&&to>from,start);return html.slice(from,to);};
      const hubWrites=[];
      const hub=vm.createContext({me:'ZacB',console:{warn(){}},firebase:compat.default||compat,Date:class{toISOString(){return '2099-09-01T12:10:00.000Z';}},
        sessionStorage:{getItem:key=>key==='egc_business_access'?'true':null},
        db:{collection:name=>({add:data=>{const write=environment.authenticatedContext('manager-cased',claims('ZacB','owner',true)).firestore().collection(name).add({...data});hubWrites.push(write);return write;}})}});
      vm.runInContext(slice('function canRunBusiness()','async function ensureFirebaseSession(')+slice('function addAuditLog(','function renderAuditLog(')+"\naddAuditLog('hub_writer_'+'a'.repeat(300),'Lead: x'+'\\u{1F697}'.repeat(1500));addAuditLog('login');",hub);
      assert.equal(hubWrites.length,2);
      for(const write of hubWrites) await assertSucceeds(write);
      await environment.withSecurityRulesDisabled(async context=>{
        const saved=(await context.firestore().collection('audit_log').where('by','==','ZacB').get()).docs.map(doc=>doc.data()).sort((a,b)=>a.action.length-b.action.length);
        assert.deepEqual(saved.map(row=>[row.action.length,row.detail.length,row.at,typeof row.serverAt?.toMillis]),[[5,0,'2099-09-01T12:10:00.000Z','function'],[200,1999,'2099-09-01T12:10:00.000Z','function']]);
      });
      await environment.withSecurityRulesDisabled(async context=>{
        const saved=(await context.firestore().collection('audit_log').where('action','==','mark_quoted').get()).docs.map(doc=>doc.data());
        assert.equal(saved.length,1);assert.equal(saved[0].by,'TylerG');
        assert.equal(typeof saved[0].serverAt?.toMillis,'function','serverAt is stored as the server Timestamp.');
      });
      await assertSucceeds(manager.doc('audit_log/existing').get());
      await assertSucceeds(manager.collection('audit_log').orderBy('at','desc').limit(50).get());
      await assertSucceeds(manager.collection('audit_log').orderBy('serverAt','desc').limit(50).get());
      for(const db of [manager,partner]){
        await assertFails(db.doc('audit_log/existing').update({detail:'Rewritten'}));
        await assertFails(db.doc('audit_log/existing').set(entry('zacb',{detail:'Replaced'})));
        await assertFails(db.doc('audit_log/existing').delete());
      }
    });
    await t.test('a crew session that tampers with its client business flag is still refused by the rules',async()=>{
      // P1-02: the Hub trusts sessionStorage egc_business_access from the server profile and keeps no staff list,
      // so the browser gate is only UX. The enforcement is the Hub-minted token: business_access comes from
      // hasBusinessAccess(session) and username from session.user (functions/api/firebase-session.js).
      const html=await readFile(new URL('../employee.html',import.meta.url),'utf8');
      assert.doesNotMatch(html,/const ADMINS|BUSINESS_USERS/);
      const slice=(start,end)=>{const from=html.indexOf(start),to=html.indexOf(end,from);assert.ok(from>=0&&to>from,start);return html.slice(from,to);};
      const source=slice('function canRunBusiness()','async function ensureFirebaseSession(')+slice('function addAuditLog(','function renderAuditLog(');
      let sequence=0;
      // Runs the real addAuditLog with a client that claims business access, against a context holding tokenClaims.
      const attempt=(me,tokenClaims)=>{
        const writes=[];
        const db=environment.authenticatedContext('tamper-'+(++sequence),tokenClaims).firestore();
        vm.runInContext(source+"\naddAuditLog('tamper_probe','Lead: Synthetic Lead');",vm.createContext({me,console:{warn(){}},firebase:compat.default||compat,
          Date:class{toISOString(){return '2099-09-01T12:20:00.000Z';}},sessionStorage:{getItem:key=>key==='egc_business_access'?'true':null},
          db:{collection:name=>({add:data=>{const write=db.collection(name).add({...data});writes.push(write);return write;}})}}));
        assert.equal(writes.length,1,'The client-side gate passes once the flag is forged, so only the rules stand in the way.');
        return writes[0];
      };
      const {business_access:_omit,...noBusinessClaim}=claims('zacb','owner',true);
      // Crew tokens (business_access false) are refused whatever the tampered client claims to be.
      await assertFails(attempt('crew1',claims('crew1')));
      await assertFails(attempt('zacb',claims('crew1')));
      await assertFails(attempt('lead1',claims('lead1','crew_lead')));
      // A privileged role or username in the token does not stand in for the server-minted business_access claim.
      await assertFails(attempt('zacb',claims('zacb','owner',false)));
      await assertFails(attempt('zacb',noBusinessClaim));
      await assertFails(attempt('zacb',{...claims('zacb','owner',false),business_access:'true'}));
      // A business token still cannot write under another name: 'by' must equal the token username exactly.
      await assertFails(attempt('TylerG',claims('zacb','owner',true)));
      await assertFails(attempt('ZacB',claims('zacb','owner',true)));
      await assertSucceeds(attempt('zacb',claims('zacb','owner',true)));
      await environment.withSecurityRulesDisabled(async context=>{
        const saved=(await context.firestore().collection('audit_log').where('action','==','tamper_probe').get()).docs.map(doc=>doc.data());
        assert.deepEqual(saved.map(row=>row.by),['zacb']);
      });
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
      const accountBefore=await store.read('jobs','assigned');
      const copies=await Promise.all([mutateDispatch(store,actor,input),mutateDispatch(store,actor,input)]);
      assert.equal(copies[0].job.id,copies[1].job.id);
      assert.equal((await mutateDispatch(store,actor,input)).replayed,true);
      assert.equal((await store.jobs()).filter(job=>job.id===copies[0].job.id).length,1);
      assert.equal((await store.read('jobs',copies[0].job.id)).customerAccountOwnerJobId,'assigned');
      assert.equal((await store.read('jobs','assigned')).revision,accountBefore.revision,'Read verification must not mutate the account root.');
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
      await store.commit([{collection:'jobs',id:'assigned',revision:accountBefore.revision,patch:{lineageTestChange:true}}]);
      await assert.rejects(store.commit([{collection:'jobs',id:'assigned',revision:accountBefore.revision,verify:true},{collection:'jobs',id:'must-not-save',patch:{type:'job',customerId:'customer'}}]),error=>error.code==='dispatch_revision_conflict');
      assert.equal(await store.read('jobs','must-not-save'),null,'A stale ownership read cannot write another job.');
    });
    await t.test('actual Firestore REST stores the insurance certificate pointer with revision checks',async()=>{
      const {portalDocumentsStorage,uploadInsuranceCertificate,insuranceCertificateStatus}=await import('../functions/_lib/customer-documents.js');
      const store=portalDocumentsStorage({},async(_env,url,options={})=>{
        const target=new URL(url);target.protocol='http:';target.host=host;target.pathname=target.pathname.replace('/projects/egcw-1ec83/','/projects/'+projectId+'/');
        assert.equal(target.hostname,hostname);
        return fetch(target,{...options,...(options.body ? {body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...options.headers,Authorization:'Bearer owner'}});
      });
      const files=new Map(),pdf=new TextEncoder().encode('%PDF-1.4\n% Synthetic emulator certificate fixture only\ntrailer << >>\n%%EOF\n');
      const drive={allocate:async()=>'synthetic-drive-file-0002',metadata:async id=>files.get(id)||null,upload:async(id,meta,bytes)=>{files.set(id,{mimeType:'application/pdf',size:String(bytes.length),appProperties:{egcPortalDocument:'insurance_certificate',egcRequestId:meta.requestId}});}};
      const before=await store.read(),now='2026-09-22T18:00:00.000Z';
      assert.equal(insuranceCertificateStatus(before,now).state,'current');
      const saved=await uploadInsuranceCertificate({store,drive},{user:'zacb',role:'owner',businessAccess:true},{action:'upload',requestId:crypto.randomUUID(),expectedRevision:before.revision,expiresOn:'2027-09-01',filename:'Synthetic.pdf',dataUrl:'data:application/pdf;base64,'+Buffer.from(pdf).toString('base64')},now);
      assert.equal(saved.insurance.expiresOn,'2027-09-01');
      const after=await store.read();
      assert.deepEqual([after.insuranceCertificate.driveFileId,after.pendingInsuranceUpload,after.insuranceCertificateHistory[0].driveFileId],['synthetic-drive-file-0002',null,'synthetic-drive-file-0001']);
      await assert.rejects(store.commit({insuranceCertificate:null},before.revision),error=>/^PORTAL_DOCUMENTS_(REVISION_CONFLICT|OUTCOME_UNKNOWN)$/.test(error.code));
      assert.equal((await store.read()).insuranceCertificate.driveFileId,'synthetic-drive-file-0002','a stale revision never overwrites the certificate');
    });
    await t.test('Garage Guard events link, mirror and dedupe through actual Firestore REST',async()=>{
      const {membershipStorage,applyGarageGuardEvent,garageGuardEvent}=await import('../functions/_lib/garage-guard-membership.js');
      await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc('customers/gg-customer').set({name:'Synthetic Member',phone:'9705550177',email:'member@example.invalid'});await db.doc('jobs/gg-root').set({type:'job',customerId:'gg-customer',customer:'Synthetic Member'});await db.doc('jobs/gg-visit').set({type:'job',customerId:'gg-customer',customerAccountOwnerJobId:'gg-root'});});
      const store=membershipStorage({},async(_env,url,options={})=>{
        const target=new URL(url);target.protocol='http:';target.host=host;target.pathname=target.pathname.replace('/projects/egcw-1ec83/','/projects/'+projectId+'/');
        return fetch(target,{...options,...(options.body ? {body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...options.headers,Authorization:'Bearer owner'}});
      });
      const event=(id,created)=>garageGuardEvent({id,type:'checkout.session.completed',created,data:{object:{mode:'subscription',payment_status:'paid',subscription:'sub_emulator',customer:'cus_emulator',metadata:{plan:'lite'},customer_details:{email:'MEMBER@example.invalid',phone:'+19705550177'}}}});
      const results=await Promise.all([applyGarageGuardEvent(store,event('evt_emulator_1',1),{now:'2099-09-10T12:00:00.000Z',alerts:true}),applyGarageGuardEvent(store,event('evt_emulator_1',1),{now:'2099-09-10T12:00:00.000Z',alerts:true})]);
      assert.deepEqual(results.map(result=>result.status).sort(),['applied','duplicate']);
      const job=await store.read('jobs','gg-root'),membership=await store.read('memberships','sub_emulator');
      assert.deepEqual({plan:job.garageGuard.plan,visits:job.garageGuard.visitsRemaining,membershipId:job.garageGuard.membershipId},{plan:'lite',visits:2,membershipId:'sub_emulator'});
      assert.equal(membership.link.accountJobId,'gg-root');assert.equal((await store.read('stripe_events','evt_emulator_1')).alert.status,'pending');
      assert.equal((await store.read('jobs','gg-visit')).garageGuard,undefined);
      assert.equal((await applyGarageGuardEvent(store,event('evt_emulator_1',1),{now:'2099-09-11T12:00:00.000Z'})).status,'duplicate');
      assert.equal((await store.read('memberships','sub_emulator')).revision,membership.revision,'a replay writes nothing');
      assert.equal((await store.read('customerIdentityState','revision')).lastStripeEventId,'evt_emulator_1','the first link creates the identity guard it fences');
      // A duplicate customer created between the reads and the commit (resolveCustomer bumps the guard) fails the transaction fence.
      await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc('customers/gg-second').set({name:'Synthetic Second',phone:'9705550178'});await db.doc('jobs/gg-second-root').set({type:'job',customerId:'gg-second',customer:'Synthetic Second'});});
      let raced=false;
      const racing={...store,commit:async writes=>{if(!raced){raced=true;await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc('customers/gg-second-dup').set({name:'Synthetic Second Duplicate',phone:'970-555-0178'});await db.doc('customerIdentityState/revision').set({updatedAt:'2099-09-10T12:00:01.000Z',lastRequestId:'synthetic-race'});});}return store.commit(writes);}};
      const second=garageGuardEvent({id:'evt_emulator_2',type:'checkout.session.completed',created:2,data:{object:{mode:'subscription',payment_status:'paid',subscription:'sub_emulator_2',customer:'cus_emulator_2',metadata:{plan:'guard'},customer_details:{phone:'+19705550178'}}}});
      const racedResult=await applyGarageGuardEvent(racing,second,{now:'2099-09-10T12:00:02.000Z'});
      assert.deepEqual({raced,link:racedResult.link,reason:racedResult.reason,mirrored:racedResult.mirrored},{raced:true,link:'needs_review',reason:'ambiguous_customer',mirrored:false});
      assert.equal((await store.read('jobs','gg-second-root')).garageGuard,undefined,'the stale one-customer decision never reaches the job');
    });
  } finally {await environment.cleanup();}
});
