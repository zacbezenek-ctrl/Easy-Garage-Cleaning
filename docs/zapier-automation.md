# EGC Full Automation System — Zapier + Quo + Firestore

> **Owner reference** for Easy Garage Cleaning lead automation.  
> Employee CRM: `employee.html` → More → Automation System.

## Database

**Collection:** `leads` (Firebase Firestore)

| Property | Value |
|----------|--------|
| Document ID | **Facebook Lead ID** for FB leads; E.164 phone for website/manual leads |
| Primary fields | `status`, `contactAttempts`, `optedOutAt`, `conversationActive`, `lastTouchAt`, `lastOutboundAt`, `nextFollowUpAt`, `scheduledJobAt`, `notifiedAt`, `reviewRequestedAt` |
| Contact fields | `name`, `email`, `items`, `source`, `assignedTo`, `serviceZip`, `lossReason` |

### Status funnel

| Status | Meaning |
|--------|---------|
| `new` | Not quoted yet |
| `quoted` | Price given, not booked |
| `booked` | Job scheduled |
| `dead` | Closed / lost (includes manual dead) |
| `no_answer_6_attempts` | Dead variant after 6 cadence tries |

**Legacy mapping (CRM UI):** `converted` / `scheduled` → `booked`; `lost` / `contacted` → mapped in employee CRM.

---

## API Endpoints (Cloudflare Pages Functions)

### POST /api/lead-intake
Receives new lead data and writes to Firestore. Use this as the Zapier webhook target for Facebook Lead Ads (replaces direct Firestore write).

**Zapier setup:** Webhooks by Zapier → POST → `https://easygaragecleaning.com/api/lead-intake`

| Field | Maps from | Required |
|-------|-----------|----------|
| `leadId` | Facebook Lead ID | Yes (used as Firestore doc ID) |
| `name` | Full Name | Yes |
| `firstName` | First Name | No |
| `phone` | Phone Number | Yes |
| `email` | Email | No |
| `items` | What service / items | No |
| `source` | Hardcode `Facebook Ads (fb)` | No (defaults to FB) |
| `serviceZip` | Zip code | No |
| `message` | Any notes | No |

### POST /api/sms-event
Receives SMS events and updates the correct lead by phone lookup. Use this instead of direct Firestore writes for Zaps 2A/2B/3.

**Zapier setup:** Webhooks by Zapier → POST → `https://easygaragecleaning.com/api/sms-event`

| Field | Value |
|-------|-------|
| `phone` | SMS sender/recipient phone number |
| `direction` | `inbound` or `outbound` |
| `stop` | `true` if STOP message (TCPA opt-out) |

**Env var required:** `FIREBASE_API_KEY` in Cloudflare Pages dashboard.

---

## Zaps (1–8)

### Zap 1 — Facebook Lead Intake
- Trigger: Facebook Lead Ads
- Action: **Webhooks by Zapier → POST to `/api/lead-intake`** with lead fields mapped
- The endpoint writes to Firestore using the Facebook Lead ID as the doc ID

### Zap 2A — Inbound SMS
- Trigger: Quo inbound SMS
- Action: **Webhooks by Zapier → POST to `/api/sms-event`** with `phone` and `direction: inbound`
- The endpoint looks up the lead by phone and updates the correct document

### Zap 2B — Outbound SMS
- Trigger: Quo outbound SMS
- Action: **Webhooks by Zapier → POST to `/api/sms-event`** with `phone` and `direction: outbound`

### Zap 3 — STOP (TCPA)
- Trigger: Inbound SMS contains STOP
- Action: **POST to `/api/sms-event`** with `phone` and `stop: true`
- Sets `optedOutAt` — **never message again**

### Zap 4 — No-Answer Cadence
- Schedule: Hourly, business hours 9am–6pm MT
- Logic: `contactAttempts` 0→5 while `status=new`, cadence not paused
- After 6 attempts: `status=dead` or `no_answer_6_attempts`
- **Paused when:** `conversationActive=true` OR `optedOutAt` set

### Zap 5 — Quote Follow-Up
- Trigger: `status=quoted`
- Action: Automated follow-up SMS via Quo

### Zap 6 — Booking Confirmation
- Trigger: `status=booked`
- Action: Confirmation SMS via Quo

### Zap 7 — Review Request
- Trigger: Job complete
- Action: Quo SMS with Google review link (`GBP_REVIEW_URL` in `_generate_site.py`)

### Zap 8 — Daily Digest
- Schedule: 9pm MT daily
- Recipients: Zac, Tyler

---

## Website → Zapier field map (Web3forms)

Forms: `index.html` (#quote wizard), `book.html`

| Web3forms field | Firestore field | Notes |
|-----------------|-----------------|-------|
| `phone` | doc ID + `phone` | E.164 normalized on submit |
| `name` | `name` | |
| `email` | `email` | |
| `items` | `items` | Service type + job size |
| `serviceZip` | `serviceZip` | From zip field |
| `source` | `source` | Always `Website` |
| `status` | `status` | Always `new` |
| `estimated_range` | (Zap maps) | From size tier |
| `booking_slot` | (Zap maps) | Preferred slot |
| `flow_type` | (Zap maps) | `call_text` or `booking` |
| `What to remove` | message body | Human-readable summary for Zap |

HTML comment in forms: `<!-- Zapier Zap: Web3forms → Firestore leads (phone doc ID) -->`

---

## Employee CRM behavior

- **No auto-delete** of leads
- Manual status change warns about Zaps 5/6/7
- Mark dead requires confirm + optional `lossReason`
- Opted-out leads: SMS buttons disabled (TCPA)
- Convert lead → job sets `status=booked` + `scheduledJobAt`
- Facebook leads use FB lead ID as doc ID; website/manual leads use E.164 phone or auto ID
- Ghost documents (phone-keyed docs with only conversation fields) are auto-merged by the CRM into the correct lead and deleted

---

## Safety / TCPA

- `optedOutAt` set by Zap 3 (STOP) or admin "Mark opted out"
- Never send automated SMS when opted out
- Cadence pauses on active conversation or opt-out
