import {describe,it,expect} from 'vitest';
import {presentCustomerDiagnostics} from '../src/customer-diagnostics.js';
describe('bounded diagnostics',()=>{
 it('preserves database timestamps in summaries using JSON date semantics',()=>{
  const updatedAt=new Date('2026-10-02T19:37:18.715Z'),invalid=new Date('invalid');
  const source={customers:{semanticQueue:{cursor:{updatedAt}},rows:[{updatedAt}]},meta:{lastSync:{startedAt:updatedAt,finishedAt:invalid},lastSuccessfulMetaSync:updatedAt}};
  const result=presentCustomerDiagnostics(source) as any;
  expect(result.customers.semanticQueue.cursor.updatedAt).toBe(updatedAt.toISOString());
  expect(result.meta.lastSync).toEqual({startedAt:updatedAt.toISOString(),finishedAt:null});
  expect(result.meta.lastSuccessfulMetaSync).toBe(updatedAt.toISOString());
  expect(source.customers.semanticQueue.cursor.updatedAt).toBe(updatedAt);
  expect((presentCustomerDiagnostics(source,{section:'customers.rows'}) as any).items[0].updatedAt).toBe(updatedAt);
 });
 const rows=Array.from({length:684},(_,i)=>({contactId:`customer-${i}`,supportingEvidence:[{excerpt:'private evidence '.repeat(300)}]}));
 const input={customers:{generatedAt:'2026-10-01T18:00:00Z',unresolvedDiscrepancies:rows,coverage:rows,semanticQueue:{cursor:{cursor:'x'.repeat(50000)},truncated:true,customers:rows.slice(0,500)}},meta:{counts:{accepted:29},canonicalCoverage:{sourceExtractionHeldEvents:rows}}};
 it('summarizes large repeated arrays without concealing total or upstream truncation',()=>{
  const result=presentCustomerDiagnostics(input) as any;
  expect(JSON.stringify(result).length).toBeLessThan(5000);expect(result.customers.unresolvedDiscrepancies.total).toBe(684);expect(result.customers.semanticQueue.truncated).toBe(true);expect(result.sections['customers.semanticQueue.customers'].total).toBe(500);expect(result.meta.counts.accepted).toBe(29);expect(result.customers.semanticQueue.cursor.cursor).toMatchObject({characterCount:50000});expect((presentCustomerDiagnostics(input,{section:'customers.semanticQueue.cursor.cursor'}) as any).items).toEqual(['x'.repeat(50000)]);expect(result).not.toHaveProperty('complete',true);
 });
 it('pages full original rows exactly and leaves source untouched',()=>{
  const result=presentCustomerDiagnostics(input,{section:'customers.unresolvedDiscrepancies',offset:680,limit:3}) as any;
  expect(result.items).toEqual(rows.slice(680,683));expect(result.page).toMatchObject({total:684,nextOffset:683});expect(presentCustomerDiagnostics(input,{section:'customers.unresolvedDiscrepancies',offset:683,limit:3})).toMatchObject({page:{nextOffset:null},items:[rows[683]]});expect(rows).toHaveLength(684);
 });
 it('rejects unknown paths and invalid pages',()=>{
  for(const section of ['customers.__proto__','customers.unknown','meta.counts'])expect(()=>presentCustomerDiagnostics(input,{section})).toThrow('invalid_diagnostics_section');
  for(const offset of [-1,1.5,Number.MAX_SAFE_INTEGER+1])expect(()=>presentCustomerDiagnostics(input,{section:'customers.coverage',offset})).toThrow('invalid_diagnostics_page');
 });
});
