create extension if not exists pgcrypto;

create table if not exists public.patient_invoice_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_invoice_id uuid not null references public.patient_invoices(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  payment_status text not null default 'posted' check (
    payment_status in ('pending', 'posted', 'failed', 'voided', 'refunded')
  ),
  payment_method text not null default 'manual' check (
    payment_method in ('manual', 'cash', 'check', 'card', 'stripe', 'portal', 'other')
  ),
  amount numeric(12,2) not null check (amount >= 0),
  external_payment_id text,
  memo text,
  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists idx_patient_invoice_payments_invoice
  on public.patient_invoice_payments (organization_id, patient_invoice_id, paid_at desc)
  where archived_at is null;

create index if not exists idx_patient_invoice_payments_client
  on public.patient_invoice_payments (organization_id, client_id, paid_at desc)
  where archived_at is null;

alter table public.patient_invoice_payments enable row level security;

drop policy if exists patient_invoice_payments_org_policy on public.patient_invoice_payments;
create policy patient_invoice_payments_org_policy
  on public.patient_invoice_payments
  for all to authenticated
  using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

select pg_notify('pgrst', 'reload schema');
