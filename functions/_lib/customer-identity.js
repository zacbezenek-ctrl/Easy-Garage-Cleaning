import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';

const ROOT='projects/egcw-1ec83/databases/(default)/documents';
const BASE=`https://firestore.googleapis.com/v1/${ROOT}`;
const CUSTOMER_LIMIT=10,JOB_LIMIT=100;
const CUSTOMER_FIELDS=['name','phone','email','phoneE164','emailLower','highlevelContactId'];
const QUERY_FIELDS=new Set(['phoneE164','emailLower','highlevelContactId']);
const JOB_FIELDS=['type','recordType','customerId','highlevelContactId'];
// Job fields that may be looked up by exact value. phoneE164/emailLower exist on
// jobs only once scripts/backfill-job-contact-keys.mjs has written them, so callers
// also pass the raw phone/email spellings to match (at most IN_LIMIT).
const JOB_QUERY_FIELDS=new Set(['highlevelContactId','customerId','phoneE164','emailLower','phone','email']),IN_LIMIT=30;
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

/** Exact spellings a legacy job may have saved for one NANP number, for bounded
 * equality lookups on the unnormalized job phone field. Other numbers keep their
 * own spelling and E.164. */
export function phoneSpellings(value) {
  const raw=typeof value==='string'?value.trim():typeof value==='number'?String(value):'',e164=normalizePhoneE164(value),found=new Set(raw?[raw]:[]);
  if(/^\+1\d{10}$/.test(e164)) {
    const d=e164.slice(2),[a,b,c]=[d.slice(0,3),d.slice(3,6),d.slice(6)];
    for(const text of [d,'1'+d,e164,`(${a}) ${b}-${c}`,`(${a})${b}-${c}`,`(${a}) ${b} ${c}`,`${a}-${b}-${c}`,`${a}.${b}.${c}`,`${a} ${b} ${c}`,`${a} ${b}-${c}`,
      `1-${a}-${b}-${c}`,`1 ${a} ${b} ${c}`,`1 (${a}) ${b}-${c}`,`1 ${a}-${b}-${c}`,`+1 ${a} ${b} ${c}`,`+1 (${a}) ${b}-${c}`,`+1-${a}-${b}-${c}`,`+1 ${a}-${b}-${c}`,`+1 ${a}.${b}.${c}`,`+1.${a}.${b}.${c}`])found.add(text);
  } else if(e164)found.add(e164);
  return [...found].slice(0,IN_LIMIT);
}

/** The saved spelling and its lowercase form of one valid address. */
export function emailSpellings(value) {
  const raw=typeof value==='string'?value.trim():'';
  return normalizeEmail(raw)?[...new Set([raw,raw.toLowerCase()])]:[];
}

export function customerIdentityFields(row) {
  return {phoneE164:normalizePhoneE164(row?.phone),emailLower:normalizeEmail(row?.email)};
}

/** Derived phone/email lookup keys for a saved job, or null when they are current
 * (a job with neither key and no phone or email needs none). */
export function jobContactKeysPatch(row,now=new Date().toISOString()) {
  const fields=customerIdentityFields(row);
  return (row?.phoneE164??'')===fields.phoneE164&&(row?.emailLower??'')===fields.emailLower?null:{...fields,contactKeysNormalizedAt:now};
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
  // An array value is an IN lookup (one of the values).
  async function query(collection,fields,field,value,limit) {
    const filter=Array.isArray(value)?{op:'IN',value:{arrayValue:{values:value.map(stringValue=>({stringValue}))}}}:{op:'EQUAL',value:{stringValue:value}};
    let response;
    try{response=await fetcher(env,`${BASE}:runQuery`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({structuredQuery:{from:[{collectionId:collection}],select:{fields:fields.map(fieldPath=>({fieldPath}))},where:{fieldFilter:{field:{fieldPath:field},...filter}},limit}}),signal:AbortSignal.timeout(15000)});}
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
    /** Jobs whose `field` equals one of `values` (bounded; a full page means the
     * caller's coverage is incomplete). Private rows are returned for the caller to skip. */
    async queryJobsByField(field,values,{fields=JOB_FIELDS,limit=JOB_LIMIT}={}) {
      const list=[...new Set((Array.isArray(values)?values:[values]).filter(value=>typeof value==='string'&&value))];
      if(!JOB_QUERY_FIELDS.has(field)||!list.length||list.length>IN_LIMIT||['highlevelContactId','customerId'].includes(field)&&!list.every(safeId))throw fail('query_invalid','Customer job lookup needs a valid CRM contact, customer, phone or email.',400);
      const rows=await query('jobs',[...new Set([...fields,field])],field,list.length===1?list[0]:list,limit);
      if(rows.some(row=>!list.includes(row[field])))throw fail('storage_incomplete','Customer job history returned incomplete records. Retry.');
      return rows;
    },
  };
}

/** Indexed customer search (P1-DS-14). searchKeys holds the phone-digit
 * prefixes (3+ digits; extension cut, NANP without the leading 1) and the last
 * 4 and 7 digits first, then the lowercased 2-to-16-character prefixes of each
 * email word and each name word in order, at most 200 (a very long name loses
 * only its last words). searchKeysVersion is SEARCH_KEYS_VERSION: readers use
 * the index only while every customer has it (bump it with any key-format
 * change and rerun the backfill). Keys are never evidence: readers re-derive
 * them from the saved fields.
 * Any path that creates a customer, or changes its name, firstName, lastName,
 * phone or email, must write customerSearchFields/customerSearchPatch in the
 * same commit. A create without keys only makes search scan again (coverage
 * counts keyed customers), but an edit without them leaves stale keys that
 * coverage cannot see; the backfill dry run lists those (staleKeys). */
export const SEARCH_KEYS_VERSION=2;
const SEARCH_PREFIX=16,SEARCH_KEY_LIMIT=200;
const PHONE_EXTENSION=/\s*(?:ext\.?|extension|x|#)\s*\d{1,6}$/i,PHONE_TEXT=/^[+\d().\s-]+$/;
const fold=value=>typeof value==='string'||typeof value==='number'?String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase():'';
const searchWords=value=>fold(value).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const savedWords=row=>[row?.email,row?.name,row?.firstName,row?.lastName].flatMap(searchWords);
const longest=keys=>keys.reduce((best,key)=>key.length>best.length?key:best);

/** A saved phone's searchable digits: extension cut, NANP without its leading 1. */
export function customerPhoneDigits(value) {
  const digits=fold(value).trim().replace(PHONE_EXTENSION,'').replace(/\D/g,'');
  return digits.length===11&&digits[0]==='1'?digits.slice(1):digits;
}

export function customerSearchKeys(row) {
  const keys=new Set(),digits=customerPhoneDigits(row?.phone);
  if(digits.length>=3&&digits.length<=15) {
    for(let length=3;length<=digits.length;length++)keys.add(digits.slice(0,length));
    for(const length of [4,7])if(digits.length>length)keys.add(digits.slice(-length));
  }
  for(const word of savedWords(row))for(let length=2;length<=Math.min(word.length,SEARCH_PREFIX);length++)keys.add(word.slice(0,length));
  return [...keys].slice(0,SEARCH_KEY_LIMIT);
}

export function customerSearchFields(row) {
  return {searchKeys:customerSearchKeys(row),searchKeysVersion:SEARCH_KEYS_VERSION};
}

/** A new customer's patch with its derived search keys. */
export const withCustomerSearchKeys=patch=>({...patch,...customerSearchFields(patch)});

/** Derived search keys for a saved customer, or null when they are current. */
export function customerSearchPatch(row,now=new Date().toISOString()) {
  const fields=customerSearchFields(row),saved=Array.isArray(row?.searchKeys)?row.searchKeys:null;
  return row?.searchKeysVersion===SEARCH_KEYS_VERSION&&saved?.length===fields.searchKeys.length&&saved.every((key,index)=>key===fields.searchKeys[index])?null:{...fields,searchKeysUpdatedAt:now};
}

/** What a search needs, or null when the index cannot answer it (empty text,
 * only one-character words, fewer than 3 phone digits) and callers scan.
 * `query` lists the keys to read; every match holds one of them.
 * Phone text (digits, spaces and + ( ) . -, an extension ignored) matches a
 * customer holding any key in `any`: NANP area codes never start with 1, so
 * digits typed with a leading 1 are also tried without it. Other text, emails included, matches when every
 * word of 2+ characters is a key (its first 16 characters) and every word in
 * `words` (one letter, or longer than 16) starts a saved name or email word. */
export function customerSearchTerms(text) {
  const value=fold(text).trim(),number=value.replace(PHONE_EXTENSION,'');
  if(!value)return null;
  if(number&&PHONE_TEXT.test(number)) {
    const digits=number.replace(/\D/g,''),any=[...new Set([digits.length===11&&digits[0]==='1'?digits.slice(1):digits,...(digits.length>=4&&digits[0]==='1'?[digits.slice(1)]:[])])].filter(key=>key.length>=3&&key.length<=15);
    return any.length?{query:any,any}:null;
  }
  const words=[...new Set(searchWords(value))],keys=[...new Set(words.filter(word=>word.length>=2).map(word=>word.slice(0,SEARCH_PREFIX)))];
  if(!keys.length)return null;
  // The longest key selects best, but an email's domain (gmail, com) is shared by many customers.
  const local=value.includes('@')?searchWords(value.split('@')[0]).filter(word=>word.length>=2).map(word=>word.slice(0,SEARCH_PREFIX)):[];
  return {query:[longest(local.length?local:keys)],keys,words:words.filter(word=>word.length<2||word.length>SEARCH_PREFIX)};
}

export function customerMatchesSearch(row,terms) {
  const keys=new Set(customerSearchKeys(row));
  if(terms.any)return terms.any.some(key=>keys.has(key));
  const words=terms.words.length?savedWords(row):[];
  return terms.keys.every(key=>keys.has(key))&&terms.words.every(word=>words.some(found=>found.startsWith(word)));
}
