-- Add hold tracking to professional_claims so billers can pause a
-- ready_for_batch claim from the Ready-to-Generate workqueue without
-- archiving it or losing its workflow position.
alter table public.professional_claims
  add column if not exists held_at timestamptz,
  add column if not exists hold_reason text;

create index if not exists idx_professional_claims_held
  on public.professional_claims (organization_id, held_at)
  where held_at is not null and archived_at is null;
