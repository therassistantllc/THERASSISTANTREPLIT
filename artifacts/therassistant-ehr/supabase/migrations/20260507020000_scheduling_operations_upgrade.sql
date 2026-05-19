-- Scheduling operations upgrade
-- Adds provider availability, administrative blocks, recurrence series, and reminder support.

create extension if not exists pgcrypto;

create table if not exists public.provider_availability_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  provider_id uuid not null,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  location_type text not null default 'any' check (location_type in ('office', 'telehealth', 'any')),
  is_available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null
);

create table if not exists public.provider_schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  provider_id uuid not null,
  block_type text not null check (block_type in ('meeting', 'administrative', 'break', 'meal', 'leave')),
  title text not null,
  description text null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  is_billable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null,
  check (ends_at > starts_at)
);

create table if not exists public.appointment_series (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  provider_id uuid null,
  client_id uuid null,
  recurrence_frequency text not null check (recurrence_frequency in ('weekly', 'biweekly', 'monthly')),
  recurrence_interval integer not null default 1,
  ends_on date null,
  session_count integer null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null
);

create table if not exists public.appointment_reminders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  appointment_id uuid not null,
  channel text not null check (channel in ('email', 'sms', 'portal')),
  scheduled_for timestamptz not null,
  reminder_status text not null default 'scheduled' check (reminder_status in ('scheduled', 'sent', 'failed', 'cancelled')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null
);

alter table if exists public.appointments add column if not exists service_location text;
alter table if exists public.appointments add column if not exists internal_note text;
alter table if exists public.appointments add column if not exists reminder_email_enabled boolean not null default false;
alter table if exists public.appointments add column if not exists reminder_sms_enabled boolean not null default false;
alter table if exists public.appointments add column if not exists reminder_portal_enabled boolean not null default true;
alter table if exists public.appointments add column if not exists reminder_lead_hours integer not null default 24;
alter table if exists public.appointments add column if not exists telehealth_session_token text;
alter table if exists public.appointments add column if not exists series_id uuid;
alter table if exists public.appointments add column if not exists recurrence_index integer;
alter table if exists public.appointments add column if not exists recurrence_frequency text;

create index if not exists idx_provider_availability_rules_lookup
  on public.provider_availability_rules (organization_id, provider_id, day_of_week)
  where archived_at is null;

create index if not exists idx_provider_schedule_blocks_lookup
  on public.provider_schedule_blocks (organization_id, provider_id, starts_at, ends_at)
  where archived_at is null;

do $$
begin
  if to_regclass('public.appointments') is not null then
    create index if not exists idx_appointment_series_lookup
      on public.appointments (organization_id, series_id, scheduled_start_at)
      where archived_at is null and series_id is not null;
  end if;
end $$;

create index if not exists idx_appointment_reminders_due
  on public.appointment_reminders (organization_id, reminder_status, scheduled_for)
  where archived_at is null;
