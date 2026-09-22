import { requireDispatcher, projectDispatchJob } from './dispatch-service.js';
import { validDate } from './dispatch-time.js';
import { jobCrewNames, assignmentKey } from './job-assignment.js';

const fail=(message,code='dispatch_search_invalid',status=400)=>Object.assign(new Error(message),{code,status});
const normalize=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const closed=new Set(['completed','invoiced','paid','review_requested','closed','cancelled','canceled','noshow','no_show','no-show']);
const completed=new Set(['completed','invoiced','paid','review_requested','closed']);
const cancelled=new Set(['cancelled','canceled','noshow','no_show','no-show']);
const jobTypes=new Set(['job','walkthrough','cleanout','reorg','blocked']);
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(value)&&!value.startsWith('_egc_')&&!value.startsWith('secure_');

/** Manager search spans all canonical Hub history, independently of the board
 * date range. Provider records are not merged or guessed by phone/name. */
export async function dispatchSearch(store,session,query={},now=new Date()) {
  requireDispatcher(session);
  if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(key=>!['q','status'].includes(key)))throw fail('Use a search term and an optional job status.');
  if(typeof query.q!=='string'||query.q.trim().length<2||query.q.length>200)throw fail('Enter 2 to 200 characters to search all Hub jobs.');
  const status=query.status||'all';if(!['all','active','completed','cancelled','unscheduled'].includes(status))throw fail('Choose a supported job status.');
  const phoneDigits=value=>{const digits=String(value||'').replace(/\D/g,'');return digits.length===11&&digits.startsWith('1')?digits.slice(1):digits;};
  const q=normalize(query.q),phoneOnly=/^[+\d().\s-]+$/.test(q),phone=phoneDigits(q),tokens=q.split(' ');
  const usDate=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(q),isoDate=usDate?`${usDate[3]}-${usDate[1].padStart(2,'0')}-${usDate[2].padStart(2,'0')}`:q;
  const date=validDate(isoDate)?isoDate:null;
  const [jobs,customers,roster]=await Promise.all([store.jobs(),store.customers(),store.roster()]);
  if(![jobs,customers,roster].every(Array.isArray))throw fail('The complete job history could not be verified. Retry the search.','dispatch_search_incomplete',503);
  const customersById=new Map(customers.map(customer=>[customer.id,customer])),people=new Map(roster.map(person=>[person.id,person.name])),matches=[];
  for(const raw of jobs){
    if(!raw||raw.recordType||!safeId(raw.id)||!jobTypes.has(raw.type))continue;
    const state=raw.pipelineStatus||raw.status||'unscheduled';
    if(status==='active'&&closed.has(state)||status==='completed'&&!completed.has(state)||status==='cancelled'&&!cancelled.has(state)||status==='unscheduled'&&raw.date)continue;
    const customer=customersById.get(raw.customerId),name=customer?.name||[customer?.firstName,customer?.lastName].filter(Boolean).join(' ');
    const fields=[raw.id,raw.customerId,raw.customer,raw.title,name,raw.address,raw.phone,customer?.phone,customer?.email,raw.serviceType,raw.date,raw.endDate];
    const directText=normalize(fields.join(' ')),phones=[raw.phone,customer?.phone].map(phoneDigits);
    // Materialize the permission-safe DTO only for a text match or a plausible
    // employee match; do not parse every historical date for common searches.
    const assigned=jobCrewNames(raw);
    const employeeText=normalize([...assigned,...assigned.map(value=>people.get(assignmentKey(value))||'')].join(' '));
    const text=(directText+' '+employeeText).trim();
    if(!(date&&(raw.date===date||raw.endDate===date))&&!(phoneOnly&&phone.length>=3&&phones.some(value=>value.includes(phone)))&&!tokens.every(token=>text.includes(token)))continue;
    const job=projectDispatchJob(raw,roster);
    matches.push({job,canonicalCustomerName:name||null,rank:normalize(raw.id)===q?0:normalize(name||raw.customer).startsWith(q)?1:2});
  }
  matches.sort((a,b)=>a.rank-b.rank||String(b.job.date||'9999').localeCompare(String(a.job.date||'9999'))||a.job.id.localeCompare(b.job.id));
  return {ok:true,query:query.q.trim(),status,total:matches.length,truncated:matches.length>50,results:matches.slice(0,50).map(({job,canonicalCustomerName})=>({job,canonicalCustomerName})),coverage:{complete:true,mode:'canonical_hub_history',asOf:now.toISOString()}};
}
