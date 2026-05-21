-- T004 Phase 1 compliance: Business Associate Agreement (BAA) tracker.
--
-- HIPAA requires the covered entity (this practice) to maintain a signed BAA with every
-- business associate that processes PHI on its behalf — at minimum Office Ally, Supabase,
-- the email provider, and the hosting platform. This table is the canonical, audit-friendly
-- record of those agreements.
--
-- Additive only.

create table if not exists public.business_associate_agreements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  counterparty_type text not null check (
    counterparty_type in ('office_ally','supabase','google_workspace','hosting','other')
  ),
  counterparty_name text not null,
  status text not null default 'not_started' check (
    status in ('not_started','draft','executed','expired','terminated')
  ),
  signed_at date,
  effective_at date,
  expires_at date,
  contact_name text,
  contact_email text,
  document_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active (non-terminated) BAA per (org, counterparty_type). Operators can add an
-- 'other' row freely (so the partial uniqueness only applies to the named counterparties).
create unique index if not exists idx_baa_org_counterparty_active
  on public.business_associate_agreements (organization_id, counterparty_type)
  where status <> 'terminated' and counterparty_type <> 'other';

create index if not exists idx_baa_org_status
  on public.business_associate_agreements (organization_id, status);

create index if not exists idx_baa_expiring
  on public.business_associate_agreements (organization_id, expires_at)
  where status = 'executed' and expires_at is not null;

alter table public.business_associate_agreements enable row level security;

drop policy if exists business_associate_agreements_org_policy on public.business_associate_agreements;
create policy business_associate_agreements_org_policy
  on public.business_associate_agreements
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
