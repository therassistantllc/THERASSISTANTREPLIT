-- ============================================================================
-- Migration: 20260523000000_payment_posting_foundation.sql
-- Purpose:   Payment Posting refactor — Foundation (Task #107).
--   1. Duplicate-ERA detection — add payer/EFT/payment_date columns +
--      a partial unique index on era_import_batches keyed by
--      (org, payer_identifier, eft_or_check_number, payment_date,
--       total_payment_amount).
--   2. Claim/provider-level non-claim adjustments — new payment_adjustments
--      table (interest, sequestration, recoupment offsets, incentives, etc.)
--   3. Light-touch helper indexes for the posting engine (ledger lookups by
--      claim, audit lookups by object).
--
-- All operations use IF NOT EXISTS / safe ALTER patterns and are idempotent.
-- No new RLS surfaces beyond payment_adjustments (org-scoped, same pattern).
-- No new payment_audit_log table is created — the existing public.audit_logs
-- already exposes Medplum-style columns (user_id, user_role, action,
-- object_type, object_id, before_value, after_value, organization_id,
-- claim_id, workqueue_item_id). The posting engine writes there.
-- ============================================================================

create extension if not exists pgcrypto;

-- ─── 1. era_import_batches: dedupe identity columns ──────────────────────────
alter table public.era_import_batches
  add column if not exists payer_identifier      text,
  add column if not exists payer_name            text,
  add column if not exists eft_or_check_number   text,
  add column if not exists payment_date          date,
  add column if not exists payment_method_code   text;

comment on column public.era_import_batches.payer_identifier
  is 'Payer ID from N1*PR (BPR-equivalent counterparty). Combined with eft_or_check_number, payment_date, and total_payment_amount to detect duplicate ERA uploads.';
comment on column public.era_import_batches.eft_or_check_number
  is 'TRN02 trace number (EFT or check number from 835). Part of the duplicate-ERA detection key.';
comment on column public.era_import_batches.payment_date
  is 'BPR16 payment date (or settlement effective date).';

create index if not exists idx_era_import_batches_payer_payment
  on public.era_import_batches (organization_id, payer_identifier, payment_date desc)
  where archived_at is null;

-- Partial unique index to block duplicate ERA imports.
-- Only applies once all parts of the key are present (so legacy / hand-loaded
-- batches without these fields are not retroactively constrained).
-- Per memory note: NOT exposed as an ON CONFLICT arbiter because supabase-js
-- cannot emit index_predicate. Service code must pre-check via SELECT.
create unique index if not exists ux_era_import_batches_dedupe_key
  on public.era_import_batches (
    organization_id,
    payer_identifier,
    eft_or_check_number,
    payment_date,
    total_payment_amount
  )
  where archived_at is null
    and payer_identifier is not null
    and eft_or_check_number is not null
    and payment_date is not null
    and total_payment_amount is not null;

-- ─── 2. payment_adjustments: claim/provider-level non-claim adjustments ──────
-- Used for: interest (CARC group OA + RARC), sequestration (CARC 253),
-- recoupment offsets (PLB WO/FB), provider incentives (PLB IS), capitation,
-- and other PLB-segment adjustments that don't tie to a single CLP claim.
create table if not exists public.payment_adjustments (
  id                       uuid        primary key default gen_random_uuid(),
  organization_id          uuid        not null references public.organizations(id) on delete cascade,
  era_import_batch_id      uuid        references public.era_import_batches(id) on delete set null,
  era_claim_payment_id     uuid        references public.era_claim_payments(id) on delete set null,
  professional_claim_id    uuid        references public.professional_claims(id) on delete set null,
  client_id                uuid        references public.clients(id) on delete set null,
  scope                    text        not null check (
                                         scope in ('claim_level', 'provider_level', 'service_line')
                                       ),
  adjustment_type          text        not null check (
                                         adjustment_type in (
                                           'interest', 'sequestration', 'recoupment',
                                           'forwarding_balance', 'incentive', 'capitation',
                                           'patient_responsibility_transfer',
                                           'contractual_obligation', 'denial', 'reversal',
                                           'refund', 'unapplied_credit', 'other'
                                         )
                                       ),
  group_code               text,
  reason_code              text,
  reference_id             text,
  amount                   numeric(14,2) not null,
  description              text,
  source                   text        not null default 'era_835' check (
                                         source in ('era_835', 'manual', 'system')
                                       ),
  posted_at                timestamptz,
  posted_by_user_id        uuid,
  reversed_by_adjustment_id uuid       references public.payment_adjustments(id) on delete set null,
  metadata                 jsonb       not null default '{}'::jsonb,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  archived_at              timestamptz
);

create index if not exists idx_payment_adjustments_org_claim
  on public.payment_adjustments (organization_id, professional_claim_id)
  where archived_at is null;

create index if not exists idx_payment_adjustments_org_era_claim_payment
  on public.payment_adjustments (organization_id, era_claim_payment_id)
  where archived_at is null and era_claim_payment_id is not null;

create index if not exists idx_payment_adjustments_org_batch
  on public.payment_adjustments (organization_id, era_import_batch_id)
  where archived_at is null and era_import_batch_id is not null;

create index if not exists idx_payment_adjustments_org_type_posted
  on public.payment_adjustments (organization_id, adjustment_type, posted_at desc)
  where archived_at is null;

alter table public.payment_adjustments enable row level security;
drop policy if exists payment_adjustments_org_policy on public.payment_adjustments;
create policy payment_adjustments_org_policy on public.payment_adjustments
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─── 3. Helper indexes for the posting engine ────────────────────────────────
-- audit_logs lookup by payment object (engine writes object_type='era_claim_payment',
-- object_type='professional_claim', or object_type='patient_invoice').
-- idx_audit_logs_org_object already exists; add a narrower one for payment actions.
create index if not exists idx_audit_logs_payment_actions
  on public.audit_logs (organization_id, action, created_at desc)
  where organization_id is not null
    and action in (
      'payment_posted', 'payment_reversed', 'payment_adjusted',
      'era_batch_posted', 'era_batch_imported', 'patient_invoice_created',
      'patient_invoice_updated', 'recoupment_recorded', 'refund_issued',
      'unapplied_credit_recorded'
    );

-- era_posting_ledger_entries lookup by claim (engine reads back posted totals).
create index if not exists idx_era_posting_ledger_entries_org_claim
  on public.era_posting_ledger_entries (organization_id, professional_claim_id)
  where archived_at is null and professional_claim_id is not null;

-- ─── 4. Notify PostgREST to reload schema ────────────────────────────────────
select pg_notify('pgrst', 'reload schema');
