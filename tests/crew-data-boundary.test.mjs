import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {crewJobProjection} from '../functions/_lib/crew-job-projection.js';

test('legacy crew cards receive operational context without financial, signature or management data',()=>{
 const secret='PRIVATE-CANARY-DO-NOT-EXPOSE';
 const job={id:'job-a',type:'job',customer:'Test customer',date:'2026-09-22',time:'08:00',endTime:'10:00',status:'scheduled',address:'100 Test Street',phone:'9705550100',
  assignedCrew:['crew.one'],crewLead:'crew.one',crewNeeded:2,shiftPickupEnabled:true,openShift:true,shiftClaims:[{employee:'crew.one',claimedAt:'2026-09-22T00:00Z',sensitive:secret}],
  total:secret,priceQuoted:secret,deposit:{amount:secret},payment:{receipt:secret},invoice:{amount:secret},laborCost:secret,customerAcceptance:{signature:secret},
  internalNotes:secret,opsNotes:secret,operationNotes:[{body:secret}],apiKey:secret,
  jobInstructions:{customerGoal:'Organize the garage',accessNotes:'Use side door',customerNotes:'Keep blue bins',payroll:secret},
  customerConversation:[{id:'m',body:'Side door is open',authorName:'Test customer',delivery:{status:'sent',apiKey:secret},metadata:secret}],
  fieldExecution:{managerOnly:secret},__updateTime:'v1'};
 const dto=crewJobProjection(job),json=JSON.stringify(dto);
 assert.ok(!json.includes(secret));
 assert.equal(dto.customerGoal,'Organize the garage');
 assert.equal(dto.accessInstructions,'Use side door');
 assert.equal(dto.customerInstructions,'Keep blue bins');
 assert.deepEqual(dto.assignedCrew,['crew.one']);
 assert.equal(dto.shiftClaims[0].employee,'crew.one');
 assert.equal(dto.customerConversation[0].body,'Side door is open');
 assert.equal(dto.expectedRevision,'v1');
 assert.equal(dto.revision,'v1');
});

test('own availability projection excludes operational jobs, staff accounts and extra fields',()=>{
 const dto=crewJobProjection({id:'off',type:'availability',employee:'crew.one',date:'2026-09-22',time:'00:00',endTime:'23:59',allDay:true,status:'active',reason:'Unavailable',encrypted:'PRIVATE'});
 assert.equal(dto.employee,'crew.one');assert.equal(dto.allDay,true);assert.equal(dto.recordType,'crew_availability');
 assert.ok(!JSON.stringify(dto).includes('PRIVATE'));
});

test('canonical Firestore job grants cannot bypass server crew projection or completion gates',()=>{
 const rules=readFileSync(new URL('../firestore.rules',import.meta.url),'utf8');
 const job=rules.match(/match \/jobs\/\{documentId\} \{([\s\S]*?)\n    \}/)?.[1];
 const customer=rules.match(/match \/customers\/\{documentId\} \{([\s\S]*?)\n    \}/)?.[1];
 assert.ok(job);assert.doesNotMatch(job,/assignedToUser|assignedUpdateIsSafe/);
 assert.match(job,/allow read: if businessUser\(\) \|\| ownAvailability/);
 // SEC-A: manager SDK writes exclude server-owned receipts and encrypted records.
 // Every write method must also reject server-owned recordTypes on the stored and proposed document.
 assert.doesNotMatch(job,/allow [^:]*write:|allow create, update, delete:/);
 // JOB-COST-PRIVACY (updated deliberately): creates and updates also refuse adding or changing a job labor copy.
 // FUN-03: nor create or change a job's funnelSale (the sale the funnel ledger counts).
 assert.match(job,/allow create: if businessUser\(\) && !serverOwnedJobRecord\(documentId\) &&\s*!serverOwnedJobData\(request\.resource\.data, documentId\) &&\s*!\('funnelSale' in request\.resource\.data\) &&\s*jobLaborUnchanged\(request\.resource\.data, \{\}, documentId\);/);
 assert.match(job,/allow update: if businessUser\(\) && !serverOwnedJobRecord\(documentId\) &&\s*!serverOwnedJobData\(resource\.data, documentId\) &&\s*!serverOwnedJobData\(request\.resource\.data, documentId\) &&\s*!request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasAny\(\['funnelSale'\]\) &&\s*jobLaborUnchanged\(request\.resource\.data, resource\.data, documentId\);/);
 assert.match(job,/allow delete: if businessUser\(\) && !serverOwnedJobRecord\(documentId\) &&\s*!serverOwnedJobData\(resource\.data, documentId\);/);
 assert.match(rules.match(/function serverOwnedJobRecord\(documentId\) \{([\s\S]*?)\n    \}/)?.[1]||'',/matches\('\(secure_\|_egc_\)\.\*'\) && !documentId\.matches\('_egc_schedule_lock_\.\*'\)/);
 const ownedData=rules.match(/function serverOwnedJobData\(data, documentId\) \{([\s\S]*?)\n    \}/)?.[1]||'';
 for(const type of ['employee_hub_v2','employee_account_v1','schedule_operation','schedule_provider_receipt','schedule_adoption','operational_record_receipt']) assert.ok(ownedData.includes(`'${type}'`),type);
 assert.doesNotMatch(ownedData,/'crew_availability'/,'Manager PTO approvals still write crew_availability rows.');
 assert.match(ownedData,/recordType == 'schedule_lock' && !documentId\.matches\('_egc_schedule_lock_\.\*'\)/);
 // A new literal recordType in server code must be classified: deny it to SDK writes above, or
 // (only if browsers legitimately write it, or it lives outside jobs) list it here.
 const browserWritable=new Set(['schedule_lock','crew_availability']);
 const serverTypes=new Set();
 const functionsRoot=fileURLToPath(new URL('../functions/',import.meta.url));
 for(const entry of readdirSync(functionsRoot,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith('.js'))){
  for(const [,,type] of readFileSync(join(entry.parentPath,entry.name),'utf8').matchAll(/(recordType\s*:\s*|RECORD_TYPE\s*=\s*)['"]([a-z_0-9]+)['"]/g)) serverTypes.add(type);
 }
 for(const type of ['employee_hub_v2','employee_account_v1','operational_record_receipt','schedule_operation']) assert.ok(serverTypes.has(type),type);
 for(const type of serverTypes) assert.ok(browserWritable.has(type)||ownedData.includes(`'${type}'`),`server-owned jobs recordType ${type} must be denied to browser SDK writes`);
 assert.match(customer,/allow update: if businessUser\(\);/);
 assert.doesNotMatch(customer,/assignedCustomerCloseout/);
 // Emulator acceptance exercises actual grants separately.
});
