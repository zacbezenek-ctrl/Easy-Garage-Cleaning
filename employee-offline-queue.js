/* Employee Hub offline queue (HUB_OFFLINE_ENABLED, switched on by employee-hub-screens.js). The viewer's own time-clock
   actions (clock in, clock out, break start/end) and crew chat or job-room messages that the Hub saves through
   peopleSet are written to this device's IndexedDB before they are sent, then replayed one at a time, in order, with
   the same request ID and body when the connection returns ('online', the page becoming visible, Sync now, or a 30 s
   check). A 2xx with ok:true confirms and removes an action. Any other 4xx is the server's answer, so the action is
   dropped and shown as not saved. No reply, a timeout, 401, 408, 429, a write conflict, a 5xx, an unreadable 2xx or a
   different signed-in account keeps it for the next replay. A clock action older than 12 hours, or a message older than
   a day, is never sent and is shown as not saved. With the switch off, for every other request, or on a device that
   cannot store the action, the request goes to the network exactly as before. Queued actions stay per account: only
   the signed-in viewer's are shown, and only for that same signed-in account are they sent (a save kept because another
   account is signed in says so). Until an action is sent, refused, expired or discarded, the Hub shows it over the
   server's copy of its record (records(), also before the switch has answered), a Hub load that overlapped a change to
   the queue reads again (revision()), and settled() tells the Hub what became of an action this page saw leave the queue
   so it can correct what it shows, and where shift location goes, without waiting for a reload. Switched off after it
   was on, what a device still has queued is held there, never sent while it is off (hold()), and settled() lists it as
   held so the Hub can pause shift location for a held clock-out and tell the crew member; once the Hub has told them
   (supersede()) it is never sent, and what they do instead (resume location, clock out or in again) removes it
   (release()). A queued clock-in discarded, or refused or expired before any attempt reached the server, takes the
   clock actions queued after it for the same shift with it, unsent. Every clock-out queued here is also remembered on
   the device for 12 hours after it leaves the queue (clockOut()), so a Hub tab that never saw it queued still sends no
   position fix for that shift. */
(function(root){
'use strict';
const DB='egc-hub-offline',STORE='requests',MARKS='clockOuts',VERSION=2,LOCK='egc-hub-offline',PATH='/api/employee-hub',AUTH='/api/hub-auth',TIMEOUT=30000,CHECK_MS=30000,CONFIRM_MS=5000,TZ='America/Denver';
const ACCOUNT='EMPLOYEE_HUB_ACCOUNT_CHANGED',EXPIRED='HUB_OFFLINE_EXPIRED',SUPERSEDED='HUB_OFFLINE_SUPERSEDED';
// How long an action may wait on the device: a clock action as long as the server accepts a device time (12 hours), a
// message a day. Older ones are removed unsent, so a queue left behind never replays stale shifts or old chat.
const MAX_AGE={clock:12*3600000,message:24*3600000},LIVE_MS=2*60000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,INSTANT=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const CLOCK_OUT_KEYS=['clockOutAt','status','approvalStatus','hours','grossEstimate','locationTracking','locationStatus','updatedAt'];
const same=(left,right)=>String(left||'').trim().toLowerCase()===String(right||'').trim().toLowerCase();
const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const failure=(message,code)=>Object.assign(new Error(message),{code});
const unavailable=()=>failure('This device could not keep the action.','HUB_OFFLINE_UNAVAILABLE');
const copy=value=>JSON.parse(JSON.stringify(value));
const parseBody=item=>{try{return JSON.parse(item?.body);}catch{return null;}};
// A clock-in as the Hub saves it (opsClockIn): an active shift with its start time and no clock-out.
const clockInData=data=>isRecord(data)&&data.status==='active'&&!data.clockOutAt&&typeof data.clockInAt==='string';
const clockOutData=data=>isRecord(data)&&data.status==='submitted'&&Boolean(data.clockOutAt);

// A clock-out record (MARKS) counts from when its clock-out left the queue (left), or, until then, from when it was
// queued (at).
const markTime=row=>Math.max(Date.parse(row?.at)||-Infinity,Date.parse(row?.left)||-Infinity);

// Two stores: the queued requests, and the clock-outs queued on this device (kept 12 hours, clockOut()). Version 2 adds
// the second to a device that has only the first.
function idbStore(factory=root.indexedDB){
  function open(){
    return new Promise((resolve,reject)=>{
      if(!factory)return reject(unavailable());
      let request,settled=false;
      try{request=factory.open(DB,VERSION);}catch{return reject(unavailable());}
      request.onupgradeneeded=()=>{for(const name of [STORE,MARKS])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:'requestId'});};
      // Each connection lets go as soon as another page asks for a newer version, so it never holds that upgrade up.
      request.onsuccess=()=>{const db=request.result;if(settled){db.close();return;}settled=true;db.onversionchange=()=>db.close();resolve(db);};
      request.onerror=()=>{settled=true;reject(unavailable());};
      // Another tab still holds the database open at the older version: the action goes to the network instead. The open
      // itself goes on and upgrades the database once that tab lets go; its connection is then closed at once (above).
      request.onblocked=()=>{settled=true;reject(unavailable());};
    });
  }
  async function run(mode,action,name=STORE){
    const db=await open();
    try{
      return await new Promise((resolve,reject)=>{
        let result;
        const tx=db.transaction(name,mode),request=action(tx.objectStore(name));
        request.onsuccess=()=>{result=request.result;};
        tx.oncomplete=()=>resolve(result);
        tx.onerror=()=>reject(unavailable());
        tx.onabort=()=>reject(unavailable());
      });
    }finally{db.close();}
  }
  // put(item, mark, cutoff): a queued clock-out and its record (MARKS) are written in one transaction, which also drops
  // records older than cutoff.
  async function keep(item,mark,cutoff){
    const db=await open();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction([STORE,MARKS],'readwrite'),marks=tx.objectStore(MARKS),all=marks.getAll();
        tx.objectStore(STORE).put(item);
        all.onsuccess=()=>{for(const row of all.result||[])if(!(markTime(row)>cutoff))marks.delete(row.requestId);marks.put(mark);};
        tx.oncomplete=()=>resolve();
        tx.onerror=()=>reject(unavailable());
        tx.onabort=()=>reject(unavailable());
      });
    }finally{db.close();}
  }
  // remove(id, at): the action leaves the queue, and its clock-out record, if it still has one, notes when (left), in the
  // same write. A record already forgotten (forget()) stays forgotten.
  async function take(id,at){
    const db=await open();
    try{
      await new Promise((resolve,reject)=>{
        const tx=db.transaction([STORE,MARKS],'readwrite'),marks=tx.objectStore(MARKS),mark=marks.get(id);
        tx.objectStore(STORE).delete(id);
        mark.onsuccess=()=>{if(isRecord(mark.result))marks.put({...mark.result,left:at});};
        tx.oncomplete=()=>resolve();
        tx.onerror=()=>reject(unavailable());
        tx.onabort=()=>reject(unavailable());
      });
    }finally{db.close();}
  }
  // Whether this device has a queue at all, asked without creating one: from databases() where the browser lists them,
  // otherwise (Firefox before 126) by opening the database at whatever version it has, with the upgrade that would
  // create a new one aborted.
  async function exists(){
    if(typeof factory?.databases==='function'){try{return (await factory.databases()).some(db=>db?.name===DB);}catch{return false;}}
    return new Promise(resolve=>{
      let request;
      try{request=factory.open(DB);}catch{return resolve(false);}
      request.onupgradeneeded=()=>{try{request.transaction.abort();}catch{/* The open then fails below. */}};
      request.onsuccess=()=>{try{request.result.close();}catch{/* Closed already. */}resolve(true);};
      request.onerror=()=>resolve(false);
      request.onblocked=()=>resolve(false);
    });
  }
  return {all:async()=>(await run('readonly',store=>store.getAll()))||[],put:(item,mark,cutoff)=>mark?keep(item,mark,cutoff):run('readwrite',store=>store.put(item)),remove:(id,at)=>at?take(id,at):run('readwrite',store=>store.delete(id)),exists,
    marks:async()=>(await run('readonly',store=>store.getAll(),MARKS))||[],unmark:id=>run('readwrite',store=>store.delete(id),MARKS)};
}

function memoryStore(){
  const rows=new Map(),marks=new Map();
  return {all:async()=>[...rows.values()].map(copy),remove:async(id,at)=>{rows.delete(id);if(at&&marks.has(id))marks.set(id,{...marks.get(id),left:at});},exists:async()=>true,
    put:async(item,mark,cutoff)=>{rows.set(item.requestId,copy(item));if(!mark)return;for(const row of marks.values())if(!(markTime(row)>cutoff))marks.delete(row.requestId);marks.set(mark.requestId,copy(mark));},
    marks:async()=>[...marks.values()].map(copy),unmark:async id=>{marks.delete(id);}};
}

// The posts this queue may hold: the viewer's own clock in/out and break changes, and crew chat or job-room messages.
// Location updates, approvals, profile saves and every other Hub request go straight to the network as before.
function describe(path,body,user){
  if(path!==PATH||!isRecord(body)||typeof body.id!=='string'||!body.id||!isRecord(body.data))return null;
  const data=body.data,keys=Object.keys(data);
  if(body.collection==='teamMessages'||body.collection==='jobMessages')return typeof data.body==='string'&&data.body.trim()?{kind:'message',op:'message',label:body.collection==='jobMessages'?'Job room message':'Crew chat message'}:null;
  if(body.collection!=='timeEntries')return null;
  if(data.status==='active'&&!data.clockOutAt&&data.locationTracking===true&&typeof data.clockInAt==='string'&&isRecord(data.lastLocation)&&user&&same(data.employee,user))return {kind:'clock',op:'clock_in',label:'Clock in'};
  if(data.status==='submitted'&&typeof data.clockOutAt==='string'&&data.clockOutAt&&keys.every(key=>CLOCK_OUT_KEYS.includes(key)))return {kind:'clock',op:'clock_out',label:'Clock out'};
  const last=Array.isArray(data.breaks)?data.breaks.at(-1):null;
  if(isRecord(last)&&keys.every(key=>key==='breaks'||key==='updatedAt'))return last.endAt?{kind:'clock',op:'break_end',label:'End break'}:{kind:'clock',op:'break_start',label:'Start break'};
  return null;
}

// The request ID travels in the body, so every replay is the same request, and so does the account that saved it
// (expectedUser): the server refuses it for any other signed-in account. A queued break (a manager's too) carries the
// request ID the server keeps on it. A crew clock action kept on the device also carries the time the Hub showed for it
// (deviceCapturedAt), as the crew app's queued actions do: the server then refuses a stale time (or, with
// EGC_OFFLINE_CLOCK_ENABLED, keeps it for review) instead of silently recording the moment the phone reconnected. A
// manager's clock times are already in the body, as the server keeps them. An action saved online with nothing queued
// ahead of it also keeps a live body without the device time (captured:false): its first attempt, if made within two
// minutes of the save, is recorded at the server's time as before, so a phone whose clock is a few minutes off is never
// refused for an action it sends live. Every later attempt sends the body with the device time. The server keeps no
// body fingerprint for these records, and a clock-in, clock-out or break replay is a no-op by record or request ID, for
// a manager's own shift as for a crew member's.
function prepare(body,kind,{requestId,user='',crew,captured=true,now=()=>new Date()}){
  const next={...body,requestId,...(user?{expectedUser:user}:{})};
  if(kind.kind!=='clock')return next;
  const data={...body.data},last=Array.isArray(data.breaks)?data.breaks.at(-1):null;
  const shown={clock_in:data.clockInAt,clock_out:data.clockOutAt,break_start:last?.startAt,break_end:last?.endAt}[kind.op];
  if(crew&&captured)data.deviceCapturedAt=typeof shown==='string'&&INSTANT.test(shown)&&Number.isFinite(Date.parse(shown))?shown:now().toISOString();
  if(kind.op==='break_start'||kind.op==='break_end')data.breaks=[...data.breaks.slice(0,-1),{...last,requestId}];
  return {...next,data};
}

// applied: confirmed. refused: the server's definite answer (a 4xx other than 401/408/429, a write conflict or a
// changed account), so the action is dropped. Everything else (no reply, auth, another signed-in account, a busy or
// failing server, a lost write race, an unreadable success) keeps the action queued.
function classify({status=0,data=null}={}){
  if(status>=200&&status<300)return data?.ok===true?'applied':'unknown';
  if(!status)return 'network';
  if(status===401)return 'auth';
  if(data?.code===ACCOUNT)return 'account';
  if(status===408||status===429||status>=500||data?.code==='EMPLOYEE_HUB_WRITE_CONFLICT')return 'server';
  return status>=400?'refused':'unknown';
}

const expiredText=item=>item.lost?LOST_EXPIRED:item.kind==='message'?'It waited on this device for more than a day, so it was not sent. Send it again if it is still needed.':'It waited on this device for more than 12 hours, so it was not sent. Ask a manager for a time correction.';
// The clock actions queued after a clock-in for the same shift were built on it. When the clock-in is discarded, or is
// refused or expires before any attempt of it reached the server (tried), the server never has that timecard, so they go
// with it instead of being sent (and refused as a timecard the server does not have). A clock-in that was sent before may
// have been saved with its reply lost, so its refused or expired retry leaves them queued, and they are sent as before.
const LOST='HUB_OFFLINE_CLOCK_IN_NOT_SAVED',LOST_TEXT='The clock-in for this shift was not saved, so this was not sent.',LOST_EXPIRED='The clock-in for this shift waited on this device for more than 12 hours and was not sent, so this was not sent either.';
const SUPERSEDED_TEXT='It was not sent because offline saving was off, and the Hub asked you to do it again.';

// Before a replay sends anything it confirms who is signed in now: a tab can still show an account that another tab
// has since replaced. Only the account that saved the actions sends them, and a failed check never drops one.
async function signedIn(session,user){
  let reply;
  try{reply=await session();}catch(error){reply={status:Number(error?.status)||0,data:null,error};}
  const status=Number(reply?.status)||0,data=reply?.data,outcome=classify({status,data});
  if(outcome==='applied'&&typeof data.user==='string')return same(data.user,user)?null:{status:409,data:{ok:false,code:ACCOUNT,error:`Signed in as ${data.user}.`},outcome:'account'};
  return {status,data:null,error:reply?.error||null,outcome:['network','auth','server'].includes(outcome)?outcome:'unknown'};
}

function valid(item){
  return isRecord(item)&&UUID.test(String(item.requestId||''))&&typeof item.user==='string'&&Boolean(item.user.trim())&&item.path===PATH&&typeof item.body==='string'&&Number.isFinite(item.seq);
}

function normalize(input,now){
  const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
  const own=body=>isRecord(body)&&body.requestId===input.requestId&&same(body.expectedUser,input.user);
  const body=parse(input?.body),live=input?.live?parse(input.live):null;
  if(!isRecord(input)||!UUID.test(String(input.requestId||''))||typeof input.user!=='string'||!input.user.trim()||input.path!==PATH||!own(body)||(input.live&&!own(live)))throw failure('This action could not be kept on the device.','HUB_OFFLINE_INVALID');
  return {requestId:input.requestId,user:input.user.trim(),path:PATH,body:input.body,live:input.live&&input.live!==input.body?input.live:'',kind:input.kind==='message'?'message':'clock',label:String(input.label||'Hub action').slice(0,80),queuedAt:input.queuedAt||now().toISOString(),seq:0,attempts:0,lastStatus:0,waiting:''};
}

function create({store=idbStore(),now=()=>new Date(),locks=root.navigator?.locks}={}){
  let writes=Promise.resolve(),running=Promise.resolve(),revision=0;
  const recent=new Map();
  const serial=task=>{const next=writes.then(task,task);writes=next.catch(()=>{});return next;};
  // Counts this page's changes to the queue (an action kept, sent, dropped, retried or discarded), so the Hub can tell
  // that a load of its records overlapped one.
  const changed=()=>{revision++;};
  const sorted=rows=>rows.filter(valid).sort((a,b)=>a.seq-b.seq||a.requestId.localeCompare(b.requestId));
  const items=async user=>sorted(await store.all()).filter(item=>same(item.user,user));
  // A queued clock-in's shift, and the same account's actions queued after it for that shift (rows: sorted).
  const shiftOf=item=>{const body=parseBody(item);return body?.collection==='timeEntries'&&typeof body.id==='string'?body:null;};
  const followers=(rows,item)=>{const body=shiftOf(item);if(!body||!clockInData(body.data))return [];return rows.filter(row=>row.seq>item.seq&&row.requestId!==item.requestId&&same(row.user,item.user)&&shiftOf(row)?.id===body.id);};
  const expired=item=>{const at=Date.parse(item.queuedAt);return !Number.isFinite(at)||now().getTime()-at>(MAX_AGE[item.kind]||MAX_AGE.clock);};
  const clockIn=item=>{const body=shiftOf(item);return Boolean(body&&clockInData(body.data));};
  // The clock-outs queued on this device (MARKS): {requestId, user, id, at (queued), left (when it left the queue)}, each
  // kept 12 hours after it left the queue.
  const fresh=row=>isRecord(row)&&markTime(row)>now().getTime()-MAX_AGE.clock;
  // Every action that leaves the queue (sent, refused, expired, discarded or dropped) goes through here, so a clock-out's
  // record notes when.
  const drop=requestId=>store.remove(requestId,now().toISOString());
  // A clock-out is written with its record, in one write.
  function put(item){
    const body=shiftOf(item),at=now();
    if(!body||!clockOutData(body.data))return store.put(item);
    return store.put(item,{requestId:item.requestId,user:item.user,id:body.id,at:at.toISOString()},at.getTime()-MAX_AGE.clock);
  }
  // The latest clock-out this account queued on this device for that shift that is still waiting or left the queue (sent,
  // refused, expired or discarded) in the last 12 hours, or null.
  async function clockedOut(user,id){
    if(typeof store.marks!=='function')return null;
    const rows=(await store.marks()).filter(row=>fresh(row)&&same(row.user,user)&&row.id===id);
    return rows.sort((a,b)=>String(b.at).localeCompare(String(a.at)))[0]||null;
  }
  // Forgets them (the crew member resumed shift location for that shift).
  const forget=(user,id)=>serial(async()=>{
    if(typeof store.marks!=='function')return;
    for(const row of await store.marks())if(same(row?.user,user)&&row?.id===id)await store.unmark(row.requestId);
  });
  // What the last passes did with each action, so a save whose action another pass sent reports that pass's answer.
  const settle=(item,reply,outcome)=>{recent.set(item.requestId,{outcome,status:reply.status,data:reply.data});if(recent.size>20)recent.delete(recent.keys().next().value);};
  const outcome=requestId=>recent.get(requestId)||null;

  function enqueue(input){
    return serial(async()=>{
      const item=normalize(input,now),rows=sorted(await store.all()),existing=rows.find(row=>row.requestId===item.requestId);
      if(existing)return existing;
      // Only an action with nothing of its account's queued ahead of it can go out live.
      if(rows.some(row=>same(row.user,item.user)))item.live='';
      item.seq=rows.reduce((max,row)=>Math.max(max,row.seq),0)+1;
      await put(item);
      changed();
      return item;
    });
  }
  const remove=requestId=>serial(async()=>{await drop(requestId);changed();});
  // Discard: removes the action and, for a clock-in, the clock actions queued after it for that shift; returns them.
  const discard=requestId=>serial(async()=>{
    const rows=sorted(await store.all()),item=rows.find(row=>row.requestId===requestId),gone=item?[item,...followers(rows,item)]:[];
    await drop(requestId);
    for(const row of gone.slice(1))await drop(row.requestId);
    changed();
    return gone;
  });
  // A refused clock-in's followers, removed unsent.
  const dropFollowers=item=>serial(async()=>{
    const gone=followers(sorted(await store.all()),item);
    for(const row of gone){await drop(row.requestId);changed();}
    return gone;
  });
  // Removes every account's actions that waited too long (with the clock actions queued after an expired clock-in that
  // was never sent, marked lost) and returns them; the Hub lists the viewer's as not saved.
  const expire=()=>serial(async()=>{
    const rows=sorted(await store.all()),old=rows.filter(expired),lost=[];
    for(const item of old)if(!item.tried)for(const row of followers(rows,item))if(!old.includes(row)&&!lost.includes(row))lost.push(row);
    for(const item of [...old,...lost]){await drop(item.requestId);changed();}
    return [...old,...lost.map(item=>({...item,lost:true}))];
  });
  // Offline saving is off and the Hub told the crew member this action was not sent and to do it again: it is never sent
  // (a later replay removes it unsent), and a clock-in takes the clock actions queued after it for that shift with it.
  const supersede=requestId=>serial(async()=>{
    const rows=sorted(await store.all()),item=rows.find(row=>row.requestId===requestId);
    const marked=item?[item,...followers(rows,item)].filter(row=>!row.superseded):[];
    for(const row of marked)await store.put({...row,superseded:true});
    if(marked.length)changed();
    return marked;
  });
  // A clock-in is marked before its first send, so a later refusal or expiry can tell whether the server may have it.
  const tried=item=>serial(async()=>{
    if(!(await store.all()).some(row=>row.requestId===item.requestId))return null;
    const next={...item,tried:true};
    await store.put(next);
    return next;
  });
  const mine=(rows,user)=>rows.filter(item=>same(item.user,user));

  // An action's first attempt within two minutes of its save sends the live body; any other attempt sends the kept one.
  const payload=item=>!item.attempts&&item.live&&Math.abs(now().getTime()-Date.parse(item.queuedAt))<=LIVE_MS?item.live:item.body;

  // One pass, oldest first. A kept action stops the pass so later actions never overtake it; a dropped one does not.
  // session (a background pass) confirms the signed-in account before the first send.
  async function replay({user,transport,session}){
    const result={applied:[],dropped:[],stopped:null,remaining:0},seen=new Set();
    for(const item of mine(await expire(),user)){
      const reply={status:0,data:{ok:false,code:EXPIRED,error:expiredText(item)}};
      settle(item,reply,'expired');
      result.dropped.push({item,...reply,expired:true});
    }
    let checked=typeof session!=='function';
    for(let guard=0;guard<1000;guard++){
      let item=(await items(user)).find(row=>!seen.has(row.requestId));
      if(!item)break;
      seen.add(item.requestId);
      if(item.superseded){
        await remove(item.requestId);
        const reply={status:0,data:{ok:false,code:SUPERSEDED,error:SUPERSEDED_TEXT}};
        settle(item,reply,'superseded');
        result.dropped.push({item,...reply,superseded:true});
        // A superseded clock-in's shift never reaches the server, so what was queued after it for that shift goes too.
        for(const row of await dropFollowers(item)){
          const quiet=Boolean(row.superseded),dropped=quiet?reply:{status:0,data:{ok:false,code:LOST,error:LOST_TEXT}};
          seen.add(row.requestId);settle(row,dropped,quiet?'superseded':'lost');
          result.dropped.push({item:row,...dropped,...(quiet?{superseded:true}:{lost:true})});
        }
        continue;
      }
      let reply=null;
      if(!checked){checked=true;reply=await signedIn(session,user);}
      // first: no earlier attempt of this clock-in reached the server, so its refusal proves the server has no timecard.
      const first=!reply&&clockIn(item)&&!item.tried;
      if(first&&!(item=await tried(item)))continue;
      if(!reply){
        try{reply=await transport(item.path,payload(item));}
        catch(error){reply={status:Number(error?.status)||0,data:null,error};}
      }
      const outcome=reply.outcome||classify(reply);
      if(outcome==='applied'||outcome==='refused'){
        await remove(item.requestId);
        settle(item,reply,outcome);
        (outcome==='applied'?result.applied:result.dropped).push({item,status:reply.status,data:reply.data});
        if(outcome==='refused'&&first)for(const row of await dropFollowers(item)){
          const lost={status:0,data:{ok:false,code:LOST,error:LOST_TEXT}};
          seen.add(row.requestId);settle(row,lost,'lost');
          result.dropped.push({item:row,...lost,lost:true});
        }
        continue;
      }
      // A Discard while the request was out must not bring the action back.
      await serial(async()=>{if((await store.all()).some(row=>row.requestId===item.requestId)){await store.put({...item,live:'',attempts:item.attempts+1,lastStatus:Number(reply.status)||0,waiting:outcome});changed();}});
      result.stopped={item,status:Number(reply.status)||0,reason:outcome,error:reply.error||null};
      break;
    }
    result.remaining=(await items(user)).length;
    return result;
  }

  // Passes are serialized on this page and, through Web Locks, with other Hub tabs, so two replays never overlap.
  function flush(options={}){
    if(!options.user||typeof options.transport!=='function')return Promise.resolve({applied:[],dropped:[],stopped:null,remaining:0});
    const next=running.then(()=>locks?.request?locks.request(LOCK,()=>replay(options)):replay(options));
    running=next.catch(()=>{});
    return next;
  }

  const exists=()=>typeof store.exists==='function'?store.exists():Promise.resolve(true);
  return {enqueue,items,flush,remove,discard,expire,supersede,mine,outcome,exists,clockedOut,forget,revision:()=>revision};
}

// A queued action as the Hub saved it (without the device time and break request ID the queue adds), or null.
const plainBreak=row=>{if(!isRecord(row))return row;const {requestId,...rest}=row;return rest;};
function view(item){
  const body=parseBody(item);
  if(!isRecord(body)||typeof body.collection!=='string'||typeof body.id!=='string'||!isRecord(body.data))return null;
  const {deviceCapturedAt,...data}=body.data;
  if(Array.isArray(data.breaks))data.breaks=data.breaks.map(plainBreak);
  return {requestId:item.requestId,collection:body.collection,id:body.id,data};
}

function h(doc,tag,props,...children){
  const node=doc.createElement(tag);
  for(const[key,value]of Object.entries(props||{})){
    if(value==null||value===false)continue;
    if(key==='class')node.className=value;
    else if(key==='text')node.textContent=value;
    else if(key.startsWith('on')&&typeof value==='function')node.addEventListener(key.slice(2),value);
    else node.setAttribute(key,value===true?'':String(value));
  }
  for(const child of children.flat())if(child!=null&&child!==false)node.append(typeof child==='string'?doc.createTextNode(child):child);
  return node;
}

function stamp(value){
  const at=Date.parse(value||'');
  return Number.isFinite(at)?new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(at)):'earlier';
}

function waitingText(item,online){
  if(item.waiting==='account')return `Sign in as ${item.user} to send it`;
  if(item.lastStatus===401||item.waiting==='auth')return 'Sign in again to send it';
  if(item.waiting==='server')return 'The Hub did not confirm it yet; it will retry';
  if(item.waiting==='unknown')return 'The reply was cut off; it will be checked again';
  return online?'Waiting to send':'Waiting for a connection';
}

// The page side: the switch, the send() hook peopleSet uses, replay triggers and the Pending sync chip.
function controller(deps={}){
  const doc=deps.document||root.document,now=deps.now||(()=>new Date()),uuid=deps.uuid||(()=>root.crypto.randomUUID());
  const online=deps.online||(()=>root.navigator?.onLine!==false),timeout=deps.timeout||TIMEOUT,timers=deps.timers||root;
  const fetcher=deps.fetch||((url,init)=>typeof root.hubFetch==='function'?root.hubFetch(url,init):root.fetch(url,{...init,credentials:'same-origin'}));
  const toast=deps.toast||(message=>{if(typeof root.showToast==='function')root.showToast(message);});
  const viewer=deps.viewer||(()=>{try{return {user:String(root.sessionStorage.getItem('egc_u')||'').trim(),crew:root.sessionStorage.getItem('egc_business_access')!=='true'};}catch{return {user:'',crew:true};}});
  // known: whether /api/hub-offline has given a definite answer (configure). Until then the queue holds nothing new and
  // removes nothing, but the Hub still shows what an earlier page left queued on this device (showing(), records()).
  const state={enabled:false,known:false,pending:[],refused:[],syncing:false,listening:false,forgetting:false,swept:null,held:null,timer:0,ui:null,confirm:'',synced:''};
  // The Hub's own saves still waiting on their first answer: that answer goes back to peopleSet, not to a toast.
  const directs=new Set();
  // What became of each of the viewer's actions this page saw leave the queue (applied with the server's record, refused,
  // expired or discarded) or found held while the switch is off, so the Hub can settle what it shows for it without
  // waiting for a reload (settled()).
  const gone=new Map();
  function note(item,outcome,data){
    const body=parseBody(item);
    gone.delete(item.requestId);
    gone.set(item.requestId,{outcome,collection:String(body?.collection||''),id:String(body?.id||''),clockIn:body?.collection==='timeEntries'&&clockInData(body.data),clockOut:body?.collection==='timeEntries'&&clockOutData(body.data),record:outcome==='applied'&&isRecord(data?.record)?copy(data.record):null});
    if(gone.size>50)gone.delete(gone.keys().next().value);
  }
  let box=deps.queue||null;
  const queue=()=>box||(box=create({now}));

  async function call(path,init){
    const abort=new AbortController(),timer=timers.setTimeout(()=>abort.abort(),timeout);
    try{
      let response;
      try{response=await fetcher(path,{...init,cache:'no-store',signal:abort.signal});}
      catch(error){throw Object.assign(new Error('The Hub could not be reached.'),{status:['HUB_AUTH_REQUIRED','HUB_AUTH_INTERRUPTED'].includes(error?.code)?401:0,cause:error});}
      const data=await response.json().catch(()=>null);
      return {status:Number(response.status)||0,data};
    }finally{timers.clearTimeout(timer);}
  }
  const transport=(path,body)=>call(path,{method:'POST',headers:{'Content-Type':'application/json'},body});
  const session=()=>call(AUTH,{method:'GET'});
  // The Hub reloads its records, so an action that was sent, refused, expired or discarded no longer shows as pending.
  const announce=()=>{if(typeof root.Event==='function')root.dispatchEvent?.(new root.Event('egc:hub-offline-synced'));};

  // One the Hub already told the crew member about (superseded) gets no second notice.
  function notSaved(entries){
    for(const {item,data} of entries.filter(entry=>!entry.superseded&&!entry.item.superseded&&(entry.expired||entry.lost||!directs.has(entry.item.requestId)))){
      const message=typeof data?.error==='string'&&data.error.trim()?data.error.trim().slice(0,300):'The Hub refused this action.';
      state.refused=[...state.refused.filter(row=>row.requestId!==item.requestId),{requestId:item.requestId,label:item.label,queuedAt:item.queuedAt,message}].slice(-20);
      toast(`Not saved: ${item.label}. ${message}`);
    }
  }

  // Removes actions that waited too long and lists the viewer's as not saved at once, before any replay sends a thing, so
  // the Hub never restarts shift location for a clock-out that will never be sent while a pass is still under way.
  async function expireNow(user){
    const old=(await queue().expire()).filter(item=>same(item.user,user));
    if(!old.length)return;
    for(const item of old)note(item,'expired');
    notSaved(old.map(item=>({item,data:{error:expiredText(item)},expired:true})));
    announce();
  }

  async function refresh(){
    const user=viewer().user;
    try{
      if(user&&state.enabled)await expireNow(user);
      state.pending=user?await queue().items(user):[];
    }catch{/* The list refreshes after the next change. */}
    render();
  }

  // Replays the viewer's queue. Actions the server refuses outside the viewer's own save are listed as not saved. A
  // background pass first confirms the signed-in account; the Hub's own save (own) relies on its expectedUser.
  async function drain(own=false){
    const user=viewer().user;
    if(!state.enabled||!user)return {applied:[],dropped:[],stopped:null,remaining:0};
    state.syncing=true;render();
    let result;
    try{await expireNow(user);result=await queue().flush(own?{user,transport}:{user,transport,session});state.synced=user.toLowerCase();}
    catch{result={applied:[],dropped:[],stopped:null,remaining:state.pending.length};}
    finally{state.syncing=false;}
    for(const entry of result.applied)note(entry.item,'applied',entry.data);
    // A clock action dropped with its refused clock-in (lost) is not saved either.
    for(const entry of result.dropped)note(entry.item,entry.expired?'expired':entry.superseded?'superseded':'refused');
    notSaved(result.dropped);
    if([...result.applied,...result.dropped].some(entry=>!directs.has(entry.item.requestId)))announce();
    await refresh();
    return result;
  }

  const sync=()=>!state.enabled?Promise.resolve(null):online()?drain():refresh();
  const json=(status,body)=>new Response(JSON.stringify(body??{}),{status,headers:{'Content-Type':'application/json'}});

  // peopleSet's fetch. Anything this queue does not hold is the original hubFetch call, unchanged.
  async function send(url,init={}){
    const direct=()=>fetcher(url,init);
    if(!state.enabled||String(init.method||'GET').toUpperCase()!=='POST'||typeof init.body!=='string')return direct();
    let body;
    try{body=JSON.parse(init.body);}catch{return direct();}
    const who=viewer(),kind=describe(String(url),body,who.user);
    // The first Hub save after a sign-in also replays what this account left queued.
    if(!kind||!who.user){if(who.user&&state.synced!==who.user.toLowerCase()&&online())void drain();return direct();}
    const requestId=uuid(),options={requestId,user:who.user,crew:who.crew,now},prepared=prepare(body,kind,options);
    const queued=()=>json(202,{ok:true,queued:true,requestId,record:prepared.data});
    // A pass already under way on this page (the 30 s check, 'online', the page becoming visible) may send it first;
    // that pass's answer is then the one returned.
    const answer=()=>{const done=queue().outcome(requestId);return ['applied','refused'].includes(done?.outcome)?json(done.status,done.data):null;};
    directs.add(requestId);
    try{
      const kept=JSON.stringify(prepared),first=JSON.stringify(prepare(body,kind,{...options,captured:false})),live=online()&&first!==kept?first:'';
      let saved;
      try{saved=await queue().enqueue({requestId,user:who.user,path:PATH,body:kept,live,kind:kind.kind,label:kind.label});}
      catch{return direct();}
      // Only an action with nothing queued ahead of it is sent while the Hub waits; behind older ones it is kept at once.
      const behind=Boolean(live&&!saved.live)||await queue().items(who.user).then(rows=>rows.some(row=>row.requestId!==requestId),()=>true);
      if(!online()||behind){directs.delete(requestId);const done=answer();if(done)return done;await refresh();if(online())void drain();return queued();}
      const result=await drain(true);
      const own=[...result.applied,...result.dropped].find(entry=>entry.item.requestId===requestId&&!entry.expired&&!entry.lost);
      if(own)return json(own.status,own.data);
      const done=answer();
      if(done)return done;
      // hubFetch has already started the sign-in flow; the action stays queued for this account.
      if(result.stopped?.item.requestId===requestId&&result.stopped.reason==='auth'&&result.stopped.error?.cause)throw result.stopped.error.cause;
      // Another account holds the sign-in (a tab left open on this account): kept, and the Hub says who must sign in.
      if(result.stopped?.item.requestId===requestId&&result.stopped.reason==='account')return json(202,{ok:true,queued:true,requestId,record:prepared.data,accountChanged:true});
      return queued();
    }finally{directs.delete(requestId);}
  }

  // Whether the viewer's clock and chat saves go through this queue now.
  const holding=()=>state.enabled&&Boolean(viewer().user);
  // Whether the Hub shows the viewer's queued records over the server's copy: while the queue is on, and while the switch
  // has not answered yet (a page opened while an earlier page's clock-out still waits on this device). A definite off
  // shows nothing, as before.
  const showing=()=>(state.enabled||!state.known)&&Boolean(viewer().user);
  const revision=()=>queue().revision?.()||0;
  // The viewer's queued records as the Hub saved them (without the device time and break request ID the queue adds),
  // oldest first. The Hub shows them over the server's copy until each is sent, refused, expired or discarded. Before the
  // switch answers, only a device that already has a queue is read (it is never created for this).
  async function records(){
    const user=viewer().user;
    if(!showing()||!user)return [];
    let rows;
    try{if(!state.enabled&&!await queue().exists())return [];rows=await queue().items(user);}catch{return [];}
    return rows.map(view).filter(Boolean);
  }
  // Switched off (a definite off): the viewer's actions still on this device from an earlier switch-on are held, never
  // sent while the switch is off, and the Hub shows the server's copy. They are found once per signed-in account per page
  // (which also removes every account's expired ones and lists the viewer's as not saved, as a replay would) and listed
  // by settled() as held, so the Hub pauses shift location for a shift whose clock-out waits here and tells the crew
  // member to clock out again. A device that never had a queue is not given one.
  function hold(){
    const user=viewer().user;
    if(!state.known||state.enabled)return Promise.resolve([]);
    // Every account's expired actions are removed once per page, as before, even before anyone signs in on it; the removed
    // ones are kept here to tell the account they belong to once it is the viewer.
    if(!state.swept)state.swept=(async()=>{const found=await queue().exists();return {found,removed:found?await queue().expire():[]};})().catch(()=>({found:false,removed:[]}));
    if(!user)return state.swept.then(()=>[]);
    if(state.held?.user===user.toLowerCase())return state.held.promise;
    const promise=(async()=>{
      const {found,removed}=await state.swept;
      if(!found)return [];
      const old=removed.filter(item=>same(item.user,user));
      for(const item of old)note(item,'expired');
      notSaved(old.map(item=>({item,data:{error:expiredText(item)},expired:true})));
      const kept=await queue().items(user);
      for(const item of kept)note(item,'held');
      if(old.length||kept.length)announce();
      return kept;
    })().catch(()=>[]);
    state.held={user:user.toLowerCase(),promise};
    return promise;
  }
  // Whether this device has a queue to read: switched on it is read (and made); otherwise only one that already exists
  // (switched off, found once per page by hold()).
  async function present(){
    if(state.enabled)return true;
    if(state.known){await hold();return Boolean((await state.swept)?.found);}
    return queue().exists();
  }
  // The viewer's clock-out for that shift saved on this device, or null. Another Hub tab may have saved it: the queue is
  // this device's, shared by every tab. Still queued: as records() lists it (held:true while the switch is off, or once the
  // crew member was told it was not sent). Gone from the queue in the last 12 hours (sent, refused, expired or discarded,
  // perhaps by another tab): {collection, id, requestId, data:null, left:true}. Each carries at, when it was queued. Read
  // fresh each time, so a clock-out removed by release() no longer counts.
  async function clockOut(entryId){
    const user=viewer().user,id=String(entryId||''),match=row=>row?.collection==='timeEntries'&&row.id===id&&clockOutData(row.data);
    if(!user||!id)return null;
    try{
      if(!await present())return null;
      const item=(await queue().items(user)).find(row=>match(view(row)));
      if(item)return {...view(item),at:item.queuedAt,...(!state.known||state.enabled&&!item.superseded?{}:{held:true})};
      const left=await queue().clockedOut?.(user,id);
      return left?{collection:'timeEntries',id,requestId:String(left.requestId),data:null,at:String(left.at),left:true}:null;
    }catch{return null;}
  }
  // Offline saving is off and the Hub told the crew member that this action was not sent and to do it again: it is never
  // sent, even after offline saving is switched back on (a clock-in takes what was queued after it for that shift).
  async function supersede(requestId){
    if(!viewer().user||!state.known||state.enabled)return [];
    try{return await present()?await queue().supersede(requestId):[];}catch{return [];}
  }
  // What the crew member did instead of a held action, while offline saving is off, removes it from the device so a later
  // switch-on never sends it: 'resume' (shift location resumed for that shift) its clock-out, which is also forgotten
  // (clockOut() stops finding it, switched on or off); 'clock_out' (clocked out of that shift again) every clock action
  // held for that shift; 'clock_in' (clocked in to that new shift) every held clock-in for another shift, with the clock
  // actions queued after it. Returns what was removed; settled() lists each as released.
  async function release({entryId,op}={}){
    const user=viewer().user,id=String(entryId||''),held=state.known&&!state.enabled,removed=[];
    if(!user||!id||!['resume','clock_out','clock_in'].includes(op))return removed;
    try{
      if(!await present())return removed;
      if(op==='resume')await queue().forget(user,id);
      if(held){
        const rows=(await queue().items(user)).map(item=>({item,row:view(item)})).filter(({row})=>row?.collection==='timeEntries');
        const pick=rows.filter(({row})=>op==='resume'?row.id===id&&clockOutData(row.data):op==='clock_out'?row.id===id:row.id!==id&&clockInData(row.data));
        for(const {item} of pick)if(!removed.some(row=>row.requestId===item.requestId))removed.push(...await queue().discard(item.requestId));
      }
    }catch{/* What was not removed stays held, as before. */}
    for(const item of removed)note(item,'released');
    const ids=new Set(removed.map(item=>item.requestId));
    if(ids.size&&state.held)state.held={...state.held,promise:state.held.promise.then(list=>list.filter(item=>!ids.has(item.requestId)))};
    return removed;
  }

  // A discarded clock-in takes the clock actions queued after it for that shift with it (the whole shift is discarded).
  async function discard(requestId){
    const gone=await queue().discard(requestId);
    for(const item of gone.length?gone:[state.pending.find(row=>row.requestId===requestId)||{requestId,body:''}])note(item,'discarded');
    state.confirm='';
    announce();
    await refresh();
  }
  function dismiss(){state.refused=[];render();}

  function build(){
    if(state.ui)return state.ui;
    const label=h(doc,'span',{class:'hs-label'}),button=h(doc,'button',{type:'button',class:'hs-chip','aria-haspopup':'dialog',onclick:open},h(doc,'span',{class:'hs-dot','aria-hidden':'true'}),label);
    const body=h(doc,'div',{class:'hs-body'}),dialog=h(doc,'dialog',{class:'hs-panel','aria-labelledby':'hs-title'},h(doc,'header',{},h(doc,'h2',{id:'hs-title'},'Pending sync')),body);
    const chip=h(doc,'div',{class:'egc-hub-sync','aria-live':'polite',hidden:true},button);
    dialog.addEventListener('close',()=>{state.confirm='';if(!chip.hidden)button.focus?.();});
    doc.body.append(chip,dialog);
    state.ui={chip,button,label,dialog,body};
    return state.ui;
  }

  function panel(){
    const ui=state.ui,isOnline=online(),count=state.pending.length;
    const status=h(doc,'p',{class:'hs-status'},count?isOnline?'These actions are saved on this device and send in order.':'You are offline. These actions are saved on this device and send in order when you reconnect.':'Nothing is waiting to send.');
    const list=count?h(doc,'ul',{class:'hs-list'},state.pending.map(item=>{
      const confirming=state.confirm===item.requestId,body=parseBody(item),shift=body?.collection==='timeEntries'&&clockInData(body.data)&&state.pending.some(row=>row.seq>item.seq&&parseBody(row)?.collection==='timeEntries'&&parseBody(row)?.id===body.id);
      return h(doc,'li',{},h(doc,'div',{},h(doc,'strong',{},item.label),h(doc,'span',{},`Saved ${stamp(item.queuedAt)} · ${waitingText(item,isOnline)}`)),
        h(doc,'button',{type:'button',class:'hs-discard','data-request':item.requestId,onclick:()=>{
          if(state.confirm!==item.requestId){state.confirm=item.requestId;panel();timers.setTimeout(()=>{if(state.confirm===item.requestId){state.confirm='';if(ui.dialog.open)panel();}},CONFIRM_MS);return;}
          void discard(item.requestId);
        }},confirming?shift?'Tap again to discard this shift':'Tap again to discard':'Discard'));
    })):null;
    const refused=state.refused.length?h(doc,'div',{class:'hs-refused',role:'alert'},h(doc,'h3',{},'Not saved'),
      h(doc,'ul',{class:'hs-list'},state.refused.map(row=>h(doc,'li',{},h(doc,'div',{},h(doc,'strong',{},row.label),h(doc,'span',{},`Saved ${stamp(row.queuedAt)} · ${row.message}`))))),
      h(doc,'button',{type:'button',class:'hs-dismiss',onclick:dismiss},'Dismiss')):null;
    const footer=h(doc,'footer',{},
      h(doc,'button',{type:'button',class:'hs-sync',disabled:!isOnline||state.syncing||!count,onclick:()=>{void sync();}},state.syncing?'Syncing…':'Sync now'),
      h(doc,'button',{type:'button',class:'hs-close',onclick:()=>ui.dialog.close?.()},'Close'));
    ui.body.replaceChildren(...[status,list,refused,footer].filter(Boolean));
  }

  function open(){
    const ui=build();
    panel();
    if(ui.dialog.open)return;
    if(typeof ui.dialog.showModal==='function')ui.dialog.showModal();else ui.dialog.setAttribute('open','');
  }

  function render(){
    if(!doc?.body)return;
    const count=state.pending.length,refused=state.refused.length,show=state.enabled&&Boolean(viewer().user)&&Boolean(count||refused);
    if(!show&&!state.ui)return;
    const ui=build();
    ui.chip.hidden=!show;
    if(show){
      ui.chip.classList.toggle('refused',!count);
      ui.label.textContent=count?`Pending sync · ${count}`:`${refused} not saved`;
      ui.button.setAttribute('aria-label',count?`${count} action${count===1?'':'s'} waiting to sync. Open pending sync.`:`${refused} action${refused===1?' was':'s were'} not saved. Open details.`);
    }
    if(ui.dialog.open){if(state.enabled&&viewer().user)panel();else ui.dialog.close?.();}
  }

  function listen(){
    if(state.listening)return;
    state.listening=true;
    root.addEventListener?.('online',()=>{void sync();});
    root.addEventListener?.('offline',render);
    doc?.addEventListener?.('visibilitychange',()=>{if(doc.visibilityState!=='hidden')void sync();});
  }
  // Signing out forgets what this page knew about the account's actions, switched on or off.
  function forget(){
    if(state.forgetting)return;
    state.forgetting=true;
    root.addEventListener?.('egc:signout',()=>{state.pending=[];state.refused=[];state.confirm='';state.synced='';state.held=null;gone.clear();render();});
  }

  // Called with the switch's definite answer only; an unknown answer leaves the page as it started.
  function configure({enabled=false}={}){
    state.enabled=enabled===true;
    state.known=true;
    forget();
    if(state.enabled){
      listen();
      if(!state.timer)state.timer=timers.setInterval(()=>{if(state.enabled&&viewer().user)void sync();},CHECK_MS);
      void sync();
    }else{
      if(state.timer)timers.clearInterval(state.timer);
      state.timer=0;state.pending=[];state.refused=[];render();
      // Switched off, the device keeps unexpired actions for a later switch-on but removes any account's expired ones; the
      // viewer is told about both (hold). Before anyone is signed in on this page, nothing is removed yet.
      void hold();
    }
    return state.enabled;
  }

  const snapshot=()=>({enabled:state.enabled,known:state.known,pending:state.pending.map(item=>({requestId:item.requestId,label:item.label,queuedAt:item.queuedAt,waiting:item.waiting})),refused:state.refused.map(row=>({...row})),syncing:state.syncing});
  // settled(requestId): what became of that action (applied, refused, expired, discarded, or held while the switch is off),
  // or null if this page has not seen it. settled(): all of them, oldest first, each with its record's collection and ID
  // and whether it was a clock-in or a clock-out.
  const settled=requestId=>{
    const view=([key,done])=>({requestId:key,outcome:done.outcome,collection:done.collection,id:done.id,clockIn:done.clockIn,clockOut:done.clockOut,record:done.record?copy(done.record):null});
    if(requestId===undefined)return [...gone].map(view);
    return gone.has(requestId)?view([requestId,gone.get(requestId)]):null;
  };
  return {configure,send,sync,discard,state:snapshot,open,holding,showing,records,revision,settled,hold,clockOut,supersede,release};
}

let page=null;
const current=()=>page||(page=controller());
root.EGCHubOffline=Object.freeze({
  create,idbStore,memoryStore,describe,prepare,classify,controller,
  configure:options=>current().configure(options),
  send:(url,init)=>current().send(url,init),
  sync:()=>current().sync(),
  state:()=>current().state(),
  holding:()=>current().holding(),
  showing:()=>current().showing(),
  records:()=>current().records(),
  hold:()=>current().hold(),
  clockOut:entryId=>current().clockOut(entryId),
  supersede:requestId=>current().supersede(requestId),
  release:options=>current().release(options),
  revision:()=>current().revision(),
  settled:requestId=>current().settled(requestId),
});
})(typeof self!=='undefined'?self:globalThis);
