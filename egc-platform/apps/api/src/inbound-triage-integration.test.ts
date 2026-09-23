import {describe, it, expect} from 'vitest';
import {inboundAction, inboundRequestId, type InboundPolicy} from './inbound-actions.js';

const policy: InboundPolicy = {authority:'employee_hub', inboundResponse:{enabled:true, ownerId:'test-owner', dueMinutes:60, ownerSource:'test', dueSource:'test', blockedReason:null}};
const message = {id:'synthetic-message', contactId:'synthetic-contact', occurredAt:new Date('2026-09-23T03:47:00Z'), body:'No worries & no rush'};

describe('acknowledgment triage through the real task constructor', () => {
  it('retains source, owner, deadline, dedupe and internal-only semantics', () => {
    const task = inboundAction(message, policy);
    expect(task).toMatchObject({kind:'review_notes', priority:'medium', assignedUserId:'test-owner', contactId:'synthetic-contact', dueAt:'2026-09-23T04:47:00.000Z', waitingOn:'EGC', draft:null, portalJobId:null, portalVisitId:null, dedupeKey:'inbound_reply:synthetic-message'});
    expect(task.sourceEvidence).toEqual([{source:'message', id:'synthetic-message', excerpt:message.body}]);
    expect(task.completionCondition).toContain('does not prove delivery');
    expect(inboundRequestId(message.id)).toBe(inboundRequestId(message.id));
  });
  it('does not downrank a request just because it starts politely', () => {
    expect(inboundAction({...message, body:'No rush, but please send the photos'}, policy)).toMatchObject({priority:'high', title:'Review and respond to customer reply'});
  });
  it('still rejects unresolved authority and owner policy', () => {
    expect(() => inboundAction(message, {...policy, inboundResponse:{...policy.inboundResponse, ownerId:null}})).toThrow('inbound_policy_unresolved');
  });
});
