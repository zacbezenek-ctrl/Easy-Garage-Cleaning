import {describe,it,expect,vi,afterEach} from 'vitest';
const {create}=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('openai',()=>({default:class OpenAI {static APIError=class APIError extends Error{};responses={create};}}));
import {extractStructuredEvidence,semanticProviderDiagnostic} from './extractor.js';
import type {SourceRecord} from './types.js';
const oldKey=process.env.OPENAI_API_KEY;
afterEach(()=>{if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;create.mockReset();});
describe('semantic extraction provider contract',()=>{
  it('keeps provider diagnostics useful without persisting arbitrary provider strings',()=>{
    expect(semanticProviderDiagnostic({status:400,code:'invalid_json_schema',param:'text.format.schema',type:'invalid_request_error',request_id:'req_synthetic123'})).toBe('semantic_provider_http_400;code=invalid_json_schema;type=invalid_request_error;param=text.format.schema;request_id=req_synthetic123');
    expect(semanticProviderDiagnostic({status:401,code:'sk-sensitive-token',param:'private@example.invalid',type:'Authorization: Bearer secret',request_id:'sk-private'})).toBe('semantic_provider_http_401');
  });
  it('retries only the invalid excerpt source, preserving reviewed ambiguous evidence and automation',async()=>{
    process.env.OPENAI_API_KEY='synthetic-not-a-real-key';
    const base={sourceType:'message' as const,contactId:'contact',occurredAt:'2026-09-21T12:00:00Z',direction:'inbound',actorType:'customer'};
    const records=[{...base,sourceRecordId:'valid',text:'I might accept after checking with my spouse.'},{...base,sourceRecordId:'bad',text:'Can you call me tomorrow?'},{...base,sourceRecordId:'auto',direction:'outbound',actorType:'automation',text:'Automated greeting'}];
    create.mockResolvedValue({output_text:JSON.stringify({reviewedSourceIds:['valid','bad'],events:[{sourceRecordId:'valid',eventType:'customer_deciding',supportingText:'I might accept after checking with my spouse.',confidence:.8,humanReviewNeeded:true,customerCommitmentVerified:false},{sourceRecordId:'bad',eventType:'job_sold',supportingText:'A fabricated quote acceptance',confidence:1,customerCommitmentVerified:true}]})});
    const result=await extractStructuredEvidence(records);expect(result.status).toBe('partial');expect(result.records.find(r=>r.sourceRecordId==='valid')!.extractionStatus).toBe('complete');expect(result.records.find(r=>r.sourceRecordId==='valid')!.events!.some(e=>e.humanReviewNeeded)).toBe(true);expect(result.records.find(r=>r.sourceRecordId==='bad')!.extractionStatus).toBe('review_required');expect(result.records.find(r=>r.sourceRecordId==='auto')!.extractionStatus).toBe('complete');expect(result.records.find(r=>r.sourceRecordId==='auto')!.extractionAttempted).toBe(false);
  });
  it('preserves a verified human written price quote when semantic extraction omits it',async()=>{
    process.env.OPENAI_API_KEY='synthetic-not-a-real-key';
    const source:SourceRecord={sourceType:'message',sourceRecordId:'quoted-work',contactId:'contact',occurredAt:'2026-09-21T12:00:00Z',actorType:'human',direction:'outbound',text:'We have a truck in the area on September 27th. If you wanted to book on that day I can come down to 139'};
    create.mockResolvedValue({output_text:JSON.stringify({reviewedSourceIds:['quoted-work'],events:[]})});
    const result=await extractStructuredEvidence([source]);expect(result.status).toBe('complete');const quote=result.records[0]!.events!.find(e=>e.eventType==='quote_delivered');expect(quote?.valueCents).toBe(13900);expect(quote?.valueVerified).toBe(true);expect(result.records[0]!.events!.some(e=>e.eventType==='job_sold')).toBe(false);
  });
  it('preserves delivered scoped scheduling-price options when a complete model result omits the quote',async()=>{
    process.env.OPENAI_API_KEY='synthetic-not-a-real-key';
    const source:SourceRecord={sourceType:'message',sourceRecordId:'options',contactId:'contact',occurredAt:'2026-09-21T12:00:00Z',actorType:'human',direction:'outbound',text:'Hi! Normally, we are at 350 for that, but if you book on a day when we have a truck out, we are at $250'};
    const context:SourceRecord={...source,sourceRecordId:'request',occurredAt:'2026-09-21T11:00:00Z',actorType:'customer',direction:'inbound',text:'What do you charge to take a king size bed and frame? I’m in SW Loveland.'};
    create.mockResolvedValue({output_text:JSON.stringify({reviewedSourceIds:['options'],events:[]})});
    const result=await extractStructuredEvidence([source],[context]),quote=result.records[0]!.events!.find(e=>e.eventType==='quote_delivered');expect(result.status).toBe('complete');expect(quote?.details?.conditionalPriceOptions).toBe(true);expect(quote?.valueVerified).not.toBe(true);expect(result.records[0]!.events!.some(e=>e.eventType==='job_sold')).toBe(false);
  });
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
