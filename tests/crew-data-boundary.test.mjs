import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
 assert.match(job,/allow create, update, delete: if businessUser\(\);/);
 assert.match(customer,/allow update: if businessUser\(\);/);
 assert.doesNotMatch(customer,/assignedCustomerCloseout/);
 // Emulator acceptance exercises actual grants separately.
});
