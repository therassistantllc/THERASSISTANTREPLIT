# Stripe Webhook Runbook

Operator guide for configuring and recovering the Stripe webhook that
auto-posts patient card payments into client_payments.

Route: `app/api/billing/payments/stripe-webhook/route.ts`
Public URL: `POST {your-deployment}/api/billing/payments/stripe-webhook`

---

## 1. Set `STRIPE_WEBHOOK_SECRET`

The route refuses to process anything unless the shared signing secret is
configured. Without it, every delivery returns **503** and Stripe keeps
retrying — payments will *not* post.

1. In the Stripe Dashboard, go to **Developers → Webhooks → Add endpoint**.
2. Set the endpoint URL to
   `https://<your-deployment-domain>/api/billing/payments/stripe-webhook`.
3. After creating the endpoint, Stripe shows a **Signing secret** that
   starts with `whsec_…`. Copy it.
4. Add it as a secret on the Replit deployment with key
   `STRIPE_WEBHOOK_SECRET` (use the workspace Secrets pane — do not
   commit it to the repo or `.env` checked into git). Restart the
   web workflow so the new env var is picked up.
5. From the Stripe Dashboard, hit **Send test webhook** with
   `charge.succeeded`. A correct setup returns `200 {"success": true,
   "queuedForReview": true}` (queued because the test event has no
   metadata — see §3).

If you ever rotate the secret in Stripe, you must update
`STRIPE_WEBHOOK_SECRET` in the same step. Mismatched secrets return
**401 Invalid signature** and Stripe will retry until the secret is
fixed or the event is older than its retry window.

## 2. Which events to forward

Subscribe the endpoint to exactly these two event types:

- `charge.succeeded`
- `payment_intent.succeeded`

Both describe the same underlying charge; the route dedupes them via the
Stripe **charge id** so dual delivery results in a single
`client_payments` row. Any other event type is acknowledged with
`200 {ignored: true}` and has no side effects — there is no harm in
leaving extra events selected, but the two above are the minimum.

> Replay protection: events older than **5 minutes** (per the
> `Stripe-Signature` `t=` timestamp) are rejected with 401. If you
> manually resend an event from the Dashboard hours later, expect it to
> fail; trigger a fresh test event instead.

## 3. Required and optional metadata on the source payment

The route looks up which patient/organization to credit from
`metadata` on the Stripe object. Whatever creates the Checkout Session,
Payment Link, or PaymentIntent **must** set these:

| Key                          | Required? | Effect                                                                 |
| ---------------------------- | --------- | ---------------------------------------------------------------------- |
| `organization_id`            | **Yes**   | Tenant scope for the posted payment. Missing → workqueue review item.  |
| `client_id`                  | **Yes**   | Patient the payment is credited to. Missing → workqueue review item.   |
| `patient_invoice_id`         | Optional  | If present, applies the payment to that invoice automatically.         |
| `professional_claim_id`      | Optional  | If present (and no invoice id), applies to that claim.                 |

If neither `patient_invoice_id` nor `professional_claim_id` is set, the
payment is posted to the patient's **account balance** for a biller to
apply later.

Set metadata in whichever object initiates the charge:

- **Checkout Sessions:** pass `metadata` at session creation. Stripe
  copies it onto the resulting PaymentIntent and charge.
- **Payment Links:** under the link's **Advanced options → Metadata**,
  set the keys above. Per-customer values can be added via the
  `payment_intent_data[metadata]` parameter when you create the link
  through the API.
- **Direct PaymentIntents:** set `metadata` on the PaymentIntent at
  create time.

A zero-dollar charge is always routed to the review workqueue regardless
of metadata.

## 4. Recovering a workqueue item filed for missing metadata

When metadata is missing (or `commitPatientPayment` fails for any other
reason), the route writes a row into `workqueue_items` and returns
`200 {queuedForReview: true}` so Stripe stops retrying. The row looks
like:

- `work_type = 'patient_payment_review'`
- `status = 'open'`, `priority = 'high'`
- `source_object_type = 'payment_posting'`
- `context_payload` includes `origin: 'stripe_webhook'`,
  `stripe_charge_id`, `stripe_payment_intent_id`, `patient_invoice_id`,
  `amount_cents`, and the `reason` string.

To recover:

1. Open the workqueue and filter `work_type = patient_payment_review`.
   The title is `Review Stripe payment $<amount> (<ch_…>)`.
2. From `context_payload.stripe_charge_id`, find the charge in the
   Stripe Dashboard and identify the correct patient + organization.
3. Post the payment manually in the EHR payments UI. **Use the Stripe
   charge id as the External Payment ID** — the unique index on
   `(organization_id, payment_method='stripe', external_payment_id)`
   prevents accidental double-posting if the webhook later succeeds.
4. Resolve / close the workqueue item.
5. To prevent recurrence, fix the upstream source: update the Payment
   Link / Checkout Session creation code so it always sets
   `metadata.organization_id` and `metadata.client_id` before re-issuing.

> Do **not** "resend" the original event from the Dashboard hoping it
> will auto-post — the original Stripe object still has no metadata, so
> the webhook will just file another review item. Fix the source
> metadata on a new charge instead.

## 5. Quick troubleshooting

| Symptom                                          | Likely cause                                           |
| ------------------------------------------------ | ------------------------------------------------------ |
| Stripe shows repeated `503` deliveries           | `STRIPE_WEBHOOK_SECRET` not set on the deployment.     |
| Stripe shows repeated `401 Invalid signature`    | Secret in env doesn't match the endpoint's signing secret, or the event is older than 5 minutes (manual replay). |
| `200 {ignored: true}`                            | Event type isn't `charge.succeeded` or `payment_intent.succeeded`. Safe to ignore. |
| `200 {queuedForReview: true}`                    | Webhook accepted but couldn't auto-post — see §4.      |
| `200 {deferred: true}`                           | A PI event arrived with no resolvable charge id; the matching `charge.succeeded` will post it. |
