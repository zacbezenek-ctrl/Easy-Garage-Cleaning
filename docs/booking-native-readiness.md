# Native website booking readiness

The QR destination stays `https://easygaragecleaning.com/book`.

This change prepares a clean white EGC booking page around the existing public website
HighLevel form. It reuses one small site logo, one navy heading, and one short sentence;
alternate links stay inside secondary help. It selects the existing public website
inquiry form for `/book`; it does not create a second form, submit data, or change
workflows, consent, pricing, guarantees, or financial terms.

## Exact public-form selection

The booking page's `.quote-form` element in `book.html` and `render_book()` in
`_generate_site.py` selects this owner-approved, existing public form:

```html
data-highlevel-form-url="https://links.easygaragecleaning.com/widget/form/DeiRNO6itxjLiTk3Nkj0"
```

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

## Follow-ups and release boundary

1. Disclosed UX follow-up: in HighLevel, give junk-only and other non-garage requests a truthful size
   choice (for example, “Not applicable — no garage”) or make garage size
   conditional. Verify the chosen service is retained without mapping it to a
   garage cleanout. Do not use “Not sure” to silently recategorize the request.
2. Finish any inner-form branding in HighLevel and recheck the actual mobile
   embed. The page reuses the EGC logo and supplies the heading and recovery links.
3. Retain accepted native-receipt evidence for this exact form and audit the
   current trigger configuration is isolated from internal quote and completion
   forms. Earlier QA receipts demonstrate persistence; they do not by themselves
   prove the current downstream behavior. Check that no unintended workflow,
   payment, or message fires, using only permitted test data if a new test is needed.
4. Parent reviews the exact configuration change and CI before deployment. The
   owner's public-form instruction authorizes this selection; the UX follow-up
   and unverified downstream behavior are not a blanket hold on showing the
   existing public form. They authorize no workflow or financial-setting change.

This task did not submit a real customer or test contact. The Web3Forms fallback
and direct native-form link remain available. No downstream automation is claimed
as verified, and no GHL workflow is enabled by this code change.
