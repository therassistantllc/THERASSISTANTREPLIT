-- Migration: 20260520000000_patient_intake_workflow.sql
-- Purpose: Patient intake workflow. Adds intake_status to clients,
--          and creates intake_links (one-time tokens) and intake_submissions
--          (form payloads + extracted scores) tables.

alter table public.clients
  add column if not exists intake_status text
    check (intake_status in ('not_started', 'pending', 'in_progress', 'complete'))
    default 'not_started';

create table if not exists public.intake_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  token text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'expired', 'revoked')),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  submission_id uuid
);

create index if not exists idx_intake_links_org_client
  on public.intake_links (organization_id, client_id, created_at desc);

create index if not exists idx_intake_links_token
  on public.intake_links (token);

create table if not exists public.intake_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  intake_link_id uuid references public.intake_links(id) on delete set null,
  status text not null default 'submitted'
    check (status in ('draft', 'submitted', 'reviewed')),
  demographics jsonb not null default '{}'::jsonb,
  insurance jsonb not null default '{}'::jsonb,
  consents jsonb not null default '{}'::jsonb,
  screeners jsonb not null default '{}'::jsonb,
  signature_name text,
  signature_signed_at timestamptz,
  phq9_score integer,
  gad7_score integer,
  phq9_severity text,
  gad7_severity text,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by_user_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_intake_submissions_org_client
  on public.intake_submissions (organization_id, client_id, submitted_at desc);

alter table public.intake_links enable row level security;
alter table public.intake_submissions enable row level security;

drop policy if exists intake_links_org_policy on public.intake_links;
create policy intake_links_org_policy on public.intake_links
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

drop policy if exists intake_submissions_org_policy on public.intake_submissions;
create policy intake_submissions_org_policy on public.intake_submissions
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
