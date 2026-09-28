import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
// Installed workspace dependencies can contain cyclic directory junctions on
// Windows. Source assertions must neither traverse those nor inspect built HTML,
// agent worktrees or local QA output (field screenshots, Lighthouse runs).
export function sourceFiles(root){
 const ignored=new Set(['.git','.claude','worktrees','node_modules','.pnpm-store','.next','.turbo','.wrangler','test-results','dist','field-qa','.lighthouseci']);
 const entries=[];
 function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){
   if(entry.isSymbolicLink()||ignored.has(entry.name))continue;
   if(entry.isDirectory())walk(join(dir,entry.name));
   else if(entry.isFile())entries.push({name:entry.name,parentPath:dir,isFile:()=>true});
 }}
 walk(root instanceof URL?fileURLToPath(root):root);return entries;
}
