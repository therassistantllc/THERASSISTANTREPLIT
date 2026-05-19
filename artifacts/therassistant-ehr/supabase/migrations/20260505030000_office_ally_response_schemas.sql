-- File: supabase/migrations/20260505_office_ally_response_schemas.sql
-- Purpose: Add Office Ally/API response schemas beyond base EDI transaction logging.
-- Covers: realtime health checks, API request auditing, TA1/999/277CA acknowledgments,
-- 271 benefit details, 277 status details, and 835/ERA adjudication structure.

create extension if not exists pgcrypto;

create table if not exists public.clearinghouse_health_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null,
  vendor text not null default 'office_ally',
  connection_id uuid null,
  endpoint_name text not null,
  endpoint_url text null,
  transport text not null check (transport in ('soap', 'mime', 'sftp', 'api', 'system')),
  status text not null check (status in ('healthy', 'degraded', 'down', 'unknown')),
  http_status integer null,
  latency_ms integer null,
  response_summary text null,
  raw_response text null,
  error_message text null,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.clearinghouse_api_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid null,
  vendor text not null default 'office_ally',
  operation text not null,
  transport text not null check (transport in ('soap', 'mime', 'sftp', 'api')),
  endpoint_url text null,
  http_method text null,
  http_status integer null,
  request_headers jsonb not null default '{}'::jsonb,
  response_headers jsonb not null default '{}'::jsonb,
  request_body text null,
  response_body text null,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  payload_id text null,
  sender_id text null,
  receiver_id text null,
  processing_mode text null,
  core_rule_version text null,
  edi_transaction_id uuid null,
  status text not null default 'created' check (status in ('created', 'sent', 'received', 'parsed', 'failed')),
  error_message text null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null,
  created_at timestamptz not null default now()
);

create table if not exists public.edi_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid null,
  claim_id uuid null,
  edi_transaction_id uuid null,
  source_file_name text null,
  acknowledgment_type text not null check (acknowledgment_type in ('TA1', '999', '277CA', 'file_summary', 'edi_status')),
  acknowledgment_status text not null check (acknowledgment_status in ('accepted', 'partially_accepted', 'rejected', 'error', 'unknown')),
  interchange_control_number text null,
  group_control_number text null,
  transaction_set_control_number text null,
  payer_id text null,
  payer_name text null,
  office_ally_file_id text null,
  office_ally_claim_id text null,
  status_code text null,
  status_message text null,
  raw_codes jsonb not null default '{}'::jsonb,
  raw_response text null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  archived_at timestamptz null
);

create table if not exists public.eligibility_benefit_segments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  eligibility_check_id uuid not null,
  client_id uuid not null,
  payer_id text null,
  payer_name text null,
  service_type_code text null,
  service_type_description text null,
  benefit_information_code text null,
  benefit_description text null,
  coverage_level_code text null,
  insurance_type_code text null,
  plan_coverage_description text null,
  time_period_qualifier text null,
  monetary_amount numeric null,
  percent_amount numeric null,
  quantity_qualifier text null,
  quantity numeric null,
  authorization_or_certification_required boolean null,
  in_plan_network_indicator text null,
  eligibility_date_from date null,
  eligibility_date_to date null,
  messages jsonb not null default '[]'::jsonb,
  raw_eb_segment jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  archived_at timestamptz null
);

create table if not exists public.claim_status_response_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  claim_status_inquiry_id uuid not null,
  claim_id uuid not null,
  client_id uuid not null,
  payer_id text null,
  payer_name text null,
  status_category_code text null,
  status_code text null,
  entity_code text null,
  status_effective_date date null,
  total_charge_amount numeric null,
  paid_amount numeric null,
  check_eft_number text null,
  payer_claim_control_number text null,
  service_date_from date null,
  service_date_to date null,
  message text null,
  raw_stc_segment jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  archived_at timestamptz null
);

create table if not exists public.era_claim_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payment_import_item_id uuid null,
  edi_transaction_id uuid null,
  claim_id uuid null,
  client_id uuid null,
  payer_name text null,
  payer_id text null,
  payee_npi text null,
  payee_tax_id text null,
  check_or_eft_number text null,
  trace_number text null,
  payer_claim_control_number text null,
  patient_control_number text null,
  claim_status_code text null,
  total_charge_amount numeric null,
  paid_amount numeric null,
  patient_responsibility_amount numeric null,
  claim_filing_indicator_code text null,
  received_at timestamptz null,
  raw_clp_segment jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  archived_at timestamptz null
);

create table if not exists public.era_service_line_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  era_claim_payment_id uuid not null,
  claim_id uuid null,
  claim_service_line_id uuid null,
  service_line_number integer null,
  cpt_hcpcs_code text null,
  modifiers text[] null,
  charge_amount numeric null,
  paid_amount numeric null,
  allowed_amount numeric null,
  units numeric null,
  service_date date null,
  raw_svc_segment jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  archived_at timestamptz null
);

create table if not exists public.era_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  era_claim_payment_id uuid null,
  era_service_line_payment_id uuid null,
  claim_id uuid null,
  adjustment_scope text not null check (adjustment_scope in ('claim', 'service_line')),
  group_code text null,
  reason_code text null,
  reason_description text null,
  amount numeric null,
  quantity numeric null,
  remark_codes text[] null,
  created_at timestamptz not null default now(),
  archived_at timestamptz null
);

create index if not exists idx_clearinghouse_health_checks_vendor_endpoint_checked
  on public.clearinghouse_health_checks (vendor, endpoint_name, checked_at desc);

create index if not exists idx_clearinghouse_api_requests_org_operation_created
  on public.clearinghouse_api_requests (organization_id, operation, created_at desc);

create index if not exists idx_edi_acknowledgments_org_claim_type_received
  on public.edi_acknowledgments (organization_id, claim_id, acknowledgment_type, received_at desc)
  where archived_at is null;

create index if not exists idx_eligibility_benefit_segments_check_client
  on public.eligibility_benefit_segments (eligibility_check_id, client_id, service_type_code)
  where archived_at is null;

create index if not exists idx_claim_status_response_lines_claim_inquiry
  on public.claim_status_response_lines (claim_id, claim_status_inquiry_id, created_at desc)
  where archived_at is null;

create index if not exists idx_era_claim_payments_org_claim_trace
  on public.era_claim_payments (organization_id, claim_id, trace_number, created_at desc)
  where archived_at is null;

create index if not exists idx_era_service_line_payments_claim_payment
  on public.era_service_line_payments (claim_id, era_claim_payment_id)
  where archived_at is null;

create index if not exists idx_era_adjustments_claim_reason
  on public.era_adjustments (claim_id, reason_code, group_code)
  where archived_at is null;

alter table public.clearinghouse_health_checks enable row level security;
alter table public.clearinghouse_api_requests enable row level security;
alter table public.edi_acknowledgments enable row level security;
alter table public.eligibility_benefit_segments enable row level security;
alter table public.claim_status_response_lines enable row level security;
alter table public.era_claim_payments enable row level security;
alter table public.era_service_line_payments enable row level security;
alter table public.era_adjustments enable row level security;

-- Service role bypasses RLS. Authenticated org policies are included for future UI reads.
drop policy if exists clearinghouse_api_requests_org_policy on public.clearinghouse_api_requests;
create policy clearinghouse_api_requests_org_policy on public.clearinghouse_api_requests
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

drop policy if exists edi_acknowledgments_org_policy on public.edi_acknowledgments;
create policy edi_acknowledgments_org_policy on public.edi_acknowledgments
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

drop policy if exists eligibility_benefit_segments_org_policy on public.eligibility_benefit_segments;
create policy eligibility_benefit_segments_org_policy on public.eligibility_benefit_segments
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

drop policy if exists claim_status_response_lines_org_policy on public.claim_status_response_lines;
create policy claim_status_response_lines_org_policy on public.claim_status_response_lines
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

drop policy if exists era_claim_payments_org_policy on public.era_claim_payments;
create policy era_claim_payments_org_policy on public.era_claim_payments
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

drop policy if exists era_service_line_payments_org_policy on public.era_service_line_payments;
create policy era_service_line_payments_org_policy on public.era_service_line_payments
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

drop policy if exists era_adjustments_org_policy on public.era_adjustments;
create policy era_adjustments_org_policy on public.era_adjustments
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));
