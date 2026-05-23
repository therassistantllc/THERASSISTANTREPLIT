-- Add patient/payer responsibility amount columns to professional_claims.
--
-- Production code in lib/payments/postingEngine/manualInsurance.ts and
-- lib/payments/postingEngine/patientPayment.ts reads and writes
-- patient_responsibility_amount on professional_claims, and several API
-- routes (patient claims history, posted-payment detail, etc.) select it
-- back. Earlier migrations never created the column, so the production
-- writes would fail with "column does not exist". The shared schemaGuard
-- overlay (lib/supabase/__tests__/schemaGuard.ts) was hiding this in tests.
--
-- payer_responsibility_amount is added alongside it because it is selected
-- in manualInsurance.commitManualInsurancePosting and is the natural pair
-- to patient_responsibility_amount for claim-level money tracking.
--
-- total_charge_amount is intentionally NOT added: the canonical charge
-- column on professional_claims is `total_charge` (numeric(12,2)), which is
-- used by every other claim-reading service (assistedMatchingService,
-- claimReadinessService, edi837pBatchService, billing reports, ...). The
-- one offending caller (manualInsurance) has been changed to use
-- `total_charge` instead.

alter table public.professional_claims
  add column if not exists patient_responsibility_amount numeric(12,2) not null default 0,
  add column if not exists payer_responsibility_amount   numeric(12,2) not null default 0;
