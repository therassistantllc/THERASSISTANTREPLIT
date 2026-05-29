-- Per-payer adjudication SLA in days. Drives the "Expected adjudication date"
-- column on the Payer Received workqueue so billers can prioritize against
-- realistic payer turn-around times (Medicare ~14, commercial ~30, some
-- Medicaid 60+) rather than a flat 30-day default.
ALTER TABLE payer_profiles
  ADD COLUMN IF NOT EXISTS adjudication_sla_days integer NOT NULL DEFAULT 30
    CHECK (adjudication_sla_days >= 1 AND adjudication_sla_days <= 365);

COMMENT ON COLUMN payer_profiles.adjudication_sla_days IS
  'Expected number of calendar days from payer receipt to adjudication. Consumed by lib/billing/payerReceivedService to compute expectedAdjudicationAt per claim.';

NOTIFY pgrst, 'reload schema';
