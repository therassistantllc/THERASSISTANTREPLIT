-- Availity transaction logging layer
-- Supports 270/271 eligibility, 276/277 claim status, 837P submission, 835/ERA tracking

create extension if not exists pgcrypto;

create table if not exists public.availity_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  client_id uuid,
  encounter_id uuid,
  claim_id uuid,
  payer_id text,
  payer_name text,
  transaction_type text not null,
  transaction_direction text not null default 'outbound',
  environment text not null default 'demo',
  status text not null default 'created',
  request_method text,
  request_url text,
  request_headers_safe jsonb,
  request_body_safe jsonb,
  response_status integer,
  response_headers_safe jsonb,
  response_body_safe jsonb,
  external_transaction_id text,
  correlation_id text,
  error_message text,
  error_type text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  
  constraint valid_transaction_type check (transaction_type in (
    'eligibility_270',
    'eligibility_271',
    'claim_status_276',
    'claim_status_277',
    'claim_submission_837p',
    'era_835',
    'payer_list',
    'enrollment',
    'enrollment_status',
    'diagnostics',
    'token_test',
    'other'
  )),
  
  constraint valid_transaction_direction check (transaction_direction in (
    'outbound',
    'inbound',
    'internal'
  )),
  
  constraint valid_environment check (environment in (
    'demo',
    'production',
    'sandbox',
    'test'
  )),
  
  constraint valid_status check (status in (
    'created',
    'pending',
    'sent',
    'received',
    'completed',
    'failed',
    'cancelled'
  ))
);

-- Create indexes for common query patterns
create index if not exists idx_availity_transactions_organization
  on public.availity_transactions (organization_id)
  where organization_id is not null;

create index if not exists idx_availity_transactions_client
  on public.availity_transactions (client_id)
  where client_id is not null;

create index if not exists idx_availity_transactions_claim
  on public.availity_transactions (claim_id)
  where claim_id is not null;

create index if not exists idx_availity_transactions_payer
  on public.availity_transactions (payer_id)
  where payer_id is not null;

create index if not exists idx_availity_transactions_type
  on public.availity_transactions (transaction_type);

create index if not exists idx_availity_transactions_status
  on public.availity_transactions (status);

create index if not exists idx_availity_transactions_created_at
  on public.availity_transactions (created_at desc);

create index if not exists idx_availity_transactions_external_id
  on public.availity_transactions (external_transaction_id)
  where external_transaction_id is not null;

create index if not exists idx_availity_transactions_correlation_id
  on public.availity_transactions (correlation_id)
  where correlation_id is not null;

-- Row-level security
alter table public.availity_transactions enable row level security;

-- Drop existing policies if they exist
drop policy if exists availity_transactions_org_policy on public.availity_transactions;

-- Create organization-scoped policy for authenticated users
-- NOTE: This policy currently allows all authenticated users to read/write rows matching their organization_id.
-- Once the final org membership helper is confirmed, tighten this policy to ensure users
-- can only access their own organization's transactions.
create policy availity_transactions_org_policy
  on public.availity_transactions
  for all
  to authenticated
  using (
    organization_id is null
    or organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id is null
    or organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );
