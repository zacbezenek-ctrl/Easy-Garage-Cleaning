import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('revocation clears both private image URLs synchronously even when dialog close events are delayed',()=>{
 const html=readFileSync(new URL('../customer-portal.html',import.meta.url),'utf8');
 const source=html.match(/function showError\(message\)\{[^\n]+/)[0];
 const nodes=new Map();
 for(const id of ['loading','portal','render-notice','error','error-message','gallery-viewer','storage-viewer','gallery-image','storage-image'])nodes.set(id,{classList:{add(){},remove(){}},open:id.endsWith('-viewer'),src:id.endsWith('-image')?'/api/customer-portal-photo?photoId=synthetic':undefined,removeAttribute(name){delete this[name]},close(){this.open=false}});
 vm.runInNewContext(source+';showError("Access revoked")',{$:id=>nodes.get(id)});
 for(const kind of ['gallery','storage']){assert.equal(nodes.get(kind+'-viewer').open,false);assert.equal(nodes.get(kind+'-image').src,undefined);}
});
