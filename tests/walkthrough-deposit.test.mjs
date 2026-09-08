import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const walkthrough=fs.readFileSync(new URL('../crew/gameplan.html',import.meta.url),'utf8');
const suite=fs.readFileSync(new URL('../employee-suite.js',import.meta.url),'utf8');
const sourceLine=(source,prefix)=>source.split(/\r?\n/).find(line=>line.startsWith(prefix));

test('walkthrough deposit uses half the total to cents and preserves verified receipts on revisions',()=>{
  const context=vm.createContext({});
  vm.runInContext(sourceLine(walkthrough,'function walkthroughDeposit('),context);
  assert.equal(context.walkthroughDeposit(1425).amount,712.5);
  assert.equal(context.walkthroughDeposit(1000.01).amount,500.01);
  const previous={amount:200,paidAmount:200,status:'paid',verified:true,reference:'stripe-200',receivedAt:'2026-09-08T12:00:00Z'};
  const revised=context.walkthroughDeposit(1000,previous);
  assert.equal(revised.amount,500);
  assert.equal(revised.paidAmount,200);
  assert.equal(revised.status,'partial');
  assert.equal(revised.reference,previous.reference);
  assert.equal(revised.verified,true);
  assert.equal(revised.receivedAt,previous.receivedAt);
  assert.equal(context.walkthroughDeposit(400,previous).status,'paid');
});

test('manual walkthrough total changes refresh the upfront and completion amounts before approval',()=>{
  const nodes={'deposit-summary':{textContent:''}},context=vm.createContext({S:{lockedPrice:'1000'},$:id=>nodes[id],recommend:()=>1000,invalidateAcceptance:()=>{},save:()=>{}});
  vm.runInContext([sourceLine(walkthrough,'function depositSummary('),sourceLine(walkthrough,'function updateField(')].join('\n'),context);
  context.updateField('lockedPrice','1425');
  assert.equal(context.S.priceManuallySet,true);
  assert.equal(nodes['deposit-summary'].textContent,'50% deposit due upfront: $712.50. Remaining $712.50 due on completion.');
});

function financeHarness(job,input=null){
  const captured={};
  const context=vm.createContext({window:{},jobs:()=>[job],financeDatePlus:()=> '2026-09-22',money:String,askAction:async options=>{captured.form=options;return input},patchJob:async(id,update)=>{captured.update=update},syncCustomerCommunication:async()=>true,render:()=>{},employeeIdentity:()=> 'ZacB'});
  vm.runInContext(suite.slice(suite.indexOf('window.opsFinanceAction='),suite.indexOf('function addCalendarMonths')),context);
  return{context,captured};
}

test('new finance estimates default to fifty percent while existing explicit deposit terms remain editable',async()=>{
  for(const [extra,expected] of [[{},712.5],[{estimate:{amount:1425,depositRequired:285}},285],[{deposit:{amount:0}},0]]){
    const h=financeHarness({id:'job',total:1425,...extra});
    await h.context.window.opsFinanceAction('job','estimate');
    assert.equal(h.captured.form.fields.find(field=>field.name==='deposit').value,expected);
  }
});

test('a deposit-only estimate revision requires fresh approval and retains money already received',async()=>{
  const h=financeHarness({id:'job',customer:'Test Customer',total:1000,estimate:{number:'EST-1',status:'accepted',amount:1000,scope:'Garage reset',depositRequired:200},deposit:{amount:200,paidAmount:200,status:'paid',reference:'receipt-200',verified:true}}, {amount:'1000',scope:'Garage reset',deposit:'500',validUntil:'2026-09-22'});
  await h.context.window.opsFinanceAction('job','estimate');
  assert.equal(h.captured.update.estimate.status,'draft');
  assert.equal(h.captured.update.customerApproval.status,'superseded');
  assert.equal(h.captured.update.estimate.depositRequired,500);
  assert.equal(h.captured.update.deposit.paidAmount,200);
  assert.equal(h.captured.update.deposit.status,'partial');
  assert.equal(h.captured.update.deposit.reference,'receipt-200');
});

test('recording a partial deposit defaults only to the unpaid required portion',async()=>{
  const h=financeHarness({id:'job',total:1000,deposit:{amount:500,paidAmount:200}});
  await h.context.window.opsFinanceAction('job','deposit');
  assert.equal(h.captured.form.fields.find(field=>field.name==='amount').value,300);
});

test('revising a quote supersedes a Stripe-created partial invoice even without an issue date',async()=>{
  const h=financeHarness({id:'job',customer:'Test Customer',total:1000,estimate:{number:'EST-1',status:'accepted',amount:1000,scope:'Garage reset'},deposit:{amount:500,paidAmount:500,status:'paid'},payment:{amount:500,verified:true},invoice:{amount:1000,status:'partial',paid:500,balance:500}}, {amount:'1500',scope:'Garage reset and shelving',deposit:'750',validUntil:'2026-09-22'});
  await h.context.window.opsFinanceAction('job','estimate');
  assert.equal(h.captured.update.invoice.status,'superseded');
  assert.equal(h.captured.update.invoice.paid,500);
  assert.equal(h.captured.update.estimate.amount,1500);
  assert.equal(h.captured.update.deposit.paidAmount,500);
  assert.equal(h.captured.update.payment,undefined,'a quote revision must not replace payment records');
});

test('a newly signed walkthrough revision refreshes approval and removes stale invoice authority',()=>{
  const context=vm.createContext({});
  vm.runInContext([sourceLine(walkthrough,'function walkthroughDeposit('),sourceLine(walkthrough,'function applyWalkthroughFinance(')].join('\n'),context);
  const previous={total:1000,scope:{finish:['cleanout']},deposit:{amount:500,paidAmount:500,reference:'receipt-500'},invoice:{amount:1000,status:'partial',paid:500,balance:500},customerApproval:{status:'superseded',amount:1000}};
  const job={total:1500,scope:{finish:['cleanout','shelving']},acceptance:{acceptedAt:'2026-09-08T18:00:00Z',acceptedBy:'Test Customer'},updatedAt:'2026-09-08T18:00:00Z'};
  context.applyWalkthroughFinance(job,previous);
  assert.equal(job.deposit.amount,750);
  assert.equal(job.deposit.paidAmount,500);
  assert.equal(job.deposit.reference,'receipt-500');
  assert.equal(job.invoice.status,'superseded');
  assert.equal(job.invoice.paid,500);
  assert.equal(job.customerApproval.status,'approved');
  assert.equal(job.customerApproval.amount,1500);
  assert.equal(job.quoteStatus,'approved');
  assert.equal(job.payment,undefined);
});

test('an accepted legacy estimate without a number still requires reapproval after revision',async()=>{
  const h=financeHarness({id:'job',customer:'Test Customer',total:1000,estimate:{status:'accepted',amount:1000,scope:'Garage reset'},customerApproval:{status:'approved',amount:1000},deposit:{amount:500,paidAmount:500},invoice:{amount:1000,status:'partial',paid:500,balance:500}}, {amount:'1500',scope:'Garage reset and shelving',deposit:'750',validUntil:'2026-09-22'});
  await h.context.window.opsFinanceAction('job','estimate');
  assert.equal(h.captured.update.estimate.status,'draft');
  assert.equal(h.captured.update.customerApproval.status,'superseded');
  assert.equal(h.captured.update.invoice.status,'superseded');
  assert.equal(h.captured.update.deposit.paidAmount,500);
});

test('finance rejects nonfinite totals and deposits outside the quote total before saving',async()=>{
  for(const [amount,deposit] of [['Infinity','500'],['not-a-number','500'],['1000','1001'],['1000','Infinity'],['1000','-1']]){
    const h=financeHarness({id:'job',total:1000},{amount,deposit,scope:'Garage reset'});
    await h.context.window.opsFinanceAction('job','estimate');
    assert.equal(h.captured.update,undefined,`${amount} total / ${deposit} deposit must not save`);
  }
});
