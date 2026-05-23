---
name: Supabase live DB drifts from in-repo migrations
description: When applying pending migrations to the linked Supabase DB, tables/columns referenced by "registered" migrations are often absent and replays hit "relation does not exist". Apply prerequisites surgically, do not replay the whole chain.
---

The `supabase_migrations.schema_migrations` table on the live DB cannot be trusted as a faithful record of what actually ran. Tables created by long-registered migrations are routinely missing on prod (e.g. era_claim_payments existed but with `professional_claim_id` instead of the migration's `claim_id`; insurance_manual_payments + client_payments missing entirely though their creator migration was marked applied).

**Why:** The repo's migration files have been edited/rewritten over time, but earlier versions were what actually ran against prod. The version numbers still match so they look "applied". Combined with `wipe_demo_data` migrations that only DELETE rows (don't drop tables), and likely manual schema patching done outside the migrations folder.

**How to apply:**
1. Do NOT loop through all pending migrations top-to-bottom — you'll hit a cascade of "relation does not exist" / "column does not exist" failures from the drifted ones (most commonly anything that touches `era_claim_payments` or the eligibility_* tables created by `20260505030000_office_ally_response_schemas.sql`).
2. Identify the specific tables/columns the user's UI is failing on (`Could not find the table 'public.X' in the schema cache`).
3. Find the creator migration via `rg -l "create table.*X"` then re-run THAT migration (most are `create table if not exists` so safe) plus any direct prerequisite migrations the failing one ALTERs.
4. After applying, run `psql -c "notify pgrst, 'reload schema';"` so PostgREST picks up the new tables immediately (otherwise the UI keeps seeing the cached "not found" until the cache TTL expires).
5. Verify with `curl -H "apikey: $ANON_KEY" "$SUPABASE_URL/rest/v1/<table>?select=id&limit=1"` — 200 means PostgREST sees it.

**Connection detail (this project, btsbmozbggjllpcsuyyy):** pooler region is `aws-1-us-east-2`. Direct `db.<ref>.supabase.co:5432` is IPv6-only and unreachable from the Replit sandbox — must go through `aws-1-us-east-2.pooler.supabase.com:6543` with user `postgres.<ref>`.
