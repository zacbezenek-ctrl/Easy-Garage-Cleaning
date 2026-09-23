# Named B2B staff invitation

Zac authorized one named staff invitation for Zoe Zoll (zoe.zoll@easygaragecleaning.com), username `zoe.zoll`, with the restricted `sales` role. This does not grant owner/manager business access, permission to share existing customer jobs, pricing authority, or payroll authority.

The deployment manifest is the pending invitation grant. It contains a SHA-256 digest only. The random 256-bit raw token is delivered only in the private email. `/staff-setup#invite=...` removes the fragment from history and has no analytics or browser storage. Viewing the page or inspecting the invitation does not activate or consume it. The holder must confirm the named work email and choose/confirm a password.

The server verifies the exact token and expiry before any identity lookup. It refuses collisions with configured staff or existing employee accounts. Activation creates one encrypted employee record with a create-only Firestore precondition, password hash, consumed marker, and sales authorization together. Simultaneous attempts cannot create multiple accounts or overwrite an existing account. Existing normal username/password sign-in and signed Hub-session restoration use that record. Owner rejection revokes issued sessions; replay cannot undo rejection. Existing employee account creation cannot supply the invitation authorization or raise its role.

The account is invited, not active, until Zoe completes activation. The private link expires September 25, 2026 at 18:23:57 UTC (12:23 PM America/Denver). It does not expire her normal password after activation. No automatic email is sent by deployment. Payroll pay rate remains unconfigured in this new Hub identity; existing payroll terms and systems are unchanged.

`/business-start` is the portal introduction, explicitly labeled work in progress. `/business-hub?staff=1` is her main B2B workspace; `/business-hub` is for clients with separate named company invitations; `/employee` is the employee workspace; `/customer-portal` requires a private project grant; `/book` is the public introduction/walkthrough request.

Tests use synthetic invitations only, exercise actual encryption and normal signed-session code with isolated Firestore transport, and cover competing redemption, replay, expiry, wrong email, collisions, privilege boundaries and owner revocation. Production acceptance uses GET only and does not consume the private invitation or claim Zoe has logged in.
