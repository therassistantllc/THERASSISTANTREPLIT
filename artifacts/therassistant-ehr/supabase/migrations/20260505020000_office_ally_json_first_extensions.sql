-- File: supabase/migrations/20260505_office_ally_json_first_extensions.sql
-- Purpose: JSON-first Office Ally API support.

create extension if not exists pgcrypto;

alter table if exists public.eligibility_checks
  add column if not exists raw_response_json jsonb not null default '{}'::jsonb,
  add column if not exists raw_response_x12 text null,
  add column if not exists office_ally_transaction_id text null,
  add column if not exists response_status_code text null,
  add column if not exists response_status_description text null;

alter table if exists public.claim_status_inquiries
  add column if not exists raw_response_json jsonb not null default '{}'::jsonb,
  add column if not exists raw_response_x12 text null,
  add column if not exists office_ally_transaction_id text null,
  add column if not exists response_status_code text null,
  add column if not exists response_status_description text null;

alter table if exists public.clearinghouse_api_requests
  add column if not exists raw_response_json jsonb not null default '{}'::jsonb,
  add column if not exists raw_response_x12 text null;

create table if not exists public.payer_search_option_configs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null,
  vendor text not null default 'office_ally',
  payer_id text not null,
  payer_name text null,
  search_options jsonb not null default '[]'::jsonb,
  required_fields jsonb not null default '[]'::jsonb,
  optional_fields jsonb not null default '[]'::jsonb,
  raw_response_json jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null
);

create unique index if not exists idx_payer_search_option_configs_vendor_payer_active
  on public.payer_search_option_configs (vendor, payer_id)
  where archived_at is null;

create index if not exists idx_eligibility_checks_oa_transaction_id
  on public.eligibility_checks (office_ally_transaction_id)
  where office_ally_transaction_id is not null;

create index if not exists idx_claim_status_inquiries_oa_transaction_id
  on public.claim_status_inquiries (office_ally_transaction_id)
  where office_ally_transaction_id is not null;

alter table public.payer_search_option_configs enable row level security;

drop policy if exists payer_search_option_configs_org_policy on public.payer_search_option_configs;
create policy payer_search_option_configs_org_policy on public.payer_search_option_configs
  for all to authenticated
  using (
    organization_id is null
    or organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id is null
    or organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );
