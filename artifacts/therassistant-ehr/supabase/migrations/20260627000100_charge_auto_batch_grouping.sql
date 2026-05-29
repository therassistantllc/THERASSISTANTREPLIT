-- Charge auto-batching metadata for 837P batches.
--
-- Allows the app to keep one open batch bucket per (organization, payer_profile_id,
-- billing_provider_tax_id) for charges that are auto-created from signed notes.

alter table public.claim_837p_batches
  add column if not exists payer_profile_id uuid references public.payer_profiles(id) on delete set null,
  add column if not exists billing_provider_tax_id text,
  add column if not exists batch_source text not null default 'manual'
    check (batch_source in ('manual', 'charge_auto'));

create index if not exists idx_claim_837p_batches_org_group
  on public.claim_837p_batches (organization_id, payer_profile_id, billing_provider_tax_id, batch_source)
  where archived_at is null;

-- Enforce at most one open auto bucket per grouping key.
create unique index if not exists idx_claim_837p_batches_unique_open_auto_group
  on public.claim_837p_batches (organization_id, payer_profile_id, billing_provider_tax_id)
  where archived_at is null
    and batch_source = 'charge_auto'
    and batch_status in ('draft', 'ready_to_generate');

select pg_notify('pgrst', 'reload schema');
