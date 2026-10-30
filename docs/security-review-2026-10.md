# Security review, October 2026

Reviewed: `main` at `978ccbb` (2026-10-21). Covered: staff sign-in and roles, the customer portal, inbound webhooks and cron endpoints, Firestore rules, secrets in the full git history (918 commits), XSS/CSV/SSRF/redirect/upload handling, CORS/CSRF and security headers.

Each finding below was reproduced by a script run against the real modules, with Firestore, HighLevel, Stripe and Zapier mocked in the same way the test suite mocks them. Findings that could not be shown to work were left out. "Fixed" means fixed in this review's pull request, with a regression test in `tests/security-review-2026-10.test.mjs`.

## Summary for the owner

| ID | Severity | One line | Status |
|---|---|---|---|
| C-01 | **Critical** | Password hashes for six staff sign-ins (the owner's included) sat in the public repo's history in a format that can be cracked fast; change those passwords now. | **Owner action now** |
| H-01 | High | Four Zapier "catch hook" addresses are in the public history; if any of those Zaps is still on, anyone can fire it (review-request texts, Meta conversions, crew/Jobber jobs). | **Owner action now** |
| S-01 | High | Anyone could guess staff passwords, including the owner's, with no limit on attempts. | Fixed |
| S-02 | High | A customer address, phone or email containing code ran that code in the owner's Hub, which could take over the owner session. | Fixed |
| M-01 | Medium | The public lead form can be scripted to text any phone, flood team alerts, and overwrite an existing customer's name and email in HighLevel. | Partly fixed (rate limits; missing-origin counted); contact-overwrite part waits for Cesar |
| M-02 | Medium | Later visits on a company-managed project can still get a full owner portal link, which skips the company's member roles. | Fixed (later PR, branch `claude/portal-business-root-links`) |
| M-03 | Medium | Anonymous sign-ins (unknown usernames) and staff signups each read every employee account, which could burn the Firestore quota and take sign-in down. | Partly fixed (S-01 limits sign-in); signup open |
| L-01 | Low | Signing out of the Hub doesn't kill a session that was already copied; it stays valid for up to 12 hours. | Open (pending sessions branch) |
| L-02 | Low | Co-Pilot believes whatever name the browser sends, and any staff login can spend the OpenAI key without limit. | Open |
| L-03 | Low | The Customers CSV download doesn't neutralise cells that start with a tab or carriage return before a formula. | Open |
| L-04 | Low | Customer intake accepts `<` and `>` in phone, email and address fields. S-02 fixes the display; the data itself is still stored as typed. | Open |
| L-05 | Low | The page CSP allows inline scripts, so any future escaping slip becomes working XSS. | Open (hardening) |
| L-06 | Low | The Google Maps key in `employee.html` is public by design; confirm it is restricted in Google Cloud. | Owner check |
| L-07 | Low | The egc-platform internal bearer token is compared with `!==`, not a constant-time compare. | Open (hardening) |

**Secrets:** the repository is **public**, so everything in its 918-commit history is already on the internet.

- No live server credentials were found: no Stripe live or restricted keys, webhook secrets, service-account private keys, `HUB_SESSION_SECRET` values, or HighLevel, OpenAI, GitHub, Slack, AWS or Resend keys. Every value matching those patterns is a synthetic test fixture.
- Two kinds of material in the history do need action now: the password hashes in C-01 and the Zapier hook addresses in H-01.
- The Firebase web `apiKey` and the Google Maps key in `employee.html` are browser keys and public by design (see L-06).

**Should the repository be private? Yes, make it private now.** Here is what the switch affects:

- **Cloudflare Pages and Vercel:** both deploy from private repositories through their GitHub apps; no change is needed.
- **GitHub Actions:** this is the real cost of going private.
  - Private repositories on the free plan get 2,000 Linux minutes a month. Every workflow here runs on `ubuntu-latest`, so there is no macOS multiplier.
  - PR #151 ran 12 jobs on each push: the root suite, the shifted clock, browser, devices, lighthouse, WebKit, database-and-platform, the emulator and the bundle. With GitHub rounding each job up to the minute, that is about **46 billed minutes per push**, and a merge to `main` runs most of it again.
  - At this repository's pace (526 commits reached `main` in the last 30 days), 2,000 minutes lasts roughly 40 pushes. Expect to go past it.
  - Options:
    1. Upgrade to GitHub Pro (3,000 minutes) or pay for overage at GitHub's per-minute Linux rate. Turn on a spending limit either way.
    2. Run the heavy jobs (browser, devices, lighthouse) only on pushes to `main` or with a PR label.
    3. Cancel superseded PR runs, which the root workflow already does.
  - Weigh that cost against keeping the code and its history public; the security case favours private.
- **Claude and Codex GitHub apps:** they keep working on a private repository as long as the app is installed on it.

Going private stops new exposure. It does **not** take back what was already cloned or indexed, so C-01 and H-01 still need the rotation steps below.

This report is also public while the repository is. It describes open findings (M-01 to M-03) in enough detail to act on, which is one more reason to go private and fix M-01 soon.

**Other public information that helps an attacker** (the code needs most of it, so it was not removed):

- the business sign-in usernames;
- the production Railway hostnames for the API, MCP and portal services (`egc-platform` docs and `functions/`);
- the admin and API paths;
- the owner's personal mobile number, inside the Co-Pilot system prompt (`functions/api/copilot.js`, lines 235 to 256 and 547).

Consider moving that phone number into an environment variable. Railway health and service-key endpoints are meant to be public; the API itself is protected by `requireInternalAuth`.

**Personal data:** no real customer data was found in the history. Names, phones, emails and addresses in fixtures, tests, docs and snapshots are synthetic: "Synthetic …" names, `555` phones, `example.*` and `.invalid` emails, and "Synthetic Way" addresses. The other phone numbers are the business's public lines.

## Critical

### C-01: crackable staff password hashes in the public history (Owner action now)

**Where:**
- Commits `8f4e441` (2026-09-03) to `e066d13` (2026-09-05), also `1938384` and `f432302`, put a username → hash map in `functions/_lib/hub-session.js`.
- It covered six accounts: ZacB, TylerG, AlexK, FrankJara, JobberCrew and CrewTest.
- The map is no longer in the current code, but every clone of the repository still has it.

**Why this is critical:**
- Those hashes come from `hashHubCredential`: one SHA-256 over `username:password:` plus a fixed salt that is also in the repository. A GPU tests billions of guesses a second against that, so any ordinary password falls quickly.
- The current sign-in code (`hub-session.js`, `verifyPasswordHash`) still accepts that legacy 64-hex format. Any of those six people still using the same password can therefore be signed in as by whoever cracks the hash, the owner included.
- The new S-01 limit doesn't help here: the guessing happens offline.

**What to do now:**
1. Change the password for each of those six sign-ins, owner first.
2. Store the new hashes only in the `pbkdf2-sha256$…` format, using `createHubCredentialHash` or the owner setup page.
3. Remove any account that is no longer used, such as CrewTest and JobberCrew.
4. Make sure `HUB_AUTH_USERS_JSON` in Cloudflare holds no 64-hex legacy hash.
5. Rotate `HUB_SESSION_SECRET` after the password change, so every session is signed out.

**Follow-up code change, after step 4 is done:** make `verifyPasswordHash` refuse 64-hex legacy hashes. This review did not make that change. `hub-session.js` is being changed on another branch, and refusing legacy hashes before the configuration is converted would lock staff out. Either way, the real fix is the new passwords.

### H-01: Zapier catch-hook addresses in the public history (Owner action now)

**Where:** four `hooks.zapier.com/hooks/catch/…` addresses, introduced in:
- `aec264e` / `96fec85`: Meta CAPI signal buttons;
- `f2d9554`: review request on job completion;
- `ac11654`, `306cb6e` and `8e50297`: crew gameplan and post-job;
- `4026892`: crew webhook to the Jobber Zap.

All were later moved to server-side env vars (`240335b`, `8e50297`), so none is in the current code.

**Why it matters:** a catch hook has no authentication; anyone holding the address can trigger the Zap. If any of those Zaps is still on, or one of these addresses is still the value of a current env var such as the crew hook, an outsider can:
- send review-request texts to any number;
- post fake Meta conversions;
- create crew or Jobber events.

**What to do now:** in Zapier, open each of those Zaps.
- If a Zap is still in use, re-create its Catch Hook trigger to get a new address, and put the new address only in the Cloudflare env var.
- If it is not in use, turn it off.

---

## High

### S-01: no attempt limit on staff sign-in (Fixed)

**Where:** `functions/api/hub-auth.js:37-64` (before this fix). `POST /api/hub-auth` checked the password with no rate limit, lockout or delay. `functions/_lib/rate-limit.js` existed but only customer login used it.

**Exploit:** an anonymous attacker scripts `POST /api/hub-auth {"username":"ZacB","password":"<guess>"}`.

- Business usernames are in the repository, and crew usernames follow a first.last pattern.
- A correct guess returns a 12-hour Hub session. On the owner or a manager account, that means every customer's PII, payments, payroll links and staff roles.
- Nothing in the repository showed a Cloudflare WAF rule standing in for a limit.

**Proof:** a PoC loop signed in on guess 41 with 40 × 401 before it, and nothing was refused.

**Fix:**
- New file `functions/_lib/staff-sign-in-limit.js`. Every attempt is counted before the password is checked:
  - 10 per rolling 15 minutes per client address (`CF-Connecting-IP`; IPv6 is grouped by /64);
  - 50 per rolling hour per username, ignoring case.
- A successful sign-in gives its attempts back, so only failures count.
- Over the limit, the answer is `429 HUB_AUTH_RATE_LIMITED` with `Retry-After`, and no session is issued even for the right password.
- Counters live in the server-only `rate_limits` collection. They store only a purpose-keyed digest, never the address or username.
- If the counter store fails, sign-in is refused with `503 HUB_AUTH_LIMIT_UNAVAILABLE` (fail closed).

**Regression tests:** `S-01` in `tests/security-review-2026-10.test.mjs`.

**Limits of the fix:**
- The limit runs only where `FIREBASE_SERVICE_ACCOUNT_JSON` is set. Production has it, because employee accounts need it. Local previews and unit tests without it behave as before.
- Someone spraying 50 wrong guesses an hour at one username can lock that person out for up to an hour. That is the cost of stopping a guess spread across many addresses. A Cloudflare rate-limiting rule on `/api/hub-auth` is still a good second layer.

### S-02: stored XSS in the owner/manager Hub through customer contact fields (Fixed)

**Where:** three templates in `employee.html` joined `c.phone`, `c.email` and `c.address` into `innerHTML` without `esc()` (the name next to them was escaped):

- `renderCustomersTab()` (line 2126);
- `renderCustList()` (booking step 1, line 2363);
- `ocFilter()` (phone-call wizard, line 2655).

For owner and manager sessions, `employee-suite.js:37-41` re-renders the Customers list on every Firestore `customers` snapshot, whether or not the tab is open. An injected `<img onerror>` therefore runs as soon as the owner opens the Hub. The CSP allows `script-src 'unsafe-inline'`, so it is not blocked. The script then runs with the owner's session against every `/api/*` endpoint.

**Exploit path, proven through the real server code:**
1. A door-to-door rep records a Knock sale whose `city` is `<img src=x onerror=…>`. `knock-sales.js` only checks that it is a string of 60 characters or fewer.
2. The Knock job bridge (on by launch default) builds the customer address from it (`knock-bridge.js`, `addressText()`).
3. `customer-resolution.js` stores it on the `customers` document.

Sales or Phone role staff can do the same through `POST /api/customer-resolve`. The email check accepts `<img/src=x/onerror=…>@a.co`, and phone and address are stored as typed. A HighLevel contact's email or address copied in at booking is a third possible source.

**Proof:**
- `applySaleEvent` → `resolveCustomer` produced a `customers` document with the payload in `address`.
- The real `renderCustomersTab` from `employee.html`, run in headless Chromium on that document, fired the handler (`document.title` changed to `XSS-FIRED`).
- After the fix, the same run shows the payload as text.

**Fix:**
- Each contact value goes through `esc()` in all three templates.
- `initials()` now escapes its two characters too. A name beginning with `<` could otherwise open a tag.

**Regression test:** `S-02` in `tests/security-review-2026-10.test.mjs`. It runs the real functions from `employee.html` on a hostile customer and asserts no `<img` reaches `innerHTML`.

**Follow-up (L-04):** reject `<` and `>` in phone, email and address on the server too.

---

## Medium

### M-01: `/api/web-lead` can be scripted to text any phone and overwrite CRM contacts

**Where:**
- `functions/api/web-lead.js:53`: `originAllowed()` accepts a request with no Origin and no Referer.
- `:143`: no rate limit or captcha. The `botcheck` honeypot is simply left empty.
- `:224` → `relayLead` (`:112`) fires the Zapier hook on every request.
- `functions/_lib/web-lead-intake.js:214` upserts the HighLevel contact by phone, using the name and email from the request.

**Exploit:** a script POSTs leads with no Origin, `sms_consent:"yes"`, any target phone and a fresh `inquiry_id` (which beats the receipt dedupe). Every request:
- runs the Zap, which sends the team SMS alert, a Meta CAPI Lead event, and the optional AI text-back to the target phone;
- writes the attacker's name and email onto the existing HighLevel contact for that phone.

**Proof:** 25 scripted posts gave 25 × 200, 25 Zapier relays to one phone, and 25 upserts that set an existing customer's contact to "Attacker Chosen Name" / `attacker@evil.test`.

**Not possible:** this cannot redirect a portal magic link or invitation.
- Delivery addresses come from Firestore (`approved-send.js:261`, `portal-invitation.js:87/170`), and `ghl-messenger.js:79-80` refuses a contact that doesn't match (`contact_mismatch`).
- `web-lead` writes nothing to Firestore.
- The effect is that email links to that customer stop delivering until staff fix the contact.

**Recommended fix:**
1. Apply `rate-limit.js` per `CF-Connecting-IP` and per normalized phone, for example 5 per hour per address and 2 per day per phone.
2. Require a real Origin (refuse when both Origin and Referer are missing).
3. On `/contacts/upsert`, don't overwrite `name` and `email` on a contact that already exists. Add a note instead.
4. Add a Cloudflare rate-limit rule for `/api/web-lead`.

### M-02: owner portal links on later visits of a company-managed project (Fixed)

**Where:** "business-managed" is decided two ways.
- `message-links.js:25-29` and `customer-account-access.js:43` treat a job as company-managed when the job *or its account root* has `businessAccountId`.
- Three places check only the job:
  - `functions/api/customer-portal-link.js:31` (staff "Copy customer portal"; it resolves the root at line 35 but never checks it);
  - `functions/_lib/portal-invitation.js:122/135/168` (the automatic invitation after a quote is accepted);
  - `functions/api/customer-portal.js:639` and `:315` (`create_collaborator_invite`, `invitesAvailable`).

**Exploit:** a root project is linked to a company in the Business Hub, which marks only that job. A later visit under the same root carries no marker of its own. When that visit's quote is approved, an owner-level portal link is texted to the visit's contact, and staff can copy one. The holder gets a full owner session: decide, pay, and mint family links. That skips the company's member roles, which the B2B-SAFE rule in `docs/business-client-hub.md` forbids.

**Proof:** a test mints an owner link, sends an invitation SMS containing it, and opens a session with `viewer.owner = true`. With that session it creates a collaborator link. `message-links` refuses the same job, which shows the inconsistency.

**Recommended fix:** in the three places, also refuse when the resolved account root is business-linked. Use `businessAccountJob(account)`, as `message-links.js:28` does.

**Status:** fixed after this review, on branch `claude/portal-business-root-links`. The root-aware check is now one shared predicate, `businessManaged(job, root)` in `functions/_lib/portal-invitation.js`, which `customer-account-access.js` also uses.
- **Copy customer portal** (`functions/api/customer-portal-link.js`) answers 409 when the account root is linked, with the same wording as a linked job.
- The accepted-quote invitation (`functions/_lib/portal-invitation.js`) resolves the account root before any HighLevel call and records `suppressed` / `business_account_job`. It checks again after the contact lookup and after the delivery claim. A root that cannot be verified never sends.
- The portal (`functions/_lib/customer-portal-access.js` gives `businessManaged`; `functions/api/customer-portal.js` uses it) hides **Copy invite** (`invitesAvailable: false`), and `create_collaborator_invite` answers 403 `CUSTOMER_PORTAL_BUSINESS_PROJECT`.
- Regression tests: the `M-02:` tests in `tests/business-hub-portal-safety.test.mjs`.
- Unchanged: as for a linked job, owner links shared before the company link keep working until staff revoke them.

### M-03: anonymous requests read and decrypt every employee account

**Where:**
- `functions/_lib/employee-accounts.js:247`: sign-in with an unknown username lists all `employee_account_v1` documents and decrypts each one.
- `employee-accounts.js:212`: every public signup (`POST /api/employee-accounts`, `action:"register"`, no sign-in needed) does the same scan, then adds a permanent pending account.

**Exploit:** a stream of random-username sign-ins and signups costs N Firestore reads each, where N is the number of accounts, and every signup makes N bigger. Once the quota is exhausted, `EMPLOYEE_ACCOUNT_QUOTA_EXCEEDED` takes Hub sign-in down for every employee.

**Proof:** with 60 accounts seeded, an unknown-user sign-in read 60 documents and signup #22 read 81.

**Status:**
- S-01 now caps sign-ins at 10 per 15 minutes per address.
- Signup is still open. Apply `rate-limit.js` to `register` per address, for example 3 per hour, and replace the full scan with a lookup keyed by username.

---

## Low

- **L-01: sign-out does not revoke the session on the server.**
  - `functions/api/hub-auth.js:66` only clears the cookie, and Hub tokens are stateless for 12 hours (`functions/_lib/hub-session.js:7`).
  - Proof: a token copied before sign-out still answered `GET /api/hub-auth` and `/api/employee-hub` with 200 eleven hours later.
  - The unmerged sliding-session / credential-version branch for `hub-session.js` is the right place to fix this: bump the credential version at sign-out. This review did not edit that file.
- **L-02: Co-Pilot trusts the identity in the request body.**
  - `functions/api/copilot.js:459-477` takes the "Logged in" user from `body.user`. A crew session sent `"user":"ZacB"` and the model was told the owner was asking. The answer is prompt context only; no extra data is exposed.
  - Fix: use the session's user, and add a per-user daily cap on OpenAI calls.
- **L-03: the CSV formula guard misses tab and CR.**
  - `employee-suite.js:621` `csvCell` prefixes only `= + - @`. The other exporters (`employee-ui-kit.js:130`, `payroll-export.js`, `money-reports.js`, `business-hub.js`) also handle a leading `\t` and `\r`.
  - Fix: use the same regex, `/^[=+\-@\t\r]/`.
- **L-04: no server-side check on contact fields.**
  - `customer-resolution.js` `clean()` checks only type and length. The email pattern accepts markup, and the raw phone string is stored.
  - Fix: reject `<` and `>` in phone, email and address, and store the normalized phone.
- **L-05: the CSP allows `script-src 'unsafe-inline'`** (`functions/_middleware.js:29`, `employee.html:9`). Moving the Hub's inline handlers to nonce'd or external scripts would contain the next escaping mistake. The Business Hub already runs without `unsafe-inline`.
- **L-06: the Google Maps browser key.** In Google Cloud Console, confirm the key `employee.html` uses is restricted:
  - HTTP referrers limited to `easygaragecleaning.com` and `easy-garage-cleaning.pages.dev`;
  - APIs limited to the ones the Hub uses (Distance Matrix, Maps JavaScript).

  If it isn't restricted, restrict it. Rotating it is optional.
- **L-07: egc-platform `requireInternalAuth` uses `!==`** (`egc-platform/apps/api/src/server.ts:35`). The token must be at least 32 characters, and no timing attack was shown. Switch to `crypto.timingSafeEqual` for hygiene.

## Checked and sound

**Staff sessions**
- HMAC compared in constant time; exactly two token parts required; `exp` enforced; tokens for different purposes cannot be confused with each other.
- Cookies are `HttpOnly; Secure; SameSite=Strict`, and a fresh token is issued at every sign-in.
- Employee sessions re-read the account status and `sessionVersion` on every request.
- The owner and manager roles cannot be granted through stored fields or request bodies.
- `set_roles` is owner-only. Invitation and reset links are 256-bit, hashed, single-use and expire.

**Customer portal**
- Links are signed with HMAC and per-purpose keys, compared in constant time, and expire.
- Every endpoint (photo, document, money document, the `customer-portal` actions, Stripe) uses only the job id from the session.
- Revocation is checked on every request.
- Magic links are single-use (compare-and-set), last 15 minutes, and give no enumeration signal. Their rate limits key on `CF-Connecting-IP`.
- `next=` takes only listed values.
- Customer login is off in production (`CUSTOMER_LOGIN_ENABLED` is not set).

**Webhooks**
- Stripe: HMAC over the raw body, a ±300 s window, any `v1` signature accepted, constant-time compare, and 503 when the secret is unset. Amounts and paid state are re-read from Stripe, and events are idempotent on the session or event id.
- HighLevel (Pages and egc-platform): Ed25519 against a pinned key, location id bound, deduped by message id.
- Cron and service ticks (`messaging-cron`, `ghl-tag-drain`, `operations-*`): v2 Ed25519 envelopes bound to the path, with a 60 s lifetime and single-use nonces.
- OAuth: Gusto, Jobber and Drive state is signed or ledgered, and their redirect URIs are fixed.
- `sms-event` and `lead-intake` are retired (410).

**Firestore**
- 81 `if false` rules plus a deny-all default.
- Every other rule needs `businessUser()` custom claims, which only `/api/firebase-session` mints, from a server session. An account someone signs up with the public apiKey passes no rule.
- The service account requests only the datastore and identitytoolkit scopes.

**SSRF, uploads and redirects**
- Drive thumbnails are pinned to https `*.googleusercontent.com`. Every other server fetch uses a fixed host from env or code.
- Uploads go through MIME allowlists, magic-byte checks and size caps. Files served back re-check `image/*` or PDF and send `nosniff`, `default-src 'none'` and `attachment`.
- `safeStaffNext` refused all 14 redirect bypass payloads tried.

**CORS, CSRF and headers**
- The middleware strips `Access-Control-Allow-Origin`.
- Every cookie-authenticated POST checks Origin, Referer or `Sec-Fetch-Site`.
- HSTS, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy` and `Permissions-Policy` are set, and source and config paths return 404.

**Other output**
- Server-rendered HTML (money and quote documents, projects pages, auth relay pages) escapes every value.
- The Hub UI kit `h()`, the Business Hub, the crew apps, the customer portal and Co-Pilot rendering escape their values or use text nodes.
