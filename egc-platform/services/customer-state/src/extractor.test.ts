import {describe,it,expect,vi,afterEach} from 'vitest';
const {create}=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('openai',()=>({default:class OpenAI {static APIError=class APIError extends Error{};responses={create};}}));
import {extractStructuredEvidence} from './extractor.js';
import type {SourceRecord} from './types.js';
const oldKey=process.env.OPENAI_API_KEY;
afterEach(()=>{if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;create.mockReset();});
describe('semantic extraction provider contract',()=>{
  it('sends a valid strict schema and retains separate commitments without copying one monetary amount to both',async()=>{
    process.env.OPENAI_API_KEY='synthetic-not-a-real-key';
    const source:SourceRecord={sourceType:'call_transcript',sourceRecordId:'call',contactId:'contact',leadId:'lead',occurredAt:'2026-09-21T12:00:00Z',text:'Customer: I accept the small pickup Tuesday. Customer: I accept the full cleanout Saturday.'};
    create.mockImplementation(async(request)=>{
      const validate=(schema:Record<string,unknown>)=>{
        if(schema.type==='object'){expect(schema.additionalProperties).toBe(false);expect([...(schema.required as string[])].sort()).toEqual(Object.keys(schema.properties as object).sort());for(const child of Object.values(schema.properties as object))validate(child as Record<string,unknown>);}
        if(schema.type==='array')validate(schema.items as Record<string,unknown>);
      };
      validate(request.text.format.schema);
      return {output_text:JSON.stringify({reviewedSourceIds:['call'],events:['small pickup Tuesday','full cleanout Saturday'].map(anchor=>({sourceRecordId:'call',eventType:'job_sold',supportingText:`I accept the ${anchor}.`,confidence:.98,humanReviewNeeded:false,customerCommitmentVerified:true,nextAction:'Schedule this accepted work',timeMention:null,deadlineMention:null,reason:'Explicitly accepted separate work',independentCommitment:true,commitmentAnchor:anchor}))})};
    });
    const result=await extractStructuredEvidence([source]),sales=result.records[0]!.events!.filter(e=>e.eventType==='job_sold');expect(result.status).toBe('complete');expect(sales).toHaveLength(2);expect(new Set(sales.map(e=>e.details!.commitmentSpanKey)).size).toBe(2);expect(sales.every(e=>!e.valueVerified)).toBe(true);
  });
});
