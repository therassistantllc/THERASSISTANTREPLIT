create extension if not exists pgcrypto;

create table if not exists public.charge_capture_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  provider_id uuid,
  appointment_id uuid,
  insurance_policy_id uuid,
  source_object_type text not null default 'encounter',
  source_object_id uuid not null,
  charge_status text not null default 'captured' check (
    charge_status in ('captured', 'ready_for_claim', 'claim_created', 'blocked', 'voided')
  ),
  service_date date not null,
  diagnosis_codes text[] not null default '{}'::text[],
  service_lines jsonb not null default '[]'::jsonb,
  total_charge numeric(12,2) not null default 0,
  place_of_service text,
  claim_id uuid,
  blocker_reasons jsonb not null default '[]'::jsonb,
  captured_at timestamptz not null default now(),
  claim_created_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index if not exists idx_charge_capture_items_encounter_active
  on public.charge_capture_items (encounter_id)
  where archived_at is null and charge_status <> 'voided';

create index if not exists idx_charge_capture_items_org_status
  on public.charge_capture_items (organization_id, charge_status, captured_at desc)
  where archived_at is null;

create index if not exists idx_charge_capture_items_client
  on public.charge_capture_items (organization_id, client_id, captured_at desc)
  where archived_at is null;

alter table public.charge_capture_items enable row level security;

drop policy if exists charge_capture_items_org_policy on public.charge_capture_items;
create policy charge_capture_items_org_policy
  on public.charge_capture_items
  for all
  to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

select pg_notify('pgrst', 'reload schema');
