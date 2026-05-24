-- Appeals Needed workqueue: per-claim appeal records driving the
-- /billing/appeals workqueue. One row per appeal attempt against a
-- denied claim; the latest row is what the workqueue surfaces.
--
-- We deliberately do NOT add appeal columns to professional_claims —
-- a single claim can have multiple appeal attempts (level 1 → 2 → 3 /
-- DOI), and a row-per-attempt keeps history honest.

create table if not exists public.claim_appeals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  claim_id uuid not null references public.professional_claims(id) on delete cascade,
  template_id uuid references public.claim_appeal_templates(id) on delete set null,
  level smallint not null default 1,
  status text not null default 'draft_ready',
  letter_body text,
  deadline date,
  denial_reason text,
  denied_amount numeric(12,2),
  attachments_count integer not null default 0,
  assigned_to_user_id uuid references auth.users(id),
  submitted_at timestamptz,
  decision text,
  decision_at timestamptz,
  created_by_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint claim_appeals_status_chk check (
    status in (
      'draft_ready', 'sent', 'pending',
      'won', 'lost', 'escalated_doi'
    )
  )
);

create index if not exists idx_claim_appeals_org_status
  on public.claim_appeals (organization_id, status, updated_at desc);
create index if not exists idx_claim_appeals_claim
  on public.claim_appeals (claim_id, level desc, created_at desc);

alter table public.claim_appeals enable row level security;

drop policy if exists "claim_appeals_tenant" on public.claim_appeals;
create policy "claim_appeals_tenant" on public.claim_appeals
  for all using (
    organization_id = (auth.jwt() ->> 'organization_id')::uuid
    or organization_id in (
      select organization_id from public.staff_profiles
      where auth_user_id = auth.uid()
    )
  );

create or replace function public.claim_appeals_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists claim_appeals_set_updated_at on public.claim_appeals;
create trigger claim_appeals_set_updated_at
  before update on public.claim_appeals
  for each row execute function public.claim_appeals_touch_updated_at();

notify pgrst, 'reload schema';
