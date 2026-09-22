import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDispatchLineage, sameOperationalProperty } from '../functions/_lib/dispatch-lineage.js';

const job=(id,extra={})=>({id,type:'job',customerId:'c1',address:'100 Main Street',revision:`revision-${id}`,...extra});
function fixture(rows) {
  const records=new Map(rows.map(row=>[row.id,row])),reads=[];
  const store={read:async(collection,id)=>{assert.equal(collection,'jobs');reads.push(id);return structuredClone(records.get(id)||null);}};
  const check=(extra={})=>resolveDispatchLineage(store,{customerId:'c1',jobs:rows,address:'100 Main Street',...extra});
  return {records,reads,check};
}

test('one exact customer root inherits only access and property source pointers with revision checks',async()=>{
  const root=job('root',{giftWallet:{balance:500},customerCollaborators:[{id:'private'}],payment:{amount:100},customerMemory:{alarmNotes:'secret'}}),f=fixture([root,job('repeat',{customerAccountOwnerJobId:'root'})]);
  const result=await f.check();assert.deepEqual(result.patch,{customerAccountOwnerJobId:'root',customerMemoryInheritedFrom:'root'});
  assert.equal(result.metadata.selection,'unique_root');assert.equal(result.checks.length,2);assert.ok(result.checks.every(row=>row.verify&&row.revision));
  assert.deepEqual(f.reads,['root']);assert.equal(result.patch.giftWallet,undefined);assert.equal(result.patch.customerCollaborators,undefined);
});

test('no prior exact canonical customer never matches by phone, address or customer display name',async()=>{
  const f=fixture([job('different',{customerId:'other',phone:'9705550100',customer:'Same Person'})]);
  assert.deepEqual((await f.check()).patch,{});assert.deepEqual(f.reads,[]);
});

test('bounded ownership chains resolve one root and reject crosscustomer, cycles and missing records',async()=>{
  const f=fixture([job('one',{customerAccountOwnerJobId:'two'}),job('two',{customerAccountOwnerJobId:'root'}),job('root')]);
  assert.equal((await f.check()).patch.customerAccountOwnerJobId,'root');assert.equal(new Set(f.reads).size,f.reads.length);
  for(const rows of [[job('one',{customerAccountOwnerJobId:'other'}),job('other',{customerId:'other'})],[job('one',{customerAccountOwnerJobId:'two'}),job('two',{customerAccountOwnerJobId:'one'})],[job('one',{customerAccountOwnerJobId:'missing'})]])await assert.rejects(fixture(rows).check(),e=>e.code.startsWith('dispatch_lineage_'));
  const long=Array.from({length:14},(_,i)=>job(`n${i}`,{customerAccountOwnerJobId:i<13?`n${i+1}`:null}));
  await assert.rejects(fixture(long).check({sourceJobId:'n0'}),e=>e.code==='dispatch_lineage_depth');
});

test('multiple roots require explicit source choice instead of newest-job inference',async()=>{
  const f=fixture([job('first',{updatedAt:'2026-01-01'}),job('latest',{updatedAt:'2026-09-22'})]);
  await assert.rejects(f.check(),e=>e.code==='dispatch_lineage_selection_required'&&e.details.candidates.length===2&&e.details.candidates.every(row=>Object.keys(row).every(key=>['jobId','customerId','customer','address','date','rootJobId'].includes(key))));
  const selected=await f.check({sourceJobId:'first'});assert.equal(selected.patch.customerAccountOwnerJobId,'first');assert.equal(selected.metadata.selection,'explicit_source');
  await assert.rejects(f.check({sourceJobId:'secure_account'}),e=>e.code==='dispatch_lineage_invalid');
});

test('shared customer wallet does not imply shared property memory and ambiguous histories require choice',async()=>{
  const root=job('root',{address:'200 Other Street'}),prior=job('prior',{customerAccountOwnerJobId:'root'}),f=fixture([root,prior]);
  assert.deepEqual((await f.check()).patch,{customerAccountOwnerJobId:'root',customerMemoryInheritedFrom:'prior'});
  const different=await f.check({address:'300 Third Street'});assert.deepEqual(different.patch,{customerAccountOwnerJobId:'root'});assert.equal(different.metadata.memoryAddressMatches,false);
  const ambiguous=fixture([root,prior,job('another',{customerAccountOwnerJobId:'root'})]);
  await assert.rejects(ambiguous.check(),e=>e.code==='dispatch_lineage_selection_required');
  assert.equal((await ambiguous.check({sourceJobId:'prior'})).patch.customerMemoryInheritedFrom,'prior');
});

test('property IDs take priority while missing or differing addresses never count as the same property',()=>{
  assert.equal(sameOperationalProperty({propertyId:'p1',address:'Old label'},{propertyId:'p1',address:'New label'}),true);
  assert.equal(sameOperationalProperty({propertyId:'p1',address:'100 Main'},{propertyId:'p2',address:'100 Main'}),false);
  assert.equal(sameOperationalProperty({propertyId:'p1',address:'100 Main'},{address:'100 Main'}),false);
  assert.equal(sameOperationalProperty({address:' 100  MAIN Street '},{address:'100 Main Street'}),true);
  assert.equal(sameOperationalProperty({address:'100 Main Unit 1'},{address:'100 Main Unit 2'}),false);
  assert.equal(sameOperationalProperty({address:''},{address:''}),false);
});
