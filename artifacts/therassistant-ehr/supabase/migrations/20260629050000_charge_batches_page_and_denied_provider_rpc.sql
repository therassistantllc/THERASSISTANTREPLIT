-- SQL page helpers for charge batches and provider-filtered denied claims.

create or replace function public.billing_charge_batches_page(
  p_organization_id uuid,
  p_practice text default null,
  p_provider_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id uuid,
  batch_number text,
  batch_status text,
  claim_count integer,
  total_charge_amount numeric(12,2),
  generated_file_name text,
  submitted_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  payer_profile_id uuid,
  payer_name text,
  billing_provider_tax_id text,
  claims jsonb,
  total_count bigint
)
language sql
security definer
set search_path = public
as $$
  with base_batches as (
    select b.*
    from public.claim_837p_batches b
    where b.organization_id = p_organization_id
      and b.batch_source = 'charge_auto'
      and b.archived_at is null
  ),
  claim_rows as (
    select
      b.id as batch_id,
      pc.id as claim_id,
      coalesce(nullif(pc.claim_number, ''), left(pc.id::text, 8)) as claim_number,
      pc.claim_status,
      coalesce(pc.total_charge, 0)::numeric(12,2) as total_charge,
      a.provider_location_id::text as practice_id,
      coalesce(nullif(concat_ws(' ', c.first_name, c.last_name), ''), 'Unknown Client') as patient_name,
      coalesce(
        nullif(btrim(pr.display_name), ''),
        nullif(concat_ws(' ', pr.first_name, pr.last_name), ''),
        '—'
      ) as provider_name,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', coalesce(sl.id::text, pc.id::text || '-' || coalesce(sl.line_number::text, '1')),
              'lineNumber', coalesce(sl.line_number, 0),
              'dateOfService', sl.service_date_from,
              'procedureCode', coalesce(nullif(sl.procedure_code, ''), '—'),
              'chargeAmount', coalesce(sl.charge_amount, 0)::numeric(12,2)
            )
            order by sl.line_number asc
          )
          from public.professional_claim_service_lines sl
          where sl.organization_id = p_organization_id
            and sl.claim_id = pc.id
            and sl.archived_at is null
        ),
        '[]'::jsonb
      ) as service_lines
    from base_batches b
    join public.claim_837p_batch_claims l
      on l.batch_id = b.id
     and l.organization_id = p_organization_id
     and l.archived_at is null
    join public.professional_claims pc
      on pc.id = l.professional_claim_id
     and pc.organization_id = p_organization_id
     and pc.archived_at is null
    left join public.appointments a
      on a.id = pc.appointment_id
    left join public.providers pr
      on pr.id = a.provider_id
    left join public.clients c
      on c.id = coalesce(pc.patient_id, pc.client_id)
    where (p_practice is null or p_practice = '' or a.provider_location_id::text = p_practice)
      and (p_provider_id is null or a.provider_id = p_provider_id)
  ),
  rolled as (
    select
      b.id,
      b.batch_number,
      b.batch_status,
      count(*)::integer as claim_count,
      coalesce(sum(cr.total_charge), 0)::numeric(12,2) as total_charge_amount,
      b.generated_file_name,
      b.submitted_at,
      b.created_at,
      b.updated_at,
      b.payer_profile_id,
      coalesce(pp.payer_name, 'Payer') as payer_name,
      b.billing_provider_tax_id,
      jsonb_agg(
        jsonb_build_object(
          'id', cr.claim_id,
          'claimNumber', cr.claim_number,
          'status', cr.claim_status,
          'totalCharge', cr.total_charge,
          'practiceId', cr.practice_id,
          'patientName', cr.patient_name,
          'providerName', cr.provider_name,
          'serviceLines', cr.service_lines
        )
        order by cr.claim_number asc
      ) as claims
    from base_batches b
    join claim_rows cr
      on cr.batch_id = b.id
    left join public.payer_profiles pp
      on pp.id = b.payer_profile_id
    group by
      b.id,
      b.batch_number,
      b.batch_status,
      b.generated_file_name,
      b.submitted_at,
      b.created_at,
      b.updated_at,
      b.payer_profile_id,
      pp.payer_name,
      b.billing_provider_tax_id
  ),
  paged as (
    select r.*, count(*) over() as total_count
    from rolled r
    order by r.created_at desc
    limit greatest(coalesce(p_limit, 50), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select
    p.id,
    p.batch_number,
    p.batch_status,
    p.claim_count,
    p.total_charge_amount,
    p.generated_file_name,
    p.submitted_at,
    p.created_at,
    p.updated_at,
    p.payer_profile_id,
    p.payer_name,
    p.billing_provider_tax_id,
    p.claims,
    p.total_count::bigint as total_count
  from paged p
  order by p.created_at desc;
$$;

revoke all on function public.billing_charge_batches_page(uuid, text, uuid, integer, integer) from public;
revoke all on function public.billing_charge_batches_page(uuid, text, uuid, integer, integer) from authenticated, anon;
grant execute on function public.billing_charge_batches_page(uuid, text, uuid, integer, integer) to service_role;

create or replace function public.billing_denied_claims_page_v2(
  p_organization_id uuid,
  p_practice text default null,
  p_provider_id uuid default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table (
  id uuid,
  claim_number text,
  claim_status text,
  client_id uuid,
  client_name text,
  payer_name text,
  provider_name text,
  provider_id uuid,
  practice_id text,
  date_of_service date,
  total_charge numeric(12,2),
  patient_responsibility numeric(12,2),
  payer_paid numeric(12,2),
  denial_reason_code text,
  denial_reason_description text,
  appeal_deadline_date date,
  correction_status text,
  correction_type text,
  billing_notes text,
  submitted_at timestamptz,
  created_at timestamptz,
  cpt_code text,
  total_count bigint
)
language sql
security definer
set search_path = public
as $$
  with matched as (
    select
      pc.id,
      pc.claim_number,
      pc.claim_status,
      pc.client_id,
      pc.total_charge,
      pc.patient_responsibility_amount,
      pc.payer_responsibility_amount,
      pc.denial_reason_code,
      pc.denial_reason_description,
      pc.appeal_deadline_date,
      pc.correction_status,
      pc.correction_type,
      pc.billing_notes,
      pc.submitted_at,
      pc.created_at,
      pc.first_billed_date,
      a.scheduled_start_at,
      a.provider_id,
      a.provider_location_id,
      c.first_name as client_first_name,
      c.last_name as client_last_name,
      pp.payer_name,
      p.display_name as provider_display_name,
      p.first_name as provider_first_name,
      p.last_name as provider_last_name,
      count(*) over() as total_count
    from public.professional_claims pc
    left join public.clients c
      on c.id = pc.client_id
    left join public.payer_profiles pp
      on pp.id = pc.payer_profile_id
    left join public.appointments a
      on a.id = pc.appointment_id
    left join public.providers p
      on p.id = a.provider_id
    where pc.organization_id = p_organization_id
      and pc.claim_status = 'denied'
      and pc.archived_at is null
      and (p_practice is null or p_practice = '' or a.provider_location_id::text = p_practice)
      and (p_provider_id is null or a.provider_id = p_provider_id)
    order by pc.updated_at desc
    limit greatest(coalesce(p_limit, 100), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select
    m.id,
    m.claim_number,
    m.claim_status,
    m.client_id,
    coalesce(nullif(concat_ws(' ', m.client_first_name, m.client_last_name), ''), '—') as client_name,
    coalesce(m.payer_name, '—') as payer_name,
    coalesce(
      nullif(btrim(m.provider_display_name), ''),
      nullif(concat_ws(' ', m.provider_first_name, m.provider_last_name), ''),
      null
    ) as provider_name,
    m.provider_id,
    m.provider_location_id::text as practice_id,
    coalesce(m.scheduled_start_at::date, m.first_billed_date) as date_of_service,
    coalesce(m.total_charge, 0)::numeric(12,2) as total_charge,
    coalesce(m.patient_responsibility_amount, 0)::numeric(12,2) as patient_responsibility,
    coalesce(m.payer_responsibility_amount, 0)::numeric(12,2) as payer_paid,
    m.denial_reason_code,
    m.denial_reason_description,
    m.appeal_deadline_date,
    m.correction_status,
    m.correction_type,
    m.billing_notes,
    m.submitted_at,
    m.created_at,
    coalesce(sl.procedure_code, '—') as cpt_code,
    m.total_count::bigint as total_count
  from matched m
  left join lateral (
    select l.procedure_code
    from public.professional_claim_service_lines l
    where l.organization_id = p_organization_id
      and l.claim_id = m.id
      and l.archived_at is null
    order by l.line_number asc
    limit 1
  ) sl on true
  order by m.created_at desc;
$$;

revoke all on function public.billing_denied_claims_page_v2(uuid, text, uuid, integer, integer) from public;
revoke all on function public.billing_denied_claims_page_v2(uuid, text, uuid, integer, integer) from authenticated, anon;
grant execute on function public.billing_denied_claims_page_v2(uuid, text, uuid, integer, integer) to service_role;

select pg_notify('pgrst', 'reload schema');
