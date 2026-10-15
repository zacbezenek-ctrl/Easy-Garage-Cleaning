# Native website booking readiness

The QR destination stays `https://easygaragecleaning.com/book`.

This change prepares the EGC navy/orange wrapper around the existing public website
HighLevel form. It does not activate the embed, create a second form, submit data,
or change workflows, consent, pricing, guarantees, or financial terms.

## Exact activation switch

After acceptance and parent review, add this attribute to the booking page's
`.quote-form` element in `render_book()` in `_generate_site.py`, then regenerate
`book.html` with the recorded site build date:

```html
data-highlevel-form-url="https://links.easygaragecleaning.com/widget/form/DeiRNO6itxjLiTk3Nkj0"
```

The attribute is deliberately absent from both production sources in this PR.
Do not substitute an estimator, door-to-door, or crew-completion form. Removing
the attribute restores the existing Web3Forms path. The enhanced page also keeps
an explicit standard-form recovery action and a direct link to the same native
form. Neither an iframe load event nor a browser message proves submission.

## Verified native fields, 2026-10-15

- Required: Name, Phone, Garage size.
- Optional: Service and SMS consent. SMS consent starts unchecked.
- Service choices: Garage Cleanout, Junk Removal, Furniture, Appliances, Mattress,
  Storage Unit, Organization, Other / Not sure.
- Garage sizes: 1-car garage, 2-car garage, 3-car or larger, Garage + other spaces,
  Not sure — call me.

The wrapper does not preselect or transform service fields. The native form is
the only place collecting contact data and consent. Its inner styling belongs to
HighLevel; parent-page CSS cannot change it across origins.

## Remaining acceptance gates

1. In HighLevel, give junk-only and other non-garage requests a truthful size
   choice (for example, “Not applicable — no garage”) or make garage size
   conditional. Verify the chosen service is retained without mapping it to a
   garage cleanout. Do not use “Not sure” to silently recategorize the request.
2. Finish any inner-form branding in HighLevel and recheck the actual mobile
   embed. The wrapper supplies the EGC logo, colors, heading, and recovery links.
3. Retain accepted native-receipt evidence for this exact form and verify the
   current trigger configuration is isolated from internal quote and completion
   forms. Earlier QA receipts demonstrate persistence; they do not by themselves
   prove the current downstream behavior. Check that no unintended workflow,
   payment, or message fires, using only permitted test data if a new test is needed.
4. Parent reviews the exact configuration change before production enablement.

This task did not submit a real customer or test contact. Keep the current
Web3Forms fallback available until all gates pass.
