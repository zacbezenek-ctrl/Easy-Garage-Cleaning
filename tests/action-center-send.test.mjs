import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Runs the real Action Center module and checks when the one-tap Send now is offered.
// The server re-checks all of this; the Hub must simply never offer a send it would refuse.
const source=readFileSync(new URL('../employee-operations.js',import.meta.url),'utf8');
const window={addEventListener(){}};
vm.runInNewContext(source,{window,URL,Intl,console},{filename:'employee-operations.js'});
const {sendEligibility,sendStarted}=window.EGCActionCenter.send;
const NOW=Date.parse('2026-10-01T15:00:00.000Z');
const links=[{kind:'portal_quote',url:'https://easygaragecleaning.com/portal/quote/synthetic-1',label:'Your quote',refId:null}];
const draft=(extra={})=>({channel:'sms',fromNumber:'+15555551644',recipient:'+15555550100',subject:'',body:'Synthetic approved message',sendWindowStart:'2026-10-01T14:00:00.000Z',sendWindowEnd:'2026-10-02T02:00:00.000Z',attachments:links,...extra});
const result=(task={},extra={})=>({task:{id:'synthetic-task',kind:'send_quote',status:'open',assignedUserId:'synthetic-sales',revision:1,draftPayload:draft(),...task},effectiveApproval:'approved',actionSend:{available:true,smsFromNumbers:['+15555551644','+15555551818']},previewHash:'a'.repeat(64),...extra});
const owner={id:'synthetic-owner',role:'owner'},manager={id:'synthetic-manager',role:'manager'},sales={id:'synthetic-sales',role:'sales'},otherSales={id:'other-sales',role:'sales'};
const reason=(r,actor=owner,now=NOW)=>sendEligibility(r,actor,now).reason;

test('an approved, fully visible message inside its window is sendable by a manager or its own owner',()=>{
  for(const actor of [owner,manager,sales])assert.deepEqual({...sendEligibility(result(),actor,NOW)},{ok:true,reason:'ready'});
  assert.equal(reason(result(),otherSales),'not_owner');assert.equal(reason(result(),{id:'synthetic-crew',role:'crew'}),'not_owner');assert.equal(reason(result(),null),'not_owner');
  assert.equal(reason(result({status:'in_progress'})),'ready');
});
test('nothing is offered while the backend has one-tap sending off',()=>{
  for(const extra of [{actionSend:{available:false}},{actionSend:undefined},{actionSend:{available:'true'}}])assert.equal(reason(result({},extra)),'disabled');
});
test('only an approved message action that is still open can be sent',()=>{
  for(const effectiveApproval of ['pending','invalidated_or_expired','rejected','not_required'])assert.equal(reason(result({},{effectiveApproval})),'not_approved');
  for(const status of ['blocked','completed','cancelled'])assert.equal(reason(result({status})),'not_sendable');
  assert.equal(reason(result({kind:'callback',draftPayload:null})),'not_sendable');
});
test('a draft the Hub cannot show in full is never offered',()=>{
  for(const d of [draft({attachments:[{...links[0],url:'http://easygaragecleaning.com/q'}]}),draft({signedUrl:'https://example.com/secret'}),draft({attachments:[{...links[0],label:''}]})])assert.equal(reason(result({draftPayload:d})),'not_reviewable');
});
test('the send window is enforced at the exact instants, not the device day',()=>{
  const r=result();
  assert.equal(reason(r,owner,Date.parse('2026-10-01T14:00:00.000Z')),'ready');
  assert.equal(reason(r,owner,Date.parse('2026-10-01T13:59:59.999Z')),'window_not_open');
  assert.equal(reason(r,owner,Date.parse('2026-10-02T01:59:59.999Z')),'ready');
  assert.equal(reason(r,owner,Date.parse('2026-10-02T02:00:00.000Z')),'window_expired');
  assert.equal(reason(result({draftPayload:draft({sendWindowEnd:'not a time'})})),'window_expired');
});
test('once the current revision’s send started, only a status check is offered, even after its approval was invalidated',()=>{
  const started=(revision=1)=>({history:[{type:'draft.approved',revision:1},{type:'message.execution_started',revision,evidence:{executionId:'synthetic-execution'}}]});
  assert.equal(sendStarted(result({},started())),true);assert.equal(sendStarted(result({revision:2},started(1))),false);assert.equal(sendStarted(result()),false);assert.equal(sendStarted(result({},{history:'broken'})),false);
  for(const actor of [owner,manager,sales])assert.equal(reason(result({},started()),actor),'check_status');
  // The sent message itself invalidates the approval; the window may have closed; neither blocks a read-back.
  assert.equal(reason(result({},{...started(),effectiveApproval:'invalidated_or_expired'})),'check_status');
  assert.equal(reason(result({},started()),owner,Date.parse('2026-10-03T00:00:00.000Z')),'check_status');
  // An edit made a new revision: that one has not been sent, so the normal rules apply.
  assert.equal(reason(result({revision:2},{...started(1),effectiveApproval:'pending'})),'not_approved');
  assert.equal(reason(result({},started()),otherSales),'not_owner');assert.equal(reason(result({status:'blocked'},started())),'not_sendable');assert.equal(reason(result({status:'completed'},started())),'not_sendable');
  assert.equal(reason(result({},{...started(),actionSend:{available:false}})),'disabled');
});

test('missing, malformed and unconfigured SMS sender cannot be newly sent',()=>{
 for(const fromNumber of [undefined,null,'','+1 555 555 1644','+15555559999'])assert.equal(reason(result({draftPayload:draft({fromNumber})})),'not_reviewable');
 assert.equal(reason(result({draftPayload:draft({fromNumber:'+15555551818'})})),'ready');
 assert.equal(reason(result({},{actionSend:{available:true,smsFromNumbers:[]}})),'not_reviewable');
 const legacy=result({draftPayload:draft({fromNumber:undefined})},{history:[{type:'message.execution_started',revision:1}]});assert.equal(reason(legacy),'check_status');
});
