-- File: supabase/migrations/20260101000000_foundation_tables.sql
-- Purpose: Create foundational enum types and core tables that all subsequent
-- migrations depend on. These tables exist in schema.sql (remote snapshot) but
-- were never codified in a migration, causing fresh-start failures.
-- All statements are idempotent (create if not exists / do $$ guards).

create extension if not exists pgcrypto;

-- ─── Enum types ───────────────────────────────────────────────────────────────
-- Each type is guarded so re-runs and environments where types already exist
-- from a schema dump continue to work without error.

do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'appointment_status' and n.nspname = 'public'
  ) then
    create type public.appointment_status as enum (
      'scheduled', 'checked_in', 'in_progress', 'completed', 'no_show', 'cancelled'
    );
  end if;

  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'claim_status' and n.nspname = 'public'
  ) then
    create type public.claim_status as enum (
      'draft', 'ready_to_submit', 'submitted', 'accepted',
      'rejected', 'denied', 'paid', 'partially_paid', 'voided'
    );
  end if;

  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'encounter_status' and n.nspname = 'public'
  ) then
    create type public.encounter_status as enum (
      'scheduled', 'in_progress', 'completed', 'ready_to_bill', 'billed', 'voided'
    );
  end if;

  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'payment_import_status' and n.nspname = 'public'
  ) then
    create type public.payment_import_status as enum (
      'imported', 'parsed', 'needs_review', 'ready_to_post', 'posted', 'failed'
    );
  end if;

  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'source_object_type' and n.nspname = 'public'
  ) then
    create type public.source_object_type as enum (
      'appointment', 'encounter', 'claim', 'eligibility_check',
      'authorization_or_referral', 'payment_import_item', 'payment_posting',
      'client', 'insurance_policy', 'workqueue_item', 'mailroom_item'
    );
  end if;

  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'workqueue_priority' and n.nspname = 'public'
  ) then
    create type public.workqueue_priority as enum (
      'low', 'normal', 'high', 'urgent'
    );
  end if;

  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'workqueue_status' and n.nspname = 'public'
  ) then
    create type public.workqueue_status as enum (
      'open', 'in_progress', 'blocked', 'resolved', 'closed'
    );
  end if;
end $$;

-- ─── organizations ────────────────────────────────────────────────────────────
create table if not exists public.organizations (
  id                  uuid        primary key default gen_random_uuid(),
  name                text        not null,
  slug                text        not null unique,
  legal_name          text,
  tax_id_last4        text,
  timezone            text        not null default 'America/Denver',
  default_state       text        not null default 'CO',
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by_user_id  uuid,
  updated_by_user_id  uuid,
  archived_at         timestamptz
);

-- ─── clients ──────────────────────────────────────────────────────────────────
create table if not exists public.clients (
  id                        uuid        primary key default gen_random_uuid(),
  organization_id           uuid        not null references public.organizations(id) on delete cascade,
  external_client_ref       text,
  mrn                       text,
  first_name                text        not null,
  middle_name               text,
  last_name                 text        not null,
  preferred_name            text,
  date_of_birth             date        not null,
  sex_at_birth              text,
  gender_identity           text,
  pronouns                  text,
  phone                     text,
  email                     text,
  address_line_1            text,
  address_line_2            text,
  city                      text,
  state                     text,
  postal_code               text,
  preferred_language        text,
  primary_clinician_user_id uuid,
  deceased_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by_user_id        uuid,
  updated_by_user_id        uuid,
  archived_at               timestamptz
);

-- ─── insurance_payers ─────────────────────────────────────────────────────────
create table if not exists public.insurance_payers (
  id                   uuid        primary key default gen_random_uuid(),
  organization_id      uuid        not null references public.organizations(id) on delete cascade,
  payer_name           text        not null,
  payer_id             text        not null,
  payer_category       text,
  claims_address       text,
  remit_address        text,
  eligibility_endpoint text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by_user_id   uuid,
  updated_by_user_id   uuid,
  archived_at          timestamptz
);

-- ─── appointments ─────────────────────────────────────────────────────────────
create table if not exists public.appointments (
  id                    uuid                      primary key default gen_random_uuid(),
  organization_id       uuid                      not null references public.organizations(id) on delete cascade,
  client_id             uuid                      not null references public.clients(id) on delete cascade,
  provider_id           uuid,
  provider_location_id  uuid,
  insurance_policy_id   uuid,
  scheduled_start_at    timestamptz               not null,
  scheduled_end_at      timestamptz               not null,
  appointment_status    public.appointment_status not null default 'scheduled',
  appointment_type      text,
  reason                text,
  check_in_at           timestamptz,
  cancelled_at          timestamptz,
  cancellation_reason   text,
  telehealth_url        text,
  created_at            timestamptz               not null default now(),
  updated_at            timestamptz               not null default now(),
  created_by_user_id    uuid,
  updated_by_user_id    uuid,
  archived_at           timestamptz,
  constraint appointments_start_before_end check (scheduled_start_at < scheduled_end_at)
);

-- ─── encounters ───────────────────────────────────────────────────────────────
create table if not exists public.encounters (
  id                                uuid                    primary key default gen_random_uuid(),
  organization_id                   uuid                    not null references public.organizations(id) on delete cascade,
  appointment_id                    uuid                    not null references public.appointments(id) on delete cascade,
  client_id                         uuid                    not null references public.clients(id) on delete cascade,
  provider_id                       uuid                    not null,
  encounter_status                  public.encounter_status not null default 'scheduled',
  started_at                        timestamptz,
  ended_at                          timestamptz,
  service_date                      date,
  required_billing_fields_complete  boolean                 not null default false,
  created_at                        timestamptz             not null default now(),
  updated_at                        timestamptz             not null default now(),
  created_by_user_id                uuid,
  updated_by_user_id                uuid,
  archived_at                       timestamptz,
  session_summary                   text,
  soap_note                         jsonb,
  constraint encounters_end_after_start check (
    ended_at is null or started_at is null or ended_at >= started_at
  )
);

-- ─── claims ───────────────────────────────────────────────────────────────────
create table if not exists public.claims (
  id                            uuid                  primary key default gen_random_uuid(),
  organization_id               uuid                  not null references public.organizations(id) on delete cascade,
  encounter_id                  uuid                  not null references public.encounters(id) on delete cascade,
  client_id                     uuid                  not null references public.clients(id) on delete cascade,
  insurance_policy_id           uuid                  not null,
  claim_number                  text                  not null,
  claim_status                  public.claim_status   not null default 'draft',
  claim_frequency_code          text                  not null default '1',
  total_charge_amount           numeric(12,2)         not null default 0 check (total_charge_amount >= 0),
  patient_responsibility_amount numeric(12,2)         not null default 0 check (patient_responsibility_amount >= 0),
  payer_responsibility_amount   numeric(12,2)         not null default 0 check (payer_responsibility_amount >= 0),
  date_of_service_from          date                  not null,
  date_of_service_to            date                  not null,
  ready_to_submit_at            timestamptz,
  submitted_at                  timestamptz,
  accepted_at                   timestamptz,
  denied_at                     timestamptz,
  paid_at                       timestamptz,
  last_blocker_codes            text[]                not null default '{}',
  duplicate_detection_key       text                  not null,
  created_at                    timestamptz           not null default now(),
  updated_at                    timestamptz           not null default now(),
  created_by_user_id            uuid,
  updated_by_user_id            uuid,
  archived_at                   timestamptz,
  constraint claims_dos_check check (date_of_service_to >= date_of_service_from)
);

-- ─── workqueue_items ──────────────────────────────────────────────────────────
create table if not exists public.workqueue_items (
  id                   uuid                      primary key default gen_random_uuid(),
  organization_id      uuid                      not null references public.organizations(id) on delete cascade,
  source_object_type   public.source_object_type not null,
  source_object_id     uuid                      not null,
  client_id            uuid,
  encounter_id         uuid,
  claim_id             uuid,
  priority             public.workqueue_priority not null default 'normal',
  status               public.workqueue_status   not null default 'open',
  work_type            text                      not null,
  title                text                      not null,
  description          text,
  assigned_to_user_id  uuid,
  due_at               timestamptz,
  resolved_at          timestamptz,
  closed_at            timestamptz,
  context_payload      jsonb                     not null default '{}',
  created_at           timestamptz               not null default now(),
  updated_at           timestamptz               not null default now(),
  created_by_user_id   uuid,
  updated_by_user_id   uuid,
  archived_at          timestamptz,
  deferred_until       timestamptz,
  defer_reason         text,
  resolved_by_user_id  uuid,
  closed_by_user_id    uuid,
  professional_claim_id uuid,
  billing_alert_id     uuid,
  ticket_id            uuid,
  constraint workqueue_items_has_source check (
    source_object_id is not null and source_object_type is not null
  )
);

-- ─── audit_logs ───────────────────────────────────────────────────────────────
create table if not exists public.audit_logs (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid,
  patient_id        uuid,
  appointment_id    uuid,
  encounter_id      uuid,
  claim_id          uuid,
  clinical_note_id  uuid,
  workqueue_item_id uuid,
  event_type        text,
  event_summary     text,
  event_metadata    jsonb       not null default '{}',
  created_at        timestamptz not null default now(),
  user_id           uuid,
  user_role         text,
  action            text,
  object_type       text,
  object_id         uuid,
  before_value      jsonb,
  after_value       jsonb
);

-- ─── claim_status_events ──────────────────────────────────────────────────────
create table if not exists public.claim_status_events (
  id                    uuid        primary key default gen_random_uuid(),
  claim_id              uuid,
  source                text        not null default 'system',
  status                text        not null default 'unknown',
  status_message        text,
  external_claim_id     text,
  office_ally_claim_id  text,
  office_ally_file_id   text,
  payer_reference_id    text,
  raw_payload           jsonb       not null default '{}',
  created_at            timestamptz not null default now()
);

-- ─── patient_checkins ─────────────────────────────────────────────────────────
create table if not exists public.patient_checkins (
  id                                  uuid        primary key default gen_random_uuid(),
  organization_id                     uuid        not null references public.organizations(id) on delete cascade,
  client_id                           uuid        not null references public.clients(id) on delete cascade,
  appointment_id                      uuid,
  encounter_id                        uuid,
  checkin_type                        text        not null default 'medicaid_telehealth'
    check (checkin_type in ('medicaid_telehealth', 'general')),
  status                              text        not null default 'started'
    check (status in ('started', 'submitted', 'reviewed', 'imported_to_note')),
  mental_state_response               text,
  psychosocial_update_response        text,
  substance_use_update_response       text,
  risk_safety_response                text,
  patient_journal_response            text,
  subjective_import_text              text,
  h0031_signal                        boolean     not null default false,
  h0001_signal                        boolean     not null default false,
  h0032_signal                        boolean     not null default false,
  patient_acknowledged_record_notice  boolean     not null default false,
  submitted_at                        timestamptz,
  clinician_notified_at               timestamptz,
  reviewed_at                         timestamptz,
  created_at                          timestamptz not null default now(),
  updated_at                          timestamptz not null default now()
);

-- ─── payment_import_items ─────────────────────────────────────────────────────
create table if not exists public.payment_import_items (
  id                     uuid                          primary key default gen_random_uuid(),
  organization_id        uuid                          not null references public.organizations(id) on delete cascade,
  batch_id               uuid                          not null,
  payment_import_status  public.payment_import_status  not null default 'imported',
  imported_item_ref      text,
  payment_date           date,
  payer_id               uuid,
  claim_id               uuid,
  client_id              uuid,
  service_line_ref       text,
  gross_amount           numeric(12,2)                 not null default 0,
  adjustment_amount      numeric(12,2)                 not null default 0,
  net_amount             numeric(12,2)                 not null default 0,
  unapplied_amount       numeric(12,2)                 not null default 0,
  posting_ready          boolean                       not null default false,
  raw_item_payload       jsonb,
  created_at             timestamptz                   not null default now(),
  updated_at             timestamptz                   not null default now(),
  created_by_user_id     uuid,
  updated_by_user_id     uuid,
  archived_at            timestamptz,
  storage_bucket         text,
  storage_path           text,
  original_file_name     text,
  file_hash              text,
  raw_edi                text,
  parsed_payload         jsonb,
  parse_status           text                          not null default 'pending',
  parse_error            text,
  parsed_at              timestamptz,
  match_status           text                          not null default 'unmatched'
    check (match_status in ('matched', 'unmatched', 'manual_matched', 'ignored')),
  match_reason           text,
  matched_at             timestamptz
);

-- ─── vcc_payments ─────────────────────────────────────────────────────────────
create table if not exists public.vcc_payments (
  id                    uuid          primary key default gen_random_uuid(),
  organization_id       uuid          not null references public.organizations(id) on delete cascade,
  mailroom_item_id      uuid,
  payment_posting_id    uuid,
  payer_name            text,
  payer_id              text,
  card_last4            text,
  card_brand            text,
  expiration_month      integer,
  expiration_year       integer,
  authorization_code    text,
  reference_number      text,
  payment_amount        numeric(12,2) not null,
  fee_amount            numeric(12,2),
  service_date_start    date,
  service_date_end      date,
  client_id             uuid,
  claim_id              uuid,
  status                text          not null default 'pending'
    check (status in ('pending', 'processed', 'failed', 'expired', 'voided')),
  processed_at          timestamptz,
  processed_by_user_id  uuid,
  notes                 text,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now()
);
