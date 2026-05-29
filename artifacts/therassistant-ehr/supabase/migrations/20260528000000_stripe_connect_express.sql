-- Task #123 — Stripe Connect Express for in-app copay collection.
--
-- Adds per-provider Stripe Connect account state to
-- provider_credentialing_profiles, and a connected-account pointer on
-- client_payments so refunds know which connected account to bill the
-- reversal against (Stripe Connect refunds must include the
-- Stripe-Account header for the charge to be located).

ALTER TABLE provider_credentialing_profiles
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_details_submitted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_requirements jsonb,
  ADD COLUMN IF NOT EXISTS stripe_account_status_updated_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS provider_credentialing_stripe_account_uidx
  ON provider_credentialing_profiles (stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;

ALTER TABLE client_payments
  ADD COLUMN IF NOT EXISTS stripe_connected_account_id text;

CREATE INDEX IF NOT EXISTS client_payments_stripe_connected_account_idx
  ON client_payments (organization_id, stripe_connected_account_id)
  WHERE stripe_connected_account_id IS NOT NULL;
