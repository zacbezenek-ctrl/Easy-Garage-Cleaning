// Every page the public site serves, for the device e2e: each *.html outside the
// directories the site generator never treats as pages (PRIVATE_DIRS in
// _generate_site.py, plus any dot-directory), minus the staff pages that
// staff-paths.js gates or lists as staff sign-in and crew-app files, and minus
// legacy files that _redirects answers with a 3xx, so the file is never served.
import {readFileSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceFiles} from '../../source-files.mjs';
import {STAFF_PUBLIC_PATHS,staffGatedPath} from '../../../staff-paths.js';

const ROOT=fileURLToPath(new URL('../../../',import.meta.url));

// PRIVATE_DIRS read from the generator itself, so the two lists never drift apart.
export function siteExcludedDirs(root=ROOT){
 const block=readFileSync(join(root,'_generate_site.py'),'utf8').match(/^PRIVATE_DIRS = frozenset\(\{([\s\S]*?)\}\)/m);
 if(!block)throw new Error('_generate_site.py has no PRIVATE_DIRS = frozenset({...}) block');
 return new Set([...block[1].matchAll(/"([^"]+)"/g)].map(match=>match[1].toLowerCase()));
}

// Source paths that _redirects sends elsewhere with a 3xx status (a 200 is a rewrite that still serves).
export function redirectedPaths(root=ROOT){
 let text='';try{text=readFileSync(join(root,'_redirects'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 return new Set(text.split('\n').map(line=>line.replace(/#.*/,'').trim().split(/\s+/)).filter(([from,,status])=>from?.startsWith('/')&&/^3\d\d$/.test(status||'301')).map(([from])=>from));
}

export function staffPage(path){
 return staffGatedPath(path)||STAFF_PUBLIC_PATHS.includes(path)||STAFF_PUBLIC_PATHS.includes(path.replace(/\.html$/,''));
}

// Root-relative paths ('/faq.html', '/blog/index.html'), sorted.
export function publicPages(root=ROOT){
 const excluded=siteExcludedDirs(root),redirected=redirectedPaths(root);
 return sourceFiles(root)
  .map(entry=>relative(root,join(entry.parentPath,entry.name)).split(sep))
  .filter(parts=>parts.at(-1).endsWith('.html')&&!parts.slice(0,-1).some(part=>part.startsWith('.')||excluded.has(part.toLowerCase())))
  .map(parts=>'/'+parts.join('/'))
  .filter(path=>!staffPage(path)&&!redirected.has(path)&&!redirected.has(path.replace(/\.html$/,'')))
  .sort();
}
