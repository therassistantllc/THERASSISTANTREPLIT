-- Paper Check workqueue (Task #385).
--
-- Tracks the lifecycle of physical/paper checks received from payers:
-- a check arrives in the mail, gets deposited at the bank, then posted
-- against one or more claims. The queue surfaces unmatched and returned
-- checks separately so they can be resolved without blocking the rest.

create extension if not exists pgcrypto;

create table if not exists public.paper_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payer_profile_id uuid references public.payer_profiles(id) on delete set null,
  payer_name_snapshot text,
  check_number text,
  check_date date,
  amount numeric(12,2) not null default 0,
  received_date date not null default current_date,
  deposit_date date,
  posting_status text not null default 'new'
    check (posting_status in ('new','deposited','posted','unmatched','returned','void')),
  scanned_check_url text,
  paper_eob_url text,
  deposit_notes text,
  assigned_to_user_id uuid references auth.users(id),
  assigned_to_display_name text,
  priority text check (priority is null or priority in ('low','normal','high','urgent')),
  follow_up_due_date date,
  created_by_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists idx_paper_checks_org_status_received
  on public.paper_checks (organization_id, posting_status, received_date desc)
  where archived_at is null;

create index if not exists idx_paper_checks_org_payer
  on public.paper_checks (organization_id, payer_profile_id)
  where archived_at is null;

-- Many checks ↔ many claims (a single check can pay multiple claims, and a
-- single claim can be touched by more than one check across postings).
create table if not exists public.paper_check_claim_matches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  paper_check_id uuid not null references public.paper_checks(id) on delete cascade,
  claim_id uuid not null references public.professional_claims(id) on delete cascade,
  applied_amount numeric(12,2) not null default 0,
  matched_at timestamptz not null default now(),
  matched_by_user_id uuid references auth.users(id),
  matched_by_display_name text,
  unique (paper_check_id, claim_id)
);

create index if not exists idx_paper_check_matches_org_check
  on public.paper_check_claim_matches (organization_id, paper_check_id);

create index if not exists idx_paper_check_matches_org_claim
  on public.paper_check_claim_matches (organization_id, claim_id);

-- Lightweight audit trail for queue actions (upload, deposit, post, etc.).
create table if not exists public.paper_check_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  paper_check_id uuid not null references public.paper_checks(id) on delete cascade,
  event_type text not null,
  message text,
  actor_user_id uuid references auth.users(id),
  actor_display_name text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_paper_check_events_check_created
  on public.paper_check_events (paper_check_id, created_at desc);

-- RLS: tenant isolation by organization_id (matches existing claim_notes pattern).
alter table public.paper_checks enable row level security;
alter table public.paper_check_claim_matches enable row level security;
alter table public.paper_check_events enable row level security;

drop policy if exists "paper_checks_tenant_rw" on public.paper_checks;
create policy "paper_checks_tenant_rw" on public.paper_checks
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

drop policy if exists "paper_check_matches_tenant_rw" on public.paper_check_claim_matches;
create policy "paper_check_matches_tenant_rw" on public.paper_check_claim_matches
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

drop policy if exists "paper_check_events_tenant_rw" on public.paper_check_events;
create policy "paper_check_events_tenant_rw" on public.paper_check_events
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
