---
name: Office Ally Phase 1 gate lessons
description: Two durable correctness rules from building the OA Phase 1 compliance gates (per-payer enrollment, raw-X12 transmission).
---

## Rule 1: per-payer enrollment lookups must filter `status='approved'` AND exclude terminated rows in SQL

The `payer_enrollments` table keeps terminated rows for audit history. A partial unique index `(org, payer, transaction_type, environment) WHERE status <> 'terminated'` enforces at-most-one active row at write time, but reads are not constrained.

**Why:** If you fetch all rows for a (org, payer, txn, env) tuple and then "last writer wins" in memory (Map.set), the row that wins is nondeterministic across drivers and can be a stale terminated/approved row. Production submission can then be incorrectly allowed.

**How to apply:** Every read path that gates on enrollment must include `.eq("status","approved").neq("status","terminated")` (or equivalent SQL predicate). Never trust client-side dedup. This applies symmetrically to any other table that keeps "tombstone" rows alongside an "active" lifecycle column.

## Rule 2: raw-X12 transmission endpoints cannot be gated by per-payer enrollment — restrict them to sandbox

Endpoints that accept a pre-built X12 string + organizationId (no batch reference) have no way to enumerate which payers are inside the envelope without parsing X12, so the per-payer enrollment gate cannot run.

**Why:** Leaving such an endpoint unrestricted in production silently bypasses the per-payer compliance gate that the batch route enforces. Office Ally trading-partner agreements require per-payer enrollment per transaction type per environment; a raw-X12 path is an unprotected back door.

**How to apply:** Resolve the active clearinghouse credential, and if `credential.environment === "production"` refuse with a 422 explaining the user must use the batch route. Sandbox transmissions are fine because sandbox never blocks on enrollment.
