import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const leadState = pgEnum("lead_state", [
  "NEVER_CONTACTED",
  "OUTREACH_ATTEMPTED_NO_REPLY",
  "CUSTOMER_RESPONDED",
  "ACTIVE_CONVERSATION",
  "BOOKED",
  "LOST",
  "DO_NOT_CONTACT"
]);

export const direction = pgEnum("message_direction", ["inbound", "outbound"]);
export const actorType = pgEnum("actor_type", ["customer", "human", "automation", "system"]);
export const appointmentStatus = pgEnum("appointment_status", [
  "new", "confirmed", "cancelled", "showed", "noshow", "invalid"
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
};

export const contacts = pgTable("contacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider").default("ghl").notNull(),
  providerId: text("provider_id").notNull(),
  locationId: text("location_id"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  name: text("name"),
  email: text("email"),
  phone: text("phone"),
  source: text("source"),
  tags: jsonb("tags").$type<string[]>().default([]).notNull(),
  customFields: jsonb("custom_fields").$type<unknown[]>().default([]).notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().default({}).notNull(),
  providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
  providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
  ...timestamps
}, (t) => [
  uniqueIndex("contacts_provider_id_uq").on(t.provider, t.providerId),
  index("contacts_phone_idx").on(t.phone),
  index("contacts_email_idx").on(t.email)
]);

export const leads = pgTable("leads", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  source: text("source"),
  currentState: leadState("current_state").default("NEVER_CONTACTED").notNull(),
  assignedUserId: text("assigned_user_id"),
  lastHumanOutreachAt: timestamp("last_human_outreach_at", { withTimezone: true }),
  lastCustomerResponseAt: timestamp("last_customer_response_at", { withTimezone: true }),
  firstBookedAt: timestamp("first_booked_at", { withTimezone: true }),
  lostAt: timestamp("lost_at", { withTimezone: true }),
  doNotContact: boolean("do_not_contact").default(false).notNull(),
  ...timestamps
}, (t) => [
  uniqueIndex("leads_contact_uq").on(t.contactId),
  index("leads_created_idx").on(t.createdAt),
  index("leads_state_idx").on(t.currentState)
]);

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: text("provider_id").notNull(),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().default({}).notNull(),
  ...timestamps
}, (t) => [uniqueIndex("conversations_provider_uq").on(t.providerId)]);

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: text("provider_id").notNull(),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  type: text("type").notNull(),
  direction: direction("direction").notNull(),
  actorType: actorType("actor_type").notNull(),
  body: text("body"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().default({}).notNull(),
  ...timestamps
}, (t) => [
  uniqueIndex("messages_provider_uq").on(t.providerId),
  index("messages_contact_time_idx").on(t.contactId, t.occurredAt)
]);

export const calls = pgTable("calls", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerMessageId: text("provider_message_id").notNull(),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  direction: direction("direction").notNull(),
  actorType: actorType("actor_type").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  durationSeconds: integer("duration_seconds"),
  status: text("status"),
  recordingUrl: text("recording_url"),
  answered: boolean("answered"),
  raw: jsonb("raw").$type<Record<string, unknown>>().default({}).notNull(),
  ...timestamps
}, (t) => [
  uniqueIndex("calls_provider_message_uq").on(t.providerMessageId),
  index("calls_contact_time_idx").on(t.contactId, t.startedAt)
]);

export const callTranscripts = pgTable("call_transcripts", {
  id: uuid("id").defaultRandom().primaryKey(),
  callId: uuid("call_id").references(() => calls.id, { onDelete: "cascade" }).notNull(),
  text: text("text").notNull(),
  segments: jsonb("segments").$type<unknown[]>().default([]).notNull(),
  providerPayload: jsonb("provider_payload").$type<Record<string, unknown>>().default({}).notNull(),
  model: text("model"),
  ...timestamps
}, (t) => [uniqueIndex("call_transcripts_call_uq").on(t.callId)]);

export const opportunities = pgTable("opportunities", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: text("provider_id").notNull(),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  pipelineId: text("pipeline_id"),
  pipelineStageId: text("pipeline_stage_id"),
  status: text("status"),
  monetaryValueCents: integer("monetary_value_cents"),
  assignedUserId: text("assigned_user_id"),
  source: text("source"),
  wonAt: timestamp("won_at", { withTimezone: true }),
  raw: jsonb("raw").$type<Record<string, unknown>>().default({}).notNull(),
  providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
  providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
  ...timestamps
}, (t) => [
  uniqueIndex("opportunities_provider_uq").on(t.providerId),
  index("opportunities_contact_idx").on(t.contactId)
]);

export const appointments = pgTable("appointments", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: text("provider_id").notNull(),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  calendarId: text("calendar_id"),
  assignedUserId: text("assigned_user_id"),
  title: text("title"),
  status: appointmentStatus("status").default("new").notNull(),
  appointmentCreatedAt: timestamp("appointment_created_at", { withTimezone: true }),
  appointmentStartAt: timestamp("appointment_start_at", { withTimezone: true }).notNull(),
  appointmentEndAt: timestamp("appointment_end_at", { withTimezone: true }),
  notes: text("notes"),
  raw: jsonb("raw").$type<Record<string, unknown>>().default({}).notNull(),
  ...timestamps
}, (t) => [
  uniqueIndex("appointments_provider_uq").on(t.providerId),
  index("appointments_created_idx").on(t.appointmentCreatedAt),
  index("appointments_start_idx").on(t.appointmentStartAt)
]);

export const jobs = pgTable("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  opportunityId: uuid("opportunity_id").references(() => opportunities.id),
  appointmentId: uuid("appointment_id").references(() => appointments.id),
  status: text("status").default("draft").notNull(),
  wonAt: timestamp("won_at", { withTimezone: true }),
  serviceAddress: text("service_address"),
  garageSize: text("garage_size"),
  serviceType: text("service_type"),
  junkVolumeYards: numeric("junk_volume_yards", { precision: 6, scale: 2 }),
  itemsRemove: jsonb("items_remove").$type<string[]>().default([]).notNull(),
  itemsKeep: jsonb("items_keep").$type<string[]>().default([]).notNull(),
  itemsRelocate: jsonb("items_relocate").$type<string[]>().default([]).notNull(),
  organizationRequirements: jsonb("organization_requirements").$type<string[]>().default([]).notNull(),
  addOns: jsonb("add_ons").$type<string[]>().default([]).notNull(),
  accessNotes: text("access_notes"),
  estimatedLaborHours: numeric("estimated_labor_hours", { precision: 6, scale: 2 }),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  priceCents: integer("price_cents"),
  depositCents: integer("deposit_cents"),
  ...timestamps
}, (t) => [index("jobs_scheduled_idx").on(t.scheduledAt)]);

export const jobNotes = pgTable("job_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }).notNull(),
  type: text("type").notNull(),
  body: text("body").notNull(),
  source: text("source").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const tasks = pgTable("tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  priority: text("priority").default("medium").notNull(),
  status: text("status").default("open").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  assignedUserId: text("assigned_user_id"),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  opportunityId: uuid("opportunity_id").references(() => opportunities.id, { onDelete: "set null" }),
  source: text("source").default("mcp").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps
}, (t) => [
  index("tasks_status_due_idx").on(t.status, t.dueAt),
  index("tasks_contact_idx").on(t.contactId),
  index("tasks_job_idx").on(t.jobId),
  index("tasks_opportunity_idx").on(t.opportunityId)
]);

export const walkthroughs = pgTable("walkthroughs", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }).notNull(),
  status: text("status").default("draft").notNull(),
  audioObjectKey: text("audio_object_key"),
  transcript: text("transcript"),
  extraction: jsonb("extraction").$type<Record<string, unknown>>().default({}).notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: text("approved_by"),
  ...timestamps
});

export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerEventId: text("provider_event_id"),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  processingStatus: text("processing_status").default("pending").notNull(),
  retryCount: integer("retry_count").default(0).notNull()
}, (t) => [
  uniqueIndex("webhook_provider_event_uq").on(t.providerEventId),
  index("webhook_status_idx").on(t.processingStatus)
]);

export const providerMappings = pgTable("provider_mappings", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider").notNull(),
  resourceType: text("resource_type").notNull(),
  providerId: text("provider_id").notNull(),
  canonicalField: text("canonical_field"),
  displayName: text("display_name"),
  fieldType: text("field_type"),
  raw: jsonb("raw").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex("provider_mappings_provider_resource_id_uq")
    .on(t.provider, t.resourceType, t.providerId)
]);

export const syncCursors = pgTable("sync_cursors", {
  key: text("key").primaryKey(),
  cursor: text("cursor"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const oauthAuthorizationCodes = pgTable("oauth_authorization_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  codeHash: text("code_hash").notNull(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource").notNull(),
  scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex("oauth_authorization_codes_hash_uq").on(t.codeHash),
  index("oauth_authorization_codes_expires_idx").on(t.expiresAt)
]);

export const oauthTokens = pgTable("oauth_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  accessTokenHash: text("access_token_hash").notNull(),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  clientId: text("client_id").notNull(),
  resource: text("resource").notNull(),
  scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex("oauth_tokens_access_hash_uq").on(t.accessTokenHash),
  uniqueIndex("oauth_tokens_refresh_hash_uq").on(t.refreshTokenHash),
  index("oauth_tokens_access_expires_idx").on(t.accessExpiresAt)
]);

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: text("type").notNull(),
  entityId: text("entity_id").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  processingStatus: text("processing_status").default("pending").notNull(),
  retryCount: integer("retry_count").default(0).notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  uniqueIndex("outbox_type_entity_uq").on(t.type, t.entityId),
  index("outbox_status_available_idx").on(t.processingStatus, t.availableAt)
]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

// Only normalized attribution and hashed matching payloads belong here. Never tokens,
// raw contact snapshots, HTTP headers, or unfiltered provider error messages.
export const metaConversionEvents = pgTable("meta_conversion_events", {
  id: text("id").primaryKey(),
  contactId: uuid("contact_id").notNull(),
  leadId: uuid("lead_id").notNull(),
  appointmentId: uuid("appointment_id"),
  jobId: uuid("job_id"),
  opportunityId: uuid("opportunity_id"),
  eventType: text("event_type").notNull(),
  eventTime: timestamp("event_time", { withTimezone: true }),
  datasetId: text("dataset_id").notNull(),
  attribution: jsonb("attribution").$type<Record<string, unknown>>().notNull(),
  valueCents: integer("value_cents"),
  currency: text("currency"),
  payloadVersion: text("payload_version").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  status: text("status").default("pending").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  leaseToken: text("lease_token"),
  response: jsonb("response").$type<Record<string, unknown>>(),
  error: text("error"),
  retryable: boolean("retryable").default(true).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  ...timestamps
}, (t) => [index("meta_conversion_events_status_idx").on(t.status, t.nextAttemptAt)]);

export const metaConversionAttempts = pgTable("meta_conversion_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventId: text("event_id").references(() => metaConversionEvents.id).notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  outcome: text("outcome").default("unknown").notNull(),
  response: jsonb("response").$type<Record<string, unknown>>(),
  error: text("error")
}, (t) => [uniqueIndex("meta_conversion_attempt_number_uq").on(t.eventId, t.attemptNumber)]);

export const metaConversionRuns = pgTable("meta_conversion_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  mode: text("mode").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  summary: jsonb("summary").$type<Record<string, unknown>>()
});

export const metaConversionTests = pgTable("meta_conversion_tests", {
  id: text("id").primaryKey(),
  datasetId: text("dataset_id").notNull(),
  accepted: boolean("accepted").notNull(),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});
