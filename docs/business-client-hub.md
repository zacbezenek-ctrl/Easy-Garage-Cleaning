# B2B business client hub

## Routes and operations

- Client: `/business-hub`. This is a company workspace, separate from `/customer-portal` (one shared project) and `/book` (walkthrough request).
- Staff: `/business-hub?staff=1`. Existing authorized EGC staff sign-in is required. Business managers can manage all companies and explicitly link projects. Staff with the verified `sales` role can onboard and service only companies they created. No role is granted by recognizing a name or email in client-side code.
- Primary contact: Zoe Zoll, zoe.zoll@easygaragecleaning.com, +1 970 999 1403.
- Backend: `functions/api/business-hub.js`, the existing server-side Firebase service-account configuration, and default-deny Firestore collections. No additional SaaS or public Firebase permission is required.

## First account

1. Authorized staff signs in, chooses **Create business account**, and records company, named client administrator and billing email.
2. The server creates the company and single-use 48-hour invitation atomically with an audit entry. Copy the link and deliver privately to the named person. **No invitation email is sent automatically.**
3. The client redeems the link and receives a seven-day HttpOnly, Secure, SameSite=Strict session. Add properties, contacts/access notes, work requests and team members. Avoid permanent access codes in saved notes.
4. Review requests in the staff workspace. A requested date is not a confirmed appointment. Scheduling still uses EGC dispatch and existing crew-capacity checks.
5. An EGC business manager selects a property and enters an existing canonical job ID. Explicitly confirm that the company is authorized to see the project AND billing. A referral alone is not authorization. Linking updates only B2B sharing fields; it does not change attribution, quotes, payments or appointment state.
6. Sent/accepted quotes and issued invoices appear from the canonical job. The client opens an authorized project to use the existing approval, payment, messaging and photo tools. Draft quotes and internal notes are not published by this hub.

## Roles

Company administrator: properties, requests, approvals, payments and team invitations/revocation. Property manager: properties, requests and approvals, not payments or team administration. Billing: account view and payments, not requests/approvals/team administration. Viewer: read-only. Members share the company's authorized portfolio; per-property member restrictions are not implemented. Prices are never accepted from a browser.

Inviting an existing member renews their generation and invalidates prior sessions. Invites are single-use; a staff member can issue a replacement after expiry. There is no email/password self-service recovery in this release. Remove a member or unlink a project to revoke delegated project access on the next request. Customers cannot create their own company or claim access based on a domain, guessed job ID or shared phone number.

## Data and safety

Server-only collections: `business_accounts`, `business_sessions`, `business_audit`. Direct browser SDK access remains denied by existing wildcard rules. Invitations and sessions store SHA-256 hashes; raw invitation links are returned only to the authorized creator and are never written to account DTOs or analytics. Cookies are host-only and HttpOnly. State-changing API requests require exact same origin, JSON and a custom header. Account edits, audit and sharing mutations use Firestore preconditioned atomic commits.

A company session delegates only its exact authorized project with a `biz_...` collaborator identity. The individual project API rechecks current account status, member role/generation and canonical job grant on each request. The business session cannot become the homeowner owner session or access household collaborators, unrelated property memory, credits or membership balances. No signed customer agreement is altered.

Account storage limits: 100 properties, 300 requests, 100 linked projects, 30 members, 400 messages and a conservative 750KB JSON limit. Limit errors leave existing records unchanged. Archive/export tooling is a follow-on; do not promise unlimited retention. Owner account lists paginate at 50; sales lists explicitly report truncation above 50 rather than silently presenting a full list. Expired session retention/cleanup should be configured as operations volume grows.

## Boundaries of this release

- Requests and company messages are saved in this workspace. They do **not** automatically send email/SMS or enter HighLevel. Staff must review the workspace; customer-facing text says so. Request-to-dispatch conversion is manual through existing tools.
- Job-level approval, payments, photo upload and rebooking use the existing project portal, not a second financial ledger. This release does not add bulk invoice payment or consolidated invoicing. CSV is a list of issued invoices, with formula-safe cells.
- The company's actual partner pricing is confirmed in each quote. There is no automatic percentage reprice of historical jobs. Original acquisition/commission attribution is preserved.
- No real companies, customers, invoices or payments are seeded by deployment. UI test fixtures are synthetic and are not committed as business data.
- Zoe's existing staff account/role must be verified in production. Do not grant employee-wide administrative access merely to enable the sales workspace.

## Verification and release acceptance

Local backend tests cover invitation single use/expiry, secure cookies, tenant isolation, CSRF, roles, revocation, atomic sharing, unchanged acquisition, duplicate submissions, draft suppression, unverified balances and delegated project access. Local responsive browser checks use synthetic mocked API responses; they are not authenticated production evidence.

Before marking production onboarding complete: authorized staff creates a test company, redeems the private invite on a separate browser, saves/reloads a property and request, verifies the staff queue, creates a second company's isolated account, links a consented test job, exercises quote approval, revokes access, and verifies it is denied. Validate Stripe using its safe test environment; never charge a live card just to smoke-test a release. Confirm actual receipts and provider webhooks independently. Archive/remove test tenant records through an authorized administrative process.
