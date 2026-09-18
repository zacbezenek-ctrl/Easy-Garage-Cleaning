import { verify } from "node:crypto";

const GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

export function verifyGhlWebhook(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || signature === "N/A") return false;
  try {
    return verify(
      null,
      rawBody,
      GHL_ED25519_PUBLIC_KEY,
      Buffer.from(signature, "base64")
    );
  } catch {
    return false;
  }
}
