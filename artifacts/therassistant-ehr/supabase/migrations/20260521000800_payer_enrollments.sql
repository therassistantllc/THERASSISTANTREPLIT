-- T003 Phase 1 compliance: per-payer trading-partner enrollments.
--
-- Office Ally requires a separate, payer-specific enrollment for each EDI transaction type
-- (837P claims, 835 ERA, 270/271 eligibility, 276/277 status). Production claims for a payer
-- cannot legally be transmitted until the (payer, transaction_type, production) enrollment is
-- "approved" on the Office Ally portal.
--
-- Additive only; no other table is modified.

create table if not exists public.payer_enrollments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payer_profile_id uuid not null references public.payer_profiles(id) on delete cascade,
  transaction_type text not null check (transaction_type in ('837P','837I','835','270','276','999')),
  environment text not null check (environment in ('sandbox','production')),
  status text not null default 'pending' check (status in ('pending','submitted','approved','rejected','terminated')),
  oa_enrollment_reference text,
  approved_at timestamptz,
  expires_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one non-terminated enrollment per (org, payer, transaction, env).
-- Terminated rows are kept for audit history.
create unique index if not exists idx_payer_enrollments_unique_active
  on public.payer_enrollments (organization_id, payer_profile_id, transaction_type, environment)
  where status <> 'terminated';

create index if not exists idx_payer_enrollments_org_status
  on public.payer_enrollments (organization_id, status);

create index if not exists idx_payer_enrollments_payer
  on public.payer_enrollments (organization_id, payer_profile_id);

alter table public.payer_enrollments enable row level security;

drop policy if exists payer_enrollments_org_policy on public.payer_enrollments;
create policy payer_enrollments_org_policy
  on public.payer_enrollments
  for all to authenticated
  using (
    organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      ''
    )
  )
  with check (
    organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      ''
    )
  );

select pg_notify('pgrst', 'reload schema');
