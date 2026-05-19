-- Eligibility request preparation foundation
-- Stores normalized, safe eligibility request/response preparation state.

create extension if not exists pgcrypto;

create table if not exists public.eligibility_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  client_id uuid,
  payer_configuration_id uuid,
  payer_id text,
  payer_name text,
  provider_npi text,
  subscriber_id text,
  subscriber_first_name text,
  subscriber_last_name text,
  subscriber_dob date,
  patient_first_name text,
  patient_last_name text,
  patient_dob date,
  service_type_code text not null default '98',
  service_type_description text not null default 'Professional Services',
  request_mode text not null default 'mock',
  status text not null default 'created',
  availity_transaction_id uuid,
  request_payload_safe jsonb,
  response_payload_safe jsonb,
  eligibility_status text,
  copay_amount numeric,
  deductible_remaining numeric,
  effective_date date,
  termination_date date,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,

  constraint eligibility_requests_valid_request_mode check (
    request_mode in ('mock', 'demo', 'production')
  ),
  constraint eligibility_requests_valid_status check (
    status in ('created', 'prepared', 'submitted', 'completed', 'failed', 'cancelled')
  ),
  constraint eligibility_requests_service_type_98_default check (
    service_type_code <> ''
  )
);

create index if not exists idx_eligibility_requests_organization_id
  on public.eligibility_requests (organization_id);

create index if not exists idx_eligibility_requests_client_id
  on public.eligibility_requests (client_id);

create index if not exists idx_eligibility_requests_payer_configuration_id
  on public.eligibility_requests (payer_configuration_id);

create index if not exists idx_eligibility_requests_payer_id
  on public.eligibility_requests (payer_id);

create index if not exists idx_eligibility_requests_status
  on public.eligibility_requests (status);

create index if not exists idx_eligibility_requests_eligibility_status
  on public.eligibility_requests (eligibility_status);

create index if not exists idx_eligibility_requests_created_at
  on public.eligibility_requests (created_at desc);

create index if not exists idx_eligibility_requests_availity_transaction_id
  on public.eligibility_requests (availity_transaction_id);

alter table public.eligibility_requests enable row level security;

drop policy if exists eligibility_requests_org_policy on public.eligibility_requests;

-- Temporary organization-scoped policy aligned to existing payer/availity org policies.
create policy eligibility_requests_org_policy
  on public.eligibility_requests
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

comment on table public.eligibility_requests is
  'Internal eligibility request preparation records. Stores safe request/response payloads and normalized summary outputs.';

comment on column public.eligibility_requests.service_type_code is
  'EDI service type code; default must remain 98 (Professional Services).';

comment on column public.eligibility_requests.request_payload_safe is
  'Sanitized request payload with no credentials, tokens, authorization headers, or API keys.';

comment on column public.eligibility_requests.response_payload_safe is
  'Sanitized response payload with no credentials, tokens, authorization headers, or API keys.';
