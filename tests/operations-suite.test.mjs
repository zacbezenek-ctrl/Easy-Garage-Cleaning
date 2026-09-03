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

test('employee hub loads the operations suite after the CRM layer',()=>{
  assert.match(employee,/employee-crm\.js[\s\S]*employee-suite\.js/);
  assert.match(employee,/employee-suite\.css/);
});

test('operations suite follows the EGC operating model instead of duplicating the CRM',()=>{
  for(const area of ['today','pipeline','walkthroughs','delivery','scorecard','proof','playbook','settings']){
    assert.match(suite,new RegExp("'"+area+"'"),area+' is missing');
  }
  for(const marker of ['HighLevel is CRM','Walkthrough-first','Contribution / lead','The EGC playbook'])assert.match(suite,new RegExp(marker));
  for(const duplicate of ['collection:\'invoices\'','collection:\'payments\'','crew_members','time_entries'])assert.doesNotMatch(suite,new RegExp(duplicate));
});

test('HighLevel bridge keeps credentials server-side and supports field continuity',()=>{
  for(const marker of ['HIGHLEVEL_API_KEY','HIGHLEVEL_LOCATION_ID','/opportunities/search','/calendars/events','/contacts/upsert','Garage Comeback Plan','6-month garage check-in'])assert.match(highlevel,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
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

test('walkthrough enforces discovery, exclusions, logistics, proof, and close',()=>{
  for(const marker of ['Why Now & The Win','decisionMaker','idealOutcome','exclusions','truckPlacement','PHOTO_COUNTS.before','garage width and depth','homeowner signature'])assert.match(crew,new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(crew,/discovery:\{/);
  assert.match(crew,/function validateStep/);
});

test('all employee and field-tool inline scripts parse',()=>{
  for(const [name,html] of [['employee.html',employee],['crew/gameplan.html',crew],['crew/prejob.html',read('crew/prejob.html')],['crew/postjob.html',read('crew/postjob.html')]]){
    const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x=>x[1]).filter(Boolean);
    scripts.forEach((code,i)=>assert.doesNotThrow(()=>new vm.Script(code,{filename:name+'#'+i})));
  }
  assert.doesNotThrow(()=>new vm.Script(suite,{filename:'employee-suite.js'}));
});
