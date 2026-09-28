import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

// The preload is exercised in a child process so the suite itself may already run shifted.
// Each probe measures the shift against performance.timeOrigin, which the preload never touches.
// --import and import() take URLs: a bare C:\ path fails on Windows with
// ERR_UNSUPPORTED_ESM_URL_SCHEME, so every helper is passed as pathToFileURL(path).href.
const helperUrl=name=>pathToFileURL(fileURLToPath(new URL(`./helpers/${name}`,import.meta.url))).href;
const preload=helperUrl('shift-clock.mjs');
const realmHelper=helperUrl('vm-realm.mjs');
const UTC_CLOCK='new Intl.DateTimeFormat("sv-SE",{timeZone:"UTC",dateStyle:"short",timeStyle:"medium"})';
const PARSE_UTC='text=>Date.parse(text.replace(" ","T")+"Z")';
const DAY=86400000,TOLERANCE=5000;
function probe(days,source){
 const env={...process.env,TZ:'UTC'};delete env.NODE_OPTIONS;delete env.EGC_CLOCK_SHIFT_DAYS;
 if(days!==undefined)env.EGC_CLOCK_SHIFT_DAYS=days;
 const result=spawnSync(process.execPath,['--import',preload,'--input-type=module','-e',`const real=()=>performance.timeOrigin+performance.now();const report=${source};process.stdout.write(JSON.stringify(await report()));`],{env,encoding:'utf8',timeout:30000});
 return {...result,value:result.status===0?JSON.parse(result.stdout):undefined};
}
const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<TOLERANCE,`${message}: ${actual} is not within ${TOLERANCE}ms of ${expected}`);

test('shift-clock moves Date.now, new Date() and Date() while explicit dates stay exact',()=>{
 const {value,stderr,status}=probe('400',`()=>({
  now:Date.now()-real(),
  constructed:new Date().getTime()-real(),
  called:Date.parse(Date())-real(),
  fixedIso:new Date('2026-09-22T12:00:00.000Z').toISOString(),
  fixedParts:new Date(2026,8,22,12,0,0).toISOString(),
  epoch:new Date(0).getTime(),
  copy:new Date(new Date('2026-09-22T12:00:00.000Z')).toISOString(),
  invalid:String(new Date(undefined).getTime()),
  parse:Date.parse('2026-09-22T12:00:00.000Z'),
  utc:Date.UTC(2026,8,22,12),
  instance:new Date() instanceof Date&&Object.prototype.toString.call(new Date())==='[object Date]',
  prototype:Object.getPrototypeOf(new Date())===Date.prototype,
  shape:[Date.name,Date.length,typeof Date],
  subclass:(()=>{class Stamp extends Date{};const shifted=new Stamp(),fixed=new Stamp(0);return {instance:shifted instanceof Stamp&&shifted instanceof Date,shift:shifted.getTime()-real(),fixed:fixed.getTime()};})(),
  viaConstructor:new (new Date(0).constructor)().getTime()-real(),
  sameConstructor:new Date(0).constructor===Date,
  viaDescriptor:Object.getOwnPropertyDescriptor(Date,'now').value()-real(),
  viaDescriptors:Object.getOwnPropertyDescriptors(Date).now.value()-real(),
  formatted:(${PARSE_UTC})(${UTC_CLOCK}.format())-real(),
  formattedParts:(${PARSE_UTC})(${UTC_CLOCK}.formatToParts().map(part=>part.value).join(''))-real(),
  formattedFixed:[${UTC_CLOCK}.format(0),${UTC_CLOCK}.formatToParts(new Date(0)).map(part=>part.value).join('')],
  formatCached:(()=>{const clock=${UTC_CLOCK};return clock.format===clock.format;})()
 })`);
 assert.equal(status,0,stderr);
 near(value.now,400*DAY,'Date.now()');
 near(value.constructed,400*DAY,'new Date()');
 near(value.called,400*DAY,'Date()');
 near(value.subclass.shift,400*DAY,'subclass without arguments');
 assert.equal(value.fixedIso,'2026-09-22T12:00:00.000Z');
 assert.equal(value.fixedParts,'2026-09-22T12:00:00.000Z');
 assert.equal(value.epoch,0);
 assert.equal(value.copy,'2026-09-22T12:00:00.000Z');
 assert.equal(value.invalid,'NaN');
 assert.equal(value.parse,Date.UTC(2026,8,22,12));
 assert.equal(value.utc,Date.UTC(2026,8,22,12));
 assert.equal(value.instance,true);
 assert.equal(value.prototype,true);
 assert.deepEqual(value.shape,['Date',7,'function']);
 assert.equal(value.subclass.instance,true);
 assert.equal(value.subclass.fixed,0);
 near(value.viaConstructor,400*DAY,'new (date.constructor)()');
 assert.equal(value.sameConstructor,true,'date.constructor must be the shifted Date');
 near(value.viaDescriptor,400*DAY,'the Date.now property descriptor');
 near(value.viaDescriptors,400*DAY,'Object.getOwnPropertyDescriptors(Date).now');
 near(value.formatted,400*DAY,'Intl.DateTimeFormat#format() without a date');
 near(value.formattedParts,400*DAY,'Intl.DateTimeFormat#formatToParts() without a date');
 assert.deepEqual(value.formattedFixed,['1970-01-01 00:00:00','1970-01-01 00:00:00']);
 assert.equal(value.formatCached,true,'format stays one bound function per formatter');
});

test('shift-clock supports fractional and backward shifts',()=>{
 const later=probe('45.5','()=>({now:Date.now()-real()})'),earlier=probe('-120','()=>({now:Date.now()-real()})');
 assert.equal(later.status,0,later.stderr);assert.equal(earlier.status,0,earlier.stderr);
 near(later.value.now,45.5*DAY,'+45.5 days');
 near(earlier.value.now,-120*DAY,'-120 days');
});

test('shift-clock leaves the clock and the native Date untouched when unset, empty or zero',()=>{
 for(const days of [undefined,'','0']){
  const {value,stderr,status}=probe(days,`async()=>{
   const vm=(await import(${JSON.stringify(realmHelper)})).default,sandbox={};vm.createContext(sandbox);
   return {now:Date.now()-real(),constructed:new Date().getTime()-real(),native:Function.prototype.toString.call(Date).includes('[native code]')&&Date===Date.prototype.constructor,
    formatted:(${PARSE_UTC})(${UTC_CLOCK}.format())-real(),realm:vm.runInContext('Date.now()',sandbox)-real(),realmUntouched:Object.getOwnPropertyNames(sandbox).length===0&&Object.getOwnPropertySymbols(sandbox).length===0};
  }`);
  assert.equal(status,0,stderr);
  near(value.now,0,`Date.now() with ${JSON.stringify(days)}`);
  near(value.constructed,0,`new Date() with ${JSON.stringify(days)}`);
  near(value.formatted,0,`Intl format with ${JSON.stringify(days)}`);
  assert.equal(value.native,true,`native Date with ${JSON.stringify(days)}`);
  near(value.realm,0,`vm-realm Date.now() with ${JSON.stringify(days)}`);
  assert.equal(value.realmUntouched,true,`vm-realm leaves the sandbox alone with ${JSON.stringify(days)}`);
 }
});

test('shift-clock rejects a malformed shift instead of silently running unshifted',()=>{
 const {status,stderr,stdout}=probe('soon','()=>({ran:true})');
 assert.notEqual(status,0);
 assert.equal(stdout,'');
 assert.match(stderr,/EGC_CLOCK_SHIFT_DAYS must be a number of days, got "soon"/);
});

test('node:test mock timers still pin the clock under the shift and restore the shifted clock',()=>{
 const {value,stderr,status}=probe('400',`async()=>{
  const {mock}=await import('node:test');
  mock.timers.enable({apis:['Date'],now:Date.parse('2026-09-22T12:00:00.000Z')});
  const pinned={now:Date.now(),constructed:new Date().toISOString(),explicit:new Date('2020-01-01T00:00:00.000Z').toISOString()};
  mock.timers.tick(60000);
  const ticked=new Date().toISOString();
  mock.timers.reset();
  return {pinned,ticked,restored:Date.now()-real()};
 }`);
 assert.equal(status,0,stderr);
 assert.deepEqual(value.pinned,{now:Date.parse('2026-09-22T12:00:00.000Z'),constructed:'2026-09-22T12:00:00.000Z',explicit:'2020-01-01T00:00:00.000Z'});
 assert.equal(value.ticked,'2026-09-22T12:01:00.000Z');
 near(value.restored,400*DAY,'Date.now() after mock timers reset');
});

test('loading the preload twice does not apply the shift twice',()=>{
 const env={...process.env,TZ:'UTC',EGC_CLOCK_SHIFT_DAYS:'10'};delete env.NODE_OPTIONS;
 const result=spawnSync(process.execPath,['--import',preload,'--import',preload+'?again','--input-type=module','-e','process.stdout.write(String(Date.now()-(performance.timeOrigin+performance.now())))'],{env,encoding:'utf8',timeout:30000});
 assert.equal(result.status,0,result.stderr);
 near(Number(result.stdout),10*DAY,'double preload');
});

test('vm realms from tests/helpers/vm-realm.mjs inherit the shift; plain node:vm realms do not',()=>{
 const {value,stderr,status}=probe('400',`async()=>{
  const vm=(await import(${JSON.stringify(realmHelper)})).default,native=await import('node:vm'),{mock}=await import('node:test');
  const sample='({now:Date.now(),constructed:new Date().getTime(),called:Date.parse(Date()),formatted:(${PARSE_UTC})(${UTC_CLOCK}.format()),'+
   'fixed:new Date("2026-09-22T12:00:00.000Z").toISOString(),parts:new Date(2026,8,22,12).getTime(),utc:Date.UTC(2026,8,22,12),'+
   'realmDate:new Date() instanceof Date&&Object.getPrototypeOf(new Date())===Date.prototype&&new Date(0).constructor===Date})';
  const measure=result=>({...result,now:result.now-real(),constructed:result.constructed-real(),called:result.called-real(),formatted:result.formatted-real()});
  const sandbox={};const context=vm.createContext(sandbox);
  const created=measure(vm.runInContext(sample,context));
  const again=measure(vm.runInNewContext(sample,context));
  const fresh=measure(vm.runInNewContext(sample,undefined,{filename:'fresh-realm.js',contextName:'fresh realm'}));
  const script=new vm.Script(sample,{filename:'script-realm.js'});
  const scripted=measure(script.runInNewContext({},{contextName:'script realm'}));
  const plain=measure(native.runInNewContext(sample));
  const plainScript=measure(new native.Script(sample).runInNewContext());
  const HostDate=Date,FixedDate=function Date(...args){return new HostDate(...(args.length?args:['2026-09-22T12:00:00.000Z']));};FixedDate.now=()=>HostDate.parse('2026-09-22T12:00:00.000Z');
  const ownClock=vm.runInNewContext('[new Date().toISOString(),Date.now()]',{Date:FixedDate});
  mock.timers.enable({apis:['Date'],now:0});
  const whileMocked=vm.runInNewContext('Date.now()')-real();
  mock.timers.reset();
  return {created,again,fresh,scripted,scriptIsNative:script instanceof native.Script,plain,plainScript,ownClock,whileMocked};
 }`);
 assert.equal(status,0,stderr);
 for(const name of ['created','again','fresh','scripted']){
  const realm=value[name];
  for(const reading of ['now','constructed','called','formatted'])near(realm[reading],400*DAY,`${name} realm ${reading}`);
  assert.equal(realm.fixed,'2026-09-22T12:00:00.000Z');
  assert.equal(realm.parts,Date.UTC(2026,8,22,12));
  assert.equal(realm.utc,Date.UTC(2026,8,22,12));
  assert.equal(realm.realmDate,true,`${name} realm keeps its own Date prototype and instanceof`);
 }
 assert.equal(value.scriptIsNative,true,'vm-realm Script is still a node:vm Script');
 for(const name of ['plain','plainScript'])for(const reading of ['now','constructed','called','formatted'])near(value[name][reading],0,`${name} node:vm realm ${reading} (the blind spot vm-realm.mjs closes)`);
 assert.deepEqual(value.ownClock,['2026-09-22T12:00:00.000Z',Date.UTC(2026,8,22,12)],'a sandbox that brings its own Date keeps it');
 near(value.whileMocked,400*DAY,'a realm created while node:test mocks the host Date');
});
