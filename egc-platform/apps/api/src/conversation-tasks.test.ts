import {describe,it,expect} from 'vitest';
import {conversationExtractionSchema,CONVERSATION_ACTION_KINDS} from '@egc/ai';
import {createTaskSchema,isMessageTaskKind,MESSAGE_TASK_KINDS} from '@egc/operations';
import {recordingTaskProposals} from './conversation-tasks.js';
const recording={id:'5f0c3c1e-6a53-4f3e-9d5b-2f6f6f0f9a11',portalJobId:'visit-synthetic',portalVisitId:'visit-synthetic'};
const base={ownerMention:null,dueMention:null,requestedChannel:null,draftSuggestion:null,attachmentsNeeded:[],questionText:null,confidence:.9};
const conversation=()=>conversationExtractionSchema.parse({version:2,sourceKind:'visit_recording',occurredAt:'2026-09-22T12:00:00.000Z',model:'gpt-synthetic',catalogVersion:null,scope:null,catalogMentions:[],preferences:[],
  validation:{droppedProposedActions:0,droppedCatalogMentions:0,droppedPreferences:0,droppedEvidence:0,clearedCatalogItemIds:0,clearedMentions:0,clearedDraftSuggestions:0},
  proposedActions:[
    {...base,kind:'send_quote',title:'Text the quote',commitment:'Text the customer the quote',sourceQuote:'I will text you the quote by Friday',ownerMention:'Tyler',dueMention:'by Friday',requestedChannel:'sms',draftSuggestion:{channel:'sms',subject:null,body:'Hi, here is your quote.'},attachmentsNeeded:['portal_quote']},
    {...base,kind:'send_before_afters',title:'Send photos',commitment:'Email before and after photos',sourceQuote:'Send me the before and after photos',requestedChannel:'email'},
    {...base,kind:'callback',title:'Call back',commitment:'Call back after 5',sourceQuote:'Call me back after 5 about timing',requestedChannel:'call'},
    {...base,kind:'schedule_job',title:'Schedule',commitment:'Schedule the job',sourceQuote:'get you on the schedule',dueMention:'the first week of October'}]});
const staff={assignedUserId:'synthetic-manager',dueAt:'2026-09-25T16:00:00.000Z',completionCondition:'Customer confirms receipt'};
const window={recipient:'+19705550142',sendWindowStart:'2026-09-23T15:00:00.000Z',sendWindowEnd:'2026-09-23T23:00:00.000Z'};

describe('recording task proposals (EGC_EXTRACTION_V2)',()=>{
  it('keep each P3-01 kind, carry drafts only on message kinds and leave every staff decision unset',()=>{
    const proposals=recordingTaskProposals(conversation(),recording);
    expect(proposals.map(p=>p.task.kind)).toEqual(['send_quote','send_before_afters','callback','schedule_job']);
    expect(proposals[0]!.task.draft).toEqual({channel:'sms',recipient:null,subject:'',body:'Hi, here is your quote.',sendWindowStart:null,sendWindowEnd:null,attachments:[]});
    expect(proposals[1]!.task.draft).toMatchObject({channel:'email',body:''});
    expect(proposals[2]!.task.draft).toBeNull();expect(proposals[3]!.task.draft).toBeNull();
    for(const p of proposals){
      expect(p.task).toMatchObject({assignedUserId:null,dueAt:null,completionCondition:null,contactId:null,jobId:null,portalJobId:'visit-synthetic',portalVisitId:'visit-synthetic',sourceEvidence:[{source:'recording',id:recording.id}]});
      expect(p.reviewRequired).toEqual(expect.arrayContaining(['assignedUserId','dueAt','completionCondition']));
      expect(p.task.sourceEvidence[0]!.excerpt).toBe(conversation().proposedActions[p.index]!.sourceQuote);
      expect(isMessageTaskKind(p.task.kind)).toBe(p.task.draft!==null);
    }
    expect(proposals[0]!.reviewRequired).toEqual(['assignedUserId','dueAt','completionCondition','draft.recipient','draft.sendWindowStart','draft.sendWindowEnd','draft.attachments.portal_quote']);
    expect(proposals[1]!.reviewRequired).toContain('draft.body');
    expect(proposals[3]).toMatchObject({dueMention:'the first week of October',ownerMention:null});
    expect(proposals[0]).toMatchObject({dueMention:'by Friday',ownerMention:'Tyler',attachmentsNeeded:['portal_quote'],requestedChannel:'sms'});
  });
  it('are not tasks until staff fill the owner, due time, evidence and message delivery details',()=>{
    for(const p of recordingTaskProposals(conversation(),recording))expect(createTaskSchema.safeParse(p.task).success,p.task.kind).toBe(false);
    const [quote,photos,callback]=recordingTaskProposals(conversation(),recording);
    const reviewed=createTaskSchema.parse({...quote!.task,...staff,draft:{...quote!.task.draft,...window,attachments:[{kind:'portal_quote',url:'https://easygaragecleaning.com/customer-portal?job=visit-synthetic',label:'Your quote',refId:null}]}});
    expect(reviewed).toMatchObject({kind:'send_quote',draft:{channel:'sms',body:'Hi, here is your quote.',recipient:'+19705550142'}});
    expect(createTaskSchema.safeParse({...photos!.task,...staff,draft:{...photos!.task.draft,...window,recipient:'synthetic@example.invalid'}}).success).toBe(false);
    expect(createTaskSchema.parse({...photos!.task,...staff,draft:{...photos!.task.draft,...window,recipient:'synthetic@example.invalid',body:'Here are the photos.'}}).kind).toBe('send_before_afters');
    expect(createTaskSchema.parse({...callback!.task,...staff})).toMatchObject({kind:'callback',draft:null});
    expect(createTaskSchema.safeParse({...callback!.task,...staff,draft:reviewed.draft}).success).toBe(false);
  });
  it('cover every conversation kind with the matching draft rule',()=>{
    const all=conversation();all.proposedActions=CONVERSATION_ACTION_KINDS.map(kind=>({...all.proposedActions[2]!,kind}));
    const proposals=recordingTaskProposals(conversationExtractionSchema.parse(all),recording);
    expect(proposals.filter(p=>p.task.draft).map(p=>p.task.kind)).toEqual([...MESSAGE_TASK_KINDS]);
    expect(proposals.map(p=>p.task.kind)).toEqual([...CONVERSATION_ACTION_KINDS]);
  });
});
