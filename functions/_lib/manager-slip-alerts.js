// MANAGER-SLIP-ALERTS: who gets a Hub browser alert when today's crew slips (late, not en route, not clocked in).
// The alert itself is built and shown on the manager's own device (employee-slip-alerts.js), from the Field agenda
// flags the Hub already computes; this only tells GET /api/employee-hub whether this viewer gets them. Staff only: no
// customer message and no HighLevel write. Off unless EGC_MANAGER_SLIP_ALERTS is exactly "true" (not a launch default).
import { hasBusinessAccess } from './hub-session.js';
import { can } from './staff-roles.js';

export const managerSlipAlertsEnabled = env => env?.EGC_MANAGER_SLIP_ALERTS === 'true';

// The owner and managers who run dispatch: business access and dispatch.write. Crew, sales and phone never.
export const slipAlertsFor = (session, env) => managerSlipAlertsEnabled(env) && hasBusinessAccess(session) && can(session, 'dispatch.write', env);
