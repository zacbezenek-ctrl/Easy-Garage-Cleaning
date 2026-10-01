/* Dispatch month grid and per-employee / per-crew time lanes, registered on EGCDispatch.registerView.
   Moves and assignments are schedule.update requests with expectedRevision, sent through dispatch's own
   save(), so an unverified save is kept in this tab and retried with the same requestId. All times are
   Denver wall clock (the server recomputes instants and rechecks every conflict). */
(function () {
'use strict';
const AXIS_START = 360, AXIS_END = 1200, SLOT = 30, SPAN = AXIS_END - AXIS_START;
const TERMINAL = new Set(['completed','cancelled','canceled','paid','invoiced','review_requested','closed','noshow','no_show','no-show']);
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/;
const C = { mode:'employee', drag:null, suppressClick:false, message:'', statusNode:null };

// Pure schedule model (also loaded by tests/dispatch-calendar.test.mjs).
const noon = date => Date.parse(date+'T12:00:00Z');
const addDays = (date, count) => new Date(noon(date)+count*86400000).toISOString().slice(0,10);
const weekday = date => new Date(noon(date)).getUTCDay();
const monthStart = date => date.slice(0,8)+'01';
function addMonths(date, count) { const day=new Date(noon(monthStart(date))); day.setUTCMonth(day.getUTCMonth()+count); return day.toISOString().slice(0,10); }
// Sunday-first weeks covering the month: 28 to 42 days, far inside the 93-day read cap.
function monthGrid(date) {
  const first=monthStart(date), last=addDays(addMonths(first,1),-1), startDate=addDays(first,-weekday(first)), endDate=addDays(last,7-weekday(last)), days=[];
  for (let day=startDate; day<endDate; day=addDays(day,1)) days.push(day);
  return {month:first.slice(0,7), first, startDate, endDate, days};
}
const minutesOf = value => TIME.test(value||'') ? Number(value.slice(0,2))*60+Number(value.slice(3)) : NaN;
const hhmm = minute => String(Math.floor(minute/60)).padStart(2,'0')+':'+String(minute%60).padStart(2,'0');
function clock(value) { const minute=minutesOf(value); if (!Number.isFinite(minute)) return 'Time needed'; const hour=Math.floor(minute/60); return (hour%12||12)+':'+value.slice(3)+' '+(hour<12?'AM':'PM'); }
// Wall-clock minutes since the epoch for a Denver date and time; differences are wall-clock durations.
function wall(date, time) { return DATE.test(date||'') && TIME.test(time||'') ? Date.UTC(+date.slice(0,4),+date.slice(5,7)-1,+date.slice(8,10))/60000+minutesOf(time) : NaN; }
function fromWall(value) { const text=new Date(value*60000).toISOString(); return {date:text.slice(0,10), time:text.slice(11,16)}; }
const segmentsOf = job => Array.isArray(job?.assignmentSegments) ? job.assignmentSegments : [];
const inactive = job => TERMINAL.has(job?.status||job?.pipelineStatus);
// One row per assignment segment (SEGMENTS), otherwise the job itself.
function rowsOf(job) {
  const row = (source, segmentId) => ({job, segmentId, date:source.date||'', time:source.time||'', endDate:source.endDate||source.date||'', endTime:source.endTime||'',
    assignedCrew:Array.isArray(source.assignedCrew)?source.assignedCrew:[], crewLead:source.crewLead||null, crewId:source.crewId||null, vehicleId:source.vehicleId||null});
  const segments=segmentsOf(job);
  return segments.length ? segments.map(segment => row(segment, segment.id)) : [row(job, null)];
}
// The minutes of `date` a row occupies. An end at 00:00 releases that day.
function dayWindow(row, date) {
  const start=wall(row.date,row.time), end=wall(row.endDate||row.date,row.endTime), day=wall(date,'00:00');
  if (!(end>start) || !Number.isFinite(day)) return null;
  const from=Math.max(start,day)-day, to=Math.min(end,day+1440)-day;
  return to>from ? {start:from, end:to, startsToday:start>=day, endsToday:end<=day+1440} : null;
}
function availabilityRow(block) {
  if (['cancelled','canceled'].includes(block?.status) || !DATE.test(block?.date||'')) return null;
  return block.allDay===true ? {date:block.date, time:'00:00', endDate:addDays(block.endDate||block.date,1), endTime:'00:00'} : {date:block.date, time:block.time, endDate:block.endDate||block.date, endTime:block.endTime};
}
// Dated work whose saved times cannot be placed; views report it instead of silently leaving it out.
function untimed(jobs, first, last=first) { return jobs.filter(job => job.type!=='blocked' && DATE.test(job.date||'') && job.date<=last && (job.endDate||job.date)>=first && rowsOf(job).some(row => !(wall(row.endDate||row.date,row.endTime)>wall(row.date,row.time)))); }
const sameAddress = (a, b) => Boolean(a?.address) && String(a.address).trim().toLowerCase().replace(/\s+/g,' ') === String(b?.address||'').trim().toLowerCase().replace(/\s+/g,' ');
const nameOf = (data, id) => (data?.roster||[]).find(person => person.id===id)?.name || id;
const jobLabel = job => job.customer || job.title || 'Job';

/** Lanes for one Denver date: 'employee' mode has a row per roster employee, 'crew' mode a row per active
 * saved crew; both start with Unassigned. Items are placed per segment, stacked in tracks when they
 * overlap, with availability and company-block shading and the travel gap between consecutive stops. */
function laneModel(data, jobs, date, {mode='employee', employee=''}={}) {
  const lanes=new Map(), crews=data?.crews||[];
  const lane = (id, kind, label, extra={}) => { if (!lanes.has(id)) lanes.set(id,{id, kind, label, items:[], shades:[], gaps:[], memberIds:[], ...extra}); return lanes.get(id); };
  // Only active crews and roster employees take new work.
  const crewLane = crew => lane('crew:'+crew.id, 'crew', crew.name+(crew.status==='active'?'':' · inactive'), {crew, memberIds:crew.memberIds||[], drop:crew.status==='active'});
  // Owner decision F19: an office-only owner or manager (fieldWork:false) gets a lane only for work
  // already assigned to them (or when the board is filtered to them) and never takes a drop.
  const employeeLane = id => { const found=(data?.roster||[]).find(person => person.id===id); return lane('employee:'+id, 'employee', found ? nameOf(data,id) : id+' · not on the active roster', {employeeId:id, memberIds:[id], drop:Boolean(found) && found.fieldWork!==false}); };
  lane('unassigned', 'unassigned', 'Unassigned');
  if (mode==='crew') for (const crew of crews.filter(row => row.status==='active')) crewLane(crew);
  else for (const person of data?.roster||[]) if (employee ? person.id===employee : person.fieldWork!==false) employeeLane(person.id);
  const company=[];
  for (const job of jobs) for (const row of rowsOf(job)) {
    const span=dayWindow(row,date); if (!span) continue;
    if (job.type==='blocked') { company.push({...span, kind:'blocked', label:'Company time block'+(job.title?' · '+job.title:'')}); continue; }
    const item={...span, row, job, key:job.id+(row.segmentId?'~'+row.segmentId:'')};
    const crew=crews.find(entry => entry.id===row.crewId);
    const targets=!row.assignedCrew.length ? [lane('unassigned')] : mode==='crew' ? [crew ? crewLane(crew) : lane('individual','individual','Individual assignments')]
      : row.assignedCrew.filter(id => !employee || id===employee).map(employeeLane);
    for (const target of targets) target.items.push({...item, lane:target.id});
  }
  for (const block of data?.availability||[]) {
    const source=availabilityRow(block), span=source && dayWindow(source,date); if (!span) continue;
    for (const entry of lanes.values()) if (entry.memberIds.includes(block.employeeId)) entry.shades.push({...span, kind:'unavailable', employeeId:block.employeeId,
      label:(entry.kind==='crew'?nameOf(data,block.employeeId)+' unavailable':'Unavailable')+(block.allDay===true?' all day':'')+(block.reason?' · '+block.reason:'')});
  }
  const warnings=(data?.warnings||[]).filter(warning => warning.code==='travel_buffer_short');
  for (const entry of lanes.values()) {
    if (entry.kind!=='unassigned') entry.shades.push(...company);
    entry.items.sort((a,b) => a.start-b.start || a.end-b.end || a.key.localeCompare(b.key));
    const ends=[];
    for (const item of entry.items) { let track=ends.findIndex(end => end<=item.start); if (track<0) { track=ends.length; ends.push(0); } ends[track]=item.end; item.track=track; }
    entry.tracks=Math.max(1,ends.length);
    entry.minutes=entry.items.reduce((sum,item) => sum+item.end-item.start, 0);
    if (!['employee','crew'].includes(entry.kind)) continue;
    let previous=null;
    for (const item of entry.items) {
      if (previous && previous.end<=item.start && previous.job.id!==item.job.id) {
        const server=warnings.filter(w => w.jobId===previous.job.id&&w.otherJobId===item.job.id || w.jobId===item.job.id&&w.otherJobId===previous.job.id).reduce((max,w) => Math.max(max,Number(w.requiredMinutes)||0),0);
        const minutes=item.start-previous.end, required=Math.max(Number(previous.job.travelBufferMinutes)||0, Number(item.job.travelBufferMinutes)||0, server);
        entry.gaps.push({start:previous.end, end:item.start, minutes, required, from:previous.key, to:item.key, status:sameAddress(previous.job,item.job)?'same_property':minutes<required?'short':'ok'});
      }
      if (!previous || item.end>previous.end) previous=item;
    }
  }
  const order=['unassigned','employee','crew','individual'];
  return {date, mode, lanes:[...lanes.values()].filter(entry => entry.kind!=='unassigned' || entry.items.length).sort((a,b) => order.indexOf(a.kind)-order.indexOf(b.kind))};
}

/** Local, advisory hints for giving `row` to these employees, from the loaded overview only. */
function hints(data, row, memberIds) {
  const start=wall(row.date,row.time), end=wall(row.endDate||row.date,row.endTime), out=[];
  if (!(end>start)) return out;
  const who = ids => memberIds.length>1 ? ids.map(id => nameOf(data,id)).join(', ')+': ' : '';
  const span = other => clock(other.time)+' – '+clock(other.endTime);
  for (const job of data?.jobs||[]) {
    if (inactive(job)) continue;
    for (const other of rowsOf(job)) {
      // Other segments of the same job still collide; the unsplit job itself never does.
      if (job.id===row.job.id && (!row.segmentId || other.segmentId===row.segmentId)) continue;
      const from=wall(other.date,other.time), to=wall(other.endDate||other.date,other.endTime);
      if (!(to>from)) continue;
      if (job.type==='blocked') { if (from<end && start<to) out.push({kind:'blocked', message:'Company time block '+span(other)+(job.title?' · '+job.title:'')}); continue; }
      const shared=memberIds.filter(id => other.assignedCrew.includes(id));
      if (!shared.length) continue;
      if (from<end && start<to) { out.push({kind:'busy', jobId:job.id, message:who(shared)+'Busy '+span(other)+' · '+(job.id===row.job.id?'another segment of this job':jobLabel(job))}); continue; }
      const buffer=Math.max(Number(job.travelBufferMinutes)||0, Number(row.job.travelBufferMinutes)||0), gap=to<=start ? start-to : from-end;
      if (buffer && gap<buffer && !sameAddress(job,row.job)) out.push({kind:'travel', jobId:job.id, message:who(shared)+'Only '+gap+' min '+(to<=start?'after ':'before ')+jobLabel(job)+' (travel buffer '+buffer+' min)'});
    }
  }
  for (const block of data?.availability||[]) {
    const source=availabilityRow(block); if (!source || !memberIds.includes(block.employeeId)) continue;
    const from=wall(source.date,source.time), to=wall(source.endDate,source.endTime);
    if (from<end && start<to) out.push({kind:'unavailable', message:who([block.employeeId])+'Unavailable '+(block.allDay===true?'all day':span(source))+(block.reason?' · '+block.reason:'')});
  }
  return out;
}

const sameSet = (a, b) => a.length===b.length && a.every(value => b.includes(value));
/** The crew fields for handing `item` (opened from lane item.lane) to a target lane, or null when unchanged.
 * Employee rows swap the source employee for the target (the lead role moves with them); from any other
 * row the target becomes the whole crew. A saved crew brings its members, lead and crew id. */
function crewChange(data, item, target) {
  const row=item.row, crew=row.assignedCrew, source=item.lane||'';
  if (target.id===source) return null;
  if (target.kind==='crew') return row.crewId===target.crew.id && sameSet(crew,target.crew.memberIds||[]) ? null : {assignedCrew:[...(target.crew.memberIds||[])], crewLead:target.crew.leadId||null, crewId:target.crew.id};
  if (target.kind!=='employee') return {error:'Drop the job on an employee or crew row.'};
  const id=target.employeeId;
  if (crew.includes(id)) return {error:nameOf(data,id)+' already works this job. Move it within that row to change its time.'};
  const from=source.startsWith('employee:') ? source.slice(9) : '';
  if (!from || !crew.includes(from)) return {assignedCrew:[id], crewLead:id, crewId:null};
  const next=crew.map(value => value===from ? id : value);
  return {assignedCrew:next, crewLead:row.crewLead===from ? id : next.includes(row.crewLead) ? row.crewLead : null, crewId:null};
}
function segmentPayload(segment, data) {
  const crewId=segment.crewId && (data?.crews||[]).some(crew => crew.id===segment.crewId && crew.status==='active') ? segment.crewId : null;
  return {id:segment.id, date:segment.date, time:segment.time, endDate:segment.endDate||segment.date, endTime:segment.endTime, assignedCrew:[...(segment.assignedCrew||[])], crewLead:segment.crewLead||null, ...(crewId?{crewId}:{}), vehicleId:segment.vehicleId||null, notes:String(segment.notes||'').trim()};
}
/** schedule.update changes for giving `item` to `target` and, with {date,start}, starting it at `start`
 * minutes on `date` with the same duration. A split job changes only the moved segment. */
function moveChanges(data, item, target, {date=null, start=null}={}) {
  const row=item.row, job=item.job;
  const crew=crewChange(data,item,target);
  if (crew?.error) return {error:crew.error};
  let next={date:row.date, time:row.time, endDate:row.endDate||row.date, endTime:row.endTime};
  if (date!==null && start!==null) {
    const begin=wall(date,'00:00')+start, length=wall(row.endDate||row.date,row.endTime)-wall(row.date,row.time);
    if (!Number.isFinite(begin) || !(length>0)) return {error:'This job needs valid start and end times before it can be moved. Open it to review the schedule.'};
    const a=fromWall(begin), b=fromWall(begin+length);
    next={date:a.date, time:a.time, endDate:b.date, endTime:b.time};
  }
  const moved=next.date!==row.date || next.time!==row.time || next.endDate!==(row.endDate||row.date) || next.endTime!==row.endTime;
  if (!moved && !crew) return {error:'Nothing changed.'};
  const result={next, crew, moved, arrivalCleared:false};
  if (row.segmentId) {
    result.changes={assignmentSegments:segmentsOf(job).map(segment => segmentPayload(segment.id===row.segmentId ? {...segment, ...(moved?next:{}), ...(crew||{})} : segment, data))};
    return result;
  }
  const changes={...(moved?next:{}), ...(crew||{})};
  // The custom arrival window moves with the start time, as in the job editor; it is cleared if it would cross midnight.
  const shift=minutesOf(next.time)-minutesOf(row.time);
  if (moved && shift && job.arrivalWindowStart && job.arrivalWindowEnd) {
    const from=minutesOf(job.arrivalWindowStart)+shift, to=minutesOf(job.arrivalWindowEnd)+shift;
    if (from>=0 && to<1440) Object.assign(changes,{arrivalWindowStart:hhmm(from), arrivalWindowEnd:hhmm(to)});
    else { Object.assign(changes,{arrivalWindowStart:null, arrivalWindowEnd:null}); result.arrivalCleared=true; }
  }
  result.changes=changes;
  return result;
}

/** True when a move changes the visit's start (a split job starts at its earliest segment); the server records that as a reschedule. */
function startChanged(item, result) {
  if (!result?.moved) return false;
  const first = rows => rows.map(row => row.date+'T'+row.time).sort()[0], before=rowsOf(item.job);
  return first(before) !== first(before.map(row => !item.row.segmentId || row.segmentId===item.row.segmentId ? {...row, ...result.next} : row));
}

// Browser views.
const kit = () => window.EGCDispatch?.internals;
const pct = minute => Math.min(100,Math.max(0,(minute-AXIS_START)/SPAN*100));
function place(node, start, end) {
  const left=pct(start), width=Math.max(0,pct(end)-left);
  node.style.left='min('+left.toFixed(3)+'%, calc(100% - 44px))';
  node.style.width=width.toFixed(3)+'%';
}
function refusal(data, job) {
  if (job.type==='blocked') return 'Company time blocks are edited with Block time.';
  if (inactive(job)) return 'Completed and cancelled work keeps its schedule history.';
  if (job.segmentsInvalid) return 'The saved crew segments for this job could not be read. Open the job and save one job-level time and crew.';
  if (segmentsOf(job).length && data?.segments?.enabled!==true) return 'Crew segments are turned off. Open the job to keep or remove its segments.';
  return '';
}
// Until the read for this view's range lands, the previous range's jobs are not shown as if complete.
function pending(k, S, range, subject) {
  const data=S.data;
  if (typeof data?.startDate!=='string' || data.startDate===range.startDate && data.endDate===range.endDate) return null;
  return S.loading ? k.h('div',{class:'dc-skeleton','aria-busy':'true'},k.h('p',{class:'dc-sr',role:'status'},'Loading '+subject+'…'),k.h('span',{}),k.h('span',{}),k.h('span',{class:'dc-short'}))
    : k.notice('The schedule for '+subject+' has not loaded, so nothing is shown for it. Retry to load it.','error');
}
function say(text) { C.message=text; if (C.statusNode?.isConnected) C.statusNode.textContent=text; }
function renderMonth(target, jobs) {
  cancelDrag();
  const k=kit(), S=k.state(), {h}=k, grid=monthGrid(S.date), today=k.today(), byDay=new Map(grid.days.map(day => [day,[]]));
  const wait=pending(k,S,grid,'this month'); if (wait) { target.append(wait); return; }
  for (const job of jobs) for (const row of rowsOf(job)) {
    if (!row.date || S.employee && row.segmentId && !row.assignedCrew.includes(S.employee)) continue;
    for (const day of grid.days) { const span=dayWindow(row,day); if (span) byDay.get(day).push({job, row, span}); }
  }
  const title=new Intl.DateTimeFormat('en-US',{timeZone:'UTC', month:'long', year:'numeric'}).format(new Date(noon(grid.first)));
  const cells=grid.days.map(day => {
    const entries=byDay.get(day).sort((a,b) => a.span.start-b.span.start || jobLabel(a.job).localeCompare(jobLabel(b.job)));
    const open=entries.filter(entry => entry.job.type!=='blocked' && !inactive(entry.job) && !entry.row.assignedCrew.length).length;
    const chips=entries.slice(0,3).map(({job,row,span}) => { const text=(job.type==='blocked'?'Blocked':span.startsToday?clock(row.time):'Cont.')+' '+(job.type==='blocked'?job.title||'company time':jobLabel(job))+(row.segmentId?' · '+row.assignedCrew.map(id => nameOf(S.data,id)).join(', '):'');
      return h('span',{class:'dc-chip'+(job.type==='blocked'?' dc-chip-blocked':!inactive(job)&&!row.assignedCrew.length?' dc-chip-open':inactive(job)?' dc-chip-muted':''), title:text},text); });
    const count=entries.length, label=k.dateText(day)+': '+(count?count+(count===1?' item':' items'):'no work')+(open?', '+open+' unassigned':'')+'. Open this day.';
    return h('button',{type:'button', class:'dc-cell'+(day.slice(0,7)===grid.month?'':' dc-out')+(day===today?' dc-now':'')+(day===S.date?' dc-picked':''), 'aria-label':label, onclick:()=>k.show('day',day)},
      h('span',{class:'dc-num','aria-hidden':'true'},String(Number(day.slice(8)))),
      count?h('span',{class:'dc-count'+(open?' dc-count-open':''),'aria-hidden':'true'},String(count)):null,
      h('span',{class:'dc-chips','aria-hidden':'true'},chips,count>3?h('span',{class:'dc-more'},'+'+(count-3)+' more'):null));
  });
  const review=untimed(jobs,grid.startDate,addDays(grid.endDate,-1)).length;
  target.append(h('section',{class:'dc-month','aria-label':title},
    h('header',{class:'dc-view-head'},h('h2',{},title),h('p',{class:'dp-muted'},'Tap a day to open its schedule. Split jobs show each crew segment.')),
    review?k.notice(review+(review===1?' job in this month has':' jobs in this month have')+' saved times that need review and '+(review===1?'is':'are')+' not shown on the grid. Open Jobs view to fix '+(review===1?'it':'them')+'.','error'):null,
    h('div',{class:'dc-weekdays','aria-hidden':'true'},['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(day => h('span',{},day))),
    h('div',{class:'dc-grid'},cells)));
}
function laneStatus(lane) {
  const jobs=new Set(lane.items.map(item => item.job.id)).size;
  return jobs ? jobs+(jobs===1?' job':' jobs')+' · '+(lane.minutes/60).toFixed(1)+' hr' : lane.shades.some(shade => shade.kind==='unavailable') ? 'No work · has unavailable time' : 'No work';
}
function itemNode(k, S, lane, item) {
  const {h}=k, job=item.job, row=item.row, others=row.assignedCrew.filter(id => lane.kind!=='employee' || id!==lane.employeeId);
  const time=(item.startsToday?clock(row.time):'Earlier')+' – '+(item.endsToday?clock(row.endTime):'continues');
  const meta=[job.type==='walkthrough'?'Walkthrough':job.serviceType||'', job.type==='walkthrough'&&typeof job.walkthroughBadge==='string'?job.walkthroughBadge:'', row.segmentId?'Crew segment':'', lane.kind==='employee'&&others.length?'with '+others.map(id => nameOf(S.data,id)).join(', '):lane.kind!=='employee'&&others.length?others.map(id => nameOf(S.data,id)).join(', '):''].filter(Boolean).join(' · ');
  const locked=refusal(S.data,job), node=h('button',{type:'button', class:'dc-item'+(locked?' dc-locked':'')+(item.start<AXIS_START?' dc-before':'')+(item.end>AXIS_END?' dc-after':'')+(inactive(job)?' dc-muted':''),
    'data-dc-item':item.key, title:time+' · '+jobLabel(job)+(meta?' · '+meta:''), 'aria-label':time+', '+jobLabel(job)+(meta?', '+meta:'')+'. '+(locked||'Assign or move.'),
    onclick:()=>{ if (C.suppressClick) { C.suppressClick=false; return; } openSheet(item); }},
    h('span',{class:'dc-item-time'},time),h('span',{class:'dc-item-name'},jobLabel(job)),meta?h('span',{class:'dc-item-meta'},meta):null);
  place(node,item.start,item.end); node.style.setProperty('--dc-track',item.track);
  node.addEventListener('pointerdown',event => startDrag(event,item,node));
  node.addEventListener('pointermove',dragMove);
  node.addEventListener('pointerup',dragEnd);
  node.addEventListener('pointercancel',cancelDrag);
  return node;
}
function laneNode(k, S, lane) {
  const {h}=k, track=h('div',{class:'dc-track'}), entries=[];
  track.style.setProperty('--dc-tracks',lane.tracks);
  for (const shade of lane.shades) { const node=h('div',{class:'dc-shade dc-'+shade.kind, title:shade.label},h('span',{},(shade.startsToday&&shade.endsToday&&shade.end-shade.start<1440?clock(hhmm(shade.start))+' – '+(shade.end===1440?'midnight':clock(hhmm(shade.end)))+' · ':'')+shade.label)); place(node,shade.start,shade.end); entries.push([shade.start,0,node]); }
  for (const gap of lane.gaps) {
    const text=gap.status==='same_property'?gap.minutes+' min · same property':gap.status==='short'?'Only '+gap.minutes+' min between stops · needs '+gap.required:gap.minutes+' min gap'+(gap.required?' · buffer '+gap.required:'');
    const node=h('div',{class:'dc-gap dc-gap-'+gap.status, title:text},h('span',{},text)); place(node,gap.start,gap.end); entries.push([gap.start,1,node]);
  }
  for (const item of lane.items) entries.push([item.start,2,itemNode(k,S,lane,item)]);
  entries.sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  track.append(...entries.map(entry => entry[2]));
  if (!lane.items.length) track.append(h('p',{class:'dc-empty'},lane.kind==='employee'?'No work scheduled':'No work'));
  return h('section',{class:'dc-lane dc-lane-'+lane.kind, 'data-dc-lane':lane.id, ...(lane.drop?{'data-dc-drop':'true'}:{}), 'aria-label':lane.label},
    h('div',{class:'dc-lane-label'},h('strong',{},lane.label),h('small',{},lane.kind==='unassigned'?'Tap a job to assign it':laneStatus(lane))),track);
}
let lastModel=null;
function renderLanes(target, jobs) {
  redrawn();
  const k=kit(), S=k.state(), {h, btn}=k, wait=pending(k,S,{startDate:S.date, endDate:addDays(S.date,1)},'this date');
  if (wait) { target.append(wait); return; }
  const model=laneModel(S.data,jobs,S.date,{mode:C.mode, employee:S.employee});
  lastModel=model;
  const modes=h('div',{class:'dc-lane-modes', role:'group', 'aria-label':'Lane rows'},
    [['employee','By employee'],['crew','By crew']].map(([id,label]) => btn(label,()=>{ C.mode=id; k.redraw(); },C.mode===id?'selected':'',{'aria-pressed':C.mode===id?'true':'false'})));
  C.statusNode=h('p',{class:'dc-status', role:'status', 'aria-live':'polite'},C.message); C.message='';
  const review=untimed(jobs,S.date).length;
  const axis=h('div',{class:'dc-axis','aria-hidden':'true'},h('span',{class:'dc-lane-label'}),h('div',{class:'dc-axis-track'},Array.from({length:SPAN/60},(_,index) => h('span',{},clock(hhmm(AXIS_START+index*60)).replace(':00','')))));
  const rows=model.lanes.map(lane => laneNode(k,S,lane));
  target.append(h('section',{class:'dc-lanes','aria-label':'Lanes for '+k.dateText(S.date)},
    h('header',{class:'dc-view-head'},h('div',{},h('h2',{},k.dateText(S.date)),h('p',{class:'dp-muted dc-wide-only'},'Rows show 6 AM – 8 PM in 30-minute steps. Drag a job to another row or time; tap it to assign. Shaded time is unavailable; gaps show travel time between stops.'),
      h('p',{class:'dp-muted dc-phone-only'},'Tap a job to assign it. Shaded time is unavailable; gaps show travel time between stops.')),modes),
    C.statusNode,review?k.notice(review+(review===1?' job on this date has':' jobs on this date have')+' saved times that need review and '+(review===1?'is':'are')+' not shown in the lanes. Open Day view to fix '+(review===1?'it':'them')+'.','error'):null,
    h('div',{class:'dc-lane-grid'},axis,rows.length?rows:h('p',{class:'dc-empty'},C.mode==='crew'?'No active saved crews. Add one in Crews & vehicles, or view lanes by employee.':'No active employees on the roster.'))));
}

// Desktop drag: pointer events only for mouse and pen on the timeline layout; touch keeps scrolling, and taps
// and the phone-width agenda (no time axis) open the sheet.
function minuteAt(track, x) { const rect=track.getBoundingClientRect(); return AXIS_START+(x-rect.left)/Math.max(1,rect.width)*SPAN; }
const agenda = () => window.matchMedia?.('(max-width:680px)').matches===true;
function startDrag(event, item, node) {
  if (C.drag && !C.drag.node.isConnected) cancelDrag();
  if (event.button!==0 || event.pointerType==='touch' || C.drag || agenda()) return;
  C.drag={item, node, pointerId:event.pointerId, x:event.clientX, y:event.clientY, offset:minuteAt(node.parentElement,event.clientX)-Math.max(item.start,AXIS_START), moved:false, target:null, preview:null};
  try { node.setPointerCapture(event.pointerId); } catch {}
}
function clearPreview() { C.drag?.preview?.remove(); document.querySelectorAll('.dc-drop-target').forEach(node => node.classList.remove('dc-drop-target')); }
function dragMove(event) {
  const drag=C.drag; if (!drag || event.pointerId!==drag.pointerId) return;
  if (!drag.moved && Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<6) return;
  const k=kit(), {h}=k;
  if (!drag.moved) { drag.moved=true; drag.node.classList.add('dc-dragging'); }
  clearPreview(); drag.target=null;
  const lane=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-dc-drop]'), track=lane?.querySelector('.dc-track');
  if (!lane || !track) return;
  const length=drag.item.end-drag.item.start;
  const start=Math.min(AXIS_END-SLOT,Math.max(AXIS_START,Math.round((minuteAt(track,event.clientX)-drag.offset)/SLOT)*SLOT));
  drag.target={laneId:lane.dataset.dcLane, start};
  lane.classList.add('dc-drop-target');
  drag.preview=h('div',{class:'dc-preview','aria-hidden':'true'},clock(hhmm(start)));
  place(drag.preview,start,start+length); track.append(drag.preview);
}
function cancelDrag() { clearPreview(); C.drag?.node.classList.remove('dc-dragging'); C.drag=null; }
// A redraw (the background refresh, a save elsewhere) replaces the dragged node, so the drag ends with it.
function redrawn() { if (!C.drag) return; if (C.drag.moved) C.message='The schedule refreshed during the drag, so nothing was moved. Drag the job again.'; cancelDrag(); }
// A removed node's lost capture is fired at the document, so this listens above it.
window.addEventListener('lostpointercapture',event => { if (C.drag && event.pointerId===C.drag.pointerId) cancelDrag(); },true);
function dragEnd(event) {
  const drag=C.drag; if (!drag || event.pointerId!==drag.pointerId) return;
  if (event.currentTarget!==drag.node || !drag.node.isConnected) { cancelDrag(); return; }
  const target=drag.target, moved=drag.moved;
  cancelDrag();
  if (!moved) return;
  C.suppressClick=true; setTimeout(() => { C.suppressClick=false; }, 0);
  if (!target) { say('Drop the job on an employee or crew row.'); return; }
  const lane=lastModel?.lanes.find(entry => entry.id===target.laneId);
  if (lane) confirmMove(drag.item,lane,target.start);
}
function facts(k, rows) { return k.h('dl',{class:'dp-recovery-facts dp-wide'},rows.filter(Boolean).map(([label,value]) => k.h('div',{},k.h('dt',{},label),k.h('dd',{},value)))); }
function hintList(k, list, empty='No conflicts in the loaded schedule.') {
  return list.length ? k.h('ul',{class:'dc-hints'},list.map(hint => k.h('li',{class:'dc-hint-'+hint.kind},hint.message))) : k.h('p',{class:'dc-hint-free'},empty);
}
function when(k, row) { return (row.date===row.endDate||!row.endDate?k.dateText(row.date,true):k.dateText(row.date,true)+' → '+k.dateText(row.endDate,true))+' · '+clock(row.time)+' – '+clock(row.endTime); }
function confirmMove(item, lane, start) {
  const k=kit(), S=k.state(), job=item.job, blocked=refusal(S.data,job);
  if (blocked) { say(blocked); return; }
  const result=moveChanges(S.data,item,lane,{date:S.date,start});
  if (result.error) { say(result.error); return; }
  const model=k.modal('Confirm schedule change','Review this move before saving. The server rechecks conflicts, availability and travel time.'); if (!model) return;
  model.form.insertBefore(model.status,model.fields);
  const members=result.crew?.assignedCrew||item.row.assignedCrew, source=lastModel?.lanes.find(entry => entry.id===item.lane);
  model.fields.append(...[facts(k,[['Job',jobLabel(job)+(item.row.segmentId?' · crew segment':'')],['From',(source?.label||'Unassigned')+' · '+when(k,item.row)],['To',lane.label+' · '+when(k,{...item.row,...result.next})],
    result.crew?['Crew',members.map(id => nameOf(S.data,id)).join(', ')+(result.crew.crewLead?' · lead '+nameOf(S.data,result.crew.crewLead):'')]:null]),
    k.h('div',{class:'dp-wide'},k.h('h3',{class:'dc-subhead'},'Loaded-schedule check'),hintList(k,hints(S.data,{...item.row,...result.next,job},members))),
    result.arrivalCleared?k.notice('The customer arrival window is cleared because moving it with the new start would cross midnight. Set a new window in Edit / assign.','error'):null].filter(Boolean));
  // A move of the visit's start is a reschedule: dispatch asks why and who asked (FUN-02).
  const moveBox=k.h('fieldset',{class:'dp-wide'},k.h('legend',{},'Why is this visit moving?')), reason=startChanged(item,result)&&k.reasonControls ? k.reasonControls(moveBox,'reschedule',{who:true}) : null;
  if (reason) model.fields.append(moveBox);
  model.footer.append(k.btn('Back',model.close),k.h('button',{type:'submit',class:'dp-btn primary'},'Save move'));
  model.form.addEventListener('submit',event => { event.preventDefault(); void k.save(model,{action:'schedule.update',requestId:k.key(),jobId:job.id,expectedRevision:job.revision,changes:result.changes,...(reason?reason():{})},'Schedule updated.'); });
}
// Phone and keyboard: a sheet of employees and crews; one tap sends the assignment.
function openSheet(item) {
  const k=kit(), S=k.state(), {h}=k, job=item.job, row=item.row, blocked=refusal(S.data,job);
  const model=k.modal((job.type==='blocked'?job.title||'Company time block':jobLabel(job)),blocked?'This work cannot be reassigned here.':'Tap an employee or crew to assign. Hints use the loaded schedule; the server rechecks every conflict when you save.'); if (!model) return;
  model.dialog.classList.add('dc-sheet'); model.form.insertBefore(model.status,model.fields);
  const from=item.lane?.startsWith('employee:') ? item.lane.slice(9) : '';
  model.fields.append(facts(k,[['When',when(k,row)+(row.segmentId?' · crew segment':'')],['Now',row.assignedCrew.length?row.assignedCrew.map(id => nameOf(S.data,id)).join(', ')+(row.crewLead?' · lead '+nameOf(S.data,row.crewLead):''):'Unassigned']]));
  // WT-OUTCOME: the walkthrough's outcome badge (a sold one links to its job) and Rebook, as on the day and week cards.
  const outcome=k.outcomeBadge?.(job); if (outcome) model.fields.append(h('div',{class:'dp-wide'},outcome));
  const send=(target,label) => { const result=moveChanges(S.data,item,target); if (result.error) { model.status.replaceChildren(k.notice(result.error,'error')); return; } void k.save(model,{action:'schedule.update',requestId:k.key(),jobId:job.id,expectedRevision:job.revision,changes:result.changes},'Assigned to '+label+'.'); };
  if (blocked) model.fields.append(k.notice(blocked,'error'));
  else {
    const people=h('div',{class:'dc-options dp-wide',role:'group','aria-label':'Employees'},h('h3',{class:'dc-subhead'},from?'Replace '+nameOf(S.data,from)+' with':row.assignedCrew.length?'Assign one employee instead':'Assign to'));
    for (const person of (S.data.roster||[]).filter(person => person.fieldWork!==false || row.assignedCrew.includes(person.id))) {
      const assigned=row.assignedCrew.includes(person.id), list=assigned?[]:hints(S.data,row,[person.id]);
      people.append(h('button',{type:'button', class:'dc-option'+(list.length?' dc-option-warn':''), disabled:assigned, onclick:()=>send({id:'employee:'+person.id,kind:'employee',employeeId:person.id},person.name)},
        h('strong',{},person.name),h('small',{},assigned?'Already on this job':list.length?list.map(hint => hint.message).join(' · '):'Free on the loaded schedule')));
    }
    const crews=(S.data.crews||[]).filter(crew => crew.status==='active'), teams=h('div',{class:'dc-options dp-wide',role:'group','aria-label':'Saved crews'},h('h3',{class:'dc-subhead'},'Assign a saved crew'));
    for (const crew of crews) {
      const current=row.crewId===crew.id && sameSet(row.assignedCrew,crew.memberIds||[]), list=current?[]:hints(S.data,row,crew.memberIds||[]);
      teams.append(h('button',{type:'button', class:'dc-option'+(list.length?' dc-option-warn':''), disabled:current, onclick:()=>send({id:'crew:'+crew.id,kind:'crew',crew},crew.name)},
        h('strong',{},crew.name),h('small',{},(crew.memberIds||[]).map(id => nameOf(S.data,id)).join(', ')+' · '+(current?'Already assigned':list.length?list.map(hint => hint.message).join(' · '):'Free on the loaded schedule'))));
    }
    model.fields.append(...[people,crews.length?teams:null].filter(Boolean));
  }
  const edit=inactive(job)?null:k.btn('Edit / assign',()=>{ if (S.pending || model.request) return; model.close(); k.openJob(job); });
  const rebook=k.rebookAction?.(job), again=rebook?k.btn('Rebook',()=>{ if (S.pending || model.request) return; model.close(); rebook.open(); },'primary',{'aria-label':rebook.label}):null;
  const open=h('a',{class:'dp-btn',href:job.type==='walkthrough'?'/crew/gameplan.html?walkthroughId='+encodeURIComponent(job.id):'/crew/job.html?jobId='+encodeURIComponent(job.id)},job.type==='walkthrough'?'Open walkthrough':'Open job');
  model.footer.append(...[k.btn('Back',model.close),open,edit,again].filter(Boolean));
}

// The last lane model holds customer schedule data; drop it with the rest of the Hub state.
window.addEventListener('egc:signout',() => { cancelDrag(); lastModel=null; C.mode='employee'; C.message=''; C.statusNode=null; });
window.EGCDispatchCalendar=Object.freeze({AXIS_START, AXIS_END, SLOT, monthGrid, addMonths, dayWindow, rowsOf, laneModel, untimed, hints, crewChange, moveChanges, startChanged});
const dispatch=window.EGCDispatch;
if (dispatch?.registerView) {
  dispatch.registerView('month',{label:'Month', pendingSubject:'this month', range:date => { const grid=monthGrid(date); return {startDate:grid.startDate, endDate:grid.endDate}; }, step:addMonths, render:renderMonth, help:'Tap a day to open it.'});
  dispatch.registerView('lanes',{label:'Lanes', pendingSubject:'this date', range:date => ({startDate:date, endDate:addDays(date,1)}), step:addDays, render:renderLanes, help:'Drag a job to another row or time to review the change, or tap it to assign.'});
}
})();
