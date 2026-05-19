-- File: supabase/migrations/20260509_office_ally_837p_foundation.sql
-- Purpose: Office Ally 837P foundation for professional claims, batch storage, and acknowledgements.

create extension if not exists pgcrypto;

create table if not exists public.clearinghouse_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  vendor text not null default 'office_ally',
  mode text not null default 'test' check (mode in ('test', 'production')),
  submitter_id text not null,
  sender_qualifier text not null default 'ZZ' check (sender_qualifier in ('30', 'ZZ')),
  receiver_qualifier text not null default '30' check (receiver_qualifier in ('30', 'ZZ')),
  receiver_id text not null default '330897513',
  receiver_name text not null default 'OFFICEALLY',
  gs_receiver_code text not null default 'OA',
  x12_version text not null default '005010X222A1',
  isa_usage_indicator text not null default 'T' check (isa_usage_indicator in ('T', 'P')),
  sftp_host text,
  sftp_port integer default 22,
  sftp_username text,
  inbound_folder text default 'inbound',
  outbound_folder text default 'outbound',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_clearinghouse_connections_org_name_mode
  on public.clearinghouse_connections (organization_id, vendor, mode);

create table if not exists public.payer_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payer_name text not null,
  office_ally_payer_id text not null,
  payer_type text check (payer_type in ('medicaid', 'medicare', 'commercial', 'other')),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payer_profiles_organization_id
  on public.payer_profiles (organization_id);

create index if not exists idx_payer_profiles_office_ally_payer_id
  on public.payer_profiles (office_ally_payer_id);

create table if not exists public.professional_claims (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  patient_id uuid references public.clients(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  payer_profile_id uuid references public.payer_profiles(id) on delete set null,
  claim_number text,
  patient_account_number text,
  claim_status text not null default 'draft' check (
    claim_status in (
      'draft',
      'ready_for_validation',
      'validation_failed',
      'ready_for_batch',
      'batched',
      'submitted',
      'accepted_oa',
      'rejected_oa',
      'accepted_payer',
      'rejected_payer',
      'paid',
      'denied',
      'voided'
    )
  ),
  total_charge numeric(12,2) not null default 0,
  place_of_service text,
  diagnosis_codes text[] not null default '{}'::text[],
  prior_authorization_number text,
  accept_assignment boolean default true,
  benefits_assignment boolean default true,
  release_of_information boolean default true,
  signature_on_file boolean default true,
  validation_errors jsonb not null default '[]'::jsonb,
  last_validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_professional_claims_organization_id
  on public.professional_claims (organization_id);

create index if not exists idx_professional_claims_patient_id
  on public.professional_claims (patient_id);

create index if not exists idx_professional_claims_claim_status
  on public.professional_claims (claim_status);

create table if not exists public.professional_claim_service_lines (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.professional_claims(id) on delete cascade,
  line_number integer not null,
  service_date_from date not null,
  service_date_to date,
  procedure_code text not null,
  modifiers text[] not null default '{}'::text[],
  charge_amount numeric(12,2) not null,
  units numeric(10,2) not null default 1,
  diagnosis_pointers text[] not null default '{1}'::text[],
  place_of_service text,
  rendering_provider_npi text,
  authorization_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_professional_claim_service_lines_claim_line_number
  on public.professional_claim_service_lines (claim_id, line_number);

create table if not exists public.claim_parties_snapshot (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null unique references public.professional_claims(id) on delete cascade,
  billing_provider_entity_type text not null default '2' check (billing_provider_entity_type in ('1', '2')),
  billing_provider_name text not null,
  billing_provider_first_name text,
  billing_provider_npi text not null,
  billing_provider_tax_id text not null,
  billing_provider_tax_id_type text not null default 'EI' check (billing_provider_tax_id_type in ('EI', 'SY')),
  billing_provider_address1 text not null,
  billing_provider_address2 text,
  billing_provider_city text not null,
  billing_provider_state text not null,
  billing_provider_zip text not null,
  subscriber_last_name text not null,
  subscriber_first_name text not null,
  subscriber_member_id text not null,
  subscriber_dob date not null,
  subscriber_gender text check (subscriber_gender in ('F', 'M', 'U')),
  subscriber_address1 text not null,
  subscriber_city text not null,
  subscriber_state text not null,
  subscriber_zip text not null,
  patient_is_subscriber boolean not null default true,
  patient_last_name text,
  patient_first_name text,
  patient_dob date,
  patient_gender text check (patient_gender in ('F', 'M', 'U')),
  patient_address1 text,
  patient_city text,
  patient_state text,
  patient_zip text,
  payer_name text not null,
  payer_id text not null,
  rendering_same_as_billing boolean not null default true,
  rendering_provider_entity_type text check (rendering_provider_entity_type in ('1', '2')),
  rendering_provider_last_name_or_org text,
  rendering_provider_first_name text,
  rendering_provider_npi text,
  service_facility_same_as_billing boolean not null default true,
  service_facility_name text,
  service_facility_npi text,
  service_facility_address1 text,
  service_facility_city text,
  service_facility_state text,
  service_facility_zip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.edi_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  clearinghouse_connection_id uuid references public.clearinghouse_connections(id) on delete set null,
  transaction_type text not null default '837P',
  mode text not null check (mode in ('test', 'production')),
  file_name text not null,
  file_content text not null,
  isa_control_number text not null,
  gs_control_number text not null,
  st_control_number text not null,
  claim_count integer not null default 0,
  status text not null default 'generated' check (
    status in (
      'generated',
      'submitted',
      'accepted_999',
      'rejected_999',
      'accepted_277ca',
      'rejected_277ca',
      'partially_accepted',
      'failed'
    )
  ),
  office_ally_file_id text,
  generated_at timestamptz not null default now(),
  submitted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_edi_batches_organization_id
  on public.edi_batches (organization_id);

create index if not exists idx_edi_batches_status
  on public.edi_batches (status);

create index if not exists idx_edi_batches_file_name
  on public.edi_batches (file_name);

create table if not exists public.edi_batch_claims (
  id uuid primary key default gen_random_uuid(),
  edi_batch_id uuid not null references public.edi_batches(id) on delete cascade,
  claim_id uuid not null references public.professional_claims(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_edi_batch_claims_batch_claim
  on public.edi_batch_claims (edi_batch_id, claim_id);

create table if not exists public.edi_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  edi_batch_id uuid references public.edi_batches(id) on delete set null,
  acknowledgement_type text not null check (acknowledgement_type in ('999', '277CA', 'file_summary', 'edi_status', '835', 'era_status_text', 'other')),
  file_name text,
  raw_content text not null,
  parsed_content jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_edi_acknowledgements_organization_id
  on public.edi_acknowledgements (organization_id);

create index if not exists idx_edi_acknowledgements_acknowledgement_type
  on public.edi_acknowledgements (acknowledgement_type);

create index if not exists idx_edi_acknowledgements_edi_batch_id
  on public.edi_acknowledgements (edi_batch_id);

alter table if exists public.claim_status_events
  add column if not exists status text not null default 'unknown',
  add column if not exists status_message text,
  add column if not exists external_claim_id text,
  add column if not exists office_ally_claim_id text,
  add column if not exists office_ally_file_id text,
  add column if not exists payer_reference_id text,
  add column if not exists raw_payload jsonb not null default '{}'::jsonb;

create index if not exists idx_claim_status_events_claim_source_created
  on public.claim_status_events (claim_id, source, created_at desc);

alter table public.clearinghouse_connections enable row level security;
alter table public.payer_profiles enable row level security;
alter table public.professional_claims enable row level security;
alter table public.professional_claim_service_lines enable row level security;
alter table public.claim_parties_snapshot enable row level security;
alter table public.edi_batches enable row level security;
alter table public.edi_batch_claims enable row level security;
alter table public.edi_acknowledgements enable row level security;
alter table public.claim_status_events enable row level security;

drop policy if exists clearinghouse_connections_org_policy on public.clearinghouse_connections;
create policy clearinghouse_connections_org_policy on public.clearinghouse_connections
  for all to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

drop policy if exists payer_profiles_org_policy on public.payer_profiles;
create policy payer_profiles_org_policy on public.payer_profiles
  for all to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

drop policy if exists professional_claims_org_policy on public.professional_claims;
create policy professional_claims_org_policy on public.professional_claims
  for all to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

drop policy if exists professional_claim_service_lines_org_policy on public.professional_claim_service_lines;
create policy professional_claim_service_lines_org_policy on public.professional_claim_service_lines
  for all to authenticated
  using (
    exists (
      select 1
      from public.professional_claims pc
      where pc.id = professional_claim_service_lines.claim_id
        and pc.organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
    )
  )
  with check (
    exists (
      select 1
      from public.professional_claims pc
      where pc.id = professional_claim_service_lines.claim_id
        and pc.organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
    )
  );

drop policy if exists claim_parties_snapshot_org_policy on public.claim_parties_snapshot;
create policy claim_parties_snapshot_org_policy on public.claim_parties_snapshot
  for all to authenticated
  using (
    exists (
      select 1
      from public.professional_claims pc
      where pc.id = claim_parties_snapshot.claim_id
        and pc.organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
    )
  )
  with check (
    exists (
      select 1
      from public.professional_claims pc
      where pc.id = claim_parties_snapshot.claim_id
        and pc.organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
    )
  );

drop policy if exists edi_batches_org_policy on public.edi_batches;
create policy edi_batches_org_policy on public.edi_batches
  for all to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

drop policy if exists edi_batch_claims_org_policy on public.edi_batch_claims;
create policy edi_batch_claims_org_policy on public.edi_batch_claims
  for all to authenticated
  using (
    exists (
      select 1
      from public.edi_batches eb
      join public.professional_claims pc on pc.id = edi_batch_claims.claim_id
      where eb.id = edi_batch_claims.edi_batch_id
        and eb.organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
        and pc.organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
    )
  )
  with check (
    exists (
      select 1
      from public.edi_batches eb
      join public.professional_claims pc on pc.id = edi_batch_claims.claim_id
      where eb.id = edi_batch_claims.edi_batch_id
        and eb.organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
        and pc.organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
    )
  );

drop policy if exists edi_acknowledgements_org_policy on public.edi_acknowledgements;
create policy edi_acknowledgements_org_policy on public.edi_acknowledgements
  for all to authenticated
  using (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  )
  with check (
    organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
  );

drop policy if exists claim_status_events_org_policy on public.claim_status_events;
create policy claim_status_events_org_policy on public.claim_status_events
  for all to authenticated
  using (
    exists (
      select 1
      from public.professional_claims pc
      where pc.id = claim_status_events.claim_id
        and pc.organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
    )
  )
  with check (
    exists (
      select 1
      from public.professional_claims pc
      where pc.id = claim_status_events.claim_id
        and pc.organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', '')
    )
  );
