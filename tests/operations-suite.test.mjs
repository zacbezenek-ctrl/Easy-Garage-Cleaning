import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=(p)=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const employee=read('employee.html');
const suite=read('employee-suite.js');
const crew=read('crew/gameplan.html');
const relay=read('functions/api/operations-event.js');
const highlevel=read('functions/api/highlevel.js');
const statusApi=read('functions/api/integration-status.js');
const commercial=read('commercial-junk-removal-fort-collins-co.html');

test('employee hub loads the EGC operations suite without the duplicate CRM overlay',()=>{
  assert.doesNotMatch(employee,/employee-crm\.(?:js|css)/);
  assert.match(employee,/employee-suite\.js/);
  assert.match(employee,/employee-suite\.css/);
});

test('operations suite follows the EGC operating model instead of duplicating the CRM',()=>{
  for(const area of ['today','schedule','pipeline','walkthroughs','delivery','scorecard','proof','playbook','settings']){
    assert.match(suite,new RegExp("'"+area+"'"),area+' is missing');
  }
  for(const marker of ['HighLevel is CRM','Walkthrough-first','Contribution / lead','The EGC playbook'])assert.match(suite,new RegExp(marker));
  for(const duplicate of ['collection:\'invoices\'','collection:\'payments\'','crew_members','time_entries'])assert.doesNotMatch(suite,new RegExp(duplicate));
  assert.doesNotMatch(statusApi,/jobber:/);
});

test('HighLevel bridge keeps credentials server-side and supports field continuity',()=>{
  for(const marker of ['HIGHLEVEL_API_KEY','HIGHLEVEL_LOCATION_ID','HIGHLEVEL_JOB_CALENDAR_ID','/opportunities/search','/calendars/events','/calendars/events/appointments','/contacts/upsert','egc-job-scheduled','egc-review-ready','6-month garage check-in'])assert.match(highlevel,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.doesNotMatch(employee,/HIGHLEVEL_API_KEY\s*[:=]\s*['"][^'"]+/);
  assert.match(crew,/\/api\/highlevel/);
  assert.match(crew,/highlevel_contact_id/);
});

test('private webhook destinations are absent from browser and function source',()=>{
  assert.doesNotMatch(employee,/hooks\.zapier\.com\/hooks\/catch\/\d+\/[^.]+/);
  assert.doesNotMatch(suite,/hooks\.zapier\.com/);
  assert.doesNotMatch(read('employee-crm.js'),/hooks\.zapier\.com/);
  assert.doesNotMatch(read('functions/api/crew-hook.js'),/hooks\.zapier\.com\/hooks\/catch\/\d+/);
  for(const key of ['QUOTE_FOLLOWUP_WEBHOOK_URL','BOOKING_WEBHOOK_URL','REVIEW_WEBHOOK_URL','META_SIGNAL_WEBHOOK_URL'])assert.match(relay,new RegExp(key));
});

test('walkthrough is photo-led, builds price in the background, and saves Hub scheduling',()=>{
  for(const marker of ['Customer','Photos','Scope','Finish','Schedule','Review','whyNow','outcome','truckPlacement','PHOTO_COUNT','Homeowner signature','function recommend','saveHubJob','scheduleSource'])assert.match(crew,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.doesNotMatch(crew,/14-point|Damage Zone|Comeback Zone|layout sketch|AI after/i);
  assert.match(crew,/discovery:\{/);
  assert.match(crew,/function validateStep/);
});

test('Hub owns scheduling while HighLevel owns CRM automation',()=>{
  for(const marker of ['HUB SCHEDULE','Schedule the work here','scheduleSource','Save + sync','HighLevel = leads, contacts, conversations, pipeline, automations'])assert.match(suite,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(suite,/\.set\(job,\{merge:true\}\)/);
  assert.match(suite,/Choose an end time after the start time/);
  for(const field of ['phone','email','address','date','time','endTime','assignedTo','notes','notify'])assert.match(suite,new RegExp(`opsBookField\\('${field}'`));
});

test('walkthrough preserves job creation time and hands off the scheduled job appointment',()=>{
  assert.match(crew,/if\(!existing\.exists\)job\.createdAt=now/);
  assert.match(crew,/highlevelAppointmentId:S\.highlevelJobAppointmentId/);
});

test('public quote progress and production links stay configured',()=>{
  assert.match(commercial,/const shell=form\.closest\('\.quote-form'\)\|\|document/);
  assert.match(commercial,/const dots=shell\.querySelectorAll\('\.form-step-dot'\)/);
  assert.match(commercial,/const lbl=shell\.querySelector\('\.form-step-label'\)/);
  const publicSource=fs.readdirSync(new URL('..',import.meta.url),{recursive:true,withFileTypes:true})
    .filter(x=>x.isFile()&&/\.(?:html|py)$/.test(x.name))
    .map(x=>fs.readFileSync(`${x.parentPath}/${x.name}`,'utf8')).join('\n');
  assert.doesNotMatch(publicSource,/fcgov\.com\/chamber|"CLARITY_PROJECT_ID"|(?:facebook|instagram)\.com\/PLACEHOLDER|yelp\.com\/biz\/PLACEHOLDER/);
  assert.match(publicSource,/fortcollinschamber\.com/);
  assert.match(publicSource,/"wf7ba129jm"/);
});

test('all employee and field-tool inline scripts parse',()=>{
  for(const [name,html] of [['employee.html',employee],['crew/gameplan.html',crew],['crew/prejob.html',read('crew/prejob.html')],['crew/postjob.html',read('crew/postjob.html')]]){
    const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x=>x[1]).filter(Boolean);
    scripts.forEach((code,i)=>assert.doesNotThrow(()=>new vm.Script(code,{filename:name+'#'+i})));
  }
  assert.doesNotThrow(()=>new vm.Script(suite,{filename:'employee-suite.js'}));
});
