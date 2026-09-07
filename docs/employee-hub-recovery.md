# Employee Hub recovery

The employee signup, approval, and sign-in flows need production server credentials. A public Firebase Web API key does not grant server access. Code deployment alone cannot create those credentials or recover the employee-data encryption key.

## Preserve existing records first

Do not reset employee accounts, recreate profiles, or rotate the employee vault key to clear a setup error. Existing accounts, timecards, training, and messages must remain readable.

Older versions selected the vault secret from `EMPLOYEE_HUB_DATA_SECRET`, then `HUB_SESSION_SECRET`, then `HIGHLEVEL_API_KEY` / `GHL_API_KEY`. Before enabling a new session secret, preserve the exact historical vault secret. A dedicated `EMPLOYEE_HUB_DATA_SECRET` is preferred when its historical value is available. If the historical value is uncertain, retain the records and arrange a verified migration before enabling activity.

For a deployment whose historical records used the existing sealed `HIGHLEVEL_API_KEY`, the explicit server-only setting `EMPLOYEE_HUB_LEGACY_KEY_SOURCE=HIGHLEVEL_API_KEY` can preserve those bytes without extracting the CRM secret. This is an opt-in recovery path, never an automatic fallback. A missing selected key or an unrecognized selector fails closed. A dedicated employee secret still takes priority; otherwise the selector prevents a new session secret from changing the employee encryption key. Session and customer authentication never use this selector.

While the selector is set, all employee-account and employee-Hub mutations are blocked until `EMPLOYEE_HUB_LEGACY_WRITES_VERIFIED=true`. Read access remains available for verification. Keep this flag unset or `false` while checking BOTH record families: employee accounts and the profiles/timecards/training/messages vault. A successful read of one family does not prove the other can be decrypted.

## Required production settings

Use the existing Cloudflare Pages project `easy-garage-cleaning`, Production environment, and Firebase project `egcw-1ec83` with its existing default database.

| Secret | Required value |
| --- | --- |
| `EMPLOYEE_HUB_DATA_SECRET` | Exact historical vault secret for the existing records; resolve this before the session secret changes. |
| `EMPLOYEE_HUB_LEGACY_KEY_SOURCE` | Optional plaintext selector, exactly `HIGHLEVEL_API_KEY`, only when retaining that known historical key in place. Leave the dedicated secret unset when using this path. |
| `EMPLOYEE_HUB_LEGACY_WRITES_VERIFIED` | Optional plaintext recovery gate. Leave unset or `false` until both record families are verified; set to exactly `true` afterward. |
| `HUB_SESSION_SECRET` | Independent randomly generated session-signing secret, at least 32 random bytes. |
| `HUB_AUTH_USERS_JSON` | Existing static users, including the `ZacB` owner, with securely generated password hashes. Preserve other existing entries. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | A complete service-account JSON key for project `egcw-1ec83`, with the required Firestore data permissions. |
| `HUB_PASSWORD_VERIFIER` | Private Durable Object binding to `PasswordVerifier` in the separately deployed `egc-password-verifier` Worker. Supported on Workers Free using its SQLite namespace. |

The owner entry is `ZacB`, not `Owner`. Public employee signup never creates an owner or manager account. Hash new owner passwords with the repository's `createHubCredentialHash` helper (PBKDF2-SHA256); do not put a plaintext password into the configured user map.

Cloudflare's native PBKDF2 rejects iteration counts above 100,000. The recent staff-password generator uses 210,000 rounds, introducing an incompatibility with native verification. Deploy the private Worker in `auth-verifier/` and bind its SQLite Durable Object to Pages as `HUB_PASSWORD_VERIFIER`. Durable Objects are available on Workers Free with a 30-second default CPU allowance. A hosting upgrade is not required for this repair.

Only the specific native iteration-cap error uses this binding. The private verifier performs the same PBKDF2-SHA256 calculation using pinned `@noble/hashes`, preserving passwords, salts, rounds, and hashes. It exposes no public endpoint and stores no credential data. Binding errors fail closed. Verify the deployed connection before declaring login restored. Never lower an existing hash's iteration field or reset the owner's password to work around this issue. The old `HUB_PASSWORD_HASH_FALLBACK=enabled` software path remains compatible for already configured runtimes without a binding; leave it unset on this Free Pages deployment.

Store credential values as encrypted production secrets; the recovery controls and password fallback flag are non-secret configuration. Never commit credentials, place them in public assets, or send them in chat. The local `.env` file does not configure Cloudflare production. Existing encrypted Cloudflare values cannot be recovered from the dashboard.

Use a dedicated service account with `roles/datastore.user` or a reviewed narrower role sufficient for the application's database operations. Do not grant Project Owner/Editor to make the application work. The application signs custom Firebase tokens locally using this key.

After preserving the vault key and saving all credentials, publish the reviewed `firestore.rules` to the existing Firebase project and create a new Cloudflare production deployment. Saving settings alone does not update an existing deployment.

## Verify recovery

1. Deploy the private verifier, add the Pages Durable Object binding, and redeploy Pages. Confirm a deliberate wrong password returns 401 without a session, then sign in as the configured owner with the existing password; confirm the secure Hub cookie and Firebase custom-token exchange both succeed.
2. First verify both `/api/employee-accounts` and `/api/employee-hub` as the authenticated owner, reporting only aggregate read results. An unavailable-data message is a failed check, not an empty queue. Avoid opening the full owner dashboard during this first check because it may retry previously queued customer invitations.
3. Confirm an existing approved employee can sign in with their existing credentials and can see only their permitted work.
4. Confirm existing profiles, timecards, training, and messages remain readable before saving new activity. With the legacy selector, account and Hub mutations must still return the recovery read-only error during these checks.
5. Only after both record families pass, set `EMPLOYEE_HUB_LEGACY_WRITES_VERIFIED=true` and deploy again. RETAIN `EMPLOYEE_HUB_LEGACY_KEY_SOURCE=HIGHLEVEL_API_KEY` and the original CRM key. Removing the selector would select the new session key and make historical records unreadable. Any later CRM-key rotation requires a separate, verified employee-vault migration first.
6. Confirm unauthenticated API and database access is denied, and a crew user cannot approve applications or use owner actions.
7. Run `node --test tests/*.test.mjs`. These tests use synthetic data and do not establish that production credentials or IAM permissions are correct.

Do not approve a real applicant, send a customer message, or create live payroll/timecard data merely to test recovery.

Status changes invalidate employee Hub cookies and prevent new custom-token issuance for inactive accounts. Firebase tokens already issued are a separate session lifecycle: the Hub-cookie check does not revoke an existing Firebase refresh token. Do not claim immediate revocation of all direct Firebase access without implementing and verifying Firebase-side session revocation and applicable database rules.

## References

- [Cloudflare Pages secret configuration](https://developers.cloudflare.com/pages/functions/bindings/#secrets)
- [Firebase service-account custom tokens](https://firebase.google.com/docs/auth/admin/create-custom-tokens)
- [Firestore IAM roles](https://firebase.google.com/docs/firestore/security/iam)
- [Cloudflare CPU limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Durable Objects Free plan](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Object CPU limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Pages Durable Object bindings](https://developers.cloudflare.com/pages/functions/bindings/#durable-objects)
- [Pinned password derivation implementation](https://github.com/paulmillr/noble-hashes/blob/2.0.1/src/pbkdf2.ts)
