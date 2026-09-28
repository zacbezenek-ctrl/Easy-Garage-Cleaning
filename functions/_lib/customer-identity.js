import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';

const ROOT='projects/egcw-1ec83/databases/(default)/documents';
const BASE=`https://firestore.googleapis.com/v1/${ROOT}`;
const CUSTOMER_LIMIT=10,JOB_LIMIT=100;
const CUSTOMER_FIELDS=['name','phone','email','phoneE164','emailLower','highlevelContactId'];
const QUERY_FIELDS=new Set(['phoneE164','emailLower','highlevelContactId']);
const JOB_FIELDS=['type','recordType','customerId','highlevelContactId'];
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(value)&&!/^(_egc_|secure_)/.test(value);
const fail=(code,message,status=503)=>Object.assign(new Error(message),{code:'customer_identity_'+code,status});
export const operationalJob=row=>Boolean(row&&safeId(row.id)&&!row.recordType&&['job','cleanout','reorg','walkthrough'].includes(row.type));

/** US-first E.164. Bare ten digits (or eleven with a leading 1) and +1 numbers
 * are NANP. An explicit + with any other country code stays international and is
 * never folded into +1. Anything unusable normalizes to ''. */
export function normalizePhoneE164(value) {
  if(typeof value!=='string'&&typeof value!=='number')return '';
  const text=String(value).trim().replace(/^tel:\s*/i,'').replace(/\s*(?:ext\.?|extension|x|#)\s*\d{1,6}$/i,'');
  if(!text||text.length>64)return '';
  const digits=text.replace(/\D/g,''),plus=text.startsWith('+');
  if(plus&&digits[0]!=='1')return /^[2-9]\d{7,14}$/.test(digits)?'+'+digits:'';
  const nanp=digits.length===11&&digits[0]==='1'?digits.slice(1):!plus&&digits.length===10?digits:'';
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(nanp)?'+1'+nanp:'';
}

/** Case-insensitive exact address. Dots and plus tags are kept: two mailboxes
 * are never folded into one identity. */
export function normalizeEmail(value) {
  if(typeof value!=='string')return '';
  const text=value.trim().replace(/^mailto:/i,'').toLowerCase();
  return text.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)?text:'';
}

export function customerIdentityFields(row) {
  return {phoneE164:normalizePhoneE164(row?.phone),emailLower:normalizeEmail(row?.email)};
}

/** Derived lookup keys for a saved customer, or null when they are current. */
export function customerIdentityPatch(row,now=new Date().toISOString()) {
  const fields=customerIdentityFields(row);
  return row?.phoneE164===fields.phoneE164&&row?.emailLower===fields.emailLower?null:{...fields,identityNormalizedAt:now};
}

/** Candidate customers for a phone or email. A login or link may use `customerId`
 * only when exactly one customer matches and coverage is complete. Stale keys,
 * duplicate CRM mappings and jobs linked elsewhere under the same CRM contact all
 * fail closed; nothing here merges or writes customers. */
export async function findCustomerCandidates(store,{phone,email}={}) {
  const phoneE164=normalizePhoneE164(phone),emailLower=normalizeEmail(email);
  const found=new Map(),jobs=[];let complete=true;
  const add=(row,how)=>{const entry=found.get(row.id)||{id:row.id,revision:row.revision||'',name:row.name||'',phoneE164:row.phoneE164||'',emailLower:row.emailLower||'',highlevelContactId:row.highlevelContactId||'',matchedBy:[]};if(!entry.matchedBy.includes(how))entry.matchedBy.push(how);found.set(row.id,entry);};
  const query=async(field,value)=>{
    const rows=await store.queryCustomers(field,value,CUSTOMER_LIMIT);
    if(!Array.isArray(rows)||rows.some(row=>!safeId(row?.id)||row[field]!==value))throw fail('storage_incomplete','Customer identity lookup returned incomplete records. Retry.');
    if(rows.length>=CUSTOMER_LIMIT)complete=false;
    return rows;
  };
  for(const [how,field,value] of [['phone','phoneE164',phoneE164],['email','emailLower',emailLower]]) {
    if(!value)continue;
    for(const row of await query(field,value)) {
      // A key written before the phone/email changed is not evidence.
      if(customerIdentityFields(row)[field]!==value){complete=false;continue;}
      add(row,how);
    }
  }
  if(found.size===1) {
    const [candidate]=found.values(),contact=candidate.highlevelContactId;
    // A stored contact that cannot be queried safely leaves the CRM history unverified.
    if(contact&&!safeId(contact))complete=false;
    else if(contact) {
      for(const row of await query('highlevelContactId',contact))add(row,'crm_contact');
      const rows=await store.jobsByContact(contact,JOB_LIMIT);
      if(!Array.isArray(rows))throw fail('storage_incomplete','Customer job history returned incomplete records. Retry.');
      if(rows.length>=JOB_LIMIT)complete=false;
      for(const row of rows.filter(operationalJob)) {
        if(row.highlevelContactId!==contact)throw fail('storage_incomplete','Customer job history returned incomplete records. Retry.');
        if(row.customerId&&row.customerId!==candidate.id){if(safeId(row.customerId))add({id:row.customerId},'crm_contact_job');else complete=false;}
        jobs.push({id:row.id,revision:row.revision||'',customerId:row.customerId||''});
      }
    }
  }
  const customers=[...found.values()].sort((a,b)=>a.id.localeCompare(b.id));
  return {phoneE164,emailLower,customers,customerId:customers.length===1&&complete?customers[0].id:'',ambiguous:customers.length>1,jobs:customers.length===1?jobs:[],coverage:{complete}};
}

// Private job rows (_egc_/secure_) are returned so the caller can count and skip them.
function decode(document,collection) {
  const prefix=`/documents/${collection}/`,name=document?.name,id=typeof name==='string'&&name.includes(prefix)?name.slice(name.indexOf(prefix)+prefix.length):'';
  if(!(collection==='jobs'?/^[^/]{1,1500}$/.test(id):safeId(id))||typeof document.updateTime!=='string'||!document.updateTime||document.fields!==undefined&&(!document.fields||typeof document.fields!=='object'||Array.isArray(document.fields)))throw fail('storage_incomplete','Customer identity lookup returned a record without a verifiable identity. Retry.');
  return {...decodeFirestoreFields(document.fields||{}),id,revision:document.updateTime};
}

export function customerIdentityStorage(env,fetcher=firestoreFetch) {
  // Masked, bounded equality lookups: only the identity fields ever leave Firestore.
  async function query(collection,fields,field,value,limit) {
    let response;
    try{response=await fetcher(env,`${BASE}:runQuery`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({structuredQuery:{from:[{collectionId:collection}],select:{fields:fields.map(fieldPath=>({fieldPath}))},where:{fieldFilter:{field:{fieldPath:field},op:'EQUAL',value:{stringValue:value}}},limit}}),signal:AbortSignal.timeout(15000)});}
    catch{throw fail('storage_unavailable','Customer identity lookup is unavailable. Retry.');}
    if(!response.ok)throw fail('storage_unavailable','Customer identity lookup is unavailable. Retry.');
    const rows=await response.json().catch(()=>null);
    if(!Array.isArray(rows))throw fail('storage_incomplete','Customer identity lookup returned incomplete records. Retry.');
    return rows.filter(row=>row?.document).map(row=>decode(row.document,collection));
  }
  return {
    async queryCustomers(field,value,limit=CUSTOMER_LIMIT) {
      if(!QUERY_FIELDS.has(field)||typeof value!=='string'||!value)throw fail('query_invalid','Customer identity lookup needs a normalized phone, email or CRM contact.',400);
      return query('customers',CUSTOMER_FIELDS,field,value,limit);
    },
    async jobsByContact(contactId,limit=JOB_LIMIT) {
      if(!safeId(contactId))throw fail('query_invalid','Customer job lookup needs a valid CRM contact.',400);
      return query('jobs',JOB_FIELDS,'highlevelContactId',contactId,limit);
    },
  };
}
