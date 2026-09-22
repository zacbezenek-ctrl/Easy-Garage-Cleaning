/** Native Hub dispatch API. Session cookie, same-origin JSON, manager/owner only.
 * GET /api/dispatch?startDate=2026-09-22&endDate=2026-09-29&includeUnscheduled=true
 *   endDate is EXCLUSIVE. Missing range defaults to today + 7 Denver calendar days.
 *   => {ok, timeZone:'America/Denver', jobs:[DispatchJob], roster:[{id,name,role}],
 *       crews:[{id,revision,name,memberIds,leadId,status}],
 *       vehicles:[{id,revision,name,status,notes}],
 *       availability:[{id,revision,employeeId,date,endDate,time,endTime,allDay,reason,status}],
 *       warnings:[{code,jobId,message,...}], coverage:{complete,asOf},startDate,endDate}
 * GET /api/dispatch?view=customers&q=phone-or-name
 *   => {ok,customers:[{id,name,phone,email,address}],total}; at most 50 results.
 * GET /api/dispatch?view=job&jobId=exact-ID
 *   => {ok,job:DispatchJob,roster,crews,vehicles,warnings}; no date-range filter.
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
 * openShift is derived server-side from pickup permission, crew capacity, valid
 * schedule and lifecycle; it is never accepted as an arbitrary client field.
 * Schedule dates store local Denver calendar values and derived startAt/endAt.
 * assignedCrew is an explicit per-job membership snapshot; crewId labels it.
 * When crewId is supplied without assignedCrew, use the saved crew membership.
 * Reassigning a saved crew does not silently change existing job snapshots.
 * No arbitrary status/financial/customer/provider identity patches are accepted.
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
 * completionSync:{status,message,attemptedAt,syncedAt}|null.
 * Date/time invalid or absent is represented as startAt:null.
 * Financial/credential/employee payroll fields are deliberately absent.
 *
 * Errors: {ok:false,code,error,details?}. 400 validation, 401 sign-in,
 * 403 permission, 404 missing, 409 revision/conflict, 503 unavailable/unknown.
 * A 409 dispatch_conflict has details.conflicts with employee/vehicle/job IDs.
 * Conflicts are never bypassed by a client flag. Understaffing and travel buffers
 * are explicit warnings returned on GET and successful POST.
 *
 * GET /api/dispatch-openings?startDate=YYYY-MM-DD&endDate=exclusive&
 * durationMinutes=120&workdayStart=08:00&workdayEnd=17:00&employeeIds=id1,id2&
 * vehicleId=optional&travelBufferMinutes=20
 * Manager only; at most14days, duration15..1440min, buffer0..180min. Explicit
 * active employee IDs required. Workdayend24:00 is allowed. Past times omitted.
 * => {ok,timeZone,startDate,endDate,asOf,coverage:{complete,consistent,mode,
 * revision,asOf},constraints:{...,workingAvailabilityConfirmed:false},
 * candidates:[{date,time,endDate,endTime,startAt,endAt,gapStartAt,gapEndAt,
 * gapMinutes}],total,truncated,warnings,roster,vehicles:[{id,name,status}]}.
 * Each candidate is the earliest representable start in one maximal workday
 * gap; at most20 earliest candidates are returned. No working-hours availability
 * is inferred. A candidate is only a suggestion and MUST use ordinary dispatch
 * POST validation when booking. Snapshot consistency covers guarded dispatch
 * writes and day locks, not independent provider databases or route estimates.
 */
export const DISPATCH_TIME_ZONE = 'America/Denver';
export const DISPATCH_ACTIONS = Object.freeze(['schedule.create','schedule.update','schedule.cancel','schedule.restore','crew.save','vehicle.save','availability.save']);
