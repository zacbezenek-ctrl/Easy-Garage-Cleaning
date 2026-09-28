import { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  walkthroughExtractionSchema,
  walkthroughModelOutputSchema,
  type WalkthroughExtraction,
  type WalkthroughModelOutput
} from "@egc/schemas";
import { DEFAULT_EXTRACTION_MODEL, DEFAULT_TRANSCRIBE_MODEL, modelName as model, openaiClient as client } from "./provider.js";
import { isMessageTaskKind } from "@egc/operations/action-kinds";
import type { ConversationExtraction } from "./conversation-extraction.js";

export { DEFAULT_EXTRACTION_MODEL, DEFAULT_TRANSCRIBE_MODEL };
export * from "./catalog-index.js";
export * from "./conversation-extraction.js";

/** Folds the model's evidence array back into the stored per-field record; the first quote for a field wins. */
export function walkthroughEvidenceRecord(evidence: WalkthroughModelOutput["evidence"]): WalkthroughExtraction["evidence"] {
  const record: WalkthroughExtraction["evidence"] = {};
  for (const { field, sourceQuote, confidence } of evidence) {
    if (!Object.hasOwn(record, field)) record[field] = { sourceQuote, confidence };
  }
  return record;
}

/** Validates strict model output and maps it to the stored/approval extraction shape. */
export function walkthroughExtractionFromModel(output: unknown): WalkthroughExtraction {
  const parsed = walkthroughModelOutputSchema.parse(output);
  return walkthroughExtractionSchema.parse({ ...parsed, evidence: walkthroughEvidenceRecord(parsed.evidence) });
}

export async function transcribeWalkthrough(
  audio: Buffer,
  filename: string,
  mimeType = "audio/webm"
): Promise<string> {
  const file = await toFile(audio, filename, { type: mimeType });
  const transcript = await client().audio.transcriptions.create({
    file,
    model: model("OPENAI_TRANSCRIBE_MODEL", DEFAULT_TRANSCRIBE_MODEL),
    response_format: "json"
  });
  return transcript.text;
}

export async function extractWalkthrough(transcript: string): Promise<WalkthroughExtraction> {
  const response = await client().responses.parse({
    model: model("OPENAI_EXTRACTION_MODEL", DEFAULT_EXTRACTION_MODEL),
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: [
              "Extract Easy Garage Cleaning walkthrough scope.",
              "Never invent facts.",
              "If a field is unknown, use null/unknown/empty values allowed by the schema.",
              "Preserve customer distinctions between remove, keep, and relocate.",
              "Pest observations are observations only; do not infer an active infestation.",
              "Proposed actions are drafts, never completed work. Extract explicit promises and follow-ups with an exact source quote.",
              "Never invent an owner, deadline, price, payment, customer approval, or a promise. Leave unknown ownerMention and dueMention null.",
              "Evidence lists at most one entry per extracted field, with the exact transcript words that support it; omit fields the transcript does not support.",
              "Return structured data only."
            ].join(" ")
          }
        ]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: transcript }]
      }
    ],
    text: {
      format: zodTextFormat(walkthroughModelOutputSchema, "egc_walkthrough")
    }
  });

  if (!response.output_parsed) {
    throw new Error("Walkthrough extraction returned no structured output");
  }
  return walkthroughExtractionFromModel(response.output_parsed);
}

const LEGACY_INTERNAL_KINDS = ["callback", "prepare_quote", "review_notes", "job_readiness", "manual"] as const;
/** The stored/approval walkthrough shape of a v2 visit extraction, so walkthrough readers and the current
 * review screen keep working: message kinds become followup_message and schedule_job becomes manual. */
export function walkthroughExtractionFromConversation(conversation: ConversationExtraction): WalkthroughExtraction {
  const { evidence = [], ...scope } = conversation.scope ?? {};
  return walkthroughExtractionSchema.parse({
    ...scope,
    evidence: walkthroughEvidenceRecord(evidence),
    proposedActions: conversation.proposedActions.map(action => ({
      title: action.title, kind: isMessageTaskKind(action.kind) ? "followup_message" : LEGACY_INTERNAL_KINDS.find(kind => kind === action.kind) ?? "manual",
      commitment: action.commitment, sourceQuote: action.sourceQuote, ownerMention: action.ownerMention, dueMention: action.dueMention, confidence: action.confidence
    }))
  });
}
