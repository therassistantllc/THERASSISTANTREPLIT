-- File: supabase/migrations/20260424_clearinghouse_intelligence.sql
create extension if not exists pgcrypto;

create table if not exists public.clearinghouse_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  vendor text not null check (vendor in ('office_ally', 'availity', 'change_healthcare', 'mock')),
  connection_name text,
  mode text not null default 'test' check (mode in ('test', 'live')),
  submitter_id text,
  receiver_id text,
  api_base_url text,
  auth_type text,
  encrypted_credentials jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.edi_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  patient_id uuid null,
  appointment_id uuid null,
  encounter_id uuid null,
  claim_id uuid null,
  clearinghouse_connection_id uuid null references public.clearinghouse_connections(id) on delete set null,
  transaction_type text not null,
  direction text not null check (direction in ('outbound', 'inbound')),
  status text not null check (status in ('created', 'sent', 'received', 'parsed', 'failed')),
  control_number text null,
  correlation_id text null,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  raw_request text null,
  raw_response text null,
  parsed_summary jsonb not null default '{}'::jsonb,
  error_message text null,
  sent_at timestamptz null,
  received_at timestamptz null,
  created_at timestamptz not null default now()
);

-- NOTE: The remote eligibility_checks table was created via a separate migration
-- using client_id (not patient_id). This definition is kept for schema documentation;
-- CREATE TABLE IF NOT EXISTS means this block is safely skipped if the table exists.
create table if not exists public.eligibility_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  appointment_id uuid null,
  insurance_policy_id uuid null,
  clearinghouse_connection_id uuid null references public.clearinghouse_connections(id) on delete set null,
  edi_270_transaction_id uuid null references public.edi_transactions(id) on delete set null,
  edi_271_transaction_id uuid null references public.edi_transactions(id) on delete set null,
  payer_name text,
  payer_id text,
  service_type_code text not null default '98',
  status text not null check (status in ('active', 'inactive', 'not_found', 'error', 'unknown')),
  plan_name text null,
  member_id text null,
  subscriber_name text null,
  effective_date date null,
  termination_date date null,
  copay_amount numeric null,
  deductible_total numeric null,
  deductible_remaining numeric null,
  coinsurance_percent numeric null,
  out_of_pocket_remaining numeric null,
  raw_benefits jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.claim_status_inquiries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  claim_id uuid not null,
  patient_id uuid null,
  clearinghouse_connection_id uuid null references public.clearinghouse_connections(id) on delete set null,
  edi_276_transaction_id uuid null references public.edi_transactions(id) on delete set null,
  edi_277_transaction_id uuid null references public.edi_transactions(id) on delete set null,
  payer_name text,
  payer_id text,
  status text not null check (status in ('accepted', 'pending', 'paid', 'denied', 'rejected', 'not_found', 'needs_info', 'error', 'unknown')),
  status_category_code text null,
  status_code text null,
  entity_code text null,
  billed_amount numeric null,
  paid_amount numeric null,
  check_eft_number text null,
  finalized_date date null,
  received_at timestamptz null,
  raw_status jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.clearinghouse_response_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  claim_id uuid null,
  patient_id uuid null,
  edi_transaction_id uuid null references public.edi_transactions(id) on delete set null,
  event_type text not null check (event_type in ('acknowledgment', 'rejection', 'status_update', 'denial', 'payment', 'eligibility_result', 'error')),
  severity text not null default 'info' check (severity in ('info', 'warning', 'error', 'critical')),
  source text null,
  title text not null,
  message text null,
  normalized_code text null,
  raw_codes jsonb not null default '{}'::jsonb,
  is_resolved boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_edi_transactions_org_claim_patient_type_corr_created
  on public.edi_transactions (organization_id, claim_id, patient_id, transaction_type, correlation_id, created_at desc);

create index if not exists idx_eligibility_checks_org_patient_appt_checked
  on public.eligibility_checks (organization_id, client_id, appointment_id, checked_at desc);

create index if not exists idx_claim_status_inquiries_org_claim_received
  on public.claim_status_inquiries (organization_id, claim_id, created_at desc);

create index if not exists idx_response_events_org_claim_type_resolved
  on public.clearinghouse_response_events (organization_id, claim_id, event_type, is_resolved);

alter table public.clearinghouse_connections enable row level security;
alter table public.edi_transactions enable row level security;
alter table public.eligibility_checks enable row level security;
alter table public.claim_status_inquiries enable row level security;
alter table public.clearinghouse_response_events enable row level security;

drop policy if exists clearinghouse_connections_org_policy on public.clearinghouse_connections;
create policy clearinghouse_connections_org_policy
  on public.clearinghouse_connections
  for all
  to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

drop policy if exists edi_transactions_org_policy on public.edi_transactions;
create policy edi_transactions_org_policy
  on public.edi_transactions
  for all
  to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

drop policy if exists eligibility_checks_org_policy on public.eligibility_checks;
create policy eligibility_checks_org_policy
  on public.eligibility_checks
  for all
  to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

drop policy if exists claim_status_inquiries_org_policy on public.claim_status_inquiries;
create policy claim_status_inquiries_org_policy
  on public.claim_status_inquiries
  for all
  to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

drop policy if exists clearinghouse_response_events_org_policy on public.clearinghouse_response_events;
create policy clearinghouse_response_events_org_policy
  on public.clearinghouse_response_events
  for all
  to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );
