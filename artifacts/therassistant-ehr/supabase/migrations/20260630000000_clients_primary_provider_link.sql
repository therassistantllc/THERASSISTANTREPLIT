alter table public.clients
add column if not exists primary_provider_id uuid references public.providers(id);

update public.clients c
set primary_provider_id = p.id
from public.providers p
where c.organization_id = p.organization_id
  and c.primary_provider_id is null
  and c.primary_clinician_user_id is not null
  and (
    c.primary_clinician_user_id = p.user_id
    or c.primary_clinician_user_id::text = p.id::text
  );

create index if not exists idx_clients_org_primary_provider
on public.clients (organization_id, primary_provider_id);

drop function if exists public.billing_clients_roster_page(uuid, text, integer, integer);

create function public.billing_clients_roster_page(
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
  primary_provider_id uuid,
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
      c.primary_provider_id
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
    p.primary_provider_id,
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
