import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sourceFiles} from './source-files.mjs';

const listed=root=>sourceFiles(root).map(entry=>relative(root,join(entry.parentPath,entry.name)).split(sep).join('/')).sort();

test('sourceFiles skips agent worktrees, dependencies, build output and local QA captures',t=>{
 const root=mkdtempSync(join(tmpdir(),'egc-source-files-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(path,body='synthetic')=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),body);};
 for(const path of ['index.html','functions/api/field-jobs.js','crew/job.js','tests/example.test.mjs','egc-platform/apps/portal/page.tsx'])put(path);
 for(const path of ['.claude/worktrees/agent-1/index.html','.claude/settings.json','worktrees/agent-2/functions/api/field-jobs.js','egc-platform/worktrees/copy.js',
  'field-qa/today-mobile.png','.lighthouseci/lhr-1.json','test-results/field-qa/completed-mobile.png','node_modules/pkg/index.js','.pnpm-store/v3/index.json',
  '.git/HEAD','egc-platform/apps/portal/.next/server/page.js','egc-platform/.turbo/cache.json','.wrangler/state.json','egc-platform/packages/database/dist/index.js'])put(path);
 // 'junction' needs no privileges on Windows and is ignored elsewhere.
 symlinkSync(join(root,'crew'),join(root,'linked-crew'),'junction');
 assert.deepEqual(listed(root),['crew/job.js','egc-platform/apps/portal/page.tsx','functions/api/field-jobs.js','index.html','tests/example.test.mjs']);
 assert.deepEqual(sourceFiles(pathToFileURL(root+sep)).map(entry=>entry.name).sort(),['example.test.mjs','field-jobs.js','index.html','job.js','page.tsx'],'a URL root is walked the same way');
});

test('scans of this checkout never include another agent worktree or QA output',()=>{
 const root=fileURLToPath(new URL('..',import.meta.url)),files=listed(root);
 assert.ok(files.includes('tests/source-files.mjs')&&files.includes('functions/api/field-jobs.js'),'the walk still reaches real sources');
 const leaked=files.filter(path=>/(^|\/)(\.claude|worktrees|field-qa|\.lighthouseci|test-results|node_modules)(\/|$)/.test(path));
 assert.deepEqual(leaked,[]);
});
