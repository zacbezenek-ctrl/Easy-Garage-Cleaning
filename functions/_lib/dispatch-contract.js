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
 *   With EGC_STAFF_DIRECTORY_ENABLED=true a roster row also carries staffRoles,
 *   skills and weeklyAvailability, and an office-only owner or manager carries
 *   fieldWork:false (owner decision F19; stored staffRoles without crew or
 *   crew_lead). The Hub leaves those rows out of its assignment lists and the
 *   'any qualified' openings search, except where they are already assigned.
 *   The server still accepts them when a dispatcher names them.
 *   dispatchRules (P1-DS-06) is the non-secret owner rule summary: {skills:[{id,
 *   label}] (staff skill catalog),workdayStart,workdayEnd,defaultTravelBufferMinutes,
 *   maxJobsPerEmployeePerDay,maxHoursPerEmployeePerDay,blocking:{crewShort,
 *   skillMissing,travelShort,overCapacity,outsideHours}}. Owner settings live in
 *   dispatchSettings/current (GET/POST /api/dispatch-settings, owner only;
 *   functions/_lib/dispatch-settings.js). Warnings add skill_missing
 *   {missingSkills,unverified?,segmentId?}, employee_daily_capacity {employeeId,
 *   date,jobCount,scheduledHours,...} and outside_working_hours {employeeId,date,
 *   segmentId?} (functions/_lib/dispatch-rules.js); a rule the owner made blocking
 *   carries blocking:true and a save that changes what it reads is a 409
 *   dispatch_conflict. With no settings saved every rule is only a warning, and
 *   with the staff directory off saves, receipts and job documents are
 *   byte-identical to before P1-DS-06 (tests/snapshots/dispatch-legacy-output.json);
 *   reads only gain dispatchRules here and the openings fields below. One
 *   change needs no setting: with EGC_DISPATCH_TRAVEL_ESTIMATES on, a crew
 *   claim checks drive estimates, so its response can carry a travel_buffer_short
 *   notice where only the manual buffer was checked before.
 *   Owner checklist: with EGC_STAFF_DIRECTORY_ENABLED=true and weekly hours
 *   recorded, results change even with no settings saved: the board, the job
 *   view and save and claim responses warn outside_working_hours, and openings
 *   stay inside recorded hours (warnings only until the owner sets a block).
 * GET /api/dispatch?view=customers&q=phone-or-name
 *   => {ok,customers:[{id,name,phone,email,address}],total}; at most 50 results.
 *   With EGC_DISPATCH_WINDOWED_READS=true and every customer keyed, text
 *   matches when every word (one letter included) starts a word of the name
 *   or email, and phone text (digits, spaces, + ( ) . -) when it is the start
 *   of the number (a typed leading 1 optional; extensions ignored) or its last
 *   4 or 7 digits (customer-identity.js). Otherwise any substring matches, as
 *   before. Text starting inside a word or number, and address-only text,
 *   match only the substring scan; shadow mode counts those and flags any
 *   other difference. Response shapes never depend on that flag.
 *   With 'true', rows whose date the windowed reads cannot verify (malformed,
 *   non-string or missing) are neither on the board nor conflict evidence:
 *   an accepted residual risk that scripts/dispatch-window-audit.mjs reports.
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
 * FUN-29 (functions/_lib/funnel-dimensions.js): booking also takes the one-tap
 * picks serviceLine? (a serviceLines code; 'unknown' is "Not sure yet") and
 * funnelPath? (a funnelPaths code), plus serviceLineSuggested?:true when
 * serviceLine is the untouched Facebook lead-form suggestion (only a line the
 * lead form gives; it ranks as the ghlGarageHelpRequested rule, not as a staff
 * pick) (400 dispatch_booking_invalid). The project the visit creates gets
 * serviceLine/serviceLineSource, funnelPath/funnelPathSource,
 * dimensionRulesVersion and dimensionsUpdatedAt/By; a project it joins is refined
 * only on better evidence, under its revision in the same commit. The booking
 * event carries the values; GET `funnel` also lists serviceLines and funnelPaths.
 * GET /api/funnel-dimensions?customerId=ID&kind=job|walkthrough, optional
 * visitPurpose, channel, reworkOfJobId, serviceType, suggest=false: dispatcher
 * only, read-only; an unknown or repeated key is 400
 * funnel_dimensions_query_invalid, a missing customer 404
 * funnel_dimensions_customer_not_found.
 *   => {ok,customerId,kind,projectId,rulesVersion,serviceLine:{value,source,
 *       required,suggestion},funnelPath:{value,source,required},
 *       ghl:'disabled'|'ok'|'unavailable'|'not_needed'|'skipped'}
 *   What a create with these facts records without a pick (a rework shows the
 *   project it joins); required means the form needs one tap. suggestion is the
 *   lead-form line (FUNNEL_GHL_SERVICE_LINE_PREFILL_ENABLED=true), read only
 *   while the line is undecided; suggest=false skips that read ('skipped').
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
 * requiredSkills:string[] (staff skill catalog ids; an id the job already has
 * may be kept after it leaves the catalog), else 400 dispatch_skills_invalid.
 * Optional: a job without it requires no skills. Repeats copy it.
 * estimatedDurationMin:integer 15..10080|null is the expected on-site length (it
 * may span days); it never moves the saved schedule and blocks do not accept it.
 * Saving a value also records durationOverride {minutes,reason:'Set in dispatch',
 * source:'dispatch',crewSize,recordedBy,recordedAt} for the crew the job is then
 * planned for, so it outranks the quote lines for that crew (the suggestion
 * below reports it as estimated_duration). null clears both fields, and the
 * suggestion falls back to the quote lines, the schedule span or the default.
 * Crew and open-shift views treat a length over 1440 as multi-day, not one shift.
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
 * serviceType,syncStatus,highlevelAppointmentId,sourceWalkthroughId,completedAt,requiredSkills,
 * createdAt,updatedAt,recurrence,recurrenceParentId,sourceTemplateJobId,reminderDays,
 * notify,shiftPickupEnabled,openShift,notes,durationMin,estimatedDurationMin,
 * completionSync:{status,message,attemptedAt,syncedAt}|null,
 * arrivalWindowStart,arrivalWindowEnd ('HH:MM'|null), arrivalWindow (Denver
 * range label such as '9:00 AM – 10:00 AM', '' when none is saved),
 * assignmentSegments (only on segmented jobs): [{id,date,time,endDate,endTime,
 * startAt,endAt,assignedCrew,crewLead,crewId,vehicleId,notes}].
 * suggestedDurationMin (integer minutes, a multiple of 15, or null when the
 * saved data cannot be read) and durationSource ('duration_override'|
 * 'line_items'|'estimated_duration'|'schedule_span'|'default'|null) come from
 * functions/_lib/dispatch-duration.js (P1-DS-05). A length recorded for the
 * crew the job is planned for wins: the walkthrough manager's override
 * (duration_override, judged for logistics.crew_size) or a length saved in
 * dispatch (estimated_duration). Otherwise the selected lines of a sold
 * (accepted/approved) quote give person-minutes (durationMinutes, else
 * split.laborMinutes, x quantity) divided by the crew (crewNeeded) and rounded
 * up to 15 minutes; without line minutes it falls back to estimatedDurationMin,
 * the saved schedule span, then 120. durationCoverage is 'complete'|'partial'
 * for line_items ('partial': some sold lines carry no minutes) and null
 * otherwise; durationCapped is true when the total was capped at one day. Both
 * mark an undercount. Masked scans never load quote lines: lists read them only
 * for the sold jobs they return, and a job whose lines cannot be read or changed
 * meanwhile gets nulls. No line, amount or price reaches the DTO. The Hub
 * prefills Expected duration (only when it fits one workday) and the openings
 * search from it.
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
 * vehicleId=optional&travelBufferMinutes=20&address=optional|zip=optional&
 * requiredSkills=optional
 * Manager only; at most14days, duration15..1440min, buffer0..180min. Explicit
 * active employee IDs required unless requiredSkills is given (400
 * dispatch_openings_employees_required). Workdayend24:00 is allowed. Past times omitted.
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
 * POST validation when booking.
 * Dispatch rules (P1-DS-06): workdayStart/workdayEnd/travelBufferMinutes default
 * to the owner settings (08:00/17:00/20 when none are saved). requiredSkills=
 * id1,id2 (skill catalog ids) with employeeIds checks that crew (warning
 * skill_missing; no candidates when the owner blocks it) and without
 * employeeIds searches each employee holding every skill at proficient or lead
 * ('any qualified'), leaving out fieldWork:false rows (office-only owners and
 * managers, F19). Every candidate names employeeIds. Recorded weekly working
 * hours (staff directory) exclude time outside them; constraints report
 * requiredSkills, mode:'together'|'any_qualified', searchedEmployeeIds and
 * workingAvailabilityConfirmed (true only when every searched employee has
 * recorded hours, with a working_hours_applied warning instead of
 * working_availability_unconfirmed). Daily limits add employee_daily_capacity
 * warnings and skip that date only when the owner blocks it. Snapshot consistency covers guarded dispatch
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
