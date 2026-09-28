import type {ConversationExtraction} from '@egc/ai';
import {isMessageTaskKind} from '@egc/operations';
type Recording={id:string;portalJobId:string|null;portalVisitId:string|null};

/** Action Center task drafts for the v2 proposals of one visit recording (P3-02). Each keeps its P3-01 kind;
 * message kinds carry the suggested draft and internal kinds never carry one. Only staff set the owner, due
 * time, completion evidence and, for messages, the recipient, send window and attachment links (null here
 * and named in reviewRequired). Approving the recording creates the tasks; a message task still needs its
 * own draft approval and a human send, so nothing here is ever sent automatically.
 */
export function recordingTaskProposals(conversation:ConversationExtraction,recording:Recording){
  return conversation.proposedActions.map((action,index)=>{
    const message=isMessageTaskKind(action.kind),suggestion=action.draftSuggestion;
    const channel=suggestion?.channel??(action.requestedChannel==='email'?'email':'sms');
    return{index,
      task:{title:action.title,description:action.commitment,kind:action.kind,priority:'medium' as const,assignedUserId:null,dueAt:null,timeZone:'America/Denver',waitingOn:'none' as const,reviewAt:null,
        portalJobId:recording.portalJobId,portalVisitId:recording.portalVisitId,contactId:null,jobId:null,completionCondition:null,
        sourceEvidence:[{source:'recording' as const,id:recording.id,excerpt:action.sourceQuote}],dependencies:[] as string[],
        draft:message?{channel,recipient:null,subject:suggestion?.subject??'',body:suggestion?.body??'',sendWindowStart:null,sendWindowEnd:null,attachments:[] as never[]}:null},
      reviewRequired:['assignedUserId','dueAt','completionCondition',...(message?['draft.recipient','draft.sendWindowStart','draft.sendWindowEnd',...(suggestion?[]:['draft.body']),...action.attachmentsNeeded.map(kind=>`draft.attachments.${kind}`)]:[])],
      attachmentsNeeded:action.attachmentsNeeded,ownerMention:action.ownerMention,dueMention:action.dueMention,requestedChannel:action.requestedChannel,questionText:action.questionText,confidence:action.confidence};
  });
}
