/** Native Hub dispatch API. Session cookie, same-origin JSON, manager/owner only.
 * GET /api/dispatch?startDate=2026-09-22&endDate=2026-09-29&includeUnscheduled=true
 *   endDate is EXCLUSIVE. Missing range defaults to today + 7 Denver calendar days.
 *   => {ok, timeZone:'America/Denver', jobs:[DispatchJob], roster:[{id,name,role}],
 *       crews:[{id,revision,name,memberIds,leadId,status}],
 *       vehicles:[{id,revision,name,status,notes}],
 *       availability:[{id,revision,employeeId,date,endDate,time,endTime,allDay,reason,status}],
 *       warnings:[{code,jobId,message,...}], coverage:{complete,asOf},startDate,endDate,
 *       arrivalDefaults:{enabled:boolean,minutes:integer},segments:{enabled:boolean,max:31}}
 *   arrivalDefaults says whether blank arrival windows get a derived default
 *   (EGC_DISPATCH_DEFAULT_ARRIVAL_WINDOW_ENABLED) and its length; no secrets.
 * GET /api/dispatch?view=customers&q=phone-or-name
 *   => {ok,customers:[{id,name,phone,email,address}],total}; at most 50 results.
 * GET /api/dispatch?view=job&jobId=exact-ID
 *   => {ok,job:DispatchJob,roster,crews,vehicles,warnings,arrivalDefaults,segments}; no date-range filter.
 *
 * POST /api/dispatch always requires requestId = crypto.randomUUID(). Keep the
 * SAME requestId and unchanged body when retrying a lost/network response.
 * {action:'schedule.create',requestId,customerId,kind:'job'|'walkthrough',changes,
 *  sourceWalkthroughId?: existing ID,sourceTemplateJobId?: existing job ID,
 *  sourceJobId?: existing job ID}
 * sourceTemplateJobId and sourceWalkthroughId are mutually exclusive. A repeat
 * copies only operational instructions, materials/equipment, service and cadence;
 * it has a new project and never copies payments, acceptance, photos or execution.
 * sourceJobId selects only verified customer account/property lineage; it never
 * copies a quote, payment, collaborator, token or work scope. Exact customer IDs
 * and bounded root chains are required; multiple roots/history require selection.
 * 409 dispatch_lineage_selection_required details:{candidates:[{jobId,customerId,
 * customer,address,date,rootJobId?}],truncated}; max50 exact-customer candidates.
 * Property memory requires matching stable property IDs or matching full normalized
 * addresses. Different properties keep separate memory and return a warning.
 * {action:'schedule.create',requestId,kind:'blocked',changes:{date,time,endDate?,
 *  endTime,title?,opsNotes?,notes?}} creates a company-wide block without customer.
 * {action:'schedule.update'|'schedule.cancel'|'schedule.restore',requestId,
 *  jobId,expectedRevision,changes:{...},cancellationReason?:string(240)}
 * cancel requires changes:{}; only cancellation accepts cancellationReason.
 * FUN-02 (functions/_lib/dispatch-funnel.js; codes from the shared funnel
 * definitions, `funnel` on GET lists them): schedule.create of a customer visit
 * takes booking?:{channel?:'hub_phone'|'hub_in_person'|...,channelSelfReported?,
 * visitPurpose?:'service'|'install'|'return'|'rework'|'member_visit' (a job;
 * default 'service', a walkthrough is always 'walkthrough'),reworkOfJobId?
 * (required for, and only for, rework: an operational job of this customer,
 * whose project the visit joins),membershipId? (required for, and only for,
 * member_visit),crmLinkReason? (kept only when the visit has no CRM contact)},
 * saved as bookingChannel, channelSelfReported, bookedBy, visitPurpose,
 * reworkOfJobId, membershipId, crmLinkReason (400 dispatch_booking_*).
 * schedule.update and schedule.cancel take reasonCode? (reschedule or cancel
 * list; other_legacy is reserved) and initiatedBy?:'customer'|'company'|'system'
 * (400 dispatch_reason_code_invalid). A cancel saves cancellationReasonCode
 * (other_legacy when none was sent), cancellationInitiatedBy and lateCancel
 * (customer cancel within 24 h of the start; false for company or a visit never
 * placed; null when nobody said who asked or the saved start cannot be read).
 * {action:'schedule.no_show',requestId,jobId,expectedRevision,changes:{},
 *  reasonCode (noShow list, required)} marks a placed customer job no_show
 * from one hour before its start (409 dispatch_no_show_too_early /
 * dispatch_no_show_invalid; a walkthrough no-show is the walkthrough visit's
 * own outcome, 409 dispatch_no_show_walkthrough), saves noShowAt/noShowBy/
 * noShowReasonCode, frees its day locks and never changes the provider
 * appointment. It is final like a completion (the bridge cannot cancel it). Every visit change writes its
 * funnel events (walkthrough.booked / job.scheduled on first placement,
 * *.rescheduled with fromStartAt/toStartAt and the scheduleOccurrence counter,
 * *.cancelled, job.no_show, *.restored, job.assigned) in the same commit as the
 * visit and its receipt. GET view=customers adds crmLinked (boolean).
 * changes: date, time, endDate, endTime (all strings; all '' for unscheduled),
 * assignedCrew:string[] (canonical roster IDs), crewLead:string|null,
 * crewId:string|null, vehicleId:string|null, crewNeeded:integer 1..20,
 * travelBufferMinutes:integer 0..180, title, address, serviceType,
 * jobInstructions, accessInstructions, customerInstructions, opsNotes,
 * requiredEquipment:string[], materials:[{id,name,quantity:number}].
 * Also recurrence:'none'|'weekly'|'biweekly'|'monthly'|'quarterly',
 * reminderDays:integer1..30,notify:boolean,shiftPickupEnabled:boolean,notes:string.
 * Cadence and notification preferences are stored metadata, not a guarantee that
 * another visit or message has been created. Provider sync reports separately.
 * Server-owned repeats live in /api/recurring-plans (recurring-plan-service.js):
 * each generated visit is an ordinary schedule.create with sourceTemplateJobId
 * and a deterministic requestId, plus recurringPlanId/occurrenceDate (and
 * recurrenceConflict when saved unscheduled); those extra fields are not DTO fields.
 * openShift is derived server-side from pickup permission, crew capacity, valid
 * schedule and lifecycle; it is never accepted as an arbitrary client field.
 * Schedule dates store local Denver calendar values and derived startAt/endAt.
 * assignedCrew is an explicit per-job membership snapshot; crewId labels it.
 * When crewId is supplied without assignedCrew, use the saved crew membership.
 * Reassigning a saved crew does not silently change existing job snapshots.
 * arrivalWindowStart/arrivalWindowEnd: 'HH:MM'|null (both or neither) is the
 * customer arrival range on the start date; it must contain the start time.
 * null clears it (a default window applies only when enabled in settings). A
 * saved window that no longer contains a changed start time is cleared with an
 * arrival_window_reset warning. 400 dispatch_arrival_window_invalid otherwise.
 * The derived default label is materialized on save: enabling the setting
 * affects jobs as they are next saved (or by the dry-run-by-default
 * scripts/backfill-arrival-windows.mjs --apply), and disabling it does not
 * remove labels already saved. A start too late for a non-empty window before
 * midnight derives no window.
 * No arbitrary status/financial/customer/provider identity patches are accepted.
 * assignmentSegments (P1-DS-08, functions/_lib/dispatch-segments.js): a complete
 * replacement list of up to 31 [{id:/^[A-Za-z0-9_-]{1,19}$/ unique,date,time,
 * endDate?,endTime,assignedCrew?:string[],crewLead?:string|null,crewId?:string|
 * null,vehicleId?:string|null,notes?:string(2000)}] for multi-crew jobs, split
 * assignments and per-day work windows (e.g. 3 days of 08:00-17:00 frees each
 * night). Segments are sorted by start. crewId without assignedCrew uses that
 * crew's members and lead. Parallel segments need different employees and
 * vehicles (else 409 dispatch_conflict, details.conflicts[].code
 * 'segment_overlap'). The job's date/time/endDate/endTime become the hull
 * (earliest start, latest end, at most 31 days), assignedCrew/assignedTo the
 * union, crewLead the earliest segment lead, crewId/vehicleId the shared value
 * or null; a save cannot also send those hull keys (400
 * dispatch_segments_hull_derived), nor edit them on a segmented job without
 * sending segments. [] clears segments and keeps the hull as a single job-level
 * assignment. Blocks cannot have segments. Server env EGC_DISPATCH_SEGMENTS
 * (exactly 'true'; default off): off rejects the field with 400
 * dispatch_segments_disabled, except [] on an already segmented job, so turning
 * it off never strands one. Saved segments are honoured whatever the flag.
 * Conflicts, warnings, openings, drive-time routes and crew time off are checked
 * per segment; a segment on its own days reserves only its own window, crew and
 * vehicle. Each segment writes one day-lock entry per occupied day with id
 * `${jobId}~${segmentId}` (plus jobId, segmentId); legacy entries keep the job
 * ID. Edits and cancellation release every entry owned by the job. A malformed
 * saved split (bad or duplicate ID, crew not a list) is checked and locked as its
 * hull with the union crew, never as free capacity. Warnings may
 * carry segmentId/otherSegmentId, plus segment_unassigned. A segmented job is
 * never an open shift and shift pickup/release is 409 dispatch_shift_closed.
 * The older operations scheduler rejects segmented jobs with
 * schedule_segments_require_dispatch (adoption: schedule_adoption_segments_
 * require_dispatch). Crew DTOs (field-execution.js) show a crew viewer only
 * their own segments and a hull of them; managers see every segment. No
 * backfill is needed or provided: a job without assignmentSegments is one
 * implicit segment computed from its own fields, so existing records, locks and
 * readers are unchanged. dispatchStorage reports a Firestore 400
 * FAILED_PRECONDITION commit as 409 dispatch_revision_conflict with the flag
 * on or off (functions/_lib/firestore-errors.js).
 * => {ok,job:DispatchJob,warnings,requestId,replayed?,providerSync:'pending'|'not_needed'}
 *
 * {action:'crew.save',requestId,id?:string,expectedRevision?:string,
 *  changes:{name,memberIds:string[],leadId:string|null,status:'active'|'inactive'}}
 * {action:'vehicle.save',requestId,id?:string,expectedRevision?:string,
 *  changes:{name,status:'available'|'out_of_service'|'inactive',notes?:string}}
 * {action:'availability.save',requestId,id?:string,expectedRevision?:string,
 *  changes:{employeeId,date,endDate?,time?,endTime?,allDay:boolean,
 *           reason?:string,status:'active'|'cancelled'}}
 * Resource creates omit id/revision. Saves return {ok,resource,warnings,requestId}.
 *
 * DispatchJob has: id,revision,type,customerId,customer,phone,address,title,
 * date,time,endDate,endTime,startAt,endAt,timeZone,status,assignedCrew,assignedTo,
 * crewLead,crewId,vehicleId,crewNeeded,travelBufferMinutes,jobInstructions,
 * accessInstructions,customerInstructions,opsNotes,requiredEquipment,materials,
 * serviceType,syncStatus,highlevelAppointmentId,sourceWalkthroughId,completedAt,
 * createdAt,updatedAt,recurrence,recurrenceParentId,sourceTemplateJobId,reminderDays,
 * notify,shiftPickupEnabled,openShift,notes,durationMin,estimatedDurationMin,
 * completionSync:{status,message,attemptedAt,syncedAt}|null,
 * arrivalWindowStart,arrivalWindowEnd ('HH:MM'|null), arrivalWindow (Denver
 * range label such as '9:00 AM – 10:00 AM', '' when none is saved),
 * assignmentSegments (only on segmented jobs): [{id,date,time,endDate,endTime,
 * startAt,endAt,assignedCrew,crewLead,crewId,vehicleId,notes}].
 * Date/time invalid or absent is represented as startAt:null.
 * Financial/credential/employee payroll fields are deliberately absent.
 *
 * Errors: {ok:false,code,error,details?}. 400 validation, 401 sign-in,
 * 403 permission, 404 missing, 409 revision/conflict, 503 unavailable/unknown.
 * A 409 dispatch_conflict has details.conflicts with employee/vehicle/job IDs.
 * Conflicts are never bypassed by a client flag. Understaffing and travel buffers
 * are explicit warnings returned on GET and successful POST.
 * Legacy Hub calendar day blocks (blocked_days/<date>) are never written.
 * Server env EGC_DISPATCH_LEGACY_BLOCKED_DAYS=off (default, also for unknown
 * values): they are not read and conflicts/openings are unchanged. Opt-in =warn:
 * placing work on one returns a legacy_blocked_day warning and openings skip the
 * day; opt-in =enforce: new placement or shift pickup there is a 409
 * dispatch_conflict.
 *
 * GET /api/dispatch-openings?startDate=YYYY-MM-DD&endDate=exclusive&
 * durationMinutes=120&workdayStart=08:00&workdayEnd=17:00&employeeIds=id1,id2&
 * vehicleId=optional&travelBufferMinutes=20&address=optional|zip=optional
 * Manager only; at most14days, duration15..1440min, buffer0..180min. Explicit
 * active employee IDs required. Workdayend24:00 is allowed. Past times omitted.
 * Optional job location for drive estimates: EITHER address (non-empty, <=500
 * chars) OR zip (5 digits), never both (400 dispatch_openings_invalid). With
 * EGC_DISPATCH_TRAVEL_ESTIMATES on, neighbouring work is padded by
 * max(travel buffer, estimated drive); unknown locations keep the buffer and
 * add a travel_estimate_unavailable warning. Off (default): buffer only.
 * => {ok,timeZone,startDate,endDate,asOf,coverage:{complete,consistent,mode,
 * revision,asOf},constraints:{...,workingAvailabilityConfirmed:false},
 * candidates:[{date,time,endDate,endTime,startAt,endAt,gapStartAt,gapEndAt,
 * gapMinutes}],total,truncated,warnings,roster,vehicles:[{id,name,status}]}.
 * Each candidate is the earliest representable start in one maximal workday
 * gap; at most20 earliest candidates are returned. No working-hours availability
 * is inferred. A candidate is only a suggestion and MUST use ordinary dispatch
 * POST validation when booking. Snapshot consistency covers guarded dispatch
 * writes and day locks, not independent provider databases.
 *
 * GET /api/dispatch-travel?date=YYYY-MM-DD&employeeId=optional (manager only;
 * duplicate/unknown/invalid params 400 dispatch_travel_invalid; storage
 * failure 503 dispatch_travel_unavailable; no-store, nosniff; read-only)
 * => {ok,timeZone,date,asOf,travel:{mode,requestedMode,blockTravelShort},
 * coverage:{complete,asOf},employees:[{employeeId,name,active,complete,
 * jobs:[{id,type,customer,title,address,date,time,endDate,endTime,startAt,endAt,
 * status,travelBufferMinutes}],legs:[{fromJobId,toJobId,gapMinutes,
 * bufferMinutes,estimatedMinutes,estimateSource,requiredMinutes,shortByMinutes,
 * status:'ok'|'short'|'same_property'|'overlap'}],totals:{stops,legs,shortLegs,
 * estimatedDriveMinutes,unestimatedLegs}}],warnings}. legs[i] joins jobs[i] and
 * jobs[i+1]; no phone, email, money or pay fields. Estimates come from
 * functions/_lib/dispatch-travel.js (EGC_DISPATCH_TRAVEL_ESTIMATES off|offline|
 * google). travel_buffer_short warnings carry bufferMinutes, estimatedMinutes,
 * estimateSource and blocking; with EGC_DISPATCH_BLOCK_TRAVEL_SHORT=true a save
 * that moves a stop into a gap shorter than the estimated drive is a 409
 * dispatch_conflict (manual-buffer shortfalls stay warnings).
 */
export const DISPATCH_TIME_ZONE = 'America/Denver';
export const DISPATCH_ACTIONS = Object.freeze(['schedule.create','schedule.update','schedule.cancel','schedule.restore','schedule.no_show','crew.save','vehicle.save','availability.save']);
