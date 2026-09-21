import OpenAI, { toFile } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { walkthroughExtractionSchema, type WalkthroughExtraction } from "@egc/schemas";

function client() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 1 });
}

export async function transcribeWalkthrough(
  audio: Buffer,
  filename: string,
  mimeType = "audio/webm"
): Promise<string> {
  const file = await toFile(audio, filename, { type: mimeType });
  const transcript = await client().audio.transcriptions.create({
    file,
    model: "gpt-transcribe",
    response_format: "json"
  });
  return transcript.text;
}

export async function extractWalkthrough(transcript: string): Promise<WalkthroughExtraction> {
  const response = await client().responses.parse({
    model: "gpt-5.6-luna",
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
      format: zodTextFormat(walkthroughExtractionSchema, "egc_walkthrough")
    }
  });

  if (!response.output_parsed) {
    throw new Error("Walkthrough extraction returned no structured output");
  }
  return walkthroughExtractionSchema.parse(response.output_parsed);
}
