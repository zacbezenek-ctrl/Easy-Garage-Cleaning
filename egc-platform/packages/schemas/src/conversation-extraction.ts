import * as z from "zod/v4";
// Circular with index.ts: walkthroughModelOutputSchema is only read inside the factory, never while
// this module is being evaluated, so the cycle is safe. Keep it that way.
import { walkthroughModelOutputSchema } from "./index.js";

/** Conversation extraction v2 (P3-02). Strict Structured Outputs: every object is closed and every
 * key is required; unknown values are null, never optional keys, and there are no records. The
 * action and attachment kinds are passed in by @egc/ai from @egc/operations action-kinds, which is
 * the only kind list (this package cannot depend on it without a cycle).
 */
export const CONVERSATION_EXTRACTION_VERSION = 2;
export const CONVERSATION_SOURCE_KINDS = ["visit_recording", "visit_transcript", "phone_call", "message_thread"] as const;
export const conversationSourceKindSchema = z.enum(CONVERSATION_SOURCE_KINDS);
export type ConversationSourceKind = z.infer<typeof conversationSourceKindSchema>;
export const CATALOG_TIERS = ["good", "better", "best"] as const;
export const PREFERENCE_POLARITIES = ["prefer", "avoid", "neutral"] as const;
export const REQUESTED_CHANNELS = ["sms", "email", "call"] as const;
export const DRAFT_CHANNELS = ["sms", "email"] as const;
export const SCHEDULING_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export const SCHEDULING_DAY_PARTS = ["morning", "midday", "afternoon", "evening"] as const;
export const SCHEDULING_URGENCIES = ["asap", "soon", "flexible"] as const;
export type SchedulingWeekday = typeof SCHEDULING_WEEKDAYS[number];
export type SchedulingDayPart = typeof SCHEDULING_DAY_PARTS[number];
export type SchedulingUrgency = typeof SCHEDULING_URGENCIES[number];
// Deterministic caps: post-validation clips text to these lengths and lists to these counts.
export const CONVERSATION_LIMITS = {
  proposedActions: 30, catalogMentions: 40, preferences: 30, attachmentsNeeded: 6,
  title: 200, commitment: 1000, sourceQuote: 1000, mention: 200, questionText: 1000,
  draftSubject: 200, draftBody: 2000, catalogItemId: 120, name: 200, category: 80, zone: 80, measurements: 200, quantity: 10000,
  topic: 120, statement: 500, scopeText: 500, scopeList: 50, accessNotes: 2000, model: 200, catalogVersion: 40,
  unavailableMentions: 10, crewSize: 20, durationHours: 200
} as const;
const L = CONVERSATION_LIMITS;
const text = (max: number) => z.string().min(1).max(max);
const confidence = z.number().min(0).max(1);
const count = z.number().int().min(0);

/** Scheduling constraints (FUN-08): what the customer said about when the work can happen. Every constraint is
 * null (unavailableMentions empty) unless the transcript states it, and carries its own sourceQuote. Mentions are
 * the customer's own words; only code turns them into Denver dates (@egc/ai resolveSchedulingConstraints, against
 * walkthroughVisit.startedAt), never the model. Crew size and hours are hints for staff, never a plan. */
const schedulingQuote = text(L.sourceQuote), schedulingMention = text(L.mention);
const schedulingDateMention = z.object({ mention: schedulingMention, sourceQuote: schedulingQuote }).strict();
export const schedulingConstraintSchemas = {
  preferredWeekdays: z.object({ weekdays: z.array(z.enum(SCHEDULING_WEEKDAYS)).min(1).max(SCHEDULING_WEEKDAYS.length), sourceQuote: schedulingQuote }).strict(),
  timeOfDay: z.object({ dayParts: z.array(z.enum(SCHEDULING_DAY_PARTS)).min(1).max(SCHEDULING_DAY_PARTS.length), sourceQuote: schedulingQuote }).strict(),
  dateMention: schedulingDateMention,
  crewSizeMention: z.object({ people: z.number().int().min(1).max(L.crewSize).nullable(), mention: schedulingMention, sourceQuote: schedulingQuote }).strict(),
  durationHoursMention: z.object({ hours: z.number().min(0.25).max(L.durationHours).nullable(), mention: schedulingMention, sourceQuote: schedulingQuote }).strict(),
  urgency: z.object({ level: z.enum(SCHEDULING_URGENCIES), sourceQuote: schedulingQuote }).strict()
};
const S = schedulingConstraintSchemas;
export const schedulingConstraintsSchema = z.object({
  preferredWeekdays: S.preferredWeekdays.nullable(),
  timeOfDay: S.timeOfDay.nullable(),
  notBeforeMention: S.dateMention.nullable(),
  notAfterMention: S.dateMention.nullable(),
  unavailableMentions: z.array(S.dateMention).max(L.unavailableMentions),
  crewSizeMention: S.crewSizeMention.nullable(),
  durationHoursMention: S.durationHoursMention.nullable(),
  urgency: S.urgency.nullable()
}).strict();
export type SchedulingConstraints = z.infer<typeof schedulingConstraintsSchema>;
export type SchedulingDateMention = z.infer<typeof schedulingDateMention>;

export function conversationExtractionSchemas<const ActionKind extends string, const AttachmentKind extends string>(kinds: {
  actionKinds: readonly [ActionKind, ...ActionKind[]]; attachmentKinds: readonly [AttachmentKind, ...AttachmentKind[]];
}) {
  const sourceQuote = text(L.sourceQuote);
  const draftSuggestion = z.object({
    channel: z.enum(DRAFT_CHANNELS),
    subject: text(L.draftSubject).nullable(),
    body: text(L.draftBody)
  }).strict();
  const proposedAction = z.object({
    kind: z.enum(kinds.actionKinds),
    title: text(L.title),
    commitment: text(L.commitment),
    sourceQuote,
    ownerMention: text(L.mention).nullable(),
    dueMention: text(L.mention).nullable(),
    requestedChannel: z.enum(REQUESTED_CHANNELS).nullable(),
    draftSuggestion: draftSuggestion.nullable(),
    attachmentsNeeded: z.array(z.enum(kinds.attachmentKinds)).max(L.attachmentsNeeded),
    questionText: text(L.questionText).nullable(),
    confidence
  }).strict();
  const catalogMention = z.object({
    catalogItemId: text(L.catalogItemId).nullable(),
    tier: z.enum(CATALOG_TIERS).nullable(),
    name: text(L.name),
    category: text(L.category),
    zone: text(L.zone).nullable(),
    quantity: z.number().int().min(0).max(L.quantity).nullable(),
    measurements: text(L.measurements).nullable(),
    sourceQuote,
    confidence
  }).strict();
  const preference = z.object({
    topic: text(L.topic),
    statement: text(L.statement),
    polarity: z.enum(PREFERENCE_POLARITIES),
    sourceQuote,
    confidence
  }).strict();
  // The existing walkthrough scope fields (and their evidence array) for visit recordings; the
  // walkthrough's own proposedActions are replaced by the v2 proposedActions above.
  const scope = walkthroughModelOutputSchema.omit({ proposedActions: true }).required().strict();
  const modelOutput = z.object({
    scope: scope.nullable(),
    proposedActions: z.array(proposedAction).max(L.proposedActions),
    catalogMentions: z.array(catalogMention).max(L.catalogMentions),
    preferences: z.array(preference).max(L.preferences),
    schedulingConstraints: schedulingConstraintsSchema
  }).strict();
  // The scheduling counters and schedulingConstraints default for extractions stored before FUN-08; there
  // schedulingConstraints is null (never extracted), which is not the same as an extraction that found none.
  const validation = z.object({
    droppedProposedActions: count, droppedCatalogMentions: count, droppedPreferences: count, droppedEvidence: count,
    clearedCatalogItemIds: count, clearedMentions: count, clearedDraftSuggestions: count,
    droppedSchedulingConstraints: count.default(0), clearedSchedulingValues: count.default(0)
  }).strict();
  const extraction = z.object({
    version: z.literal(CONVERSATION_EXTRACTION_VERSION),
    sourceKind: conversationSourceKindSchema,
    // For visit recordings this is the upload time: context for the model only, never a date anchor.
    occurredAt: z.string().datetime({ offset: true }),
    model: text(L.model),
    catalogVersion: text(L.catalogVersion).nullable(),
    ...modelOutput.shape,
    schedulingConstraints: schedulingConstraintsSchema.nullable().default(null),
    validation
  }).strict();
  return { draftSuggestion, proposedAction, catalogMention, preference, scope, schedulingConstraints: schedulingConstraintsSchema, modelOutput, validation, extraction };
}
export type ConversationExtractionSchemas<ActionKind extends string, AttachmentKind extends string> = ReturnType<typeof conversationExtractionSchemas<ActionKind, AttachmentKind>>;
