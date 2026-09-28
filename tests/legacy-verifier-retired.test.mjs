import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceFiles} from './source-files.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const self=fileURLToPath(import.meta.url);
const code=sourceFiles(root).filter(f=>/\.(m?js|cjs|tsx?|html|py|sh|json|ya?ml)$/.test(f.name)&&!/lock\.(json|yaml)$/.test(f.name)).map(f=>join(f.parentPath,f.name)).filter(path=>path!==self);
const read=path=>readFileSync(path,'utf8');

test('the stale crew verifier is retired and nothing still runs or ignores its output',()=>{
 assert.equal(existsSync(join(root,'scripts/verify-crew.mjs')),false);
 assert.ok(code.length>50,'the scan must cover the repository sources');
 for(const script of Object.values(JSON.parse(read(join(root,'package.json'))).scripts||{}))assert.doesNotMatch(script,/verify-crew/);
 for(const file of [...code,join(root,'.gitignore')])assert.doesNotMatch(read(file),/verify-crew|verify-shots/,file);
});

test('no committed code mints a Hub session from a hard-coded staff credential hash',()=>{
 // Hub sessions are only issued server-side (HUB_SESSION_SECRET-signed cookies); the retired client scheme was sha256(`user:hash:egc-session`).
 for(const file of code){
  const source=read(file);
  assert.doesNotMatch(source,/:egc-session\b/,file);
  assert.doesNotMatch(source,/\b[A-Z][A-Z0-9_]*_HASH\s*=\s*['"`][0-9a-f]{64}['"`]/,file);
 }
});
