# Private password verifier

This Worker supplies `PasswordVerifier`, a SQLite-backed Durable Object that derives the existing 32-byte PBKDF2-SHA256 password value with the stored iteration count. It uses the same pinned `@noble/hashes` 2.0.1 implementation as the website. It does not create sessions or decide account permissions.

The Worker has no routes, workers.dev hostname, or preview URLs. Its top-level `fetch` always returns 404. Only a caller with the Durable Object namespace binding can invoke derivation. The class does not read or write storage, retain request data in instance fields, or log credential material. SQLite is the namespace backend required for Durable Objects on Workers Free; no database operations are needed.

Bind the Pages project's `HUB_PASSWORD_VERIFIER` to class `PasswordVerifier` in script `egc-password-verifier`. The agreed caller obtains `idFromName('hub-password-verifier-v1')` and calls the resulting stub with:

```text
POST https://hub-password-verifier.internal/derive
Content-Type: application/json

{"algorithm":"pbkdf2-sha256","password":"<submitted password>","salt":"<canonical base64url>","iterations":210000,"length":32}
```

Success is HTTP 200, `application/octet-stream`, exactly 32 bytes. Every other response must fail verification; it must never authorize a session. Request data is transient and errors do not echo it.

The verifier accepts only this exact schema, integer iteration counts from 100,000 through 1,000,000, password strings of 1–8,192 UTF-16 code units and at most 24,576 UTF-8 bytes, and salts of 1–4,096 decoded bytes. It reads at most 64 KiB of JSON, including when Content-Length is missing or incorrect. These password limits preserve the current Hub endpoint's 8,192-code-unit request envelope; generated salts are 16 bytes.

Install this directory's pinned dependency and run `npm test`. Tests compare the actual private handler's output against Node's independent native PBKDF2 implementation, check malformed/bounded input and unavailable computation, and ensure the public handler remains closed. The Wrangler configuration disables public routing and declares the SQLite migration; deployment and the Pages binding are separate operator actions.

Cloudflare documents [Durable Objects on the Free plan](https://developers.cloudflare.com/durable-objects/platform/pricing/), their [CPU limits](https://developers.cloudflare.com/durable-objects/platform/limits/), and [Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/#durable-objects). Production Free-plan behavior must be verified with synthetic inputs before routing real sign-ins through the binding.
