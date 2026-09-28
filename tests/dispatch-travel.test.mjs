import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { travelEstimator, travelSettings, offlineTravelEstimate, addressZip, normalizeAddress, dispatchTravelRoutes, TRAVEL_ZIP_CENTROIDS } from '../functions/_lib/dispatch-travel.js';
import { dispatchTravelHandlers } from '../functions/api/dispatch-travel.js';
import { dispatchOverview, mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { dispatchHandlers } from '../functions/api/dispatch.js';
import { dispatchOpenings } from '../functions/_lib/dispatch-openings.js';
import { dispatchOpeningsHandlers } from '../functions/api/dispatch-openings.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';

const manager={user:'zacb',displayName:'Owner',role:'owner',businessAccess:true};
const NOW='2026-09-22T12:00:00.000Z',now=new Date(NOW),OFFLINE={EGC_DISPATCH_TRAVEL_ESTIMATES:'offline'};
const FC='100 Oak Street, Fort Collins, CO 80525',LOVELAND='200 Elm Avenue, Loveland, CO 80537',WINDSOR='300 Main St, Windsor, CO 80550',NOWHERE='400 Somewhere Rd, Cheyenne, WY 82001';
const noNetwork=()=>{throw new Error('The offline estimator must never call a provider.');};

function haversineReference(a,b) {
  const toRad=d=>d*Math.PI/180,[lat1,lon1]=TRAVEL_ZIP_CENTROIDS[a],[lat2,lon2]=TRAVEL_ZIP_CENTROIDS[b];
  const h=Math.sin(toRad(lat2-lat1)/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(toRad(lon2-lon1)/2)**2;
  return 2*3958.8*Math.asin(Math.sqrt(h));
}

function fixture() {
  const rows=new Map([
    ['customers/c1',{id:'c1',name:'Fort Collins Customer',phone:'+1 970 555 0100',address:FC,revision:'c1r'}],
    ['customers/c2',{id:'c2',name:'Loveland Customer',phone:'+1 970 555 0111',address:LOVELAND,revision:'c2r'}],
    ['customers/c3',{id:'c3',name:'Faraway Customer',phone:'+1 970 555 0122',address:NOWHERE,revision:'c3r'}],
  ]);
  let revision=0;const commits=[],cacheReads=[],reads=[];
  const clone=value=>structuredClone(value),all=collection=>[...rows.entries()].filter(([key])=>key.startsWith(collection+'/')).map(([,value])=>clone(value));
  const roster=[{id:'zacb',name:'Owner',role:'owner'},{id:'crew1',name:'Crew One',role:'crew'},{id:'crew2',name:'Crew Two',role:'crew'}];
  const store={
    jobs:async()=>all('jobs'),resources:async()=>all('dispatchResources'),customers:async()=>all('customers'),roster:async()=>clone(roster),
    read:async(collection,id)=>{reads.push(collection);return clone(rows.get(`${collection}/${id}`)||null);},
    readMany:async(collection,ids)=>{cacheReads.push([collection,[...ids]]);return ids.map(id=>rows.get(`${collection}/${id}`)).filter(Boolean).map(clone);},
    commit:async writes=>{
      const seen=new Set();commits.push(clone(writes));
      for(const write of writes){const key=`${write.collection}/${write.id}`,old=rows.get(key);assert.ok(!seen.has(key),'No duplicate writes per document');seen.add(key);if(write.revision?old?.revision!==write.revision:Boolean(old))throw Object.assign(new Error('Conflict'),{code:'dispatch_revision_conflict',status:409});}
      for(const write of writes)if(!write.verify)rows.set(`${write.collection}/${write.id}`,{...rows.get(`${write.collection}/${write.id}`),...clone(write.patch),id:write.id,revision:`r${++revision}`});
    },
  };
  const job=(id,changes={})=>{const row={id,type:'job',customerId:'c1',customer:'Customer '+id,address:FC,jobInstructions:'Clean',status:'scheduled',date:'2026-09-23',time:'08:00',endDate:'2026-09-23',endTime:'09:00',assignedCrew:['crew1'],crewLead:null,travelBufferMinutes:20,revision:'rev-'+id,...changes};rows.set('jobs/'+id,row);return row;};
  const create=(changes={},extra={})=>({action:'schedule.create',requestId:randomUUID(),customerId:'c2',kind:'job',changes:{date:'2026-09-23',time:'09:20',endTime:'10:20',assignedCrew:['crew1'],jobInstructions:'Clean garage',...changes},...extra});
  const travel=(env=OFFLINE,extra={})=>travelEstimator({env,store,fetcher:noNetwork,now:()=>now,...extra});
  const mutate=(input,env)=>mutateDispatch(store,manager,input,NOW,env===undefined?{}:{travel:travel(env)});
  return {rows,store,roster,commits,cacheReads,reads,job,create,travel,mutate};
}

test('offline estimate is centroid haversine x1.35 at 35 mph plus 5 minutes, rounded up to 5',()=>{
  const miles=haversineReference('80525','80537')*1.35,expected=Math.ceil((miles/35*60+5)/5)*5;
  const result=offlineTravelEstimate(FC,LOVELAND);
  assert.equal(result.minutes,expected);assert.equal(result.minutes%5,0);assert.equal(result.source,'offline_zip');
  assert.equal(result.minutes,30);assert.deepEqual([result.fromZip,result.toZip],['80525','80537']);
  assert.equal(offlineTravelEstimate('1 A St, Fort Collins, CO 80525','2 B St, Fort Collins, CO 80525').minutes,5);
  assert.ok(offlineTravelEstimate('Estes Park, CO 80517','Greeley, CO 80631').minutes>=100);
  assert.equal(offlineTravelEstimate(FC,NOWHERE),null);assert.equal(offlineTravelEstimate(FC,'123 Synthetic Way, Fort Collins, CO'),null);assert.equal(offlineTravelEstimate(null,FC),null);
});

test('ZIP parsing never mistakes a house number and the table covers every service-area town',()=>{
  assert.equal(addressZip('12345 County Road 5, Wellington, CO'),null);
  assert.equal(addressZip('4100 Main St Fort Collins Colorado 80525-1234, USA'),'80525');
  assert.equal(addressZip('Fort Collins, CO, 80526'),'80526');assert.equal(addressZip('80547'),'80547');assert.equal(addressZip('1 Road, Loveland 80538'),'80538');
  assert.equal(normalizeAddress('100 Oak Street,  Fort Collins, Colorado 80525-0001 USA'),normalizeAddress('100 oak st fort collins co 80525'));
  const towns=new Set(Object.values(TRAVEL_ZIP_CENTROIDS).map(([, ,town])=>town));
  for(const town of ['Fort Collins','Loveland','Windsor','Wellington','Timnath','Severance','LaPorte','Berthoud','Johnstown','Greeley','Longmont','Estes Park','Evans','Eaton'])assert.ok(towns.has(town),town);
  for(const zip of ['80521','80524','80525','80526','80528','80537','80538','80547','80549','80550','80546','80535','80513','80534','80631','80634','80501','80503','80504','80517','80620','80615'])assert.ok(TRAVEL_ZIP_CENTROIDS[zip],zip);
  for(const [zip,[lat,lon]] of Object.entries(TRAVEL_ZIP_CENTROIDS)){assert.match(zip,/^80[56]\d\d$/);assert.ok(lat>39.9&&lat<41&&lon>-105.8&&lon<-104.3,zip);}
});

test('settings default to the historical manual buffer and only accept explicit modes',()=>{
  assert.deepEqual(travelSettings({}),{requestedMode:'off',mode:'off',blockShort:false});
  for(const [value,mode] of [['true','off'],['yes','off'],['on','off'],[' OFFLINE ','offline'],['Off','off']])assert.equal(travelSettings({EGC_DISPATCH_TRAVEL_ESTIMATES:value}).mode,mode,value);
  assert.deepEqual(travelSettings({EGC_DISPATCH_TRAVEL_ESTIMATES:'google'}),{requestedMode:'google',mode:'offline',blockShort:false});
  assert.equal(travelSettings({EGC_DISPATCH_TRAVEL_ESTIMATES:'google',GOOGLE_MAPS_SERVER_API_KEY:'server-key'}).mode,'google');
  assert.equal(travelSettings({EGC_DISPATCH_BLOCK_TRAVEL_SHORT:'true'}).blockShort,true);assert.equal(travelSettings({EGC_DISPATCH_BLOCK_TRAVEL_SHORT:'1'}).blockShort,false);
});

test('off and offline modes never touch the network or cache; same property is zero minutes',async()=>{
  const untouchable={read:()=>{throw new Error('no cache read');},readMany:()=>{throw new Error('no cache read');},commit:()=>{throw new Error('no cache write');}};
  const off=travelEstimator({env:{},store:untouchable,fetcher:noNetwork,now:()=>now});
  assert.equal(off.enabled,false);assert.equal(await off.estimate(FC,LOVELAND),null);assert.equal((await off.prefetch([[FC,LOVELAND]]))(FC,LOVELAND),null);
  const offline=travelEstimator({env:{...OFFLINE,GOOGLE_MAPS_SERVER_API_KEY:'unused-key'},store:untouchable,fetcher:noNetwork,now:()=>now});
  assert.equal((await offline.estimate(FC,LOVELAND)).minutes,30);
  assert.deepEqual(await offline.estimate({address:'100 Oak St Fort Collins CO 80525'},{address:FC}),{minutes:0,source:'same_property'});
  assert.deepEqual(await offline.estimate({address:FC,propertyId:'prop-1'},{address:'Different text, CO 80537',propertyId:'prop-1'}),{minutes:0,source:'same_property'});
  assert.equal(await offline.estimate(FC,NOWHERE),null);assert.equal(await offline.estimate('',FC),null);
  const lookup=await offline.prefetch([[{address:FC},{address:WINDSOR}]]);
  assert.equal(lookup({address:FC},{address:WINDSOR}).source,'offline_zip');assert.equal(lookup({address:WINDSOR},{address:FC}),null,'Unfetched directions stay on the manual buffer.');
});

test('google mode uses the injected fetcher, caches only hashed routes with a TTL and falls back offline',async()=>{
  const f=fixture(),calls=[];let clock=now;
  const fetcher=async(url,init)=>{calls.push({url:new URL(url),init});return new Response(JSON.stringify({status:'OK',rows:[{elements:[{status:'OK',duration:{value:1261},distance:{value:25000}}]}]}),{status:200});};
  const env={EGC_DISPATCH_TRAVEL_ESTIMATES:'google',GOOGLE_MAPS_SERVER_API_KEY:'server-key'};
  const first=travelEstimator({env,store:f.store,fetcher,now:()=>clock});
  assert.deepEqual(await first.estimate(FC,LOVELAND),{minutes:25,source:'google'});
  assert.equal(calls.length,1);assert.equal(calls[0].url.origin+calls[0].url.pathname,'https://maps.googleapis.com/maps/api/distancematrix/json');
  assert.equal(calls[0].url.searchParams.get('origins'),FC);assert.equal(calls[0].url.searchParams.get('destinations'),LOVELAND);assert.equal(calls[0].url.searchParams.get('key'),'server-key');assert.equal(calls[0].url.searchParams.get('mode'),'driving');assert.ok(calls[0].init.signal);
  const id=createHash('sha256').update(`${normalizeAddress(FC)}|${normalizeAddress(LOVELAND)}`).digest('hex'),cached=f.rows.get('dispatchTravelCache/'+id);
  assert.equal(cached.minutes,25);assert.equal(cached.fetchedAt,NOW);assert.ok(cached.expiresAt instanceof Date,'TTL policies need a Firestore timestamp');assert.equal(cached.expiresAt.getTime()-Date.parse(NOW),30*86400000);
  assert.doesNotMatch(JSON.stringify(cached),/Oak|Elm|8052|8053|server-key/);
  assert.deepEqual(await travelEstimator({env,store:f.store,fetcher,now:()=>clock}).estimate(FC,LOVELAND),{minutes:25,source:'google',cached:true});assert.equal(calls.length,1);
  clock=new Date(Date.parse(NOW)+31*86400000);
  await travelEstimator({env,store:f.store,fetcher,now:()=>clock}).estimate(FC,LOVELAND);assert.equal(calls.length,2);assert.equal(f.rows.get('dispatchTravelCache/'+id).fetchedAt,clock.toISOString());
  for(const failing of [async()=>{throw new Error('network');},async()=>new Response('{}',{status:500}),async()=>new Response(JSON.stringify({status:'OK',rows:[{elements:[{status:'ZERO_RESULTS'}]}]}),{status:200}),async()=>new Response(JSON.stringify({status:'REQUEST_DENIED'}),{status:200})]) {
    const estimator=travelEstimator({env,store:null,fetcher:failing,now:()=>now});
    assert.equal((await estimator.estimate(FC,WINDSOR)).source,'offline_zip');assert.equal(await estimator.estimate(FC,NOWHERE),null);
  }
  const broken=travelEstimator({env,store:{readMany:async()=>{throw new Error('cache unavailable');},commit:async()=>{throw new Error('cache unavailable');}},fetcher,now:()=>now});
  assert.equal((await broken.estimate(WINDSOR,FC)).source,'google');
  let limited=0;const limit=travelEstimator({env,store:null,fetcher:async(...args)=>{limited++;return fetcher(...args);},now:()=>now});
  const pairs=Array.from({length:30},(_,index)=>[`${index} First St, Fort Collins, CO 80525`,LOVELAND]),lookup=await limit.prefetch(pairs);
  assert.equal(limited,25);assert.equal(pairs.filter(([from,to])=>lookup(from,to)?.source==='offline_zip').length,5);
});

test('dispatch warns with max(buffer, estimate) and stays non-blocking by default',async()=>{
  const f=fixture();f.job('fc');
  const legacy=await f.mutate(f.create());assert.deepEqual(legacy.warnings.filter(w=>w.code==='travel_buffer_short'),[],'Off keeps the 20-minute buffer satisfied.');
  const g=fixture();g.job('fc');
  const result=await g.mutate(g.create(),OFFLINE),warning=result.warnings.find(w=>w.code==='travel_buffer_short');
  assert.equal(result.job.status,'scheduled');
  assert.deepEqual({gap:warning.gapMinutes,required:warning.requiredMinutes,buffer:warning.bufferMinutes,estimate:warning.estimatedMinutes,source:warning.estimateSource,blocking:warning.blocking},{gap:20,required:30,buffer:20,estimate:30,source:'offline_zip',blocking:undefined});
  assert.match(warning.message,/about 30 minutes of driving/);
  const overview=await dispatchOverview(g.store,manager,{startDate:'2026-09-23',endDate:'2026-09-24'},now,{travel:g.travel()});
  assert.equal(overview.warnings.filter(w=>w.code==='travel_buffer_short'&&w.estimatedMinutes===30).length,2);
  const plain=await dispatchOverview(g.store,manager,{startDate:'2026-09-23',endDate:'2026-09-24'},now);
  assert.deepEqual(plain.warnings.filter(w=>w.code==='travel_buffer_short'),[]);
  const single=await dispatchOverview(g.store,manager,{view:'job',jobId:'fc'},now,{travel:g.travel()});
  assert.equal(single.warnings.find(w=>w.code==='travel_buffer_short').estimatedMinutes,30);
});

test('blockTravelShort blocks only a gap shorter than the estimated drive',async()=>{
  const blocking={...OFFLINE,EGC_DISPATCH_BLOCK_TRAVEL_SHORT:'true'};
  const f=fixture();f.job('fc');
  await assert.rejects(f.mutate(f.create(),blocking),error=>error.code==='dispatch_conflict'&&error.status===409&&error.details.conflicts.some(c=>c.code==='travel_buffer_short'&&c.blocking===true&&c.estimatedMinutes===30));
  assert.equal([...f.rows.keys()].filter(key=>key.startsWith('jobs/visit_')).length,0);
  const buffered=await f.mutate(f.create({time:'09:35',endTime:'10:35',travelBufferMinutes:60}),blocking),warning=buffered.warnings.find(w=>w.code==='travel_buffer_short');
  assert.equal(warning.requiredMinutes,60);assert.equal(warning.estimatedMinutes,30);assert.equal(warning.blocking,undefined);
  const g=fixture();g.job('fc');
  const unknown=await g.mutate(g.create({time:'09:25',endTime:'10:25'},{customerId:'c3'}),blocking);
  assert.deepEqual(unknown.warnings.filter(w=>w.code==='travel_buffer_short'),[],'Unknown ZIP falls back to the satisfied manual buffer.');
  const h=fixture();h.job('fc');
  const same=await h.mutate(h.create({time:'09:05',endTime:'10:05',address:'100 Oak St, Fort Collins, Colorado 80525'},{customerId:'c1'}),blocking);
  assert.deepEqual(same.warnings.filter(w=>w.code==='travel_buffer_short'),[],'A normalized same property needs no drive.');
});

test('estimates widen the neighbor window across midnight without changing the off behavior',async()=>{
  const f=fixture();f.job('late',{date:'2026-09-23',time:'22:00',endDate:'2026-09-23',endTime:'23:50',travelBufferMinutes:0});
  f.job('early',{date:'2026-09-24',time:'00:10',endDate:'2026-09-24',endTime:'02:00',travelBufferMinutes:0,address:LOVELAND});
  const range={startDate:'2026-09-23',endDate:'2026-09-25'};
  assert.deepEqual((await dispatchOverview(f.store,manager,range,now)).warnings.filter(w=>w.code==='travel_buffer_short'),[]);
  const warnings=(await dispatchOverview(f.store,manager,range,now,{travel:f.travel()})).warnings.filter(w=>w.code==='travel_buffer_short');
  assert.deepEqual(warnings.map(w=>[w.jobId,w.gapMinutes,w.requiredMinutes]).sort(),[['early',20,30],['late',20,30]]);
});

test('dispatch HTTP handler reads the travel mode from env and injects the clock',async()=>{
  const f=fixture();f.job('fc');f.job('lv',{time:'09:20',endTime:'10:20',address:LOVELAND,customerId:'c2'});
  const handlers=env=>dispatchHandlers({session:async()=>manager,storage:()=>f.store,now:()=>now,travel:options=>travelEstimator({...options,fetcher:noNetwork})});
  const get=async env=>(await (await handlers(env).get({request:new Request('https://egc.test/api/dispatch?startDate=2026-09-23&endDate=2026-09-24'),env})).json());
  const off=await get({}),on=await get(OFFLINE);
  assert.equal(off.coverage.asOf,NOW);assert.ok(off.warnings.every(w=>w.estimatedMinutes===undefined));
  assert.ok(on.warnings.some(w=>w.code==='travel_buffer_short'&&w.estimateSource==='offline_zip'));
  const body=JSON.stringify(f.create({date:'2026-09-24',time:'09:20',endTime:'10:20'}));
  f.job('fc2',{date:'2026-09-24'});
  const post=await handlers({...OFFLINE,EGC_DISPATCH_BLOCK_TRAVEL_SHORT:'true'}).post({request:new Request('https://egc.test/api/dispatch',{method:'POST',headers:{Origin:'https://egc.test','Content-Type':'application/json'},body}),env:{...OFFLINE,EGC_DISPATCH_BLOCK_TRAVEL_SHORT:'true'}});
  assert.equal(post.status,409);assert.equal((await post.json()).code,'dispatch_conflict');
});

test('openings pad gaps with estimates from an optional zip or address and never shorten buffers',async()=>{
  const f=fixture();f.job('lv',{time:'09:00',endTime:'10:00',address:LOVELAND,travelBufferMinutes:0});
  const query={startDate:'2026-09-23',endDate:'2026-09-24',employeeIds:'crew1',durationMinutes:'60',travelBufferMinutes:'0'};
  const times=result=>result.candidates.map(row=>row.time);
  assert.deepEqual(times(await dispatchOpenings(f.store,manager,query,now)),['08:00','10:00']);
  const padded=await dispatchOpenings(f.store,manager,{...query,zip:'80525'},now,{travel:f.travel()});
  assert.deepEqual(times(padded),['10:30']);assert.ok(padded.warnings.some(w=>w.code==='travel_time_estimated'));assert.equal(padded.constraints.zip,'80525');
  assert.deepEqual(times(await dispatchOpenings(f.store,manager,{...query,address:FC},now,{travel:f.travel()})),['10:30']);
  assert.deepEqual(times(await dispatchOpenings(f.store,manager,{...query,zip:'80537',travelBufferMinutes:'45'},now,{travel:f.travel()})),['10:45'],'A same-ZIP estimate never shortens the larger buffer.');
  const unknown=await dispatchOpenings(f.store,manager,{...query,address:NOWHERE},now,{travel:f.travel()});
  assert.deepEqual(times(unknown),['08:00','10:00']);assert.equal(unknown.warnings.find(w=>w.code==='travel_estimate_unavailable').count,1);
  const disabled=await dispatchOpenings(f.store,manager,{...query,zip:'80525'},now,{travel:f.travel({})});
  assert.deepEqual(times(disabled),['08:00','10:00']);assert.ok(disabled.warnings.some(w=>w.code==='travel_estimates_disabled'));
  for(const bad of [{zip:'8052'},{zip:'80525',address:FC},{address:'   '},{address:'x'.repeat(501)}])await assert.rejects(dispatchOpenings(f.store,manager,{...query,...bad},now,{travel:f.travel()}),e=>e.code==='dispatch_openings_invalid');
  f.store.commit=()=>{throw new Error('Offline openings never write');};
  const handler=dispatchOpeningsHandlers({session:async()=>manager,storage:()=>f.store,now:()=>now,travel:options=>travelEstimator({...options,fetcher:noNetwork})});
  const response=await handler.get({request:new Request('https://egc.test/api/dispatch-openings?'+new URLSearchParams({...query,zip:'80525'})),env:OFFLINE});
  assert.equal(response.status,200);assert.deepEqual(times(await response.json()),['10:30']);
});

test('route legs list each employee day in order with gaps, estimates and review states',async()=>{
  const f=fixture();
  f.job('b',{time:'10:00',endTime:'11:00',address:LOVELAND,customerId:'c2',assignedCrew:['crew1','crew2']});
  f.job('a',{time:'08:00',endTime:'09:45',address:FC,phone:'+1 970 555 0100',email:'private@example.invalid',estimate:{total:900},crewPay:30});
  f.job('c',{time:'11:10',endTime:'12:00',address:'200 Elm Ave, Loveland, Colorado 80537',customerId:'c2'});
  f.job('d',{time:'12:30',endTime:'13:30',address:NOWHERE,customerId:'c3'});
  f.job('e',{time:'13:00',endTime:'14:00',address:WINDSOR});
  f.job('multi',{date:'2026-09-22',time:'16:00',endDate:'2026-09-23',endTime:'07:00',assignedCrew:['crew2'],address:WINDSOR});
  f.job('cancelled',{time:'09:50',endTime:'09:55',status:'cancelled'});
  f.job('other-day',{date:'2026-09-24'});
  f.job('blocked',{type:'blocked',assignedCrew:['crew1']});
  f.rows.set('jobs/_egc_schedule_lock_2026-09-23',{id:'_egc_schedule_lock_2026-09-23',recordType:'schedule_lock',entries:[],revision:'lock'});
  f.store.commit=()=>{throw new Error('Offline routes never write');};
  const result=await dispatchTravelRoutes(f.store,manager,{date:'2026-09-23'},now,{travel:f.travel()});
  assert.equal(result.travel.mode,'offline');assert.equal(result.coverage.complete,true);assert.equal(result.asOf,NOW);
  const one=result.employees.find(row=>row.employeeId==='crew1'),two=result.employees.find(row=>row.employeeId==='crew2');
  assert.deepEqual(one.jobs.map(job=>job.id),['a','b','c','d','e']);assert.deepEqual(two.jobs.map(job=>job.id),['multi','b']);
  assert.deepEqual(one.legs.map(leg=>[leg.fromJobId,leg.toJobId,leg.gapMinutes,leg.estimatedMinutes,leg.requiredMinutes,leg.status]),[
    ['a','b',15,30,30,'short'],['b','c',10,0,20,'same_property'],['c','d',30,null,20,'ok'],['d','e',-30,null,20,'overlap']]);
  assert.equal(one.legs[0].shortByMinutes,15);assert.equal(one.legs[3].shortByMinutes,30);
  assert.deepEqual(one.totals,{stops:5,legs:4,shortLegs:2,estimatedDriveMinutes:30,unestimatedLegs:1});
  assert.equal(two.legs[0].estimateSource,'offline_zip');assert.equal(two.jobs[0].time,'16:00');
  assert.equal(result.warnings.find(w=>w.code==='travel_estimate_unavailable').count,1);
  assert.deepEqual(Object.keys(one.jobs[0]).sort(),['address','customer','date','endAt','endDate','endTime','id','startAt','status','time','title','travelBufferMinutes','type']);
  const filtered=await dispatchTravelRoutes(f.store,manager,{date:'2026-09-23',employeeId:'CREW2'},now,{travel:f.travel()});
  assert.deepEqual(filtered.employees.map(row=>row.employeeId),['crew2']);
  await assert.rejects(dispatchTravelRoutes(f.store,manager,{date:'2026-09-23',employeeId:'nobody'},now,{travel:f.travel()}),e=>e.code==='dispatch_employee_inactive');
  const off=await dispatchTravelRoutes(f.store,manager,{date:'2026-09-23'},now,{travel:f.travel({})});
  assert.equal(off.warnings[0].code,'travel_estimates_disabled');
  assert.deepEqual(off.employees.find(row=>row.employeeId==='crew1').legs.slice(0,2).map(leg=>[leg.estimatedMinutes,leg.requiredMinutes,leg.status]),[[null,20,'short'],[null,20,'short']]);
  const google=await dispatchTravelRoutes(f.store,manager,{},now,{travel:f.travel({EGC_DISPATCH_TRAVEL_ESTIMATES:'google'})});
  assert.equal(google.date,'2026-09-22');assert.equal(google.warnings[0].code,'travel_google_key_missing');assert.equal(google.travel.mode,'offline');
});

test('invalid dated work marks only affected routes incomplete instead of hiding it',async()=>{
  const f=fixture();f.job('good',{assignedCrew:['crew2']});f.job('broken',{time:'bad'});f.job('reversed',{date:'2026-09-25',endDate:'2026-09-20',assignedCrew:['crew2']});f.job('backlog',{date:'',time:'',endDate:'',endTime:''});
  const result=await dispatchTravelRoutes(f.store,manager,{date:'2026-09-23'},now,{travel:f.travel()});
  const one=result.employees.find(row=>row.employeeId==='crew1'),two=result.employees.find(row=>row.employeeId==='crew2');
  assert.equal(one.complete,false);assert.deepEqual(one.jobs,[]);assert.equal(two.complete,false);assert.deepEqual(two.jobs.map(job=>job.id),['good']);
  assert.deepEqual(result.warnings.filter(w=>w.code==='invalid_schedule').map(w=>w.jobId).sort(),['broken','reversed']);
});

test('drive-time HTTP API is manager-only, bounded, no-store and maps storage failures',async()=>{
  const f=fixture();f.job('a');
  const handler=(actor,storage=()=>f.store)=>dispatchTravelHandlers({session:async()=>actor,storage,now:()=>now,travel:options=>travelEstimator({...options,fetcher:noNetwork})});
  const get=(actor,query='date=2026-09-23',storage)=>handler(actor,storage).get({request:new Request('https://egc.test/api/dispatch-travel?'+query),env:OFFLINE});
  assert.equal((await get(null)).status,401);assert.equal((await get({user:'crew1',role:'crew'})).status,403);assert.equal((await get({user:'crew1',role:'manager',businessAccess:false})).status,403);
  const ok=await get(manager);assert.equal(ok.status,200);assert.equal(ok.headers.get('cache-control'),'no-store');assert.equal(ok.headers.get('x-content-type-options'),'nosniff');
  const body=await ok.json();assert.equal(body.travel.mode,'offline');assert.deepEqual(body.employees.map(row=>row.employeeId),['crew1']);
  for(const query of ['date=2026-09-23&date=2026-09-24','date=2026-02-30','date=2026-09-23&unexpected=1','employeeId=']) {
    const response=await get(manager,query);assert.equal(response.status,400,query);assert.equal((await response.json()).code,'dispatch_travel_invalid');
  }
  const failed=await get(manager,'date=2026-09-23',()=>({...f.store,jobs:async()=>{throw new Error('partial scan with private detail');}}));
  assert.equal(failed.status,503);const error=await failed.json();assert.equal(error.code,'dispatch_travel_unavailable');assert.doesNotMatch(error.error,/private detail/);
});

test('google work on a busy day is bounded: one batched cache read, adjacent legs only, and saves never call Google',async()=>{
  const f=fixture(),env={EGC_DISPATCH_TRAVEL_ESTIMATES:'google',GOOGLE_MAPS_SERVER_API_KEY:'synthetic-maps-key'};let google=0;
  const fetcher=async()=>{google++;return new Response(JSON.stringify({status:'OK',rows:[{elements:[{status:'OK',duration:{value:1500}}]}]}),{status:200});};
  for(let index=0;index<60;index++) {
    const start=5*60+index*15,time=minutes=>`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
    f.job(`busy${String(index).padStart(2,'0')}`,{time:time(start),endTime:time(start+10),travelBufferMinutes:0,address:`${index} Synthetic St, ${index%2?'Loveland, CO 80537':'Fort Collins, CO 80525'}`});
  }
  const board=async()=>(await dispatchOverview(f.store,manager,{startDate:'2026-09-23',endDate:'2026-09-24'},now,{travel:travelEstimator({env,store:f.store,fetcher,now:()=>now})})).warnings.filter(w=>w.code==='travel_buffer_short');
  const first=await board();
  assert.equal(f.cacheReads.length,1,'One batched cache read per board load');assert.equal(f.cacheReads[0][1].length,59,'Only the 59 consecutive legs are looked up');
  assert.equal(f.reads.filter(collection=>collection==='dispatchTravelCache').length,0);assert.equal(google,25);
  assert.equal(f.commits.length,1);assert.equal(f.commits[0].length,25);assert.ok(f.commits[0].every(write=>write.collection==='dispatchTravelCache'));
  assert.equal(first.length,118,'Every consecutive leg is checked from both jobs');
  assert.deepEqual([first.filter(w=>w.estimateSource==='google').length,first.filter(w=>w.estimateSource==='offline_zip').length],[50,68],'The spent budget falls back offline without Firestore');
  assert.ok(first.every(w=>Math.abs(Number(w.jobId.slice(4))-Number(w.otherJobId.slice(4)))===1),'Non-adjacent pairs keep the manual buffer');
  const second=await board();
  assert.equal(f.cacheReads.length,2);assert.equal(google,50);assert.equal(second.filter(w=>w.estimateSource==='google').length,100,'Cached legs cost no Google call');
  const handlers=dispatchHandlers({session:async()=>manager,storage:()=>f.store,now:()=>now,travel:options=>travelEstimator({...options,fetcher})});
  const body=JSON.stringify(f.create({time:'21:00',endTime:'22:00'}));
  const commits=f.commits.length,post=await handlers.post({request:new Request('https://egc.test/api/dispatch',{method:'POST',headers:{Origin:'https://egc.test','Content-Type':'application/json'},body}),env});
  const saved=await post.json();
  assert.equal(post.status,200,JSON.stringify(saved));assert.equal(saved.job.status,'scheduled');
  assert.equal(google,50,'A save never calls Google between the day locks and the commit');assert.equal(f.cacheReads.length,3);
  assert.equal(f.commits.length,commits+1);assert.ok(f.commits.at(-1).every(write=>write.collection!=='dispatchTravelCache'),'A save never writes the cache');
  assert.equal(saved.warnings.filter(w=>w.code==='travel_buffer_short').length,0,'The 65-minute gap covers the cached 25-minute drive');
});

test('a denied or failing Google key stops provider calls for the rest of the request',async()=>{
  const env={EGC_DISPATCH_TRAVEL_ESTIMATES:'google',GOOGLE_MAPS_SERVER_API_KEY:'synthetic-maps-key'},pairs=Array.from({length:10},(_,index)=>[`${index} First St, Fort Collins, CO 80525`,LOVELAND]);
  for(const failing of [async()=>new Response(JSON.stringify({status:'REQUEST_DENIED',error_message:'This API is not activated'}),{status:200}),async()=>new Response('{}',{status:429}),async()=>{throw new Error('timeout');}]) {
    let calls=0;const estimator=travelEstimator({env,store:null,fetcher:async(...args)=>{calls++;return failing(...args);},now:()=>now});
    const lookup=await estimator.prefetch(pairs);
    assert.equal(calls,1);assert.ok(pairs.every(([from,to])=>lookup(from,to).source==='offline_zip'));
    await estimator.estimate(WINDSOR,FC);assert.equal(calls,1);
  }
  let calls=0;const partial=travelEstimator({env,store:null,fetcher:async()=>{calls++;return new Response(JSON.stringify({status:'OK',rows:[{elements:[{status:'ZERO_RESULTS'}]}]}),{status:200});},now:()=>now});
  await partial.prefetch(pairs);assert.equal(calls,10,'An unroutable address does not stop the other legs');
  let saves=0;const save=travelEstimator({env,store:null,fetcher:async()=>{saves++;throw new Error('never');},now:()=>now,googleLimit:0});
  assert.equal((await save.estimate(FC,LOVELAND)).source,'offline_zip');assert.equal(saves,0);
});

test('a travel shortfall that already exists blocks only edits that move the stop',async()=>{
  const blocking={...OFFLINE,EGC_DISPATCH_BLOCK_TRAVEL_SHORT:'true'},f=fixture();
  f.job('fc');f.job('lv',{time:'09:20',endTime:'10:20',address:LOVELAND,customerId:'c2'});
  const update=(changes,expectedRevision)=>({action:'schedule.update',requestId:randomUUID(),jobId:'lv',expectedRevision,changes});
  const notes=await f.mutate(update({accessInstructions:'Synthetic gate code'},'rev-lv'),blocking),warning=notes.warnings.find(w=>w.code==='travel_buffer_short');
  assert.equal(notes.job.accessInstructions,'Synthetic gate code');assert.equal(warning.estimatedMinutes,30);assert.equal(warning.blocking,undefined);
  const revision=f.rows.get('jobs/lv').revision;
  for(const changes of [{time:'09:25',endTime:'10:25'},{address:'250 Elm Avenue, Loveland, CO 80537'},{assignedCrew:['crew1','crew2'],crewLead:'crew1'}]) {
    await assert.rejects(f.mutate(update(changes,revision),blocking),error=>error.code==='dispatch_conflict'&&error.details.conflicts.some(c=>c.code==='travel_buffer_short'&&c.blocking===true),JSON.stringify(changes));
  }
  const moved=await f.mutate(update({time:'09:30',endTime:'10:30'},revision),blocking);
  assert.equal(moved.warnings.filter(w=>w.code==='travel_buffer_short').length,0,'A fix that makes room is saved.');
});

test('off-mode routes agree with the board on same-address stops and nested overlaps report the true overlap',async()=>{
  const f=fixture();
  f.job('first',{time:'08:00',endTime:'09:00'});f.job('second',{time:'09:05',endTime:'10:00'});
  const off=await dispatchTravelRoutes(f.store,manager,{date:'2026-09-23'},now,{travel:f.travel({})});
  assert.deepEqual(off.employees[0].legs.map(leg=>[leg.gapMinutes,leg.status,leg.shortByMinutes]),[[5,'same_property',0]]);
  assert.equal(off.employees[0].totals.shortLegs,0);
  const board=await dispatchOverview(f.store,manager,{startDate:'2026-09-23',endDate:'2026-09-24'},now);
  assert.deepEqual(board.warnings.filter(w=>w.code==='travel_buffer_short'),[]);
  const g=fixture();g.job('outer',{time:'08:00',endTime:'12:00'});g.job('inner',{time:'09:00',endTime:'10:00',address:LOVELAND});
  const nested=await dispatchTravelRoutes(g.store,manager,{date:'2026-09-23'},now,{travel:g.travel()});
  assert.deepEqual(nested.employees[0].legs.map(leg=>[leg.fromJobId,leg.toJobId,leg.status,leg.shortByMinutes]),[['outer','inner','overlap',60]]);
});

test('the ZIP table covers neighboring towns and never reads a PO box number as a ZIP',()=>{
  assert.equal(TRAVEL_ZIP_CENTROIDS[80645][2],'La Salle');assert.equal(TRAVEL_ZIP_CENTROIDS[80516][2],'Erie');
  assert.ok(offlineTravelEstimate('1 Main St, La Salle, CO 80645','2 Main St, Evans, CO 80620').minutes<=15);
  for(const value of ['PO Box 80525','P.O. Box 80525 USA','Fort Collins, CO PO Box 80525'])assert.equal(addressZip(value),null,value);
  assert.equal(addressZip('PO Box 80525, Fort Collins, CO 80526'),'80526');
});

test('cache rows use one Firestore batchGet and an expiresAt timestamp value',async()=>{
  const calls=[];
  const found=id=>({found:{name:`projects/egcw-1ec83/databases/(default)/documents/dispatchTravelCache/${id}`,updateTime:'2026-09-22T12:00:00.000001Z',fields:{minutes:{integerValue:'25'},expiresAt:{timestampValue:'2026-10-22T12:00:00.000001Z'}}}});
  const store=dispatchStorage({},async(_env,url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body)});return String(url).endsWith(':batchGet')?Response.json([found('aa'),{missing:'projects/egcw-1ec83/databases/(default)/documents/dispatchTravelCache/bb'}]):Response.json({writeResults:[]});});
  assert.deepEqual(await store.readMany('dispatchTravelCache',[]),[]);assert.equal(calls.length,0);
  const rows=await store.readMany('dispatchTravelCache',['aa','bb']);
  assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith(':batchGet'));assert.deepEqual(calls[0].body.documents,['projects/egcw-1ec83/databases/(default)/documents/dispatchTravelCache/aa','projects/egcw-1ec83/databases/(default)/documents/dispatchTravelCache/bb']);
  assert.deepEqual(rows,[{minutes:25,expiresAt:'2026-10-22T12:00:00.000001Z',id:'aa',revision:'2026-09-22T12:00:00.000001Z'}]);
  await store.commit([{collection:'dispatchTravelCache',id:'bb',patch:{minutes:10,expiresAt:new Date(Date.parse(NOW)+30*86400000)}}]);
  assert.deepEqual(calls[1].body.writes[0].update.fields.expiresAt,{timestampValue:'2026-10-22T12:00:00.000Z'});
  await assert.rejects(dispatchStorage({},async()=>Response.json({},{status:503})).readMany('dispatchTravelCache',['aa']),error=>error.code==='dispatch_storage_unavailable');
  await assert.rejects(dispatchStorage({},async()=>Response.json({})).readMany('dispatchTravelCache',['aa']),error=>error.code==='dispatch_storage_incomplete');
});
