import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../analytics-loader.js',import.meta.url),'utf8');
function run(hostname){
 const events=[],scripts=[];
 const window={location:{hostname},addEventListener:(...args)=>events.push(args),removeEventListener(){}};
 const document={currentScript:{getAttribute:()=>null},createElement:()=>({}),head:{appendChild:script=>scripts.push(script)}};
 vm.runInNewContext(source,{window,document});return {window,events,scripts};
}
test('marketing analytics never initializes on previews, localhost or lookalike hosts',()=>{
 for(const hostname of ['localhost','127.0.0.1','branch.easy-garage-cleaning.pages.dev','branch.vercel.app','easygaragecleaning.com.example.org','']){
  const result=run(hostname);assert.equal(result.window.fbq,undefined,hostname);assert.equal(result.window.gtag,undefined,hostname);assert.equal(result.events.length,0);assert.equal(result.scripts.length,0);
 }
});
test('canonical production hosts retain queued page tracking and deferred script loading',()=>{
 for(const hostname of ['easygaragecleaning.com','www.easygaragecleaning.com']){
  const result=run(hostname);assert.equal(typeof result.window.fbq,'function');assert.equal(typeof result.window.gtag,'function');assert.equal(result.scripts.length,0);assert.ok(result.events.length>0);assert.equal(result.window.fbq.queue[1][1],'PageView');
 }
});
