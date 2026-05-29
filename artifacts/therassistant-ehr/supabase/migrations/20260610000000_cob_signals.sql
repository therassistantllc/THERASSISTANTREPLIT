-- Task #457 — Coordination-of-benefits signals.
--
-- 271 (eligibility) and 835 (remittance) both carry hard COB evidence that
-- today gets dropped on the floor:
--   * 271 EB*R subloops identify additional payers (name + payer-id +
--     eligibility dates) covering the same member.
--   * 835 CAS adjustments with reason code 22 ("This care may be covered
--     by another payer per coordination of benefits") and MOA segments
--     carrying other-payer-paid amounts tell us a specific *claim* was
--     denied or downcoded for COB reasons.
--
-- Without persisting either of these, `/api/billing/cob-issues` has to
-- fall back to a "client has >=2 active insurance_policies" heuristic,
-- which both misses real COB denials (single-policy client paid as
-- non-primary by the payer) and false-fires when the secondary policy
-- has never actually been billed.

alter table public.eligibility_checks
  add column if not exists other_payer_name text,
  add column if not exists other_payer_id text,
  add column if not exists other_payer_effective_date date,
  add column if not exists other_payer_termination_date date,
  add column if not exists other_payers jsonb not null default '[]'::jsonb;

comment on column public.eligibility_checks.other_payers is
  'Structured list of additional payers reported by the 271 (EB*R subloop or '
  'Availity JSON otherPayers bucket). Each entry: {name, payerId, '
  'effectiveDate, terminationDate}. Headline values mirrored into the '
  'flat other_payer_* columns for quick filtering.';

create table if not exists public.claim_cob_signals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  professional_claim_id uuid not null references public.professional_claims(id) on delete cascade,
  era_claim_payment_id uuid references public.era_claim_payments(id) on delete cascade,
  signal_type text not null check (signal_type in (
    'co_22',                  -- CAS CO*22 adjustment on the ERA
    'other_payer_paid',       -- MOA-reported other-payer paid amount
    'other_payer_eligibility' -- 271 reported another payer covering the member
  )),
  other_payer_name text,
  other_payer_id text,
  other_payer_paid_amount numeric(12,2),
  source_segment text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists claim_cob_signals_org_claim_idx
  on public.claim_cob_signals (organization_id, professional_claim_id);

create index if not exists claim_cob_signals_era_payment_idx
  on public.claim_cob_signals (era_claim_payment_id)
  where era_claim_payment_id is not null;

alter table public.claim_cob_signals enable row level security;

drop policy if exists "claim_cob_signals_tenant_rw" on public.claim_cob_signals;
create policy "claim_cob_signals_tenant_rw" on public.claim_cob_signals
  for all using (
    organization_id = (auth.jwt() ->> 'organization_id')::uuid
    or organization_id in (
      select organization_id from public.staff_profiles
      where auth_user_id = auth.uid()
    )
  )
  with check (
    organization_id = (auth.jwt() ->> 'organization_id')::uuid
    or organization_id in (
      select organization_id from public.staff_profiles
      where auth_user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
