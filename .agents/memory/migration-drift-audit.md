---
name: migration-drift-audit
description: How to sweep every "applied" Supabase migration for objects missing on prod, plus the rename/enum gotchas that make naive replays fail.
---

# Auditing Supabase migration drift wholesale

When `supabase_migrations.schema_migrations` cannot be trusted (see `supabase-migration-drift.md`), parse every `create table` / `alter table … add column` in `supabase/migrations/*.sql` and check existence via `information_schema.tables` / `information_schema.columns` over the Management API. A reusable audit + reconciler lives under `.local/audit/` in this repo.

**Why:** Prior fixes addressed only the table the UI complained about. The same drift class (`schema_migrations` row present but object missing) is widespread — a single sweep is cheaper than chasing one bug report at a time.

**How to apply:**
- Audit script must treat renamed columns as present. Some "missing" columns from older migrations were renamed by a later migration (e.g. `office_ally_*` → `availity_*` from `20260521002000_availity_replaces_office_ally.sql`). Replaying the original `add column if not exists office_ally_claim_id` against live would create a dead duplicate. Maintain an explicit RENAMED map in the audit and skip those.
- Replay is per-migration, in its own transaction. Most are idempotent (`if not exists`, `drop policy if exists`/`create policy`) and safe to re-run, but two gotcha patterns recur:
  1. **Enum vs text-check mismatch.** `enforce_client_schema_drift` adds a text-literal check constraint (`'not_found'`, …) on `eligibility_checks.eligibility_status`, but on live that column is the `eligibility_status` enum (`not_checked,active,inactive,pending,error`). The constraint fails to cast the literal. Surgical-apply only the missing pieces (the three `client_id` adds); skip the check constraint.
  2. **Tables created elsewhere with a different shape.** `era_claim_payments` exists on live with `professional_claim_id` instead of the migration's `claim_id`. `create table if not exists` is a no-op, then `create index … on (claim_id, …)` blows up. Gate offending statements with a `do $$ … information_schema.columns … $$` guard before running them.
- ALTER-TABLE-IF-EXISTS silently skips when the target table is absent. If one replayed migration creates a table that an earlier migration tried to ALTER, you must re-run that earlier migration's ALTERs after the table exists (e.g. `clearinghouse_api_requests.raw_response_json` was only fully populated after the table-creator migration was replayed).
- JS pitfall when patching SQL via `String.replace`: `$$` in the replacement string is the meta-sequence for `$`, mangling Postgres dollar-quoted blocks. Use a function replacement (`replace(re, () => '…')`) or `$$$$`.
