import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
for(const path of ['crew/prejob.html','crew/postjob.html']){
  test(`${path} renders staff instructions and current notes without altering signed scope or interpreting HTML`,()=>{
    const source=readFileSync(path,'utf8'),host={innerHTML:''};
    const functions=['normalizedInstructions','renderJobBrief'].map(name=>source.split(/\r?\n/).find(line=>line.startsWith(`function ${name}(`))).join('\n');
    assert.ok(functions.includes('operationalScope'));
    const context={ACTIVE:{operationalScope:{text:'Protect the shelving <img src=x>'},operationNotes:[{id:'a',body:'Old instructions'},{id:'b',body:'Reviewed instructions',supersedes:'a',actorId:'actual-owner'}],scope:{keep_items:'Customer signed keep item'}},document:{getElementById:()=>host},esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),textList:v=>Array.isArray(v)?v.join(', '):String(v??'')};
    vm.createContext(context);vm.runInContext(functions+'\nrenderJobBrief();',context);
    assert.ok(host.innerHTML.includes('Staff operational instructions'));assert.ok(host.innerHTML.includes('Protect the shelving &lt;img src=x&gt;'));assert.ok(!host.innerHTML.includes('<img'));assert.ok(host.innerHTML.includes('Reviewed instructions'));assert.ok(!host.innerHTML.includes('Old instructions'));assert.ok(host.innerHTML.includes('Customer signed keep item'));
    context.ACTIVE={instructions:vm.runInContext('normalizedInstructions(ACTIVE)',context)};vm.runInContext('renderJobBrief()',context);assert.ok(host.innerHTML.includes('Reviewed instructions'),'server-loaded normalized instructions remain visible');
  });
}
