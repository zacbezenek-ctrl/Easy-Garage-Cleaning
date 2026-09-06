# Employee Hub recovery

The employee signup, approval, and sign-in flows need production server credentials. A public Firebase Web API key does not grant server access. Code deployment alone cannot create those credentials or recover the employee-data encryption key.

## Preserve existing records first

Do not reset employee accounts, recreate profiles, or rotate the employee vault key to clear a setup error. Existing accounts, timecards, training, and messages must remain readable.

Older versions selected the vault secret from `EMPLOYEE_HUB_DATA_SECRET`, then `HUB_SESSION_SECRET`, then `HIGHLEVEL_API_KEY` / `GHL_API_KEY`. The current application requires a dedicated employee vault or Hub session secret. Before enabling a new session secret, the authorized operator must preserve the exact historical vault secret in the encrypted `EMPLOYEE_HUB_DATA_SECRET` setting. If the historical value is uncertain, retain the records and arrange a verified migration before enabling activity.

## Required production settings

Use the existing Cloudflare Pages project `easy-garage-cleaning`, Production environment, and Firebase project `egcw-1ec83` with its existing default database.

| Secret | Required value |
| --- | --- |
| `EMPLOYEE_HUB_DATA_SECRET` | Exact historical vault secret for the existing records; resolve this before the session secret changes. |
| `HUB_SESSION_SECRET` | Independent randomly generated session-signing secret, at least 32 random bytes. |
| `HUB_AUTH_USERS_JSON` | Existing static users, including the `ZacB` owner, with securely generated password hashes. Preserve other existing entries. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | A complete service-account JSON key for project `egcw-1ec83`, with the required Firestore data permissions. |

The owner entry is `ZacB`, not `Owner`. Public employee signup never creates an owner or manager account. Hash new owner passwords with the repository's `createHubCredentialHash` helper (PBKDF2-SHA256); do not put a plaintext password into the configured user map.

Store these values as encrypted production secrets. Never commit them, place them in public assets, or send them in chat. The local `.env` file does not configure Cloudflare production. Existing encrypted Cloudflare values cannot be recovered from the dashboard.

Use a dedicated service account with `roles/datastore.user` or a reviewed narrower role sufficient for the application's database operations. Do not grant Project Owner/Editor to make the application work. The application signs custom Firebase tokens locally using this key.

After preserving the vault key and saving all credentials, publish the reviewed `firestore.rules` to the existing Firebase project and create a new Cloudflare production deployment. Saving settings alone does not update an existing deployment.

## Verify recovery

1. Sign in as the configured owner; confirm the secure Hub cookie and Firebase custom-token exchange both succeed.
2. Open Team and verify the pending application count and existing employee records. An unavailable-data message is a failed check, not an empty queue.
3. Confirm an existing approved employee can sign in with their existing credentials and can see only their permitted work.
4. Confirm existing profiles, timecards, training, and messages remain readable before saving new activity.
5. Confirm unauthenticated API and database access is denied, and a crew user cannot approve applications or use owner actions.
6. Run `node --test tests/*.test.mjs`. These tests use synthetic data and do not establish that production credentials or IAM permissions are correct.

Do not approve a real applicant, send a customer message, or create live payroll/timecard data merely to test recovery.

## References

- [Cloudflare Pages secret configuration](https://developers.cloudflare.com/pages/functions/bindings/#secrets)
- [Firebase service-account custom tokens](https://firebase.google.com/docs/auth/admin/create-custom-tokens)
- [Firestore IAM roles](https://firebase.google.com/docs/firestore/security/iam)
