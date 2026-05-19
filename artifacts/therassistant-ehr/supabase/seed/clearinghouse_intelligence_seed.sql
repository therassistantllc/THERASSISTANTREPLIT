-- File: supabase/seed/clearinghouse_intelligence_seed.sql
-- Demo seed for clearinghouse intelligence.
-- This seed assumes the app already has clients, appointments, and claims.
-- It safely inserts a mock connection and a few sample rows when matching records exist.

insert into public.clearinghouse_connections (
  organization_id,
  vendor,
  connection_name,
  mode,
  submitter_id,
  receiver_id,
  api_base_url,
  auth_type,
  encrypted_credentials,
  is_active
)
select
  c.organization_id,
  'mock',
  'Mock Clearinghouse Connection',
  'test',
  'MOCKSUBMITTER',
  'MOCKRECEIVER',
  'https://mock-clearinghouse.local',
  'mock',
  jsonb_build_object('token_placeholder', '***'),
  true
from public.clients c
group by c.organization_id
on conflict do nothing;

with active_patient as (
  select c.id, c.organization_id
  from public.clients c
  order by c.created_at asc
  limit 1
),
inactive_patient as (
  select c.id, c.organization_id
  from public.clients c
  order by c.created_at desc
  limit 1
),
first_connection as (
  select id, organization_id from public.clearinghouse_connections order by created_at asc limit 1
)
insert into public.eligibility_checks (
  organization_id,
  patient_id,
  clearinghouse_connection_id,
  payer_name,
  payer_id,
  status,
  plan_name,
  member_id,
  subscriber_name,
  effective_date,
  copay_amount,
  deductible_total,
  deductible_remaining,
  coinsurance_percent,
  out_of_pocket_remaining
)
select
  ap.organization_id,
  ap.id,
  fc.id,
  'Mock Active Payer',
  'MOCK001',
  'active',
  'Mock PPO Gold',
  'ACTIVE1234',
  'Active Patient',
  current_date - interval '30 days',
  25,
  1500,
  830,
  20,
  1700
from active_patient ap
cross join first_connection fc
where not exists (
  select 1 from public.eligibility_checks ec where ec.patient_id = ap.id
);

with first_connection as (
  select id, organization_id from public.clearinghouse_connections order by created_at asc limit 1
),
claim_rows as (
  select cl.id, cl.organization_id, cl.client_id, cl.claim_status, cl.total_charge_amount
  from public.claims cl
  order by cl.created_at asc
  limit 3
)
insert into public.claim_status_inquiries (
  organization_id,
  claim_id,
  patient_id,
  clearinghouse_connection_id,
  payer_name,
  payer_id,
  status,
  billed_amount,
  paid_amount,
  raw_status
)
select
  cr.organization_id,
  cr.id,
  cr.client_id,
  fc.id,
  'Mock Payer',
  'MOCK001',
  case
    when row_number() over (order by cr.id) = 1 then 'pending'
    when row_number() over (order by cr.id) = 2 then 'denied'
    else 'paid'
  end,
  cr.total_charge_amount,
  case when row_number() over (order by cr.id) = 3 then cr.total_charge_amount else 0 end,
  jsonb_build_object('seeded', true)
from claim_rows cr
cross join first_connection fc
where not exists (
  select 1 from public.claim_status_inquiries csc where csc.claim_id = cr.id
);
