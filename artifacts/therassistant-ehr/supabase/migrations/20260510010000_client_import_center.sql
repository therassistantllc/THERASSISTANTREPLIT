-- Client Import Center foundation
-- Stages uploaded import files and per-row validation before writing live client records.

create extension if not exists pgcrypto;

create table if not exists public.client_import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  source_system text not null default 'unknown',
  original_file_name text,
  file_type text,
  status text not null default 'uploaded',
  total_rows integer not null default 0,
  valid_rows integer not null default 0,
  invalid_rows integer not null default 0,
  imported_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  mapping jsonb,
  validation_summary jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint client_import_jobs_valid_status check (
    status in ('uploaded', 'mapped', 'validated', 'importing', 'completed', 'failed', 'cancelled')
  )
);

create table if not exists public.client_import_rows (
  id uuid primary key default gen_random_uuid(),
  import_job_id uuid not null references public.client_import_jobs(id) on delete cascade,
  row_number integer not null,
  raw_data jsonb not null,
  mapped_data jsonb,
  validation_errors jsonb,
  validation_warnings jsonb,
  duplicate_match_client_id uuid,
  import_status text not null default 'pending',
  imported_client_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint client_import_rows_valid_import_status check (
    import_status in ('pending', 'valid', 'invalid', 'duplicate', 'imported', 'skipped', 'failed')
  )
);

create index if not exists idx_client_import_jobs_organization_id
  on public.client_import_jobs (organization_id);

create index if not exists idx_client_import_jobs_status
  on public.client_import_jobs (status);

create index if not exists idx_client_import_jobs_created_at
  on public.client_import_jobs (created_at desc);

create index if not exists idx_client_import_rows_import_job_id
  on public.client_import_rows (import_job_id);

create index if not exists idx_client_import_rows_import_status
  on public.client_import_rows (import_status);

create index if not exists idx_client_import_rows_duplicate_match_client_id
  on public.client_import_rows (duplicate_match_client_id);

alter table public.client_import_jobs enable row level security;
alter table public.client_import_rows enable row level security;

drop policy if exists client_import_jobs_org_policy on public.client_import_jobs;
drop policy if exists client_import_jobs_service_role_policy on public.client_import_jobs;
drop policy if exists client_import_rows_org_policy on public.client_import_rows;
drop policy if exists client_import_rows_service_role_policy on public.client_import_rows;

-- Temporary organization-scoped policy aligned to current build-stage tables.
create policy client_import_jobs_org_policy
  on public.client_import_jobs
  for all
  to authenticated
  using (
    organization_id is null
    or organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      auth.jwt() ->> 'org_id',
      ''
    )
  )
  with check (
    organization_id is null
    or organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      auth.jwt() ->> 'org_id',
      ''
    )
  );

-- Service role policy for server-side administrative workflows.
create policy client_import_jobs_service_role_policy
  on public.client_import_jobs
  for all
  to service_role
  using (true)
  with check (true);

-- Row access inherits organization scope from parent import job.
create policy client_import_rows_org_policy
  on public.client_import_rows
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.client_import_jobs jobs
      where jobs.id = client_import_rows.import_job_id
        and (
          jobs.organization_id is null
          or jobs.organization_id::text = coalesce(
            auth.jwt() ->> 'organization_id',
            auth.jwt() -> 'app_metadata' ->> 'organization_id',
            auth.jwt() ->> 'org_id',
            ''
          )
        )
    )
  )
  with check (
    exists (
      select 1
      from public.client_import_jobs jobs
      where jobs.id = client_import_rows.import_job_id
        and (
          jobs.organization_id is null
          or jobs.organization_id::text = coalesce(
            auth.jwt() ->> 'organization_id',
            auth.jwt() -> 'app_metadata' ->> 'organization_id',
            auth.jwt() ->> 'org_id',
            ''
          )
        )
    )
  );

create policy client_import_rows_service_role_policy
  on public.client_import_rows
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.client_import_jobs is
  'Client import job metadata and aggregate validation/import status for staged file ingestion.';

comment on table public.client_import_rows is
  'Per-row staged import data with mapped fields, validation output, and import state.';
