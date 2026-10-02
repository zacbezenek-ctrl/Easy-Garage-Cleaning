import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createDocument} from './helpers/hub-dom.mjs';
const source=readFileSync(new URL('../employee-operations.js',import.meta.url),'utf8');
const lines=['+15555551644','+15555551818'];
const task={id:'00000000-0000-4000-8000-000000000001',kind:'followup_message',title:'Synthetic sender review',description:'',assignedUserId:'synthetic-owner',status:'open',approvalStatus:'approved',revision:1,priority:'medium',waitingOn:'none',dueAt:'2026-10-01T16:00:00Z',completionCondition:'Verify delivery',draftPayload:{channel:'sms',fromNumber:lines[0],recipient:'+15555550100',body:'Synthetic reviewed SMS',subject:'',sendWindowStart:'2026-10-01T14:00:00Z',sendWindowEnd:'2026-10-02T02:00:00Z',attachments:[]}};
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
async function harness(status=async()=>({ok:true,smsFromNumbers:lines})){
 const document=createDocument(),proto=Object.getPrototypeOf(document.createElement('div'));
 proto.showModal=function(){this.open=true;};proto.close=function(){this.open=false;queueMicrotask(()=>this.dispatchEvent({type:'close'}));};proto.prepend=function(...nodes){for(const node of nodes.reverse())this.insertBefore(typeof node==='string'?document.createTextNode(node):node,this.childNodes[0]||null);};
 const host=document.createElement('main');document.body.append(host);const writes=[];
 const storage={getItem:()=>null,setItem(){},removeItem(){},length:0};
 class FormData{constructor(form){this.entries=form.querySelectorAll('input,select,textarea').filter(n=>!n.disabled).map(n=>[n.name,n.value||n.querySelector('option[selected]')?.value||'']);}*[Symbol.iterator](){yield* this.entries;}}
 const context={document,Node:document.Node,URL,Intl,console,AbortController,crypto,setTimeout,clearTimeout,sessionStorage:storage,FormData,addEventListener(){},confirm:()=>true,fetch:async(url,init={})=>{
  if(!init.method)return Response.json({ok:true,enabled:true,actor:{id:'synthetic-owner',role:'owner'},owners:[{id:'synthetic-owner',name:'Synthetic Owner'}]});
  const command=JSON.parse(init.body).body;
  if(command.command==='status')return Response.json(await status());
  if(command.command==='task.get')return Response.json({ok:true,task,previewHash:'a'.repeat(64),effectiveApproval:'approved',history:[],actionSend:{available:true,smsFromNumbers:lines}});
  if(command.command==='queue')return Response.json({ok:true,items:[task],total:1,nextOffset:null,asOf:'2026-10-01T15:00:00Z'});
  writes.push(command);return Response.json({ok:true,task:{...task,revision:2}});
 }};context.window=context;vm.runInNewContext(source,context,{filename:'employee-operations.js'});await context.EGCActionCenter.mount(host);await flush();
 const click=(text,root=document.body)=>{const b=root.querySelectorAll('button').find(n=>n.textContent===text);assert.ok(b,text);b.click();};
 return{document,host,writes,click,center:context.EGCActionCenter};
}
test('sender choices load without selecting a default and a dismissed lookup cannot update a replacement editor',async()=>{
 const pending=[];const h=await harness(()=>new Promise(resolve=>pending.push(resolve)));
 h.click('New action');const first=h.document.body.querySelector('[name="fromNumber"]');assert.equal(first.disabled,true);h.click('Close');h.click('New action');const second=h.document.body.querySelector('[name="fromNumber"]');assert.notEqual(first,second);
 pending[0]({ok:true,smsFromNumbers:['+15555559999']});await flush();assert.equal(second.querySelectorAll('option').length,1);
 pending[1]({ok:true,smsFromNumbers:lines});await flush();assert.equal(second.value,'');assert.deepEqual(second.querySelectorAll('option').map(n=>n.value),['',...lines]);
 h.center.unmount();
});
test('detail and approval display the sender, and an explicit sender edit saves the new draft revision request',async()=>{
 const h=await harness();h.host.querySelector('.ac-row').click();await flush();assert.match(h.document.body.querySelector('dialog').textContent,/From: \+15555551644/);
 h.click('Review approval');assert.match(h.document.body.querySelector('dialog').textContent,/I reviewed the exact sender, recipient/);assert.match(h.document.body.querySelector('dialog').textContent,/From: \+15555551644/);h.click('Close');
 h.host.querySelector('.ac-row').click();await flush();h.click('Edit');await flush();const sender=h.document.body.querySelector('[name="fromNumber"]');assert.equal(sender.value,lines[0]);sender.value=lines[1];
 const form=h.document.body.querySelector('form');for(const select of form.querySelectorAll('select'))if(select!==sender)select.value=select.querySelector('option[selected]')?.value||select.querySelector('option')?.value||'';
 form.querySelector('[name="channel"]').dispatchEvent({type:'change'});form.dispatchEvent({type:'submit',preventDefault(){}});await flush();assert.equal(h.writes.length,1);assert.equal(h.writes[0].command,'task.edit');assert.equal(h.writes[0].revision,1);assert.equal(h.writes[0].changes.draft.fromNumber,lines[1]);assert.equal(task.draftPayload.fromNumber,lines[0]);h.center.unmount();
});

test('saving an unrelated edit preserves the exact sender when its lookup is pending or failed',async()=>{
 for(const status of [()=>new Promise(()=>{}),async()=>{throw new Error('synthetic unavailable');}]){
  const h=await harness(status);h.host.querySelector('.ac-row').click();await flush();h.click('Edit');await flush();const form=h.document.body.querySelector('form'),sender=form.querySelector('[name="fromNumber"]');assert.equal(sender.disabled,true);
  for(const select of form.querySelectorAll('select'))if(select!==sender)select.value=select.querySelector('option[selected]')?.value||select.querySelector('option')?.value||'';
  form.querySelector('[name="title"]').value='Changed internal action title';form.dispatchEvent({type:'submit',preventDefault(){}});await flush();
  assert.equal(h.writes.length,1);assert.equal(h.writes[0].changes.draft.fromNumber,lines[0]);assert.equal(h.writes[0].changes.title,'Changed internal action title');h.center.unmount();
 }
});
