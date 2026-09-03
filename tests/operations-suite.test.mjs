import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read=(p)=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const employee=read('employee.html');
const suite=read('employee-suite.js');
const crew=read('crew/gameplan.html');
const relay=read('functions/api/operations-event.js');

test('employee hub loads the operations suite after the CRM layer',()=>{
  assert.match(employee,/employee-crm\.js[\s\S]*employee-suite\.js/);
  assert.match(employee,/employee-suite\.css/);
});

test('operations suite contains the core Jobber-style work areas',()=>{
  for(const area of ['quotes','invoices','payments','expenses','time','tasks','team','reports','services']){
    assert.match(suite,new RegExp("'"+area+"'"),area+' is missing');
  }
  for(const collection of ['invoices','payments','expenses','time_entries','tasks','crew_members','services']){
    assert.match(suite,new RegExp(collection),collection+' persistence is missing');
  }
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

test('all inline scripts parse',()=>{
  for(const [name,html] of [['employee.html',employee],['crew/gameplan.html',crew]]){
    const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x=>x[1]).filter(Boolean);
    scripts.forEach((code,i)=>assert.doesNotThrow(()=>new vm.Script(code,{filename:name+'#'+i})));
  }
  assert.doesNotThrow(()=>new vm.Script(suite,{filename:'employee-suite.js'}));
});
