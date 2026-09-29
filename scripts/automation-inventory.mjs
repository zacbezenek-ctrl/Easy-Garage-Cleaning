/**
 * FUN-30 automation inventory. Scans the code for every path that can message a customer or fire a
 * HighLevel/Zapier automation, diffs it against the checked-in registry
 * (functions/_lib/automation-registry-data.js) and renders docs/automation-registry.md.
 *   node scripts/automation-inventory.mjs            report; exit 1 on registry problems or code drift
 *   node scripts/automation-inventory.mjs --write    also regenerate docs/automation-registry.md
 *   node scripts/automation-inventory.mjs --check    also fail when docs/automation-registry.md is stale
 *   node scripts/automation-inventory.mjs --scan     print the scanned code inventory as JSON
 *   node scripts/automation-inventory.mjs --ghl      also list HighLevel workflows (read-only GET /workflows/) with
 *                                                    HIGHLEVEL_API_KEY|GHL_API_KEY and HIGHLEVEL_LOCATION_ID|GHL_LOCATION_ID
 *                                                    from the shell, and diff them against the registry
 * Read-only unless --write. Never sends, never changes a live automation and never prints a credential.
 */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sourceFiles} from '../tests/source-files.mjs';
import {AUTOMATION_REGISTRY,registryProblems,registryHash,gateBlockers,hubWritesFor,listenersFor,automationCleared,diffGhlWorkflows,fetchGhlWorkflows} from '../functions/_lib/automation-registry.js';
import {MESSAGE_KINDS} from '../functions/_lib/message-policies.js';

export const REPO_ROOT=fileURLToPath(new URL('..',import.meta.url));
export const DOC='docs/automation-registry.md';
// Browser pages and Pages Functions (Hub), the crew tools, and the Railway platform sources.
export const SCAN_ROOTS=['functions','crew','egc-platform/apps','egc-platform/services','egc-platform/packages'];
// The registry itself names send paths; it is not one.
const SELF=new Set(['functions/_lib/automation-registry.js','functions/_lib/automation-registry-data.js','functions/api/automation-registry.js']);
const CODE=/\.(?:[cm]?js|tsx?|html)$/,TEST_CODE=/\.(?:test|spec|check|browser)\.[cm]?[jt]sx?$/,SKIP_DIR=/(?:^|\/)(?:tests?|__tests__|dist)\//;
// One regular expression per kind of send path. A new occurrence anywhere changes the scanned counts, so the
// registry test fails until someone classifies it. A path the scanner cannot tell read from write (a contact,
// opportunity or appointment by id, a notes or tasks list, a Hub endpoint with a query) counts either way. A
// contact sub-resource other than tags, notes and tasks (a workflow or campaign enrolment) is a contact write.
export const SIGNATURES=Object.freeze({
  ghl_message_send:/\/conversations\/messages(?=['"`])/g,
  ghl_tag_write:/\/contacts\/[^'"`\n]*\/tags(?=['"`])/g,
  // A call to the shared tag writer (functions/_lib/highlevel-tags.js addTags, GHL-TRACK-1): the caller's tag literals are its tag writes.
  ghl_tag_helper_call:/(?<!function\s)(?<![\w$.])addTags\(/g,
  ghl_contact_write:/\/contacts\/(?:upsert)?(?=['"`])|\/contacts\/\$\{[^}]+\}(?:\/(?!(?:tags|notes|tasks)['"`\/])[^'"`\n]*)?(?=['"`])/g,
  ghl_note_task_write:/\/contacts\/[^'"`\n]*\/(?:notes|tasks)(?:\/\$\{[^}]+\})?(?=['"`])/g,
  ghl_opportunity_write:/\/opportunities\/(?:upsert)?(?=['"`])|\/opportunities\/\$\{[^}]+\}(?=['"`])/g,
  ghl_appointment_write:/\/calendars\/events\/(?:appointments(?:\/\$\{[^}]+\})?|\$\{[^}]+\})(?=['"`])/g,
  ghl_client_write:/\.(?:sendMessage|addContactTags|removeContactTags|createOpportunity|updateOpportunity|createAppointment|updateAppointment|deleteCalendarEvent|upsertContact|updateContact|createContact|createContactNote)\(/g,
  zapier_hook:/\b[A-Z][A-Z0-9_]*(?:HOOK|WEBHOOK)_URL\b|hooks\.zapier\.com/g,
  quo_send:/api\.openphone\.com|api\.quo\.com/g,
  emailjs_send:/api\.emailjs\.com/g,
  stripe_receipt_email:/receipt_email/g,
  hub_send_helper_call:/(?<!function\s)(?<![\w$.])(?:deliverHighLevelMessage|sendAcceptedQuotePortal|syncSalesFollowupExit|createApprovedSendService|createGhlMessenger)\(/g,
  hub_lifecycle_trigger:/tool\s*:\s*['"]lifecycle['"]/g,
  hub_send_endpoint_call:/['"`]\/api\/(?:highlevel|quo-send|crew-hook|operations-event|email-confirmation|messages|customer-portal-invitation|web-lead)(?=['"`?])/g,
});
const posix=path=>path.split(sep).join('/');

export function scanFiles(root=REPO_ROOT){
  const files=SCAN_ROOTS.filter(dir=>existsSync(join(root,dir))).flatMap(dir=>sourceFiles(join(root,dir)).map(entry=>posix(relative(root,join(entry.parentPath,entry.name)))));
  for(const entry of sourceFiles(root)){const path=posix(relative(root,join(entry.parentPath,entry.name)));if(!path.includes('/'))files.push(path);}
  return [...new Set(files)].filter(path=>CODE.test(path)&&!TEST_CODE.test(path)&&!SKIP_DIR.test(path)&&!path.endsWith('.d.ts')&&!SELF.has(path)).sort();
}

// {file:{signature:count}} for every file with at least one send path.
export function scanSendPaths(root=REPO_ROOT,files=scanFiles(root)){
  const inventory={};
  for(const file of files){
    const source=readFileSync(join(root,file),'utf8');
    for(const [name,expression] of Object.entries(SIGNATURES)){const count=[...source.matchAll(expression)].length;if(count)(inventory[file]||={})[name]=count;}
  }
  return inventory;
}

// HighLevel tag literals in server tag writers (a tag write path or a call to the shared tag writer); ${...} becomes {*} and a comma-joined default list is split.
export function scanTagTokens(root=REPO_ROOT,inventory=scanSendPaths(root)){
  const tokens={};
  for(const file of Object.keys(inventory).filter(file=>file.startsWith('functions/')&&(inventory[file].ghl_tag_write||inventory[file].ghl_tag_helper_call))){
    const source=readFileSync(join(root,file),'utf8'),found=new Set();
    for(const match of source.matchAll(/(['"`])((?:egc|gc|fb)-[a-z0-9-]*(?:(?:\$\{[^}`]+\}|,)[a-z0-9-]*)*)\1/g))
      for(const token of match[2].replace(/\$\{[^}]+\}/g,'{*}').split(','))if(/^(?:egc|gc|fb)-/.test(token))found.add(token);
    tokens[file]=[...found].sort();
  }
  return tokens;
}

// Lifecycle events the browser can send to /api/highlevel (each becomes the tag egc-<event> unless suppressed).
export function scanLifecycleEvents(root=REPO_ROOT,inventory=scanSendPaths(root)){
  const events={};
  const add=(event,file,suppressed)=>{const item=events[event]||={files:[],suppressed:true};if(!item.files.includes(file))item.files.push(file);item.suppressed&&=suppressed;};
  for(const file of Object.keys(inventory).filter(file=>inventory[file].hub_lifecycle_trigger)){
    const source=readFileSync(join(root,file),'utf8');
    const table=source.match(/const customerCommunicationTypes=\{([\s\S]*?)\n\};/);
    if(table)for(const key of table[1].matchAll(/^\s*'([a-z0-9-]+)'\s*:/gm))add(key[1],file,false);
    for(const call of source.matchAll(/tool\s*:\s*['"]lifecycle['"]\s*,\s*event\s*:\s*['"]([a-z0-9-]+)['"](\s*,\s*suppress_automation\s*:\s*true)?/g))add(call[1],file,Boolean(call[2]));
  }
  for(const item of Object.values(events))item.files.sort();
  return Object.fromEntries(Object.entries(events).sort(([a],[b])=>a.localeCompare(b)));
}

export function scanRepository(root=REPO_ROOT){
  const inventory=scanSendPaths(root);
  return {inventory,tags:scanTagTokens(root,inventory),lifecycle:scanLifecycleEvents(root,inventory)};
}

const tagTrigger=(registry,tag)=>registry.triggers.find(trigger=>trigger.id===`tag:${tag}`);
// Every difference between the code and the registry, as human-readable lines. Empty means in sync.
export function inventoryDrift(registry,scan){
  const drift=[],registered=registry.codeInventory||{};
  for(const [file,signatures] of Object.entries(scan.inventory))for(const [signature,count] of Object.entries(signatures)){
    const expected=registered[file]?.[signature];
    if(!expected)drift.push(`unregistered send path: ${file} ${signature} x${count}. Classify it in functions/_lib/automation-registry-data.js (codeInventory plus an automation's code list).`);
    else if(expected!==count)drift.push(`changed send path: ${file} ${signature} found ${count}, registered ${expected}. Review the new or removed call and update the registry.`);
  }
  for(const [file,signatures] of Object.entries(registered))for(const signature of Object.keys(signatures))if(!scan.inventory[file]?.[signature])drift.push(`stale registry entry: ${file} ${signature} is no longer in the code.`);
  const patterns=registry.tagPatterns||[];
  for(const [file,tokens] of Object.entries(scan.tags))for(const token of tokens){
    if(token.includes('{*}')){
      const pattern=patterns.find(item=>item.file===file&&item.token===token);
      if(!pattern)drift.push(`unregistered tag pattern: ${file} writes ${token}. Add it to tagPatterns.`);
      else if(pattern.expands!=='lifecycle')for(const tag of pattern.expands)if(!tagTrigger(registry,tag)?.hubWrites.some(write=>write.file===file))drift.push(`tag ${tag} (from ${token}) needs a trigger whose hubWrites include ${file}.`);
    }else if(!tagTrigger(registry,token)?.hubWrites.some(write=>write.file===file))drift.push(`unregistered tag write: ${file} writes ${token}. Add trigger tag:${token} with this Hub write.`);
  }
  for(const pattern of patterns)if(!scan.tags[pattern.file]?.includes(pattern.token))drift.push(`stale tag pattern: ${pattern.file} no longer writes ${pattern.token}.`);
  const expanded=new Set(patterns.flatMap(item=>Array.isArray(item.expands)?item.expands.map(tag=>`${item.file} ${tag}`):[]));
  for(const trigger of registry.triggers.filter(item=>item.type==='tag_added'))for(const write of trigger.hubWrites){
    const tag=trigger.id.slice(4),lifecycle=registry.lifecycleEvents.some(item=>`egc-${item.event}`===tag&&item.tagWritten);
    if(write.file.startsWith('functions/')&&!scan.tags[write.file]?.includes(tag)&&!expanded.has(`${write.file} ${tag}`)&&!(lifecycle&&write.file==='functions/api/highlevel.js'))drift.push(`stale hub write: ${write.file} no longer writes ${tag}.`);
  }
  const events=registry.lifecycleEvents||[];
  for(const [event,found] of Object.entries(scan.lifecycle)){
    const item=events.find(entry=>entry.event===event);
    if(!item){drift.push(`unregistered lifecycle event: ${event} (${found.files.join(', ')}). Add it to lifecycleEvents and, unless suppressed, trigger tag:egc-${event}.`);continue;}
    if(item.files.join('|')!==found.files.join('|'))drift.push(`lifecycle event ${event}: callers are ${found.files.join(', ')}, registered ${item.files.join(', ')}.`);
    if(item.tagWritten===found.suppressed)drift.push(`lifecycle event ${event}: tagWritten must be ${!found.suppressed}.`);
    if(!found.suppressed&&!tagTrigger(registry,`egc-${event}`))drift.push(`lifecycle event ${event}: missing trigger tag:egc-${event}.`);
  }
  for(const item of events)if(!scan.lifecycle[item.event])drift.push(`stale lifecycle event: ${item.event} is no longer sent.`);
  const kinds=registry.automations.map(entry=>entry.msgCoreKind).filter(Boolean);
  for(const kind of MESSAGE_KINDS)if(!kinds.includes(kind))drift.push(`unregistered approved-send kind: ${kind} (functions/_lib/message-policies.js).`);
  for(const kind of kinds)if(!MESSAGE_KINDS.includes(kind))drift.push(`stale approved-send kind: ${kind}.`);
  return drift;
}

// Files the registry cites must exist, so evidence and Hub writes never point at nothing.
export function missingReferences(registry,root=REPO_ROOT){
  const files=new Set([...registry.triggers.flatMap(trigger=>trigger.hubWrites.flatMap(write=>[write.file,...write.via])),
    ...registry.automations.flatMap(entry=>[...(entry.evidence||[]),...(entry.code||[]).map(ref=>ref.file)]),
    ...Object.values(registry.sources).flatMap(source=>source.evidence||[]),...(registry.lifecycleEvents||[]).flatMap(item=>item.files)]);
  return [...files].filter(file=>!existsSync(join(root,file))).sort();
}

const cell=value=>String(value??'—').replace(/\|/g,'\\|').replace(/\s*\n\s*/g,' ');
const labels={approved_automatic:'Approved automatic (sends today, may keep running)',approved_human:'Approved human (a person approves each message)',internal:'Internal (no customer message)',needs_owner_approval:'Needs owner approval or verification',retire:'Retire (recommended off; not turned off by this registry)'};
// Deterministic: no clock, so --check only changes when the registry does.
export function renderRegistryMarkdown(registry,hash){
  const lines=['# Automation registry (FUN-30)','',
    `Generated by \`node scripts/automation-inventory.mjs --write\` from \`functions/_lib/automation-registry-data.js\`. Do not edit by hand. Registry version \`${registry.registryVersion}\`, content hash \`${hash}\`.`,'',
    'Every path in this repository that can message a customer, or fire a HighLevel, Zapier or provider automation, is listed here and classified under the approval rule: a customer-facing send needs a person to approve that exact message, or an owner-approved fixed template registered here with its text hash. The registry only records and classifies. It never sends, and it never turns a live automation on or off.','',
    '`tests/automation-inventory.test.mjs` fails when a new send path, tag write, lifecycle event or approved-send kind appears in the code without a registry entry, so this list cannot silently fall behind the code.','',
    '## How it is used','',
    '- `GET /api/automation-registry` (Hub business users) returns this registry with the live attestation state, the go/no-go gates and the Hub writes behind each automation.',
    '- `node scripts/automation-inventory.mjs --ghl` lists the HighLevel workflows read-only (GET /workflows/, needs a token with workflow read access) and reports any workflow the registry does not know, any registered one that is missing, changed since it was verified, or published/draft against the registry.',
    '- Later units read the helpers in `functions/_lib/automation-registry.js`: `bookingMessages` gives the FUN-11 confirm dialog its texts, `evaluateGate` gives FUN-12 and FUN-35 their go/no-go, `classifyTouch` marks automation touches for speed to lead (FUN-14), and `diffGhlWorkflows` is the registry-drift check for FUN-25.',
    '- To register a new send path: add or extend an automation (with its trigger and code references) and the matching `codeInventory` count in the data file, then run `node scripts/automation-inventory.mjs --write`.','',
    '## Summary','','| Disposition | Count |','| --- | --- |',
    ...Object.entries(labels).map(([key,label])=>`| ${label} | ${registry.automations.filter(entry=>entry.disposition===key).length} |`),'',
    '## Inventory coverage','','| Source | Status | Verified | Method |','| --- | --- | --- | --- |',
    ...Object.entries(registry.sources).map(([name,source])=>`| ${name} | ${source.status} | ${source.verifiedAt||'never'} | ${cell(source.method)} |`),'',
    '## Go/no-go gates','','A gate opens only when every automation its writes can start is cleared, every listener list is owner-verified, and the monthly owner attestation is current.','',
    '| Gate | Unit | Blockers (besides the attestation) |','| --- | --- | --- |',
    ...registry.gates.map(gate=>{const blockers=gateBlockers(registry,gate.id);return `| ${cell(gate.label)} | ${gate.unit} | ${blockers.length?blockers.map(item=>`\`${item}\``).join(', '):'none'} |`;}),'',
    '## Monthly owner re-attestation','',
    'Once a month the owner (zacb) works through the checklist below, confirms that HighLevel, Zapier, Quo, EmailJS, Stripe and Jobber match this registry, and records an attestation entry `{attestedBy, attestedAt, registryHash}` in the data file. The attestation is due one calendar month (America/Denver) after the last one and becomes stale as soon as the registry content changes. No gate opens without a current attestation.','',
    registry.attestations.length?registry.attestations.map(item=>`- ${item.attestedAt} by ${item.attestedBy} (hash \`${item.registryHash}\`)`).join('\n'):'No attestation has been recorded yet.','',
    '## Owner verification checklist','',
    ...registry.automations.filter(entry=>entry.ownerCheck).map(entry=>`- [ ] **${cell(entry.name)}** (\`${entry.id}\`, ${entry.disposition}): ${cell(entry.ownerCheck)}`),'',
    '## Automations and send paths','',
    '| Id | Name | System | Trigger | Channel | Classification | Disposition | Sends today | Speed to lead | Template hash | Approved |','| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...registry.automations.map(entry=>`| \`${entry.id}\` | ${cell(entry.name)} | ${entry.system} | ${cell(entry.trigger)} | ${entry.channel} | ${entry.classification} | ${entry.disposition} | ${entry.sendsToday} | ${entry.speedToLead} | ${entry.templateHash?`\`${entry.templateHash.slice(0,12)}\``:'none'} | ${entry.approvedBy?`${entry.approvedBy} ${entry.approvedAt}`:automationCleared(entry)?'cleared':'no'} |`),'',
    '## Hub writes that can start each automation','',
    ...registry.automations.filter(entry=>(entry.listensTo||[]).length).flatMap(entry=>{const writes=hubWritesFor(registry,entry.id);return [`- **${cell(entry.name)}** (\`${entry.id}\`): ${writes.length?writes.map(write=>`\`${write.trigger}\` from \`${write.file}\` (${cell(write.when)})`).join('; '):'no Hub write; started outside the Hub'}`];}),'',
    '## Trigger surfaces','',
    '| Trigger | Listeners verified | Registered listeners | Hub writers |','| --- | --- | --- | --- |',
    ...registry.triggers.map(trigger=>`| \`${trigger.id}\` | ${trigger.listenersVerified?'yes':'no'} | ${listenersFor(registry,trigger.id).map(entry=>`\`${entry.id}\``).join(', ')||'none'} | ${[...new Set(trigger.hubWrites.map(write=>`\`${write.file}\`${write.automatic?' (automatic)':''}`))].join(', ')||'none today'} |`),'',
    '## Templates','',
    ...registry.automations.filter(entry=>entry.templateText).flatMap(entry=>[`### ${entry.name} (\`${entry.id}\`)`,'',`${entry.channel}${entry.subject?`, subject "${entry.subject}"`:''}; sha256 \`${entry.templateHash}\``,'','```text',entry.templateText,'```','']),
  ];
  return `${lines.join('\n').replace(/\n{3,}/g,'\n\n').trimEnd()}\n`;
}

export async function main(argv=process.argv.slice(2),{root=REPO_ROOT,env=process.env,fetcher=fetch,log=console.log,registry=AUTOMATION_REGISTRY}={}){
  const args=new Set(argv),scan=scanRepository(root);
  if(args.has('--scan')){log(JSON.stringify(scan,null,2));return 0;}
  const [problems,hash]=await Promise.all([registryProblems(registry),registryHash(registry)]);
  const drift=inventoryDrift(registry,scan),missing=missingReferences(registry,root),markdown=renderRegistryMarkdown(registry,hash),docPath=join(root,DOC);
  if(args.has('--write'))writeFileSync(docPath,markdown);
  const stale=args.has('--check')&&(!existsSync(docPath)||readFileSync(docPath,'utf8')!==markdown);
  log(`registry ${registry.registryVersion}: ${registry.automations.length} automations, ${registry.triggers.length} triggers, ${Object.keys(scan.inventory).length} files with send paths`);
  for(const line of [...problems.map(item=>`registry: ${item}`),...drift,...missing.map(file=>`missing file: ${file}`)])log(`  ✗ ${line}`);
  if(stale)log(`  ✗ ${DOC} is stale; run node scripts/automation-inventory.mjs --write`);
  if(args.has('--write'))log(`wrote ${DOC}`);
  let ghlFailed=false;
  if(args.has('--ghl')){
    try{
      const workflows=await fetchGhlWorkflows({token:env.HIGHLEVEL_API_KEY||env.GHL_API_KEY,locationId:env.HIGHLEVEL_LOCATION_ID||env.GHL_LOCATION_ID,fetcher});
      const diff=diffGhlWorkflows(registry,workflows);
      log(`HighLevel: ${diff.listed} workflows listed`);
      for(const row of diff.unregistered)log(`  ✗ unregistered workflow ${row.id} "${row.name}" (${row.status||'status unknown'})`);
      for(const row of diff.missing)log(`  ✗ registered workflow not listed: ${row.automationId} ${row.providerId}`);
      for(const row of diff.changed)log(`  ✗ changed since verification: ${row.automationId} updated ${row.updatedAt}, verified ${row.verifiedAt}`);
      for(const row of diff.statusMismatch)log(`  ✗ status ${row.status} but registry says sendsToday=${row.sendsToday}: ${row.automationId}`);
      ghlFailed=!diff.complete;
    }catch(error){log(`  ✗ HighLevel workflow listing failed: ${error.code||'error'} ${error.message}`);ghlFailed=true;}
  }
  return problems.length||drift.length||missing.length||stale||ghlFailed?1:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main();
