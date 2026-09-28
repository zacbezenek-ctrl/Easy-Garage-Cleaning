import {drizzle} from 'drizzle-orm/postgres-js';
import {getTableColumns,getTableName,type Table} from 'drizzle-orm';
import {schema} from '@egc/database';

// A real drizzle instance over a fake postgres-js driver: queries are built and rendered by drizzle exactly as in production,
// then recorded, and rows come from the test. Nothing connects to a database.
export type Statement={sql:string;params:unknown[];op:'select'|'insert'|'update'|'delete'|'other';table:string|null};
export type Respond=(statement:Statement)=>Record<string,unknown>[]|undefined;
const unquote=(token:string)=>token.trim().replace(/"/g,'');
const WRITES:Record<string,Statement['op']>={'insert into':'insert',update:'update','delete from':'delete'};
/** Anything that is not recognisably a select, insert, update or delete is 'other'; a data-modifying CTE counts as its write. */
export function classify(text:string):Pick<Statement,'op'|'table'>{
  const s=text.trimStart();let m:RegExpExecArray|null;
  if(/^with\b/i.test(s)&&(m=/\b(insert into|update|delete from) "([a-z0-9_]+)"/i.exec(s)))return {op:WRITES[m[1]!.toLowerCase()]!,table:m[2]!};
  if(/^\(?\s*(select|with)\b/i.test(s))return {op:'select',table:/\bfrom "([a-z0-9_]+)"/i.exec(s)?.[1]??null};
  if((m=/^insert into "([a-z0-9_]+)"/i.exec(s)))return {op:'insert',table:m[1]!};
  if((m=/^update "([a-z0-9_]+)"/i.exec(s)))return {op:'update',table:m[1]!};
  if((m=/^delete from "([a-z0-9_]+)"/i.exec(s)))return {op:'delete',table:m[1]!};
  return {op:'other',table:null};
}
function columns(text:string,table:string|null){
  const list=/ returning ([\s\S]*)$/i.exec(text)?.[1]??/^select ([\s\S]*?) from "/i.exec(text.trimStart())?.[1];
  return list?list.split(', ').map(token=>{const key=unquote(token);return key.includes('.')||!table?key:`${table}.${key}`;}):[];
}
/** Row keyed by qualified database column names from JS field names, e.g. dbRow(schema.jobs,{id,contactId}) -> {'jobs.id':..,'jobs.contact_id':..}. */
export function dbRow(table:Table,values:Record<string,unknown>){
  const name=getTableName(table),out:Record<string,unknown>={};
  for(const [key,column] of Object.entries(getTableColumns(table)))if(key in values)out[`${name}.${column.name}`]=values[key];
  return out;
}
export const limitOffset=(statement:Statement)=>{
  const m=/ limit \$(\d+)(?: offset \$(\d+))?\s*$/i.exec(statement.sql);
  return m?{limit:Number(statement.params[Number(m[1])-1]),offset:m[2]?Number(statement.params[Number(m[2])-1]):0}:null;
};
export function sqlDriver(respond:Respond=()=>[]){
  const log:Statement[]=[];
  const run=(text:string,params:unknown[])=>{
    const statement={sql:text,params:[...params],...classify(text)};log.push(statement);
    // Lazy so a failing response rejects only the promise drizzle actually awaits.
    const rows=()=>new Promise<Record<string,unknown>[]>(resolve=>resolve(respond(statement)??[])),cols=columns(text,statement.table);
    return {then:(ok:(v:unknown)=>unknown,fail:(e:unknown)=>unknown)=>rows().then(ok,fail),values:()=>rows().then(list=>list.map(row=>cols.map(col=>row[col]??null)))};
  };
  const client:Record<string,unknown>={options:{parsers:{},serializers:{}},unsafe:run};
  client.begin=async(fn:(tx:unknown)=>unknown)=>fn(client);
  return {db:drizzle(client as never,{schema}),log};
}
