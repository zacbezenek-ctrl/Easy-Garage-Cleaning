# EGC employee hub audit — September 2026

## Product decision

The employee hub is not a replacement CRM and should not imitate generic field-service software. HighLevel is Easy Garage Cleaning's source of truth for contacts, conversations, calendars, pipeline stages, lead attribution, and nurture automations.

The EGC hub exists to run the promise after a lead is created:

1. Surface today's HighLevel opportunities and walkthrough appointments.
2. Guide the free, diagnostic walkthrough.
3. Preserve the customer's why, desired outcome, scope, hazards, keep/remove rules, price, signature, and photos.
4. Hand the full context to the crew so the customer never repeats the story.
5. Enforce the arrival, execution, final reveal, payment, review, referral, and proof standards.
6. Measure contribution dollars per lead and per crew-hour.

## What was wrong

- The prior overlay described itself as “Jobber-style.”
- It created parallel invoices, payments, expenses, customers, tasks, time entries, services, and reports in Firebase.
- Crew tools searched Jobber and sent the walkthrough back to Jobber.
- The navigation reflected generic SaaS modules rather than EGC's actual operating flywheel.
- The dashboard optimized record coverage rather than walkthrough set rate, average ticket, contribution, continuity, and proof.
- Dense 10–13px interface text made the working surface feel administrative instead of field-ready.

## Correct system boundary

| System | Owns |
| --- | --- |
| HighLevel | Leads, contacts, conversations, appointments, pipeline, automations, attribution |
| EGC employee hub | Today view, walkthrough, signed scope, crew handoff, checklists, proof capture, operating scorecard |
| Accounting and payments | Invoices, deposits, payment ledger, payroll, books |
| Google Drive | Full-resolution job photos and signed agreements |
| Quo | Business-line transactional texts |

## Business decisions reflected in the rebuild

- Funnel: ad → free walkthrough → phone sells walkthrough → walkthrough sells job.
- Target average ticket: about $1,400.
- A very high close rate can indicate underpricing; contribution is more important than close rate alone.
- Target walkthrough set rate: about 50%.
- Value ladder: cleanout → deep clean → organization → shelving → full transformation.
- Pricing is flat by outcome and scope, not hourly.
- Minimum-job guardrail: roughly $499–$699.
- Service standard: big-company professionalism with small-company personalization.
- Crew lead owns the customer, scope continuity, payment, and closeout.
- Surprise ending is not advertised in advance.
- Reviews are requested at peak satisfaction during the reveal.
- Each job should produce transformation proof, personality content, and educational/engagement content.
- Ad tests isolate one hook at a time and are judged on qualified leads, booked jobs, and contribution.
- Follow-up belongs in HighLevel: day 0, 1, 3, 7, 14, 30, then 60/90.

## Rebuild completed

- Replaced the generic back-office sidebar with an EGC Field Command interface.
- Added Today, HighLevel Pipeline, Walkthroughs, Job Delivery, Scorecard, Proof Library, EGC Playbook, and Integrations views.
- Added a server-only HighLevel bridge for opportunities, pipelines, calendar events, contact lookup, walkthrough notes, closeout notes, and the six-month follow-up task.
- Converted Game Plan lookup, appointment loading, customer IDs, and final handoff from Jobber to HighLevel.
- Converted pre-job and post-job contact lookup to HighLevel.
- Made the post-job closeout write to HighLevel.
- Removed the new duplicate CRM ledgers from the visible product.
- Increased working text sizes and rebuilt the responsive visual system around a high-contrast field-command layout.

## Deployment blocker

The interface and bridge are complete. Live HighLevel data requires these Cloudflare environment values:

- `HIGHLEVEL_API_KEY` — HighLevel sub-account private integration token.
- `HIGHLEVEL_LOCATION_ID` — EGC HighLevel location ID.
- `HIGHLEVEL_WALKTHROUGH_CALENDAR_ID` — optional; if omitted, the bridge selects the first calendar with walkthrough/consult/estimate/quote in its name.
- `HIGHLEVEL_PIPELINE_ID` — optional; limits the mirror to the EGC sales pipeline.
- `HIGHLEVEL_USER_ID` — optional; assigns the six-month follow-up task and note author.

Required token scopes: contacts read/write, opportunities read, calendars/events read, contact notes write, and contact tasks write.
