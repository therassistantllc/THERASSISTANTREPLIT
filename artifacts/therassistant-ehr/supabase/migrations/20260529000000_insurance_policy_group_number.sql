-- ============================================================================
-- Migration: 20260529000000_insurance_policy_group_number.sql
-- Purpose:   Task #141 — track the payer-issued Group # on each
--            `insurance_policies` row so it can flow into the Summary
--            tab's Group # column and into outbound 270 eligibility
--            inquiries (Loop 2100C REF*1L Group or Policy Number).
--
--            The patient intake flow already writes this column when
--            collecting demographics; until now it was silently
--            failing because the column did not exist. The unrelated
--            `insurance_subscribers.group_number` column is preserved
--            for back-compat with subscriber-level lookups.
-- Idempotent.
-- ============================================================================

alter table public.insurance_policies
  add column if not exists group_number text;

comment on column public.insurance_policies.group_number is
  'Payer-issued Group # for this coverage (Loop 2100C REF*1L on the 270).';
