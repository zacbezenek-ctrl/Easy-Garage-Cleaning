import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {zodTextFormat} from 'openai/helpers/zod';
import {SCHEDULING_DAY_PARTS,SCHEDULING_URGENCIES,SCHEDULING_WEEKDAYS,schedulingConstraintsSchema,type SchedulingConstraints} from '@egc/schemas';
import {conversationExtractionSchema,conversationModelOutputSchema,conversationPrompt,extractConversation,loadCatalogIndex,resolveSchedulingConstraints,schedulingAnchor,schedulingAnchorFromOutcome,spokenDayParts,spokenNumbers,spokenUrgencies,spokenWeekdays,validateConversationOutput,walkthroughExtractionFromConversation,walkthroughSchedulingConstraints,type ConversationClient,type ConversationContext,type SchedulingAnchor} from './index.js';
import {validate,type Schema} from './strict-schema.test-helper.js';

// FUN-08: scheduling constraints in the v2 extraction. The model output is synthetic; the evidence validation and the
// date resolution are the real ones. No test reads the real clock: anchors are fixed instants, and one test moves the
// system time years ahead to prove the resolver never looks at it.
const transcript=['Synthetic visit recording.',
  'Customer: Tuesdays or Thursdays work best for us, and mornings are better than afternoons.',
  'Customer: We cannot do anything until after next week because of a family trip.',
  'Customer: It really has to be finished by the end of October for the HOA inspection.',
  'Customer: We are out of town the week of the 19th, and Fridays never work.',
  'Tyler: It looks like maybe two guys for about four and a half hours.',
  'Customer: There is no rush on the shelving part, and I prefer texts over calls.'].join('\n');
// The visit was uploaded eight days after its Start, in another week: occurredAt must never anchor a date.
const context:ConversationContext={sourceKind:'visit_recording',occurredAt:'2026-10-13T15:00:00.000Z'};
const index=loadCatalogIndex(),meta={context,catalog:index.items,catalogVersion:index.catalogVersion,model:'gpt-synthetic'};
const quoted=(mention:string,sourceQuote:string)=>({mention,sourceQuote});
const constraints=(over:Record<string,unknown>={})=>({
  preferredWeekdays:{weekdays:['tuesday','thursday'],sourceQuote:'Tuesdays or Thursdays work best for us'},
  timeOfDay:{dayParts:['morning'],sourceQuote:'mornings are better than afternoons'},
  notBeforeMention:quoted('until after next week','We cannot do anything until after next week'),
  notAfterMention:quoted('by the end of October','It really has to be finished by the end of October'),
  unavailableMentions:[quoted('the week of the 19th','We are out of town the week of the 19th'),quoted('Fridays','Fridays never work')],
  crewSizeMention:{people:2,mention:'two guys',sourceQuote:'maybe two guys for about four and a half hours'},
  durationHoursMention:{hours:4.5,mention:'about four and a half hours',sourceQuote:'maybe two guys for about four and a half hours'},
  urgency:{level:'flexible',sourceQuote:'There is no rush on the shelving part'},...over});
const empty={preferredWeekdays:null,timeOfDay:null,notBeforeMention:null,notAfterMention:null,unavailableMentions:[],crewSizeMention:null,durationHoursMention:null,urgency:null};
const output=(schedulingConstraints:unknown=constraints())=>({scope:null,proposedActions:[],catalogMentions:[],preferences:[],schedulingConstraints});
const validated=(schedulingConstraints:unknown,text=transcript)=>validateConversationOutput(output(schedulingConstraints),text,meta)!;
// FUN-37 hub.walkthrough.outcomes items as the Hub projects them (tests/scheduling-constraints-anchor.test.mjs feeds real ones).
const outcome=(startedAt:string|null,date:string|null='2026-10-05')=>({eventId:`fe_${'a'.repeat(40)}`,visitId:'visit-synthetic',outcome:'quote_to_follow',finishedAt:'2026-10-06T06:10:00.000Z',startedAt,occurrence:{number:1,date,time:'17:00',startAt:null},detail:'visit_record'});
// Monday 5 October 2026, 23:30 in Denver (MDT); already Tuesday in UTC.
const LATE_MONDAY='2026-10-06T05:30:00.000Z';
const only=(over:Partial<SchedulingConstraints>):SchedulingConstraints=>({...empty,...over});
const at=(startedAt:string)=>schedulingAnchor({startedAt});
const notBefore=(mention:string,anchor:SchedulingAnchor)=>resolveSchedulingConstraints(only({notBeforeMention:quoted(mention,mention)}),anchor)!.notBefore!;
const notAfter=(mention:string,anchor:SchedulingAnchor)=>resolveSchedulingConstraints(only({notAfterMention:quoted(mention,mention)}),anchor)!.notAfter!;
const away=(mention:string,anchor:SchedulingAnchor)=>resolveSchedulingConstraints(only({unavailableMentions:[quoted(mention,mention)]}),anchor)!.unavailable[0]!;

beforeEach(()=>{vi.stubEnv('OPENAI_API_KEY','synthetic-not-a-real-key');vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('External HTTP disabled in @egc/ai unit tests');}));});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe('scheduling constraints in the strict v2 schema',()=>{
  it('adds a closed, all-required schedulingConstraints object whose every constraint is nullable and quoted',()=>{
    const format=zodTextFormat(conversationModelOutputSchema,'egc_conversation'),objects=validate(format.schema as Schema);
    const base='#/properties/schedulingConstraints';
    expect(objects).toEqual(expect.arrayContaining([base,...['preferredWeekdays','timeOfDay','notBeforeMention','notAfterMention','crewSizeMention','durationHoursMention','urgency'].map(key=>`${base}/properties/${key}/anyOf/0`),`${base}/properties/unavailableMentions/items`]));
    const properties=((format.schema as {properties:Record<string,Schema>}).properties.schedulingConstraints as {properties:Record<string,{anyOf?:Schema[];maxItems?:number;items?:Schema}>}).properties;
    expect(Object.keys(properties).sort()).toEqual(['crewSizeMention','durationHoursMention','notAfterMention','notBeforeMention','preferredWeekdays','timeOfDay','unavailableMentions','urgency']);
    for(const [key,property] of Object.entries(properties)){
      if(key==='unavailableMentions'){expect(property.maxItems).toBe(10);expect(Object.keys((property.items as {properties:object}).properties)).toEqual(['mention','sourceQuote']);continue;}
      expect(property.anyOf!.map(branch=>branch.type),key).toEqual(['object','null']);
      expect((property.anyOf![0]!.required as string[]),key).toContain('sourceQuote');
    }
    const member=(key:string,field:string)=>(properties[key]!.anyOf![0]!.properties as Record<string,{enum?:string[];items?:{enum:string[]}}>)[field]!;
    expect(member('preferredWeekdays','weekdays').items!.enum).toEqual([...SCHEDULING_WEEKDAYS]);
    expect(member('timeOfDay','dayParts').items!.enum).toEqual([...SCHEDULING_DAY_PARTS]);
    expect(member('urgency','level').enum).toEqual([...SCHEDULING_URGENCIES]);
    // Nothing the model returns can be a date: mentions are words, and the schema has no date or time field.
    expect(JSON.stringify(properties)).not.toMatch(/date-time|"format"/);
  });
  it('keeps extractions stored before FUN-08 readable: their schedulingConstraints are null (never extracted), not empty',()=>{
    const legacy={version:2,sourceKind:'visit_recording',occurredAt:'2026-09-22T12:00:00.000Z',model:'gpt-synthetic',catalogVersion:null,scope:null,proposedActions:[],catalogMentions:[],preferences:[],
      validation:{droppedProposedActions:0,droppedCatalogMentions:0,droppedPreferences:0,droppedEvidence:0,clearedCatalogItemIds:0,clearedMentions:0,clearedDraftSuggestions:0}};
    const parsed=conversationExtractionSchema.parse(legacy);
    expect(parsed.schedulingConstraints).toBeNull();expect(parsed.validation).toMatchObject({droppedSchedulingConstraints:0,clearedSchedulingValues:0});
    expect(resolveSchedulingConstraints(parsed.schedulingConstraints,at(LATE_MONDAY))).toBeNull();
    expect(walkthroughSchedulingConstraints(parsed,outcome(LATE_MONDAY))).toBeNull();
    expect(conversationExtractionSchema.parse({...legacy,schedulingConstraints:empty}).schedulingConstraints).toEqual(empty);
    expect(conversationExtractionSchema.safeParse({...legacy,schedulingConstraints:{...empty,notBeforeMention:{mention:'x y',sourceQuote:'x y',date:'2026-10-19'}}}).success).toBe(false);
  });
  it('tells the model to quote each constraint and copy date words, and keeps the long prefix cacheable',()=>{
    const prompt=conversationPrompt(context,index.items);
    for(const rule of ['schedulingConstraints are what the customer said about when the work can happen','its own sourceQuote copied exactly from the transcript','mention must be words inside its sourceQuote',
      'Never turn them into dates or weekdays: code resolves them against the walkthrough start','people and hours are numbers only when those words say the number','They are hints for staff, never a plan'])expect(prompt).toContain(rule);
    expect(prompt.indexOf('schedulingConstraints are')).toBeLessThan(prompt.indexOf('Catalog (id |'));
    expect(prompt).not.toMatch(/cents|\$\d/);
  });
});

describe('scheduling constraint evidence validation',()=>{
  it('keeps every constraint its own quote supports, and sends it in the one strict request',async()=>{
    const call=vi.fn(async(_body:unknown)=>({output_text:JSON.stringify(output())}));
    const result=await extractConversation(transcript,{catalog:[],context,client:{responses:{create:call}} as ConversationClient});
    if(!result.ok)throw new Error(result.code);
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.extraction.schedulingConstraints).toEqual(constraints());
    expect(result.extraction.validation).toMatchObject({droppedSchedulingConstraints:0,clearedSchedulingValues:0});
    expect(conversationExtractionSchema.parse(result.extraction)).toEqual(result.extraction);
  });
  it('drops a constraint whose quote is not a whole-word normalized substring of the transcript, or is only function words',()=>{
    const result=validated(constraints({
      preferredWeekdays:{weekdays:['saturday'],sourceQuote:'Saturdays work best for us'},
      notBeforeMention:quoted('after the 20th','we can start after the 20th'),
      notAfterMention:quoted('end of October','nd of Octobe'),
      unavailableMentions:[quoted('the week of the 19th','  we ARE out of town, the WEEK of the 19th!! '),quoted('Mondays','Mondays are out'),quoted('it is','It is')],
      urgency:{level:'asap',sourceQuote:'we need this done ASAP'}}));
    const sc=result.schedulingConstraints!;
    expect([sc.preferredWeekdays,sc.notBeforeMention,sc.notAfterMention,sc.urgency]).toEqual([null,null,null,null]);
    expect(sc.unavailableMentions).toEqual([quoted('the week of the 19th','we ARE out of town, the WEEK of the 19th!!')]);
    expect(result.validation.droppedSchedulingConstraints).toBe(6);
    expect(sc.timeOfDay).toEqual(constraints().timeOfDay);
  });
  it('drops a date mention that is not words inside its own quote, so no date comes from unquoted words',()=>{
    const result=validated(constraints({
      notBeforeMention:quoted('after next month','We cannot do anything until after next week'),
      notAfterMention:quoted('2026-10-31','It really has to be finished by the end of October'),
      unavailableMentions:[quoted('the 19th','We are out of town the week of the 19th'),quoted('Fridays','We are out of town the week of the 19th')]}));
    const sc=result.schedulingConstraints!;
    expect([sc.notBeforeMention,sc.notAfterMention]).toEqual([null,null]);
    expect(sc.unavailableMentions.map(item=>item.mention)).toEqual(['the 19th']);
    expect(result.validation.droppedSchedulingConstraints).toBe(3);
  });
  it('clears weekdays, day parts, people and hours the words do not say, and drops a constraint left with none',()=>{
    const result=validated(constraints({
      preferredWeekdays:{weekdays:['tuesday','wednesday','thursday','thursday'],sourceQuote:'Tuesdays or Thursdays work best for us'},
      timeOfDay:{dayParts:['evening','morning'],sourceQuote:'mornings are better than afternoons'},
      crewSizeMention:{people:3,mention:'two guys',sourceQuote:'maybe two guys for about four and a half hours'},
      durationHoursMention:{hours:4,mention:'about four and a half hours',sourceQuote:'maybe two guys for about four and a half hours'}}));
    const sc=result.schedulingConstraints!;
    expect(sc.preferredWeekdays).toEqual({weekdays:['tuesday','thursday'],sourceQuote:'Tuesdays or Thursdays work best for us'});
    expect(sc.timeOfDay!.dayParts).toEqual(['morning']);
    expect([sc.crewSizeMention!.people,sc.crewSizeMention!.mention,sc.durationHoursMention!.hours]).toEqual([null,'two guys',null]);
    expect(result.validation).toMatchObject({clearedSchedulingValues:4,droppedSchedulingConstraints:0});
    const none=validated(constraints({preferredWeekdays:{weekdays:['monday'],sourceQuote:'Tuesdays or Thursdays work best for us'},timeOfDay:{dayParts:['evening'],sourceQuote:'mornings are better than afternoons'},
      urgency:{level:'asap',sourceQuote:'There is no rush on the shelving part'},crewSizeMention:{people:2,mention:'a crew',sourceQuote:'maybe two guys for about four and a half hours'}}));
    expect([none.schedulingConstraints!.preferredWeekdays,none.schedulingConstraints!.timeOfDay,none.schedulingConstraints!.urgency,none.schedulingConstraints!.crewSizeMention]).toEqual([null,null,null,null]);
    expect(none.validation).toMatchObject({droppedSchedulingConstraints:4,clearedSchedulingValues:0});
  });
  it('keeps flexible for a negated urgency and drops asap, so droppedSchedulingConstraints counts only wrong answers',()=>{
    const text=[transcript,"Customer: Honestly there's no need to rush the cabinets.","Customer: It's not an emergency, but the garage door sticks.","Customer: We sat down with the HOA."].join('\n');
    const kept=validated(constraints({urgency:{level:'flexible',sourceQuote:"there's no need to rush the cabinets"}}),text);
    expect(kept.schedulingConstraints!.urgency).toEqual({level:'flexible',sourceQuote:"there's no need to rush the cabinets"});
    expect(kept.validation.droppedSchedulingConstraints).toBe(0);
    const wrong=validated(constraints({urgency:{level:'asap',sourceQuote:"It's not an emergency"},preferredWeekdays:{weekdays:['saturday'],sourceQuote:'We sat down with the HOA'}}),text);
    expect([wrong.schedulingConstraints!.urgency,wrong.schedulingConstraints!.preferredWeekdays]).toEqual([null,null]);
    expect(wrong.validation.droppedSchedulingConstraints).toBe(2);
  });
  it('drops malformed or over-long entries, repeated unavailable mentions and any beyond ten, and never keeps a model date',()=>{
    const lines=Array.from({length:12},(_,i)=>`Customer: we are busy on the ${i+1}th of November.`),text=[transcript,...lines].join('\n');
    const many=lines.map((_,i)=>quoted(`the ${i+1}th of November`,`we are busy on the ${i+1}th of November`));
    const result=validated(constraints({unavailableMentions:[many[0],{...many[0],sourceQuote:'we are busy on the 1th of November'},...many.slice(1)],
      notBeforeMention:{...quoted('until after next week','We cannot do anything until after next week'),date:'2026-10-19'},
      notAfterMention:{mention:'x'.repeat(250),sourceQuote:'It really has to be finished by the end of October'},
      crewSizeMention:{people:2.5,mention:'two guys',sourceQuote:'maybe two guys for about four and a half hours'},
      urgency:'soon',timeOfDay:{dayParts:[],sourceQuote:'mornings are better than afternoons'}}),text);
    const sc=result.schedulingConstraints!;
    expect(sc.unavailableMentions).toHaveLength(10);expect(sc.unavailableMentions.map(item=>item.mention)).toEqual(many.slice(0,10).map(item=>item.mention));
    // Only the known keys are read: a date the model added is not kept, and nothing else about the mention changes.
    expect(sc.notBeforeMention).toEqual(quoted('until after next week','We cannot do anything until after next week'));
    expect([sc.notAfterMention,sc.crewSizeMention,sc.urgency,sc.timeOfDay]).toEqual([null,null,null,null]);
    expect(result.validation.droppedSchedulingConstraints).toBe(3+4);
  });
  it('treats output without the constraints object as never extracted, and missing members as not stated',()=>{
    const {schedulingConstraints:_,...without}=output();
    for(const raw of [without,{...without,schedulingConstraints:null},{...without,schedulingConstraints:'next week'}])expect(validateConversationOutput(raw,transcript,meta)!.schedulingConstraints).toBeNull();
    const partial=validated({notBeforeMention:quoted('until after next week','We cannot do anything until after next week')});
    expect(partial.schedulingConstraints).toEqual({...empty,notBeforeMention:quoted('until after next week','We cannot do anything until after next week')});
    expect(partial.validation.droppedSchedulingConstraints).toBe(0);
  });
  it('never reaches the reviewed walkthrough scope the Hub stores, so no AI date or crew hint becomes customer-facing',()=>{
    const scoped=validateConversationOutput({...output(),scope:{garageSize:'unknown',junkVolumeYards:null,itemsRemove:[],itemsKeep:[],itemsRelocate:[],storageRequirements:[],bikeRacks:0,toolRacks:0,shelving:[],pressureWashing:false,pestObservations:[],activeInfestation:null,accessNotes:null,estimatedLaborHours:null,customerPreferences:[],customerObjections:[],salesNotes:[],crewNotes:[],pricingNotes:[],evidence:[]}},transcript,meta)!;
    const legacy=walkthroughExtractionFromConversation(scoped),text=JSON.stringify(legacy);
    expect(legacy).not.toHaveProperty('schedulingConstraints');
    for(const words of ['next week','end of October','two guys','Fridays','no rush'])expect(text).not.toContain(words);
  });
});

describe('resolving date words against walkthroughVisit.startedAt',()=>{
  it('resolves the example visit against its Start, never its upload time, and passes the hints through unchanged',()=>{
    const extraction=validated(constraints());
    expect(extraction.occurredAt).toBe('2026-10-13T15:00:00.000Z');
    const resolved=walkthroughSchedulingConstraints(extraction,outcome(LATE_MONDAY))!;
    expect(resolved.anchor).toEqual({source:'walkthrough_started',startedAt:LATE_MONDAY,date:'2026-10-05',timeZone:'America/Denver',flagged:false,reason:null});
    expect(resolved.notBefore).toEqual({...constraints().notBeforeMention,resolution:'resolved',date:'2026-10-19',candidates:[],approximate:false,reason:null});
    expect(resolved.notAfter).toMatchObject({resolution:'resolved',date:'2026-10-31'});
    expect(resolved.unavailable.map(item=>[item.resolution,item.from,item.to,item.weekdays])).toEqual([['resolved','2026-10-19','2026-10-25',[]],['resolved',null,null,['friday']]]);
    expect([resolved.preferredWeekdays,resolved.timeOfDay,resolved.crewSizeMention,resolved.durationHoursMention,resolved.urgency]).toEqual([constraints().preferredWeekdays,constraints().timeOfDay,constraints().crewSizeMention,constraints().durationHoursMention,constraints().urgency]);
    expect(resolved.flags).toEqual([]);
    // Counted from the upload (Tuesday 13 October) "after next week" would be 26 October.
    expect(notBefore('until after next week',at(context.occurredAt)).date).toBe('2026-10-26');
    resolved.preferredWeekdays!.weekdays.push('sunday');expect(extraction.schedulingConstraints!.preferredWeekdays!.weekdays).toEqual(['tuesday','thursday']);
  });
  it('dates a Start after 23:00 Denver on its Denver day, not the UTC one',()=>{
    const monday=at(LATE_MONDAY);
    expect(monday.date).toBe('2026-10-05');
    expect(['tomorrow','the day after tomorrow','Thursday','next week','this weekend','the 15th','in two weeks','a week from today'].map(words=>{const item=away(words,monday);return`${item.from}..${item.to}`;}))
      .toEqual(['2026-10-06..2026-10-06','2026-10-07..2026-10-07','2026-10-08..2026-10-08','2026-10-12..2026-10-18','2026-10-10..2026-10-11','2026-10-15..2026-10-15','2026-10-19..2026-10-19','2026-10-12..2026-10-12']);
    // Sunday 4 October 23:30 MDT is Monday in UTC: next week is the one starting the next day.
    const sunday=at('2026-10-05T05:30:00.000Z');
    expect([sunday.date,away('next week',sunday).from,away('next week',sunday).to,notBefore('tomorrow',sunday).date]).toEqual(['2026-10-04','2026-10-05','2026-10-11','2026-10-05']);
    // 23:59:59.999 on 31 December is already the new year in UTC.
    const newYearsEve=at('2027-01-01T06:59:59.999Z');
    expect([newYearsEve.date,notBefore('tomorrow',newYearsEve).date,notBefore('January 5',newYearsEve).date,away('next month',newYearsEve).from,away('next month',newYearsEve).to]).toEqual(['2026-12-31','2027-01-01','2027-01-05','2027-01-01','2027-01-31']);
  });
  it('uses the Denver offset in force at the Start on both daylight-saving change days',()=>{
    // Spring forward, Sunday 8 March 2026 (02:00 MST becomes 03:00 MDT).
    expect(at('2026-03-09T05:30:00.000Z').date).toBe('2026-03-08');
    expect(at('2026-03-09T06:30:00.000Z').date).toBe('2026-03-09');
    const springSunday=at('2026-03-09T05:30:00.000Z');
    expect([notBefore('tomorrow',springSunday).date,away('next week',springSunday).from,away('next week',springSunday).to,notBefore('after the 10th',springSunday).date]).toEqual(['2026-03-09','2026-03-09','2026-03-15','2026-03-11']);
    // Fall back, Sunday 1 November 2026 (02:00 MDT becomes 01:00 MST); 01:30 happens twice.
    expect([at('2026-11-01T07:30:00.000Z').date,at('2026-11-01T08:30:00.000Z').date,at('2026-11-02T06:30:00.000Z').date,at('2026-11-02T07:30:00.000Z').date]).toEqual(['2026-11-01','2026-11-01','2026-11-01','2026-11-02']);
    const fallSunday=at('2026-11-02T06:30:00.000Z');
    expect([notBefore('tomorrow',fallSunday).date,away('next week',fallSunday).from,away('next week',fallSunday).to,away('this weekend',fallSunday).candidates[0]]).toEqual(['2026-11-02','2026-11-02','2026-11-08',{from:'2026-11-01',to:'2026-11-01'}]);
    // Counting across a change never shifts a day.
    const friday=at('2026-10-30T18:00:00.000Z');
    expect([notBefore('in two weeks',friday).date,notBefore('next Friday',friday).date,away('next week',friday).from]).toEqual(['2026-11-13','2026-11-06','2026-11-02']);
    const beforeSpring=at('2026-03-06T18:00:00.000Z');
    expect([away('next week',beforeSpring).from,notBefore('in 3 days',beforeSpring).date]).toEqual(['2026-03-09','2026-03-09']);
  });
  it('keeps both readings of words people use two ways, for a person to pick',()=>{
    const monday=at(LATE_MONDAY),wednesday=at('2026-10-07T18:00:00.000Z');
    expect(notBefore('next Tuesday',monday)).toMatchObject({resolution:'ambiguous',date:null,candidates:['2026-10-06','2026-10-13']});
    expect(notBefore('next Tuesday',wednesday)).toMatchObject({resolution:'resolved',date:'2026-10-13'});
    expect(notBefore('Monday',monday).candidates).toEqual(['2026-10-05','2026-10-12']);expect(notBefore('this coming Monday',monday).date).toBe('2026-10-12');
    expect(away('next weekend',monday)).toMatchObject({resolution:'ambiguous',candidates:[{from:'2026-10-10',to:'2026-10-11'},{from:'2026-10-17',to:'2026-10-18'}]});
    expect(away('next weekend',at('2026-10-10T18:00:00.000Z'))).toMatchObject({resolution:'resolved',from:'2026-10-17',to:'2026-10-18'});
    // "By next week" may mean before it starts or before it ends; "by the end of October" names its last day.
    expect(notAfter('by next week',monday)).toMatchObject({resolution:'ambiguous',candidates:['2026-10-12','2026-10-18']});
    expect([notAfter('by the end of October',monday).date,notAfter('before the 15th',monday).date,notAfter('no later than Friday',monday).date,notAfter('within two weeks',monday).date,notAfter('the last day of the month',monday).date])
      .toEqual(['2026-10-31','2026-10-14','2026-10-09','2026-10-19','2026-10-31']);
    expect([notBefore('starting next week',monday).date,notBefore('not until after the 20th',monday).date,notBefore('the 20th or later',monday).date,notBefore('the first week of November',monday).date,notBefore('mid November',monday).date])
      .toEqual(['2026-10-12','2026-10-21','2026-10-20','2026-11-01','2026-11-11']);
    expect(notBefore('around the 15th',monday)).toMatchObject({resolution:'resolved',date:'2026-10-15',approximate:true});
  });
  it('leaves words it cannot read with certainty unresolved, with the reason and the quote',()=>{
    const monday=at(LATE_MONDAY);
    const reasons=([['before Thanksgiving','unsupported_expression'],['sometime after the holidays','unsupported_expression'],['October 1','date_in_past'],['Tuesday the 14th','weekday_mismatch'],['February 30','invalid_date'],['Tuesdays','recurring_not_a_date']] as const)
      .map(([words])=>{const item=notBefore(words,monday);return[words,item.resolution,item.reason,item.date,item.sourceQuote];});
    expect(reasons).toEqual([['before Thanksgiving','unresolved','unsupported_expression',null,'before Thanksgiving'],['sometime after the holidays','unresolved','unsupported_expression',null,'sometime after the holidays'],
      ['October 1','unresolved','date_in_past',null,'October 1'],['Tuesday the 14th','unresolved','weekday_mismatch',null,'Tuesday the 14th'],['February 30','unresolved','invalid_date',null,'February 30'],['Tuesdays','unresolved','recurring_not_a_date',null,'Tuesdays']]);
    expect(notAfter('Thanksgiving',monday)).toMatchObject({resolution:'unresolved',reason:'unsupported_expression'});
    expect([notBefore('by Friday',monday).reason,notAfter('after next week',monday).reason,away('within a week',monday).reason]).toEqual(['direction_conflict','direction_conflict','direction_conflict']);
    expect([notBefore('Tuesday the 13th',monday).date,notBefore('October 20',monday).date,notBefore('12/1',monday).date,notBefore('March',monday).date,away('Tuesdays',monday).weekdays,away('weekends',monday).weekdays])
      .toEqual(['2026-10-13','2026-10-20','2026-12-01','2027-03-01',['tuesday'],['saturday','sunday']]);
    const all=resolveSchedulingConstraints(only({notBeforeMention:quoted('after the 20th','after the 20th'),notAfterMention:quoted('by the 10th','by the 10th'),unavailableMentions:[quoted('before Thanksgiving','before Thanksgiving'),quoted('next Tuesday','next Tuesday')]}),monday)!;
    expect(all.flags).toEqual(['mention_ambiguous','mention_unresolved','window_conflict']);
  });
  it('falls back to the scheduled date, flagged, when the visit was never Started; with neither, only dates with a year resolve',()=>{
    const standalone=schedulingAnchorFromOutcome(outcome(null,'2026-10-07'));
    expect(standalone).toEqual({source:'scheduled_date',startedAt:null,date:'2026-10-07',timeZone:'America/Denver',flagged:true,reason:'walkthrough_not_started'});
    const resolved=walkthroughSchedulingConstraints(validated(constraints()),outcome(null,'2026-10-07'))!;
    expect([resolved.notBefore!.date,resolved.notAfter!.date,resolved.flags]).toEqual(['2026-10-19','2026-10-31',['anchor_scheduled_date']]);
    for(const item of [null,undefined,{},{startedAt:'yesterday',occurrence:{date:'2026-02-30'}},{startedAt:'2026-10-05',occurrence:null},{eventId:'x',detail:'event_only',startedAt:null,occurrence:{number:1,date:null,time:null,startAt:null}}])
      expect(schedulingAnchorFromOutcome(item)).toMatchObject({source:'none',date:null,flagged:true,reason:'anchor_unknown'});
    const unknown=schedulingAnchorFromOutcome(null),blind=resolveSchedulingConstraints(only({notBeforeMention:quoted('next week','next week'),notAfterMention:quoted('December 4 2026','December 4 2026'),unavailableMentions:[quoted('Fridays','Fridays'),quoted('the week of October 12 2026','the week of October 12 2026')]}),unknown)!;
    expect([blind.notBefore!.reason,blind.notAfter!.date,blind.unavailable.map(item=>[item.from,item.to,item.weekdays])]).toEqual(['anchor_unknown','2026-12-04',[[null,null,['friday']],['2026-10-12','2026-10-18',[]]]]);
    expect(blind.flags).toEqual(['anchor_unknown','mention_unresolved']);
    // A later startedAt from the same occurrence wins over the scheduled date.
    expect(schedulingAnchorFromOutcome(outcome('2026-10-08T15:00:00.000Z','2026-10-07')).date).toBe('2026-10-08');
    expect(resolveSchedulingConstraints(only({crewSizeMention:{people:2,mention:'two guys',sourceQuote:'two guys'}}),unknown)!.flags).toEqual([]);
  });
  it('reads "the end of" a month as its last day in every direction, and never as the 21st alone',()=>{
    const monday=at(LATE_MONDAY);
    // "Before" the end of October is the same day as "by" it; "before the last day" is the day before that day.
    expect(['by the end of October','before the end of October','before the end of the month','the end of October','the last day of the month','before the last day of the month'].map(words=>notAfter(words,monday)).map(item=>[item.resolution,item.date]))
      .toEqual([['resolved','2026-10-31'],['resolved','2026-10-31'],['resolved','2026-10-31'],['resolved','2026-10-31'],['resolved','2026-10-31'],['resolved','2026-10-30']]);
    // "Not until the end of the month" may mean its last days or its last day: a person picks.
    for(const words of ['not until the end of the month','starting at the end of October','the end of the month'])
      expect(notBefore(words,monday),words).toMatchObject({resolution:'ambiguous',date:null,candidates:['2026-10-21','2026-10-31']});
    expect(notBefore('after the end of October',monday).date).toBe('2026-11-01');
    // Away before the end of the month rules out every day to the 31st, so FUN-11 never offers 21-30 October.
    expect(away('before the end of the month',monday)).toMatchObject({resolution:'resolved',from:'2026-10-05',to:'2026-10-31'});
    expect(away('before the end of October',monday)).toMatchObject({from:'2026-10-05',to:'2026-10-31'});
    expect(away('the end of the month',monday)).toMatchObject({resolution:'resolved',from:'2026-10-21',to:'2026-10-31'});
    expect(away('from the end of the month',monday)).toMatchObject({resolution:'ambiguous',candidates:[{from:'2026-10-21',to:null},{from:'2026-10-31',to:null}]});
    expect(away('before the 15th',monday)).toMatchObject({from:'2026-10-05',to:'2026-10-14'});
    // Said inside the end of the month, the end starts today.
    expect(notBefore('not until the end of the month',at('2026-10-25T18:00:00.000Z')).candidates).toEqual(['2026-10-25','2026-10-31']);
  });
  it('treats a month, or a date in it, that ended up to 60 days back as said about the past, never as next year',()=>{
    const monday=at(LATE_MONDAY);
    const past=['after September','by the end of September','the first week of September','the last week of September','September','early September','August','August 5','September 30','the last day of September'];
    expect(past.map(words=>[words,notBefore(words,monday).reason,notBefore(words,monday).date])).toEqual(past.map(words=>[words,'date_in_past',null]));
    expect(notAfter('by the end of September',monday)).toMatchObject({resolution:'unresolved',reason:'date_in_past'});
    expect(away('the first week of September',monday)).toMatchObject({resolution:'unresolved',reason:'date_in_past'});
    // Further back is next year's; this month and "next <month>" are unchanged.
    expect(['July','July 31','March 15','next September','October','next October','the end of October'].map(words=>notBefore(words,monday)).map(item=>item.date??item.candidates))
      .toEqual(['2027-07-01','2027-07-31','2027-03-15','2027-09-01','2026-10-05','2027-10-01',['2026-10-21','2026-10-31']]);
    // Across the new year: December said on 5 January ended five days before.
    const january=at('2027-01-05T18:00:00.000Z');
    expect(['December','December 20','the first week of December','November'].map(words=>notBefore(words,january).reason)).toEqual(['date_in_past','date_in_past','date_in_past','date_in_past']);
    expect(['next December','October','January 20','December 20 2027'].map(words=>notBefore(words,january).date)).toEqual(['2027-12-01','2027-10-01','2027-01-20','2027-12-20']);
    // A day of the month up to a week back is about the past; earlier in the month it is next month's.
    expect([notBefore('the 4th',monday).reason,notBefore('the 1st',monday).reason,notBefore('the 5th',monday).date,notBefore('the 30th',monday).date]).toEqual(['date_in_past','date_in_past','2026-10-05','2026-10-30']);
    const late=at('2026-10-20T18:00:00.000Z');
    expect([notBefore('the 13th',late).reason,notBefore('the 12th',late).date,notBefore('the 3rd',late).date]).toEqual(['date_in_past','2026-11-12','2026-11-03']);
  });
  it('reads a date range as one unavailable span, and keeps direction words that are not a range',()=>{
    const monday=at(LATE_MONDAY);
    const ranges=['the 19th to the 23rd','October 19 through 23','Oct 19-23','from the 19th to the 23rd','between the 19th and the 23rd','19th-23rd','10/19-10/23','Monday the 19th thru Friday the 23rd','the 19th till the 23rd'];
    expect(ranges.map(words=>{const item=away(words,monday);return[words,item.resolution,item.from,item.to];})).toEqual(ranges.map(words=>[words,'resolved','2026-10-19','2026-10-23']));
    expect(['the 28th to the 3rd','October 28 to November 3','December 28 to January 3','a week to ten days','tomorrow through Friday'].map(words=>{const item=away(words,monday);return`${item.from}..${item.to}`;}))
      .toEqual(['2026-10-28..2026-11-03','2026-10-28..2026-11-03','2026-12-28..2027-01-03','2026-10-12..2026-10-15','2026-10-06..2026-10-09']);
    expect(away('Monday to Friday',at('2026-10-07T18:00:00.000Z'))).toMatchObject({resolution:'resolved',from:'2026-10-12',to:'2026-10-16'});
    expect(away('Monday to Friday',monday)).toMatchObject({resolution:'ambiguous',candidates:[{from:'2026-10-05',to:'2026-10-09'},{from:'2026-10-12',to:'2026-10-16'}]});
    expect([away('the 23rd to the 19th',monday).reason,away('Monday the 19th to Friday the 22nd',monday).reason,away('10-19',monday).reason,away('the 19th to whenever',monday).reason])
      .toEqual(['invalid_date','weekday_mismatch','unsupported_expression','unsupported_expression']);
    expect([away('not until the 20th',monday).from,away('not until the 20th',monday).to,away('up to the 23rd',monday).to,notBefore('the 19th to the 23rd',monday).date]).toEqual(['2026-10-20',null,'2026-10-23','2026-10-19']);
    expect(notAfter('the 19th to the 23rd',monday)).toMatchObject({resolution:'ambiguous',candidates:['2026-10-19','2026-10-23']});
  });
  it('keeps both readings of "next <weekday>" a day or two ahead, and of "this weekend" said on a Sunday',()=>{
    const friday=at('2026-10-09T18:00:00.000Z'),saturday=at('2026-10-10T18:00:00.000Z'),sunday=at('2026-10-11T18:00:00.000Z');
    expect([notBefore('next Monday',sunday).candidates,notBefore('next Monday',saturday).candidates,notBefore('next Tuesday',sunday).candidates]).toEqual([['2026-10-12','2026-10-19'],['2026-10-12','2026-10-19'],['2026-10-13','2026-10-20']]);
    expect([notBefore('next Monday',friday).date,notBefore('next Wednesday',sunday).date]).toEqual(['2026-10-12','2026-10-14']);
    for(const words of ['this weekend','the weekend'])expect(away(words,sunday),words).toMatchObject({resolution:'ambiguous',candidates:[{from:'2026-10-11',to:'2026-10-11'},{from:'2026-10-17',to:'2026-10-18'}]});
    expect(away('this coming weekend',sunday)).toMatchObject({resolution:'resolved',from:'2026-10-17',to:'2026-10-18'});
    expect([away('this weekend',saturday).from,away('this weekend',saturday).to,away('this weekend',friday).from]).toEqual(['2026-10-10','2026-10-11','2026-10-10']);
  });
  it('resolves an unparsed shape without throwing: missing constraints are not stated and malformed mentions are skipped',()=>{
    const monday=at(LATE_MONDAY),partial={notBeforeMention:quoted('tomorrow','tomorrow')} as unknown as SchedulingConstraints;
    expect(resolveSchedulingConstraints(partial,monday)).toMatchObject({notBefore:{date:'2026-10-06'},notAfter:null,unavailable:[],preferredWeekdays:null,urgency:null,flags:[]});
    const odd={...empty,notAfterMention:{mention:3},unavailableMentions:'next week'} as unknown as SchedulingConstraints;
    expect(resolveSchedulingConstraints(odd,monday)).toMatchObject({notAfter:null,unavailable:[]});
    const mixed={...empty,unavailableMentions:[null,{mention:'Fridays'},quoted('Fridays','Fridays')]} as unknown as SchedulingConstraints;
    expect(resolveSchedulingConstraints(mixed,monday)!.unavailable.map(item=>item.weekdays)).toEqual([['friday']]);
    expect(resolveSchedulingConstraints('next week' as unknown as SchedulingConstraints,monday)).toBeNull();
    expect(walkthroughSchedulingConstraints({schedulingConstraints:partial},outcome(LATE_MONDAY))!.notBefore!.date).toBe('2026-10-06');
  });
  it('reads no clock: the same inputs give the same dates years later',()=>{
    const before=walkthroughSchedulingConstraints(validated(constraints()),outcome(LATE_MONDAY));
    vi.useFakeTimers();vi.setSystemTime(new Date('2031-06-15T12:00:00.000Z'));
    expect(walkthroughSchedulingConstraints(validated(constraints()),outcome(LATE_MONDAY))).toEqual(before);
    expect(notBefore('next week',at(LATE_MONDAY)).date).toBe('2026-10-12');
  });
});

describe('spoken values',()=>{
  it('finds the weekdays, parts of the day, urgency and numbers words say',()=>{
    expect([...spokenWeekdays('Tues or Thurs, and weekends')]).toEqual(['tuesday','thursday','saturday','sunday']);
    expect([...spokenWeekdays('weekdays only')]).toEqual(['monday','tuesday','wednesday','thursday','friday']);
    expect([...spokenWeekdays(SCHEDULING_WEEKDAYS.join(' '))]).toEqual([...SCHEDULING_WEEKDAYS]);
    expect([...spokenDayParts('first thing, before 10 a.m.')]).toEqual(['morning']);
    expect([...spokenDayParts('after lunch or 3pm')]).toEqual(['midday','afternoon','evening']);
    expect([...spokenDayParts('after work')]).toEqual(['evening']);
    expect([...spokenDayParts('I am free Tuesday')]).toEqual([]);
    expect([...spokenUrgencies('no rush, it is not urgent')]).toEqual(['flexible']);
    expect([...spokenUrgencies('as soon as possible please')]).toEqual(['asap','soon']);
    expect([...spokenUrgencies('pretty soon')]).toEqual(['soon']);
    expect([...spokenNumbers('two guys for about four and a half hours')].sort()).toEqual([2,4.5]);
    expect([...spokenNumbers('an hour and a half, or 1.5 hrs')]).toEqual([1.5]);
    expect([...spokenNumbers('half an hour')]).toEqual([0.5]);
    expect([...spokenNumbers('a couple of guys')]).toEqual([2]);
    expect([...spokenNumbers('twenty one boxes and 3 people')].sort((a,b)=>a-b)).toEqual([3,21]);
    expect([...spokenNumbers('a few guys for half a day')]).toEqual([]);
    expect([...spokenNumbers('someone for a whole day')]).toEqual([]);
  });
  it('does not read negated urgency, day parts or ordinary words as support',()=>{
    for(const text of ["it's not an emergency",'not super urgent',"there's no need to rush","don't rush it",'no big hurry','not in a big rush',"we don't want to be rushed",'Not urgently, whenever works'])
      expect([...spokenUrgencies(text)],text).toEqual(['flexible']);
    // A negation ends at punctuation: "No, it's urgent" is urgent.
    for(const text of ["No, it's urgent",'No. We need it ASAP.','we need it done right away'])expect([...spokenUrgencies(text)],text).toEqual(['asap','soon']);
    expect([...spokenWeekdays('we sat down and the sun was out, wed like tuesdays')]).toEqual(['tuesday']);
    for(const [text,days] of [['Sat or Sun',['saturday','sunday']],['sat/sun',['saturday','sunday']],['Sat the 10th',['saturday']],['Wed 10/14',['wednesday']],['Sun morning',['sunday']],['mon and fri',['monday','friday']],['weds',['wednesday']]] as const)
      expect([...spokenWeekdays(text)],text).toEqual(days);
    for(const [text,parts] of [['early afternoon',['afternoon']],['early in the afternoon',['afternoon']],['not in the morning',[]],["can't do mornings",[]],['no early mornings',[]],['early next week',[]],['early October',[]],
      ['early is best',['morning']],['early morning',['morning']],['mornings, not afternoons',['morning']],['at 10 a.m.',['morning']],['not before noon',[]]] as const)
      expect([...spokenDayParts(text)],text).toEqual(parts);
  });
  it('the resolver weekday and day-part lists are the schema enums',()=>{
    expect(schedulingConstraintsSchema.shape.preferredWeekdays.unwrap().shape.weekdays.element.options).toEqual([...SCHEDULING_WEEKDAYS]);
    expect([...spokenDayParts('morning noon afternoon evening')]).toEqual([...SCHEDULING_DAY_PARTS]);
  });
});
