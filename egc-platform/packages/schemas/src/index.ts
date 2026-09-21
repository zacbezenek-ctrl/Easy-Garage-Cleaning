import * as z from "zod/v4";

export const leadStateSchema = z.enum([
  "NEVER_CONTACTED",
  "OUTREACH_ATTEMPTED_NO_REPLY",
  "CUSTOMER_RESPONDED",
  "ACTIVE_CONVERSATION",
  "BOOKED",
  "LOST",
  "DO_NOT_CONTACT"
]);
export type LeadState = z.infer<typeof leadStateSchema>;

const evidenceSchema = z.object({
  confidence: z.number().min(0).max(1).optional(),
  sourceQuote: z.string().optional()
});

export const walkthroughExtractionSchema = z.object({
  garageSize: z.enum(["1_car", "2_car", "3_car", "4_plus", "unknown"]).default("unknown"),
  junkVolumeYards: z.number().min(0).nullable().default(null),
  itemsRemove: z.array(z.string()).default([]),
  itemsKeep: z.array(z.string()).default([]),
  itemsRelocate: z.array(z.string()).default([]),
  storageRequirements: z.array(z.string()).default([]),
  bikeRacks: z.number().int().min(0).default(0),
  toolRacks: z.number().int().min(0).default(0),
  shelving: z.array(z.string()).default([]),
  pressureWashing: z.boolean().default(false),
  pestObservations: z.array(z.string()).default([]),
  activeInfestation: z.boolean().nullable().default(null),
  accessNotes: z.string().nullable().default(null),
  estimatedLaborHours: z.number().min(0).nullable().default(null),
  customerPreferences: z.array(z.string()).default([]),
  customerObjections: z.array(z.string()).default([]),
  salesNotes: z.array(z.string()).default([]),
  crewNotes: z.array(z.string()).default([]),
  pricingNotes: z.array(z.string()).default([]),
  proposedActions: z.array(z.object({
    title: z.string().min(1).max(500),
    kind: z.enum(["callback", "prepare_quote", "followup_message", "review_notes", "verify_deposit", "job_readiness", "manual"]),
    commitment: z.string().max(2000),
    sourceQuote: z.string().min(1).max(2000),
    ownerMention: z.string().nullable(),
    dueMention: z.string().nullable(),
    confidence: z.number().min(0).max(1)
  })).max(30).default([]),
  evidence: z.record(z.string(), evidenceSchema).default({})
});
export type WalkthroughExtraction = z.infer<typeof walkthroughExtractionSchema>;

export const jobBriefSchema = z.object({
  jobId: z.string(),
  customerName: z.string().nullable(),
  serviceAddress: z.string().nullable(),
  scheduledAt: z.coerce.date().nullable(),
  status: z.string(),
  priceCents: z.number().int().nullable(),
  garageSize: z.string().nullable(),
  junkVolumeYards: z.number().nullable(),
  itemsRemove: z.array(z.string()),
  itemsKeep: z.array(z.string()),
  organizationRequirements: z.array(z.string()),
  addOns: z.array(z.string()),
  accessNotes: z.string().nullable(),
  crewNotes: z.array(z.string()),
  salesNotes: z.array(z.string())
});
export type JobBrief = z.infer<typeof jobBriefSchema>;
