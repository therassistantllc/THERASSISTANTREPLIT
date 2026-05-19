create extension if not exists pgcrypto;

create table if not exists public.encounter_clinical_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  provider_id uuid,
  note_status text not null default 'draft' check (
    note_status in ('draft', 'signed', 'voided')
  ),
  subjective text,
  interventions text,
  plan text,
  signed_at timestamptz,
  signed_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index if not exists idx_encounter_clinical_notes_unique_active
  on public.encounter_clinical_notes (organization_id, encounter_id)
  where archived_at is null;

create index if not exists idx_encounter_clinical_notes_client
  on public.encounter_clinical_notes (organization_id, client_id, updated_at desc)
  where archived_at is null;

alter table public.encounter_clinical_notes enable row level security;

drop policy if exists encounter_clinical_notes_org_policy on public.encounter_clinical_notes;
create policy encounter_clinical_notes_org_policy
  on public.encounter_clinical_notes
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

select pg_notify('pgrst', 'reload schema');
