/* SALES-BOOKING (BOOK-25): the /book walkthrough windows from the Denver clock, never the
   device clock's time zone. Past windows and closed days (business hours and holidays of the
   FUN-01 business calendar) are left out, and each choice carries an explicit
   'YYYY-MM-DD AM|PM' value, rendered again when the page is shown after a while (visibilitychange, or pageshow
   from the back-forward cache). This mirrors bookingSlots() in functions/_lib/booking-slots.js;
   tests/booking-slots.test.mjs keeps the two, and CALENDAR, in step with the business calendar.
   It renders only a fieldset the server marked data-explicit-slots: the root middleware marks /book's while
   EGC_BOOKING_EXPLICIT_SLOTS is exactly "true" (functions/_lib/booking-slots-flag.js). Unmarked, or on any error,
   the page keeps its static choices and posts them exactly as before; without JavaScript it keeps them too, and
   /api/web-lead (flag on) resolves them to dates. */
(function(root){
'use strict';
const TZ='America/Denver',DAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const CALENDAR=Object.freeze({
  businessHours:{monday:[['07:00','19:00']],tuesday:[['07:00','19:00']],wednesday:[['07:00','19:00']],thursday:[['07:00','19:00']],friday:[['07:00','19:00']],saturday:[['07:00','19:00']],sunday:[]},
  holidays:[{id:'new_years_day',month:1,day:1},{id:'martin_luther_king_jr_day',month:1,weekday:'monday',nth:3},{id:'washingtons_birthday',month:2,weekday:'monday',nth:3},{id:'memorial_day',month:5,weekday:'monday',nth:-1},{id:'juneteenth',month:6,day:19},{id:'independence_day',month:7,day:4},{id:'labor_day',month:9,weekday:'monday',nth:1},{id:'columbus_day',month:10,weekday:'monday',nth:2},{id:'veterans_day',month:11,day:11},{id:'thanksgiving_day',month:11,weekday:'thursday',nth:4},{id:'christmas_day',month:12,day:25}],
});
const WINDOWS=Object.freeze({AM:Object.freeze({start:'08:00',end:'12:00',label:'morning'}),PM:Object.freeze({start:'12:00',end:'17:00',label:'afternoon'})});
const COUNT=4,SCAN_DAYS=21;
const pad=n=>String(n).padStart(2,'0');
const minutes=text=>Number(text.slice(0,2))*60+Number(text.slice(3,5));
const addDays=(date,count)=>new Date(Date.parse(date+'T12:00:00Z')+count*86400000).toISOString().slice(0,10);
const weekday=date=>new Date(date+'T12:00:00Z').getUTCDay();
function denver(now){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(part=>[part.type,part.value]));
  return {date:parts.year+'-'+parts.month+'-'+parts.day,minute:Number(parts.hour)*60+Number(parts.minute)};
}
function holiday(date){
  const year=Number(date.slice(0,4)),month=Number(date.slice(5,7));
  return CALENDAR.holidays.some(rule=>{
    if(rule.month!==month)return false;
    if(rule.day!==undefined)return date===year+'-'+pad(rule.month)+'-'+pad(rule.day);
    const target=DAYS.indexOf(rule.weekday);
    if(rule.nth>0){const first=year+'-'+pad(month)+'-01';return date===addDays(first,(target-weekday(first)+7)%7+(rule.nth-1)*7);}
    const last=new Date(Date.UTC(year,month,0,12)).toISOString().slice(0,10);return date===addDays(last,-((weekday(last)-target+7)%7));
  });
}
function open(date,window){const spec=WINDOWS[window];return !holiday(date)&&(CALENDAR.businessHours[DAYS[weekday(date)]]||[]).some(([start,end])=>minutes(start)<=minutes(spec.start)&&minutes(spec.end)<=minutes(end));}
function label(date,window,today){
  const day=date===today?'Today':date===addDays(today,1)?'Tomorrow':new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',month:'short',day:'numeric'}).format(new Date(date+'T12:00:00Z'));
  return day+' '+WINDOWS[window].label;
}
// The next open windows after `now` (epoch ms): [{value:'YYYY-MM-DD AM|PM', date, window, label}].
function slots(now,count=COUNT){
  if(!Number.isFinite(Number(now)))return [];
  const {date:today,minute}=denver(Number(now)),out=[];
  for(let offset=0;offset<SCAN_DAYS&&out.length<count;offset++){
    const date=addDays(today,offset);
    for(const window of Object.keys(WINDOWS)){
      if(out.length>=count)break;
      if(offset===0&&minute>=minutes(WINDOWS[window].start))continue;
      if(open(date,window))out.push({value:date+' '+window,date,window,label:label(date,window,today)});
    }
  }
  return out;
}
const choicesAt=now=>[...slots(now).map(slot=>[slot.value,slot.label]),['Flexible','Flexible']];
const radios=fieldset=>[...fieldset.querySelectorAll('input')].filter(input=>input.name==='booking_slot_choice');
const MARKER='data-explicit-slots';
// The fieldsets the server told this script to render (EGC_BOOKING_EXPLICIT_SLOTS on); any other is never touched.
const marked=()=>[...root.document.querySelectorAll('fieldset.booking-slots')].filter(fieldset=>fieldset.hasAttribute(MARKER));
// Replaces a fieldset's time choices with the current windows plus Flexible, built with textContent. The visitor's
// choice stays chosen while it is still offered. The new choices are built before the old ones go, so a failure
// leaves the choices that were there.
function render(fieldset,now){
  if(!fieldset||typeof fieldset.querySelectorAll!=='function')return [];
  const doc=fieldset.ownerDocument||root.document,choices=choicesAt(now),chosen=radios(fieldset).find(input=>input.checked)?.value;
  const built=choices.map(([value,text])=>{
    const wrap=doc.createElement('label'),input=doc.createElement('input');
    wrap.className='booking-slot';input.type='radio';input.name='booking_slot_choice';input.value=value;input.checked=value===chosen;
    wrap.append(input,doc.createTextNode(' '+text));return wrap;
  });
  for(const old of fieldset.querySelectorAll('.booking-slot'))old.remove();
  for(const wrap of built)fieldset.append(wrap);
  fieldset.setAttribute('data-slots-rendered','');
  return choices.map(([value])=>value);
}
// A tab left open overnight, or a page restored from the back-forward cache, would still offer windows that have
// started and call yesterday's tomorrow "Tomorrow": when the page is shown again, render the choices that changed.
function refresh(now){
  if(!root.document)return;
  const next=JSON.stringify(choicesAt(now));
  for(const fieldset of marked()){
    const shown=[...fieldset.querySelectorAll('.booking-slot')].map(label=>[radios(label)[0]?.value,label.textContent.trim()]);
    if(JSON.stringify(shown)!==next)render(fieldset,now);
  }
}
root.EGCBookingSlots=Object.freeze({slots,render,refresh,CALENDAR,WINDOWS});
if(root.document){
  // Fails closed: an error leaves the choices the page already shows.
  const safely=task=>()=>{try{task();}catch{}};
  const run=safely(()=>{for(const fieldset of marked())render(fieldset,Date.now());});
  if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',run,{once:true});else run();
  if(typeof root.addEventListener==='function')root.addEventListener('pageshow',event=>{if(event.persisted)safely(()=>refresh(Date.now()))();});
  root.document.addEventListener('visibilitychange',()=>{if(root.document.visibilityState==='visible')safely(()=>refresh(Date.now()))();});
}
})(typeof window!=='undefined'?window:globalThis);
