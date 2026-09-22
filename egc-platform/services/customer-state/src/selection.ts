import { or, sql } from "drizzle-orm";
import { schema } from "@egc/database";

/** Shared customer scope for evidence and provider-note workers. The outer query
 * must include contacts. Aging qualified deals remain active without a new SMS. */
export function customerActivityPredicate(since:Date) {
  const at=since.toISOString();
  return or(
    sql`exists(select 1 from leads l where l.contact_id=${schema.contacts.id} and l.created_at>=${at}::timestamptz)`,
    sql`exists(select 1 from messages m where m.contact_id=${schema.contacts.id} and m.occurred_at>=${at}::timestamptz)`,
    sql`exists(select 1 from calls c where c.contact_id=${schema.contacts.id} and c.started_at>=${at}::timestamptz)`,
    sql`exists(select 1 from customer_operational_assertions a where a.contact_id=${schema.contacts.id} and a.status='pending_reconciliation')`,
    sql`exists(select 1 from customer_state_snapshots s where s.contact_id=${schema.contacts.id} and s.snapshot->>'pipelineDisposition'='active' and s.state in ('QUALIFIED','PRICE_EXPECTATION_ACCEPTED','VIDEO_QUOTE_PENDING_CUSTOMER','VIDEO_QUOTE_RECEIVED','VIDEO_QUOTE_IN_PROGRESS','QUOTE_DELIVERED','WALKTHROUGH_VERBALLY_BOOKED','WALKTHROUGH_BOOKED','FOLLOW_UP_PENDING','CUSTOMER_DECIDING','JOB_VERBALLY_ACCEPTED'))`,
    sql`exists(select 1 from appointments a where a.contact_id=${schema.contacts.id} and a.status in ('new','confirmed') and a.appointment_start_at>=${at}::timestamptz)`,
    sql`exists(select 1 from jobs j where j.contact_id=${schema.contacts.id} and ((j.status in ('sold','won','confirmed','scheduled','in_progress') and j.scheduled_at>=${at}::timestamptz) or j.updated_at>=${at}::timestamptz))`,
    sql`exists(select 1 from opportunities o where o.contact_id=${schema.contacts.id} and coalesce(o.provider_updated_at,o.updated_at)>=${at}::timestamptz)`,
    sql`exists(select 1 from walkthroughs w where w.contact_id=${schema.contacts.id} and w.updated_at>=${at}::timestamptz)`
  );
}

/** Oldest refresh first makes a bounded worker rotate fairly instead of leaving
 * the 501st active customer permanently unexamined. New customers sort first. */
export const customerRefreshOrder=()=>sql`coalesce((select s.last_reconciled_at from customer_state_snapshots s where s.contact_id=${schema.contacts.id}),'1970-01-01'::timestamptz) asc`;
export const providerNotesRefreshOrder=()=>sql`coalesce((select c.updated_at from sync_cursors c where c.key='customer_state:provider_notes:'||${schema.contacts.id}::text),'1970-01-01'::timestamptz) asc`;
