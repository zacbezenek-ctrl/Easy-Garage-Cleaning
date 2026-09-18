import { createPublicKey, verify } from "node:crypto";

export function verifyGhlWebhook(rawBody: Buffer, signature: string | undefined): boolean {
  const publicKey = process.env.GHL_WEBHOOK_PUBLIC_KEY;
  if (!publicKey) throw new Error("GHL_WEBHOOK_PUBLIC_KEY is required");
  if (!signature) return false;

  try {
    const key = createPublicKey(publicKey.replace(/\\n/g, "\n"));
    return verify(null, rawBody, key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
