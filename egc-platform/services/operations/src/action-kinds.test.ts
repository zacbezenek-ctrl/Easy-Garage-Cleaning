import {describe,it,expect} from "vitest";
import {readFileSync} from "node:fs";
import {MESSAGE_TASK_KINDS,TASK_KINDS} from "./action-kinds.js";
// Security invariant: the database guard is the last line of defence for drafts and
// provider-verified completion, so its kind lists must equal the TypeScript contract.
const guards=readFileSync(new URL("../sql/revision-guards.sql",import.meta.url),"utf8");
const migration=readFileSync(new URL("../../../packages/database/migrations/0013_action_kinds_v2.sql",import.meta.url),"utf8");
const journal=JSON.parse(readFileSync(new URL("../../../packages/database/migrations/meta/_journal.json",import.meta.url),"utf8")) as {entries:{idx:number;tag:string}[]};
const list=(sql:string,pattern:RegExp)=>{const match=pattern.exec(sql);expect(match,String(pattern)).not.toBeNull();return match![1]!.split(",").map(v=>v.trim().replace(/^'|'$/g,"")).sort();};
const fn=(sql:string,name:string)=>{const start=sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}()`);expect(start,name).toBeGreaterThanOrEqual(0);return sql.slice(start,sql.indexOf("END $$;",start)+7);};
const sorted=(values:readonly string[])=>[...values].sort();
describe("database guard matches action kinds v2",()=>{
 for(const [name,sql] of [["sql/revision-guards.sql",guards],["migration 0013",migration]] as const) {
  it(`${name} whitelists exactly the contract kinds and applies message rules to every message kind`,()=>{
   expect(list(sql,/NEW\.kind NOT IN \(([^)]*)\) OR/)).toEqual(sorted(TASK_KINDS));
   expect(list(sql,/IF \(NEW\.kind IN \(([^)]*)\)\) IS DISTINCT FROM \(NEW\.draft_payload IS NOT NULL\)/)).toEqual(sorted(MESSAGE_TASK_KINDS));
   expect(list(sql,/IF NEW\.status='completed' AND NEW\.kind IN \(([^)]*)\) AND \(TG_OP='INSERT'/)).toEqual(sorted(MESSAGE_TASK_KINDS));
   expect(list(sql,/WHERE contact_id=contact AND kind IN \(([^)]*)\) AND status IN/)).toEqual(sorted(MESSAGE_TASK_KINDS));
   expect(sql).toContain("AND coalesce(execution.payload->'attachments','[]'::jsonb)=coalesce((SELECT jsonb_agg(attachment->'url' ORDER BY ord)");
   expect(sql).not.toMatch(/kind='followup_message'/);
  });
 }
 it("migration 0013 installs byte-identical functions to the maintained guard source",()=>{
  for(const name of ["egc_task_revision_guard","egc_communication_invalidates_drafts"])expect(fn(migration,name)).toBe(fn(guards,name));
  expect(journal.entries.find(e=>e.tag==="0013_action_kinds_v2")?.idx).toBe(13);
 });
});
