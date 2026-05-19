-- Manual payment posting support for billing workflows.

create extension if not exists pgcrypto;

create table if not exists public.client_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  claim_id uuid null,
  payment_method text not null check (payment_method in ('cash', 'check', 'credit_card', 'debit_card', 'other')),
  amount numeric(12,2) not null check (amount > 0),
  reference_number text null,
  note text null,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null
);

create table if not exists public.insurance_manual_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  claim_id uuid not null,
  client_id uuid not null,
  eob_reference text null,
  allowed_amount numeric(12,2) not null default 0,
  paid_amount numeric(12,2) not null default 0,
  adjustment_amount numeric(12,2) not null default 0,
  patient_responsibility_amount numeric(12,2) not null default 0,
  note text null,
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null
);

create table if not exists public.payment_applications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payment_kind text not null check (payment_kind in ('client', 'insurance')),
  payment_source_id uuid not null,
  client_id uuid not null,
  claim_id uuid null,
  applied_amount numeric(12,2) not null check (applied_amount > 0),
  applied_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null
);

create index if not exists idx_client_payments_org_client_posted
  on public.client_payments (organization_id, client_id, posted_at desc)
  where archived_at is null;

create index if not exists idx_insurance_manual_payments_org_claim_posted
  on public.insurance_manual_payments (organization_id, claim_id, posted_at desc)
  where archived_at is null;

create index if not exists idx_payment_applications_org_claim_applied
  on public.payment_applications (organization_id, claim_id, applied_at desc)
  where archived_at is null;
