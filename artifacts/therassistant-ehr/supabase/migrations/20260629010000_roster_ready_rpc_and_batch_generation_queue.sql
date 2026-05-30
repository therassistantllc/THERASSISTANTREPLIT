-- SQL-backed roster + ready-to-generate page helpers and async 837 generation queue.

create table if not exists public.claim_837p_batch_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  batch_id uuid not null references public.claim_837p_batches(id) on delete cascade,
  status text not null default 'pending' check (
    status in ('pending', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  attempt_count integer not null default 0,
  scheduled_for timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_837p_batch_generation_jobs_pending
  on public.claim_837p_batch_generation_jobs (status, scheduled_for, created_at)
  where status = 'pending';

create index if not exists idx_837p_batch_generation_jobs_org
  on public.claim_837p_batch_generation_jobs (organization_id, created_at desc);

create unique index if not exists idx_837p_batch_generation_jobs_one_active
  on public.claim_837p_batch_generation_jobs (batch_id)
  where status in ('pending', 'running');

alter table public.claim_837p_batch_generation_jobs enable row level security;

drop policy if exists claim_837p_batch_generation_jobs_org_policy on public.claim_837p_batch_generation_jobs;
create policy claim_837p_batch_generation_jobs_org_policy
  on public.claim_837p_batch_generation_jobs
  for all to authenticated
  using (
    organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      ''
    )
  )
  with check (
    organization_id::text = coalesce(
      auth.jwt() ->> 'organization_id',
      auth.jwt() -> 'app_metadata' ->> 'organization_id',
      ''
    )
  );

create or replace function public.enqueue_claim_837p_batch_generation_job(
  p_organization_id uuid,
  p_batch_id uuid,
  p_run_after timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_now timestamptz := now();
begin
  if p_organization_id is null then
    raise exception 'organization_id is required' using errcode = '22023';
  end if;
  if p_batch_id is null then
    raise exception 'batch_id is required' using errcode = '22023';
  end if;

  perform 1
  from public.claim_837p_batches b
  where b.id = p_batch_id
    and b.organization_id = p_organization_id
    and b.archived_at is null;
  if not found then
    raise exception 'batch not found in organization' using errcode = 'P0002';
  end if;

  insert into public.claim_837p_batch_generation_jobs (
    organization_id,
    batch_id,
    status,
    attempt_count,
    scheduled_for,
    created_at,
    updated_at
  )
  select
    p_organization_id,
    p_batch_id,
    'pending',
    0,
    coalesce(p_run_after, v_now),
    v_now,
    v_now
  where not exists (
    select 1
    from public.claim_837p_batch_generation_jobs j
    where j.batch_id = p_batch_id
      and j.status in ('pending', 'running')
  )
  returning id into v_job_id;

  if v_job_id is null then
    return jsonb_build_object(
      'enqueued', false,
      'reason', 'already_pending_or_running'
    );
  end if;

  return jsonb_build_object(
    'enqueued', true,
    'job_id', v_job_id
  );
end;
$$;

revoke all on function public.enqueue_claim_837p_batch_generation_job(uuid, uuid, timestamptz) from public;
revoke all on function public.enqueue_claim_837p_batch_generation_job(uuid, uuid, timestamptz) from authenticated, anon;
grant execute on function public.enqueue_claim_837p_batch_generation_job(uuid, uuid, timestamptz) to service_role;

create or replace function public.billing_clients_roster_page(
  p_organization_id uuid,
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  client_id uuid,
  first_name text,
  last_name text,
  preferred_name text,
  email text,
  phone text,
  status text,
  intake_status text,
  open_balance numeric(12,2),
  updated_at timestamptz,
  eligibility_status text,
  eligibility_checked_at timestamptz,
  copay_amount numeric(12,2),
  next_appointment_at timestamptz,
  open_workqueue_count integer,
  claim_issue_count integer,
  primary_clinician_user_id uuid,
  total_count bigint
)
language sql
security definer
set search_path = public
as $$
  with matched as (
    select
      c.id,
      c.first_name,
      c.last_name,
      c.preferred_name,
      c.email,
      c.phone,
      c.deceased_at,
      c.intake_status,
      c.updated_at,
      c.primary_clinician_user_id
    from public.clients c
    where c.organization_id = p_organization_id
      and c.archived_at is null
      and (
        p_query is null
        or btrim(p_query) = ''
        or concat_ws(' ', c.first_name, c.last_name, c.preferred_name, c.email, c.phone)
          ilike ('%' || btrim(p_query) || '%')
      )
  ),
  total as (
    select count(*)::bigint as total_count from matched
  ),
  paged as (
    select *
    from matched
    order by last_name asc, first_name asc
    limit greatest(coalesce(p_limit, 50), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select
    p.id as client_id,
    p.first_name,
    p.last_name,
    p.preferred_name,
    p.email,
    p.phone,
    case when p.deceased_at is not null then 'deceased' else 'active' end as status,
    coalesce(p.intake_status, 'not_started') as intake_status,
    coalesce(inv.open_balance, 0)::numeric(12,2) as open_balance,
    p.updated_at,
    elig.eligibility_status,
    elig.checked_at as eligibility_checked_at,
    elig.copay_amount,
    appt.next_appointment_at,
    coalesce(wq.open_workqueue_count, 0)::integer as open_workqueue_count,
    coalesce(clm.claim_issue_count, 0)::integer as claim_issue_count,
    p.primary_clinician_user_id,
    t.total_count
  from paged p
  cross join total t
  left join lateral (
    select coalesce(sum(i.balance_amount), 0)::numeric(12,2) as open_balance
    from public.patient_invoices i
    where i.organization_id = p_organization_id
      and i.client_id = p.id
      and i.archived_at is null
      and i.invoice_status in ('open', 'sent', 'collections')
  ) inv on true
  left join lateral (
    select
      e.eligibility_status,
      e.checked_at,
      e.copay_amount
    from public.eligibility_checks e
    where e.organization_id = p_organization_id
      and e.client_id = p.id
      and e.archived_at is null
    order by e.checked_at desc nulls last
    limit 1
  ) elig on true
  left join lateral (
    select min(a.scheduled_start_at) as next_appointment_at
    from public.appointments a
    where a.organization_id = p_organization_id
      and a.client_id = p.id
      and a.archived_at is null
      and a.scheduled_start_at >= now()
  ) appt on true
  left join lateral (
    select count(*)::integer as open_workqueue_count
    from public.workqueue_items w
    where w.organization_id = p_organization_id
      and w.client_id = p.id
      and w.archived_at is null
      and w.status in ('open', 'in_progress', 'blocked')
  ) wq on true
  left join lateral (
    select count(*)::integer as claim_issue_count
    from public.professional_claims pc
    where pc.organization_id = p_organization_id
      and pc.archived_at is null
      and pc.patient_id = p.id
      and pc.claim_status in ('denied', 'rejected_oa', 'rejected_payer')
  ) clm on true
  order by p.last_name asc, p.first_name asc;
$$;

revoke all on function public.billing_clients_roster_page(uuid, text, integer, integer) from public;
revoke all on function public.billing_clients_roster_page(uuid, text, integer, integer) from authenticated, anon;
grant execute on function public.billing_clients_roster_page(uuid, text, integer, integer) to service_role;

create or replace function public.billing_ready_to_generate_page(
  p_organization_id uuid,
  p_include_held boolean default false,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  id uuid,
  claim_number text,
  claim_status text,
  client_id uuid,
  client_name text,
  service_date date,
  clinician_name text,
  payer_profile_id uuid,
  payer_name text,
  payer_type text,
  payer_id_value text,
  cpt_codes text[],
  diagnosis_codes text[],
  modifiers text[],
  charge_amount numeric(12,2),
  place_of_service text,
  rendering_provider_npi text,
  billing_provider_name text,
  billing_provider_npi text,
  ready_status text,
  held_at timestamptz,
  hold_reason text,
  age_days integer,
  encounter_id uuid,
  batch_id uuid,
  practice_id text,
  practice_name text,
  assigned_biller_user_id uuid,
  assigned_biller_name text,
  follow_up_due_at timestamptz,
  total_count bigint
)
language sql
security definer
set search_path = public
as $$
  with matched as (
    select
      pc.*, count(*) over() as total_count
    from public.professional_claims pc
    where pc.organization_id = p_organization_id
      and pc.claim_status = 'ready_for_batch'
      and pc.archived_at is null
      and (p_include_held or pc.held_at is null)
    order by pc.created_at asc
    limit greatest(coalesce(p_limit, 100), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select
    m.id,
    m.claim_number,
    m.claim_status,
    m.patient_id as client_id,
    coalesce(nullif(concat_ws(' ', c.first_name, c.last_name), ''), 'Unknown client') as client_name,
    sl.service_date,
    prov.clinician_name,
    m.payer_profile_id,
    pp.payer_name,
    pp.payer_type,
    pp.payer_id as payer_id_value,
    coalesce(sl.cpt_codes, '{}'::text[]) as cpt_codes,
    coalesce(m.diagnosis_codes, '{}'::text[]) as diagnosis_codes,
    coalesce(sl.modifiers, '{}'::text[]) as modifiers,
    coalesce(m.total_charge, 0)::numeric(12,2) as charge_amount,
    coalesce(sl.place_of_service, m.place_of_service) as place_of_service,
    sl.rendering_provider_npi,
    snap.billing_provider_name,
    snap.billing_provider_npi,
    case
      when m.held_at is not null then 'on_hold'
      when bc.batch_id is not null then 'needs_batch_assignment'
      else 'ready'
    end as ready_status,
    m.held_at,
    m.hold_reason,
    floor(extract(epoch from (now() - m.created_at)) / 86400)::integer as age_days,
    m.encounter_id,
    bc.batch_id,
    snap.billing_provider_npi as practice_id,
    snap.billing_provider_name as practice_name,
    wq.assigned_to_user_id as assigned_biller_user_id,
    coalesce(u.full_name, u.email) as assigned_biller_name,
    wq.defer_until as follow_up_due_at,
    m.total_count::bigint as total_count
  from matched m
  left join public.clients c
    on c.id = m.patient_id
  left join public.payer_profiles pp
    on pp.id = m.payer_profile_id
  left join lateral (
    select
      min(sl.service_date_from) as service_date,
      array_remove(array_agg(distinct nullif(btrim(sl.procedure_code), '')), null) as cpt_codes,
      array_remove(array_agg(distinct nullif(btrim(mods.modifier), '')), null) as modifiers,
      (array_agg(sl.place_of_service order by sl.line_number asc))[1] as place_of_service,
      (array_agg(sl.rendering_provider_npi order by sl.line_number asc))[1] as rendering_provider_npi
    from public.professional_claim_service_lines sl
    left join lateral unnest(coalesce(sl.modifiers, '{}'::text[])) as mods(modifier) on true
    where sl.claim_id = m.id
  ) sl on true
  left join lateral (
    select
      cps.billing_provider_name,
      cps.billing_provider_npi
    from public.claim_parties_snapshot cps
    where cps.claim_id = m.id
    limit 1
  ) snap on true
  left join lateral (
    select
      concat_ws(' ', p.first_name, p.last_name) as clinician_name
    from public.encounters e
    left join public.providers p on p.id = e.provider_id
    where e.id = m.encounter_id
    limit 1
  ) prov on true
  left join lateral (
    select bcl.batch_id
    from public.claim_837p_batch_claims bcl
    where bcl.organization_id = p_organization_id
      and bcl.professional_claim_id = m.id
      and bcl.archived_at is null
    order by bcl.created_at desc
    limit 1
  ) bc on true
  left join lateral (
    select
      w.assigned_to_user_id,
      w.defer_until
    from public.workqueue_items w
    where w.organization_id = p_organization_id
      and w.professional_claim_id = m.id
      and w.archived_at is null
    order by w.updated_at desc nulls last
    limit 1
  ) wq on true
  left join public.users u
    on u.id = wq.assigned_to_user_id
  order by m.created_at asc;
$$;

revoke all on function public.billing_ready_to_generate_page(uuid, boolean, integer, integer) from public;
revoke all on function public.billing_ready_to_generate_page(uuid, boolean, integer, integer) from authenticated, anon;
grant execute on function public.billing_ready_to_generate_page(uuid, boolean, integer, integer) to service_role;

select pg_notify('pgrst', 'reload schema');
