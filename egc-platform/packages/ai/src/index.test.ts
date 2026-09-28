import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import * as z from 'zod/v4';
import {zodTextFormat} from 'openai/helpers/zod';
import {walkthroughExtractionSchema,walkthroughModelOutputSchema} from '@egc/schemas';
const {parse,transcribe,constructed}=vi.hoisted(()=>({parse:vi.fn(),transcribe:vi.fn(),constructed:[] as unknown[]}));
vi.mock('openai',async importOriginal=>({...await importOriginal<typeof import('openai')>(),default:class OpenAI {static APIError=class APIError extends Error{};responses={parse};audio={transcriptions:{create:transcribe}};constructor(options:unknown){constructed.push(options);}}}));
import {DEFAULT_EXTRACTION_MODEL,DEFAULT_TRANSCRIBE_MODEL,extractWalkthrough,transcribeWalkthrough,walkthroughEvidenceRecord,walkthroughExtractionFromModel} from './index.js';

import {validate,type Schema} from './strict-schema.test-helper.js';
const transcript='Synthetic walkthrough. Customer: it is a two car garage. Haul away the old couch but keep the bikes. I will send the quote tomorrow.';
const modelOutput=()=>({garageSize:'2_car',junkVolumeYards:null,itemsRemove:['old couch'],itemsKeep:['bikes'],itemsRelocate:[],storageRequirements:[],bikeRacks:0,toolRacks:0,shelving:[],pressureWashing:false,pestObservations:[],activeInfestation:null,accessNotes:null,estimatedLaborHours:null,customerPreferences:[],customerObjections:[],salesNotes:[],crewNotes:[],pricingNotes:[],
  proposedActions:[{title:'Send quote',kind:'prepare_quote',commitment:'Send the quote tomorrow',sourceQuote:'I will send the quote tomorrow.',ownerMention:null,dueMention:'tomorrow',confidence:.9}],
  evidence:[{field:'garageSize',sourceQuote:'it is a two car garage',confidence:.95},{field:'itemsRemove',sourceQuote:'Haul away the old couch',confidence:.9},{field:'garageSize',sourceQuote:'a later duplicate quote',confidence:.2},{field:'itemsKeep',sourceQuote:'keep the bikes',confidence:.85}]});
const storedEvidence={garageSize:{sourceQuote:'it is a two car garage',confidence:.95},itemsRemove:{sourceQuote:'Haul away the old couch',confidence:.9},itemsKeep:{sourceQuote:'keep the bikes',confidence:.85}};

beforeEach(()=>{vi.stubEnv('OPENAI_API_KEY','synthetic-not-a-real-key');vi.stubEnv('OPENAI_EXTRACTION_MODEL',undefined);vi.stubEnv('OPENAI_TRANSCRIBE_MODEL',undefined);vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('External HTTP disabled in @egc/ai unit tests');}));});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.unstubAllEnvs();vi.unstubAllGlobals();parse.mockReset();transcribe.mockReset();constructed.length=0;});

describe('walkthrough strict structured output schema',()=>{
  it('converts the real model schema with the real zodTextFormat into a closed, all-required strict schema',()=>{
    const format=zodTextFormat(walkthroughModelOutputSchema,'egc_walkthrough');
    expect(format).toMatchObject({type:'json_schema',name:'egc_walkthrough',strict:true});
    const objects=validate(format.schema as Schema);
    expect(objects).toEqual(expect.arrayContaining(['#','#/properties/proposedActions/items','#/properties/evidence/items']));
    const evidence=(format.schema as {properties:{evidence:Schema}}).properties.evidence;
    expect(evidence.type).toBe('array');expect(evidence.maxItems).toBe(60);
  });
  it('pins the original crash: record-shaped evidence cannot be sent to strict Structured Outputs',()=>{
    expect(()=>zodTextFormat(walkthroughExtractionSchema,'egc_walkthrough')).toThrow(/additionalProperties/);
    expect(()=>zodTextFormat(walkthroughModelOutputSchema.extend({evidence:z.record(z.string(),z.object({sourceQuote:z.string(),confidence:z.number()}))}),'egc_walkthrough')).toThrow(/additionalProperties/);
  });
  it('keeps the stored extraction shape: evidence stays a per-field record with optional members',()=>{
    expect(walkthroughExtractionSchema.parse({}).evidence).toEqual({});
    expect(walkthroughExtractionSchema.parse({evidence:{accessNotes:{}}}).evidence).toEqual({accessNotes:{}});
    expect(()=>walkthroughExtractionSchema.parse({evidence:[]})).toThrow();
  });
  it('restricts model evidence to known extraction fields and closed entries',()=>{
    for(const field of ['evidence','__proto__','constructor','unknownField'])expect(walkthroughModelOutputSchema.safeParse({...modelOutput(),evidence:[{field,sourceQuote:'quote',confidence:.5}]}).success,field).toBe(false);
    expect(walkthroughModelOutputSchema.safeParse({...modelOutput(),evidence:[{field:'garageSize',sourceQuote:'quote',confidence:.5,extra:true}]}).success).toBe(false);
    expect(walkthroughModelOutputSchema.safeParse({...modelOutput(),evidence:[{field:'garageSize',sourceQuote:'',confidence:.5}]}).success).toBe(false);
    expect(walkthroughModelOutputSchema.safeParse({...modelOutput(),evidence:Array.from({length:61},()=>({field:'garageSize',sourceQuote:'quote',confidence:.5}))}).success).toBe(false);
  });
  it('maps the evidence array to a record, keeping the first quote per field',()=>{
    expect(walkthroughEvidenceRecord(modelOutput().evidence as never)).toEqual(storedEvidence);
    expect(walkthroughEvidenceRecord([])).toEqual({});
    const mapped=walkthroughExtractionFromModel(modelOutput());
    expect(mapped).toEqual(walkthroughExtractionSchema.parse({...modelOutput(),evidence:storedEvidence}));
    expect(Object.getPrototypeOf(mapped.evidence)).toBe(Object.prototype);
  });
});

describe('extractWalkthrough',()=>{
  it('sends the strict model schema and returns the stored shape with an evidence record',async()=>{
    parse.mockImplementation(async(request)=>{
      validate(request.text.format.schema);
      // The real SDK parses the raw model JSON with the format's own parser before exposing output_parsed.
      return {output_parsed:request.text.format.$parseRaw(JSON.stringify(modelOutput()))};
    });
    const result=await extractWalkthrough(transcript);
    expect(result).toEqual(walkthroughExtractionSchema.parse({...modelOutput(),evidence:storedEvidence}));
    expect(walkthroughExtractionSchema.parse(result)).toEqual(result);
    expect(Array.isArray(result.evidence)).toBe(false);expect(result.evidence).toEqual(storedEvidence);
    expect(parse).toHaveBeenCalledTimes(1);
    const request=parse.mock.calls[0]![0];
    expect(request.model).toBe(DEFAULT_EXTRACTION_MODEL);expect(DEFAULT_EXTRACTION_MODEL).toBe('gpt-5.6-luna');
    expect(request.text.format).toMatchObject({type:'json_schema',name:'egc_walkthrough',strict:true});
    expect(request.input[1]).toEqual({role:'user',content:[{type:'input_text',text:transcript}]});
    expect(request.input[0].content[0].text).toContain('Never invent facts.');
    expect(constructed).toEqual([{apiKey:'synthetic-not-a-real-key',timeout:120_000,maxRetries:1}]);
  });
  it('uses OPENAI_EXTRACTION_MODEL when set and the default when blank',async()=>{
    parse.mockResolvedValue({output_parsed:modelOutput()});
    vi.stubEnv('OPENAI_EXTRACTION_MODEL',' gpt-synthetic-extract ');await extractWalkthrough(transcript);
    vi.stubEnv('OPENAI_EXTRACTION_MODEL','   ');await extractWalkthrough(transcript);
    expect(parse.mock.calls.map(([request])=>request.model)).toEqual(['gpt-synthetic-extract',DEFAULT_EXTRACTION_MODEL]);
  });
  it('throws when the response has no structured output',async()=>{
    for(const output_parsed of [null,undefined]){
      parse.mockResolvedValueOnce({output_parsed,output_text:''});
      await expect(extractWalkthrough(transcript)).rejects.toThrow('Walkthrough extraction returned no structured output');
    }
  });
  it('rejects model output that does not match the strict model schema instead of storing it',async()=>{
    parse.mockResolvedValueOnce({output_parsed:{...modelOutput(),evidence:storedEvidence}});
    await expect(extractWalkthrough(transcript)).rejects.toThrow();
    parse.mockResolvedValueOnce({output_parsed:{...modelOutput(),evidence:[{field:'__proto__',sourceQuote:'quote',confidence:1}]}});
    await expect(extractWalkthrough(transcript)).rejects.toThrow();
  });
  it('requires OPENAI_API_KEY before calling the provider',async()=>{
    vi.stubEnv('OPENAI_API_KEY','');
    await expect(extractWalkthrough(transcript)).rejects.toThrow('OPENAI_API_KEY is required');
    await expect(transcribeWalkthrough(Buffer.from('synthetic audio'),'walkthrough.webm')).rejects.toThrow('OPENAI_API_KEY is required');
    expect(parse).not.toHaveBeenCalled();expect(transcribe).not.toHaveBeenCalled();expect(constructed).toEqual([]);
  });
});

describe('transcribeWalkthrough',()=>{
  it('uploads the audio through the mocked transcription client and returns its text',async()=>{
    transcribe.mockResolvedValue({text:'Synthetic transcript text'});
    await expect(transcribeWalkthrough(Buffer.from('synthetic audio bytes'),'walkthrough.m4a','audio/mp4')).resolves.toBe('Synthetic transcript text');
    expect(transcribe).toHaveBeenCalledTimes(1);
    const request=transcribe.mock.calls[0]![0];
    expect(request.model).toBe(DEFAULT_TRANSCRIBE_MODEL);expect(DEFAULT_TRANSCRIBE_MODEL).toBe('gpt-transcribe');expect(request.response_format).toBe('json');
    expect(request.file.name).toBe('walkthrough.m4a');expect(request.file.type).toBe('audio/mp4');
    expect(Buffer.from(await request.file.arrayBuffer()).toString()).toBe('synthetic audio bytes');
  });
  it('defaults to webm audio and honours OPENAI_TRANSCRIBE_MODEL',async()=>{
    transcribe.mockResolvedValue({text:'Synthetic'});vi.stubEnv('OPENAI_TRANSCRIBE_MODEL','gpt-synthetic-transcribe');
    await transcribeWalkthrough(Buffer.from('synthetic'),'recording');
    const request=transcribe.mock.calls[0]![0];
    expect(request.model).toBe('gpt-synthetic-transcribe');expect(request.file.type).toBe('audio/webm');
  });
});
