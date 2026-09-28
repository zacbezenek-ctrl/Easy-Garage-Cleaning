/** Business member property-scope export (B2B-HARDEN). READ-ONLY: it never writes to Firestore.
 * Lists every company member whose access B2B-SCOPE limits to selected properties (member.propertyIds). Code from
 * before B2B-SCOPE ignores that field, so after a rollback past it each listed member with `widensOnRollback: true`
 * would see EVERY property of their company (for an inactive company, as soon as staff reactivate it). Before such a
 * rollback, revoke those members in the Business Hub (or deliberately give them every property); after rolling forward
 * again, use this export to restore their limits. See docs/business-client-hub.md "Rolling back past per-property access".
 *
 *   FIREBASE_SERVICE_ACCOUNT_JSON='{...}' node scripts/business-members-scope-export.mjs --out scope.json
 *
 * With --out the members go ONLY to that file (created private, mode 0600) and just a summary line is printed; if the
 * file cannot be written privately, nothing about the members is printed and it exits 1. Without --out the JSON goes to
 * stdout. It names people (name and email): keep it private. It never contains invitation hashes, session data,
 * delivery records or access history. A partial scan is an error, never a shorter list. */
import {rm,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {firestoreFetch,firebaseServiceAccountConfigured} from '../functions/_lib/firebase-service-account.js';
import {decodeFirestoreFields} from '../functions/_lib/firestore-job.js';
import {memberPropertyIds} from '../functions/_lib/business-hub-scope.js';

const BASE='https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents';
const FIELDS=['company','status','properties','members'];
const str=value=>typeof value==='string'?value:'';

/** Every document of one business collection, page by page, as the raw Firestore documents with their verified id. A
 * failed, malformed or repeating page aborts the whole scan with `code` (and `outcome` in its message), never a shorter list. */
export async function scanBusinessCollection(env,fetcher,{collection,fields,id:valid,code='business_scope_export_failed',outcome='Nothing was exported.'}){
  const stop=message=>Object.assign(new Error(`${message} ${outcome}`),{code});
  const documents=[],ids=new Set(),tokens=new Set(),prefix=`/documents/${collection}/`;let token='';
  for(let page=0;page<1000;page++){
    const url=new URL(`${BASE}/${collection}`);url.searchParams.set('pageSize','100');if(token)url.searchParams.set('pageToken',token);
    for(const field of fields)url.searchParams.append('mask.fieldPaths',field);
    let response;try{response=await fetcher(env,url.toString(),{method:'GET',signal:AbortSignal.timeout(30000)});}catch{throw stop(`${collection} could not be read.`);}
    if(!response.ok)throw stop(`${collection} could not be read.`);
    const data=await response.json().catch(()=>null);
    if(!data||typeof data!=='object'||Array.isArray(data)||data.documents!==undefined&&!Array.isArray(data.documents)||data.nextPageToken!==undefined&&typeof data.nextPageToken!=='string')throw stop(`A ${collection} page was incomplete.`);
    for(const document of data.documents||[]){
      const name=document?.name,id=typeof name==='string'&&name.includes(prefix)?name.slice(name.indexOf(prefix)+prefix.length):'';
      if(!valid.test(id)||ids.has(id))throw stop(`A ${collection} record had no verifiable identity.`);
      ids.add(id);documents.push({...document,id});
    }
    token=data.nextPageToken||'';
    if(!token)return documents;
    if(tokens.has(token))throw stop(`The ${collection} scan did not finish.`);
    tokens.add(token);
  }
  throw stop(`The ${collection} scan did not finish.`);
}

/** Every business account (the fields this export needs). */
export async function scanBusinessAccounts(env,fetcher=firestoreFetch){
  const documents=await scanBusinessCollection(env,fetcher,{collection:'business_accounts',fields:FIELDS,id:/^[a-f0-9]{32}$/});
  return documents.map(document=>({...decodeFirestoreFields(document.fields||{}),id:document.id}));
}

/** Members with a property limit, as a reviewable list. Only the fields needed to revoke and later restore them. */
export function scopedMembers(accounts){
  const rows=[];
  for(const account of accounts){
    const properties=new Map((Array.isArray(account.properties)?account.properties:[]).filter(p=>p&&typeof p.id==='string').map(p=>[p.id,str(p.name)]));
    for(const member of Array.isArray(account.members)?account.members:[]){
      const ids=member&&typeof member==='object'?memberPropertyIds(member):null;
      if(!ids)continue;
      const malformed=!Array.isArray(member.propertyIds);
      rows.push({
        accountId:account.id,company:str(account.company),accountStatus:str(account.status),
        memberId:str(member.id),name:str(member.name),email:str(member.email),role:str(member.role),status:str(member.status),
        generation:Number.isInteger(member.version)?member.version:null,
        propertyIds:[...ids],properties:[...ids].map(id=>({id,name:properties.get(id)??'',known:properties.has(id)})),
        ...(malformed?{malformed:true}:{}),
        // Pre-B2B-SCOPE code lets an active or invited member see every property: at once in an active company, and in an
        // inactive one (accountStatus) as soon as staff reactivate it, so the company's status never clears the flag.
        widensOnRollback:['active','invited'].includes(member.status),
      });
    }
  }
  return rows.sort((a,b)=>a.company.localeCompare(b.company)||a.accountId.localeCompare(b.accountId)||a.email.localeCompare(b.email)||a.memberId.localeCompare(b.memberId));
}

export async function exportMemberScopes(env,{fetcher=firestoreFetch,now=new Date().toISOString()}={}){
  const accounts=await scanBusinessAccounts(env,fetcher),members=scopedMembers(accounts);
  return {exportedAt:now,accounts:accounts.length,limitedMembers:members.length,widensOnRollback:members.filter(m=>m.widensOnRollback).length,members};
}

export function parseArgs(argv){
  const options={out:'',help:false};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--out'&&argv[i+1]&&!argv[i+1].startsWith('--'))options.out=argv[++i];
    else if(arg==='--help'||arg==='-h')options.help=true;
    else throw new Error('Unknown or incomplete argument: '+arg);
  }
  return options;
}

/** Replaces any earlier file, which would otherwise keep its old permissions. */
export async function writeExport(path,json){
  await rm(path,{force:true});
  await writeFile(path,json+'\n',{mode:0o600,flag:'wx'});
}

const USAGE='Usage: node scripts/business-members-scope-export.mjs [--out <file>]\nRead-only: lists business members limited to selected properties. With --out they are written only to that private file.';

/** The command line, with injectable environment, Firestore fetcher, clock and output streams. Returns the exit code. */
export async function runExport(argv,{env=process.env,fetcher=firestoreFetch,now=()=>new Date().toISOString(),stdout=process.stdout,stderr=process.stderr}={}){
  let options;
  try{options=parseArgs(argv);}catch(error){stderr.write(error.message+'\n');return 2;}
  if(options.help){stderr.write(USAGE+'\n');return 0;}
  const config={FIREBASE_SERVICE_ACCOUNT_JSON:env.FIREBASE_SERVICE_ACCOUNT_JSON||''};
  if(!firebaseServiceAccountConfigured(config)){stderr.write('FIREBASE_SERVICE_ACCOUNT_JSON is required.\n');return 2;}
  let report;
  try{report=await exportMemberScopes(config,{fetcher,now:now()});}
  catch(error){stderr.write((error.code?error.message:'Business accounts could not be read. Nothing was exported.')+'\n');return 1;}
  const json=JSON.stringify(report,null,2);
  // The file is the private copy: its people never also go to the terminal, and a failed private write prints none of them.
  if(options.out){
    try{await writeExport(options.out,json);}
    catch{stderr.write('The export file could not be written privately, so nothing was saved or printed. Choose another --out path and run it again.\n');return 1;}
  }
  else stdout.write(json+'\n');
  const inactive=report.members.filter(m=>m.widensOnRollback&&m.accountStatus!=='active').length;
  stderr.write(`READ-ONLY: ${report.accounts} business accounts, ${report.limitedMembers} members limited to selected properties, ${report.widensOnRollback} would see every property after a rollback past B2B-SCOPE (${inactive} of them in inactive companies).${options.out?` Members written only to ${options.out} (private).`:''}\n`);
  return 0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runExport(process.argv.slice(2));
