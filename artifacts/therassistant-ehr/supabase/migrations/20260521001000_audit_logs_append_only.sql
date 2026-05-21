-- T005 Phase 1 compliance: enforce audit_logs append-only at the database layer.
--
-- HIPAA §164.312(b) requires audit controls that record and examine activity. To make those
-- records trustworthy, no application-layer role may UPDATE or DELETE existing audit rows.
-- INSERT and SELECT are the only operations that survive.
--
-- Note on residual exposure: the `postgres` superuser role inherently bypasses GRANT/REVOKE,
-- so a sufficiently-privileged operator with direct DB access can still modify these rows.
-- That is the standard, accepted residual exposure for Postgres-based audit tables; the
-- compensating control is restricting access to the superuser role (managed by Supabase) and
-- rotating it.
--
-- Application audit code uses .insert(); a sweep of the codebase before this migration
-- confirmed no .update() or .delete() callers exist for public.audit_logs.

-- Drop any mutating privileges that may have been granted historically.
revoke update, delete, truncate on public.audit_logs from public;
revoke update, delete, truncate on public.audit_logs from anon;
revoke update, delete, truncate on public.audit_logs from authenticated;
revoke update, delete, truncate on public.audit_logs from service_role;

-- Re-grant only the verbs we want callers to ever have on this table.
grant insert, select on public.audit_logs to authenticated;
grant insert, select on public.audit_logs to service_role;

-- Belt-and-suspenders RLS: even if a future GRANT slips through, RLS will block UPDATE/DELETE.
-- INSERT and SELECT policies are unchanged (governed by the existing org_policy elsewhere).
do $$
begin
  if exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'audit_logs_no_update'
  ) then
    drop policy audit_logs_no_update on public.audit_logs;
  end if;
  if exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'audit_logs_no_delete'
  ) then
    drop policy audit_logs_no_delete on public.audit_logs;
  end if;
end$$;

create policy audit_logs_no_update on public.audit_logs
  for update to public
  using (false) with check (false);

create policy audit_logs_no_delete on public.audit_logs
  for delete to public
  using (false);

select pg_notify('pgrst', 'reload schema');
