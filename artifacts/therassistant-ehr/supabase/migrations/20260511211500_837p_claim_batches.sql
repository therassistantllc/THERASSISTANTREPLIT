create extension if not exists pgcrypto;

create table if not exists public.claim_837p_batches (
  id uuid primary key default gen_random_uuid(),
    organization_id uuid not null references public.organizations(id) on delete cascade,
      batch_number text not null,
        batch_status text not null default 'draft' check (
            batch_status in ('draft', 'ready_to_generate', 'generated', 'submitted', 'accepted', 'rejected', 'voided')
              ),
                claim_count integer not null default 0,
                  total_charge_amount numeric(12,2) not null default 0,
                    generated_file_name text,
                      generated_file_content text,
                        submitted_at timestamptz,
                          created_at timestamptz not null default now(),
                            updated_at timestamptz not null default now(),
                              archived_at timestamptz
                              );

                              create unique index if not exists idx_claim_837p_batches_org_number
                                on public.claim_837p_batches (organization_id, batch_number)
                                  where archived_at is null;

                                  create table if not exists public.claim_837p_batch_claims (
                                    id uuid primary key default gen_random_uuid(),
                                      organization_id uuid not null references public.organizations(id) on delete cascade,
                                        batch_id uuid not null references public.claim_837p_batches(id) on delete cascade,
                                          professional_claim_id uuid not null references public.professional_claims(id) on delete cascade,
                                            created_at timestamptz not null default now(),
                                              archived_at timestamptz
                                              );

                                              create unique index if not exists idx_claim_837p_batch_claims_unique_active
                                                on public.claim_837p_batch_claims (organization_id, professional_claim_id)
                                                  where archived_at is null;

                                                  create index if not exists idx_claim_837p_batch_claims_batch
                                                    on public.claim_837p_batch_claims (organization_id, batch_id)
                                                      where archived_at is null;

                                                      alter table public.claim_837p_batches enable row level security;
                                                      alter table public.claim_837p_batch_claims enable row level security;

                                                      drop policy if exists claim_837p_batches_org_policy on public.claim_837p_batches;
                                                      create policy claim_837p_batches_org_policy
                                                        on public.claim_837p_batches
                                                          for all to authenticated
                                                            using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
                                                              with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

                                                              drop policy if exists claim_837p_batch_claims_org_policy on public.claim_837p_batch_claims;
                                                              create policy claim_837p_batch_claims_org_policy
                                                                on public.claim_837p_batch_claims
                                                                  for all to authenticated
                                                                    using (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
                                                                      with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

                                                                      select pg_notify('pgrst', 'reload schema');
                                                                      