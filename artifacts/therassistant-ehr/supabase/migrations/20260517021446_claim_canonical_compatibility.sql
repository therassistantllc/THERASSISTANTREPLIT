alter table public.professional_claims
  add column if not exists client_id uuid;

update public.professional_claims
set client_id = patient_id
where client_id is null
  and patient_id is not null;

create index if not exists idx_professional_claims_client_id
  on public.professional_claims (client_id)
  where client_id is not null;

alter table public.professional_claims
  add column if not exists legacy_claim_id uuid;

create index if not exists idx_professional_claims_legacy_claim_id
  on public.professional_claims (legacy_claim_id)
  where legacy_claim_id is not null;

create or replace view public.canonical_claims as
select
  pc.id,
  pc.organization_id,
  pc.client_id,
  pc.patient_id,
  pc.encounter_id,
  pc.appointment_id,
  pc.claim_number,
  pc.claim_status,
  pc.total_charge,
  null::timestamptz as submitted_at,
  pc.created_at,
  pc.updated_at,
  pc.legacy_claim_id
from public.professional_claims pc;