-- File: supabase/migrations/20260505_enforce_client_schema_drift.sql
-- Purpose: enforce canonical THERASSISTANT terminology and claim-status schema.
-- Canonical choices:
--   1. client_id, not patient_id
--   2. claim_status_inquiries, not claim_status_checks
--   3. workqueue_items.status, not work_status

create extension if not exists pgcrypto;

-- Remove incorrect/noncanonical claim-status object if it was created during schema drift.
-- Supabase may have this as a view instead of a table, so both forms are handled.
drop view if exists public.claim_status_checks cascade;
drop table if exists public.claim_status_checks cascade;

-- Keep canonical claim status inquiry table available for 276/277 workflows.
create table if not exists public.claim_status_inquiries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  claim_id uuid not null,
  client_id uuid not null,
  status text not null default 'created',
  external_transaction_id text null,
  duplicate_detection_key text null,
  payer_status_code text null,
  payer_status_text text null,
  response_summary text null,
  requested_at timestamptz null,
  received_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_user_id uuid null,
  updated_by_user_id uuid null,
  archived_at timestamptz null
);

-- Rename patient_id to client_id where a table exists with patient_id but without client_id.
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'eligibility_checks',
    'claims',
    'claim_status_inquiries',
    'workqueue_items',
    'payment_import_items',
    'mailroom_items',
    'vcc_payments',
    'patient_checkins',
    'edi_transactions',
    'clearinghouse_response_events'
  ]
  loop
    if exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = target_table and c.column_name = 'patient_id'
    ) and not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = target_table and c.column_name = 'client_id'
    ) then
      execute format('alter table public.%I rename column patient_id to client_id', target_table);
    end if;
  end loop;
end $$;

-- If both columns exist, remove patient_id because no existing data must be preserved.
alter table if exists public.eligibility_checks drop column if exists patient_id;
alter table if exists public.claims drop column if exists patient_id;
alter table if exists public.claim_status_inquiries drop column if exists patient_id;
alter table if exists public.workqueue_items drop column if exists patient_id;
alter table if exists public.payment_import_items drop column if exists patient_id;
alter table if exists public.mailroom_items drop column if exists patient_id;
alter table if exists public.vcc_payments drop column if exists patient_id;
alter table if exists public.patient_checkins drop column if exists patient_id;
alter table if exists public.edi_transactions drop column if exists patient_id;
alter table if exists public.clearinghouse_response_events drop column if exists patient_id;

alter table if exists public.workqueue_items drop column if exists work_status;

alter table if exists public.eligibility_checks add column if not exists client_id uuid;
alter table if exists public.encounters add column if not exists client_id uuid;
alter table if exists public.claims add column if not exists client_id uuid;
alter table if exists public.claim_status_inquiries add column if not exists client_id uuid;
alter table if exists public.workqueue_items add column if not exists client_id uuid;
alter table if exists public.payment_import_items add column if not exists client_id uuid;
alter table if exists public.mailroom_items add column if not exists client_id uuid;
alter table if exists public.vcc_payments add column if not exists client_id uuid;
alter table if exists public.patient_checkins add column if not exists client_id uuid;
alter table if exists public.edi_transactions add column if not exists client_id uuid;
alter table if exists public.clearinghouse_response_events add column if not exists client_id uuid;

alter table if exists public.eligibility_checks add column if not exists eligibility_status text;
do $$
begin
  if exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'eligibility_checks' and c.column_name = 'status'
  ) then
    execute 'update public.eligibility_checks set eligibility_status = coalesce(eligibility_status, status)';
    execute 'alter table public.eligibility_checks drop column status';
  end if;
end $$;

alter table if exists public.workqueue_items add column if not exists status text not null default 'open';
alter table if exists public.workqueue_items add column if not exists context_payload jsonb not null default '{}'::jsonb;

alter table if exists public.workqueue_items drop constraint if exists workqueue_items_status_chk;
alter table if exists public.workqueue_items
  add constraint workqueue_items_status_chk
  check (status in ('open', 'in_progress', 'blocked', 'resolved', 'closed'));

alter table if exists public.workqueue_items drop constraint if exists workqueue_items_priority_chk;
-- NOTE: workqueue_items.priority is typed as workqueue_priority (a custom enum).
-- Valid enum values are: low, normal, high, urgent.
-- The enum type itself enforces valid values; no additional text check constraint is needed.
-- Adding a check constraint with text literals would fail on an enum-typed column.

alter table if exists public.eligibility_checks drop constraint if exists eligibility_checks_status_chk;
alter table if exists public.eligibility_checks
  add constraint eligibility_checks_status_chk
  check (eligibility_status is null or eligibility_status in ('active', 'inactive', 'not_checked', 'not_found', 'error', 'unknown'));

alter table if exists public.claim_status_inquiries drop constraint if exists claim_status_inquiries_status_chk;
alter table if exists public.claim_status_inquiries
  add constraint claim_status_inquiries_status_chk
  check (status in ('created', 'sent', 'received', 'parsed', 'failed', 'not_found', 'pending', 'paid', 'denied', 'rejected', 'needs_info', 'unknown'));

alter table if exists public.encounters alter column client_id set not null;
alter table if exists public.claims alter column client_id set not null;
alter table if exists public.eligibility_checks alter column client_id set not null;
alter table if exists public.claim_status_inquiries alter column client_id set not null;

create index if not exists idx_eligibility_checks_org_client_appt_checked
  on public.eligibility_checks (organization_id, client_id, appointment_id, checked_at desc);

create index if not exists idx_claim_status_inquiries_org_claim_received
  on public.claim_status_inquiries (organization_id, claim_id, created_at desc);

create index if not exists idx_claim_status_inquiries_org_client_created
  on public.claim_status_inquiries (organization_id, client_id, created_at desc);

do $$
begin
  if to_regclass('public.workqueue_items') is not null then
    create index if not exists idx_workqueue_items_open_by_type
      on public.workqueue_items (organization_id, status, work_type, priority, created_at desc)
      where archived_at is null;

    create index if not exists idx_workqueue_items_source_dedupe
      on public.workqueue_items (source_object_type, source_object_id, work_type);
  end if;
end $$;

do $$
begin
  if to_regclass('public.claims') is not null then
    create index if not exists idx_claims_org_client_status
      on public.claims (organization_id, client_id, claim_status, updated_at desc)
      where archived_at is null;
  end if;
end $$;

alter table public.claim_status_inquiries enable row level security;

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
