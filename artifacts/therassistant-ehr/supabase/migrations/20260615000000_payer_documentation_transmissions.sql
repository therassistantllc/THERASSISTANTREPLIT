-- Task #550 — actually transmit medical-review documentation to the payer.
--
-- The Medical Review "Send documentation" action used to write only an audit
-- entry; it never moved the attached files anywhere. To send them we need
-- (a) a place on payer_profiles to record where documentation goes and
-- (b) a transmission ledger so the Submission history tab can show what
-- was sent, to whom, and whether it succeeded.

alter table public.payer_profiles
  add column if not exists records_email text,
  add column if not exists records_fax text;

create table if not exists public.claim_documentation_transmissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  claim_id uuid not null references public.professional_claims(id) on delete cascade,
  payer_profile_id uuid references public.payer_profiles(id) on delete set null,
  channel text not null check (channel in ('email','fax','logged')),
  recipient text,
  document_ids uuid[] not null default '{}',
  file_list jsonb not null default '[]'::jsonb,
  status text not null default 'queued'
    check (status in ('queued','sent','failed','logged')),
  provider_message_id text,
  error text,
  note text,
  sent_at timestamptz,
  created_by_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_claim_doc_transmissions_org_claim
  on public.claim_documentation_transmissions (organization_id, claim_id, created_at desc);

alter table public.claim_documentation_transmissions enable row level security;

drop policy if exists "claim_doc_transmissions_tenant" on public.claim_documentation_transmissions;
create policy "claim_doc_transmissions_tenant" on public.claim_documentation_transmissions
  for all using (
    organization_id = (auth.jwt() ->> 'organization_id')::uuid
    or organization_id in (
      select organization_id from public.staff_profiles
      where auth_user_id = auth.uid()
    )
  )
  with check (
    organization_id = (auth.jwt() ->> 'organization_id')::uuid
    or organization_id in (
      select organization_id from public.staff_profiles
      where auth_user_id = auth.uid()
    )
  );

notify pgrst, 'reload schema';
