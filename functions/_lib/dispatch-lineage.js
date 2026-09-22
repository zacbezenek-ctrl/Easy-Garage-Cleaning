const recordId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,180}$/.test(value)&&!/^(_egc_|secure_)/.test(value);
const fail=(code,message,details)=>Object.assign(new Error(message),{code,status:409,...(details?{details}:{})});
const operational=row=>row&&!row.recordType&&['job','cleanout','reorg','walkthrough'].includes(row.type);
const addressKey=value=>typeof value==='string'?value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g,' '):'';

/** A stable property ID is authoritative. Missing IDs cannot borrow address
 * equality from a record that already has a known property ID. */
export function sameOperationalProperty(left,right) {
  const a=typeof left?.propertyId==='string'?left.propertyId.trim():'',b=typeof right?.propertyId==='string'?right.propertyId.trim():'';
  if(a||b)return Boolean(a&&b&&a===b);
  const address=addressKey(left?.address);
  return Boolean(address&&address===addressKey(right?.address));
}

/** Follow account ownership without choosing a latest job or comparing PII.
 * Callers cache reads and retain their revisions for atomic manager mutations. */
export async function verifiedAccountRoot(read,firstId,customerId) {
  const seen=new Set();let id=firstId;
  for(let depth=0;depth<12;depth++) {
    if(!recordId(id)||seen.has(id))throw fail('dispatch_lineage_invalid','The customer account link has an invalid or circular ownership chain. Review it before creating another visit.');
    seen.add(id);
    const row=await read(id);
    if(!operational(row)||row.id!==id)throw fail('dispatch_lineage_missing','A linked customer account record is missing or cannot be verified.');
    if(!customerId||row.customerId!==customerId)throw fail('dispatch_lineage_customer_mismatch','The account owner must belong to the exact same canonical customer.');
    const next=row.customerAccountOwnerJobId;
    if(!next||next===id)return row;
    id=next;
  }
  throw fail('dispatch_lineage_depth','The customer account chain is too long to verify safely. Review its ownership before adding a visit.');
}

/** Resolve read-only lineage; the caller atomically verifies every observed
 * revision alongside the new job. No wallet, collaborator, token or payment
 * object is copied into the new visit. */
export async function resolveDispatchLineage(store,{customerId,jobs,address,propertyId,sourceJobId}) {
  const cache=new Map(),checks=new Map();
  const read=async id=>{
    if(!cache.has(id)) {
      if(cache.size>=150)throw fail('dispatch_lineage_selection_required','This customer has too many account links to resolve automatically. Choose a specific source job.');
      cache.set(id,store.read('jobs',id));
    }
    const row=await cache.get(id);
    if(row&&!row.revision)throw fail('dispatch_lineage_invalid','A linked customer record has no verifiable revision.');
    if(row?.revision)checks.set(id,{collection:'jobs',id,revision:row.revision,verify:true});
    return row;
  };
  const target={address,propertyId};
  const candidates=jobs.filter(row=>operational(row)&&['job','cleanout','reorg'].includes(row.type)&&row.customerId===customerId);
  const selectionError=(message,rows=candidates,roots=new Map())=>fail('dispatch_lineage_selection_required',message,{candidates:rows.slice().sort((a,b)=>a.id.localeCompare(b.id)).slice(0,50).map(row=>({jobId:row.id,customerId:row.customerId,customer:typeof row.customer==='string'?row.customer.slice(0,200):'',address:typeof row.address==='string'?row.address.slice(0,1000):'',date:typeof row.date==='string'?row.date.slice(0,10):'',...(roots.has(row.customerAccountOwnerJobId||row.id)?{rootJobId:roots.get(row.customerAccountOwnerJobId||row.id)}:{})})),truncated:rows.length>50});
  let source=null,root=null;
  if(sourceJobId) {
    if(!recordId(sourceJobId))throw fail('dispatch_lineage_invalid','Choose a valid customer source job.');
    source=await read(sourceJobId);
    root=await verifiedAccountRoot(read,sourceJobId,customerId);
  } else {
    if(!candidates.length)return {patch:{},checks:[],metadata:null};
    if(candidates.length>150)throw selectionError('Choose a specific source job to verify this customer account.');
    // These list revisions protect each observed pointer as well as root reads.
    for(const row of candidates) {
      if(!row.revision)throw fail('dispatch_lineage_invalid','A previous customer visit has no verifiable revision.');
      checks.set(row.id,{collection:'jobs',id:row.id,revision:row.revision,verify:true});
    }
    const ids=[...new Set(candidates.map(row=>row.customerAccountOwnerJobId||row.id))],roots=new Map(),rootIds=new Map();
    for(const id of ids) {const found=await verifiedAccountRoot(read,id,customerId);roots.set(found.id,found);rootIds.set(id,found.id);}
    if(roots.size!==1)throw selectionError('This customer has more than one account root. Choose the prior job whose account should own this visit.',candidates,rootIds);
    root=[...roots.values()][0];
    if(sameOperationalProperty(target,root))source=root;
    else {
      const matching=candidates.filter(row=>sameOperationalProperty(target,row));
      if(matching.length===1)source=await read(matching[0].id);
      // Multiple property histories are intentionally not resolved by recency.
      else if(matching.length>1)throw selectionError('More than one property history matches this address. Choose the source job explicitly.',matching,rootIds);
    }
  }
  const memoryAddressMatches=Boolean(source&&sameOperationalProperty(target,source));
  return {patch:{customerAccountOwnerJobId:root.id,...(memoryAddressMatches?{customerMemoryInheritedFrom:source.id}:{})},checks:[...checks.values()],metadata:{selection:sourceJobId?'explicit_source':'unique_root',sourceJobId:source?.id||null,rootJobId:root.id,memoryAddressMatches}};
}
