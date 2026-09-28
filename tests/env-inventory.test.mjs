import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {REPO_ROOT,DOC,TARGETS,inventory,problems,extractEnvReferences,collectReferences,diffTarget,parseExample,placeholderValue,renderMarkdown,scanSecrets,scanRepository,trackedFiles} from '../scripts/env-inventory.mjs';

// Secret-shaped fixtures are assembled at runtime so this tracked file never contains one.
const live=(prefix,body)=>prefix+body;
const SK=live('sk_'+'live_','51Synthetic'+'A1b2C3d4'.repeat(4)),RK=live('rk_'+'live_','51Synthetic'+'Z9y8X7w6'.repeat(4));
const WH=live('wh'+'sec_','Synthetic'+'Q1w2E3r4'.repeat(4)),PEM=(kind,headers='')=>`-----BEGIN ${kind}PRIVATE KEY-----\n${headers}${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(2)}\n-----END ${kind}PRIVATE KEY-----`;

function fixture(t,files){
  const root=mkdtempSync(join(tmpdir(),'egc-env-inventory-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const [path,text] of Object.entries(files)){mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),text);}
  return root;
}
const doc=(name,value='',tag='[plain; Cloudflare Pages variable]')=>`# Synthetic ${name} setting. Unset: synthetic default. ${tag}\n${name}=${value}\n`;
const names=groups=>groups.map(group=>group.names);

test('both .env.example files document every env var the code reads, and nothing stale',()=>{
  const report=inventory();
  assert.deepEqual(problems(report),[]);
  const [pages,platform]=report;
  assert.equal(pages.example,'.env.example');assert.equal(platform.example,'egc-platform/.env.example');
  assert.ok(pages.groups.length>=60&&platform.groups.length>=50,'the scan must actually find the Hub and platform reads');
  for(const target of report)for(const row of target.rows){
    if(row.reserved)assert.ok(row.purpose&&!row.active,`${target.example} ${row.name}: reserved note, commented out`);
    else assert.ok(row.where&&row.purpose&&row.unset,`${target.example} ${row.name}: where it is set, purpose and unset behaviour`);
  }
  // Known reads that were missing before SEC-10, including alias-only groups.
  const documented=target=>new Set(target.rows.filter(row=>!row.reserved).map(row=>row.name));
  for(const name of ['EGC_OPERATIONS_ENABLED','EGC_OPERATIONS_PORTAL_SIGNING_SECRET','HUB_PASSWORD_HASH_FALLBACK','HIGHLEVEL_PIPELINE_ID','QUO_API_BASE','QUICKBOOKS_CLIENT_SECRET'])assert.ok(documented(pages).has(name),name);
  for(const name of ['EGC_OPERATIONS_SERVICE_AUTH','EGC_RELEASE_SHA','EGC_BOOKING_ADOPT_EXISTING','CUSTOMER_OCCURRENCE_LEDGER_MODE','META_CAPI_EVENT_STAGES'])assert.ok(documented(platform).has(name),name);
  assert.deepEqual(platform.rows.filter(row=>row.reserved).map(row=>row.name).sort(),['API_URL','GHL_CLIENT_ID','GHL_CLIENT_SECRET','MCP_URL','PORTAL_PORT','REDIS_URL','SENTRY_DSN']);
  assert.ok(platform.rows.filter(row=>row.reserved).every(row=>!row.active),'reserved variables stay commented out');
  assert.deepEqual(pages.runtime,[]);assert.deepEqual(platform.runtime,['PORT','RAILWAY_GIT_COMMIT_SHA']);
  // The Durable Object binding is documented but must not be copied into .dev.vars as a string.
  assert.equal(pages.rows.find(row=>row.name==='HUB_PASSWORD_VERIFIER').active,false);
  assert.equal(pages.rows.find(row=>row.name==='STRIPE_SECRET_KEY').secret,true);
  assert.deepEqual(pages.rows.find(row=>row.name==='HIGHLEVEL_API_KEY').aliases,['GHL_API_KEY']);
  // Code reads these with ??, !==undefined or Number(), so an empty NAME= line copied into .dev.vars/.env is not "unset".
  for(const [target,name] of [[pages,'EGC_OPERATIONS_ENABLED'],[pages,'EGC_OPERATIONS_INBOUND_REPLY_MINUTES'],[platform,'CUSTOMER_EVIDENCE_MODEL'],[platform,'META_CAPI_EVENT_STAGES'],[platform,'EGC_RELEASE_SHA'],[platform,'EGC_PORTAL_ORIGIN']])
    assert.equal(target.rows.find(row=>row.name===name).active,false,`${name} stays commented out`);
  assert.equal(platform.rows.find(row=>row.name==='EGC_USER_CONFIRMED_BOOTSTRAP_JSON').secret,true,'customer text belongs in a sealed variable');
});

test('extraction finds every read form, keeps alias groups, and ignores prose',()=>{
  const source=[
    '/**',' * Reads env.SYNTH_JSDOC_ONLY in prose only.',' */',
    '// env.SYNTH_LINE_COMMENT_ONLY',
    "const a=env.SYNTH_DIRECT, b=env?.SYNTH_OPTIONAL, c=env['SYNTH_BRACKET'], d=env.get('SYNTH_METHOD');",
    "const token=env.SYNTH_PRIMARY||env.SYNTH_LEGACY||'fallback';",
    "const key=envVar(env,'SYNTH_CANON',['SYNTH_ALIAS_A','SYNTH_ALIAS_B']);",
    "const hl=envVar(env, 'SYNTH_HL') || envVar(env, 'SYNTH_GHL');",
    "const port=Number(process.env.PORT ?? process.env.SYNTH_PORT ?? 4100);",
    "const release=this.env.RAILWAY_GIT_COMMIT_SHA??this.env.SYNTH_RELEASE??null;",
    "if(env.SYNTH_FLAG==='true'||env.SYNTH_OTHER_FLAG==='true')go();",
    "const ok=!(env.SYNTH_X||env.SYNTH_Y)||!(env.SYNTH_Z);",
    "const any=(...keys)=>keys.some(k=>Boolean(env[k]));",
    "const all=(...keys)=>keys.every(k=>Boolean(env[k]));",
    "const status={one:any('SYNTH_ANY_A','SYNTH_ANY_B'),two:all('SYNTH_ALL_A','SYNTH_ALL_B'),three:any(dynamicName)};",
    "const ROUTES={quote:'SYNTH_ROUTE_URL',booking:'SYNTH_ROUTE_TWO_URL'};const STATES={a:'NOT_READ_BY_ENV'};",
    "const route=ROUTES[event],url=env[route];",
    "const PLANS={lite:{name:'Lite',priceEnv:'SYNTH_PRICE_LITE'}};"
  ].join('\n');
  const groups=extractEnvReferences(source);
  assert.deepEqual(names(groups),[
    ['SYNTH_DIRECT'],['SYNTH_OPTIONAL'],['SYNTH_BRACKET'],
    ['SYNTH_PRIMARY','SYNTH_LEGACY'],['SYNTH_CANON','SYNTH_ALIAS_A','SYNTH_ALIAS_B'],['SYNTH_HL','SYNTH_GHL'],
    ['PORT','SYNTH_PORT'],['RAILWAY_GIT_COMMIT_SHA','SYNTH_RELEASE'],['SYNTH_FLAG'],['SYNTH_OTHER_FLAG'],['SYNTH_X','SYNTH_Y'],['SYNTH_Z'],
    ['SYNTH_ANY_A','SYNTH_ANY_B'],['SYNTH_ALL_A'],['SYNTH_ALL_B'],['SYNTH_ROUTE_URL'],['SYNTH_ROUTE_TWO_URL'],['SYNTH_PRICE_LITE']
  ]);
  assert.equal(groups[0].line,5);
  const chain=name=>groups.find(group=>group.names.includes(name)).chain;
  assert.deepEqual(chain('SYNTH_PRIMARY'),[['SYNTH_PRIMARY'],['SYNTH_LEGACY']],'|| and ?? make fallbacks, in read order');
  assert.deepEqual(chain('SYNTH_CANON'),[['SYNTH_CANON','SYNTH_ALIAS_A','SYNTH_ALIAS_B']],'envVar aliases are one alternative');
  assert.deepEqual(chain('SYNTH_HL'),[['SYNTH_HL'],['SYNTH_GHL']]);
  assert.deepEqual(chain('SYNTH_ANY_A'),[['SYNTH_ANY_A','SYNTH_ANY_B']],'any() names are one alternative');
  assert.ok(!JSON.stringify(groups).includes('NOT_READ_BY_ENV'),'a constant table not read through env[] is not an env name');
  assert.deepEqual(names(extractEnvReferences("const ROUTES={a:'SYNTH_UNUSED_TABLE'};const x=env.SYNTH_ONLY;")),[['SYNTH_ONLY']],'tables count only when env is read with a computed key');
});

test('a synthetic repository proves missing, alias, allowlist, stale and reserved detection',t=>{
  const files={
    'functions/api/synthetic.js':"export const handler=env=>[env.SYNTH_REQUIRED,env.SYNTH_NEW||env.SYNTH_OLD,envVar(env,'SYNTH_KEY',['SYNTH_KEY_ALIAS']),env.SYNTH_RESERVED_BUT_READ];\n// env.SYNTH_ONLY_IN_A_COMMENT\n",
    'functions/api/status.js':"const any=(...keys)=>keys.some(k=>Boolean(env[k]));\nexport const ready=env=>any('SYNTH_BADGE','SYNTH_BADGE_ALIAS');\n",
    'egc-platform/apps/api/src/server.ts':"const port=Number(process.env.PORT??process.env.SYNTH_API_PORT??4100);\nconst mode=process.env.NODE_ENV,test=process.env.EGC_SYNTH_TEST,release=process.env.RAILWAY_GIT_COMMIT_SHA,path=process.env.PATH;\n",
    'egc-platform/services/synthetic/src/index.ts':"export const token=(env:NodeJS.ProcessEnv)=>env.SYNTH_PLATFORM_TOKEN;\n",
    'egc-platform/apps/api/test/server.test.ts':'process.env.SYNTH_ONLY_IN_TESTS;\n',
    'egc-platform/apps/api/src/server.test.ts':'process.env.SYNTH_ONLY_IN_UNIT_TESTS;\n',
    'egc-platform/services/synthetic/test/db.check.mjs':'process.env.SYNTH_ONLY_IN_CHECKS;\n',
    'egc-platform/apps/api/node_modules/dep/index.js':'process.env.SYNTH_DEPENDENCY;\n',
    'egc-platform/apps/portal/next-env.d.ts':'declare const x:typeof process.env.SYNTH_TYPES_ONLY;\n',
    '.env.example':doc('SYNTH_REQUIRED')+doc('SYNTH_KEY_ALIAS')+doc('SYNTH_STALE')+'# Old name kept for reference. [reserved, not read]\n# SYNTH_RESERVED_BUT_READ=\n',
    'egc-platform/.env.example':doc('SYNTH_PLATFORM_TOKEN','','[secret; Railway egc-api]')+doc('NODE_ENV','development','[plain; Railway all services]')
  };
  const root=fixture(t,files);
  let [pages,platform]=inventory(root);
  assert.deepEqual(pages.missing.map(group=>group.names),[['SYNTH_BADGE','SYNTH_BADGE_ALIAS'],['SYNTH_NEW'],['SYNTH_RESERVED_BUT_READ']]);
  assert.deepEqual(pages.missing[1],{names:['SYNTH_NEW'],fallbacks:['SYNTH_OLD'],files:['functions/api/synthetic.js']});
  assert.deepEqual(pages.unused,['SYNTH_STALE']);
  assert.deepEqual(pages.reservedRead,['SYNTH_RESERVED_BUT_READ']);
  assert.deepEqual(platform.missing.map(group=>group.names),[['SYNTH_API_PORT']],'runtime-provided names never satisfy or require an entry; the configurable fallback after them does');
  assert.deepEqual(platform.runtime,['EGC_SYNTH_TEST','PATH','PORT','RAILWAY_GIT_COMMIT_SHA'],'*_TEST and runtime names are allowlisted; documented NODE_ENV is not listed as runtime-only');
  assert.ok(!JSON.stringify([pages,platform].map(target=>target.groups)).match(/SYNTH_ONLY_IN|SYNTH_DEPENDENCY|SYNTH_TYPES_ONLY|SYNTH_ONLY_IN_A_COMMENT/),'tests, checks, dependencies, type declarations and comments are not reads');
  const report=problems([pages,platform]);
  assert.ok(report.some(line=>line==='.env.example: missing SYNTH_NEW (read in functions/api/synthetic.js; falls back to SYNTH_OLD)'),report.join('\n'));
  assert.ok(report.some(line=>line==='.env.example: missing SYNTH_BADGE | SYNTH_BADGE_ALIAS (read in functions/api/status.js)'),report.join('\n'));
  assert.ok(report.some(line=>line.includes('SYNTH_STALE is not read'))&&report.some(line=>line.includes('SYNTH_RESERVED_BUT_READ is marked reserved but code reads it')));

  // Documenting only the || fallback does not document the primary name read before it.
  const fixed=doc('SYNTH_REQUIRED')+doc('SYNTH_KEY_ALIAS')+doc('SYNTH_BADGE_ALIAS')+doc('SYNTH_RESERVED_BUT_READ');
  writeFileSync(join(root,'.env.example'),fixed+doc('SYNTH_OLD'));
  assert.deepEqual(inventory(root)[0].missing,[{names:['SYNTH_NEW'],fallbacks:['SYNTH_OLD'],files:['functions/api/synthetic.js']}]);

  // Documenting each primary name (any ONE name of an explicit alias list), dropping the stale entry and
  // un-reserving the read name clears every problem.
  writeFileSync(join(root,'.env.example'),fixed+doc('SYNTH_NEW'));
  writeFileSync(join(root,'egc-platform/.env.example'),files['egc-platform/.env.example']+doc('SYNTH_API_PORT','4100','[plain; local only]'));
  [pages,platform]=inventory(root);
  assert.deepEqual(problems([pages,platform]),[]);
  assert.deepEqual(pages.rows.find(row=>row.name==='SYNTH_NEW').aliases,['SYNTH_OLD']);
  assert.deepEqual(pages.rows.find(row=>row.name==='SYNTH_KEY_ALIAS').aliases,['SYNTH_KEY']);

  // Each read is judged on its own order: env.B||env.A in one file cannot hide an undocumented A read first elsewhere.
  writeFileSync(join(root,'functions/api/order-a.js'),'export const a=env=>env.SYNTH_ORDER_A||env.SYNTH_ORDER_B;\n');
  writeFileSync(join(root,'functions/api/order-b.js'),'export const b=env=>env.SYNTH_ORDER_B||env.SYNTH_ORDER_A;\n');
  writeFileSync(join(root,'.env.example'),fixed+doc('SYNTH_NEW')+doc('SYNTH_ORDER_B'));
  assert.deepEqual(inventory(root)[0].missing,[{names:['SYNTH_ORDER_A'],fallbacks:['SYNTH_ORDER_B'],files:['functions/api/order-a.js']}]);
  writeFileSync(join(root,'.env.example'),fixed+doc('SYNTH_NEW')+doc('SYNTH_ORDER_A'));
  assert.deepEqual(inventory(root)[0].missing,[{names:['SYNTH_ORDER_B'],fallbacks:['SYNTH_ORDER_A'],files:['functions/api/order-b.js']}]);
  writeFileSync(join(root,'.env.example'),fixed+doc('SYNTH_NEW')+doc('SYNTH_ORDER_A')+doc('SYNTH_ORDER_B'));
  assert.deepEqual(inventory(root)[0].missing,[]);

  // A new read without an example entry fails again.
  writeFileSync(join(root,'functions/api/new-feature.js'),"export const on=env=>env.SYNTH_BRAND_NEW_FLAG==='true';\n");
  assert.deepEqual(inventory(root)[0].missing.map(group=>group.names),[['SYNTH_BRAND_NEW_FLAG']]);
  assert.deepEqual(inventory(root,[{...TARGETS[0],example:'missing/.env.example'}])[0].formatErrors,['missing/.env.example is missing']);
});

test('against the real .env.example, a primary name is required even when its fallback is documented',()=>{
  const text=readFileSync(join(REPO_ROOT,'.env.example'),'utf8'),references=collectReferences(REPO_ROOT,TARGETS[0]);
  const read=(file,source)=>extractEnvReferences(source).map(group=>({...group,file}));
  const without=text.replace(/^# [^\n]*\nCUSTOMER_PORTAL_SECRET=[^\n]*\n/m,'');
  assert.notEqual(without,text,'the fixture removes the CUSTOMER_PORTAL_SECRET entry');
  assert.deepEqual(diffTarget(references,parseExample(without)).missing,
    [{names:['CUSTOMER_PORTAL_SECRET'],fallbacks:['HUB_SESSION_SECRET'],files:['functions/_lib/customer-portal.js']}]);
  const added=[...references,...read('functions/_lib/new-purpose.js','export const key=env=>env.EGC_NEW_PURPOSE_SECRET||env.HUB_SESSION_SECRET;\n'),
    ...read('functions/api/new-hook.js',"export const url=env=>String(env.EGC_NEW_HOOK_URL||env.CREW_WEBHOOK_URL||'');\n")];
  const {missing}=diffTarget(added,parseExample(text));
  assert.deepEqual(missing,[
    {names:['EGC_NEW_PURPOSE_SECRET'],fallbacks:['HUB_SESSION_SECRET'],files:['functions/_lib/new-purpose.js']},
    {names:['EGC_NEW_HOOK_URL'],fallbacks:['CREW_WEBHOOK_URL'],files:['functions/api/new-hook.js']}
  ]);
});

test('example comments must say what, when unset, secret-ness and where, and never hold a real secret',()=>{
  const {vars,errors}=parseExample([
    '# Section header without a variable.','',
    '# Signs sessions. Unset: sign-in fails closed. [secret; Cloudflare Pages secret]','SYNTH_SECRET=',
    '# Local database. Unset: startup fails. [secret; Railway all services]','SYNTH_DB=postgres://egc:egc@localhost:5432/egc',
    '# Accounts. Unset: none. [secret; Cloudflare Pages secret]','SYNTH_JSON={}',
    '# Remote database. Unset: startup fails. [secret; Railway all services]','SYNTH_REMOTE_DB=postgres://user:pass@db.example.invalid:5432/egc',
    '# A key. Unset: nothing works. [secret; Cloudflare Pages secret]','SYNTH_LEAKED=synthetic-real-looking-value',
    'SYNTH_UNDOCUMENTED=',
    '# Missing the tag. Unset: nothing.','SYNTH_UNTAGGED=',
    '# Has no unset behaviour. [plain; Cloudflare Pages variable]','SYNTH_NO_UNSET=',
    '# Minutes. Unset or invalid: 60. [plain; Cloudflare Pages variable]','SYNTH_QUALIFIED=',
    '# Binding. Unset: fallback. [plain; Cloudflare Pages Durable Object binding]','# SYNTH_BINDING=<binding>',
    '# Old. [reserved, not read]','SYNTH_ACTIVE_RESERVED=',
    '# Again. Unset: x. [plain; Cloudflare Pages variable]','SYNTH_SECRET=',
    '# Trailing dots. Unset: x. [secret; Cloudflare Pages secret]','SYNTH_TRAILING_DOTS=synthetic-real-looking-value...',
    '# Inner note. Unset: x. [secret; Cloudflare Pages secret]','SYNTH_INNER_NOTE=synthetic<note>value',
    '# Hook with id. Unset: x. [secret; Cloudflare Pages secret]','SYNTH_HOOK_ID=https://hooks.example.invalid/hooks/catch/123/abc/...',
    '# JSON leak. Unset: x. [secret; Cloudflare Pages secret]','SYNTH_JSON_LEAK={"user":{"passwordHash":"<hash>","token":"synthetic-real-looking"}}',
    '# JSON shape. Unset: x. [secret; Cloudflare Pages secret]','SYNTH_JSON_SHAPE={"<username>":{"passwordHash":"<hash>","role":"<owner|crew>","hourlyRate":0,"active":true}}',
    '# Prefixes. Unset: x. [secret; Cloudflare Pages secret]','SYNTH_PREFIX=sk_live_...',
    '# Hook. Unset: x. [secret; Cloudflare Pages secret]','SYNTH_HOOK=https://hooks.example.invalid/hooks/catch/...',
    '# Whole placeholder. Unset: x. [secret; Cloudflare Pages secret]','SYNTH_WHOLE=<whole downloaded JSON object>'
  ].join('\n'));
  assert.deepEqual(errors,[
    'SYNTH_REMOTE_DB: secret example value must be empty or a <placeholder>/... value',
    'SYNTH_LEAKED: secret example value must be empty or a <placeholder>/... value',
    'SYNTH_UNDOCUMENTED: needs a one-line "# … [secret|plain; where]" comment directly above it',
    'SYNTH_UNTAGGED: comment must end with [secret; where], [plain; where] or [reserved, not read]',
    'SYNTH_NO_UNSET: comment must say what it does and "Unset: …" behaviour',
    'SYNTH_ACTIVE_RESERVED: reserved variables must be commented out',
    'SYNTH_SECRET: documented twice (lines 4 and 25)',
    'SYNTH_TRAILING_DOTS: secret example value must be empty or a <placeholder>/... value',
    'SYNTH_INNER_NOTE: secret example value must be empty or a <placeholder>/... value',
    'SYNTH_HOOK_ID: secret example value must be empty or a <placeholder>/... value',
    'SYNTH_JSON_LEAK: secret example value must be empty or a <placeholder>/... value'
  ]);
  for(const value of ['','{}','[]','<x>','whsec_...','sk-...','postgres://egc:egc@localhost:5432/egc','{"a":["<b>",1,null]}'])assert.equal(placeholderValue(value),true,value);
  for(const value of ['sk_live_x...','<a>b','a<b>','http://hooks.example.invalid/...','postgres://egc:egc@db.example.invalid/egc','{"a":"b"}','{"a":',"['<a>']"])assert.equal(placeholderValue(value),false,value);
  assert.deepEqual(vars.get('SYNTH_SECRET'),{name:'SYNTH_SECRET',line:4,active:true,value:'',secret:true,where:'Cloudflare Pages secret',reserved:false,purpose:'Signs sessions.',unset:'sign-in fails closed.'});
  assert.equal(vars.get('SYNTH_QUALIFIED').unset,'(or invalid) 60.');
  assert.equal(vars.get('SYNTH_BINDING').active,false);
});

test('the secret scan flags live Stripe keys, webhook secrets and private keys but not placeholders',t=>{
  const findings=text=>scanSecrets(text).map(finding=>finding.pattern);
  assert.deepEqual(findings(`key=${SK}`),['stripe_live_secret_key']);
  assert.deepEqual(findings(`key=${RK}`),['stripe_live_restricted_key']);
  assert.deepEqual(findings(`STRIPE_WEBHOOK_SECRET=${WH}`),['stripe_webhook_secret']);
  assert.deepEqual(findings(PEM('')),['private_key']);
  assert.deepEqual(findings(PEM('RSA ')),['private_key']);
  assert.deepEqual(findings(JSON.stringify({private_key:PEM('')})),['private_key'],'JSON-escaped newlines in service-account files');
  assert.deepEqual(findings(`https://example.invalid/pay?key%3D${SK}`),['stripe_live_secret_key'],'URL-encoded keys have no word boundary');
  assert.deepEqual(findings(`const x_${SK}=1;x_${RK};STRIPE_x${WH}`),['stripe_live_secret_key','stripe_live_restricted_key','stripe_webhook_secret'],'keys glued to identifiers');
  const LEGACY='Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF\n\n';
  assert.deepEqual(findings(PEM('RSA ',LEGACY)),['private_key'],'legacy encrypted PEM header lines');
  assert.deepEqual(findings(JSON.stringify({key:PEM('EC ',LEGACY)})),['private_key'],'JSON-escaped legacy PEM');
  assert.deepEqual(findings(PEM('PGP ','Version: Synthetic 1\n\n').replace(/KEY-----/g,'KEY BLOCK-----')),['private_key'],'armored PGP private key');
  for(const safe of ['STRIPE_SECRET_KEY=sk_live_...','copy its whsec_... here','whsec_synthetic_deposit','sk_test_synthetic_deposit','-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
    String.raw`/^-----BEGIN PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]+\s+-----END PRIVATE KEY-----$/`,'replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\\s/g, \'\')'])assert.deepEqual(findings(safe),[],safe);
  assert.deepEqual(scanSecrets(`one\ntwo ${SK}\nthree\n${WH}`).map(finding=>finding.line),[2,4]);

  const root=fixture(t,{'config/leak.json':`{"key":"${SK}"}`,'notes/clean.md':'sk_live_... placeholder','images/photo.webp':SK,'data/blob.bin':Buffer.concat([Buffer.from([0,1,2]),Buffer.from(WH)]),'src/pem.js':`export const k=${JSON.stringify(PEM('EC '))};`});
  const found=scanRepository(root,['config/leak.json','notes/clean.md','images/photo.webp','data/blob.bin','src/pem.js','deleted/file.txt']);
  assert.deepEqual(found,[{file:'config/leak.json',pattern:'stripe_live_secret_key',line:1},{file:'src/pem.js',pattern:'private_key',line:1}]);
  assert.ok(!JSON.stringify(found).includes(SK.slice(8)),'findings never echo the secret value');
});

test('tracked files contain no live Stripe keys, webhook secrets or private keys',()=>{
  const files=trackedFiles();
  assert.ok(files.length>100&&files.includes('.env.example')&&files.includes('functions/_lib/hub-session.js'),'the scan must cover the tracked tree');
  assert.deepEqual(scanRepository(REPO_ROOT,files),[]);
});

test('docs/env-inventory.md lists exactly the documented and runtime variables, never their values',()=>{
  const report=inventory(),markdown=renderMarkdown(report),committed=readFileSync(join(REPO_ROOT,DOC),'utf8');
  const expected=new Set(report.flatMap(target=>[...target.rows.map(row=>row.name),...target.runtime]));
  const listed=text=>new Set([...text.matchAll(/^\| `([A-Za-z_][A-Za-z0-9_]*)`/gm)].map(match=>match[1]));
  assert.deepEqual([...listed(markdown)].sort(),[...expected].sort());
  assert.deepEqual([...listed(committed)].sort(),[...expected].sort(),'regenerate with: node scripts/env-inventory.mjs --write');
  for(const value of ['sk_live_...','whsec_...','postgres://egc:egc','<generated-pbkdf2-hash>','hooks.zapier.com'])assert.ok(!markdown.includes(value),value);
  assert.match(markdown,/\| `HIGHLEVEL_API_KEY`<br>aliases: `GHL_API_KEY` \| Cloudflare Pages secret \| yes \|/);
});
