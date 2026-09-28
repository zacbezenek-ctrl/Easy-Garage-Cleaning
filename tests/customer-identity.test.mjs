import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {normalizePhoneE164,normalizeEmail,customerIdentityFields,customerIdentityPatch,findCustomerCandidates,customerIdentityStorage} from '../functions/_lib/customer-identity.js';
import {resolveCustomer} from '../functions/_lib/customer-resolution.js';
import {linkScheduledCustomer} from '../functions/_lib/operations-scheduling.js';
import {adoptScheduledVisit} from '../functions/_lib/operations-adoption.js';
import {saveWalkthroughHandoff} from '../functions/_lib/walkthrough-handoff.js';
import {encodeFirestoreFields,decodeFirestoreFields} from '../functions/_lib/firestore-job.js';
import {mkdtemp,writeFile,chmod,stat,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mutateDispatch} from '../functions/_lib/dispatch-service.js';
import {planCustomerIdentityBackfill,runCustomerIdentityBackfill,backfillStorage,parseArgs,maskPhone,maskEmail,maskId,writeReport} from '../scripts/backfill-customer-identity.mjs';

const NOW='2026-09-22T12:00:00.000Z',manager={user:'zacb',role:'owner',businessAccess:true,displayName:'Owner'};
const conflict=()=>Object.assign(new Error('Changed'),{code:'dispatch_revision_conflict',status:409});
// In-memory Firestore: revisioned rows, create/update preconditions, read-only
// verify fences and one write per document per commit.
function memory(seed={}) {
  const rows=new Map(),commits=[];let n=0,before=async()=>{};
  for(const [key,value] of Object.entries(seed))rows.set(key,{revision:'seed-'+key,...structuredClone(value),id:key.split('/')[1]});
  const list=collection=>[...rows].filter(([key])=>key.startsWith(collection+'/')).map(([,row])=>structuredClone(row));
  const store={
    read:async(collection,id)=>structuredClone(rows.get(collection+'/'+id)||null),
    customers:async()=>list('customers'),jobs:async()=>list('jobs'),resources:async()=>[],roster:async()=>[{id:'zacb',name:'Owner',role:'owner'}],
    queryCustomers:async(field,value)=>list('customers').filter(row=>row[field]===value),
    jobsByContact:async contact=>list('jobs').filter(row=>row.highlevelContactId===contact),
    async commit(writes) {
      await before(writes);
      const keys=new Set();
      for(const write of writes){const key=write.collection+'/'+write.id;assert(!keys.has(key),'one write per document');keys.add(key);const current=rows.get(key);if(write.revision?current?.revision!==write.revision:Boolean(current))throw conflict();}
      commits.push(structuredClone(writes));
      for(const write of writes)if(!write.verify){const key=write.collection+'/'+write.id;rows.set(key,{...rows.get(key),...structuredClone(write.patch),id:write.id,revision:'r'+(++n)});}
      return {};
    },
  };
  return {rows,store,commits,before:fn=>before=fn,writes:()=>commits.flat().filter(write=>!write.verify)};
}

test('phone normalization: +1, 10/11 digits, separators and extensions are E.164; unusable numbers are empty',()=>{
  for(const value of ['(970) 555-0100','970.555.0100','970 555 0100','9705550100','19705550100','1-970-555-0100','+1 970 555 0100','+19705550100','tel:+1-970-555-0100','970-555-0100 ext. 12','970-555-0100 x12',9705550100])assert.equal(normalizePhoneE164(value),'+19705550100',String(value));
  assert.equal(normalizePhoneE164('+44 20 7946 0958'),'+442079460958');
  // An explicit + with another country code is never folded into NANP (+64 NZ is not +1 649 Turks & Caicos).
  // '+9705550100' used to fold into +19705550100; it is now the international number it spells.
  assert.equal(normalizePhoneE164('+64 9 523 4567'),'+6495234567');assert.equal(normalizePhoneE164('+9705550100'),'+9705550100');
  assert.notEqual(normalizePhoneE164('+64 9 523 4567'),normalizePhoneE164('649 523 4567'));
  for(const value of ['','555-0100','29705550100','0705550100','1705550100','9701550100','+1 170 555 0100','+1 970 555 01000','+1970555010','970-555-01000','+0 123 4567 89','12345','not a phone','+1','+123456',null,undefined,{},['9705550100'],'9'.repeat(70)])assert.equal(normalizePhoneE164(value),'',String(value));
});

test('email normalization lowercases and trims exactly without folding different mailboxes',()=>{
  assert.equal(normalizeEmail('  Synthetic.Person+Garage@Example.INVALID '),'synthetic.person+garage@example.invalid');
  assert.equal(normalizeEmail('mailto:SYNTHETIC@example.invalid'),'synthetic@example.invalid');
  assert.notEqual(normalizeEmail('synthetic.person@example.invalid'),normalizeEmail('syntheticperson@example.invalid'));
  for(const value of ['','broken','two@@example.invalid','no-domain@','spaces in@example.invalid','a@b',`${'x'.repeat(250)}@example.invalid`,null,42])assert.equal(normalizeEmail(value),'',String(value));
  assert.deepEqual(customerIdentityFields({phone:'970-555-0100',email:'A@Example.invalid'}),{phoneE164:'+19705550100',emailLower:'a@example.invalid'});
  assert.equal(customerIdentityPatch({phone:'9705550100',email:'',phoneE164:'+19705550100',emailLower:''},NOW),null);
  assert.deepEqual(customerIdentityPatch({phone:'9705550100',phoneE164:'+19705550199'},NOW),{phoneE164:'+19705550100',emailLower:'',identityNormalizedAt:NOW});
});

test('candidate lookup finds exactly one customer by phone or email and lists that CRM contact’s legacy jobs',async()=>{
  const f=memory({
    'customers/alpha':{name:'Synthetic Alpha',phone:'(970) 555-0101',email:'Alpha@example.invalid',phoneE164:'+19705550101',emailLower:'alpha@example.invalid',highlevelContactId:'contact-alpha'},
    'jobs/linked':{type:'job',customerId:'alpha',highlevelContactId:'contact-alpha'},
    'jobs/legacy':{type:'walkthrough',highlevelContactId:'contact-alpha'},
    'jobs/_egc_receipt':{recordType:'schedule_operation',highlevelContactId:'contact-alpha',customerId:'someone-else'},
  });
  let result=await findCustomerCandidates(f.store,{phone:'+1 970-555-0101'});
  assert.equal(result.customerId,'alpha');assert.equal(result.ambiguous,false);assert.equal(result.coverage.complete,true);
  assert.deepEqual(result.customers.map(row=>[row.id,row.matchedBy]),[['alpha',['phone','crm_contact']]]);
  assert.deepEqual(result.jobs.map(job=>[job.id,job.customerId]).sort(),[['legacy',''],['linked','alpha']]);
  assert.equal(JSON.stringify(result).includes('Alpha@example.invalid'),false);
  result=await findCustomerCandidates(f.store,{email:' ALPHA@EXAMPLE.INVALID '});assert.equal(result.customerId,'alpha');
  result=await findCustomerCandidates(f.store,{phone:'9705550102'});assert.equal(result.customerId,'');assert.equal(result.customers.length,0);
});

test('ambiguous phone shared by two customers yields no match, as do split phone/email and CRM identities',async()=>{
  const f=memory({
    'customers/one':{phone:'9705550199',phoneE164:'+19705550199',emailLower:'one@example.invalid',email:'one@example.invalid'},
    'customers/two':{phone:'+1 970 555 0199',phoneE164:'+19705550199',emailLower:'',email:''},
    'customers/three':{phone:'9705550133',phoneE164:'+19705550133',email:'three@example.invalid',emailLower:'three@example.invalid',highlevelContactId:'contact-three'},
    'customers/three-duplicate':{phone:'',phoneE164:'',email:'',emailLower:'',highlevelContactId:'contact-three'},
    'customers/four':{phone:'9705550144',phoneE164:'+19705550144',email:'',emailLower:'',highlevelContactId:'contact-four'},
    'jobs/four-elsewhere':{type:'job',highlevelContactId:'contact-four',customerId:'another-customer'},
  });
  let result=await findCustomerCandidates(f.store,{phone:'970-555-0199'});
  assert.equal(result.customerId,'');assert.equal(result.ambiguous,true);assert.deepEqual(result.customers.map(row=>row.id),['one','two']);assert.deepEqual(result.jobs,[]);
  result=await findCustomerCandidates(f.store,{phone:'9705550133',email:'one@example.invalid'});assert.equal(result.customerId,'');assert.deepEqual(result.customers.map(row=>row.id),['one','three']);
  result=await findCustomerCandidates(f.store,{email:'three@example.invalid'});assert.equal(result.customerId,'');assert.deepEqual(result.customers.map(row=>row.id),['three','three-duplicate']);
  result=await findCustomerCandidates(f.store,{phone:'9705550144'});assert.equal(result.customerId,'');assert.deepEqual(result.customers.map(row=>[row.id,row.matchedBy]),[['another-customer',['crm_contact_job']],['four',['phone','crm_contact']]]);
  assert.equal(f.commits.length,0);
});

test('stale or truncated lookups fail closed and invalid input never queries storage',async()=>{
  const f=memory({'customers/moved':{phone:'9705550188',email:'',phoneE164:'+19705550100',emailLower:''}});
  let result=await findCustomerCandidates(f.store,{phone:'9705550100'});
  assert.equal(result.customerId,'');assert.equal(result.coverage.complete,false);assert.deepEqual(result.customers,[]);
  let calls=0;const counted={queryCustomers:async()=>{calls++;return [];},jobsByContact:async()=>{calls++;return [];}};
  result=await findCustomerCandidates(counted,{phone:'555-0100',email:'broken'});assert.equal(calls,0);assert.equal(result.customerId,'');
  const many=Array.from({length:10},(_,i)=>({id:'c'+i,phone:'9705550100',phoneE164:'+19705550100'}));
  result=await findCustomerCandidates({queryCustomers:async()=>many,jobsByContact:async()=>[]},{phone:'9705550100'});assert.equal(result.coverage.complete,false);assert.equal(result.customerId,'');
  const single={id:'solo',phone:'9705550100',phoneE164:'+19705550100',highlevelContactId:'contact-solo'};
  result=await findCustomerCandidates({queryCustomers:async field=>field==='phoneE164'||field==='highlevelContactId'?[single]:[],jobsByContact:async()=>Array.from({length:100},(_,i)=>({id:'j'+i,type:'job',highlevelContactId:'contact-solo'}))},{phone:'9705550100'});
  assert.equal(result.coverage.complete,false);assert.equal(result.customerId,'');
  for(const broken of [async()=>null,async()=>[{id:'_egc_private',phoneE164:'+19705550100'}],async()=>[{id:'other',phoneE164:'+19705550199'}]])
    await assert.rejects(findCustomerCandidates({queryCustomers:broken,jobsByContact:async()=>[]},{phone:'9705550100'}),error=>error.code==='customer_identity_storage_incomplete');
  // A stored CRM contact that cannot be queried safely is unverified coverage, not a 400.
  calls=0;const unsafe={id:'unsafe-contact',phone:'9705550100',phoneE164:'+19705550100',highlevelContactId:'contact/../other'};
  result=await findCustomerCandidates({queryCustomers:async field=>{calls++;return field==='phoneE164'?[unsafe]:[];},jobsByContact:async()=>{throw new Error('must not query');}},{phone:'9705550100'});
  assert.equal(calls,1);assert.equal(result.customerId,'');assert.equal(result.coverage.complete,false);assert.deepEqual(result.customers.map(row=>row.id),['unsafe-contact']);
});

test('production lookup uses bounded, field-masked runQuery lookups on normalized keys and CRM jobs',async()=>{
  const calls=[],doc=(collection,id,fields)=>({name:`projects/egcw-1ec83/databases/(default)/documents/${collection}/${id}`,updateTime:'2026-09-22T11:00:00.000000Z',fields:encodeFirestoreFields(fields)});
  const fetcher=async(env,url,options)=>{
    const body=JSON.parse(options.body);calls.push({url:String(url),body});
    const filter=body.structuredQuery.where.fieldFilter,value=filter.value.stringValue;
    if(body.structuredQuery.from[0].collectionId==='jobs')return Response.json([{document:doc('jobs','legacy',{type:'job',highlevelContactId:value})},{document:doc('jobs','_egc_receipt',{recordType:'schedule_operation',highlevelContactId:value,customerId:'someone-else'})},{readTime:'2026-09-22T11:00:00Z'}]);
    return Response.json(filter.field.fieldPath==='emailLower'?[{readTime:'2026-09-22T11:00:00Z'}]:[{document:doc('customers','alpha',{phone:'9705550101',phoneE164:'+19705550101',highlevelContactId:'contact-alpha'})}]);
  };
  const result=await findCustomerCandidates(customerIdentityStorage({},fetcher),{phone:'970-555-0101',email:'nobody@example.invalid'});
  assert.equal(result.customerId,'alpha');assert.equal(result.customers[0].revision,'2026-09-22T11:00:00.000000Z');assert.deepEqual(result.jobs,[{id:'legacy',revision:'2026-09-22T11:00:00.000000Z',customerId:''}]);
  assert.deepEqual(calls.map(call=>[call.body.structuredQuery.from[0].collectionId,call.body.structuredQuery.where.fieldFilter.field.fieldPath,call.body.structuredQuery.where.fieldFilter.value.stringValue]),[['customers','phoneE164','+19705550101'],['customers','emailLower','nobody@example.invalid'],['customers','highlevelContactId','contact-alpha'],['jobs','highlevelContactId','contact-alpha']]);
  assert.ok(calls.every(call=>call.url.endsWith('/documents:runQuery')));assert.ok(calls[0].body.structuredQuery.select.fields.some(field=>field.fieldPath==='phoneE164'));assert.equal(calls[3].body.structuredQuery.limit,100);
  // Job history never pulls signatures, handoff payloads or finance: only the identity fields are selected.
  assert.deepEqual(calls[3].body.structuredQuery.select.fields.map(field=>field.fieldPath),['type','recordType','customerId','highlevelContactId']);
  await assert.rejects(customerIdentityStorage({},async()=>Response.json({error:'synthetic-secret'})).queryCustomers('phoneE164','+19705550101'),error=>error.code==='customer_identity_storage_incomplete'&&!error.message.includes('synthetic'));
  await assert.rejects(customerIdentityStorage({},async()=>new Response('nope',{status:500})).jobsByContact('contact-alpha'),error=>error.code==='customer_identity_storage_unavailable');
  await assert.rejects(customerIdentityStorage({},fetcher).queryCustomers('name','Synthetic'),error=>error.status===400);
});

test('customer resolution writes normalized identity on create and on first provider link',async()=>{
  const f=memory(),input=customer=>({requestId:randomUUID(),customer:{name:'Synthetic Customer',phone:'(970) 555-0100',email:'Synthetic@Example.invalid',address:'1 Synthetic Way',...customer}});
  const run=value=>resolveCustomer(f.store,manager,value,{now:NOW,verifyContact:async id=>({name:'Synthetic Customer',phone:'+1 970 555 0100',email:'SYNTHETIC@example.invalid',address:'1 Synthetic Way',highlevelContactId:id})});
  const created=await run(input());const saved=f.rows.get('customers/'+created.customer.id);
  assert.equal(saved.phoneE164,'+19705550100');assert.equal(saved.emailLower,'synthetic@example.invalid');assert.equal(saved.phone,'(970) 555-0100');
  const linked=await run(input({highlevelContactId:'ContactOne'}));assert.equal(linked.linked,true);assert.equal(linked.customer.id,created.customer.id);
  const relinked=f.rows.get('customers/'+created.customer.id);assert.equal(relinked.highlevelContactId,'ContactOne');assert.equal(relinked.phoneE164,'+19705550100');assert.equal(relinked.phone,'(970) 555-0100');
  const provider=memory(),fromProvider=await resolveCustomer(provider.store,manager,input({highlevelContactId:'ContactTwo'}),{now:NOW,verifyContact:async id=>({name:'Synthetic Provider',phone:'9705550122',email:'',address:'',highlevelContactId:id})});
  assert.equal(provider.rows.get('customers/'+fromProvider.customer.id).phoneE164,'+19705550122');assert.equal(provider.rows.get('customers/'+fromProvider.customer.id).emailLower,'');
});

test('native scheduled customer link writes normalized identity on create and on link',async()=>{
  const actor={id:'verified-grant',kind:'integration',role:'integration',workspace:'egc'};
  const f=memory({'jobs/native':{type:'walkthrough',highlevelContactId:'contact-new',status:'scheduled',revision:'v1'}});
  f.store.customers=async provider=>[...f.rows].filter(([key,row])=>key.startsWith('customers/')&&row.highlevelContactId===provider).map(([,row])=>structuredClone(row));
  await linkScheduledCustomer(f.store,actor,{portalVisitId:'native',expectedRevision:'v1',providerContact:{id:'contact-new',phone:'970.555.0177',email:' New@Example.invalid'}},NOW);
  assert.deepEqual([f.rows.get('customers/ghl_contact-new').phoneE164,f.rows.get('customers/ghl_contact-new').emailLower],['+19705550177','new@example.invalid']);
  const g=memory({'jobs/native':{type:'walkthrough',customerId:'local',phone:'9705550166',status:'scheduled',revision:'v1'},'customers/local':{name:'Synthetic Local',phone:'970-555-0166',email:'Local@example.invalid'}});
  g.store.customers=f.store.customers;
  await linkScheduledCustomer(g.store,actor,{portalVisitId:'native',expectedRevision:'v1',providerContact:{id:'contact-local',phone:'+19705550166'}},NOW);
  const local=g.rows.get('customers/local');assert.equal(local.highlevelContactId,'contact-local');assert.equal(local.phoneE164,'+19705550166');assert.equal(local.emailLower,'local@example.invalid');assert.equal(local.phone,'970-555-0166');
});

test('verified adoption creates its customer with normalized identity',async()=>{
  const actor={id:'booking-adoption-worker',kind:'integration',role:'integration',workspace:'egc'},now='2026-09-22T07:00:00.000Z';
  const proof={source:'ghl_appointment',sourceId:'provider-appointment',sourceRevision:'verified-r1',contactProviderId:'provider-contact',providerContact:{id:'provider-contact',name:'Synthetic Customer',phone:'+12025550199',email:'Synthetic@example.invalid'},kind:'walkthrough',startAt:'2026-09-22T20:15:00.000Z',endAt:'2026-09-22T20:45:00.000Z',address:'100 Synthetic Lane',title:'Synthetic walkthrough',originalBookingAt:'2026-09-20T16:05:00.000Z',sourceCreatedAt:'2026-09-20T16:05:00.000Z',verifiedAt:now,providerAppointmentId:'provider-appointment',providerCalendarId:'walkthrough-calendar',providerStatus:'confirmed',localJobId:null,normalizedLocalAppointmentId:null,evidenceIds:['appointment:provider-appointment']};
  const f=memory();Object.assign(f.store,{customers:async()=>[],identityCandidates:async()=>[],snapshot:async()=>[]});
  const result=await adoptScheduledVisit(f.store,actor,{command:'schedule.adopt',requestId:randomUUID(),proof},now),customer=f.rows.get('customers/'+result.portalCustomerId);
  assert.equal(customer.phoneE164,'+12025550199');assert.equal(customer.emailLower,'synthetic@example.invalid');assert.equal(customer.phone,'+12025550199');
});

test('walkthrough handoff brings a legacy customer’s identity keys current in the fenced commit, then only verifies',async()=>{
  const plan=()=>({client:{name:'Synthetic Customer',phone:'9705550100',email:'test@example.invalid',address:'100 Fixture Lane',highlevel_contact_id:'provider1'},quote:{title:'Garage reset',total:1400,deposit:700,job_date:'2026-09-24',start_time:'09:00',end_time:'12:00',estimated_duration_min:180},acceptance:{accepted_at:'2026-09-22T11:45:00.000Z',accepted_by:'Synthetic Customer',signature_captured:true,method:'in_person_signature',terms_version:'2026-09-deposit50'},signature:'data:image/png;base64,iVBORw0KGgo=',terms_version:'2026-09-deposit50',terms_accepted:true,photos:{before:1},scope:{keep_items:'Blue bicycle'},discovery:{success:'Park a vehicle'},logistics:{crew_size:2,assigned_to:'Crew of 2',notes:''},internal_notes:'Keep the blue bicycle.',notes:'',client_checklists:{preJob:[],postJob:[]}});
  const f=memory({'customers/c1':{name:'Synthetic Customer',phone:'970-555-0100',email:'Test@example.invalid',highlevelContactId:'provider1',revision:'c1r'}});
  await saveWalkthroughHandoff(f.store,manager,{requestId:randomUUID(),customerId:'c1',plan:plan()},NOW);
  const fence=f.commits[0].find(write=>write.collection==='customers');
  assert.equal(fence.revision,'c1r');assert.deepEqual(fence.patch,{phoneE164:'+19705550100',emailLower:'test@example.invalid',identityNormalizedAt:NOW});
  assert.equal(f.rows.get('customers/c1').phone,'970-555-0100');assert.equal(f.rows.get('customers/c1').name,'Synthetic Customer');
  const next=plan();next.quote.job_date='2026-09-25';
  await saveWalkthroughHandoff(f.store,manager,{requestId:randomUUID(),customerId:'c1',plan:next},NOW);
  const second=f.commits[1].find(write=>write.collection==='customers');assert.equal(second.verify,true);assert.equal(second.patch,undefined);
});

const legacySeed=()=>({
  'customers/alpha':{name:'Synthetic Alpha',phone:'(970) 555-0101',email:'Alpha@Example.invalid',highlevelContactId:'contact-alpha',address:'101 Alpha Street, Denver, CO'},
  'customers/beta':{name:'Synthetic Beta',phone:'970-555-0102',email:'beta@example.invalid',address:'102 Beta Street'},
  'customers/gamma':{name:'Synthetic Gamma',phone:'970-555-0104'},
  'customers/delta':{name:'Synthetic Delta',phone:'970-555-0105'},
  'customers/legacy.customer@x':{name:'Synthetic Unsafe Id',phone:'9705550105'},
  'customers/odd id!':{name:'Synthetic Odd Id',email:'odd@example.invalid'},
  'customers/egc_9705550106':{name:'Synthetic Legacy Gameplan',phone:'9705550106'},
  'customers/shared-one':{name:'Synthetic Shared One',phone:'+1 970 555 0199'},
  'customers/shared-two':{name:'Synthetic Shared Two',phone:'9705550199',email:'two@example.invalid'},
  'customers/done':{name:'Synthetic Done',phone:'9705550103',email:'',phoneE164:'+19705550103',emailLower:''},
  'customers/bad-phone':{name:'Synthetic Bad Phone',phone:'555-0100',email:'not-an-email'},
  'jobs/legacy-contact':{type:'walkthrough',highlevelContactId:'contact-alpha',phone:'9705550999'},
  'jobs/legacy-phone':{type:'walkthrough',phone:'1-970-555-0102',customer:'Synthetic  beta'},
  'jobs/legacy-email':{type:'walkthrough',email:' BETA@example.invalid ',address:'102 Beta Street, Denver, CO'},
  'jobs/legacy-both':{type:'walkthrough',phone:'9705550102',email:'beta@example.invalid'},
  'jobs/legacy-unconfirmed':{type:'walkthrough',phone:'9705550102',customer:'Synthetic Stranger',address:'9 Elsewhere Road'},
  'jobs/legacy-first-name':{type:'walkthrough',phone:'9705550102',customer:'Beta'},
  'jobs/legacy-egc':{type:'walkthrough',phone:'9705550106',customerName:'Synthetic Legacy Gameplan'},
  'jobs/legacy-shared':{type:'job',phone:'970.555.0199'},
  'jobs/legacy-conflict':{type:'job',phone:'9705550102',email:'someone-else@example.invalid',customer:'Synthetic Beta'},
  'jobs/legacy-crm-unmatched':{type:'job',phone:'9705550102',highlevelContactId:'contact-unknown'},
  'jobs/legacy-crm-mismatch':{type:'job',phone:'(970) 555-0101',highlevelContactId:'contact-other'},
  'jobs/legacy-none':{type:'job',phone:'9705550150'},
  'jobs/delta-job':{type:'walkthrough',phone:'9705550105',customer:'Synthetic Delta'},
  'jobs/odd-job':{type:'walkthrough',email:'odd@example.invalid',customer:'Synthetic Odd Id'},
  'jobs/linked':{type:'job',customerId:'alpha',phone:'9705550102'},
  'jobs/_egc_schedule_lock_2026-09-22':{recordType:'schedule_lock',phone:'9705550102'},
  'jobs/block':{type:'blocked',phone:'9705550102'},
  'jobs/alpha-repeat':{type:'job',phone:'(970) 555-0101',customer:'Synthetic Alpha',customerAccountOwnerJobId:'linked'},
  'jobs/alpha-second-root':{type:'job',email:'alpha@example.invalid',customer:'Synthetic Alpha'},
  'jobs/gamma-first':{type:'job',phone:'9705550104',customer:'Synthetic Gamma'},
  'jobs/gamma-second':{type:'reorg',phone:'9705550104',customer:'Synthetic Gamma'},
  'jobs/gamma-walkthrough':{type:'walkthrough',phone:'9705550104',customer:'Synthetic Gamma'},
  'jobs/root-shared':{type:'job',phone:'9705550199'},
  'jobs/child-of-shared':{type:'job',phone:'9705550102',customer:'Synthetic Beta',customerAccountOwnerJobId:'root-shared'},
  'jobs/root-beta':{type:'job',email:'beta@example.invalid',customer:'Synthetic Beta'},
  'jobs/child-beta':{type:'cleanout',phone:'9705550102',customer:'Synthetic Q. Beta',customerAccountOwnerJobId:'root-beta'},
  'jobs/root-under-alpha-child':{type:'job',phone:'9705550102',customer:'Synthetic Beta'},
  'jobs/alpha-child':{type:'job',customerId:'alpha',customerAccountOwnerJobId:'root-under-alpha-child'},
  'jobs/project-job':{type:'job',phone:'9705550102',customer:'Synthetic Beta',projectId:'project-alpha'},
  'projects/project-alpha':{customerId:'alpha'},
});
const LINKED=[['alpha-repeat','alpha'],['child-beta','beta'],['gamma-walkthrough','gamma'],['legacy-both','beta'],['legacy-contact','alpha'],['legacy-egc','egc_9705550106'],['legacy-email','beta'],['legacy-phone','beta'],['root-beta','beta']];
const HELD=['alpha-second-root','child-of-shared','delta-job','gamma-first','gamma-second','legacy-conflict','legacy-crm-mismatch','legacy-crm-unmatched','legacy-first-name','legacy-none','legacy-shared','legacy-unconfirmed','odd-job','project-job','root-shared','root-under-alpha-child'];
const planOf=f=>{const list=prefix=>[...f.rows].filter(([key])=>key.startsWith(prefix)).map(([,row])=>row);return planCustomerIdentityBackfill({customers:list('customers/'),jobs:list('jobs/'),projects:new Map([['project-alpha',f.rows.get('projects/project-alpha')]])},NOW);};

test('backfill plan links only single exact matches and reports ambiguity, conflicts and shared identities with masked values',()=>{
  const plan=planOf(memory(legacySeed()));
  assert.deepEqual(plan.links.map(link=>[link.id,link.customerId,link.patch.customerLinkEvidence]),[['alpha-repeat','alpha',['phone','name']],['child-beta','beta',['phone','name']],['gamma-walkthrough','gamma',['phone','name']],['legacy-both','beta',['phone','email']],['legacy-contact','alpha',['crm_contact']],['legacy-egc','egc_9705550106',['phone','name']],['legacy-email','beta',['email','address']],['legacy-phone','beta',['phone','name']],['root-beta','beta',['email','name']]]);
  assert.ok(plan.links.every(link=>link.revision&&link.patch.customerLinkedAt===NOW&&link.patch.customerLinkSource==='identity_backfill'));
  assert.deepEqual(plan.report.jobs.ambiguous.map(row=>[row.jobId,row.customerIds]),[['delta-job',['delta','l…@x']],['legacy-shared',['shared-one','shared-two']],['root-shared',['shared-one','shared-two']]]);
  assert.deepEqual(plan.report.jobs.ambiguous[0].evidence,{phone:['delta','l…@x']});
  assert.deepEqual(plan.report.jobs.conflicts.map(row=>[row.jobId,row.reason]),[['alpha-second-root','account_root_conflict'],['child-of-shared','lineage_conflict'],['gamma-first','account_root_conflict'],['gamma-second','account_root_conflict'],['legacy-conflict','email_mismatch'],['legacy-crm-mismatch','crm_contact_mismatch'],['legacy-crm-unmatched','crm_contact_unmatched'],['legacy-first-name','identity_unconfirmed'],['legacy-unconfirmed','identity_unconfirmed'],['odd-job','customer_id_invalid'],['project-job','project_conflict'],['root-under-alpha-child','lineage_conflict']]);
  assert.deepEqual(plan.report.jobs.unmatched,['legacy-none']);
  assert.deepEqual(plan.report.jobs.loneKeyLinks.map(row=>[row.jobId,row.customerId,row.evidence]),[['alpha-repeat','alpha',['phone','name']],['child-beta','beta',['phone','name']],['gamma-walkthrough','gamma',['phone','name']],['legacy-egc','egc_…0106',['phone','name']],['legacy-email','beta',['email','address']],['legacy-phone','beta',['phone','name']],['root-beta','beta',['email','name']]]);
  assert.deepEqual(plan.report.customers.duplicateIdentities,[{field:'phone',value:'+1…0105',customerIds:['delta','l…@x']},{field:'phone',value:'+1…0199',customerIds:['shared-one','shared-two']}]);
  assert.deepEqual(plan.report.customers.skippedIds,['l…@x','odd id!']);
  assert.deepEqual(plan.report.customers.unusablePhone,['bad-phone']);assert.deepEqual(plan.report.customers.unusableEmail,['bad-phone']);
  assert.deepEqual(plan.customerWrites.map(write=>write.id).sort(),['alpha','bad-phone','beta','delta','egc_9705550106','gamma','shared-one','shared-two']);
  const report=JSON.stringify(plan.report);
  for(const secret of ['9705550199','9705550106','beta@example.invalid','legacy.customer'])assert.equal(report.includes(secret),false,secret);
  assert.equal(maskPhone('+442079460958'),'+…0958');assert.equal(maskEmail('synthetic@example.invalid'),'s…@example.invalid');
  assert.equal(maskId('egc_19705550106'),'egc_…0106');assert.equal(maskId('synthetic@example.invalid'),'s…@example.invalid');assert.equal(maskId('egc_job_12'),'egc_job_12');
});

test('backfill groups dependent links into atomic components fenced on every record the plan relied on',()=>{
  const plan=planOf(memory(legacySeed())),group=id=>plan.linkGroups.find(entry=>entry.ids.includes(id));
  assert.deepEqual(group('root-beta').ids,['child-beta','root-beta']);
  assert.deepEqual(group('alpha-repeat').writes.filter(write=>write.verify).map(write=>`${write.collection}/${write.id}@${write.revision}`).sort(),['customers/alpha@seed-customers/alpha','jobs/linked@seed-jobs/linked']);
  assert.deepEqual(group('legacy-contact').ids,['legacy-contact']);
  for(const entry of plan.linkGroups){
    assert.ok(entry.writes.filter(write=>!write.verify).every(write=>write.collection==='jobs'&&entry.ids.includes(write.id)&&write.revision));
    for(const id of entry.ids)assert.ok(entry.writes.some(write=>write.verify&&write.collection==='customers'&&write.id===plan.links.find(link=>link.id===id).customerId));
  }
  assert.deepEqual(plan.linkGroups.flatMap(entry=>entry.ids).sort(),plan.links.map(link=>link.id));
  const projectPlan=planCustomerIdentityBackfill({customers:[{id:'beta',revision:'b1',name:'Synthetic Beta',phone:'9705550102'}],jobs:[{id:'p-job',revision:'j1',type:'walkthrough',phone:'9705550102',customer:'Synthetic Beta',projectId:'project-beta'}],projects:new Map([['project-beta',{id:'project-beta',revision:'p1',customerId:'beta'}]])},NOW);
  assert.deepEqual(projectPlan.linkGroups[0].writes.filter(write=>write.verify).map(write=>write.collection+'/'+write.id).sort(),['customers/beta','projects/project-beta']);
});

test('backfill dry run is the default and writes nothing',async()=>{
  const f=memory(legacySeed()),before=structuredClone([...f.rows]);
  const report=await runCustomerIdentityBackfill(f.store,{now:NOW,runId:'dry'});
  assert.equal(report.mode,'dry_run');assert.equal(f.commits.length,0);assert.deepEqual([...f.rows],before);
  assert.deepEqual(report.writes,{planned:{customers:8,jobs:9},committed:{customers:0,jobs:0}});assert.equal(report.managerReview.required,true);assert.equal(report.managerReview.ambiguousJobs,3);assert.equal(report.managerReview.loneKeyLinks,7);
  assert.equal(f.rows.has('customerIdentityState/revision'),false);assert.equal(f.rows.has('dispatchState/revision'),false);
  assert.deepEqual(parseArgs([]),{apply:false,report:'',help:false});assert.equal(parseArgs(['--apply']).apply,true);assert.equal(parseArgs(['--report','out.json']).report,'out.json');
  for(const args of [['--apply','--dry-run'],['--force'],['--report']])assert.throws(()=>parseArgs(args));
});

test('backfill apply uses revision preconditions, skips ambiguous jobs, never merges customers and is idempotent',async()=>{
  const f=memory(legacySeed()),customersBefore=[...f.rows].filter(([key])=>key.startsWith('customers/')).map(([key,row])=>[key,row.name,row.phone,row.email,row.highlevelContactId]);
  const report=await runCustomerIdentityBackfill(f.store,{apply:true,now:NOW,runId:'apply-one',batchSize:2});
  assert.equal(report.mode,'apply');assert.equal(report.aborted,undefined);assert.deepEqual(report.writes.committed,{customers:8,jobs:9});
  for(const write of f.commits.flat())assert.ok(write.revision||(['customerIdentityState','dispatchState'].includes(write.collection)&&!write.verify),`${write.collection}/${write.id} has a precondition`);
  for(const commit of f.commits.filter(commit=>commit.some(write=>write.collection==='jobs'&&!write.verify))){
    for(const guard of ['customerIdentityState','dispatchState'])assert.ok(commit.some(write=>write.collection===guard&&write.verify),guard);
    for(const write of commit.filter(write=>write.collection==='jobs'&&!write.verify))assert.ok(commit.some(fence=>fence.collection==='customers'&&fence.id===write.patch.customerId&&fence.verify));
  }
  assert.ok(f.commits.some(commit=>commit.some(write=>write.id==='root-beta'&&!write.verify)&&commit.some(write=>write.id==='child-beta'&&!write.verify)),'a lineage component commits together');
  assert.equal(f.rows.get('customers/alpha').phoneE164,'+19705550101');assert.equal(f.rows.get('customers/alpha').emailLower,'alpha@example.invalid');assert.equal(f.rows.get('customers/bad-phone').phoneE164,'');
  assert.equal(f.rows.get('customers/done').revision,'seed-customers/done');assert.equal(f.rows.get('customers/legacy.customer@x').phoneE164,undefined);
  for(const [id,customerId] of LINKED)assert.equal(f.rows.get('jobs/'+id).customerId,customerId,id);
  for(const id of HELD)assert.equal(f.rows.get('jobs/'+id).customerId,undefined,id);
  assert.equal(f.rows.get('jobs/linked').customerId,'alpha');assert.equal(f.rows.get('jobs/linked').revision,'seed-jobs/linked');
  assert.deepEqual([...f.rows].filter(([key])=>key.startsWith('customers/')).map(([key,row])=>[key,row.name,row.phone,row.email,row.highlevelContactId]),customersBefore);
  assert.ok(f.writes().every(write=>write.collection!=='customers'||Object.keys(write.patch).every(key=>['phoneE164','emailLower','identityNormalizedAt'].includes(key))));
  const writes=f.writes().length,again=await runCustomerIdentityBackfill(f.store,{apply:true,now:'2026-09-23T12:00:00.000Z',runId:'apply-two'});
  assert.deepEqual(again.writes.planned,{customers:0,jobs:0});assert.equal(f.writes().length,writes);assert.equal(again.managerReview.ambiguousJobs,3);
});

test('backfill never gives a customer a second account root, so the signed handoff and Dispatch still create visits',async()=>{
  const plan=()=>({client:{name:'Synthetic Customer',phone:'9705550100',email:'test@example.invalid',address:'100 Fixture Lane',highlevel_contact_id:'provider1'},quote:{title:'Garage reset',total:1400,deposit:700,job_date:'2026-09-24',start_time:'09:00',end_time:'12:00',estimated_duration_min:180},acceptance:{accepted_at:'2026-09-22T11:45:00.000Z',accepted_by:'Synthetic Customer',signature_captured:true,method:'in_person_signature',terms_version:'2026-09-deposit50'},signature:'data:image/png;base64,iVBORw0KGgo=',terms_version:'2026-09-deposit50',terms_accepted:true,photos:{before:1},scope:{keep_items:'Blue bicycle'},discovery:{success:'Park a vehicle'},logistics:{crew_size:2,assigned_to:'Crew of 2',notes:''},internal_notes:'Keep the blue bicycle.',notes:'',client_checklists:{preJob:[],postJob:[]}});
  const customer={name:'Synthetic Customer',phone:'970-555-0100',email:'Test@example.invalid',highlevelContactId:'provider1',address:'100 Fixture Lane'};
  const visit=()=>({action:'schedule.create',requestId:randomUUID(),customerId:'c1',kind:'job',changes:{date:'2026-09-28',time:'08:00',endTime:'10:00',address:'100 Fixture Lane'}});
  // Two legacy histories would each become an account root; neither is linked.
  const f=memory({'customers/c1':customer,
    'jobs/legacy-a':{type:'job',phone:'9705550100',customer:'Synthetic Customer',date:'2025-05-01',status:'completed',address:'100 Fixture Lane'},
    'jobs/legacy-b':{type:'cleanout',email:'test@example.invalid',customer:'Synthetic Customer',date:'2025-06-01',status:'completed',address:'200 Other Lane'},
    'jobs/legacy-walk':{type:'walkthrough',phone:'9705550100',customer:'Synthetic Customer',address:'100 Fixture Lane'}});
  let report=await runCustomerIdentityBackfill(f.store,{apply:true,now:NOW,runId:'roots'});
  assert.deepEqual(report.jobs.conflicts.map(row=>[row.jobId,row.reason]),[['legacy-a','account_root_conflict'],['legacy-b','account_root_conflict']]);
  assert.equal(f.rows.get('jobs/legacy-walk').customerId,'c1');assert.equal(f.rows.get('jobs/legacy-a').customerId,undefined);assert.equal(f.rows.get('jobs/legacy-b').customerId,undefined);
  const handoff=await saveWalkthroughHandoff(f.store,manager,{requestId:randomUUID(),customerId:'c1',plan:plan()},NOW);assert.equal(handoff.ok,true);
  const created=await mutateDispatch(f.store,manager,visit(),NOW);assert.equal(f.rows.get('jobs/'+created.job.id).customerAccountOwnerJobId,handoff.job.id);
  // An existing dispatch chain keeps its single root: a legacy child of that root links, a legacy stand-alone job is held.
  const g=memory({'customers/c1':customer,'jobs/root':{type:'job',customerId:'c1',address:'100 Fixture Lane',date:'2026-01-05',status:'completed'},
    'jobs/legacy-root':{type:'job',phone:'9705550100',customer:'Synthetic Customer',address:'300 Third Lane'},
    'jobs/legacy-child':{type:'job',phone:'9705550100',customer:'Synthetic Customer',customerAccountOwnerJobId:'root'}});
  report=await runCustomerIdentityBackfill(g.store,{apply:true,now:NOW,runId:'chain'});
  assert.deepEqual(report.jobs.conflicts.map(row=>[row.jobId,row.reason]),[['legacy-root','account_root_conflict']]);assert.equal(g.rows.get('jobs/legacy-child').customerId,'c1');
  assert.equal((await saveWalkthroughHandoff(g.store,manager,{requestId:randomUUID(),customerId:'c1',plan:plan()},NOW)).ok,true);
  const next=await mutateDispatch(g.store,manager,visit(),NOW);assert.equal(g.rows.get('jobs/'+next.job.id).customerAccountOwnerJobId,'root');
});

test('backfill apply skips a whole lineage component when any record it relied on changes, and aborts on identity or schedule changes',async()=>{
  const f=memory(legacySeed());let raced=false;
  f.before(async writes=>{if(!raced&&writes.some(write=>write.id==='legacy-phone'&&!write.verify)){raced=true;f.rows.get('jobs/legacy-phone').revision='changed-by-dispatch';}});
  let report=await runCustomerIdentityBackfill(f.store,{apply:true,now:NOW,runId:'race',batchSize:10});
  assert.deepEqual(report.writes.changedDuringRun.jobs,['legacy-phone']);assert.equal(report.writes.committed.jobs,8);assert.equal(f.rows.get('jobs/legacy-phone').customerId,undefined);assert.equal(f.rows.get('jobs/legacy-email').customerId,'beta');
  report=await runCustomerIdentityBackfill(f.store,{apply:true,now:NOW,runId:'rerun'});assert.equal(report.writes.committed.jobs,1);assert.equal(f.rows.get('jobs/legacy-phone').customerId,'beta');
  // The account root of a chain is edited mid-run: neither the child nor the root is linked.
  const chain=memory({'customers/beta':{name:'Synthetic Beta',phone:'9705550102'},'jobs/a-child':{type:'job',phone:'9705550102',customer:'Synthetic Beta',customerAccountOwnerJobId:'z-root'},'jobs/z-root':{type:'job',phone:'9705550102',customer:'Synthetic Beta'}});
  let edited=false;chain.before(async writes=>{if(!edited&&writes.some(write=>write.id==='z-root')){edited=true;chain.rows.get('jobs/z-root').revision='edited';}});
  report=await runCustomerIdentityBackfill(chain.store,{apply:true,now:NOW,runId:'chain',batchSize:1});
  assert.deepEqual(report.writes.changedDuringRun.jobs,['a-child','z-root']);assert.equal(chain.rows.get('jobs/a-child').customerId,undefined);assert.equal(chain.rows.get('jobs/z-root').customerId,undefined);
  report=await runCustomerIdentityBackfill(chain.store,{apply:true,now:NOW,runId:'chain-rerun'});assert.deepEqual(report.writes.committed,{customers:0,jobs:2});
  // An already-linked relative the plan relied on changes: its dependent link is skipped.
  const fenced=memory(legacySeed());let touched=false;
  fenced.before(async writes=>{if(!touched&&writes.some(write=>write.id==='alpha-repeat')){touched=true;fenced.rows.get('jobs/linked').revision='owner-edited';}});
  report=await runCustomerIdentityBackfill(fenced.store,{apply:true,now:NOW,runId:'fence',batchSize:1});
  assert.deepEqual(report.writes.changedDuringRun.jobs,['alpha-repeat']);assert.equal(fenced.rows.get('jobs/alpha-repeat').customerId,undefined);
  const g=memory(legacySeed());let created=false;
  g.before(async writes=>{if(!created&&writes.some(write=>write.collection==='jobs')){created=true;g.rows.set('customers/new-beta-twin',{id:'new-beta-twin',phone:'9705550102',revision:'new'});g.rows.get('customerIdentityState/revision').revision='bumped-by-resolution';}});
  report=await runCustomerIdentityBackfill(g.store,{apply:true,now:NOW,runId:'identity-race'});
  assert.equal(report.aborted.code,'customer_identity_backfill_identity_changed');assert.equal(report.writes.committed.jobs,0);
  assert.ok([...g.rows].filter(([key])=>key.startsWith('jobs/')).every(([,row])=>row.customerId===undefined||['linked','alpha-child'].includes(row.id)));
  const d=memory(legacySeed());let scheduled=false;
  d.before(async writes=>{if(!scheduled&&writes.some(write=>write.collection==='jobs')){scheduled=true;d.rows.set('jobs/new-visit',{id:'new-visit',type:'job',customerId:'gamma',revision:'new'});d.rows.get('dispatchState/revision').revision='bumped-by-dispatch';}});
  report=await runCustomerIdentityBackfill(d.store,{apply:true,now:NOW,runId:'schedule-race',batchSize:1});
  assert.equal(report.aborted.code,'customer_identity_backfill_schedule_changed');assert.equal(report.writes.committed.jobs,0);assert.equal(d.rows.get('jobs/gamma-walkthrough').customerId,undefined);
  const h=memory(legacySeed());h.before(async writes=>{if(writes.some(write=>write.collection==='jobs'))throw Object.assign(new Error('lost'),{code:'dispatch_outcome_unknown',status:503});});
  report=await runCustomerIdentityBackfill(h.store,{apply:true,now:NOW,runId:'unknown'});assert.equal(report.aborted.code,'dispatch_outcome_unknown');
});

test('backfill report file replaces any earlier file so it is always private',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'egc-identity-')),path=join(dir,'report.json');
  try{
    await writeFile(path,'older report\n',{mode:0o644});await chmod(path,0o644);
    await writeReport(path,'{"mode":"dry_run"}');
    assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(await readFile(path,'utf8'),'{"mode":"dry_run"}\n');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('backfill storage scans complete masked pages and refuses partial or unverifiable pages',async()=>{
  const doc=(collection,id,fields)=>({name:`projects/egcw-1ec83/databases/(default)/documents/${collection}/${id}`,updateTime:'2026-09-22T11:00:00.000000Z',fields:encodeFirestoreFields(fields)}),urls=[];
  const fetcher=async(env,url)=>{urls.push(new URL(url));const token=new URL(url).searchParams.get('pageToken');return Response.json(token?{documents:[doc('customers','b',{phone:'9705550102'})]}:{documents:[doc('customers','a',{phone:'9705550101'})],nextPageToken:'page-2'});};
  const rows=await backfillStorage({},fetcher).customers();
  assert.deepEqual(rows.map(row=>[row.id,row.phone,row.revision]),[['a','9705550101','2026-09-22T11:00:00.000000Z'],['b','9705550102','2026-09-22T11:00:00.000000Z']]);
  assert.deepEqual(urls[0].searchParams.getAll('mask.fieldPaths'),['phone','email','phoneE164','emailLower','highlevelContactId','name','firstName','lastName','address']);
  for(const page of [{documents:{}},{documents:[{name:'customers/x'}]},{documents:[],nextPageToken:7},[]])await assert.rejects(backfillStorage({},async()=>Response.json(page)).customers(),error=>error.code==='customer_identity_backfill_storage_incomplete');
  await assert.rejects(backfillStorage({},async(env,url)=>Response.json({documents:[],nextPageToken:'same'})).jobs(),error=>error.code==='customer_identity_backfill_storage_incomplete');
  await assert.rejects(backfillStorage({},async()=>new Response('',{status:503})).jobs(),error=>error.code==='customer_identity_backfill_storage_unavailable');
});

test('backfill over Firestore REST: dry run sends no mutations; apply commits with updateTime preconditions and transaction fences',async()=>{
  const ROOT='projects/egcw-1ec83/databases/(default)/documents',docs=new Map(),posts=[];let tick=0;
  const stamp=()=>`2026-09-22T12:00:00.${String(++tick).padStart(6,'0')}Z`;
  const put=(path,fields)=>docs.set(path,{fields:structuredClone(fields),updateTime:stamp()});
  put('customers/alpha',{phone:'(970) 555-0101',email:'Alpha@example.invalid',highlevelContactId:'contact-alpha',name:'Synthetic Alpha'});
  put('customers/one',{phone:'9705550199'});put('customers/two',{phone:'+1 970 555 0199'});
  put('jobs/legacy',{type:'job',highlevelContactId:'contact-alpha'});put('jobs/shared',{type:'job',phone:'9705550199'});put('jobs/secure_vault',{employeeHubType:'profile'});
  const document=(path,mask)=>({name:`${ROOT}/${path}`,updateTime:docs.get(path).updateTime,fields:encodeFirestoreFields(mask?Object.fromEntries(Object.entries(docs.get(path).fields).filter(([key])=>mask.includes(key))):docs.get(path).fields)});
  const fetcher=async(env,input,options={})=>{
    const url=new URL(input),path=decodeURIComponent(url.pathname.split('/documents')[1]||'').replace(/^\//,''),body=options.body?JSON.parse(options.body):null;
    if(!options.method||options.method==='GET'){
      if(!path.includes('/'))return Response.json({documents:[...docs.keys()].filter(key=>key.startsWith(path+'/')).map(key=>document(key,url.searchParams.getAll('mask.fieldPaths')))});
      return docs.has(path)?Response.json(document(path)):new Response('{}',{status:404});
    }
    posts.push({action:url.pathname.split(':').pop(),body});
    if(url.pathname.endsWith(':beginTransaction'))return Response.json({transaction:'synthetic-tx'});
    if(url.pathname.endsWith(':rollback'))return Response.json({});
    if(url.pathname.endsWith(':batchGet'))return Response.json(body.documents.map(name=>{const key=name.slice(ROOT.length+1);return docs.has(key)?{found:{name,updateTime:docs.get(key).updateTime}}:{missing:name};}));
    for(const write of body.writes){const key=write.update.name.slice(ROOT.length+1),current=docs.get(key);if(write.currentDocument.exists===false?current:current?.updateTime!==write.currentDocument.updateTime)return new Response('{}',{status:412});}
    for(const write of body.writes){const key=write.update.name.slice(ROOT.length+1),fields={...docs.get(key)?.fields},patch=decodeFirestoreFields(write.update.fields);for(const field of write.updateMask.fieldPaths)fields[field]=patch[field];put(key,fields);}
    return Response.json({writeResults:[],commitTime:stamp()});
  };
  const store=backfillStorage({},fetcher),before=structuredClone([...docs]);
  const dry=await runCustomerIdentityBackfill(store,{now:NOW,runId:'rest-dry'});
  assert.equal(posts.length,0);assert.deepEqual([...docs],before);assert.deepEqual(dry.writes.planned,{customers:3,jobs:1});
  const applied=await runCustomerIdentityBackfill(store,{apply:true,now:NOW,runId:'rest-apply'});
  assert.equal(applied.aborted,undefined);assert.deepEqual(applied.writes.committed,{customers:3,jobs:1});
  const commits=posts.filter(post=>post.action==='commit');
  for(const commit of commits)for(const write of commit.body.writes)assert.ok(write.currentDocument.updateTime||/\/(customerIdentityState|dispatchState)\/revision$/.test(write.update.name)&&write.currentDocument.exists===false);
  const link=commits.find(commit=>commit.body.writes.some(write=>write.update.name.endsWith('/jobs/legacy')));
  assert.equal(link.body.transaction,'synthetic-tx');assert.deepEqual(link.body.writes.map(write=>write.updateMask.fieldPaths),[['customerId','customerLinkSource','customerLinkEvidence','customerLinkedAt']]);
  const fences=posts.filter(post=>post.action==='batchGet').flatMap(post=>post.body.documents.map(name=>name.slice(ROOT.length+1)));
  assert.deepEqual(fences.sort(),['customerIdentityState/revision','customers/alpha','dispatchState/revision']);
  assert.equal(docs.get('jobs/legacy').fields.customerId,'alpha');assert.equal(docs.get('jobs/shared').fields.customerId,undefined);assert.equal(docs.get('customers/alpha').fields.phoneE164,'+19705550101');assert.equal(docs.get('customers/alpha').fields.name,'Synthetic Alpha');
  const count=posts.length,again=await runCustomerIdentityBackfill(store,{apply:true,now:NOW,runId:'rest-again'});
  assert.deepEqual(again.writes.planned,{customers:0,jobs:0});assert.equal(posts.length,count);
});
