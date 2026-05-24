# Supabase migration drift audit

One-shot tooling to detect and reconcile drift between
`supabase_migrations.schema_migrations` (what prod claims is applied) and
the actual live schema. Background and gotchas: see
`.agents/memory/migration-drift-audit.md` and
`.agents/memory/supabase-migration-drift.md`.

## Requirements

Both env vars must be set:

- `SUPABASE_PROJECT_REF` — e.g. `btsbmozbggjllpcsuyyy`
- `SUPABASE_ACCESS_TOKEN` — personal access token with project-DB access

All commands hit the Supabase Management API (`/v1/projects/<ref>/database/query`).

## Scripts

- `audit_migrations.mjs` — parses every `create table` and `alter table … add column`
  in `supabase/migrations/*.sql`, queries `information_schema` on the live DB, and
  writes `report.md` listing migrations whose objects are missing on prod.
  Maintains a `RENAMED` map so columns that a later migration renamed (e.g.
  `office_ally_*` → `availity_*`) are not falsely flagged as drift.
- `safety_check.mjs` — pre-flight before reconciliation: confirms tables we'd
  enforce `NOT NULL` on are empty (or already populated), and that FK target
  tables exist.
- `reconcile.mjs` — replays each drifted migration inside its own transaction.
  Patches two known incompatibilities discovered during Task #320:
    1. `20260505010000_enforce_client_schema_drift` is surgically reduced to its
       three missing `client_id` adds because live made `eligibility_status` a
       typed enum incompatible with the migration's text-literal check constraint.
    2. `20260505030000_office_ally_response_schemas` has its `era_claim_payments`
       index gated by an `information_schema` check because live's
       `era_claim_payments` was created with `professional_claim_id` instead of
       the migration's `claim_id`.
  After replay it runs `notify pgrst, 'reload schema'` so PostgREST picks up the
  new objects immediately.

## Usage

```bash
node artifacts/therassistant-ehr/scripts/audit-migrations/audit_migrations.mjs
node artifacts/therassistant-ehr/scripts/audit-migrations/safety_check.mjs
node artifacts/therassistant-ehr/scripts/audit-migrations/reconcile.mjs
# Then re-run the audit to confirm a clean state:
node artifacts/therassistant-ehr/scripts/audit-migrations/audit_migrations.mjs
```

## Last audit result

See `report.md` in this directory — generated 2026-05-24 after Task #320
reconciliation, showing 0 missing tables and 0 missing columns.
