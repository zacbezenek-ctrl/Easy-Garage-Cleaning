/* FIX-MONEY-TOTALS: one integer-cent total on the Hub finance board. With
   MONEY_UNIFIED_TOTALS=true (/api/integration-status flags.unifiedTotals) the
   board, its balances and its printed fallbacks read money-core's unified
   totals (functions/_lib/money-core.js customerMoneyTotals(job, {unified:
   true})) through this pure module: the quote plus the billed change-order
   lines only, the money applied to the service (tips never count) and the
   balance. An approval recorded without a billed line is never counted; it is
   flagged change_order_unbilled on the finance row. Money that cannot be read
   (by the portal checkout's own rule, customer-payments unifiedTotals: an
   unreadable deposit term counts only while the deposit is due) keeps the
   board's own figures and is flagged for review; a job with no quote saved
   yet (money-core moneyUnpriced) keeps them too, with no review flag.
   With the flag off (or 'shadow', which serves today's numbers) the board is
   exactly as before. The board reads this browser copy of money-core even
   with MONEY_API_ENABLED on (it needs every job at once; /api/money serves
   one job): tests/money-totals.test.mjs ('the Hub board module matches
   money-core to the cent') pins every figure, issue and review flag to
   money-core and the portal. */
(function(){
'use strict';
const MAX=100000000,KEY='egc.moneyTotals.unified';
const S={enabled:false};
try{S.enabled=sessionStorage.getItem(KEY)==='true';}catch{}
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clean=(value,max)=>String(value||'').replace(/[\r\n\t]/g,' ').trim().slice(0,max);
const given=value=>value!==undefined&&value!==null&&value!=='';
// operations-financials moneyCents: whole cents, never negative; unknown stays null. Capped at $1,000,000 like money-core.
function cents(value){
  if(!given(value))return null;
  if(typeof value==='string'&&!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))return null;
  const n=Number(value);
  if(!(Number.isFinite(n)&&n>=0&&Number.isSafeInteger(Math.round(n*100))))return null;
  const whole=Math.round(n*100);return whole>MAX?null:whole;
}
const at=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const SESSION=/^cs_(?:test_|live_)?[A-Za-z0-9_]+$/,INTENT=/^pi_[A-Za-z0-9_]+$/;
// change-orders.js billedChangeOrders: unvoided whole-cent customer-decision lines, once per decision.
const lineId=decisionId=>'change-'+clean(decisionId,60).replace(/[^A-Za-z0-9_-]/g,'');
function billed(job){
  const seen=new Set(),lines=[];
  for(const line of Array.isArray(job?.changeOrders)?job.changeOrders:[]){
    if(!plain(line)||line.status==='void'||line.voidedAt||line.kind!=='fee'||line.source!=='customer_decision'||typeof line.decisionId!=='string'||!line.decisionId||line.id!==lineId(line.decisionId))continue;
    if(!Number.isSafeInteger(line.totalCents)||line.totalCents<=0||line.totalCents>MAX||seen.has(line.decisionId)||seen.has(line.id))continue;
    seen.add(line.decisionId);seen.add(line.id);lines.push(line);
  }
  return lines;
}
const UNREADABLE=['money_quote_invalid','money_change_order_invalid','money_paid_invalid','money_tips_unknown','money_deposit_invalid'];
const saved=(lines,id)=>typeof id==='string'&&id!==''&&lines.some(line=>plain(line)&&(line.decisionId===id||line.id===lineId(id)));
function unbilled(job,billedCents){
  const lines=Array.isArray(job?.changeOrders)?job.changeOrders:[],stored=given(job?.approvedChangeTotal)?cents(job.approvedChangeTotal):null;
  const open=(Array.isArray(job?.customerDecisions)?job.customerDecisions:[]).some(item=>plain(item)&&item.status==='approved'&&!item.changeOrderVoidedAt&&!saved(lines,item.id)&&given(item.priceDelta)&&cents(item.priceDelta)!==0);
  return open||stored!==null&&billedCents!==null&&stored>billedCents;
}
// operations-financials uniqueReceipts: receipts sharing a session or PaymentIntent are one payment; copies that disagree conflict.
function uniqueReceipts(rows){
  const parents=new Map(),root=key=>{if(!parents.has(key))parents.set(key,key);let found=key;while(parents.get(found)!==found)found=parents.get(found);return found;};
  const keys=row=>[row.paymentIntentId&&INTENT.test(row.paymentIntentId)?'intent:'+row.paymentIntentId:null,row.sessionId&&/^cs_(?:live_)?[A-Za-z0-9_]+$/.test(row.sessionId)?'session:'+row.sessionId:null].filter(Boolean);
  for(const row of rows){const ids=keys(row);for(const id of ids.slice(1))parents.set(root(id),root(ids[0]));}
  const groups=new Map();for(const row of rows){const id=root(keys(row)[0]||row.key);groups.set(id,[...(groups.get(id)||[]),row]);}
  const unique=[];let conflicts=0;
  for(const group of groups.values()){if(group.some(row=>row.amountCents!==group[0].amountCents||row.at!==group[0].at))conflicts++;else unique.push(group[0]);}
  return{unique,conflicts};
}
// money-core paymentLedger: what was received (tips included) and what the tips were; null when unknown.
function received(job){
  const payment=plain(job?.payment)?job.payment:{},verified=payment.verified===true,cards=[];
  if(verified)for(const item of Array.isArray(payment.stripeSessions)?payment.stripeSessions:[]){
    const row=plain(item)?item:{sessionId:String(item||'')},sessionId=SESSION.test(row.sessionId||'')?row.sessionId:'',intentId=INTENT.test(row.paymentIntentId||'')?row.paymentIntentId:'';
    if(!sessionId&&!intentId)continue;
    const kind=['deposit','balance','tip'].includes(row.purpose)?row.purpose:'balance';
    cards.push({sessionId:sessionId||null,paymentIntentId:intentId||null,amountCents:cents(row.amount),at:`${at(row.verifiedAt)}|${kind}`,kind,id:'stripe:'+(sessionId||intentId)});
  }
  const receipts=uniqueReceipts(cards),ids=new Set(),tips=[];
  for(const card of receipts.unique){if(ids.has(card.id))continue;ids.add(card.id);if(card.kind==='tip')tips.push(card.amountCents);}
  let separate=0;const rows=Array.isArray(payment.tips)?payment.tips:[];
  if(payment.tips!==undefined&&payment.tips!==null&&!Array.isArray(payment.tips))separate=null;
  if(rows.length&&!verified)separate=null;
  const byRef=new Map();
  if(verified)for(const item of rows){
    const row=plain(item)?item:{},sessionId=SESSION.test(row.sessionId||'')?row.sessionId:'',intentId=INTENT.test(row.paymentIntentId||'')?row.paymentIntentId:'';
    const stored=Number.isSafeInteger(row.amountCents)&&row.amountCents>0&&row.amountCents<=MAX?row.amountCents:null,dollars=row.amount===undefined?stored:cents(row.amount),amount=stored!==null&&dollars===stored?stored:null;
    if(!sessionId&&!intentId){separate=null;continue;}
    const earlier=[sessionId,intentId].filter(Boolean).map(ref=>byRef.get(ref)).find(value=>value!==undefined);
    if(earlier!==undefined){if(earlier!==amount)separate=null;continue;}
    const id='tip:'+(sessionId||intentId);
    [sessionId,intentId].filter(Boolean).forEach(ref=>byRef.set(ref,amount));
    if(!ids.has(id)){ids.add(id);tips.push(amount);}
    separate=separate===null||amount===null?null:separate+amount;
  }
  const raw=payment.amount??job?.invoice?.paid??job?.invoice?.amountPaid??job?.deposit?.paidAmount,recorded=raw===undefined||raw===null?0:cents(raw);
  const paid=recorded===null||separate===null?null:recorded+separate;
  const tipCents=receipts.conflicts&&cards.some(card=>card.kind==='tip')||separate===null||tips.includes(null)?null:tips.reduce((sum,value)=>sum+value,0);
  return{paid,tips:tipCents};
}
/** money-core customerMoneyTotals(job, {unified: true}): every figure in whole cents, null when unknown. */
function totals(job){
  const issues=[],quoteRaw=job?.estimate?.amount??job?.total??job?.priceQuoted??job?.lockedTotal??job?.rate??job?.customerApproval?.amount;
  const quoteCents=quoteRaw===undefined||quoteRaw===null?null:cents(quoteRaw),lines=billed(job),sum=lines.reduce((total,line)=>total+line.totalCents,0),changeCents=sum>MAX?null:sum;
  if(quoteCents===null)issues.push(quoteRaw===undefined||quoteRaw===null?'money_quote_missing':'money_quote_invalid');
  if(changeCents===null)issues.push('money_change_order_invalid');
  if(unbilled(job,changeCents))issues.push('change_order_unbilled');
  const money=received(job),known=(...values)=>values.every(value=>value!==null);
  if(money.paid===null)issues.push('money_paid_invalid');
  if(money.tips===null)issues.push('money_tips_unknown');
  const totalCents=known(quoteCents,changeCents)?quoteCents+changeCents:null,appliedCents=known(money.paid,money.tips)?Math.max(0,money.paid-money.tips):null;
  const balanceCents=known(totalCents,appliedCents)?Math.max(0,totalCents-appliedCents):null;
  const savedDeposit=job?.estimate?.depositRequired??job?.deposit?.amount,depositSaved=savedDeposit===undefined||savedDeposit===null?undefined:cents(savedDeposit);
  if(depositSaved===null)issues.push('money_deposit_invalid');
  const depositRequiredCents=quoteCents===null||depositSaved===null?null:Math.min(quoteCents,depositSaved===undefined?Math.round(quoteCents*5000/10000):depositSaved);
  const depositPaidCents=known(depositRequiredCents,appliedCents)?Math.min(depositRequiredCents,appliedCents):null,depositDueCents=known(depositRequiredCents,appliedCents)?Math.max(0,depositRequiredCents-appliedCents):null;
  const stage=String(job?.pipelineStatus||job?.status||'').toLowerCase(),walked=(Array.isArray(job?.postJobProgress?.standardItems)?job.postJobProgress.standardItems:[]).some(item=>item?.key==='0_1'&&item.completed===true);
  const closing=['completed','paid'].includes(stage)||Boolean(job?.completedAt||job?.postJobChecklist?.completedAt||walked),dueNowCents=closing?balanceCents:depositDueCents;
  return{quoteCents,approvedChangeCents:changeCents,totalCents,paidCents:money.paid,tipCents:money.tips,appliedCents,balanceCents,overpaidCents:known(totalCents,appliedCents)?Math.max(0,appliedCents-totalCents):null,
    depositRequiredCents,depositPaidCents,depositDueCents,dueNowCents,purpose:closing?'balance':'deposit',remainderCents:known(balanceCents,dueNowCents)?Math.max(0,balanceCents-dueNowCents):null,issues};
}
/** money-core moneyUnpriced: no quote saved yet while every other amount reads (today's board, no review flag). */
const unpriced=money=>money.issues.includes('money_quote_missing')&&!money.issues.some(issue=>UNREADABLE.includes(issue));
/** customer-payments unifiedTotals, the one "needs review" rule: the total, the money applied, the balance, what is due now and the remainder read, and the deposit terms too while the deposit is what is due (an unreadable deposit term never holds up a completed job's balance). */
const NEEDED=['totalCents','appliedCents','balanceCents','dueNowCents','remainderCents'],DEPOSIT=['depositRequiredCents','depositPaidCents','depositDueCents'];
const readable=money=>[...NEEDED,...(money.purpose==='deposit'?DEPOSIT:[])].every(key=>Number.isSafeInteger(money[key]));
/** The suite's financeState on the unified totals (null while the flag is off). `legacy` is the board's own state; `today` a Denver date. */
function financeState(job,legacy,today){
  if(!S.enabled||!plain(job)||!plain(legacy))return null;
  const money=totals(job),unbilledChange=money.issues.includes('change_order_unbilled');
  if(!readable(money))return{...legacy,unbilledChange,moneyReview:!unpriced(money)};
  const paid=money.appliedCents/100,verified=job.payment?.verified===true,balance=money.balanceCents/100,dueDate=legacy.dueDate||'',base=job.invoice?.status||'not issued';
  const invoice=balance>0&&dueDate&&dueDate<today&&!['paid','void','superseded'].includes(base)?'overdue':base;
  return{...legacy,total:money.totalCents/100,paid,verifiedPaid:verified?paid:0,pendingPaid:verified?0:paid,balance,invoice,approvedChanges:money.approvedChangeCents/100,unbilledChange,moneyReview:false};
}
function configure(flags){S.enabled=flags?.unifiedTotals===true;try{sessionStorage.setItem(KEY,String(S.enabled));}catch{}}
window.addEventListener?.('egc:signout',()=>{S.enabled=false;try{sessionStorage.removeItem(KEY);}catch{}});
window.EGCMoneyTotals={configure,enabled:()=>S.enabled,totals,financeState};
})();
