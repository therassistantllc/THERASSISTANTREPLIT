-- Task #483 — Allow a single professional_claim to be linked to BOTH a primary
-- and a secondary 837P batch concurrently, by partitioning the unique index on
-- claim_837p_batch_claims by submission_kind.
--
-- claim_837p_batches.submission_kind is the authoritative flag on the batch
-- itself; the link row carries a denormalized copy so the unique index can
-- enforce "at most one active primary and at most one active secondary batch
-- per claim at a time".

alter table public.claim_837p_batches
  add column if not exists submission_kind text not null default 'primary';

do $$
begin
  if not exists (
    select 1 from information_schema.check_constraints
     where constraint_schema = 'public'
       and constraint_name = 'claim_837p_batches_submission_kind_check'
  ) then
    alter table public.claim_837p_batches
      add constraint claim_837p_batches_submission_kind_check
      check (submission_kind in ('primary','secondary'));
  end if;
end$$;

alter table public.claim_837p_batch_claims
  add column if not exists submission_kind text not null default 'primary';

do $$
begin
  if not exists (
    select 1 from information_schema.check_constraints
     where constraint_schema = 'public'
       and constraint_name = 'claim_837p_batch_claims_submission_kind_check'
  ) then
    alter table public.claim_837p_batch_claims
      add constraint claim_837p_batch_claims_submission_kind_check
      check (submission_kind in ('primary','secondary'));
  end if;
end$$;

-- Replace the per-claim active-link uniqueness with one keyed by
-- submission_kind so a claim can hold an active primary batch link and an
-- active secondary batch link simultaneously.
drop index if exists public.idx_claim_837p_batch_claims_unique_active;
create unique index if not exists idx_claim_837p_batch_claims_unique_active
  on public.claim_837p_batch_claims (organization_id, professional_claim_id, submission_kind)
  where archived_at is null;

create index if not exists idx_claim_837p_batch_claims_claim_kind
  on public.claim_837p_batch_claims (organization_id, professional_claim_id, submission_kind)
  where archived_at is null;

create index if not exists idx_claim_837p_batches_org_kind_created
  on public.claim_837p_batches (organization_id, submission_kind, created_at desc)
  where archived_at is null;

select pg_notify('pgrst', 'reload schema');
