# Email open tracking

EGC now has an in-house email open tracker.

## How it works

1. A unique opaque tracking record is created in Firestore.
2. The email HTML contains a 1×1 image whose URL is unique to that message.
3. When the email client requests that image, `/api/email-open/:token.gif` records the load and returns a transparent GIF.
4. The event is stored as an image load, not proof that a human read the email.

## Generic tracking endpoint

Authenticated business users can POST to:

`/api/email-tracking`

Example JSON:

```json
{
  "recipient": "customer@example.com",
  "subject": "Your Easy Garage Cleaning plan",
  "message_id": "optional-provider-message-id",
  "campaign": "b2b-outreach",
  "contact_id": "optional-crm-contact-id",
  "source": "ghl"
}
```

The response includes `pixel_url` and ready-to-paste `html`.

## EmailJS booking confirmations

`/api/email-confirmation` now provides the EmailJS template variable:

`{{tracking_pixel_url}}`

Add this HTML at the very bottom of the EmailJS template:

```html
<img src="{{tracking_pixel_url}}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden">
```

Do not display the URL in visible copy.

## Interpretation

Treat opens as `remote_image_loaded`, not a guaranteed human open. Apple Mail Privacy Protection, Gmail image proxying, security scanners, and corporate gateways can create false or proxied opens. Replies, booked walkthroughs, link clicks, and accepted quotes remain higher-confidence engagement signals.
