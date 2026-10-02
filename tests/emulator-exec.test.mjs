import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PORT_CONFLICT,emulatorConfig,firebaseCommand,freePorts,parseArgs,runEmulatorExec,shellCommand} from '../scripts/emulator-exec.mjs';

const SCRIPT=fileURLToPath(new URL('../scripts/emulator-exec.mjs',import.meta.url));
// Stands in for firebase-tools: binds the configured Firestore port exclusively,
// writes a debug log into its cwd, then runs the script like emulators:exec does.
// A taken port fails the way firebase-tools reports it, before the script runs.
const FAKE_FIREBASE=`import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createServer} from 'node:net';import {spawn} from 'node:child_process';import {dirname,resolve} from 'node:path';
const args=process.argv.slice(2),value=name=>args[args.indexOf(name)+1],configPath=value('--config'),config=JSON.parse(readFileSync(configPath,'utf8'));
if(args[0]!=='emulators:exec'||value('--only')!=='firestore'||!args.includes('--non-interactive'))process.exit(90);
if(!existsSync(resolve(dirname(configPath),config.firestore.rules)))process.exit(91);
const {host,port}=config.emulators.firestore,server=createServer();
server.once('error',error=>{console.log('Port '+port+' is not open on '+host+', could not start Cloud Firestore Emulator.');writeFileSync('firebase-debug.log','listen '+error.code+' '+host+':'+port);console.error('Error: Could not start Cloud Firestore Emulator, port taken.');process.exit(1);});
server.listen(port,host,()=>{writeFileSync('firestore-debug.log','synthetic emulator log for '+port);
 const child=spawn(args.at(-1),{shell:true,stdio:'inherit',env:{...process.env,FIRESTORE_EMULATOR_HOST:host+':'+port,GCLOUD_PROJECT:value('--project')}});
 child.on('exit',code=>server.close(()=>process.exit(code??1)));});`;
const PROBE="import {writeFileSync} from 'node:fs';const [out,delay='0',code='0']=process.argv.slice(2);await new Promise(done=>setTimeout(done,Number(delay)));writeFileSync(out,JSON.stringify({host:process.env.FIRESTORE_EMULATOR_HOST,project:process.env.GCLOUD_PROJECT,cwd:process.cwd()}));process.exit(Number(code));";

function workspace(t){
 const root=mkdtempSync(join(tmpdir(),'egc-emulator-exec-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'firebase.emulator.json'),JSON.stringify({firestore:{rules:'firestore.rules'},emulators:{firestore:{host:'127.0.0.1',port:8089},ui:{enabled:false},singleProjectMode:true}}));
 writeFileSync(join(root,'firestore.rules'),"rules_version = '2';");
 writeFileSync(join(root,'fake-firebase.mjs'),FAKE_FIREBASE);writeFileSync(join(root,'probe.mjs'),PROBE);
 return {root,env:{...process.env,EGC_FIREBASE_BIN:join(root,'fake-firebase.mjs')}};
}
const quiet={stdio:'ignore',log:()=>{}};
const leftovers=root=>readdirSync(root).filter(name=>name.startsWith('.firebase-emulator.'));

test('arguments default to the rules project, require a command and refuse non-demo projects',()=>{
 assert.deepEqual(parseArgs(['node --test tests/x.test.mjs']),{project:'demo-egc-field-rules',config:'firebase.emulator.json',keepLogs:false,script:'node --test tests/x.test.mjs'});
 assert.deepEqual(parseArgs(['--project=demo-egc-dispatch-day','--config','firebase.field-day.json','--keep-logs','--','node','tests/a.browser.mjs','--flag']),{project:'demo-egc-dispatch-day',config:'firebase.field-day.json',keepLogs:true,script:'node tests/a.browser.mjs --flag'});
 assert.throws(()=>parseArgs([]),/command to run/);
 assert.throws(()=>parseArgs(['--project','egcw-1ec83','node x']),/demo-\* project id/);
 assert.throws(()=>parseArgs(['--project','demo-Real Project','node x']),/demo-\* project id/);
 assert.throws(()=>parseArgs(['--project']),/needs a value/);
 assert.throws(()=>parseArgs(['--port','1','node x']),/Unknown option --port/);
 assert.throws(()=>parseArgs(['--only','firestore','node x']),/Unknown option --only/);
});

test('private config pins every emulator port, keeps the rules path and disables the UI',()=>{
 const base={firestore:{rules:'firestore.rules'},emulators:{firestore:{host:'127.0.0.1',port:8089},ui:{enabled:true}}};
 const config=emulatorConfig(base,{firestore:41001,websocket:41002,hub:41003,logging:41004});
 assert.deepEqual(config,{firestore:{rules:'firestore.rules'},emulators:{firestore:{host:'127.0.0.1',port:41001,websocketPort:41002},hub:{host:'127.0.0.1',port:41003},logging:{host:'127.0.0.1',port:41004},ui:{enabled:false},singleProjectMode:true}});
 assert.equal(base.emulators.firestore.port,8089);
 assert.equal(emulatorConfig({emulators:{singleProjectMode:false}},{firestore:1,websocket:2,hub:3,logging:4}).emulators.singleProjectMode,false);
});

test('the command runs from the caller directory with shell-safe quoting',()=>{
 assert.equal(shellCommand("/work/it's here",'node --test','linux'),"cd '/work/it'\\''s here' && node --test");
 assert.equal(shellCommand('C:\\work','node --test','win32'),'cd /d "C:\\work" && node --test');
 assert.equal(shellCommand('/work',"node --test",'linux',"/logs/it's/.command-started"),"cd '/work' && : > '/logs/it'\\''s/.command-started' && node --test");
 assert.equal(shellCommand('C:\\work','node --test','win32','C:\\logs\\.command-started'),'cd /d "C:\\work" && type nul > "C:\\logs\\.command-started" && node --test');
 assert.deepEqual(firebaseCommand({EGC_FIREBASE_BIN:'/opt/fake/firebase.mjs'}),[process.execPath,'/opt/fake/firebase.mjs']);
 assert.deepEqual(firebaseCommand({EGC_FIREBASE_BIN:'/usr/local/bin/firebase'}),['/usr/local/bin/firebase']);
 assert.throws(()=>firebaseCommand({EGC_FIREBASE_TEST_MODULES:join(tmpdir(),'egc-no-firebase-tools-here')}),/firebase-tools is not installed/);
});

test('free ports are distinct and immediately bindable',async()=>{
 const ports=await freePorts(4);
 assert.equal(new Set(ports).size,4);
 for(const port of ports){const server=createServer();await new Promise((done,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',done);});await new Promise(done=>server.close(done));}
});

test('two concurrent runs get separate emulators, run in the caller cwd and clean up',async t=>{
 const {root,env}=workspace(t);
 const runs=await Promise.all(['a','b'].map(name=>runEmulatorExec({...quiet,root,env,cwd:root,project:'demo-egc-parallel-'+name,script:`node probe.mjs out-${name}.json 400`})));
 assert.deepEqual(runs.map(run=>run.code),[0,0]);
 const seen=['a','b'].map(name=>JSON.parse(readFileSync(join(root,`out-${name}.json`),'utf8')));
 assert.deepEqual(seen.map(probe=>probe.project),['demo-egc-parallel-a','demo-egc-parallel-b']);
 assert.deepEqual(seen.map(probe=>probe.host),runs.map(run=>`127.0.0.1:${run.ports.firestore}`));
 assert.notEqual(seen[0].host,seen[1].host);assert.ok(seen.every(probe=>probe.cwd===root));
 assert.equal(new Set(runs.flatMap(run=>Object.values(run.ports))).size,8);
 assert.ok(runs.every(run=>run.config.startsWith(join(root,'.firebase-emulator.'))&&!existsSync(run.config)&&!existsSync(run.logDir)&&!run.kept));
 assert.notEqual(runs[0].config,runs[1].config);assert.deepEqual(leftovers(root),[]);
});

test('independent module instances with the same PID cannot collide on config or logs',async t=>{
 const {root,env}=workspace(t);
 const instances=await Promise.all(['namespace-a','namespace-b'].map(key=>import(`../scripts/emulator-exec.mjs?${key}`)));
 const runs=await Promise.all(instances.map((module,index)=>module.runEmulatorExec({...quiet,root,env,cwd:root,keepLogs:true,project:`demo-egc-isolated-${index}`,script:`node probe.mjs isolated-${index}.json 200`})));
 assert.deepEqual(runs.map(run=>run.code),[0,0]);
 assert.notEqual(runs[0].config,runs[1].config);assert.notEqual(runs[0].logDir,runs[1].logDir);
 for(const [index,run] of runs.entries()){
  const seen=JSON.parse(readFileSync(join(root,`isolated-${index}.json`),'utf8'));
  assert.equal(seen.project,`demo-egc-isolated-${index}`);assert.equal(seen.host,`127.0.0.1:${run.ports.firestore}`);
  assert.equal(readFileSync(join(run.logDir,'firestore-debug.log'),'utf8'),'synthetic emulator log for '+run.ports.firestore);
 }
 assert.deepEqual(leftovers(root),[]);
});

test('a failing command keeps its exit code and emulator log but still removes the private config',async t=>{
 const {root,env}=workspace(t);
 const run=await runEmulatorExec({...quiet,root,env,cwd:root,script:'node probe.mjs out.json 0 3'});
 assert.equal(run.code,3);assert.equal(run.kept,true);assert.equal(existsSync(run.config),false);
 assert.equal(readFileSync(join(run.logDir,'firestore-debug.log'),'utf8'),'synthetic emulator log for '+run.ports.firestore);
 const missing=await runEmulatorExec({...quiet,root,env:{...env,EGC_FIREBASE_BIN:join(root,'no-such-firebase')},cwd:root,script:'node probe.mjs never.json'});
 assert.equal(missing.code,127);assert.equal(existsSync(missing.config),false);assert.equal(existsSync(join(root,'never.json')),false);
 assert.deepEqual(leftovers(root),[]);
});

test('the CLI propagates the exit status and refuses production project ids before starting anything',async t=>{
 const {root,env}=workspace(t);
 const cli=(...args)=>new Promise(done=>{const child=spawn(process.execPath,[SCRIPT,...args],{cwd:root,env,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});child.on('exit',code=>done({code,stderr}));});
 const refused=await cli('--project','egcw-1ec83','node probe.mjs refused.json');
 assert.equal(refused.code,2);assert.match(refused.stderr,/demo-\* project id/);assert.equal(existsSync(join(root,'refused.json')),false);
 const failed=await cli('--project','demo-egc-cli','--keep-logs','node probe.mjs cli.json 0 4');
 assert.equal(failed.code,4);assert.match(failed.stderr,/\[emulator-exec\] demo-egc-cli: firestore 127\.0\.0\.1:\d+/);
 const kept=/emulator logs kept in (.+)$/m.exec(failed.stderr)[1];t.after(()=>rmSync(kept,{recursive:true,force:true}));
 assert.equal(JSON.parse(readFileSync(join(root,'cli.json'),'utf8')).project,'demo-egc-cli');assert.ok(existsSync(join(kept,'firestore-debug.log')));
});

test('a port taken before the emulator starts is retried once with fresh ports, never after the command ran',async t=>{
 const {root,env}=workspace(t),logs=[];
 const holder=createServer();await new Promise((done,fail)=>{holder.once('error',fail);holder.listen(0,'127.0.0.1',done);});t.after(()=>new Promise(done=>holder.close(done)));
 const taken=holder.address().port;let picks=0;
 const firstTaken=async count=>{const fresh=await freePorts(count);return picks++===0?[taken,...fresh.slice(1)]:fresh;};
 const run=await runEmulatorExec({stdio:'ignore',log:message=>logs.push(message),root,env,cwd:root,pickPorts:firstTaken,script:'node probe.mjs retried.json'});
 assert.equal(run.code,0);assert.equal(run.attempts,2);assert.equal(picks,2);assert.equal(run.kept,false);
 assert.equal(run.retriedPorts[0].firestore,taken);assert.notEqual(run.ports.firestore,taken);
 assert.equal(JSON.parse(readFileSync(join(root,'retried.json'),'utf8')).host,`127.0.0.1:${run.ports.firestore}`);
 assert.match(logs.join('\n'),new RegExp(`port conflict before the command started \\(firestore ${taken}\\); retrying with fresh ports`));
 assert.deepEqual(readdirSync(join(root,'test-results')),[]);assert.deepEqual(leftovers(root),[]);
 const alwaysTaken=async count=>{const fresh=await freePorts(count);return [taken,...fresh.slice(1)];};
 const stuck=await runEmulatorExec({...quiet,root,env,cwd:root,pickPorts:alwaysTaken,script:'node probe.mjs never.json'});
 assert.equal(stuck.code,1);assert.equal(stuck.attempts,2);assert.equal(stuck.portConflict,true);assert.equal(stuck.kept,true);
 assert.equal(existsSync(join(root,'never.json')),false);assert.match(readFileSync(join(stuck.logDir,'firebase-debug.log'),'utf8'),/EADDRINUSE/);
 const once=await runEmulatorExec({...quiet,root,env,cwd:root,retries:0,pickPorts:alwaysTaken,script:'node probe.mjs never.json'});
 assert.deepEqual([once.code,once.attempts],[1,1]);
 const own=await runEmulatorExec({...quiet,root,env,cwd:root,script:`node -e "require('node:fs').appendFileSync('runs.txt','run;');console.error('Error: listen EADDRINUSE: address already in use 127.0.0.1:3000');process.exit(5)"`});
 assert.deepEqual([own.code,own.attempts,own.portConflict],[5,1,false]);assert.equal(readFileSync(join(root,'runs.txt'),'utf8'),'run;');
 assert.equal(existsSync(join(own.logDir,'.command-started')),false);assert.deepEqual(leftovers(root),[]);
 for(const text of['Port 41001 is not open on 127.0.0.1, could not start Cloud Firestore Emulator.','Could not start Cloud Firestore Emulator, port taken.','java.net.BindException: Address already in use','Error: listen EADDRINUSE: address already in use'])assert.match(text,PORT_CONFLICT);
 assert.doesNotMatch('Error: firestore.rules:3:1 syntax error',PORT_CONFLICT);
});
