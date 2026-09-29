import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';

const enabled = process.env.EGC_FIREBASE_EMULATOR_TEST === '1';

test('actual Firestore rules isolate canonical operations from crew SDK access', {skip:!enabled,timeout:150000},async t=>{
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
        'garage_guard_operations/receipt':{actorId:'zacb',action:'visits.reconcile',fingerprint:'synthetic'},
        'payment_reviews/cs_test_synthetic':{status:'open',reason:'payment_exceeds_balance',jobId:'assigned',amountCents:50000},
        'moneyOperations/receipt':{actorId:'zacb',action:'payment.record_offline',jobId:'assigned',fingerprint:'synthetic'},
        'moneyInvoiceNumbers/n_INV-ASSIGN':{number:'INV-ASSIGN',jobId:'assigned'},
        'jobs/labor-copy':{id:'labor-copy',type:'job',status:'completed',laborCost:189.55,costs:{labor:151.64,laborCents:15164,disposal:85.5,recordedBy:'zacb'}},
        'jobLaborCosts/assigned':{jobId:'assigned',laborCents:15164,source:'egc_hub'},
        'jobs/labor-moved':{id:'labor-moved',type:'job',status:'completed',laborCost:189.55,costs:{labor:151.64,laborCents:15164,disposal:85.5,recordedBy:'zacb'}},
        'jobLaborCosts/labor-moved':{jobId:'labor-moved',laborCents:15164,source:'legacy_job'},
        'jobLaborCostOperations/receipt':{actorId:'zacb',jobId:'assigned',fingerprint:'synthetic'},
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
    await t.test('job-cost closeout attestations and stocked-item standard costs remain server-only even for business SDK sessions',async()=>{
      for(const db of [publicDb,crew,lead,manager]) for(const path of ['jobs/assigned/fieldExpenseCloseout/material','jobs/assigned/fieldExpenses/entry','catalogStandardCosts/current','catalogStandardCostOperations/receipt']){await assertFails(db.doc(path).get());await assertFails(db.doc(path).set({attestation:'none',standardUnitCostCents:1}));await assertFails(db.doc(path).delete());}
      for(const db of [crew,manager]){await assertFails(db.collection('catalogStandardCosts').get());await assertFails(db.collection('jobs/assigned/fieldExpenseCloseout').get());}
    });
    await t.test('portal document settings (insurance certificate pointer) remain server-only even for business SDK sessions',async()=>{
      for(const db of [publicDb,crew,lead,manager]){const path='portal_settings/documents';await assertFails(db.doc(path).get());await assertFails(db.collection('portal_settings').get());await assertFails(db.doc(path).set({insuranceCertificate:{driveFileId:'attacker-file-0001',expiresOn:'2099-12-31'}}));await assertFails(db.doc(path).update({'insuranceCertificate.expiresOn':'2099-12-31'}));await assertFails(db.doc(path).delete());await assertFails(db.doc('portal_settings/new').set({insuranceCertificate:null}));}
    });
    await t.test('imported Jobber history is read-only and import receipts and guard checks are server-only',async()=>{
      const history='jobs/jobber_visit_2002_20260910_1300_1500';
      await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc(history).set({type:'job',recordType:'jobber_history',customerId:'customer',status:'completed',date:'2026-09-10'});await db.doc('jobberImport/run').set({status:'completed',committed:{customers:1,jobs:1}});});
      await assertSucceeds(manager.doc(history).get());
      for(const db of [manager,partner]){await assertFails(db.doc(history).update({status:'scheduled'}));await assertFails(db.doc(history).set({type:'job',status:'unscheduled'}));await assertFails(db.doc(history).delete());await assertFails(db.doc('jobs/forged-history').set({type:'job',recordType:'jobber_history'}));await assertFails(db.doc('jobs/assigned').update({recordType:'jobber_history'}));}
      for(const db of [publicDb,crew,manager]){await assertFails(db.doc('jobberImport/run').get());await assertFails(db.doc('jobberImport/run').set({status:'running'}));await assertFails(db.doc('jobberImport/run').delete());await assertFails(db.collection('jobberImport').get());}
      for(const db of [publicDb,crew,manager]) for(const path of ['jobberGuard/latest','jobberGuardRuns/run']){await assertFails(db.doc(path).get());await assertFails(db.doc(path).set({findings:[]}));await assertFails(db.doc(path).delete());await assertFails(db.collection(path.split('/')[0]).get());}
    });
    await t.test('approved-send ledgers, message templates and messaging receipts remain server-only even for business SDK sessions',async()=>{
      await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc('message_sends/send').set({kind:'payment_reminder',status:'submitted',targetId:'assigned'});await db.doc('message_templates/payment_reminder').set({kind:'payment_reminder',liveVersion:1});await db.doc('message_operations/receipt').set({actorId:'zacb',action:'template.approve'});});
      for(const db of [publicDb,crew,lead,manager]) for(const path of ['message_sends/send','message_templates/payment_reminder','message_operations/receipt']){await assertFails(db.doc(path).get());await assertFails(db.doc(path).set({status:'changed'}));await assertFails(db.doc(path).update({status:'changed'}));await assertFails(db.doc(path).delete());}
      for(const db of [crew,manager]) for(const name of ['message_sends','message_templates','message_operations']) await assertFails(db.collection(name).get());
    });
    await t.test('messaging cadence settings, signed cron run summaries and holds remain server-only even for business SDK sessions',async()=>{
      await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc('messaging_settings/automation').set({paused:false,paymentReminderDays:[1,7,14]});await db.doc('messaging_runs/run').set({status:'completed',actorId:'messaging-cron-worker'});await db.doc('messaging_holds/current').set({day:'2026-09-22',entries:[{key:'payment_reminder:job:2026-09-21:1',status:'suppressed'}]});});
      for(const db of [publicDb,crew,lead,manager]) for(const path of ['messaging_settings/automation','messaging_runs/run','messaging_holds/current']){await assertFails(db.doc(path).get());await assertFails(db.doc(path).set({paused:true}));await assertFails(db.doc(path).update({status:'changed'}));await assertFails(db.doc(path).delete());}
      for(const db of [crew,manager]) for(const name of ['messaging_settings','messaging_runs','messaging_holds']) await assertFails(db.collection(name).get());
    });
    await t.test('Garage Guard memberships, Stripe event receipts and reviews are webhook-only',async()=>{
      for(const db of [publicDb,crew,manager]) for(const path of ['memberships/sub_synthetic','stripe_events/evt_synthetic','membership_reviews/sub_synthetic','payment_reviews/cs_test_synthetic','garage_guard_operations/receipt']){await assertFails(db.doc(path).get());await assertFails(db.doc(path).update({status:'changed'}));await assertFails(db.doc(path).delete());}
      await assertFails(manager.doc('memberships/sub_new').set({plan:'black',status:'active'}));
      await assertFails(manager.collection('memberships').get());
      await assertFails(manager.collection('payment_reviews').get());
      await assertFails(manager.collection('garage_guard_operations').get());
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
    await t.test('staff directory and employee vault migration receipts are server-only even for business SDK sessions',async()=>{
      await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc('staffDirectoryOperations/receipt').set({kind:'staff_directory_receipt_v1',actor:'zacb',target:'crew1'});await db.doc('employeeVaultMigrations/receipt').set({kind:'employee_vault_migration_receipt_v1',status:'completed'});});
      for(const db of [publicDb,crew,lead,manager,partner]) for(const path of ['staffDirectoryOperations/receipt','employeeVaultMigrations/receipt']){await assertFails(db.doc(path).get());await assertFails(db.doc(path).set({status:'changed'}));await assertFails(db.doc(path).update({status:'changed'}));await assertFails(db.doc(path).delete());}
      for(const db of [crew,manager]) for(const name of ['staffDirectoryOperations','employeeVaultMigrations']) await assertFails(db.collection(name).get());
      await assertFails(manager.doc('staffDirectoryOperations/forged').set({fingerprint:'0'.repeat(64)}));
    });
    await t.test('garage catalog versions, pricing settings, settings versions and catalog receipts remain server-only even for business SDK sessions',async()=>{
      const paths=['catalogVersions/current','catalogVersions/2099-09-01.1','pricingSettings/current','catalogOperations/receipt','pricingSettingsVersions/synthetic'];
      await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc(paths[0]).set({version:'2099-09-01.1'});await db.doc(paths[1]).set({catalogVersion:'2099-09-01.1',catalogJson:'{}'});await db.doc(paths[2]).set({settingsVersion:'synthetic',readyForCustomers:false});await db.doc(paths[3]).set({actorId:'zacb',action:'catalog.publish'});await db.doc(paths[4]).set({settingsVersion:'synthetic',readyForCustomers:false});});
      for(const db of [publicDb,crew,lead,manager,partner]) for(const path of paths){await assertFails(db.doc(path).get());await assertFails(db.doc(path).set({readyForCustomers:true}));await assertFails(db.doc(path).update({readyForCustomers:true}));await assertFails(db.doc(path).delete());}
      for(const db of [crew,manager,partner]) for(const name of ['catalogVersions','pricingSettings','pricingSettingsVersions','catalogOperations']) await assertFails(db.collection(name).get());
      await assertFails(manager.doc('catalogVersions/2099-09-02.1').set({catalogVersion:'2099-09-02.1',catalogJson:'{}'}));
      await environment.withSecurityRulesDisabled(async context=>{for(const path of paths)await context.firestore().doc(path).delete();});
    });
    await t.test('catalog publishes and settings saves keep their Firestore REST preconditions and audit atomically',async()=>{
      const {catalogStorage,mutateCatalog,readCatalogState}=await import('../functions/_lib/catalog-store.js');
      const {hubAuditStorage,listAudit}=await import('../functions/_lib/hub-audit.js');
      const fetcher=async(_env,url,options={})=>{
        const target=new URL(url);target.protocol='http:';target.host=host;target.pathname=target.pathname.replace('/projects/egcw-1ec83/','/projects/'+projectId+'/');
        assert.equal(target.hostname,hostname);
        return fetch(target,{...options,...(options.body ? {body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...options.headers,Authorization:'Bearer owner'}});
      };
      const store=catalogStorage({},fetcher),owner={user:'zacb',role:'owner',businessAccess:true},now='2099-09-10T18:00:00.000Z';
      const shipped=JSON.parse(await readFile(new URL('../functions/_data/garage-catalog.json',import.meta.url),'utf8'));
      const defaults=JSON.parse(await readFile(new URL('../functions/_data/pricing-settings.defaults.json',import.meta.url),'utf8'));
      assert.equal((await readCatalogState(store)).publication.source,'seed');
      const publish={action:'catalog.publish',requestId:crypto.randomUUID(),basedOnVersion:shipped.catalogVersion,catalog:{...shipped,catalogVersion:'2099-09-10.1',generatedOn:'2099-09-10'}};
      const copies=await Promise.all([mutateCatalog(store,owner,publish,now),mutateCatalog(store,owner,publish,now)]);
      assert.deepEqual(copies.map(copy=>copy.publication.version),['2099-09-10.1','2099-09-10.1']);
      assert.equal(copies.filter(copy=>copy.replayed).length,1,'a racing copy of the same request recovers the one commit');
      const state=await readCatalogState(store);
      assert.deepEqual([state.publication.source,state.publication.version,state.catalog.items.length],['firestore','2099-09-10.1',shipped.items.length],'a full catalog fits one verified snapshot document');
      assert.equal((await listAudit(hubAuditStorage({},fetcher),{entity:'catalogVersions/2099-09-10.1'})).entries.length,1);
      await assert.rejects(mutateCatalog(store,owner,{...publish,requestId:crypto.randomUUID(),catalog:{...publish.catalog,catalogVersion:'2099-09-10.2'}},now),error=>error.code==='catalog_version_conflict');
      const saved=await mutateCatalog(store,owner,{action:'settings.update',requestId:crypto.randomUUID(),expectedRevision:null,settings:{...defaults,settingsVersion:'emulator:1'}},now);
      assert.match(saved.settings.revision,/^\d{4}-\d{2}-\d{2}T/);
      assert.equal((await store.read('pricingSettings','current')).revision,saved.settings.revision,'the commit write result is the stored revision');
      assert.equal((await store.read('pricingSettingsVersions','emulator:1')).settings.settingsVersion,'emulator:1');
      // The emulator's not-found answer for a missing document (an id with ':' included) reads as absent.
      assert.equal(await store.read('pricingSettingsVersions','emulator:missing'),null);
      await assert.rejects(mutateCatalog(store,owner,{action:'settings.update',requestId:crypto.randomUUID(),expectedRevision:saved.settings.revision,settings:{...defaults,settingsVersion:'emulator:1',laborRateCents:9000}},now),error=>error.code==='catalog_settings_version_unchanged');
      // A stale updateTime is FAILED_PRECONDITION (HTTP 400) and a create over an existing document is
      // ALREADY_EXISTS (409): both are revision conflicts, and Firestore applies no write of the commit.
      const receipt={collection:'catalogOperations',id:crypto.randomUUID(),patch:{action:'settings.update'}};
      await assert.rejects(store.commit([{collection:'pricingSettings',id:'current',revision:'2000-01-01T00:00:00.000000Z',patch:{updatedBy:'stale'}},receipt]),error=>error.code==='catalog_revision_conflict');
      await assert.rejects(store.commit([{collection:'catalogVersions',id:'2099-09-10.1',patch:{catalogJson:'{}'}},receipt]),error=>error.code==='catalog_revision_conflict');
      // Updating a document that was deleted since it was read is a conflict too.
      await assert.rejects(store.commit([{collection:'pricingSettingsVersions',id:'emulator-deleted',revision:saved.settings.revision,patch:{settingsVersion:'emulator-deleted'}},receipt]),error=>error.code==='catalog_revision_conflict');
      assert.equal(await store.read('catalogOperations',receipt.id),null);
      assert.equal((await store.read('pricingSettings','current')).revision,saved.settings.revision);
      await environment.withSecurityRulesDisabled(async context=>{for(const path of ['catalogVersions/current','catalogVersions/2099-09-10.1','pricingSettings/current','pricingSettingsVersions/emulator:1'])await context.firestore().doc(path).delete();});
    });
    await t.test('operations follow-up settings are server-only even for business SDK sessions',async()=>{
      await environment.withSecurityRulesDisabled(async context=>{await context.firestore().doc('operations_settings/followups').set({ownerId:'Zoe.Synthetic',dueMinutes:240,sendWindow:{startHour:8,endHour:19,timeZone:'America/Denver'},updatedBy:'zacb'});});
      for(const db of [publicDb,crew,lead,manager,partner]){const ref=db.doc('operations_settings/followups');await assertFails(ref.get());await assertFails(ref.set({ownerId:'attacker'}));await assertFails(ref.update({ownerId:'attacker'}));await assertFails(ref.delete());await assertFails(db.doc('operations_settings/other').set({ownerId:'attacker'}));}
      for(const db of [crew,manager])await assertFails(db.collection('operations_settings').get());
    });
    await t.test('MCP grant approval receipts are server-only even for business SDK sessions',async()=>{
      await environment.withSecurityRulesDisabled(async context=>{await context.firestore().doc(`mcp_grant_nonces/${'a'.repeat(64)}`).set({hubUser:'zacb',role:'owner',mcp:'https://mcp.example.invalid'});});
      for(const db of [publicDb,crew,lead,manager]){const path=`mcp_grant_nonces/${'a'.repeat(64)}`;await assertFails(db.doc(path).get());await assertFails(db.doc(path).update({hubUser:'crew1'}));await assertFails(db.doc(path).delete());await assertFails(db.doc(`mcp_grant_nonces/${'b'.repeat(64)}`).set({hubUser:'zacb',role:'owner'}));await assertFails(db.collection('mcp_grant_nonces').get());}
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
    await t.test('business SDK writes cannot add or change a job labor copy, drop one only once it has moved, and labor records stay server-only',async()=>{
      // JOB-COST-PRIVACY: every business user reads jobs, so labor dollars live in the server-only jobLaborCosts record.
      for(const db of [manager,partner]){
        await assertFails(db.doc('jobs/assigned').update({'costs.labor':151.64}));
        await assertFails(db.doc('jobs/assigned').set({costs:{laborCents:15164}},{merge:true}));
        await assertFails(db.doc('jobs/assigned').update({laborCost:189.55}));
        await assertFails(db.doc('jobs/labor-new').set({id:'labor-new',type:'job',costs:{labor:1,disposal:1}}));
        await assertFails(db.collection('jobs').add({type:'job',laborCost:1}));
        await assertFails(db.doc('jobs/labor-copy').update({'costs.labor':151.65}));
        await assertFails(db.doc('jobs/labor-copy').update({'costs.laborCents':15165}));
        await assertFails(db.doc('jobs/labor-copy').set({costs:{labor:0}},{merge:true}));
        await assertFails(db.doc('jobs/labor-copy').update({laborCost:1}));
        await assertFails(db.batch().update(db.doc('jobs/assigned'),{notes:'Batched'}).update(db.doc('jobs/labor-copy'),{'costs.labor':1}).commit());
      }
      // Other saves keep an older copy as it is, so managers work normally before the backfill.
      await assertSucceeds(manager.doc('jobs/labor-copy').set({costs:{disposal:99.25,recordedBy:'tylerg'},updatedAt:'2099-09-01T12:00:00.000Z'},{merge:true}));
      await assertSucceeds(partner.doc('jobs/labor-copy').update({notes:'Manager note still saves'}));
      await assertSucceeds(manager.doc('jobs/labor-copy').set({costs:{labor:151.64,laborCents:15164,disposal:99.25}},{merge:true}));
      // Dropping or blanking a copy that was never moved would destroy the owner's only figure.
      for(const db of [manager,partner]){
        await assertFails(db.doc('jobs/labor-copy').update({'costs.labor':FieldValue.delete(),laborCost:FieldValue.delete()}));
        await assertFails(db.doc('jobs/labor-copy').update({laborCost:FieldValue.delete()}));
        await assertFails(db.doc('jobs/labor-copy').update({'costs.laborCents':FieldValue.delete()}));
        await assertFails(db.doc('jobs/labor-copy').set({costs:{labor:null}},{merge:true}));
        await assertFails(db.doc('jobs/labor-copy').set({id:'labor-copy',type:'job',status:'completed',costs:{disposal:99.25}}));
      }
      // Once the job's private record exists the copy is stale, and a save may drop it.
      await assertFails(manager.doc('jobs/labor-moved').update({'costs.labor':1}));
      await assertSucceeds(manager.doc('jobs/labor-moved').update({'costs.labor':FieldValue.delete(),laborCost:FieldValue.delete()}));
      await assertSucceeds(partner.doc('jobs/labor-moved').set({costs:{laborCents:null}},{merge:true}));
      await assertSucceeds(manager.doc('jobs/labor-created').set({id:'labor-created',type:'job',status:'unscheduled',costs:{disposal:1}}));
      // A blank labor field on a job with no copy (the Hub's unknown marker) reveals nothing and still saves.
      await assertSucceeds(manager.doc('jobs/labor-created').set({costs:{labor:null,disposal:2}},{merge:true}));
      for(const db of [publicDb,crew,lead,manager,partner]) for(const path of ['jobLaborCosts/assigned','jobLaborCostOperations/receipt']){await assertFails(db.doc(path).get());await assertFails(db.doc(path).set({laborCents:1}));await assertFails(db.doc(path).delete());}
      for(const db of [crew,manager]){await assertFails(db.collection('jobLaborCosts').get());await assertFails(db.collection('jobLaborCostOperations').get());}
      await environment.withSecurityRulesDisabled(async context=>{
        const db=context.firestore(),copy=(await db.doc('jobs/labor-copy').get()).data();
        assert.deepEqual([copy.costs.labor,copy.costs.laborCents,copy.costs.disposal,copy.laborCost,copy.notes],[151.64,15164,99.25,189.55,'Manager note still saves'],'the unmoved copy is intact');
        const moved=(await db.doc('jobs/labor-moved').get()).data();
        assert.deepEqual([moved.costs.labor,moved.costs.laborCents,moved.laborCost,(await db.doc('jobLaborCosts/labor-moved').get()).data().laborCents],[undefined,null,undefined,15164]);
        assert.deepEqual((await db.doc('jobs/labor-created').get()).data().costs,{labor:null,disposal:2});
        assert.equal((await db.doc('jobs/labor-new').get()).exists,false);
        assert.notEqual((await db.doc('jobs/assigned').get()).data().notes,'Batched','a denied labor write rejects the whole batch');
        assert.equal((await db.doc('jobLaborCosts/assigned').get()).data().laborCents,15164);
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
    await t.test('a stale updateTime is 400 FAILED_PRECONDITION on actual Firestore and the stores report a revision conflict',async st=>{
      const {dispatchStorage}=await import('../functions/_lib/dispatch-storage.js');
      const {schedulingStorage}=await import('../functions/_lib/operations-scheduling.js');
      const {createBusinessStore}=await import('../functions/_lib/business-hub-store.js');
      const {patchJob}=await import('../functions/_lib/firestore-job.js');
      const {classifyCommitFailure}=await import('../functions/_lib/firestore-errors.js');
      const realFetch=globalThis.fetch;
      const emulator=async(_env,url,options={})=>{
        const target=new URL(url);target.protocol='http:';target.host=host;target.pathname=target.pathname.replace('/projects/egcw-1ec83/','/projects/'+projectId+'/');target.searchParams.delete('key');
        assert.equal(target.hostname,hostname);
        return realFetch(target,{...options,...(options.body ? {body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...Object.fromEntries(new Headers(options.headers)),Authorization:'Bearer owner'}});
      };
      const store=dispatchStorage({},emulator),id='p04-stale-'+crypto.randomUUID().slice(0,8);
      await store.commit([{collection:'jobs',id,patch:{type:'job',status:'scheduled'}}]);
      const first=await store.read('jobs',id);
      await store.commit([{collection:'jobs',id,revision:first.revision,patch:{status:'confirmed'}}]);
      const raw=await emulator({},'https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents:commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({writes:[{update:{name:`projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`,fields:{status:{stringValue:'cancelled'}}},updateMask:{fieldPaths:['status']},currentDocument:{updateTime:first.revision}}]})});
      const body=await raw.json();
      assert.deepEqual([raw.status,body.error?.status],[400,'FAILED_PRECONDITION'],'Firestore answers a stale updateTime with 400, not 409/412.');
      assert.equal(classifyCommitFailure(raw.status,body),'stale');
      await assert.rejects(store.commit([{collection:'jobs',id,revision:first.revision,patch:{status:'cancelled'}}]),error=>error.code==='dispatch_revision_conflict'&&error.status===409);
      await assert.rejects(store.commit([{collection:'jobs',id:id+'-never-created',revision:first.revision,patch:{status:'cancelled'}}]),error=>error.code==='dispatch_revision_conflict','A vanished document is a stale precondition too.');
      await assert.rejects(store.commit([{collection:'jobs',id,patch:{status:'cancelled'}}]),error=>error.code==='dispatch_revision_conflict','A create collision (409 ALREADY_EXISTS) stays a conflict.');
      await assert.rejects(store.commit([{collection:'jobs',id,revision:'not-a-revision',patch:{status:'cancelled'}}]),error=>error.code==='dispatch_outcome_unknown'&&error.status===503,'400 INVALID_ARGUMENT is never a conflict.');
      await assert.rejects(schedulingStorage({},emulator).commit([{collection:'jobs',id,revision:first.revision,patch:{status:'cancelled'}}]),error=>error.message==='schedule_revision_conflict'&&error.status===409);
      const business=createBusinessStore({},emulator),account=crypto.randomUUID().replaceAll('-','');
      await business.commit([{collection:'business_accounts',id:account,data:{status:'active'}}]);
      const opened=await business.read('business_accounts',account);
      await business.commit([{collection:'business_accounts',id:account,version:opened._version,data:{status:'paused'},patch:true}]);
      await assert.rejects(business.commit([{collection:'business_accounts',id:account,version:opened._version,data:{status:'closed'},patch:true}]),error=>error.status===409);
      st.mock.method(globalThis,'fetch',(input,init={})=>emulator({},input,init));
      await assert.rejects(patchJob({FIREBASE_API_KEY:'firebase-test-emulator'},id,{status:'cancelled'},first.revision),error=>error.storageStatus===400&&error.storageFailure==='stale');
      assert.equal((await store.read('jobs',id)).status,'confirmed','No stale write was applied.');
      assert.equal((await business.read('business_accounts',account)).status,'paused');
    });
    await t.test('an overlapping identical recording approval that loses the job precondition reports the applied receipt',async()=>{
      const {applyRecordingApproval,resolveRecordingIdentity}=await import('../functions/_lib/operations-recording-approval.js');
      const realFetch=globalThis.fetch;
      const emulator=async(_env,url,options={})=>{
        const target=new URL(url);target.protocol='http:';target.host=host;target.pathname=target.pathname.replace('/projects/egcw-1ec83/','/projects/'+projectId+'/');target.searchParams.delete('key');
        assert.equal(target.hostname,hostname);
        return realFetch(target,{...options,...(options.body ? {body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...Object.fromEntries(new Headers(options.headers)),Authorization:'Bearer owner'}});
      };
      const visit='p04-recording-'+crypto.randomUUID().slice(0,8),customer=visit+'-customer',actor={id:'zacb',kind:'human',role:'owner'};
      await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc('customers/'+customer).set({name:'Synthetic Recording Customer'});await db.doc('jobs/'+visit).set({type:'walkthrough',customerId:customer});});
      const approval=async fingerprint=>({recordingId:crypto.randomUUID(),requestId:crypto.randomUUID(),fingerprint,portalJobId:visit,expectedRevision:(await resolveRecordingIdentity({},visit,emulator)).portalRevision,portalVisitId:visit,portalCustomerId:customer,portalProjectId:null,extraction:{summary:'Synthetic scope'}});
      // Request #2 has read "no receipt" and the job revision; request #1 (a Railway retry of the same approval) commits first.
      const command=await approval('c'.repeat(64));let first=null;
      const second=await applyRecordingApproval({},command,actor,async(env,url,options)=>{if(String(url).endsWith(':commit')&&!first)first=await applyRecordingApproval({},command,actor,emulator);return emulator(env,url,options);});
      assert.equal(first.alreadyApplied,false);
      assert.deepEqual(second,{ok:true,alreadyApplied:true,recordingId:command.recordingId,appliedAt:first.appliedAt},'The identical approval applied once; the loser reports it instead of a revision conflict.');
      // A plain edit between the identity read and the commit, with no receipt, is still a revision conflict.
      const stale=await approval('d'.repeat(64));
      await assert.rejects(applyRecordingApproval({},stale,actor,async(env,url,options)=>{if(String(url).endsWith(':commit'))await environment.withSecurityRulesDisabled(context=>context.firestore().doc('jobs/'+visit).update({opsNotes:'Synthetic edit'}));return emulator(env,url,options);}),error=>error.message==='recording_source_revision_conflict'&&error.status===409);
      const job=await (await emulator({},`https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents/jobs/${visit}`)).json();
      assert.equal(job.fields.reviewedWalkthroughScope.mapValue.fields.recordingId.stringValue,command.recordingId,'Only the first approval reached the job.');
      assert.equal((await emulator({},`https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents/operation_recording_approvals/${stale.recordingId}`)).status,404,'The stale approval left no receipt.');
    });
    await t.test('Garage Guard events link, mirror and dedupe through actual Firestore REST',async()=>{
      const {membershipStorage,applyGarageGuardEvent,garageGuardEvent}=await import('../functions/_lib/garage-guard-membership.js');
      await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc('customers/gg-customer').set({name:'Synthetic Member',phone:'9705550177',email:'member@example.invalid'});await db.doc('jobs/gg-root').set({type:'job',customerId:'gg-customer',customer:'Synthetic Member'});await db.doc('jobs/gg-visit').set({type:'job',customerId:'gg-customer',customerAccountOwnerJobId:'gg-root'});});
      const emulatorFetch=async(_env,url,options={})=>{
        const target=new URL(url);target.protocol='http:';target.host=host;target.pathname=target.pathname.replace('/projects/egcw-1ec83/','/projects/'+projectId+'/');
        return fetch(target,{...options,...(options.body ? {body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...options.headers,Authorization:'Bearer owner'}});
      };
      const store=membershipStorage({},emulatorFetch);
      const event=(id,created)=>garageGuardEvent({id,type:'checkout.session.completed',created,data:{object:{mode:'subscription',payment_status:'paid',subscription:'sub_emulator',customer:'cus_emulator',metadata:{plan:'lite'},customer_details:{email:'MEMBER@example.invalid',phone:'+19705550177'}}}});
      const results=await Promise.all([applyGarageGuardEvent(store,event('evt_emulator_1',1),{now:'2099-09-10T12:00:00.000Z',alerts:true}),applyGarageGuardEvent(store,event('evt_emulator_1',1),{now:'2099-09-10T12:00:00.000Z',alerts:true})]);
      assert.deepEqual(results.map(result=>result.status).sort(),['applied','duplicate']);
      const job=await store.read('jobs','gg-root'),membership=await store.read('memberships','sub_emulator');
      assert.deepEqual({plan:job.garageGuard.plan,visits:job.garageGuard.visitsRemaining,membershipId:job.garageGuard.membershipId},{plan:'lite',visits:2,membershipId:'sub_emulator'});
      assert.equal(membership.link.accountJobId,'gg-root');assert.equal((await store.read('stripe_events','evt_emulator_1')).alert.status,'pending');
      assert.equal((await store.read('jobs','gg-visit')).garageGuard,undefined);
      // FUN-20: the ledger's exact membershipId query (with its field mask) when a billing period closes.
      await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();await db.doc('jobs/gg-member-visit').set({type:'job',customerId:'gg-customer',membershipId:'sub_emulator',visitPurpose:'member_visit',status:'completed',completedAt:'2099-09-12T12:00:00.000Z',membershipVisit:{status:'pending'},total:900});await db.doc('jobs/gg-other-member').set({type:'job',customerId:'gg-customer',membershipId:'sub_emulator_other',status:'completed'});});
      const memberVisits=await store.membershipVisits('sub_emulator');
      assert.deepEqual([memberVisits.complete,memberVisits.rows.map(row=>row.id),memberVisits.rows[0].membershipVisit,memberVisits.rows[0].completedAt,memberVisits.rows[0].total,typeof memberVisits.rows[0].revision],[true,['gg-member-visit'],{status:'pending'},'2099-09-12T12:00:00.000Z',undefined,'string']);
      // FUN-20 second review: visits.reconcile lists them again (the manager store) for a year that closed without a list.
      const {garageGuardStorage}=await import('../functions/_lib/garage-guard-visits.js');
      const managerVisits=await garageGuardStorage({},emulatorFetch).membershipVisits('sub_emulator');
      assert.deepEqual([managerVisits.complete,managerVisits.rows.map(row=>row.id),managerVisits.rows[0].membershipVisit,managerVisits.rows[0].total,managerVisits.rows[0].revision],[true,['gg-member-visit'],{status:'pending'},undefined,memberVisits.rows[0].revision]);
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
    await t.test('FUN-20: a close fences only the member visits that could land in its year, and a manager confirms an unlisted year empty, through actual Firestore REST',async()=>{
      const {membershipStorage,applyGarageGuardEvent,garageGuardEvent}=await import('../functions/_lib/garage-guard-membership.js');
      const {garageGuardLedgerStore,garageGuardBilling,LEDGER_LIMITS}=await import('../functions/_lib/garage-guard-ledger.js');
      const {garageGuardStorage,garageGuardAction}=await import('../functions/_lib/garage-guard-visits.js');
      const emulatorFetch=async(_env,url,options={})=>{
        const target=new URL(url);target.protocol='http:';target.host=host;target.pathname=target.pathname.replace('/projects/egcw-1ec83/','/projects/'+projectId+'/');
        return fetch(target,{...options,...(options.body ? {body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...options.headers,Authorization:'Bearer owner'}});
      };
      const NOW='2099-06-01T12:00:00.000Z',T=seconds=>new Date(Date.parse(NOW)+seconds*1000).toISOString(),DAY=86400,created=Math.floor(Date.parse(NOW)/1000);
      const raw=membershipStorage({},emulatorFetch);
      // A linked member with one open tracked year, more cancelled member visits than a year can list, and one scheduled visit.
      const seed=async sub=>{
        await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();for(let index=0;index<=LEDGER_LIMITS.visits;index++)await db.doc(`jobs/${sub}-cancelled-${index}`).set({type:'job',customerId:`c-${sub}`,membershipId:sub,visitPurpose:'member_visit',status:'cancelled',pipelineStatus:'cancelled',date:'2099-04-01'});});
        await raw.commit([
          {collection:'customers',id:`c-${sub}`,patch:{name:'Synthetic Member',phone:'9705550188',email:`${sub}@example.invalid`}},
          {collection:'jobs',id:`root-${sub}`,patch:{type:'job',customerId:`c-${sub}`,customer:'Synthetic Member',garageGuard:{plan:'guard',status:'active',visitsIncluded:4,visitsRemaining:4,membershipId:sub,source:'stripe'}}},
          {collection:'jobs',id:`next-${sub}`,patch:{type:'job',customerId:`c-${sub}`,membershipId:sub,visitPurpose:'member_visit',status:'scheduled',date:'2099-07-01'}},
          {collection:'memberships',id:sub,patch:{subscriptionId:sub,status:'active',plan:'guard',visitsIncluded:4,visitsRemaining:4,livemode:true,currentPeriodEnd:T(265*DAY),statusEventCreated:created-100*DAY,createdAt:T(-100*DAY),ledgerVersion:1,startedAt:T(-100*DAY),
            customerEmail:`${sub}@example.invalid`,phone:'+19705550188',link:{status:'linked',customerId:`c-${sub}`,accountJobId:`root-${sub}`,mirroredAt:T(-100*DAY)},
            periods:[{id:'in_emu',status:'open',openedAt:T(-100*DAY),paidSource:'invoice',invoiceId:'in_emu',invoiceIds:['in_emu'],paidCents:80000,periodStart:T(-100*DAY),periodEnd:T(265*DAY),plan:'guard',visitsIncluded:4,visitsTracked:true,visitsUsed:0,recognizedCents:0,visits:[],adjustments:[],closedAt:null,closeReason:null,breakageCents:null,breakageUnknown:null}]}},
        ]);
      };
      const cancel=sub=>garageGuardEvent({id:`evt_emu_cancel_${sub.replace(/[^A-Za-z0-9]/g,'')}`,type:'customer.subscription.deleted',created,livemode:true,data:{object:{id:sub,object:'subscription',customer:'cus_emu',status:'canceled',metadata:{plan:'guard'},canceled_at:created,ended_at:created,cancellation_details:{reason:'cancellation_requested'}}}});
      const close=(store,sub,now)=>{const input=cancel(sub);return applyGarageGuardEvent(garageGuardLedgerStore(store,input,garageGuardBilling({type:'customer.subscription.deleted',data:{object:{cancellation_details:{reason:'cancellation_requested'}}}}),now,{visitTracking:true}),input,{now,alerts:false});};
      // The scheduled visit is completed, backdated into the year, between the close's listing and its commit: its fence conflicts and the close lists again.
      const fenced='sub_emu_fence5';await seed(fenced);
      let listings=0;
      const racing={...raw,async membershipVisits(id){const out=await raw.membershipVisits(id);listings++;if(listings===1){const job=await raw.read('jobs',`next-${fenced}`);await raw.commit([{collection:'jobs',id:job.id,revision:job.revision,patch:{status:'completed',pipelineStatus:'completed',completedAt:T(-10*DAY),membershipVisit:{status:'pending',membershipId:fenced}}}]);}return out;}};
      const first=await raw.membershipVisits(fenced);
      assert.deepEqual([first.complete,first.rows.length,first.rows.find(row=>row.id===`next-${fenced}`).date],[true,LEDGER_LIMITS.visits+2,'2099-07-01'],'the listing carries each job\'s date');
      assert.equal((await close(racing,fenced,T(60))).status,'applied');
      let period=(await raw.read('memberships',fenced)).periods[0];
      assert.deepEqual([listings,period.status,period.unresolvedVisitJobIds,period.breakageCents,period.breakageUnknown],[2,'closed',[`next-${fenced}`],null,'visits_unresolved'],'the cancelled jobs never made the list unknown');
      // With only cancelled jobs and the scheduled one, the year closes with a known breakage.
      const quiet='sub_emu_quiet5';await seed(quiet);
      assert.equal((await close(raw,quiet,T(60))).status,'applied');
      period=(await raw.read('memberships',quiet)).periods[0];
      assert.deepEqual([period.unresolvedVisitJobIds,period.breakageCents,period.breakageUnknown],[[],80000,null]);
      // A listing that keeps failing: past the retry window the year closes unlisted, and a manager confirms it has no visit waiting.
      const unlisted='sub_emu_unlisted5';await seed(unlisted);
      const failing={...raw,membershipVisits:async()=>{throw Object.assign(new Error('down'),{code:'garage_guard_storage_unavailable'});}};
      assert.equal((await close(failing,unlisted,T(2*3600))).status,'applied');
      assert.equal((await raw.read('memberships',unlisted)).periods[0].unresolvedVisitJobIds,null);
      const manager={user:'alexk',role:'manager',businessAccess:true},gg=garageGuardStorage({},emulatorFetch),down={...gg,membershipVisits:failing.membershipVisits};
      const confirmed=await garageGuardAction(down,manager,{action:'visits.reconcile',requestId:crypto.randomUUID(),membershipId:unlisted,expectedRevision:(await raw.read('memberships',unlisted)).revision,visitsRemaining:4,note:'No member visit was done before the cancellation.',confirmEmptyPeriodIds:['in_emu']},T(3*3600));
      period=(await raw.read('memberships',unlisted)).periods[0];
      assert.deepEqual([confirmed.confirmedEmptyPeriodIds,period.unresolvedVisitJobIds,period.breakageCents,period.visitsConfirmedEmpty.by],[['in_emu'],[],80000,'alexk']);
    });
    await t.test('funnel events are server-only and land atomically with their business change through actual Firestore REST',async()=>{
      const {dispatchStorage}=await import('../functions/_lib/dispatch-storage.js');
      const {funnelEventWrite}=await import('../functions/_lib/funnel-events.js');
      const store=dispatchStorage({},async(_env,url,options={})=>{
        const target=new URL(url);target.protocol='http:';target.host=host;target.pathname=target.pathname.replace('/projects/egcw-1ec83/','/projects/'+projectId+'/');
        return fetch(target,{...options,...(options.body ? {body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...options.headers,Authorization:'Bearer owner'}});
      });
      await environment.withSecurityRulesDisabled(context=>context.firestore().doc('jobs/fun-job').set({type:'job',customerId:'customer',status:'scheduled'}));
      const job=await store.read('jobs','fun-job'),requestId=crypto.randomUUID();
      const event=input=>funnelEventWrite(store,'2099-09-10T12:00:00.000Z',{type:'job.cancelled',idempotencyKey:{kind:'requestId',value:requestId},jobId:'fun-job',actor:{id:'zacb',kind:'human',role:'owner'},via:'hub',source:{collection:'dispatchOperations',id:requestId},data:{reasonCode:'weather',initiatedBy:'company',...input},eligibility:{hub:job}});
      const write=await event();
      await store.commit([{collection:'jobs',id:'fun-job',revision:job.revision,patch:{status:'cancelled'}},write]);
      assert.equal((await store.read('funnelEvents',write.id)).data.reasonCode,'weather');
      assert.equal(await event(),null,'a retry after a lost response finds the identical saved event');
      await assert.rejects(event({reasonCode:'crew_unavailable'}),error=>error.code==='funnel_event_idempotency_conflict');
      const after=await store.read('jobs','fun-job');
      await assert.rejects(store.commit([{collection:'jobs',id:'fun-job',revision:after.revision,patch:{status:'scheduled'}},write]),error=>error.code==='dispatch_revision_conflict','an event id is never written twice');
      assert.equal((await store.read('jobs','fun-job')).status,'cancelled','the business change is rejected with its duplicate event');
      for(const db of [publicDb,crew,lead,manager,partner]){const ref=db.doc('funnelEvents/'+write.id);await assertFails(ref.get());await assertFails(ref.set({type:'deal.sold'}));await assertFails(ref.update({type:'deal.sold'}));await assertFails(ref.delete());await assertFails(db.collection('funnelEvents').get());await assertFails(db.doc('funnelEvents/fe_forged').set({type:'deal.sold',data:{amountCents:1}}));}
    });
    await t.test('FUN-13 web lead receipts: one create-only commit with the event, the retryAt due query and the claim CAS hold on actual Firestore, and no SDK session reaches them',async()=>{
      const {webLeadStorage,receiveWebLead,retryWebLeadReceipts,webLeadMeta,WEB_LEAD_RECEIPTS}=await import('../functions/_lib/web-lead-intake.js');
      const store=webLeadStorage({},async(_env,url,options={})=>{
        const target=new URL(url);target.protocol='http:';target.host=host;target.pathname=target.pathname.replace('/projects/egcw-1ec83/','/projects/'+projectId+'/');
        return fetch(target,{...options,...(options.body ? {body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...options.headers,Authorization:'Bearer owner'}});
      });
      const env={HUB_SESSION_SECRET:'synthetic-web-lead-emulator-secret-0123456789'},now='2099-09-22T18:00:00.000Z',inquiryId=crypto.randomUUID();
      const flat={name:'Synthetic Emulator',phone:'(970) 555-0120',page_url:'https://easygaragecleaning.com/book',source:'Website',sms_consent:''};
      const webLead={name:flat.name,phone:flat.phone,flat},meta=webLeadMeta(flat,webLead);
      const failing=await receiveWebLead({store,env,now,sync:async()=>{throw Object.assign(new Error('synthetic'),{code:'highlevel_unavailable'});},relay:async()=>assert.fail('no relay after a failed sync')},{lead:webLead,inquiryId,clientInquiryId:true,meta,held:null});
      assert.equal(failing.status,202);
      const saved=await store.read(WEB_LEAD_RECEIPTS,inquiryId);
      assert.deepEqual([saved.ghlSyncStatus,saved.attempts,saved.retryAt,saved.lastError],['failed',1,'2099-09-22T18:05:00.000Z','highlevel_unavailable']);
      assert.equal((await store.read('funnelEvents',saved.funnelEventId)).type,'inquiry.received');
      const replay=await receiveWebLead({store,env,now,sync:async()=>assert.fail('a replay never syncs'),relay:async()=>assert.fail('a replay never relays')},{lead:webLead,inquiryId,clientInquiryId:true,meta,held:null});
      assert.deepEqual([replay.status,replay.body.replayed],[202,true]);
      await assert.rejects(store.commit([{collection:WEB_LEAD_RECEIPTS,id:inquiryId,patch:{attempts:9}}]),error=>error.code==='web_lead_revision_conflict','a receipt is create-only');
      assert.deepEqual((await store.dueReceipts('2099-09-22T18:04:59.999Z',5)).map(row=>row.id),[]);
      assert.deepEqual((await store.dueReceipts('2099-09-22T18:05:00.000Z',5)).map(row=>row.id),[inquiryId]);
      const synced=[];
      const [a,b]=await Promise.all([1,2].map(()=>retryWebLeadReceipts({store,env,sync:async value=>{synced.push(value.phone);return {configured:true,synced:true,contactId:'contact-emulator',opportunityId:''};}},{now:new Date('2099-09-22T18:06:00.000Z')})));
      assert.deepEqual([a.synced+b.synced,synced],[1,['(970) 555-0120']],'the claim CAS lets exactly one tick sync the lead');
      const done=await store.read(WEB_LEAD_RECEIPTS,inquiryId);
      assert.deepEqual([done.ghlSyncStatus,done.attempts,done.contactId,done.sealedPayload,done.retryAt],['synced',2,'contact-emulator',null,null]);
      assert.deepEqual(await store.dueReceipts('2099-09-23T18:00:00.000Z',5),[]);
      // A lead with 20,000 3-byte characters: Firestore keeps its ~80,000-character sealed copy intact and the retry opens it.
      const bigId=crypto.randomUUID(),bigFlat={...flat,what_to_remove:'車庫'.repeat(5000),photo_description:'写真'.repeat(5000)},big={name:bigFlat.name,phone:bigFlat.phone,flat:bigFlat};
      const bigFailing=await receiveWebLead({store,env,now,sync:async()=>{throw Object.assign(new Error('synthetic'),{code:'highlevel_unavailable'});},relay:async()=>assert.fail('no relay after a failed sync')},{lead:big,inquiryId:bigId,clientInquiryId:true,meta:webLeadMeta(bigFlat,big),held:null});
      assert.deepEqual([bigFailing.status,bigFailing.body.highlevel.retry],[202,'scheduled']);
      const bigSaved=await store.read(WEB_LEAD_RECEIPTS,bigId);
      assert.ok(bigSaved.payloadSealed===true&&bigSaved.sealedPayload.ct.length>16*4096,String(bigSaved.sealedPayload?.ct?.length));
      const bigSynced=[];
      const bigTick=await retryWebLeadReceipts({store,env,sync:async value=>{bigSynced.push(value);return {configured:true,synced:true,contactId:'contact-emulator-big',opportunityId:''};}},{now:new Date('2099-09-22T18:06:00.000Z')});
      assert.deepEqual([bigTick.synced,bigTick.abandoned,bigSynced.length,bigSynced[0]?.what_to_remove===bigFlat.what_to_remove,bigSynced[0]?.photo_description===bigFlat.photo_description],[1,0,1,true,true]);
      assert.deepEqual((({ghlSyncStatus,sealedPayload,contactId})=>[ghlSyncStatus,sealedPayload,contactId])(await store.read(WEB_LEAD_RECEIPTS,bigId)),['synced',null,'contact-emulator-big']);
      for(const db of [publicDb,crew,lead,manager,partner]){const ref=db.doc(WEB_LEAD_RECEIPTS+'/'+inquiryId);await assertFails(ref.get());await assertFails(ref.set({ghlSyncStatus:'synced'}));await assertFails(ref.update({attempts:0}));await assertFails(ref.delete());await assertFails(db.collection(WEB_LEAD_RECEIPTS).get());await assertFails(db.doc(WEB_LEAD_RECEIPTS+'/forged').set({ghlSyncStatus:'failed',retryAt:'2000-01-01T00:00:00.000Z'}));}
    });
  } finally {await environment.cleanup();}
});

// Its own environment and timeout: this drives the real business hub through a few hundred emulator round trips.
test('every business_* collection, including receipts and invitation email caps, is server-only; TTL fields are real timestamps', {skip:!enabled,timeout:90000},async()=>{
  const host = process.env.FIRESTORE_EMULATOR_HOST || '';
  assert.match(host,/^(?:127\.0\.0\.1|localhost):\d{2,5}$/,'This test may only connect to a loopback Firestore emulator.');
  const projectId='demo-egc-field-rules';
  const require = process.env.EGC_FIREBASE_TEST_MODULES ? createRequire(resolve(process.env.EGC_FIREBASE_TEST_MODULES,'package.json')) : createRequire(new URL('../package.json',import.meta.url));
  const {initializeTestEnvironment,assertFails}=require('@firebase/rules-unit-testing');
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
  const compat=require('firebase/compat/app');const {Timestamp}=(compat.default||compat).firestore;
  try {
    const {createBusinessStore,BUSINESS_COLLECTIONS}=await import('../functions/_lib/business-hub-store.js');
    const {createBusinessHandler}=await import('../functions/_lib/business-hub-service.js');
    const {businessHubModules}=await import('../functions/_lib/business-hub-modules.js');
    const {RECEIPT_DAYS}=await import('../functions/_lib/business-hub-core.js');
    const emulator=async(_env,url,options={})=>{
      const target=new URL(url);target.protocol='http:';target.host=host;target.pathname=target.pathname.replace('/projects/egcw-1ec83/','/projects/'+projectId+'/');target.searchParams.delete('key');
      assert.equal(target.hostname,hostname);
      return fetch(target,{...options,...(options.body ? {body:options.body.replaceAll('projects/egcw-1ec83/','projects/'+projectId+'/')} : {}),headers:{...Object.fromEntries(new Headers(options.headers)),Authorization:'Bearer owner'}});
    };
    // The real hub on real Firestore: onboarding by email writes the account, audit rows, the requestId receipt and both
    // email cap records; redeeming writes a session; a property limit and a no-op each write a receipt.
    const origin='https://easygaragecleaning.com',DAY=86400000,links=[],hex=()=>crypto.randomUUID().replaceAll('-','');let clock=Date.UTC(2099,8,10,12);
    const handler=createBusinessHandler({store:createBusinessStore({},emulator),getStaff:async()=>({user:'zacb',displayName:'Synthetic Owner',businessAccess:true,role:'owner'}),finance:()=>({}),needsReview:()=>false,projectCookie:async()=>'project=; HttpOnly',clearProjectCookie:()=>'project=; Max-Age=0',now:()=>clock,
      invites:{enabled:true,deliver:async({link})=>{links.push(link);return {status:'submitted',messageId:'synthetic-message'};}},...businessHubModules});
    const call=async(payload,{url='',cookie=''}={})=>{const res=await handler(new Request(origin+'/api/business-hub'+url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-EGC-Business':'1',Cookie:cookie},body:JSON.stringify(payload)}));return {status:res.status,data:await res.json(),cookie:res.headers.get('Set-Cookie')};};
    const created=hex(),onboarded=clock,run=hex().slice(0,8);
    const account=await call({action:'create_account',requestId:created,company:'Synthetic Rules Co '+run,name:'Synthetic Admin',email:`rules-${run}@example.invalid`,deliver:'email'},{url:'?staff=1'});
    assert.equal(account.status,201,JSON.stringify(account.data));assert.equal(account.data.delivery.status,'submitted');
    const accountId=account.data.accountId,staffUrl='?staff=1&account='+accountId;
    clock+=60000;const redeemed=await call({action:'redeem',invite:new URL(links[0]).hash.slice('#invite='.length)});assert.equal(redeemed.status,200);
    const property=(await call({action:'save_property',requestId:hex(),name:'Synthetic Lot',address:'1 Example Way'},{url:staffUrl})).data.propertyId;
    const scoped=hex(),noop=hex(),memberId=account.data.memberId;
    const viewer=await call({action:'invite_member',name:'Synthetic Viewer',email:`viewer-${run}@example.invalid`,role:'viewer'},{url:staffUrl});assert.equal(viewer.status,201);
    assert.equal((await call({action:'set_member_properties',memberId:viewer.data.memberId,propertyIds:[property],requestId:scoped},{url:staffUrl})).status,200);
    assert.deepEqual((await call({action:'set_member_properties',memberId:viewer.data.memberId,propertyIds:[property],requestId:noop},{url:staffUrl})).data,{ok:true,unchanged:true});
    assert.deepEqual((await call({action:'set_member_properties',memberId:viewer.data.memberId,propertyIds:[property],requestId:noop},{url:staffUrl})).data,{ok:true,duplicate:true});
    const docs={};
    await environment.withSecurityRulesDisabled(async context=>{const db=context.firestore();for(const name of BUSINESS_COLLECTIONS)docs[name]=(await db.collection(name).get()).docs.filter(doc=>JSON.stringify(doc.data()).includes(accountId)||doc.id===accountId);});
    assert.deepEqual(Object.fromEntries(Object.entries(docs).map(([name,list])=>[name,list.length>0])),{business_accounts:true,business_sessions:true,business_audit:true,business_operations:true});
    const operations=Object.fromEntries(docs.business_operations.map(doc=>[doc.id,doc.data()])),quotas=Object.values(operations).filter(row=>row.kind==='invite_email_quota');
    // The TTL policy only deletes documents whose field is a Firestore timestamp; the store writes a JavaScript Date as one.
    for(const id of [created,scoped,noop]){assert.equal(typeof operations[id]?.expireAt?.toMillis,'function',id);assert.equal(operations[id].expireAt.toMillis(),Date.parse(operations[id].at)+RECEIPT_DAYS*DAY);}
    assert.equal(operations[created].expireAt.toMillis(),onboarded+RECEIPT_DAYS*DAY);
    assert.deepEqual(quotas.map(row=>row.scope).sort(),['address','sender']);
    for(const row of quotas){assert.equal(typeof row.expireAt?.toMillis,'function',row.scope);assert.equal(row.expireAt.toMillis(),onboarded+DAY);}
    assert.equal(docs.business_accounts[0].data().members.find(m=>m.id===memberId).status,'active');
    // The read-only rollback export pages the real collection with its field mask and lists the limited member only.
    const {exportMemberScopes}=await import('../scripts/business-members-scope-export.mjs');
    const report=await exportMemberScopes({},{fetcher:emulator,now:new Date(clock).toISOString()});
    assert.deepEqual(report.members.filter(m=>m.accountId===accountId).map(m=>[m.memberId,m.status,m.propertyIds,m.widensOnRollback]),[[viewer.data.memberId,'invited',[property],true]]);
    assert.equal(/inviteHash|accessHistory|attemptId/.test(JSON.stringify(report)),false);
    // Every browser SDK role, including signed-in business staff, is denied every business_* record and listing.
    const paths=Object.entries(docs).flatMap(([name,list])=>list.map(doc=>`${name}/${doc.id}`));
    assert.ok(paths.some(path=>path===`business_operations/${noop}`)&&paths.filter(path=>path.startsWith('business_operations/')).length>=5);
    for(const db of [publicDb,crew,otherCrew,lead,manager,partner]){
      for(const path of [...paths,`business_accounts/${accountId}/members/${memberId}`]){
        await assertFails(db.doc(path).get());await assertFails(db.doc(path).set({status:'forged'}));await assertFails(db.doc(path).update({status:'forged'}));await assertFails(db.doc(path).delete());
      }
      // invite_email_quota is a kind inside business_operations; its own name is denied too, should the caps ever move.
      for(const name of [...BUSINESS_COLLECTIONS,'invite_email_quota']){
        await assertFails(db.collection(name).get());await assertFails(db.collection(name).where('accountId','==',accountId).get());
        await assertFails(db.doc(`${name}/${'f'.repeat(32)}`).set({accountId,action:'forged',kind:'invite_email_quota',expireAt:Timestamp.fromMillis(0)}));
      }
    }
    await environment.withSecurityRulesDisabled(async context=>assert.equal((await context.firestore().doc(`business_operations/${'f'.repeat(32)}`).get()).exists,false));
    // Records written before expireAt existed: the dry-run-by-default backfill gives them real timestamps and changes nothing else.
    const {runOperationsTtlBackfill}=await import('../scripts/business-operations-ttl-backfill.mjs');
    const legacyReceipt=hex(),legacyQuota=hex()+hex(),legacy={
      [legacyReceipt]:{action:'set_member_properties',actorId:'staff:zacb',fingerprint:'e'.repeat(64),accountId,at:new Date(clock-2*DAY).toISOString()},
      [legacyQuota]:{kind:'invite_email_quota',scope:'address',sends:[{at:clock-3600000,attemptId:hex()}],updatedAt:new Date(clock-7200000).toISOString()},
    };
    // Counted against a baseline, so records another emulator suite left behind never change the answer.
    const base=await runOperationsTtlBackfill({},{fetcher:emulator,now:new Date(clock).toISOString()});
    assert.ok(base.operations.current>=5,'every record the hub wrote above already has expireAt');
    await environment.withSecurityRulesDisabled(async context=>{for(const [id,data] of Object.entries(legacy))await context.firestore().doc(`business_operations/${id}`).set(data);});
    const dry=await runOperationsTtlBackfill({},{fetcher:emulator,now:new Date(clock).toISOString()});
    assert.deepEqual([dry.mode,dry.writes.planned-base.writes.planned,dry.operations.receipts-base.operations.receipts,dry.operations.quotas-base.operations.quotas,dry.operations.current,dry.operations.unrecognized],['dry_run',2,1,1,base.operations.current,base.operations.unrecognized]);
    const applied=await runOperationsTtlBackfill({},{fetcher:emulator,apply:true,now:new Date(clock).toISOString()});
    assert.deepEqual(applied.writes,{planned:dry.writes.planned,committed:dry.writes.planned,changedDuringRun:[]});
    await environment.withSecurityRulesDisabled(async context=>{
      const read=async id=>(await context.firestore().doc(`business_operations/${id}`).get()).data();
      const receipt=await read(legacyReceipt),quota=await read(legacyQuota);
      assert.equal(receipt.expireAt.toMillis(),clock-2*DAY+RECEIPT_DAYS*DAY);assert.equal(quota.expireAt.toMillis(),clock-3600000+DAY);
      const {expireAt:_r,...receiptRest}=receipt,{expireAt:_q,...quotaRest}=quota;assert.deepEqual(receiptRest,legacy[legacyReceipt]);assert.deepEqual(quotaRest,legacy[legacyQuota]);
    });
    assert.equal((await runOperationsTtlBackfill({},{fetcher:emulator,apply:true,now:new Date(clock).toISOString()})).writes.planned,0,'a rerun is a no-op');
  } finally {await environment.cleanup();}
});
