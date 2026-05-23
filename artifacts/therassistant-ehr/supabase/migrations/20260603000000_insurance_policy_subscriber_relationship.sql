-- ============================================================================
-- Migration: 20260603000000_insurance_policy_subscriber_relationship.sql
-- Purpose:   Task #303 — back the `subscriber_relationship` column that
--            patient intake (`lib/intake/upsertPolicyFromIntake.ts` and
--            `app/api/intake/[token]/route.ts`) has been writing to
--            `insurance_policies` for months. The test schema guard had
--            an EXTRA_COLUMNS overlay pretending the column existed; the
--            real table has no such column, so the writes were silently
--            failing in production the same way the
--            `patient_responsibility_amount` bug fixed in Task #300 did.
--
--            Values written by the intake flow are short relationship
--            codes ("self", "spouse", "child", …), defaulting to "self".
--            We keep the column nullable + free-text to match the
--            existing app contract; the related
--            `insurance_subscribers.relationship_to_client` column already
--            carries the subscriber-level value for back-compat.
-- Idempotent.
-- ============================================================================

alter table public.insurance_policies
  add column if not exists subscriber_relationship text;

comment on column public.insurance_policies.subscriber_relationship is
  'Relationship of the policy subscriber to the client (self/spouse/child/...). '
  'Written by patient intake; used by 270 eligibility + claim build.';
