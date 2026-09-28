/**
 * Env inventory. Statically lists every environment name the Pages Functions (functions/) and the
 * Railway platform (egc-platform/{apps,services,packages}) read, diffs them against .env.example and
 * egc-platform/.env.example, and scans tracked files for committed live secrets.
 *   node scripts/env-inventory.mjs            report; exit 1 on any problem
 *   node scripts/env-inventory.mjs --write    also regenerate docs/env-inventory.md
 *   node scripts/env-inventory.mjs --check    also fail when docs/env-inventory.md is stale
 *   node scripts/env-inventory.mjs --json     also print the inventory as JSON (names and comments only)
 * Read-only unless --write. Never prints a secret value.
 */
import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sourceFiles} from '../tests/source-files.mjs';

export const REPO_ROOT=fileURLToPath(new URL('..',import.meta.url));
export const DOC='docs/env-inventory.md';
export const TARGETS=[
  {id:'pages',title:'Cloudflare Pages Functions',example:'.env.example',roots:['functions']},
  {id:'platform',title:'Railway egc-platform services',example:'egc-platform/.env.example',roots:['egc-platform/apps','egc-platform/services','egc-platform/packages']}
];
// Injected by the host runtime (Railway, Node, Next) or a test harness; never configured by the owner.
export const RUNTIME_PROVIDED=['PORT','PATH','NODE_ENV','RAILWAY_GIT_COMMIT_SHA'];
export const runtimeProvided=name=>RUNTIME_PROVIDED.includes(name)||/_TEST$/.test(name);

const CODE=/\.(?:[cm]?js|tsx?)$/,TEST_CODE=/\.(?:test|spec|check|browser)\.[cm]?[jt]sx?$/,TEST_DIR=/(?:^|\/)(?:tests?|__tests__)\//;
const FALLBACK_JOIN=/^\s*(?:\|\||\?\?)\s*(?:[A-Za-z_$][\w$]*\??\.)*$/;
const posix=path=>path.split(sep).join('/');
const literals=text=>[...String(text||'').matchAll(/(['"`])([A-Za-z_][A-Za-z0-9_]*)\1/g)].map(m=>m[2]);
function lineOf(text){
  const starts=[0];for(let at=text.indexOf('\n');at>=0;at=text.indexOf('\n',at+1))starts.push(at+1);
  return index=>{let low=0,high=starts.length-1;while(low<high){const mid=(low+high+1)>>1;if(starts[mid]<=index)low=mid;else high=mid-1;}return low+1;};
}

// Whole-line and leading block comments are prose, not reads.
function withoutComments(source){
  let block=false;
  return source.split('\n').map(line=>{
    if(block){const end=line.indexOf('*/');if(end<0)return '';block=false;return ' '.repeat(end+2)+line.slice(end+2);}
    const text=line.trimStart();
    if(text.startsWith('//'))return '';
    if(!text.startsWith('/*'))return line;
    const start=line.indexOf('/*'),end=line.indexOf('*/',start+2);
    if(end<0){block=true;return '';}
    return ' '.repeat(end+2)+line.slice(end+2);
  }).join('\n');
}

/**
 * Returns [{names, chain, line}] for one source file. `chain` lists the alternatives in read order: reads joined
 * with || or ?? (env.HIGHLEVEL_API_KEY||env.GHL_API_KEY) are separate alternatives, the first one primary and the
 * rest fallbacks; the names inside one alternative are an explicit alias list (envVar(env,'NAME',[aliases]), or the
 * any()/normalized() helpers). `names` is every name the reference reads.
 */
export function extractEnvReferences(source){
  const code=withoutComments(String(source)),spans=[];
  const add=(start,end,names,joins=true)=>{if(names.length)spans.push({start,end,names,joins});};
  for(const m of code.matchAll(/\benv\??\.([A-Za-z_][A-Za-z0-9_]*)(?![\w$]|\s*\()/g))add(m.index,m.index+m[0].length,[m[1]]);
  for(const m of code.matchAll(/\benv\??\.?\[\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\s*\]/g))add(m.index,m.index+m[0].length,[m[2]]);
  for(const m of code.matchAll(/\benvVar\(\s*[\w$.]+\s*,\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1\s*(?:,\s*\[([^\]]*)\])?\s*\)/g))add(m.index,m.index+m[0].length,[m[2],...literals(m[3])]);
  // Local readiness helpers such as integration-status any()/all()/normalized(): const x=(...keys)=>…env….
  for(const helper of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\(\.\.\.keys\)\s*=>([^\n]*)/g)){
    const body=helper[2].split(/;\s*const\s/)[0];
    if(!/\benv\b/.test(body))continue;
    const every=/\.every\(/.test(body);
    for(const call of code.matchAll(new RegExp(`(?<![\\w$.])${helper[1].replace(/\$/g,'\\$')}\\(([^()]*)\\)`,'g'))){
      if(!/^\s*(?:(['"`])[A-Za-z_][A-Za-z0-9_]*\1\s*,?\s*)+$/.test(call[1]))continue;
      const names=literals(call[1]);
      if(every)for(const name of names)add(call.index,call.index+call[0].length,[name],false);
      else add(call.index,call.index+call[0].length,names,false);
    }
  }
  // Name tables read through a computed key, e.g. operations-event ROUTES[event] -> env[key].
  if(/\benv\??\.?\[\s*(?!['"`])/.test(code))for(const table of code.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*\{([^{}]*)\}/g)){
    const values=[...table[2].matchAll(/:\s*(['"`])([^'"`]*)\1/g)].map(m=>m[2]);
    if(!values.length||!values.every(value=>/^[A-Z][A-Z0-9_]*$/.test(value))||!new RegExp(`\\b${table[1]}\\[`).test(code))continue;
    for(const name of values)add(table.index,table.index+table[0].length,[name],false);
  }
  // Env names held in config objects, e.g. garage-guard-checkout PLANS priceEnv:'STRIPE_PRICE_GUARD'.
  for(const m of code.matchAll(/\b[a-z][A-Za-z0-9]*Env\s*:\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1/g))add(m.index,m.index+m[0].length,[m[2]],false);
  spans.sort((a,b)=>a.start-b.start||a.end-b.end);
  const groups=[],line=lineOf(code);let previous=null;
  for(const span of spans){
    if(previous?.joins&&span.joins&&FALLBACK_JOIN.test(code.slice(previous.end,span.start)))groups.at(-1).chain.push(span.names);
    else groups.push({chain:[span.names],line:line(span.start)});
    previous=span;
  }
  return groups.map(({chain,line})=>({names:[...new Set(chain.flat())],chain,line}));
}

export function sourcePaths(root,dirs){
  return dirs.flatMap(dir=>existsSync(join(root,dir))?sourceFiles(join(root,dir)).map(entry=>posix(relative(root,join(entry.parentPath,entry.name)))):[])
    .filter(path=>CODE.test(path)&&!path.endsWith('.d.ts')&&!TEST_CODE.test(path)&&!TEST_DIR.test(path)).sort();
}

export function collectReferences(root,target){
  return sourcePaths(root,target.roots).flatMap(file=>extractEnvReferences(readFileSync(join(root,file),'utf8')).map(group=>({...group,file})));
}

const VAR_LINE=/^(#\s*)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const TAG=/\s*\[(?:(secret|plain);\s*([^\]]+?)|(reserved, not read))\]\s*$/;
// A whole value that is empty, a <placeholder>, or a known key prefix or letters-only URL path followed by "...".
const PLACEHOLDER=/^(?:|<[^<>]+>|(?:sk_live_|sk_test_|rk_live_|whsec_|sk-|https:\/\/[a-z0-9.-]+(?:\/[a-z/-]*)?\/)\.\.\.)$/;
const LOOPBACK_URL=/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/\S*)?$/;
const jsonLeaves=node=>typeof node==='string'?[node]:node&&typeof node==='object'?Object.values(node).flatMap(jsonLeaves):[];
// Placeholders, a loopback-only local-dev URL, or JSON (including {} and []) whose every string leaf is a placeholder.
export function placeholderValue(value){
  const text=String(value).trim();
  if(PLACEHOLDER.test(text)||LOOPBACK_URL.test(text))return true;
  if(!/^[[{]/.test(text))return false;
  try{return jsonLeaves(JSON.parse(text)).every(leaf=>PLACEHOLDER.test(leaf));}catch{return false;}
}
const UNSET=/\bUnset\b([^:.]{0,40}):/;
/**
 * Every variable line (NAME=… or a commented-out # NAME=…) needs a one-line comment directly above it:
 *   # What it does. Unset: behaviour when missing. [secret|plain; where it is set]
 *   # Why it is kept. [reserved, not read]      (the variable line itself must be commented out)
 */
export function parseExample(text){
  const lines=String(text).split(/\r?\n/),vars=new Map(),errors=[];
  lines.forEach((raw,index)=>{
    const match=VAR_LINE.exec(raw.trim());if(!match)return;
    const [,commented,name,value]=match,prior=index?lines[index-1].trim():'';
    const doc=prior.startsWith('#')&&!VAR_LINE.test(prior)?prior.replace(/^#\s*/,''):'';
    const tag=TAG.exec(doc),text=tag?doc.slice(0,tag.index).trim():doc,unset=UNSET.exec(text),qualifier=unset?.[1].trim();
    const entry={name,line:index+1,active:!commented,value,secret:tag?.[1]==='secret',where:tag?.[2]?.trim()||'',reserved:Boolean(tag?.[3]),
      purpose:(unset?text.slice(0,unset.index):text).trim(),unset:unset?`${qualifier?`(${qualifier}) `:''}${text.slice(unset.index+unset[0].length).trim()}`:''};
    if(vars.has(name))errors.push(`${name}: documented twice (lines ${vars.get(name).line} and ${index+1})`);
    else vars.set(name,entry);
    if(!doc)errors.push(`${name}: needs a one-line "# … [secret|plain; where]" comment directly above it`);
    else if(!tag)errors.push(`${name}: comment must end with [secret; where], [plain; where] or [reserved, not read]`);
    else if(entry.reserved&&entry.active)errors.push(`${name}: reserved variables must be commented out`);
    else if(!entry.reserved&&(!entry.purpose||!entry.unset))errors.push(`${name}: comment must say what it does and "Unset: …" behaviour`);
    if(entry.secret&&!placeholderValue(value))errors.push(`${name}: secret example value must be empty or a <placeholder>/... value`);
  });
  return {vars,errors};
}

// Names that satisfy a reference: the first alternative that names a configurable variable. Any one name of an
// explicit alias list is enough, but a ||/?? fallback never stands in for the primary name before it.
const primaryNames=ref=>(ref.chain||[ref.names]).map(names=>names.filter(name=>!runtimeProvided(name))).find(names=>names.length)||[];

export function diffTarget(references,example){
  const {vars,errors}=example,documented=name=>vars.has(name)&&!vars.get(name).reserved;
  const groups=new Map(),gaps=new Map(),aliases=new Map();
  const merge=(map,names,file,fallbacks=[])=>{
    const key=[...names].sort().join('|'),group=map.get(key)||{names,fallbacks:new Set(),files:new Set()};
    group.files.add(file);for(const name of fallbacks)group.fallbacks.add(name);map.set(key,group);
  };
  for(const ref of references){
    merge(groups,ref.names,ref.file);
    const primary=primaryNames(ref),satisfied=primary.find(documented);
    if(primary.length&&!satisfied)merge(gaps,primary,ref.file,ref.names.filter(name=>!primary.includes(name)&&!runtimeProvided(name)));
    if(satisfied)for(const name of ref.names)if(name!==satisfied&&!vars.has(name)&&!runtimeProvided(name))aliases.set(satisfied,new Set([...(aliases.get(satisfied)||[]),name]));
  }
  const all=[...groups.values()].map(group=>({names:group.names,files:[...group.files].sort()}));
  const missing=[...gaps.values()].map(group=>({names:group.names,fallbacks:[...group.fallbacks],files:[...group.files].sort()}));
  const read=new Set(all.flatMap(group=>group.names));
  const unused=[...vars.values()].filter(entry=>!entry.reserved&&!read.has(entry.name)&&!runtimeProvided(entry.name)).map(entry=>entry.name);
  const reservedRead=[...vars.values()].filter(entry=>entry.reserved&&read.has(entry.name)).map(entry=>entry.name);
  const runtime=[...read].filter(name=>runtimeProvided(name)&&!vars.has(name)).sort();
  const rows=[...vars.values()].sort((a,b)=>a.line-b.line).map(entry=>({...entry,aliases:[...(aliases.get(entry.name)||[])],
    files:[...new Set(all.filter(group=>group.names.includes(entry.name)).flatMap(group=>group.files))].sort()}));
  return {groups:all,missing,unused,reservedRead,runtime,formatErrors:errors,rows,
    runtimeFiles:Object.fromEntries(runtime.map(name=>[name,[...new Set(all.filter(group=>group.names.includes(name)).flatMap(group=>group.files))].sort()]))};
}

export function inventory(root=REPO_ROOT,targets=TARGETS){
  return targets.map(target=>{
    const path=join(root,target.example);
    const example=existsSync(path)?parseExample(readFileSync(path,'utf8')):{vars:new Map(),errors:[`${target.example} is missing`]};
    return {...target,...diffTarget(collectReferences(root,target),example)};
  });
}

export const problems=report=>report.flatMap(target=>[
  ...target.formatErrors.map(error=>`${target.example}: ${error}`),
  ...target.missing.map(group=>`${target.example}: missing ${group.names.join(' | ')} (read in ${group.files.join(', ')}${group.fallbacks.length?`; falls back to ${group.fallbacks.join(', ')}`:''})`),
  ...target.unused.map(name=>`${target.example}: ${name} is not read by ${target.roots.join(', ')}; remove it or mark it [reserved, not read]`),
  ...target.reservedRead.map(name=>`${target.example}: ${name} is marked reserved but code reads it`)
]);

const cell=value=>String(value||'').replace(/\|/g,'\\|').replace(/</g,'&lt;').replace(/\s+/g,' ').trim()||'—';
const code=value=>`\`${value}\``;
export function renderMarkdown(report){
  const out=['# Environment variable inventory','',
    'Generated by `node scripts/env-inventory.mjs --write` from the code that reads each variable and the one-line comments in the two `.env.example` files. Do not edit by hand; edit the example comment and regenerate.','',
    '`tests/env-inventory.test.mjs` fails when code reads a variable its `.env.example` does not document (the first name of a `||`/`??` fallback chain must be documented; any one name of an explicit alias list such as `envVar(env, NAME, [aliases])`, `any()` or `normalized()` is enough), when an example documents a variable nothing reads without marking it reserved, or when a tracked file contains a live Stripe key, a Stripe webhook secret or a private key. Values are never listed here.',''];
  for(const target of report){
    const active=target.rows.filter(row=>!row.reserved),reserved=target.rows.filter(row=>row.reserved);
    out.push(`## ${target.title} (\`${target.example}\`)`,'',`Read by \`${target.roots.join('`, `')}\`.`,'',
      '| Variable | Where set | Secret | Purpose | When unset | Read in |','| --- | --- | --- | --- | --- | --- |');
    for(const row of active)out.push(`| ${code(row.name)}${row.active?'':' (commented out)'}${row.aliases.length?`<br>aliases: ${row.aliases.map(code).join(', ')}`:''} | ${cell(row.where)} | ${row.secret?'yes':'no'} | ${cell(row.purpose)} | ${cell(row.unset)} | ${row.files.length?row.files.map(code).join(', '):'—'} |`);
    if(target.runtime.length){
      out.push('','Runtime-provided (never configured by the owner):','','| Variable | Read in |','| --- | --- |');
      for(const name of target.runtime)out.push(`| ${code(name)} | ${target.runtimeFiles[name].map(code).join(', ')} |`);
    }
    if(reserved.length){
      out.push('','Reserved, not read by any code (kept commented out in the example):','','| Variable | Note |','| --- | --- |');
      for(const row of reserved)out.push(`| ${code(row.name)} | ${cell(row.purpose)} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

// No leading word boundary: keys also appear after URL encoding (%3Dsk_live_…) or inside identifiers. PEM bodies may
// follow RFC 1421 header lines (Proc-Type:, DEK-Info:) and a blank line, raw or JSON-escaped.
export const SECRET_PATTERNS=[
  ['stripe_live_secret_key',/sk_live_[A-Za-z0-9]{16,}/g],
  ['stripe_live_restricted_key',/rk_live_[A-Za-z0-9]{16,}/g],
  ['stripe_webhook_secret',/whsec_[A-Za-z0-9+/=]{20,}/g],
  ['private_key',/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----(?:(?:\s|\\[rn])+[A-Za-z][A-Za-z-]*:[^\r\n\\]*)*(?:\s|\\[rn])*[A-Za-z0-9+/=]{40,}/g]
];
const BINARY=/\.(?:png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|eot|mp[34]|mov|webm|zip|gz|br|wasm)$/i;
// Placeholders such as sk_live_... and short synthetic PEM bodies in tests do not match.
export function scanSecrets(text){
  const source=String(text),line=lineOf(source),findings=[];
  for(const [pattern,expression] of SECRET_PATTERNS)for(const match of source.matchAll(expression))findings.push({pattern,line:line(match.index)});
  return findings.sort((a,b)=>a.line-b.line);
}
export function trackedFiles(root=REPO_ROOT){
  try{return execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:64*1024*1024}).split('\0').filter(Boolean);}
  catch{return sourceFiles(root).map(entry=>posix(relative(root,join(entry.parentPath,entry.name)))).filter(path=>!path.startsWith('.claude/'));}
}
export function scanRepository(root=REPO_ROOT,files=trackedFiles(root)){
  const findings=[];
  for(const file of files){
    if(BINARY.test(file))continue;
    let buffer;try{const path=join(root,file);if(!statSync(path).isFile())continue;buffer=readFileSync(path);}catch{continue;}
    if(buffer.subarray(0,8000).includes(0))continue;
    for(const finding of scanSecrets(buffer.toString('utf8')))findings.push({file,...finding});
  }
  return findings;
}

function main(){
  const args=new Set(process.argv.slice(2)),report=inventory(),markdown=renderMarkdown(report),docPath=join(REPO_ROOT,DOC);
  if(args.has('--write'))writeFileSync(docPath,markdown);
  const issues=problems(report),secrets=scanRepository();
  const stale=args.has('--check')&&(!existsSync(docPath)||readFileSync(docPath,'utf8')!==markdown);
  if(args.has('--json'))console.log(JSON.stringify(report.map(({id,example,missing,unused,reservedRead,runtime,formatErrors,rows})=>({id,example,missing,unused,reservedRead,runtime,formatErrors,
    rows:rows.map(({name,active,secret,where,reserved,purpose,unset,aliases,files})=>({name,active,secret,where,reserved,purpose,unset,aliases,files}))})),null,2));
  for(const target of report)console.log(`${target.example}: ${target.rows.filter(row=>!row.reserved).length} documented, ${target.rows.filter(row=>row.reserved).length} reserved, ${target.groups.length} read groups, ${target.missing.length} missing, ${target.unused.length} unused`);
  for(const issue of issues)console.log(`  ✗ ${issue}`);
  console.log(`secret scan: ${secrets.length} finding(s)`);
  for(const finding of secrets)console.log(`  ✗ ${finding.file}:${finding.line} ${finding.pattern}`);
  if(stale)console.log(`  ✗ ${DOC} is stale; run node scripts/env-inventory.mjs --write`);
  if(args.has('--write'))console.log(`wrote ${DOC}`);
  if(issues.length||secrets.length||stale)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
