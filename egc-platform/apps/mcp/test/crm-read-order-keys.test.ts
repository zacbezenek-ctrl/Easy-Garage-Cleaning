import {readFileSync,readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe,expect,it} from 'vitest';

// leads.search, calls.search and walkthroughs.search walk keyset cursors with no change probe (crm-reads.ts keyMoves:"never") because no write path rewrites their
// order key after insert. That holds only while every writer leaves the key alone, so this pins it at the source: an update or upsert whose `set` names the key
// (or cannot be read as a literal), a raw SQL update of the key, or a BEFORE trigger on the table fails here. If one is intended, reclassify the tool first.
const ROOT=fileURLToPath(new URL('../../../',import.meta.url));
const FIXED:Record<string,{field:string;column:string}>={leads:{field:'createdAt',column:'created_at'},calls:{field:'startedAt',column:'started_at'},walkthroughs:{field:'createdAt',column:'created_at'}};
const SKIP_DIRS=new Set(['node_modules','dist','.next','.turbo','coverage','test','tests','__tests__']);
type Site={file:string;table:string;kind:'update'|'upsert'|'raw'|'trigger';problem?:string};

function sources(dir:string,out:string[]=[]):string[]{
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);
    if(entry.isDirectory()){if(!SKIP_DIRS.has(entry.name))sources(path,out);}
    else if(/\.(ts|tsx|js|mjs|sql)$/.test(entry.name)&&!/\.(test|spec|check)\.|\.d\.ts$/.test(entry.name))out.push(path);
  }
  return out;
}
/** The text inside the bracket at open, skipping quoted strings; undefined when it never closes. */
function inside(text:string,open:number):string|undefined{
  const pairs:Record<string,string>={'(':')','{':'}','[':']'},stack:string[]=[];
  for(let i=open;i<text.length;i++){
    const ch=text[i]!;
    if(ch==='"'||ch==="'"||ch==='`'){for(i++;i<text.length&&text[i]!==ch;i++)if(text[i]==='\\')i++;continue;}
    if(pairs[ch])stack.push(pairs[ch]!);
    else if(ch===stack[stack.length-1]){stack.pop();if(!stack.length)return text.slice(open+1,i);}
  }
  return undefined;
}
function tableOf(expr:string,text:string):string|undefined{
  const qualified=/^schema\.(\w+)$/.exec(expr);if(qualified)return qualified[1];
  if(!/^\w+$/.test(expr))return undefined;
  return new RegExp(`\\b${expr}\\s*=\\s*schema\\.(\\w+)\\b`).exec(text)?.[1]??expr;
}
/** A `set` must be an object literal that neither names the order key nor spreads a value whose keys cannot be seen here. */
function checkSet(set:string|undefined,table:string):string|undefined{
  const {field}=FIXED[table]!;
  if(set===undefined||!set.trimStart().startsWith('{'))return 'set is not an object literal';
  if(new RegExp(`\\b${field}\\b`).test(set))return `set names ${field}`;
  if(/\.\.\.\s*[A-Za-z_$]/.test(set))return 'set spreads a value whose keys are not visible';
  return undefined;
}
function writeSites(file:string,text:string):Site[]{
  const sites:Site[]=[];let m:RegExpExecArray|null;
  const update=/\.update\(\s*([\w.]+)\s*\)\s*\.set\(/g;
  while((m=update.exec(text))){const table=tableOf(m[1]!,text);if(table&&FIXED[table]){const problem=checkSet(inside(text,m.index+m[0].length-1),table);sites.push({file,table,kind:'update',...(problem?{problem}:{})});}}
  const insert=/\.insert\(\s*([\w.]+)\s*\)\s*\.values\(/g;
  while((m=insert.exec(text))){
    const table=tableOf(m[1]!,text);if(!table||!FIXED[table])continue;
    const values=inside(text,m.index+m[0].length-1);if(values===undefined)continue;
    const rest=text.slice(m.index+m[0].length+values.length+1),conflict=/^\s*\.onConflictDoUpdate\(/.exec(rest);if(!conflict)continue;
    const args=inside(rest,conflict[0].length-1)??'',set=/\bset\s*:\s*/.exec(args);
    const problem=checkSet(set?(args[set.index+set[0].length]==='{'?`{${inside(args,set.index+set[0].length)??''}}`:args.slice(set.index+set[0].length)):undefined,table);
    sites.push({file,table,kind:'upsert',...(problem?{problem}:{})});
  }
  const raw=/\b(?:update|insert\s+into)\s+(?:public\.)?"?(leads|calls|walkthroughs)"?\s[^;`]*/gi;
  while((m=raw.exec(text))){const table=m[1]!.toLowerCase();if(/\b(set|do\s+update)\b/i.test(m[0]))sites.push({file,table,kind:'raw',...(new RegExp(`\\b${FIXED[table]!.column}"?\\s*=`,'i').test(m[0])?{problem:`raw SQL assigns ${FIXED[table]!.column}`}:{})});}
  const trigger=/\bcreate\s+(?:or\s+replace\s+)?trigger\s+"?\w+"?\s+before\b[^;]*?\bon\s+(?:public\.)?"?(leads|calls|walkthroughs)"?\b/gi;
  while((m=trigger.exec(text)))sites.push({file,table:m[1]!.toLowerCase(),kind:'trigger',problem:'a BEFORE trigger can rewrite the order key'});
  return sites;
}

describe('fixed keyset order keys',()=>{
  it('no write path rewrites leads.created_at, calls.started_at or walkthroughs.created_at after insert',()=>{
    const sites=['apps','packages','services','infra'].flatMap(dir=>sources(join(ROOT,dir))).flatMap(path=>writeSites(relative(ROOT,path),readFileSync(path,'utf8')));
    expect(sites.filter(site=>site.problem)).toEqual([]);
    // The scan must see the real writers, or it proves nothing.
    const seen=(table:string,kind:Site['kind'])=>[...new Set(sites.filter(site=>site.table===table&&site.kind===kind).map(site=>site.file))].sort();
    expect(seen('leads','upsert')).toEqual(['apps/worker/src/worker.ts']);
    expect(seen('leads','update')).toEqual(expect.arrayContaining(['apps/mcp/src/server.ts','services/lead-audit/src/index.ts']));
    expect(seen('calls','upsert')).toEqual(['apps/worker/src/worker.ts']);
    expect(seen('walkthroughs','update')).toEqual(expect.arrayContaining(['apps/api/src/recordings.ts','apps/mcp/src/server.ts','services/operations/src/legacy-walkthrough.ts']));
  });
  it('the scan flags every way a writer could move a fixed key',()=>{
    const flagged=(text:string)=>writeSites('synthetic.ts',text).map(site=>[site.table,site.kind,site.problem]);
    expect(flagged(`await db.insert(schema.calls).values({startedAt}).onConflictDoUpdate({target:schema.calls.providerMessageId,set:{status,startedAt:occurredAt,updatedAt:new Date()}});`)).toEqual([['calls','upsert','set names startedAt']]);
    expect(flagged(`const l=schema.leads;await db.update(l).set({createdAt:new Date()}).where(eq(l.id,id));`)).toEqual([['leads','update','set names createdAt']]);
    expect(flagged(`await db.insert(schema.leads).values(values).onConflictDoUpdate({target:schema.leads.contactId,set:values});`)).toEqual([['leads','upsert','set is not an object literal']]);
    expect(flagged(`await tx.update(schema.walkthroughs).set({...patch,updatedAt:now});`)).toEqual([['walkthroughs','update','set spreads a value whose keys are not visible']]);
    expect(flagged('await db.execute(sql`update "leads" set created_at = now() where id = ${id}`);')).toEqual([['leads','raw','raw SQL assigns created_at']]);
    expect(flagged('CREATE TRIGGER calls_restamp BEFORE UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION restamp();')).toEqual([['calls','trigger','a BEFORE trigger can rewrite the order key']]);
    // What the real writers do stays clean: other tables, conditional spreads, setWhere, AFTER triggers and insert-only paths.
    expect(flagged(`await db.update(schema.walkthroughs).set({...(transcript!==undefined?{transcript}:{}),updatedAt:new Date()});await db.update(schema.jobs).set({createdAt:x});`)).toEqual([['walkthroughs','update',undefined]]);
    expect(flagged(`await db.insert(schema.leads).values({contactId,createdAt:contact.providerCreatedAt??new Date()}).onConflictDoUpdate({target:schema.leads.contactId,set:{source,updatedAt:new Date()},setWhere:sql\`true\`});`)).toEqual([['leads','upsert',undefined]]);
    expect(flagged(`await db.insert(schema.leads).values({contactId,createdAt}).onConflictDoNothing();CREATE TRIGGER egc_calls_invalidate_drafts AFTER INSERT OR UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION f();`)).toEqual([]);
  });
});
