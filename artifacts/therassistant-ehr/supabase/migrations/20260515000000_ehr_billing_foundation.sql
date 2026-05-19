-- ============================================================================
-- Migration: 20260515000000_ehr_billing_foundation.sql
-- Purpose:   Add all missing tables, columns, indexes, FKs, and RLS policies
--            needed for a fully end-to-end testable EHR/billing flow.
--            All operations use IF NOT EXISTS / safe ALTER patterns.
--
-- Flow covered:
--   org → provider → patient → insurance → appointment → eligibility →
--   encounter → note → codes → coding suggestions → claim → claim lines →
--   clearinghouse txn → claim status → ERA payment → billing alert →
--   workqueue → ticket → mailroom → documents → audit log
-- ============================================================================

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1: patient_contacts
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.patient_contacts (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  client_id           uuid        not null references public.clients(id) on delete cascade,
  contact_type        text        not null default 'emergency' check (
                                    contact_type in ('emergency', 'guarantor', 'guardian', 'authorized', 'other')
                                  ),
  relationship        text,
  first_name          text        not null,
  last_name           text        not null,
  phone               text,
  email               text,
  address_line1       text,
  address_city        text,
  address_state       text,
  address_zip         text,
  is_primary          boolean     not null default false,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create index if not exists idx_patient_contacts_client
  on public.patient_contacts (organization_id, client_id, contact_type)
  where archived_at is null;

alter table public.patient_contacts enable row level security;
drop policy if exists patient_contacts_org_policy on public.patient_contacts;
create policy patient_contacts_org_policy on public.patient_contacts
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2: payer_plans
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.payer_plans (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  payer_profile_id    uuid        references public.payer_profiles(id) on delete set null,
  insurance_payer_id  uuid        references public.insurance_payers(id) on delete set null,
  plan_name           text        not null,
  plan_code           text,
  plan_type           text        check (plan_type in ('hmo', 'ppo', 'pos', 'epo', 'medicaid', 'medicare', 'tricare', 'other')),
  electronic_payer_id text,
  timely_filing_days  integer     not null default 365,
  requires_auth       boolean     not null default false,
  is_active           boolean     not null default true,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create index if not exists idx_payer_plans_org_payer
  on public.payer_plans (organization_id, payer_profile_id)
  where archived_at is null;

alter table public.payer_plans enable row level security;
drop policy if exists payer_plans_org_policy on public.payer_plans;
create policy payer_plans_org_policy on public.payer_plans
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3: service_locations
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.service_locations (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  name                text        not null,
  location_type       text        not null default 'office' check (
                                    location_type in ('office', 'telehealth', 'home', 'hospital', 'school', 'community', 'other')
                                  ),
  place_of_service_code text      not null default '11',
  npi                 text,
  address_line1       text,
  address_city        text,
  address_state       text,
  address_zip         text,
  phone               text,
  fax                 text,
  is_active           boolean     not null default true,
  is_default          boolean     not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create index if not exists idx_service_locations_org
  on public.service_locations (organization_id, is_active)
  where archived_at is null;

alter table public.service_locations enable row level security;
drop policy if exists service_locations_org_policy on public.service_locations;
create policy service_locations_org_policy on public.service_locations
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4: diagnosis_codes  (ICD-10 reference)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.diagnosis_codes (
  id                  uuid        primary key default gen_random_uuid(),
  code                text        not null,
  code_system         text        not null default 'ICD-10-CM',
  description         text        not null,
  description_short   text,
  is_active           boolean     not null default true,
  effective_date      date,
  expiration_date     date,
  created_at          timestamptz not null default now()
);

create unique index if not exists idx_diagnosis_codes_code_system
  on public.diagnosis_codes (code, code_system);
create index if not exists idx_diagnosis_codes_code_text
  on public.diagnosis_codes using gin (to_tsvector('english', description));

-- Public read (no org scoping — reference data)
alter table public.diagnosis_codes enable row level security;
drop policy if exists diagnosis_codes_read on public.diagnosis_codes;
create policy diagnosis_codes_read on public.diagnosis_codes
  for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5: patient_diagnoses  (problem list)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.patient_diagnoses (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  client_id           uuid        not null references public.clients(id) on delete cascade,
  encounter_id        uuid        references public.encounters(id) on delete set null,
  diagnosis_code      text        not null,
  diagnosis_description text,
  code_system         text        not null default 'ICD-10-CM',
  onset_date          date,
  resolved_date       date,
  is_active           boolean     not null default true,
  is_primary          boolean     not null default false,
  present_on_claim    boolean     not null default true,
  clinical_notes      text,
  created_by_user_id  uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create index if not exists idx_patient_diagnoses_client
  on public.patient_diagnoses (organization_id, client_id, is_active, diagnosis_code)
  where archived_at is null;

alter table public.patient_diagnoses enable row level security;
drop policy if exists patient_diagnoses_org_policy on public.patient_diagnoses;
create policy patient_diagnoses_org_policy on public.patient_diagnoses
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5b: provider_profiles (prerequisite for FK references below)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.provider_profiles (
  id                              uuid        primary key default gen_random_uuid(),
  organization_id                 uuid        not null references public.organizations(id) on delete cascade,
  staff_id                        uuid,
  provider_npi                    text,
  provider_type                   text,
  specialty                       text,
  credentials                     text,
  license_number                  text,
  license_state                   text,
  license_expiration_date         date,
  board_certifications            jsonb       not null default '[]'::jsonb,
  malpractice_insurance_carrier   text,
  malpractice_tail_coverage       boolean     not null default false,
  is_rendering_provider           boolean     not null default true,
  is_billing_provider             boolean     not null default false,
  is_referring_provider           boolean     not null default false,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  archived_at                     timestamptz
);

create index if not exists idx_provider_profiles_org
  on public.provider_profiles (organization_id)
  where archived_at is null;

alter table public.provider_profiles enable row level security;
drop policy if exists provider_profiles_org_policy on public.provider_profiles;
create policy provider_profiles_org_policy on public.provider_profiles
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 6: treatment_plans + treatment_plan_goals
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.treatment_plans (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  client_id           uuid        not null references public.clients(id) on delete cascade,
  provider_id         uuid        references public.provider_profiles(id) on delete set null,
  plan_status         text        not null default 'active' check (
                                    plan_status in ('draft', 'active', 'completed', 'discontinued', 'voided')
                                  ),
  start_date          date,
  end_date            date,
  next_review_date    date,
  presenting_problem  text,
  long_term_goals     text,
  frequency           text,
  duration_weeks      integer,
  modality            text,
  signatures          jsonb       not null default '[]'::jsonb,
  created_by_user_id  uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create index if not exists idx_treatment_plans_client
  on public.treatment_plans (organization_id, client_id, plan_status)
  where archived_at is null;

alter table public.treatment_plans enable row level security;
drop policy if exists treatment_plans_org_policy on public.treatment_plans;
create policy treatment_plans_org_policy on public.treatment_plans
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

create table if not exists public.treatment_plan_goals (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  treatment_plan_id   uuid        not null references public.treatment_plans(id) on delete cascade,
  client_id           uuid        not null references public.clients(id) on delete cascade,
  goal_number         integer     not null default 1,
  goal_description    text        not null,
  objectives          text,
  target_date         date,
  goal_status         text        not null default 'active' check (
                                    goal_status in ('active', 'achieved', 'revised', 'discontinued')
                                  ),
  progress_notes      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create index if not exists idx_treatment_plan_goals_plan
  on public.treatment_plan_goals (treatment_plan_id, goal_status)
  where archived_at is null;

alter table public.treatment_plan_goals enable row level security;
drop policy if exists treatment_plan_goals_org_policy on public.treatment_plan_goals;
create policy treatment_plan_goals_org_policy on public.treatment_plan_goals
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 7: encounter_codes
-- Procedure codes selected for billing within an encounter (CPT/HCPCS).
-- Separate from encounter_service_lines (which are claim-ready line items).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.encounter_codes (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  encounter_id        uuid        not null references public.encounters(id) on delete cascade,
  client_id           uuid        not null references public.clients(id) on delete cascade,
  code_type           text        not null default 'CPT' check (code_type in ('CPT', 'HCPCS', 'ICD-10')),
  procedure_code      text        not null,
  modifiers           text[]      not null default '{}'::text[],
  units               numeric(8,2) not null default 1,
  fee_amount          numeric(12,2),
  diagnosis_pointers  integer[]   not null default '{}'::integer[],
  place_of_service    text,
  is_primary          boolean     not null default false,
  source              text        not null default 'manual' check (source in ('manual', 'suggestion', 'template', 'copy_forward')),
  coding_suggestion_id uuid,
  clinical_justification text,
  created_by_user_id  uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz,
  constraint valid_procedure_codes check (
    procedure_code in (
      -- Psychotherapy codes
      '90832','90834','90837','90791','90785',
      -- Behavioral health services
      'H0001','H0002','H0031','H0032','H0038','H0005','H0006',
      'H2011','H2014',
      -- Targeted case management
      'T1017',
      -- Other commonly used codes
      '90839','90840','90847','90846','96130','96131','96136','96137',
      '96150','96151','96152','96153','96154','96155',
      '99202','99203','99204','99205','99211','99212','99213','99214','99215',
      '99231','99232','99233',
      -- Wildcard sentinel for custom codes
      'CUSTOM'
    ) or procedure_code ~ '^[0-9]{5}$' or procedure_code ~ '^[A-Z][0-9]{4}$'
  )
);

alter table public.encounter_codes drop constraint if exists valid_procedure_codes;

create index if not exists idx_encounter_codes_encounter
  on public.encounter_codes (organization_id, encounter_id, code_type)
  where archived_at is null;

alter table public.encounter_codes enable row level security;
drop policy if exists encounter_codes_org_policy on public.encounter_codes;
create policy encounter_codes_org_policy on public.encounter_codes
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 8: coding_suggestions
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.coding_suggestions (
  id                        uuid        primary key default gen_random_uuid(),
  organization_id           uuid        not null references public.organizations(id) on delete cascade,
  encounter_id              uuid        not null references public.encounters(id) on delete cascade,
  client_id                 uuid        not null references public.clients(id) on delete cascade,
  suggestion_type           text        not null default 'cpt' check (
                                          suggestion_type in ('cpt', 'hcpcs', 'icd10', 'modifier', 'missed_code')
                                        ),
  suggested_code            text        not null,
  suggested_modifier        text,
  description               text,
  rationale                 text,
  confidence_score          numeric(5,4) check (confidence_score between 0 and 1),
  -- Warnings
  medical_necessity_warning text,
  unsupported_combination   text,
  missed_code_alert         text,
  -- Status
  suggestion_status         text        not null default 'pending' check (
                                          suggestion_status in ('pending', 'accepted', 'rejected', 'ignored')
                                        ),
  accepted_by_user_id       uuid,
  accepted_at               timestamptz,
  source                    text        not null default 'rules_engine' check (
                                          source in ('rules_engine', 'ai', 'payer_policy', 'manual')
                                        ),
  raw_trigger_data          jsonb       not null default '{}'::jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists idx_coding_suggestions_encounter
  on public.coding_suggestions (organization_id, encounter_id, suggestion_status);

alter table public.coding_suggestions enable row level security;
drop policy if exists coding_suggestions_org_policy on public.coding_suggestions;
create policy coding_suggestions_org_policy on public.coding_suggestions
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 9: documents  (CREATE IF NOT EXISTS – table may exist in live DB)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.documents (
  id                    uuid        primary key default gen_random_uuid(),
  organization_id       uuid        not null references public.organizations(id) on delete cascade,
  client_id             uuid        references public.clients(id) on delete set null,
  encounter_id          uuid        references public.encounters(id) on delete set null,
  claim_id              uuid,
  workqueue_item_id     uuid        references public.workqueue_items(id) on delete set null,
  mailroom_item_id      uuid,
  document_scope        text        not null default 'client' check (
                                      document_scope in ('client', 'claim', 'encounter', 'practice', 'admin', 'other')
                                    ),
  document_type         text        not null default 'other',
  title                 text,
  file_name             text,
  storage_bucket        text,
  storage_path          text,
  mime_type             text,
  file_size_bytes       bigint,
  uploaded_by_user_id   uuid,
  filed_by_user_id      uuid,
  filed_at              timestamptz,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  archived_at           timestamptz
);

create index if not exists idx_documents_client
  on public.documents (organization_id, client_id, created_at desc)
  where archived_at is null;
create index if not exists idx_documents_encounter
  on public.documents (organization_id, encounter_id)
  where archived_at is null and encounter_id is not null;
create index if not exists idx_documents_mailroom
  on public.documents (organization_id, mailroom_item_id)
  where archived_at is null and mailroom_item_id is not null;

alter table public.documents enable row level security;
drop policy if exists documents_org_policy on public.documents;
create policy documents_org_policy on public.documents
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 10: document_links  (polymorphic links)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.document_links (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  document_id         uuid        not null references public.documents(id) on delete cascade,
  linked_entity_type  text        not null check (
                                    linked_entity_type in (
                                      'patient', 'claim', 'encounter', 'appointment',
                                      'workqueue_item', 'ticket', 'mailroom_item', 'organization'
                                    )
                                  ),
  linked_entity_id    uuid        not null,
  link_notes          text,
  created_by_user_id  uuid,
  created_at          timestamptz not null default now()
);

create index if not exists idx_document_links_document
  on public.document_links (document_id, linked_entity_type, linked_entity_id);
create index if not exists idx_document_links_entity
  on public.document_links (organization_id, linked_entity_type, linked_entity_id);

alter table public.document_links enable row level security;
drop policy if exists document_links_org_policy on public.document_links;
create policy document_links_org_policy on public.document_links
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 11: smart_phrases
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.smart_phrases (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  created_by_user_id  uuid,
  phrase_key          text        not null,
  phrase_label        text        not null,
  phrase_body         text        not null,
  -- *** marks insertion points; e.g. "Patient reports ***. Clinician notes ***."
  placeholder_count   integer     not null default 0,
  category            text        not null default 'general' check (
                                    category in ('general', 'subjective', 'objective', 'assessment', 'plan', 'comment', 'claim')
                                  ),
  is_shared           boolean     not null default true,
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists idx_smart_phrases_key_org
  on public.smart_phrases (organization_id, phrase_key);
create index if not exists idx_smart_phrases_category
  on public.smart_phrases (organization_id, category, is_active);

alter table public.smart_phrases enable row level security;
drop policy if exists smart_phrases_org_policy on public.smart_phrases;
create policy smart_phrases_org_policy on public.smart_phrases
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 12: billing_alerts
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.billing_alerts (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  client_id           uuid        references public.clients(id) on delete set null,
  claim_id            uuid        references public.professional_claims(id) on delete set null,
  encounter_id        uuid        references public.encounters(id) on delete set null,
  workqueue_item_id   uuid        references public.workqueue_items(id) on delete set null,
  alert_type          text        not null check (
                                    alert_type in (
                                      'eligibility_lapsed', 'claim_rejected', 'claim_denied',
                                      'era_mismatch', 'balance_overdue', 'auth_expiring',
                                      'timely_filing_risk', 'coding_warning', 'recoupment', 'other'
                                    )
                                  ),
  severity            text        not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  alert_status        text        not null default 'open' check (
                                    alert_status in ('open', 'acknowledged', 'resolved', 'dismissed')
                                  ),
  title               text        not null,
  description         text,
  due_date            date,
  acknowledged_by     uuid,
  acknowledged_at     timestamptz,
  resolved_by         uuid,
  resolved_at         timestamptz,
  context_payload     jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

-- Ensure all required columns exist (table may have been created with an older schema)
alter table public.billing_alerts
  add column if not exists client_id           uuid        references public.clients(id) on delete set null,
  add column if not exists claim_id            uuid        references public.professional_claims(id) on delete set null,
  add column if not exists encounter_id        uuid        references public.encounters(id) on delete set null,
  add column if not exists workqueue_item_id   uuid        references public.workqueue_items(id) on delete set null,
  add column if not exists alert_type          text        not null default 'other',
  add column if not exists severity            text        not null default 'warning',
  add column if not exists alert_status        text        not null default 'open',
  add column if not exists title               text        not null default '',
  add column if not exists description         text,
  add column if not exists due_date            date,
  add column if not exists acknowledged_by     uuid,
  add column if not exists acknowledged_at     timestamptz,
  add column if not exists resolved_by         uuid,
  add column if not exists resolved_at         timestamptz,
  add column if not exists context_payload     jsonb       not null default '{}'::jsonb,
  add column if not exists archived_at         timestamptz;

create index if not exists idx_billing_alerts_org_status
  on public.billing_alerts (organization_id, alert_status, severity, created_at desc)
  where archived_at is null;
create index if not exists idx_billing_alerts_client
  on public.billing_alerts (organization_id, client_id, alert_status)
  where archived_at is null and client_id is not null;
create index if not exists idx_billing_alerts_claim
  on public.billing_alerts (organization_id, claim_id, alert_status)
  where archived_at is null and claim_id is not null;

alter table public.billing_alerts enable row level security;
drop policy if exists billing_alerts_org_policy on public.billing_alerts;
create policy billing_alerts_org_policy on public.billing_alerts
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 13: tickets + ticket_comments
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.tickets (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  client_id           uuid        references public.clients(id) on delete set null,
  claim_id            uuid        references public.professional_claims(id) on delete set null,
  encounter_id        uuid        references public.encounters(id) on delete set null,
  workqueue_item_id   uuid        references public.workqueue_items(id) on delete set null,
  billing_alert_id    uuid        references public.billing_alerts(id) on delete set null,
  ticket_number       text        not null,
  ticket_type         text        not null default 'billing' check (
                                    ticket_type in (
                                      'billing', 'eligibility', 'authorization', 'credentialing',
                                      'appeal', 'patient_complaint', 'clinical', 'admin', 'other'
                                    )
                                  ),
  ticket_status       text        not null default 'open' check (
                                    ticket_status in (
                                      'open', 'pending', 'waiting_on_clinician',
                                      'waiting_on_payer', 'resolved', 'closed'
                                    )
                                  ),
  priority            text        not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  subject             text        not null,
  description         text,
  assigned_to_user_id uuid,
  due_date            date,
  resolved_at         timestamptz,
  resolved_by_user_id uuid,
  closed_at           timestamptz,
  closed_by_user_id   uuid,
  created_by_user_id  uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create unique index if not exists idx_tickets_ticket_number
  on public.tickets (organization_id, ticket_number);
create index if not exists idx_tickets_org_status
  on public.tickets (organization_id, ticket_status, priority, created_at desc)
  where archived_at is null;
create index if not exists idx_tickets_client
  on public.tickets (organization_id, client_id)
  where archived_at is null and client_id is not null;
create index if not exists idx_tickets_claim
  on public.tickets (organization_id, claim_id)
  where archived_at is null and claim_id is not null;

alter table public.tickets enable row level security;
drop policy if exists tickets_org_policy on public.tickets;
create policy tickets_org_policy on public.tickets
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

create table if not exists public.ticket_comments (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  ticket_id           uuid        not null references public.tickets(id) on delete cascade,
  comment_body        text        not null,
  -- Smart phrase tracking: *** placeholders replaced before save
  smart_phrase_keys   text[]      not null default '{}'::text[],
  comment_type        text        not null default 'note' check (
                                    comment_type in ('note', 'status_change', 'assignment', 'resolution', 'system')
                                  ),
  is_internal         boolean     not null default true,
  created_by_user_id  uuid,
  created_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create index if not exists idx_ticket_comments_ticket
  on public.ticket_comments (ticket_id, created_at desc)
  where archived_at is null;

alter table public.ticket_comments enable row level security;
drop policy if exists ticket_comments_org_policy on public.ticket_comments;
create policy ticket_comments_org_policy on public.ticket_comments
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 14: claim_workqueue_items
-- AR/billing-specific workqueue entries (supplement general workqueue_items)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.claim_workqueue_items (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  claim_id            uuid        not null references public.professional_claims(id) on delete cascade,
  client_id           uuid        references public.clients(id) on delete set null,
  encounter_id        uuid        references public.encounters(id) on delete set null,
  era_claim_payment_id uuid,
  billing_alert_id    uuid        references public.billing_alerts(id) on delete set null,
  item_status         text        not null default 'no_response' check (
                                    item_status in (
                                      'no_response', 'rejected', 'denied', 'appeal_needed',
                                      'eligibility_issue', 'missing_era', 'recoupment',
                                      'aging_0_30', 'aging_31_60', 'aging_61_90',
                                      'aging_91_120', 'aging_120_plus',
                                      'resolved', 'deferred'
                                    )
                                  ),
  priority            text        not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  carc_code           text,
  rarc_code           text,
  group_code          text        check (group_code in ('PR', 'CO', 'OA', 'PI') or group_code is null),
  denial_reason       text,
  action_taken        text,
  assigned_to_user_id uuid,
  defer_until         date,
  defer_reason        text,
  resolved_at         timestamptz,
  resolved_by_user_id uuid,
  days_in_ar          integer,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create index if not exists idx_claim_workqueue_items_org_status
  on public.claim_workqueue_items (organization_id, item_status, priority, created_at desc)
  where archived_at is null;
create index if not exists idx_claim_workqueue_items_claim
  on public.claim_workqueue_items (organization_id, claim_id, item_status)
  where archived_at is null;
create index if not exists idx_claim_workqueue_items_client
  on public.claim_workqueue_items (organization_id, client_id)
  where archived_at is null and client_id is not null;

alter table public.claim_workqueue_items enable row level security;
drop policy if exists claim_workqueue_items_org_policy on public.claim_workqueue_items;
create policy claim_workqueue_items_org_policy on public.claim_workqueue_items
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 15: patient_balances
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.patient_balances (
  id                        uuid        primary key default gen_random_uuid(),
  organization_id           uuid        not null references public.organizations(id) on delete cascade,
  client_id                 uuid        not null references public.clients(id) on delete cascade,
  total_billed              numeric(12,2) not null default 0,
  total_insurance_paid      numeric(12,2) not null default 0,
  total_contractual_adj     numeric(12,2) not null default 0,
  total_patient_responsible numeric(12,2) not null default 0,
  total_patient_paid        numeric(12,2) not null default 0,
  current_balance           numeric(12,2) not null default 0,
  balance_0_30              numeric(12,2) not null default 0,
  balance_31_60             numeric(12,2) not null default 0,
  balance_61_90             numeric(12,2) not null default 0,
  balance_91_120            numeric(12,2) not null default 0,
  balance_120_plus          numeric(12,2) not null default 0,
  last_payment_date         date,
  last_payment_amount       numeric(12,2),
  last_statement_date       date,
  in_collections            boolean     not null default false,
  notes                     text,
  computed_at               timestamptz not null default now(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create unique index if not exists idx_patient_balances_client
  on public.patient_balances (organization_id, client_id);

alter table public.patient_balances enable row level security;
drop policy if exists patient_balances_org_policy on public.patient_balances;
create policy patient_balances_org_policy on public.patient_balances
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 16: payer_contracts + fee_schedules
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.payer_contracts (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  payer_profile_id    uuid        references public.payer_profiles(id) on delete set null,
  contract_name       text        not null,
  contract_type       text        not null default 'fee_for_service' check (
                                    contract_type in ('fee_for_service', 'capitation', 'bundled', 'value_based', 'other')
                                  ),
  effective_date      date,
  expiration_date     date,
  timely_filing_days  integer     not null default 365,
  appeal_deadline_days integer    not null default 60,
  resubmission_limit  integer     not null default 1,
  notes               text,
  contract_document_id uuid,
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create index if not exists idx_payer_contracts_org_payer
  on public.payer_contracts (organization_id, payer_profile_id, is_active)
  where archived_at is null;

alter table public.payer_contracts enable row level security;
drop policy if exists payer_contracts_org_policy on public.payer_contracts;
create policy payer_contracts_org_policy on public.payer_contracts
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

create table if not exists public.fee_schedules (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  payer_contract_id   uuid        references public.payer_contracts(id) on delete set null,
  schedule_name       text        not null,
  procedure_code      text        not null,
  modifiers           text[]      not null default '{}'::text[],
  place_of_service    text,
  allowed_amount      numeric(12,2) not null default 0,
  billed_rate         numeric(12,2),
  effective_date      date,
  expiration_date     date,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create index if not exists idx_fee_schedules_org_code
  on public.fee_schedules (organization_id, procedure_code)
  where archived_at is null;

alter table public.fee_schedules enable row level security;
drop policy if exists fee_schedules_org_policy on public.fee_schedules;
create policy fee_schedules_org_policy on public.fee_schedules
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 17: provider_payer_enrollments
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.provider_payer_enrollments (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  provider_profile_id uuid        not null references public.provider_profiles(id) on delete cascade,
  payer_profile_id    uuid        references public.payer_profiles(id) on delete set null,
  enrollment_status   text        not null default 'pending' check (
                                    enrollment_status in (
                                      'pending', 'submitted', 'approved', 'rejected',
                                      'revalidation_due', 'terminated', 'inactive'
                                    )
                                  ),
  enrollment_type     text        not null default 'in_network' check (
                                    enrollment_type in ('in_network', 'out_of_network', 'medicaid', 'medicare', 'tricare')
                                  ),
  provider_payer_id   text,
  effective_date      date,
  expiration_date     date,
  submitted_date      date,
  approved_date       date,
  notes               text,
  credentialing_profile_id uuid   references public.provider_credentialing_profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);

create index if not exists idx_provider_payer_enrollments_provider
  on public.provider_payer_enrollments (organization_id, provider_profile_id, enrollment_status)
  where archived_at is null;
create index if not exists idx_provider_payer_enrollments_payer
  on public.provider_payer_enrollments (organization_id, payer_profile_id)
  where archived_at is null;

alter table public.provider_payer_enrollments enable row level security;
drop policy if exists provider_payer_enrollments_org_policy on public.provider_payer_enrollments;
create policy provider_payer_enrollments_org_policy on public.provider_payer_enrollments
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 18: system_settings
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.system_settings (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null references public.organizations(id) on delete cascade,
  setting_key         text        not null,
  setting_value       jsonb       not null default 'null'::jsonb,
  setting_category    text        not null default 'general' check (
                                    setting_category in (
                                      'general', 'billing', 'eligibility', 'scheduling',
                                      'notifications', 'security', 'integrations', 'clinical'
                                    )
                                  ),
  description         text,
  is_secret           boolean     not null default false,
  updated_by_user_id  uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists idx_system_settings_key
  on public.system_settings (organization_id, setting_key);

alter table public.system_settings enable row level security;
drop policy if exists system_settings_org_policy on public.system_settings;
create policy system_settings_org_policy on public.system_settings
  for all to authenticated
  using  (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''))
  with check (organization_id::text = coalesce(auth.jwt() ->> 'organization_id', auth.jwt() -> 'app_metadata' ->> 'organization_id', ''));

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 19: ADD MISSING COLUMNS TO EXISTING TABLES
-- ─────────────────────────────────────────────────────────────────────────────

-- 19a. eligibility_requests: add appointment_id FK
alter table public.eligibility_requests
  add column if not exists appointment_id uuid references public.appointments(id) on delete set null;

create index if not exists idx_eligibility_requests_appointment_id
  on public.eligibility_requests (appointment_id)
  where appointment_id is not null;

-- 19b. encounter_clinical_notes: add Objective and Assessment for full SOAP
alter table public.encounter_clinical_notes
  add column if not exists objective  text,
  add column if not exists assessment text;

comment on column public.encounter_clinical_notes.subjective  is 'SOAP S: patient-reported symptoms, check-in intake import target';
comment on column public.encounter_clinical_notes.objective   is 'SOAP O: clinician observations, vitals, test results';
comment on column public.encounter_clinical_notes.assessment  is 'SOAP A: clinical assessment and diagnosis';
comment on column public.encounter_clinical_notes.plan        is 'SOAP P: treatment plan, interventions, next steps';

-- 19c. encounter_clinical_notes: add check_in_import_flag for H0031/H0001/H0032 auto-flag
alter table public.encounter_clinical_notes
  add column if not exists check_in_imported_at  timestamptz,
  add column if not exists suggested_codes        text[] not null default '{}'::text[];

comment on column public.encounter_clinical_notes.suggested_codes is
  'Auto-flagged CPT/HCPCS codes from check-in import. Values: H0031, H0001, H0032 when clinically supported.';

-- 19d. era_claim_payments: ensure full CARC/RARC/check tracking columns exist
--     (handles both the 20260505 and 20260511 versions of this table)
alter table public.era_claim_payments
  add column if not exists check_eft_number          text,
  add column if not exists payer_trace_number        text,
  add column if not exists check_issue_date          date,
  add column if not exists allowed_amount            numeric(12,2),
  add column if not exists adjustment_amount         numeric(12,2),
  add column if not exists carc_codes                text[] not null default '{}'::text[],
  add column if not exists rarc_codes                text[] not null default '{}'::text[],
  add column if not exists pr_amount                 numeric(12,2),
  add column if not exists co_amount                 numeric(12,2),
  add column if not exists oa_amount                 numeric(12,2),
  add column if not exists pi_amount                 numeric(12,2);

comment on column public.era_claim_payments.carc_codes is
  'CARC (Claim Adjustment Reason Codes) from 835 CAS segments';
comment on column public.era_claim_payments.rarc_codes is
  'RARC (Remittance Advice Remark Codes) from 835 MOA/LQ segments';

-- 19e. era_service_line_payments: add CARC/RARC detail columns (only if table exists)
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'era_service_line_payments') then
    alter table public.era_service_line_payments
      add column if not exists carc_code         text,
      add column if not exists rarc_code         text,
      add column if not exists group_code        text check (group_code in ('PR', 'CO', 'OA', 'PI') or group_code is null),
      add column if not exists adjustment_amount numeric(12,2);
  end if;
end;
$$;

-- 19f. workqueue_items: link to billing_alerts and tickets
alter table public.workqueue_items
  add column if not exists billing_alert_id uuid references public.billing_alerts(id) on delete set null,
  add column if not exists ticket_id        uuid references public.tickets(id) on delete set null;

do $$
begin
  if to_regclass('public.workqueue_items') is not null then
    create index if not exists idx_workqueue_items_billing_alert
      on public.workqueue_items (organization_id, billing_alert_id)
      where billing_alert_id is not null and archived_at is null;
  end if;
end $$;

-- 19g. workqueue_item_comments: smart_phrase tracking
alter table public.workqueue_item_comments
  add column if not exists smart_phrase_keys text[] not null default '{}'::text[];

-- 19h. mailroom_items: add missing columns for full routing workflow
alter table public.mailroom_items
  add column if not exists routed_to_workqueue_id uuid references public.workqueue_items(id) on delete set null,
  add column if not exists routed_at              timestamptz,
  add column if not exists routed_by_user_id      uuid,
  add column if not exists ticket_id              uuid references public.tickets(id) on delete set null;

-- 19i. professional_claims: add timely filing and appeal tracking
alter table public.professional_claims
  add column if not exists first_billed_date        date,
  add column if not exists last_billed_date         date,
  add column if not exists appeal_deadline_date     date,
  add column if not exists appeal_submitted_at      timestamptz,
  add column if not exists denial_reason_code       text,
  add column if not exists denial_reason_description text,
  add column if not exists days_in_ar               integer,
  add column if not exists billing_notes            text;

create index if not exists idx_professional_claims_status_org
  on public.professional_claims (organization_id, claim_status, created_at desc)
  where claim_status not in ('paid', 'voided');

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 20: SEED smart_phrases (common behavioral health phrases)
-- ─────────────────────────────────────────────────────────────────────────────
-- Uses org_id 11111111-1111-1111-1111-111111111111 (demo org)
-- Only inserts if the org exists
do $$
declare
  v_org_id uuid := '11111111-1111-1111-1111-111111111111';
begin
  if exists (select 1 from public.organizations where id = v_org_id) then
    insert into public.smart_phrases
      (organization_id, phrase_key, phrase_label, phrase_body, placeholder_count, category)
    values
      (v_org_id, 'subjective_standard',      'Standard Subjective',
       'Client reports *** mood and energy levels. Sleep reported as ***. Client denies SI/HI. Current stressors include ***.',
       3, 'subjective'),
      (v_org_id, 'plan_followup',            'Follow-up Plan',
       'Continue current treatment plan. Next session scheduled for ***. Client will practice *** skills between sessions.',
       2, 'plan'),
      (v_org_id, 'assessment_stable',        'Assessment Stable',
       'Client presents as *** today. Affect is ***. Cognitive functioning appears intact. *** symptoms are ***.',
       4, 'assessment'),
      (v_org_id, 'claim_denial_note',        'Claim Denial Comment',
       'Claim denied with CARC ***. Action taken: ***. Resubmission deadline: ***.',
       3, 'claim'),
      (v_org_id, 'no_response_comment',      'No Response Comment',
       'No ERA or response received from payer as of ***. Claim submitted ***. Follow-up action: ***.',
       3, 'claim'),
      (v_org_id, 'eligibility_note',         'Eligibility Note',
       'Eligibility verified *** via ***. Active coverage confirmed through ***. Copay: $***.',
       4, 'general')
    on conflict (organization_id, phrase_key) do nothing;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 21: INDEXES on high-traffic foreign keys (catch-all pass)
-- ─────────────────────────────────────────────────────────────────────────────
create index if not exists idx_professional_claims_patient_id
  on public.professional_claims (patient_id)
  where patient_id is not null;

create index if not exists idx_era_claim_payments_professional_claim_id
  on public.era_claim_payments (professional_claim_id)
  where professional_claim_id is not null;

create index if not exists idx_era_claim_payments_check_eft
  on public.era_claim_payments (check_eft_number)
  where check_eft_number is not null;

create index if not exists idx_patient_diagnoses_code
  on public.patient_diagnoses (diagnosis_code, organization_id)
  where archived_at is null;

create index if not exists idx_coding_suggestions_code
  on public.coding_suggestions (organization_id, suggested_code, suggestion_status);

create index if not exists idx_billing_alerts_due_date
  on public.billing_alerts (organization_id, due_date, alert_status)
  where archived_at is null and due_date is not null;

create index if not exists idx_tickets_assigned_user
  on public.tickets (organization_id, assigned_to_user_id, ticket_status)
  where archived_at is null and assigned_to_user_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 22: Notify PostgREST to reload schema
-- ─────────────────────────────────────────────────────────────────────────────
select pg_notify('pgrst', 'reload schema');
