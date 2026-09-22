import { requireDispatcher } from './dispatch-service.js';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(value)&&!/^(_egc_|secure_)/.test(value);
const fail=(code,message,status=400)=>Object.assign(new Error(message),{code:'customer_resolve_'+code,status});
const fields=['name','phone','email','address','highlevelContactId'];
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':plain(value)?'{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>JSON.stringify(key)+':'+canonical(value)).join(',')+'}':JSON.stringify(value);
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(value))))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const phone=value=>String(value||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
const email=value=>String(value||'').trim().toLowerCase();
const project=row=>Object.fromEntries(['id','revision',...fields].filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
function clean(customer){
  if(!plain(customer)||Object.keys(customer).some(key=>!fields.includes(key)))throw fail('invalid_customer','Only customer name, contact details and a selected CRM contact are accepted.');
  const result={};for(const key of fields){const value=customer[key]??'';if(typeof value!=='string'||value.length>({name:200,phone:40,email:254,address:1000,highlevelContactId:180}[key]))throw fail('invalid_customer','Customer details contain an invalid field.');result[key]=value.trim();}
  if(!result.name)throw fail('name_required','Enter the customer’s name.');
  if(result.highlevelContactId&&!safeId(result.highlevelContactId))throw fail('invalid_provider_contact','Choose a valid CRM contact.');
  if(result.phone&&(phone(result.phone).length<10||phone(result.phone).length>15))throw fail('invalid_phone','Enter a complete customer phone number.');
  if(result.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email))throw fail('invalid_email','Enter a valid customer email address.');
  return result;
}

/** Read provider identity using server credentials; browser contact links are
 * evidence to verify, never authority to attach an unrelated customer. */
export async function verifiedHighLevelContact(env,id,fetcher=fetch){
  const token=env.HIGHLEVEL_API_KEY||env.GHL_API_KEY,locationId=env.HIGHLEVEL_LOCATION_ID||env.GHL_LOCATION_ID;
  if(!token||!locationId)throw fail('provider_unavailable','CRM contact verification is not configured. Keep the form and retry after the connection is restored.',503);
  let response;try{response=await fetcher('https://services.leadconnectorhq.com/contacts/'+encodeURIComponent(id),{headers:{Accept:'application/json',Authorization:'Bearer '+token,Version:'v3'},signal:AbortSignal.timeout(15000)});}catch{throw fail('provider_unavailable','The CRM contact could not be verified. Keep the form and retry.',503);}
  if(!response.ok)throw fail('provider_unavailable','The CRM contact could not be verified. Select the current contact and retry.',response.status===404?409:503);
  const body=await response.json().catch(()=>({})),contact=body.contact;
  if(!contact||contact.id!==id||contact.locationId!==locationId)throw fail('provider_identity_mismatch','This contact does not belong to the connected EGC CRM location.',409);
  return clean({name:contact.name||[contact.firstName,contact.lastName].filter(Boolean).join(' '),phone:contact.phone||'',email:contact.email||'',address:[contact.address1||contact.address,contact.city,contact.state,contact.postalCode].filter(Boolean).join(', '),highlevelContactId:id});
}

export async function resolveCustomer(store,session,input,{verifyContact,now=new Date().toISOString()}={}){
  requireDispatcher(session);
  if(!plain(input)||Object.keys(input).some(key=>!['requestId','customer'].includes(key))||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId||''))throw fail('invalid_request','Customer resolution needs a unique request ID and customer details.');
  const requested=clean(input.customer),fingerprint=await hash({actor:session.user,input}),receiptId=input.requestId.toLowerCase();
  async function replay(){const receipt=await store.read('customerOperations',receiptId);if(!receipt)return null;if(receipt.fingerprint!==fingerprint)throw fail('idempotency_conflict','This request ID was already used for another customer. Keep the original request or refresh.',409);const customer=await store.read('customers',receipt.customerId);if(!customer||receipt.highlevelContactId&&customer.highlevelContactId!==receipt.highlevelContactId)throw fail('changed_since_operation','The customer link changed after it was saved. Ask a manager to review it.',409);return{ok:true,customer:project(customer),requestId:input.requestId,replayed:true,created:receipt.created,linked:receipt.linked};}
  const previous=await replay();if(previous)return previous;
  let wanted=requested;
  if(requested.highlevelContactId){if(typeof verifyContact!=='function')throw fail('provider_unavailable','CRM contact verification is unavailable.',503);wanted=clean(await verifyContact(requested.highlevelContactId));if(wanted.highlevelContactId!==requested.highlevelContactId)throw fail('provider_identity_mismatch','The selected CRM contact could not be verified.',409);}
  if(!wanted.highlevelContactId&&!phone(wanted.phone)&&!email(wanted.email))throw fail('contact_required','Add a phone number or email so this customer can be matched safely.');
  // Read the shared identity revision BEFORE the complete customer snapshot.
  // New customers and first provider links serialize with each other.
  const guard=await store.read('customerIdentityState','revision'),rows=await store.customers();
  const provider=wanted.highlevelContactId,exact=provider?rows.filter(row=>row.highlevelContactId===provider):[];
  if(exact.length>1)throw fail('ambiguous_provider','Multiple customer records point to this CRM contact. Ask a manager to resolve the duplicate before booking.',409);
  const identityMatches=rows.filter(row=>phone(wanted.phone)&&phone(row.phone)===phone(wanted.phone)||email(wanted.email)&&email(row.email)===email(wanted.email));
  const matches=exact.length?exact:identityMatches;
  if(matches.length>1)throw fail('ambiguous_customer','More than one customer matches this phone or email. Choose the existing canonical customer before booking.',409);
  let current=matches[0]||null;
  if(current){
    current=await store.read('customers',current.id);
    if(!current)throw fail('customer_changed','The customer changed during lookup. Retry the original request.',409);
    if(provider&&current.highlevelContactId&&current.highlevelContactId!==provider)throw fail('provider_link_conflict','These contact details belong to a different CRM-linked customer. Review the identity before booking.',409);
    if(!exact.length&&((phone(wanted.phone)&&phone(current.phone)&&phone(wanted.phone)!==phone(current.phone))||(email(wanted.email)&&email(current.email)&&email(wanted.email)!==email(current.email))))throw fail('contact_conflict','The phone and email point to conflicting customer details. Review the customer before booking.',409);
  }
  const id=current?.id||(provider?'ghl_'+provider:'customer_'+(await hash({phone:phone(wanted.phone),email:email(wanted.email)})).slice(0,40));
  if(!safeId(id))throw fail('invalid_customer_id','This customer record needs manager review before booking.',409);
  if(!current&&await store.read('customers',id))throw fail('customer_changed','A matching customer was created during lookup. Retry with the same customer details.',409);
  const created=!current,linked=Boolean(provider&&current&&!current.highlevelContactId),writes=[];
  if(created)writes.push({collection:'customers',id,patch:{id,...wanted,source:provider?'verified_provider_contact':'manager_intake',createdAt:now,updatedAt:now,createdBy:session.user}});
  else if(linked)writes.push({collection:'customers',id,revision:current.revision,patch:{highlevelContactId:provider,providerLinkedAt:now,providerLinkedBy:session.user,updatedAt:now}});
  writes.push({collection:'customerIdentityState',id:'revision',revision:guard?.revision,patch:{updatedAt:now,lastRequestId:input.requestId}});
  writes.push({collection:'customerOperations',id:receiptId,patch:{fingerprint,actorId:session.user,customerId:id,highlevelContactId:provider||current?.highlevelContactId||'',created,linked,createdAt:now,requestId:input.requestId}});
  try{await store.commit(writes);}catch(problem){const recovered=await replay();if(recovered)return recovered;throw problem;}
  const saved=await store.read('customers',id);if(!saved||provider&&saved.highlevelContactId!==provider)throw fail('outcome_unknown','The customer save could not be verified. Retry the unchanged request.',503);
  return{ok:true,customer:project(saved),requestId:input.requestId,created,linked};
}
