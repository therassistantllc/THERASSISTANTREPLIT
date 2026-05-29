-- Additional indexes for newly introduced billing RPC query paths.

create index if not exists idx_appointments_org_provider_active
  on public.appointments (organization_id, provider_id, id)
  where archived_at is null;

create index if not exists idx_appointments_org_practice_active
  on public.appointments (organization_id, provider_location_id, id)
  where archived_at is null;

create index if not exists idx_prof_claim_service_lines_org_claim_line_active
  on public.professional_claim_service_lines (organization_id, claim_id, line_number)
  where archived_at is null;

select pg_notify('pgrst', 'reload schema');
