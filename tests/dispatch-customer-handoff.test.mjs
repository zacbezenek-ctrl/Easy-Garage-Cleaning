import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchHandlers } from '../functions/api/dispatch.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const LOCATION = 'location-synthetic';
const URL = `https://app.gohighlevel.com/v2/location/${LOCATION}/contacts/detail/contact-synthetic`;
const actors = [
  {user:'ZacB',role:'owner',businessAccess:true},
  {user:'TylerG',role:'manager',businessAccess:true},
  {user:'sales.one',role:'sales',staffRoles:['sales'],businessAccess:false},
  {user:'phone.one',role:'phone',staffRoles:['phone'],businessAccess:false},
];

function fixture({jobPatch={},jobReadPatch={},customerPatch={},customerMissing=false,failCustomer=false}={}) {
  const job={id:'visit-synthetic',revision:'job-r1',type:'walkthrough',customerId:'customer-synthetic',customer:'Stale job label',phone:'0000000000',highlevelContactId:'contact-synthetic',date:'2026-09-23',time:'08:00',endTime:'09:00',status:'scheduled',assignedCrew:[],...jobPatch};
  const customer={id:'customer-synthetic',revision:'customer-r1',name:'Verified Customer',phone:'+19705550123',highlevelContactId:'contact-synthetic',...customerPatch};
  const reads=[];
  let jobReads=0;
  const store={
    jobs:async()=>[structuredClone(job)],resources:async()=>[],roster:async()=>[],settings:async()=>({}),customers:async()=>customerMissing?[]:[structuredClone(customer)],
    read:async(collection,id)=>{
      reads.push([collection,id]);
      if(collection==='jobs'&&id===job.id)return structuredClone({...job,...(++jobReads>1?jobReadPatch:{})});
      if(collection==='customers'&&id===job.customerId){if(failCustomer)throw new Error('storage unavailable');return customerMissing?null:structuredClone(customer);}
      return null;
    },
  };
  const request=(query='view=job&jobId=visit-synthetic')=>new Request(`https://easygaragecleaning.com/api/dispatch?${query}`);
  const get=async(actor=actors[0],env={EGC_STAFF_ROLE_ACCESS:'true',HIGHLEVEL_LOCATION_ID:LOCATION},query)=>{
    const response=await dispatchHandlers({session:async()=>actor,storage:()=>store,travel:()=>null,now:()=>NOW}).get({request:request(query),env});
    return {status:response.status,body:await response.json()};
  };
  return {get,reads};
}

test('job detail gives authorized office roles the persisted customer and exact verified HighLevel link',async()=>{
  const f=fixture();
  for(const actor of actors){
    const {status,body}=await f.get(actor,undefined,'view=job&jobId=visit-synthetic&highlevelContactId=attacker');
    assert.equal(status,200,actor.role);
    assert.equal(body.job.id,'visit-synthetic');
    assert.deepEqual(body.customerHandoff,{name:'Verified Customer',phone:'+19705550123',highlevelContactUrl:URL,reasonCode:null},actor.role);
  }
  assert.ok(f.reads.some(([collection,id])=>collection==='customers'&&id==='customer-synthetic'));
  for(const query of ['startDate=2026-09-23&endDate=2026-09-24','view=customers&q=Verified']){
    const {status,body}=await f.get(actors[0],undefined,query);
    assert.equal(status,200);
    assert.equal(Object.hasOwn(body,'customerHandoff'),false,'other Dispatch views retain their response shape');
  }
});

test('conflicting, missing, invalid and unconfigured links omit the contact URL without failing the job view',async()=>{
  const scenarios=[
    [{customerPatch:{highlevelContactId:'different-contact'}},'contact_link_conflict'],
    [{jobPatch:{highlevelContactId:''}},'contact_unlinked'],
    [{jobPatch:{highlevelContactId:'bad/contact'},customerPatch:{highlevelContactId:'bad/contact'}},'contact_link_invalid'],
    [{jobPatch:{customerId:''}},'customer_unlinked'],
    [{customerMissing:true},'customer_missing'],
    [{failCustomer:true},'customer_unavailable'],
    [{jobReadPatch:{revision:'job-r2',highlevelContactId:'changed-contact'}},'job_changed'],
  ];
  for(const [options,reasonCode] of scenarios){
    const {status,body}=await fixture(options).get();
    assert.equal(status,200,reasonCode);
    assert.equal(body.customerHandoff.highlevelContactUrl,'',reasonCode);
    assert.equal(body.customerHandoff.reasonCode,reasonCode);
  }
  const {status,body}=await fixture().get(actors[0],{EGC_STAFF_ROLE_ACCESS:'true'});
  assert.equal(status,200);
  assert.equal(body.customerHandoff.reasonCode,'location_unconfigured');
  assert.equal(body.customerHandoff.highlevelContactUrl,'');
});
