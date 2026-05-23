---
name: workqueue_items insert schema
description: Required column shape, enum constraints, and uuid trap when inserting workqueue_items rows from any new code path.
---

# workqueue_items insert shape — get it right or the insert dies

When writing a new code path that files a `workqueue_items` row (manual review, exception, follow-up), the schema is stricter than it looks.

## The rules
- Use `client_id`, NEVER `patient_id`. The column is `client_id`. A row inserted with `patient_id` will hit "column does not exist".
- Use `work_type` (free-form text). Do NOT use `queue_type` — it's a legacy column that some old rows still carry but new insert paths should not set it.
- `source_object_type` is a Postgres ENUM (`public.source_object_type`). Valid values include: `appointment`, `encounter`, `claim`, `eligibility_check`, `authorization_or_referral`, `payment_import_item`, `payment_posting`, `client`, `insurance_policy`, `workqueue_item`, `mailroom_item`. Anything else (e.g. `stripe_charge`, `era_claim_payment` as a string) silently fails the enum cast.
- `source_object_id` is `uuid NOT NULL`. There is also a check constraint `workqueue_items_has_source` requiring BOTH `source_object_id` AND `source_object_type` to be NOT NULL together. **You cannot stash a non-uuid external id (Stripe `ch_...`, EDI control numbers, etc.) here.** If the source object isn't a uuid in our system, generate a synthetic `crypto.randomUUID()` for source_object_id and put the real external identifiers in `context_payload` (jsonb).

**Why:** New webhook/exception handlers tend to model their WQ insert after the upstream sender's vocabulary (`patient_id`, `queue_type`, `source_object_type:'stripe_charge'` for a Stripe handler, or analogous nouns for other senders). The DB rejects every one of those silently if the caller only logs and returns 200, which loses the obligation entirely while making the system look healthy.

**How to apply:** Before adding any new `.from("workqueue_items").insert(...)` call, grep an existing canonical insert (`workqueueRules.ts` is the reference). If you're representing an external system's id that isn't a uuid, mint a synthetic uuid for source_object_id and put the real id in context_payload — and make sure the caller treats a failed WQ insert as fail-loud (5xx + retry by the upstream sender), not a logged-and-ignored warning.
