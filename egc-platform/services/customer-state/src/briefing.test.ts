import {it,expect} from 'vitest';
import {buildCanonicalEvents,buildReport,projectCustomer,type SourceRecord} from './core.js';
import {formatOperationalBriefing} from './briefing.js';

it('compact presentation preserves all business counts and original evidence lookup identity',()=>{
 const records:SourceRecord[]=Array.from({length:80},(_,i)=>({sourceType:'message',sourceRecordId:`message-${i}`,contactId:'customer',leadId:'lead',occurredAt:'2026-09-21T18:00:00Z',text:'Original source body',events:[{eventType:'human_outreach',confidence:1,humanReviewNeeded:false,nextAction:null,supportingText:'Original source body'}]}));
 const events=buildCanonicalEvents(records),customer=projectCustomer({contactId:'customer',leadId:'lead',leadCreatedAt:'2026-09-16T12:00:00Z',events});
 const full=buildReport({events,customers:[customer],since:'2026-09-16T00:00:00Z',until:'2026-09-22T00:00:00Z'}),brief= formatOperationalBriefing(full);
 for(const name of Object.keys(full.periodActivity)){expect(brief.periodActivity[name]?.count).toBe(full.periodActivity[name]?.count);expect(brief.periodActivity[name]?.contactIds).toEqual(full.periodActivity[name]?.contactIds);}
 expect(brief.cohort).toEqual(full.cohort);expect(brief.countedEvents).toHaveLength(40);expect(brief.countedEventsPage.nextOffset).toBe(40);expect(brief.customers[0]?.timelineEventCount).toBe(80);
 expect(brief.countedEvents[0]?.eventId).toBe(full.countedEvents[0]?.eventId);expect(brief.countedEvents[0]?.evidenceSources[0]?.sourceRecordId).toBe(full.countedEvents[0]?.evidence[0]?.sourceRecordId);
 expect(brief.evidenceRetrieval.since).toBe(full.period.since);expect(brief.customers[0]?.evidenceRetrieval.contactId).toBe('customer');
 expect(JSON.stringify(brief).length).toBeLessThan(JSON.stringify(full).length);
});

it('preserves a requested evidence limit smaller than the compact cap and a terminal page',()=>{
 const full=buildReport({events:[],customers:[],since:'2026-09-16T00:00:00Z',until:'2026-09-22T00:00:00Z'});
 const brief=formatOperationalBriefing({...full,countedEventsPage:{offset:8,limit:1,total:8,nextOffset:null}});
 expect(brief.countedEventsPage).toEqual({offset:8,limit:1,total:8,nextOffset:null});
 expect(brief.evidenceRetrieval).toMatchObject({limit:1,nextOffset:null,since:full.period.since,until:full.period.until});
 expect(brief.periodActivity).toMatchObject({jobsSold:{count:0,unit:'distinct_customers'}});
});
