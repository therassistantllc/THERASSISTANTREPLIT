-- Add structured contact fields to payer_profiles so the "Call payer" panel
-- on the No Response queue can render clickable tel:/fax: links instead of
-- relying on a free-text notes field.
--
-- `fax_number` already exists (added in 20260605000000_billing_workflow_redesign)
-- and is used as a generic fax destination for denials/appeals/fax-queue.
-- The new columns split contact info by purpose so reps can dial the right
-- department directly from the No Response panel.

alter table public.payer_profiles
  add column if not exists claims_phone text,
  add column if not exists claims_fax text,
  add column if not exists provider_services_phone text;

notify pgrst, 'reload schema';
