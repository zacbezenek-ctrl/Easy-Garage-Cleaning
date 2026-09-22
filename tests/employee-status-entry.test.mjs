import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const suite=readFileSync(new URL('../employee-suite.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../employee.html',import.meta.url),'utf8');
function fixture(source){
  const rows=[{id:'job.one',type:'job',status:'scheduled',phone:'9705550100'},{id:'walk.one',type:'walkthrough',status:'scheduled'}],visits=[],messages=[];
  const context={location:{href:''},jobs:()=>rows,loadJobs:()=>rows,go:name=>visits.push(name),opsGo:name=>visits.push(name),showToast:text=>messages.push(text),encodeURIComponent,
    db:{collection(){throw new Error('A status shortcut must not write Firestore.');}},hubFetch(){throw new Error('A status shortcut must not send provider events.');}};
  context.window=context;vm.runInNewContext(source,context);return{context,visits,messages};
}
const entryPoints=[['suite',suite.slice(suite.indexOf('window.opsAdvanceStatus='),suite.indexOf('\nfunction scheduledJobMinutes')),context=>context.opsAdvanceStatus],
  ['legacy page',html.slice(html.indexOf('function setStatus('),html.indexOf('\nfunction delJob(')),context=>context.setStatus]];
for(const [name,source,fn]of entryPoints){
  test(name+' operational shortcuts open the guarded job workflow without mutating status or sending reviews',async()=>{
    const f=fixture(source);for(const status of ['dispatched','arrived','in_progress','completed']){await fn(f.context)('job.one',status);assert.equal(f.context.location.href,'/crew/job.html?jobId=job.one');}
    await fn(f.context)('walk.one','completed');assert.equal(f.context.location.href,'/crew/gameplan.html?walkthroughId=walk.one');
    f.context.location.href='';await fn(f.context)('missing','completed');assert.equal(f.context.location.href,'');
  });
  test(name+' paid/invoice shortcuts require the separate verified financial workflow',async()=>{
    const f=fixture(source);for(const status of ['paid','invoiced','review_requested'])await fn(f.context)('job.one',status);
    assert.deepEqual(f.visits,['finance','finance','finance']);assert.equal(f.messages.length,3);assert.equal(f.context.location.href,'');
    await fn(f.context)('job.one','invented');assert.equal(f.visits.length,3);
  });
}
