// One contract per registered MCP tool, across legacy and Action Center (operations) mode. test/tool-contracts.test.ts
// fails when a registered tool has no entry here, when an entry names a tool that no longer exists, or when the
// registered annotations, scope, two-step path or observed side effect disagree with the entry.
export type ToolClass='read'|'write'|'destructive'|'send'|'money';
export type Scope='egc:read'|'egc:write';
/** The first observable side effect of a valid call. bridge/recordings: the command signed into the envelope sent to
 * /operations/rpc or /recordings/rpc; db: a statement against that table; provider: a GHL client method; service: a
 * mocked workspace service function; refused: the error returned before any effect; none: no external effect at all. */
export type Effect={bridge:string}|{recordings:string}|{db:'select'|'insert'|'update'|'delete';table:string}|{provider:string}|{service:string}|{refused:string}|{none:true};
export type Rows=Record<string,Record<string,unknown>[]>;
export type ModeContract={valid?:Record<string,unknown>;invalid?:unknown;effect?:Effect;rows?:Rows;blocked?:string};
export type ToolContract={class:ToolClass;scope:Scope;twoStep:boolean;valid:Record<string,unknown>;invalid:unknown;effect:Effect;rows?:Rows;legacy?:ModeContract;operations?:ModeContract};

export const CONTACT='3b1f7e0a-8d2c-4e5f-9a6b-7c8d9e0f1a2b',RECORD='ac178de9-8156-42b8-818c-83e21c12c099',REQUEST='3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f70';
const AT='2026-09-22T12:00:00.000Z',R:Scope='egc:read',W:Scope='egc:write';
const contact={id:CONTACT,provider:'ghl',providerId:'synthetic-ghl-contact',name:'Synthetic fixture',phone:'+15555550100',email:'synthetic@example.test',tags:['existing'],customFields:[],raw:{}};
const contacts={contacts:[contact]};
const LEGACY_DISABLED:ModeContract={blocked:'legacy_mutation_disabled_in_operations_mode'};
const SEND_PAUSED:ModeContract={blocked:'direct_send_disabled_in_operations_mode',effect:{refused:'direct_send_disabled_in_operations_mode'}};
const read=(valid:Record<string,unknown>,invalid:unknown,effect:Effect,extra:Partial<ToolContract>={}):ToolContract=>({class:'read',scope:R,twoStep:false,valid,invalid,effect,...extra});
const write=(valid:Record<string,unknown>,invalid:unknown,effect:Effect,extra:Partial<ToolContract>={}):ToolContract=>({class:'write',scope:W,twoStep:false,valid,invalid,effect,...extra});
const select=(table:string):Effect=>({db:'select',table});
const revision={taskId:RECORD,revision:1,requestId:REQUEST};
const portalRecord={requestId:REQUEST,portalJobId:'synthetic-job-1',expectedRevision:AT};

export const TOOL_CONTRACTS:Record<string,ToolContract>={
  // Registry (defineTool) tools.
  'egc.safety_policy':read({},{role:'owner'},{none:true}),
  'contacts.search':read({query:'Synthetic',limit:5},{limit:201},select('contacts')),
  'contacts.get':read({contactId:CONTACT},{contactId:'not-a-uuid'},select('contacts')),
  'leads.search':read({state:'BOOKED'},{state:'SOMETHING_ELSE'},select('leads')),
  'leads.get':read({leadId:CONTACT},{},select('leads')),
  'conversations.search':read({contactId:CONTACT},{},select('conversations')),
  'conversations.get':read({conversationId:CONTACT},{conversationId:CONTACT,messageLimit:501},select('conversations')),
  'calls.search':read({contactId:CONTACT,days:7},{days:0},select('calls')),
  'calls.get':read({callId:CONTACT},{callId:7},select('calls')),
  'opportunities.search':read({status:'open'},{status:'x'.repeat(51)},select('opportunities')),
  'opportunities.get':read({opportunityId:CONTACT},{},select('opportunities')),
  'appointments.search':read({daysPast:1,daysFuture:7},{daysFuture:731},select('appointments')),
  'jobs.search':read({status:'scheduled'},{limit:501},select('jobs')),
  'jobs.get':read({jobId:CONTACT},{jobId:'synthetic-job-1'},select('jobs')),
  'tasks.search':read({status:'open',jobId:CONTACT},{status:'done'},select('tasks')),
  'walkthroughs.search':read({status:'draft'},{limit:0},select('walkthroughs')),
  'walkthroughs.get':read({walkthroughId:CONTACT},{},select('walkthroughs')),
  // Pages the Hub overdue queue through the bridge; in legacy mode it is refused before any request.
  'egc.whats_overdue':read({owner:'owner-1',limit:5},{owner:'owner-1',limit:51},{bridge:'queue'}),

  // Operations bridge. In legacy mode every bridge call is refused with operations_not_enabled before any request.
  'egc.operations_status':read({},'not-an-object',{bridge:'status'}),
  'egc.operations_owners':read({},'not-an-object',{bridge:'portal.members'}),
  'egc.calendar':read({startDate:'2026-09-22',endDate:'2026-09-29'},{startDate:'09/22/2026',endDate:'2026-09-29'},{bridge:'calendar'}),
  'actions.queue':read({dueBefore:AT},{view:'mine',dueBefore:AT},{bridge:'queue'}),
  'actions.review':read({taskId:RECORD},{taskId:'synthetic'},{bridge:'task.get'}),
  'egc.daily_brief':read({},{briefId:'latest'},{bridge:'brief.latest'}),
  'egc.visit_get':read({portalVisitId:'synthetic-visit-1'},{portalVisitId:''},{bridge:'schedule.resolve'}),
  'actions.reconcile_inbound':write({requestId:REQUEST},{requestId:REQUEST,limit:201},{bridge:'inbound.reconcile'}),
  'actions.propose':write({requestId:REQUEST,task:{title:'Call back about the quote',assignedUserId:'owner-1',dueAt:AT,completionCondition:'Customer reached'}},{requestId:REQUEST,task:{title:''}},{bridge:'task.create'}),
  'actions.edit':write({...revision,changes:{priority:'high'}},{...revision,changes:{}},{bridge:'task.edit'}),
  'actions.snooze':write({...revision,until:AT,reason:'Customer asked for Friday'},{...revision,revision:0,until:AT,reason:'Customer asked'},{bridge:'task.snooze'}),
  'actions.complete':write({...revision,outcome:'Called back and confirmed'},{...revision,outcome:'ok'},{bridge:'task.complete'}),
  'actions.cancel':write({...revision,reason:'Duplicate action'},{...revision,reason:'x'},{bridge:'task.cancel'}),
  'egc.generate_brief':write({requestId:REQUEST,dueBefore:AT},{requestId:REQUEST},{bridge:'brief.create'}),
  'egc.add_job_note':write({...portalRecord,body:'Synthetic crew note'},{...portalRecord,requestId:'retry-1',body:'Synthetic crew note'},{bridge:'portal.note.add'}),
  'egc.update_job_operations':write({...portalRecord,changes:{status:'dispatched'},reason:'Crew dispatched'},{...portalRecord,changes:{status:'paid'},reason:'Crew dispatched'},{bridge:'portal.job.edit'}),
  'egc.link_project':write(portalRecord,{portalJobId:'synthetic-job-1',expectedRevision:AT},{bridge:'portal.project.ensure'}),
  'egc.schedule_visit':write({requestId:REQUEST,mode:'create',portalCustomerId:'synthetic-customer-1',kind:'walkthrough',changes:{date:'2026-09-25',time:'09:00',endTime:'10:00'}},{requestId:REQUEST,mode:'delete',portalCustomerId:'synthetic-customer-1',changes:{}},{bridge:'schedule.mutate'}),
  'recordings.list':read({portalJobId:'synthetic-job-1'},{portalJobId:'not a portal id'},{recordings:'recording.list'}),
  'recordings.get':read({recordingId:RECORD},{recordingId:'synthetic'},{recordings:'recording.get'}),
  'recordings.retry':write({recordingId:RECORD,requestId:REQUEST},{recordingId:RECORD},{recordings:'recording.retry'}),
  'egc.followups_due':read({days:3},{limit:201},{service:'lead-audit.leadsNeedingContact'},{operations:{effect:{bridge:'queue'}}}),
  'egc.customer_history':read({contactId:CONTACT},{},select('contacts'),{operations:{valid:{portalJobId:'synthetic-job-1'},effect:{bridge:'history'}}}),
  'egc.job_brief':read({jobId:CONTACT},{jobId:'synthetic-job-1'},select('jobs'),{operations:{valid:{jobId:'synthetic-job-1'},invalid:{jobId:''},effect:{bridge:'portal.job'}}}),

  // Canonical customer state and Meta conversion services.
  'egc.operational_report':read({days:7},{days:0},{service:'customer-state.getCanonicalReport'}),
  'egc.operational_event_evidence':read({since:'2026-09-15T00:00:00Z',until:'2026-09-22T00:00:00Z'},{since:'last week',until:'today'},{service:'customer-state.getOperationalEventEvidence'}),
  'egc.customer_timeline':read({contactId:CONTACT},{},{service:'customer-state.getCustomerTimeline'}),
  'egc.customer_state_diagnostics':read({},'not-an-object',{service:'customer-state.getCustomerStateDiagnostics'}),
  'egc.reconcile_customer_state':write({contactIds:[CONTACT],useAI:false},{maxContacts:501},{service:'customer-state.reconcileCustomerState'}),
  'egc.record_user_confirmed_outcome':write({contactId:CONTACT,field:'jobSold',value:true,exactText:'Customer accepted the written quote',sourceReference:'call:synthetic-1'},{contactId:CONTACT,field:'jobSold',exactText:'no',sourceReference:'x'},{service:'customer-state.recordUserConfirmedOutcome'}),
  'egc.lead_conversion_funnel':read({days:30},{days:366},{service:'customer-state.getCanonicalReport'}),
  'egc.revenue_summary':read({days:30},{days:0},{service:'customer-state.getCanonicalReport'}),
  'egc.sales_rep_performance':read({days:30},{days:366},{service:'customer-state.getCanonicalReport'}),
  'egc.walkthrough_conversion':read({days:90},{days:0},{service:'customer-state.getCanonicalReport'}),
  'meta.conversions.preview':read({days:7},{days:91},{service:'meta-conversions.previewConversions'}),
  'meta.conversions.status':read({},{days:0},{service:'meta-conversions.conversionStatus'}),
  'meta.conversions.sync':write({days:7},{days:8},{service:'meta-conversions.syncConversions'}),
  'meta.conversions.retry':write({eventIds:[`egc_${'a'.repeat(64)}`]},{eventIds:['not-an-event']},{service:'meta-conversions.retryConversions'}),
  'meta.conversions.test':write({},{dryRun:false},{service:'meta-conversions.sendTestEvent'}),

  // Lead audit reads.
  'egc.leads_needing_contact':read({days:3},{days:91},{service:'lead-audit.leadsNeedingContact'}),
  'egc.leads_not_responding':read({days:3},{days:0},{service:'lead-audit.leadsNotResponding'}),
  'egc.recent_bookings':read({days:3},{days:91},{service:'lead-audit.recentBookings'}),
  'calls.transcript':read({contactId:CONTACT},{contactId:CONTACT,days:366},{service:'lead-audit.callTranscriptsForContact'}),

  // Postgres mirror reports and GHL reference reads.
  'walkthroughs.transcript':read({walkthroughId:CONTACT},{},select('walkthroughs')),
  'egc.tomorrows_jobs':read({},{timeZone:''},select('appointments')),
  'egc.unanswered_calls':read({days:7},{days:91},select('calls')),
  'egc.stale_opportunities':read({staleDays:7},{staleDays:0},select('opportunities')),
  'egc.sales_pipeline':read({status:'open'},{status:'closed'},select('opportunities')),
  'egc.jobs_by_status':read({},'not-an-object',select('jobs')),
  'egc.addon_attach_rates':read({days:90},{days:366},select('jobs')),
  'egc.routing_audit':read({days:14},{days:91},select('contacts')),
  'egc.system_alerts':read({},{futureDays:366},select('appointments')),
  'communications.executions':read({contactId:CONTACT},{limit:101},select('communication_executions')),
  'appointments.operation_status':read({operationId:RECORD},{},select('appointment_operations')),
  'ghl.pipelines':read({},'not-an-object',{provider:'getPipelines'}),
  'ghl.calendars':read({},'not-an-object',{provider:'getCalendars'}),
  'ghl.users':read({},'not-an-object',{provider:'getLocation'}),

  // Legacy Postgres/GHL writes. Several are disabled at the HTTP boundary in operations mode.
  'jobs.create':write({contactId:CONTACT},{contactId:'synthetic'},{db:'insert',table:'jobs'},{rows:contacts,operations:LEGACY_DISABLED}),
  'jobs.update':write({jobId:RECORD,changes:{status:'scheduled'}},{jobId:RECORD},{db:'update',table:'jobs'},{rows:{jobs:[{id:RECORD,contactId:CONTACT,status:'draft'}]},operations:LEGACY_DISABLED}),
  'jobs.add_note':write({jobId:RECORD,body:'Synthetic crew note'},{jobId:RECORD,body:''},{db:'insert',table:'job_notes'},{rows:{jobs:[{id:RECORD,contactId:CONTACT,status:'draft'}],...contacts},operations:LEGACY_DISABLED}),
  'walkthroughs.create_draft':write({contactId:CONTACT,extraction:{}},{contactId:CONTACT},{db:'insert',table:'walkthroughs'},{rows:contacts,operations:LEGACY_DISABLED}),
  'walkthroughs.update_draft':write({walkthroughId:RECORD,transcript:'Synthetic transcript'},{transcript:'Synthetic transcript'},{db:'update',table:'walkthroughs'},{rows:{walkthroughs:[{id:RECORD,contactId:CONTACT,status:'draft',extraction:{}}]},operations:LEGACY_DISABLED}),
  'walkthroughs.approve':write({walkthroughId:RECORD},{},select('walkthroughs'),{operations:LEGACY_DISABLED}),
  'tasks.create':write({title:'Synthetic task'},{title:''},{db:'insert',table:'tasks'},{operations:LEGACY_DISABLED}),
  'tasks.update':write({taskId:RECORD,changes:{status:'blocked'}},{taskId:RECORD,changes:{status:'done'}},{db:'update',table:'tasks'},{rows:{tasks:[{id:RECORD,title:'Synthetic',status:'open'}]},operations:LEGACY_DISABLED}),
  'tasks.complete':write({taskId:RECORD},{},{db:'update',table:'tasks'},{rows:{tasks:[{id:RECORD,title:'Synthetic',status:'open'}]},operations:LEGACY_DISABLED}),
  'contacts.create':write({contact:{firstName:'Synthetic'}},{contact:{email:'not-an-email'}},{provider:'upsertContact'}),
  'contacts.update':write({contactId:CONTACT,changes:{firstName:'Synthetic'}},{contactId:CONTACT},{provider:'updateContact'},{rows:contacts}),
  'contacts.add_tags':write({contactId:CONTACT,tags:['vip']},{contactId:CONTACT,tags:[]},{provider:'addContactTags'},{rows:contacts}),
  'contacts.remove_tags':write({contactId:CONTACT,tags:['existing']},{contactId:CONTACT,tags:['']},{provider:'removeContactTags'},{rows:contacts}),
  'opportunities.create':write({contactId:CONTACT,pipelineId:'synthetic-pipeline'},{contactId:CONTACT},{provider:'createOpportunity'},{rows:contacts}),
  'opportunities.update':write({opportunityId:RECORD,changes:{status:'won'}},{opportunityId:RECORD,changes:{status:'closed'}},{provider:'updateOpportunity'},{rows:{opportunities:[{id:RECORD,providerId:'synthetic-opportunity',contactId:CONTACT,status:'open'}]}}),
  'communications.reconcile':write({executionId:RECORD},{},select('communication_executions')),
  'actions.complete_from_message':write({requestId:REQUEST,taskId:RECORD,revision:1,executionId:RECORD},{requestId:REQUEST,taskId:RECORD,revision:0,executionId:RECORD},select('communication_executions')),
  // Provider booking writes need the exact Hub visit in operations mode and refuse before any request without it.
  'appointments.create':write({contactId:CONTACT,calendarId:'synthetic-calendar',startTime:AT},{contactId:CONTACT,calendarId:'',startTime:AT},{db:'insert',table:'appointment_operations'},{rows:contacts,operations:{effect:{refused:'schedule_portal_visit_required'}}}),
  'appointments.update':write({appointmentId:RECORD,changes:{title:'Synthetic visit'}},{appointmentId:RECORD},{db:'insert',table:'appointment_operations'},{rows:{appointments:[{id:RECORD,providerId:'synthetic-event',contactId:CONTACT,status:'confirmed',appointmentStartAt:AT,raw:{}}],...contacts},operations:{effect:{refused:'schedule_portal_visit_required'}}}),
  'appointments.cancel':write({appointmentId:RECORD},{appointmentId:'synthetic'},{db:'insert',table:'appointment_operations'},{rows:{appointments:[{id:RECORD,providerId:'synthetic-event',contactId:CONTACT,status:'confirmed',appointmentStartAt:AT,raw:{}}],...contacts},operations:{effect:{refused:'schedule_portal_visit_required'}}}),
  'appointments.reconcile':write({operationId:RECORD},{},select('appointment_operations')),
  'egc.ensure_booking':write({contactId:CONTACT,type:'walkthrough',startTime:AT},{contactId:CONTACT,type:'visit',startTime:AT},{provider:'getCalendars'}),
  'appointments.delete':{class:'destructive',scope:W,twoStep:false,valid:{appointmentId:RECORD},invalid:{appointmentId:RECORD,force:'yes'},effect:{provider:'deleteCalendarEvent'},rows:{appointments:[{id:RECORD,providerId:'synthetic-event',contactId:CONTACT,status:'confirmed',appointmentStartAt:AT,raw:{}}]},operations:LEGACY_DISABLED},

  // One-step customer sends. Paused in operations mode, where the handler also refuses before any read.
  'conversations.send_message':{class:'send',scope:W,twoStep:false,valid:{requestId:REQUEST,contactId:CONTACT,channel:'SMS',body:'Synthetic authorized message'},invalid:{requestId:REQUEST,contactId:CONTACT,channel:'Fax',body:'x'},effect:{db:'insert',table:'communication_executions'},rows:{...contacts,leads:[{contactId:CONTACT,doNotContact:false}]},operations:SEND_PAUSED},
  'send_sms':{class:'send',scope:W,twoStep:false,valid:{requestId:REQUEST,contactId:CONTACT,body:'Synthetic authorized message'},invalid:{requestId:REQUEST,contactId:CONTACT,body:''},effect:{db:'insert',table:'communication_executions'},rows:{...contacts,leads:[{contactId:CONTACT,doNotContact:false}]},operations:SEND_PAUSED},
  'egc.send_followup':{class:'send',scope:W,twoStep:false,valid:{requestId:REQUEST,contactId:CONTACT,body:'Synthetic authorized message',contextReviewed:true},invalid:{requestId:REQUEST,contactId:CONTACT,body:'Synthetic',contextReviewed:false},effect:{db:'insert',table:'communication_executions'},rows:{...contacts,leads:[{contactId:CONTACT,doNotContact:false}]},operations:SEND_PAUSED}
};

/** Tools whose class needs a preview and confirmation but that predate the two-step path. Shrink only; never add. */
export const LEGACY_ONE_STEP=['appointments.delete','conversations.send_message','send_sms','egc.send_followup'];
