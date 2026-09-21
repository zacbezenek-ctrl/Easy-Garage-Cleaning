import {firestoreFetch} from './firebase-service-account.js';
import {decodeFirestoreFields} from './firestore-job.js';
const BASE='https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents/jobs';
const instant=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export function moneyCents(value){if(value===null||value===undefined||value==='')return null;if(typeof value==='string'&&!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))return null;const n=Number(value);return Number.isFinite(n)&&n>=0&&Number.isSafeInteger(Math.round(n*100))?Math.round(n*100):null;}
const accepted=value=>['accepted','approved'].includes(String(value||'').toLowerCase());
const jobEligible=job=>job.type==='job'&&!job.recordType&&!/^(secure_|_egc_)/.test(job.id||'')&&job.isTest!==true&&job.test!==true;
export function uniqueReceipts(receipts){const parents=new Map(),root=k=>{if(!parents.has(k))parents.set(k,k);let r=k;while(parents.get(r)!==r)r=parents.get(r);return r;};const keys=r=>[r.paymentIntentId&&/^pi_[A-Za-z0-9_]+$/.test(r.paymentIntentId)?'intent:'+r.paymentIntentId:null,r.sessionId&&/^cs_(?:live_)?[A-Za-z0-9_]+$/.test(r.sessionId)?'session:'+r.sessionId:null].filter(Boolean);
  for(const r of receipts){const ids=keys(r);for(const id of ids.slice(1))parents.set(root(id),root(ids[0]));}const groups=new Map();for(const r of receipts){const id=root(keys(r)[0]||r.key);groups.set(id,[...(groups.get(id)||[]),r]);}const unique=[],conflicts=[];for(const[id,rows]of groups){if(rows.some(r=>r.amountCents!==rows[0].amountCents||r.at!==rows[0].at))conflicts.push(id);else unique.push(rows[0]);}return{unique,conflicts};}
export function financialFacts(job){
  const exceptions=[],timeline=[];if(!jobEligible(job))return{eligible:false,exceptions,timeline,quote:null,completion:null,payments:[],staffPayments:[]};
  const ca=job.customerApproval||{},estimate=job.estimate||{},approval=accepted(ca.status)?ca:accepted(estimate.status)?estimate:null;
  let quote=null;
  if(approval){const at=instant(approval.approvedAt||approval.acceptedAt),amountCents=moneyCents(approval.amount);if(!at)exceptions.push('approved_quote_date_unknown');if(amountCents===null)exceptions.push('approved_quote_value_unknown');quote={at,amountCents,source:approval===ca?'customer_approval':'accepted_estimate',revision:estimate.revision??null};if(at)timeline.push({id:`${job.id}:quote:${estimate.revision??at}`,kind:'quote_approved',at,data:{amountCents,currency:'USD',source:quote.source,portalJobId:job.id}});}
  if(accepted(ca.status)&&accepted(estimate.status)&&moneyCents(ca.amount)!==null&&moneyCents(estimate.amount)!==null&&moneyCents(ca.amount)!==moneyCents(estimate.amount)){exceptions.push('approved_quote_values_conflict');if(quote)quote.amountCents=null;for(const event of timeline)if(event.kind==='quote_approved')event.data.amountCents=null;}
  const completeAt=instant(job.completedAt||job.postJobChecklist?.completedAt);
  const completed=Boolean(completeAt)||['completed','paid','closed','review_requested'].includes(String(job.pipelineStatus||job.status||'').toLowerCase());
  let completion=null;
  if(completed){let amountCents=quote?.amountCents??null;if(!completeAt)exceptions.push('completion_date_unknown');if(!quote?.at||!completeAt||Date.parse(quote.at)>Date.parse(completeAt)){amountCents=null;exceptions.push('completion_approved_value_unknown');}completion={at:completeAt,amountCents};if(completeAt)timeline.push({id:`${job.id}:completed`,kind:'job_completed',at:completeAt,data:{amountCents,currency:'USD',portalJobId:job.id}});}
  const invoiceAt=instant(job.invoice?.issuedAt);if(invoiceAt)timeline.push({id:`${job.id}:invoice:${job.invoice?.number||invoiceAt}`,kind:'invoice_issued',at:invoiceAt,data:{amountCents:moneyCents(job.invoice?.amount),currency:'USD',status:job.invoice?.status||'unknown',portalJobId:job.id}});
  const payment=job.payment||{},payments=[],staffPayments=[];
  if(payment.verified===true&&Array.isArray(payment.stripeSessions))for(const item of payment.stripeSessions){
    if(!item||typeof item!=='object'){exceptions.push('payment_receipt_details_unknown');continue;}
    if(String(item.sessionId||'').startsWith('cs_test_'))continue;
    const key=typeof item.paymentIntentId==='string'&&/^pi_[A-Za-z0-9_]+$/.test(item.paymentIntentId)?item.paymentIntentId:typeof item.sessionId==='string'&&/^cs_(?:live_)?[A-Za-z0-9_]+$/.test(item.sessionId)?item.sessionId:null;
    const at=instant(item.verifiedAt),amountCents=moneyCents(item.amount);
    if(!key||!at||amountCents===null){exceptions.push('payment_receipt_details_unknown');continue;}
    const receipt={key,sessionId:item.sessionId||null,paymentIntentId:item.paymentIntentId||null,at,amountCents,portalJobId:job.id};payments.push(receipt);timeline.push({id:'stripe:'+key,kind:'payment_verified',at,data:{amountCents,currency:'USD',processor:'stripe',evidenceId:key,portalJobId:job.id}});
  }
  const deduped=uniqueReceipts(payments);if(deduped.conflicts.length)exceptions.push('payment_receipts_conflict');
  const observedCents=deduped.unique.reduce((sum,p)=>sum+p.amountCents,0),recorded=moneyCents(payment.amount);
  if(recorded!==null&&recorded>observedCents){if(payment.verified===true&&payment.recordedBy&&payment.reference&&instant(payment.lastReceivedAt)&&moneyCents(payment.lastAmount)!==null){const staff={at:instant(payment.lastReceivedAt),amountCents:moneyCents(payment.lastAmount),source:'staff_recorded_receipt',portalJobId:job.id};staffPayments.push(staff);timeline.push({id:`${job.id}:staff-payment:${staff.at}`,kind:'payment_staff_recorded',at:staff.at,data:{...staff,currency:'USD',processorVerified:false}});}exceptions.push(payment.verified===true?'payment_history_incomplete':'payment_not_verified');}
  if(job.refunds||payment.refunds||moneyCents(payment.refundedAmount)>0)exceptions.push('refunds_require_processor_reconciliation');
  return{eligible:true,quote,completion,payments,staffPayments,exceptions:[...new Set(exceptions)],timeline:timeline.sort((a,b)=>String(b.at).localeCompare(String(a.at))||a.id.localeCompare(b.id))};
}
export function summarizeFinancialJobs(jobs,from,to){
  const start=instant(from),end=instant(to);if(!start||!end||start>=end||Date.parse(end)-Date.parse(start)>366*86400000)throw Object.assign(new Error('invalid_revenue_window'),{status:400});
  const inside=at=>Boolean(at&&at>=start&&at<end),sold={count:0,knownSubtotalCents:0,missingValueCount:0,undatedCount:0},completed={count:0,knownSubtotalCents:0,missingValueCount:0,undatedCount:0},receipts=[],exceptions=[];let eligibleJobs=0,staffRecordedCents=0,paymentCoverageIncomplete=false;
  for(const job of jobs){const facts=financialFacts(job);if(!facts.eligible)continue;eligibleJobs++;
    for(const reason of facts.exceptions){exceptions.push({portalJobId:job.id,code:reason});if(reason.startsWith('payment_'))paymentCoverageIncomplete=true;}
    for(const[target,fact]of [[sold,facts.quote],[completed,facts.completion]])if(fact){if(!fact.at)target.undatedCount++;else if(inside(fact.at)){target.count++;if(fact.amountCents===null)target.missingValueCount++;else target.knownSubtotalCents+=fact.amountCents;}}
    receipts.push(...facts.payments);
    for(const receipt of facts.staffPayments)if(inside(receipt.at))staffRecordedCents+=receipt.amountCents;
  }
  const deduped=uniqueReceipts(receipts);let cashKnownSubtotalCents=0,receiptCount=0;for(const receipt of deduped.unique){if(inside(receipt.at)){cashKnownSubtotalCents+=receipt.amountCents;receiptCount++;}}
  const total=s=>s.missingValueCount||s.undatedCount?null:s.knownSubtotalCents;
  return{ok:true,authority:'employee_hub',currency:'USD',from:start,to:end,eligibleJobs,revenueSoldCents:total(sold),revenueCompletedCents:total(completed),cashCollectedCents:paymentCoverageIncomplete||deduped.conflicts.length?null:cashKnownSubtotalCents,netCashCollectedCents:null,
    sold,completed,cash:{verifiedGrossSubtotalCents:cashKnownSubtotalCents,uniqueReceiptCount:receiptCount,conflictingReceiptCount:deduped.conflicts.length,staffRecordedSubtotalCents:staffRecordedCents},exceptions,
    coverage:{jobs:'complete_source_scan',saleDate:'explicit_customer_approval_or_accepted_estimate',completionDate:'explicit_completed_at',cash:'verified_stripe_receipts_only',refunds:'not_reconciled',netCash:'unknown',staffPaymentHistory:'latest_receipt_only'},
    note:'Sold value, completed value and cash receipts are separate. Cash is gross verified receipts, not profit or net after refunds. Missing values and dates remain unknown; draft prices and CRM opportunity values are excluded.'};
}
export async function portalRevenue(env,command,fetcher=firestoreFetch){
  summarizeFinancialJobs([],command.from,command.to);
  const docs=[],seen=new Set(),tokens=new Set();let token='',pages=0;
  do{if(++pages>200)throw Object.assign(new Error('revenue_scan_incomplete'),{status:503});const url=new URL(BASE);url.searchParams.set('pageSize','500');if(token)url.searchParams.set('pageToken',token);for(const f of ['type','recordType','isTest','test','status','pipelineStatus','estimate','customerApproval','payment','invoice','completedAt','postJobChecklist','refunds'])url.searchParams.append('mask.fieldPaths',f);
    const r=await fetcher(env,url.toString());if(!r.ok)throw Object.assign(new Error('revenue_source_unavailable'),{status:503});const page=await r.json();if(page.documents!==undefined&&!Array.isArray(page.documents))throw Object.assign(new Error('revenue_source_invalid'),{status:503});
    for(const raw of page.documents||[]){const id=String(raw.name||'').split('/').pop();if(seen.has(id))throw Object.assign(new Error('revenue_scan_changed'),{status:503});seen.add(id);docs.push({...decodeFirestoreFields(raw.fields),id});}token=page.nextPageToken||'';if(token&&tokens.has(token))throw Object.assign(new Error('revenue_pagination_stalled'),{status:503});tokens.add(token);
  }while(token);
  return{...summarizeFinancialJobs(docs,command.from,command.to),asOf:new Date().toISOString(),scan:'paginated_source_not_cross_store_snapshot'};
}
