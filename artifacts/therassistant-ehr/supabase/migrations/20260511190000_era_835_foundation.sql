create extension if not exists pgcrypto;

-- Drop legacy era_claim_payments and its dependents from 20260505030000_office_ally_response_schemas.
-- That migration created an early draft with incompatible columns. This migration is the canonical
-- 835/ERA redesign, so we drop-and-recreate on a fresh DB where the tables are always empty.
drop table if exists public.era_adjustments cascade;
drop table if exists public.era_service_line_payments cascade;
drop table if exists public.era_claim_payments cascade;

create table if not exists public.era_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source text not null default 'manual_upload',
  file_name text,
  raw_content text not null,
  parsed_summary jsonb not null default '{}'::jsonb,
  import_status text not null default 'parsed' check (
    import_status in ('uploaded', 'parsed', 'matched', 'posted', 'blocked', 'failed')
  ),
  total_claims integer not null default 0,
  total_payment_amount numeric(12,2) not null default 0,
  total_patient_responsibility numeric(12,2) not null default 0,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.era_claim_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  era_import_batch_id uuid not null references public.era_import_batches(id) on delete cascade,
  professional_claim_id uuid references public.professional_claims(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  clp01_claim_control_number text not null,
  clp02_claim_status_code text,
  clp03_total_charge numeric(12,2) not null default 0,
  clp04_payment_amount numeric(12,2) not null default 0,
  clp05_patient_responsibility numeric(12,2) not null default 0,
  payer_claim_control_number text,
  claim_match_status text not null default 'unmatched' check (
    claim_match_status in ('matched', 'unmatched', 'ambiguous')
  ),
  posting_status text not null default 'ready' check (
    posting_status in ('ready', 'posted', 'blocked', 'skipped')
  ),
  cas_adjustments jsonb not null default '[]'::jsonb,
  service_lines jsonb not null default '[]'::jsonb,
  raw_segments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.era_posting_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  era_claim_payment_id uuid not null references public.era_claim_payments(id) on delete cascade,
  professional_claim_id uuid references public.professional_claims(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  entry_type text not null check (
    entry_type in ('insurance_payment', 'contractual_adjustment', 'patient_responsibility', 'other_adjustment')
  ),
  amount numeric(12,2) not null,
  group_code text,
  reason_code text,
  description text,
  source_segment text,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists public.patient_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  professional_claim_id uuid references public.professional_claims(id) on delete set null,
  era_claim_payment_id uuid references public.era_claim_payments(id) on delete set null,
  invoice_status text not null default 'open' check (
    invoice_status in ('draft', 'open', 'sent', 'paid', 'voided', 'collections')
  ),
  invoice_number text not null,
  patient_responsibility_amount numeric(12,2) not null default 0,
  paid_amount numeric(12,2) not null default 0,
  balance_amount numeric(12,2) not null default 0,
  source text not null default 'era_pr',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index if not exists idx_patient_invoices_invoice_number
  on public.patient_invoices (organization_id, invoice_number);

create index if not exists idx_era_import_batches_org_status
  on public.era_import_batches (organization_id, import_status, imported_at desc)
  where archived_at is null;

create index if not exists idx_era_claim_payments_batch
  on public.era_claim_payments (era_import_batch_id, claim_match_status, posting_status)
  where archived_at is null;

create index if not exists idx_era_claim_payments_claim
  on public.era_claim_payments (organization_id, professional_claim_id)
  where archived_at is null;

create index if not exists idx_era_posting_ledger_entries_claim
  on public.era_posting_ledger_entries (organization_id, professional_claim_id, entry_type)
  where archived_at is null;

create index if not exists idx_patient_invoices_client_status
  on public.patient_invoices (organization_id, client_id, invoice_status, created_at desc)
  where archived_at is null;

alter table public.era_import_batches enable row level security;
alter table public.era_claim_payments enable row level security;
alter table public.era_posting_ledger_entries enable row level security;
alter table public.patient_invoices enable row level security;

drop policy if exists era_import_batches_org_policy on public.era_import_batches;
create policy era_import_batches_org_policy on public.era_import_batches
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

drop policy if exists era_claim_payments_org_policy on public.era_claim_payments;
create policy era_claim_payments_org_policy on public.era_claim_payments
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

drop policy if exists era_posting_ledger_entries_org_policy on public.era_posting_ledger_entries;
create policy era_posting_ledger_entries_org_policy on public.era_posting_ledger_entries
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

drop policy if exists patient_invoices_org_policy on public.patient_invoices;
create policy patient_invoices_org_policy on public.patient_invoices
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

select pg_notify('pgrst', 'reload schema');
