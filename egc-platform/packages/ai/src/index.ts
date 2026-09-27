import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import {
  walkthroughExtractionSchema,
  walkthroughModelOutputSchema,
  type WalkthroughExtraction,
  type WalkthroughModelOutput
} from "@egc/schemas";

export const DEFAULT_TRANSCRIBE_MODEL = "gpt-transcribe";
export const DEFAULT_EXTRACTION_MODEL = "gpt-5.6-luna";

function client() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 1 });
}

function model(name: "OPENAI_TRANSCRIBE_MODEL" | "OPENAI_EXTRACTION_MODEL", fallback: string) {
  return process.env[name]?.trim() || fallback;
}

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
