import OpenAI from "openai";

export const DEFAULT_TRANSCRIBE_MODEL = "gpt-transcribe";
export const DEFAULT_EXTRACTION_MODEL = "gpt-5.6-luna";

export function openaiClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000, maxRetries: 1 });
}

export function modelName(name: "OPENAI_TRANSCRIBE_MODEL" | "OPENAI_EXTRACTION_MODEL", fallback: string) {
  return process.env[name]?.trim() || fallback;
}
