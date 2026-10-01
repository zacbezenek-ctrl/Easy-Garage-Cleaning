#!/usr/bin/env node
// Parallel-safe `firebase emulators:exec`. Each run gets free Firestore, websocket,
// hub and logging ports in a private .firebase-emulator.<pid>.json next to firestore.rules
// and a private log directory, so concurrent agents/CI jobs never share 8089/8090.
// The free ports are released before Java binds them, so another process can
// take one in that window. When the emulator fails on a taken port before the
// command started, the run is retried once with fresh ports.
//
//   node scripts/emulator-exec.mjs [--project demo-egc-x] [--config firebase.emulator.json]
//     [--keep-logs] [--] '<command run with FIRESTORE_EMULATOR_HOST set>'
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const ROOT=fileURLToPath(new URL('../',import.meta.url));
const USAGE="Usage: node scripts/emulator-exec.mjs [--project demo-egc-x] [--config firebase.emulator.json] [--keep-logs] [--] '<command>'";

export function parseArgs(argv){
 const options={project:'demo-egc-field-rules',config:'firebase.emulator.json',keepLogs:false},rest=[];
 for(let index=0;index<argv.length;index++){
  const arg=argv[index];
  if(arg==='--'){rest.push(...argv.slice(index+1));break;}
  if(arg==='--keep-logs'){options.keepLogs=true;continue;}
  const flag=/^--(project|config)(?:=(.*))?$/.exec(arg);
  if(flag){const value=flag[2]??argv[++index];if(!value||value.startsWith('--'))throw new Error(`--${flag[1]} needs a value. ${USAGE}`);options[flag[1]]=value;continue;}
  if(arg.startsWith('--'))throw new Error(`Unknown option ${arg}. ${USAGE}`);
  rest.push(arg);
 }
 options.script=rest.join(' ').trim();
 if(!options.script)throw new Error(`A command to run against the emulator is required. ${USAGE}`);
 if(!/^demo-[a-z0-9-]{1,40}$/.test(options.project))throw new Error(`Emulator runs must use a demo-* project id, not ${options.project}.`);
 return options;
}

// Hold every listener open until all are bound so the ports are distinct.
export async function freePorts(count,host='127.0.0.1'){
 const servers=[];
 try{
  for(let index=0;index<count;index++){const server=createServer();servers.push(server);await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,host,done);});}
  return servers.map(server=>server.address().port);
 }finally{await Promise.all(servers.map(server=>new Promise(done=>server.listening?server.close(done):done())));}
}

// firebase-tools probes 4400/4500/9150 by default, which races between concurrent starts.
export function emulatorConfig(base,{firestore,websocket,hub,logging},host='127.0.0.1'){
 const emulators=base.emulators||{};
 return {...base,emulators:{...emulators,firestore:{...emulators.firestore,host,port:firestore,websocketPort:websocket},hub:{host,port:hub},logging:{host,port:logging},ui:{enabled:false},singleProjectMode:emulators.singleProjectMode??true}};
}

// firebase runs from the private log directory; the command still runs from the caller's cwd.
// `started` is a file created just before the command runs, so a failure can be
// attributed to the emulator start-up (safe to retry) or to the command itself.
export function shellCommand(cwd,script,platform=process.platform,started=''){
 if(platform==='win32')return `cd /d "${cwd}" && ${started?`type nul > "${started}" && `:''}${script}`;
 const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
 return `cd ${quote(cwd)} && ${started?`: > ${quote(started)} && `:''}${script}`;
}

// firebase-tools: "Port N is not open on HOST, could not start …", "…, port taken.",
// "…configured port is already in use…"; Java: "BindException: Address already in use".
export const PORT_CONFLICT=/EADDRINUSE|address already in use|port taken|is not open on|configured port is already in use/i;
const tail=(text,limit=65536)=>text.length>limit?text.slice(-limit):text;
function logTail(logDir){
 let text='';
 for(const name of['firebase-debug.log','firestore-debug.log']){try{text+=tail(readFileSync(join(logDir,name),'utf8'))+'\n';}catch{}}
 return text;
}

export function firebaseCommand(env=process.env){
 if(env.EGC_FIREBASE_BIN)return /\.m?js$/.test(env.EGC_FIREBASE_BIN)?[process.execPath,env.EGC_FIREBASE_BIN]:[env.EGC_FIREBASE_BIN];
 const require=createRequire(resolve(env.EGC_FIREBASE_TEST_MODULES||ROOT,'package.json'));
 let manifest;
 try{manifest=require.resolve('firebase-tools/package.json');}
 catch{throw new Error('firebase-tools is not installed. Run: npm install --no-save --ignore-scripts firebase-tools@15.30.2 @firebase/rules-unit-testing@5.0.2 firebase@12.19.0');}
 const bin=JSON.parse(readFileSync(manifest,'utf8')).bin;
 return [process.execPath,join(dirname(manifest),typeof bin==='string'?bin:bin.firebase)];
}

async function attempt({project,config,script,keepLogs,root,cwd,env,stdio,onChild,log,pickPorts}){
 // Separate sandbox/process namespaces can report the same PID while sharing
 // this checkout. A per-attempt UUID prevents config and log collisions there.
 const baseConfig=resolve(root,config),id=`${process.pid}-${randomUUID()}`;
 const [firestore,websocket,hub,logging]=await pickPorts(4);
 const privateConfig=join(dirname(baseConfig),`.firebase-emulator.${id}.json`),logDir=resolve(root,'test-results',`emulator-${id}`),started=join(logDir,'.command-started');
 let code=1,output='';
 try{
  writeFileSync(privateConfig,JSON.stringify(emulatorConfig(JSON.parse(readFileSync(baseConfig,'utf8')),{firestore,websocket,hub,logging}),null,2)+'\n');
  mkdirSync(logDir,{recursive:true});
  const [command,...prefix]=firebaseCommand(env);
  log(`[emulator-exec] ${project}: firestore 127.0.0.1:${firestore} (websocket ${websocket}, hub ${hub}, logging ${logging}) using ${privateConfig}`);
  code=await new Promise((done,fail)=>{
   // Output is teed so a port conflict can be recognized; it is still shown live.
   const child=spawn(command,[...prefix,'emulators:exec','--only','firestore','--project',project,'--config',privateConfig,'--non-interactive',shellCommand(cwd,script,process.platform,started)],{cwd:logDir,env,stdio:[stdio==='inherit'?'inherit':'ignore','pipe','pipe']});
   for(const [stream,sink] of[[child.stdout,process.stdout],[child.stderr,process.stderr]])stream.on('data',chunk=>{output=tail(output+chunk);if(stdio==='inherit')sink.write(chunk);});
   onChild(child);child.once('error',fail);child.once('exit',(status,signal)=>done(signal?1:status??1));
  });
 }catch(error){log(`[emulator-exec] could not run firebase: ${error.message}`);code=127;}
 finally{rmSync(privateConfig,{force:true});}
 const commandStarted=existsSync(started),portConflict=code!==0&&code!==127&&!commandStarted&&PORT_CONFLICT.test(output+'\n'+logTail(logDir));
 return {code,ports:{firestore,websocket,hub,logging},config:privateConfig,logDir,commandStarted,portConflict};
}

// retries: how many times a start-up port conflict is retried with fresh ports
// (default once). A failure after the command started is never retried.
export async function runEmulatorExec({project='demo-egc-field-rules',config='firebase.emulator.json',script,keepLogs=false,root=ROOT,cwd=process.cwd(),env=process.env,stdio='inherit',onChild=()=>{},log=message=>process.stderr.write(message+'\n'),retries=1,pickPorts=freePorts}){
 const retriedPorts=[];let result;
 for(let run=0;;run++){
  result=await attempt({project,config,script,keepLogs,root,cwd,env,stdio,onChild,log,pickPorts});
  if(!result.portConflict||run>=retries)break;
  log(`[emulator-exec] port conflict before the command started (firestore ${result.ports.firestore}); retrying with fresh ports`);
  retriedPorts.push(result.ports);rmSync(result.logDir,{recursive:true,force:true});
 }
 let kept=false;
 if(result.code===0&&!keepLogs)rmSync(result.logDir,{recursive:true,force:true});
 else{kept=true;rmSync(join(result.logDir,'.command-started'),{force:true});log(`[emulator-exec] exit ${result.code}; emulator logs kept in ${result.logDir}`);}
 const {commandStarted,portConflict,...summary}=result;
 return {...summary,kept,attempts:retriedPorts.length+1,retriedPorts,portConflict};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 let options;
 try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(error.message);process.exit(2);}
 // Ctrl-C already reaches firebase through the process group; a second SIGINT would
 // force-quit it and orphan the Java emulator, so only SIGTERM is forwarded.
 let child;
 process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{child?.kill('SIGTERM');});
 const result=await runEmulatorExec({...options,onChild:value=>{child=value;}});
 process.exitCode=result.code;
}
