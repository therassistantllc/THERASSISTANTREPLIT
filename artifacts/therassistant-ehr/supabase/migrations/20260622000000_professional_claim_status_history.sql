-- Task #779: an audited status-history source so the 6-month trend
-- numbers (Outstanding AR + Average Days in AR) can be computed
-- against true point-in-time status instead of today's status.
--
-- Why: `computeMonthlyHeadline` in app/api/billing/reports/route.ts
-- previously approximated past-month outstanding by looking at every
-- claim *currently* in an outstanding status whose submitted_at fell
-- on/before monthEnd. Practices with late status changes (a claim
-- paid two months after the period closed) under-stated how
-- outstanding things really were back then. This table captures
-- every claim_status / submitted_at / total_charge transition so the
-- snapshot for any past month is a SQL fact, not a guess.

create table if not exists public.professional_claim_status_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  professional_claim_id uuid not null references public.professional_claims(id) on delete cascade,
  appointment_id uuid,
  claim_status text not null,
  submitted_at timestamptz,
  total_charge numeric,
  changed_at timestamptz not null default now(),
  source text not null default 'trigger'
);

create index if not exists professional_claim_status_history_claim_changed_idx
  on public.professional_claim_status_history (professional_claim_id, changed_at desc);

create index if not exists professional_claim_status_history_org_changed_idx
  on public.professional_claim_status_history (organization_id, changed_at);

alter table public.professional_claim_status_history enable row level security;

-- Tenant-scoped read policy following the project's standard RLS shape
-- (compare claim_appeals, encounter_clinical_notes). The trigger that
-- writes rows runs as the table owner (security definer would require a
-- separate WITH CHECK), so we expose only SELECT to authenticated and
-- gate it by org membership. INSERTs come from the trigger / service
-- role, not from authenticated callers.
drop policy if exists professional_claim_status_history_org_select
  on public.professional_claim_status_history;
create policy professional_claim_status_history_org_select
  on public.professional_claim_status_history
  for select
  to authenticated
  using (
    organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      ''
    )
    or organization_id in (
      select sp.organization_id
      from public.staff_profiles sp
      where sp.auth_user_id = auth.uid()
    )
  );

drop policy if exists professional_claim_status_history_service_role
  on public.professional_claim_status_history;
create policy professional_claim_status_history_service_role
  on public.professional_claim_status_history
  for all
  to service_role
  using (true)
  with check (true);

-- Only service_role can INSERT directly; the trigger uses the table
-- owner so writes from production claim updates still succeed.
revoke all on public.professional_claim_status_history from public;
revoke all on public.professional_claim_status_history from anon;
revoke all on public.professional_claim_status_history from authenticated;
grant select on public.professional_claim_status_history to authenticated;
grant select, insert on public.professional_claim_status_history to service_role;

-- Append-only: status history must not be rewritten or deleted to keep
-- the trend numbers audit-trustworthy (HIPAA §164.312(b) audit controls).
revoke update, delete, truncate on public.professional_claim_status_history from public;
revoke update, delete, truncate on public.professional_claim_status_history from anon;
revoke update, delete, truncate on public.professional_claim_status_history from authenticated;
revoke update, delete, truncate on public.professional_claim_status_history from service_role;

create or replace function public.professional_claims_record_status_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    insert into public.professional_claim_status_history (
      organization_id, professional_claim_id, appointment_id,
      claim_status, submitted_at, total_charge, changed_at, source
    ) values (
      new.organization_id, new.id, new.appointment_id,
      new.claim_status, new.submitted_at, new.total_charge,
      coalesce(new.updated_at, new.created_at, now()), 'trigger'
    );
    return new;
  end if;

  -- Only record when something the trend cares about actually changed.
  if (
    new.claim_status is distinct from old.claim_status
    or new.submitted_at is distinct from old.submitted_at
    or new.total_charge is distinct from old.total_charge
  ) then
    insert into public.professional_claim_status_history (
      organization_id, professional_claim_id, appointment_id,
      claim_status, submitted_at, total_charge, changed_at, source
    ) values (
      new.organization_id, new.id, new.appointment_id,
      new.claim_status, new.submitted_at, new.total_charge,
      coalesce(new.updated_at, now()), 'trigger'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_professional_claims_record_status_history on public.professional_claims;
create trigger trg_professional_claims_record_status_history
  after insert or update of claim_status, submitted_at, total_charge
  on public.professional_claims
  for each row execute function public.professional_claims_record_status_history();

-- Backfill one history row per existing claim using its current values
-- so past-month queries have something to anchor on. Skip claims that
-- already have a history row (re-running the migration is safe).
insert into public.professional_claim_status_history (
  organization_id, professional_claim_id, appointment_id,
  claim_status, submitted_at, total_charge, changed_at, source
)
select c.organization_id, c.id, c.appointment_id,
       c.claim_status, c.submitted_at, c.total_charge,
       coalesce(c.submitted_at, c.created_at, now()), 'backfill'
from public.professional_claims c
where not exists (
  select 1 from public.professional_claim_status_history h
  where h.professional_claim_id = c.id
);

-- Snapshot of every claim's status as of a past instant.
-- Returns at most one row per claim: the latest history entry whose
-- changed_at is strictly before `p_as_of`.
create or replace function public.billing_claim_status_snapshot(
  p_organization_id uuid,
  p_as_of timestamptz,
  p_appointment_ids uuid[] default null
)
returns table (
  professional_claim_id uuid,
  claim_status text,
  submitted_at timestamptz,
  total_charge numeric,
  appointment_id uuid
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  -- Defense-in-depth: even though RLS on professional_claim_status_history
  -- already filters by tenant, reject snapshot calls for an org the caller
  -- doesn't belong to (covers callers using a JWT without the
  -- organization_id claim, or service_role callers passing a stray id).
  if current_setting('request.jwt.claims', true) is not null
     and auth.role() = 'authenticated'
     and not exists (
       select 1 from public.staff_profiles sp
       where sp.auth_user_id = auth.uid()
         and sp.organization_id = p_organization_id
     )
     and coalesce(auth.jwt() ->> 'organization_id',
                  auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
         <> p_organization_id::text
  then
    raise exception 'billing_claim_status_snapshot: caller is not a member of organization %', p_organization_id
      using errcode = '42501';
  end if;

  return query
    select distinct on (h.professional_claim_id)
      h.professional_claim_id,
      h.claim_status,
      h.submitted_at,
      h.total_charge,
      h.appointment_id
    from public.professional_claim_status_history h
    where h.organization_id = p_organization_id
      and h.changed_at < p_as_of
      and (p_appointment_ids is null or h.appointment_id = any(p_appointment_ids))
    order by h.professional_claim_id, h.changed_at desc;
end;
$$;

revoke all on function public.billing_claim_status_snapshot(uuid, timestamptz, uuid[]) from public;
revoke all on function public.billing_claim_status_snapshot(uuid, timestamptz, uuid[]) from anon;
grant execute on function public.billing_claim_status_snapshot(uuid, timestamptz, uuid[])
  to authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
