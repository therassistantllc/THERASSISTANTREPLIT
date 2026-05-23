-- Task #244: stop duplicate intake submissions from creating duplicate
-- insurance policies.
--
-- The intake route does a read-then-insert on insurance_policies keyed on
-- (client_id, priority='primary'). Two near-simultaneous intake submits
-- (slow network + retry, double-click, two tabs) can both miss the SELECT
-- and both INSERT, producing two "primary" policies for the same client.
-- Downstream eligibility and claim submission then can't tell which one
-- to use.
--
-- An existing partial unique index `uq_primary_policy_per_client` already
-- covers the (organization_id, client_id) shape for priority='primary'
-- only. Task #244 widens the protection to ANY priority so secondary /
-- tertiary intake paths can't race in the same way, mirroring the rest
-- of the sweep in 20260601000000_find_or_create_dedupe_indexes.sql:
--
--   1. partial unique index at the DB (WHERE archived_at IS NULL) so
--      a row can be legitimately re-created after the prior one is
--      archived.
--   2. application code (app/api/intake/[token]/route.ts) catches the
--      resulting 23505 unique_violation and falls back to its existing
--      UPDATE branch, so concurrent callers deterministically converge
--      on the same policy id.

do $$
begin
  if to_regclass('public.insurance_policies') is not null then
    create unique index if not exists idx_insurance_policies_unique_active_client_priority
      on public.insurance_policies (client_id, priority)
      where archived_at is null;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
