-- Document payer-specific appeal and corrected-claim deadlines on
-- payer_profiles.billing_rules.
--
-- No schema change: billing_rules is jsonb, so we just extend the documented
-- shape. The Timely Filing route (app/api/billing/timely-filing/route.ts)
-- reads these per-payer with org-wide fallbacks (DEFAULT_APPEAL_DEADLINE_DAYS,
-- DEFAULT_CORRECTED_CLAIM_DAYS = 180) defined in lib/billing/timelyFiling.ts.
--
-- Extended shape (all fields optional; absent = use org default):
--   {
--     "requires_telehealth_modifier":        boolean,
--     "allowed_pos_codes":                   string[],
--     "requires_rendering_provider_taxonomy":boolean,
--     "requires_subscriber_relationship":    boolean,
--     "timely_filing_days":                  integer,
--     "appeal_deadline_days":                integer,   -- NEW (e.g. 60, 90, 180, 365)
--     "corrected_claim_days":                integer,   -- NEW (e.g. 90, 180, 365)
--     "allowed_cpt_codes":                   string[],
--     "denied_cpt_codes":                    string[]
--   }

COMMENT ON COLUMN public.payer_profiles.billing_rules IS
  'Payer-specific billing rule flags consumed by lib/validation/claim and lib/billing/timelyFiling. Includes timely_filing_days, appeal_deadline_days, corrected_claim_days (positive integers; null/missing falls back to org defaults). See migration 20260610010000_payer_appeal_corrected_deadlines.sql for shape.';

SELECT pg_notify('pgrst', 'reload schema');
