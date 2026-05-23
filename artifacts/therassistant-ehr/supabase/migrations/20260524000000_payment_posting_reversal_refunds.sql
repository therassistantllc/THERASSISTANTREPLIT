-- ============================================================================
-- Migration: 20260524000000_payment_posting_reversal_refunds.sql
-- Purpose:   Payment Posting — Task #110 (posted-detail, reversal, void,
--            recoupment, insurance refund, patient refund).
--   1. Widen posting_status check constraints on era_claim_payments,
--      client_payments, and insurance_manual_payments to include 'voided'
--      (DROP+ADD pattern — additive `if not exists` won't widen).
--   2. Add lifecycle columns (reversed_at / reversal_reason /
--      reversed_by_actor_id / voided_at / void_reason / voided_by_actor_id)
--      to all three posted-payment tables so the detail page + audit chain
--      can render a complete history.
--   3. New table payment_refunds for insurance and patient refunds with
--      Stripe-refund linkage and a refund_status workflow.
--   4. New table payment_recoupments for negative-payment takebacks linked
--      to the original posted payment (era_claim_payment or client_payment).
-- All operations are idempotent.
-- ============================================================================

-- ─── 1. Widen posting_status to include 'voided' ─────────────────────────────
alter table public.era_claim_payments
  drop constraint if exists era_claim_payments_posting_status_check;
alter table public.era_claim_payments
  add constraint era_claim_payments_posting_status_check
  check (posting_status in ('ready','posted','blocked','skipped','reversed','voided'));

alter table public.client_payments
  drop constraint if exists client_payments_posting_status_check;
alter table public.client_payments
  add constraint client_payments_posting_status_check
  check (posting_status in ('posted','blocked','reversed','voided'));

alter table public.insurance_manual_payments
  drop constraint if exists insurance_manual_payments_posting_status_check;
alter table public.insurance_manual_payments
  add constraint insurance_manual_payments_posting_status_check
  check (posting_status in ('posted','blocked','reversed','voided'));

-- ─── 2. Lifecycle columns on all posted-payment tables ───────────────────────
alter table public.era_claim_payments
  add column if not exists reversed_at            timestamptz,
  add column if not exists reversal_reason        text,
  add column if not exists reversed_by_actor_id   uuid,
  add column if not exists voided_at              timestamptz,
  add column if not exists void_reason            text,
  add column if not exists voided_by_actor_id     uuid;

alter table public.client_payments
  add column if not exists reversed_at            timestamptz,
  add column if not exists reversal_reason        text,
  add column if not exists reversed_by_actor_id   uuid,
  add column if not exists voided_at              timestamptz,
  add column if not exists void_reason            text,
  add column if not exists voided_by_actor_id     uuid;

alter table public.insurance_manual_payments
  add column if not exists reversed_at            timestamptz,
  add column if not exists reversal_reason        text,
  add column if not exists reversed_by_actor_id   uuid,
  add column if not exists voided_at              timestamptz,
  add column if not exists void_reason            text,
  add column if not exists voided_by_actor_id     uuid;

-- ─── 3. payment_refunds — insurance + patient refund records ─────────────────
create table if not exists public.payment_refunds (
  id                       uuid        primary key default gen_random_uuid(),
  organization_id          uuid        not null references public.organizations(id) on delete cascade,
  refund_type              text        not null check (refund_type in ('insurance','patient')),
  -- Source linkage — exactly one of the *_id columns is populated per row.
  source_era_claim_payment_id uuid     references public.era_claim_payments(id) on delete set null,
  source_client_payment_id    uuid     references public.client_payments(id) on delete set null,
  source_insurance_manual_payment_id uuid references public.insurance_manual_payments(id) on delete set null,
  client_id                uuid        references public.clients(id) on delete set null,
  professional_claim_id    uuid        references public.professional_claims(id) on delete set null,
  payer_profile_id         uuid        references public.payer_profiles(id) on delete set null,
  amount                   numeric(12,2) not null check (amount > 0),
  reason                   text,
  refund_status            text        not null default 'pending'
    check (refund_status in ('pending','issued','failed','cancelled')),
  stripe_refund_id         text,
  -- Carry the originating Stripe charge for reconciliation when the source
  -- payment was a card/Stripe charge (needed by auto-refund-on-reversal).
  stripe_charge_id         text,
  -- Patient-side refunds may need to credit a specific invoice on issuance.
  patient_invoice_id       uuid        references public.patient_invoices(id) on delete set null,
  workqueue_item_id        uuid        references public.workqueue_items(id) on delete set null,
  issued_at                timestamptz,
  issued_by_actor_id       uuid,
  requested_at             timestamptz not null default now(),
  requested_by_actor_id    uuid,
  note                     text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  archived_at              timestamptz,
  -- Exactly-one-source invariant: at least one source link must be set, and
  -- refund_type must agree with the source kind (patient → client_payment;
  -- insurance → era_claim_payment OR insurance_manual_payment).
  constraint payment_refunds_source_present check (
    (source_era_claim_payment_id is not null)::int
    + (source_client_payment_id  is not null)::int
    + (source_insurance_manual_payment_id is not null)::int
    >= 1
  ),
  constraint payment_refunds_type_matches_source check (
    (refund_type = 'patient'   and source_client_payment_id  is not null)
    or
    (refund_type = 'insurance' and (
        source_era_claim_payment_id is not null
        or source_insurance_manual_payment_id is not null))
  )
);

create index if not exists idx_payment_refunds_org_status
  on public.payment_refunds (organization_id, refund_status, requested_at desc)
  where archived_at is null;
create index if not exists idx_payment_refunds_source_era
  on public.payment_refunds (organization_id, source_era_claim_payment_id)
  where archived_at is null and source_era_claim_payment_id is not null;
create index if not exists idx_payment_refunds_source_client
  on public.payment_refunds (organization_id, source_client_payment_id)
  where archived_at is null and source_client_payment_id is not null;
create index if not exists idx_payment_refunds_source_manual
  on public.payment_refunds (organization_id, source_insurance_manual_payment_id)
  where archived_at is null and source_insurance_manual_payment_id is not null;

-- ─── 4. payment_recoupments — negative-payment takebacks ─────────────────────
create table if not exists public.payment_recoupments (
  id                       uuid        primary key default gen_random_uuid(),
  organization_id          uuid        not null references public.organizations(id) on delete cascade,
  -- Original posted payment that money is being taken back from.
  source_era_claim_payment_id uuid     references public.era_claim_payments(id) on delete set null,
  source_client_payment_id    uuid     references public.client_payments(id) on delete set null,
  -- Forward-looking: when a payer recoups by netting it out of a new ERA
  -- check, this points at that subsequent payment as the offset record.
  offset_era_claim_payment_id uuid     references public.era_claim_payments(id) on delete set null,
  professional_claim_id    uuid        references public.professional_claims(id) on delete set null,
  client_id                uuid        references public.clients(id) on delete set null,
  payer_profile_id         uuid        references public.payer_profiles(id) on delete set null,
  amount                   numeric(12,2) not null check (amount > 0),
  reason_code              text,
  reason                   text,
  workqueue_item_id        uuid        references public.workqueue_items(id) on delete set null,
  recouped_at              timestamptz not null default now(),
  recouped_by_actor_id     uuid,
  created_at               timestamptz not null default now(),
  archived_at              timestamptz,
  constraint payment_recoupments_source_present check (
    source_era_claim_payment_id is not null
    or source_client_payment_id is not null
  )
);

create index if not exists idx_payment_recoupments_org_date
  on public.payment_recoupments (organization_id, recouped_at desc)
  where archived_at is null;
create index if not exists idx_payment_recoupments_source_era
  on public.payment_recoupments (organization_id, source_era_claim_payment_id)
  where archived_at is null and source_era_claim_payment_id is not null;

select pg_notify('pgrst','reload schema');
